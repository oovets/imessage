// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer SIGABRTs WebKitWebProcess on Wayland+Mesa
    // (Hyprland + Intel here): parent UI survives, web process dies. Same abort
    // site across many Messages cores. Fall back to the shared-memory path
    // unless the user already set the var. See:
    // https://v2.tauri.app/develop/debug/linux-graphics/
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    app_lib::run();
}
