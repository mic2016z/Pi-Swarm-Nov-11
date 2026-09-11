# Relay transport research

Research date: 8 September 2026. Documentation findings and architecture recommendations; no latency benchmark was performed.

## Supported upstream capabilities

- Codex App Server uses bidirectional JSON-RPC, with initialization once per connection, thread creation/resumption, turn submission, steering and streamed events. Its documented remote terminal mode connects the real Codex TUI to a server using `codex --remote ws://127.0.0.1:4500`. This makes a persistent backend with a visible terminal plausible. The current documentation labels WebSocket transport experimental and unsupported for production; verify installed-version support and same-thread attachment before adopting it. [Official App Server documentation](https://learn.chatgpt.com/docs/app-server)
- Codex approval requests arrive as server requests, scoped to a thread and turn. A client must handle them and track resolution. Listener health alone does not prove that the desired thread is ready. Generate the protocol schema from the installed binary instead of assuming today's web documentation matches it. [Official App Server documentation](https://learn.chatgpt.com/docs/app-server)
- Pi extensions can inject user messages into the existing session through `sendUserMessage`. Idle injection starts a turn; busy injection requires a delivery policy. Extensions can observe lifecycle events and retain the full interactive terminal UI. Current upstream provides `agent_settled` for the point after automatic retry, compaction and queued continuation, whereas `agent_end` can precede them. Verify these APIs against the installed Pi version. [Official Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- Pi RPC exchanges JSON commands and streamed events. Prompt acceptance is acknowledged separately from later execution results; busy prompts support steering or follow-up queueing. RPC is an integration mode whose host handles the interface, so replacing interactive Pi processes with RPC is a larger UI change. [Official Pi RPC documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), [extension mode comparison](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

## Recommended design (engineering judgment)

Keep the actual Pi terminal processes. Give their extension a persistent local connection to Pi Squad's Rust supervisor and push work over it. The extension injects the message through Pi's supported API and pushes acceptance, activity and completion back. This avoids filesystem polling and per-message helper startup without replacing the user's terminals.

Use one persistent Codex App Server as the master execution owner, with Pi Squad as its client and the real Codex TUI attached to that same backend where supported. Prototype the remote TUI and shared-thread behavior first because the WebSocket API is experimental. Retain the existing transport as a fallback until this is proven on the installed Windows build.

Expose a small native Pi Squad CLI (or persistent tool endpoint) for voice-triggered submissions. It should contact the already-running supervisor, rather than launch a new Codex/Pi process per message. The supervisor's active workspace is authoritative. Bind each accepted request to that workspace's generation, master thread and worker identity; reject obsolete bindings after project switches.

Give the master a structured dispatch tool connected to the same supervisor. Prefer a persistent MCP integration for a stable tool surface; App Server dynamic tools are another documented but experimental option. Batch independent worker dispatches when the master decides they are independent. Return dispatch acceptance promptly, then stream individual replies; do not hold the voice response until every worker completes.

Keep one execution owner per session. Do not start a separate headless process against a session already owned by an interactive terminal. Queue routine additions while busy; reserve steering for an intentional correction. Preserve approval handling and show waiting-for-user distinctly from connecting or idle.

Use request identifiers, explicit acceptance, bounded queues and delivery state. Retry only when non-delivery is established; reconnect and query uncertain requests before replaying. Show readiness only after the broker, correct master and desired worker connections are usable.

## Measurement and acceptance plan

Instrument timestamps for final speech transcript, relay receipt, Codex acceptance, master dispatch, worker acceptance, first output and completion. Report transport latency separately from model reasoning and tool execution. Measure warm and cold starts, one worker and broadcast, busy workers, reconnects, project switches and approval waits. Track median and tail latency, lost/duplicate messages, and errors. No numeric speedup can be established from documentation alone.

The decisive smoke test is: open a new workspace, say the trigger once, see the same visible Codex master accept it, see the intended existing Pi terminals receive it, and receive replies without restarting or creating duplicate session owners.

A dedicated local MCP send tool for the voice assistant can collapse repeated shell discovery/helper calls into one broker submission. A batch worker tool can likewise replace one shell invocation per worker. These are proposed Pi Squad interfaces, not existing upstream Pi commands. The current voice backend's scheduling and model time remain outside the local broker's control; a skill alone cannot remove those delays.

## Existing Pi coordination packages: evaluate before rewriting

The Pi catalog lists **pi-intercom** and **pi-messenger** as separately installed community extensions. Catalog presence does not make either a built-in Pi protocol or an official Codex integration. [Pi Intercom catalog](https://pi.dev/packages/pi-intercom), [Pi Messenger catalog](https://pi.dev/packages/pi-messenger)

| Option | Verified behavior | Fit for this project |
| --- | --- | --- |
| Pi core subagent extension example | Spawns a separate Pi process for each invocation, with isolated context and JSON-mode output; supports single, parallel and chain operations. | Useful reference for task orchestration, but does not deliver to the already-visible Pi terminal sessions. [Official example source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts) |
| pi-intercom | Existing sessions load an extension and connect to a local broker; targeted messaging, replies, live discovery and reconnect behavior. | Closest existing candidate for the requested existing-terminal routing. Evaluate before writing another broker. [Author repository](https://github.com/nicobailon/pi-intercom) |
| pi-messenger | Coordination extension with file-backed registration, messaging, reservations and Crew task workflows. Explicit targeted sends exist alongside shared coordination. | More useful for team coordination than as the minimal transport replacement. Do not describe it as broadcast-only. [Author README](https://github.com/nicobailon/pi-messenger/blob/main/README.md) |

### Intercom transport and platform details

The author implementation uses Windows named pipes by default and Unix sockets elsewhere. Windows localhost TCP is opt-in, with a dynamic endpoint file. These are explicit code paths, not inferred cross-platform support; they have not been smoke-tested on this machine. [Transport paths source](https://github.com/nicobailon/pi-intercom/blob/main/broker/paths.ts)

Wire frames are a four-byte big-endian payload length followed by UTF-8 JSON, with a default one-megabyte receive limit. It is not JSONL, MCP or Codex App Server JSON-RPC. [Framing implementation](https://github.com/nicobailon/pi-intercom/blob/main/broker/framing.ts)

Current protocol validators include receipt states such as received, queued, injected and acknowledged, correlation fields, delivery timestamps and cancellation/supersession controls. Those stages should not be conflated with successful task completion. [Protocol source](https://github.com/nicobailon/pi-intercom/blob/main/broker/protocol.ts)

The package supports routing scopes and stable identities, and only sessions with the extension connected appear in discovery. Idle recipients can start a turn; busy interactive recipients use Pi's steering queue. Its broker is a local service, and its extension channels offer non-conversational coordination without starting an LLM turn. These are package behaviors, not core Pi guarantees. [Catalog documentation](https://pi.dev/packages/pi-intercom)

### Messenger transport detail

Messenger writes per-agent inbox JSON and watches the inbox with `fs.watch`, debouncing events by 50 milliseconds. Consequently, file-based does not automatically mean repeated polling. The inspected reader removes messages after delivery and also removes failed parse/delivery entries; this warrants explicit recovery tests if adopting it for authoritative task delivery. [Storage implementation](https://github.com/nicobailon/pi-messenger/blob/main/store.ts)

The inspected Messenger README does not provide a specific Windows support guarantee. Core filesystem use is insufficient evidence that every Crew launcher and workflow works on Windows; test those separately. Its reservation features can also overlap Pi Squad's existing file ownership rules. [Author README](https://github.com/nicobailon/pi-messenger/blob/main/README.md)

### Revised implementation recommendation

**Evaluate Intercom first instead of immediately replacing all coordination with custom Rust.** It already addresses the difficult existing-session discovery, Windows IPC, reply routing and reconnect requirements. Preserve the existing Pi terminals and their user-selected providers.

A narrow Rust adapter in Pi Squad can speak the pinned Intercom wire protocol and expose a native CLI/MCP tool to Codex. This is a proposed integration: no ready-made Codex adapter or Rust client was verified in the reviewed author documentation. Keep the actual broker as the package's TypeScript/Node implementation initially; removing Python does not require rewriting that broker in Rust. Porting the broker would be a separate maintenance decision with compatibility tests.

Prototype two existing Pi terminals and one Codex tool adapter before rollout to twenty-four agents. Verify exact message acceptance, busy behavior, reply correlation, reconnect, active-workspace scope and rejection of stale sessions. Pin the tested package version and verify protocol behavior against that version because repository main and published catalog releases can differ. Keep Pi Squad responsible for selected workspace and execution ownership; let Intercom route messages rather than independently spawn or adopt workers.

No evidence here establishes that Intercom is faster than the existing implementation in a measured sense. It is a better architectural candidate because it already implements the desired push-to-existing-session path. Compare instrumented timings before deciding whether a bespoke Rust transport is justified.
