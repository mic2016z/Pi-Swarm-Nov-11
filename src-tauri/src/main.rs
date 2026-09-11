#![cfg_attr(windows, windows_subsystem = "windows")]

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{collections::HashMap, io::{Read, Write}, path::{Path, PathBuf}, process::Command, sync::{Arc, Mutex}};
use tauri::{Emitter, Manager, State};
#[cfg(windows)] use std::os::windows::process::CommandExt;

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
fn python_exe() -> &'static str { if cfg!(windows) { "python.exe" } else { "python3" } }
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

fn bridge(app: &tauri::AppHandle) -> PathBuf {
    let bundled = app.path().resource_dir().unwrap_or_default().join("bridge.py");
    if bundled.exists() { bundled } else { Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("bridge.py") }
}
fn python_command(app: &tauri::AppHandle, command: &str, project: &str, rest: &[String]) -> Result<String, String> {
    let mut cmd = Command::new(python_exe());
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.arg(bridge(app)).args([command, "--project", project]).args(rest);
    #[cfg(windows)] cmd.creation_flags(0x08000000);
    let out = cmd.output().map_err(error)?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().into()); }
    Ok(String::from_utf8_lossy(&out.stdout).trim().into())
}
fn spawn_terminal(app: &tauri::AppHandle, shared: &Shared, id: String, title: String, cmd: CommandBuilder) -> Result<Descriptor, String> {
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
/// Launch the master pane. Shared by workspace start and a model change, so the
/// two cannot drift apart in how the master is configured.
fn master_terminal(app: &tauri::AppHandle, shared: &Shared, project: &str) -> Result<Descriptor, String> {
    let root = relay::state_for(project)?;
    let master_root = root.join("oc-master");
    std::fs::create_dir_all(&master_root).map_err(error)?;
    let model = python_command(app, "current-model", project, &[])
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| v["model"].as_str().map(str::to_string))
        .filter(|v| !v.trim().is_empty() && !v.starts_with('-') && v.contains('/'))
        .ok_or("Bridge config has no valid default_model (use provider/model)")?;
    // OpenCode installs as opencode.exe; there is no .cmd shim to call.
    let mut master = CommandBuilder::new("opencode");
    // --auto matches the workers: an unattended pane has nobody to answer a
    // permission prompt, so anything not explicitly denied is approved.
    master.args(["--model", &model, "--auto"]);
    // The plugin records the session id on first launch; resume it when present.
    if let Some(id) = std::fs::read(master_root.join("session.json")).ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v["sessionID"].as_str().map(str::to_string))
        // Session ids start with ses_; a message id here strands the pane in a shell.
        .filter(|v| v.starts_with("ses_"))
    { master.args(["--session", &id]); }
    master.env("SQUAD_AGENT", "master"); master.env("SQUAD_PROJECT", project);
    master.env("SQUAD_ROOT", &master_root); master.env("SQUAD_APP_PID", std::process::id().to_string());
    master.cwd(project);
    spawn_terminal(app, shared, "master".into(), "OpenCode · master".into(), master)
}

