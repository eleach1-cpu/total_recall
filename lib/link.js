'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, noConfigMessage } = require('./config');
const { openStore, sha256 } = require('./store');
const { embedModel } = require('./embed');

// Automatic supersession links between distilled statements: when a later decision replaces an
// earlier one, the earlier one prints STRUCK and names its successor.
//
// A wrong link hides a live decision, so likeness only NOMINATES a pair and the model decides.
// Measured on the first real store (250 statements): likeness plus an approved/rejected flip drew
// 14 links and 13 were wrong, because "Owner approved ..." titles all sit near 0.80 of each other
// and "rejected the new layout" followed by "approved keeping the old layout" is one decision
// said twice, not a reversal. So:
//
//   nominate  a pair whose shapes could be a replacement (below) and that are about the same thing
//             (vector similarity when both have vectors, shared title words otherwise), at most
//             three older statements per newer one;
//   judge     each nominated pair once per judge prompt, ever, with the distill model, showing it
//             the words actually said; the verdict is kept in link_verdicts and never bought again.
//
// Shapes: a statement the model labelled `superseded` and a later one in the SAME session; or an
// owner decision against an older statement it could overturn (rejected over approved, proposed
// or completed; approved over rejected; a standing rule over a standing rule).

// Like the distill prompt: a text file, so tuning is a text edit, and its sha keys every verdict,
// so a retuned judge re-judges instead of trusting what the old wording decided.
const PROMPT = fs.readFileSync(path.join(__dirname, 'link-prompt.txt'), 'utf8').split('\r').join('');
const PROMPT_SHA = sha256(PROMPT);

const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'owner', 'claude', 'was', 'were', 'are', 'not', 'its', 'has',
  'have', 'had', 'should', 'will', 'into', 'over', 'approved', 'approves', 'rejected', 'rejects', 'requested', 'asked', 'wants', 'wanted']);
const tokens = (s) => new Set(String(s).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)?.filter((w) => !STOP.has(w)) || []);

