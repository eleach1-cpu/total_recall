'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, noConfigMessage } = require('./config');
const { openStore, sha256 } = require('./store');
const { parseSelector } = require('./ingest');

const OUTCOMES = new Set(['proposed', 'approved', 'rejected', 'completed', 'superseded', 'standing', 'open']);
const WHO = new Set(['owner', 'claude', 'codex']);

// The prompt lives in its own file so tuning is a text edit. Its sha is part of every run key, so
// a changed prompt re-runs every chunk and retires the statements the old prompt produced.
// Tune against tests/prompt-eval/gold.json with scripts/eval-prompt.js.
const PROMPT = fs.readFileSync(path.join(__dirname, 'distill-prompt.txt'), 'utf8').replace(/\r\n/g, '\n').replace(/\s*$/, '\n');
const PROMPT_SHA = sha256(PROMPT);

// A Codex conversation is read with the same rules under the assistant's real name. The Codex
// prompt is DERIVED from the tuned file, so the file, and with it the sha that keys every Claude
// run, stays byte-identical: adding a client re-runs nothing that was already distilled.
const PROMPTS = { claude: { text: PROMPT, sha: PROMPT_SHA } };
function promptFor(client) {
  const c = client === 'codex' ? 'codex' : 'claude';
  if (!PROMPTS[c]) {
    const text = PROMPT.replace(/CLAUDE/g, 'CODEX').replace(/Claude/g, 'Codex').replace(/claude/g, 'codex');
    PROMPTS[c] = { text, sha: sha256(text) };
  }
  return PROMPTS[c];
}
// Who said a turn is a fact of the record, never the model's opinion.
const speakerOf = (t) => (t.role === 'user' ? 'owner' : t.source_client === 'codex' ? 'codex' : 'claude');

