# Pi Squad MCP

`mcp/server.mjs` exposes the existing native relay as three stdio MCP tools. It uses the pinned official TypeScript MCP SDK and Node.js; it neither owns Pi sessions nor starts workers. Pi Squad must already be running with exactly one registered master. Agent actions continue through Pi's existing authentication and permissions.

Install dependencies with `npm ci --prefix mcp`. Register using `codex mcp add pi_squad -- NODE_ABSOLUTE_PATH SERVER_ABSOLUTE_PATH`, supplying the installed Node executable and this repository's `mcp/server.mjs`. `codex mcp get pi_squad --json` verifies configuration. Existing Codex settings are preserved. `PISQUAD_EXE` optionally selects an installed executable; otherwise the adapter checks the repository's packaged executable, then its debug executable.

1. Call `discover` to obtain the live project and master identity.
2. Call `send` with that project, the originating task ID as `source`, a unique stable `request` ID, and the authorized instruction as `text`. The adapter runs discovery again immediately before sending. Ask the master to address existing workers when appropriate.
3. Call `read` with the same project and request. `queued` means persisted delivery, not completion. Only a `replied` receipt contains the settled response. Preserve failures, interruption, and missing worker replies in reports. For uncertain delivery, read the same request instead of creating a replacement.

Tool output is the native receipt, including source, instance and session identity. Reads work after the app exits. Messages are UTF-8 temporary files removed after the native command returns. The adapter invokes an executable with an argument array, without shell interpretation. Commands have a 15-second bound; a timeout is an uncertain outcome requiring readback.

Verification: `npm test --prefix mcp` exercises a real SDK client/server handshake, tool enumeration, invalid request IDs and UTF-8 limits without dispatch. `node mcp/client.mjs discover` verifies the live connection through MCP. The client accepts a tool name and optional JSON argument-file path for explicit live tests.

Codex desktop and CLI share MCP configuration ([official documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)). Registration and an SDK handshake do not prove an already-running voice task has loaded the tools. Check that task's tool catalog and call `pi_squad.discover` there. If absent, report that a connection refresh or new session may be needed; leave running apps and voice calls under user control. No restart is needed for the Pi Squad app itself.

The distributable installer and a voice-task tool call are separate verification steps; global registration alone proves neither.

## Verified local outcome

The Windows live test completed one MCP request through discover/send/read and one Messenger batch to the existing 24 workers: 22 actual replies. Pi 4's session recorded an Antigravity API invalid-argument error; Pi 7 recorded quota exhaustion. No model changes or replacement workers were used. The SDK protocol test, 45 Python tests, four Rust tests including the embedded terminal round-trip, frontend build and actual Pi master startup smoke passed.

Desktop logs confirmed `pi_squad` reached `ready` in a fresh task runtime. The existing voice task retained its earlier server set even after reconnecting voice. This establishes successful desktop server loading, but direct MCP invocation from that voice task remains unverified. The public app-server protocol includes `config/mcpServer/reload`; this task has no exposed tool for issuing it to the running desktop connection. A fresh task runtime loads the server without a Pi Squad restart.
