#![cfg_attr(windows, windows_subsystem = "windows")]

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashMap, io::{Read, Write}, path::{Path, PathBuf}, process::Command, sync::{Arc, Mutex}};
use tauri::{Emitter, Manager, State};

#[derive(Clone, Serialize)]
struct Descriptor { id: String, title: String, output: String }
struct TerminalProcess {
    desc: Descriptor,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}
#[derive(Default)]
struct Workspace { master_lock: Option<std::fs::File>, project: Option<String>, terminals: HashMap<String, TerminalProcess>, generation: u64 }
type Shared = Arc<Mutex<Workspace>>;
#[derive(Clone, Serialize)]
struct Output { id: String, data: Vec<u8> }
fn error(e: impl std::fmt::Display) -> String { e.to_string() }

fn native_shell(command: CommandBuilder) -> CommandBuilder {
    let quote = |value: &std::ffi::OsString| {
        let value = value.to_string_lossy();
        if cfg!(windows) { format!("'{}'", value.replace('"', "\\\"").replace('\'', "''")) }
        else { format!("'{}'", value.replace('\'', "'\\''")) }
    };
    let invocation = command.get_argv().iter().map(quote).collect::<Vec<_>>().join(" ");
    let mut shell = if cfg!(windows) {
        let mut shell = CommandBuilder::new("powershell.exe");
        // Encode the script so Windows command-line parsing cannot consume its quotes.
        // Windows PowerShell's legacy native binder also needs escaped embedded quotes.
        let script = format!("& {invocation}");
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        shell.args(["-NoLogo", "-NoExit", "-EncodedCommand", &encoded]);
        shell
    } else {
        let path = std::env::var("SHELL").ok().filter(|p| Path::new(p).is_file())
            .unwrap_or_else(|| if cfg!(target_os="macos") { "/bin/zsh".into() } else { "/bin/bash".into() });
        let mut shell = CommandBuilder::new(&path);
        let quoted_shell = quote(&std::ffi::OsString::from(&path));
        shell.args(["-l", "-i", "-c", &format!("{invocation}; exec {quoted_shell} -l -i")]);
        shell
    };
    if let Some(cwd) = command.get_cwd() { shell.cwd(cwd); }
    for (key, value) in command.iter_extra_env_as_str() { shell.env(key, value); }
    shell
}

// ---------------------------------------------------------------------------
// Hermes plugin installation
// ---------------------------------------------------------------------------

/// Where the squad plugin ships from: bundled beside the executable, or the
/// repository checkout during development.
fn plugin_source(app: &tauri::AppHandle) -> PathBuf {
    let bundled = app.path().resource_dir().unwrap_or_default().join("hermes-plugin").join("squad");
    if bundled.join("plugin.yaml").exists() { bundled }
    else { Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("hermes-plugin").join("squad") }
}

/// Hermes' state home: HERMES_HOME, else the platform default.
fn hermes_home() -> PathBuf {
    if let Some(home) = std::env::var_os("HERMES_HOME") { return PathBuf::from(home); }
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("hermes"))
            .or_else(|| std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData").join("Local").join("hermes")))
            .unwrap_or_else(|| PathBuf::from(".hermes"))
    } else {
        std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".hermes")).unwrap_or_else(|| PathBuf::from(".hermes"))
    }
}

fn copy_dir(source: &Path, target: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(source).map_err(error)?.flatten() {
        let destination = target.join(entry.file_name());
        if entry.path().is_dir() {
            std::fs::create_dir_all(&destination).map_err(error)?;
            copy_dir(&entry.path(), &destination)?;
        } else if entry.file_name().to_string_lossy() != "plugin.yaml"
            || std::fs::read_to_string(&destination).unwrap_or_default()
                != std::fs::read_to_string(entry.path()).unwrap_or_default() {
            std::fs::copy(entry.path(), &destination).map_err(error)?;
        }
    }
    Ok(())
}