fn pi_terminal(app: &tauri::AppHandle, shared: &Shared, project: &str, number: u64) -> Result<Descriptor, String> {
    let mut cmd = CommandBuilder::new(python_exe());
    cmd.arg("-u"); cmd.arg(bridge(app)); cmd.args(["native-worker", "--project", project, "--agent", &number.to_string()]);
    cmd.cwd(project); cmd.env("PYTHONIOENCODING", "utf-8");
    spawn_terminal(app, shared, format!("oc-{number}"), format!("OpenCode {number}"), cmd)
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
    let cfg: serde_json::Value = serde_json::from_str(&python_command(&app, "init", &project, &[])?).map_err(error)?;
    let mut out = vec![];
    let root = relay::state_for(&project)?;
    if let Ok(bytes) = std::fs::read(root.join("master-runtime.json")) {
        if let Ok(runtime) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if runtime["pid"].as_u64().is_some_and(|pid| relay::alive(pid as u32)) {
                return Err("This project's Pi master is already running. Close that workspace before opening it again.".into());
            }
        }
    }
    let master_root = root.join("oc-master");
    std::fs::create_dir_all(&master_root).map_err(error)?;
    let master_lock = std::fs::OpenOptions::new().read(true).write(true).create(true).open(master_root.join("owner.lock")).map_err(error)?;
    fs2::FileExt::try_lock_exclusive(&master_lock).map_err(|_| "This project's Pi master session already has an owner".to_string())?;
    state.lock().map_err(error)?.master_lock = Some(master_lock);
    match master_terminal(&app, &state, &project) {
        Ok(desc) => out.push(desc),
        Err(e) => { let _ = app.emit("workspace-warning", format!("The master did not start: {e}")); }
    }
    for key in cfg["sessions"].as_object().ok_or("Invalid bridge config")?.keys() {
        let number = key.parse().map_err(error)?;
        match pi_terminal(&app, &state, &project, number) {
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
    let number = python_command(&app, "add", &project, &[])?.parse().map_err(error)?;
    pi_terminal(&app, &state, &project, number)
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
#[tauri::command]
async fn submit_prompt(app: tauri::AppHandle, state: State<'_, Shared>, id: String, prompt: String, route: Option<String>) -> Result<String, String> {
    if prompt.trim().is_empty() { return Err("Enter a prompt".into()); }
    let route = route.unwrap_or_else(|| "delegate".into());
    if !["delegate", "master-only", "master-review"].contains(&route.as_str()) { return Err("Unknown task route".into()); }
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    tauri::async_runtime::spawn_blocking(move || {
    if id == "master" {
        let intent = match route.as_str() {
            "master-only" => "[Routing intent: Master-only] Handle this task in the Pi master. Do not delegate to a worker.",
            "master-review" => "[Routing intent: Needs master review] Review the supplied work or problem in the Pi master. Verify evidence before accepting conclusions; provide high-level reasoning and findings.",
            _ => return Err("Choose an explicit master route for the Pi master".into()),
        };
        let receipt = relay::submit(&project, "app-composer", &format!("{intent}\n\n{prompt}"))?;
        return Ok(receipt.to_string());
    }
    if route != "delegate" { return Err("Master routes must target the Pi master".into()); }
    let number: u64 = id.strip_prefix("pi-").ok_or("Choose a Pi worker")?.parse().map_err(error)?;
    // Python receives structured argv; prompts are never interpolated into shell code.
    python_command(&app, "submit", &project, &["--agent".into(), number.to_string(), "--prompt".into(), format!("[Routing intent: Delegate to Pi]\n{prompt}")])
    }).await.map_err(error)?
}
#[tauri::command]
fn master_brief(app: tauri::AppHandle, state: State<Shared>) -> Result<String, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    let context = python_command(&app, "document-context", &project, &["--terminal".into(), "master".into()])?;
    Ok(format!("{context}\n\nYou are the OpenCode Squads master for {project}. Coordinate the existing workers with squad_message, reserve files with squad_claims before edits, and verify results. Do not launch duplicate workers or change their configured model. Wait for a scoped user task."))
}
#[tauri::command]
fn login_pi(app: tauri::AppHandle, state: State<Shared>) -> Result<Descriptor, String> {
    let cmd = CommandBuilder::new("opencode");
    spawn_terminal(&app, &state, "auth".into(), "Pi · use /login".into(), cmd)
}
#[tauri::command]
fn workspace_status(app: tauri::AppHandle, state: State<Shared>) -> Result<String, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    python_command(&app, "status", &project, &[])
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
    // menu is discovered live, so it reflects the subscriptions this machine
    // actually has rather than a list baked in at build time.
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

fn discover(app: &tauri::AppHandle, state: &State<Shared>) -> Result<String, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    python_command(app, "discover-models", &project, &[])
}

