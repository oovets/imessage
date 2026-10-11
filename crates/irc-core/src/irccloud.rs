//! One-time history import from IRCCloud's own API.
//!
//! IRCCloud's bouncer only replays what a client id hasn't seen yet, and has no
//! history command, so what IRCCloud stored before the network was added here
//! is only reachable through the API its web and mobile apps use. That API is
//! not documented; this follows IRCCloud's open-source Android client:
//!
//! 1. `POST /chat/auth-formtoken`, then `POST /chat/login` (email, password,
//!    token) → a session, plus the account's shard (`api_host`,
//!    `websocket_path`).
//! 2. Open the websocket stream and authenticate with the session. It answers
//!    with `oob_include`: a URL, valid while the stream stays open, holding
//!    every network (`makeserver`) and buffer (`makebuffer`).
//! 3. Page `GET /chat/backlog?cid=&bid=&beforeid=` backwards per buffer. Pages
//!    hold every event (joins, quits, modes), oldest first, at most 100.
//!
//! Nothing is stored: the session lives for the duration of the import.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::client::content_id;
use crate::history::{BufferKind, IrcMessage, MessageKind};
use crate::proto;

const DEFAULT_API: &str = "https://api.irccloud.com";
const USER_AGENT: &str = "messages-desktop (history import)";
/// Events per backlog page; the server caps it at 100.
const PAGE: usize = 100;
const TIMEOUT: Duration = Duration::from_secs(30);

/// Email and password, as read from `~/.irc`.
#[derive(Clone)]
pub struct Credentials {
    pub email: String,
    pub password: String,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials").field("email", &self.email).finish_non_exhaustive()
    }
}

/// Parse a `key: value` credentials file. `uid`/`email`/`user` name the
/// login, `pw`/`password`/`pass` the password; `=` works as a separator too.
pub fn parse_credentials(text: &str) -> Result<Credentials> {
    let mut email = None;
    let mut password = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once([':', '=']) else {
            continue;
        };
        let value = value.trim().to_string();
        match key.trim().to_ascii_lowercase().as_str() {
            "uid" | "email" | "user" | "login" => email = Some(value),
            "pw" | "password" | "pass" => password = Some(value),
            _ => {}
        }
    }
    match (email, password) {
        (Some(email), Some(password)) if !email.is_empty() && !password.is_empty() => {
            Ok(Credentials { email, password })
        }
        _ => bail!("expected `uid: <email>` and `pw: <password>` lines"),
    }
}

#[derive(Debug, Clone)]
pub struct CloudBuffer {
    pub bid: i64,
    pub name: String,
    pub kind: BufferKind,
}

#[derive(Debug, Clone)]
pub struct CloudServer {
    pub cid: i64,
    pub name: String,
    pub hostname: String,
    pub buffers: Vec<CloudBuffer>,
}

/// The IRCCloud network whose channels best match `channels` (the ones the
/// bouncer joined for us) — one bouncer password is one IRCCloud network, so
/// the overlap identifies it. `None` when nothing overlaps or two tie.
pub fn pick_server<'a>(servers: &'a [CloudServer], channels: &[String]) -> Option<&'a CloudServer> {
    let wanted: std::collections::HashSet<String> =
        channels.iter().map(|c| proto::irc_lower(c)).collect();
    let mut scored: Vec<(usize, &CloudServer)> = servers
        .iter()
        .map(|s| {
            let overlap = s
                .buffers
                .iter()
                .filter(|b| b.kind == BufferKind::Channel && wanted.contains(&proto::irc_lower(&b.name)))
                .count();
            (overlap, s)
        })
        .filter(|(overlap, _)| *overlap > 0)
        .collect();
    scored.sort_by_key(|(overlap, _)| std::cmp::Reverse(*overlap));
    match scored.as_slice() {
        [] => None,
        [(_, only)] => Some(only),
        [(best, s), (second, _), ..] if best > second => Some(s),
        _ => None,
    }
}