/// Install the squad plugin into Hermes' user plugin directory and enable it.
/// The plugin is inert outside squad panes, so a global install is safe.
fn install_plugin(app: &tauri::AppHandle) -> Result<(), String> {
    let source = plugin_source(app);
    if !source.join("plugin.yaml").exists() { return Err("Squad plugin source missing".into()); }
    let target = hermes_home().join("plugins").join("squad");
    std::fs::create_dir_all(&target).map_err(error)?;
    let manifest_changed = std::fs::read_to_string(source.join("plugin.yaml")).map_err(error)?
        != std::fs::read_to_string(target.join("plugin.yaml")).unwrap_or_default();
    copy_dir(&source, &target)?;
    if manifest_changed || std::env::var_os("HQS_FORCE_PLUGIN_ENABLE").is_some() {
        // `plugins enable` is the public gate; a failure on an already-enabled
        // plugin is harmless, so only real errors are surfaced.
        let output = Command::new("hermes").args(["plugins", "enable", "squad"]).output().map_err(error)?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stderr.contains("already enabled") && !stderr.to_lowercase().contains("enabled") {
                return Err(format!("hermes plugins enable squad failed: {}", stderr.trim()));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Native project config (replaces the Python bridge's config.json)
// ---------------------------------------------------------------------------

fn default_config() -> Value {
    json!({
        "workers": {"1": "UI designer", "2": "Backend expert", "3": "QA tester"},
        "default_model": "opencode-zen/big-pickle",
        "agent_models": {},
        "github_repo": ""
    })
}

fn read_config(root: &Path) -> Value {
    std::fs::read_to_string(root.join("config.json")).ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(default_config)
}

fn write_config(root: &Path, config: &Value) -> Result<(), String> {
    let temporary = root.join("config.json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(config).map_err(error)?).map_err(error)?;
    std::fs::rename(&temporary, root.join("config.json")).map_err(error)
}

fn valid_model(model: &str) -> bool {
    !model.trim().is_empty() && !model.starts_with('-') && !model.contains(char::is_whitespace)
        && model.len() < 200
}

fn model_for(config: &Value, pane: &str) -> Option<String> {
    let model = config["agent_models"].get(pane).and_then(|v| v.as_str())
        .or_else(|| config["default_model"].as_str()).unwrap_or("");
    valid_model(model).then(|| model.to_string())
}

// ---------------------------------------------------------------------------
// Per-agent instruction documents
// ---------------------------------------------------------------------------

/// Template version for generated .squad documents. Bump when the text below
/// changes; seed_documents upgrades unmodified older files and never touches
/// user-edited ones.
const TEMPLATE_VERSION: u32 = 1;

fn document_marker(version: u32) -> String {
    format!("<!-- squad-template v{version} -->\n")
}

fn document_bodies(config: &Value) -> Vec<(String, String, String)> {
    let mut out = vec![(
        "master".into(),
        "agent.md".into(),
        "# Master\n\nYou are the master of a Hermes Agent quad squad. When the user gives you a task:\n\n1. Write the shared board once with squad_board: decompose the work into vertical slices, each with a non-empty acceptance command, a files list and dependencies. Slice zero is the contracts slice (types, schemas, API shapes, test scaffolding) that everything else depends on.\n2. After planning you are a peer: take slices yourself when the board has work and idle capacity is low. Do not dispatch, poll or re-plan unless a slice is blocked or the release gate fails.\n3. You hold tie-breaking and completion-declaration powers: you alone unblock, cancel, and declare the task done.\n\nDeclare done only when every slice is done, no reservations remain, the project checks pass (python -m pytest, npm run build, cargo test), and an agent that authored none of the last slices has run the final integration review.\n".into(),
    ), (
        "master".into(),
        "context.md".into(),
        "# Context\n\nCoordination is file-based: registry, inbox, reservations and board.json under the squad state directory. Reviews are never reviewed; approval is a board transition only. Workers idle without model calls when no slice is available to them.\n".into(),
    ), (
        "master".into(),
        "todo.md".into(),
        "# Master todo\n\n- [ ] Await a scoped user task\n".into(),
    )];
    if let Some(workers) = config["workers"].as_object() {
        for (number, role) in workers {
            let name = format!("hermes-{number}");
            let role = role.as_str().unwrap_or("Worker");
            out.push((name.clone(), "agent.md".into(), format!("# {role}\n\nYou are {name}, the {role} of a Hermes Agent quad squad. Run the worker loop:\n\n1. Read the board with squad_board list.\n2. Claim the highest-priority open slice whose dependencies are done.\n3. Reserve the slice's files with squad_claims before editing.\n4. Implement, then run the slice's acceptance command until it exits zero.\n5. Transition the slice to review and message exactly one idle peer with squad_message (slice id + transition).\n6. Release your reservations and return to step 1.\n\nWhen no slice is available to you, idle: no model requests, no invented tasks. Never review your own work.\n")));
            out.push((name.clone(), "context.md".into(), "# Context\n\nCoordination is file-based: registry, inbox, reservations and board.json under the squad state directory. Writes to another agent's reserved paths are denied. Every peer message must reference a slice id and a board transition.\n".into()));
            out.push((name, "todo.md".into(), "# Worker todo\n".into()));
        }
    }
    out
}

fn agent_documents(config: &Value) -> Vec<(String, String, String)> {
    document_bodies(config).into_iter()
        .map(|(name, file, body)| (name, file, format!("{}{}", document_marker(TEMPLATE_VERSION), body)))
        .collect()
}

/// Append one line to the squad feed under the same lock the Python plugin uses.
fn append_squad_feed(root: &Path, entry: &str) {
    let squad = root.join("squad");
    let _ = std::fs::create_dir_all(&squad);
    let line = format!("{{\"ts\": \"{}\", {}}}\n", chrono::Utc::now().to_rfc3339(), entry);
    let Ok(lock) = std::fs::OpenOptions::new().read(true).write(true).create(true).open(squad.join("feed.lock")) else { return };
    for _ in 0..50 {
        if fs2::FileExt::try_lock_exclusive(&lock).is_ok() {
            if let Ok(mut feed) = std::fs::OpenOptions::new().create(true).append(true).open(squad.join("feed.jsonl")) {
                let _ = std::io::Write::write_all(&mut feed, line.as_bytes());
            }
            drop(lock);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// Seed .squad/<name>/{agent,context,todo}.md only where missing, and carry
/// across documents saved for this project's earlier OpenCode workers. Files
/// still on an older unmodified template upgrade in place; user-edited files
/// are never touched and are reported on the feed.
fn seed_documents(project: &str, config: &Value, root: &Path) {
    for (name, _file, _text) in &agent_documents(config) {
        let legacy = Path::new(project).join(".squad").join(name.replacen("hermes-", "oc-", 1));
        let dir = Path::new(project).join(".squad").join(name);
        if !dir.exists() && legacy.exists() {
            let _ = std::fs::create_dir_all(&dir);
            for file in ["agent.md", "context.md", "todo.md"] {
                if let Ok(bytes) = std::fs::read(legacy.join(file)) {
                    let _ = std::fs::write(dir.join(file), bytes);
                }
            }
        }
    }
    let bodies: HashMap<(String, String), String> = document_bodies(config).into_iter()
        .map(|(name, file, body)| ((name, file), body)).collect();
    for (name, file, text) in &agent_documents(config) {
        let path = Path::new(project).join(".squad").join(name).join(file);
        if !path.exists() {
            let _ = std::fs::create_dir_all(path.parent().unwrap());
            let _ = std::fs::write(&path, text);
            continue;
        }
        let Ok(existing) = std::fs::read_to_string(&path) else { continue };
        if existing == *text { continue; }
        let (marker_version, body) = match existing.split_once('\n') {
            Some((first, rest)) if first.starts_with("<!-- squad-template v") => (
                first.trim_start_matches("<!-- squad-template v").trim_end_matches(" -->")
                    .parse::<u32>().ok(),
                rest.to_string(),
            ),
            _ => (None, existing.clone()),
        };
        let generated = bodies.get(&(name.clone(), file.clone()))
            .is_some_and(|template| *template == body);
        if generated && marker_version.map_or(true, |v| v < TEMPLATE_VERSION) {
            let _ = std::fs::write(&path, text);
        } else if marker_version.is_some() {
            append_squad_feed(root, &format!("\"type\": \"doc.stale\", \"agent\": \"{name}\", \"target\": \"{file}\", \"preview\": \"user-modified; template v{TEMPLATE_VERSION} not applied\""));
        }
    }
}

// ---------------------------------------------------------------------------
// Terminal spawning
// ---------------------------------------------------------------------------

fn spawn_terminal(app: &tauri::AppHandle, shared: &Shared, id: String, title: String, cmd: CommandBuilder) -> Result<Descriptor, String> {
    spawn_terminal_with_boot(app, shared, id, title, cmd, None)
}

/// Spawn a pane; when `boot` is set, type it into the pane shortly after the
/// REPL starts, exactly as the user would. Hermes' injected-message path only
/// drains once the prompt loop is consuming input, so the first turn of a
/// fresh or resumed pane is delivered over the PTY instead.
fn spawn_terminal_with_boot(app: &tauri::AppHandle, shared: &Shared, id: String, title: String, cmd: CommandBuilder, boot: Option<String>) -> Result<Descriptor, String> {
    let mut cmd = native_shell(cmd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let mut workspace = shared.lock().map_err(error)?;
    if workspace.terminals.contains_key(&id) { return Err("Terminal already exists".into()); }
    let pair = native_pty_system().openpty(PtySize { rows: 28, cols: 100, pixel_width: 0, pixel_height: 0 }).map_err(error)?;
    let child = pair.slave.spawn_command(cmd).map_err(error)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(error)?;
    let writer = pair.master.take_writer().map_err(error)?;
    let desc = Descriptor { id: id.clone(), title, output: String::new() };
    let generation = workspace.generation;
    workspace.terminals.insert(id.clone(), TerminalProcess { desc: desc.clone(), writer, master: pair.master, child });
    drop(workspace);
    if let Some(boot) = boot {
        let shared = shared.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(20));
            let mut ws = match shared.lock() { Ok(ws) => ws, Err(_) => return };
            if ws.generation != generation { return; }
            if let Some(term) = ws.terminals.get_mut(&id) {
                let _ = term.writer.write_all(format!("{boot}\r").as_bytes());
                let _ = term.writer.flush();
            }
        });
    }
    let app = app.clone(); let shared = shared.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 { break; }
            if let Ok(mut ws) = shared.lock() {
                if ws.generation != generation { return; }
                if let Some(term) = ws.terminals.get_mut(&id) {
                    term.desc.output.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if term.desc.output.len() > 256_000 {
                        let mut cut = term.desc.output.len() - 200_000;
                        while !term.desc.output.is_char_boundary(cut) { cut += 1; }
                        term.desc.output.drain(..cut);
                    }
                }
            }
            let _ = app.emit("terminal-output", Output { id: id.clone(), data: buf[..n].to_vec() });
        }
        if shared.lock().is_ok_and(|ws| ws.generation == generation) {
            let _ = app.emit("terminal-exit", serde_json::json!({"id":id,"code":"exited"}));
        }
    });
    Ok(desc)
}

/// Launch one Hermes Agent pane. The classic REPL (`hermes chat`) is required,
/// not the TUI: the squad plugin's turn injection works in the CLI loop only.
fn hermes_terminal(app: &tauri::AppHandle, shared: &Shared, project: &str, config: &Value, agent: &str) -> Result<Descriptor, String> {
    let root = relay::state_for(project)?;
    let name = if agent == "master" { "master".to_string() } else { format!("hermes-{agent}") };
    let pane = if agent == "master" { "master".to_string() } else { name.clone() };
    let agent_root = root.join(&pane);
    std::fs::create_dir_all(&agent_root).map_err(error)?;
    let mut cmd = CommandBuilder::new("hermes");
    cmd.args(["chat", "--yolo"]);
    if let Some(model) = model_for(config, &pane) {
        // hermes does not split "provider/model"; pass both flags explicitly.
        match model.split_once('/') {
            Some((provider, name)) => { cmd.args(["--provider", provider, "--model", name]); }
            None => { cmd.args(["--model", &model]); }
        }
    }
    // The plugin records the session id after the first turn; resume it after.
    if let Ok(bytes) = std::fs::read(agent_root.join("session.json")) {
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            if let Some(id) = value["sessionID"].as_str().filter(|v| !v.trim().is_empty()) {
                cmd.args(["--resume", id]);
            }
        }
    }
    cmd.env("SQUAD_AGENT", agent);
    cmd.env("SQUAD_PROJECT", project);
    cmd.env("SQUAD_ROOT", &agent_root);
    cmd.env("SQUAD_APP_PID", std::process::id().to_string());
    cmd.cwd(project);
    let title = if agent == "master" { "Hermes · master".to_string() }
        else { format!("Hermes Agent {agent}") };
    // The boot line starts the pane's first turn from the PTY, like a user
    // typing: it creates the session the relay's ready gate needs, on fresh
    // and resumed panes alike.
    let boot = if agent == "master" {
        "Quad squad master online. Acknowledge in one short line, then wait for user tasks; your standing instructions arrive in the pre-turn briefing.".to_string()
    } else {
        format!("Quad squad worker hermes-{agent} online. Acknowledge in one short line, check the board with squad_board, and idle if nothing is claimable.")
    };
    spawn_terminal_with_boot(app, shared, pane, title, cmd, Some(boot))
}

#[tauri::command]
fn launch_directory() -> Result<String, String> {
    std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).map_err(error)
}
/// One level of a directory tree, for the in-app folder browser.
#[tauri::command]
fn list_directories(path: String) -> Result<serde_json::Value, String> {
    let start = if path.trim().is_empty() {
        std::env::current_dir().map_err(error)?
    } else {
        std::path::PathBuf::from(&path)
    };
    // Fall back to the nearest existing ancestor so a typo still shows something.
    let mut here = start.clone();
    while !here.is_dir() {
        match here.parent() {
            Some(parent) => here = parent.to_path_buf(),
            None => return Err("No such folder".into()),
        }
    }
    let mut folders: Vec<String> = std::fs::read_dir(&here)
        .map_err(error)?
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        // Hidden and system folders are noise when picking a project.
        .filter(|name| !name.starts_with('.') && !name.starts_with('$'))
        .collect();
    folders.sort_by_key(|name| name.to_lowercase());

    let drives: Vec<String> = ('A'..='Z')
        .map(|letter| format!("{letter}:\\"))
        .filter(|drive| std::path::Path::new(drive).is_dir())
        .collect();

    Ok(serde_json::json!({
        "path": here.to_string_lossy(),
        "parent": here.parent().map(|p| p.to_string_lossy().into_owned()),
        "folders": folders,
        "drives": drives,
    }))
}

#[tauri::command]
async fn start_workspace(app: tauri::AppHandle, state: State<'_, Shared>, project: String) -> Result<Vec<Descriptor>, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || start_workspace_blocking(app, shared, project)).await.map_err(error)?
}
fn start_workspace_blocking(app: tauri::AppHandle, state: Shared, project: String) -> Result<Vec<Descriptor>, String> {
    let project = std::fs::canonicalize(&project).map_err(error)?.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    if !Path::new(&project).is_dir() { return Err("Choose an existing project directory".into()); }
    let mut workspace = state.lock().map_err(error)?;
    if workspace.project.is_some() { return Err("Close this workspace before opening another project".into()); }
    workspace.project = Some(project.clone());
    drop(workspace);
    let result = (|| {
    install_plugin(&app)?;
    let root = relay::state_for(&project)?;
    if let Ok(bytes) = std::fs::read(root.join("master-runtime.json")) {
        if let Ok(runtime) = serde_json::from_slice::<Value>(&bytes) {
            if runtime["pid"].as_u64().is_some_and(|pid| relay::alive(pid as u32)) {
                return Err("This project's Hermes master is already running. Close that workspace before opening it again.".into());
            }
        }
    }
    let mut config = read_config(&root);
    if config["workers"].as_object().map_or(true, |w| w.is_empty()) {
        config = default_config();
        write_config(&root, &config)?;
    }
    seed_documents(&project, &config, &root);
    let master_root = root.join("master");
    std::fs::create_dir_all(&master_root).map_err(error)?;
    let master_lock = std::fs::OpenOptions::new().read(true).write(true).create(true).open(master_root.join("owner.lock")).map_err(error)?;
    fs2::FileExt::try_lock_exclusive(&master_lock).map_err(|_| "This project's Hermes master session already has an owner".to_string())?;
    state.lock().map_err(error)?.master_lock = Some(master_lock);
    let mut out = vec![];
    match hermes_terminal(&app, &state, &project, &config, "master") {
        Ok(desc) => out.push(desc),
        Err(e) => { let _ = app.emit("workspace-warning", format!("The master did not start: {e}")); }
    }
    let mut numbers: Vec<u64> = config["workers"].as_object().map(|w| w.keys().filter_map(|k| k.parse().ok()).collect()).unwrap_or_default();
    numbers.sort();
    for number in numbers {
        match hermes_terminal(&app, &state, &project, &config, &number.to_string()) {
            Ok(desc) => out.push(desc), Err(e) => { let _ = app.emit("workspace-warning", e); }
        }
    }
    Ok(out)
    })();
    if result.is_err() {
        let mut workspace = state.lock().map_err(error)?;
        if workspace.terminals.is_empty() { workspace.project = None; }
    }
    result
}
#[tauri::command]
fn snapshot(state: State<Shared>) -> Vec<Descriptor> { state.lock().unwrap().terminals.values().map(|t| t.desc.clone()).collect() }
#[tauri::command]
fn add_agent(app: tauri::AppHandle, state: State<Shared>) -> Result<Descriptor, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace first")?;
    let root = relay::state_for(&project)?;
    let mut config = read_config(&root);
    let workers = config["workers"].as_object().ok_or("Invalid config")?;
    let next = workers.keys().filter_map(|k| k.parse::<u64>().ok()).max().unwrap_or(0) + 1;
    config["workers"][&next.to_string()] = json!(format!("Worker {next}"));
    write_config(&root, &config)?;
    seed_documents(&project, &config, &root);
    hermes_terminal(&app, &state, &project, &config, &next.to_string())
}
#[tauri::command]
fn write_terminal(state: State<Shared>, id: String, data: String) -> Result<(), String> {
    let mut ws = state.lock().map_err(error)?;
    let term = ws.terminals.get_mut(&id).ok_or("Unknown terminal")?;
    term.writer.write_all(data.as_bytes()).map_err(error)?;
    term.writer.flush().map_err(error)
}
#[tauri::command]
fn resize_terminal(state: State<Shared>, id: String, rows: u16, cols: u16) -> Result<(), String> {
    let ws = state.lock().map_err(error)?;
    ws.terminals.get(&id).ok_or("Unknown terminal")?.master.resize(PtySize{ rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 }).map_err(error)
}

