//! One IRC network connection, kept alive for as long as the client exists.
//!
//! `IrcClient::start` spawns a task that connects, registers, and reconnects
//! with backoff whenever the link drops — a bouncer keeps the real network
//! session, so a reconnect only costs a replay of what was missed. Everything
//! observable is published as [`IrcUpdate`] on a broadcast channel, the shape
//! the host forwards to the webview, mirroring `slack-core`.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, watch};

use crate::history::{BufferInfo, BufferKind, History, IrcMessage, MessageKind};
use crate::proto::{self, Message};

/// How to reach the server (or bouncer).
#[derive(Debug, Clone)]
pub struct IrcConfig {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub nick: String,
    pub username: String,
    pub realname: String,
    /// Sent as `PASS` — the bouncer password for IRCCloud.
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum IrcUpdate {
    /// Registered with the server; `nick` is what it actually assigned us.
    Connected { nick: String },
    Disconnected { reason: String },
    /// A channel or query appeared: we joined, someone messaged us, `/query`.
    BufferOpened { buffer: BufferInfo },
    /// We left a channel or closed a query.
    BufferClosed { buffer: String },
    Topic { buffer: String, topic: String },
    Message { buffer: BufferInfo, message: IrcMessage },
    /// Something the user should see: a failed send, a refused join, a kick.
    Error { buffer: Option<String>, text: String },
}

/// IRCv3 capabilities we use when the server offers them.
///
/// `server-time` is what makes replayed backlog carry its real timestamps
/// (IRCCloud's bouncer relies on it). `echo-message` sends our own messages
/// back, so what we show is what the server accepted.
const WANTED_CAPS: &[&str] = &[
    "server-time",
    "message-tags",
    "echo-message",
    "multi-prefix",
    "znc.in/server-time-iso",
];

/// Silence on the socket before we probe it with a PING, and after that probe
/// before the link is considered dead.
const IDLE_PING: Duration = Duration::from_secs(90);
const PING_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const BACKOFF_MIN: Duration = Duration::from_secs(2);
const BACKOFF_MAX: Duration = Duration::from_secs(120);

/// Room for `:nick!user@host PRIVMSG target :` within the 512-byte line limit.
/// The host part is unknown to us (a bouncer may cloak it), so be generous.
const LINE_BUDGET: usize = 512 - 2 - 120;

#[derive(Default)]
struct Session {
    connected: bool,
    nick: String,
    /// `CHANTYPES` from ISUPPORT; `#&` until the server says otherwise.
    chantypes: String,
    /// `NETWORK` from ISUPPORT, e.g. "Libera.Chat".
    network: Option<String>,
    caps: HashSet<String>,
    /// Accumulates a multi-line `CAP LS`.
    offered: Vec<String>,
}

struct Inner {
    config: IrcConfig,
    history: History,
    updates: broadcast::Sender<IrcUpdate>,
    session: Mutex<Session>,
    /// Outgoing lines for the live connection; `None` while disconnected.
    out: Mutex<Option<mpsc::UnboundedSender<String>>>,
    shutdown: watch::Sender<bool>,
    local_ids: AtomicU64,
}

pub struct IrcClient {
    inner: Arc<Inner>,
}

impl IrcClient {
    /// Load the local history and start connecting in the background. Must be
    /// called inside a Tokio runtime.
    pub fn start(config: IrcConfig, history: History) -> Self {
        let (updates, _) = broadcast::channel(1024);
        let (shutdown, _) = watch::channel(false);
        let inner = Arc::new(Inner {
            session: Mutex::new(Session {
                nick: config.nick.clone(),
                chantypes: "#&".into(),
                ..Session::default()
            }),
            config,
            history,
            updates,
            out: Mutex::new(None),
            shutdown,
            local_ids: AtomicU64::new(0),
        });
        tokio::spawn(run(Arc::clone(&inner)));
        Self { inner }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<IrcUpdate> {
        self.inner.updates.subscribe()
    }

    pub fn is_connected(&self) -> bool {
        self.inner.session().connected
    }

    pub fn nick(&self) -> String {
        self.inner.session().nick.clone()
    }

    pub fn network_name(&self) -> Option<String> {
        self.inner.session().network.clone()
    }

    pub fn buffers(&self) -> Vec<BufferInfo> {
        self.inner.history.buffers()
    }

    pub fn history(&self, buffer: &str, limit: usize) -> Vec<IrcMessage> {
        self.inner.history.recent(&proto::irc_lower(buffer), limit)
    }

    /// The `limit` messages just older than `before_ts` (epoch millis).
    pub fn history_before(&self, buffer: &str, before_ts: i64, limit: usize) -> Vec<IrcMessage> {
        self.inner.history.before(&proto::irc_lower(buffer), before_ts, limit)
    }

    /// Send what the user typed into `buffer`. Each line is a message, or a
    /// command when it starts with `/` (`//` sends a literal slash).
    pub fn send_input(&self, buffer: &str, text: &str) -> Result<()> {
        let target = self
            .inner
            .history
            .buffer(&proto::irc_lower(buffer))
            .map(|b| b.name)
            .unwrap_or_else(|| buffer.to_string());
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            if let Some(literal) = line.strip_prefix("//") {
                self.inner.privmsg(&target, &format!("/{literal}"), MessageKind::Privmsg)?;
            } else if let Some(command) = line.strip_prefix('/') {
                self.inner.command(&target, command)?;
            } else {
                self.inner.privmsg(&target, line, MessageKind::Privmsg)?;
            }
        }
        Ok(())
    }

