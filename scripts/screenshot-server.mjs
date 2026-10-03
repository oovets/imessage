#!/usr/bin/env node
// screenshot-server.mjs — a stand-in BlueBubbles server with made-up
// conversations, for README screenshots without anyone's real messages.
//
// Usage:
//   node scripts/screenshot-server.mjs [port]     (default 1235)
//   npm run dev, then in Settings: server http://localhost:1235, password "demo"
//
// Serves just what the web client reads: contacts, chats with their last
// message, message history (including an iMessage rich link, whose preview
// rides in payloadData + .pluginPayloadAttachment files) and attachments, plus
// just enough of the socket.io handshake for the client to show "connected".
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 1235);
const MIN = 60_000;
const now = Date.now();
const ago = (minutes) => now - minutes * MIN;

const people = {
  alex: { address: "+15550101", name: "Alex Rivera" },
  maya: { address: "+15550102", name: "Maya Chen" },
  jonas: { address: "+15550103", name: "Jonas Berg" },
  priya: { address: "+15550104", name: "Priya Natarajan" },
  sam: { address: "+15550105", name: "Sam Okafor" },
  lena: { address: "+15550106", name: "Lena Fischer" },
  noah: { address: "+15550107", name: "Noah Williams" },
};

const LISTING = "https://fjordhomes.example/listing/4-rooms-vasastan";

// The rich link's preview, as BlueBubbles hands payload_data over: the
// NSKeyedArchiver bplist parsed to JSON. Image is attachment 1, icon 0.
const listingPayload = [
  {
    $version: 100000,
    $archiver: "NSKeyedArchiver",
    $top: { root: { UID: 1 } },
    $objects: [
      "$null",
      { richLinkMetadata: { UID: 2 }, richLinkIsPlaceholder: false },
      {
        title: { UID: 3 },
        summary: { UID: 4 },
        siteName: { UID: 5 },
        URL: { UID: 6 },
        originalURL: { UID: 6 },
        image: { UID: 8 },
        icon: { UID: 9 },
      },
      "4 rooms · Vasastan, Stockholm",
      "Bright corner apartment with a south-facing balcony, 98 m²",
      "Fjord Homes",
      { "NS.base": { UID: 0 }, "NS.relative": { UID: 7 } },
      LISTING,
      { richLinkImageAttachmentSubstituteIndex: 1 },
      { richLinkImageAttachmentSubstituteIndex: 0 },
    ],
  },
];

const svg = {
  "link-icon": `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="#2f6f62"/><path d="M14 36 32 20l18 16v14H14z" fill="#f4f3ef"/></svg>`,
  "link-image": `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6c99a"/><stop offset="1" stop-color="#f3e6d3"/></linearGradient></defs>
  <rect width="1200" height="630" fill="url(#sky)"/>
  <circle cx="930" cy="170" r="70" fill="#fbe3b8"/>
  <rect x="180" y="190" width="520" height="440" fill="#d9c3a5"/>
  <rect x="700" y="260" width="330" height="370" fill="#c4a988"/>
  ${[0, 1, 2, 3]
    .map((row) =>
      [0, 1, 2, 3]
        .map((col) => `<rect x="${220 + col * 120}" y="${230 + row * 95}" width="70" height="60" fill="#5c6f7a"/>`)
        .join("")
    )
    .join("")}
  ${[0, 1, 2].map((row) => `<rect x="740" y="${300 + row * 95}" width="250" height="18" fill="#7a5a3c"/>`).join("")}
  <rect x="0" y="600" width="1200" height="30" fill="#8c7a63"/>
</svg>`,
  photo: `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200">
  <rect width="900" height="1200" fill="#9fc2d6"/>
  <path d="M0 760 260 420l190 230 140-160 310 270v440H0z" fill="#4e6b5c"/>
  <path d="M0 900 300 700l250 170 350-120v450H0z" fill="#38503f"/>
  <circle cx="680" cy="250" r="90" fill="#fdf2d0"/>
</svg>`,
};

const handle = (p) => ({ address: p.address });

let seq = 0;
function msg(chatGuid, from, minutesAgo, text, extra = {}) {
  return {
    guid: `demo-${++seq}`,
    text,
    isFromMe: from === "me",
    dateCreated: ago(minutesAgo),
    handle: from === "me" ? null : handle(from),
    attachments: [],
    associatedMessageGuid: "",
    associatedMessageType: "",
    chats: [{ guid: chatGuid }],
    ...extra,
  };
}

const payloadAttachment = (name) => ({
  guid: name,
  mimeType: "",
  transferName: `${name.toUpperCase()}.pluginPayloadAttachment`,
});

const dm = (p) => `iMessage;-;${p.address}`;
const TRIP = "iMessage;+;chat-weekend-trip";

