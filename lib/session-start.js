'use strict';
const { loadConfig, noConfigMessage } = require('./config');
const { openStore } = require('./store');
const { readHookPayload, resolveSessionId } = require('./session');
const gate = require('./gate');
const ingest = require('./ingest');
const brief = require('./brief');

// One process, in order: arm the gate, ingest what is new, print the brief.
// Claude Code runs the hooks of one event in parallel, so this cannot be three hook lines.
function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const payload = readHookPayload();
  const sid = resolveSessionId({ payload, flags: args.flags });
  if (sid) gate.arm(cfg.project, sid);
  const store = openStore(cfg.store);
  try {
    const r = ingest.run(cfg, { mode: 'new' }, store);
    process.stdout.write(`total_recall: ingested ${r.turns} turns, ${r.sections} sections (${r.seconds.toFixed(1)}s)${sid ? '' : '; no session id, gate not armed'}\n`);
    process.stdout.write(brief.buildBrief(store, cfg, brief.recentFiles(cfg.root)).join('\n') + '\n');
  } finally { store.close(); }
  return 0;
}

module.exports = { command };