    /// Open (or reopen) a query with `nick` without sending anything.
    pub fn open_query(&self, nick: &str) -> Result<BufferInfo> {
        self.inner.open_query(nick)
    }

    /// Merge history from elsewhere (an IRCCloud export) into a buffer,
    /// creating it if needed. Returns how many messages were new.
    pub fn import_history(&self, name: &str, kind: BufferKind, messages: Vec<IrcMessage>) -> usize {
        let info = self.inner.open_buffer(name, kind, false);
        self.inner.history.import(&info.id, messages)
    }

    /// Leave a channel or close a query.
    pub fn close_buffer(&self, buffer: &str) -> Result<()> {
        self.inner.close(buffer, None)
    }

    pub async fn shutdown(&self) {
        let _ = self.inner.shutdown.send(true);
    }
}

impl Drop for IrcClient {
    fn drop(&mut self) {
        let _ = self.inner.shutdown.send(true);
    }
}

impl Inner {
    fn session(&self) -> std::sync::MutexGuard<'_, Session> {
        self.session.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn emit(&self, update: IrcUpdate) {
        // No receivers is fine: nothing is listening yet.
        let _ = self.updates.send(update);
    }

    fn send_raw(&self, line: String) -> Result<()> {
        let out = self.out.lock().unwrap_or_else(|e| e.into_inner());
        let tx = out
            .as_ref()
            .ok_or_else(|| anyhow!("not connected to {}", self.config.host))?;
        tx.send(line).map_err(|_| anyhow!("connection to {} closed", self.config.host))
    }

    fn is_channel(&self, target: &str) -> bool {
        proto::is_channel(target, &self.session().chantypes)
    }

    fn open_buffer(&self, name: &str, kind: BufferKind, authoritative: bool) -> BufferInfo {
        let (info, created) = self
            .history
            .ensure(&proto::irc_lower(name), name, kind, authoritative);
        if created {
            self.emit(IrcUpdate::BufferOpened { buffer: info.clone() });
        }
        info
    }

    fn open_query(&self, nick: &str) -> Result<BufferInfo> {
        let nick = nick.trim();
        if nick.is_empty() || nick.contains([' ', ',', '\r', '\n']) || self.is_channel(nick) {
            bail!("not a nick: {nick:?}");
        }
        Ok(self.open_buffer(nick, BufferKind::Query, false))
    }

    fn close(&self, buffer: &str, reason: Option<&str>) -> Result<()> {
        let id = proto::irc_lower(buffer);
        let info = self.history.buffer(&id);
        let name = info.as_ref().map_or(buffer, |b| b.name.as_str());
        if self.is_channel(name) {
            // The buffer goes when the server confirms with our PART.
            return self.send_raw(proto::build("PART", &[name, reason.unwrap_or("")]));
        }
        if self.history.remove(&id) {
            self.emit(IrcUpdate::BufferClosed { buffer: id });
        }
        Ok(())
    }

