"""Quad Squad coordination core tests: real files, real locks, no agents required.

Every Squad registers with the test process's own pid, so the liveness checks
see live owners without spawning real Hermes panes.
"""

import json
import subprocess
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hermes-plugin"))

from squad.squad_core import (CLAIM_TTL_SECONDS, MESSAGE_BUDGET, PAIR_CUTOFF, Squad,
                              SquadError, read_json, settle_receipt_patch)


@pytest.fixture()
def colony(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    state = tmp_path / "state"
    agents = {
        "master": Squad("master", str(project), str(state / "hermes-master")),
        "w1": Squad("hermes-1", str(project), str(state / "hermes-1")),
        "w2": Squad("hermes-2", str(project), str(state / "hermes-2")),
    }
    for agent in agents.values():
        agent.inbox.mkdir(parents=True, exist_ok=True)
        agent.register()
    return agents


def test_registry_lists_only_live_peers(colony, tmp_path):
    stale = Squad("hermes-9", colony["w1"].project, str(tmp_path / "state" / "hermes-9"))
    stale.register()
    # An exited pid must not count as alive.
    record = json.loads((colony["w1"].registry / "hermes-9.json").read_text())
    record["pid"] = 99999999
    (colony["w1"].registry / "hermes-9.json").write_text(json.dumps(record))

    names = [p["name"] for p in colony["w1"].peers()]
    assert "master" in names and "hermes-2" in names
    assert "hermes-9" not in names
    assert "hermes-1" not in names  # never yourself


def test_recipient_resolution(colony):
    squad = colony["w1"]
    assert squad.resolve_recipient("master") == "master"
    assert squad.resolve_recipient("@Hermes-2") == "hermes-2"
    assert squad.resolve_recipient("oc-3") == "hermes-3"  # legacy alias
    with pytest.raises(SquadError):
        squad.resolve_recipient("worker-one")


def test_inbox_delivery_and_drain_order(colony):
    sender = colony["w2"]
    first = sender.deliver("hermes-1", "one")
    second = sender.deliver("hermes-1", "two")
    messages = colony["w1"].drain_inbox()
    assert [m["text"] for m in messages] == ["one", "two"]
    assert messages[0]["id"] == first and messages[1]["id"] == second
    assert colony["w1"].drain_inbox() == []


def test_peek_does_not_remove_and_ack_is_explicit(colony):
    colony["w2"].deliver("hermes-1", "stay put")
    pending = colony["w1"].peek_inbox()
    assert len(pending) == 1
    file, message = pending[0]
    assert message["text"] == "stay put"
    # A failed injection leaves the message in place for retry.
    assert colony["w1"].peek_inbox() == [(file, message)]
    colony["w1"].ack_message(file)
    assert colony["w1"].peek_inbox() == []


def test_park_undelivered_moves_message_out_of_inbox(colony):
    colony["w2"].deliver("hermes-1", "exhausted")
    file, _ = colony["w1"].peek_inbox()[0]
    parked = colony["w1"].park_undelivered(file)
    assert parked.parent.name == "hermes-1"
    assert parked.parent.parent.name == "undelivered"
    assert colony["w1"].peek_inbox() == []


def test_reservations_block_conflicts_and_cover_directories(colony):
    colony["w1"].claim_paths(["src/app.js"], "slice s001")
    with pytest.raises(SquadError, match="held by hermes-1"):
        colony["w2"].claim_paths(["src/app.js"], "slice s002")
    # A directory reservation covers everything beneath it.
    colony["w2"].claim_paths(["docs"], "slice s002")
    with pytest.raises(SquadError):
        colony["master"].claim_paths(["docs/guide.md"], "edit")
    # The owner is never in conflict with itself.
    colony["w1"].claim_paths(["src/app.js", "src/lib.js"], "again")
    # Release works by path and releases everything when given none.
    assert colony["w2"].release_paths(["docs"]) == 1
    assert colony["w2"].release_paths() == 0  # already empty


def test_dead_agent_reservations_are_ignored(colony, tmp_path):
    colony["w2"].claim_paths(["legacy.txt"], "slice s001")
    # Liveness comes from the registry, so poison the pid there.
    reg = json.loads((colony["w1"].registry / "hermes-2.json").read_text())
    reg["pid"] = 99999999
    (colony["w1"].registry / "hermes-2.json").write_text(json.dumps(reg))
    assert colony["master"].conflicts("legacy.txt") == []


def test_denies_write_to_reserved_paths_across_tools(colony):
    colony["w1"].claim_paths(["src/app.js"], "slice s001")
    colony["w2"].claim_paths(["docs"], "slice s002")
    # File tools in any of the covered names.
    for tool in ("write_file", "patch", "edit_file", "apply_patch"):
        reason = colony["master"].deny_tool(tool, {"path": "src/app.js"})
        assert reason and "hermes-1" in reason
    assert colony["master"].deny_tool("write_file", {"file": "docs/guide.md"}) is not None
    # A path nobody holds is fine, and the owner never conflicts with itself.
    assert colony["master"].deny_tool("write_file", {"path": "free.js"}) is None
    assert colony["w1"].deny_tool("write_file", {"path": "src/app.js"}) is None


def test_denies_shell_touching_reserved_paths(colony):
    colony["w1"].claim_paths(["src/app.js"], "slice s001")
    command = {"command": "echo done >> src/app.js"}
    reason = colony["w2"].deny_tool("bash", command)
    assert reason and "hermes-1" in reason
    # Shell over an unreserved path is allowed.
    assert colony["w2"].deny_tool("bash", {"command": "npm test"}) is None


def test_git_mutation_is_master_only(colony):
    reason = colony["w1"].deny_tool("bash", {"command": "git commit -am wip"})
    assert reason and "master" in reason
    assert colony["w1"].deny_tool("shell", {"command": "git push origin main"}) is not None
    assert colony["master"].deny_tool("bash", {"command": "git commit -am wip"}) is None
    # Non-mutating git is fine for anyone.
    assert colony["w1"].deny_tool("bash", {"command": "git status"}) is None


def test_board_add_requires_master_and_acceptance(colony):
    with pytest.raises(SquadError, match="master"):
        colony["w1"].add_slice("t", "g", "pytest --x", [], [])
    with pytest.raises(SquadError, match="acceptance"):
        colony["master"].add_slice("t", "g", "  ", [], [])
    with pytest.raises(SquadError, match="dependency"):
        colony["master"].add_slice("t", "g", "true", [], ["s999"])
    colony["master"].add_slice("contracts", "types and schemas", "pytest tests/", [],
                               [], 5, "s000")
    colony["master"].add_slice("feature", "the thing", "npm test", ["src/a.js"], ["s000"])
    board = colony["w1"].board()
    assert [s["id"] for s in board["slices"]] == ["s000", "s001"]


def test_deps_gate_claiming(colony):
    colony["master"].add_slice("contracts", "", "true", [], [])
    colony["master"].add_slice("feature", "", "true", [], ["s000"])
    with pytest.raises(SquadError, match="dependencies"):
        colony["w1"].claim_slice("s001")
    assert colony["w1"].available_for(colony["w1"].board())[0]["id"] == "s000"


def test_claim_reserves_slice_files(colony):
    colony["master"].add_slice("feature", "", "true", ["src/a.js"], [])
    colony["w1"].claim_slice("s000")
    with pytest.raises(SquadError, match="hermes-1"):
        colony["w2"].claim_paths(["src/a.js"], "mine")
    mine = read_json(colony["w1"].reservations / "hermes-1.json", [])
    assert any(r["path"].endswith("src/a.js") for r in mine)


def test_transition_rules(colony):
    colony["master"].add_slice("feature", "", "pytest tests/", [], [])
    colony["w1"].claim_slice("s000")
    # Only the owner moves out of claimed.
    with pytest.raises(SquadError, match="owner"):
        colony["w2"].transition_slice("s000", "review")
    # Illegal transitions are rejected outright.
    with pytest.raises(SquadError, match="Illegal"):
        colony["w1"].transition_slice("s000", "done")
    colony["w1"].transition_slice("s000", "review")
    # The author may not approve their own work.
    with pytest.raises(SquadError, match="author"):
        colony["w1"].transition_slice("s000", "done",
                                      evidence={"command": "pytest", "exitCode": 0})
    colony["w2"].transition_slice("s000", "done",
                                  evidence={"command": "pytest tests/", "exitCode": 0})
    assert colony["w2"].board()["slices"][0]["state"] == "done"
    assert colony["w2"].board()["slices"][0]["reviewer"] == "hermes-2"
    assert colony["w2"].board()["slices"][0]["evidence"]["exitCode"] == 0


def test_done_requires_passing_acceptance_evidence(colony):
    colony["master"].add_slice("feature", "", "npm test", [], [])
    colony["w1"].claim_slice("s000")
    colony["w1"].transition_slice("s000", "review")
    # Missing evidence rejects the sign-off.
    with pytest.raises(SquadError, match="evidence"):
        colony["w2"].transition_slice("s000", "done")
    # A failing acceptance run can never approve a slice.
    with pytest.raises(SquadError, match="exit 1"):
        colony["w2"].transition_slice("s000", "done",
                                      evidence={"command": "npm test", "exitCode": 1})
    colony["w2"].transition_slice("s000", "done", evidence={"exitCode": 0})
    done = colony["w2"].board()["slices"][0]
    # The slice's own acceptance command is the default command in the proof.
    assert done["evidence"]["command"] == "npm test"
    assert done["history"][-1]["evidence"]["exitCode"] == 0


def test_review_changes_loop(colony):
    colony["master"].add_slice("feature", "", "true", [], [])
    colony["w1"].claim_slice("s000")
    colony["w1"].transition_slice("s000", "review")
    colony["w2"].transition_slice("s000", "changes")
    with pytest.raises(SquadError, match="owner"):
        colony["w2"].transition_slice("s000", "review")
    colony["w1"].transition_slice("s000", "review")
    colony["w2"].transition_slice("s000", "done", evidence={"command": "true", "exitCode": 0})


def test_block_and_unblock_are_master_guarded(colony):
    colony["master"].add_slice("feature", "", "true", [], [])
    colony["w1"].claim_slice("s000")
    colony["w1"].block_slice("s000", "waiting on upstream")
    assert colony["w2"].board()["slices"][0]["state"] == "blocked"
    with pytest.raises(SquadError, match="master"):
        colony["w1"].transition_slice("s000", "open")
    colony["master"].transition_slice("s000", "open")
    assert colony["w1"].board()["slices"][0]["state"] == "open"
    with pytest.raises(SquadError, match="master"):
        colony["w2"].transition_slice("s000", "cancelled")
    colony["master"].transition_slice("s000", "cancelled")


def test_release_returns_slice_to_open_and_frees_files(colony):
    colony["master"].add_slice("feature", "", "true", ["src/a.js"], [])
    colony["w1"].claim_slice("s000")
    colony["w1"].transition_slice("s000", "open")
    assert read_json(colony["w1"].reservations / "hermes-1.json", []) == []
    assert colony["w2"].board()["slices"][0]["state"] == "open"


def test_message_requires_slice_and_transition(colony):
    colony["master"].add_slice("feature", "", "true", [], [])
    sender = colony["w1"]
    with pytest.raises(SquadError, match="slice id"):
        sender.send_message("hermes-2", "ping", "", "")
    with pytest.raises(SquadError, match="live squad"):
        sender.send_message("hermes-5", "ping", "s000", "claimed")
    sender.send_message("hermes-2", "took s000", "s000", "s000 open -> claimed")
    assert colony["w2"].drain_inbox()[0]["text"] == "took s000"


def test_message_budget_auto_blocks(colony):
    colony["master"].add_slice("feature", "", "true", [], [])
    # Rotate three distinct pairs so the pair cutoff never fires first.
    rotation = [(colony["w1"], "hermes-2"), (colony["w2"], "master"),
                (colony["master"], "hermes-1")]
    for index in range(MESSAGE_BUDGET):
        sender, to = rotation[index % 3]
        sender.send_message(to, f"note {index}", "s000", "progress")
    with pytest.raises(SquadError, match="budget"):
        colony["w1"].send_message("hermes-2", "one too many", "s000", "progress")
    assert colony["w1"].board()["slices"][0]["state"] == "blocked"
    # The master was notified through its inbox.
    assert any("budget" in m["text"] for m in colony["master"].drain_inbox())


def test_pair_cutoff_blocks_circle(colony):
    colony["master"].add_slice("feature", "", "true", [], [])
    for index in range(PAIR_CUTOFF):
        colony["w1"].send_message("hermes-2", f"round {index}", "s000", "progress")
    with pytest.raises(SquadError, match="pair cutoff"):
        colony["w2"].send_message("hermes-1", "and back again", "s000", "progress")
    assert colony["w2"].board()["slices"][0]["state"] == "blocked"


def test_claim_ttl_expires_to_open(colony):
    from datetime import datetime, timedelta, timezone
    import squad.squad_core as core
    colony["master"].add_slice("feature", "", "true", [], [])
    colony["w1"].claim_slice("s000")
    board_path = colony["w1"].board_path
    board = read_json(board_path, {})
    expired = (datetime.now(timezone.utc) - timedelta(seconds=CLAIM_TTL_SECONDS + 60))
    board["slices"][0]["claimedAt"] = expired.isoformat()
    core.atomic_write(board_path, board)
    colony["w2"].board()  # any read sweeps
    assert read_json(board_path, {})["slices"][0]["state"] == "open"


def test_concurrent_claims_have_exactly_one_winner(colony):
    colony["master"].add_slice("feature", "", "true", [], [])
    colony["master"].add_slice("other", "", "true", [], [])
    results = {}
    def attempt(name):
        squad = colony[name]
        try:
            item = squad.claim_slice("s000")
            results[name] = item["owner"]
        except SquadError as problem:
            results[name] = f"lost: {problem}"
    threads = [threading.Thread(target=attempt, args=(name,))
               for name in ("w1", "w2", "master")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    winners = [owner for owner in results.values() if owner in ("hermes-1", "hermes-2", "master")]
    assert len(winners) == 1
    assert read_json(colony["w1"].board_path, {})["slices"][0]["state"] == "claimed"


def test_available_orders_by_priority(colony):
    colony["master"].add_slice("low", "", "true", [], [], 1)
    colony["master"].add_slice("high", "", "true", [], [], 9)
    colony["master"].add_slice("mid", "", "true", [], [], 5)
    order = [s["id"] for s in colony["w1"].available_for(colony["w1"].board())]
    # s001 (high) first, then s002 (mid), then s000 (low).
    assert order == ["s001", "s002", "s000"]


def test_board_survives_reader_with_no_board_file(colony):
    assert colony["w1"].board() == {"slices": []}


def test_settle_receipt_patch_prefers_final_text_then_delegation(colony):
    receipt = {"id": "r1", "status": "delivering"}
    patch = settle_receipt_patch(receipt, "  the final answer  ")
    assert patch["status"] == "replied" and patch["response"] == "the final answer"
    delegated = settle_receipt_patch({"delegations": ["hermes-1"]}, "", "2 slices: s000 done")
    assert delegated["status"] == "delegated" and delegated["response"].startswith("2 slices")
    failed = settle_receipt_patch({}, "")
    assert failed["status"] == "failed" and "no readable response" in failed["error"]


def test_feed_survives_concurrent_appends(colony):
    sender = colony["w2"]
    def blast(count):
        for index in range(count):
            sender.append_feed({"type": "noise", "agent": sender.name,
                                "preview": f"line {index} " + "x" * 40})
    threads = [threading.Thread(target=blast, args=(50,)) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    lines = [line for line in sender.feed_path.read_text().splitlines() if line.strip()]
    assert len(lines) >= 200
    for line in lines:
        assert json.loads(line)["type"] == "noise"
