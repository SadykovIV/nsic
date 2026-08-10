use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Runtime};

use crate::{app_tools_dir, cancellation_requested, make_executable, nscb_exe_path, running_pid};

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
pub struct PatchToolStatus {
    hactool: bool,
    hacpack: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PatchInspection {
    root: String,
    content_root: String,
    title_id: String,
    romfs_path: Option<String>,
    exefs_path: Option<String>,
    file_count: u64,
    total_size: u64,
    ignored_files: u64,
    warnings: Vec<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PatchBuildRequest {
    title_id: String,
    base_path: String,
    update_path: Option<String>,
    dlc_paths: Vec<String>,
    carrier_dlc_path: String,
    patch_path: String,
    output_dir: String,
    temp_dir: Option<String>,
    nodelta: bool,
    show_firmware: bool,
    rsvcap: Option<String>,
    keypatch: Option<String>,
}

#[derive(Default, Clone, Debug, PartialEq, Eq)]
struct DlcPackageInfo {
    title_id: Option<String>,
    data: Option<String>,
    data_sdk: Option<String>,
    meta_sdk: Option<String>,
    key_generation: u8,
}

#[derive(Default)]
struct NcaTraits {
    rights: bool,
}

struct TemporaryKey(PathBuf);

impl Drop for TemporaryKey {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PatchManifest {
    title_id: String,
    base: String,
    update: Option<String>,
    dlc: Vec<String>,
    carrier_dlc: String,
    carrier_title_id: String,
    unreal_plugin: String,
    patch: String,
    patch_files: u64,
    patch_bytes: u64,
    replaced_files: u64,
    added_files: u64,
    installed_files: Vec<String>,
    output: String,
    note: String,
}

fn tool_path(app: &tauri::AppHandle, kind: &str) -> Result<PathBuf, String> {
    let name = match kind {
        "hactool" => "hactool",
        "hacpack" => "hacpack",
        _ => return Err("Unknown patch tool".into()),
    };
    let path = app_tools_dir(app)?.join(name);
    if !path.is_file() {
        return Err(format!("{name} is not installed"));
    }
    Ok(path)
}

#[tauri::command]
pub fn get_patch_tool_status(app: tauri::AppHandle) -> Result<PatchToolStatus, String> {
    let tools = app_tools_dir(&app)?;
    Ok(PatchToolStatus {
        hactool: tools.join("hactool").is_file(),
        hacpack: tools.join("hacpack").is_file(),
    })
}

#[tauri::command]
pub fn import_patch_tool(
    app: tauri::AppHandle,
    kind: String,
    src_path: String,
) -> Result<(), String> {
    let source = PathBuf::from(src_path);
    if !source.is_file() {
        return Err("Selected tool does not exist".into());
    }
    let lower = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if (kind == "hactool" && !lower.contains("hactool"))
        || (kind == "hacpack" && !lower.contains("hacpack"))
    {
        return Err(format!("Select a {kind} binary"));
    }
    let destination = app_tools_dir(&app)?.join(match kind.as_str() {
        "hactool" => "hactool",
        "hacpack" => "hacpack",
        _ => return Err("Unknown patch tool".into()),
    });
    fs::copy(source, &destination).map_err(|error| format!("Failed to import {kind}: {error}"))?;
    make_executable(&destination);
    Ok(())
}

fn is_title_id(value: &str) -> bool {
    value.len() == 16
        && value.starts_with("0100")
        && value.bytes().all(|value| value.is_ascii_hexdigit())
}

fn ignored_name(name: &str) -> bool {
    name == ".DS_Store" || name.starts_with("._")
}

fn patch_content_dirs(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0_u8)];
    while let Some((directory, depth)) = pending.pop() {
        let name = directory
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if is_title_id(&name.to_ascii_uppercase())
            && (directory.join("romfs").is_dir() || directory.join("exefs").is_dir())
        {
            found.push(directory);
            continue;
        }
        if depth >= 4 {
            continue;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir()
                && !kind.is_symlink()
                && !ignored_name(&entry.file_name().to_string_lossy())
            {
                pending.push((entry.path(), depth + 1));
            }
        }
    }
    found.sort();
    found
}

fn usable_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("Cannot read {}: {error}", directory.display()))?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if ignored_name(&name) || kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                files.push(entry.path());
            }
        }
    }
    files.sort();
    Ok(files)
}

fn count_ignored(root: &Path) -> Result<u64, String> {
    let mut ignored = 0_u64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("Cannot read {}: {error}", directory.display()))?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if ignored_name(&name) || kind.is_symlink() {
                ignored += 1;
            } else if kind.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Ok(ignored)
}

fn is_unreal_package_asset(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "pak" | "utoc" | "ucas" | "sig"
            )
        })
}

fn unreal_patch_assets(romfs: &Path) -> Result<Vec<PathBuf>, String> {
    let files = usable_files(romfs)?;
    if let Some(path) = files.iter().find(|path| !is_unreal_package_asset(path)) {
        let relative = path.strip_prefix(romfs).unwrap_or(path);
        return Err(format!(
            "Safe DLC embedding currently supports only Unreal PAK/UTOC/UCAS/SIG assets; unsupported file: {}",
            relative.display()
        ));
    }
    if !files.iter().any(|path| {
        path.extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("pak"))
    }) {
        return Err("The modification contains no Unreal .pak file".into());
    }
    Ok(files)
}