fn squad_inbox(root: &Path, name: &str, from: &str, text: &str, reply_to: Option<&str>) -> Result<usize, String> {
    let inbox = root.join("squad").join("inbox").join(name);
    std::fs::create_dir_all(&inbox).map_err(error)?;
    let id = uuid();
    let mut message = json!({"id": id, "from": from, "to": name, "text": text,
        "timestamp": chrono::Utc::now().to_rfc3339()});
    if let Some(reply) = reply_to { message["replyTo"] = json!(reply); }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis()).unwrap_or(0);
    let temporary = inbox.join(format!("{id}.tmp"));
    let target = inbox.join(format!("{stamp:020}-{id}.json"));
    std::fs::write(&temporary, serde_json::to_vec(&message).unwrap()).map_err(error)?;
    std::fs::rename(&temporary, &target).map_err(error)?;
    Ok(1)
}

#[tauri::command]
async fn submit_prompt(app: tauri::AppHandle, state: State<'_, Shared>, id: String, prompt: String, route: Option<String>) -> Result<String, String> {
    if prompt.trim().is_empty() { return Err("Enter a prompt".into()); }
    let route = route.unwrap_or_else(|| "delegate".into());
    if !["delegate", "master-only", "master-review"].contains(&route.as_str()) { return Err("Unknown task route".into()); }
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    let root = relay::state_for(&project)?;
    if id == "master" {
        let intent = match route.as_str() {
            "master-only" => "[Routing intent: Master-only] Handle this task in the Hermes master. Do not delegate to a worker.",
            "master-review" => "[Routing intent: Needs master review] Review the supplied work or problem in the Hermes master. Verify evidence before accepting conclusions; provide high-level reasoning and findings.",
            _ => return Err("Choose an explicit master route for the Hermes master".into()),
        };
        let receipt = relay::submit(&project, "app-composer", &format!("{intent}\n\n{prompt}"))?;
        return Ok(receipt.to_string());
    }
    if route != "delegate" { return Err("Master routes must target the Hermes master".into()); }
    if !id.starts_with("hermes-") { return Err("Choose a Hermes worker".into()); }
    let number = id.strip_prefix("hermes-").unwrap();
    if !number.bytes().all(|b| b.is_ascii_digit()) || number.is_empty() { return Err("Choose a Hermes worker".into()); }
    let _ = &app;
    squad_inbox(&root, &id, "user", &format!("[Routing intent: Delegate to Hermes]\n{prompt}"), None)?;
    Ok(id.to_string())
}
#[tauri::command]
fn master_brief(app: tauri::AppHandle, state: State<Shared>) -> Result<String, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    let _ = &app;
    let mut context = String::new();
    for file in ["agent.md", "context.md", "todo.md"] {
        if let Ok(text) = std::fs::read_to_string(Path::new(&project).join(".squad").join("master").join(file)) {
            if !text.trim().is_empty() { context.push_str(&format!("### {file}\n{}\n\n", text.trim())); }
        }
    }
    Ok(format!("{context}\nYou are the Hermes quad squad master for {project}. Plan by writing the shared board with squad_board, then work as a peer. Reserve files with squad_claims before edits and verify results. Do not launch duplicate workers or change their configured model. Wait for a scoped user task."))
}
#[tauri::command]
fn login_hermes(app: tauri::AppHandle, state: State<Shared>) -> Result<Descriptor, String> {
    // `hermes model` is the interactive provider/model picker, including OAuth
    // sign-in flows; it is the one place login actually happens.
    let mut cmd = CommandBuilder::new("hermes");
    cmd.arg("model");
    spawn_terminal(&app, &state, "auth".into(), "Hermes · model & sign in".into(), cmd)
}
#[tauri::command]
fn workspace_status(app: tauri::AppHandle, state: State<Shared>) -> Result<String, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    let _ = &app;
    let root = relay::state_for(&project)?;
    let config = read_config(&root);
    let registry = root.join("squad").join("registry");
    let mut out = serde_json::Map::new();
    for number in config["workers"].as_object().map(|w| w.keys()).into_iter().flatten() {
        let record = std::fs::read(registry.join(format!("hermes-{number}.json"))).ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        let status = match record {
            Some(r) if relay::alive(r["pid"].as_u64().unwrap_or(0) as u32) =>
                r["activity"]["currentActivity"].as_str().unwrap_or("idle").to_string(),
            _ => "stopped".to_string(),
        };
        out.insert(number.clone(), json!({"status": status}));
    }
    serde_json::to_string(&Value::Object(out)).map_err(error)
}
/// Providers and models offered by the pane pickers.
///
/// Written beside the executable on first run so it can be edited without a
/// rebuild. At most five providers are used; anything beyond that is ignored
/// rather than silently reshuffled.

