'use strict';
const { loadConfig, noConfigMessage } = require('./config');
const { openStore } = require('./store');
const gate = require('./gate');
const { resolveSessionId } = require('./session');

const path = require('node:path');
const { queryVector, embedModel } = require('./embed');

const DISTILLED = ['statement', 'handoff', 'memory', 'compact_summary', 'map_section'];
const ALL = ['turn', ...DISTILLED, 'changelog'];
const WHO = ['owner', 'claude', 'codex', 'assistant'];
const CLIENT = ['claude', 'codex', 'all'];

// Ranked searches OR the words and let bm25 float the best hit up. A date-ordered search has no
// ranking to do that, so it passes ' AND ': otherwise the "earliest" hit is any old turn with one word.
function buildMatch(query, joiner = ' OR ') {
  const q = String(query || '').trim();
  if (!q) return null;
  const parts = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    const tok = (m[1] || m[2]).replace(/"/g, '').trim();
    if (tok) parts.push(`"${tok}"`);
  }
  return parts.length ? parts.join(joiner) : null;
}

// YYYY, YYYY-MM, YYYY-MM-DD or a full ISO timestamp. Anything else ("last week") would compare as
// text and silently return nothing, so the command refuses it instead.
const isDate = (s) => /^\d{4}(-\d{2}(-\d{2}(T[\d:.]+Z?)?)?)?$/.test(String(s));

function parseKinds(flag) {
  if (!flag || flag === true) return DISTILLED;
  if (flag === 'all') return ALL;
  return String(flag).split(',').map((s) => s.trim()).filter(Boolean);
}

function deepFor(store, hit) {
  let ids = [];
  try { ids = JSON.parse(hit.evidence_ids || '[]'); } catch {}
  if (!ids.length && hit.kind === 'turn') ids = [hit.id];
  const seen = new Map();
  for (const id of ids) {
    const d = store.getDoc(id);
    if (!d) continue;
    const { prev, next } = store.neighbours(id);
    for (const t of [prev, d, next]) if (t) seen.set(t.id, t);
  }
  return [...seen.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id));
}

// Sessions "covered" for the raw fallback: any with a distill run, or whose last turn shares a
// date with a handoff section written since the window opened. A handoff only covers the client
// that wrote it: a Claude handoff dated today says nothing about what Codex did today.
const handoffClient = (h) => (/codex/i.test(path.basename(String(h.path || ''))) ? 'codex' : 'claude');
function coveredSessions(store, since) {
  const exclude = store.sessionsWithRuns();
  const days = new Set(store.handoffsBetween(since, '9999').map((h) => `${handoffClient(h)}|${String(h.ts).slice(0, 10)}`));
  if (days.size) {
    for (const sid of store.recentSessionIds(50)) {
      const turns = store.turnsForSession(sid);
      if (turns.length && days.has(`${turns[0].source_client || 'claude'}|${turns[turns.length - 1].ts.slice(0, 10)}`)) exclude.add(sid);
    }
  }
  return exclude;
}

// Reciprocal rank fusion: a row's score is the sum of 1/(K + its rank) over the lanes that found
// it, so a row both lanes agree on beats a row only one of them likes, with no score scales to tune.
// K is 5, not the textbook 60: the words lane ORs every query word, so nearly every row the meaning
// lane likes also matches some stray word ("so", "many"), and at K=60 those weak two-lane rows
// buried the one true paraphrase (measured: a rule about running fewer tests, first by meaning at 0.72,
// fell out of the top 12 for "stop running so many tests"). At 5 a lane's best row always shows.
const K = 5;
function fuse(words, meaning, limit) {
  const byId = new Map();
  const add = (rows, lane) => rows.forEach((d, i) => {
    const e = byId.get(d.id) || { d: { ...d }, score: 0, lanes: new Set() };
    e.score += 1 / (K + i); e.lanes.add(lane);
    if (d.sim !== undefined) e.d.sim = d.sim;
    byId.set(d.id, e);
  });
  add(words, 'words'); add(meaning, 'meaning');
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit)
    .map((e) => ({ ...e.d, byMeaning: !e.lanes.has('words') }));
}

