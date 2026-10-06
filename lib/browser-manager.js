const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const PROFILES_DIR = path.join(process.cwd(), 'data', 'profiles');
if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });

// Files uploaded by viewers for injection into the remote page's
// <input type=file>. The headless Chromium runs on the server so its native
// file picker can never see the viewer's local disk - viewers send file
// bytes over the device WebSocket and the server feeds them to Playwright's
// file chooser (see handleFileChooser below).
const UPLOADS_DIR = path.join(process.cwd(), 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// Per-file cap - firmware images are typically a few MB; this is generous
// while still bounding memory/disk per upload. Must match the client check.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
// Base64 chunk size the client uses; only used for validation/logging.
const MAX_PENDING_UPLOADS = 5;

// Files downloaded BY the remote page (e.g. a router's "Backup config"
// button). The headless Chromium runs on the server, so its downloads land
// on server disk - viewers fetch them back over HTTP (see server.js's
// /api/devices/:id/downloads routes) after a {type:'downloadReady'}
// WebSocket notification. Filenames on disk encode device + id + original
// name so the index can be rebuilt from a directory scan after a restart.
const DOWNLOADS_DIR = path.join(process.cwd(), 'data', 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
// Keep the newest N downloads per device; files older than this are pruned.
const MAX_DOWNLOADS_PER_DEVICE = 20;
const DOWNLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// downloadId charset (base36 timestamp + random) - used by the parser below.
const DOWNLOAD_ID_RE = '[a-z0-9]{6,20}';

/** `${deviceId}/${downloadId}` -> { id, deviceId, name, size, createdAt, path } */
const downloads = new Map();

function sanitizeDevicePart(id) {
  return (String(id).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'device');
}

function downloadFileName(deviceId, id, name) {
  return `${sanitizeDevicePart(deviceId)}--${id}--${sanitizeUploadName(name)}`;
}

function parseDownloadFileName(fname) {
  const m = String(fname).match(new RegExp(`^(.+?)--(${DOWNLOAD_ID_RE})--(.+)$`));
  if (!m) return null;
  return { deviceId: m[1], id: m[2], name: m[3] };
}

function indexDownloadRecord(rec) {
  downloads.set(`${rec.deviceId}/${rec.id}`, rec);
}

// Rebuild the in-memory index from files left on disk by a previous run,
// dropping anything past retention so a restart also garbage-collects.
(function rebuildDownloadIndex() {
  let files = [];
  try {
    files = fs.readdirSync(DOWNLOADS_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  for (const fname of files) {
    const parsed = parseDownloadFileName(fname);
    if (!parsed) continue;
    const full = path.join(DOWNLOADS_DIR, fname);
    let stat = null;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (now - stat.mtimeMs > DOWNLOAD_RETENTION_MS) {
      try {
        fs.rmSync(full, { force: true });
      } catch {}
      continue;
    }
    indexDownloadRecord({
      id: parsed.id,
      deviceId: parsed.deviceId,
      name: parsed.name,
      size: stat.size,
      createdAt: Math.round(stat.mtimeMs),
      path: full,
    });
  }
  // Enforce the per-device cap after reindexing.
  try {
    const byDevice = new Map();
    for (const rec of downloads.values()) {
      if (!byDevice.has(rec.deviceId)) byDevice.set(rec.deviceId, []);
      byDevice.get(rec.deviceId).push(rec);
    }
    for (const [dev, list] of byDevice) {
      list.sort((a, b) => b.createdAt - a.createdAt);
      for (const extra of list.slice(MAX_DOWNLOADS_PER_DEVICE)) {
        downloads.delete(`${dev}/${extra.id}`);
        try {
          fs.rmSync(extra.path, { force: true });
        } catch {}
      }
    }
  } catch {}
})();

function listDownloads(deviceId) {
  return [...downloads.values()]
    .filter((r) => r.deviceId === String(deviceId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => ({ id: r.id, name: r.name, size: r.size, createdAt: r.createdAt }));
}

function getDownloadRecord(deviceId, downloadId) {
  if (!String(downloadId).match(new RegExp(`^${DOWNLOAD_ID_RE}$`))) return null;
  const rec = downloads.get(`${String(deviceId)}/${String(downloadId)}`);
  if (!rec) return null;
  try {
    if (!fs.existsSync(rec.path)) {
      downloads.delete(`${String(deviceId)}/${String(downloadId)}`);
      return null;
    }
  } catch {
    return null;
  }
  return rec;
}

function pruneDownloads(deviceId) {
  const list = listDownloads(deviceId);
  for (const entry of list.slice(MAX_DOWNLOADS_PER_DEVICE)) {
    downloads.delete(`${String(deviceId)}/${entry.id}`);
    const full = path.join(DOWNLOADS_DIR, downloadFileName(deviceId, entry.id, entry.name));
    try {
      fs.rm(full, { force: true }, () => {});
    } catch {}
    // The on-disk name embeds the original filename, which may have been
    // sanitized differently across versions - fall back to a prefix scan.
    try {
      const prefix = `${sanitizeDevicePart(deviceId)}--${entry.id}--`;
      for (const f of fs.readdirSync(DOWNLOADS_DIR)) {
        if (f.startsWith(prefix)) fs.rm(path.join(DOWNLOADS_DIR, f), { force: true }, () => {});
      }
    } catch {}
  }
}

/**
 * Persists a finished Playwright download and tells every viewer it is
 * ready to fetch over HTTP.
 */
async function handleDownload(deviceId, download) {
  const session = sessions.get(deviceId);
  const suggested = sanitizeUploadName(
    (() => {
      try {
        return download.suggestedFilename() || 'download.bin';
      } catch {
        return 'download.bin';
      }
    })()
  );
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const rec = {
    id,
    deviceId: String(deviceId),
    name: suggested,
    size: 0,
    createdAt: Date.now(),
    path: path.join(DOWNLOADS_DIR, downloadFileName(deviceId, id, suggested)),
  };
  try {
    await download.saveAs(rec.path);
  } catch (err) {
    try {
      fs.rm(rec.path, { force: true }, () => {});
    } catch {}
    let reason = 'Download failed';
    try {
      const failure = await download.failure();
      if (typeof failure === 'string' && failure) reason = `Download failed: ${failure}`;
    } catch {}
    console.error('[browser-manager] download save failed', err);
    if (session) broadcastTo(session, { type: 'fileError', message: reason });
    return;
  }
  try {
    rec.size = fs.statSync(rec.path).size;
  } catch {}
  indexDownloadRecord(rec);
  pruneDownloads(deviceId);
  if (session) {
    broadcastTo(session, {
      type: 'downloadReady',
      id: rec.id,
      name: rec.name,
      size: rec.size,
    });
  }
}

// Native `<select>` popups render on a separate popup surface that CDP
// `Page.startScreencast` never captures (it only streams the page surface),
// so dropdown options were invisible in the dashboard. This in-page
// replacement renders the option list as ordinary DOM, which the screencast
// does capture. Injected into every page via `addInitScript` before the
// first navigation; see lib/select-polyfill.js for the full explanation.
const SELECT_POLYFILL_PATH = path.join(__dirname, 'select-polyfill.js');
let selectPolyfillSource = null;
function getSelectPolyfillSource() {
  if (selectPolyfillSource === null) {
    try {
      selectPolyfillSource = fs.readFileSync(SELECT_POLYFILL_PATH, 'utf8');
    } catch (err) {
      console.error('[browser-manager] could not load select polyfill, dropdowns may not render', err);
      selectPolyfillSource = '';
    }
  }
  return selectPolyfillSource;
}

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
    // Downloads triggered by the remote page (e.g. "Backup config") land
    // on server disk and are re-exposed to viewers over HTTP - see
    // handleDownload. Without acceptDownloads the download event still
    // fires but saveAs() has nothing to save.
    acceptDownloads: true,
    downloadsPath: DOWNLOADS_DIR,
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

  // Must run before the first navigation so the polyfill is present on the
  // device's login page as well as every page after it. `addInitScript`
  // re-runs automatically on each navigation, and the script itself guards
  // against double-install, so this is safe to register once per context.
  const polyfill = getSelectPolyfillSource();
  if (polyfill) {
    await context.addInitScript({ content: polyfill }).catch(() => {});
  }

  const url = `${device.protocol}://${device.ip}:${device.port}${device.base_path || ''}/`;

  // Registered before the first navigation so dialogs firing during page
  // load (e.g. an onload alert) are captured instead of auto-dismissed.
  // The session is in the map for the same reason: handleDialog looks it up
  // there.
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
    // A JavaScript dialog (alert/confirm/prompt/beforeunload) waiting for a
    // viewer to answer it. See handleDialog below. Only one can be open at
    // a time: the page's JS stays paused until it is settled.
    pendingDialog: null,
    // File-upload bridging (viewer host -> remote page). Viewers push file
    // bytes over the WebSocket; they land here as real files under
    // data/uploads and are fed to the next file chooser. See
    // handleFileChooser / handleFileMessage below.
    pendingUploadPaths: [],
    waitingChooser: null,
    incomingFiles: new Map(),
  };
  sessions.set(deviceId, session);

  page.on('close', () => {
    sessions.delete(deviceId);
  });
  page.on('dialog', (dialog) => {
    try {
      handleDialog(deviceId, dialog);
    } catch {
      dialog.dismiss().catch(() => {});
    }
  });
  // Fires when the remote page opens a file picker (user clicked
  // <input type=file> via forwarded mouse input). The server-side picker
  // could never show the viewer's files, so feed it the already-uploaded
  // file(s), or park it and ask a viewer to upload one.
  page.on('filechooser', (chooser) => {
    try {
      handleFileChooser(deviceId, chooser);
    } catch (err) {
      console.error('[browser-manager] filechooser error', err);
      try {
        if (!chooser.isMultiple()) chooser.cancel().catch(() => {});
      } catch {}
    }
  });
  // Downloads land on server disk (see acceptDownloads above) - persist
  // each finished one and notify viewers so they can fetch it back over
  // HTTP. Device UIs sometimes download from a popup window rather than
  // the main page, hence the context-level listener as well.
  page.on('download', (download) => {
    handleDownload(deviceId, download).catch((err) => {
      console.error('[browser-manager] download error', err);
    });
  });
  context.on('page', (p) => {
    if (p === page) return;
    p.on('download', (download) => {
      handleDownload(deviceId, download).catch((err) => {
        console.error('[browser-manager] popup download error', err);
      });
    });
  });

  // Don't let a slow/offline device block session creation - whatever the
  // page ends up showing (even a browser error page) still streams fine.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

  return session;
}

/**
 * JavaScript dialogs (alert/confirm/prompt/beforeunload) need a viewer round
 * trip, for two reasons. Playwright auto-dismisses dialogs that have no
 * `dialog` listener, so without this every alert would vanish instantly and
 * every confirm would read as "cancel". And even a handled native dialog
 * would be invisible: like `<select>` popups it renders on a separate popup
 * surface the screencast never captures. So the page is left paused (as a
 * real browser would leave it) while viewers answer through dashboard UI.
 */
function dialogPayload(pending) {
  return {
    type: 'dialog',
    dialogType: pending.dialogType,
    message: pending.message,
    defaultValue: pending.defaultValue,
  };
}

function handleDialog(deviceId, dialog) {
  const session = sessions.get(deviceId);
  if (!session) {
    dialog.dismiss().catch(() => {});
    return;
  }
  // Store first: the page is paused until this is settled, and a slow
  // broadcast must never lose the only handle that can resume it.
  session.pendingDialog = {
    dialog,
    dialogType: dialog.type(),
    message: dialog.message() || '',
    defaultValue: dialog.defaultValue() || '',
  };
  const payload = JSON.stringify(dialogPayload(session.pendingDialog));
  for (const sock of session.subscribers) {
    if (sock.readyState === sock.OPEN) {
      sock.send(payload);
    }
  }
}

/**
 * Settles the pending dialog from a viewer's answer. First response wins;
 * everyone is then told the dialog is gone. `accept` with prompt text for
 * `prompt`, plain accept otherwise.
 */
async function handleDialogResponse(deviceId, accept, text) {
  const session = sessions.get(deviceId);
  if (!session || !session.pendingDialog) return;
  const pending = session.pendingDialog;
  session.pendingDialog = null;
  // Tell viewers first: the page may fire another dialog synchronously as
  // it resumes, and its `dialog` message must arrive after this one.
  const closed = JSON.stringify({ type: 'dialogClosed' });
  for (const sock of session.subscribers) {
    if (sock.readyState === sock.OPEN) {
      sock.send(closed);
    }
  }
  try {
    if (accept) {
      if (pending.dialogType === 'prompt') await pending.dialog.accept(text ?? pending.defaultValue);
      else await pending.dialog.accept();
    } else {
      await pending.dialog.dismiss();
    }
  } catch {
    // Page navigated/crashed mid-dialog - nothing left to settle.
  }
}

/**
 * File-upload bridging: viewer host -> headless page.
 *
 * The remote Chromium runs on the server, so clicking its
 * `<input type=file>` would open a server-side picker with no access to
 * the viewer's disk. Instead:
 *  1. The viewer uploads file bytes over the device WebSocket
 *     (fileStart/fileChunk/fileEnd, base64 chunks).
 *  2. The server writes them to data/uploads/ and records the path in
 *     session.pendingUploadPaths.
 *  3. When the remote page opens a file chooser, the pending file(s) are
 *     fed to it via chooser.setFiles(). If nothing is pending yet, the
 *     chooser is parked in session.waitingChooser and viewers are asked
 *     to pick a file ({type:'fileChooser'}); the upload then fulfills it.
 */

function sanitizeUploadName(name) {
  const base = path.basename(String(name || 'upload.bin')).slice(0, 120) || 'upload.bin';
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function sendTo(ws, obj) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

function broadcastTo(session, obj) {
  const payload = JSON.stringify(obj);
  for (const sock of session.subscribers) {
    try {
      if (sock.readyState === sock.OPEN) sock.send(payload);
    } catch {}
  }
}

async function fulfillChooser(session, chooser) {
  const paths = session.pendingUploadPaths.filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (paths.length === 0) return false;
  try {
    if (chooser.isMultiple()) {
      await chooser.setFiles(paths);
    } else {
      // Single-file input: use the most recently uploaded file.
      await chooser.setFiles(paths[paths.length - 1]);
    }
    broadcastTo(session, { type: 'fileConsumed' });
    return true;
  } catch (err) {
    console.error('[browser-manager] setFiles failed', err);
    broadcastTo(session, { type: 'fileError', message: 'Could not deliver file to remote page' });
    return false;
  }
}

async function handleFileChooser(deviceId, chooser) {
  const session = sessions.get(deviceId);
  if (!session) {
    try {
      await chooser.cancel();
    } catch {}
    return;
  }
  // If a previous chooser is still parked (viewer never uploaded), cancel
  // it - only the latest click is still relevant to the user.
  if (session.waitingChooser && session.waitingChooser !== chooser) {
    try {
      await session.waitingChooser.cancel();
    } catch {}
    session.waitingChooser = null;
  }
  const delivered = await fulfillChooser(session, chooser);
  if (delivered) return;
  // No file ready yet: park this chooser and ask viewers to pick one. The
  // page stays paused on the open picker until the upload arrives (or a
  // timeout below cancels it so the page doesn't hang forever).
  session.waitingChooser = chooser;
  broadcastTo(session, {
    type: 'fileChooser',
    multiple: (() => {
      try {
        return !!chooser.isMultiple();
      } catch {
        return false;
      }
    })(),
  });
  setTimeout(() => {
    if (session.waitingChooser === chooser) {
      session.waitingChooser = null;
      chooser.cancel().catch(() => {});
      broadcastTo(session, { type: 'fileChooserTimeout' });
    }
  }, 120000).unref?.();
}

function prunePendingUploads(session) {
  while (session.pendingUploadPaths.length > MAX_PENDING_UPLOADS) {
    const oldest = session.pendingUploadPaths.shift();
    try {
      if (oldest) fs.rm(oldest, { force: true }, () => {});
    } catch {}
  }
}

/**
 * Handles fileStart/fileChunk/fileEnd messages from one viewer. Replies
 * (fileReady/fileError/fileProgress) go back to the uploader only; the
 * fileChooser/fileConsumed broadcasts go to every viewer.
 * Returns true if the message was a file message (handled).
 */
async function handleFileMessage(deviceId, ws, msg) {
  const session = sessions.get(deviceId);
  if (!session) {
    sendTo(ws, { type: 'fileError', message: 'No browser session' });
    return true;
  }

  if (msg.type === 'fileStart') {
    const id = String(msg.id || '');
    const size = Number(msg.size);
    const name = sanitizeUploadName(msg.name);
    if (!id) {
      sendTo(ws, { type: 'fileError', message: 'Upload missing id' });
      return true;
    }
    if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
      sendTo(ws, {
        type: 'fileError',
        id,
        message: `File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)`,
      });
      return true;
    }
    session.incomingFiles.set(id, { name, size, received: 0, chunks: [], owner: ws });
    return true;
  }

  if (msg.type === 'fileChunk') {
    const incoming = session.incomingFiles.get(String(msg.id || ''));
    if (!incoming) return true;
    try {
      const buf = Buffer.from(String(msg.data || ''), 'base64');
      incoming.received += buf.length;
      if (incoming.received > MAX_UPLOAD_BYTES || incoming.received > incoming.size + 1024) {
        session.incomingFiles.delete(String(msg.id));
        sendTo(ws, { type: 'fileError', id: msg.id, message: 'Upload exceeded size limit' });
        return true;
      }
      incoming.chunks.push(buf);
    } catch {
      session.incomingFiles.delete(String(msg.id));
      sendTo(ws, { type: 'fileError', id: msg.id, message: 'Invalid upload data' });
    }
    return true;
  }

  if (msg.type === 'fileEnd') {
    const id = String(msg.id || '');
    const incoming = session.incomingFiles.get(id);
    if (!incoming) return true;
    session.incomingFiles.delete(id);
    try {
      const data = Buffer.concat(incoming.chunks);
      if (data.length !== incoming.size) {
        // Tolerate small base64 rounding differences, reject truncation.
        if (data.length === 0 || Math.abs(data.length - incoming.size) > 16) {
          sendTo(ws, { type: 'fileError', id, message: 'Upload incomplete, please retry' });
          return true;
        }
      }
      const safeDevice = String(deviceId).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'device';
      const filePath = path.join(UPLOADS_DIR, `${safeDevice}-${Date.now()}-${id}-${incoming.name}`);
      fs.writeFileSync(filePath, data);
      session.pendingUploadPaths.push(filePath);
      prunePendingUploads(session);
      sendTo(ws, { type: 'fileReady', id, name: incoming.name, size: data.length });
      // If the remote page is already sitting on an open file picker,
      // fulfill it immediately with the file that just arrived.
      const chooser = session.waitingChooser;
      if (chooser) {
        session.waitingChooser = null;
        const ok = await fulfillChooser(session, chooser);
        if (!ok) {
          // Keep the path pending so the next click can use it.
          broadcastTo(session, { type: 'fileChooser', multiple: false });
          session.waitingChooser = chooser;
        }
      }
    } catch (err) {
      console.error('[browser-manager] file upload save failed', err);
      sendTo(ws, { type: 'fileError', id, message: 'Could not save upload on server' });
    }
    return true;
  }

  if (msg.type === 'fileCancel') {
    session.incomingFiles.delete(String(msg.id || ''));
    return true;
  }

  return false;
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
    // A dialog opened while nobody was watching (or while this viewer was
    // disconnected) still blocks the page - show it immediately.
    if (session.pendingDialog) {
      ws.send(JSON.stringify(dialogPayload(session.pendingDialog)));
    }
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
  // Drop any half-uploaded files owned by this viewer.
  try {
    for (const [id, incoming] of session.incomingFiles) {
      if (incoming.owner === ws) session.incomingFiles.delete(id);
    }
  } catch {}
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
        // A pending dialog blocks navigation - settle it first: accepting a
        // beforeunload dialog leaves the page, dismissing any other dialog
        // just unblocks it so the reload can proceed.
        if (session.pendingDialog) {
          const isUnload = session.pendingDialog.dialogType === 'beforeunload';
          await handleDialogResponse(deviceId, isUnload).catch(() => {});
        }
        await page.reload().catch(() => {});
        break;
      case 'dialogAccept':
        await handleDialogResponse(deviceId, true, typeof msg.text === 'string' ? msg.text : undefined);
        break;
      case 'dialogDismiss':
        await handleDialogResponse(deviceId, false);
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
    // An open JavaScript dialog blocks the page - dismiss it first or the
    // context close below can hang waiting on it.
    if (session.pendingDialog) {
      const pending = session.pendingDialog;
      session.pendingDialog = null;
      await pending.dialog.dismiss().catch(() => {});
    }
    if (session.waitingChooser) {
      const chooser = session.waitingChooser;
      session.waitingChooser = null;
      await chooser.cancel().catch(() => {});
    }
    session.incomingFiles?.clear?.();
    for (const p of session.pendingUploadPaths || []) {
      try {
        fs.rm(p, { force: true }, () => {});
      } catch {}
    }
    // Device removed/edited: its staged uploads and finished downloads go
    // with it, same as its browser profile below.
    for (const entry of listDownloads(deviceId)) {
      downloads.delete(`${String(deviceId)}/${entry.id}`);
    }
    try {
      const prefix = `${sanitizeDevicePart(deviceId)}--`;
      for (const f of fs.readdirSync(DOWNLOADS_DIR)) {
        if (f.startsWith(prefix)) fs.rm(path.join(DOWNLOADS_DIR, f), { force: true }, () => {});
      }
    } catch {}
    await stopScreencast(session).catch(() => {});
    await session.context.close().catch(() => {});
    sessions.delete(deviceId);
  }
  const userDataDir = path.join(PROFILES_DIR, deviceId);
  fs.rm(userDataDir, { recursive: true, force: true }, () => {});
}

module.exports = { attach, detach, handleInput, handleViewport, handleFileMessage, listDownloads, getDownloadRecord, destroySession, getSessionStatus, DEFAULT_VIEWPORT, MAX_UPLOAD_BYTES };
