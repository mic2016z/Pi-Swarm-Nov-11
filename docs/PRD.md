# PI SWARM — Ant Colony Coding

## Product Overview

Pi Swarm is a desktop workspace for parallel coding: one **Queen** (planner/arbiter) and many **worker Pis** (implementers/reviewers) that cut a coding task into vertical slices and execute them in parallel. Coordination runs over native peer messaging (pi-messenger style), with a shared task board as the source of truth.

The colony model: the Queen decomposes a user task into slices, workers claim and execute independently, reviewers pipeline behind implementers, and the Queen only arbitrates — blocking, TTL expiry, and completion declaration. Idle workers cost nothing.

## Roles

### Queen (master pane)
- Receives the user task, writes the board once
- Decomposes into vertical slices: declared files, acceptance command, priority, dependency edges, tags
- Never claims slices (pure planner + arbiter)
- Arbitrates: splits or reassigns slices blocked twice, resolves pair cutoffs, declares completion
- One strong model, low reasoning, full board powers

### Workers (N panes, target 24)
- Register with capabilities: `{tags: ["ui"|"backend"|"test"|"docs"], model, platform}`
- Worker loop:
  1. Read board
  2. Claim highest-priority dep-ready slice matching own tags
  3. Reserve the slice's declared files
  4. Implement; run the acceptance command; record output + exit code
  5. Transition to review; notify a reviewer peer
  6. Release reservations; return to 1
- Idle when no matching work — no model requests, no invented tasks
- Cheap models for generic workers; specialists only where tags require

## Coordination Protocol

- File-based board: `board.json` — slices with state `open → claimed → review → changes → blocked → done`
- File-based registry: one JSON per live agent in `squad/registry/`
- Messaging: native peer relay (pi-messenger) for delivery; file inbox as the durable fallback
- File-based reservations: declared at slice creation; enforced on every file-mutating tool
- Append-only audit feed: `feed.jsonl` (locked appends — no lost events)

## Guards

- Per-slice message budget (default 6) — auto-blocks on exceed
- Claim TTL (default 30 min without commit) — expires to open
- Agent pair cutoff (>3 messages on one slice with no board change) — blocks slice
- Messages must reference a slice id and board transition
- Reviews are never reviewed; approval is a board transition only
- **Unfalsifiable sign-off is forbidden:** `review → done` requires recorded acceptance output, exit code 0, and timestamp

## Swarm Improvements (new in this build)

1. **Queen never works.** No self-claims; no board churn by the planner.
2. **Slices declare files at creation.** Ownership stated up front — reservation conflicts are structurally impossible; workers shard by file.
3. **Worker tiers by tag.** Slices tagged `ui|backend|test|docs`; workers advertise capabilities; Queen routes by tag. Scales to 24 light workers.
4. **Event-driven messaging.** Push delivery over the peer relay; no polling loops, idle workers burn zero model calls.
5. **Pipelined review.** Reviewers work slice N while implementers build slice N+1.
6. **Auto re-slicing.** A slice blocked twice is split or reassigned by the Queen, never left to deadlock.
7. **Settle correctness.** A relay reply is only the final assistant response of the turn that answered the request (freshness-guarded).
8. **Visible swarm.** Live board/graph view in the app: slices, owners, blockers, queue depth.

## Rolling-Wave Planning (phased rollout)

The Queen does not plan everything at once. She plans at increasing resolution, phase by phase — detailed now, fuzzy later.

### Plan tiers

1. **Architecture pass (Queen alone, serial).** Scaffold the skeleton herself; produce the paint-by-numbers picture: file tree, dependency map, ordered phases, workspace ownership per phase. Every future phase exists only as a one-line card (title + acceptance).
2. **Phase expansion (Queen).** Only the current phase gets full-resolution slices + briefs. Future phases stay one-line cards — cheap to plan, cheap to throw away.
3. **Build passes (swarm, parallel).** Drones claim and execute the current phase's slices at maximum parallelism; sub-queens integrate.
4. **Phase gate (Queen, short).** Re-read what was actually built, then compile the next phase's briefs from real code — never from the stale plan. The gate is also the human checkpoint: approve the next phase.

### Rules

- **No over-planning.** Planning is serial, building is parallel; keep the serial portion minimal by never expanding future phases early.
- **Plans are living documents.** A later phase may reopen earlier slices; revisions beat rollback.
- **Briefs are compiled from reality at the gate.** Stale plans are the colony's enemy.
- **Parallelism profile:** architecture pass = 1 agent; each phase = max parallelism; gates = short serial stints.

## Swarm Control UX (the human interface)

The swarm is controlled from ONE surface; panes are for inspection only.

### Design rules

1. **One task in, one status out.** The user gives one task; the app shows one colony status. No reading 16 panes to know what's happening.
2. **Three human moments.** The human interacts at exactly three points: (a) give the task, (b) approve the plan, (c) handle exceptions. Everything between runs itself.
3. **Quiet success, loud exceptions.** The UI is silent while slices flow. Alerts fire only on: blocked slices, TTL expiry, idle workers with open matching work, escalation requests.
4. **Every intervention is one click and reversible.** Retry, reassign, unblock — never edit JSON.

### Layout

