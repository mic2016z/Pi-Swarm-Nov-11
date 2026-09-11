# SPEC — Coordination Guarantees

Normative requirements for the Hermes Quad Squad coordination layer. Each section maps to
a backlog ticket in [BACKLOG.md](BACKLOG.md); the problem statements live in
[PRD.md](PRD.md#known-issues-verified-against-code-and-a-live-run-2026-09-11).
"Must" is a hard requirement verified by test; "should" is best effort with a recorded
fallback.

## S1 · Relay identity (T1)

The relay discovers a master by scanning state dirs for `master-runtime.json` and the
registry copy `squad/registry/master.json`.

- The sessionId comparison MUST read the registry field `sessionID` (the spelling the
  plugin writes) and MUST accept `sessionId` from legacy state dirs.
- A master is live only when: runtime `ready == true`, runtime pid alive, app pid alive,
  registry pid equals runtime pid, and registry sessionID equals runtime sessionId.
- `--relay discover` on a healthy running workspace MUST return the master JSON within
  one second.

## S2 · Durable inbox delivery (T2)

- Reading a message MUST NOT remove it. Removal happens only via an explicit ack after
  `ctx.inject_message` returned True for that message.
- A message whose injection returned False MUST remain queued and be retried with
  backoff; every retry MUST append a `delivery.retry` feed line.
- No message may be dropped silently: any code path that gives up on a message MUST
  append a `delivery.dropped` feed line with the reason.
- A master relay receipt MUST NOT rest in `delivering`: it ends as `replied`,
  `delegated`, `failed` (with error), `interrupted`, or `cancelled`.

## S3 · Reservation enforcement (T3)

- A tool call that would modify a path reserved by another live agent MUST be blocked
  with a message naming the holder. Coverage MUST include every Hermes file-mutating
  tool name, not just `write_file`/`patch`.
- The shell tool MUST be blocked when its command string references a reserved path
  (normalized, case-insensitive on Windows).
- `git commit` and `git push` MUST be blocked for non-master agents.
- Every denial MUST append a `claim.denied` feed line (agent, tool, target, holder).

## S4 · Evidence-gated sign-off (T4)

- A slice MAY transition `review → done` only when the caller supplies evidence:
  the acceptance command and its exit code. Exit code ≠ 0, or missing evidence, MUST
  reject the transition.
- The slice history MUST record, for every `done`: reviewer, timestamp, command, exit
  code.
- `squad_tasks done` MUST require non-empty evidence text.

## S5 · Relay receipt lifecycle (T5)

- A receipt's `response` MUST be the final assistant text of the turn that answered it,
  never an intermediate tool-turn fragment.
- A turn whose outcome is delegation settles as `delegated` with a summary of the
  resulting board state — not `failed` for having no prose.
- Settlement happens on turn end for the request that was active when the turn began.

## S6 · Document template versioning (T6)

- Every app-generated `.squad/<agent>/{agent,context,todo}.md` MUST carry a version
  marker comment.
- On workspace open: an unmodified older-template file MUST be upgraded to the current
  template; a user-modified file MUST NOT be touched and MUST produce a `doc.stale`
  feed line naming the file.

## S7 · Audit feed integrity (T7)

- Concurrent appends from up to four processes MUST NOT interleave or lose lines.
- The feed is append-only JSONL; a failed append retries once and then reports through
  stderr/logging available to the pane, never through dropping the event silently beyond
  that.
