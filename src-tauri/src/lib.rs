#[cfg(any(target_os = "macos", target_os = "linux"))]
use keyring::Entry;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
use tauri::{
    menu::Menu, menu::MenuBuilder, menu::MenuItemBuilder, menu::PredefinedMenuItem,
    menu::SubmenuBuilder, Emitter, Manager, Runtime,
};
use tauri::{tray::MouseButton, tray::MouseButtonState, tray::TrayIconBuilder, tray::TrayIconEvent};

mod onboarding;

#[cfg(any(target_os = "macos", target_os = "linux"))]
const KEYRING_SERVICE: &str = "com.oovets.messages";
#[cfg(target_os = "macos")]
const LEGACY_KEYCHAIN_SERVICE: &str = "com.oovets.imessagereact";
#[cfg(any(target_os = "macos", target_os = "linux"))]
const KEY_CONFIG: &str = "secure-config";

const MENU_SHOW: &str = "menu_show";
const MENU_SETTINGS: &str = "menu_settings";
const MENU_HIDE_MENUBAR: &str = "menu_hide_menubar";

const TRAY_SHOW: &str = "tray_show";
const TRAY_SETTINGS: &str = "tray_settings";
const TRAY_QUIT: &str = "tray_quit";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecureConfig {
    server_url: String,
    password: String,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn keyring_entry(service: &str, key: &str) -> Result<Entry, String> {
    Entry::new(service, key).map_err(|e| format!("keyring init failed: {e}"))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn read_secret(service: &str, key: &str) -> Result<Option<String>, String> {
    let entry = keyring_entry(service, key)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("keyring read failed: {err}")),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn write_secret(key: &str, value: &str) -> Result<(), String> {
    let entry = keyring_entry(KEYRING_SERVICE, key)?;
    entry
        .set_password(value)
        .map_err(|e| format!("keyring write failed: {e}"))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn delete_secret(service: &str, key: &str) -> Result<(), String> {
    let entry = keyring_entry(service, key)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("keyring delete failed: {err}")),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn parse_secure_config(raw_config: &str) -> Result<SecureConfig, String> {
    serde_json::from_str(raw_config).map_err(|e| format!("keyring config parse failed: {e}"))
}

#[cfg(target_os = "macos")]
fn load_legacy_secure_config() -> Result<Option<SecureConfig>, String> {
    if let Some(raw_config) = read_secret(LEGACY_KEYCHAIN_SERVICE, KEY_CONFIG)? {
        return parse_secure_config(&raw_config).map(Some);
    }

    Ok(None)
}

#[tauri::command]
fn load_secure_config() -> Result<Option<SecureConfig>, String> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        if let Some(raw_config) = read_secret(KEYRING_SERVICE, KEY_CONFIG)? {
            return parse_secure_config(&raw_config).map(Some);
        }

        #[cfg(target_os = "macos")]
        if let Some(config) = load_legacy_secure_config()? {
            let raw_config = serde_json::to_string(&config)
                .map_err(|e| format!("keyring config serialize failed: {e}"))?;
            write_secret(KEY_CONFIG, &raw_config)?;
            return Ok(Some(config));
        }

        return Ok(None);
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Ok(None)
    }
}

#[tauri::command]
fn save_secure_config(server_url: String, password: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let config = SecureConfig {
            server_url,
            password,
        };
        let raw_config = serde_json::to_string(&config)
            .map_err(|e| format!("keyring config serialize failed: {e}"))?;
        write_secret(KEY_CONFIG, &raw_config)?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (server_url, password);
        Err("Secure keyring storage is not available on this platform.".to_string())
    }
}

#[tauri::command]
fn clear_secure_config() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        delete_secret(KEYRING_SERVICE, KEY_CONFIG)?;
        delete_secret(LEGACY_KEYCHAIN_SERVICE, KEY_CONFIG)?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        delete_secret(KEYRING_SERVICE, KEY_CONFIG)?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn apply_window_vibrancy<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = apply_vibrancy(
            &window,
            NSVisualEffectMaterial::Sidebar,
            Some(NSVisualEffectState::Active),
            None,
        );
    }
}

fn focus_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn emit_settings_open<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let _ = app.emit("app://open-settings", ());
}

fn build_app_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_submenu = SubmenuBuilder::new(app, "Messages Desktop")
        .text(MENU_SHOW, "Show")
        .text(MENU_SETTINGS, "Settings")
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("Hide Messages Desktop"))?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit Messages Desktop"))?)
        .build()?;

    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    let hide_menubar = MenuItemBuilder::with_id(MENU_HIDE_MENUBAR, "Hide Menu Bar")
        .accelerator("CmdOrCtrl+Shift+M")
        .build(app)?;

    let view_submenu = SubmenuBuilder::new(app, "View")
        .item(&hide_menubar)
        .build()?;

    let window_submenu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&edit_submenu)
        .item(&view_submenu)
        .item(&window_submenu)
        .build()
}

fn setup_app_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let menu = build_app_menu(app)?;
    app.set_menu(menu)?;
    Ok(())
}

#[tauri::command]
fn set_menubar_visible<R: Runtime>(app: tauri::AppHandle<R>, visible: bool) -> Result<(), String> {
    if visible {
        let menu = build_app_menu(&app).map_err(|e| format!("build menu failed: {e}"))?;
        app.set_menu(menu)
            .map_err(|e| format!("set menu failed: {e}"))?;
    } else {
        app.remove_menu()
            .map_err(|e| format!("remove menu failed: {e}"))?;
    }
    Ok(())
}

fn setup_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let tray_menu = MenuBuilder::new(app)
        .text(TRAY_SHOW, "Show")
        .text(TRAY_SETTINGS, "Settings")
        .separator()
        .text(TRAY_QUIT, "Quit")
        .build()?;

    let mut tray = TrayIconBuilder::with_id("main-tray")
        .menu(&tray_menu)
        .show_menu_on_left_click(false);

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.on_menu_event(|app, event| match event.id().as_ref() {
        TRAY_SHOW => focus_main_window(app),
        TRAY_SETTINGS => {
            focus_main_window(app);
            emit_settings_open(app);
        }
        TRAY_QUIT => app.exit(0),
        _ => {}
    })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            focus_main_window(&tray.app_handle());
        }
    })
    .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            load_secure_config,
            save_secure_config,
            clear_secure_config,
            set_menubar_visible,
            onboarding::bb_status,
            onboarding::bb_install,
            onboarding::bb_configure,
            onboarding::bb_open_privacy,
            onboarding::bb_start_and_check
        ])
        .setup(|app| {
            let app_handle = app.handle();
            setup_app_menu(&app_handle)?;
            setup_tray(&app_handle)?;
            #[cfg(target_os = "macos")]
            apply_window_vibrancy(&app_handle);

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => focus_main_window(app),
            MENU_SETTINGS => {
                focus_main_window(app);
                emit_settings_open(app);
            }
            MENU_HIDE_MENUBAR => {
                let _ = app.emit("app://hide-menubar", ());
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
