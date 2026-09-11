---
name: pisquad
description: Connect to Pi Squad through MCP on invocation and forward explicitly addressed messages when the user says tell PySquad or tell Pi Squad.
---

# Pi Squad

## Connect

Use the configured `pi_squad` MCP server. Its tools are `discover`, `send`, and `read` (normally exposed as `mcp__pi_squad__discover`, `mcp__pi_squad__send`, and `mcp__pi_squad__read`; use the actual tool catalog). Invoking this skill alone connects without forwarding a transcript.

Call `discover` with `{}`. It verifies exactly one live registered master and matching Messenger identity. Use the returned `project` for messages; the conversation folder does not override the app workspace. If an explicitly requested destination differs, report the mismatch. Missing or ambiguous live ownership blocks sending.

If no matching app is running, check the selected project's `launch.cmd`, `package.json` identity and executable. Use its local installation; only when no local installation exists, use `D:\Coding\pi squad version 2`. Launch through that installation's `launch.cmd` with the selected project as working directory. Respect instructions to leave the app closed or avoid restarting. Reuse running apps and existing workers; never launch duplicate owners. Discover again through MCP after startup.

If the MCP tools are absent, report **Pi Squad MCP is unavailable in this task**. Read INSTALL/docs/MCP.md for setup and recovery. Verify registration and desktop startup status; existing tasks can retain an older tool set even when a newer task loads the server. Refresh through supported Codex settings/session controls when available. Discuss an app restart before interrupting an active voice session. Do not silently substitute CLI calls or claim that editing this skill, registering a server, or restarting voice proves MCP availability. Confirm availability by calling the actual MCP `discover` tool in the intended task.

## Explicit forwarding

“Tell PySquad”, “tell PiSquad”, “tell Pi Squad”, or another clear request to forward a message addresses the active master. Forward the relevant instruction and context only. Ordinary conversation, discussion of the trigger, and skill invocation alone send nothing. Existing explicit authorization needs no repeat confirmation.

1. Call MCP `discover` immediately before every send and retain the verified project/master identity.
2. Generate one stable unique `request` per logical message: 1–100 ASCII letters, digits, underscores or hyphens. Retain the originating Codex task ID as `source`.
3. Call MCP `send` with `{project, request, source, text}`. `text` is the authorized message, at most 80KB UTF-8. The adapter rechecks live ownership and uses the native Rust relay and Messenger; it preserves models, settings and saved session ownership.
4. Call MCP `read` with `{project, request}` at bounded intervals. `queued` means persisted delivery, not a reply. `replied` contains the actual correlated master response. Report `failed`, `interrupted`, missing replies and provider errors accurately.
5. Return the actual response to the originating task, attributed to the Pi Squad master. UI focus changes do not redirect it. There is no idle push or automatic voice attachment.

For a busy rejection, wait until the master settles before retrying the unsent request. Reuse the same ID for retries/readback. An existing request returns its receipt without resending; an uncertain outcome must be inspected rather than replayed with a replacement ID. Never invent worker replies or change models to conceal failure.

Master defaults remain Pi openai-codex/gpt-6-astra with low reasoning; workers retain Pi defaults. Read INSTALL/docs/PISQUAD.md for relay recovery and INSTALL/docs/MCP.md for adapter setup and verification.
