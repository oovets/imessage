//! AI personality profiles — read-only access to the Style Distiller's output
//! (`scripts/style-distiller.mjs`), which writes into the app's config dir:
//!
//!   ai/style_profile.json          global stats + style card
//!   ai/relationships/<file>.json   per-contact stats, card and examples
//!   ai/index.json                  guid -> file listing
//!
//! The webview loads these when building the layered reply prompt. Files are
//! small (a few KB) and read on the async runtime.

use tauri::Manager;

fn ai_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("ai"))
}

/// The global style profile as raw JSON, or None when no distillation exists.
#[tauri::command]
pub async fn ai_style_profile(app: tauri::AppHandle) -> Option<String> {
    tokio::fs::read_to_string(ai_dir(&app)?.join("style_profile.json"))
        .await
        .ok()
}

/// The relationship profile for a chat guid (matched against each entry's
/// underlying thread guids, so merged iMessage/SMS conversations resolve too).
#[tauri::command]
pub async fn ai_relationship_profile(app: tauri::AppHandle, chat_guid: String) -> Option<String> {
    let dir = ai_dir(&app)?;
    let index = tokio::fs::read_to_string(dir.join("index.json")).await.ok()?;
    let index: serde_json::Value = serde_json::from_str(&index).ok()?;
    for entry in index.get("relationships")?.as_array()? {
        let in_guids = entry
            .get("guids")
            .and_then(|g| g.as_array())
            .map(|arr| arr.iter().any(|v| v.as_str() == Some(chat_guid.as_str())))
            .unwrap_or(false);
        if in_guids || entry.get("guid").and_then(|v| v.as_str()) == Some(chat_guid.as_str()) {
            let file = entry.get("file")?.as_str()?;
            return tokio::fs::read_to_string(dir.join(file)).await.ok();
        }
    }
    None
}
