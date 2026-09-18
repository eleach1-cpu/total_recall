#!/usr/bin/env node
'use strict';

// node:sqlite still prints an ExperimentalWarning on Node 22-24; it is noise in a hook.
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.error(w); });

const { parseArgs } = require('../lib/args');

const USAGE = `total_recall <command> [options]

  ingest   [--all | --since D | --from D --to D | --session ID]
  distill  [--all | --since D | --from D --to D | --session ID | --today] [--model TAG]
  search   "<query>" [--kind k,k] [--who owner|claude] [--outcome o,o] [--files GLOB]
           [--session ID] [--since D] [--until D] [--on D] [--oldest | --newest] [--tools] [--words]
           [--deep] [--limit N] [--include-superseded]      (D = YYYY-MM-DD, YYYY-MM or YYYY)
  brief
  embed    [--kind all|k,k]      (vectors for the meaning lane of search; needs Ollama)
  link     [--dry]               (redraw the supersession links between statements)
  strike   <id> --reason "..." | <id> --undo    (the owner says a distilled statement is wrong)
  mcp      [--root DIR]          (serve search and brief to Claude as MCP tools, over stdio)
  gate     --arm | --check | --check-bash | --ack
  session-start        (hook only: arm, ingest, brief)
  --help
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cmd || args.flags.help) { process.stdout.write(USAGE); return 0; }
  const commands = {
    ingest: () => require('../lib/ingest').command(args),
    distill: () => require('../lib/distill').command(args),
    search: () => require('../lib/search').command(args),
    brief: () => require('../lib/brief').command(args),
    embed: () => require('../lib/embed').command(args),
    link: () => require('../lib/link').command(args),
    strike: () => require('../lib/strike').command(args),
    mcp: () => require('../lib/mcp').command(args),
    gate: () => require('../lib/gate').command(args),
    'session-start': () => require('../lib/session-start').command(args),
  };
  const fn = commands[args.cmd];
  if (!fn) { process.stderr.write(`total_recall: unknown command "${args.cmd}"\n${USAGE}`); return 1; }
  return await fn();
}

main().then((code) => { process.exitCode = code || 0; }, (err) => {
  process.stderr.write(`total_recall: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
});
