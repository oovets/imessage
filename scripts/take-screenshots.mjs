#!/usr/bin/env node
// take-screenshots.mjs — README screenshots (dark + light) of the web client
// talking to scripts/screenshot-server.mjs, so no real conversations appear.
//
// Usage (both servers running first):
//   node scripts/screenshot-server.mjs &
//   npm run dev &
//   node scripts/take-screenshots.mjs [outDir]       (default docs/assets)
//
// Drives a headless Chromium over the DevTools protocol with a throwaway
// profile: connects to the stand-in server, opens one chat with a rich link
// and a group chat in a second pane, and captures each theme at 2x.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT_DIR = process.argv[2] ?? "docs/assets";
const APP = process.env.APP_URL ?? "http://localhost:5173/";
const SERVER = process.env.SERVER_URL ?? "http://localhost:1235";
const CHROMIUM = process.env.CHROMIUM ?? "chromium";
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), "shots-"));
const browser = spawn(
  CHROMIUM,
  ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "about:blank"],
  { stdio: "ignore" }
);

async function pageSocketUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chromium did not come up");
}

const ws = new WebSocket(await pageSocketUrl());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
function cdp(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) =>
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)))
  );
}
async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? expression);
  return result.value;
}
async function waitFor(expression, what) {
  for (let i = 0; i < 60; i++) {
    if (await evaluate(expression)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function typeInto(selector, text) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await cdp("Input.insertText", { text });
}

await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });

for (const theme of ["dark", "light"]) {
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  // Every theme starts fresh: the app persists its pane layout.
  await cdp("Storage.clearDataForOrigin", { origin: new URL(APP).origin, storageTypes: "all" });
  await cdp("Page.navigate", { url: APP });

  const urlField = 'input[placeholder="https://your-server:1234"]';
  await waitFor(`!!document.querySelector('${urlField}')`, "the settings dialog");
  await typeInto(urlField, SERVER);
  await typeInto('input[type="password"]', "demo");
  await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save & Connect").click()`);

  // The chat list, then the rich-link chat in pane 1 and the group in pane 2.
  const byText = (text) =>
    `[...document.querySelectorAll("span, div")].find((el) => el.children.length === 0 && el.textContent.trim() === ${JSON.stringify(text)})`;
  await waitFor(`!!${byText("Alex Rivera")}`, "the chat list");
  await evaluate(`${byText("Alex Rivera")}.click()`);
  await waitFor(`!!${byText("Fjord Homes")} || !!${byText("4 rooms · Vasastan, Stockholm")}`, "the link card");
  // The "Open in new pane" action on the group chat's triage card.
  await evaluate(`[...document.querySelectorAll('[aria-label="Open in new pane"]')]
    .find((b) => b.parentElement?.parentElement?.textContent.includes("hike"))
    .click()`);
  await waitFor(`!!${byText("View from the cabin last time")}`, "the group chat");

  await sleep(1500); // images decode, the entrance animations settle
  await evaluate("document.activeElement?.blur()");
  // Images that decode late push a list off its bottom; pin every list there.
  await evaluate(`[...document.querySelectorAll("*")]
    .filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight)
    .forEach((el) => (el.scrollTop = el.scrollHeight))`);
  await sleep(300);
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  const file = join(OUT_DIR, `screenshot-${theme}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`wrote ${file}`);
}

ws.close();
browser.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