function runSearch(store, cfg, opts, sid, caller) {
  const dated = opts.order === 'oldest' || opts.order === 'newest';
  const match = buildMatch(opts.query, dated ? ' AND ' : ' OR ');
  const kinds = opts.kinds || DISTILLED;
  const result = { distilled: [], raw: [], deepBlocks: [], notes: [] };
  if (match) {
    const limit = opts.limit || 12;
    // ONE eligibility object for every lane: words, meaning, the RAW block and deep context.
    const f = {
      kinds, who: opts.who, client: opts.client && opts.client !== 'all' ? opts.client : undefined, outcomes: opts.outcomes,
      since: opts.since, until: opts.until, session: opts.session,
      files: opts.files, includeSuperseded: !!opts.includeSuperseded, spokenOnly: !opts.files && !opts.tools,
    };
    if (opts.qvec && !dated) {
      // Two lanes, one answer: the words lane finds what was said in these words, the meaning lane
      // finds the paraphrase that shares none of them. A date-ordered search stays words-only,
      // because "the earliest turn that is roughly about X" is not a question with an answer.
      const pool = Math.max(limit * 4, 40);
      const minSim = (cfg.search && cfg.search.minSim) || 0.62;
      const meaning = store.vectorSearch(opts.qvec, f, opts.vecModel, pool).filter((d) => d.sim >= minSim);
      result.distilled = fuse(store.search(match, { ...f, limit: pool }), meaning, limit);
    } else {
      result.distilled = store.search(match, { ...f, limit, order: opts.order });
    }
    // The RAW block is "the last few days, not yet distilled"; a dated question asked for its own window.
    if (!kinds.includes('turn') && !dated && !opts.until) {
      const days = (cfg.search && cfg.search.rawRecentDays) || 7;
      const lim = (cfg.search && cfg.search.rawRecentLimit) || 5;
      const since = new Date(Date.now() - days * 86400000).toISOString();
      result.raw = store.recentUndistilledTurns(match, since, lim, coveredSessions(store, since), f);
    }
    // A statement the owner's later words may replace, or clash with, says so beside the hit.
    for (const d of result.distilled) if (d.kind === 'statement') d.relations = store.relationsOf(d.id);
    if (opts.deep) {
      for (const hit of result.distilled.slice(0, opts.deepLimit || 6)) result.deepBlocks.push({ hit, turns: deepFor(store, hit) });
    }
    // "The earliest hit" is only the first discussion if the beginning of every conversation is on record.
    if (opts.order === 'oldest') {
      const n = Number(store.getMeta('codex_incomplete') || 0);
      if (n) result.notes.push(`(coverage: ${n} Codex conversation(s) are missing their earlier history, so the earliest hit here may not be the first discussion)`);
    }
  }
  if (sid) gate.ack(cfg.project, sid, caller);
  return result;
}

// Body text after the title, collapsed, so a hit shows what the section says and not only its heading.
function snippet(d, n) {
  let b = String(d.body || '').replace(/\s+/g, ' ').trim();
  if (d.title && b.startsWith(d.title)) b = b.slice(d.title.length).trim();
  return b.length > n ? b.slice(0, n - 1) + '…' : b;
}

// Who is speaking in a raw row: the owner, or the assistant of the client that recorded it. A
// compaction summary is nobody's direct statement and says so.
function speakerOf(d) {
  if (d.kind === 'compact_summary' || d.origin === 'summary') return 'summary';
  if (d.role === 'user') return d.origin === 'reference' ? 'owner, reference' : 'owner';
  const a = d.source_client === 'codex' ? 'codex' : 'claude';
  return d.origin === 'reference' ? `${a}, reference` : a;
}

function sessionLabel(d) {
  const s = String(d.session_id);
  return s.startsWith('codex:') ? `codex:${s.slice(6, 14)}` : s.slice(0, 8);
}

