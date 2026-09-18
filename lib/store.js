'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id            INTEGER PRIMARY KEY,
  project       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  session_id    TEXT,
  ts            TEXT NOT NULL,
  role          TEXT,
  path          TEXT,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  files_json    TEXT NOT NULL DEFAULT '[]',
  tools_json    TEXT NOT NULL DEFAULT '[]',
  who           TEXT,
  outcome       TEXT,
  evidence_ids  TEXT NOT NULL DEFAULT '[]',
  quote         TEXT,
  reason        TEXT,
  superseded_by INTEGER REFERENCES docs(id),
  sha           TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS docs_session ON docs(session_id, ts);
CREATE INDEX IF NOT EXISTS docs_kind_status_ts ON docs(kind, status, ts);
CREATE INDEX IF NOT EXISTS docs_path ON docs(path);
CREATE INDEX IF NOT EXISTS docs_outcome ON docs(outcome) WHERE kind = 'statement';
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  title, body, content='docs', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE OF title, body ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO docs_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TABLE IF NOT EXISTS sources (
  path        TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mtime       TEXT NOT NULL,
  sha         TEXT NOT NULL,
  offset      INTEGER NOT NULL DEFAULT 0,
  ingested_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS distill_runs (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL,
  turn_from   INTEGER NOT NULL,
  turn_to     INTEGER NOT NULL,
  model       TEXT NOT NULL,
  prompt_sha  TEXT NOT NULL,
  ran_at      TEXT NOT NULL,
  lines       INTEGER NOT NULL,
  UNIQUE(session_id, turn_from, turn_to, model, prompt_sha)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS link_verdicts (
  old_id     INTEGER NOT NULL,
  new_id     INTEGER NOT NULL,
  prompt_sha TEXT NOT NULL,
  model      TEXT NOT NULL,
  replaces   INTEGER NOT NULL,
  PRIMARY KEY (old_id, new_id, prompt_sha)
);
CREATE TABLE IF NOT EXISTS vectors (
  doc_id INTEGER PRIMARY KEY REFERENCES docs(id),
  model  TEXT NOT NULL,
  vec    BLOB NOT NULL
);
`;

// Vectors are stored unit-length as raw Float32, so similarity is a plain dot product.
function toBlob(arr) {
  let n = 0; for (const x of arr) n += x * x;
  n = Math.sqrt(n) || 1;
  const f = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) f[i] = arr[i] / n;
  return Buffer.from(f.buffer);
}
function fromBlob(buf) {
  return new Float32Array(new Uint8Array(buf).buffer); // the copy owns its buffer, so the offset is 0 and aligned
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function docSha(d) {
  if (d.sha) return d.sha;
  if (d.kind === 'statement') return sha256(['statement', d.who, d.outcome, d.title, d.quote || ''].join(''));
  return sha256([d.kind, d.session_id || '', d.ts, d.role || '', d.path || '', d.body].join(''));
}

const COLS = ['project', 'kind', 'status', 'session_id', 'ts', 'role', 'path', 'title', 'body',
  'files_json', 'tools_json', 'who', 'outcome', 'evidence_ids', 'quote', 'reason', 'sha'];

function openStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  // A session-start ingest can land while a distill is writing; wait rather than fail SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);

  const insert = db.prepare(`INSERT OR IGNORE INTO docs (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`);
  const byShaId = db.prepare('SELECT id FROM docs WHERE sha = ?');

  function insertDoc(d) {
    const sha = docSha(d);
    const row = {
      project: d.project, kind: d.kind, status: d.status || 'active', session_id: d.session_id || null,
      ts: d.ts, role: d.role || null, path: d.path || null, title: d.title, body: d.body,
      files_json: d.files_json || '[]', tools_json: d.tools_json || '[]', who: d.who || null,
      outcome: d.outcome || null, evidence_ids: d.evidence_ids || '[]', quote: d.quote || null,
      reason: d.reason ?? null, sha,
    };
    const r = insert.run(...COLS.map((c) => row[c]));
    if (r.changes > 0) return { id: Number(r.lastInsertRowid), inserted: true };
    return { id: byShaId.get(sha).id, inserted: false };
  }

  // One filter clause for both lanes of a search (words and meaning), so they can never disagree
  // about which rows are eligible.
  function filters(f, where, params) {
    if (f.kinds && f.kinds.length) { where.push(`d.kind IN (${f.kinds.map(() => '?').join(',')})`); params.push(...f.kinds); }
    if (!f.includeSuperseded) where.push(`d.status = 'active'`);
    if (f.who) { where.push('d.who = ?'); params.push(f.who); }
    if (f.outcomes && f.outcomes.length) { where.push(`d.outcome IN (${f.outcomes.map(() => '?').join(',')})`); params.push(...f.outcomes); }
    if (f.since) { where.push('d.ts >= ?'); params.push(f.since); }
    // A bare year, month or day bounds the WHOLE of it: compare only as many characters as were given.
    if (f.until) { where.push('substr(d.ts, 1, ?) <= ?'); params.push(String(f.until).length, f.until); }
    if (f.session) { where.push('d.session_id = ?'); params.push(f.session); }
    if (f.files) { where.push('d.files_json LIKE ?'); params.push('%' + String(f.files).replace(/\*/g, '%') + '%'); }
    // A tool-only turn's body is just a file path: it answers "what touched this file", never "who said what".
    if (f.spokenOnly) where.push(`d.body NOT LIKE '(tool-only turn:%'`);
  }

  function search(match, f = {}) {
    const where = ['docs_fts MATCH ?'];
    const params = [match];
    filters(f, where, params);
    const order = f.order === 'oldest' ? 'd.ts ASC, d.id ASC' : f.order === 'newest' ? 'd.ts DESC, d.id DESC' : 'rank';
    params.push(f.limit || 12);
    return db.prepare(`SELECT d.*, bm25(docs_fts, 3.0, 1.0) AS rank FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
      WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...params);
  }

  // The meaning lane: every eligible row that has a vector, scored against the query vector.
  // ponytail: brute-force scan in JS, fine to ~50K vectors (about 150 MB read per search); past
  // that, move to sqlite-vec or an ANN index.
  function vectorSearch(qvec, f = {}, model, limit) {
    const where = ['v.model = ?'];
    const params = [model];
    filters(f, where, params);
    const rows = db.prepare(`SELECT d.*, v.vec AS vec FROM vectors v JOIN docs d ON d.id = v.doc_id WHERE ${where.join(' AND ')}`).all(...params);
    for (const r of rows) {
      const v = fromBlob(r.vec);
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i] * qvec[i];
      r.sim = dot; delete r.vec;
    }
    return rows.sort((a, b) => b.sim - a.sim).slice(0, limit || 12);
  }

  const api = {
    db,
    insertDoc,
    search,
    vectorSearch,
    // A section that did not change between two versions of a file has the same sha, so it is never
    // re-inserted; without this it stayed superseded and an edited handoff lost its untouched sections.
    reactivate: (id) => db.prepare(`UPDATE docs SET status = 'active', superseded_by = NULL WHERE id = ? AND status = 'superseded'`).run(id).changes,
    putVector: (id, model, arr) => db.prepare('INSERT OR REPLACE INTO vectors(doc_id, model, vec) VALUES (?,?,?)').run(id, model, toBlob(arr)),
    getVector: (id, model) => { const r = db.prepare('SELECT vec FROM vectors WHERE doc_id = ? AND model = ?').get(id, model); return r ? fromBlob(r.vec) : null; },
    vectorCount: (model) => db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE model = ?').get(model).n,
    docsMissingVectors(kinds, model, spokenOnly) {
      return db.prepare(`SELECT d.id, d.kind, d.title, d.body FROM docs d LEFT JOIN vectors v ON v.doc_id = d.id AND v.model = ?
        WHERE v.doc_id IS NULL AND d.status = 'active' AND d.kind IN (${kinds.map(() => '?').join(',')})
        ${spokenOnly ? `AND d.body NOT LIKE '(tool-only turn:%'` : ''} ORDER BY d.id`).all(model, ...kinds);
    },
    // Statements distilled from turns (not the standing rules read from memory files), oldest first.
    distilledStatements: () => db.prepare(`SELECT * FROM docs WHERE kind = 'statement' AND status = 'active' AND session_id IS NOT NULL ORDER BY ts, id`).all(),
    // An automatic link leaves the old statement ACTIVE (it prints STRUCK and names its successor);
    // dedupe and file edits use status 'superseded' instead, so clearing these touches nothing else.
    clearStatementLinks: () => db.prepare(`UPDATE docs SET superseded_by = NULL WHERE kind = 'statement' AND status = 'active' AND superseded_by IS NOT NULL`).run().changes,
    // A pair is judged once per judge prompt, ever: the verdict is kept and never bought again.
    getVerdict: (oldId, newId, sha) => { const r = db.prepare('SELECT replaces FROM link_verdicts WHERE old_id = ? AND new_id = ? AND prompt_sha = ?').get(oldId, newId, sha); return r ? !!r.replaces : null; },
    putVerdict: (oldId, newId, sha, model, replaces) => db.prepare('INSERT OR REPLACE INTO link_verdicts(old_id, new_id, prompt_sha, model, replaces) VALUES (?,?,?,?,?)').run(oldId, newId, sha, model, replaces ? 1 : 0),
    linkStatement: (oldId, newId) => db.prepare('UPDATE docs SET superseded_by = ? WHERE id = ?').run(newId, oldId),
    getDoc: (id) => db.prepare('SELECT * FROM docs WHERE id = ?').get(id),
    supersedePath: (p) => db.prepare(`UPDATE docs SET status = 'superseded' WHERE path = ? AND status = 'active'`).run(p).changes,
    // Distilled statements not produced by the current prompt (path 'distill:<sha>') step aside.
    supersedeStatementsExcept: (tag) => db.prepare(`UPDATE docs SET status = 'superseded' WHERE kind = 'statement' AND session_id IS NOT NULL AND status = 'active' AND (path IS NULL OR path <> ?)`).run(tag).changes,
    // One active statement per (session, cited turn, outcome): a session chunked twice yields the
    // same finding in two wordings, and the newest wins. Returns how many older ones stepped aside.
    dedupeStatements() {
      const rows = db.prepare(`SELECT d.id, d.session_id, d.outcome, (SELECT value FROM json_each(d.evidence_ids) ORDER BY value DESC LIMIT 1) AS turn
        FROM docs d WHERE d.kind = 'statement' AND d.session_id IS NOT NULL AND d.status = 'active' AND d.evidence_ids <> '[]' ORDER BY d.id DESC`).all();
      const seen = new Map();
      const sup = db.prepare(`UPDATE docs SET status = 'superseded', superseded_by = ? WHERE id = ?`);
      let n = 0;
      for (const r of rows) {
        const key = `${r.session_id}|${r.turn}|${r.outcome}`;
        if (seen.has(key)) { sup.run(seen.get(key), r.id); n++; } else seen.set(key, r.id);
      }
      return n;
    },
    linkSupersession(p) {
      const olds = db.prepare(`SELECT id, kind, title FROM docs WHERE path = ? AND status = 'superseded' AND superseded_by IS NULL`).all(p);
      const find = db.prepare(`SELECT id FROM docs WHERE path = ? AND kind = ? AND title = ? AND status = 'active' ORDER BY id DESC LIMIT 1`);
      const link = db.prepare('UPDATE docs SET superseded_by = ? WHERE id = ?');
      let n = 0;
      for (const o of olds) { const r = find.get(p, o.kind, o.title); if (r && r.id !== o.id) { link.run(r.id, o.id); n++; } }
      return n;
    },
    neighbours(id) {
      const d = api.getDoc(id);
      if (!d || !d.session_id) return { prev: null, next: null };
      const prev = db.prepare(`SELECT * FROM docs WHERE session_id = ? AND kind = 'turn' AND (ts < ? OR (ts = ? AND id < ?)) ORDER BY ts DESC, id DESC LIMIT 1`).get(d.session_id, d.ts, d.ts, id) || null;
      const next = db.prepare(`SELECT * FROM docs WHERE session_id = ? AND kind = 'turn' AND (ts > ? OR (ts = ? AND id > ?)) ORDER BY ts ASC, id ASC LIMIT 1`).get(d.session_id, d.ts, d.ts, id) || null;
      return { prev, next };
    },
    turnsForSession: (sid) => db.prepare(`SELECT * FROM docs WHERE session_id = ? AND kind = 'turn' AND status = 'active' ORDER BY ts, id`).all(sid),
    recentSessionIds: (n) => db.prepare(`SELECT session_id FROM docs WHERE kind = 'turn' AND session_id IS NOT NULL GROUP BY session_id ORDER BY MAX(ts) DESC LIMIT ?`).all(n).map((r) => r.session_id),
    statementsForSessions(ids) {
      if (!ids.length) return [];
      return db.prepare(`SELECT * FROM docs WHERE kind = 'statement' AND status = 'active' AND session_id IN (${ids.map(() => '?').join(',')}) ORDER BY ts DESC`).all(...ids);
    },
    handoffsBetween: (a, b) => db.prepare(`SELECT * FROM docs WHERE kind = 'handoff' AND status = 'active' AND ts >= ? AND ts <= ? ORDER BY ts DESC`).all(a, b),
    standing: (limit) => db.prepare(`SELECT * FROM docs WHERE kind = 'statement' AND status = 'active' AND outcome = 'standing' ORDER BY ts DESC LIMIT ?`).all(limit),
    standingCount: () => db.prepare(`SELECT COUNT(*) AS n FROM docs WHERE kind = 'statement' AND status = 'active' AND outcome = 'standing'`).get().n,
    getSource: (p) => db.prepare('SELECT * FROM sources WHERE path = ?').get(p),
    setSource: (r) => db.prepare(`INSERT INTO sources(path, kind, size, mtime, sha, offset, ingested_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, size=excluded.size, mtime=excluded.mtime, sha=excluded.sha, offset=excluded.offset, ingested_at=excluded.ingested_at`)
      .run(r.path, r.kind, r.size, r.mtime, r.sha, r.offset, r.ingested_at),
    hasRun: (k) => !!db.prepare('SELECT 1 FROM distill_runs WHERE session_id = ? AND turn_from = ? AND turn_to = ? AND model = ? AND prompt_sha = ?').get(k.session_id, k.turn_from, k.turn_to, k.model, k.prompt_sha),
    insertRun: (r) => db.prepare('INSERT OR IGNORE INTO distill_runs(session_id, turn_from, turn_to, model, prompt_sha, ran_at, lines) VALUES (?,?,?,?,?,?,?)').run(r.session_id, r.turn_from, r.turn_to, r.model, r.prompt_sha, r.ran_at, r.lines),
    sessionsWithRuns: () => new Set(db.prepare('SELECT DISTINCT session_id FROM distill_runs').all().map((r) => r.session_id)),
    recentUndistilledTurns(match, sinceTs, limit, excludeSessions) {
      const ex = [...(excludeSessions || [])];
      const notIn = ex.length ? `AND d.session_id NOT IN (${ex.map(() => '?').join(',')})` : '';
      return db.prepare(`SELECT d.*, bm25(docs_fts, 3.0, 1.0) AS rank FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
        WHERE docs_fts MATCH ? AND d.kind = 'turn' AND d.status = 'active' AND d.ts >= ? ${notIn} ORDER BY rank LIMIT ?`).all(match, sinceTs, ...ex, limit);
    },
    close: () => db.close(),
  };
  return api;
}

module.exports = { openStore, docSha, sha256 };
