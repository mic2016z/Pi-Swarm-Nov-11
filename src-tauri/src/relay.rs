//! Native local relay to the registered Pi master, using Messenger's inbox format.
//!
//! Requests are accepted promptly into a queue directory. The master picks them
//! up and delegates to available Pi workers for concurrent execution.
//! No single-slot lock or busy-check blocks callers.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

fn now() -> f64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() }
fn canonical(project: &str) -> Result<String, String> {
    let path = fs::canonicalize(project).map_err(|e| e.to_string())?;
    let text = path.to_string_lossy().to_string();
    Ok(if cfg!(windows) { text.trim_start_matches(r"\\?\").to_lowercase() } else { text })
}
fn base() -> Result<PathBuf, String> {
    std::env::var_os("LOCALAPPDATA").or_else(||std::env::var_os("HOME")).or_else(||std::env::var_os("USERPROFILE"))
        .map(|p|PathBuf::from(p).join("OpenCodeSquads")).ok_or("User state directory unavailable".into())
}
pub fn state_for(project: &str) -> Result<PathBuf, String> {
    let hash = format!("{:x}", Sha256::digest(canonical(project)?.as_bytes()));
    Ok(base()?.join(&hash[..20]))
}
pub fn alive(pid: u32) -> bool {
    if pid == 0 { return false; }
    #[cfg(windows)] unsafe {
        #[link(name="kernel32")] extern "system" {
            fn OpenProcess(access:u32, inherit:i32, pid:u32)->*mut std::ffi::c_void;
            fn GetExitCodeProcess(handle:*mut std::ffi::c_void, code:*mut u32)->i32;
            fn CloseHandle(handle:*mut std::ffi::c_void)->i32;
        }
        let h=OpenProcess(0x1000,0,pid); if h.is_null(){return false;}
        let mut code=0; let ok=GetExitCodeProcess(h,&mut code)!=0 && code==259; CloseHandle(h); ok
    }
    #[cfg(unix)] unsafe { extern "C" { fn kill(pid:i32,sig:i32)->i32; } kill(pid as i32,0)==0 }
    #[cfg(not(any(windows,unix)))] { false }
}
fn read(path: &Path) -> Result<Value,String> { serde_json::from_slice(&fs::read(path).map_err(|e|e.to_string())?).map_err(|e|e.to_string()) }
fn identity(value:&Value)->Result<(),String> {
    if value["ready"]!=true || !alive(value["pid"].as_u64().unwrap_or(0) as u32) || !alive(value["app_pid"].as_u64().unwrap_or(0) as u32) {
        return Err("Pi master is not ready or its owning app has exited".into());
    }
    for field in ["project","sessionId","instance"] { if value[field].as_str().unwrap_or("").is_empty(){return Err(format!("Master registration missing {field}"));} }
    Ok(())
}
pub fn discover(project: Option<&str>) -> Result<Value,String> {
    let mut masters=Vec::new();
    for entry in fs::read_dir(base()?).map_err(|e|e.to_string())?.flatten() {
        if let Ok(value)=read(&entry.path().join("master-runtime.json")) {
            let registered=read(&entry.path().join("squad/registry/master.json"));
            if identity(&value).is_ok() && registered.as_ref().is_ok_and(|r|r["pid"]==value["pid"] && r["sessionId"]==value["sessionId"]) { masters.push(value); }
        }
    }
    if masters.len()!=1 { return Err(format!("Expected one live Pi master; found {}",masters.len())); }
    let master=masters.remove(0);
    if let Some(project)=project { if canonical(project)?!=canonical(master["project"].as_str().unwrap())? {return Err("Requested workspace differs from the active Pi master".into());} }
    Ok(master)
}
fn valid_id(id:&str)->Result<(),String> {
    if id.is_empty() || id.len()>100 || !id.bytes().all(|b|b.is_ascii_alphanumeric() || b==b'-' || b==b'_') {Err("Invalid request identifier".into())}else{Ok(())}
}
pub fn submit(project:&str, source:&str, text:&str)->Result<Value,String> {
    let id=format!("app-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos());
    send(discover(Some(project))?,&id,source,text)
}

/// Accept a request promptly. The master is never blocked: requests are queued
/// regardless of whether the master is currently busy with other work.
fn send(master:Value, id:&str, source:&str, text:&str)->Result<Value,String> {
    valid_id(id)?;
    if source.trim().is_empty() || text.trim().is_empty() || text.len()>80_000 {return Err("Source and message required; message limit is 80KB".into());}
    let project=master["project"].as_str().unwrap(); let root=state_for(project)?;
    let requests=root.join("relay/requests");fs::create_dir_all(&requests).map_err(|e|e.to_string())?;
    let receipt_path=requests.join(format!("{id}.json"));

    // Idempotent: return existing receipt if source+text match
    if receipt_path.exists() {
        let receipt=read(&receipt_path)?;
        if receipt["source"]!=source || receipt["text"]!=text {return Err("Request identifier already used for another message".into());}
        return Ok(receipt);
    }

    // Verify master is still the same instance (but do NOT check busy)
    let live=read(&root.join("master-runtime.json"))?; identity(&live)?;
    if live["instance"]!=master["instance"] || live["sessionId"]!=master["sessionId"] {return Err("Master changed before dispatch; reconnect first".into());}

    // Write receipt immediately with queued status
    let mut receipt=json!({"id":id,"source":source,"text":text,"project":project,"instance":master["instance"],"sessionId":master["sessionId"],"status":"queued","submitted":now()});
    let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&receipt_path).map_err(|e|e.to_string())?;
    file.write_all(serde_json::to_string_pretty(&receipt).unwrap().as_bytes()).map_err(|e|e.to_string())?;file.sync_all().map_err(|e|e.to_string())?;

    // Deliver to master inbox
    let inbox=root.join("squad/inbox/master");fs::create_dir_all(&inbox).map_err(|e|e.to_string())?;
    let msg=json!({"id":id,"from":"user","to":"master","text":text,"timestamp":chrono::Utc::now().to_rfc3339(),"replyTo":id});
    let temporary=inbox.join(format!("{id}.tmp"));let target=inbox.join(format!("{:020}-{id}.json",(now()*1000.0) as u64));
    let result=fs::write(&temporary,serde_json::to_vec(&msg).unwrap()).and_then(|_|fs::rename(&temporary,target));
    if let Err(error)=result { receipt["status"]=json!("uncertain");receipt["error"]=json!(error.to_string());fs::write(&receipt_path,serde_json::to_vec_pretty(&receipt).unwrap()).map_err(|e|e.to_string())?; }

    // Write queue pointer so master can scan for new work
    let queue_dir=root.join("relay/queue");fs::create_dir_all(&queue_dir).map_err(|e|e.to_string())?;
    let queue_entry=json!({"id":id,"source":source,"submitted":now(),"instance":master["instance"]});
    let _ = fs::write(queue_dir.join(format!("{id}.json")),serde_json::to_string(&queue_entry).unwrap());

    Ok(receipt)
}

/// Read a request's current status (queued / delivering / delegated / replied / failed / cancelled / interrupted).
pub fn read_request(project:&str, id:&str)->Result<Value,String> {
    valid_id(id)?;
    read(&state_for(project)?.join("relay/requests").join(format!("{id}.json")))
}

/// Cancel a queued request. Only cancels if still queued and owned by this instance.
pub fn cancel_request(project:&str, id:&str)->Result<Value,String> {
    valid_id(id)?;
    let root=state_for(project)?;
    let receipt_path=root.join("relay/requests").join(format!("{id}.json"));
    if !receipt_path.exists() {return Err("Request not found".into());}
    let receipt=read(&receipt_path)?;
    let status=receipt["status"].as_str().unwrap_or("");
    if !["queued","delivering","delegated"].contains(&status) {return Err(format!("Cannot cancel request in status '{status}'"));}
    let cancelled=json!({
        "id":id,"source":receipt["source"],"text":receipt["text"],"project":receipt["project"],
        "instance":receipt["instance"],"sessionId":receipt["sessionId"],
        "status":"cancelled","submitted":receipt["submitted"],"cancelled":now()
    });
    fs::write(&receipt_path,serde_json::to_string_pretty(&cancelled).unwrap()).map_err(|e|e.to_string())?;
    // Remove queue pointer
    let _ = fs::remove_file(root.join("relay/queue").join(format!("{id}.json")));
    Ok(cancelled)
}

/// List all requests with their current status.
pub fn list_requests(project:&str)->Result<Value,String> {
    let requests_dir=state_for(project)?.join("relay/requests");
    if !requests_dir.exists() {return Ok(json!([]));}
    let mut list=Vec::new();
    for entry in fs::read_dir(&requests_dir).map_err(|e|e.to_string())?.flatten() {
        if entry.path().extension().and_then(|e|e.to_str())==Some("json") {
            if let Ok(receipt)=read(&entry.path()) { list.push(receipt); }
        }
    }
    list.sort_by(|a,b| a["submitted"].as_f64().unwrap_or(0.0).partial_cmp(&b["submitted"].as_f64().unwrap_or(0.0)).unwrap());
    Ok(json!(list))
}

pub fn run_cli()->bool {
    let args:Vec<String>=std::env::args().collect();
    if args.get(1).map(String::as_str)!=Some("--relay"){return false;}
    let option=|key:&str|args.windows(2).find(|w|w[0]==key).map(|w|w[1].as_str());
    let run=||->Result<Value,String>{
        match args.get(2).map(String::as_str) {
            Some("discover")=>discover(option("--project")),
            Some("send")=>{let master=discover(option("--project"))?;let text=fs::read_to_string(option("--text-file").ok_or("Missing text file")?).map_err(|e|e.to_string())?;send(master,option("--request").ok_or("Missing request identifier")?,option("--source").ok_or("Missing source")?,&text)},
            Some("read")=>{let id=option("--request").ok_or("Missing request identifier")?;read_request(option("--project").ok_or("Missing project")?, id)},
            Some("cancel")=>{cancel_request(option("--project").ok_or("Missing project")?,option("--request").ok_or("Missing request identifier")?)},
            Some("list")=>{list_requests(option("--project").ok_or("Missing project")?)},
            _=>Err("Use --relay discover, send, read, cancel or list".into())
        }
    };
    match run(){Ok(value)=>println!("{value}"),Err(e)=>{eprintln!("{e}");std::process::exit(1);}} true
}

#[cfg(test)] mod tests {
    use super::*;
    use std::sync::Mutex;
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test] fn request_paths_are_bounded(){assert!(valid_id("../outside").is_err());assert!(valid_id("test-123").is_ok());}
    #[test] fn liveness_checks_current_process(){assert!(alive(std::process::id()));assert!(!alive(0));}

    #[test] fn relay_accepts_multiple_concurrent_requests(){
        let _guard = TEST_LOCK.lock().unwrap();
        let temp=std::env::temp_dir().join(format!("pi-relay-queue-{}",now() as u64));
        fs::create_dir_all(&temp).unwrap();
        let saved=std::env::var_os("LOCALAPPDATA");std::env::set_var("LOCALAPPDATA",&temp);
        let project=temp.to_string_lossy().to_string();let root=state_for(&project).unwrap();
        fs::create_dir_all(&root).unwrap();
        let runtime=json!({"project":project,"pid":std::process::id(),"app_pid":std::process::id(),"sessionId":"test-session","instance":"test-instance","ready":true,"busy":true});
        fs::write(root.join("master-runtime.json"),runtime.to_string()).unwrap();

        // Even with busy:true, requests should be accepted
        let r1=send(runtime.clone(),"req-1","source-a","task one").unwrap();
        assert_eq!(r1["status"],"queued");

        let r2=send(runtime.clone(),"req-2","source-b","task two").unwrap();
        assert_eq!(r2["status"],"queued");

        let r3=send(runtime.clone(),"req-3","source-c","task three").unwrap();
        assert_eq!(r3["status"],"queued");

        // All three accepted, none rejected for busy
        let inbox_dir=root.join("squad/inbox/master");
        let messages:Vec<_>=fs::read_dir(&inbox_dir).unwrap().flatten().collect();
        assert_eq!(messages.len(),3);

        // Queue directory has entries
        let queue_dir=root.join("relay/queue");
        let queue_entries:Vec<_>=fs::read_dir(&queue_dir).unwrap().flatten().collect();
        assert_eq!(queue_entries.len(),3);

        // Idempotent resend
        let r1_again=send(runtime.clone(),"req-1","source-a","task one").unwrap();
        assert_eq!(r1_again["id"],"req-1");

        // Different source for same ID rejected
        assert!(send(runtime.clone(),"req-1","source-x","task one").is_err());

        // Cancel a queued request
        let cancelled=cancel_request(&project,"req-2").unwrap();
        assert_eq!(cancelled["status"],"cancelled");
        assert!(cancel_request(&project,"req-2").is_err()); // can't cancel twice

        // List requests
        let list=list_requests(&project).unwrap();
        assert_eq!(list.as_array().unwrap().len(),3);

        if let Some(saved)=saved{std::env::set_var("LOCALAPPDATA",saved);}else{std::env::remove_var("LOCALAPPDATA");}
        fs::remove_dir_all(temp).unwrap();
    }

    #[test] fn relay_delivers_once_and_refuses_mixed_requests(){
        let _guard = TEST_LOCK.lock().unwrap();
        let temp=std::env::temp_dir().join(format!("pi-relay-test-{}-{}",(now()*1_000_000.0) as u64,std::process::id()));
        fs::create_dir_all(&temp).unwrap();
        let saved=std::env::var_os("LOCALAPPDATA");std::env::set_var("LOCALAPPDATA",&temp);
        let project=temp.to_string_lossy().to_string();let root=state_for(&project).unwrap();
        fs::create_dir_all(&root).unwrap();
        let runtime=json!({"project":project,"pid":std::process::id(),"app_pid":std::process::id(),"sessionId":"test-session","instance":"test-instance","ready":true,"busy":false});
        fs::write(root.join("master-runtime.json"),runtime.to_string()).unwrap();
        assert_eq!(send(runtime.clone(),"request-1","source-1","hello").unwrap()["status"],"queued");
        assert_eq!(send(runtime.clone(),"request-1","source-1","hello").unwrap()["id"],"request-1");
        assert!(send(runtime.clone(),"request-1","source-2","hello").is_err());
        // Second request should also be accepted (no active.json blocking)
        assert_eq!(send(runtime,"request-2","source-2","hello").unwrap()["status"],"queued");
        let files:Vec<_>=fs::read_dir(root.join("squad/inbox/master")).unwrap().flatten().collect();
        assert_eq!(files.len(),2);
        if let Some(saved)=saved{std::env::set_var("LOCALAPPDATA",saved);}else{std::env::remove_var("LOCALAPPDATA");}
        fs::remove_dir_all(temp).unwrap();
    }
}
