# Current build verification

Verified locally on Windows, 8 September 2026. The Windows artifact is an unsigned debug-profile executable, not a signed installer.

## Passed

- Frontend production build and Tauri desktop build.
- Twenty-eight Python tests covering FIFO queues, session ownership, interruption recovery, process containment, instruction-file isolation/conflicts, Unicode, relay destination checks, duplicate suppression, uncertain delivery and session-checked replies, native session-switch ownership and abandoned-reservation cleanup.
- Rust real Windows ConPTY input/output roundtrip.
- Pi Squad window title and header verified through the actual WebView DOM. The embedded Codex and Pi terminals launched from the renamed application.
- Prior live tests verified four saved Pi sessions across restarts, terminal and composer input, adding a worker, and Codex-to-Pi delegation with result readback.
- PiSquad skill validation over MCP: native relay discover/send/read against the running Pi master, Messenger registration, and a correlated replied receipt. The earlier Codex-thread relay path has been removed.

## Native terminal verification

The native Pi process loaded its delegation extension, rendered the actual `/` menu and 39 installed `/skill:` completions, and kept a queued job pending while the native editor contained text. Clearing the editor delivered the job to the same Pi instance. Its configured provider returned `fetch failed`; the saved result correctly reported failure rather than claiming success. No provider/model settings were changed. The native PowerShell transport is covered by the real ConPTY roundtrip. The latest app-window verification attempt was blocked by automatic tool approval; native picker interaction and integrated-window keyboard behavior remain to be checked. Linux/macOS code paths have not been runtime-tested.

## Four-team verification

The current debug Windows build auto-launched in D:\Coding\pi_squad with one Codex master and sixteen Pi workers. All sixteen supervisor statuses reported idle. Computer Use confirmed four tabs and switched to Workspace 4, displaying Pi 13–16 while the Codex pane remained visible. Browser integration checks verified tab switching preserves hidden terminal instances, seventeen panes exist in total, five are visible per tab, and document/routing/overview controls still work. No sixteen-agent coding workload or quantified token savings benchmark has been run.

MSIX can redirect individual instruction files separately from parent folders. Fixed startup by using fixed allowed document names and rejecting symlink/junction components, without comparing virtualized resolved parents. Actual project init and automatic launch both passed after this fix.

## Outstanding live verification

The full conversation-to-master-to-Pi-to-saved-reply roundtrip through the Pi master has been exercised via `--relay` and MCP (see [MCP.md](MCP.md)); unattended operation still needs a longer soak. The master's Pi provider must be signed in before relay requests can settle. A queued receipt is not completion evidence.

## Operation

Source: `D:\Coding\pi squad version 2`. Executable: `src-tauri\target\debug\pi-squad.exe`, with `bridge.py`, `native_session.py`, `team.py` and the Pi extensions (`native-pi.ts`, `native-team.ts`, `pi-master.ts`, `pisquad-messenger.ts`) beside it. Persistent state remains under `%LOCALAPPDATA%\ChatGPTPlusPiSubagents`; runtime histories and credentials are excluded from Git and bundles.

Pi providers/models remain user-configured. Code drafts and worker reports require review of actual files and tests. Local source conversations can relay messages while active or on their next interaction; no consumer-chat scraping or idle source-chat push is implemented. See [PISQUAD.md](PISQUAD.md).
