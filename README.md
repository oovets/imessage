[![latest release](https://img.shields.io/github/v/release/oovets/imessage?label=latest%20release)](https://github.com/oovets/imessage/releases/latest)
[![macOS](https://img.shields.io/badge/macOS-desktop-black)](https://github.com/oovets/imessage/releases/latest)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8D8)](https://tauri.app/)
[![React + TypeScript](https://img.shields.io/badge/React-TypeScript-3178C6)](https://react.dev/)
[![Docs](https://img.shields.io/badge/docs-mkdocs--material-blue.svg)](https://stevoo.net/imessage/)

![](docs/assets/messages-mockup.svg)
native macos desktop app for bluebubbles servers. a real tauri 2 application that installs
into /applications, lives in the menu bar, launches at login, and feels at home on macos —
not a webpage in a wrapper. built with tauri 2, rust, react, typescript, vite, tailwind,
and zustand: a clean multi-pane imessage experience with keychain credential storage,
native notifications, deep links, and locally-fetched rich link previews. a browser-served
web build exists for development, but the shipping product is the macos desktop app.

download -> [latest release](https://github.com/oovets/imessage/releases/latest) ·
[apple silicon dmg](https://github.com/oovets/imessage/releases/download/v0.1.3/Messages_0.1.3_aarch64.dmg) ·
[intel dmg](https://github.com/oovets/imessage/releases/download/v0.1.3/Messages_0.1.3_x64.dmg)

```
== desktop features ==

- real macos app bundle: native menu, tray icon, dock presence, Cmd+Q

- macos keychain-backed credential storage in release builds

- native desktop notifications for incoming messages

- launch-at-login and messages:// deep links to jump straight to a chat

- link previews fetched locally through the tauri http plugin (no cors hacks)

- app-wide font scaling (Cmd +, Cmd -, Cmd 0) plus theme colour editing

- native window vibrancy and an overlay titlebar -- frosted, draggable from the top

- emoji autocomplete -- type a plain word (fire) or a :shortcode (:smile), plus a
  searchable emoji picker

- memory-conscious: bounded message cache (lru eviction) and downscaled image thumbnails

- multi-pane conversations, replies, tapbacks, image/video/file attachments with
  full-size preview dialogs
```

```
== status ==

current version 0.1.3. macos releases are built by github actions from v* tags:
  apple silicon   aarch64-apple-darwin on macos-latest
  intel           x86_64-apple-darwin on macos-13

release builds are currently unsigned unless apple signing + notarization secrets are
added to the repo.
```

```
== requirements ==
to use the app:

- macos (apple silicon or intel)
- a reachable bluebubbles server + its url and password/api key

to build from source: rust stable, tauri 2 macos prerequisites, xcode command line tools,
node.js 24 + npm. the web build (development) needs only node.js 24 + npm.
```

```
== installing a bluebubbles server ==

the bluebubbles server is a macos app that bridges imessage to an http/websocket api. it
must run on a mac signed into icloud with messages working.

host: a mac on macos 11+ , signed into icloud with imessage enabled and a visible
conversation; always-on power/network with sleep prevented; full disk access granted (to
read the messages sqlite db); accessibility + automation granted (to send messages).

install:
1. download the latest server from bluebubbles.app/server (or the github releases)

2. move BlueBubbles.app to /applications and launch it

3. approve prompts: system settings -> privacy & security -> full disk access, then
   accessibility, then automation (allow control of messages + system events)

4. set a strong server password (this is the api password the client uses)

5. choose a port (default 1234) and start the server

6. optional: launch on startup + disable app nap so it survives reboots

exposing: lan-only uses http://<mac-ip>:1234. for remote, use cloudflare tunnel
(recommended; the server can publish a *.trycloudflare.com url), ngrok (from the server
ui), or manual port-forward + dynamic dns with tls in front.

verify:  curl -k "https://your-server/api/v1/server/info?password=YOUR_PASSWORD"
a json metadata payload confirms the api is reachable; use that url + password on first run.

pitfalls: messages must have launched + synced an imessage chat; "messages in icloud"
should be on or old history is missing; macos upgrades can reset permissions (re-grant
full disk access + restart); prefer a real tls cert via cloudflare tunnel for remote use.
```

```bash
# quick start -- most users just grab a dmg above; to build the desktop app:
npm install --legacy-peer-deps
npm run tauri:dev      # run the desktop app in development
npm run tauri:build    # produce a local .app and .dmg (under src-tauri/target/release/bundle/)

# frontend-only (browser, no rust shell rebuild):
npm run dev            # vite dev server
npm run build          # type-check + build the frontend
```

```
== local code signing ==

unsigned local builds re-trigger the macos keychain trust prompt on every launch (the
keychain can't remember "always allow" without a stable code signature). to silence it,
npm run tauri:build signs the bundle with a stable identity.

create the signing certificate once:
  keychain access -> certificate assistant -> create a certificate
  name: Messages Desktop Signing , identity type: self signed root , type: code signing

the tauri:build script reads APPLE_SIGNING_IDENTITY and defaults to "Messages Desktop
Signing". override it with your own cert name, or APPLE_SIGNING_IDENTITY="-" for an
ad-hoc (unsigned) build:
  APPLE_SIGNING_IDENTITY="Apple Development: you@example.com" npm run tauri:build
  APPLE_SIGNING_IDENTITY="-" npm run tauri:build

after the first launch of a signed build, click "always allow" once; the stable signature
means it won't ask again, even after future rebuilds. github actions release builds are
independent of this (still unsigned unless notarization secrets are added).
```

```
== first run ==

with no saved settings the settings dialog opens automatically; enter the server url
(e.g. https://your-bluebubbles-server) and the password/api key. in tauri dev, credentials
use local dev storage (avoids keychain trust prompts from unsigned dev binaries). in macos
release builds they are a single json entry in the keychain under com.oovets.messages.

unsigned builds: if macos says the app "is damaged and can't be opened", move it to
/applications and clear the quarantine flag:
  xattr -dr com.apple.quarantine "/Applications/Messages Desktop.app"
```

```bash
# npm scripts
npm run dev          # start vite dev server
npm run build        # type-check + build the frontend
npm run lint         # eslint flat config
npm run test         # vitest unit tests
npm run preview      # preview the built frontend
npm run tauri:dev    # run the desktop app in development
npm run tauri:build  # build local desktop bundles
```

```
== dev diagnostics ==

memory work has two dev-only helpers. in a dev build the web inspector console exposes
window.__mem() (js heap, dom nodes, cached message counts) and window.__memRec (start / mark /
stop / dump to record a scenario walkthrough as a table + csv). scripts/mem-snapshot.sh prints
the matching rss for the rust process and its wkwebview content process -- diff before/after
launch to find the app's renderer pid:
  scripts/mem-snapshot.sh before   # before launching the app
  scripts/mem-snapshot.sh after    # the new WebContent pid is the app's
```

```
== how it works ==

secure settings   src/lib/secureConfig.ts + native tauri commands in src-tauri/src/lib.rs.
                  web keeps credentials in memory; tauri dev uses dev storage; release uses
                  keychain; clearing settings removes current + legacy keychain entries.

realtime + sync   connects to the bluebubbles socket.io-compatible websocket; falls back to
                  http polling. http and websocket both go through the tauri plugins
                  (rust-side), so dev reaches a cleartext lan server without webview ats/cors
                  blocks. (src/hooks/useWebSocket.ts, lib/wsTransport.ts,
                  usePollingFallback.ts, src/api/client.ts)

messages + attach optimistic outgoing render, deduped against server echoes via temp guids;
                  images inline as downscaled thumbnails (click -> dark full-size dialog),
                  video as <video controls>, other attachments as links. socket events that
                  arrive without attachment data are backfilled over http. the in-memory cache
                  is bounded (lru, 30 chats x 100 messages) and persisted.
                  (src/components/Message*.tsx, store/useAppStore.ts, store/messageCache.ts)

link previews     fetched locally via the tauri http plugin, cached in zustand with a bounded
                  size. (src/lib/linkPreview.ts, components/LinkPreviewCard.tsx)

appearance        light/dark + superlight modes, app-wide font scaling (Cmd +/-/0), font
                  family + colour-token editing, auto-hidden scrollbars. (src/lib/appearance.ts)

macos integration native menu + tray actions, launch at login, desktop notifications,
                  messages:// deep links:  messages://chat/<guid>  or
                  messages://open?chat=<guid>
```

```text
== project structure ==

.github/workflows/   github actions release workflow
src/                 react application
  api/               bluebubbles api client
  components/        ui and chat components
  hooks/             realtime, polling, desktop hooks
  lib/               utilities, appearance, secure config, previews, ws transport, diagnostics
  store/             zustand app state (+ messageCache.ts bounded cache)
  types/             shared typescript types
scripts/             dev helpers (mem-snapshot.sh)
src-tauri/           tauri 2 desktop shell (capabilities/ icons/ src/ rust commands)
eslint.config.js     eslint 9 flat config
package.json         npm scripts + frontend deps
vite.config.ts       vite config
vitest.config.ts     vitest config
```

```bash
# local cross-architecture builds (on apple silicon, add the intel target first)
rustup target add x86_64-apple-darwin
npm run tauri:build -- --target x86_64-apple-darwin --bundles app,dmg   # intel
npm run tauri:build -- --target aarch64-apple-darwin --bundles app,dmg  # apple silicon

# verification before shipping
npm run lint
npm run test
npm run build
cd src-tauri && cargo check
npm run tauri:build     # for desktop packaging changes
```

```
== troubleshooting ==

keychain prompts          dev builds avoid the keychain (dev storage). unsigned release
                          builds re-prompt every launch; sign locally so "always allow"
                          sticks -- see "local code signing" above.

dmg build "resource busy" a temp app from a mounted dmg blocks hdiutil detach; quit it,
                          eject the temp volume, rerun npm run tauri:build.

self-signed server cert   open the server url in a browser first and accept the cert.

unsigned release warning  gatekeeper may require manual approval; add apple signing +
                          notarization secrets to github actions before wider distribution.
```
