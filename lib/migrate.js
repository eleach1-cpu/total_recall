'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadConfig, noConfigMessage } = require('./config');
const { openStore, SCHEMA_VERSION } = require('./store');

// The owner's step, never a side effect. It first writes a complete, consistent copy of the store
// with VACUUM INTO (SQLite's own snapshot: it includes what is still in the -wal file, which a
// plain file copy of a live WAL database would miss), then upgrades the store in place.
// Rolling back = put the backup file back where the store was.
function backup(storeFile, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${path.basename(storeFile, '.sqlite')}-before-schema-${SCHEMA_VERSION}-${stamp}.sqlite`);
  const db = new DatabaseSync(storeFile);
  try { db.exec('PRAGMA busy_timeout = 5000'); db.prepare('VACUUM INTO ?').run(dest); } finally { db.close(); }
  return dest;
}

function run(cfg, opts = {}) {
  if (!fs.existsSync(cfg.store)) return { created: true, from: 0, to: SCHEMA_VERSION, backup: null };
  const probe = new DatabaseSync(cfg.store);
  let from = 1;
  try { const r = probe.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get(); from = r ? Number(r.value) || 1 : 1; } catch {} finally { probe.close(); }
  if (from >= SCHEMA_VERSION) return { from, to: from, backup: null, nothing: true };
  const dest = opts.noBackup ? null : backup(cfg.store, opts.backupDir || path.join(path.dirname(cfg.store), 'backups'));
  const s = openStore(cfg.store, { migrate: true });
  try { return { from, to: s.schemaVersion(), backup: dest }; } finally { s.close(); }
}

function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const r = run(cfg, { backupDir: typeof args.flags['backup-dir'] === 'string' ? args.flags['backup-dir'] : undefined });
  if (r.nothing) process.stdout.write(`the store is already schema version ${r.to}; nothing to do\n`);
  else if (r.created) process.stdout.write('there is no store yet; the first ingest creates it at the current version\n');
  else process.stdout.write(`migrated the store from schema version ${r.from} to ${r.to}\nbackup: ${r.backup}\nroll back: close every session, then copy that file over ${cfg.store}\n`);
  return 0;
}

module.exports = { run, backup, command };
