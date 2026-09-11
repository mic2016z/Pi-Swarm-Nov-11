# Coding Backlog

Ordered by severity: T1–T2 make the relay and message path trustworthy, T3–T5 make the
guards real, T6–T7 are reliability polish, T8 is the end-to-end proof. Issues are
documented in [PRD.md](PRD.md#known-issues-verified-against-code-and-a-live-run-2026-09-11);
requirements are normative in [SPEC.md](SPEC.md).

## T1 · Relay identity check never matches

- **Problem:** plugin registers `sessionID` (`hermes-plugin/squad/__init__.py:427`),
  `src-tauri/src/relay.rs:61` compares `registered["sessionId"]`. Null ≠ string, so
  `--relay discover` always reports "found 0" and send/read/cancel/list plus the MCP
  adapter are all dead while the UI shows "Master relay ready".
- **Fix:** in `relay.rs`, read the registry field as `sessionID` (accept legacy
  `sessionId` for old state dirs). Keep the pid equality check.
- **Accept:** with the app running, `hermes-quad-squad.exe --relay discover` returns the
  live master JSON; `--relay send` delivers to the master inbox and the receipt reaches
  `replied` or `delegated`.
- **Checks:** `cargo test`.

## T2 · Inbox messages deleted before delivery is confirmed

- **Problem:** `drain_inbox()` (`squad_core.py:254`) unlinks each message as it reads it;
  `_inject()` (`__init__.py:224`) swallows a failed `inject_message` with `except: pass`.
  One failed injection destroys the instruction permanently. A master relay receipt can
  stick at `delivering` forever.
- **Fix:** split drain into `peek` + `ack(message_id)`. The pump peeks, injects, and acks
  only when `inject_message` returns True; on False, leave the file and retry with
  backoff, and append a `delivery.retry` line to the feed. On the master, if a claimed
  receipt stays `delivering` past a timeout with no session turn, settle it as `failed`
  with an explicit error.
- **Accept:** unit test — inbox file with an inject that returns False survives and is
  retried; returns True → file removed. Relay receipt never rests at `delivering` without
  either a turn or a failure.
- **Checks:** `python -m pytest tests/test_squad_core.py`.

## T3 · Reservations bypassable via shell and unlisted tools

- **Problem:** `_hook_pre_tool_call` (`__init__.py:385`) only inspects `write_file` and
  `patch`. Any shell command or other file-mutating tool sails past, so a worker can edit
  reserved paths or run `git commit`/`git push` freely.
- **Fix:** enumerate Hermes' mutating tool names and cover them all; for the shell tool,
  deny when the command string references a reserved path (best-effort substring on the
  normalized path) and deny `git commit`/`git push` for non-master agents outright.
  Append every denial to the feed (`claim.denied`).
- **Accept:** unit tests for the matcher (reserved path via write tool, via shell echo
  redirect, git push by a worker; master git push allowed). A denial message naming the
  holder reaches the model.
- **Checks:** `python -m pytest tests/test_squad_core.py`.

## T4 · Sign-off without acceptance evidence

- **Problem:** `transition_slice` review→done (`squad_core.py:428`) checks only
  reviewer ≠ owner. Nothing requires or records the acceptance command running and
  exiting zero; `squad_tasks done` accepts empty evidence.
- **Fix:** review→done requires an `evidence` argument: `{command, exitCode}` recorded
  into the slice history (author + timestamp already there). Reject `done` when exitCode
  ≠ 0 or evidence is missing. `squad_tasks done` requires non-empty evidence.
- **Accept:** unit tests — done with exit 0 evidence passes; with exit 1 or missing
  evidence raises; history carries the command.
- **Checks:** `python -m pytest tests/test_squad_core.py`.

## T5 · Relay replies settle on the wrong text

- **Problem:** `_settle_request` (`__init__.py:103`) settles with the last text any
  `post_llm_call` hook saw. An intermediate tool turn becomes the "reply"; a master that
  delegated and ended its turn cleanly settles `failed` for having no readable response.
- **Fix:** settle explicitly: when the master's turn ends with an active relay request,
  use the final assistant text of that turn only; if the turn's only outcome was
  delegation (`status: delegated`), keep `delegated` and record the final board state
  summary instead of failing. Settle on `on_session_end`, not on whatever arrived last.
- **Accept:** simulated turn sequence (tool turn, then final text) settles `replied` with
  the final text; delegation-only turn settles `delegated` with an error-free receipt.
- **Checks:** `python -m pytest tests/test_squad_core.py`.

## T6 · Seeded documents never refresh

- **Problem:** `seed_documents` (`main.rs:185`) writes only missing files, so app prompt
  improvements never reach existing projects unless files are deleted by hand.
- **Fix:** stamp each generated doc with a version marker comment
  (`<!-- squad-template vN -->`). On workspace open, when the file's marker version is
  older and the body is byte-identical to the old template, rewrite it with the new
  template; when the user modified it, leave it untouched and append a `doc.stale` feed
  line naming the file.
- **Accept:** unit test — old-template file upgrades, user-modified file survives
  unchanged, feed notes the skip.
- **Checks:** `cargo test`.

## T7 · Audit feed loses concurrent events

- **Problem:** `append_feed` (`squad_core.py:155`) appends from four processes with no
  synchronisation; the live run lost one of four `join` lines.
- **Fix:** reuse the existing `FileLock` pattern (a `feed.lock`) around read-append, or
  open with `O_APPEND` semantics verified on Windows plus one retry on a short read.
- **Accept:** stress test — 4 threads × 50 concurrent appends produce 200 lines, none
  interleaved or lost.
- **Checks:** `python -m pytest tests/test_squad_core.py`.

## T8 · Colony acceptance test (PRD Phase 4)

- **Problem:** the end-to-end proof (master plans, workers claim parallel slices, one
  review round with changes, one auto-block or TTL expiry, release gate) has never run
  to completion on the Hermes stack.
- **Fix:** after T1–T5, run it on a scratch project with `opencode-zen/big-pickle`,
  scripted via `--relay send` plus filesystem assertions. Record the transcript under
  `docs/benchmarks/`.
- **Accept:** every PRD Phase 4 criterion observed and logged.
- **Checks:** manual + `npm run build`, `cargo test`, `python -m pytest tests`.