fn model_config_path() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(error)?;
    Ok(exe.with_file_name("models.json"))
}

#[tauri::command]
fn model_menu(app: tauri::AppHandle, state: State<Shared>) -> Result<String, String> {
    // models.json beside the executable is an optional override. Without one the
    // menu is discovered from Hermes' own model catalog plus the configured
    // default, so it reflects what this machine actually runs.
    let path = model_config_path()?;
    if path.exists() {
        let text = std::fs::read_to_string(&path).map_err(error)?;
        match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(mut value) => {
                if let Some(list) = value["providers"].as_array_mut() { list.truncate(5); }
                value["path"] = serde_json::json!(path.to_string_lossy());
                value["source"] = serde_json::json!("models.json");
                return Ok(value.to_string());
            }
            Err(problem) => {
                // A broken override must not empty the menu, and must say why.
                let mut value: serde_json::Value = serde_json::from_str(&discover(&app, &state)?).map_err(error)?;
                value["path"] = serde_json::json!(path.to_string_lossy());
                value["error"] = serde_json::json!(format!("models.json is not valid JSON ({problem}); showing the installed catalog"));
                return Ok(value.to_string());
            }
        }
    }
    let mut value: serde_json::Value = serde_json::from_str(&discover(&app, &state)?).map_err(error)?;
    value["path"] = serde_json::json!(path.to_string_lossy());
    value["source"] = serde_json::json!("discovered");
    Ok(value.to_string())
}

