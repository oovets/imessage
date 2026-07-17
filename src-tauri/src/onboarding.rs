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

const BB_REPO: &str = "BlueBubblesApp/bluebubbles-server";
const BB_APP: &str = "/Applications/BlueBubbles.app";

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

fn install_blocking() -> Result<String, String> {
    let url = latest_bb_dmg_url()?;
    let tmp = std::env::temp_dir();
    let dmg = tmp.join("bluebubbles-setup.dmg");
    let mnt = tmp.join("bluebubbles-setup-mnt");

    let _ = std::fs::remove_dir_all(&mnt);
    std::fs::create_dir_all(&mnt).map_err(|e| format!("could not create mountpoint: {e}"))?;

    let dmg_s = path_str(&dmg)?;
    let mnt_s = path_str(&mnt)?;

    run("curl", &["-fL", "-o", dmg_s, &url])?;
    run(
        "hdiutil",
        &["attach", "-nobrowse", "-quiet", "-mountpoint", mnt_s, dmg_s],
    )?;

    // Copy the .app out, then always detach + clean up regardless of outcome.
    let copy_result = (|| -> Result<(), String> {
        let app_src = std::fs::read_dir(&mnt)
            .map_err(|e| format!("could not read dmg: {e}"))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.extension().map(|x| x == "app").unwrap_or(false))
            .ok_or_else(|| "no .app found inside the dmg".to_string())?;
        let _ = std::fs::remove_dir_all(BB_APP);
        run("cp", &["-R", path_str(&app_src)?, BB_APP])?;
        Ok(())
    })();

    let _ = run("hdiutil", &["detach", "-quiet", mnt_s]);
    let _ = std::fs::remove_file(&dmg);
    copy_result?;

    // Clear quarantine so the (unsigned) server launches without the Gatekeeper
    // "app is damaged" block.
    let _ = run("xattr", &["-dr", "com.apple.quarantine", BB_APP]);
    Ok(url)
}

#[tauri::command]
pub async fn bb_install() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(install_blocking)
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
) -> Result<(), String> {
    // First launch creates config.db via typeorm migrations; then quit to seed.
    run("open", &["-a", "BlueBubbles"])?;
    let db = config_db_path()?;
    let mut created = false;
    for _ in 0..60 {
        if db.exists() {
            created = true;
            break;
        }
        thread::sleep(Duration::from_secs(1));
    }
    if !created {
        return Err("BlueBubbles did not create its config database in time".to_string());
    }
    thread::sleep(Duration::from_secs(2));
    let _ = run("osascript", &["-e", "tell application \"BlueBubbles\" to quit"]);
    thread::sleep(Duration::from_secs(2));

    let db_s = path_str(&db)?;
    seed(db_s, "password", &password)?;
    seed(db_s, "socket_port", &port.to_string())?;
    seed(db_s, "tutorial_is_done", "1")?;
    seed(db_s, "check_for_updates", "0")?;
    seed(db_s, "auto_caffeinate", "1")?;
    seed(db_s, "start_minimized", "1")?;
    seed(db_s, "auto_start", if login { "1" } else { "0" })?;
    seed(db_s, "headless", if headless { "1" } else { "0" })?;
    if headless {
        seed(db_s, "hide_dock_icon", "1")?;
    }
    Ok(())
}

#[tauri::command]
pub async fn bb_configure(
    password: String,
    port: u16,
    headless: bool,
    login: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || configure_blocking(password, port, headless, login))
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

fn start_and_check_blocking(password: String, port: u16) -> ServerCheck {
    let _ = run("open", &["-a", "BlueBubbles"]);
    let base = format!("http://localhost:{port}/api/v1");

    let mut reachable = false;
    for _ in 0..40 {
        let url = format!("{base}/server/info?password={password}");
        if run("curl", &["-fsS", &url]).is_ok() {
            reachable = true;
            break;
        }
        thread::sleep(Duration::from_secs(1));
    }

    let can_read_db = reachable && {
        let url = format!("{base}/message/count?password={password}");
        run("curl", &["-fsS", &url]).is_ok()
    };

    ServerCheck {
        reachable,
        can_read_db,
    }
}

#[tauri::command]
pub async fn bb_start_and_check(password: String, port: u16) -> ServerCheck {
    tauri::async_runtime::spawn_blocking(move || start_and_check_blocking(password, port))
        .await
        .unwrap_or(ServerCheck {
            reachable: false,
            can_read_db: false,
        })
}
