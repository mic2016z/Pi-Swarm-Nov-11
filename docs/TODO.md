# Pi Squad implementation backlog

Phases, goals and exit criteria are defined in [PRD Roadmap](PRD.md#roadmap). This file is the coding backlog for those phases. Unchecked items are not implemented or not verified; a checked item means demonstrated, not written.

## Phase 0 — Carried over from 1.0.0 (blocking Phase 1 acceptance)

- [x] Integrate pinned Pi Messenger into existing interactive Pi workers; no Python in the new peer-message transport.
- [x] Scope discovery to the active app workspace, with stable terminal IDs and matching replies.
- [x] Verify real Windows broker delivery, reply correlation, reconnect, scope isolation, peer-tool routing, and loading in the actual Pi CLI without model calls.
- [x] Default master to Pi with Astra low; preserve worker defaults.
- [x] Native Rust relay and automatic Pi master registration/replies.
- [ ] After the user requests restart, verify visible workers exchange actual model replies and validate the full worker roster.
- [ ] Validate the full live relay after user-requested restart.
- [ ] Fix first-session readiness so registration leads to a verified live connection without requiring restart.
- [ ] Package dependencies for installed Windows builds; retain Linux and macOS transport support and explicitly record platform test coverage.

## Phase 1 — Colony on Pi (current)

### 1.1 Shared task board

- [ ] `board.ts`: slice schema (`id`, `title`, `goal`, `acceptance`, `files`, `deps`, `state`, `owner`, `reviewer`, `claimedAt`, `messages`, `history`), atomic temp-file-plus-rename writes to `board.json` beside `registry/` and `inbox/`, and read-modify-write under a lock so concurrent claims cannot lose updates.
- [ ] Validated transitions: `open` to `claimed` to `review` to `changes` or `done`, `changes` back to `review`, and `blocked` from any state. Reject every transition not in the table.
- [ ] Permission rules: only the owner transitions out of `claimed`; only the reviewer approves; only the master unblocks or cancels; the reviewer must not be the author.
- [ ] Reject any slice added without a non-empty `acceptance` command.
- [ ] `fs.watch` on `board.json`, debounced, so idle workers are woken by board changes without polling. A wake must not start a model turn when the worker has no available slice.
- [ ] `squad_board` tool in `native-team.ts` with `list`, `claim`, `transition`, `block` and `release`, registered beside `squad_claims`.
- [ ] Smoke test `tests/board-smoke.mjs`: real files, concurrent claim race, illegal transitions rejected, permission rules enforced, watcher delivery observed.

### 1.2 Master planning and worker loop

- [ ] Master writes the board once from the user task; contracts (types, schemas, API shapes, test scaffolding) are slice zero and must be `done` before dependants become available.
- [ ] After planning the master becomes a peer: no dispatch, no polling, no re-planning unless a slice is `blocked` or the gate fails.
- [ ] Colony `agent.md` defaults for master and worker roles, seeded only where missing so existing user edits survive.
- [ ] Worker pull loop: pick the highest-priority `open` slice with all deps `done`, claim it, reserve its `files`, implement, run `acceptance` until it exits zero, commit with the slice id, transition to `review`, message exactly one idle peer, release reservations, repeat.
- [ ] Idle workers make no model requests and never invent work.

### 1.3 Guards

- [ ] Reject peer messages that carry no slice id and board transition, so acknowledgement-only messages are impossible by construction.
- [ ] Per-slice message budget, default six; exceeding it auto-blocks the slice and notifies the master.
- [ ] Claim TTL, default thirty minutes without a commit; expiry returns the slice to `open` and releases its reservations.
- [ ] Cut off a pair exchanging more than three messages on one slice with no board change, and block the slice.

### 1.4 Release gate

- [ ] Gate script: every slice `done`, no reservations remaining, project checks green (Python tests, `npm run build`, `cargo test`), and one final integration review by an agent that authored none of the last slices.
- [ ] Write the gate result to the board and surface it in the app. Until the gate exits zero, worker "done" messages are board updates, not completion.

### 1.5 App surface

- [ ] Board panel listing slices by state with owner, reviewer, message count and age; blocked slices highlighted.
- [ ] Per-run metrics: slices, review rounds, blocked count, wall clock and agent-turns.

### 1.6 Phase 1 acceptance

- [ ] Real embedded run: master plus at least four workers, one review round with changes, one automatic block or TTL expiry, a passing gate, no message without a slice id, and no worker turn while the board has no available work.

## Phase 2 — Git isolation and integration

- [ ] Resolve the slice isolation model open decision in [PRD Open decisions](PRD.md#open-decisions): shared checkout with reservations, or `git worktree` and branch per slice.
- [ ] If worktrees: add `branch` and `worktree` to the slice schema, provision and tear down worktrees on claim and release, and decide whether merging is a board slice with its own acceptance command or a master privilege outside the board.
- [ ] Per-slice commits reach one integration branch with a named conflict owner.
- [ ] Run the release gate against the integrated result, not any single worker tree.
- [ ] Update the gate clause "no file reservations remain" if reservations stop being the contention mechanism.

## Phase 3 — Harness seam

- [ ] Define the adapter contract covering exactly four host capabilities: register a tool, inject a turn into a live session, observe true turn completion, and veto a tool call.
- [ ] Extract the Pi implementation out of `pisquad-messenger.ts` and `native-pi.ts` behind that contract with no behavior change.
- [ ] Replace hardcoded `pi-N` identity in `native-team.ts` (including the `pi-?(\d+)` recipient regex) and `pisquad-messenger.ts` with harness-neutral identity; keep `@codex` and `pi-N` as compatibility aliases.
- [ ] Replace the Pi-only model catalog check in `bridge.py` (`pi --offline --list-models`) with a per-harness capability lookup.
- [ ] Preserve permanent terminal identity and shared `agent.md`, `context.md` and `todo.md` across harness changes.
- [ ] Exit a harness to the shell, start a supported replacement in the same master pane, and register it automatically with safe ownership transfer and task handover; never replay uncertain work.
- [ ] Phase 1 acceptance run still passes with Pi driven through the contract.

## Phase 4 — OpenCode adapter

- [ ] Verify against the installed OpenCode build, recording results in [RELAY-TRANSPORT-RESEARCH.md](RELAY-TRANSPORT-RESEARCH.md): whether `tool.execute.before` can veto a tool call or only observe it.
- [ ] Verify what `POST /session/:id/prompt_async` does to a busy session, compared with Pi `steer` and `followUp`.
- [ ] Verify whether `session.idle` corresponds to Pi `agent_settled` or to the earlier `agent_end`, including behaviour after compaction and queued continuation.
- [ ] Implement the adapter driven from the Rust supervisor over OpenCode's HTTP server and `GET /event` SSE stream, not an in-process extension.
- [ ] Answer OpenCode permission requests through `POST /session/:id/permissions/:permissionID` instead of blocking a pane.
- [ ] OpenCode panes join the same `registry/`, `inbox/` and `board.json` as Pi panes.
- [ ] Mixed-colony acceptance: a Pi master plus at least two OpenCode workers complete the Phase 1 acceptance run.

## Phase 5 — Swarm at scale and model economics

- [ ] Make slice completion evidence-based — the acceptance command's exit status, not a settled turn with no error — before any free-tier model runs as a worker.
- [ ] Configure OpenRouter and OpenCode Zen providers with per-pane model selection; treat free tiers as rate-limited and time-limited and re-verify availability rather than pinning to documentation.
- [ ] Add tokens and cost per slice to the per-run metrics.
- [ ] Handle provider rate limiting across twenty-four concurrent workers: backoff, queueing and a visible degraded state.
- [ ] Measure acceptance, first output and completion separately; stream individual replies without waiting for the slowest worker.
- [ ] Twenty-four worker acceptance run on free or low-cost models, with throughput and cost per slice compared against a single-agent baseline on the same spec.

## Phase 6 — Cross-platform distribution and additional harnesses

- [ ] Verify the Linux runtime end to end: Unix PTY with the user's shell, messenger file watching, path normalisation without the Windows lowercase branch, and native folder picker under Wayland.
- [ ] Confirm the Tauri build produces a working Linux binary under Wayland/Hyprland as used by Omarchy, including window decorations and the folder picker portal.
- [ ] Publish an AUR package: `PKGBUILD` with declared runtime dependencies (`webkit2gtk`, Node, the selected harness CLIs), a `.desktop` entry, reproducible build from a tagged source tarball, and a documented update path per release.
- [ ] Verify macOS PTY and packaging, or state explicitly that macOS is unsupported rather than implying it.
- [ ] Build the single Windows EXE installer in `D:\Coding\Pi Squad installer`, bundling app, MCP adapter and MCP-using skill. Acceptance and candidate harnesses: [PRD.md](PRD.md#windows-installer-requirement-approved-distribution-not-yet-implemented).
- [ ] Detect candidate harnesses and offer checkboxes only for integrations verified against the Phase 3 contract; identify unsupported options clearly. Preserve settings and document trust and reload steps honestly.
- [ ] Re-evaluate DeepSeek Harness against the Phase 3 contract once it leaves developer preview; its replaceable agent loop is the best fit on paper, but it is web-UI-first and promises breaking changes.

## Unscheduled

- [ ] App controls for master harness/model, worker defaults and individual overrides; preserve credentials and apply changes at safe boundaries.
- [ ] PiSquad invocation binds the originating local conversation; explicit "tell PySquad" messages target the app's active master and workspace, and replies return to their origin.
- [ ] Make Browse use the existing Change project flow.
- [ ] Replace legacy Python supervision, queue, relay and claims with Rust, preserving saved state and recovery guarantees.

Research: [transport and Pi package comparison](RELAY-TRANSPORT-RESEARCH.md).
