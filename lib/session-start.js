'use strict';
const { loadConfig, noConfigMessage } = require('./config');
const { openStore } = require('./store');
const { readHookPayload, resolveSessionId } = require('./session');
const gate = require('./gate');
const ingest = require('./ingest');
const brief = require('./brief');

// One process, in order: arm the gate, ingest what is new, print the brief. Both hosts run the
// hooks of one event in parallel, so this cannot be three hook lines.
//
// The ingest is BOUNDED: a session start gets a couple of seconds. A cold multi-gigabyte Codex
// archive is never imported here; what did not fit waits at its checkpoint and the brief says so.
// No model is ever called from a session start.
function start(cfg, { sid, client, arm = true, out = process.stdout }) {
  if (sid && arm) gate.arm(cfg.project, sid, client);
  let store;
  try { store = openStore(cfg.store); }
  catch (e) { out.write(`total_recall: ${e.message}\n`); return 0; }
  try {
    const budgetMs = (cfg.ingest && cfg.ingest.startupBudgetMs) || 2000;
    let note = '';
    try {
      const r = ingest.run(cfg, { mode: 'new' }, store, { budgetMs });
      note = `total_recall: ingested ${r.turns} turns, ${r.sections} sections (${r.seconds.toFixed(1)}s)${sid ? '' : '; no session id, gate not armed'}`;
      if (r.pending) note += `\ntotal_recall: MORE IS WAITING than a session start may read (${budgetMs} ms); this brief does not cover it yet. Run  total_recall ingest  to catch up.`;
      for (const w of r.warnings) note += `\ntotal_recall: WARNING ${w}`;
    } catch (e) { note = `total_recall: ingest failed (${e.message}); the brief below is from what was already stored`; }
    out.write(note + '\n');
    out.write(brief.buildBrief(store, cfg, brief.recentFiles(cfg.root)).join('\n') + '\n');
  } finally { store.close(); }
  return 0;
}

function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const payload = readHookPayload();
  const sid = resolveSessionId({ payload, flags: args.flags, client: 'claude' });
  return start(cfg, { sid, client: 'claude' });
}

module.exports = { command, start };
