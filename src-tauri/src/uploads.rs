//! Attachment uploads over the raw IPC body.
//!
//! A file passed as an ordinary command argument (a `Uint8Array` inside the
//! args object, or a FormData body through the HTTP plugin) is serialized as a
//! JSON array of numbers — built and parsed on the webview's main thread,
//! which froze the UI for 0.5–1 s per photo and seconds per video. Upload
//! commands therefore take the file as the whole IPC body
//! (`invoke(cmd, bytes, { headers })`, delivered as `InvokeBody::Raw`) and
//! their metadata as one URI-encoded JSON header, so long captions and
//! unicode file names are safe.

use std::borrow::Cow;
use std::hash::{BuildHasher, RandomState};
use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use tauri::http::HeaderMap;
use tauri::ipc::{InvokeBody, Request};
use tauri::{Runtime, Webview};
use tauri_plugin_http::reqwest;

/// Header carrying an upload's metadata:
/// `encodeURIComponent(JSON.stringify(meta))`.
const META_HEADER: &str = "x-upload-meta";

/// What the HTTP plugin sends as `User-Agent` (`tauri-plugin-http/<version>`),
/// so BlueBubbles — and any tunnel in front of it — sees the same client for
/// uploads as for every other API call.
const HTTP_USER_AGENT: &str = "tauri-plugin-http/2.5.9";

/// Decode an upload command's metadata header into `T`.
pub fn meta<T: DeserializeOwned>(request: &Request<'_>) -> Result<T, String> {
    decode_meta(request.headers())
}

/// The uploaded file. Raw wherever Tauri supports raw bodies; Android and the
/// postMessage fallback (custom protocol blocked) deliver the same bytes as a
/// JSON number array, which is accepted too.
pub fn bytes<'a>(request: &'a Request<'_>) -> Result<Cow<'a, [u8]>, String> {
    body_bytes(request.body())
}

/// 32 random hex chars (128 bits) for multipart boundaries and per-upload temp
/// directories. Every `RandomState` gets distinct SipHash keys (seeded from
/// the OS per thread, stepped per call), so this needs no RNG crate.
pub fn random_token() -> String {
    let state = RandomState::new();
    format!("{:016x}{:016x}", state.hash_one(0u8), state.hash_one(1u8))
}

/// Write an upload to `path` in chunks on tokio's blocking pool.
/// `tokio::fs::write` would first copy the whole file (a second video's worth
/// of memory) because the bytes are borrowed from the IPC request.
pub async fn write_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File::create(path).await?;
    file.write_all(bytes).await?;
    // Waits for the last in-flight chunk and surfaces its error.
    file.flush().await
}

fn decode_meta<T: DeserializeOwned>(headers: &HeaderMap) -> Result<T, String> {
    let raw = headers
        .get(META_HEADER)
        .ok_or("missing upload metadata")?
        .to_str()
        .map_err(|_| "upload metadata must be URI-encoded")?;
    let json = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map_err(|e| format!("upload metadata is not UTF-8: {e}"))?;
    serde_json::from_str(&json).map_err(|e| format!("invalid upload metadata: {e}"))
}

fn body_bytes(body: &InvokeBody) -> Result<Cow<'_, [u8]>, String> {
    match body {
        InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes.as_slice())),
        InvokeBody::Json(value) => Vec::<u8>::deserialize(value)
            .map(Cow::Owned)
            .map_err(|e| format!("invalid upload body: {e}")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentMeta {
    /// The full endpoint, auth query included
    /// (`…/api/v1/message/attachment?guid=…`).
    url: String,
    chat_guid: String,
    temp_guid: String,
    name: String,
    /// The Blob's type; empty when the webview couldn't tell.
    #[serde(default)]
    mime_type: String,
}

/// Send an iMessage attachment through BlueBubbles (AppleScript method, which
/// doesn't need the Private API).
///
/// Posts the same `multipart/form-data` request the webview's `FormData` did
/// through the HTTP plugin — `chatGuid`, `tempGuid`, `name`,
/// `method=apple-script` and the `attachment` file — with the plugin's
/// reqwest and client defaults (TLS included), its User-Agent and its Origin.
/// Only the transport differs: the file arrives as the raw IPC body and the
/// multipart body is assembled here, off the main thread.
#[tauri::command]
pub async fn bb_send_attachment<R: Runtime>(
    webview: Webview<R>,
    request: Request<'_>,
) -> Result<(), String> {
    let meta: AttachmentMeta = meta(&request)?;
    let url = reqwest::Url::parse(&meta.url).map_err(|e| format!("invalid URL: {e}"))?;
    // What the HTTP plugin's scope allows too (capabilities/desktop.json).
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("unsupported URL scheme: {}", url.scheme()));
    }
    let file = bytes(&request)?;

    let boundary = form_boundary();
    let body = multipart_form(
        &boundary,
        &[
            ("chatGuid", meta.chat_guid.as_str()),
            ("tempGuid", meta.temp_guid.as_str()),
            ("name", meta.name.as_str()),
            ("method", "apple-script"),
        ],
        FilePart {
            field: "attachment",
            file_name: &meta.name,
            content_type: content_type(&meta.mime_type),
            bytes: &file,
        },
    );
    drop(file);

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let mut upload = client
        .post(url)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .header(reqwest::header::USER_AGENT, HTTP_USER_AGENT)
        .body(body);
    if let Some(origin) = webview_origin(&webview) {
        upload = upload.header(reqwest::header::ORIGIN, origin);
    }
    let response = upload.send().await.map_err(|e| e.to_string())?;

    let status = response.status();
    if !status.is_success() {
        let body = response.bytes().await.unwrap_or_default();
        let detail = error_detail(&body);
        return Err(if detail.is_empty() {
            format!("sendAttachment failed: HTTP {}", status.as_u16())
        } else {
            format!("sendAttachment failed: HTTP {} - {detail}", status.as_u16())
        });
    }
    Ok(())
}

