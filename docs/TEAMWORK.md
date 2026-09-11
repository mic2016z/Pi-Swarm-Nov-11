# Team coordination

Pi Squad loads pinned pi-messenger 0.15.2 storage, watcher and reservation modules into each existing Pi terminal. The focused adapter avoids upstream global-file migrations and Crew's separate worker spawning. It is a Messenger integration, not the full Crew orchestration UI.

Stable identities are `master` and `pi-N`, scoped under each project's state directory `messenger/`. The master and workers use the same peer tool and reservation registry. `pi_messenger` exposes join, list, status, send, reserve and release. `squad_message` and `/team @pi-N message` preserve the existing worker interface; `@codex` is a compatibility alias for `master`. All these peer messages use Messenger directly, without Python. Worker model/provider defaults remain untouched.

Reservations are advisory, as in upstream Messenger. The adapter blocks conflicting Pi write/edit calls and normalizes paths; reservations do not lock arbitrary shell commands or external editors. Inspect reservations before claiming/editing and release them after work. Legacy team.py claim records are historical and are not the new live reservation system.

Incoming messages appear in the session and can trigger a turn; busy messages use Pi's supported delivery semantics. Acceptance means an inbox write, not a completed model reply. Replies and IDs distinguish delivery from completion. Project isolation, fixed identities and refusal to spawn peers prevent accidental routing into unrelated workers.

Instructions stay under `instructions/<pane>/agent.md`, context.md and todo.md. The master uses the existing codex document folder across the harness switch. Preserve user edits; context is curated knowledge, not a session log. Legacy worker supervision and document notifications remain pending Rust migration.

Tests: `node --import tsx tests/messenger-smoke.mjs` checks actual file-watch delivery, scope, replies and reservation blocking/release. `node tests/pi-master-smoke.mjs` checks actual Pi startup with Astra low and registration without a model call. The built app awaits an explicit restart and live worker test; Linux/macOS runtime checks remain pending.
