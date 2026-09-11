# Pi Squad relay

The active master is an interactive Pi CLI session using openai-codex/gpt-6-astra with low reasoning. Workers use Pi defaults. The master retains the existing `codex` pane/document identity for compatibility; its Messenger address is `master`.

The application executable provides `--relay discover`, `--relay send --project PROJECT --source SOURCE --request REQUEST --text-file FILE`, and `--relay read --project PROJECT --request REQUEST`. This Rust interface verifies live app/master processes and matching Messenger registration, writes a request receipt and delivers through the pinned Messenger inbox format. It does not invoke Python or the Codex CLI.

Registration is automatic when the master extension loads. Readiness requires its actual Pi session and Messenger registration. Relay requests retain their origin, master session and runtime instance. The master publishes its reply after agent settlement, and records interrupted work on shutdown. A busy master or active relay slot rejects additional sends rather than mixing replies. Never resend an uncertain request under a new ID. Old-instance inbox messages are not valid new requests.

Invoke the PiSquad skill to connect a supported local conversation, then say “tell PySquad” followed by the message. Ordinary conversation stays local. Replies go back to their source conversation; focus alone does not change routing. Discovery uses the workspace open in the app. The project-local launcher is preferred; see the installed skill for fallback resolution.

The master uses an exclusive OS file lock to prevent two app instances from owning its saved session. Switching arbitrary harnesses in the same pane remains future work. Existing Python scripts remain for legacy worker supervision and document management; they are not the new master relay.

Verification: Messenger watch delivery, isolation, reply correlation and reservation write blocking; actual Pi master startup/model/registration without a model call; native Rust tests and terminal transport. The full user-visible rollout is pending the user-requested restart. Linux/macOS code paths require runtime verification.