fn inspect_patch(root: &Path) -> Result<PatchInspection, String> {
    if !root.is_dir() {
        return Err("Patch folder does not exist".into());
    }
    let candidates = patch_content_dirs(root);
    if candidates.is_empty() {
        return Err("No <TITLE ID>/romfs layout was found".into());
    }
    if candidates.len() > 1 {
        return Err(
            "The patch contains more than one TITLE ID; select one game patch folder".into(),
        );
    }
    let content = &candidates[0];
    let title_id = content
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_uppercase();
    let romfs = content.join("romfs");
    let exefs = content.join("exefs");
    if exefs.is_dir() {
        return Err(
            "Safe DLC embedding does not support ExeFS modifications; use a RomFS Unreal PAK localization"
                .into(),
        );
    }
    if !romfs.is_dir() {
        return Err("Safe DLC embedding requires a <TITLE ID>/romfs folder".into());
    }
    let assets = unreal_patch_assets(&romfs)?;
    let file_count = assets.len() as u64;
    let total_size = assets.iter().try_fold(0_u64, |total, path| {
        path.metadata()
            .map(|metadata| total + metadata.len())
            .map_err(|error| error.to_string())
    })?;
    let ignored_files = count_ignored(content)?;
    let mut warnings = Vec::new();
    if ignored_files > 0 {
        warnings.push(format!(
            "{ignored_files} macOS metadata or symlink entries will be ignored"
        ));
    }
    warnings.push(
        "Unreal package assets will be embedded into the selected DLC; base and update remain unchanged"
            .into(),
    );
    Ok(PatchInspection {
        root: root.to_string_lossy().into_owned(),
        content_root: content.to_string_lossy().into_owned(),
        title_id,
        romfs_path: Some(romfs.to_string_lossy().into_owned()),
        exefs_path: None,
        file_count,
        total_size,
        ignored_files,
        warnings,
    })
}

#[tauri::command]
pub fn inspect_patch_directory(path: String) -> Result<PatchInspection, String> {
    inspect_patch(Path::new(&path))
}

fn emit_line<R: Runtime>(app: &tauri::AppHandle<R>, line: impl Into<String>) {
    let _ = app.emit(
        "nscb-stdout",
        StdoutEvent {
            op: "patch".into(),
            line: line.into(),
        },
    );
}

fn emit_error<R: Runtime>(app: &tauri::AppHandle<R>, line: impl Into<String>) {
    let _ = app.emit(
        "nscb-stderr",
        StderrEvent {
            op: "patch".into(),
            chunk: line.into(),
        },
    );
}

fn progress<R: Runtime>(app: &tauri::AppHandle<R>, percent: u8, ru: &str, en: &str) {
    emit_line(app, format!("NSIC_PROGRESS {percent} | {ru} / {en}"));
}

fn ensure_not_cancelled() -> Result<(), String> {
    if cancellation_requested().load(Ordering::SeqCst) {
        Err("Operation cancelled".into())
    } else {
        Ok(())
    }
}

fn copy_file_cancellable(source: &Path, destination: &Path) -> Result<u64, String> {
    let mut input = fs::File::open(source)
        .map_err(|error| format!("Cannot open {}: {error}", source.display()))?;
    let mut output = fs::File::create(destination)
        .map_err(|error| format!("Cannot create {}: {error}", destination.display()))?;
    let mut copied = 0_u64;
    let mut buffer = vec![0_u8; 4 * 1024 * 1024];
    loop {
        ensure_not_cancelled()?;
        let length = input
            .read(&mut buffer)
            .map_err(|error| format!("Cannot read {}: {error}", source.display()))?;
        if length == 0 {
            break;
        }
        output
            .write_all(&buffer[..length])
            .map_err(|error| format!("Cannot write {}: {error}", destination.display()))?;
        copied += length as u64;
    }
    output
        .flush()
        .map_err(|error| format!("Cannot flush {}: {error}", destination.display()))?;
    Ok(copied)
}

fn run_command_with_events<R: Runtime>(
    mut command: Command,
    label: &str,
    capture_stdout: bool,
    events: Option<tauri::AppHandle<R>>,
) -> Result<String, String> {
    ensure_not_cancelled()?;
    command.stdin(Stdio::null());
    if capture_stdout || events.is_some() {
        command.stdout(Stdio::piped());
    } else {
        command.stdout(Stdio::null());
    }
    command.stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start {label}: {error}"))?;
    if let Ok(mut state) = running_pid().lock() {
        *state = Some(child.id());
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_events = events.clone();
    let out_thread = std::thread::spawn(move || {
        let mut value = String::new();
        if let Some(mut stream) = stdout {
            let mut buffer = [0_u8; 4096];
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => {
                        let chunk = String::from_utf8_lossy(&buffer[..length]);
                        value.push_str(&chunk);
                        if let Some(app) = &stdout_events {
                            let _ = app.emit(
                                "nscb-stdout",
                                StdoutEvent {
                                    op: "patch".into(),
                                    line: chunk.into_owned(),
                                },
                            );
                        }
                    }
                    Err(_) => break,
                }
            }
        }
        value
    });
    let stderr_events = events;
    let err_thread = std::thread::spawn(move || {
        let mut value = String::new();
        if let Some(mut stream) = stderr {
            let mut buffer = [0_u8; 4096];
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => {
                        let chunk = String::from_utf8_lossy(&buffer[..length]);
                        value.push_str(&chunk);
                        if let Some(app) = &stderr_events {
                            let _ = app.emit(
                                "nscb-stderr",
                                StderrEvent {
                                    op: "patch".into(),
                                    chunk: chunk.into_owned(),
                                },
                            );
                        }
                    }
                    Err(_) => break,
                }
            }
        }
        value
    });
    let status = child
        .wait()
        .map_err(|error| format!("Failed to wait for {label}: {error}"))?;
    if let Ok(mut state) = running_pid().lock() {
        *state = None;
    }
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    ensure_not_cancelled()?;
    if !status.success() {
        let detail = stderr
            .lines()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!(
            "{label} failed ({}): {}",
            status.code().unwrap_or(-1),
            detail.trim()
        ));
    }
    Ok(stdout)
}