/// The Origin the HTTP plugin attaches to every request it makes for a webview.
fn webview_origin<R: Runtime>(webview: &Webview<R>) -> Option<String> {
    let url = webview.url().ok()?;
    // `tauri://localhost` has an opaque origin, which serializes to "null".
    Some(if url.scheme() == "tauri" {
        "tauri://localhost".to_string()
    } else {
        url.origin().ascii_serialization()
    })
}

/// An error response body as the fetch path reported it: `res.text()` (UTF-8,
/// whatever the declared charset, leading BOM dropped) then `.slice(0, 160)`,
/// which counts UTF-16 units. A surrogate pair straddling the cut is dropped
/// rather than halved.
fn error_detail(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let mut units = 0;
    let end = text
        .char_indices()
        .find(|&(_, c)| {
            units += c.len_utf16();
            units > 160
        })
        .map_or(text.len(), |(i, _)| i);
    text[..end].to_owned()
}

/// A random multipart boundary (63 chars; RFC 2046 allows up to 70).
fn form_boundary() -> String {
    format!("----MessagesDesktopFormBoundary{}", random_token())
}

/// The Blob type as the part's Content-Type, or the browsers' default for an
/// untyped Blob.
fn content_type(mime: &str) -> &str {
    let mime = mime.trim();
    if mime.is_empty() || !mime.bytes().all(|b| (0x20..0x7f).contains(&b)) {
        "application/octet-stream"
    } else {
        mime
    }
}

struct FilePart<'a> {
    field: &'a str,
    file_name: &'a str,
    content_type: &'a str,
    bytes: &'a [u8],
}

