mod patch_dlc;

use patch_dlc::{
    get_patch_tool_status, import_patch_tool, inspect_patch_directory, run_patch_build,
};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const BACKEND_RELEASE_PREFIX: &str = "https://github.com/cxfcxf/nscb_rust/releases/download/";
const SUPPORTED_EXTENSIONS: [&str; 4] = ["nsp", "nsz", "xci", "xcz"];

fn nscb_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "nscb_rust.exe"
    } else if cfg!(target_os = "macos") {
        "nscb_rust-macos-arm64"
    } else {
        "nscb_rust-linux-amd64"
    }
}

fn app_tools_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve application data directory: {error}"))?;
    let tools = root.join("tools");
    std::fs::create_dir_all(&tools)
        .map_err(|error| format!("Failed to create tools directory: {error}"))?;
    Ok(tools)
}

fn nscb_exe_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app_tools_dir(app)?.join(nscb_binary_name());
    if !path.is_file() {
        return Err(format!(
            "{} not found at {}",
            nscb_binary_name(),
            path.display()
        ));
    }
    Ok(path)
}

fn running_pid() -> &'static Mutex<Option<u32>> {
    static PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();
    PID.get_or_init(|| Mutex::new(None))
}

fn cancellation_requested() -> &'static AtomicBool {
    static CANCELLED: AtomicBool = AtomicBool::new(false);
    &CANCELLED
}

#[derive(Serialize, Clone)]
struct StdoutEvent {
    op: String,
    line: String,
}

#[derive(Serialize, Clone)]
struct StderrEvent {
    op: String,
    chunk: String,
}

#[derive(Serialize, Clone)]
struct DoneEvent {
    op: String,
    code: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SwitchFileEntry {
    path: String,
    name: String,
    extension: String,
    size: u64,
    modified_ms: Option<u64>,
    kind: String,
    title_id: Option<String>,
    version: Option<u64>,
}

fn extract_title_id(name: &str) -> Option<String> {
    let upper = name.to_ascii_uppercase();
    let bytes = upper.as_bytes();
    if bytes.len() < 16 {
        return None;
    }
    let mut fallback = None;
    for start in 0..=bytes.len() - 16 {
        let candidate = &bytes[start..start + 16];
        if !candidate.iter().all(u8::is_ascii_hexdigit) {
            continue;
        }
        let left_is_hex = start > 0 && bytes[start - 1].is_ascii_hexdigit();
        let right_is_hex = start + 16 < bytes.len() && bytes[start + 16].is_ascii_hexdigit();
        if left_is_hex || right_is_hex {
            continue;
        }
        let value = String::from_utf8_lossy(candidate).to_string();
        if value.starts_with("0100") {
            return Some(value);
        }
        fallback.get_or_insert(value);
    }
    fallback
}

fn extract_version(name: &str) -> Option<u64> {
    let upper = name.to_ascii_uppercase();
    let bytes = upper.as_bytes();
    for start in 0..bytes.len().saturating_sub(2) {
        if bytes[start] != b'[' || bytes[start + 1] != b'V' {
            continue;
        }
        let digit_start = start + 2;
        let mut end = digit_start;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end > digit_start && end < bytes.len() && bytes[end] == b']' {
            return upper[digit_start..end].parse().ok();
        }
    }
    None
}

fn classify_content(name: &str, title_id: Option<&str>) -> String {
    if let Some(title_id) = title_id {
        if let Ok(suffix) = u16::from_str_radix(&title_id[title_id.len() - 3..], 16) {
            if suffix == 0 {
                return "base".to_string();
            }
            if suffix == 0x800 {
                return "update".to_string();
            }
            if (1..=0x7ff).contains(&suffix) {
                return "dlc".to_string();
            }
        }
    }

    let lower = name.to_ascii_lowercase();
    if lower.contains("[upd]") || lower.contains("update") || lower.contains("patch") {
        "update".to_string()
    } else if lower.contains("[dlc]") || lower.contains(" dlc") {
        "dlc".to_string()
    } else {
        "unknown".to_string()
    }
}

fn inspect_file(path: &Path) -> Option<SwitchFileEntry> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if !SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let name = path.file_name()?.to_string_lossy().into_owned();
    let title_id = extract_title_id(&name);
    let kind = classify_content(&name, title_id.as_deref());
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64);
    Some(SwitchFileEntry {
        path: path.to_string_lossy().into_owned(),
        name,
        extension,
        size: metadata.len(),
        modified_ms,
        kind,
        title_id,
        version: extract_version(path.file_name()?.to_string_lossy().as_ref()),
    })
}

fn collect_directory(root: &Path, recursive: bool, output: &mut Vec<SwitchFileEntry>) {
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if recursive {
                    pending.push(path);
                }
            } else if let Some(item) = inspect_file(&path) {
                output.push(item);
            }
        }
    }
}

