//! In-app BlueBubbles onboarding.
//!
//! Mirrors scripts/demo-setup.sh, but as Tauri commands the first-run wizard
//! drives step by step. Everything is done by shelling out to the macOS tools
//! already on the system (curl/hdiutil/cp/xattr/open/osascript/sqlite3), so no
//! new Rust dependencies are pulled in. The long-running steps run on the
//! blocking thread pool so they never stall the UI event loop.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::{thread, time::Duration};
use tauri::ipc::Channel;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    stage: String,
    /// 0–100 when the total size is known, otherwise null (indeterminate).
    pct: Option<f64>,
}

const BB_REPO: &str = "BlueBubblesApp/bluebubbles-server";
const BB_APP: &str = "/Applications/BlueBubbles.app";
const LSREGISTER: &str = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/// A line-oriented log channel streamed to the onboarding wizard so the user can
/// watch each step (and see the exact failure) as the installer runs.
type Log = Channel<String>;

fn logln(log: &Log, msg: impl Into<String>) {
    let _ = log.send(msg.into());
}

/// Launch BlueBubbles by its full path rather than by name. `open -a BlueBubbles`
/// resolves through Launch Services, which has not necessarily indexed a freshly
/// copied .app yet ("Unable to find application named 'BlueBubbles'"); opening the
/// bundle path directly does not depend on that registration.
fn open_bluebubbles() -> Result<String, String> {
    run("open", &[BB_APP])
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".to_string())
}

fn config_db_path() -> Result<PathBuf, String> {
    Ok(home()?.join("Library/Application Support/bluebubbles-server/config.db"))
}

fn path_str(p: &Path) -> Result<&str, String> {
    p.to_str().ok_or_else(|| "path is not valid UTF-8".to_string())
}

/// Run a command to completion, returning stdout on success.
fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run {program}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!(
            "{program} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

fn want_arm64() -> bool {
    std::env::consts::ARCH == "aarch64"
}

// --- status ----------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BbStatus {
    installed: bool,
    has_config: bool,
}

#[tauri::command]
pub fn bb_status() -> BbStatus {
    BbStatus {
        installed: Path::new(BB_APP).exists(),
        has_config: config_db_path().map(|p| p.exists()).unwrap_or(false),
    }
}

// --- install ---------------------------------------------------------------

fn latest_bb_dmg_url() -> Result<String, String> {
    let url = format!("https://api.github.com/repos/{BB_REPO}/releases/latest");
    let json = run("curl", &["-fsSL", &url])?;
    let release: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("could not parse release JSON: {e}"))?;
    let assets = release
        .get("assets")
        .and_then(|a| a.as_array())
        .ok_or_else(|| "release has no assets".to_string())?;

    for asset in assets {
        let name = asset.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let is_arm = name.ends_with("-arm64.dmg");
        let is_intel = name.ends_with(".dmg") && !name.contains("arm64");
        if (want_arm64() && is_arm) || (!want_arm64() && is_intel) {
            if let Some(u) = asset.get("browser_download_url").and_then(|u| u.as_str()) {
                return Ok(u.to_string());
            }
        }
    }
    Err("no matching BlueBubbles dmg for this architecture".to_string())
}

/// Best-effort total download size, for the progress bar. Follows redirects.
fn content_length(url: &str) -> Option<u64> {
    let out = run("curl", &["-fsSLI", url]).ok()?;
    out.lines()
        .filter_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|v| v.trim().to_string())
        })
        .next_back()
        .and_then(|v| v.parse::<u64>().ok())
}

