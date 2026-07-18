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

/// The distiller's index of relationship profiles (for pickers/simulator).
#[tauri::command]
pub async fn ai_relationship_index(app: tauri::AppHandle) -> Option<String> {
    tokio::fs::read_to_string(ai_dir(&app)?.join("index.json"))
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

// --- telemetry (Personality Engine §14) -------------------------------------
//
// Every generated draft and what the user did with it is appended as one JSON
// line. A file (not localStorage) because this grows without bound, is written
// far more often than it is read, and is meant to be analysed offline too.

fn telemetry_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = ai_dir(app)?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("telemetry.jsonl"))
}

/// Append one event (already-serialized JSON object) to the telemetry log.
#[tauri::command]
pub async fn ai_log_event(app: tauri::AppHandle, event: String) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let path = telemetry_path(&app).ok_or("no telemetry path")?;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .map_err(|e| e.to_string())?;
    file.write_all(format!("{}\n", event.trim()).as_bytes())
        .await
        .map_err(|e| e.to_string())
}

/// The whole telemetry log (newline-delimited JSON), or None when empty.
#[tauri::command]
pub async fn ai_read_telemetry(app: tauri::AppHandle) -> Option<String> {
    tokio::fs::read_to_string(telemetry_path(&app)?).await.ok()
}

// --- retrieval (conversation embeddings) ------------------------------------
//
// The conversation indexer (scripts/conversation-indexer.mjs) writes per-
// conversation episode embeddings under ai/embeddings/. Scoring happens HERE,
// not in the webview: an index file can be megabytes of packed vectors, and
// shipping that over IPC per reply is the same mistake that once froze the
// UI on video bytes. The webview sends query text; it gets back only the
// top episodes' text.

#[derive(serde::Serialize)]
pub struct RetrievedEpisode {
    pub at: i64,
    pub text: String,
    pub score: f32,
}

fn unpack_vector(b64: &str) -> Option<Vec<f32>> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    Some(
        bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let (mut dot, mut na, mut nb) = (0f32, 0f32, 0f32);
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// Top episodes from this conversation's index for a query.
///
/// `endpoint` is the same OpenAI-compatible base the reply engine uses
/// (e.g. http://gpulab:11434/v1); embedding goes through /embeddings so no
/// second endpoint needs configuring. Returns [] rather than erroring when
/// no index exists — retrieval is an enhancement, never a blocker.
#[tauri::command]
pub async fn ai_retrieve_context(
    app: tauri::AppHandle,
    chat_guid: String,
    query: String,
    endpoint: String,
    model: String,
    k: usize,
) -> Result<Vec<RetrievedEpisode>, String> {
    let dir = match ai_dir(&app) {
        Some(d) => d.join("embeddings"),
        None => return Ok(vec![]),
    };
    let index = match tokio::fs::read_to_string(dir.join("index.json")).await {
        Ok(s) => s,
        Err(_) => return Ok(vec![]),
    };
    let index: serde_json::Value = serde_json::from_str(&index).map_err(|e| e.to_string())?;

    let file = index
        .get("conversations")
        .and_then(|c| c.as_array())
        .and_then(|arr| {
            arr.iter().find(|entry| {
                entry.get("guid").and_then(|v| v.as_str()) == Some(chat_guid.as_str())
                    || entry
                        .get("guids")
                        .and_then(|g| g.as_array())
                        .map(|gs| gs.iter().any(|v| v.as_str() == Some(chat_guid.as_str())))
                        .unwrap_or(false)
            })
        })
        .and_then(|entry| entry.get("file").and_then(|f| f.as_str()).map(String::from));
    let Some(file) = file else { return Ok(vec![]) };

    // Embed the query with the same model that built the index.
    let client = tauri_plugin_http::reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;
    let resp: serde_json::Value = client
        .post(format!("{}/embeddings", endpoint.trim_end_matches('/')))
        .json(&serde_json::json!({ "model": model, "input": query }))
        .send()
        .await
        .map_err(|e| format!("embed request failed: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let qv: Vec<f32> = resp
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|arr| arr.first())
        .and_then(|e| e.get("embedding"))
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .ok_or("no embedding in response")?;

    let data = tokio::fs::read_to_string(dir.join(&file))
        .await
        .map_err(|e| e.to_string())?;
    let data: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;

    let mut scored: Vec<RetrievedEpisode> = data
        .get("episodes")
        .and_then(|e| e.as_array())
        .map(|eps| {
            eps.iter()
                .filter_map(|ep| {
                    let v = unpack_vector(ep.get("v")?.as_str()?)?;
                    Some(RetrievedEpisode {
                        at: ep.get("at")?.as_i64()?,
                        text: ep.get("text")?.as_str()?.to_string(),
                        score: cosine(&qv, &v),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    // Real multi-topic episodes compress cosine into ~0.45-0.55, so the floor
    // is relative to the best hit (plus a low absolute sanity bound) rather
    // than a fixed threshold that would sometimes admit everything and
    // sometimes nothing.
    let top = scored.first().map(|e| e.score).unwrap_or(0.0);
    scored.retain(|e| e.score >= top - 0.08 && e.score >= 0.40);
    scored.truncate(k.clamp(1, 8));
    Ok(scored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn vectors_round_trip_through_base64_f32le() {
        // Must match the indexer's packing: Float32Array bytes, little-endian.
        let original = [0.25f32, -1.5, 3.75];
        let bytes: Vec<u8> = original.iter().flat_map(|f| f.to_le_bytes()).collect();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        assert_eq!(unpack_vector(&b64).unwrap(), original);
    }

    #[test]
    fn cosine_behaves() {
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
        assert_eq!(cosine(&[1.0], &[1.0, 2.0]), 0.0); // dim mismatch -> harmless
    }
}

/// The extracted conversation state for a chat guid (scripts/state-extractor.mjs).
///
/// Separate from the relationship profile on purpose: the profile is HOW I
/// write to someone and changes slowly; state is WHERE WE STAND and changes
/// daily. Returns None when no extraction exists — every consumer treats
/// missing state as "nothing open".
#[tauri::command]
pub async fn ai_conversation_state(app: tauri::AppHandle, chat_guid: String) -> Option<String> {
    let dir = ai_dir(&app)?.join("state");
    let index = tokio::fs::read_to_string(dir.join("index.json")).await.ok()?;
    let index: serde_json::Value = serde_json::from_str(&index).ok()?;
    for entry in index.get("conversations")?.as_array()? {
        let matches = entry.get("guid").and_then(|v| v.as_str()) == Some(chat_guid.as_str())
            || entry
                .get("guids")
                .and_then(|g| g.as_array())
                .map(|gs| gs.iter().any(|v| v.as_str() == Some(chat_guid.as_str())))
                .unwrap_or(false);
        if matches {
            let file = entry.get("file")?.as_str()?;
            return tokio::fs::read_to_string(dir.join(file)).await.ok();
        }
    }
    None
}

/// The social graph (scripts/social-graph.mjs) as raw JSON.
#[tauri::command]
pub async fn ai_social_graph(app: tauri::AppHandle) -> Option<String> {
    tokio::fs::read_to_string(ai_dir(&app)?.join("graph.json"))
        .await
        .ok()
}