- **Task bar (top, always visible).** One input + Send. Beside it: Pause All / Resume, Kill, and the cost meter (tokens per workspace).
- **Plan preview (the checkpoint).** After Send, the lead queen proposes a partition: workspaces × file domains × slices with deps and tags. The user approves, edits (move a slice, change a workspace), or rejects. Workers may not claim until approved. This is the single most important control — the human is the partition guard.
- **Live board (main view, the ant farm).** Slices as cards flowing across state columns (open → claimed → review → changes → blocked → done), colored by workspace, with dep edges and TTL countdown badges. Click a slice: owner, messages, acceptance evidence, one-click retry/reassign/block.
- **Right rail.** Colony status: agents busy/idle per workspace, queue depth, tokens spent. Below it: the **escalation queue** — workers' requests for powers they don't have (web, git, installs), each with the requested tool call; the queen executes them, but the human sees and can veto.
- **Tabs = workspaces.** Each tab holds its 4 panes for inspection and manual driving; control never requires opening a tab.
- **Completion gate.** When all slices are done: a summary card — per-slice acceptance evidence (command, output, exit code), reservation check, test results — with Declare Complete (queen power, human visibility).

### Anti-goals

- No chat-with-the-queen as the control mechanism (verbose, ambiguous)
- No dashboard of every message (noise)
- No JSON editing for interventions
- No silent background pauses: every guard action (block, TTL, cutoff) appears as a card on the board with its reason

## Context Compilation Protocol (the queen's core job)

The queen is a **context compiler**: her real work is not planning but supplying each drone the exact, distilled context its slice needs. Drones never explore.

### Slice brief (board object, first-class)

A slice carries a `brief`, written by the queen **after the slice's dependencies complete** (excerpts must be fresh code):

- `goal` — one sentence, what to change
- `files` — owned paths (write) + read-only reference paths
- `excerpts` — relevant code inline, not pointers; exact and trimmed
- `conventions` — style/patterns the project uses that apply to this slice
- `acceptance` — the command that proves it works

### Rules

1. **No brief, no claim.** A slice is `open` (claimable) only once its brief exists. Before that it is `briefing`.
2. **Context budget** — ~8-12k tokens per brief. Overflow means the slice is too big: split it. The budget is a splitting signal, never an overflow.
3. **No roaming.** Worker instructions: work from the brief; do not explore the repo; if the brief is insufficient, escalate with a *specific* question via the escalation channel.
4. **Reviewer context differs.** A reviewer receives diff + acceptance + brief — not implementation context.
5. **Layered context.** (a) Project conventions compiled once at plan time, shared by all slices. (b) Per-slice briefs. (c) Escalation answers as the on-demand third layer.

### Economics

The queen pays the large context cost once per slice; each drone pays a fraction. This asymmetry is why 1 queen + N cheap workers beats N strong agents: strong agents re-read everything, paying the context cost N times.

## Power Ladder (who may touch what)

```
Level 0 — Pi drones:    files only (read/write/edit/delete). No git, no GitHub,
                        no network. Report results to the sub-queen.
Level 1 — sub-queens:   git + GitHub. Review drone diffs, run acceptance locally,
                        commit, push, open PRs, file issues. GitHub token holders.
Level 2 — grand queen:  merge PRs, resolve cross-workspace issues, declare complete.
```

### Rules

1. **Only sub-queens touch GitHub.** Credential surface is 4 agents, not 16. PRs are opened by sub-queens based on drone reports.
2. **PR body attributes honestly:** "Implemented by drone pi-3 per brief s042, workspace backend." The board carries the real record; git history shows the queen as committer.
3. **Two-stage acceptance:** sub-queen runs the acceptance command locally before pushing (fast gate); CI re-runs it on the PR (durable, unfalsifiable evidence).
4. **Cross-workspace review:** workspace A's queen reviews workspace B's PR — reviewer is never the author, structurally.
5. **Drones don't file issues.** They report findings to their queen, who files the issue if warranted.
6. **Sub-queen turn loop includes harvest:** plan → brief → harvest completed drone slices → review diff → acceptance → commit/push/PR → back to planning.

## Known Bugs Carried Over (fix in this build, from HQS PRD)

1. Relay identity check can never match (`sessionId` vs `sessionID`) — whole `--relay`/MCP path dead.
2. Inbox messages deleted before delivery confirmed; failed injection destroys the instruction.
3. File reservations only blocked some tools; shell edits and git push passed through.
4. Sign-off unfalsifiable — fixed by the acceptance-evidence guard above.
5. Relay replies settled from intermediate tool turns — fixed by freshness guard.
6. Seeded documents never refreshed after first write.
7. Audit feed lost events to concurrent unsynchronised appends.

## Definition of Done

The Queen may declare complete when:
1. Every slice is `done`
2. No file reservations remain
3. Project checks pass (tests, build)
4. Final integration review by an agent that authored none of the last slices

## Acceptance Criteria

1. Queen + 3+ workers launch in the app grid
2. Queen decomposes a task into tagged, dep-ordered slices with declared files
3. Workers claim only dep-ready, capability-matching slices
4. Parallel execution: ≥2 workers active simultaneously
5. At least one review round with `changes`
6. One automatic block or TTL expiry, resolved by the Queen
7. Acceptance evidence recorded on every `done`
8. No message without slice id; no worker turn while board has no matching work
9. Colony test passes end-to-end with the release gate
