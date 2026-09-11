# Setup and operation

Windows prerequisites: Python 3 on PATH, Node.js and a configured Pi CLI on PATH, and WebView2. Building also requires Rust/MSVC C++ Build Tools. Authentication uses your installed CLI accounts; the app never manages credentials.

Double-click `launch.cmd`. The app automatically opens the process working directory and starts one pinned Pi master pane plus twenty-four native Pi worker terminals in six tabs. Existing workers are retained. Use **Change project** to select another folder later. The executable install directory locates bundled helpers; it does not override the launch working directory. A Windows shortcut uses its Start in folder as that working directory. Type directly in either kind of terminal. For multiline Pi tasks, use the bottom composer and choose the worker. **+ Add Pi** creates another durable session. **Pi sign in** runs the Pi provider's official login flow in an embedded pane; a system browser may be opened for sign-in.

**Prepare master handover** generates the current routing brief for the Pi master. The master already coordinates workers through pi_messenger; paste the brief only when its prompt is ready. The app does not inject a prompt over partially typed input or an approval dialog.

**Close app** waits for idle Pi workers; active jobs must finish first. Use the native CLI exit command to leave an individual agent. Relaunching the same project resumes each saved Pi conversation, including the master's. Interrupted jobs appear in results and are not replayed automatically.

## Connect an outside agent

The supported path is the `pi_squad` MCP server ([MCP.md](MCP.md)): register it with your harness (for example `claude mcp add pi_squad -- NODE_ABSOLUTE_PATH SERVER_ABSOLUTE_PATH` or the equivalent `codex mcp add`), then call `discover`, `send` and `read` to reach the live Pi master, which delegates to workers through pi_messenger.

As a lower-level fallback, a task can submit directly to a single worker's queue using the absolute bridge script path, project directory and Pi number. It must submit to the queue rather than launch Pi itself:

```powershell
python "D:\Coding\pi squad version 2\bridge.py" submit --project D:\Coding\your-project --agent 1 --prompt-file C:\path\task.txt
python "D:\Coding\pi squad version 2\bridge.py" results --project D:\Coding\your-project --agent 1 --after 000000000000
python "D:\Coding\pi squad version 2\bridge.py" status --project D:\Coding\your-project
```

Use UTF-8 prompt files for exact multiline text. Results include prompt source, output, exit code, error and job ID; track the last consumed ID. There is no automatic push into an idle external conversation; poll `read` or `results`.

Attaching this source bundle to a conversation does not execute it. Use the exact prompt in [SETUP-PROMPT.md](SETUP-PROMPT.md) with a capable local agent. New project paths automatically select separate sessions. Do not copy runtime state or authentication files into a distributable bundle.