    fn privmsg(&self, target: &str, text: &str, kind: MessageKind) -> Result<()> {
        if target.is_empty() {
            bail!("no target to send to");
        }
        if text.trim().is_empty() {
            bail!("nothing to send");
        }
        let (command, wrap): (&str, fn(&str) -> String) = match kind {
            MessageKind::Privmsg => ("PRIVMSG", |t| t.to_string()),
            MessageKind::Notice => ("NOTICE", |t| t.to_string()),
            MessageKind::Action => ("PRIVMSG", |t| format!("\x01ACTION {t}\x01")),
        };
        let budget = LINE_BUDGET.saturating_sub(target.len() + 10).max(64);
        let echoes = self.session().caps.contains("echo-message");
        let buffer_kind = if self.is_channel(target) {
            BufferKind::Channel
        } else {
            BufferKind::Query
        };
        for chunk in proto::split_message(text, budget) {
            self.send_raw(proto::build(command, &[target, &wrap(&chunk)]))?;
            // Without echo-message the server never shows us our own line, so
            // record it here; with it, the echo is the record.
            if !echoes {
                let buffer = self.open_buffer(target, buffer_kind, false);
                let n = self.local_ids.fetch_add(1, Ordering::Relaxed);
                let ts = chrono::Utc::now().timestamp_millis();
                let message = IrcMessage {
                    id: format!("local-{ts}-{n}"),
                    ts,
                    from: self.session().nick.clone(),
                    text: chunk,
                    kind,
                    is_self: true,
                    highlight: false,
                };
                self.record(buffer, message);
            }
        }
        Ok(())
    }

    fn record(&self, buffer: BufferInfo, message: IrcMessage) {
        if self.history.append(&buffer.id, &message) {
            let buffer = self.history.buffer(&buffer.id).unwrap_or(buffer);
            self.emit(IrcUpdate::Message { buffer, message });
        }
    }

    /// A `/command` typed into `current`.
    fn command(&self, current: &str, input: &str) -> Result<()> {
        let (verb, args) = input.split_once(' ').unwrap_or((input, ""));
        let args = args.trim();
        let in_channel = self.is_channel(current);
        match verb.to_ascii_lowercase().as_str() {
            "me" => self.privmsg(current, args, MessageKind::Action),
            "msg" | "query" => {
                let (nick, text) = args.split_once(' ').unwrap_or((args, ""));
                if nick.is_empty() {
                    bail!("usage: /{verb} <nick> [message]");
                }
                if self.is_channel(nick) {
                    return self.privmsg(nick, text, MessageKind::Privmsg);
                }
                self.open_query(nick)?;
                if text.trim().is_empty() {
                    Ok(())
                } else {
                    self.privmsg(nick, text, MessageKind::Privmsg)
                }
            }
            "notice" => {
                let (target, text) = args
                    .split_once(' ')
                    .ok_or_else(|| anyhow!("usage: /notice <target> <message>"))?;
                self.privmsg(target, text, MessageKind::Notice)
            }
            "join" | "j" => {
                let (channels, key) = args.split_once(' ').unwrap_or((args, ""));
                if channels.is_empty() {
                    bail!("usage: /join <#channel> [key]");
                }
                if key.is_empty() {
                    self.send_raw(proto::build("JOIN", &[channels]))
                } else {
                    self.send_raw(proto::build("JOIN", &[channels, key]))
                }
            }
            "part" | "leave" => {
                let (channel, reason) = match args.split_once(' ') {
                    Some((first, rest)) if self.is_channel(first) => (first, rest),
                    None if self.is_channel(args) => (args, ""),
                    _ if in_channel => (current, args),
                    _ => bail!("usage: /part [#channel] [reason]"),
                };
                self.send_raw(proto::build("PART", &[channel, reason]))
            }
            "close" => self.close(current, (!args.is_empty()).then_some(args)),
            "topic" => {
                if !in_channel {
                    bail!("/topic only works in a channel");
                }
                if args.is_empty() {
                    self.send_raw(proto::build("TOPIC", &[current]))
                } else {
                    self.send_raw(proto::build("TOPIC", &[current, args]))
                }
            }
            "nick" if !args.is_empty() => self.send_raw(proto::build("NICK", &[args])),
            "quote" | "raw" if !args.is_empty() => {
                // build() with no params still strips CR/LF from nothing, so
                // sanitise the raw line here: one line, one command.
                let line: String = args.chars().filter(|c| !matches!(c, '\r' | '\n' | '\0')).collect();
                self.send_raw(line)
            }
            _ => bail!("unknown command /{verb} — start the line with // to send it as text, or use /quote"),
        }
    }

