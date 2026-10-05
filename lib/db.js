const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'dashboard.db'));

// `next build` ("Collecting page data") imports the API routes in parallel
// Node workers that all share the builder's fresh DB file, and `node:sqlite`
// defaults to busy_timeout=0 - so the losers of the schema-creation race
// throw SQLITE_BUSY ("database is locked") at import time and fail the
// build. Waiting instead of failing fixes it, and WAL mode also improves
// concurrent read/write behaviour for the running server.
db.exec('PRAGMA busy_timeout = 5000');
try {
  db.exec('PRAGMA journal_mode = WAL');
} catch {
  // e.g. filesystems without shared-memory support - fall back to the
  // default rollback journal rather than failing to start.
}

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ip TEXT NOT NULL,
    port INTEGER NOT NULL,
    protocol TEXT NOT NULL DEFAULT 'http',
    base_path TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT 'server',
    color TEXT NOT NULL DEFAULT '#e8a33d',
    created_at INTEGER NOT NULL
  );
`);

// Session state (cookies/localStorage/logins) now lives in each device's
// Playwright persistent browser profile under data/profiles/<id> instead of
// a hand-rolled cookie table - see lib/browser-manager.js.

module.exports = db;
