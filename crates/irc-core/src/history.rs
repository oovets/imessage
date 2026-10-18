//! Local scrollback for one network.
//!
//! IRC has no history API the way Slack's `conversations.history` is one: a
//! bouncer replays what this client missed on connect (IRCCloud does it per
//! client id) and then the messages are gone from the wire. So the client
//! keeps its own log, which is what lets a chat open with history and what
//! lets a conversation survive a restart.
//!
//! Layout under the network's directory:
//! - `buffers.json` — the known channels and queries, with name and topic.
//! - `<hex of buffer id>.jsonl` — one message per line, oldest first. Hex keeps
//!   `#`, `|` and friends out of file names on every platform.
//!
//! The most recent [`KEEP`] messages per buffer are held in memory and served
//! from there. A log is compacted down to those when it grows past [`COMPACT_AT`]
//! lines, so the disk footprint stays bounded too.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Messages kept in memory, and on disk after compaction, per buffer.
pub const KEEP: usize = 500;
/// Log length (lines) that triggers compaction on load.
const COMPACT_AT: usize = KEEP * 4;
/// How far apart two otherwise identical messages may be and still be one.
pub const NEAR_DUPLICATE_MS: i64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BufferKind {
    Channel,
    Query,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageKind {
    Privmsg,
    Action,
    Notice,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IrcMessage {
    /// `msgid` from the server when it sends one, else a hash of the content
    /// and server-time — stable across replays, which is what dedupes them.
    pub id: String,
    /// Epoch millis.
    pub ts: i64,
    pub from: String,
    pub text: String,
    pub kind: MessageKind,
    pub is_self: bool,
    /// Addressed to us: any query message, or our nick mentioned in a channel.
    pub highlight: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BufferInfo {
    /// Casefolded name — the key. `#Rust` and `#rust` are one buffer.
    pub id: String,
    /// Name as last seen on the wire, for display.
    pub name: String,
    pub kind: BufferKind,
    #[serde(default)]
    pub topic: Option<String>,
    /// Epoch millis of the newest message, 0 if none.
    #[serde(default)]
    pub last_ts: i64,
    #[serde(default)]
    pub last_text: String,
}

struct Buffer {
    info: BufferInfo,
    recent: VecDeque<IrcMessage>,
    seen: HashSet<String>,
}

impl Buffer {
    fn new(info: BufferInfo) -> Self {
        Self {
            info,
            recent: VecDeque::new(),
            seen: HashSet::new(),
        }
    }

    fn push(&mut self, msg: IrcMessage) {
        self.seen.insert(msg.id.clone());
        // Replayed backlog can arrive slightly out of order relative to what is
        // already here; keep the deque sorted by time so history reads in order.
        let at = self.recent.partition_point(|m| m.ts <= msg.ts);
        self.recent.insert(at, msg);
        while self.recent.len() > KEEP {
            if let Some(old) = self.recent.pop_front() {
                self.seen.remove(&old.id);
            }
        }
        if let Some(newest) = self.recent.back() {
            self.info.last_ts = newest.ts;
            self.info.last_text = newest.text.clone();
        }
    }
}

pub struct History {
    dir: PathBuf,
    buffers: Mutex<HashMap<String, Buffer>>,
}

fn log_file(dir: &Path, id: &str) -> PathBuf {
    let hex: String = id.bytes().map(|b| format!("{b:02x}")).collect();
    dir.join(format!("{hex}.jsonl"))
}

impl History {
    /// Open (creating if needed) the log directory and load every buffer.
    pub fn open(dir: impl Into<PathBuf>) -> anyhow::Result<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        let index: Vec<BufferInfo> = match fs::read(dir.join("buffers.json")) {
            Ok(raw) => serde_json::from_slice(&raw).unwrap_or_else(|e| {
                tracing::warn!("irc: buffers.json unreadable, starting empty: {e}");
                Vec::new()
            }),
            Err(_) => Vec::new(),
        };

        let mut buffers = HashMap::new();
        for info in index {
            let mut buffer = Buffer::new(info);
            for msg in load_log(&dir, &buffer.info.id) {
                buffer.push(msg);
            }
            buffers.insert(buffer.info.id.clone(), buffer);
        }
        Ok(Self {
            dir,
            buffers: Mutex::new(buffers),
        })
    }

    pub fn buffers(&self) -> Vec<BufferInfo> {
        self.lock().values().map(|b| b.info.clone()).collect()
    }

    pub fn buffer(&self, id: &str) -> Option<BufferInfo> {
        self.lock().get(id).map(|b| b.info.clone())
    }

    /// Make sure a buffer exists. Returns its info and whether it was new.
    ///
    /// `authoritative` says `name` is the canonical spelling (from a JOIN, or
    /// a nick's own prefix) and should replace the stored one. A message
    /// target is not: anyone can write to `#rust` when the channel is `#Rust`.
    pub fn ensure(
        &self,
        id: &str,
        name: &str,
        kind: BufferKind,
        authoritative: bool,
    ) -> (BufferInfo, bool) {
        let mut buffers = self.lock();
        if let Some(existing) = buffers.get_mut(id) {
            if authoritative && existing.info.name != name {
                existing.info.name = name.to_string();
                let info = existing.info.clone();
                self.save_index(&buffers);
                return (info, false);
            }
            return (existing.info.clone(), false);
        }
        let mut buffer = Buffer::new(BufferInfo {
            id: id.to_string(),
            name: name.to_string(),
            kind,
            topic: None,
            last_ts: 0,
            last_text: String::new(),
        });
        // A buffer that was closed earlier still has its log; rejoining picks
        // the conversation up where it was.
        for msg in load_log(&self.dir, id) {
            buffer.push(msg);
        }
        let info = buffer.info.clone();
        buffers.insert(id.to_string(), buffer);
        self.save_index(&buffers);
        (info, true)
    }

    /// Forget a buffer (the user left the channel or closed the query). Its
    /// log stays on disk, so rejoining brings the history back.
    pub fn remove(&self, id: &str) -> bool {
        let mut buffers = self.lock();
        let removed = buffers.remove(id).is_some();
        if removed {
            self.save_index(&buffers);
        }
        removed
    }

    pub fn set_topic(&self, id: &str, topic: &str) {
        let mut buffers = self.lock();
        if let Some(buffer) = buffers.get_mut(id) {
            buffer.info.topic = Some(topic.to_string());
            self.save_index(&buffers);
        }
    }

    /// Append a message. False when it is already known (a replay of
    /// something this client has seen), in which case nothing is written.
    pub fn append(&self, id: &str, msg: &IrcMessage) -> bool {
        let mut buffers = self.lock();
        let Some(buffer) = buffers.get_mut(id) else {
            return false;
        };
        if buffer.seen.contains(&msg.id) {
            return false;
        }
        buffer.push(msg.clone());
        if let Err(e) = append_line(&self.dir, id, msg) {
            tracing::warn!("irc: could not write log for {id}: {e}");
        }
        // The index carries last_ts/last_text for the chat list. Rewriting it on
        // every message would be wasteful; those are rebuilt from the logs on
        // load anyway, so the index only needs saving on structural changes.
        true
    }

    /// Merge older history from elsewhere (an IRCCloud export) into a buffer
    /// that already exists. Returns how many messages were new.
    ///
    /// Besides exact ids, a message counts as known when one from the same
    /// sender with the same text and kind is within [`NEAR_DUPLICATE_MS`]: the
    /// bouncer's server-time and the export's own timestamp for one line can
    /// differ slightly, and they hash to different ids. The log is rewritten
    /// from the merged result, so it stays in time order on disk.
    pub fn import(&self, id: &str, messages: Vec<IrcMessage>) -> usize {
        let mut buffers = self.lock();
        let Some(buffer) = buffers.get_mut(id) else {
            return 0;
        };
        let mut added = 0;
        for msg in messages {
            let known = buffer.seen.contains(&msg.id)
                || buffer.recent.iter().any(|m| {
                    m.kind == msg.kind
                        && m.from == msg.from
                        && m.text == msg.text
                        && (m.ts - msg.ts).abs() <= NEAR_DUPLICATE_MS
                });
            if !known {
                buffer.push(msg);
                added += 1;
            }
        }
        if added > 0 {
            let mut bytes = Vec::new();
            for msg in &buffer.recent {
                if let Ok(mut line) = serde_json::to_vec(msg) {
                    line.push(b'\n');
                    bytes.extend_from_slice(&line);
                }
            }
            if let Err(e) = write_atomic(&log_file(&self.dir, id), &bytes) {
                tracing::warn!("irc: could not write imported log for {id}: {e}");
            }
            self.save_index(&buffers);
        }
        added
    }

    /// The newest `limit` messages, oldest first.
    pub fn recent(&self, id: &str, limit: usize) -> Vec<IrcMessage> {
        let buffers = self.lock();
        let Some(buffer) = buffers.get(id) else {
            return Vec::new();
        };
        let skip = buffer.recent.len().saturating_sub(limit);
        buffer.recent.iter().skip(skip).cloned().collect()
    }

    /// The newest `limit` messages older than `before_ts` (epoch millis),
    /// oldest first: the page above what the UI has loaded.
    pub fn before(&self, id: &str, before_ts: i64, limit: usize) -> Vec<IrcMessage> {
        let buffers = self.lock();
        let Some(buffer) = buffers.get(id) else {
            return Vec::new();
        };
        // `recent` is kept sorted by time.
        let end = buffer.recent.partition_point(|m| m.ts < before_ts);
        let start = end.saturating_sub(limit);
        buffer.recent.range(start..end).cloned().collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Buffer>> {
        // A panic while holding the lock leaves plain data behind, not a
        // broken invariant worth taking the whole network down for.
        self.buffers.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn save_index(&self, buffers: &HashMap<String, Buffer>) {
        let mut index: Vec<&BufferInfo> = buffers.values().map(|b| &b.info).collect();
        index.sort_by(|a, b| a.id.cmp(&b.id));
        let result = serde_json::to_vec_pretty(&index)
            .map_err(anyhow::Error::from)
            .and_then(|bytes| write_atomic(&self.dir.join("buffers.json"), &bytes));
        if let Err(e) = result {
            tracing::warn!("irc: could not save buffers.json: {e}");
        }
    }
}

fn append_line(dir: &Path, id: &str, msg: &IrcMessage) -> anyhow::Result<()> {
    let mut line = serde_json::to_vec(msg)?;
    line.push(b'\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file(dir, id))?;
    file.write_all(&line)?;
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Read a buffer's log, compacting it when it has grown too long. A corrupt
/// line (a crash mid-write) is skipped rather than losing the whole log.
fn load_log(dir: &Path, id: &str) -> Vec<IrcMessage> {
    let path = log_file(dir, id);
    let Ok(file) = fs::File::open(&path) else {
        return Vec::new();
    };
    let mut lines = 0usize;
    let mut tail: VecDeque<IrcMessage> = VecDeque::with_capacity(KEEP + 1);
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        lines += 1;
        if let Ok(msg) = serde_json::from_str::<IrcMessage>(&line) {
            tail.push_back(msg);
            if tail.len() > KEEP {
                tail.pop_front();
            }
        }
    }
    if lines > COMPACT_AT {
        let mut bytes = Vec::new();
        for msg in &tail {
            if let Ok(mut line) = serde_json::to_vec(msg) {
                line.push(b'\n');
                bytes.extend_from_slice(&line);
            }
        }
        if let Err(e) = write_atomic(&path, &bytes) {
            tracing::warn!("irc: could not compact log for {id}: {e}");
        }
    }
    tail.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, ts: i64, text: &str) -> IrcMessage {
        IrcMessage {
            id: id.into(),
            ts,
            from: "anna".into(),
            text: text.into(),
            kind: MessageKind::Privmsg,
            is_self: false,
            highlight: false,
        }
    }

    #[test]
    fn appends_dedupes_and_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        {
            let h = History::open(dir.path()).unwrap();
            let (_, new) = h.ensure("#rust", "#Rust", BufferKind::Channel, true);
            assert!(new);
            assert!(h.append("#rust", &msg("a", 1, "one")));
            assert!(h.append("#rust", &msg("b", 2, "two")));
            // The bouncer replaying something we already have.
            assert!(!h.append("#rust", &msg("a", 1, "one")));
            h.set_topic("#rust", "Rust talk");
        }
        let h = History::open(dir.path()).unwrap();
        let texts: Vec<_> = h.recent("#rust", 10).into_iter().map(|m| m.text).collect();
        assert_eq!(texts, vec!["one", "two"]);
        let info = h.buffer("#rust").unwrap();
        assert_eq!(info.name, "#Rust");
        assert_eq!(info.topic.as_deref(), Some("Rust talk"));
        assert_eq!(info.last_text, "two");
        assert_eq!(info.last_ts, 2);
        // Dedupe state is rebuilt from disk too.
        assert!(!h.append("#rust", &msg("b", 2, "two")));
    }

    #[test]
    fn pages_backwards_from_a_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let h = History::open(dir.path()).unwrap();
        h.ensure("#rust", "#Rust", BufferKind::Channel, true);
        for (i, text) in ["one", "two", "three", "four", "five"].iter().enumerate() {
            h.append("#rust", &msg(text, i as i64 + 1, text));
        }
        let page = |ts, limit| -> Vec<String> {
            h.before("#rust", ts, limit).into_iter().map(|m| m.text).collect()
        };
        assert_eq!(page(4, 2), vec!["two", "three"]);
        assert_eq!(page(3, 10), vec!["one", "two"]);
        assert!(page(1, 10).is_empty());
        assert!(h.before("#nope", 10, 10).is_empty());
    }

    #[test]
    fn keeps_messages_in_time_order_and_limits() {
        let dir = tempfile::tempdir().unwrap();
        let h = History::open(dir.path()).unwrap();
        h.ensure("anna", "Anna", BufferKind::Query, true);
        h.append("anna", &msg("c", 30, "late"));
        h.append("anna", &msg("a", 10, "early"));
        h.append("anna", &msg("b", 20, "middle"));
        let texts: Vec<_> = h.recent("anna", 2).into_iter().map(|m| m.text).collect();
        assert_eq!(texts, vec!["middle", "late"]);
    }

    #[test]
    fn import_merges_older_history_and_skips_what_is_already_there() {
        let dir = tempfile::tempdir().unwrap();
        let h = History::open(dir.path()).unwrap();
        h.ensure("#rust", "#rust", BufferKind::Channel, true);
        // Live, from the bouncer.
        h.append("#rust", &msg("live", 100_000, "now"));

        let added = h.import(
            "#rust",
            vec![
                msg("old1", 10_000, "first"),
                msg("old2", 20_000, "second"),
                // The bouncer's copy of a line, stamped a second differently.
                msg("export-of-live", 101_000, "now"),
                // Same text much later is a different message.
                msg("again", 500_000, "first"),
            ],
        );
        assert_eq!(added, 3);
        let texts: Vec<_> = h.recent("#rust", 10).into_iter().map(|m| m.text).collect();
        assert_eq!(texts, vec!["first", "second", "now", "first"]);
        assert_eq!(h.import("#rust", vec![msg("old1", 10_000, "first")]), 0);

        // The rewritten log is in time order and survives a reopen.
        let h = History::open(dir.path()).unwrap();
        let ids: Vec<_> = h.recent("#rust", 10).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["old1", "old2", "live", "again"]);
        assert_eq!(h.buffer("#rust").unwrap().last_text, "first");
        // Unknown buffers are left alone.
        assert_eq!(h.import("#nope", vec![msg("x", 1, "x")]), 0);
    }

    #[test]
    fn compacts_long_logs_and_skips_corrupt_lines() {
        let dir = tempfile::tempdir().unwrap();
        {
            let h = History::open(dir.path()).unwrap();
            h.ensure("#big", "#big", BufferKind::Channel, true);
            for i in 0..(COMPACT_AT + 10) {
                h.append("#big", &msg(&i.to_string(), i as i64, "x"));
            }
        }
        let path = log_file(dir.path(), "#big");
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{not json\n")
            .unwrap();

        let h = History::open(dir.path()).unwrap();
        let recent = h.recent("#big", usize::MAX);
        assert_eq!(recent.len(), KEEP);
        assert_eq!(recent.last().unwrap().id, (COMPACT_AT + 9).to_string());
        let lines = fs::read_to_string(&path).unwrap().lines().count();
        assert_eq!(lines, KEEP);
    }

    #[test]
    fn rejoining_a_removed_buffer_brings_its_log_back() {
        let dir = tempfile::tempdir().unwrap();
        let h = History::open(dir.path()).unwrap();
        h.ensure("#gone", "#gone", BufferKind::Channel, true);
        h.append("#gone", &msg("a", 1, "hi"));
        assert!(h.remove("#gone"));
        assert!(h.buffers().is_empty());
        let (info, new) = h.ensure("#gone", "#gone", BufferKind::Channel, true);
        assert!(new);
        assert_eq!(info.last_text, "hi");
        assert_eq!(h.recent("#gone", 10).len(), 1);
        // And after a restart the index still lists it.
        let h = History::open(dir.path()).unwrap();
        assert_eq!(h.buffers().len(), 1);
    }
}