    // --- incoming ---------------------------------------------------------

    fn handle(&self, msg: Message) -> Result<()> {
        match msg.command.as_str() {
            "PING" => {
                let token = msg.param(0).unwrap_or("");
                self.send_raw(proto::build("PONG", &[token]))?;
            }
            "CAP" => self.handle_cap(&msg)?,
            "001" => {
                let nick = msg.param(0).unwrap_or_default().to_string();
                {
                    let mut s = self.session();
                    s.connected = true;
                    s.nick = nick.clone();
                }
                tracing::info!("irc: registered on {} as {nick}", self.config.host);
                self.emit(IrcUpdate::Connected { nick });
            }
            "005" => {
                let mut s = self.session();
                // Params: <nick> TOKEN[=value]... :are supported by this server
                for token in msg.params.iter().skip(1).take(msg.params.len().saturating_sub(2)) {
                    if let Some(v) = token.strip_prefix("CHANTYPES=") {
                        s.chantypes = v.to_string();
                    } else if let Some(v) = token.strip_prefix("NETWORK=") {
                        s.network = Some(v.to_string());
                    }
                }
            }
            "433" if !self.session().connected => {
                // Nick taken during registration: append underscores until one sticks.
                let next = format!("{}_", msg.param(1).unwrap_or(self.config.nick.as_str()));
                self.session().nick = next.clone();
                self.send_raw(proto::build("NICK", &[&next]))?;
            }
            "NICK" => {
                let new = msg.param(0).unwrap_or_default().to_string();
                if self.is_self(msg.source_nick()) {
                    self.session().nick = new;
                }
            }
            "JOIN" => {
                let channel = msg.param(0).unwrap_or_default();
                if self.is_self(msg.source_nick()) && !channel.is_empty() {
                    self.open_buffer(channel, BufferKind::Channel, true);
                }
            }
            "PART" => {
                let channel = msg.param(0).unwrap_or_default();
                if self.is_self(msg.source_nick()) {
                    let id = proto::irc_lower(channel);
                    if self.history.remove(&id) {
                        self.emit(IrcUpdate::BufferClosed { buffer: id });
                    }
                }
            }
            "KICK" => {
                let channel = msg.param(0).unwrap_or_default();
                if self.is_self(msg.param(1)) {
                    let by = msg.source_nick().unwrap_or("someone");
                    let reason = msg.param(2).unwrap_or("");
                    self.emit(IrcUpdate::Error {
                        buffer: Some(proto::irc_lower(channel)),
                        text: format!("Kicked from {channel} by {by}: {reason}"),
                    });
                    let id = proto::irc_lower(channel);
                    if self.history.remove(&id) {
                        self.emit(IrcUpdate::BufferClosed { buffer: id });
                    }
                }
            }
            "332" => {
                if let (Some(channel), Some(topic)) = (msg.param(1), msg.param(2)) {
                    self.set_topic(channel, topic);
                }
            }
            "TOPIC" => {
                if let (Some(channel), Some(topic)) = (msg.param(0), msg.param(1)) {
                    self.set_topic(channel, topic);
                }
            }
            "PRIVMSG" | "NOTICE" => self.handle_chat(&msg),
            // Errors worth showing: no such nick/channel, can't send, can't join.
            "401" | "403" | "404" | "405" | "471" | "473" | "474" | "475" | "477" | "482" => {
                let target = msg.param(1).map(proto::irc_lower);
                let reason = msg.params.last().cloned().unwrap_or_default();
                let subject = msg.param(1).unwrap_or("");
                self.emit(IrcUpdate::Error {
                    buffer: target,
                    text: format!("{subject}: {reason}"),
                });
            }
            "464" => {
                self.emit(IrcUpdate::Error {
                    buffer: None,
                    text: format!(
                        "{} refused the password: {}",
                        self.config.host,
                        msg.params.last().cloned().unwrap_or_default()
                    ),
                });
            }
            "ERROR" => {
                tracing::warn!("irc: server error: {}", msg.param(0).unwrap_or(""));
            }
            _ => {}
        }
        Ok(())
    }

