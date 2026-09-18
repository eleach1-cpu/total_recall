'use strict';
const { loadConfig, noConfigMessage } = require('./config');
const { openStore } = require('./store');

// `strike <id> --reason "..."`: the owner says a distilled statement is wrong. It leaves every
// search and the brief, stays in the store with the reason, and `--undo` brings it back. Only
// statements can be struck: turns, notes and maps are the record itself, not a model's reading.
function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const id = Number(String(args.positional[0] || '').replace(/^#/, ''));
  if (!Number.isInteger(id) || id <= 0) { process.stderr.write('total_recall strike: give the statement id, e.g.  strike 89057 --reason "the owner said yes, not no"\n'); return 1; }
  const store = openStore(cfg.store);
  try {
    if (args.flags.undo) {
      const d = store.unstrike(id);
      if (!d) { process.stderr.write(`total_recall strike: #${id} is not a struck statement\n`); return 1; }
      process.stdout.write(`#${id} is back in force: ${d.title}\n`);
      return 0;
    }
    const reason = typeof args.flags.reason === 'string' ? args.flags.reason.trim() : '';
    if (!reason) { process.stderr.write('total_recall strike: say why with --reason "...", so the record shows what was wrong\n'); return 1; }
    const d = store.strike(id, reason);
    if (!d) { process.stderr.write(`total_recall strike: #${id} is not a statement (only statements can be struck)\n`); return 1; }
    process.stdout.write(`struck #${id} [${d.who} ${d.outcome}] ${d.title}\n  reason: ${reason}\n`);
    return 0;
  } finally { store.close(); }
}

module.exports = { command };
