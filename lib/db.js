const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'dashboard.db'));

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