/// Hermes' cached model catalog, merged with the user's configured model and
/// custom providers so the picker shows what is actually runnable here.
fn discover(app: &tauri::AppHandle, state: &State<Shared>) -> Result<String, String> {
    let _ = app;
    let mut providers: Vec<Value> = vec![];
    let mut seen: Vec<String> = vec![];
    let push_provider = |slug: &str, label: &str, models: Vec<String>, providers: &mut Vec<Value>, seen: &mut Vec<String>| {
        if slug.is_empty() || seen.iter().any(|s| s == slug) || models.is_empty() { return; }
        seen.push(slug.to_string());
        let mut rows: Vec<Value> = models.into_iter().filter(|m| valid_model(m)).map(|m| json!({"id": m, "label": m})).collect();
        rows.truncate(60);
        providers.push(json!({"id": slug, "label": label, "models": rows}));
    };
    // 1. Hermes' curated catalog cache.
    if let Ok(text) = std::fs::read_to_string(hermes_home().join("cache").join("model_catalog.json")) {
        if let Ok(catalog) = serde_json::from_str::<Value>(&text) {
            if let Some(list) = catalog["providers"].as_object() {
                for (slug, entry) in list {
                    let label = entry["metadata"]["display_name"].as_str().unwrap_or(slug.as_str());
                    let models = entry["models"].as_array().map(|rows| rows.iter()
                        .filter_map(|m| m["id"].as_str().map(str::to_string)).collect()).unwrap_or_default();
                    push_provider(slug, label, models, &mut providers, &mut seen);
                }
            }
        }
    }
    // 2. The configured default, aliases and custom provider models.
    let project = state.lock().map_err(error)?.project.clone();
    let mut configured: Vec<String> = vec![];
    if let Some(project) = project {
        if let Ok(text) = std::fs::read_to_string(hermes_home().join("config.yaml")) {
            for line in text.lines() {
                if let Some(rest) = line.strip_prefix("  default: ") {
                    let model = rest.trim().trim_matches('"').trim_matches('\'');
                    if valid_model(model) { configured.push(model.to_string()); }
                }
                if let Some(rest) = line.strip_prefix("    ") {
                    // provider model lists ("      - model-id") and alias maps.
                    let trimmed = rest.trim();
                    if let Some(model) = trimmed.strip_prefix("- ") {
                        let model = model.trim().trim_matches('"').trim_matches('\'');
                        if valid_model(model) { configured.push(model.to_string()); }
                    } else if let Some((_, model)) = trimmed.split_once(": ") {
                        let model = model.trim().trim_matches('"').trim_matches('\'');
                        if valid_model(model) { configured.push(model.to_string()); }
                    }
                }
            }
        }
        if let Ok(root) = relay::state_for(&project) {
            if let Some(model) = read_config(&root)["default_model"].as_str().filter(|m| valid_model(m)) {
                configured.push(model.to_string());
            }
        }
    }
    configured.reverse();  // newest first, then dedup keeping the first seen
    let configured: Vec<String> = configured.into_iter()
        .fold(Vec::new(), |mut acc: Vec<String>, m| {
            if !acc.contains(&m) { acc.push(m); }
            acc
        })
        .into_iter().take(30).collect();
    if !configured.is_empty() {
        providers.insert(0, json!({"id": "configured", "label": "Configured here",
            "models": configured.into_iter().map(|m| json!({"id": m, "label": m})).collect::<Vec<_>>()}));
    }
    providers.truncate(5);
    serde_json::to_string(&json!({"providers": providers})).map_err(error)
}

