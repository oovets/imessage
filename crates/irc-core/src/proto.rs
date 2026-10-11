//! IRC wire format: parsing incoming lines, building outgoing ones, and the
//! small text helpers (formatting codes, casemapping, CTCP) every caller needs.
//!
//! Covers RFC 1459/2812 lines plus IRCv3 message tags, which is where a
//! bouncer puts `time` (server-time) and `msgid` on replayed backlog.

use std::collections::HashMap;

/// One parsed IRC line.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Message {
    pub tags: HashMap<String, String>,
    /// `nick!user@host` or a server name; `None` for prefix-less lines.
    pub prefix: Option<String>,
    /// Upper-cased command or three-digit numeric.
    pub command: String,
    pub params: Vec<String>,
}

impl Message {
    /// Parse one line, without its trailing CR/LF. `None` for an empty line.
    pub fn parse(line: &str) -> Option<Message> {
        let mut rest = line.trim_end_matches(['\r', '\n']).trim_start_matches(' ');
        let mut msg = Message::default();

        if let Some(after) = rest.strip_prefix('@') {
            let (tags, tail) = after.split_once(' ')?;
            for tag in tags.split(';').filter(|t| !t.is_empty()) {
                let (key, value) = tag.split_once('=').unwrap_or((tag, ""));
                msg.tags.insert(key.to_string(), unescape_tag_value(value));
            }
            rest = tail.trim_start_matches(' ');
        }

        if let Some(after) = rest.strip_prefix(':') {
            let (prefix, tail) = after.split_once(' ').unwrap_or((after, ""));
            msg.prefix = Some(prefix.to_string());
            rest = tail.trim_start_matches(' ');
        }

        let (command, mut rest) = rest.split_once(' ').unwrap_or((rest, ""));
        if command.is_empty() {
            return None;
        }
        msg.command = command.to_ascii_uppercase();

        loop {
            rest = rest.trim_start_matches(' ');
            if rest.is_empty() {
                break;
            }
            if let Some(trailing) = rest.strip_prefix(':') {
                msg.params.push(trailing.to_string());
                break;
            }
            match rest.split_once(' ') {
                Some((param, tail)) => {
                    msg.params.push(param.to_string());
                    rest = tail;
                }
                None => {
                    msg.params.push(rest.to_string());
                    break;
                }
            }
        }
        Some(msg)
    }

    /// The nick part of the prefix (everything before `!`).
    pub fn source_nick(&self) -> Option<&str> {
        let prefix = self.prefix.as_deref()?;
        Some(prefix.split_once('!').map_or(prefix, |(nick, _)| nick))
    }

    /// True when the prefix names a user (`nick!user@host`) rather than a server.
    pub fn from_user(&self) -> bool {
        self.prefix.as_deref().is_some_and(|p| p.contains('!'))
    }

    pub fn param(&self, i: usize) -> Option<&str> {
        self.params.get(i).map(String::as_str)
    }
}

fn unescape_tag_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some(':') => out.push(';'),
            Some('s') => out.push(' '),
            Some('r') => out.push('\r'),
            Some('n') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// Build an outgoing line from a command and its params. The last param is
/// always sent as a trailing (`:`-prefixed) one when it needs to be.
///
/// CR, LF and NUL are stripped from every param: they would end the line early
/// and let the rest be read as a second command.
pub fn build(command: &str, params: &[&str]) -> String {
    let mut line = command.to_string();
    for (i, param) in params.iter().enumerate() {
        let clean: String = param.chars().filter(|c| !matches!(c, '\r' | '\n' | '\0')).collect();
        let last = i + 1 == params.len();
        line.push(' ');
        if last && (clean.is_empty() || clean.contains(' ') || clean.starts_with(':')) {
            line.push(':');
        }
        line.push_str(&clean);
    }
    line
}

/// Decode a raw line. IRC has no declared encoding: modern networks are UTF-8,
/// but old channels still carry Latin-1, which is not valid UTF-8 and would
/// otherwise come through as replacement characters.
pub fn decode_line(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    }
}

