//! End-to-end against a scripted server on localhost: registration with CAP
//! negotiation and PASS, replayed backlog with server-time, echo-message,
//! commands, replay dedupe, and reconnecting after the link drops.

use std::time::Duration;

use irc_core::{BufferKind, History, IrcClient, IrcConfig, IrcUpdate, MessageKind};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::broadcast;

const WAIT: Duration = Duration::from_secs(10);

struct Server {
    read: BufReader<tokio::net::tcp::OwnedReadHalf>,
    write: tokio::net::tcp::OwnedWriteHalf,
}

impl Server {
    async fn accept(listener: &TcpListener) -> Self {
        let (stream, _) = tokio::time::timeout(WAIT, listener.accept()).await.unwrap().unwrap();
        let (read, write) = stream.into_split();
        Self { read: BufReader::new(read), write }
    }

    async fn expect(&mut self, want: &str) {
        let mut line = String::new();
        tokio::time::timeout(WAIT, self.read.read_line(&mut line))
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {want:?}"))
            .unwrap();
        assert_eq!(line.trim_end_matches(['\r', '\n']), want);
    }

    async fn send(&mut self, line: &str) {
        self.write.write_all(format!("{line}\r\n").as_bytes()).await.unwrap();
    }

    async fn register(&mut self) {
        self.expect("CAP LS 302").await;
        self.expect("PASS bnc@desk:secret").await;
        self.expect("NICK me").await;
        self.expect("USER me 0 * :Me Myself").await;
        self.send(":bnc CAP * LS * :sasl=PLAIN server-time").await;
        self.send(":bnc CAP * LS :echo-message account-tag").await;
        self.expect("CAP REQ :server-time echo-message").await;
        self.send(":bnc CAP * ACK :server-time echo-message").await;
        self.expect("CAP END").await;
        self.send(":bnc 001 me :Welcome").await;
        self.send(":bnc 005 me CHANTYPES=# NETWORK=TestNet :are supported").await;
    }
}

async fn next(rx: &mut broadcast::Receiver<IrcUpdate>) -> IrcUpdate {
    tokio::time::timeout(WAIT, rx.recv()).await.expect("no update").unwrap()
}

