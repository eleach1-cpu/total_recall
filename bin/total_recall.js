#!/usr/bin/env node
'use strict';

// node:sqlite still prints an ExperimentalWarning on Node 22-24; it is noise in a hook.
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.error(w); });

const { parseArgs } = require('../lib/args');

const USAGE = `total_recall <command> [options]

  ingest   [--all | --since D | --from D --to D | --session ID]
  distill  [--all | --since D | --from D --to D | --session ID | --today] [--model TAG]
           [--prompt decisions [--turns ID,ID] [--supersede-weaker] [--dry]]
           [--provider claude --max-usd N --price-in N --price-out N [--effort low|medium|high]]
  recall   "<natural memory request>" [--project NAME] [--client claude|codex|all]
           [--who owner|claude|codex|assistant] [--since D] [--until D] [--on D] [--limit N] [--json]
           [--topic "<subject or empty for whole project>"] [--intent continue|overview|rationale|decision|instruction|related-history|recollection]
           [--words | --mode hybrid|meaning] [--chars N] [--files GLOB] [--session ID]
  find     ["<query>"] [same options as search]       (explicit evidence search)
  search   ["<query>"] [--kind all|k,k] [--who owner|claude|codex|assistant] [--client claude|codex|all]
           [--outcome o,o] [--files GLOB]
           [--session ID] [--since D] [--until D] [--on D] [--oldest | --newest] [--tools] [--words]
           [--deep] [--limit N] [--include-superseded] [--include-unclear] [--direct] [--count] [--browse]
           [--project NAME] [--before D | --after D] [--timezone IANA]
           [--match any|all|phrase|advanced|substring] [--mode words|hybrid|meaning]
           [--cursor TOKEN] [--json]  (D = YYYY[-MM[-DD]], today, yesterday, or zoned ISO time)
  read     ID [--before N --after N] | --session ID [--order oldest|newest]
           [--project NAME] [--chars N] [--limit N] [--cursor TOKEN] [--json]
  inspect-coverage [--project NAME] [--cursor TOKEN] [--json]
  inventory [projects|sessions|coverage] [--project NAME] [--cursor TOKEN] [--json] (compatibility)
  index    [--dry] [--limit N] [--project NAME]  (explicit local chunk embedding; writes derived sidecar only)
  brief
  decide   --client claude|codex --outcome approved|rejected|standing|open --what "..." --scope "..."
           --quote "<the owner's exact words>" [--context "<words from the proposal>"] [--reason "..."]
           [--unclear] [--replaces ID | --conflicts-with ID]     (record one owner decision, in session)
  decisions [--today | --since D] [--pending] [--client c]        (the block a handoff collects)
  unlink   <id>                  (undo a recorded "replaces" or "conflict"; nothing else changes)
  embed    [--kind all|k,k]      (vectors for the meaning lane of search; needs Ollama)
  link     [--dry]               (redraw the supersession links between statements)
  strike   <id> --reason "..." | <id> --undo    (the owner says a distilled statement is wrong)
  mcp      [--root DIR] [--client codex]   (serve Recall, Find, Read, Coverage, brief and decide over stdio)
  migrate                        (owner step: back the store up, then upgrade it to this version's schema)
  codex-hook                     (hook only, Codex: SessionStart, PreToolUse, PostToolUse on one command)
  gate     --arm | --check | --check-bash | --ack
  session-start        (hook only: arm, ingest, brief)
  --root DIR           (any command: work on the project at DIR instead of the current directory)
  --help
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cmd || args.flags.help) { process.stdout.write(USAGE); return 0; }
  // One override for every command, the same resolver the MCP server and the hooks use.
  if (typeof args.flags.root === 'string' && args.cmd !== 'mcp') process.env.TOTAL_RECALL_ROOT = args.flags.root;
  const commands = {
    ingest: () => require('../lib/ingest').command(args),
    distill: () => require('../lib/distill').command(args),
    recall: () => require('../lib/recall').command(args),
    find: () => require('../lib/recall').command(args),
    search: () => require('../lib/recall').command(args),
    read: () => require('../lib/recall').command(args),
    inventory: () => require('../lib/recall').command(args),
    'inspect-coverage': () => require('../lib/recall').command(args),
    index: () => require('../lib/recall-meaning').command(args),
    brief: () => require('../lib/recall').command(args),
    decide: () => require('../lib/decide').command(args),
    decisions: () => require('../lib/decide').command(args),
    unlink: () => require('../lib/decide').command(args),
    embed: () => require('../lib/embed').command(args),
    link: () => require('../lib/link').command(args),
    strike: () => require('../lib/strike').command(args),
    mcp: () => require('../lib/mcp').command(args),
    migrate: () => require('../lib/migrate').command(args),
    'codex-hook': () => require('../lib/codex-hook').command(args),
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