function chunkTurns(turns, maxChars) {
  const chunks = [];
  let cur = [], size = 0;
  for (const t of turns) {
    const len = t.body.length + 24;
    if (cur.length && size + len > maxChars) { chunks.push(cur); cur = []; size = 0; }
    cur.push(t); size += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((c) => ({ turns: c, turn_from: c[0].id, turn_to: c[c.length - 1].id }));
}

const label = speakerOf;
function renderChunk(turns) {
  return turns.map((t) => `[T${t.id}] ${label(t)}: ${t.body.replace(/\s+/g, ' ').trim()}`).join('\n');
}

function parseReply(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const tryJson = (x) => { try { return JSON.parse(x); } catch { return undefined; } };
  let j = tryJson(s);
  if (j === undefined) {
    const items = s.split('\n').map((l) => tryJson(l.trim())).filter((x) => x && typeof x === 'object');
    if (!items.length) return null;
    if (items.length === 1 && items[0].none) return { none: true, items: [] };
    return { none: false, items };
  }
  if (Array.isArray(j)) return { none: false, items: j };
  if (j && j.none) return { none: true, items: [] };
  if (j && Array.isArray(j.items)) return { none: false, items: j.items };
  return null;
}

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// The words of a text with where each one sits, so a fuzzy match can hand back the turn's own wording.
function wordsOf(s) {
  const out = []; const re = /[\p{L}\p{N}]+/gu; let m;
  while ((m = re.exec(s))) out.push({ w: m[0].toLowerCase(), i: m.index, j: m.index + m[0].length });
  return out;
}

// The model tidies quotes: drops a filler word, fixes punctuation, joins two clauses. Exact-match
// validation threw away about half its lines for that. A quote now also passes when every one of
// its words appears in the turn, in order, with at most GAP stray words between neighbours, and
// what is stored is the TURN's text for that span, so the quote on record is still verbatim.
// ponytail: greedy nearest-next match; a backtracking match would rescue a few more, add if the
// drop reasons still show "quote not in T" after this.
const GAP = 3;
function fuzzyQuote(body, quote) {
  const q = wordsOf(quote);
  if (q.length < 4) return null; // too short to tell a paraphrase from a coincidence
  const b = wordsOf(body);
  for (let s = 0; s < b.length; s++) {
    if (b[s].w !== q[0].w) continue;
    let k = 1, last = s;
    for (let i = s + 1; i < b.length && k < q.length && i - last <= GAP + 1; i++) if (b[i].w === q[k].w) { k++; last = i; }
    if (k === q.length) return body.slice(b[s].i, b[last].j).replace(/\s+/g, ' ');
  }
  return null;
}

function validate(item, turns) {
  if (!item || typeof item !== 'object') return { ok: false, reason: 'not an object' };
  if (item.who !== undefined && item.who !== null && !WHO.has(item.who)) return { ok: false, reason: `who=${item.who}` };
  if (!OUTCOMES.has(item.outcome)) return { ok: false, reason: `outcome=${item.outcome}` };
  if (typeof item.statement !== 'string' || !item.statement.trim()) return { ok: false, reason: 'no statement' };
  const turnId = Number(String(item.turn).replace(/^T/i, ''));
  const idx = turns.findIndex((t) => t.id === turnId);
  if (idx === -1) return { ok: false, reason: `turn ${item.turn} not in chunk` };
  let quote = String(item.quote || '').trim();
  if (!quote || quote.length > 240) return { ok: false, reason: `quote not in T${turnId}` };
  if (!collapse(turns[idx].body).includes(collapse(quote))) {
    quote = fuzzyQuote(turns[idx].body, quote);
    if (!quote || quote.length > 240) return { ok: false, reason: `quote not in T${turnId}` };
  }
  // `who` is a fact of the cited turn, not the model's opinion: derived from the turn's role.
  const who = speakerOf(turns[idx]);
  // Only the owner can set a standing rule; an assistant line tagged standing is a mislabel.
  if (item.outcome === 'standing' && who !== 'owner') return { ok: false, reason: `standing cited a ${who} turn T${turnId}` };
  // Only the owner approves; an assistant's "Agreed" is not an approval of anything.
  if (item.outcome === 'approved' && who !== 'owner') return { ok: false, reason: `approved cited a ${who} turn T${turnId}` };
  // A question is never an open item: "how much is left?" defers nothing.
  if (item.outcome === 'open' && /\?\s*$/.test(quote)) return { ok: false, reason: `open cited a question T${turnId}` };
  const evidence = [turnId];
  if (turns[idx].role === 'assistant' && idx > 0 && turns[idx - 1].role === 'user') evidence.unshift(turns[idx - 1].id);
  const reason = typeof item.reason === 'string' && item.reason.trim() && item.reason.trim().toLowerCase() !== 'null' ? item.reason.trim() : null;
  return { ok: true, statement: { who, outcome: item.outcome, statement: item.statement.trim().slice(0, 300), quote, evidence, reason, ts: turns[idx].ts } };
}

async function callOllama(cfg, model, prompt) {
  const res = await fetch(`${cfg.ollama.url.replace(/\/$/, '')}/api/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, think: false, format: 'json', options: { temperature: 0, num_ctx: 8192 } }),
  });
  if (!res.ok) throw new Error(`ollama answered ${res.status} for ${model}`);
  const j = await res.json();
  const text = j && typeof j.response === 'string' ? j.response : '';
  if (!text.trim()) throw new Error('ollama returned an empty reply');
  return text;
}

// The Claude API, for machines without a local model. Raw HTTP on purpose: this repo has no npm
// dependencies. Credentials come from the environment, never from config: ANTHROPIC_API_KEY, or
// ANTHROPIC_AUTH_TOKEN (an OAuth token from `ant auth login`).
const CLAUDE_DEFAULT_MODEL = 'claude-opus-5';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

function claudeAuthHeaders(env) {
  if (env.ANTHROPIC_API_KEY) return { 'x-api-key': env.ANTHROPIC_API_KEY };
  if (env.ANTHROPIC_AUTH_TOKEN) return { authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`, 'anthropic-beta': 'oauth-2025-04-20' };
  return null;
}

async function callClaude(cfg, model, prompt, env = process.env) {
  const auth = claudeAuthHeaders(env);
  if (!auth) throw new Error('claude provider needs ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the environment');
  const url = (cfg.distill && cfg.distill.url) || CLAUDE_URL;
  // Server-side refusal fallback is on by default so a policy decline reroutes instead of
  // failing the chunk; the header names the "default" form of the parameter.
  const betas = ['server-side-fallback-2026-07-01'];
  if (auth['anthropic-beta']) betas.push(auth['anthropic-beta']);
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...auth, 'anthropic-version': '2023-06-01', 'anthropic-beta': betas.join(','), 'content-type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: 16000, fallbacks: 'default',
      system: 'You answer with one JSON object and nothing else.',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error(`claude api answered ${res.status} for ${model}${detail ? `: ${detail}` : ''}`);
  }
  const j = await res.json();
  if (j.stop_reason === 'refusal') throw new Error(`claude api refused the chunk (${(j.stop_details && j.stop_details.category) || 'no category'})`);
  const text = (Array.isArray(j.content) ? j.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  if (!text.trim()) throw new Error('claude api returned an empty reply');
  return text;
}

// One seam for every provider. `cfg.distill.provider` is 'ollama' (default) or 'claude'.
function providerOf(cfg, opts) {
  return (opts && opts.provider) || (cfg.distill && cfg.distill.provider) || 'ollama';
}
function modelFor(cfg, opts) {
  if (opts && opts.model) return opts.model;
  if (cfg.distill && cfg.distill.model) return cfg.distill.model;
  return providerOf(cfg, opts) === 'claude' ? CLAUDE_DEFAULT_MODEL : cfg.ollama.model;
}
async function callModel(cfg, opts, prompt) {
  const model = modelFor(cfg, opts);
  if (providerOf(cfg, opts) === 'claude') return callClaude(cfg, model, prompt);
  return callOllama(cfg, model, prompt);
}

function failedDir() {
  return path.join(process.env.TOTAL_RECALL_HOME || path.join(os.homedir(), '.total_recall'), 'failed');
}

// A chunk that cannot be parsed, or an Ollama error, is a FAILED chunk: nothing stored, no run
// row (so it is retried next time), the raw reply kept on disk for diagnosis, and the run goes on
// to the next chunk. The command exits non-zero at the end if any chunk failed.
function recordFailure(out, sid, chunk, reason, reply) {
  out.failed.push({ session_id: sid, turn_from: chunk.turn_from, turn_to: chunk.turn_to, reason });
  if (reply) {
    try {
      fs.mkdirSync(failedDir(), { recursive: true });
      fs.writeFileSync(path.join(failedDir(), `${sid.slice(0, 8)}-T${chunk.turn_from}-T${chunk.turn_to}.txt`), reply);
    } catch {}
  }
}

async function distillSession(store, cfg, sid, opts) {
  const model = modelFor(cfg, opts);
  const maxChars = (cfg.ollama.chunkTokens || 6000) * 4;
  const out = { sent: 0, skipped: 0, stored: 0, dropped: 0, dropReasons: [], failed: [] };
  // Tool-only turns ("(tool-only turn: Edit) src/x.js") stay searchable but carry no statements;
  // a slice made of nothing else made the model answer {"error": "Invalid command"}.
  // Only what was said directly in this conversation is evidence. Reference rows (history a fork
  // inherited, an assistant phase nobody has looked at yet) stay searchable and are never distilled.
  const turns = store.turnsForSession(sid).filter((t) => !t.body.startsWith('(tool-only turn:') && (!t.origin || t.origin === 'direct'));
  const client = (turns[0] && turns[0].source_client) || 'claude';
  const prompt = promptFor(client);
  const tag = `distill:${prompt.sha}`;
  for (const chunk of chunkTurns(turns, maxChars)) {
    const key = { session_id: sid, turn_from: chunk.turn_from, turn_to: chunk.turn_to, model, prompt_sha: prompt.sha };
    // --redo sends a chunk again although it ran: the way to win back lines an older, stricter
    // validator dropped. Statements already stored are ignored by their sha, so nothing doubles.
    if (store.hasRun(key) && !(opts && opts.redo)) { out.skipped++; continue; }
    let reply;
    try { reply = await callModel(cfg, opts, prompt.text + renderChunk(chunk.turns)); }
    catch (e) { recordFailure(out, sid, chunk, e.message, null); continue; }
    out.sent++;
    const parsed = parseReply(reply);
    if (!parsed) { recordFailure(out, sid, chunk, 'reply was not parseable JSON', reply); continue; }
    // The chunk answered, so what an OLDER prompt said about these same turns steps aside now:
    // here, in this conversation, and nowhere else. A chunk that failed above kept what it had.
    const replaced = store.supersedeChunkStatements(sid, chunk.turn_from, chunk.turn_to, tag);
    if (replaced) out.replaced = (out.replaced || 0) + replaced;
    let lines = 0;
    for (const item of parsed.items) {
      const v = validate(item, chunk.turns);
      if (!v.ok) { out.dropped++; if (out.dropReasons.length < 3) out.dropReasons.push(v.reason); continue; }
      const s = v.statement;
      // The finding already stands on this exact turn: kept as it is (its id, links and verdicts
      // with it), or struck by the owner, in which case no rewording brings it back.
      const cited = s.evidence[s.evidence.length - 1];
      if (store.statementTwin(sid, cited, s.outcome)) continue;
      const r = store.insertDoc({
        // path names the prompt that produced it, so a retuned prompt supersedes older statements.
        project: cfg.project, kind: 'statement', session_id: sid, ts: s.ts, path: tag, source_client: client, origin: 'direct',
        // Identity is the evidence, not the wording: this conversation, this turn, this outcome.
        sha: sha256(['statement2', sid, cited, s.outcome].join('|')),
        title: s.statement, body: `${s.statement}\nquote: ${s.quote}${s.reason ? `\nreason: ${s.reason}` : ''}\nsession ${sid} ${s.ts.slice(0, 10)}`,
        who: s.who, outcome: s.outcome, evidence_ids: JSON.stringify(s.evidence), quote: s.quote, reason: s.reason,
      });
      if (r.inserted) { out.stored++; lines++; }
    }
    store.insertRun({ ...key, ran_at: new Date().toISOString(), lines });
  }
  return out;
}

async function run(cfg, sel, opts, store) {
  const own = !store;
  const s = store || openStore(cfg.store);
  const t0 = Date.now();
  try {
    // Nothing is retired up front or store-wide. An older prompt's statements are replaced chunk
    // by chunk, inside distillSession, only where the new prompt's chunk actually succeeded.
    s.dedupeStatements();
    const firstNewId = s.maxDocId() + 1;
    let sessions;
    if (sel.mode === 'session') sessions = [sel.session];
    else {
      sessions = s.recentSessionIds(10000);
      if (sel.mode === 'range') {
        sessions = sessions.filter((sid) => {
          const t = s.turnsForSession(sid); if (!t.length) return false;
          const first = t[0].ts, last = t[t.length - 1].ts;
          if (sel.since && last < sel.since) return false;
          if (sel.to) { const end = new Date(sel.to + 'T00:00:00.000Z'); end.setUTCDate(end.getUTCDate() + 1); if (first >= end.toISOString()) return false; }
          return true;
        });
      }
    }
    const total = { sent: 0, skipped: 0, stored: 0, dropped: 0, dropReasons: [], failed: [], sessions: sessions.length };
    for (const sid of sessions) {
      const r = await distillSession(s, cfg, sid, opts);
      total.sent += r.sent; total.skipped += r.skipped; total.stored += r.stored; total.dropped += r.dropped;
      total.dropReasons.push(...r.dropReasons.slice(0, Math.max(0, 3 - total.dropReasons.length)));
      total.failed.push(...r.failed);
      if (opts.onSession) opts.onSession(sid, r);
    }
    total.deduped = s.dedupeStatements();
    total.firstNewId = firstNewId;
    total.seconds = (Date.now() - t0) / 1000;
    total.model = modelFor(cfg, opts);
    total.provider = providerOf(cfg, opts);
    return total;
  } finally { if (own) s.close(); }
}

async function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const sel = parseSelector(args.flags);
  if (sel.mode === 'new') sel.mode = 'all';
  const provider = typeof args.flags.provider === 'string' ? args.flags.provider : undefined;
  if (provider && provider !== 'ollama' && provider !== 'claude') { process.stderr.write(`total_recall distill: --provider must be ollama or claude, not "${provider}"\n`); return 1; }
  if (providerOf(cfg, { provider }) === 'claude' && !claudeAuthHeaders(process.env)) {
    process.stderr.write('total_recall distill: the claude provider needs ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the environment; nothing was sent\n');
    return 1;
  }
  const r = await run(cfg, sel, {
    provider, redo: !!args.flags.redo,
    model: typeof args.flags.model === 'string' ? args.flags.model : undefined,
    onSession: (sid, x) => { if (x.sent || x.failed.length) process.stderr.write(`  ${sid.slice(0, 8)}: ${x.sent} chunks, ${x.stored} stored, ${x.dropped} dropped${x.failed.length ? `, ${x.failed.length} FAILED` : ''}\n`); },
  });
  // New statements get their vectors while Ollama is warm, then the supersession links are redrawn
  // over the whole set. Neither may fail a distill: `embed` and `link` are re-runnable on their own.
  r.embedded = 0; r.linked = 0;
  // Both are bounded to this run and said in the summary line: vectors for the rows that lack one
  // (local and free), and link judgments ONLY for pairs whose newer statement this run produced, so
  // a small distill never quietly pays to judge the whole store. `total_recall link` does the rest.
  // Spoken turns too (owner, 2026-09-18): the end-of-day distill keeps the meaning lane current for
  // raw conversation, so nobody has to remember `embed --kind all`. Only rows without a vector are sent.
  try { const e = require('./embed'); r.embedded = (await e.run(cfg, { kinds: [...e.EMBED_KINDS, 'turn'] })).embedded; } catch {}
  r.judged = 0;
  try { const s = openStore(cfg.store); try { const l = await require('./link').run(cfg, s, { provider, newerThan: r.firstNewId - 1 }); r.linked = l.linked; r.judged = l.judged; } finally { s.close(); } } catch {}
  process.stdout.write(`distilled ${r.sessions} sessions: ${r.sent} chunks sent, ${r.skipped} already done, ${r.stored} statements stored, ${r.dropped} dropped by validation${r.dropReasons.length ? ` (${r.dropReasons.join('; ')})` : ''}, ${r.embedded} embedded, ${r.judged} link pairs judged, ${r.linked} superseded links, ${r.seconds.toFixed(1)} seconds, ${r.provider} ${r.model}\n`);
  if (r.failed.length) {
    process.stderr.write(`${r.failed.length} chunk(s) FAILED and will be retried next run (raw replies under ${failedDir()}):\n`);
    for (const f of r.failed) process.stderr.write(`  ${f.session_id.slice(0, 8)} T${f.turn_from}-T${f.turn_to}: ${f.reason}\n`);
    return 1;
  }
  return 0;
}

module.exports = { PROMPT, PROMPT_SHA, promptFor, speakerOf, chunkTurns, renderChunk, parseReply, validate, fuzzyQuote, distillSession, run, command,
  callOllama, callClaude, callModel, providerOf, modelFor, claudeAuthHeaders, CLAUDE_DEFAULT_MODEL };
