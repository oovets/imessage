import type { Attachment, RichLink } from "@/types";

// iMessage sends a link as a "URL balloon": the text is the URL, the preview
// the sender's device fetched is an NSKeyedArchiver plist in payload_data, and
// its images ride along as .pluginPayloadAttachment files. BlueBubbles hands
// payloadData over as the bplist parsed to JSON ($objects + UID references).
// Decoding it here means the preview shows even for sites that block our own
// fetch (Cloudflare-fronted ones answer 403), and without any network at all.

const PAYLOAD_ATTACHMENT = /\.pluginPayloadAttachment$/i;

/** A rich link's image/icon file: never shown as an attachment of its own. */
export function isPayloadAttachment(att: Attachment): boolean {
  return PAYLOAD_ATTACHMENT.test(att.transferName ?? "");
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** bplist-parser writes UIDs as {UID: n}; plist JSON dumps as {"CF$UID": n}. */
function uidOf(v: unknown): number | null {
  if (!isObj(v)) return null;
  const n = v.UID ?? v["CF$UID"];
  return typeof n === "number" && Object.keys(v).length === 1 ? n : null;
}

// Deep enough for LPLinkMetadata (RichLink → metadata → image → index) with
// room to spare; it only guards against hostile or cyclic archives.
const MAX_DEPTH = 32;

/** Resolves an NSKeyedArchiver archive into plain values. */
function unarchive(objects: unknown[], root: unknown): unknown {
  const memo = new Map<number, unknown>();

  const decode = (value: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return null;
    const uid = uidOf(value);
    if (uid !== null) {
      if (memo.has(uid)) return memo.get(uid);
      memo.set(uid, null); // breaks cycles
      const out = decode(objects[uid], depth + 1);
      memo.set(uid, out);
      return out;
    }
    if (value === "$null") return null;
    if (Array.isArray(value)) return value.map((v) => decode(v, depth + 1));
    if (!isObj(value)) return value;

    if (Array.isArray(value["NS.keys"]) && Array.isArray(value["NS.objects"])) {
      const keys = value["NS.keys"] as unknown[];
      const vals = value["NS.objects"] as unknown[];
      const dict: Obj = {};
      keys.forEach((k, i) => {
        const key = decode(k, depth + 1);
        if (typeof key === "string") dict[key] = decode(vals[i], depth + 1);
      });
      return dict;
    }
    if (Array.isArray(value["NS.objects"])) {
      return (value["NS.objects"] as unknown[]).map((v) => decode(v, depth + 1));
    }
    if ("NS.string" in value) return decode(value["NS.string"], depth + 1);
    // NSURL: the absolute URL sits in NS.relative (NS.base is $null).
    if ("NS.relative" in value) return decode(value["NS.relative"], depth + 1);

    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) {
      if (k !== "$class") out[k] = decode(v, depth + 1);
    }
    return out;
  };

  return decode(root, 0);
}

/** The payload as plain values: unarchived when it is a keyed archive. */
function plainPayload(payload: unknown): unknown {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const tops = Array.isArray(value) ? value : [value];
  for (const top of tops) {
    if (isObj(top) && Array.isArray(top.$objects)) {
      const objects = top.$objects as unknown[];
      const root = isObj(top.$top) ? (top.$top.root ?? Object.values(top.$top)[0]) : { UID: 1 };
      return unarchive(objects, root);
    }
  }
  return value;
}

const LINK_KEYS = ["URL", "originalURL"];
const TEXT_KEYS = ["title", "summary", "siteName"];

/** The LPLinkMetadata dictionary, wherever it sits in the decoded payload. */
function findMetadata(node: unknown, depth = 0): Obj | null {
  if (depth > MAX_DEPTH) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findMetadata(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (!isObj(node)) return null;
  if (isObj(node.richLinkMetadata)) return node.richLinkMetadata;
  if (LINK_KEYS.some((k) => k in node) && TEXT_KEYS.some((k) => k in node)) return node;
  for (const v of Object.values(node)) {
    const hit = findMetadata(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const text = (v: unknown): string =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";

/** An LPImage's attachment index, from `image` or the first of `images`. */
function attachmentIndex(single: unknown, many: unknown): number | undefined {
  const img = isObj(single) ? single : Array.isArray(many) && isObj(many[0]) ? many[0] : null;
  const idx = img?.richLinkImageAttachmentSubstituteIndex;
  return typeof idx === "number" && idx >= 0 ? idx : undefined;
}

function metadataUrl(meta: unknown): string {
  const first = Array.isArray(meta) ? meta[0] : meta;
  const url = isObj(first) ? text(first.URL) : "";
  return /^https?:\/\//i.test(url) ? url : "";
}

/** The rich link a BlueBubbles message's payloadData describes, if any. */
export function parseRichLink(payloadData: unknown): RichLink | undefined {
  if (payloadData == null) return undefined;
  let meta: Obj | null;
  try {
    meta = findMetadata(plainPayload(payloadData));
  } catch {
    return undefined;
  }
  if (!meta) return undefined;

  const link: RichLink = {
    url: text(meta.URL) || text(meta.originalURL),
    title: text(meta.title),
    summary: text(meta.summary),
    siteName: text(meta.siteName),
  };
  const imageIndex = attachmentIndex(meta.image, meta.images);
  const iconIndex = attachmentIndex(meta.icon, meta.icons);
  const imageUrl = metadataUrl(meta.imageMetadata) || metadataUrl(meta.imagesMetadata);
  if (imageIndex !== undefined) link.imageIndex = imageIndex;
  if (iconIndex !== undefined) link.iconIndex = iconIndex;
  if (imageUrl) link.imageUrl = imageUrl;

  const hasContent =
    link.title || link.summary || link.siteName || imageIndex !== undefined || imageUrl;
  return hasContent ? link : undefined;
}

/**
 * Sets `richLink` from a raw BlueBubbles message's payloadData and drops the
 * raw archive, which nothing else reads. Mutates; returns the message.
 */
export function attachRichLink<T extends { richLink?: RichLink }>(raw: T): T {
  const rec = raw as T & { payloadData?: unknown };
  if (rec.payloadData !== undefined) {
    const link = parseRichLink(rec.payloadData);
    if (link) rec.richLink = link;
    delete rec.payloadData;
  }
  return raw;
}