fn run_command(command: Command, label: &str, capture_stdout: bool) -> Result<String, String> {
    run_command_with_events(command, label, capture_stdout, None::<tauri::AppHandle>)
}

fn hacpack_sdk_version(value: &str) -> Option<String> {
    let parts = value
        .trim()
        .split('.')
        .map(str::parse::<u8>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if parts.len() != 4 {
        return None;
    }
    Some(parts.iter().map(|part| format!("{part:02X}")).collect())
}

fn parse_dlc_info(output: &str) -> Result<DlcPackageInfo, String> {
    if !output
        .lines()
        .any(|line| line.trim() == "- Content type: DLC")
    {
        return Err("The selected carrier is not a standalone DLC package".into());
    }
    let mut info = DlcPackageInfo::default();
    for line in output.lines() {
        let clean = line.trim();
        if let Some(value) = clean.strip_prefix("CONTENT ID:") {
            let value = value.trim().to_ascii_uppercase();
            if is_title_id(&value) {
                info.title_id = Some(value);
            }
        }
        if let Some(rest) = clean.strip_prefix("- Data:") {
            info.data = rest.split_whitespace().next().map(str::to_string);
        }
        if let Some(rest) = clean.strip_prefix("- Encryption (keygeneration):") {
            info.key_generation = rest
                .split_whitespace()
                .next()
                .and_then(|value| value.parse().ok())
                .unwrap_or(1);
        }
        if let Some(rest) = clean.strip_prefix("- Data SDK version:") {
            info.data_sdk = rest.split_whitespace().next().and_then(hacpack_sdk_version);
        }
        if let Some(rest) = clean.strip_prefix("- Meta SDK version:") {
            info.meta_sdk = rest.split_whitespace().next().and_then(hacpack_sdk_version);
        }
    }
    if info.title_id.is_none() {
        return Err("Could not identify the DLC TITLE ID".into());
    }
    if info.data.is_none() {
        return Err("The selected carrier DLC has no PublicData NCA".into());
    }
    if info.data_sdk.is_none() || info.meta_sdk.is_none() {
        return Err("Could not identify DLC Data/Meta SDK versions".into());
    }
    Ok(info)
}

fn nscb_dlc_info(exe: &Path, keys: &Path, package: &str) -> Result<DlcPackageInfo, String> {
    let mut command = Command::new(exe);
    command.args(["--ADVfilelist", package, "--keys"]).arg(keys);
    let output = run_command(command, "nscb_rust DLC metadata scan", true)?;
    parse_dlc_info(&output)
}

fn content_ids(output: &str) -> Vec<String> {
    let mut ids = output
        .lines()
        .filter_map(|line| line.trim().strip_prefix("CONTENT ID:"))
        .map(|value| value.trim().to_ascii_uppercase())
        .filter(|value| is_title_id(value))
        .collect::<Vec<_>>();
    ids.sort();
    ids
}

fn verify_final_xci_inventory(
    nscb: &Path,
    keys: &Path,
    output: &Path,
    base_title_id: &str,
    expected_dlc_ids: &[String],
) -> Result<(), String> {
    let mut command = Command::new(nscb);
    command
        .args(["--ADVfilelist"])
        .arg(output)
        .args(["--keys"])
        .arg(keys);
    let scan = run_command(command, "final XCI inventory scan", true)?;
    let ids = content_ids(&scan);
    if ids.iter().filter(|value| value.as_str() == base_title_id).count() != 1 {
        return Err(format!(
            "Final XCI inventory does not contain exactly one base title {base_title_id}"
        ));
    }
    for expected in expected_dlc_ids {
        if ids.iter().filter(|value| *value == expected).count() != 1 {
            return Err(format!(
                "Final XCI inventory does not contain exactly one selected DLC {expected}"
            ));
        }
    }
    Ok(())
}

fn split_package(
    exe: &Path,
    keys: &Path,
    package: &str,
    output: &Path,
    temp: &Path,
) -> Result<(), String> {
    fs::create_dir_all(output).map_err(|error| error.to_string())?;
    let mut command = Command::new(exe);
    command
        .args(["--splitter", package, "-o"])
        .arg(output)
        .args(["--keys"])
        .arg(keys)
        .args(["--temp-dir"])
        .arg(temp);
    run_command(command, "nscb_rust DLC extraction", false).map(|_| ())
}

fn find_named(root: &Path, name: &str) -> Option<PathBuf> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).ok()?.flatten() {
            let kind = entry.file_type().ok()?;
            if kind.is_dir() {
                pending.push(entry.path());
            } else if entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(name)
            {
                return Some(entry.path());
            }
        }
    }
    None
}

fn find_extension(root: &Path, extension: &str) -> Option<PathBuf> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).ok()?.flatten() {
            let kind = entry.file_type().ok()?;
            if kind.is_dir() {
                pending.push(entry.path());
            } else if entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case(extension))
            {
                return Some(entry.path());
            }
        }
    }
    None
}