/// One IRCCloud event as a chat message, if it is one: a message, an action
/// or a notice from someone. Joins, quits, modes and the like are not.
pub fn event_to_message(ev: &Value, buffer_name: &str) -> Option<IrcMessage> {
    let kind = match ev.get("type")?.as_str()? {
        "buffer_msg" => MessageKind::Privmsg,
        "buffer_me_msg" => MessageKind::Action,
        "notice" => MessageKind::Notice,
        _ => return None,
    };
    let from = ev.get("from").and_then(Value::as_str).filter(|f| !f.is_empty())?;
    let text = proto::strip_formatting(ev.get("msg").and_then(Value::as_str)?);
    // eid is the event time in microseconds.
    let ts = ev.get("eid").and_then(Value::as_i64)? / 1000;
    let flag = |key: &str| ev.get(key).and_then(Value::as_bool).unwrap_or(false);
    let is_self = flag("self");
    Some(IrcMessage {
        // The same hash the live path uses for a line without a msgid, so a
        // bouncer replay of the same line with the same time is the same id.
        id: content_id(ts, from, buffer_name, &text, kind),
        ts,
        from: from.to_string(),
        text,
        kind,
        is_self,
        highlight: !is_self && flag("highlight"),
    })
}

/// A logged-in IRCCloud session.
pub struct Session {
    http: reqwest::Client,
    cookie: String,
    api: String,
    websocket: String,
}

impl Session {
    pub async fn login(creds: &Credentials) -> Result<Session> {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(TIMEOUT)
            .build()?;
        let token: Value = http
            .post(format!("{DEFAULT_API}/chat/auth-formtoken"))
            .send()
            .await
            .context("could not reach IRCCloud")?
            .json()
            .await?;
        let token = token
            .get("token")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("IRCCloud gave no login token"))?
            .to_string();

