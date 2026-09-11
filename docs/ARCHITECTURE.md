# Native terminal architecture

## Invariants

1. A pane runs the installed interactive agent in the platform shell. Pi receives terminal input directly; no input() console, print mode or JSON rendering replaces its TUI.
2. Native Pi's Python supervisor holds OS owner/execution locks. The same locks exclude legacy headless workers. Session switches reserve the new locks before releasing the old; config tracks the committed saved session. Abandoned reservations expire.
3. The Pi extension delivers FIFO jobs to that same interactive Pi only while idle, with no pending messages, modal or editor text. Typed commands remain native. It records results after agent_settled so retries and compaction finish first.
4. Interrupted jobs are reported and never replayed automatically. A worker report still needs review and verification.
5. Model/provider settings and CLI authentication remain user-managed.

## Components

Rust/Tauri owns portable-pty terminals, using ConPTY on Windows and Unix PTYs elsewhere. It launches PowerShell on Windows and $SHELL on Linux/macOS (bash/zsh fallback), then invokes the installed CLI with safely quoted arguments. On Windows, pass the PowerShell script as UTF-16LE `-EncodedCommand` and escape embedded double quotes for the Windows PowerShell legacy native argument binder. Plain `-Command` adds a parsing layer that can split project paths or master prompts containing quoted paths. The real ConPTY test covers spaced paths, embedded quotes, apostrophes and Unicode. Exiting an agent returns to its shell. xterm.js renders bytes and forwards input and resize events. Windows keyboard mode 9001 is handled by the frontend.

Each Pi pane launches bridge.py native-worker. native_session.py owns its saved session and starts interactive Pi with native-pi.ts loaded as an extension. That extension connects the durable queue to Pi's supported lifecycle and sendUserMessage APIs, adds current per-agent documents to turns, and handles saved-session changes. The old worker/run-job commands remain available for headless use but cannot share an owned native session.

The master is an interactive Pi session (openai-codex/gpt-6-astra, low reasoning) launched with pi-master.ts as an extension. That extension registers the master with Messenger, drains the native relay queue (src-tauri/src/relay.rs) in FIFO order, and publishes each settled reply to its request receipt. The legacy Codex-thread relay (pisquad.py/live_master.py) has been removed. See [PISQUAD.md](PISQUAD.md) for conversation relay semantics.

State stays under LOCALAPPDATA/ChatGPTPlusPiSubagents on Windows or ~/ChatGPTPlusPiSubagents on Unix. Shared project files require explicit task/file ownership coordination. Windows supervisors use kill-on-close process Jobs; Unix terminals use normal process-group/hangup behavior. OS locks exclude cooperating Pi Squad processes, not arbitrary manually launched Pi sessions.

Shutdown requests idle native Pi to exit, waits for session ownership release, then closes the remaining shells. Busy work must finish or be aborted before app shutdown. Windows is runtime-tested; Linux/macOS paths are implemented but still require platform verification.

Team messaging and file reservations use pinned pi-messenger through pisquad-messenger.ts; only document-change notifications still route through team.py pending Rust migration. The native-team.ts extension registers squad_message/squad_claims and /team over that messenger while the existing native-pi.ts queue preserves safe turn boundaries. See [TEAMWORK.md](TEAMWORK.md) before changing routing, claims or document update behavior.