function provenance(d) {
  if (d.kind !== 'statement') return '';
  const p = String(d.path || '');
  if (p.startsWith('decide:')) return ` recorded in session by ${p.slice(7)}`;
  const report = d.who !== 'owner' && d.outcome === 'completed' ? ', an assistant\'s report, not verified' : '';
  if (p.startsWith('distill:')) return ` extracted later by ${String(d.adapter || 'distill/a local model').replace('distill/', '')}${report}`;
  return report ? report.slice(1) : '';
}

function header(d) {
  // Statements carry who + outcome; raw turns and compaction summaries carry the speaker.
  const speaker = d.role || d.kind === 'compact_summary' ? ` [${speakerOf(d)}]` : '';
  // A statement says what KIND of thing it is: the owner's decision (and who wrote it down, when),
  // or an assistant's own report, which nobody verified. UNCLEAR stays unclear.
  const unclear = d.origin === 'decision-unclear' ? ' UNCLEAR' : '';
  const tag = d.kind === 'statement' ? ` [${d.who} ${d.outcome}${unclear}]${provenance(d)}` : speaker;
  // Only the owner strikes. A later decision REPLACES; an unsettled clash is a CONFLICT for the owner.
  const conflict = (d.relations || []).filter((r) => r.prompt_sha === 'owner-decision-conflict').map((r) => `#${r.old_id === d.id ? r.new_id : r.old_id}`);
  const struck = (d.status === 'struck' ? ' STRUCK as wrong by the owner' : d.superseded_by ? ` REPLACED by #${d.superseded_by}` : '')
    + (conflict.length ? ` CONFLICT with ${conflict.join(', ')} (owner to decide)` : '');
  // A hit that shares none of the query's words says so, with how close it is, so nobody wonders why it is here.
  const meaning = d.byMeaning ? ` ~meaning ${d.sim.toFixed(2)}` : '';
  const from = d.session_id ? sessionLabel(d) : d.path && !String(d.path).startsWith('distill:') ? path.basename(d.path) : 'file';
  return `#${d.id} ${d.kind} ${String(d.ts).slice(0, 10)} ${from}${tag}${struck}${meaning}`;
}

function format(result, opts) {
  const lines = [];
  if (!result.distilled.length && !result.raw.length) lines.push(`no hits for "${opts.query}"`);
  for (const d of result.distilled) {
    if (d.kind === 'statement' && d.quote) {
      // The words are the record; the sentence under them is somebody's reading of those words.
      lines.push(header(d), `  ${d.who} said: "${d.quote}"`, `  reading: ${d.title}`);
    } else lines.push(header(d), `  ${d.title}`);
    if (d.kind === 'statement' && d.reason) lines.push(`  reason: ${d.reason}`);
    // A heading alone ("Open", "Tests") says nothing: file sections carry a snippet of their body.
    if (d.kind !== 'statement') lines.push(`  ${snippet(d, 220)}`);
  }
  if (result.raw.length) {
    lines.push('', 'RAW, not yet distilled:');
    for (const d of result.raw) lines.push(header(d), `  ${speakerOf(d)}: ${d.body.slice(0, 200).replace(/\s+/g, ' ')}`);
  }
  for (const b of result.deepBlocks) {
    if (!b.turns.length) continue; // a file-sourced hit (memory, handoff) has no turns behind it
    // Deep output names the whole conversation key and where the evidence was read.
    const first = b.turns[0];
    const where = first.path ? ` (${first.source_client || 'claude'}:${String(first.session_id).replace(/^codex:/, '')}, ${path.basename(String(first.path))}${first.src_offset !== null && first.src_offset !== undefined ? ` @${first.src_offset}` : ''})` : '';
    lines.push('', `deep for ${header(b.hit)}${where}:`);
    for (const t of b.turns) lines.push(`  [T${t.id}] ${speakerOf(t)}: ${t.body.replace(/\s+/g, ' ').slice(0, 600)}`);
  }
  for (const n of result.notes || []) lines.push(n);
  return lines.join('\n') + '\n';
}

