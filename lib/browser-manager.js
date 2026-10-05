const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const PROFILES_DIR = path.join(process.cwd(), 'data', 'profiles');
if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });

// Fixed remote viewport. Every client sees/controls the page at this
// resolution; the frontend canvas scales the picture to fit, and scales
// click coordinates back up to this size before forwarding them.
// The viewport each headless page uses. This is only the fallback used
// before any viewer reports its size - the actual viewport tracks the
// viewing component: clients send their size (?w=&h= on connect,
// {type:'viewport'} on resize) and the session adopts the largest
// subscriber size, clamped to SERVER_MAX below to bound CPU/bandwidth.
// The frontend canvas scales the picture to fit, and scales click
// coordinates back up to the live size (see 'metadata' messages) before
// forwarding them.
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
// Upper bound for an adaptive viewport - a single JPEG screencast frame
// scales roughly with pixel count, so this caps per-device cost.
const SERVER_MAX = { width: 1920, height: 1200 };
const SERVER_MIN = { width: 320, height: 200 };

function clampViewport(width, height) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return {
    width: Math.min(SERVER_MAX.width, Math.max(SERVER_MIN.width, w)),
    height: Math.min(SERVER_MAX.height, Math.max(SERVER_MIN.height, h)),
  };
}

/**
 * deviceId -> { context, page, cdp, subscribers: Set<WebSocket>, screencasting }
 * One headless Chromium *context* per device, kept alive for as long as the
 * server runs. The context's on-disk profile (data/profiles/<id>) is what
 * makes logins survive both a page switch and a server restart - it's a
 * real browser profile, not a hand-rolled cookie store.
 */
const sessions = new Map();

function getDeviceRow(id) {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
}

function assertChromiumInstalled() {
  const execPath = chromium.executablePath();
  if (!execPath || !fs.existsSync(execPath)) {
    throw new Error(
      "Chromium isn't installed on the server. Run: npx playwright install --with-deps chromium"
    );
  }
}

async function getOrCreateSession(deviceId) {
  const existing = sessions.get(deviceId);
  if (existing) return existing;

  const device = getDeviceRow(deviceId);
  if (!device) {
    throw new Error('Device not found');
  }

  // Check this up front rather than letting Playwright attempt the launch -
  // a missing binary should fail as a clean, catchable error for this one
  // device, not risk an unhandled error taking the whole server down.
  assertChromiumInstalled();

  const userDataDir = path.join(PROFILES_DIR, deviceId);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: DEFAULT_VIEWPORT,
    ignoreHTTPSErrors: true,
    args: [
      // Chromium's sandbox needs either a non-root user with the SYS_ADMIN
      // capability, or --no-sandbox. The Docker image runs as root for
      // simplicity, so --no-sandbox is required there; harmless elsewhere.
      // Acceptable here since these headless tabs only ever render your
      // own LAN devices' admin UIs, not arbitrary internet content.
      '--no-sandbox',
      // Docker's default /dev/shm is only 64MB, which Chromium's renderer
      // can exhaust and crash on. This flag makes it use /tmp instead -
      // slightly slower, much harder to crash. (docker-compose.yml also
      // raises shm_size as a second layer of headroom.)
      '--disable-dev-shm-usage',
    ],
  });

  const page = context.pages()[0] || (await context.newPage());
  const url = `${device.protocol}://${device.ip}:${device.port}${device.base_path || ''}/`;

  // Don't let a slow/offline device block session creation - whatever the
  // page ends up showing (even a browser error page) still streams fine.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

  const session = {
    context,
    page,
    cdp: null,
    screencasting: false,
    createdAt: Date.now(),
    viewport: { ...DEFAULT_VIEWPORT },
    // ws -> { width, height }: each viewer's last reported component size.
    // The live viewport is the largest of these (clamped).
    viewerSizes: new Map(),
    // Serializes viewport resizes - a resize storm must never overlap a
    // stop/resize/start sequence with itself.
    resizeQueue: Promise.resolve(),
    broadcast: null,
    subscribers: new Set(),
  };
  sessions.set(deviceId, session);

  page.on('close', () => {
    sessions.delete(deviceId);
  });

  return session;
}

function ensureBroadcast(session) {
  if (!session.broadcast) {
    session.broadcast = (base64Jpeg) => {
      const payload = JSON.stringify({ type: 'frame', data: base64Jpeg });
      for (const sock of session.subscribers) {
        if (sock.readyState === sock.OPEN) {
          sock.send(payload);
        }
      }
    };
  }
  return session.broadcast;
}

async function ensureCdp(session) {
  if (session.cdp) return session.cdp;
  const cdp = await session.context.newCDPSession(session.page);
  session.cdp = cdp;
  const broadcast = ensureBroadcast(session);
  cdp.on('Page.screencastFrame', (frame) => {
    broadcast(frame.data);
    cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  return cdp;
}

async function startScreencast(session) {
  if (session.screencasting) return;
  const cdp = await ensureCdp(session);

  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 70,
    maxWidth: session.viewport.width,
    maxHeight: session.viewport.height,
    everyNthFrame: 1,
  });

  session.screencasting = true;
}

