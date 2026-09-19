'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// 1: Claude only. 2: provenance columns, occurrences, per-source parser state (Codex support).
const SCHEMA_VERSION = 2;

const SCHEMA_V1 = `
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

// Version 2 is additive: no row is rewritten, no id moves, FTS is untouched (its triggers watch
// title and body only). `session_id` stays the grouping key: a Claude conversation keeps its bare
// id, exactly as every row, run record and link already has it; a Codex conversation is always
// `codex:<thread id>`, so the two can never collide. The new columns say where a row came from.
const V2_DOC_COLS = [
  ['source_client', 'TEXT'],   // 'claude' | 'codex'; NULL for a file note, which no client authored
  ['native_session', 'TEXT'],  // the execution-session id the source recorded (Codex: the root session)
  ['item_key', 'TEXT'],        // the source's own id for this one message
  ['turn_key', 'TEXT'],        // the source's turn id, when it has one
  ['ordinal', 'INTEGER'],      // the source's record ordinal
  ['segment', 'TEXT'],         // Codex: which continuation file of the thread ('' = the first)
  ['src_offset', 'INTEGER'],   // byte offset of the record in `path`: where the evidence was read
  ['origin', 'TEXT'],          // direct | summary | reference | tool | file
  ['adapter', 'TEXT'],         // which parser version produced the row
];
const V2_SOURCE_COLS = [['client', 'TEXT'], ['state', 'TEXT']];
const V2_TABLES = `
CREATE TABLE IF NOT EXISTS occurrences (
  doc_id     INTEGER NOT NULL REFERENCES docs(id),
  path       TEXT NOT NULL,
  src_offset INTEGER,
  PRIMARY KEY (doc_id, path)
);
CREATE INDEX IF NOT EXISTS docs_client ON docs(source_client, kind, ts);
`;

function tableExists(db, name) { return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?`).get(name); }
function columns(db, table) { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)); }
function versionOf(db) {
  if (!tableExists(db, 'meta')) return 0;
  const r = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  return r ? Number(r.value) || 1 : 1;
}

