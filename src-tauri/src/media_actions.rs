//! Image context-menu actions: open, save, copy.
//!
//! WebKit's own "Download Image" / "Open Image in New Window" items point at
//! delegates a Tauri app doesn't provide, so they silently do nothing. The
//! webview suppresses that menu and shows its own; these commands do the work.
//! They must handle every way the app serves an image: BlueBubbles http(s)
//! URLs, `asset://` temp files (Slack/Telegram media) and data: URLs
//! (Telegram photos).

use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;

/// Percent-decode a URL path component (enough for convertFileSrc output;
/// not worth a dependency).
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Bytes + best-guess extension for any image `src` the webview renders.
async fn resolve_image(src: &str) -> Result<(Vec<u8>, String), String> {
    if let Some(rest) = src.strip_prefix("data:") {
        // data:image/png;base64,....
        let (meta, payload) = rest
            .split_once(',')
            .ok_or_else(|| "malformed data URL".to_string())?;
        let bytes = if meta.ends_with(";base64") {
            base64::engine::general_purpose::STANDARD
                .decode(payload.trim())
                .map_err(|e| format!("bad base64 image: {e}"))?
        } else {
            percent_decode(payload).into_bytes()
        };
        let ext = meta
            .split(&['/', ';'][..])
            .nth(1)
            .unwrap_or("png")
            .to_string();
        return Ok((bytes, ext));
    }

    if src.starts_with("asset://") || src.contains(".localhost/") {
        // convertFileSrc output: asset://localhost/<percent-encoded absolute path>
        let encoded = src
            .splitn(4, '/')
            .nth(3)
            .ok_or_else(|| "malformed asset URL".to_string())?;
        let path = PathBuf::from(percent_decode(encoded));
        let canonical = path.canonicalize().map_err(|e| format!("no such file: {e}"))?;
        // Same boundary as the asset protocol scope: only the media temp dir
        // is readable this way. Never let a crafted src read arbitrary files.
        let media_root = crate::telegram::media_tmp_dir()
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !canonical.starts_with(&media_root) {
            return Err("image path outside the media directory".into());
        }
        let ext = canonical
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png")
            .to_ascii_lowercase();
        let bytes = std::fs::read(&canonical).map_err(|e| e.to_string())?;
        return Ok((bytes, ext));
    }

    if src.starts_with("http://") || src.starts_with("https://") {
        // Same TLS posture as the media fetches: BlueBubbles servers run
        // self-signed on the LAN.
        let client = tauri_plugin_http::reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;
        let response = client
            .get(src)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let ext = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .and_then(|ct| ct.strip_prefix("image/"))
            .map(|s| s.split(';').next().unwrap_or(s).trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "jpg".into());
        let bytes = response.bytes().await.map_err(|e| e.to_string())?.to_vec();
        return Ok((bytes, ext));
    }

    Err(format!("unsupported image source: {}", src.chars().take(32).collect::<String>()))
}

/// "picture.png" from a suggested name + resolved extension, filesystem-safe.
fn image_filename(suggested: &str, ext: &str) -> String {
    let base: String = suggested
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '_' })
        .collect::<String>()
        .trim()
        .to_string();
    let base = if base.is_empty() { "image".to_string() } else { base };
    if Path::new(&base).extension().is_some() {
        base
    } else {
        format!("{base}.{ext}")
    }
}

/// "picture.png" → "picture-2.png" until the name is free.
fn unique_in(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = Path::new(name).extension().and_then(|s| s.to_str());
    for n in 2.. {
        let next = match ext {
            Some(ext) => dir.join(format!("{stem}-{n}.{ext}")),
            None => dir.join(format!("{stem}-{n}")),
        };
        if !next.exists() {
            return next;
        }
    }
    unreachable!()
}

fn downloads_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME directory".to_string())?;
    let dir = PathBuf::from(home).join("Downloads");
    if !dir.is_dir() {
        return Err("no Downloads folder".into());
    }
    Ok(dir)
}

/// Save an image to ~/Downloads; returns the path for the confirmation toast.
#[tauri::command]
pub async fn img_save(src: String, name: String) -> Result<String, String> {
    let (bytes, ext) = resolve_image(&src).await?;
    let path = unique_in(&downloads_dir()?, &image_filename(&name, &ext));
    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Open an image in the OS viewer (Preview on macOS).
#[tauri::command]
pub async fn img_open(src: String, name: String) -> Result<(), String> {
    let (bytes, ext) = resolve_image(&src).await?;
    let dir = crate::telegram::media_tmp_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(image_filename(&format!("open-{name}"), &ext));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(not(target_os = "macos"))]
    let opener = "xdg-open";
    std::process::Command::new(opener)
        .arg(&path)
        .spawn()
        .map_err(|e| format!("could not open viewer: {e}"))?;
    Ok(())
}

/// Put an image on the clipboard.
///
/// macOS only needs a file and osascript — no image-decoding or clipboard
/// crates. PNG and JPEG cover everything the app renders; anything else is
/// offered as PNG-classed data, which Preview-sourced pastes accept.
#[tauri::command]
pub async fn img_copy(src: String) -> Result<(), String> {
    let (bytes, ext) = resolve_image(&src).await?;
    let dir = crate::telegram::media_tmp_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("clipboard.{ext}"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    {
        let class = match ext.as_str() {
            "jpg" | "jpeg" => "JPEG",
            _ => "PNGf",
        };
        let script = format!(
            "set the clipboard to (read (POSIX file \"{}\") as \u{ab}class {class}\u{bb})",
            path.to_string_lossy()
        );
        let status = std::process::Command::new("osascript")
            .args(["-e", &script])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("could not write image to clipboard".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("copy image is macOS-only for now".into())
    }
}