#[tauri::command]
fn remember_pane_model(app: tauri::AppHandle, state: State<Shared>, id: String, model: String) -> Result<(), String> {
    // Hermes has no scriptable mid-session model switch, but /model in the pane
    // changes it for the session and a --model relaunch makes it permanent.
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    if !valid_model(&model) { return Err("Invalid model".into()); }
    let root = relay::state_for(&project)?;
    let _ = &app;
    let mut config = read_config(&root);
    if !config["agent_models"].is_object() { config["agent_models"] = json!({}); }
    config["agent_models"][&id] = json!(model);
    if id == "master" && config["default_model"].as_str().map_or(true, |m| m.is_empty()) {
        config["default_model"] = json!(model);
    }
    write_config(&root, &config)
}
#[tauri::command]
fn notify_agents(state: State<Shared>, text: String, to: Option<String>) -> Result<usize, String> {
    if text.trim().is_empty() { return Err("Message is empty".into()); }
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    let root = relay::state_for(&project)?;
    let registry = root.join("squad/registry");
    let mut sent = 0usize;
    // Written in the same shape the agents' own messenger uses, so a change of
    // project or repository reaches them the way a peer message would.
    for entry in std::fs::read_dir(&registry).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().trim_end_matches(".json").to_string();
        if name.is_empty() || !entry.file_name().to_string_lossy().ends_with(".json") { continue; }
        if to.as_deref().is_some_and(|only| only != name) { continue; }
        sent += squad_inbox(&root, &name, "user", &text, None).unwrap_or(0);
    }
    Ok(sent)
}
fn uuid() -> String {
    // Enough entropy for a filename; identity comes from the registry, not this.
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos()).unwrap_or(0);
    format!("{now:x}{:x}", std::process::id())
}
#[tauri::command]
fn current_repo(app: tauri::AppHandle, state: State<Shared>) -> Result<String, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    let _ = &app;
    let root = relay::state_for(&project)?;
    let config = read_config(&root);
    let stored = config["github_repo"].as_str().unwrap_or("").to_string();
    let repo = if stored.is_empty() { git_origin(&project).unwrap_or_default() } else { stored };
    Ok(json!({"github_repo": repo}).to_string())
}
/// Whatever this folder's git origin points at, as owner/name.
fn git_origin(project: &str) -> Option<String> {
    let output = Command::new("git").args(["-C", project, "remote", "get-url", "origin"]).output().ok()?;
    if !output.status.success() { return None; }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let cleaned = url.trim_end_matches(".git").rsplit('/').take(2).collect::<Vec<_>>();
    if cleaned.len() == 2 && cleaned[1].contains(':') {
        // scp-style git@host:owner/name
        let owner = cleaned[1].split(':').last().unwrap_or("");
        return Some(format!("{owner}/{}", cleaned[0]));
    }
    if cleaned.len() == 2 && !cleaned[1].is_empty() { return Some(format!("{}/{}", cleaned[1], cleaned[0])); }
    None
}
#[tauri::command]
fn set_repo(app: tauri::AppHandle, state: State<Shared>, repo: String) -> Result<String, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    let root = relay::state_for(&project)?;
    let _ = &app;
    let mut config = read_config(&root);
    let cleaned = repo.trim().trim_end_matches(".git").to_string();
    if !cleaned.is_empty() && !cleaned.contains('/') && !cleaned.contains("://") && !cleaned.contains('@') {
        return Err("Use owner/name or a full git URL".into());
    }
    config["github_repo"] = json!(cleaned);
    write_config(&root, &config)?;
    Ok(json!({"github_repo": cleaned}).to_string())
}
#[tauri::command]
fn list_models(app: tauri::AppHandle, state: State<Shared>) -> Result<String, String> {
    discover(&app, &state)
}
#[tauri::command]
fn current_model(app: tauri::AppHandle, state: State<Shared>) -> Result<String, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    let _ = &app;
    let root = relay::state_for(&project)?;
    Ok(json!({"model": read_config(&root)["default_model"].as_str().unwrap_or("")}).to_string())
}
#[tauri::command]
fn set_model(app: tauri::AppHandle, state: State<Shared>, model: String) -> Result<(), String> {
    if !valid_model(&model) { return Err("Invalid model (use provider/model)".into()); }
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    let root = relay::state_for(&project)?;
    let _ = &app;
    let mut config = read_config(&root);
    config["default_model"] = json!(model);
    write_config(&root, &config)
}
#[tauri::command]
fn relay_status(_app: tauri::AppHandle, state: State<Shared>) -> Result<serde_json::Value, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    let root = relay::state_for(&project)?;
    let runtime = std::fs::read(root.join("master-runtime.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let registered = runtime.as_ref().is_some_and(|r| r["ready"] == true &&
        r["app_pid"].as_u64() == Some(std::process::id() as u64) &&
        r["pid"].as_u64().is_some_and(|pid| relay::alive(pid as u32)));
    let busy = runtime.as_ref().is_some_and(|r| r["busy"] == true);
    Ok(serde_json::json!({"registered":registered,"busy":busy,"thread":runtime.as_ref().map(|r| &r["sessionId"]),
        "message":if registered {"Master relay ready"} else {"Waiting for the master to register"}}))
}
#[tauri::command]
fn close_workspace(_app: tauri::AppHandle, state: State<Shared>, force: Option<bool>) -> Result<(), String> {
    // Switching project is a deliberate replacement, so it closes regardless of
    // what the agents are doing.
    let force = force.unwrap_or(false);
    let project = state.lock().map_err(error)?.project.clone();
    if let Some(project) = project {
        let root = relay::state_for(&project)?;
        if !force {
            let registry = root.join("squad").join("registry");
            let busy: Vec<String> = std::fs::read_dir(&registry).into_iter().flatten().flatten()
                .filter_map(|entry| std::fs::read(entry.path()).ok())
                .filter_map(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .filter(|record| record["activity"]["currentActivity"] == "busy"
                    && relay::alive(record["pid"].as_u64().unwrap_or(0) as u32))
                .filter_map(|record| record["name"].as_str().map(str::to_string))
                .collect();
            if !busy.is_empty() {
                return Err(format!("{} still working. Let it finish, or close with force.", busy.join(", ")));
            }
        }
    }
    let mut workspace = state.lock().map_err(error)?;
    for term in workspace.terminals.values_mut() { let _ = term.child.kill(); }
    workspace.terminals.clear();
    workspace.master_lock = None;
    workspace.project = None;
    workspace.generation += 1;
    Ok(())
}
#[tauri::command]
fn shutdown(app: tauri::AppHandle, state: State<Shared>) -> Result<(), String> {
    close_workspace(app.clone(), state, Some(false))?;
    app.exit(0); Ok(())
}
#[tauri::command]
async fn team_overview(app: tauri::AppHandle, state: State<'_, Shared>) -> Result<String, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    let _ = &app;
    let root = relay::state_for(&project)?;
    let config = read_config(&root);
    let registry = root.join("squad").join("registry");
    let read_agent = |name: &str| std::fs::read(registry.join(format!("{name}.json"))).ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let mut agents = vec![];
    let runtime = std::fs::read(root.join("master-runtime.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let master_record = read_agent("master");
    let master_alive = master_record.as_ref().is_some_and(|r| relay::alive(r["pid"].as_u64().unwrap_or(0) as u32));
    agents.push(json!({
        "id": "master", "role": "Master: planning, review and integration",
        "status": if master_alive { master_record.as_ref().unwrap()["activity"]["currentActivity"].as_str().unwrap_or("idle") } else { "stopped" },
        "model": model_for(&config, "master").unwrap_or_default(),
        "ready": runtime.as_ref().is_some_and(|r| r["ready"] == true),
    }));
    let mut claim_counts: HashMap<String, usize> = HashMap::new();
    if let Ok(entries) = std::fs::read_dir(root.join("squad").join("reservations")) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().trim_end_matches(".json").to_string();
            if let Ok(text) = std::fs::read_to_string(entry.path()) {
                if let Ok(list) = serde_json::from_str::<Value>(&text) {
                    claim_counts.insert(name, list.as_array().map(|a| a.len()).unwrap_or(0));
                }
            }
        }
    }
    for (number, role) in config["workers"].as_object().into_iter().flatten() {
        let name = format!("hermes-{number}");
        let record = read_agent(&name);
        let alive = record.as_ref().is_some_and(|r| relay::alive(r["pid"].as_u64().unwrap_or(0) as u32));
        agents.push(json!({
            "id": name, "role": role.as_str().unwrap_or("Worker"),
            "status": if alive { record.as_ref().unwrap()["activity"]["currentActivity"].as_str().unwrap_or("idle") } else { "stopped" },
            "model": model_for(&config, &name).unwrap_or_default(),
            "claims": claim_counts.get(&name).copied().unwrap_or(0),
        }));
    }
    let board = std::fs::read_to_string(root.join("squad").join("board.json")).ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(json!({"slices": []}));
    let slices: Vec<Value> = board["slices"].as_array().cloned().unwrap_or_default().into_iter().map(|mut s| {
        let messages = s["messages"].as_array().map(|m| m.len()).unwrap_or(0);
        s["messageCount"] = json!(messages);
        s
    }).collect();
    Ok(serde_json::to_string(&json!({
        "agents": agents,
        "board": {"slices": slices},
        "usage": {"note": "Hermes records usage in its own session database, which this overview does not read."}
    })).map_err(error)?)
}
fn document_project(state: &State<Shared>, id: &str, filename: &str) -> Result<String, String> {
    if !["agent.md", "context.md", "todo.md"].contains(&filename) { return Err("Unknown instruction file".into()); }
    let ws = state.lock().map_err(error)?;
    if id == "auth" || !ws.terminals.contains_key(id) { return Err("Unknown agent terminal".into()); }
    ws.project.clone().ok_or("Start a workspace first".into())
}
#[tauri::command]
fn read_agent_document(app: tauri::AppHandle, state: State<Shared>, id: String, filename: String) -> Result<String, String> {
    let project = document_project(&state, &id, &filename)?;
    let _ = &app;
    std::fs::read_to_string(Path::new(&project).join(".squad").join(&id).join(&filename)).map_err(|_| "The document does not exist yet".to_string())
}
#[tauri::command]
async fn save_agent_document(app: tauri::AppHandle, state: State<'_, Shared>, id: String, filename: String, content: String, expected: String) -> Result<String, String> {
    let project = document_project(&state, &id, &filename)?;
    if content.len() > 128 * 1024 || expected.len() > 128 * 1024 { return Err("Document exceeds 128 KB".into()); }
    let _ = &app;
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&project).join(".squad").join(&id).join(&filename);
        let current = std::fs::read_to_string(&path).unwrap_or_default();
        // Compare-and-swap: a save must never silently overwrite another writer.
        if !expected.is_empty() && current != expected {
            return Err("The document changed on disk while you were editing. Reopen it and merge your edits.".into());
        }
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(error)?; }
        let temporary = path.with_extension("md.tmp");
        std::fs::write(&temporary, &content).map_err(error)?;
        std::fs::rename(&temporary, &path).map_err(error)?;
        Ok(content)
    }).await.map_err(error)?
}


