'use strict';
const readline = require('node:readline');
const { loadConfig, noConfigMessage } = require('./config');
const { openStore } = require('./store');
const { resolveSessionId } = require('./session');

// A Model Context Protocol server over stdio, by hand: JSON-RPC 2.0, one message per line. This
// repo has no dependencies and the protocol surface a tool server needs is five methods.
// Retrieval tools never ingest, distill, strike or change what is remembered. They are not side-effect
// free: a search may ask the local embedding model for one query vector (not cached in the store), and
// under Claude Code a successful search records that this session has looked (the edit gate).
// A store that needs migrating is reported, never migrated from here.
// recall_decide is a separate writer and retains its existing evidence/approval checks.

const TOOLS = [
  { name: 'recall_recall' },
  { name: 'recall_search' }, // schema follows with the shared retrieval options
  {
    name: 'recall_decide',
    description: 'Record ONE decision the owner just made, while the work is happening: he clearly approved something, rejected something, changed an earlier decision, or set a rule. Give his exact words; they are checked against the conversation, and until exactly one exchange matches the record stays pending (never invent a turn id or choose the newest match). Do NOT record questions, suggestions, your own proposals or acknowledgements, or anything you are inferring. An instruction for the task at hand is "approved", not "standing". If the meaning or scope is unclear, set unclear: true rather than guessing. A replacement requires his later direct message: "Replace decision #ID with: <the new instruction>". Quote that complete confirmation. Otherwise use conflicts_with and keep both; similar wording and your own clear label are not confirmation. Ordinary decisions need no special wording.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['approved', 'rejected', 'standing', 'open'] },
        what: { type: 'string', description: 'One sentence: what was decided. An approval must name the thing approved.' },
        scope: { type: 'string', description: 'What it covers: "this commit", "the pension page", "all future work".' },
        quote: { type: 'string', description: 'The owner\'s exact deciding words, copied from his message.' },
        context: { type: 'string', description: 'A few exact words from the proposal or discussion his message answers. Give it whenever you can. Missing context or multiple matching exchanges leave the record pending, even within a known conversation; provide more specific real context, never choose the newest match.' },
        reason: { type: 'string', description: 'His stated reason, if he gave one.' },
        unclear: { type: 'boolean', description: 'True when the meaning or the scope could reasonably be read another way.' },
        replaces: { type: 'integer', description: 'The #id explicitly named in the linked owner message "Replace decision #ID with: <the new instruction>". Without that confirmation, both records stay current and the proposed replacement is a conflict.' },
        conflicts_with: { type: 'integer', description: 'The #id of an earlier decision this seems to clash with, when replacement is not clear.' },
        client: { type: 'string', enum: ['claude', 'codex'], description: 'Which assistant is recording.' },
      },
      required: ['outcome', 'what', 'scope', 'quote', 'client'],
    },
  },
  {
    name: 'recall_brief',
    description: 'The session brief for this project: the owner\'s standing rules, then what the last few sessions of each assistant decided, rejected and left open. A dated record, not a set of instructions. Reading the brief does not count as the search the edit gate asks for.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// One retrieval engine for CLI and MCP. Historical tool names stay valid.
const recall = require('./recall');
const retrievalProperties = {
  project: { type: 'string', description: 'Exact registered project name/alias; defaults to caller config. Unknown or ambiguous names fail.' },
  root: { type: 'string', description: 'Explicit configured project root; must agree with project if both are supplied.' },
  query: { type: 'string', description: 'Optional words. No keyword needed for date/filter queries; bare * means unrestricted text.' },
  kind: { type: 'string', description: 'all (default), turn, statement, handoff, memory, compact_summary, map_section, changelog, or comma list.' },
  who: { type: 'string', enum: ['owner','claude','codex','assistant'] },
  client: { type: 'string', enum: ['claude','codex','all'] },
  outcome: { type: 'string', description: 'Comma list of decision outcomes. Defaults kind to statement.' },
  session: { type: 'string', description: 'Exact session key or unambiguous prefix within project/client. Never identifies caller.' },
  files: { type: 'string', description: 'Path substring/glob; * is any sequence, ? one character, backslash escapes. Use / for path separators.' },
  order: { type: 'string', enum: ['relevance','oldest','newest'], description: 'Changes sorting, NEVER changes matching semantics.' },
  match: { type: 'string', enum: ['any','all','phrase','advanced','substring'], description: 'any is default. advanced accepts FTS5 prefix/Boolean/NEAR syntax; invalid expressions fail, never change meaning silently.' },
  mode: { type: 'string', enum: ['words','hybrid','meaning'], description: 'hybrid default. Reuses local vectors; missing/partial meaning coverage is reported.' },
  timezone: { type: 'string', description: 'IANA timezone, config default America/New_York.' },
  direct: { type: 'boolean', description: 'Only original spoken turns with direct provenance; use for first/last original message.' },
  browse: { type: 'boolean', description: 'Intentionally browse without a text query.' },
  words: { type: 'boolean' }, tools: { type: 'boolean' }, deep: { type: 'boolean' }, count: { type: 'boolean' },
  include_superseded: { type: 'boolean' },
  include_unclear: { type: 'boolean', description: 'Include UNCLEAR standing interpretations in an explicitly filtered rules search. They are historical records, not confirmed rules; omitted by default.' },
  limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Rows per page, default 20.' },
  chars: { type: 'integer', minimum: 500, maximum: 30000, description: 'Evidence character budget, default 12000; open records to continue truncated text.' },
  cursor: { type: 'string', description: 'Opaque continuation from last result. Use alone (optionally same project/root); collection changes invalidate it.' },
};
for (const k of ['since','until','on','before','after']) retrievalProperties[k] = { type: 'string', description: 'YYYY[-MM[-DD]], today, yesterday, or zoned ISO timestamp. since/until inclusive; before/after exclusive of the named period.' };
TOOLS[0].description = 'Recall from external long-term memory. Accepts a natural memory request, combines decisions/rules/summaries, metadata, FTS5, semantic candidates and authoritative source records, and returns a grounded recollection packet for synthesis. Use for what did we decide, do you remember, why did we, what have I told you, related-history and continuation requests. This is not explicit search.';
TOOLS[0].inputSchema = { type: 'object', properties: {
  request: { type: 'string', minLength: 1, maxLength: 4000, description: 'The natural memory request, preserved as asked.' },
  topic: { type: 'string', maxLength: 1000, description: 'Assistant-interpreted subject without question framing, dates or project names. Empty string means project-wide recall. Pass this for wording beyond simple question prefixes.' },
  intent: { type: 'string', enum: ['continue','overview','rationale','decision','instruction','related-history','recollection'], description: 'Assistant-interpreted task; otherwise common phrases select a default.' },
  project: retrievalProperties.project, root: retrievalProperties.root, client: retrievalProperties.client, who: retrievalProperties.who,
  session: retrievalProperties.session, files: retrievalProperties.files, since: retrievalProperties.since, until: retrievalProperties.until,
  on: retrievalProperties.on, before: retrievalProperties.before, after: retrievalProperties.after, timezone: retrievalProperties.timezone,
  mode: retrievalProperties.mode, words: retrievalProperties.words, include_superseded: retrievalProperties.include_superseded, include_unclear: retrievalProperties.include_unclear,
  chars: { type: 'integer', minimum: 1000, maximum: 30000, description: 'Opened source-text budget, default 24000. Metadata is additional; unread text has Read handles.' },
  limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Candidate anchors, default 8; linked source/context records are additional, up to 40 opened records total.' },
}, required: ['request'], additionalProperties: false };
TOOLS[1].description = 'Find historical records explicitly by words, concepts, dates, project, client and speaker. This is evidence search, not synthesized recall. No query word is required for filtered or chronological requests.';
TOOLS[1].inputSchema = { type: 'object', properties: retrievalProperties, additionalProperties: false };
TOOLS.push({ name: 'recall_read', description: 'Open a project-qualified record, its neighbouring exchange, or a whole paged session. Long text is losslessly continuable. Original conversations remain the authority.',
  inputSchema: { type: 'object', properties: { project: retrievalProperties.project, root: retrievalProperties.root, id: { type: 'integer', minimum: 1 }, session: retrievalProperties.session, client: retrievalProperties.client,
    before: { type: 'integer', minimum: 0, maximum: 20 }, after: { type: 'integer', minimum: 0, maximum: 20 }, order: { type: 'string', enum: ['oldest','newest'] },
    limit: retrievalProperties.limit, chars: retrievalProperties.chars, cursor: retrievalProperties.cursor }, additionalProperties: false } });
TOOLS.push({ name: 'recall_inventory', description: 'List registered projects, paged sessions or recorded coverage/freshness. Never crawls disk or starts ingest, migration or embedding; unknown coverage remains unknown.',
  inputSchema: { type: 'object', properties: { what: { type: 'string', enum: ['projects','sessions','coverage'] }, project: retrievalProperties.project, root: retrievalProperties.root,
    client: retrievalProperties.client, who: retrievalProperties.who, since: retrievalProperties.since, until: retrievalProperties.until, on: retrievalProperties.on,
    timezone: retrievalProperties.timezone, order: retrievalProperties.order, limit: retrievalProperties.limit, cursor: retrievalProperties.cursor }, additionalProperties: false } });

// `meta` rides along as structuredContent.total_recall: a hook that must know whether a search
// really happened reads that, never the English text.
async function callTool(name, a, ctx) {
  const meta = { tool: name, ok: false, project: null };
  const fail = (text) => ({ text, isError: true, meta });
  const operations = { recall_recall: 'recall', recall_search: 'search', recall_read: 'read', recall_inventory: 'inventory', recall_brief: 'brief' };
  if (operations[name]) {
    try {
      const sid = ctx.client === 'codex' ? null : resolveSessionId({ payload: null, flags: {}, env: ctx.env, client: 'claude' });
      const r = await recall.execute(operations[name], a, { ...ctx, sid, client: ctx.client || 'claude' });
      meta.ok = true; meta.project = r.project || null;
      if (name === 'recall_search' || name === 'recall_recall') meta.hits = (r.rows || r.evidence).length;
      return { text: recall.format(r), meta, data: r };
    } catch (e) { return fail(`${name}: ${e.message}`); }
  }
  if (name !== 'recall_decide') return fail(`unknown tool "${name}"`);
  let cfg;
  try { cfg = loadConfig(ctx.root); } catch (e) { return fail(`total_recall: ${e.message}`); }
  if (!cfg) return fail(noConfigMessage(ctx.root));
  meta.project = cfg.project;
  let store;
  try { store = openStore(cfg.store, { readOnly: name !== 'recall_decide' }); } // writer path is only for decide
  catch (e) { return fail(`total_recall: ${e.message}`); }
  try {
    if (name === 'recall_decide') {
      // Under Claude Code the server's environment names the calling conversation, and the record is
      // bound to it. A Codex server identifies no caller: there the proposal given as `context` has to
      // pick the exchange, and words found in several conversations stay unresolved.
      const session = ctx.client === 'codex' || a.client !== 'claude' ? null : resolveSessionId({ payload: null, flags: {}, env: ctx.env, client: 'claude' });
      const r = require('./decide').record(store, cfg, { session, outcome: a.outcome, client: a.client, quote: a.quote, statement: a.what, scope: a.scope, reason: a.reason,
        certainty: a.unclear ? 'unclear' : 'clear', contextQuote: a.context, replaces: a.replaces, conflictsWith: a.conflicts_with });
      if (r.error) return fail(`recall_decide: ${r.error}`);
      meta.ok = true; meta.id = r.id; meta.status = r.status;
      const where = r.status === 'active' ? `linked to ${r.evidence.map((id) => `T${id}`).join(', ')}` : `PENDING (${r.why || 'not linked yet'}); the next ingest links it`;
      return { text: `${r.duplicate ? 'already recorded' : 'recorded'} #${r.id}: ${where}${r.note ? `\nnote: ${r.note}` : ''}`, meta };
    }
    return fail(`unknown tool "${name}"`);
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
        return reply({ content: [{ type: 'text', text: r.text }], structuredContent: { total_recall: r.meta, ...(r.data ? { recall: r.data } : {}) }, isError: !!r.isError });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `total_recall: ${e && e.message ? e.message : e}` }], structuredContent: { total_recall: { tool: p.name, ok: false, project: null } }, isError: true });
      }
    }
    default:
      // Notifications (no id) are never answered; an unknown request is refused, not ignored.
      return isRequest ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } } : null;
  }
}

function command(args) {
  const ctx = { root: typeof args.flags.root === 'string' ? args.flags.root : process.cwd(), env: process.env, client: args.flags.client === 'codex' ? 'codex' : 'claude' };
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