function overlap(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

const OVERTURNS = { rejected: new Set(['approved', 'proposed', 'completed']), approved: new Set(['rejected']), standing: new Set(['standing']) };
const PER_NEWER = 3;

// statements: oldest first. likeness(a, b) -> { near: boolean, score }.
function nominate(statements, likeness) {
  const pairs = [];
  for (let j = 0; j < statements.length; j++) {
    const neu = statements[j];
    if (neu.outcome === 'superseded') continue;
    const found = [];
    for (let i = 0; i < j; i++) {
      const old = statements[i];
      if (old.ts >= neu.ts) continue; // two items cut from the same turn never replace each other
      const labelled = old.outcome === 'superseded' && old.session_id === neu.session_id;
      const overturn = neu.who === 'owner' && OVERTURNS[neu.outcome] && OVERTURNS[neu.outcome].has(old.outcome);
      if (!labelled && !overturn) continue;
      // "No to the new layout" then "yes, keep the old one" minutes later is one decision said
      // twice, and it is the one case the 14b judge got wrong even with that exact example in its
      // prompt. A rejection is only overturned by an approval from a LATER session.
      if (!labelled && neu.outcome === 'approved' && old.session_id === neu.session_id) continue;
      const l = likeness(old, neu);
      if (l.near) found.push({ old, neu, score: l.score });
    }
    pairs.push(...found.sort((a, b) => b.score - a.score).slice(0, PER_NEWER));
  }
  return pairs;
}

// The words of the turn a statement cites: a distilled title ("the current layout") is too vague
// to judge by, the conversation is not.
function said(store, s) {
  let ids = [];
  try { ids = JSON.parse(s.evidence_ids || '[]'); } catch {}
  const turn = ids.length && store ? store.getDoc(ids[ids.length - 1]) : null;
  return String(turn ? turn.body : s.quote || '').split(/\s+/).join(' ').trim().slice(0, 500);
}

function judgePrompt(old, neu, store) {
  const entry = (tag, s) => `${tag} (${String(s.ts).slice(0, 10)}, ${s.who} ${s.outcome}): ${s.title}\n  said at the time: "${said(store, s)}"`;
  return `${PROMPT}\n${entry('OLDER', old)}\n${entry('NEWER', neu)}\nAnswer:`;
}

function modelJudge(cfg, opts, store) {
  const { callModel, modelFor } = require('./distill');
  return { model: modelFor(cfg, opts), ask: async (old, neu) => {
    const reply = String(await callModel(cfg, opts, judgePrompt(old, neu, store)));
    const m = /"replaces"[^a-z]*(true|false)/.exec(reply);
    if (!m) throw new Error(`the judge did not answer true or false: ${reply.slice(0, 120)}`);
    return m[1] === 'true';
  } };
}

// ponytail: every earlier statement is compared with every later one, O(n^2) dot products; fine to
// a few thousand statements. Past that, nominate from the meaning lane's top-k instead.
async function run(cfg, store, opts = {}) {
  const statements = store.distilledStatements();
  const model = embedModel(cfg);
  const vec = new Map();
  for (const s of statements) { const v = store.getVector(s.id, model); if (v) vec.set(s.id, v); }
  const minSim = (cfg.link && cfg.link.minSim) || 0.8;
  const minOverlap = (cfg.link && cfg.link.minOverlap) || 0.3;
  const likeness = (a, b) => {
    const va = vec.get(a.id), vb = vec.get(b.id);
    if (va && vb) { let d = 0; for (let i = 0; i < va.length; i++) d += va[i] * vb[i]; return { near: d >= minSim, score: d }; }
    const o = overlap(a.title, b.title);
    return { near: o >= minOverlap, score: o };
  };
  const pairs = nominate(statements, likeness);
  const out = { statements: statements.length, nominated: pairs.length, judged: 0, links: [], pairs };
  let judge = null;
  for (const p of pairs) {
    let verdict = store.getVerdict(p.old.id, p.neu.id, PROMPT_SHA);
    if (verdict === null) {
      if (opts.dry) continue; // a dry run never spends a model call
      // Called at the end of a distill: only pairs that run created are judged now. Older unjudged
      // pairs wait for an explicit `total_recall link`, so no run buys more than it was asked for.
      if (opts.newerThan !== undefined && p.neu.id <= opts.newerThan) continue;
      if (!judge) judge = opts.judge ? { model: 'test', ask: opts.judge } : modelJudge(cfg, opts, store);
      verdict = await judge.ask(p.old, p.neu);
      store.putVerdict(p.old.id, p.neu.id, PROMPT_SHA, judge.model, verdict);
      out.judged++;
    }
    p.replaces = verdict;
  }
  // The first replacement is the one that struck it.
  const struck = new Map();
  for (const p of pairs.filter((x) => x.replaces).sort((a, b) => (a.neu.ts < b.neu.ts ? -1 : 1))) if (!struck.has(p.old.id)) struck.set(p.old.id, p);
  out.links = [...struck.values()];
  out.linked = out.links.length;
  if (!opts.dry) {
    store.clearStatementLinks(); // redrawn whole from the kept verdicts, so nothing stale survives
    for (const l of out.links) store.linkStatement(l.old.id, l.neu.id);
    // Links that rest on the owner's own later words are not the judge's to redraw: put them back.
    store.reapplyOwnerLinks();
  }
  return out;
}

async function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const store = openStore(cfg.store);
  try {
    const r = await run(cfg, store, { dry: !!args.flags.dry, provider: typeof args.flags.provider === 'string' ? args.flags.provider : undefined });
    if (args.flags.all) {
      for (const p of r.pairs) {
        const v = p.replaces === undefined ? 'not asked' : p.replaces ? 'REPLACES ' : 'no       ';
        process.stdout.write(`  ${v} #${p.old.id} [${p.old.outcome}] ${p.old.title.slice(0, 70)}  ->  #${p.neu.id} [${p.neu.outcome}] ${p.neu.title.slice(0, 70)}\n`);
      }
    }
    for (const l of r.links) {
      process.stdout.write(`#${l.old.id} ${l.old.ts.slice(0, 10)} [${l.old.who} ${l.old.outcome}] ${l.old.title}\n  REPLACED by #${l.neu.id} ${l.neu.ts.slice(0, 10)} [${l.neu.who} ${l.neu.outcome}] ${l.neu.title}\n`);
    }
    process.stdout.write(`${r.linked} of ${r.statements} distilled statements struck by a later one; ${r.nominated} pairs nominated, ${r.judged} judged now${args.flags.dry ? ' (dry run: nothing asked, nothing written)' : ''}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`total_recall link: ${e.message}; links left as they were\n`);
    return 1;
  } finally { store.close(); }
}

module.exports = { PROMPT_SHA, overlap, tokens, nominate, judgePrompt, run, command };