#[tauri::command]
async fn read_feed(state: State<'_, Shared>, limit: Option<u32>) -> Result<String, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    let root = relay::state_for(&project)?;
    let feed_path = root.join("squad").join("feed.jsonl");
    let max = limit.unwrap_or(200).min(2000) as usize;
    if !feed_path.exists() { return Ok("[]".into()); }
    let content = std::fs::read_to_string(&feed_path).map_err(error)?;
    let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = if lines.len() > max { lines.len() - max } else { 0 };
    let events: Vec<serde_json::Value> = lines[start..].iter().filter_map(|l| serde_json::from_str(l).ok()).collect();
    serde_json::to_string(&events).map_err(error)
}
#[tauri::command]
async fn read_registry(state: State<'_, Shared>) -> Result<String, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    let root = relay::state_for(&project)?;
    let registry_dir = root.join("squad").join("registry");
    if !registry_dir.exists() { return Ok("[]".into()); }
    let mut agents: Vec<serde_json::Value> = Vec::new();
    for entry in std::fs::read_dir(&registry_dir).map_err(error)? {
        let entry = entry.map_err(error)?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(reg) = serde_json::from_str::<serde_json::Value>(&content) {
                let pid = reg["pid"].as_u64().unwrap_or(0) as u32;
                if relay::alive(pid) { agents.push(reg); }
            }
        }
    }
    serde_json::to_string(&agents).map_err(error)
}
mod relay;
fn main() {
    if relay::run_cli() { return; }
    tauri::Builder::default()
        .manage(Arc::new(Mutex::new(Workspace::default())) as Shared)
        .invoke_handler(tauri::generate_handler![launch_directory,list_directories,start_workspace,snapshot,add_agent,write_terminal,resize_terminal,submit_prompt,master_brief,login_hermes,workspace_status,list_models,current_model,set_model,current_repo,set_repo,notify_agents,remember_pane_model,model_menu,relay_status,team_overview,close_workspace,shutdown,read_agent_document,save_agent_document,read_feed,read_registry])
        .on_window_event(|window,event| { if let tauri::WindowEvent::CloseRequested{api,..} = event { api.prevent_close(); let _ = window.emit("close-request", ()); } })
        .run(tauri::generate_context!()).expect("Desktop runtime failed");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_pty_roundtrip() {
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.args(["/c", "echo PTY_READY"]);
        let mut child = pair.slave.spawn_command(native_shell(cmd)).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let shared_all = std::sync::Arc::new(Mutex::new(String::new()));
        let snapshot = shared_all.clone();
        let mut writer = pair.master.take_writer().unwrap();
        std::thread::spawn(move || {
            let mut all = String::new(); let mut buf = [0u8; 1024]; let mut replied = false;
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 { break; }
                all.push_str(&String::from_utf8_lossy(&buf[..n]));
                *snapshot.lock().unwrap() = all.clone();
                // The shell asks for its cursor position before printing a
                // prompt; it blocks until a reply arrives.
                if !replied && all.contains("\x1b[6n") {
                    let _ = writer.write_all(b"\x1b[1;1R");
                    let _ = writer.flush();
                    replied = true;
                }
                if all.contains("PTY_READY") { let _ = tx.send(all); break; }
            }
        });
        let result = rx.recv_timeout(std::time::Duration::from_secs(30));
        let _ = child.kill();
        let partial = shared_all.lock().unwrap().clone();
        let got = result.unwrap_or_else(|_| panic!("PTY produced no output. Partial so far: {partial:?}"));
        assert!(got.contains("PTY_READY"), "output was: {got}");
    }

    #[test]
    fn config_roundtrip_and_model_rules() {
        let temp = std::env::temp_dir().join(format!("hqs-config-{}", std::process::id()));
        std::fs::create_dir_all(&temp).unwrap();
        let config = default_config();
        write_config(&temp, &config).unwrap();
        assert_eq!(read_config(&temp)["workers"]["1"], "UI designer");
        assert!(valid_model("zai-coding-plan/glm-5.3"));
        assert!(valid_model("grok-4.6"));
        assert!(!valid_model(""));
        assert!(!valid_model("-injection"));
        assert!(!valid_model("two words"));
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn documents_seed_only_where_missing() {
        let temp = std::env::temp_dir().join(format!("hqs-docs-{}", std::process::id()));
        std::fs::create_dir_all(&temp).unwrap();
        seed_documents(temp.to_string_lossy().as_ref(), &default_config(), &temp);
        let master = temp.join(".squad").join("master").join("agent.md");
        assert!(master.exists());
        let custom = "# my own brief\n";
        std::fs::write(&master, custom).unwrap();
        seed_documents(temp.to_string_lossy().as_ref(), &default_config(), &temp);
        assert_eq!(std::fs::read_to_string(&master).unwrap(), custom);
        assert!(temp.join(".squad").join("hermes-2").join("context.md").exists());
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn documents_upgrade_unmodified_and_report_stale() {
        let temp = std::env::temp_dir().join(format!("hqs-docs-v-{0}", std::process::id()));
        std::fs::create_dir_all(&temp).unwrap();
        let config = default_config();
        // An ungenerated file adopts the current template with its marker.
        seed_documents(temp.to_string_lossy().as_ref(), &config, &temp);
        let master = temp.join(".squad").join("master").join("agent.md");
        let generated = std::fs::read_to_string(&master).unwrap();
        assert!(generated.starts_with("<!-- squad-template v"));
        // A marker-less copy of the pre-marker template upgrades in place.
        let bodies = document_bodies(&config);
        let body = bodies.iter().find(|(n, f, _)| n == "master" && f == "agent.md").unwrap().2.clone();
        std::fs::write(&master, &body).unwrap();
        seed_documents(temp.to_string_lossy().as_ref(), &config, &temp);
        assert_eq!(std::fs::read_to_string(&master).unwrap(), generated);
        // A user-edited marked file is left alone and noted on the feed.
        let edited = "<!-- squad-template v1 -->\n# my edits\n".to_string();
        std::fs::write(&master, &edited).unwrap();
        seed_documents(temp.to_string_lossy().as_ref(), &config, &temp);
        assert_eq!(std::fs::read_to_string(&master).unwrap(), edited);
        let feed = std::fs::read_to_string(temp.join("squad").join("feed.jsonl")).unwrap();
        assert!(feed.contains("doc.stale"));
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn inbox_message_shape_matches_plugin() {
        let temp = std::env::temp_dir().join(format!("hqs-inbox-{}", std::process::id()));
        std::fs::create_dir_all(&temp).unwrap();
        squad_inbox(&temp, "hermes-1", "user", "hello", None).unwrap();
        squad_inbox(&temp, "hermes-1", "user", "with reply", Some("req-1")).unwrap();
        let files: Vec<_> = std::fs::read_dir(temp.join("squad").join("inbox").join("hermes-1")).unwrap().flatten().collect();
        assert_eq!(files.len(), 2);
        for file in &files {
            let message: Value = serde_json::from_slice(&std::fs::read(file.path()).unwrap()).unwrap();
            assert_eq!(message["to"], "hermes-1");
            assert!(message["timestamp"].as_str().is_some());
        }
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn git_origin_parses_common_urls() {
        let temp = std::env::temp_dir().join(format!("hqs-git-{}", std::process::id()));
        let _ = std::process::Command::new("git").args(["init", temp.to_string_lossy().as_ref()]).output();
        let _ = std::process::Command::new("git").args(["-C", temp.to_string_lossy().as_ref(), "remote", "add", "origin", "https://github.com/acme/widgets.git"]).output();
        if temp.exists() {
            assert_eq!(git_origin(temp.to_string_lossy().as_ref()).as_deref(), Some("acme/widgets"));
            let _ = std::fs::remove_dir_all(temp);
        }
    }
}