    fn is_self(&self, nick: Option<&str>) -> bool {
        nick.is_some_and(|n| proto::irc_lower(n) == proto::irc_lower(&self.session().nick))
    }

    fn set_topic(&self, channel: &str, topic: &str) {
        let id = proto::irc_lower(channel);
        let topic = proto::strip_formatting(topic);
        self.history.set_topic(&id, &topic);
        self.emit(IrcUpdate::Topic { buffer: id, topic });
    }

    fn handle_cap(&self, msg: &Message) -> Result<()> {
        // CAP <nick|*> <sub> [*] :<caps>
        match msg.param(1).unwrap_or_default().to_ascii_uppercase().as_str() {
            "LS" => {
                let more = msg.param(2) == Some("*");
                let list = if more { msg.param(3) } else { msg.param(2) };
                let mut s = self.session();
                s.offered.extend(
                    list.unwrap_or_default()
                        .split(' ')
                        .filter(|c| !c.is_empty())
                        // 302 values ("sasl=PLAIN") don't matter for what we request.
                        .map(|c| c.split_once('=').map_or(c, |(name, _)| name).to_string()),
                );
                if more {
                    return Ok(());
                }
                let wanted: Vec<&str> = WANTED_CAPS
                    .iter()
                    .copied()
                    .filter(|w| s.offered.iter().any(|o| o == w))
                    .collect();
                s.offered.clear();
                drop(s);
                if wanted.is_empty() {
                    self.send_raw("CAP END".into())?;
                } else {
                    self.send_raw(proto::build("CAP", &["REQ", &wanted.join(" ")]))?;
                }
            }
            "ACK" => {
                let acked = msg.params.last().cloned().unwrap_or_default();
                {
                    let mut s = self.session();
                    for cap in acked.split(' ').filter(|c| !c.is_empty()) {
                        match cap.strip_prefix('-') {
                            Some(removed) => {
                                s.caps.remove(removed);
                            }
                            None => {
                                s.caps.insert(cap.to_string());
                            }
                        }
                    }
                }
                if !self.session().connected {
                    self.send_raw("CAP END".into())?;
                }
            }
            "NAK" if !self.session().connected => self.send_raw("CAP END".into())?,
            _ => {}
        }
        Ok(())
    }

    fn handle_chat(&self, msg: &Message) {
        let (Some(raw_target), Some(raw_text)) = (msg.param(0), msg.param(1)) else {
            return;
        };
        let notice = msg.command == "NOTICE";

        // Server notices (no nick!user@host) are connection chatter, not a
        // conversation — keep them out of the chat list.
        if !msg.from_user() {
            tracing::info!("irc: {} notice: {raw_text}", self.config.host);
            return;
        }
        let from = msg.source_nick().unwrap_or_default().to_string();
        let is_self = self.is_self(Some(&from));

        // STATUSMSG targets ("@#chan" = ops only) belong to the channel.
        let target = raw_target.trim_start_matches(['@', '+', '%', '~', '&']);
        let target = if self.is_channel(target) { target } else { raw_target };

        let (text, kind) = match proto::parse_ctcp(raw_text) {
            Some((verb, args)) if verb.eq_ignore_ascii_case("ACTION") => (args, MessageKind::Action),
            // Other CTCP (VERSION, PING, …) is client plumbing; the bouncer
            // answers it for us.
            Some(_) => return,
            None if notice => (raw_text, MessageKind::Notice),
            None => (raw_text, MessageKind::Privmsg),
        };
        let text = proto::strip_formatting(text);

        let (buffer_name, buffer_kind) = if self.is_channel(target) {
            (target.to_string(), BufferKind::Channel)
        } else if is_self {
            // Our own message to someone, echoed back or replayed.
            (target.to_string(), BufferKind::Query)
        } else {
            (from.clone(), BufferKind::Query)
        };

        let ts = msg
            .tags
            .get("time")
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.timestamp_millis())
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        let id = msg
            .tags
            .get("msgid")
            .filter(|id| !id.is_empty())
            .cloned()
            .unwrap_or_else(|| content_id(ts, &from, &buffer_name, &text, kind));
        let highlight = !is_self
            && (buffer_kind == BufferKind::Query || proto::mentions(&text, &self.session().nick));