/// Strip mIRC formatting: bold, italic, underline, strikethrough, monospace,
/// reverse, reset, and `^C` / `^D` colours with their arguments.
pub fn strip_formatting(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x02' | '\x1d' | '\x1f' | '\x1e' | '\x11' | '\x16' | '\x0f' => {}
            '\x03' => {
                // ^C[fg[,bg]], each one or two digits.
                take_digits(&mut chars, 2);
                if chars.peek() == Some(&',') {
                    let mut ahead = chars.clone();
                    ahead.next();
                    if ahead.peek().is_some_and(char::is_ascii_digit) {
                        chars.next();
                        take_digits(&mut chars, 2);
                    }
                }
            }
            '\x04' => {
                // ^D[RRGGBB[,RRGGBB]]
                take_hex(&mut chars, 6);
                if chars.peek() == Some(&',') {
                    let mut ahead = chars.clone();
                    ahead.next();
                    if ahead.peek().is_some_and(char::is_ascii_hexdigit) {
                        chars.next();
                        take_hex(&mut chars, 6);
                    }
                }
            }
            _ => out.push(c),
        }
    }
    out
}

fn take_digits(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, max: usize) {
    for _ in 0..max {
        if chars.peek().is_some_and(char::is_ascii_digit) {
            chars.next();
        } else {
            break;
        }
    }
}

fn take_hex(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, max: usize) {
    for _ in 0..max {
        if chars.peek().is_some_and(char::is_ascii_hexdigit) {
            chars.next();
        } else {
            break;
        }
    }
}

/// Lower-case a nick or channel name under the `rfc1459` casemapping, which is
/// the IRC default: `[]\~` are the upper-case forms of `{}|^`. Buffers are
/// keyed by this so `#Rust` and `#rust` are one conversation.
pub fn irc_lower(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '[' => '{',
            ']' => '}',
            '\\' => '|',
            '~' => '^',
            c => c.to_ascii_lowercase(),
        })
        .collect()
}

/// Whether a target is a channel, given the network's `CHANTYPES`.
pub fn is_channel(target: &str, chantypes: &str) -> bool {
    target.chars().next().is_some_and(|c| chantypes.contains(c))
}

/// A CTCP payload (`\x01VERB args\x01`), split into verb and args.
pub fn parse_ctcp(text: &str) -> Option<(&str, &str)> {
    let inner = text.strip_prefix('\x01')?;
    let inner = inner.strip_suffix('\x01').unwrap_or(inner);
    Some(inner.split_once(' ').unwrap_or((inner, "")))
}

/// Split `text` into chunks of at most `max_bytes`, preferring to break at a
/// space and never inside a UTF-8 character. A server truncates (not wraps)
/// an over-long line, so a long message must go out as several.
pub fn split_message(text: &str, max_bytes: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut rest = text;
    while rest.len() > max_bytes {
        let mut cut = max_bytes;
        while !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        // Break at the last space in the window, unless that leaves a tiny chunk.
        if let Some(space) = rest[..cut].rfind(' ') {
            if space > max_bytes / 2 {
                cut = space;
            }
        }
        chunks.push(rest[..cut].to_string());
        rest = rest[cut..].strip_prefix(' ').unwrap_or(&rest[cut..]);
    }
    if !rest.is_empty() || chunks.is_empty() {
        chunks.push(rest.to_string());
    }
    chunks
}