/// A `multipart/form-data` body laid out the way the webview serializes
/// `FormData` (WHATWG encoding): text fields first, then the file.
fn multipart_form(boundary: &str, fields: &[(&str, &str)], file: FilePart<'_>) -> Vec<u8> {
    let mut body = Vec::with_capacity(file.bytes.len() + 256 * (fields.len() + 2));
    for (name, value) in fields {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"{}\"\r\n\r\n",
                escape_quoted(name)
            )
            .as_bytes(),
        );
        body.extend_from_slice(normalize_newlines(value).as_bytes());
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
            escape_quoted(file.field),
            escape_quoted(file.file_name),
            file.content_type
        )
        .as_bytes(),
    );
    body.extend_from_slice(file.bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// A field or file name inside a quoted Content-Disposition parameter:
/// browsers percent-escape CR, LF and `"`, and pass everything else (UTF-8
/// included) through verbatim.
fn escape_quoted(value: &str) -> String {
    value
        .replace('\r', "%0D")
        .replace('\n', "%0A")
        .replace('"', "%22")
}

/// Text field values go out with CRLF line breaks, as browsers send them.
fn normalize_newlines(value: &str) -> Cow<'_, str> {
    if !value.contains(['\r', '\n']) {
        return Cow::Borrowed(value);
    }
    Cow::Owned(
        value
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .replace('\n', "\r\n"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::HeaderValue;

    #[derive(Deserialize, Debug, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Meta {
        file_name: String,
        caption: Option<String>,
    }

    fn headers(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(META_HEADER, HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn decodes_uri_encoded_json_metadata() {
        // encodeURIComponent(JSON.stringify({ fileName: "Skärmavbild 1.png",
        //   caption: "hej 👋 \"du\"" }))
        let encoded = "%7B%22fileName%22%3A%22Sk%C3%A4rmavbild%201.png%22%2C%22caption%22%3A%22hej%20%F0%9F%91%8B%20%5C%22du%5C%22%22%7D";
        let meta: Meta = decode_meta(&headers(encoded)).unwrap();
        assert_eq!(
            meta,
            Meta {
                file_name: "Skärmavbild 1.png".into(),
                caption: Some("hej 👋 \"du\"".into()),
            }
        );
    }

    #[test]
    fn missing_or_malformed_metadata_is_an_error() {
        assert!(decode_meta::<Meta>(&HeaderMap::new()).is_err());
        assert!(decode_meta::<Meta>(&headers("%7Bnot-json")).is_err());
        assert!(decode_meta::<Meta>(&headers("%FF%FE")).is_err());
    }

    #[test]
    fn accepts_raw_and_json_array_bodies() {
        let raw = InvokeBody::Raw(vec![0, 1, 255]);
        assert!(matches!(
            body_bytes(&raw).unwrap(),
            Cow::Borrowed(&[0, 1, 255])
        ));

        let json = InvokeBody::Json(serde_json::json!([0, 1, 255]));
        assert_eq!(body_bytes(&json).unwrap().as_ref(), &[0, 1, 255]);

        assert!(body_bytes(&InvokeBody::Json(serde_json::json!([256]))).is_err());
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!({ "bytes": [] }))).is_err());
    }

    #[test]
    fn builds_the_browser_form_layout() {
        let body = multipart_form(
            "BOUNDARY",
            &[
                ("chatGuid", "iMessage;-;+46701234567"),
                ("method", "apple-script"),
            ],
            FilePart {
                field: "attachment",
                file_name: "a \"b\".jpg",
                content_type: "image/jpeg",
                bytes: &[0xff, 0xd8, 0x00],
            },
        );
        let mut expected = b"--BOUNDARY\r\n\
Content-Disposition: form-data; name=\"chatGuid\"\r\n\r\n\
iMessage;-;+46701234567\r\n\
--BOUNDARY\r\n\
Content-Disposition: form-data; name=\"method\"\r\n\r\n\
apple-script\r\n\
--BOUNDARY\r\n\
Content-Disposition: form-data; name=\"attachment\"; filename=\"a %22b%22.jpg\"\r\n\
Content-Type: image/jpeg\r\n\r\n"
            .to_vec();
        expected.extend_from_slice(&[0xff, 0xd8, 0x00]);
        expected.extend_from_slice(b"\r\n--BOUNDARY--\r\n");
        assert_eq!(body, expected);
    }

    #[test]
    fn escapes_and_normalizes_like_browsers() {
        assert_eq!(escape_quoted("å\r\n\"x\""), "å%0D%0A%22x%22");
        assert_eq!(normalize_newlines("a\nb\r\nc\rd"), "a\r\nb\r\nc\r\nd");
        assert!(matches!(
            normalize_newlines("plain"),
            Cow::Borrowed("plain")
        ));
    }

    #[test]
    fn untyped_or_odd_blobs_default_to_octet_stream() {
        assert_eq!(content_type("image/heic"), "image/heic");
        assert_eq!(content_type(""), "application/octet-stream");
        assert_eq!(
            content_type("image/png\r\nX-Evil: 1"),
            "application/octet-stream"
        );
    }

    #[test]
    fn error_detail_matches_the_fetch_paths_slice() {
        assert_eq!(error_detail(b""), "");
        assert_eq!(error_detail("x".repeat(300).as_bytes()), "x".repeat(160));
        assert_eq!(
            error_detail("\u{feff}{\"ok\":false}".as_bytes()),
            "{\"ok\":false}"
        );
        // 159 units + an emoji (2 units) would exceed 160: the pair is dropped.
        let body = format!("{}😀tail", "a".repeat(159));
        assert_eq!(error_detail(body.as_bytes()), "a".repeat(159));
        assert_eq!(error_detail(&[b'o', b'k', 0xff]), "ok\u{fffd}");
    }

    #[test]
    fn user_agent_matches_the_locked_http_plugin() {
        let lock = include_str!("../../Cargo.lock");
        let version = lock
            .split("[[package]]")
            .find(|p| p.contains("name = \"tauri-plugin-http\"\n"))
            .and_then(|p| p.lines().find_map(|l| l.strip_prefix("version = \"")))
            .and_then(|v| v.strip_suffix('"'))
            .expect("tauri-plugin-http in Cargo.lock");
        assert_eq!(HTTP_USER_AGENT, format!("tauri-plugin-http/{version}"));
    }

    #[tokio::test]
    async fn writes_uploads_to_disk() {
        let dir = std::env::temp_dir().join(format!("uploads-test-{}", random_token()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("big.bin");
        // Larger than tokio's 2 MiB blocking-write chunk.
        let bytes: Vec<u8> = (0..5 * 1024 * 1024 + 7).map(|i| i as u8).collect();
        write_file(&path, &bytes).await.unwrap();
        assert_eq!(tokio::fs::read(&path).await.unwrap(), bytes);
        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }

    #[test]
    fn boundaries_are_valid_and_unique() {
        let (a, b) = (form_boundary(), form_boundary());
        assert_ne!(a, b);
        assert!(a.len() <= 70);
        assert!(a.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'));
    }
}