        // A query named after the sender's own prefix has their real spelling.
        let authoritative = buffer_kind == BufferKind::Query && !is_self;
        let buffer = self.open_buffer(&buffer_name, buffer_kind, authoritative);
        self.record(
            buffer,
            IrcMessage {
                id,
                ts,
                from,
                text,
                kind,
                is_self,
                highlight,
            },
        );
    }
}

/// Stable id for a message the server sent without a `msgid`. With
/// server-time, a replay of the same line hashes the same and is deduped.
pub(crate) fn content_id(ts: i64, from: &str, buffer: &str, text: &str, kind: MessageKind) -> String {
    // FNV-1a: stable across Rust versions, unlike DefaultHasher.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let kind = match kind {
        MessageKind::Privmsg => "p",
        MessageKind::Action => "a",
        MessageKind::Notice => "n",
    };
    for part in [&ts.to_string(), from, &proto::irc_lower(buffer), text, kind] {
        for byte in part.bytes().chain(std::iter::once(0)) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("h{hash:016x}")
}

// --- connection loop ----------------------------------------------------------

async fn run(inner: Arc<Inner>) {
    let mut shutdown = inner.shutdown.subscribe();
    let mut backoff = BACKOFF_MIN;
    loop {
        if *shutdown.borrow() {
            break;
        }
        let result = session(&inner, &mut shutdown).await;
        let was_registered = inner.session().connected;
        {
            let mut s = inner.session();
            s.connected = false;
            s.caps.clear();
            s.offered.clear();
            s.nick = inner.config.nick.clone();
        }
        *inner.out.lock().unwrap_or_else(|e| e.into_inner()) = None;

        match result {
            Ok(()) => break, // shutdown requested
            Err(e) => {
                tracing::warn!("irc: {} disconnected: {e:#}", inner.config.host);
                inner.emit(IrcUpdate::Disconnected {
                    reason: format!("{e:#}"),
                });
            }
        }
        if was_registered {
            backoff = BACKOFF_MIN;
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = shutdown.changed() => {}
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
    tracing::info!("irc: {} stopped", inner.config.host);
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

async fn connect(config: &IrcConfig) -> Result<Box<dyn Stream>> {
    let addr = (config.host.as_str(), config.port);
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr))
        .await
        .map_err(|_| anyhow!("timed out connecting to {}:{}", config.host, config.port))?
        .with_context(|| format!("could not connect to {}:{}", config.host, config.port))?;
    let _ = tcp.set_nodelay(true);
    if !config.tls {
        return Ok(Box::new(tcp));
    }
    let server_name = rustls::pki_types::ServerName::try_from(config.host.clone())
        .map_err(|_| anyhow!("{} is not a valid TLS server name", config.host))?;
    let tls = tokio::time::timeout(CONNECT_TIMEOUT, tls_connector()?.connect(server_name, tcp))
        .await
        .map_err(|_| anyhow!("TLS handshake with {} timed out", config.host))?
        .with_context(|| format!("TLS handshake with {} failed", config.host))?;
    Ok(Box::new(tls))
}

fn tls_connector() -> Result<tokio_rustls::TlsConnector> {
    Ok(tokio_rustls::TlsConnector::from(tls_config()?))
}

/// Client TLS config on the system's roots. Shared with the IRCCloud importer,
/// whose websocket needs the same thing.
pub(crate) fn tls_config() -> Result<Arc<rustls::ClientConfig>> {
    // The system's roots, like tokio-tungstenite's rustls-tls-native-roots in
    // the Slack path: a corporate or self-signed CA the user trusts works too.
    let mut roots = rustls::RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    for cert in native.certs {
        let _ = roots.add(cert);
    }
    if roots.is_empty() {
        bail!("no trusted root certificates found on this system");
    }
    // Explicit provider: the process may have both ring and aws-lc linked in
    // through other crates, and then rustls refuses to pick a default.
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(Arc::new(config))
}

/// One connection, from TCP connect to disconnect. `Ok` only on shutdown.
async fn session(inner: &Arc<Inner>, shutdown: &mut watch::Receiver<bool>) -> Result<()> {
    let config = &inner.config;
    let stream = connect(config).await?;
    let (read, mut write) = tokio::io::split(stream);

    // Reading lines on its own task keeps the select below cancel-safe: an
    // mpsc recv loses nothing when another branch wins, a half-read line would.
    let (line_tx, mut lines) = mpsc::channel::<std::io::Result<Vec<u8>>>(256);
    let reader = tokio::spawn(async move {
        let mut read = BufReader::new(read);
        loop {
            let mut buf = Vec::with_capacity(512);
            let result = read.read_until(b'\n', &mut buf).await;
            let eof = matches!(result, Ok(0));
            let failed = result.is_err();
            let item = result.map(|_| buf);
            if eof || line_tx.send(item).await.is_err() || failed {
                break;
            }
        }
    });

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    *inner.out.lock().unwrap_or_else(|e| e.into_inner()) = Some(out_tx.clone());

    // Registration. CAP LS first holds registration open until CAP END, so
    // the capabilities are in place before any backlog is replayed.
    let _ = out_tx.send("CAP LS 302".into());
    if let Some(pass) = config.password.as_deref().filter(|p| !p.is_empty()) {
        let _ = out_tx.send(proto::build("PASS", &[pass]));
    }
    let _ = out_tx.send(proto::build("NICK", &[&config.nick]));
    let _ = out_tx.send(proto::build("USER", &[&config.username, "0", "*", &config.realname]));

    let mut awaiting_pong = false;
    let result = loop {
        let idle = if awaiting_pong { PING_TIMEOUT } else { IDLE_PING };
        tokio::select! {
            line = lines.recv() => match line {
                Some(Ok(bytes)) => {
                    awaiting_pong = false;
                    let text = proto::decode_line(&bytes);
                    if let Some(msg) = Message::parse(&text) {
                        if let Err(e) = inner.handle(msg) {
                            break Err(e);
                        }
                    }
                }
                Some(Err(e)) => break Err(anyhow!(e).context("read failed")),
                None => break Err(anyhow!("server closed the connection")),
            },
            Some(line) = out_rx.recv() => {
                let mut bytes = line.into_bytes();
                bytes.extend_from_slice(b"\r\n");
                if let Err(e) = write.write_all(&bytes).await {
                    break Err(anyhow!(e).context("write failed"));
                }
            },
            _ = tokio::time::sleep(idle) => {
                if awaiting_pong {
                    break Err(anyhow!("no reply from {} in {}s", config.host, PING_TIMEOUT.as_secs()));
                }
                awaiting_pong = true;
                let _ = out_tx.send(proto::build("PING", &["keepalive"]));
            },
            _ = shutdown.changed() => {
                let _ = write.write_all(b"QUIT :bye\r\n").await;
                let _ = write.flush().await;
                break Ok(());
            },
        }
    };
    reader.abort();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_id_is_stable_and_distinguishes_messages() {
        let a = content_id(1, "anna", "#Rust", "hi", MessageKind::Privmsg);
        assert_eq!(a, content_id(1, "anna", "#rust", "hi", MessageKind::Privmsg));
        assert_ne!(a, content_id(2, "anna", "#rust", "hi", MessageKind::Privmsg));
        assert_ne!(a, content_id(1, "anna", "#rust", "hi", MessageKind::Action));
        // Field boundaries matter: "ab"+"c" is not "a"+"bc".
        assert_ne!(
            content_id(1, "ab", "c", "x", MessageKind::Privmsg),
            content_id(1, "a", "bc", "x", MessageKind::Privmsg)
        );
    }
}
