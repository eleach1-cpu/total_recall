'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const { eventTime } = require('./recall-dates');

const hash = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const speaker = `CASE WHEN d.kind = 'turn' AND d.role = 'user' THEN 'owner' WHEN d.kind = 'turn' AND d.role = 'assistant' THEN d.source_client ELSE d.who END`;
const direct = `d.kind = 'turn' AND d.origin = 'direct' AND d.role IN ('user','assistant')`;
function open(cfg) {
  // No mkdir, CREATE, migration, journal-mode switch or vector cache write on a retrieval path.
  const db = new DatabaseSync(cfg.store, { readOnly: true });
  try {
    const v = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
    if (Number(v) !== 2) throw new Error(`retrieval requires schema 2, found ${v || 'unknown'}; reads never migrate`);
    const timeCache = new Map();
    db.function('recall_time', { deterministic: true }, (s) => {
      if (!timeCache.has(s)) timeCache.set(s, eventTime(s)); return timeCache.get(s);
    });
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; BEGIN');
    const identity = hash([cfg.project, require('./config').canon(cfg.store)]);
    const revisionHash = crypto.createHash('sha256');
    for (const d of db.prepare('SELECT id,sha,status,ts,project,kind,source_client,session_id,origin,role,who,outcome,superseded_by,quote,reason,evidence_ids,path,title,files_json,tools_json FROM docs WHERE project = ? ORDER BY id').iterate(cfg.project)) revisionHash.update(JSON.stringify(d));
    for (const r of db.prepare('SELECT l.* FROM link_verdicts l JOIN docs d ON d.id=l.old_id JOIN docs n ON n.id=l.new_id WHERE d.project=? AND n.project=? ORDER BY old_id,new_id,prompt_sha').iterate(cfg.project, cfg.project)) revisionHash.update(JSON.stringify(r));
    for (const r of db.prepare('SELECT s.* FROM sources s WHERE EXISTS(SELECT 1 FROM docs d WHERE d.project=? AND d.path=s.path) ORDER BY s.path').iterate(cfg.project)) revisionHash.update(JSON.stringify(r));
    const revision = revisionHash.digest('hex');
    return { db, cfg, identity, revision, close() { db.exec('ROLLBACK'); db.close(); } };
  } catch (e) { db.close(); throw e; }
}
function filter(cfg, o = {}) {
  const w = ['d.project = ?'], p = [cfg.project];
  if (!o.include_superseded) w.push("d.status = 'active' AND d.superseded_by IS NULL");
  const list = (col, v) => { if (v?.length) { w.push(`${col} IN (${v.map(() => '?').join(',')})`); p.push(...v); } };
  list('d.kind', o.kinds);
  if (o.client && o.client !== 'all') { w.push('d.source_client = ?'); p.push(o.client); }
  if (o.who === 'assistant') w.push(`${speaker} IN ('claude','codex')`);
  else if (o.who) { w.push(`${speaker} = ?`); p.push(o.who); }
  if (o.direct) w.push(direct);
  else if (!o.tools) w.push("COALESCE(d.origin,'') <> 'tool' AND d.body NOT LIKE '(tool-only turn:%'");
  list('d.outcome', o.outcomes);
  // A stored interpretation marked UNCLEAR is history, not a standing rule.
  // Keep it available in general searches and read-by-id; include it in a
  // rules inventory only when the caller explicitly asks for unclear records.
  if (o.outcomes?.includes('standing') && !o.include_unclear) {
    w.push("NOT (d.outcome = 'standing' AND COALESCE(d.origin,'') = 'decision-unclear')");
  }
  if (o.session) { w.push('d.session_id = ?'); p.push(o.session); }
  if (o.dates?.lo != null) { w.push('recall_time(d.ts) >= ?'); p.push(o.dates.lo); }
  if (o.dates?.hi != null) { w.push('recall_time(d.ts) < ?'); p.push(o.dates.hi); }
  if (o.order === 'oldest' || o.order === 'newest') w.push('recall_time(d.ts) IS NOT NULL');
  return { where: w.join(' AND '), params: p };
}
function session(store, value, client) {
  const all = store.db.prepare('SELECT DISTINCT session_id,source_client FROM docs WHERE project=? AND session_id IS NOT NULL').all(store.cfg.project);
  const q = /^(claude|codex):(.*)$/.exec(String(value));
  const eligible = all.filter((d) => (!client || client === 'all' || d.source_client === client) && (!q || d.source_client === q[1]));
  const bare = (d) => d.source_client === 'codex' ? d.session_id.replace(/^codex:/, '') : d.session_id;
  const needle = q ? q[2] : String(value);
  let found = eligible.filter((d) => bare(d) === needle);
  if (!found.length) found = eligible.filter((d) => bare(d).startsWith(needle));
  if (found.length !== 1) throw new Error(`${found.length ? 'ambiguous' : 'unknown'} session "${value}" in project ${store.cfg.project}`);
  return found[0].session_id;
}
function doc(store, id) {
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new Error('record id must be a positive integer');
  const d = store.db.prepare('SELECT * FROM docs WHERE project=? AND id=?').get(store.cfg.project, Number(id));
  if (!d) throw new Error(`record #${id} not found in project ${store.cfg.project}`);
  return d;
}
function relations(store, d) {
  return store.db.prepare(`SELECT l.* FROM link_verdicts l JOIN docs a ON a.id=l.old_id JOIN docs b ON b.id=l.new_id
    WHERE a.project=? AND b.project=? AND (l.old_id=? OR l.new_id=?) AND l.prompt_sha LIKE 'owner-decision%'`).all(store.cfg.project, store.cfg.project, d.id, d.id);
}
function briefView(store) {
  const { db, cfg } = store;
  const rows = (where, params = []) => db.prepare(`SELECT * FROM docs WHERE project=? AND ${where}`).all(cfg.project, ...params);
  const rules = "kind='statement' AND status='active' AND outcome='standing' AND superseded_by IS NULL AND COALESCE(origin,'')<>'decision-unclear'";
  return {
    standing: (limit) => rows(`${rules} ORDER BY recall_time(ts) DESC,id DESC LIMIT ?`, [limit]),
    standingCount: () => db.prepare(`SELECT COUNT(*) n FROM docs WHERE project=? AND ${rules}`).get(cfg.project).n,
    clientsPresent: () => db.prepare('SELECT DISTINCT source_client FROM docs WHERE project=? AND source_client IS NOT NULL').all(cfg.project).map((d) => d.source_client),
    recentSessionIds: (limit, client) => db.prepare(`SELECT session_id FROM docs WHERE project=? AND kind='turn' AND session_id IS NOT NULL ${client ? 'AND source_client=?' : ''} GROUP BY session_id ORDER BY MAX(recall_time(ts)) DESC LIMIT ?`).all(cfg.project, ...(client ? [client] : []), limit).map((d) => d.session_id),
    statementsForSessions: (ids) => ids.length ? rows(`kind='statement' AND status='active' AND superseded_by IS NULL AND session_id IN (${ids.map(() => '?').join(',')}) ORDER BY recall_time(ts) DESC`, ids) : [],
    turnsForSession: (sid) => rows("session_id=? AND kind='turn' AND status='active' ORDER BY recall_time(ts),id", [sid]),
    handoffsBetween: (a, b) => rows("kind='handoff' AND status='active' AND ts>=? AND ts<=? ORDER BY recall_time(ts) DESC", [a,b]),
  };
}
module.exports = { open, filter, session, doc, relations, hash, direct, speaker, briefView };