#[tauri::command]
fn remember_pane_model(app: tauri::AppHandle, state: State<Shared>, id: String, model: String) -> Result<(), String> {
    // OpenCode has no scriptable mid-session model switch: /model only opens a
    // dialog. Restarting the pane with a new --model does change it for good,
    // and --session resumes the same conversation, so nothing is lost.
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    if id == "master" {
        // The master has no per-agent slot: it launches on the project default.
        python_command(&app, "configure-model", &project, &["--model".into(), model])?;
    } else {
        let number = id.strip_prefix("oc-").ok_or("Unknown pane")?.to_string();
        python_command(&app, "set-agent-model", &project, &["--agent".into(), number, "--model".into(), model])?;
    }

    Ok(())
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
        let inbox = root.join("squad/inbox").join(&name);
        if std::fs::create_dir_all(&inbox).is_err() { continue; }
        let id = uuid();
        let message = serde_json::json!({"id": id, "from": "user", "to": name,
            "text": text, "timestamp": chrono::Utc::now().to_rfc3339()});
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis()).unwrap_or(0);
        let temporary = inbox.join(format!("{id}.tmp"));
        let target = inbox.join(format!("{stamp:020}-{id}.json"));
        if std::fs::write(&temporary, serde_json::to_vec(&message).unwrap()).is_ok()
            && std::fs::rename(&temporary, &target).is_ok() { sent += 1; }
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
    python_command(&app, "current-repo", &project, &[])
}
#[tauri::command]
fn set_repo(app: tauri::AppHandle, state: State<Shared>, repo: String) -> Result<String, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    python_command(&app, "set-repo", &project, &["--repo".into(), repo])
}
#[tauri::command]
fn list_models(app: tauri::AppHandle, state: State<Shared>) -> Result<String, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    python_command(&app, "list-models", &project, &[])
}
#[tauri::command]
fn current_model(app: tauri::AppHandle, state: State<Shared>) -> Result<String, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    python_command(&app, "current-model", &project, &[])
}
#[tauri::command]
fn set_model(app: tauri::AppHandle, state: State<Shared>, model: String) -> Result<String, String> {
    let project = state.lock().map_err(error)?.project.clone().ok_or("Start a workspace")?;
    python_command(&app, "configure-model", &project, &["--model".into(), model])
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
fn close_workspace(app: tauri::AppHandle, state: State<Shared>, force: Option<bool>) -> Result<(), String> {
    // Switching project is a deliberate replacement, so it closes regardless of
    // what the agents are doing. Without this the switch aborted here and left
    // the old squad, path and repository in place, looking as if nothing happened.
    let force = force.unwrap_or(false);
    let project = state.lock().map_err(error)?.project.clone();
    if let Some(project) = project {
        let master_status = relay::state_for(&project)?.join("oc-master/worker.json");
        if !force {
            if let Ok(bytes) = std::fs::read(master_status) {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    if value["status"] == "busy" && value["pid"].as_u64().is_some_and(|p| relay::alive(p as u32)) {
                        return Err("The master is still working. Finish or abort its task before closing.".into());
                    }
                }
            }
        }
        let status: serde_json::Value = serde_json::from_str(&python_command(&app, "status", &project, &[])?).map_err(error)?;
        if !force && status.as_object().is_some_and(|m| m.values().any(|v| v["status"] == "busy")) { return Err("An agent is still working. Let it finish, or abort the task in its terminal.".into()); }
        for id in status.as_object().ok_or("Invalid status")?.keys() { python_command(&app, "stop", &project, &["--agent".into(), id.clone()])?; }
    }
    // Native Pi exits back to its shell; wait for its ownership lock before closing shells.
    if let Some(project) = state.lock().map_err(error)?.project.clone() {
        let mut stopped = false;
        for _ in 0..20 {
            let status: serde_json::Value = serde_json::from_str(&python_command(&app, "status", &project, &[])?).map_err(error)?;
            stopped = status.as_object().is_some_and(|items| items.values().all(|v| v["status"] == "stopped" || v["status"] == "not started"));
            if stopped { break; }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        // A forced close kills the panes below regardless, so refusing here would
        // only strand the switch with the old squad still on screen.
        if !stopped && !force { return Err("An agent is still running. Finish or abort its task and close again.".into()); }
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
    let script = bridge(&app).with_file_name("team.py");
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(python_exe());
        command.arg(script).args(["overview", "--project", &project]);
        command.env("PYTHONIOENCODING", "utf-8");
        #[cfg(windows)] command.creation_flags(0x08000000);
        let output = command.output().map_err(error)?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().into()); }
        Ok(String::from_utf8_lossy(&output.stdout).trim().into())
    }).await.map_err(error)?
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
    python_command(&app, "document-read", &project, &["--terminal".into(), id, "--filename".into(), filename])
}
#[tauri::command]
async fn save_agent_document(app: tauri::AppHandle, state: State<'_, Shared>, id: String, filename: String, content: String, expected: String) -> Result<String, String> {
    let project = document_project(&state, &id, &filename)?;
    if content.len() > 128 * 1024 || expected.len() > 128 * 1024 { return Err("Document exceeds 128 KB".into()); }
    let script = bridge(&app);
    tauri::async_runtime::spawn_blocking(move || {
    // JSON over stdin preserves Unicode/newlines and avoids Windows argv limits.
    let mut cmd = Command::new(python_exe());
    cmd.arg(script).args(["document-write", "--project", &project, "--terminal", &id, "--filename", &filename]);
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    #[cfg(windows)] cmd.creation_flags(0x08000000);
    let mut child = cmd.spawn().map_err(error)?;
    let payload = serde_json::to_vec(&serde_json::json!({"content":content,"expected":expected})).map_err(error)?;
    let written = child.stdin.take().ok_or("Missing input pipe")?.write_all(&payload);
    let out = child.wait_with_output().map_err(error)?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().into()); }
    written.map_err(error)?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().into())
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
        .invoke_handler(tauri::generate_handler![launch_directory,list_directories,start_workspace,snapshot,add_agent,write_terminal,resize_terminal,submit_prompt,master_brief,login_pi,workspace_status,list_models,current_model,set_model,current_repo,set_repo,notify_agents,remember_pane_model,model_menu,relay_status,team_overview,close_workspace,shutdown,read_agent_document,save_agent_document,read_feed,read_registry])
        .on_window_event(|window,event| { if let tauri::WindowEvent::CloseRequested{api,..} = event { api.prevent_close(); let _ = window.emit("close-request", ()); } })
        .run(tauri::generate_context!()).expect("Desktop runtime failed");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_pty_roundtrip() {
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new(python_exe());
        cmd.args(["-u", "-c", "import sys; assert sys.argv[1:] == [chr(68)+':'+chr(92)+'Coding'+chr(92)+'pi squad version 2', 'Read '+chr(34)+'a path with spaces'+chr(34), 'Unicode café', chr(39)+'quoted'+chr(39)]; print('PTY_READY', flush=True); value=input(); print('PTY_ECHO:'+value, flush=True)", r"D:\Coding\pi squad version 2", "Read \"a path with spaces\"", "Unicode café", "'quoted'"]);
        let mut child = pair.slave.spawn_command(native_shell(cmd)).unwrap();
        drop(pair.slave);
        let mut writer = pair.master.take_writer().unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut all = String::new(); let mut buf = [0u8; 1024]; let mut sent = false; let mut cursor = false;
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 { break; }
                all.push_str(&String::from_utf8_lossy(&buf[..n]));
                if !cursor && all.contains("\x1b[6n") { writer.write_all(b"\x1b[1;1R").unwrap(); writer.flush().unwrap(); cursor = true; }
                if !sent && all.contains("PTY_READY") { writer.write_all(b"bridge-check\r").unwrap(); writer.flush().unwrap(); sent = true; }
                if all.contains("PTY_ECHO:bridge-check") { let _ = tx.send(all); break; }
            }
        });
        let result = rx.recv_timeout(std::time::Duration::from_secs(15));
        let _ = child.kill();
        assert!(result.unwrap().contains("PTY_READY"));
    }
}