fn install_blocking(progress: Channel<Progress>, log: Log) -> Result<String, String> {
    let emit = |stage: &str, pct: Option<f64>| {
        let _ = progress.send(Progress {
            stage: stage.to_string(),
            pct,
        });
    };

    emit("resolving", None);
    logln(&log, "Resolving latest BlueBubbles release…");
    let url = latest_bb_dmg_url().inspect_err(|e| logln(&log, format!("✗ {e}")))?;
    logln(&log, format!("Latest server: {url}"));
    let tmp = std::env::temp_dir();
    let dmg = tmp.join("bluebubbles-setup.dmg");
    let mnt = tmp.join("bluebubbles-setup-mnt");

    let _ = std::fs::remove_dir_all(&mnt);
    let _ = std::fs::remove_file(&dmg);
    std::fs::create_dir_all(&mnt).map_err(|e| format!("could not create mountpoint: {e}"))?;

    let dmg_s = path_str(&dmg)?;
    let mnt_s = path_str(&mnt)?;

    // Stream the download in the background and report progress by polling the
    // output file size against Content-Length — robust, no output parsing.
    let total = content_length(&url);
    logln(
        &log,
        match total {
            Some(t) => format!("Downloading… ({:.1} MB)", t as f64 / 1_048_576.0),
            None => "Downloading… (size unknown)".to_string(),
        },
    );
    emit("downloading", Some(0.0));
    let mut child = Command::new("curl")
        .args(["-fL", "-o", dmg_s, &url])
        .spawn()
        .map_err(|e| format!("failed to start curl: {e}"))?;
    loop {
        match child.try_wait().map_err(|e| format!("download wait failed: {e}"))? {
            Some(status) => {
                if !status.success() {
                    return Err("download failed".to_string());
                }
                break;
            }
            None => {
                if let (Some(t), Ok(meta)) = (total, std::fs::metadata(&dmg)) {
                    if t > 0 {
                        emit("downloading", Some((meta.len() as f64 / t as f64 * 100.0).min(99.0)));
                    }
                }
                thread::sleep(Duration::from_millis(300));
            }
        }
    }

    emit("installing", None);
    logln(&log, "Mounting disk image…");
    run(
        "hdiutil",
        &["attach", "-nobrowse", "-quiet", "-mountpoint", mnt_s, dmg_s],
    )
    .inspect_err(|e| logln(&log, format!("✗ {e}")))?;

    // Copy the .app out, then always detach + clean up regardless of outcome.
    let copy_result = (|| -> Result<(), String> {
        let app_src = std::fs::read_dir(&mnt)
            .map_err(|e| format!("could not read dmg: {e}"))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.extension().map(|x| x == "app").unwrap_or(false))
            .ok_or_else(|| "no .app found inside the dmg".to_string())?;
        logln(&log, "Copying BlueBubbles.app to /Applications…");
        let _ = std::fs::remove_dir_all(BB_APP);
        run("cp", &["-R", path_str(&app_src)?, BB_APP])?;
        Ok(())
    })();

    let _ = run("hdiutil", &["detach", "-quiet", mnt_s]);
    let _ = std::fs::remove_file(&dmg);
    copy_result.inspect_err(|e| logln(&log, format!("✗ {e}")))?;

    // Clear quarantine so the (unsigned) server launches without the Gatekeeper
    // "app is damaged" block.
    logln(&log, "Clearing quarantine flag…");
    let _ = run("xattr", &["-dr", "com.apple.quarantine", BB_APP]);

    // Register with Launch Services so it can be launched by name and scripted
    // via osascript immediately, without waiting for the periodic LS scan.
    logln(&log, "Registering with Launch Services…");
    let _ = run(LSREGISTER, &["-f", BB_APP]);

    logln(&log, "Install complete.");
    emit("done", Some(100.0));
    Ok(url)
}

#[tauri::command]
pub async fn bb_install(progress: Channel<Progress>, log: Log) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install_blocking(progress, log))
        .await
        .map_err(|e| format!("install task failed: {e}"))?
}

// --- configure -------------------------------------------------------------

fn seed(db: &str, name: &str, value: &str) -> Result<(), String> {
    let escaped = value.replace('\'', "''");
    let sql = format!(
        "INSERT INTO config(name,value) VALUES('{name}','{escaped}') \
         ON CONFLICT(name) DO UPDATE SET value=excluded.value;"
    );
    run("sqlite3", &[db, &sql]).map(|_| ())
}

fn configure_blocking(
    password: String,
    port: u16,
    headless: bool,
    login: bool,
    log: Log,
) -> Result<(), String> {
    // First launch creates config.db via typeorm migrations; then quit to seed.
    logln(&log, "Launching BlueBubbles to initialize its database…");
    open_bluebubbles().inspect_err(|e| logln(&log, format!("✗ open failed: {e}")))?;
    let db = config_db_path()?;
    logln(&log, "Waiting for the config database…");
    let mut created = false;
    for _ in 0..60 {
        if db.exists() {
            created = true;
            break;
        }
        thread::sleep(Duration::from_secs(1));
    }
    if !created {
        logln(&log, "✗ Timed out waiting for config.db");
        return Err("BlueBubbles did not create its config database in time".to_string());
    }
    thread::sleep(Duration::from_secs(2));
    logln(&log, "Quitting BlueBubbles to write settings…");
    let _ = run("osascript", &["-e", "tell application \"BlueBubbles\" to quit"]);
    let _ = run("pkill", &["-x", "BlueBubbles"]);
    thread::sleep(Duration::from_secs(2));

    logln(&log, "Seeding server configuration…");
    let db_s = path_str(&db)?;
    seed(db_s, "password", &password)?;
    seed(db_s, "socket_port", &port.to_string())?;
    seed(db_s, "tutorial_is_done", "1")?;
    seed(db_s, "check_for_updates", "0")?;
    seed(db_s, "auto_caffeinate", "1")?;
    seed(db_s, "auto_start", if login { "1" } else { "0" })?;
    seed(db_s, "headless", if headless { "1" } else { "0" })?;
    // Only hide the window / dock icon in true headless mode. When the server is
    // meant to be visible, keep start_minimized off too, so its window (and any
    // first-run step that must be completed before the API starts) is shown.
    seed(db_s, "start_minimized", if headless { "1" } else { "0" })?;
    seed(db_s, "hide_dock_icon", if headless { "1" } else { "0" })?;
    logln(&log, "Configuration written.");
    Ok(())
}

