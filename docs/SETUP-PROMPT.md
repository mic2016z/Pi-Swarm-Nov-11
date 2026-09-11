# Copy and paste into a capable local agent task

Set up **Pi Squad** from the attached/extracted bundle.

App folder: `<ABSOLUTE PATH TO EXTRACTED APP>`
My project: `<ABSOLUTE PATH TO PROJECT>`

I authorize local setup and opening this Rust desktop app with one embedded Pi master terminal and twenty-four Pi worker terminals. Inspect AGENTS.md and docs/PRD.md, check Python/Node/Pi/WebView2, then run launch.cmd (or build with npm ci and npm run tauri build -- --debug --no-bundle if needed). Use the Pi CLI's supported sign-in and my configured model defaults; the master's provider/model is the only app-managed selection. Do not access ChatGPT cookies or invent account APIs.

Open my project in the app, verify the saved sessions (preserve additional existing workers), and show how to type directly or queue a task. Register the `pi_squad` MCP server as described in docs/MCP.md so this task can reach the master through `discover`, `send` and `read`. Review agent edits before claiming success. Coordinate repository file ownership across workers through pi_messenger reservations.

Use the PiSquad skill and the exact live registered Pi master for conversation relay. Do not create extra desktop tasks as a substitute for the native Pi workers. Route bounded work through the existing local queue and adopt saved sessions only after their current owners release them.

Attaching files is not execution. If local execution or MCP tools are unavailable, explain that precise limit and provide the supported commands. Do not claim consumer ChatGPT chat mirroring, automatic messages into idle conversations, or zero coordination overhead. Do not publish to GitHub. Finish by showing the runnable path, actual checks passed and any remaining limitations.
