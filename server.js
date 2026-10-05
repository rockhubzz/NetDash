const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { loadEnvConfig } = require('@next/env');

// A custom server doesn't get Next's automatic .env / .env.local loading
// the way `next dev`/`next start` do - load it ourselves, first thing.
loadEnvConfig(process.cwd());

// This process also owns every device's headless Chromium session. An
// error surfacing from one device's browser (a crashed renderer, a failed
// launch, a flaky CDP call) must never be allowed to kill the dashboard for
// every other device - log it and keep running. Pair this with a process
// supervisor (systemd, pm2) in production as a backstop for anything
// actually fatal.
process.on('unhandledRejection', (err) => {
  console.error('[unhandled rejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaught exception]', err);
});
const { WebSocketServer } = require('ws');
const wsHandler = require('./lib/ws-handler');
const { verifySessionToken, getCookie } = require('./lib/session');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();
const port = parseInt(process.env.PORT || '3000', 10);

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    const parsed = parse(req.url, true);
    const match = parsed.pathname && parsed.pathname.match(/^\/ws\/device\/([^/]+)$/);

    if (!match) {
      socket.destroy();
      return;
    }

    // This upgrade handler runs outside Next's request pipeline, so it
    // never hits middleware.ts - the dashboard's own session cookie has to
    // be checked here explicitly, or the device stream would be reachable
    // by anyone who knows (or guesses) a device id, logged in or not.
    const token = getCookie(req.headers.cookie, 'dashboard_session');
    const session = token ? await verifySessionToken(token) : null;
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const deviceId = match[1];
    // Initial viewport from ?w=&h= so the stream starts at (or near) the
    // viewer's size. Resizes afterwards arrive as {type:'viewport'}.
    const viewport = {
      width: Number.parseInt(parsed.query?.w, 10),
      height: Number.parseInt(parsed.query?.h, 10),
    };
    wss.handleUpgrade(req, socket, head, (ws) => {
      wsHandler.handleConnection(ws, deviceId, viewport);
    });
  });

  server.listen(port, () => {
    console.log(`> Network Dashboard ready on http://localhost:${port}`);
  });
});