#[tauri::command]
pub async fn bb_configure(
    password: String,
    port: u16,
    headless: bool,
    login: bool,
    log: Log,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        configure_blocking(password, port, headless, login, log)
    })
    .await
    .map_err(|e| format!("configure task failed: {e}"))?
}

// --- permissions -----------------------------------------------------------

#[tauri::command]
pub fn bb_open_privacy(pane: String) -> Result<(), String> {
    let key = match pane.as_str() {
        "fulldisk" => "Privacy_AllFiles",
        "accessibility" => "Privacy_Accessibility",
        "automation" => "Privacy_Automation",
        _ => return Err(format!("unknown privacy pane: {pane}")),
    };
    run(
        "open",
        &[&format!(
            "x-apple.systempreferences:com.apple.preference.security?{key}"
        )],
    )
    .map(|_| ())
}

// --- start + verify --------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCheck {
    reachable: bool,
    can_read_db: bool,
}

/// Probe the API once. Ok(()) means HTTP 200; Err carries a human reason that
/// distinguishes "not listening" (connection refused) from an HTTP status such
/// as 401 (wrong password). The password rides in the query string, so the URL
/// itself is never returned or logged.
fn api_probe(url: &str) -> Result<(), String> {
    let out = Command::new("curl")
        .args(["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", url])
        .output()
        .map_err(|e| format!("failed to run curl: {e}"))?;
    let code = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if code == "200" {
        return Ok(());
    }
    if !out.status.success() || code == "000" {
        // Transport-level failure (e.g. connection refused): server not listening.
        return Err("connection refused (server not listening on this port)".to_string());
    }
    let hint = match code.as_str() {
        "401" | "403" => " (password mismatch — stale server config?)",
        _ => "",
    };
    Err(format!("HTTP {code}{hint}"))
}

fn start_and_check_blocking(password: String, port: u16, log: Log) -> ServerCheck {
    logln(&log, "Starting the BlueBubbles server…");
    if let Err(e) = open_bluebubbles() {
        logln(&log, format!("✗ open failed: {e}"));
    }
    let base = format!("http://localhost:{port}/api/v1");

    // The password rides in the query string, so never log the full URL.
    logln(&log, format!("Checking the API on http://localhost:{port}…"));
    let info_url = format!("{base}/server/info?password={password}");
    let mut reachable = false;
    let mut last_reason = String::from("no response");
    for _ in 0..40 {
        match api_probe(&info_url) {
            Ok(()) => {
                reachable = true;
                break;
            }
            Err(reason) => last_reason = reason,
        }
        thread::sleep(Duration::from_secs(1));
    }

    if reachable {
        logln(&log, "Server is reachable.");
    } else {
        logln(&log, format!("✗ Server not reachable — {last_reason}"));
    }

    let can_read_db = reachable && {
        let url = format!("{base}/message/count?password={password}");
        run("curl", &["-fsS", &url]).is_ok()
    };

    if reachable {
        if can_read_db {
            logln(&log, "Server can read the Messages database.");
        } else {
            logln(&log, "✗ Server up but can't read Messages — grant Full Disk Access.");
        }
    }

    ServerCheck {
        reachable,
        can_read_db,
    }
}

#[tauri::command]
pub async fn bb_start_and_check(password: String, port: u16, log: Log) -> ServerCheck {
    tauri::async_runtime::spawn_blocking(move || start_and_check_blocking(password, port, log))
        .await
        .unwrap_or(ServerCheck {
            reachable: false,
            can_read_db: false,
        })
}