#[tokio::test]
async fn full_session_through_a_bouncer() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let dir = tempfile::tempdir().unwrap();

    let client = IrcClient::start(
        IrcConfig {
            host: "127.0.0.1".into(),
            port,
            tls: false,
            nick: "me".into(),
            username: "me".into(),
            realname: "Me Myself".into(),
            password: Some("bnc@desk:secret".into()),
        },
        History::open(dir.path()).unwrap(),
    );
    let mut rx = client.subscribe();

    let mut server = Server::accept(&listener).await;
    server.register().await;
    assert!(matches!(next(&mut rx).await, IrcUpdate::Connected { nick } if nick == "me"));

    // The bouncer rejoins our channels and replays backlog.
    server.send(":me!u@h JOIN #Rust").await;
    server.send(":bnc 332 me #Rust :\x02Rust\x02 talk").await;
    server
        .send("@time=2026-01-01T00:00:00.000Z :anna!a@h PRIVMSG #rust :hi \x0304me\x03, welcome")
        .await;
    server.send(":bob!b@h PRIVMSG me :\x01ACTION waves\x01").await;
    server.send(":bob!b@h PRIVMSG me :\x01VERSION\x01").await;
    server.send(":bnc NOTICE me :*** server chatter").await;

    match next(&mut rx).await {
        IrcUpdate::BufferOpened { buffer } => {
            assert_eq!((buffer.id.as_str(), buffer.name.as_str()), ("#rust", "#Rust"));
            assert_eq!(buffer.kind, BufferKind::Channel);
        }
        other => panic!("{other:?}"),
    }
    // 005 came before the JOIN, so it has been read by now.
    assert_eq!(client.network_name().as_deref(), Some("TestNet"));
    assert!(matches!(next(&mut rx).await, IrcUpdate::Topic { topic, .. } if topic == "Rust talk"));
    match next(&mut rx).await {
        IrcUpdate::Message { buffer, message } => {
            assert_eq!(buffer.id, "#rust");
            assert_eq!(message.text, "hi me, welcome");
            assert_eq!(message.ts, 1_767_225_600_000);
            assert!(message.highlight, "our nick was mentioned");
            assert!(!message.is_self);
        }
        other => panic!("{other:?}"),
    }
    assert!(matches!(next(&mut rx).await, IrcUpdate::BufferOpened { buffer } if buffer.kind == BufferKind::Query && buffer.id == "bob"));
    match next(&mut rx).await {
        IrcUpdate::Message { buffer, message } => {
            assert_eq!(buffer.id, "bob");
            assert_eq!(message.kind, MessageKind::Action);
            assert_eq!(message.text, "waves");
            assert!(message.highlight, "a query is always for us");
        }
        other => panic!("{other:?}"),
    }

    // Sending: the target keeps its wire spelling; with echo-message on, only
    // the echo is recorded.
    client.send_input("#rust", "hello there\n/me dances").unwrap();
    server.expect("PRIVMSG #Rust :hello there").await;
    server.expect("PRIVMSG #Rust :\x01ACTION dances\x01").await;
    server.send(":me!u@h PRIVMSG #Rust :hello there").await;
    match next(&mut rx).await {
        IrcUpdate::Message { message, .. } => {
            assert!(message.is_self);
            assert!(!message.highlight);
            assert_eq!(message.text, "hello there");
        }
        other => panic!("{other:?}"),
    }

    // Commands.
    client.send_input("#rust", "//not a command").unwrap();
    server.expect("PRIVMSG #Rust :/not a command").await;
    client.send_input("#rust", "/join #go").unwrap();
    server.expect("JOIN #go").await;
    assert!(client.send_input("#rust", "/bogus").is_err());

    // A replay of something already seen is dropped; the sentinel after it
    // is the next thing to arrive.
    server
        .send("@time=2026-01-01T00:00:00.000Z :anna!a@h PRIVMSG #rust :hi \x0304me\x03, welcome")
        .await;
    server.send(":anna!a@h PRIVMSG #rust :sentinel").await;
    match next(&mut rx).await {
        IrcUpdate::Message { message, .. } => assert_eq!(message.text, "sentinel"),
        other => panic!("{other:?}"),
    }
    assert_eq!(client.history("#Rust", 10).len(), 3);

    // Keepalive.
    server.send("PING :abc").await;
    server.expect("PONG abc").await;

    // Parting closes the buffer once the server confirms.
    server.send(":me!u@h PART #Rust :bye").await;
    assert!(matches!(next(&mut rx).await, IrcUpdate::BufferClosed { buffer } if buffer == "#rust"));

    // The link drops; the client reconnects and registers again.
    drop(server);
    assert!(matches!(next(&mut rx).await, IrcUpdate::Disconnected { .. }));
    assert!(!client.is_connected());
    assert!(client.send_input("bob", "anyone?").is_err());
    let mut server = Server::accept(&listener).await;
    server.register().await;
    assert!(matches!(next(&mut rx).await, IrcUpdate::Connected { .. }));

    // Shutdown says goodbye.
    client.shutdown().await;
    server.expect("QUIT :bye").await;
}

#[tokio::test]
async fn without_echo_message_our_sends_are_recorded_locally() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let dir = tempfile::tempdir().unwrap();
    let client = IrcClient::start(
        IrcConfig {
            host: "127.0.0.1".into(),
            port,
            tls: false,
            nick: "me".into(),
            username: "me".into(),
            realname: "me".into(),
            password: None,
        },
        History::open(dir.path()).unwrap(),
    );
    let mut rx = client.subscribe();
    let (stream, _) = listener.accept().await.unwrap();
    let (read, mut write) = stream.into_split();
    let mut read = BufReader::new(read);
    let mut line = String::new();
    // CAP LS, NICK, USER — no PASS without a password.
    for want in ["CAP LS 302", "NICK me", "USER me 0 * me"] {
        line.clear();
        read.read_line(&mut line).await.unwrap();
        assert_eq!(line.trim_end(), want);
    }
    // A server without CAP support answers 421 and registers anyway, taking
    // a different nick than we asked for.
    write.write_all(b":srv 421 * CAP :Unknown command\r\n:srv 001 me_ :hi\r\n").await.unwrap();
    assert!(matches!(next(&mut rx).await, IrcUpdate::Connected { nick } if nick == "me_"));

    client.send_input("Anna", "/query Anna hej").unwrap();
    line.clear();
    read.read_line(&mut line).await.unwrap();
    assert_eq!(line.trim_end(), "PRIVMSG Anna hej");
    assert!(matches!(next(&mut rx).await, IrcUpdate::BufferOpened { buffer } if buffer.id == "anna"));
    match next(&mut rx).await {
        IrcUpdate::Message { message, .. } => {
            assert!(message.is_self);
            assert_eq!(message.from, "me_");
            assert_eq!(message.text, "hej");
        }
        other => panic!("{other:?}"),
    }
}
