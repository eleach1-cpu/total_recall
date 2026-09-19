'use strict';
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { hash } = require('./recall-db');
const { embedModel } = require('./embed');

const CHUNKER = 'paragraph-char-v1:2048:256';
function indexFile(cfg) {
  const { canon } = require('./config');
  const file = cfg.search?.index || `${cfg.store}.search.sqlite`;
  if (canon(file) === canon(cfg.store)) throw new Error('search index must be separate from the conversation store');
  if (fs.existsSync(file) && fs.existsSync(cfg.store)) {
    const a = fs.statSync(file), b = fs.statSync(cfg.store);
    if (a.ino && a.ino === b.ino && a.dev === b.dev) throw new Error('search index aliases the conversation store');
  }
  return file;
}
const textOf = (d) => d.body.startsWith(d.title) ? d.body : `${d.title}\n${d.body}`;
function chunks(text) {
  const out = []; let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 2048, text.length);
    if (end < text.length) { const para = text.lastIndexOf('\n\n', end); if (para > start + 1500) end = para + 2; }
    // Do not cut a surrogate pair. Offsets refer to the exact input, not rewritten text.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    out.push({ start, end, text: text.slice(start, end) });
    if (end === text.length) break;
    start = end - 256;
    if (/[\uDC00-\uDFFF]/.test(text[start])) start--;
  }
  return out;
}
function openIndex(cfg) {
  const file = indexFile(cfg);
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare("SELECT value FROM index_meta WHERE key='version'").get()?.value !== '1') throw new Error('unsupported search index version');
    db.exec('PRAGMA query_only=ON; BEGIN'); return db;
  } catch (e) { db.close(); throw e; }
}
function coverage(store) {
  const eligible = store.db.prepare("SELECT COUNT(*) n FROM docs WHERE project=? AND status='active' AND COALESCE(origin,'') NOT IN ('tool','reference')").get(store.cfg.project).n;
  const legacy = store.db.prepare('SELECT COUNT(*) n FROM vectors v JOIN docs d ON d.id=v.doc_id WHERE d.project=? AND v.model=?').get(store.cfg.project, embedModel(store.cfg)).n;
  let indexed = 0, complete = 0, error = null;
  try {
    const ix = openIndex(store.cfg);
    if (ix) { try {
      const rows = ix.prepare('SELECT * FROM parents WHERE project=? AND model=? AND chunker=?').all(store.cfg.project, embedModel(store.cfg), CHUNKER);
      for (const r of rows) { const d = store.db.prepare('SELECT title,body,sha,status,origin FROM docs WHERE id=? AND project=?').get(r.doc_id, store.cfg.project);
        if (d && d.status === 'active' && !['tool','reference'].includes(d.origin) && d.sha === r.doc_sha && hash(textOf(d)) === r.content_hash) { indexed++; if (r.complete) complete++; } }
    } finally { ix.close(); } }
  } catch (e) { error = e.message; }
  return { eligible_records: eligible, chunk_indexed_records: indexed, full_text_chunked_records: complete, missing_or_incomplete: Math.max(0, eligible - complete),
    legacy_vectors: legacy, legacy_coverage: 'unverified model version; may represent only the first 6000 characters', index_error: error,
    model: embedModel(store.cfg), chunker: CHUNKER, index: indexFile(store.cfg) };
}
async function encoder(cfg, ctx = {}, timeout = 6000) {
  if (ctx.encoder) return ctx.encoder;
  const signal = AbortSignal.timeout(timeout), url = cfg.ollama?.url || 'http://localhost:11434';
  const req = async (route, payload) => {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal });
    if (!res.ok) throw new Error(`local embedding model: HTTP ${res.status}`); return res.json();
  };
  // Metadata pins the model behind a mutable local tag. A changed tag never silently reuses chunks.
  const info = await req('show', { model: embedModel(cfg) });
  if (!info.model_info || typeof info.modelfile !== 'string' || !info.modelfile) throw new Error('local encoder did not provide model identity metadata');
  const version = hash([embedModel(cfg), info.model_info, info.modelfile, info.parameters]);
  return { version, async embed(texts, prefix) {
    const r = await req('embed', { model: embedModel(cfg), input: texts.map((s) => `${prefix}: ${s}`), truncate: false, keep_alive: '30m' });
    if (!Array.isArray(r.embeddings) || r.embeddings.length !== texts.length) throw new Error('local encoder returned an incomplete batch');
    for (const v of r.embeddings) if (!Array.isArray(v) || !v.length || !v.every(Number.isFinite) || !v.some((n) => n !== 0)) throw new Error('invalid embedding');
    return r.embeddings;
  } };
}
function cosine(a, b) {
  if (a.length !== b.length || !a.length) return null;
  let n = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return null; n += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2; }
  return x && y ? n / Math.sqrt(x * y) : null;
}
const vector = (blob) => new Float32Array(new Uint8Array(blob).buffer);
async function search(store, o, f, lexical, ctx = {}) {
  const cov = coverage(store), notes = [];
  let ix = null;
  const fallback = (why) => ({ rows: lexical, coverage: { ...cov, enabled: false, reason: why }, notes: [`Meaning lane off: ${why}. Results use words only.`], revision: 'off:' + why });
  if (!cov.legacy_vectors && !cov.chunk_indexed_records) return fallback('no usable vectors; no indexing job was started');
  try {
    const encoded = ctx.queryEmbedding ? await ctx.queryEmbedding(store.cfg, o.query) : await (async () => {
      const enc = await encoder(store.cfg, ctx, store.cfg.embed?.queryTimeoutMs || 6000);
      return { version: enc.version, vector: (await enc.embed([o.query], 'search_query'))[0] };
    })();
    const q = encoded.vector;
    ix = openIndex(store.cfg);
    const eligible = store.db.prepare(`SELECT d.id,d.sha,d.project,d.kind,d.ts,d.session_id,d.source_client,d.path,d.files_json,recall_time(d.ts) event_ms FROM docs d WHERE ${f.where}`).all(...f.params).filter((d) => require('./recall').fileMatch(d, o.files));
    const allowed = new Map(eligible.map((d) => [d.id, d]));
    const hardIds = ['all','phrase','advanced'].includes(o.match) ? new Set(lexical.map((d) => d.id)) : null;
    const scores = new Map(), spans = new Map(), indexed = new Set(), rev = [];
    if (ix) {
      for (const p of ix.prepare('SELECT * FROM parents WHERE project=? AND model=? AND chunker=? AND encoder_version=? AND complete=1').iterate(store.cfg.project, embedModel(store.cfg), CHUNKER, encoded.version)) {
        const d = allowed.get(p.doc_id);
        if (!d || d.sha !== p.doc_sha || hash(textOf(require('./recall-db').doc(store, d.id))) !== p.content_hash) continue;
        const cs = ix.prepare('SELECT ordinal,start_offset,end_offset,vec FROM chunks WHERE project=? AND doc_id=? ORDER BY ordinal').all(store.cfg.project, d.id);
        if (cs.length !== p.total) continue;
        indexed.add(d.id); rev.push([p.doc_id, p.content_hash, p.encoder_version]);
        const original = require('./recall-db').doc(store, d.id);
        const prefix = original.body.startsWith(original.title) ? 0 : original.title.length + 1;
        for (const c of cs) { const sim = cosine(q, vector(c.vec)); if (sim !== null && sim > (scores.get(d.id) ?? -1)) {
          scores.set(d.id, sim); spans.set(d.id, { start: Math.max(0, c.start_offset - prefix), end: Math.max(0, c.end_offset - prefix) });
        } }
      }
    }
    for (const r of store.db.prepare(`SELECT v.* FROM vectors v JOIN docs d ON d.id=v.doc_id WHERE v.model=? AND ${f.where}`).iterate(embedModel(store.cfg), ...f.params)) {
      if (!allowed.has(r.doc_id) || indexed.has(r.doc_id)) continue;
      rev.push([r.doc_id, hash(Buffer.from(r.vec).toString('base64'))]);
      const sim = cosine(q, vector(r.vec)); if (sim !== null) scores.set(r.doc_id, sim);
    }
    const semantic = [...scores].filter(([id, sim]) => sim >= (store.cfg.search?.minSim ?? 0.62) && (!hardIds || hardIds.has(id)))
      .sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id, sim]) => ({ ...allowed.get(id), sim, match_span: spans.get(id) }));
    const fused = new Map();
    const add = (list, lane) => list.forEach((d, i) => { const old = fused.get(d.id) || { ...d, score: 0, lanes: [] }; old.score += 1 / (5 + i); old.lanes.push(lane); if (d.sim !== undefined) old.sim = d.sim; if (d.match_span) old.match_span = d.match_span; fused.set(d.id, old); });
    if (o.mode !== 'meaning') add(lexical, 'words');
    add(semantic, 'meaning');
    const missing = eligible.length - indexed.size;
    if (missing) notes.push(`${missing} eligible records lack verified full-text chunk coverage. Legacy vectors are partial/unverified; an absent concept hit is not proof it was never discussed.`);
    return { rows: [...fused.values()], coverage: { ...cov, enabled: true, eligible_for_query: eligible.length, verified_complete_for_query: indexed.size, compared_records: scores.size }, notes,
      revision: hash([encoded.version, rev.sort((a,b) => a[0]-b[0])]) };
  } catch (e) { return fallback(e.message); }
  finally { if (ix) ix.close(); }
}