fn ticket_title_key(ticket: &Path) -> Result<String, String> {
    let data = fs::read(ticket).map_err(|error| format!("Cannot read ticket: {error}"))?;
    if data.len() < 4 {
        return Err("Ticket is truncated".into());
    }
    let kind = u32::from_le_bytes(data[0..4].try_into().unwrap());
    let signature = match kind {
        0x010000 | 0x010003 => 0x200,
        0x010001 | 0x010004 => 0x100,
        0x010002 | 0x010005 => 0x3c,
        _ => return Err("Unknown ticket signature type".into()),
    };
    let body = (4 + signature + 0x3f) & !0x3f;
    if data.len() < body + 0x50 {
        return Err("Ticket has no title key block".into());
    }
    Ok(data[body + 0x40..body + 0x50]
        .iter()
        .map(|value| format!("{value:02x}"))
        .collect())
}

fn sanitized_keys(source: &Path, destination: &Path) -> Result<(), String> {
    let value =
        fs::read_to_string(source).map_err(|error| format!("Cannot read prod.keys: {error}"))?;
    let mut result = String::new();
    for line in value.lines() {
        let Some((name, raw)) = line.split_once('=') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let raw = raw.trim();
        let indexed = |prefix: &str| {
            name.strip_prefix(prefix).is_some_and(|suffix| {
                suffix.len() == 2 && suffix.bytes().all(|value| value.is_ascii_hexdigit())
            })
        };
        let allowed = matches!(
            name.as_str(),
            "aes_kek_generation_source"
                | "aes_key_generation_source"
                | "key_area_key_application_source"
                | "key_area_key_ocean_source"
                | "key_area_key_system_source"
                | "titlekek_source"
                | "header_kek_source"
                | "header_key_source"
                | "header_key"
        ) || indexed("master_key_")
            || indexed("titlekek_")
            || indexed("key_area_key_application_")
            || indexed("key_area_key_ocean_")
            || indexed("key_area_key_system_");
        if allowed
            && (raw.len() == 32 || raw.len() == 64)
            && raw.bytes().all(|value| value.is_ascii_hexdigit())
        {
            result.push_str(&format!("{name} = {raw}\n"));
        }
    }
    fs::write(destination, result).map_err(|error| format!("Cannot prepare tool keyset: {error}"))
}

fn nca_traits(hactool: &Path, keys: &Path, nca: &Path) -> Result<NcaTraits, String> {
    let mut command = Command::new(hactool);
    command
        .args(["-i", "--disablekeywarns", "--suppresskeys", "-k"])
        .arg(keys)
        .arg(nca);
    let output = run_command(command, "hactool inspection", true)?;
    Ok(NcaTraits {
        rights: output.contains("Encryption Type:                    Titlekey crypto"),
    })
}

fn valid_romfs_ivfc_output(output: &str) -> bool {
    let levels = output
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("Level ") && line.contains('('))
        .collect::<Vec<_>>();
    levels.len() == 6 && levels.iter().all(|line| line.contains("(GOOD)"))
}

fn verify_romfs_ivfc(hactool: &Path, keys: &Path, nca: &Path) -> Result<(), String> {
    let mut command = Command::new(hactool);
    command
        .args(["-i", "-y", "--disablekeywarns", "--suppresskeys", "-k"])
        .arg(keys)
        .arg(nca);
    let output = run_command(command, "hactool PublicData verification", true)?;
    if !valid_romfs_ivfc_output(&output) {
        return Err(
            "Rebuilt PublicData NCA failed IVFC verification. Use a compatible ARM64 hacPack build."
                .into(),
        );
    }
    Ok(())
}

fn extract_nca(
    hactool: &Path,
    keys: &Path,
    target: &Path,
    encrypted_title_key: Option<&str>,
    romfs: &Path,
) -> Result<(), String> {
    fs::create_dir_all(romfs).map_err(|error| error.to_string())?;
    let mut command = Command::new(hactool);
    command
        .args(["--disablekeywarns", "--suppresskeys", "-k"])
        .arg(keys);
    if let Some(key) = encrypted_title_key {
        command.arg(format!("--titlekey={key}"));
    }
    command.arg(format!("--romfsdir={}", romfs.display()));
    command.arg(target);
    run_command(command, "hactool PublicData extraction", false).map(|_| ())
}

fn path_has_component(path: &Path, expected: &str) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|value| value.eq_ignore_ascii_case(expected))
    })
}

fn carrier_plugin(carrier_romfs: &Path) -> Result<(String, PathBuf), String> {
    let files = usable_files(carrier_romfs)?;
    let mut plugins = files
        .iter()
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("uplugin"))
        })
        .filter_map(|path| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .map(|value| value.to_string())
        })
        .collect::<Vec<_>>();
    plugins.sort();
    plugins.dedup();
    let pak_files = files
        .iter()
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("pak"))
                && path_has_component(path, "Paks")
        })
        .collect::<Vec<_>>();
    let mut candidates = Vec::<(String, PathBuf)>::new();
    for plugin in &plugins {
        for pak in &pak_files {
            let name = pak
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if name
                .get(..plugin.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(plugin))
            {
                if let Some(parent) = pak.parent() {
                    candidates.push((plugin.clone(), parent.to_path_buf()));
                }
            }
        }
    }
    if candidates.is_empty() && plugins.len() == 1 && pak_files.len() == 1 {
        candidates.push((
            plugins[0].clone(),
            pak_files[0].parent().unwrap().to_path_buf(),
        ));
    }
    candidates.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    candidates.dedup();
    match candidates.as_slice() {
        [candidate] => Ok(candidate.clone()),
        [] => Err(
            "The selected DLC is not a compatible Unreal plugin carrier (.uplugin plus Content/Paks .pak required)"
                .into(),
        ),
        _ => Err(
            "The selected DLC contains multiple Unreal plugin carriers; choose a simpler standalone DLC"
                .into(),
        ),
    }
}