#[tauri::command]
fn inspect_switch_paths(
    paths: Vec<String>,
    recursive: bool,
) -> Result<Vec<SwitchFileEntry>, String> {
    let mut result = Vec::new();
    for raw in paths {
        let path = PathBuf::from(raw);
        if path.is_dir() {
            collect_directory(&path, recursive, &mut result);
        } else if let Some(entry) = inspect_file(&path) {
            result.push(entry);
        }
    }
    result.sort_by_key(|left| left.path.to_lowercase());
    result.dedup_by(|left, right| left.path == right.path);
    Ok(result)
}

#[tauri::command]
fn import_keys(app: tauri::AppHandle, src_path: String) -> Result<(), String> {
    let source = PathBuf::from(src_path);
    if !source.is_file() {
        return Err("Selected keys file does not exist".to_string());
    }
    let tools = app_tools_dir(&app)?;
    std::fs::copy(source, tools.join("prod.keys"))
        .map_err(|error| format!("Failed to import prod.keys: {error}"))?;
    let _ = std::fs::remove_file(tools.join("keys.txt"));
    Ok(())
}

#[tauri::command]
fn remove_keys(app: tauri::AppHandle) -> Result<(), String> {
    let tools = app_tools_dir(&app)?;
    for name in ["prod.keys", "keys.txt"] {
        let path = tools.join(name);
        if path.exists() {
            std::fs::remove_file(path)
                .map_err(|error| format!("Failed to remove stored keys: {error}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn get_tools_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(app_tools_dir(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
fn has_keys(app: tauri::AppHandle) -> Result<bool, String> {
    let tools = app_tools_dir(&app)?;
    Ok(tools.join("prod.keys").is_file() || tools.join("keys.txt").is_file())
}

#[tauri::command]
fn has_backend(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(app_tools_dir(&app)?.join(nscb_binary_name()).is_file())
}

#[tauri::command]
fn import_nscb_binary(app: tauri::AppHandle, src_path: String) -> Result<(), String> {
    let source = PathBuf::from(src_path);
    if !source.is_file() {
        return Err("Selected backend file does not exist".to_string());
    }
    let filename = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !filename.starts_with("nscb_rust") {
        return Err("Select an nscb_rust backend binary".to_string());
    }
    let destination = app_tools_dir(&app)?.join(nscb_binary_name());
    std::fs::copy(source, &destination)
        .map_err(|error| format!("Failed to import backend: {error}"))?;
    make_executable(&destination);
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}

#[tauri::command]
fn download_backend(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with(BACKEND_RELEASE_PREFIX) {
        return Err(
            "Backend downloads are restricted to the official nscb_rust release repository"
                .to_string(),
        );
    }
    let tools = app_tools_dir(&app)?;
    let destination = tools.join(nscb_binary_name());
    let temporary = tools.join(format!("{}.download", nscb_binary_name()));
    let response =
        reqwest::blocking::get(url).map_err(|error| format!("Backend download failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Backend download returned HTTP {}",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .map_err(|error| format!("Failed to read backend response: {error}"))?;
    std::fs::write(&temporary, &bytes)
        .map_err(|error| format!("Failed to store backend: {error}"))?;
    make_executable(&temporary);
    std::fs::rename(&temporary, &destination)
        .map_err(|error| format!("Failed to activate backend: {error}"))?;
    Ok(())
}

#[tauri::command]
fn run_nscb(app: tauri::AppHandle, operation: String, args: Vec<String>) -> Result<(), String> {
    cancellation_requested().store(false, Ordering::SeqCst);
    let mut pid = running_pid()
        .lock()
        .map_err(|_| "Failed to lock backend state".to_string())?;
    if pid.is_some() {
        return Err("Another operation is already running".to_string());
    }

    let executable = nscb_exe_path(&app)?;
    let work_directory = app_tools_dir(&app)?;
    let mut command = Command::new(executable);
    command
        .args(args)
        .env("NSCB_FORCE_PROGRESS", "1")
        .current_dir(work_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start nscb_rust: {error}"))?;
    *pid = Some(child.id());
    drop(pid);

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture backend stdout")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture backend stderr")?;

    let stdout_app = app.clone();
    let stdout_operation = operation.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let value = line.trim();
                    if !value.is_empty() {
                        let _ = stdout_app.emit(
                            "nscb-stdout",
                            StdoutEvent {
                                op: stdout_operation.clone(),
                                line: value.to_string(),
                            },
                        );
                    }
                }
                Err(_) => break,
            }
        }
    });

    let stderr_app = app.clone();
    let stderr_operation = operation.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    let chunk = String::from_utf8_lossy(&buffer[..length]).to_string();
                    if !chunk.trim().is_empty() {
                        let _ = stderr_app.emit(
                            "nscb-stderr",
                            StderrEvent {
                                op: stderr_operation.clone(),
                                chunk,
                            },
                        );
                    }
                }
                Err(_) => break,
            }
        }
    });

    std::thread::spawn(move || {
        let code = child
            .wait()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(-1);
        if let Ok(mut state) = running_pid().lock() {
            *state = None;
        }
        let _ = app.emit(
            "nscb-done",
            DoneEvent {
                op: operation,
                code,
            },
        );
    });
    Ok(())
}