        let login: Value = http
            .post(format!("{DEFAULT_API}/chat/login"))
            .header("x-auth-formtoken", &token)
            .form(&[
                ("email", creds.email.as_str()),
                ("password", creds.password.as_str()),
                ("token", token.as_str()),
            ])
            .send()
            .await?
            .json()
            .await?;
        let Some(session) = login.get("session").and_then(Value::as_str) else {
            let why = login.get("message").and_then(Value::as_str).unwrap_or("unknown reason");
            bail!("IRCCloud login failed ({why}) — check uid (your email) and pw in ~/.irc");
        };
        let api = login
            .get("api_host")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_API)
            .trim_end_matches('/')
            .to_string();
        let path = login.get("websocket_path").and_then(Value::as_str).unwrap_or("/");
        let websocket = format!("{}{path}", api.replacen("https://", "wss://", 1));
        Ok(Session {
            http,
            cookie: format!("session={session}"),
            api,
            websocket,
        })
    }

    /// Every network and its (non-archived) channels and queries.
    pub async fn servers(&self) -> Result<Vec<CloudServer>> {
        let mut request = format!("{}?exclude_archives=1&limit=1", self.websocket).into_client_request()?;
        let headers = request.headers_mut();
        headers.insert("Origin", HeaderValue::from_static("https://www.irccloud.com"));
        headers.insert("User-Agent", HeaderValue::from_static(USER_AGENT));
        headers.insert("Cookie", HeaderValue::from_str(&self.cookie)?);
        let connector = tokio_tungstenite::Connector::Rustls(crate::client::tls_config()?);
        let (mut ws, _) = tokio::time::timeout(
            TIMEOUT,
            tokio_tungstenite::connect_async_tls_with_config(request, None, false, Some(connector)),
        )
        .await
        .map_err(|_| anyhow!("IRCCloud stream timed out"))?
        .context("could not open the IRCCloud stream")?;

        let auth = serde_json::json!({
            "_reqid": 1,
            "_method": "auth",
            "cookie": self.cookie.trim_start_matches("session="),
        });
        ws.send(WsMessage::text(auth.to_string())).await?;

        // The stream announces the out-of-band snapshot, which is only served
        // while the stream is open — so fetch it before closing.
        let oob_url = tokio::time::timeout(TIMEOUT, async {
            while let Some(frame) = ws.next().await {
                let WsMessage::Text(text) = frame? else { continue };
                let Ok(ev) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                if ev.get("success") == Some(&Value::Bool(false)) {
                    let why = ev.get("message").and_then(Value::as_str).unwrap_or("?");
                    bail!("IRCCloud refused the stream: {why}");
                }
                if ev.get("type").and_then(Value::as_str) == Some("oob_include") {
                    let host = ev.get("api_host").and_then(Value::as_str).unwrap_or(&self.api);
                    let url = ev.get("url").and_then(Value::as_str).unwrap_or_default();
                    return Ok(format!("{}{url}", host.trim_end_matches('/')));
                }
            }
            bail!("IRCCloud closed the stream before sending its snapshot")
        })
        .await
        .map_err(|_| anyhow!("IRCCloud sent no snapshot"))??;

        let snapshot = self.get_json(&oob_url).await;
        let _ = ws.close(None).await;
        Ok(parse_servers(&snapshot?))
    }

    /// Up to `want` messages from one buffer, newest last, paging back through
    /// at most `max_pages` pages. `progress` gets the running message count.
    pub async fn backlog(
        &self,
        cid: i64,
        buffer: &CloudBuffer,
        want: usize,
        max_pages: usize,
        mut progress: impl FnMut(usize),
    ) -> Result<Vec<IrcMessage>> {
        let mut messages = Vec::new();
        let mut before: Option<i64> = None;
        // `beforeid` is inclusive: each page repeats the previous page's oldest
        // event, so dedupe on the event id.
        let mut seen = std::collections::HashSet::new();
        for _ in 0..max_pages {
            let mut url = format!(
                "{}/chat/backlog?cid={cid}&bid={}&num={PAGE}",
                self.api, buffer.bid
            );
            if let Some(eid) = before {
                url.push_str(&format!("&beforeid={eid}"));
            }
            let page = self.get_json(&url).await?;
            let Some(events) = page.as_array().filter(|p| !p.is_empty()) else {
                break;
            };
            let oldest = events.iter().filter_map(|e| e.get("eid")?.as_i64()).min();
            messages.extend(
                events
                    .iter()
                    .filter(|e| e.get("eid").and_then(Value::as_i64).is_some_and(|eid| seen.insert(eid)))
                    .filter_map(|e| event_to_message(e, &buffer.name)),
            );
            progress(messages.len());
            match oldest {
                // Stop when the page didn't move us back (the start of the buffer).
                Some(eid) if before.is_none_or(|b| eid < b) => before = Some(eid),
                _ => break,
            }
            if messages.len() >= want || events.len() < PAGE {
                break;
            }
        }
        messages.sort_by_key(|m| m.ts);
        let skip = messages.len().saturating_sub(want);
        Ok(messages.split_off(skip))
    }

    async fn get_json(&self, url: &str) -> Result<Value> {
        let response = self
            .http
            .get(url)
            .header("Cookie", &self.cookie)
            .header("Accept", "application/json")
            .send()
            .await?;
        let status = response.status();
        let body: Value = response.json().await?;
        if !status.is_success() || body.get("success") == Some(&Value::Bool(false)) {
            let why = body.get("message").and_then(Value::as_str).unwrap_or("");
            bail!("IRCCloud answered {status} {why}");
        }
        Ok(body)
    }
}