fn install_unreal_assets(
    source_romfs: &Path,
    carrier_romfs: &Path,
) -> Result<(String, Vec<String>, u64, u64), String> {
    let assets = unreal_patch_assets(source_romfs)?;
    let (plugin, destination) = carrier_plugin(carrier_romfs)?;
    fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
    let mut installed = Vec::new();
    let mut added = 0_u64;
    let mut replaced = 0_u64;
    for source in assets {
        ensure_not_cancelled()?;
        let source_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("Invalid modification filename: {}", source.display()))?;
        let target_name = if source_name
            .get(..plugin.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(&plugin))
        {
            source_name.to_string()
        } else {
            format!("{plugin}{source_name}")
        };
        let target = destination.join(target_name);
        if target.exists() {
            replaced += 1;
        } else {
            added += 1;
        }
        copy_file_cancellable(&source, &target)?;
        installed.push(
            target
                .strip_prefix(carrier_romfs)
                .unwrap_or(&target)
                .to_string_lossy()
                .into_owned(),
        );
    }
    Ok((plugin, installed, added, replaced))
}

fn find_single_nca(root: &Path, cnmt: bool) -> Result<PathBuf, String> {
    let mut files = fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path.extension().and_then(|value| value.to_str()) == Some("nca")
                && path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.ends_with(".cnmt.nca") == cnmt)
        })
        .collect::<Vec<_>>();
    files.sort();
    files.pop().ok_or_else(|| {
        format!(
            "No rebuilt {} NCA was produced",
            if cnmt { "Meta" } else { "PublicData" }
        )
    })
}

struct HacpackNcaArgs<'a> {
    output: &'a Path,
    temp: &'a Path,
    nca_type: &'a str,
    title_id: &'a str,
    key_generation: u8,
    sdk_version: &'a str,
}

fn hacpack_base(hacpack: &Path, keys: &Path, args: HacpackNcaArgs<'_>) -> Command {
    let mut command = Command::new(hacpack);
    command
        .args(["-k"])
        .arg(keys)
        .args(["-o"])
        .arg(args.output)
        .args(["--tempdir"])
        .arg(args.temp)
        .args([
            "--type",
            "nca",
            "--ncatype",
            args.nca_type,
            "--titleid",
            args.title_id,
            "--keygeneration",
        ])
        .arg(args.key_generation.max(1).to_string())
        .arg("--sdkversion")
        .arg(args.sdk_version);
    command
}

fn base_title_id_for_dlc(title_id: &str) -> Option<String> {
    let value = u64::from_str_radix(title_id, 16).ok()?;
    let base = (value & !0xfff).checked_sub(0x1000)?;
    Some(format!("{base:016X}"))
}

fn latest_xci(root: &Path, since: SystemTime) -> Option<PathBuf> {
    fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("xci"))
        })
        .filter_map(|path| {
            path.metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .filter(|modified| *modified >= since)
                .map(|modified| (modified, path))
        })
        .max_by_key(|value| value.0)
        .map(|value| value.1)
}

