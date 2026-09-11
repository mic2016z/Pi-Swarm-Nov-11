"""Quad Squad colony plugin for Hermes Agent.

Loaded by Hermes when the Quad Squad app launches a pane with:

    SQUAD_AGENT    'master' or a worker number
    SQUAD_PROJECT  absolute project path
    SQUAD_ROOT     per-agent state directory
    SQUAD_APP_PID  pid of the owning desktop app (master only)

Without those variables the plugin stays completely inert, so the same Hermes
install works normally outside the squad.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path

from .squad_core import (Squad, SquadError, atomic_write, read_json, settle_receipt_patch,
                         utcnow)

AGENT = os.environ.get("SQUAD_AGENT", "")
NAME = "master" if AGENT == "master" else (f"hermes-{AGENT}" if AGENT.isdigit() else "")
PROJECT = os.environ.get("SQUAD_PROJECT", "")
ROOT = os.environ.get("SQUAD_ROOT", "")
APP_PID = os.environ.get("SQUAD_APP_PID", "")

IS_MASTER = AGENT == "master"
RELAY_ROOT = Path(ROOT).parent if ROOT else None
MAX_DELIVERY_ATTEMPTS = 50        # then the message is parked, never dropped
DELIVERING_TIMEOUT = 600          # a claimed relay request with no turn fails


def enabled() -> bool:
    return bool(NAME and PROJECT and ROOT)


class _State:
    def __init__(self, squad: Squad):
        self.squad = squad
        self.ctx = None
        self.session_id: str | None = None
        self.busy = False
        self.last_response: str = ""
        self.last_response_ts: float = 0.0
        self.seen_board_at: float = 0.0
        self.last_wake: float = 0.0
        self.last_heartbeat: float = 0.0
        self.inject_warning_shown = False
        # Durable delivery: message id -> (attempts, next try at unix time).
        self.delivery_failures: dict[str, tuple[int, float]] = {}
        # Master relay bookkeeping.
        self.instance = str(uuid.uuid4())
        self.queued: list[str] = []
        self.active_request: str | None = None
        self.active_since: float = 0.0


STATE: _State | None = None


def _receipt_path(request_id: str) -> Path:
    return RELAY_ROOT / "relay" / "requests" / f"{request_id}.json"


def _publish_runtime(extra: dict | None = None) -> None:
    if not IS_MASTER or not RELAY_ROOT:
        return
    state = STATE
    atomic_write(RELAY_ROOT / "master-runtime.json", {
        "project": PROJECT,
        "pid": os.getpid(),
        "app_pid": int(APP_PID) if APP_PID.isdigit() else None,
        "sessionId": state.session_id if state else None,
        "instance": state.instance if state else "",
        "ready": bool(state and state.session_id),
        "busy": bool(state and state.active_request),
        "queued": len(state.queued) if state else 0,
        "activeRequest": state.active_request if state else None,
        **(extra or {}),
    })


def _update_receipt(request_id: str, patch: dict) -> dict | None:
    receipt = read_json(_receipt_path(request_id), None)
    state = STATE
    if not receipt or not state or receipt.get("instance") != state.instance:
        return None
    updated = {**receipt, **patch}
    atomic_write(_receipt_path(request_id), updated)
    return updated


def _claim_request(request_id: str) -> bool:
    receipt = read_json(_receipt_path(request_id), None)
    if not receipt or receipt.get("status") == "cancelled":
        return False
    state = STATE
    state.active_request = request_id
    state.active_since = time.time()
    _update_receipt(request_id, {"status": "delivering", "instance": state.instance,
                                 "sessionId": state.session_id})
    _publish_runtime()
    return True


def _board_summary() -> str:
    state = STATE
    try:
        board = state.squad.board()
    except Exception:
        return ""
    slices = board.get("slices", [])
    if not slices:
        return "Board is empty."
    rows = ", ".join(f"{s.get('id')} {s.get('state')}" for s in slices[:10])
    more = f" (+{len(slices) - 10} more)" if len(slices) > 10 else ""
    return f"{len(slices)} slices: {rows}{more}"


def _fail_active_request(reason: str) -> None:
    state = STATE
    request_id = state.active_request
    if not request_id:
        return
    _update_receipt(request_id, {"status": "failed", "error": reason,
                                 "completed": time.time()})
    try:
        (RELAY_ROOT / "relay" / "queue" / f"{request_id}.json").unlink()
    except OSError:
        pass
    state.active_request = None
    if state.queued:
        _claim_request(state.queued.pop(0))
    _publish_runtime()


def _settle_request() -> None:
    state = STATE
    if not state or not state.active_request:
        return
    request_id = state.active_request
    # An interrupted turn (e.g. an injection aborting the running API call)
    # fires on_session_end with a stale last_response. Only settle once a
    # response produced after the claim exists; the pump's delivery timeout
    # fails requests whose turn never completes.
    if state.last_response_ts < state.active_since:
        return
    receipt = read_json(_receipt_path(request_id), None)
    if receipt:
        patch = settle_receipt_patch(receipt, state.last_response, _board_summary())
        _update_receipt(request_id, patch)
    try:
        (RELAY_ROOT / "relay" / "queue" / f"{request_id}.json").unlink()
    except OSError:
        pass
    state.active_request = None
    if state.queued:
        _claim_request(state.queued.pop(0))
    _publish_runtime()


def _briefing() -> str:
    state = STATE
    squad = state.squad
    parts: list[str] = []
    for doc in ("agent.md", "context.md", "todo.md"):
        try:
            text = (Path(PROJECT) / ".squad" / squad.name / doc).read_text(encoding="utf-8")
            if text.strip():
                parts.append(f"### {doc}\n{text.strip()}")
        except OSError:
            pass
    roster = ", ".join(p["name"] for p in squad.peers()) or "none currently registered"
    parts.append(
        f"### Squad\nYou are {squad.name} in a Hermes Agent quad squad on {PROJECT}. "
        f"Connected peers: {roster}.\n"
        "Reserve files with squad_claims before editing and release them when finished; "
        "writes to another agent's reserved paths are denied automatically. Work only "
        "through the shared board (squad_board): claim the highest-priority open slice "
        "whose dependencies are done, run its acceptance command until it exits zero, "
        "transition it to review, then message exactly one idle peer. Message peers with "
        "squad_message only to hand off work, ask a focused question, or report a result; "
        "every message must carry a slice id and a board transition. Stay idle without "
        "model calls when no slice is available to you. Never assume which model you or "
        "a peer is running.")
    try:
        board = squad.board()
        mine = [s for s in board.get("slices", []) if s.get("owner") == squad.name
                and s.get("state") in ("claimed", "changes")]
        reviews = [s for s in board.get("slices", [])
                   if s.get("state") == "review" and s.get("owner") != squad.name]
        available = squad.available_for(board)
        lines = []
        if mine:
            lines.append("your slices: " + ", ".join(f"{s['id']}({s['state']})" for s in mine))
        if reviews:
            lines.append("awaiting review: " + ", ".join(s["id"] for s in reviews))
        lines.append(f"claimable now: {len(available)}")
        parts.append("### Board\n" + "; ".join(lines))
    except Exception:
        pass
    return "\n\n".join(parts)[:9500]


def _log_assistant(text: str) -> None:
    if not text.strip():
        return
    squad = STATE.squad
    logs = Path(ROOT).parent / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    with open(logs / f"{squad.name}.md", "a", encoding="utf-8") as handle:
        handle.write(f"## assistant · {utcnow()}\n\n{text.strip()}\n\n")


# -- pump --------------------------------------------------------------------

def _pump() -> None:
    state = STATE
    squad = state.squad
    while True:
        try:
            now = time.time()
            if now - state.last_heartbeat > 15:
                state.last_heartbeat = now
                squad.update_activity("busy" if state.busy else "idle")
                if IS_MASTER:
                    _publish_runtime()

            # A claimed relay request whose injection never produced a turn
            # must not rest at "delivering" forever.
            if (IS_MASTER and state.active_request and state.active_since
                    and now - state.active_since > DELIVERING_TIMEOUT):
                _fail_active_request(
                    "Master pane never started a turn for this request; "
                    "delivery could not be confirmed")

            for file, message in squad.peek_inbox():
                request_id = message.get("replyTo") if isinstance(message.get("replyTo"), str) else None
                if IS_MASTER and request_id and message.get("from") == "user":
                    if state.active_request:
                        if request_id not in state.queued and request_id != state.active_request:
                            state.queued.append(request_id)
                            _publish_runtime()
                        squad.ack_message(file)  # ownership moved to the queue
                        continue
                    if not _claim_request(request_id):
                        squad.ack_message(file)  # cancelled or foreign; nothing to do
                        continue
                attempts, next_try = state.delivery_failures.get(str(message.get("id")), (0, 0.0))
                if now < next_try:
                    continue
                delivered = _inject(f"Message from {message.get('from')}:\n{message.get('text')}")
                if delivered:
                    state.delivery_failures.pop(str(message.get("id")), None)
                    squad.ack_message(file)
                    continue
                attempts += 1
                if attempts >= MAX_DELIVERY_ATTEMPTS:
                    squad.park_undelivered(file)
                    squad.append_feed({"type": "delivery.dropped", "agent": squad.name,
                                       "target": str(message.get("id")),
                                       "preview": f"undelivered after {attempts} attempts"})
                    if IS_MASTER and request_id and state.active_request == request_id:
                        _fail_active_request(
                            "Message could not be delivered to the master pane "
                            f"after {attempts} attempts")
                    continue
                state.delivery_failures[str(message.get("id"))] = (
                    attempts, now + min(1.2 * (2 ** min(attempts, 6)), 60.0))
                squad.append_feed({"type": "delivery.retry", "agent": squad.name,
                                   "target": str(message.get("id")),
                                   "preview": f"attempt {attempts}"})

            # Board wake: an idle worker with claimable work must not sleep through
            # a board change; an idle worker with no available slice must not wake.
            if not state.busy:
                try:
                    mtime = squad.board_path.stat().st_mtime
                    if mtime > state.seen_board_at + 0.001:
                        state.seen_board_at = mtime
                        board = squad.board()
                        if squad.available_for(board) and now - state.last_wake > 5:
                            state.last_wake = now
                            available = squad.available_for(board)
                            titles = ", ".join(f"{s['id']} {s['title']}" for s in available[:4])
                            _inject("The task board changed and has work you can claim: "
                                    f"{titles}. Use squad_board to claim your slice.")
                except OSError:
                    pass
        except Exception:
            pass
        time.sleep(1.2)


def _inject(text: str) -> bool:
    state = STATE
    try:
        delivered = bool(state.ctx and state.ctx.inject_message(text))
        if not delivered and not state.inject_warning_shown:
            state.inject_warning_shown = True
        return delivered
    except Exception:
        return False


# -- tools -------------------------------------------------------------------

def _result(value) -> str:
    return value if isinstance(value, str) else json.dumps(value, indent=2)


def _tool_squad_message(args: dict, **kwargs) -> str:
    squad = STATE.squad
    mid = squad.send_message(args.get("to", ""), args.get("text", ""),
                             args.get("slice", ""), args.get("transition", ""))
    if IS_MASTER and STATE.active_request:
        receipt = read_json(_receipt_path(STATE.active_request), None)
        if receipt and receipt.get("status") in ("delivering", "delegated"):
            delegations = list(receipt.get("delegations") or [])
            target = squad.resolve_recipient(args.get("to", ""))
            if target not in delegations:
                delegations.append(target)
            _update_receipt(STATE.active_request, {"status": "delegated",
                                                   "delegations": delegations})
    return _result({"delivered": True, "to": squad.resolve_recipient(args.get("to", "")),
                    "id": mid})


def _tool_squad_claims(args: dict, **kwargs) -> str:
    squad = STATE.squad
    action = args.get("action", "list")
    if action == "list":
        held = squad.read_reservations()
        if not held:
            return "No active reservations."
        return "\n".join(f"{r['agent']}: {r['path']}"
                         + (f" ({r.get('reason')})" if r.get("reason") else "") for r in held)
    if action == "claim":
        count = squad.claim_paths(args.get("paths") or [], args.get("task"))
        return _result({"reserved": count})
    if action == "release":
        count = squad.release_paths(args.get("paths"))
        return _result({"released": count})
    raise SquadError("action must be list, claim or release")


def _tool_squad_board(args: dict, **kwargs) -> str:
    squad = STATE.squad
    action = args.get("action", "list")
    if action == "list":
        board = squad.board()
        slices = [{
            "id": s.get("id"), "title": s.get("title"), "state": s.get("state"),
            "owner": s.get("owner"), "reviewer": s.get("reviewer"),
            "deps": s.get("deps", []), "priority": s.get("priority", 0),
            "messages": len(s.get("messages", [])),
            "acceptance": s.get("acceptance"), "files": s.get("files", []),
            "claimable": s in squad.available_for(board),
        } for s in board.get("slices", [])]
        return _result({"slices": slices})
    if action == "add":
        item = squad.add_slice(args.get("title", ""), args.get("goal", ""),
                               args.get("acceptance", ""), args.get("files") or [],
                               args.get("deps") or [], int(args.get("priority") or 0),
                               args.get("id"))
        return _result({"added": item["id"], "state": item["state"]})
    if action == "claim":
        item = squad.claim_slice(args.get("slice", ""))
        return _result({"claimed": item["id"], "files": item.get("files", []),
                        "acceptance": item.get("acceptance")})
    if action == "transition":
        item = squad.transition_slice(args.get("slice", ""), args.get("to", ""),
                                      args.get("reviewer"), args.get("evidence"))
        return _result({"slice": item["id"], "state": item["state"]})
    if action == "block":
        item = squad.block_slice(args.get("slice", ""), args.get("reason", "blocked"))
        return _result({"slice": item["id"], "state": item["state"]})
    if action == "release":
        item = squad.transition_slice(args.get("slice", ""), "open")
        return _result({"slice": item["id"], "state": item["state"]})
    raise SquadError("action must be list, add, claim, transition, block or release")


def _tool_squad_tasks(args: dict, **kwargs) -> str:
    squad = STATE.squad

    def list_for(who: str) -> Path:
        return Path(PROJECT) / ".squad" / who / "todo.md"

    action = args.get("action", "read")
    if action == "read":
        who = squad.resolve_recipient(args.get("agent", "")) if args.get("agent") else squad.name
        try:
            return list_for(who).read_text(encoding="utf-8") or "The list is empty."
        except OSError:
            return "The list is empty."
    if action == "assign":
        if not IS_MASTER:
            raise SquadError("Only the master assigns tasks; use the board instead")
        to = squad.resolve_recipient(args.get("to", ""))
        if to == "master":
            raise SquadError("Assign to a worker, not to yourself")
        tasks = args.get("tasks") or []
        if not tasks:
            raise SquadError("Provide at least one task")
        file = list_for(to)
        try:
            text = file.read_text(encoding="utf-8")
        except OSError:
            text = ""
        heading = "## Assigned by master"
        if heading not in text:
            text = text.rstrip("\n") + "\n\n" + heading + "\n"
        text = text.rstrip("\n") + "\n" + "\n".join(f"- [ ] {t.strip()}" for t in tasks) + "\n"
        atomic_write(file, text)
        squad.append_feed({"type": "task.assign", "agent": squad.name, "target": to,
                           "preview": str(tasks[0])[:100]})
        squad.deliver(to, f"Your todo list has been updated with {len(tasks)} task(s). "
                          "Read todo.md, work the topmost unchecked item, and tick each one "
                          "with squad_tasks once its check has actually passed.")
        return _result({"assigned": len(tasks), "to": to})
    if action == "done":
        item = str(args.get("item", "")).strip()
        if not item:
            raise SquadError("Say which item to tick")
        file = list_for(squad.name)
        try:
            text = file.read_text(encoding="utf-8")
        except OSError:
            raise SquadError("You have no task list")
        needle = item.lower()
        lines = text.splitlines()
        index = next((i for i, line in enumerate(lines)
                      if "- [ ]" in line and needle in line.lower()), -1)
        if index < 0:
            raise SquadError("No unchecked item matches that text")
        note = str(args.get("evidence") or "").strip()
        if not note:
            raise SquadError("Tick items only with evidence: pass one short line proving the check passed")
        lines[index] = lines[index].replace("- [ ]", "- [x]") + f" — {note}"
        atomic_write(file, "\n".join(lines) + "\n")
        squad.append_feed({"type": "task.done", "agent": squad.name,
                           "preview": lines[index][:120]})
        remaining = sum(1 for line in lines if "- [ ]" in line)
        return _result({"ticked": True, "remaining": remaining})
    raise SquadError("action must be read, assign or done")


def _tool_squad_roster(args: dict, **kwargs) -> str:
    squad = STATE.squad
    rows = [{"name": squad.name, "role": squad.role, "self": True}]
    rows += [{"name": p.get("name"), "role": p.get("role", "worker")} for p in squad.peers()]
    return "\n".join(f"{r['name']} ({r['role']}){' [you]' if r.get('self') else ''}"
                     for r in rows)


# -- hooks -------------------------------------------------------------------

def _hook_pre_tool_call(tool_name: str = "", args: dict | None = None, **kwargs):
    squad = STATE.squad
    reason = squad.deny_tool(tool_name, args or {})
    if reason:
        squad.append_feed({"type": "claim.denied", "agent": squad.name,
                           "target": str(tool_name), "preview": reason[:120]})
        return {"action": "block", "message": reason}
    return None


def _hook_pre_llm_call(**kwargs):
    state = STATE
    state.busy = True
    state.squad.update_activity("busy")
    return {"context": _briefing()}


def _hook_post_llm_call(**kwargs):
    state = STATE
    state.busy = True  # the turn is still open until on_session_end
    # post_llm_call fires once per completed turn with assistant_response
    # (never on interrupted turns). This is the authoritative settle signal.
    value = kwargs.get("assistant_response")
    if not value:
        for key in ("response", "text", "content", "output"):
            value = kwargs.get(key)
            if isinstance(value, str) and value.strip():
                break
    if isinstance(value, str) and value.strip():
        state.last_response = value
        state.last_response_ts = time.time()
    _log_assistant(state.last_response)
    return None


def _adopt_session(session_id: str) -> None:
    """Record this pane's session id. on_session_start only fires for
    brand-new sessions, so resumed panes adopt the id from the per-request
    hook instead; whichever arrives first wins."""
    state = STATE
    if not session_id or state.session_id:
        return
    state.session_id = session_id
    atomic_write(Path(ROOT) / "session.json",
                 {"agent": state.squad.name, "sessionID": session_id, "project": PROJECT})
    state.squad.register({"sessionID": session_id})
    _publish_runtime()


def _hook_session_start(session_id: str = "", **kwargs):
    if session_id:
        _adopt_session(session_id)


def _hook_pre_api_request(session_id: str = "", **kwargs):
    if session_id:
        _adopt_session(session_id)


def _hook_session_end(**kwargs):
    state = STATE
    state.busy = False
    state.squad.update_activity("idle")
    if IS_MASTER:
        _settle_request()
    _publish_runtime()


# -- registration ------------------------------------------------------------

SCHEMAS = {
    "squad_message": {
        "name": "squad_message",
        "description": "Send an actionable message to another squad agent. Recipients: "
                       "master, hermes-1, hermes-2, ... Every message must reference a "
                       "slice id and the board transition it accompanies. Never send "
                       "acknowledgements.",
        "parameters": {"type": "object", "properties": {
            "to": {"type": "string", "description": "Recipient: master or hermes-N"},
            "text": {"type": "string", "description": "The message. Include file:line evidence and one specific request."},
            "slice": {"type": "string", "description": "Slice id this message is about, e.g. s003"},
            "transition": {"type": "string", "description": "The board transition this message accompanies, e.g. 's003 claimed -> review'"},
        }, "required": ["to", "text", "slice", "transition"]},
    },
    "squad_claims": {
        "name": "squad_claims",
        "description": "Cooperative file ownership. Inspect current reservations, claim "
                       "paths before editing, or release your claims when finished. "
                       "Writes to paths another agent holds are denied.",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string", "enum": ["list", "claim", "release"]},
            "paths": {"type": "array", "items": {"type": "string"},
                      "description": "Project-relative paths for claim/release"},
            "task": {"type": "string", "description": "Why the paths are being claimed (slice id)"},
        }, "required": ["action"]},
    },
    "squad_board": {
        "name": "squad_board",
        "description": "The shared task board. list shows slices; the master adds slices "
                       "(acceptance command required); workers claim the highest-priority "
                       "open slice with dependencies done, run acceptance until it exits "
                       "zero, then transition to review; the reviewer (never the author) "
                       "approves done; only the master unblocks or cancels.",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string", "enum": ["list", "add", "claim", "transition", "block", "release"]},
            "slice": {"type": "string", "description": "Slice id for claim/transition/block/release"},
            "title": {"type": "string"}, "goal": {"type": "string"},
            "acceptance": {"type": "string", "description": "Command whose zero exit proves the slice (required on add)"},
            "files": {"type": "array", "items": {"type": "string"}},
            "deps": {"type": "array", "items": {"type": "string"}},
            "priority": {"type": "number"},
            "id": {"type": "string"},
            "to": {"type": "string", "description": "transition target: review, done, changes, open"},
            "reason": {"type": "string"},
            "evidence": {"type": "object", "description": "review -> done only: run the acceptance command and pass {command, exitCode}. exitCode must be 0.", "properties": {
                "command": {"type": "string"},
                "exitCode": {"type": "number"},
            }},
        }, "required": ["action"]},
    },
    "squad_tasks": {
        "name": "squad_tasks",
        "description": "Read or extend an agent task list (todo.md). The master assigns a "
                       "batch of tasks to a worker; a worker ticks an item once its check "
                       "has passed. Items the user wrote are never altered.",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string", "enum": ["read", "assign", "done"]},
            "agent": {"type": "string", "description": "Whose list to read; defaults to your own"},
            "to": {"type": "string", "description": "assign: the worker receiving the tasks"},
            "tasks": {"type": "array", "items": {"type": "string"}},
            "item": {"type": "string", "description": "done: text identifying the item to tick"},
            "evidence": {"type": "string", "description": "done (required): one short line proving the check passed"},
        }, "required": ["action"]},
    },
    "squad_roster": {
        "name": "squad_roster",
        "description": "List the squad agents that are currently registered and alive.",
        "parameters": {"type": "object", "properties": {}},
    },
}

_HANDLERS = {
    "squad_message": _tool_squad_message,
    "squad_claims": _tool_squad_claims,
    "squad_board": _tool_squad_board,
    "squad_tasks": _tool_squad_tasks,
    "squad_roster": _tool_squad_roster,
}


def _wrap(handler):
    def run(args: dict, **kwargs) -> str:
        try:
            return handler(args or {}, **kwargs)
        except SquadError as problem:
            return json.dumps({"error": str(problem)})
        except Exception as problem:  # never raise into the agent loop
            return json.dumps({"error": f"{type(problem).__name__}: {problem}"})
    return run


def register(ctx) -> None:
    if not enabled():
        return
    global STATE
    squad = Squad(NAME, PROJECT, ROOT)
    STATE = _State(squad)
    STATE.ctx = ctx
    squad.inbox.mkdir(parents=True, exist_ok=True)
    squad.registry.mkdir(parents=True, exist_ok=True)
    squad.register()
    squad.append_feed({"type": "join", "agent": NAME})
    _publish_runtime()
    STATE.seen_board_at = squad.board_path.stat().st_mtime if squad.board_path.exists() else 0.0
    # A resumed pane never fires on_session_start; adopt the session id the
    # app relaunched us with (pre_api_request corrects it on the first turn
    # if hermes started a different session).
    saved = read_json(Path(ROOT) / "session.json", {})
    if isinstance(saved.get("sessionID"), str) and saved["sessionID"].strip():
        _adopt_session(saved["sessionID"].strip())

    for tool_name, schema in SCHEMAS.items():
        ctx.register_tool(name=tool_name, toolset="squad", schema=schema,
                          handler=_wrap(_HANDLERS[tool_name]))
    ctx.register_hook("pre_tool_call", _hook_pre_tool_call)
    ctx.register_hook("pre_llm_call", _hook_pre_llm_call)
    ctx.register_hook("post_llm_call", _hook_post_llm_call)
    ctx.register_hook("pre_api_request", _hook_pre_api_request)
    ctx.register_hook("on_session_start", _hook_session_start)
    ctx.register_hook("on_session_end", _hook_session_end)

    threading.Thread(target=_pump, daemon=True, name="squad-pump").start()


def dispose() -> None:
    if not STATE:
        return
    squad = STATE.squad
    squad.append_feed({"type": "leave", "agent": NAME})
    # An in-flight relay request is interrupted, never silently dropped: the
    # caller must be able to tell "no answer" from "answered".
    for request_id in [STATE.active_request, *STATE.queued]:
        if not request_id:
            continue
        receipt = read_json(_receipt_path(request_id), None)
        if receipt and receipt.get("status") not in ("replied", "cancelled", "failed"):
            _update_receipt(request_id, {"status": "interrupted",
                                         "error": "Master pane closed before replying"})
    squad.unregister()