// Explicit, resumable local embedding job. Only a disposable derived sidecar is written. The
// source store (including Sonnet records and IDs) stays read-only and needs no schema migration.
async function build(store, opts = {}, ctx = {}) {
  indexFile(store.cfg); // refuse a source-store alias before spending GPU time or opening a writer
  const limit = Number(opts.limit || 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('index limit must be 1 to 10000 records');
  const where = "project=? AND status='active' AND COALESCE(origin,'') NOT IN ('tool','reference') AND body NOT LIKE '(tool-only turn:%'";
  const count = store.db.prepare(`SELECT COUNT(*) n FROM docs WHERE ${where}`).get(store.cfg.project).n;
  if (opts.dry) return { eligible: count, sidecar: indexFile(store.cfg), model: embedModel(store.cfg), writes: false, model_calls: 0 };
  const rows = store.db.prepare(`SELECT * FROM docs WHERE ${where} ORDER BY id`).iterate(store.cfg.project);
  const enc = await encoder(store.cfg, ctx, 120000);
  const ix = new DatabaseSync(indexFile(store.cfg));
  let done = 0;
  try {
    ix.exec(`CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY,value TEXT);
      INSERT OR IGNORE INTO index_meta VALUES ('version','1');
      CREATE TABLE IF NOT EXISTS parents(project TEXT,doc_id INTEGER,doc_sha TEXT,content_hash TEXT,model TEXT,chunker TEXT,encoder_version TEXT,total INTEGER,complete INTEGER,PRIMARY KEY(project,doc_id));
      CREATE TABLE IF NOT EXISTS chunks(project TEXT,doc_id INTEGER,ordinal INTEGER,start_offset INTEGER,end_offset INTEGER,vec BLOB,PRIMARY KEY(project,doc_id,ordinal));`);
    if (ix.prepare("SELECT value FROM index_meta WHERE key='version'").get()?.value !== '1') throw new Error('unsupported search index version');
    for (const d of rows) {
      const text = textOf(d), contentHash = hash(text), cs = chunks(text);
      const prev = ix.prepare('SELECT * FROM parents WHERE project=? AND doc_id=?').get(d.project, d.id);
      const same = prev && prev.content_hash === contentHash && prev.doc_sha === d.sha && prev.encoder_version === enc.version && prev.model === embedModel(store.cfg) && prev.chunker === CHUNKER;
      if (same && prev.complete) continue;
      if (!same) {
        ix.exec('BEGIN');
        try { ix.prepare('DELETE FROM chunks WHERE project=? AND doc_id=?').run(d.project, d.id);
          ix.prepare('INSERT OR REPLACE INTO parents VALUES (?,?,?,?,?,?,?,?,0)').run(d.project,d.id,d.sha,contentHash,embedModel(store.cfg),CHUNKER,enc.version,cs.length); ix.exec('COMMIT');
        } catch (e) { ix.exec('ROLLBACK'); throw e; }
      }
      for (let j = 0; j < cs.length; j++) {
        if (ix.prepare('SELECT 1 FROM chunks WHERE project=? AND doc_id=? AND ordinal=?').get(d.project,d.id,j)) continue;
        const [v] = await enc.embed([cs[j].text], 'search_document'); // truncate:false, never first-N-only
        if (!v || !v.length || !v.every(Number.isFinite) || !v.some((n) => n !== 0)) throw new Error('invalid chunk embedding');
        ix.prepare('INSERT INTO chunks VALUES (?,?,?,?,?,?)').run(d.project,d.id,j,cs[j].start,cs[j].end,Buffer.from(Float32Array.from(v).buffer));
      }
      ix.prepare('UPDATE parents SET complete=1 WHERE project=? AND doc_id=?').run(d.project,d.id);
      if (++done >= limit) break;
    }
    return { embedded_records: done, eligible: count, sidecar: indexFile(store.cfg), model: embedModel(store.cfg), note: 'Run the same command to resume; unchanged complete records are skipped.' };
  } finally { ix.close(); }
}
async function command(args) {
  const { cfg } = require('./recall-scope').resolve(args.flags, { root: process.env.TOTAL_RECALL_ROOT || process.cwd() });
  const s = require('./recall-db').open(cfg);
  try { process.stdout.write(JSON.stringify(await build(s, args.flags), null, 2) + '\n'); return 0; }
  finally { s.close(); }
}
module.exports = { search, coverage, build, command, chunks, textOf, CHUNKER, encoder, cosine, indexFile };
