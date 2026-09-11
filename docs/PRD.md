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
2. **Slices declare files at creation.** Ownership stated up front → reservation conflicts are structurally impossible; workers shard by file.
3. **Worker tiers by tag.** Slices tagged `ui|backend|test|docs`; workers advertise capabilities; Queen routes by tag. Scales to 24 light workers.
4. **Event-driven messaging.** Push delivery over the peer relay; no polling loops, idle workers burn zero model calls.
5. **Pipelined review.** Reviewers work slice N while implementers build slice N+1.
6. **Auto re-slicing.** A slice blocked twice is split or reassigned by the Queen, never left to deadlock.
7. **Settle correctness.** A relay reply is only the final assistant response of the turn that answered the request (freshness-guarded).
8. **Visible swarm.** Live board/graph view in the app: slices, owners, blockers, queue depth.

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