fn pipeline_with_tools<R: Runtime>(
    app: &tauri::AppHandle<R>,
    request: &PatchBuildRequest,
    nscb: &Path,
    hactool: &Path,
    hacpack: &Path,
    source_keys: &Path,
) -> Result<PathBuf, String> {
    let inspection = inspect_patch(Path::new(&request.patch_path))?;
    let base_title_id = request.title_id.to_ascii_uppercase();
    if inspection.title_id != base_title_id {
        return Err(format!(
            "Patch TITLE ID {} does not match game {}",
            inspection.title_id, request.title_id
        ));
    }
    if request.carrier_dlc_path.is_empty() {
        return Err("Select a DLC carrier for the modification".into());
    }
    if request
        .dlc_paths
        .iter()
        .filter(|path| *path == &request.carrier_dlc_path)
        .count()
        != 1
    {
        return Err("The selected DLC carrier must be included exactly once in the XCI set".into());
    }

    let temp_root = request
        .temp_dir
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    fs::create_dir_all(&temp_root)
        .map_err(|error| format!("Cannot use temporary folder: {error}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let work = temp_root.join(format!("nsic-dlc-patch-{}-{stamp}", request.title_id));
    fs::create_dir_all(&work).map_err(|error| format!("Cannot create work folder: {error}"))?;
    emit_line(app, format!("Temporary workspace: {}", work.display()));
    emit_line(
        app,
        "Safe mode: original base/update remain untouched; only the selected DLC is rebuilt.",
    );
    emit_line(
        app,
        "The workspace is removed after success and retained after an error.",
    );

    let keys = work.join("tool.keys");
    sanitized_keys(source_keys, &keys)?;
    let _temporary_key = TemporaryKey(keys.clone());

    progress(
        app,
        5,
        "Чтение метаданных DLC-контейнера",
        "Reading DLC carrier metadata",
    );
    let carrier_info = nscb_dlc_info(nscb, source_keys, &request.carrier_dlc_path)?;
    let carrier_title_id = carrier_info
        .title_id
        .clone()
        .ok_or("DLC TITLE ID is unavailable")?;
    if base_title_id_for_dlc(&carrier_title_id).as_deref() != Some(base_title_id.as_str()) {
        return Err(format!(
            "Carrier DLC {carrier_title_id} does not belong to base game {base_title_id}"
        ));
    }
    let mut expected_dlc_ids = Vec::new();
    for dlc in &request.dlc_paths {
        let info = if dlc == &request.carrier_dlc_path {
            carrier_info.clone()
        } else {
            nscb_dlc_info(nscb, source_keys, dlc)?
        };
        let title_id = info.title_id.ok_or("Selected DLC TITLE ID is unavailable")?;
        if base_title_id_for_dlc(&title_id).as_deref() != Some(base_title_id.as_str()) {
            return Err(format!(
                "Selected DLC {title_id} does not belong to base game {base_title_id}"
            ));
        }
        if expected_dlc_ids.contains(&title_id) {
            return Err(format!("DLC {title_id} is selected more than once"));
        }
        expected_dlc_ids.push(title_id);
    }
    let data_name = carrier_info
        .data
        .as_deref()
        .ok_or("DLC PublicData NCA is unavailable")?;
    let data_sdk = carrier_info
        .data_sdk
        .as_deref()
        .ok_or("DLC Data SDK version is unavailable")?;
    let meta_sdk = carrier_info
        .meta_sdk
        .as_deref()
        .ok_or("DLC Meta SDK version is unavailable")?;

    progress(
        app,
        14,
        "Распаковка выбранного DLC",
        "Extracting the selected DLC",
    );
    let carrier_split = work.join("carrier-split");
    split_package(
        nscb,
        source_keys,
        &request.carrier_dlc_path,
        &carrier_split,
        &work,
    )?;
    let data_nca =
        find_named(&carrier_split, data_name).ok_or("DLC PublicData NCA was not extracted")?;
    let title_key = find_extension(&carrier_split, "tik")
        .map(|path| ticket_title_key(&path))
        .transpose()?;
    let traits = nca_traits(hactool, &keys, &data_nca)?;
    if traits.rights && title_key.is_none() {
        return Err("The DLC uses title-key crypto, but no matching ticket was found".into());
    }

    progress(
        app,
        28,
        "Извлечение файловой системы DLC",
        "Extracting DLC filesystem",
    );
    let carrier_romfs = work.join("carrier-romfs");
    extract_nca(
        hactool,
        &keys,
        &data_nca,
        title_key.as_deref(),
        &carrier_romfs,
    )?;

    progress(
        app,
        40,
        "Встраивание Unreal-модификации в DLC",
        "Embedding Unreal modification into DLC",
    );
    let source_romfs = inspection
        .romfs_path
        .as_deref()
        .ok_or("Modification RomFS is unavailable")?;
    let (plugin, installed_files, added, replaced) =
        install_unreal_assets(Path::new(source_romfs), &carrier_romfs)?;
    emit_line(app, format!("Unreal plugin carrier: {plugin}"));
    for installed in &installed_files {
        emit_line(app, format!("Embedded: {installed}"));
    }

    progress(
        app,
        55,
        "Пересборка PublicData NCA",
        "Rebuilding PublicData NCA",
    );
    let final_ncas = work.join("final-ncas");
    fs::create_dir_all(&final_ncas).map_err(|error| error.to_string())?;
    let mut data_command = hacpack_base(
        hacpack,
        &keys,
        HacpackNcaArgs {
            output: &final_ncas,
            temp: &work.join("publicdata-temp"),
            nca_type: "publicdata",
            title_id: &carrier_title_id,
            key_generation: carrier_info.key_generation,
            sdk_version: data_sdk,
        },
    );
    data_command.args(["--romfsdir"]).arg(&carrier_romfs);
    run_command(data_command, "hacPack PublicData NCA build", false)?;
    let rebuilt_data = find_single_nca(&final_ncas, false)?;

    progress(
        app,
        68,
        "Проверка целостности PublicData NCA",
        "Verifying PublicData NCA integrity",
    );
    verify_romfs_ivfc(hactool, &keys, &rebuilt_data)?;
    emit_line(app, "PublicData RomFS IVFC: Level 0-5 GOOD");

    progress(
        app,
        74,
        "Пересборка Meta NCA DLC",
        "Rebuilding DLC Meta NCA",
    );
    let mut meta_command = hacpack_base(
        hacpack,
        &keys,
        HacpackNcaArgs {
            output: &final_ncas,
            temp: &work.join("meta-temp"),
            nca_type: "meta",
            title_id: &carrier_title_id,
            key_generation: carrier_info.key_generation,
            sdk_version: meta_sdk,
        },
    );
    meta_command
        .args(["--titletype", "addon", "--publicdatanca"])
        .arg(&rebuilt_data);
    run_command(meta_command, "hacPack DLC Meta NCA build", false)?;
    find_single_nca(&final_ncas, true)?;

    progress(
        app,
        80,
        "Создание модифицированного DLC NSP",
        "Creating modified DLC NSP",
    );
    let nsp_out = work.join("nsp");
    fs::create_dir_all(&nsp_out).map_err(|error| error.to_string())?;
    let mut nsp_command = Command::new(hacpack);
    nsp_command
        .args(["-k"])
        .arg(&keys)
        .args(["-o"])
        .arg(&nsp_out)
        .args(["--tempdir"])
        .arg(work.join("nsp-temp"))
        .args(["--type", "nsp", "--titleid", &carrier_title_id, "--ncadir"])
        .arg(&final_ncas)
        .arg("--keygeneration")
        .arg(carrier_info.key_generation.max(1).to_string());
    run_command(nsp_command, "hacPack DLC NSP build", false)?;
    let patched_dlc = find_extension(&nsp_out, "nsp").ok_or("Modified DLC NSP was not produced")?;

    progress(
        app,
        86,
        "Сборка XCI из исходных base/update и DLC",
        "Building XCI from original base/update and DLC",
    );
    fs::create_dir_all(&request.output_dir)
        .map_err(|error| format!("Cannot create output folder: {error}"))?;
    let started = SystemTime::now();
    let mut merge = Command::new(nscb);
    merge.arg("-d").arg(&request.base_path);
    if let Some(update) = request
        .update_path
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        merge.arg(update);
    }
    for dlc in &request.dlc_paths {
        if dlc == &request.carrier_dlc_path {
            merge.arg(&patched_dlc);
        } else {
            merge.arg(dlc);
        }
    }
    merge.args(["-t", "xci"]);
    if request.nodelta {
        merge.arg("-n");
    }
    if request.show_firmware {
        merge.arg("--pv");
    }
    if let Some(value) = request.rsvcap.as_deref().filter(|value| !value.is_empty()) {
        merge.args(["--RSVcap", value]);
    }
    if let Some(value) = request
        .keypatch
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        merge.args(["-k", value]);
    }
    merge
        .args(["-o", &request.output_dir, "--keys"])
        .arg(source_keys)
        .args(["--temp-dir"])
        .arg(&work)
        .env("NSCB_FORCE_PROGRESS", "1");
    run_command_with_events(merge, "nscb_rust XCI merge", false, Some(app.clone()))?;
    ensure_not_cancelled()?;
    let output =
        latest_xci(Path::new(&request.output_dir), started).ok_or("Final XCI was not found")?;

    progress(
        app,
        96,
        "Проверка состава готового XCI",
        "Verifying final XCI inventory",
    );
    verify_final_xci_inventory(
        nscb,
        source_keys,
        &output,
        &base_title_id,
        &expected_dlc_ids,
    )?;
    emit_line(
        app,
        format!(
            "Final XCI inventory: base {base_title_id}, DLC {}",
            expected_dlc_ids.join(", ")
        ),
    );

    let manifest = PatchManifest {
        title_id: base_title_id,
        base: request.base_path.clone(),
        update: request.update_path.clone(),
        dlc: request.dlc_paths.clone(),
        carrier_dlc: request.carrier_dlc_path.clone(),
        carrier_title_id,
        unreal_plugin: plugin,
        patch: inspection.content_root,
        patch_files: inspection.file_count,
        patch_bytes: inspection.total_size,
        replaced_files: replaced,
        added_files: added,
        installed_files,
        output: output.to_string_lossy().into_owned(),
        note: "Original base/update and non-carrier DLC packages are preserved. Only the selected carrier DLC PublicData/Meta NCAs are rebuilt and intentionally fakesigned; PublicData IVFC levels 0-5 were verified."
            .into(),
    };
    let manifest_path = PathBuf::from(format!("{}.nsic.json", output.to_string_lossy()));
    fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    emit_line(app, format!("Manifest: {}", manifest_path.display()));
    emit_line(app, format!("NSIC_RESULT: {}", output.display()));

    progress(
        app,
        99,
        "Очистка временных файлов",
        "Cleaning temporary files",
    );
    if let Err(error) = fs::remove_dir_all(&work) {
        emit_error(
            app,
            format!("WARNING: XCI was built, but temporary cleanup failed: {error}"),
        );
    } else {
        emit_line(app, "Temporary workspace removed.");
    }
    Ok(output)
}