async function stopScreencast(session) {
  if (!session.screencasting) return;
  if (session.cdp) {
    try {
      await session.cdp.send('Page.stopScreencast');
    } catch {
      // session/page may already be gone - drop the dead CDP handle so a
      // later start creates a fresh one instead of reusing it.
      session.cdp = null;
    }
  }
  session.screencasting = false;
}

function sendMetadata(session) {
  const payload = JSON.stringify({
    type: 'metadata',
    width: session.viewport.width,
    height: session.viewport.height,
  });
  for (const sock of session.subscribers) {
    if (sock.readyState === sock.OPEN) {
      sock.send(payload);
    }
  }
}

/**
 * Recomputes the live viewport from all viewers' reported sizes and, if it
 * changed, resizes the page and restarts the screencast at the new size.
 * Serialized per session; failures keep the previous size.
 */
function applyViewport(session) {
  session.resizeQueue = session.resizeQueue
    .catch(() => {})
    .then(async () => {
      let target = null;
      for (const size of session.viewerSizes.values()) {
        if (!target) {
          target = { ...size };
        } else {
          target.width = Math.max(target.width, size.width);
          target.height = Math.max(target.height, size.height);
        }
      }
      // Nobody watching (or no usable sizes): leave the page as-is.
      if (!target) return;
      if (
        target.width === session.viewport.width &&
        target.height === session.viewport.height
      ) {
        return;
      }
      const previous = { ...session.viewport };
      try {
        await stopScreencast(session);
        await session.page.setViewportSize(target);
        session.viewport = target;
        if (session.subscribers.size > 0) {
          await startScreencast(session);
        }
        sendMetadata(session);
      } catch (err) {
        console.error('[browser-manager] viewport resize failed, keeping previous size', err);
        session.viewport = previous;
        try {
          if (session.subscribers.size > 0) await startScreencast(session);
        } catch {
          // screencast stays down; the next attach/resize retries
        }
      }
    });
  return session.resizeQueue;
}

/** Called when a browser tab opens this device's stream. */
async function attach(deviceId, ws, viewport) {
  const session = await getOrCreateSession(deviceId);
  session.subscribers.add(ws);

  const size = viewport ? clampViewport(viewport.width, viewport.height) : null;
  if (size) {
    session.viewerSizes.set(ws, size);
  }

  ensureBroadcast(session);
  // Apply the viewer's size before the first frame so the stream starts
  // at (or near) the right resolution instead of visibly resizing after.
  await applyViewport(session);
  if (session.subscribers.size > 0) {
    await startScreencast(session);
  }

  if (ws.readyState === ws.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'metadata',
        width: session.viewport.width,
        height: session.viewport.height,
      })
    );
  }
}

/** Snapshot of live headless sessions for the overview page. */
function getSessionStatus() {
  const status = {};
  for (const [deviceId, session] of sessions) {
    status[deviceId] = {
      viewers: session.subscribers.size,
      streaming: session.screencasting,
      width: session.viewport.width,
      height: session.viewport.height,
      startedAt: session.createdAt,
    };
  }
  return status;
}

/** Called when a viewing tab disconnects. Session (and login state) stays alive. */
function detach(deviceId, ws) {
  const session = sessions.get(deviceId);
  if (!session) return;
  session.subscribers.delete(ws);
  session.viewerSizes.delete(ws);
  if (session.subscribers.size === 0) {
    stopScreencast(session).catch(() => {});
  }
}

/** Called when a viewing tab's component size changes. */
function handleViewport(deviceId, ws, msg) {
  const session = sessions.get(deviceId);
  if (!session || !session.subscribers.has(ws)) return;
  const size = clampViewport(msg.width, msg.height);
  if (!size) return;
  const prev = session.viewerSizes.get(ws);
  if (prev && prev.width === size.width && prev.height === size.height) return;
  session.viewerSizes.set(ws, size);
  applyViewport(session).catch(() => {});
}

/** Replays a mouse/keyboard event from the client onto the real page. */
async function handleInput(deviceId, msg) {
  const session = sessions.get(deviceId);
  if (!session) return;
  const { page } = session;

  try {
    switch (msg.type) {
      case 'mousemove':
        await page.mouse.move(msg.x, msg.y);
        break;
      case 'mousedown':
        await page.mouse.move(msg.x, msg.y);
        await page.mouse.down({ button: msg.button || 'left' });
        break;
      case 'mouseup':
        await page.mouse.up({ button: msg.button || 'left' });
        break;
      case 'wheel':
        await page.mouse.wheel(msg.deltaX || 0, msg.deltaY || 0);
        break;
      case 'keydown':
        await page.keyboard.down(msg.key);
        break;
      case 'keyup':
        await page.keyboard.up(msg.key);
        break;
      case 'reload':
        await page.reload().catch(() => {});
        break;
      default:
        break;
    }
  } catch {
    // page may be mid-navigation when an input event arrives - safe to drop
  }
}

/** Fully tears down a device's session (used on device delete/edit). */
async function destroySession(deviceId) {
  const session = sessions.get(deviceId);
  if (session) {
    await stopScreencast(session).catch(() => {});
    await session.context.close().catch(() => {});
    sessions.delete(deviceId);
  }
  const userDataDir = path.join(PROFILES_DIR, deviceId);
  fs.rm(userDataDir, { recursive: true, force: true }, () => {});
}

module.exports = { attach, detach, handleInput, handleViewport, destroySession, getSessionStatus, DEFAULT_VIEWPORT };