const chats = [
  {
    guid: dm(people.alex),
    participants: [people.alex],
    unreadCount: 0,
    messages: [
      msg(dm(people.alex), people.alex, 95, "Did you end up going to the viewing?"),
      msg(dm(people.alex), "me", 92, "Yes! Sending you the listing"),
      msg(dm(people.alex), "me", 91, LISTING, {
        balloonBundleId: "com.apple.messages.URLBalloonProvider",
        attachments: [payloadAttachment("link-icon"), payloadAttachment("link-image")],
        payloadData: listingPayload,
      }),
      msg(dm(people.alex), people.alex, 80, "That balcony 😍 How was the light in the kitchen?"),
      msg(dm(people.alex), "me", 78, "Sun all afternoon. Bidding starts Thursday"),
      msg(dm(people.alex), people.alex, 12, "Fingers crossed! Tell me how it goes"),
    ],
  },
  {
    guid: TRIP,
    displayName: "Weekend trip",
    participants: [people.maya, people.jonas, people.priya],
    unreadCount: 2,
    messages: [
      msg(TRIP, people.jonas, 240, "Cabin is booked for Friday–Sunday 🎉"),
      msg(TRIP, people.priya, 230, "I can drive, room for three more"),
      msg(TRIP, "me", 225, "I'll bring breakfast for Saturday"),
      msg(TRIP, people.maya, 40, "View from the cabin last time", {
        attachments: [{ guid: "photo", mimeType: "image/svg+xml", transferName: "IMG_2041.svg" }],
      }),
      msg(TRIP, people.maya, 39, "Who's in for a hike Saturday morning?"),
    ],
  },
  {
    guid: dm(people.sam),
    participants: [people.sam],
    unreadCount: 1,
    messages: [
      msg(dm(people.sam), "me", 300, "Thanks for the book recommendation"),
      msg(dm(people.sam), people.sam, 25, "Finished it yet? No spoilers please"),
    ],
  },
  {
    guid: dm(people.lena),
    participants: [people.lena],
    unreadCount: 0,
    messages: [
      msg(dm(people.lena), people.lena, 400, "Coffee tomorrow at 9?"),
      msg(dm(people.lena), "me", 395, "Perfect, see you there"),
    ],
  },
  {
    guid: dm(people.noah),
    participants: [people.noah],
    unreadCount: 0,
    messages: [
      msg(dm(people.noah), people.noah, 1500, "Here are the slides from today's meetup"),
      msg(dm(people.noah), "me", 1490, "Great talk, thanks for sharing!"),
    ],
  },
  {
    guid: dm(people.priya),
    participants: [people.priya],
    unreadCount: 0,
    messages: [
      msg(dm(people.priya), "me", 2900, "Happy birthday! 🎂"),
      msg(dm(people.priya), people.priya, 2880, "Thank you!! 🥰"),
    ],
  },
];

function chatSummary(c) {
  return {
    guid: c.guid,
    displayName: c.displayName ?? "",
    chatIdentifier: c.guid.split(";").pop(),
    participants: c.participants.map(handle),
    unreadCount: c.unreadCount,
    lastMessage: c.messages.at(-1),
  };
}

const contacts = Object.values(people).map((p) => ({
  displayName: p.name,
  phoneNumbers: [{ address: p.address }],
  emails: [],
}));

function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

// --- socket.io over a bare WebSocket: handshake and pings, never any events --

function wsFrame(text) {
  const payload = Buffer.from(text);
  const head =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

/** Text payloads of the complete (masked, client→server) frames in `buf`. */
function wsTexts(buf) {
  const out = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const opcode = buf[i] & 0x0f;
    let len = buf[i + 1] & 0x7f;
    let p = i + 2;
    if (len === 126) {
      len = buf.readUInt16BE(p);
      p += 2;
    }
    const mask = buf.subarray(p, p + 4);
    p += 4;
    if (p + len > buf.length) break;
    const data = Buffer.from(buf.subarray(p, p + len).map((b, k) => b ^ mask[k % 4]));
    if (opcode === 0x1) out.push(data.toString());
    if (opcode === 0x8) out.push(null);
    i = p + len;
  }
  return out;
}

function onUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.write(wsFrame('0{"sid":"demo","upgrades":[],"pingInterval":20000,"pingTimeout":20000,"maxPayload":1000000}'));
  const ping = setInterval(() => socket.write(wsFrame("2")), 20_000);
  socket.on("data", (buf) => {
    for (const text of wsTexts(buf)) {
      if (text === null) socket.end();
      else if (text === "40") socket.write(wsFrame('40{"sid":"demo-ns"}'));
    }
  });
  socket.on("close", () => clearInterval(ping));
  socket.on("error", () => clearInterval(ping));
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  if (req.method === "OPTIONS") return send(res, 204, "", "text/plain");

  if (path === "/api/v1/server/info") {
    return send(res, 200, { status: 200, data: { private_api: false, helper_connected: false, os_version: "15.0" } });
  }
  if (path === "/api/v1/contact/query" || path === "/api/v1/contact") {
    return send(res, 200, { status: 200, data: contacts });
  }
  if (path === "/api/v1/chat/query") {
    return send(res, 200, { status: 200, data: chats.map(chatSummary) });
  }
  const history = path.match(/^\/api\/v1\/chat\/([^/]+)\/message$/);
  if (history) {
    const chat = chats.find((c) => c.guid === decodeURIComponent(history[1]));
    const after = Number(url.searchParams.get("after") ?? 0);
    const list = (chat?.messages ?? []).filter((m) => m.dateCreated > after);
    return send(res, 200, { status: 200, data: [...list].reverse() });
  }
  const download = path.match(/^\/api\/v1\/attachment\/([^/]+)\/download$/);
  if (download && svg[decodeURIComponent(download[1])]) {
    return send(res, 200, svg[decodeURIComponent(download[1])], "image/svg+xml");
  }
  send(res, 404, { status: 404, error: "not part of the screenshot server" });
})
  .on("upgrade", onUpgrade)
  .listen(PORT, () => {
    console.log(`screenshot server on http://localhost:${PORT} (any password)`);
  });