// Idempotent: every step looks before it acts, so a second run changes nothing.
function migrate(db) {
  const before = versionOf(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const dc = columns(db, 'docs');
    for (const [c, t] of V2_DOC_COLS) if (!dc.has(c)) db.exec(`ALTER TABLE docs ADD COLUMN ${c} ${t}`);
    const sc = columns(db, 'sources');
    for (const [c, t] of V2_SOURCE_COLS) if (!sc.has(c)) db.exec(`ALTER TABLE sources ADD COLUMN ${c} ${t}`);
    db.exec(V2_TABLES);
    // Everything with a session id came from a Claude transcript (turns, compaction summaries, and
    // the statements distilled from them). File notes and the standing rules read from memory
    // files have no session and keep NULL: nobody's client wrote them.
    db.exec(`UPDATE docs SET source_client = 'claude' WHERE source_client IS NULL AND session_id IS NOT NULL AND session_id NOT LIKE 'codex:%'`);
    db.exec(`UPDATE docs SET origin = CASE kind WHEN 'compact_summary' THEN 'summary' WHEN 'turn' THEN (CASE WHEN body LIKE '(tool-only turn:%' THEN 'tool' ELSE 'direct' END) ELSE origin END
      WHERE origin IS NULL AND kind IN ('turn', 'compact_summary')`);
    db.exec(`UPDATE sources SET client = 'claude' WHERE client IS NULL AND kind = 'transcript'`);
    db.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { from: before, to: SCHEMA_VERSION };
}

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

// The field separator of every hash written since version 1 is the control character U+0001. It
// is INVISIBLE in an editor and in a diff: retyping this function with join('') silently changes
// every hash, and an unchanged transcript then imports a second copy of every row (caught in
// review, 2026-09-18). It is built by code so that it can be seen, and a test pins a known hash.
const SEP = String.fromCharCode(1);

function docSha(d) {
  if (d.sha) return d.sha;
  if (d.kind === 'statement') return sha256(['statement', d.who, d.outcome, d.title, d.quote || ''].join(SEP));
  return sha256([d.kind, d.session_id || '', d.ts, d.role || '', d.path || '', d.body].join(SEP));
}

const COLS = ['project', 'kind', 'status', 'session_id', 'ts', 'role', 'path', 'title', 'body',
  'files_json', 'tools_json', 'who', 'outcome', 'evidence_ids', 'quote', 'reason', 'sha',
  ...V2_DOC_COLS.map(([c]) => c)];

// The turn a statement cites last is the one its quote came from.
const LAST_EVIDENCE = `(SELECT MAX(value) FROM json_each(docs.evidence_ids))`;

// Only formatting whitespace is ignored. Similar words, containment, different case,
// punctuation and missing quotes are NOT proof of the same decision. Keep both if unsure.
const decisionQuoteKey = (s) => String(s || '').normalize('NFC').replace(/\s+/gu, ' ').trim();
function sameQuote(a, b) {
  const x = decisionQuoteKey(a), y = decisionQuoteKey(b);
  return x.length > 0 && x === y;
}

// opts.migrate: true only from the `migrate` command. A store that already holds an older
// version's rows is never upgraded as a side effect of a search or a hook: that is the owner's
// step, taken after a backup. A brand-new or empty store is simply created at the current version.
function openStore(file, opts = {}) {
  if (!opts.readOnly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { readOnly: !!opts.readOnly });
  if (!opts.readOnly) db.exec('PRAGMA journal_mode = WAL');
  // A session-start ingest can land while a distill is writing; wait rather than fail SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000');
  const had = tableExists(db, 'docs');
  const ver = had ? versionOf(db) : 0;
  if (ver > SCHEMA_VERSION) {
    db.close();
    throw new Error(`the store is schema version ${ver} and this total_recall understands up to ${SCHEMA_VERSION}; update total_recall, or restore the backup taken before the migration (${file})`);
  }
  if (had && ver < SCHEMA_VERSION && !opts.migrate && db.prepare('SELECT 1 FROM docs LIMIT 1').get()) {
    db.close();
    const e = new Error(`the store is schema version ${ver}; run  total_recall migrate  once (it takes a backup first) before anything else uses it (${file})`);
    e.code = 'NEEDS_MIGRATION';
    throw e;
  }
  if (opts.readOnly && (!had || ver !== SCHEMA_VERSION)) { db.close(); throw new Error('store is missing or needs migration; a read never creates or migrates it'); }
  if (!opts.readOnly) {
    db.exec(SCHEMA_V1);
    if (ver < SCHEMA_VERSION) migrate(db);
  }

  const insert = db.prepare(`INSERT OR IGNORE INTO docs (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`);
  const byShaId = db.prepare('SELECT id, path FROM docs WHERE sha = ?');
  const occur = db.prepare('INSERT OR IGNORE INTO occurrences(doc_id, path, src_offset) VALUES (?,?,?)');

  function insertDoc(d) {
    const sha = docSha(d);
    const row = {
      project: d.project, kind: d.kind, status: d.status || 'active', session_id: d.session_id || null,
      ts: d.ts, role: d.role || null, path: d.path || null, title: d.title, body: d.body,
      files_json: d.files_json || '[]', tools_json: d.tools_json || '[]', who: d.who || null,
      outcome: d.outcome || null, evidence_ids: d.evidence_ids || '[]', quote: d.quote || null,
      reason: d.reason ?? null, sha,
      source_client: d.source_client || null, native_session: d.native_session || null, item_key: d.item_key || null,
      turn_key: d.turn_key || null, ordinal: d.ordinal ?? null, segment: d.segment ?? null,
      src_offset: d.src_offset ?? null, origin: d.origin || null, adapter: d.adapter || null,
    };
    const r = insert.run(...COLS.map((c) => row[c]));
    if (r.changes > 0) return { id: Number(r.lastInsertRowid), inserted: true };
    const old = byShaId.get(sha);
    // The same message read again from another file (an archive move, a fork's replay): no second
    // row and no second piece of evidence, only a note of where else it was seen.
    if (row.path && old.path && old.path !== row.path) occur.run(old.id, row.path, row.src_offset);
    return { id: old.id, inserted: false };
  }

  // One filter clause for every lane of a search (words, meaning, RAW), so they can never disagree
  // about which rows are eligible.
  function filters(f, where, params) {
    if (f.kinds && f.kinds.length) { where.push(`d.kind IN (${f.kinds.map(() => '?').join(',')})`); params.push(...f.kinds); }
    if (!f.includeSuperseded) where.push(`d.status = 'active'`);
    // A client filter never claims a file note for that client: a row nobody's client wrote is left out.
    if (f.client) { where.push('d.source_client = ?'); params.push(f.client); }
    if (f.who) {
      // A statement carries `who`; a raw turn is its role plus the client that recorded it.
      const raw = `d.who IS NULL AND d.kind = 'turn'`;
      if (f.who === 'owner') where.push(`(d.who = 'owner' OR (${raw} AND d.role = 'user'))`);
      else if (f.who === 'assistant') where.push(`(d.who IN ('claude','codex') OR (${raw} AND d.role = 'assistant'))`);
      else { where.push(`(d.who = ? OR (${raw} AND d.role = 'assistant' AND d.source_client = ?))`); params.push(f.who, f.who); }
    }
    if (f.outcomes && f.outcomes.length) { where.push(`d.outcome IN (${f.outcomes.map(() => '?').join(',')})`); params.push(...f.outcomes); }
    if (f.since) { where.push('d.ts >= ?'); params.push(f.since); }
    // A bare year, month or day bounds the WHOLE of it: compare only as many characters as were given.
    if (f.until) { where.push('substr(d.ts, 1, ?) <= ?'); params.push(String(f.until).length, f.until); }
    if (f.session) { where.push('d.session_id = ?'); params.push(f.session); }
    if (f.excludeSessions && f.excludeSessions.length) { where.push(`d.session_id NOT IN (${f.excludeSessions.map(() => '?').join(',')})`); params.push(...f.excludeSessions); }
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
    schemaVersion: () => versionOf(db),
    // Doc inserts and the checkpoint that says they were read commit together or not at all.
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
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
    maxDocId: () => db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM docs').get().n,
    // An automatic link leaves the old statement ACTIVE (it prints STRUCK and names its successor);
    // dedupe and file edits use status 'superseded' instead, so clearing these touches nothing else.
    clearStatementLinks: () => db.prepare(`UPDATE docs SET superseded_by = NULL WHERE kind = 'statement' AND status = 'active' AND superseded_by IS NOT NULL`).run().changes,
    // A pair is judged once per judge prompt, ever: the verdict is kept and never bought again.
    getVerdict: (oldId, newId, sha) => { const r = db.prepare('SELECT replaces FROM link_verdicts WHERE old_id = ? AND new_id = ? AND prompt_sha = ?').get(oldId, newId, sha); return r ? !!r.replaces : null; },
    putVerdict: (oldId, newId, sha, model, replaces) => db.prepare('INSERT OR REPLACE INTO link_verdicts(old_id, new_id, prompt_sha, model, replaces) VALUES (?,?,?,?,?)').run(oldId, newId, sha, model, replaces ? 1 : 0),
    // The owner's correction of a statement the model got wrong. 'struck' is its own status so that
    // nothing automatic (dedupe, reactivation, a retuned prompt) ever brings the row back.
    strike(id, note) {
      const d = api.getDoc(id);
      if (!d || d.kind !== 'statement') return null;
      db.prepare(`UPDATE docs SET status = 'struck', body = ? WHERE id = ?`).run(`${d.body}\nstruck ${new Date().toISOString().slice(0, 10)}: ${note}`, id);
      return api.getDoc(id);
    },
    unstrike(id) {
      const d = api.getDoc(id);
      if (!d || d.status !== 'struck') return null;
      db.prepare(`UPDATE docs SET status = 'active', body = ? WHERE id = ?`).run(d.body.split('\n').filter((l) => !l.startsWith('struck ')).join('\n'), id);
      return api.getDoc(id);
    },
    linkStatement: (oldId, newId) => db.prepare('UPDATE docs SET superseded_by = ? WHERE id = ?').run(newId, oldId),
    getDoc: (id) => db.prepare('SELECT * FROM docs WHERE id = ?').get(id),
    supersedePath: (p) => db.prepare(`UPDATE docs SET status = 'superseded' WHERE path = ? AND status = 'active'`).run(p).changes,
    // A Codex thread continued in a new file names the byte where its first file stops counting:
    // what the first file holds past that point was replaced by the owner's own edit.
    supersedeBeyond: (p, offset) => db.prepare(`UPDATE docs SET status = 'superseded' WHERE path = ? AND src_offset >= ? AND status = 'active' AND kind IN ('turn','compact_summary')`).run(p, offset).changes,
    // The statement that already stands on this exact evidence: the turn it cites, in this
    // conversation, with this outcome. A struck twin is the owner's correction and blocks the
    // same finding from coming back reworded; an active twin keeps its id (and so its links and
    // verdicts) instead of being doubled by a re-run.
    // One message can hold several decisions ("Make the header blue. Make the footer green."), so
    // the twin is the one that quotes the same words, not merely the same turn.
    statementTwin: (session, turnId, outcome, quote) => db.prepare(`SELECT id, status, quote FROM docs WHERE kind = 'statement' AND session_id = ? AND outcome = ?
      AND status IN ('active', 'struck') AND ${LAST_EVIDENCE} = ? ORDER BY id`).all(session, outcome, turnId).find((r) => sameQuote(r.quote, quote)) || null,
    // A retuned prompt replaces the older prompt's statements, but only inside the chunk that was
    // just re-run successfully, in the one conversation it belongs to. Nothing is retired store-wide,
    // so a Codex run cannot touch Claude's memory and a failed chunk keeps what it had.
    supersedeChunkStatements: (session, turnFrom, turnTo, tag) => db.prepare(`UPDATE docs SET status = 'superseded' WHERE kind = 'statement' AND session_id = ?
      AND status = 'active' AND (path IS NULL OR path <> ?) AND ${LAST_EVIDENCE} BETWEEN ? AND ?`).run(session, tag, turnFrom, turnTo).changes,
    // One active statement per (session, cited turn, outcome, the words quoted): a session chunked
    // twice yields the same finding in two wordings, and the newest wins. Two DIFFERENT instructions
    // in one message are two decisions and both stand. Returns how many older ones stepped aside.
    dedupeStatements() {
      const rows = db.prepare(`SELECT d.id, d.session_id, d.outcome, d.quote, (SELECT value FROM json_each(d.evidence_ids) ORDER BY value DESC LIMIT 1) AS turn
        FROM docs d WHERE d.kind = 'statement' AND d.session_id IS NOT NULL AND d.status = 'active' AND d.evidence_ids <> '[]' ORDER BY d.id DESC`).all();
      const kept = new Map();
      const sup = db.prepare(`UPDATE docs SET status = 'superseded', superseded_by = ? WHERE id = ?`);
      let n = 0;
      for (const r of rows) {
        const key = `${r.session_id}|${r.turn}|${r.outcome}`;
        const group = kept.get(key) || kept.set(key, []).get(key);
        const twin = group.find((k) => sameQuote(k.quote, r.quote));
        if (twin) { sup.run(twin.id, r.id); n++; } else group.push(r);
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
    // The spoken turn on each side, in the same conversation: never a superseded row, never a tool-only one.
    neighbours(id) {
      const d = api.getDoc(id);
      if (!d || !d.session_id) return { prev: null, next: null };
      const live = `session_id = ? AND kind = 'turn' AND status = 'active' AND body NOT LIKE '(tool-only turn:%'`;
      const prev = db.prepare(`SELECT * FROM docs WHERE ${live} AND (ts < ? OR (ts = ? AND id < ?)) ORDER BY ts DESC, id DESC LIMIT 1`).get(d.session_id, d.ts, d.ts, id) || null;
      const next = db.prepare(`SELECT * FROM docs WHERE ${live} AND (ts > ? OR (ts = ? AND id > ?)) ORDER BY ts ASC, id ASC LIMIT 1`).get(d.session_id, d.ts, d.ts, id) || null;
      return { prev, next };
    },
    // Only what a person or an assistant actually said in the conversation is distilled: not a
    // summary, not reference material whose author is unclear.
    turnsForSession: (sid) => db.prepare(`SELECT * FROM docs WHERE session_id = ? AND kind = 'turn' AND status = 'active' ORDER BY ts, id`).all(sid),
    clientOfSession: (sid) => { const r = db.prepare(`SELECT source_client FROM docs WHERE session_id = ? AND source_client IS NOT NULL LIMIT 1`).get(sid); return r ? r.source_client : null; },
    recentSessionIds(n, client) {
      const c = client ? 'AND source_client = ?' : '';
      return db.prepare(`SELECT session_id FROM docs WHERE kind = 'turn' AND session_id IS NOT NULL ${c} GROUP BY session_id ORDER BY MAX(ts) DESC LIMIT ?`)
        .all(...(client ? [client, n] : [n])).map((r) => r.session_id);
    },
    // A bare id, a short one as search prints it, or a qualified key (claude:<id>, codex:<id>).
    resolveSession(q) {
      const s = String(q || '').trim();
      const m = /^(claude|codex):(.*)$/i.exec(s);
      const bare = m ? m[2] : s;
      // A qualified key names one client; a bare id is looked for under both.
      const keys = [];
      if (!m || m[1].toLowerCase() === 'claude') keys.push(bare);
      if (!m || m[1].toLowerCase() === 'codex') keys.push(`codex:${bare}`);
      const ph = keys.map(() => '?').join(',');
      const exact = db.prepare(`SELECT DISTINCT session_id FROM docs WHERE session_id IN (${ph})`).all(...keys).map((r) => r.session_id);
      if (exact.length) return exact;
      return db.prepare(`SELECT DISTINCT session_id FROM docs WHERE ${keys.map(() => 'session_id LIKE ?').join(' OR ')} LIMIT 6`).all(...keys.map((k) => `${k}%`))
        .map((r) => r.session_id).filter((id) => !m || m[1].toLowerCase() === 'codex' || !id.startsWith('codex:'));
    },
    clientsPresent: () => db.prepare(`SELECT DISTINCT source_client FROM docs WHERE source_client IS NOT NULL`).all().map((r) => r.source_client),
    statementsForSessions(ids) {
      if (!ids.length) return [];
      return db.prepare(`SELECT * FROM docs WHERE kind = 'statement' AND status = 'active' AND superseded_by IS NULL AND session_id IN (${ids.map(() => '?').join(',')}) ORDER BY ts DESC`).all(...ids);
    },
    handoffsBetween: (a, b) => db.prepare(`SELECT * FROM docs WHERE kind = 'handoff' AND status = 'active' AND ts >= ? AND ts <= ? ORDER BY ts DESC`).all(a, b),
    // A rule a later rule replaced is not current, even though its row stays active to print STRUCK.
    // ... and a rule whose meaning or scope was recorded as UNCLEAR is never presented as a rule at all.
    standing: (limit) => db.prepare(`SELECT * FROM docs WHERE kind = 'statement' AND status = 'active' AND outcome = 'standing' AND superseded_by IS NULL AND COALESCE(origin, '') <> 'decision-unclear' ORDER BY ts DESC LIMIT ?`).all(limit),
    standingCount: () => db.prepare(`SELECT COUNT(*) AS n FROM docs WHERE kind = 'statement' AND status = 'active' AND outcome = 'standing' AND superseded_by IS NULL AND COALESCE(origin, '') <> 'decision-unclear'`).get().n,
    getSource: (p) => db.prepare('SELECT * FROM sources WHERE path = ?').get(p),
    sourcesOfClient: (client) => db.prepare('SELECT * FROM sources WHERE client = ?').all(client),
    setSource: (r) => db.prepare(`INSERT INTO sources(path, kind, size, mtime, sha, offset, ingested_at, client, state) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, size=excluded.size, mtime=excluded.mtime, sha=excluded.sha, offset=excluded.offset,
        ingested_at=excluded.ingested_at, client=excluded.client, state=excluded.state`)
      .run(r.path, r.kind, r.size, r.mtime, r.sha, r.offset, r.ingested_at, r.client || null, r.state || null),
    // A rollout that moved (active -> archived) is the same file at a new address: its progress,
    // and the address its rows cite, move with it. Nothing is read again.
    moveSource(from, to) {
      db.prepare('DELETE FROM sources WHERE path = ?').run(to);
      db.prepare('UPDATE sources SET path = ? WHERE path = ?').run(to, from);
      db.prepare('UPDATE docs SET path = ? WHERE path = ?').run(to, from);
      db.prepare('UPDATE OR IGNORE occurrences SET path = ? WHERE path = ?').run(to, from);
    },
    // ---- decisions recorded while the work happens (lib/decide.js) ----
    // 'pending' = recorded, the owner's words not yet found in the ingested conversation.
    // 'unverified' = that stretch of conversation is in the store and the words are not in it.
    // Neither is ever 'active', so neither reaches a search, the brief or a distill twin check.
    pendingDecisions: () => db.prepare(`SELECT * FROM docs WHERE kind = 'statement' AND status IN ('pending', 'unverified') AND path LIKE 'decide:%' ORDER BY id`).all(),
    ownerTurnsBetween: (client, fromTs, toTs) => db.prepare(`SELECT * FROM docs WHERE kind = 'turn' AND status = 'active' AND role = 'user' AND COALESCE(origin, 'direct') = 'direct'
      AND source_client = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC, id DESC LIMIT 400`).all(client, fromTs, toTs),
    spokenTurnsBefore: (session, ts, id, n) => db.prepare(`SELECT * FROM docs WHERE session_id = ? AND kind = 'turn' AND status = 'active' AND body NOT LIKE '(tool-only turn:%'
      AND (ts < ? OR (ts = ? AND id < ?)) ORDER BY ts DESC, id DESC LIMIT ?`).all(session, ts, ts, id, n),
    hasTurnAfter: (client, ts) => !!db.prepare(`SELECT 1 FROM docs WHERE kind = 'turn' AND source_client = ? AND ts > ? LIMIT 1`).get(client, ts),
    linkDecision: (id, f) => db.prepare(`UPDATE docs SET status = 'active', session_id = ?, source_client = ?, ts = ?, evidence_ids = ?, quote = ?, body = ? WHERE id = ? AND status IN ('pending', 'unverified')`)
      .run(f.session_id, f.source_client, f.ts, f.evidence_ids, f.quote, f.body, id).changes,
    setStatus: (id, status, body = null) => body === null
      ? db.prepare('UPDATE docs SET status = ? WHERE id = ?').run(status, id).changes
      : db.prepare('UPDATE docs SET status = ?, body = ? WHERE id = ?').run(status, body, id).changes,
    decisions(f = {}) {
      const where = [`kind = 'statement'`, `path LIKE 'decide:%'`, 'ts >= ?'];
      const params = [f.since || '0000'];
      where.push(f.pending ? `status IN ('pending', 'unverified')` : `status IN ('active', 'pending', 'unverified')`);
      if (f.client) { where.push('source_client = ?'); params.push(f.client); }
      return db.prepare(`SELECT * FROM docs WHERE ${where.join(' AND ')} ORDER BY ts, id`).all(...params);
    },
    // A relation between two statements that rests on the OWNER's later words (never on a model's
    // judgment): 'replaces' or 'conflict'. Kept beside the judged verdicts, under its own key, with
    // who recorded it. Removing it touches neither statement and none of their evidence.
    putRelation: (oldId, newId, type, recorder) => db.prepare('INSERT OR REPLACE INTO link_verdicts(old_id, new_id, prompt_sha, model, replaces) VALUES (?,?,?,?,?)')
      .run(oldId, newId, type === 'replaces' ? 'owner-decision' : 'owner-decision-conflict', recorder, type === 'replaces' ? 1 : 0),
    relationsOf: (id) => db.prepare(`SELECT old_id, new_id, prompt_sha, model FROM link_verdicts WHERE (old_id = ? OR new_id = ?) AND prompt_sha LIKE 'owner-decision%'`).all(id, id),
    removeRelations(id) {
      const rows = api.relationsOf(id);
      for (const r of rows) db.prepare('UPDATE docs SET superseded_by = NULL WHERE id = ? AND superseded_by = ?').run(r.old_id, r.new_id);
      db.prepare(`DELETE FROM link_verdicts WHERE (old_id = ? OR new_id = ?) AND prompt_sha LIKE 'owner-decision%'`).run(id, id);
      return rows.length;
    },
    reapplyOwnerLinks: () => db.prepare(`UPDATE docs SET superseded_by = (SELECT v.new_id FROM link_verdicts v WHERE v.old_id = docs.id AND v.prompt_sha = 'owner-decision' LIMIT 1)
      WHERE id IN (SELECT old_id FROM link_verdicts WHERE prompt_sha = 'owner-decision')`).run().changes,
    // A stronger reader's pass over a slice: what a WEAKER extractor said about those same turns
    // steps aside. The rows stay (status 'superseded', findable with --include-superseded); an
    // in-session decision record and anything the owner struck are never touched.
    supersedeWeakerInRange(session, turnFrom, turnTo, extractor) {
      // Only what the strong reader actually covers: OWNER decisions. An assistant's "completed" or
      // "proposed" report is a different tier that the owner-decision pass never writes, so it stays.
      const ids = db.prepare(`SELECT id FROM docs WHERE kind = 'statement' AND session_id = ? AND status = 'active' AND path LIKE 'distill:%' AND COALESCE(adapter, '') <> ?
        AND who = 'owner' AND outcome IN ('approved', 'rejected', 'standing', 'open')
        AND ${LAST_EVIDENCE} BETWEEN ? AND ?`).all(session, extractor, turnFrom, turnTo).map((r) => r.id);
      for (const id of ids) db.prepare(`UPDATE docs SET status = 'superseded' WHERE id = ?`).run(id);
      return ids;
    },
    // ... and each points at the stronger reader's statement on the same turn, when there is one.
    pointSuperseded(ids, extractor) {
      for (const id of ids) {
        const old = api.getDoc(id);
        const neu = db.prepare(`SELECT id FROM docs WHERE kind = 'statement' AND session_id = ? AND status = 'active' AND adapter = ? AND ${LAST_EVIDENCE} = (SELECT MAX(value) FROM json_each(?)) LIMIT 1`)
          .get(old.session_id, extractor, old.evidence_ids);
        if (neu) db.prepare('UPDATE docs SET superseded_by = ? WHERE id = ?').run(neu.id, id);
      }
    },
    getMeta: (k) => { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(k); return r ? r.value : null; },
    setMeta: (k, v) => db.prepare(`INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, String(v)),
    hasRun: (k) => !!db.prepare('SELECT 1 FROM distill_runs WHERE session_id = ? AND turn_from = ? AND turn_to = ? AND model = ? AND prompt_sha = ?').get(k.session_id, k.turn_from, k.turn_to, k.model, k.prompt_sha),
    insertRun: (r) => db.prepare('INSERT OR IGNORE INTO distill_runs(session_id, turn_from, turn_to, model, prompt_sha, ran_at, lines) VALUES (?,?,?,?,?,?,?)').run(r.session_id, r.turn_from, r.turn_to, r.model, r.prompt_sha, r.ran_at, r.lines),
    sessionsWithRuns: () => new Set(db.prepare('SELECT DISTINCT session_id FROM distill_runs').all().map((r) => r.session_id)),
    // Recent spoken turns no distill run has covered yet. Same eligibility as the main search:
    // pass the search's own filter object and only the kind, window and exclusions differ.
    recentUndistilledTurns(match, sinceTs, limit, excludeSessions, f = {}) {
      const since = f.since && f.since > sinceTs ? f.since : sinceTs;
      return search(match, { ...f, kinds: ['turn'], outcomes: undefined, since, excludeSessions: [...(excludeSessions || [])], spokenOnly: true, limit, order: undefined });
    },
    close: () => db.close(),
  };
  return api;
}

module.exports = { openStore, migrate, docSha, sha256, decisionQuoteKey, SCHEMA_VERSION, SCHEMA_V1 };
