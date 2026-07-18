#!/usr/bin/env node
// Regenerates src/slack/emojiMap.ts from iamcal/emoji-data — the dataset
// Slack itself ships — so incoming :shortcodes: decode to native emoji.
// Run when Slack adds emoji (roughly yearly): node scripts/generate-emoji-map.mjs

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "https://raw.githubusercontent.com/iamcal/emoji-data/master/emoji.json";

const data = await (await fetch(SOURCE)).json();
const by = new Map();
for (const e of data) {
  const ch = e.unified
    .split("-")
    .map((cp) => String.fromCodePoint(parseInt(cp, 16)))
    .join("");
  for (const name of e.short_names ?? [e.short_name]) by.set(name, ch);
}

const lines = [
  "// GENERATED FILE - do not edit by hand.",
  "// Slack shortcode -> native emoji, generated from iamcal/emoji-data",
  "// (the dataset Slack itself uses) by scripts/generate-emoji-map.mjs.",
  "// The curated table in lib/emoji.ts is for autocomplete UX and stays",
  "// small on purpose; THIS map exists to decode arbitrary incoming Slack",
  "// text, which needs the full set (1900+ names).",
  "",
  "export const SLACK_EMOJI: Record<string, string> = {",
];
for (const name of [...by.keys()].sort()) {
  const ch = by.get(name).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  lines.push(`  "${name}": "${ch}",`);
}
lines.push("};");
lines.push("");
lines.push("/** :skin-tone-N: are modifiers on the emoji before them; appending the");
lines.push(" *  modifier char composes the toned emoji (🤞 + 🏻 = 🤞🏻). */");
lines.push("export const SKIN_TONES: Record<string, string> = {");
for (let i = 2; i <= 6; i++) {
  lines.push(`  "skin-tone-${i}": "${String.fromCodePoint(0x1f3fb + i - 2)}",`);
}
lines.push("};");

const out = join(import.meta.dirname, "../src/slack/emojiMap.ts");
writeFileSync(out, lines.join("\n") + "\n");
console.log(`wrote ${by.size} entries -> ${out}`);
