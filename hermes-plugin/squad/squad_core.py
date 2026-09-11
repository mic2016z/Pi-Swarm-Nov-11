"""Quad Squad coordination core: registry, inbox, reservations, board, guards.

Plain files under <store>/ so any agent that can read and write JSON can take
part, independent of model or provider. Pure standard library; nothing here
imports Hermes, so the module is unit-testable outside a running agent.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Guard defaults from the colony model.
MESSAGE_BUDGET = 6          # per-slice peer messages before the slice auto-blocks
PAIR_CUTOFF = 3             # messages between one pair with no board change
CLAIM_TTL_SECONDS = 30 * 60 # claim expiry without progress

# Tool-name coverage for reservation enforcement. File tools carry the target in
# a path-like argument; shell tools get a best-effort command-string scan.
FILE_MUTATING_TOOLS = {
    "write_file", "patch", "edit_file", "apply_patch", "create_file",
    "delete_file", "remove_file", "move_file", "rename_file", "save_file",
    "write", "edit", "str_replace",
}
SHELL_TOOLS = {
    "bash", "shell", "sh", "run_command", "execute_command", "command",
    "terminal", "run_shell_command", "powershell", "process",
}
GIT_MUTATION = re.compile(r"\bgit\s+(commit|push|merge|rebase)\b", re.IGNORECASE)

SLICE_STATES = ("open", "claimed", "review", "changes", "blocked", "done", "cancelled")
# Valid board transitions; everything else is rejected.
TRANSITIONS = {
    ("open", "claimed"),
    ("claimed", "review"),
    ("claimed", "open"),      # owner release / TTL expiry
    ("review", "done"),
    ("review", "changes"),
    ("changes", "review"),
    ("review", "open"),       # reviewer rejects back to the pool
    ("blocked", "open"),      # master unblocks
    ("open", "cancelled"),    # master cancels
}


def _acceptance_evidence(evidence: dict | None, item: dict) -> dict:
    """Validate and normalize the acceptance proof for a review -> done
    transition. Missing or failing evidence rejects the sign-off."""
    raw = evidence if isinstance(evidence, dict) else {}
    command = str(raw.get("command") or item.get("acceptance") or "").strip()
    exit_code = raw.get("exitCode", raw.get("exit_code"))
    try:
        exit_code = int(exit_code)
    except (TypeError, ValueError):
        raise SquadError(
            "Sign-off needs evidence: run the slice's acceptance command and pass "
            "evidence={command, exitCode}.") from None
    if exit_code != 0:
        raise SquadError(
            f"Acceptance command failed (exit {exit_code}); fix the slice before done. "
            "Evidence with a non-zero exit can never approve a slice.")
    return {"command": command, "exitCode": exit_code, "at": utcnow()}


def settle_receipt_patch(receipt: dict, final_text: str,
                         board_summary: str | None = None) -> dict:
    """Decide a relay receipt's terminal patch at the end of the master's turn.
    The final assistant text wins; a delegation-only turn stays delegated with
    the resulting board state; only a silent turn fails."""
    text = str(final_text or "").strip()
    if text:
        return {"status": "replied", "response": text, "completed": time.time()}
    if receipt.get("delegations"):
        return {"status": "delegated", "response": board_summary or "",
                "completed": time.time()}
    return {"status": "failed",
            "response": "",
            "error": "Master produced no readable response",
            "completed": time.time()}


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def atomic_write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{uuid.uuid4()}.tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def alive(pid: int) -> bool:
    """Process-existence check. os.kill(pid, 0) kills processes on Windows, so
    the existence probe must go through OpenProcess there."""
    if not pid or pid < 1:
        return False
    if os.name == "nt":
        import ctypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return code.value == STILL_ACTIVE
            return False
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class FileLock:
    """Cross-platform exclusive lock over a lock file, best effort."""

    def __init__(self, path: Path, timeout: float = 5.0):
        self.path = path
        self.timeout = timeout
        self._handle = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(self.path, "a+")
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                if os.name == "nt":
                    import msvcrt

                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                self._handle = handle
                return self
            except OSError:
                if time.monotonic() >= deadline:
                    handle.close()
                    raise TimeoutError(f"Lock timeout: {self.path}")
                time.sleep(0.05)

    def __exit__(self, *exc):
        if self._handle:
            try:
                if os.name == "nt":
                    import msvcrt

                    self._handle.seek(0)
                    msvcrt.locking(self._handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
            finally:
                self._handle.close()
                self._handle = None
        return False


class SquadError(Exception):
    """Raised for user-correctable coordination failures."""


class Squad:
    """One agent's view of the shared squad store."""

    def __init__(self, agent: str, project: str, root: str):
        self.name = agent  # 'master' or 'hermes-<n>'
        self.role = "master" if agent == "master" else "worker"
        self.project = str(project)
        self.root = Path(root)
        self.store = self.root.parent / "squad"
        self.registry = self.store / "registry"
        self.inbox = self.store / "inbox" / self.name
        self.reservations = self.store / "reservations"
        self.board_path = self.store / "board.json"
        self.feed_path = self.store / "feed.jsonl"
        self.board_lock = self.store / "board.lock"

    # -- low-level ---------------------------------------------------------

    def append_feed(self, entry: dict) -> None:
        """Append one audit line. The feed is written by up to four agent
        processes at once, so the append happens under a feed lock; a total
        lock failure retries once and then reports to stderr instead of
        dropping the event silently."""
        record = {"ts": utcnow(), **entry}
        line = json.dumps(record) + "\n"
        try:
            self.store.mkdir(parents=True, exist_ok=True)
            with FileLock(self.store / "feed.lock"):
                with open(self.feed_path, "a", encoding="utf-8") as handle:
                    handle.write(line)
            return
        except (OSError, TimeoutError):
            pass
        try:
            with FileLock(self.store / "feed.lock"):
                with open(self.feed_path, "a", encoding="utf-8") as handle:
                    handle.write(line)
        except (OSError, TimeoutError) as problem:
            print(f"squad: feed append failed: {problem}", file=sys.stderr)

    def normalize(self, target: str) -> str:
        """Project-relative canonical path identity; case-insensitive on Windows."""
        value = os.path.abspath(os.path.join(self.project, str(target))).replace("\\", "/")
        if os.name == "nt":
            value = value.lower()
        return value.rstrip("/")

    # -- registry ----------------------------------------------------------

    def register(self, extra: dict | None = None) -> None:
        path = self.registry / f"{self.name}.json"
        existing = read_json(path, {})
        atomic_write(path, {
            "name": self.name,
            "pid": os.getpid(),
            "cwd": self.project,
            "role": self.role,
            "startedAt": existing.get("startedAt") or utcnow(),
            "activity": {"lastActivityAt": utcnow(), "currentActivity": "idle"},
            **(extra or {}),
        })

    def update_activity(self, current: str) -> None:
        path = self.registry / f"{self.name}.json"
        record = read_json(path, {})
        if not record:
            return
        record["activity"] = {"lastActivityAt": utcnow(), "currentActivity": current}
        atomic_write(path, record)

    def agent_alive(self, agent: str) -> bool:
        record = read_json(self.registry / f"{agent}.json", None)
        return bool(record) and alive(int(record.get("pid") or 0))

    def peers(self) -> list[dict]:
        try:
            names = list(self.registry.iterdir())
        except OSError:
            return []
        out = []
        for entry in names:
            if entry.suffix != ".json":
                continue
            record = read_json(entry, None)
            if not record or record.get("name") == self.name:
                continue
            if self.agent_alive(record.get("name", "")):
                out.append(record)
        return out

    def unregister(self) -> None:
        for path in (
            self.reservations / f"{self.name}.json",
            self.registry / f"{self.name}.json",
        ):
            try:
                path.unlink()
            except OSError:
                pass
        if self.role == "master":
            try:
                (self.root.parent / "master-runtime.json").unlink()
            except OSError:
                pass

    # -- inbox -------------------------------------------------------------

    @staticmethod
    def resolve_recipient(to: str) -> str:
        target = str(to or "").strip().lstrip("@").lower()
        if target == "master":
            return "master"
        match = re.match(r"^(?:hermes|hm|oc|pi)-?([1-9]\d*)$", target)
        if match:
            return f"hermes-{match.group(1)}"
        raise SquadError("Recipient must be master or hermes-N")

    def deliver(self, to: str, text: str, reply_to: str | None = None) -> str:
        inbox = self.store / "inbox" / to
        inbox.mkdir(parents=True, exist_ok=True)
        mid = str(uuid.uuid4())
        message = {"id": mid, "from": self.name, "to": to, "text": text,
                   "timestamp": utcnow(), "replyTo": reply_to}
        temporary = inbox / f"{mid}.tmp"
        temporary.write_text(json.dumps(message), encoding="utf-8")
        # Zero-padded millisecond prefix: lexicographic order equals arrival order.
        target = inbox / f"{int(time.time() * 1000):020d}-{mid}.json"
        os.replace(temporary, target)
        return mid

    def peek_inbox(self) -> list[tuple[Path, dict]]:
        """Read pending messages in arrival order without removing them. The
        caller acks each file only after delivery succeeded, so a failed
        injection never destroys a message."""
        try:
            names = sorted(p for p in self.inbox.iterdir() if p.suffix == ".json")
        except OSError:
            return []
        out = []
        for file in names:
            message = read_json(file, None)
            if message:
                out.append((file, message))
        return out

    def ack_message(self, file: Path) -> None:
        try:
            file.unlink()
        except OSError:
            pass  # already claimed by this same pane

    def park_undelivered(self, file: Path) -> Path:
        """Move a message that exhausted its delivery budget out of the inbox,
        where it can be inspected and replayed by hand."""
        parked = self.store / "undelivered" / self.name
        parked.mkdir(parents=True, exist_ok=True)
        target = parked / file.name
        try:
            os.replace(file, target)
        except OSError:
            return file
        return target

    def drain_inbox(self) -> list[dict]:
        messages = []
        for file, message in self.peek_inbox():
            messages.append(message)
            self.ack_message(file)
        return messages

    # -- reservations ------------------------------------------------------

    def read_reservations(self) -> list[dict]:
        out = []
        try:
            names = list(self.reservations.iterdir())
        except OSError:
            return []
        for entry in names:
            if entry.suffix != ".json":
                continue
            agent = entry.stem
            if agent != self.name and not self.agent_alive(agent):
                continue  # a dead agent must not hold the project hostage
            for record in read_json(entry, []):
                out.append({"agent": agent, **record})
        return out

    def conflicts(self, target: str) -> list[dict]:
        wanted = self.normalize(target)
        held = []
        for entry in self.read_reservations():
            if entry["agent"] == self.name:
                continue
            path = entry["path"]
            # A directory reservation covers everything beneath it.
            if wanted == path or wanted.startswith(path + "/") or path.startswith(wanted + "/"):
                held.append(entry)
        return held

    def reserved_by_others(self) -> list[dict]:
        return [r for r in self.read_reservations() if r["agent"] != self.name]

    def deny_tool(self, tool: str, args: dict) -> str | None:
        """Reservation and role enforcement for one tool call. Returns the
        denial reason, or None when the call may proceed."""
        args = args or {}
        name = str(tool or "").strip().lower()
        if name not in FILE_MUTATING_TOOLS and name not in SHELL_TOOLS:
            return None
        reserved = self.reserved_by_others()
        holders = {
            entry["path"]: entry["agent"] for entry in reserved
        } if reserved else {}
        if name in FILE_MUTATING_TOOLS:
            target = next((str(args[key]) for key in ("path", "file", "filename", "target")
                           if isinstance(args.get(key), str) and args[key].strip()), "")
            if target:
                wanted = self.normalize(target)
                holder = next((agent for path, agent in holders.items()
                               if wanted == path or wanted.startswith(path + "/")
                               or path.startswith(wanted + "/")), None)
                if holder:
                    return (f"{target} is reserved by {holder}. Ask them to release it "
                            f"via squad_claims, or coordinate through the board.")
            return None
        # Shell tools: a command string may touch reserved paths or mutate git.
        parts = [args.get(key) for key in ("command", "cmd", "script", "code", "input")]
        command = " ".join(str(p) for p in parts if isinstance(p, str))
        lowered = command.lower()
        if self.role != "master" and GIT_MUTATION.search(command):
            return "Only the master runs git commit/push/merge/rebase. Send the change through the board instead."
        project = self.project.replace("\\", "/").lower() + "/"
        for path, agent in holders.items():
            relative = path.lower().split(project, 1)[-1] if project in path.lower() else path.lower()
            if relative and relative in lowered:
                return (f"That command touches {relative}, reserved by {agent}. Ask them "
                        f"to release it via squad_claims, or coordinate through the board.")
        return None

    def claim_paths(self, paths: list[str], reason: str | None) -> int:
        if not paths:
            raise SquadError("Provide at least one path to claim")
        blocked = [f"{p} held by {c['agent']}" for p in paths for c in self.conflicts(p)]
        if blocked:
            raise SquadError("Already reserved: " + "; ".join(blocked))
        file = self.reservations / f"{self.name}.json"
        mine = read_json(file, [])
        for target in paths:
            value = self.normalize(target)
            if not any(r["path"] == value for r in mine):
                mine.append({"path": value, "reason": reason, "at": utcnow()})
                self.append_feed({"type": "reserve", "agent": self.name, "target": value,
                                  "preview": reason})
        atomic_write(file, mine)
        return len(paths)

    def release_paths(self, paths: list[str] | None = None) -> int:
        file = self.reservations / f"{self.name}.json"
        mine = read_json(file, [])
        releasing = [self.normalize(p) for p in paths] if paths else [r["path"] for r in mine]
        atomic_write(file, [r for r in mine if r["path"] not in releasing])
        for value in releasing:
            self.append_feed({"type": "release", "agent": self.name, "target": value})
        return len(releasing)

    # -- board -------------------------------------------------------------

    def board(self) -> dict:
        self.sweep_expired_claims()
        return read_json(self.board_path, {"slices": []})

    def slice_by_id(self, board: dict, slice_id: str) -> dict | None:
        for item in board.get("slices", []):
            if item.get("id") == slice_id:
                return item
        return None

    def available_for(self, board: dict) -> list[dict]:
        """Open slices whose dependencies are done, highest priority first."""
        done = {s["id"] for s in board.get("slices", []) if s.get("state") == "done"}
        out = [
            s for s in board.get("slices", [])
            if s.get("state") == "open" and all(dep in done for dep in s.get("deps", []))
        ]
        return sorted(out, key=lambda s: (-(s.get("priority") or 0), s.get("id", "")))

    def add_slice(self, title: str, goal: str, acceptance: str, files: list[str],
                  deps: list[str], priority: int = 0, slice_id: str | None = None) -> dict:
        if self.role != "master":
            raise SquadError("Only the master adds slices to the board")
        if not str(acceptance or "").strip():
            raise SquadError("A slice needs a non-empty acceptance command")
        with FileLock(self.board_lock):
            board = read_json(self.board_path, {"slices": []})
            existing = board.setdefault("slices", [])
            if slice_id is None:
                # Max+1 so a rejected add never shifts the numbering of later ones.
                numbers = [int(m.group(1)) for s in existing
                           if (m := re.fullmatch(r"s(\d+)", str(s.get("id") or "")))]
                slice_id = f"s{max(numbers) + 1 if numbers else 0:03d}"
            if any(s.get("id") == slice_id for s in existing):
                raise SquadError(f"Slice id already on the board: {slice_id}")
            for dep in deps:
                if not any(s.get("id") == dep for s in existing):
                    raise SquadError(f"Unknown dependency: {dep}")
            item = {
                "id": slice_id,
                "title": title,
                "goal": goal,
                "acceptance": acceptance,
                "files": list(files),
                "deps": list(deps),
                "priority": priority,
                "state": "open",
                "owner": None,
                "reviewer": None,
                "claimedAt": None,
                "messages": [],
                "history": [{"at": utcnow(), "by": self.name, "from": None, "to": "open"}],
            }
            existing.append(item)
            atomic_write(self.board_path, board)
        self.append_feed({"type": "board.add", "agent": self.name, "target": slice_id,
                          "preview": str(title)[:120]})
        return item

    def claim_slice(self, slice_id: str) -> dict:
        with FileLock(self.board_lock):
            board = read_json(self.board_path, {"slices": []})
            self._sweep_locked(board)
            item = self.slice_by_id(board, slice_id)
            if not item:
                raise SquadError(f"No slice with id {slice_id}")
            if item["state"] != "open":
                raise SquadError(f"Slice {slice_id} is {item['state']}, not open")
            deps_done = all(
                any(s.get("id") == dep and s.get("state") == "done"
                    for s in board.get("slices", []))
                for dep in item.get("deps", [])
            )
            if not deps_done:
                raise SquadError(f"Slice {slice_id} still has unfinished dependencies")
            item["state"] = "claimed"
            item["owner"] = self.name
            item["claimedAt"] = utcnow()
            item["history"].append({"at": utcnow(), "by": self.name, "from": "open",
                                    "to": "claimed"})
            atomic_write(self.board_path, board)
        self.append_feed({"type": "board.claim", "agent": self.name, "target": slice_id})
        if item.get("files"):
            self.claim_paths(item["files"], f"slice {slice_id}")
        return item

    def transition_slice(self, slice_id: str, to_state: str, reviewer: str | None = None,
                         evidence: dict | None = None) -> dict:
        if to_state not in SLICE_STATES:
            raise SquadError(f"Unknown state: {to_state}")
        with FileLock(self.board_lock):
            board = read_json(self.board_path, {"slices": []})
            self._sweep_locked(board)
            item = self.slice_by_id(board, slice_id)
            if not item:
                raise SquadError(f"No slice with id {slice_id}")
            frm = item.get("state")
            if (frm, to_state) not in TRANSITIONS:
                raise SquadError(f"Illegal transition {frm} -> {to_state}")
            if frm == "claimed" and item.get("owner") != self.name and to_state != "open":
                raise SquadError("Only the owner transitions out of claimed")
            proof = None
            if frm == "review" and to_state == "done":
                approver = reviewer or self.name
                if approver == item.get("owner"):
                    raise SquadError("The reviewer must not be the author")
                if self.role == "worker" and approver != self.name:
                    raise SquadError("You are not the assigned reviewer for this approval")
                proof = _acceptance_evidence(evidence, item)
                item["reviewer"] = approver
            if frm == "changes" and to_state == "review" and item.get("owner") != self.name:
                raise SquadError("Only the owner resubmits to review")
            if frm == "blocked" and self.role != "master":
                raise SquadError("Only the master unblocks")
            if to_state == "cancelled" and self.role != "master":
                raise SquadError("Only the master cancels")
            item["state"] = to_state
            if to_state in ("open", "cancelled"):
                item["owner"] = None
                item["claimedAt"] = None
            entry = {"at": utcnow(), "by": self.name, "from": frm, "to": to_state}
            if proof:
                item["evidence"] = proof
                entry["evidence"] = proof
            item["history"].append(entry)
            atomic_write(self.board_path, board)
        if to_state in ("open", "cancelled", "done"):
            self.release_paths([f for f in item.get("files", [])])
        self.append_feed({"type": "board.transition", "agent": self.name, "target": slice_id,
                          "preview": f"{frm} -> {to_state}"})
        return item

    def block_slice(self, slice_id: str, reason: str) -> dict:
        with FileLock(self.board_lock):
            board = read_json(self.board_path, {"slices": []})
            item = self.slice_by_id(board, slice_id)
            if not item:
                raise SquadError(f"No slice with id {slice_id}")
            if item["state"] in ("blocked", "done", "cancelled"):
                raise SquadError(f"Slice {slice_id} is already {item['state']}")
            item["blockedReason"] = reason
            item["history"].append({"at": utcnow(), "by": self.name,
                                    "from": item["state"], "to": "blocked"})
            item["state"] = "blocked"
            atomic_write(self.board_path, board)
        self.append_feed({"type": "board.block", "agent": self.name, "target": slice_id,
                          "preview": str(reason)[:120]})
        self.notify_master(f"Slice {slice_id} is blocked: {reason}", slice_id, "blocked")
        return item

    def sweep_expired_claims(self) -> None:
        with FileLock(self.board_lock):
            board = read_json(self.board_path, {"slices": []})
            changed = self._sweep_locked(board)
            if changed:
                atomic_write(self.board_path, board)

    def _sweep_locked(self, board: dict) -> bool:
        """Return claims to open when the owner held them past the TTL without
        progress. Called with the board lock already held."""
        changed = False
        for item in board.get("slices", []):
            if item.get("state") != "claimed" or not item.get("claimedAt"):
                continue
            try:
                claimed = datetime.fromisoformat(item["claimedAt"])
                age = (datetime.now(timezone.utc) - claimed).total_seconds()
            except ValueError:
                continue
            if age < CLAIM_TTL_SECONDS:
                continue
            if not self.agent_alive(item.get("owner") or ""):
                reason = "owner is no longer alive"
            else:
                reason = f"claim exceeded {CLAIM_TTL_SECONDS // 60} minutes"
            item["state"] = "open"
            item["owner"] = None
            item["claimedAt"] = None
            item["history"].append({"at": utcnow(), "by": "system", "from": "claimed",
                                    "to": "open", "reason": reason})
            changed = True
            self.append_feed({"type": "board.ttl", "agent": "system",
                              "target": item.get("id"), "preview": reason})
        return changed

    # -- guards ------------------------------------------------------------

    def send_message(self, to: str, text: str, slice_id: str, transition: str) -> str:
        to = self.resolve_recipient(to)
        if to == self.name:
            raise SquadError("Choose another agent as recipient")
        if not str(text or "").strip():
            raise SquadError("Message is empty")
        if not str(slice_id or "").strip() or not str(transition or "").strip():
            raise SquadError("Every message must reference a slice id and a board transition")
        if not any(p.get("name") == to for p in self.peers()):
            raise SquadError(f"{to} is not a live squad agent")
        with FileLock(self.board_lock):
            board = read_json(self.board_path, {"slices": []})
            item = self.slice_by_id(board, slice_id)
            if not item:
                raise SquadError(f"No slice with id {slice_id}; the board and message must agree")
            frm = item.get("state")
            messages = item.setdefault("messages", [])
            messages.append({"from": self.name, "to": to, "at": utcnow(),
                             "transition": transition})
            # Pair cutoff: one pair trading more than PAIR_CUTOFF messages with no
            # board change between them means the slice is going in circles.
            recent = [m for m in messages if {m["from"], m["to"]} == {self.name, to}]
            if len(recent) > PAIR_CUTOFF:
                reason = (f"pair cutoff: {self.name} and {to} exchanged {len(recent)} messages "
                          f"without a board change")
                item["state"] = "blocked"
                item["blockedReason"] = reason
                item["history"].append({"at": utcnow(), "by": "system", "from": frm,
                                        "to": "blocked"})
                atomic_write(self.board_path, board)
                self.append_feed({"type": "board.block", "agent": "system",
                                  "target": slice_id, "preview": "pair cutoff"})
                self.deliver("master", f"[{slice_id}/blocked] pair cutoff between "
                             f"{self.name} and {to}; unblock or re-slice the work.")
                raise SquadError(reason)
            # Budget: too many peer messages on one slice means the plan was wrong.
            if len(messages) > MESSAGE_BUDGET:
                reason = f"message budget exceeded ({len(messages)} > {MESSAGE_BUDGET})"
                item["state"] = "blocked"
                item["blockedReason"] = reason
                item["history"].append({"at": utcnow(), "by": "system", "from": frm,
                                        "to": "blocked"})
                atomic_write(self.board_path, board)
                self.append_feed({"type": "board.block", "agent": "system",
                                  "target": slice_id, "preview": "message budget"})
                if self.name != "master" and self.agent_alive("master"):
                    self.deliver("master", f"[{slice_id}/blocked] message budget exceeded "
                                 f"({len(messages)} > {MESSAGE_BUDGET}); replan this slice.")
                raise SquadError(reason)
            atomic_write(self.board_path, board)
        mid = self.deliver(to, text)
        self.append_feed({"type": "message", "agent": self.name, "target": to,
                          "preview": str(text)[:120]})
        return mid

    def notify_master(self, text: str, slice_id: str, transition: str) -> None:
        """System-side notices bypass the peer guards but still carry slice context."""
        if self.name == "master":
            return
        if not self.agent_alive("master"):
            return
        self.deliver("master", f"[{slice_id}/{transition}] {text}")
        self.append_feed({"type": "notice", "agent": self.name, "target": "master",
                          "preview": str(text)[:120]})