fn parse_servers(snapshot: &Value) -> Vec<CloudServer> {
    let events = snapshot.as_array().map(Vec::as_slice).unwrap_or_default();
    let mut servers: Vec<CloudServer> = events
        .iter()
        .filter(|e| e.get("type").and_then(Value::as_str) == Some("makeserver"))
        .filter_map(|e| {
            Some(CloudServer {
                cid: e.get("cid")?.as_i64()?,
                name: e.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                hostname: e.get("hostname").and_then(Value::as_str).unwrap_or_default().to_string(),
                buffers: Vec::new(),
            })
        })
        .collect();
    for e in events {
        if e.get("type").and_then(Value::as_str) != Some("makebuffer") {
            continue;
        }
        if e.get("archived").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let kind = match e.get("buffer_type").and_then(Value::as_str) {
            Some("channel") => BufferKind::Channel,
            Some("conversation") => BufferKind::Query,
            _ => continue, // the console
        };
        let (Some(cid), Some(bid), Some(name)) = (
            e.get("cid").and_then(Value::as_i64),
            e.get("bid").and_then(Value::as_i64),
            e.get("name").and_then(Value::as_str),
        ) else {
            continue;
        };
        if let Some(server) = servers.iter_mut().find(|s| s.cid == cid) {
            server.buffers.push(CloudBuffer {
                bid,
                name: name.to_string(),
                kind,
            });
        }
    }
    servers
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_irc_credentials_file() {
        let c = parse_credentials("uid: me@example.com\npw: hunter2 \n").unwrap();
        assert_eq!((c.email.as_str(), c.password.as_str()), ("me@example.com", "hunter2"));
        // A password may itself contain the separator.
        let c = parse_credentials("email=me@example.com\npassword=a:b=c").unwrap();
        assert_eq!(c.password, "a:b=c");
        assert!(parse_credentials("uid: me@example.com\n").is_err());
        // Never print the password.
        assert!(!format!("{c:?}").contains("a:b=c"));
    }

    #[test]
    fn turns_message_events_into_messages() {
        let ev = json!({
            "type": "buffer_msg", "eid": 1_791_633_253_993_220_i64, "from": "anna",
            "msg": "\u{2}hej\u{2} stevoo", "chan": "#isp", "highlight": true,
        });
        let m = event_to_message(&ev, "#isp").unwrap();
        assert_eq!(m.ts, 1_791_633_253_993);
        assert_eq!(m.text, "hej stevoo");
        assert_eq!(m.kind, MessageKind::Privmsg);
        assert!(m.highlight && !m.is_self);
        // Same id as the live path computes for the same line.
        assert_eq!(m.id, content_id(m.ts, "anna", "#ISP", "hej stevoo", MessageKind::Privmsg));

        let me = json!({"type": "buffer_me_msg", "eid": 5000, "from": "me", "msg": "waves", "self": true, "highlight": true});
        let m = event_to_message(&me, "#isp").unwrap();
        assert_eq!(m.kind, MessageKind::Action);
        assert!(m.is_self && !m.highlight);

        for skip in [
            json!({"type": "joined_channel", "eid": 1, "nick": "anna"}),
            json!({"type": "notice", "eid": 1, "msg": "server says"}), // no sender
            json!({"type": "buffer_msg", "from": "anna", "msg": "no eid"}),
        ] {
            assert!(event_to_message(&skip, "#isp").is_none(), "{skip}");
        }
    }

    fn server(cid: i64, channels: &[&str]) -> CloudServer {
        CloudServer {
            cid,
            name: format!("net{cid}"),
            hostname: String::new(),
            buffers: channels
                .iter()
                .enumerate()
                .map(|(i, c)| CloudBuffer {
                    bid: i as i64,
                    name: c.to_string(),
                    kind: if c.starts_with('#') { BufferKind::Channel } else { BufferKind::Query },
                })
                .collect(),
        }
    }

    #[test]
    fn picks_the_network_by_channel_overlap() {
        let servers = [
            server(1, &["#weechat", "#isp"]),
            server(2, &["#ISP", "#netnod", "#sthix", "anna"]),
        ];
        let ours = ["#isp".to_string(), "#netnod".to_string(), "#sthix".to_string()];
        assert_eq!(pick_server(&servers, &ours).unwrap().cid, 2);
        assert!(pick_server(&servers, &["#nowhere".to_string()]).is_none());
        // A tie is ambiguous, not a guess.
        assert!(pick_server(&servers, &["#isp".to_string()]).is_none());
    }

    #[test]
    fn parses_the_snapshot() {
        let snapshot = json!([
            {"type": "backlog_starts"},
            {"type": "makeserver", "cid": 7, "name": "IRCnet", "hostname": "irc.swepipe.net"},
            {"type": "makebuffer", "cid": 7, "bid": 1, "name": "*", "buffer_type": "console"},
            {"type": "makebuffer", "cid": 7, "bid": 2, "name": "#isp", "buffer_type": "channel", "archived": false},
            {"type": "makebuffer", "cid": 7, "bid": 3, "name": "#old", "buffer_type": "channel", "archived": true},
            {"type": "makebuffer", "cid": 7, "bid": 4, "name": "anna", "buffer_type": "conversation"},
            {"type": "makebuffer", "cid": 9, "bid": 5, "name": "#orphan", "buffer_type": "channel"},
        ]);
        let servers = parse_servers(&snapshot);
        assert_eq!(servers.len(), 1);
        let names: Vec<_> = servers[0].buffers.iter().map(|b| (b.name.as_str(), b.kind)).collect();
        assert_eq!(names, vec![("#isp", BufferKind::Channel), ("anna", BufferKind::Query)]);
    }
}
