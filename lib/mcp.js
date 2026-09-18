'use strict';
const readline = require('node:readline');
const { loadConfig, noConfigMessage } = require('./config');
const { openStore } = require('./store');
const { resolveSessionId } = require('./session');
const search = require('./search');
const brief = require('./brief');

// A Model Context Protocol server over stdio, by hand: JSON-RPC 2.0, one message per line. This
// repo has no dependencies and the protocol surface a tool server needs is five methods.
// Read-only on purpose: ingest and distill cost time or money and stay on the command line.

const TOOLS = [
  {
    name: 'recall_search',
    description: 'Search the record of every earlier Claude Code session in this project: distilled decisions (who said it, what happened to it, the exact quote), handoffs, memory files, project map sections, and the raw conversation turns behind them. Use before the first edit of a session, whenever the owner names a feature or file, and for any "what did we decide / who said / when did we first / what did I reject" question. Hits marked STRUCK were replaced by a later decision; hits marked ~meaning matched by sense, not by words.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for. Put an exact phrase in double quotes.' },
        kind: { type: 'string', description: 'Omit for the distilled tier (decisions, handoffs, memory, map sections). "all" adds raw conversation turns and the changelog; "turn" is raw turns only; or a comma list of kinds.' },
        who: { type: 'string', enum: ['owner', 'claude'], description: 'Only statements made by this speaker.' },
        outcome: { type: 'string', description: 'Comma list of: approved, rejected, standing, completed, open, proposed, superseded.' },
        files: { type: 'string', description: 'Only turns that touched a matching path, e.g. "src/tax-math*".' },
        since: { type: 'string', description: 'On or after this date: YYYY-MM-DD, YYYY-MM or YYYY.' },
        until: { type: 'string', description: 'On or before this date; a bare month or year covers all of it.' },
        on: { type: 'string', description: 'Exactly this day, month or year.' },
        order: { type: 'string', enum: ['relevance', 'oldest', 'newest'], description: '"oldest" answers "when did we first discuss X", "newest" the latest word on X; both need every query word to match. Use with kind "all".' },
        deep: { type: 'boolean', description: 'Also print the conversation turns each hit cites, with a neighbour on each side.' },
        tools: { type: 'boolean', description: 'Include tool-only turns (a file path and nothing else). Off by default.' },
        words: { type: 'boolean', description: 'Match on words only; skip the meaning lane.' },
        include_superseded: { type: 'boolean', description: 'Also return rows a newer version of the same note replaced.' },
        limit: { type: 'integer', description: 'Number of hits, default 12.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'recall_brief',
    description: 'The session brief: the owner\'s standing rules, then what the last few sessions decided, rejected and left open.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, a, ctx) {
  const cfg = loadConfig(ctx.root);
  if (!cfg) return { text: noConfigMessage(ctx.root), isError: true };
  const store = openStore(cfg.store); // opened per call: a long-lived server must not sit on the store while ingest or distill write
  try {
    if (name === 'recall_brief') return { text: brief.buildBrief(store, cfg, brief.recentFiles(cfg.root)).join('\n') };
    if (name === 'recall_search') {
      const query = typeof a.query === 'string' ? a.query.trim() : '';
      if (!query) return { text: 'recall_search: give a query', isError: true };
      const { opts, error } = search.optsFrom({ ...a, 'include-superseded': a.include_superseded }, query);
      if (error) return { text: `recall_search: ${error}`, isError: true };
      const sid = resolveSessionId({ payload: null, flags: {}, env: ctx.env });
      const text = await search.answer(cfg, store, opts, sid);
      return { text: sid ? text : `${text}(no session id reached this server, so the edit gate was not opened; run the command-line search once if an edit is blocked)\n` };
    }
    return { text: `unknown tool "${name}"`, isError: true };
  } finally { store.close(); }
}

async function handle(msg, ctx) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return null;
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const isRequest = msg.id !== undefined && msg.id !== null;
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: (msg.params && typeof msg.params.protocolVersion === 'string') ? msg.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'total_recall', version: require('../package.json').version },
      });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const p = msg.params || {};
      try {
        const r = await callTool(p.name, p.arguments || {}, ctx);
        return reply({ content: [{ type: 'text', text: r.text }], isError: !!r.isError });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `total_recall: ${e && e.message ? e.message : e}` }], isError: true });
      }
    }
    default:
      // Notifications (no id) are never answered; an unknown request is refused, not ignored.
      return isRequest ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } } : null;
  }
}

function command(args) {
  const ctx = { root: typeof args.flags.root === 'string' ? args.flags.root : process.cwd(), env: process.env };
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let chain = Promise.resolve(); // answers leave in the order the questions arrived
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); return; }
    chain = chain.then(() => handle(msg, ctx)).then((res) => { if (res) process.stdout.write(JSON.stringify(res) + '\n'); });
  });
  return new Promise((resolve) => rl.on('close', () => chain.then(() => resolve(0))));
}

module.exports = { TOOLS, callTool, handle, command };
