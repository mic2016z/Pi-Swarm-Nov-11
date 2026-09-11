# Pi Squad

Version **1.0.0** — a desktop workspace for one Pi master and twenty-four persistent Pi workers.

[GitHub repository](https://github.com/mic2016z/pi-squad)

Rust/Tauri hosts real interactive Pi CLIs. Each Pi conversation persists across restarts using the user's configured model. Type directly in the terminals, use native slash commands and skills, or queue a bounded task for a worker.

**Run:** double-click `launch.cmd`. Launch automatically opens the current working directory and starts one pinned Pi master plus twenty-four Pi worker terminals in six tabs. **Change project** selects another folder later. Requires Python 3, Node.js, a configured Pi CLI and WebView2 on Windows.

**Build:** `npm ci`, then `npm run tauri build -- --debug --no-bundle`. The executable is under `src-tauri/target/debug/`. Keep the bundled Python helpers and Pi extension beside the executable.

**Verify:** `python -m unittest discover -s tests -v`; `cargo test --manifest-path src-tauri/Cargo.toml`; `npm run build`.

- [Setup and operation](docs/SETUP.md)
- [Setup prompt for a local agent task](docs/SETUP-PROMPT.md)
- [MCP adapter](docs/MCP.md)
- [Product requirements](docs/PRD.md)
- [Architecture and recovery](docs/ARCHITECTURE.md)
- [Verification and handover](docs/VALIDATION.md)
- [Agent documents and teamwork](docs/TEAMWORK.md)
- [PiSquad conversation relay](docs/PISQUAD.md)

Native terminals use PowerShell on Windows and the configured shell on Linux/macOS. Delegation enters the same interactive Pi process through an extension. Windows is runtime-tested; Linux/macOS still need platform verification. The Windows executable is an unsigned debug build.

The PiSquad skill relays requests from a local conversation to the live registered Pi master through the `pi_squad` MCP server, which wraps the native Rust relay. It does not access private consumer ChatGPT conversations or push replies into an idle source chat. Agent-to-agent routing between the master and workers uses pi-messenger, not MCP. Model connections require working network access.