fn pipeline(app: &tauri::AppHandle, request: &PatchBuildRequest) -> Result<PathBuf, String> {
    let nscb = nscb_exe_path(app)?;
    let hactool = tool_path(app, "hactool")?;
    let hacpack = tool_path(app, "hacpack")?;
    let tools = app_tools_dir(app)?;
    let source_keys = if tools.join("prod.keys").is_file() {
        tools.join("prod.keys")
    } else {
        tools.join("keys.txt")
    };
    pipeline_with_tools(app, request, &nscb, &hactool, &hacpack, &source_keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("nsic-{label}-{}-{stamp}", std::process::id()))
    }

    #[test]
    fn inspects_unreal_layeredfs_patch_and_ignores_macos_metadata() {
        let root = test_root("patch-inspection");
        let romfs = root.join("ITT_RUVO_SWITCH/010092A0172E4000/romfs/Nuts/Content/Paks");
        fs::create_dir_all(&romfs).unwrap();
        fs::write(romfs.join("Nuts-Switch_P.pak"), [1_u8, 2, 3, 4]).unwrap();
        fs::write(
            root.join("ITT_RUVO_SWITCH/010092A0172E4000/.DS_Store"),
            [0_u8],
        )
        .unwrap();
        let inspection = inspect_patch(&root).unwrap();
        assert_eq!(inspection.title_id, "010092A0172E4000");
        assert_eq!(inspection.file_count, 1);
        assert_eq!(inspection.total_size, 4);
        assert_eq!(inspection.ignored_files, 1);
        assert!(inspection.romfs_path.is_some());
        assert!(inspection.exefs_path.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_non_unreal_files_in_safe_mode() {
        let root = test_root("patch-unsupported");
        let romfs = root.join("010092A0172E4000/romfs");
        fs::create_dir_all(&romfs).unwrap();
        fs::write(romfs.join("config.ini"), [1_u8]).unwrap();
        assert!(inspect_patch(&root)
            .unwrap_err()
            .contains("supports only Unreal"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_patch_with_multiple_title_ids() {
        let root = test_root("patch-multiple-title-ids");
        for title_id in ["010092A0172E4000", "0100ABCD12345000"] {
            let romfs = root.join(title_id).join("romfs");
            fs::create_dir_all(&romfs).unwrap();
            fs::write(romfs.join("mod.pak"), [1_u8]).unwrap();
        }
        assert!(inspect_patch(&root)
            .unwrap_err()
            .contains("more than one TITLE ID"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installs_assets_into_unreal_plugin_pak_directory() {
        cancellation_requested().store(false, Ordering::SeqCst);
        let root = test_root("carrier");
        let source = root.join("source/Nuts/Content/Paks");
        let destination = root.join("carrier/Content/Paks/Switch");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(source.join("Nuts-Switch_P.pak"), [7_u8, 8, 9]).unwrap();
        fs::write(root.join("carrier/FullGameEntitlement.uplugin"), b"{}").unwrap();
        fs::write(
            destination.join("FullGameEntitlementNuts-Switch.pak"),
            [1_u8],
        )
        .unwrap();
        let (plugin, installed, added, replaced) =
            install_unreal_assets(&root.join("source"), &root.join("carrier")).unwrap();
        assert_eq!(plugin, "FullGameEntitlement");
        assert_eq!(added, 1);
        assert_eq!(replaced, 0);
        assert_eq!(
            installed,
            vec!["Content/Paks/Switch/FullGameEntitlementNuts-Switch_P.pak"]
        );
        assert_eq!(
            fs::read(destination.join("FullGameEntitlementNuts-Switch_P.pak")).unwrap(),
            [7_u8, 8, 9]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_dlc_metadata_and_derives_base_title() {
        let output = r#"
CONTENT ID: 010092a0172e5001
- Content type: DLC
- Meta SDK version: 15.3.0.0
- Data SDK version: 13.3.5.0
- Encryption (keygeneration): 0 -> (1.0.0)
- Data: 2108ab4a34a73e6a7c9c7c0107912aa5.nca Size: 112.0KB
"#;
        let info = parse_dlc_info(output).unwrap();
        assert_eq!(info.title_id.as_deref(), Some("010092A0172E5001"));
        assert_eq!(info.data_sdk.as_deref(), Some("0D030500"));
        assert_eq!(info.meta_sdk.as_deref(), Some("0F030000"));
        assert_eq!(
            base_title_id_for_dlc("010092A0172E5001").as_deref(),
            Some("010092A0172E4000")
        );
    }

    #[test]
    fn requires_all_six_good_ivfc_levels() {
        let good = (0..6)
            .map(|level| format!("        Level {level} (GOOD):"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(valid_romfs_ivfc_output(&good));
        assert!(!valid_romfs_ivfc_output(
            &good.replace("Level 5 (GOOD)", "Level 5 (FAIL)")
        ));
    }

    #[test]
    fn parses_and_normalizes_final_inventory_content_ids() {
        let output = "\
CONTENT ID: 010092a0172e4000\n\
CONTENT ID: 010092a0172e4800\n\
CONTENT ID: 010092a0172e5001\n";
        assert_eq!(
            content_ids(output),
            vec![
                "010092A0172E4000",
                "010092A0172E4800",
                "010092A0172E5001",
            ]
        );
    }

    #[test]
    #[ignore = "requires user-owned game content and external tools"]
    fn real_dlc_pipeline_from_environment() {
        let required = |name: &str| {
            std::env::var(name).unwrap_or_else(|_| panic!("missing integration variable {name}"))
        };
        let carrier = required("NSIC_E2E_CARRIER_DLC");
        let request = PatchBuildRequest {
            title_id: required("NSIC_E2E_TITLE_ID"),
            base_path: required("NSIC_E2E_BASE"),
            update_path: std::env::var("NSIC_E2E_UPDATE").ok(),
            dlc_paths: vec![carrier.clone()],
            carrier_dlc_path: carrier,
            patch_path: required("NSIC_E2E_PATCH"),
            output_dir: required("NSIC_E2E_OUTPUT"),
            temp_dir: Some(required("NSIC_E2E_TEMP")),
            nodelta: true,
            show_firmware: false,
            rsvcap: None,
            keypatch: None,
        };
        cancellation_requested().store(false, Ordering::SeqCst);
        let app = tauri::test::mock_app();
        let output = pipeline_with_tools(
            app.handle(),
            &request,
            Path::new(&required("NSIC_E2E_NSCB")),
            Path::new(&required("NSIC_E2E_HACTOOL")),
            Path::new(&required("NSIC_E2E_HACPACK")),
            Path::new(&required("NSIC_E2E_KEYS")),
        )
        .unwrap();
        assert!(output.is_file());
        assert!(PathBuf::from(format!("{}.nsic.json", output.to_string_lossy())).is_file());
    }
}

#[tauri::command]
pub fn run_patch_build(app: tauri::AppHandle, request: PatchBuildRequest) -> Result<(), String> {
    cancellation_requested().store(false, Ordering::SeqCst);
    if running_pid()
        .lock()
        .map_err(|_| "Failed to lock backend state")?
        .is_some()
    {
        return Err("Another operation is already running".into());
    }
    tool_path(&app, "hactool")?;
    tool_path(&app, "hacpack")?;
    inspect_patch(Path::new(&request.patch_path))?;
    std::thread::spawn(move || {
        let result = pipeline(&app, &request);
        let code = match result {
            Ok(path) => {
                emit_line(&app, format!("Completed: {}", path.display()));
                0
            }
            Err(error) => {
                emit_error(&app, format!("ERROR: {error}"));
                1
            }
        };
        if let Ok(mut state) = running_pid().lock() {
            *state = None;
        }
        cancellation_requested().store(false, Ordering::SeqCst);
        let _ = app.emit(
            "nscb-done",
            DoneEvent {
                op: "patch".into(),
                code,
            },
        );
    });
    Ok(())
}
