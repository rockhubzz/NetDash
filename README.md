# Network Dashboard

A self-hosted, single-pane-of-glass dashboard for your network gear (routers,
NAS, access points, anything with a web UI). Add a device from the dashboard
itself, and its admin UI opens *inside* the dashboard — a sidebar to switch
between devices, a header showing which one you're on, and a live, fully
interactive view of its actual web UI.

## How it works

Each device gets its own **real, headless Chromium browser**, running on the
server, that navigates to that device's admin UI. The dashboard streams a
live picture of that browser to your screen (a screencast, like a remote
desktop) and forwards your mouse/keyboard back to it. You're not looking at
a proxied copy of the HTML — you're looking at an actual browser tab
running on the server, controlled remotely.

```
Your browser                    Dashboard server                  Your LAN
┌──────────┐   WebSocket    ┌───────────────────────┐   normal    ┌────────┐
│  canvas  │◄── JPEG frames─┤ headless Chromium      │◄─ browsing─┤ router │
│ (click,  │── mouse/kbd ──►│ (one per device,       │    traffic ├────────┤
│  type)   │                │  persistent profile)   │            │  NAS   │
└──────────┘                └───────────────────────┘            └────────┘
```

Why this instead of an HTML-rewriting reverse proxy (an earlier version of
this project worked that way): a real browser just handles whatever the
device's UI throws at it — client-side routing, WebSockets the device's own
UI opens, dynamically-built URLs — none of which a text-rewriting proxy can
reliably keep up with. The trade-off is it's heavier: one Chromium process
per device you're actively using.

**Why you don't get re-prompted to log in:** each device's Chromium session
uses a *persistent browser profile* on disk (`data/profiles/<device-id>`) —
a real Chrome profile, cookies and local storage included. It survives
switching devices, closing the tab, and even restarting the dashboard
server itself.

**The dashboard itself is behind its own login** (`/login`), backed by a
signed session cookie (`lib/auth.ts`, `middleware.ts`). The WebSocket
streaming endpoint checks that same session cookie too — it runs outside
Next.js's normal request handling (see "Custom server" below) so it
verifies auth itself in `server.js`, rather than relying on middleware.

## Setup (Docker, recommended)

This is the path most likely to "just work" — it pins Node, Chromium, and
every system library Chromium needs inside the image, so you're not
depending on whatever happens to already be installed on the host.

```bash
cp .env.example .env
# edit .env: set ADMIN_USERNAME, ADMIN_PASSWORD, and a long SESSION_SECRET
#   openssl rand -base64 48   ← generates a good SESSION_SECRET

docker compose up -d --build
```

That's it — open `http://<host>:3000`. The image build downloads Chromium
itself (needs outbound internet during `build`, specifically to
`cdn.playwright.dev`), so the first build takes a few minutes; later builds
reuse Docker's layer cache and are much faster unless `package.json`
changed.

`./data` on the host is mounted into the container, so the device registry
and every device's logged-in browser profile survive `docker compose down`
and rebuilds. To fully reset, stop the container and delete that folder's
contents.