// Flags (CLI) or tool arguments (MCP) -> search options. Both callers speak the same names.
function optsFrom(f, query) {
  const str = (v) => (typeof v === 'string' && v ? v : undefined);
  const since = str(f.on) || str(f.since) || str(f.from);
  const until = str(f.on) || str(f.until) || str(f.to);
  for (const d of [since, until]) {
    if (d !== undefined && !isDate(d)) return { error: `"${d}" is not a date; use YYYY-MM-DD, YYYY-MM or YYYY` };
  }
  if (str(f.who) && !WHO.includes(f.who)) return { error: `--who is one of ${WHO.join(', ')}, not "${f.who}"` };
  if (str(f.client) && !CLIENT.includes(f.client)) return { error: `--client is one of ${CLIENT.join(', ')}, not "${f.client}"` };
  const order = f.oldest || f.order === 'oldest' ? 'oldest' : f.newest || f.order === 'newest' ? 'newest' : undefined;
  return { opts: {
    query, kinds: parseKinds(f.kind), who: str(f.who), client: str(f.client), outcomes: str(f.outcome) ? f.outcome.split(',') : undefined,
    files: str(f.files), session: str(f.session), since, until, order, tools: !!f.tools, deep: !!f.deep,
    words: !!f.words, limit: f.limit ? Number(f.limit) : 12, includeSuperseded: !!f['include-superseded'],
  } };
}

// One entry point for the CLI and the MCP server: resolve the session filter and the meaning lane,
// search, format. Returns { text, ok, hits }: `ok` false means no search happened (so no gate opens).
async function answerFull(cfg, store, opts, sid, caller) {
  if (opts.session) {
    // A search target, never the caller: it filters rows and opens nobody's gate by itself.
    const found = store.resolveSession(opts.session);
    if (found.length > 1) return { ok: false, hits: 0, text: `"${opts.session}" matches ${found.length} conversations; name one: ${found.map((s) => (s.startsWith('codex:') ? s : `claude:${s}`)).join(', ')}\n` };
    if (found.length === 1) opts.session = found[0];
  }
  const dated = opts.order === 'oldest' || opts.order === 'newest';
  let note = '';
  if (!opts.words && !dated && opts.qvec === undefined) {
    opts.vecModel = embedModel(cfg);
    try { opts.qvec = await queryVector(cfg, store, opts.query); }
    catch { opts.qvec = null; note = `(meaning lane off: Ollama did not answer for ${opts.vecModel}; these hits are by words alone)\n`; }
  }
  const result = runSearch(store, cfg, opts, sid, caller);
  return { ok: true, hits: result.distilled.length + result.raw.length, text: format(result, opts) + note };
}
async function answer(cfg, store, opts, sid, caller) { return (await answerFull(cfg, store, opts, sid, caller)).text; }

async function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const f = args.flags;
  // The parser hands a bare flag the next word as its value; for a yes/no flag that word is the query's.
  for (const k of ['deep', 'oldest', 'newest', 'tools', 'words', 'include-superseded']) {
    if (typeof f[k] === 'string') { args.positional.push(f[k]); f[k] = true; }
  }
  const query = args.positional.join(' ');
  if (!query.trim()) { process.stderr.write('total_recall search: give a query\n'); return 1; }
  const { opts, error } = optsFrom(f, query);
  if (error) { process.stderr.write(`total_recall search: ${error}\n`); return 1; }
  // --session on search filters; it never impersonates a session for the gate. A Codex task that
  // has no hook to acknowledge its search names itself instead: --as codex --caller <its session id>.
  const caller = f.as === 'codex' ? 'codex' : 'claude';
  const sid = caller === 'codex' ? (typeof f.caller === 'string' ? f.caller : null) : resolveSessionId({ payload: null, flags: {} });
  const store = openStore(cfg.store);
  try {
    const r = await answerFull(cfg, store, opts, sid, caller);
    process.stdout.write(r.text);
    if (!sid) process.stdout.write('(no session id; gate not touched)\n');
  } finally { store.close(); }
  return 0;
}

module.exports = { buildMatch, isDate, parseKinds, optsFrom, fuse, runSearch, answer, answerFull, format, command, DISTILLED, ALL, WHO, CLIENT };