/// Whether `text` mentions `nick` as a whole word (case-insensitively), so
/// "anna" highlights on "anna: hi" but not on "annabelle".
pub fn mentions(text: &str, nick: &str) -> bool {
    if nick.is_empty() {
        return false;
    }
    let text = irc_lower(text);
    let nick = irc_lower(nick);
    let is_word = |c: char| c.is_alphanumeric() || "_-[]{}\\|^`".contains(c);
    let mut from = 0;
    while let Some(pos) = text[from..].find(&nick) {
        let start = from + pos;
        let end = start + nick.len();
        let before_ok = text[..start].chars().next_back().is_none_or(|c| !is_word(c));
        let after_ok = text[end..].chars().next().is_none_or(|c| !is_word(c));
        if before_ok && after_ok {
            return true;
        }
        from = start + nick.len().max(1);
        while from < text.len() && !text.is_char_boundary(from) {
            from += 1;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tags_prefix_and_trailing() {
        let m = Message::parse(
            "@time=2026-10-11T19:02:03.456Z;msgid=abc\\:1 :anna!a@host PRIVMSG #rust :hello there\r\n",
        )
        .unwrap();
        assert_eq!(m.tags["time"], "2026-10-11T19:02:03.456Z");
        assert_eq!(m.tags["msgid"], "abc;1");
        assert_eq!(m.source_nick(), Some("anna"));
        assert!(m.from_user());
        assert_eq!(m.command, "PRIVMSG");
        assert_eq!(m.params, vec!["#rust", "hello there"]);
    }

    #[test]
    fn parses_lines_without_prefix_or_trailing() {
        let m = Message::parse("PING irc.example.net").unwrap();
        assert_eq!(m.prefix, None);
        assert_eq!(m.params, vec!["irc.example.net"]);

        let m = Message::parse(":server 001 me :Welcome").unwrap();
        assert!(!m.from_user());
        assert_eq!(m.param(0), Some("me"));
        assert_eq!(m.param(1), Some("Welcome"));

        // A trailing param may itself be empty, or start with a colon.
        let m = Message::parse(":a!b@c PRIVMSG #x ::)").unwrap();
        assert_eq!(m.param(1), Some(":)"));
        let m = Message::parse(":a!b@c TOPIC #x :").unwrap();
        assert_eq!(m.param(1), Some(""));

        assert!(Message::parse("").is_none());
    }

    #[test]
    fn build_adds_trailing_colon_only_when_needed() {
        assert_eq!(build("PRIVMSG", &["#x", "hi there"]), "PRIVMSG #x :hi there");
        assert_eq!(build("PRIVMSG", &["#x", "hi"]), "PRIVMSG #x hi");
        assert_eq!(build("PRIVMSG", &["#x", ":)"]), "PRIVMSG #x ::)");
        assert_eq!(build("PART", &["#x", ""]), "PART #x :");
        assert_eq!(build("JOIN", &["#x"]), "JOIN #x");
    }

    #[test]
    fn build_cannot_be_used_to_inject_a_second_command() {
        let line = build("PRIVMSG", &["#x", "hi\r\nQUIT :bye"]);
        assert!(!line.contains('\n') && !line.contains('\r'));
        let line = build("PRIVMSG", &["#x\nQUIT", "hi"]);
        assert!(!line.contains('\n'));
    }

    #[test]
    fn decodes_latin1_when_not_utf8() {
        assert_eq!(decode_line("räksmörgås".as_bytes()), "räksmörgås");
        assert_eq!(decode_line(b"r\xe4ksm\xf6rg\xe5s"), "räksmörgås");
    }

    #[test]
    fn strips_formatting_codes() {
        assert_eq!(strip_formatting("\x02bold\x02 \x1ditalic\x0f"), "bold italic");
        assert_eq!(strip_formatting("\x0304red\x03 \x0312,01blue"), "red blue");
        // A comma not followed by a digit belongs to the text.
        assert_eq!(strip_formatting("\x034,text"), ",text");
        // Digits after a two-digit colour are text again.
        assert_eq!(strip_formatting("\x0301234"), "234");
        assert_eq!(strip_formatting("\x04ff0000,00ff00hex"), "hex");
    }

    #[test]
    fn casemapping_folds_rfc1459_brackets() {
        assert_eq!(irc_lower("Nick[Away]"), "nick{away}");
        assert_eq!(irc_lower("#Rust"), "#rust");
    }

    #[test]
    fn ctcp_action() {
        assert_eq!(parse_ctcp("\x01ACTION waves\x01"), Some(("ACTION", "waves")));
        assert_eq!(parse_ctcp("\x01VERSION\x01"), Some(("VERSION", "")));
        assert_eq!(parse_ctcp("plain"), None);
    }

    #[test]
    fn splits_long_messages_on_spaces_and_char_boundaries() {
        let text = "ord ".repeat(200);
        let chunks = split_message(text.trim_end(), 100);
        assert!(chunks.iter().all(|c| c.len() <= 100));
        assert_eq!(chunks.join(" "), text.trim_end());

        let emoji = "😀".repeat(50); // 4 bytes each, no spaces
        let chunks = split_message(&emoji, 10);
        assert!(chunks.iter().all(|c| c.len() <= 10));
        assert_eq!(chunks.concat(), emoji);

        assert_eq!(split_message("", 10), vec![""]);
    }

    #[test]
    fn mentions_whole_words_only() {
        assert!(mentions("anna: hi", "Anna"));
        assert!(mentions("hi anna!", "anna"));
        assert!(!mentions("annabelle is here", "anna"));
        assert!(!mentions("hanna", "anna"));
        assert!(mentions("x hanna anna", "anna"));
        assert!(!mentions("anything", ""));
    }
}