**Reaching your LAN devices:** the container uses normal Docker bridge
networking by default, which can reach your LAN (e.g. `192.168.1.1`) via
the host's routing - this works for the overwhelming majority of setups.
If a device turns out to be unreachable only from inside the container, add
`network_mode: host` to `docker-compose.yml` (drop the `ports:` section if
you do - the app binds directly to the host's port 3000 instead).

## Setup (without Docker)

```bash
npm install
npx playwright install --with-deps chromium   # downloads the headless browser

cp .env.example .env.local
# edit .env.local: set ADMIN_USERNAME, ADMIN_PASSWORD, and a long SESSION_SECRET
#   openssl rand -base64 48   ← generates a good SESSION_SECRET

npm run dev      # http://localhost:3000, runs via server.js
# or for production:
npm run build && npm start
```

If your server has outbound firewall rules, `playwright install` needs
`cdn.playwright.dev` reachable to download the Chromium binary.

## First device

Open the dashboard, log in, and use the **+** button in the sidebar to add
your first device (name, IP, port, http/https, optional base path).
Opening a device for the first time will take a couple of seconds while its
Chromium session starts up and navigates to it.

## Putting it behind Cloudflare Tunnel

Only **one** hostname needs to be tunneled — the dashboard app itself.

```yaml
# cloudflared config.yml
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: dash.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

Cloudflare Tunnel proxies WebSocket upgrades transparently, so the
screencast connection (`/ws/device/<id>`) works through it with no extra
configuration. Strongly recommended: put **Cloudflare Access** in front of
`dash.yourdomain.com` as a second auth layer. The session cookie is marked
`Secure` automatically whenever the request arrives over HTTPS (directly or
via `x-forwarded-proto` from the proxy), so both plain-HTTP LAN access and
HTTPS tunnel access log in correctly with no extra configuration — see
`COOKIE_SECURE` in `.env.example` only if you need to override that
auto-detection.

## Project layout

```
Dockerfile, docker-compose.yml         container build (pinned Node + Chromium + its system libs)
server.js                              custom Node server: Next.js + raw WebSocket upgrade handling
app/
  login/page.tsx                       dashboard login screen
  (dashboard)/
    layout.tsx                         wraps everything below in auth + device context
    page.tsx                           empty-state / overview
    device/[id]/page.tsx               renders the live remote screen for a device
  api/
    auth/login, auth/logout            dashboard session cookie
    devices/, devices/[id]             device registry CRUD
components/
  Sidebar.tsx, Header.tsx              device list / switcher, current-device info
  RemoteScreen.tsx                     canvas that renders the screencast + forwards input
  AddDeviceModal.tsx                   add/edit device form
  DeviceContext.tsx                    client-side device state
lib/
  db.js                                device registry (Node's built-in node:sqlite - no native build step)
  browser-manager.js                   Playwright session lifecycle, screencast, input replay
  select-polyfill.js                   in-page <select> dropdown lists (the screencast can't show native popups)
  ws-handler.js                        per-WebSocket-connection message loop
  session.js                           session-cookie verification (used by both middleware.ts and server.js)
  auth.ts                              session token creation (login) + re-exports session.js's verify
middleware.ts                          redirects unauthenticated page/API requests to /login
data/
  dashboard.db                         device registry (gitignored)
  profiles/<device-id>/                each device's persistent Chromium profile - this is its "session" (gitignored)
```

### Why a custom server (`server.js`) instead of plain `next start`

The live device view needs a WebSocket that stays open and streams frames
continuously — something Next.js's normal `app/api/*` route handlers can't
do (they're request/response, not long-lived sockets). `server.js` wraps
Next's own request handler in a plain Node `http.Server` and adds a raw
`ws` WebSocket server listening for upgrades on `/ws/device/<id>`. This
also means `npm run dev` / `npm start` now run `node server.js`, not the
`next` CLI directly — notably, a custom server doesn't get Next's automatic
`.env` loading, so `server.js` loads it explicitly via `@next/env`.

## Known limitations

- **One headless Chromium process per device you've opened.** Each costs
  real CPU/RAM on the server, more than the earlier proxy-based approach.
  Sessions for devices you're not currently viewing stop their screencast
  (cheap) but keep the browser profile/page open (so switching back is
  instant) until you close/delete the device.
- **File uploads work via an upload button.** The headless browser runs on
  the server, so its native file picker can never see your machine's disk.
  Instead, click the upload button in the device view (or click Browse in
  the remote page and you'll be prompted) to send a file from your device
  over the device WebSocket (max 50 MB); the server stages it and feeds it
  to the remote page's file picker (`fileStart` / `fileChunk` / `fileEnd` /
  `fileChooser` / `fileReady` / `fileConsumed` messages in
  `lib/browser-manager.js` + `components/RemoteScreen.tsx`).
- **Downloads from the remote page come back to you.** A device UI saving a
  file (config backup, log export) downloads into the server's headless
  browser; the server stages it under `data/downloads/` (newest 20 per
  device, 7-day retention) and announces it over the device WebSocket
  (`downloadReady`). The device view shows a save link plus a download
  button listing every staged file, served as attachments from
  `/api/devices/:id/downloads` in `server.js` (same dashboard login
  required).
- **No clipboard bridging.** You can type into the remote page, but your
  system clipboard isn't synced with it — copy/paste between your machine
  and the device's UI isn't wired up.
- **Adaptive remote viewport.** Each headless page renders at its viewer's
  component size (reported on connect, updated on resize, capped at
  1920×1200 to bound CPU/bandwidth) instead of a fixed resolution, so the
  device UI always fills the available space. With several tabs viewing
  the same device, the page uses the largest viewer size.
- **A crashed Chromium process for one device doesn't affect others** (the
  server catches and reports that per-session, see `lib/browser-manager.js`
  and the process-level guards in `server.js`), but a server restart drops
  all active screencasts — profiles (logins) survive; everyone just needs
  to reopen the device view.
- **Native dropdowns are re-rendered in-page.** The screencast captures the
  page surface only, so the browser's own `<select>` popup (and date/color
  picker popups) would never appear in the stream. Single-choice `<select>`
  elements instead open a plain-DOM option list (`lib/select-polyfill.js`)
  that looks and behaves like the native one; picking an option writes it
  back to the real `<select>` and fires `input`/`change` so device UIs react
  normally. Multi-selects render inline already and are untouched.
- **JavaScript dialogs are relayed to the dashboard.** Playwright dismisses
  `alert`/`confirm`/`prompt`/`beforeunload` dialogs with no listener, and the
  native popup wouldn't show in the screencast anyway. The server instead
  pauses the page (as a real browser would) and forwards the dialog to
  viewers, who answer through a modal in the device view (`dialog` /
  `dialogAccept` / `dialogDismiss` / `dialogClosed` over the device
  WebSocket); the answer flows back synchronously so page logic is unaffected.
- Single admin account only — this isn't a multi-user system.