#[tauri::command]
fn cancel_nscb() -> Result<(), String> {
    cancellation_requested().store(true, Ordering::SeqCst);
    let active_pid = running_pid()
        .lock()
        .map_err(|_| "Failed to lock backend state".to_string())?
        .take();
    if let Some(pid) = active_pid {
        #[cfg(target_os = "windows")]
        {
            let mut command = Command::new("taskkill");
            command.args(["/PID", &pid.to_string(), "/T", "/F"]);
            command.creation_flags(CREATE_NO_WINDOW);
            let _ = command.stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
    Ok(())
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_tools_dir(app)?.join("settings.json"))
}

fn read_settings(app: &tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let value = std::fs::read_to_string(path)
        .map_err(|error| format!("Failed to read settings: {error}"))?;
    serde_json::from_str(&value).map_err(|error| format!("Failed to parse settings: {error}"))
}

fn write_settings(
    app: &tauri::AppHandle,
    settings: &HashMap<String, String>,
) -> Result<(), String> {
    let value = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Failed to encode settings: {error}"))?;
    std::fs::write(settings_path(app)?, value)
        .map_err(|error| format!("Failed to save settings: {error}"))
}

#[tauri::command]
fn get_setting(app: tauri::AppHandle, key: String) -> Result<String, String> {
    Ok(read_settings(&app)?.get(&key).cloned().unwrap_or_default())
}

#[tauri::command]
fn save_setting(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let mut settings = read_settings(&app)?;
    if value.is_empty() {
        settings.remove(&key);
    } else {
        settings.insert(key, value);
    }
    write_settings(&app, &settings)
}

#[tauri::command]
fn get_backend_version(app: tauri::AppHandle) -> Result<String, String> {
    Ok(read_settings(&app)?
        .get("backendVersion")
        .cloned()
        .unwrap_or_default())
}

#[tauri::command]
fn save_backend_version(app: tauri::AppHandle, version: String) -> Result<(), String> {
    save_setting(app, "backendVersion".to_string(), version)
}

#[tauri::command]
fn create_verify_filelist(app: tauri::AppHandle, target_path: String) -> Result<String, String> {
    let tools = app_tools_dir(&app)?;
    let stem = Path::new(&target_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("verify");
    let safe_stem: String = stem
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let list_path = tools.join(format!("{safe_stem}-vflist.txt"));
    let cached = tools
        .join("INFO")
        .join("MASSVERIFY")
        .join(format!("{safe_stem}-vflist-verify.txt"));
    let _ = std::fs::remove_file(cached);
    std::fs::write(&list_path, format!("{target_path}\n"))
        .map_err(|error| format!("Failed to create verification list: {error}"))?;
    Ok(list_path.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_file_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|error| format!("Failed to read report: {error}"))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            inspect_switch_paths,
            import_keys,
            remove_keys,
            get_tools_dir,
            has_keys,
            has_backend,
            import_nscb_binary,
            download_backend,
            run_nscb,
            cancel_nscb,
            get_setting,
            save_setting,
            get_backend_version,
            get_patch_tool_status,
            import_patch_tool,
            inspect_patch_directory,
            run_patch_build,
            save_backend_version,
            create_verify_filelist,
            read_file_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nintendo Switch Image Converter");
}

#[cfg(test)]
mod tests {
    use super::{classify_content, extract_title_id, extract_version};

    #[test]
    fn reads_title_id_and_version() {
        let name = "Game [0100123412345800][v65536][UPD].nsz";
        assert_eq!(extract_title_id(name).as_deref(), Some("0100123412345800"));
        assert_eq!(extract_version(name), Some(65536));
    }

    #[test]
    fn classifies_switch_content() {
        assert_eq!(
            classify_content("base.nsp", Some("0100123412345000")),
            "base"
        );
        assert_eq!(
            classify_content("update.nsp", Some("0100123412345800")),
            "update"
        );
        assert_eq!(classify_content("dlc.nsp", Some("0100123412345001")), "dlc");
        assert_eq!(classify_content("unknown.nsp", None), "unknown");
    }
}
