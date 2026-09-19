'use strict';
// Decisions recorded in session, and the strong-reader pass over the backlog. Synthetic data only;
// the "Claude API" here is a local HTTP stub, so nothing is ever sent or billed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

process.env.TOTAL_RECALL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-dec-home-'));

const { openStore } = require('../lib/store');
const { loadConfig } = require('../lib/config');
const ingest = require('../lib/ingest');
const search = require('../lib/search');
const brief = require('../lib/brief');
const distill = require('../lib/distill');
const decide = require('../lib/decide');
const link = require('../lib/link');
const mcp = require('../lib/mcp');
const { makeSession } = require('./fixtures/make-session');
const cx = require('./fixtures/make-codex-session');

const DAY = '2026-09-10';
const NOW = `${DAY}T11:00:00.000Z`; // the fixture's turns run 10:00 - 10:17 that day
function project(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-dec-'));
  const proj = path.join(root, 'work', 'demo-project');
  const claudeDir = path.join(root, 'claude'), codexDir = path.join(root, 'codex', 'sessions');
  for (const d of [proj, claudeDir, codexDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(proj, 'total_recall.json'), JSON.stringify({ project: 'demo', store: path.join(root, 's.sqlite'),
    transcriptSources: [{ client: 'claude', path: claudeDir }, { client: 'codex', path: codexDir }],
    ollama: { url: '', model: 'stub', chunkTokens: 6000 }, ...extra }));
  return { root, proj, claudeDir, codexDir, cfg: loadConfig(proj) };
}
const find = async (cfg, store, flags, q) => (await search.answerFull(cfg, store, search.optsFrom({ words: true, ...flags }, q).opts, null, 'claude')).text;
const rec = (store, cfg, over) => decide.record(store, cfg, { client: 'claude', outcome: 'approved', scope: 'the invoice rounding', now: NOW, ...over });

test('decide: what is refused before anything is stored', () => {
  const ok = { client: 'claude', outcome: 'approved', statement: 'Owner approved moving the rounding after the add', scope: 'the invoice rounding', quote: 'approved, do it' };
  assert.ok(decide.check(ok).ok);
  assert.match(decide.check({ ...ok, quote: 'should we round after the add?' }).error, /a question is not a decision/);
  assert.match(decide.check({ ...ok, statement: 'approved, do it' }).error, /identify the thing that was approved/);
  assert.match(decide.check({ ...ok, statement: '' }).error, /WHAT was decided/);
  assert.match(decide.check({ ...ok, scope: '' }).error, /what it covers/);
  assert.match(decide.check({ ...ok, outcome: 'completed' }).error, /outcome must be one of/);
  assert.match(decide.check({ ...ok, client: 'gpt' }).error, /which assistant/);
  // An instruction for one task, offered as a permanent rule, is kept but never promoted.
  const oneTask = decide.check({ ...ok, outcome: 'standing', quote: 'remove the banner from the invoice page' }).ok;
  assert.equal(oneTask.certainty, 'unclear'); assert.match(oneTask.note, /not shown as a standing rule/);
  assert.equal(decide.check({ ...ok, outcome: 'standing', quote: 'Never ship the invoice total rounding change again' }).ok.certainty, 'clear');
  assert.equal(decide.containsPhrase('please google it', 'go'), false, '"go" is not inside "google"');
  assert.equal(decide.containsPhrase('ok, go.', 'go'), true);
});

test('decide: a record is linked to the owner\'s real turn and the proposal it answered; the words stay the record', async () => {
  const p = project();
  makeSession(path.join(p.claudeDir, 'fix-session-1.jsonl'), { day: DAY });
  const store = openStore(p.cfg.store);
  ingest.run(p.cfg, { mode: 'new' }, store);
  const turns = store.turnsForSession('fix-session-1');
  const owner = turns.find((t) => t.body === 'approved, do it');
  const proposal = turns.find((t) => /I propose rounding after it/.test(t.body));

  const r = rec(store, p.cfg, { quote: 'approved, do it', statement: 'Owner approved moving the rounding to after the invoice add' });
  assert.equal(r.status, 'active');
  assert.deepEqual(r.evidence, [proposal.id, owner.id], 'the proposal AND the owner\'s message, both real turn ids');
  const d = store.getDoc(r.id);
  assert.deepEqual([d.session_id, d.ts, d.who, d.path, d.adapter, d.origin], ['fix-session-1', owner.ts, 'owner', 'decide:claude', 'decide/claude', 'decision']);
  assert.equal(rec(store, p.cfg, { quote: 'approved, do it', statement: 'Owner approved moving the rounding to after the invoice add' }).duplicate, true, 'the handoff collecting it again adds nothing');
  assert.equal(store.decisions({}).length, 1);

  const out = await find(p.cfg, store, { deep: true }, 'rounding invoice add');
  assert.match(out, new RegExp(`#${r.id} statement ${DAY} fix-sess \\[owner approved\\] recorded in session by claude`));
  assert.match(out, /owner said: "approved, do it"\n\s+reading: Owner approved moving the rounding to after the invoice add \(scope: the invoice rounding\)/);
  assert.match(out, /deep for[\s\S]*I propose rounding after it[\s\S]*approved, do it/, 'the supporting exchange is one --deep away, unchanged');
  assert.equal(turns.length, store.turnsForSession('fix-session-1').length, 'recording a decision changes no original turn');
  assert.match(decide.listing(store, { since: DAY }), new RegExp(`- #${r.id} \\[owner approved\\] ${DAY} recorded by claude\\n  owner said: "approved, do it"\\n  claude's reading: .*\\n  evidence: T${proposal.id}, T${owner.id}`));

  // A real rule, in words that say so, reaches the brief. A one-task instruction offered as a rule does not.
  const rule = rec(store, p.cfg, { outcome: 'standing', quote: 'Never ship the invoice total rounding change again', statement: 'Never ship the invoice rounding change again', scope: 'all future work', reason: 'it broke three orders' });
  const notRule = rec(store, p.cfg, { outcome: 'standing', quote: 'the invoice total result looks off by one percent', statement: 'Invoice totals must always be checked for a one percent error', scope: 'all future work' });
  assert.equal(rule.status, 'active'); assert.equal(store.getDoc(notRule.id).origin, 'decision-unclear');
  const b = brief.buildBrief(store, p.cfg, new Set()).join('\n');
  assert.match(b, /RULE owner: Never ship the invoice rounding change again/);
  assert.ok(!/RULE owner: Invoice totals must always/.test(b), 'doubt is kept, not turned into a standing rule');
  assert.match(b, /not fresh permission to spend, publish or deploy/);
  assert.match(await find(p.cfg, store, {}, 'one percent error'), /\[owner standing UNCLEAR\]/);
  store.close();
});

test('decide: no invented ids. Words not yet ingested stay pending, are linked by the next ingest, and words never said are never active', () => {
  const p = project();
  const store = openStore(p.cfg.store);
  const early = rec(store, p.cfg, { quote: 'approved, do it', statement: 'Owner approved moving the rounding to after the invoice add' });
  assert.equal(early.status, 'pending'); assert.deepEqual(early.evidence, []);
  assert.equal(store.getDoc(early.id).evidence_ids, '[]');
  assert.equal(store.search('"rounding"', { kinds: ['statement'] }).length, 0, 'a pending record is in no search');
  const never = rec(store, p.cfg, { quote: 'ship it to every customer tonight', statement: 'Owner approved a release to all customers', scope: 'the release' });

  makeSession(path.join(p.claudeDir, 'fix-session-1.jsonl'), { day: DAY });
  let r = ingest.run(p.cfg, { mode: 'new' }, store);
  assert.deepEqual(r.decisions, { linked: 1, waiting: 1, unverified: 0 });
  assert.equal(store.getDoc(early.id).status, 'active');
  assert.equal(JSON.parse(store.getDoc(early.id).evidence_ids).length, 2);
  // Once the conversation around that moment is in the store and the words are not in it: unverified, for good.
  makeSession(path.join(p.claudeDir, 'later.jsonl'), { sessionId: 'later', day: '2026-09-11' });
  r = ingest.run(p.cfg, { mode: 'new' }, store);
  assert.equal(r.decisions.unverified, 1);
  assert.equal(store.getDoc(never.id).status, 'unverified');
  assert.match(decide.listing(store, { since: DAY, pending: true }), new RegExp(`#${never.id} \\[owner approved\\] UNVERIFIED`));

  // A bare "go" with nothing before it approves nothing.
  const q = project();
  fs.writeFileSync(path.join(q.claudeDir, 's.jsonl'), JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: 'go' }, uuid: 'u1', timestamp: `${DAY}T10:00:00.000Z`, sessionId: 's' }) + '\n');
  const s2 = openStore(q.cfg.store);
  ingest.run(q.cfg, { mode: 'new' }, s2);
  const bare = rec(s2, q.cfg, { quote: 'go', statement: 'Owner approved starting the migration', scope: 'the migration' });
  assert.equal(bare.status, 'pending'); assert.match(bare.why, /needs the proposal it answered/);
  s2.close(); store.close();
});

test('decide: neither assistant retires an earlier instruction by its own say-so; a clear replacement is linked both ways and can be undone', async () => {
  const p = project();
  makeSession(path.join(p.claudeDir, 'fix-session-1.jsonl'), { day: DAY });
  const store = openStore(p.cfg.store);
  ingest.run(p.cfg, { mode: 'new' }, store);
  const old = rec(store, p.cfg, { outcome: 'standing', quote: 'Never ship the invoice total rounding change again', statement: 'Never ship the invoice rounding change', scope: 'all future work' });

  // Asserted with words the owner never said: stays pending, and the old rule is untouched.
  const fake = rec(store, p.cfg, { outcome: 'standing', quote: 'from now on always ship the rounding change', statement: 'Always ship the rounding change', scope: 'all future work', replaces: old.id });
  assert.equal(fake.status, 'pending');
  assert.equal(store.getDoc(old.id).superseded_by, null, 'writing "replaces" is not evidence');

  // Unclear: flagged as a conflict for the owner, nothing retired.
  const maybe = rec(store, p.cfg, { quote: 'approved, do it', statement: 'Owner may have allowed the rounding change after all', certainty: 'unclear', replaces: old.id });
  assert.equal(store.getDoc(old.id).superseded_by, null);
  assert.match(await find(p.cfg, store, {}, 'rounding change'), new RegExp(`CONFLICT with #${maybe.id} \\(owner to decide\\)`));
  assert.match(brief.buildBrief(store, p.cfg, new Set()).join('\n'), /RULE owner: Never ship the invoice rounding change/, 'still current while the clash is unsettled');

  // Explicit owner confirmation names the old record and the exact new instruction.
  fs.appendFileSync(path.join(p.claudeDir, 'fix-session-1.jsonl'), JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: `Replace decision #${old.id} with: from now on the rounding change always ships with a test` }, uuid: 'u-late', timestamp: `${DAY}T10:40:00.000Z`, sessionId: 'fix-session-1' }) + '\n');
  ingest.run(p.cfg, { mode: 'new' }, store);
  const neu = rec(store, p.cfg, { outcome: 'standing', quote: 'from now on the rounding change always ships with a test', statement: 'The rounding change always ships with a test', scope: 'all future work', replaces: old.id });
  assert.equal(neu.status, 'active');
  assert.equal(store.getDoc(old.id).superseded_by, neu.id);
  assert.equal(store.getDoc(old.id).status, 'active', 'replaced is not struck: the earlier record and its evidence stay');
  assert.match(await find(p.cfg, store, {}, '"Never ship the invoice rounding change"'), new RegExp(`REPLACED by #${neu.id}`));
  assert.ok(!/RULE owner: Never ship the invoice rounding change\b/.test(brief.buildBrief(store, p.cfg, new Set()).join('\n')));

  // The model-judged link pass redraws its own links and leaves the owner's alone.
  await link.run(p.cfg, store, { judge: async () => false });
  assert.equal(store.getDoc(old.id).superseded_by, neu.id);
  // Reversible, and nothing but the relation changes.
  assert.ok(store.removeRelations(old.id) >= 1);
  assert.equal(store.getDoc(old.id).superseded_by, null);
  assert.equal(store.getDoc(neu.id).status, 'active');
  store.close();
});

test('decide: Codex records against Codex conversations only, and the MCP tool reports what happened', async () => {
  const p = project();
  makeSession(path.join(p.claudeDir, 'c.jsonl'), { sessionId: 'c', day: DAY });
  cx.write(path.join(p.codexDir, cx.rolloutName(cx.THREAD, '', `${DAY}T10-00-00`)), { thread: cx.THREAD, cwd: p.proj, day: DAY, items: [
    { kind: 'assistant', id: 'msg_a', phase: 'final_answer', text: 'I can export the ledger as CSV or as a spreadsheet. I suggest CSV.' },
    { kind: 'user', id: 'msg_u', text: 'approved, do it' }] });
  const store = openStore(p.cfg.store);
  ingest.run(p.cfg, { mode: 'new' }, store);
  store.close();
  const call = (args) => mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall_decide', arguments: args } }, { root: p.proj, env: {}, client: 'codex' });
  const bad = await call({ client: 'codex', outcome: 'approved', what: 'x', scope: 's', quote: 'approved, do it' });
  assert.equal(bad.result.isError, true); assert.equal(bad.result.structuredContent.total_recall.ok, false);
  // Recorded "now": the fixture conversation is days old, so this one waits rather than grabbing a stale "approved".
  const waits = await call({ client: 'codex', outcome: 'approved', what: 'Owner approved exporting the ledger as CSV', scope: 'the ledger export', quote: 'approved, do it' });
  assert.equal(waits.result.structuredContent.total_recall.status, 'pending');
  const s = openStore(p.cfg.store);
  const r = decide.record(s, p.cfg, { client: 'codex', outcome: 'approved', statement: 'Owner approved the CSV export of the ledger', scope: 'the ledger export', quote: 'approved, do it', contextQuote: 'I suggest CSV', now: `${DAY}T15:00:00.000Z` }); // the Codex fixture's turns are at 14:00
  assert.equal(r.status, 'active');
  assert.equal(s.getDoc(r.id).session_id, `codex:${cx.THREAD}`, 'the same words in a Claude session are not Codex\'s evidence');
  assert.match(s.getDoc(s.getDoc(r.id).evidence_ids && JSON.parse(s.getDoc(r.id).evidence_ids)[0]).body, /I suggest CSV/);
  s.close();
});

// ---------------------------------------------------------------- the backlog pass

function stubClaude(reply, o = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ headers: req.headers, body });
      if (o.drop && o.drop(seen.length)) { req.socket.destroy(); return; } // sent, and the answer never arrives
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stop_reason: 'end_turn', usage: o.usage || { input_tokens: 1000, output_tokens: 200 }, content: [{ type: 'text', text: JSON.stringify(reply(body, seen.length)) }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/v1/messages`, seen, close: () => server.close() })));
}

test('backlog pass: a strong reader reads the conversation itself, with context; doubt is kept; a weaker extraction steps aside but is not erased; owner records and strikes are never overwritten; nothing is paid for twice', async () => {
  const p = project({ ollama: { url: '', model: 'stub', chunkTokens: 120 } }); // small slices, so there are several
  makeSession(path.join(p.claudeDir, 'fix-session-1.jsonl'), { day: DAY });
  const store = openStore(p.cfg.store);
  ingest.run(p.cfg, { mode: 'new' }, store);
  const turns = store.turnsForSession('fix-session-1').filter((t) => !t.body.startsWith('(tool-only'));
  const T = (re) => turns.find((t) => re.test(t.body));
  const approve = T(/^approved, do it$/), propose = T(/I propose rounding/), never = T(/^Never ship the invoice/), ask = T(/what about the refund calculator/), key = T(/api key/);

  // What the local 14B model once said about these turns: one mislabel, one fair line the owner struck, one in-session record.
  const weak = store.insertDoc({ project: 'demo', kind: 'statement', session_id: 'fix-session-1', source_client: 'claude', ts: ask.ts, path: 'distill:old', title: 'Owner approved the refund calculator pilot', body: 'x', who: 'owner', outcome: 'approved', evidence_ids: JSON.stringify([ask.id]), quote: 'is it still in pilot' });
  const struck = store.insertDoc({ project: 'demo', kind: 'statement', session_id: 'fix-session-1', source_client: 'claude', ts: key.ts, path: 'distill:old', title: 'Owner approved storing the key', body: 'x', who: 'owner', outcome: 'approved', evidence_ids: JSON.stringify([key.id]), quote: 'keep it private' });
  store.strike(struck.id, 'I never approved storing a key');
  const report = store.insertDoc({ project: 'demo', kind: 'statement', session_id: 'fix-session-1', source_client: 'claude', ts: ask.ts, path: 'distill:old', title: 'Claude reported the rounding was moved after the add', body: 'x', who: 'claude', outcome: 'completed', evidence_ids: JSON.stringify([T(/^Done\. Rounding now happens/).id]), quote: 'Rounding now happens after the invoice total is added' });
  const mine = decide.record(store, p.cfg, { client: 'claude', outcome: 'approved', statement: 'Owner approved moving the rounding after the add', scope: 'the invoice rounding', quote: 'approved, do it', now: NOW });

  const api = await stubClaude((body) => {
    const text = body.messages[0].content;
    const items = [];
    const has = (t) => text.includes(`[T${t.id}] owner:`) && text.indexOf(`[T${t.id}] owner:`) > text.indexOf('THE SLICE:');
    if (has(approve)) items.push({ turn: approve.id, outcome: 'approved', statement: 'Owner approved rounding after the invoice add', scope: 'the invoice rounding', quote: 'approved, do it', context_turn: propose.id, certainty: 'clear', reason: null },
      { turn: propose.id, outcome: 'approved', statement: 'Claude proposed it', scope: 'x', quote: 'I propose rounding after it', context_turn: null, certainty: 'clear', reason: null });
    if (has(key)) items.push({ turn: key.id, outcome: 'approved', statement: 'Owner approved keeping the key', scope: 'the key', quote: 'keep it private', context_turn: null, certainty: 'clear', reason: null });
    if (has(never)) items.push({ turn: never.id, outcome: 'standing', statement: 'Never ship the invoice rounding change again', scope: 'all future work', quote: 'Never ship the invoice total rounding change again', context_turn: null, certainty: 'clear', reason: 'it broke three orders' });
    return items.length ? { items } : { none: true };
  });
  const cfg = { ...p.cfg, distill: { provider: 'claude', model: 'claude-sonnet-5', url: api.url, effort: 'medium' } };
  const saved = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  try {
    const dry = await distill.run(cfg, { mode: 'session', session: 'fix-session-1' }, { kind: 'decisions', dry: true }, store);
    assert.ok(dry.planned >= 3); assert.equal(api.seen.length, 0, 'a dry run sends nothing');

    // A cap stops the run; what was finished is kept, and the next run pays only for the rest.
    // (One request can cost at most about $0.16 here: 16,000 reply tokens at $10 per million.)
    const capped = await distill.run(cfg, { mode: 'session', session: 'fix-session-1' }, { kind: 'decisions', supersedeWeaker: true, budget: { cap: 0.161, priceIn: 0.000001, priceOut: 10 } }, store);
    assert.equal(capped.capped, true); assert.equal(api.seen.length, 1);
    const rest = await distill.run(cfg, { mode: 'session', session: 'fix-session-1' }, { kind: 'decisions', supersedeWeaker: true }, store);
    assert.equal(rest.skipped, 1); assert.equal(api.seen.length, dry.planned, 'every slice was sent exactly once across both runs');
    const again = await distill.run(cfg, { mode: 'session', session: 'fix-session-1' }, { kind: 'decisions', supersedeWeaker: true }, store);
    assert.equal(again.sent, 0, 'finished work is never charged again');

    const first = api.seen[0];
    assert.equal(first.body.model, 'claude-sonnet-5');
    assert.equal(first.body.fallbacks, undefined); assert.equal(first.headers['anthropic-beta'], undefined, 'the fallback parameter is only sent to the tier it is documented for');
    assert.deepEqual(first.body.output_config, { effort: 'medium' });
    assert.ok(api.seen.some((s) => /CONTEXT \(earlier turns, for understanding only\):\n\[T\d+\]/.test(s.body.messages[0].content)), 'a later slice carries the turns before it');
    assert.ok(api.seen.every((s) => s.body.messages[0].content.includes('Find the OWNER\'S DECISIONS')), 'it reads the conversation, not the weaker model\'s lines');

    const sonnet = store.distilledStatements().filter((d) => d.adapter === 'distill/claude-sonnet-5');
    assert.deepEqual(sonnet.map((d) => [d.outcome, d.origin]).sort(), [['standing', 'decision']], 'the rule is stored; the approval already recorded in session is not doubled');
    assert.equal(store.getDoc(mine.id).status, 'active', 'the in-session record stands');
    assert.equal(store.getDoc(struck.id).status, 'struck', 'the owner\'s correction is not overwritten');
    assert.ok(!store.distilledStatements().some((d) => d.outcome === 'approved' && JSON.parse(d.evidence_ids).includes(key.id)), 'and the struck finding does not come back from a newer model');
    assert.deepEqual([store.getDoc(weak.id).status, store.getDoc(weak.id).title], ['superseded', 'Owner approved the refund calculator pilot'], 'the weaker extraction stepped aside and is still there to read');
    const drops = [capped, rest].flatMap((r) => r.dropReasons).join(' | ');
    assert.match(drops, /cited a claude turn/, 'an assistant turn is never an owner decision');
    assert.equal(store.getDoc(weak.id).superseded_by, null, 'the strong reader found no decision in that question, so nothing replaces the mislabel');
    assert.equal(store.getDoc(report.id).status, 'active', 'an assistant\'s report is a tier the owner-decision reader never writes, so it never steps aside');
    // What the validator holds any reader to, whatever it claims.
    const ts = '2026-09-10T10:00:00.000Z';
    const slice = [{ id: 1, role: 'assistant', body: 'Shall I add a cache now?', ts }, { id: 2, role: 'user', body: 'should we cache this? maybe later. yes', ts }, { id: 3, role: 'user', body: 'remove the banner from the invoice page', ts }];
    const v = (item, turns = slice, ctx = []) => distill.validateDecision({ scope: 's', statement: 'a statement long enough', ...item }, turns, ctx);
    assert.match(v({ turn: 2, outcome: 'approved', quote: 'should we cache this?' }).reason, /a question is not a decision/);
    assert.match(v({ turn: 2, outcome: 'completed', quote: 'maybe later' }).reason, /outcome=completed/);
    assert.deepEqual(v({ turn: 2, outcome: 'approved', quote: 'yes' }).statement.evidence, [1, 2], 'a short reply carries the proposal it answered');
    assert.match(v({ turn: 2, outcome: 'approved', quote: 'yes' }, [slice[1]], []).reason, /a short reply with no proposal before it/);
    assert.deepEqual(v({ turn: 2, outcome: 'approved', quote: 'yes' }, [slice[1]], [slice[0]]).statement.evidence, [1, 2], 'the proposal may sit in the CONTEXT turns');
    assert.equal(v({ turn: 3, outcome: 'standing', quote: 'remove the banner from the invoice page', certainty: 'clear' }).statement.certainty, 'unclear', 'one task is not a rule, whatever the reader says');
    assert.equal(v({ turn: 3, outcome: 'approved', quote: 'remove the banner from the invoice page', certainty: 'unclear' }).statement.certainty, 'unclear');
    assert.match(await find(cfg, store, {}, '"Never ship the invoice rounding change again"'), /\[owner standing\] extracted later by claude-sonnet-5\n\s+owner said: "Never ship the invoice total rounding change again"/);
  } finally { api.close(); if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; }
  store.close();

  // The command itself refuses to spend without a ceiling and the current prices.
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'total_recall.js'), 'distill', '--all', '--prompt', 'decisions', '--provider', 'claude', '--model', 'claude-sonnet-5'],
    { cwd: p.proj, encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-test-key', TOTAL_RECALL_ROOT: '' } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /needs --max-usd N and the CURRENT --price-in and --price-out.*nothing was sent/);
});

// ---------------------------------------------------------------- the owner's four reproductions (2026-09-18 review)

function convo(file, sid, startMin, pairs, day = DAY) {
  const pad = (n) => String(n).padStart(2, '0');
  fs.appendFileSync(file, pairs.map(([role, text], i) => JSON.stringify({ parentUuid: null, isSidechain: false, type: role, message: { role, content: text },
    uuid: `${sid}-${startMin + i}`, timestamp: `${day}T10:${pad(startMin + i)}:00.000Z`, sessionId: sid, cwd: 'C:\\proj' })).join('\n') + '\n');
}

test('review 1: an approval attaches to the conversation it was given in, or to none', () => {
  const p = project();
  convo(path.join(p.claudeDir, 'csv.jsonl'), 'csv', 10, [['assistant', 'I can export the ledger as CSV or as a spreadsheet. I suggest CSV.'], ['user', 'approved, do it']]);
  convo(path.join(p.claudeDir, 'reports.jsonl'), 'reports', 30, [['assistant', 'The old reports folder is large. Shall I delete the old reports?'], ['user', 'approved, do it']]); // the NEWER "approved"
  const store = openStore(p.cfg.store);
  ingest.run(p.cfg, { mode: 'new' }, store);
  const body = (id) => store.getDoc(id).body;
  const csv = { quote: 'approved, do it', scope: 'the ledger export' };

  const a = rec(store, p.cfg, { ...csv, statement: 'Owner approved exporting the ledger as CSV', contextQuote: 'I suggest CSV' });
  assert.equal(a.status, 'active');
  assert.equal(store.getDoc(a.id).session_id, 'csv', 'not the newer conversation that holds the same words');
  assert.match(body(a.evidence[0]), /I suggest CSV/); assert.ok(!/delete the old reports/.test(body(a.evidence[0])));

  // Context that is found nowhere: unresolved, never attached to whatever proposal sits before the words.
  const b = rec(store, p.cfg, { ...csv, statement: 'Owner approved exporting the ledger as a PDF', contextQuote: 'export the ledger as a PDF' });
  assert.equal(b.status, 'pending'); assert.deepEqual(b.evidence, []); assert.match(b.why, /not after the proposal given as context/);
  assert.deepEqual([store.getDoc(b.id).session_id, store.getDoc(b.id).evidence_ids], [null, '[]']);

  // No context and no known conversation, and the words were said in two: unresolved.
  const c = rec(store, p.cfg, { ...csv, statement: 'Owner approved the ledger export in some form' });
  assert.equal(c.status, 'pending'); assert.match(c.why, /said in 2 conversations/);

  // The host named the conversation: only that one is searched, whatever is newer elsewhere.
  const d = rec(store, p.cfg, { ...csv, statement: 'Owner approved the CSV export (bound to its conversation)', session: 'csv' });
  assert.deepEqual([d.status, store.getDoc(d.id).session_id], ['active', 'csv']);
  const e = rec(store, p.cfg, { ...csv, statement: 'Owner approved deleting the old reports', scope: 'the reports folder', session: 'csv', contextQuote: 'delete the old reports' });
  assert.equal(e.status, 'pending', 'that proposal is not in the bound conversation');
  // A later ingest does not quietly change any of this.
  ingest.run(p.cfg, { mode: 'new' }, store);
  assert.deepEqual([b, c, e].map((x) => store.getDoc(x.id).session_id), [null, null, null]);
  store.close();
});

test('review 2: a standing rule is never suppressed by an approval, an earlier message, or another subject, whatever the recorder labels it', async () => {
  const p = project();
  const file = path.join(p.claudeDir, 'pub.jsonl');
  convo(file, 'pub', 0, [['assistant', 'The draft article is ready. Shall I publish the draft to the site?'], ['user', 'approved, publish it'],
    ['assistant', 'Published.'], ['user', 'Never publish anything without my approval again.'], ['assistant', 'Understood.']]);
  const store = openStore(p.cfg.store);
  ingest.run(p.cfg, { mode: 'new' }, store);
  const rule = rec(store, p.cfg, { outcome: 'standing', quote: 'Never publish anything without my approval again', statement: 'Never publish without the owner approving it first', scope: 'all future work' });
  assert.equal(rule.status, 'active');
  const inBrief = () => /RULE owner: Never publish without the owner approving it first/.test(brief.buildBrief(store, p.cfg, new Set()).join('\n'));
  const untouched = () => { const d = store.getDoc(rule.id); assert.deepEqual([d.status, d.superseded_by], ['active', null]); assert.ok(inBrief(), 'the rule is still listed as standing'); };

  // The owner's reproduction: an OLDER "approved", labelled clear, offered as replacing the LATER rule.
  const older = rec(store, p.cfg, { quote: 'approved, publish it', statement: 'Owner approved publishing the draft article', scope: 'the draft article', replaces: rule.id });
  assert.equal(older.status, 'active'); assert.equal(older.relation.type, 'conflict'); assert.match(older.relation.why, /not said AFTER/);
  assert.match(older.note, new RegExp(`#${rule.id}: kept, flagged as a CONFLICT`)); untouched();

  convo(file, 'pub', 20, [['assistant', 'I can export the ledger as CSV. I suggest CSV.'], ['user', 'approved, export the ledger as CSV'],
    ['assistant', 'Exported.'], ['user', 'From now on always run the focused tests before a handback']]);
  ingest.run(p.cfg, { mode: 'new' }, store);
  // Later, but an approval of one thing does not repeal a rule.
  const later = rec(store, p.cfg, { quote: 'approved, export the ledger as CSV', statement: 'Owner approved the CSV export of the ledger', scope: 'the ledger export', replaces: rule.id });
  assert.equal(later.relation.type, 'conflict'); assert.match(later.relation.why, /does not repeal a rule/); untouched();
  // Later and a rule, but about something else.
  const other = rec(store, p.cfg, { outcome: 'standing', quote: 'From now on always run the focused tests before a handback', statement: 'Always run the focused tests before a handback', scope: 'all future work', replaces: rule.id });
  assert.equal(other.relation.type, 'conflict'); assert.match(other.relation.why, /not proof of replacement/); untouched();
  assert.match(await find(p.cfg, store, {}, '"Never publish without the owner"'), new RegExp(`CONFLICT with #${older.id}, #${later.id}, #${other.id} \\(owner to decide\\)`), 'the doubt is shown, nothing is retired');
  assert.ok(/RULE owner: Always run the focused tests/.test(brief.buildBrief(store, p.cfg, new Set()).join('\n')), 'both rules stand');
  store.close();
});

test('review 3: two decisions in one message are two records; the same decision twice is still one', async () => {
  const p = project();
  convo(path.join(p.claudeDir, 'paint.jsonl'), 'paint', 0, [['assistant', 'Which colours do you want for the header and the footer?'], ['user', 'Make the header blue. Make the footer green.']]);
  const store = openStore(p.cfg.store);
  ingest.run(p.cfg, { mode: 'new' }, store);
  const owner = store.turnsForSession('paint').find((t) => t.role === 'user');
  const blue = rec(store, p.cfg, { quote: 'Make the header blue', statement: 'Owner asked for a blue header', scope: 'the site header' });
  const green = rec(store, p.cfg, { quote: 'Make the footer green', statement: 'Owner asked for a green footer', scope: 'the site footer' });
  const live = (r) => { const d = store.getDoc(r.id); return [d.status, d.superseded_by, JSON.parse(d.evidence_ids).pop()]; };
  assert.deepEqual(live(blue), ['active', null, owner.id], 'recording the second instruction leaves the first alone');
  assert.deepEqual(live(green), ['active', null, owner.id]);
  // Genuine duplicates still collapse: the identical record, and the same words read a second way.
  assert.equal(rec(store, p.cfg, { quote: 'Make the header blue', statement: 'Owner asked for a blue header', scope: 'the site header' }).duplicate, true);
  const reworded = rec(store, p.cfg, { quote: 'Make the header blue', statement: 'The header is to be painted blue', scope: 'the site header' });
  assert.deepEqual([store.getDoc(blue.id).status, store.getDoc(blue.id).superseded_by], ['superseded', reworded.id]);
  assert.equal(store.getDoc(green.id).status, 'active');
  store.close();

  // The backlog reader is held to the same rule: two items on one turn are both stored, once.
  const q = project();
  convo(path.join(q.claudeDir, 'paint.jsonl'), 'paint', 0, [['assistant', 'Which colours do you want for the header and the footer?'], ['user', 'Make the header blue. Make the footer green.']]);
  const s2 = openStore(q.cfg.store);
  ingest.run(q.cfg, { mode: 'new' }, s2);
  const t = s2.turnsForSession('paint').find((x) => x.role === 'user');
  const item = (quote, what) => ({ turn: t.id, outcome: 'approved', statement: what, scope: 'the site', quote, context_turn: null, certainty: 'clear', reason: null });
  const api = await stubClaude(() => ({ items: [item('Make the header blue', 'Owner asked for a blue header'), item('Make the footer green', 'Owner asked for a green footer')] }));
  const cfg = { ...q.cfg, distill: { provider: 'claude', model: 'claude-sonnet-5', url: api.url } };
  const saved = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  try {
    await distill.run(cfg, { mode: 'session', session: 'paint' }, { kind: 'decisions' }, s2);
    await distill.run(cfg, { mode: 'session', session: 'paint' }, { kind: 'decisions', redo: true }, s2);
    assert.deepEqual(s2.distilledStatements().map((d) => d.quote).sort(), ['Make the footer green', 'Make the header blue']);
  } finally { api.close(); if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; }
  s2.close();
});

test('owner rule: questions are not decisions, even when the quote is cut short of its question mark; spent go-aheads are not asked for', () => {
  const q = 'could you add an html page directory please from the json maybe?';
  assert.equal(decide.partOfQuestion(q, 'add an html page directory please from the json'), true, 'the sentence it was cut from ends in "?"');
  assert.equal(decide.partOfQuestion('Make the header blue. Should the footer be green?', 'Make the header blue'), false);
  assert.equal(decide.partOfQuestion('could you add config.toml to the list?', 'add config'), true, 'a full stop inside a file name does not end the sentence');
  assert.equal(decide.partOfQuestion('yes commit both with skip ci push', 'yes commit both'), false);
  assert.equal(decide.partOfQuestion('do it\nwhy is that slow?', 'do it'), false, 'the next line is another sentence');
  // The backlog reader is held to it, whatever it claims.
  const ts = `${DAY}T10:00:00.000Z`;
  const turns = [{ id: 1, role: 'assistant', body: 'Done: the image library is built.', ts }, { id: 2, role: 'user', body: q, ts }];
  const v = distill.validateDecision({ turn: 2, outcome: 'approved', statement: 'Owner approved an HTML directory page', scope: 'the image library', quote: 'add an html page directory please from the json', context_turn: 1, certainty: 'clear' }, turns, []);
  assert.equal(v.ok, false); assert.match(v.reason, /part of a question/);
  // And so is an assistant recording in session.
  const p = project();
  convo(path.join(p.claudeDir, 'lib.jsonl'), 'lib', 0, [['assistant', 'Done: the image library is built.'], ['user', q]]);
  const store = openStore(p.cfg.store);
  ingest.run(p.cfg, { mode: 'new' }, store);
  const r = rec(store, p.cfg, { quote: 'add an html page directory please from the json', statement: 'Owner approved an HTML directory page for the library', scope: 'the image library' });
  assert.equal(r.status, 'pending'); assert.match(r.why, /part of a question/);
  store.close();
  // The reader's instructions say both rules, and its worked example shows them producing nothing.
  const prompt = distill.promptFor('claude', 'decisions').text;
  assert.match(prompt, /Never shorten a quote so that it loses its question mark/);
  assert.match(prompt, /spent permissions/);
  assert.match(prompt, /\[T9\] owner: commit and push 1331\n\[T10\] owner: could you also add a stats page maybe\?\nAnswer:/);
  assert.ok(!/"turn":(9|10)\b/.test(prompt), 'the worked answer holds no item for the push or the question');
});

test('review 4: the spending cap is a hard cap: a request that could pass it is not sent, and the stop is reported', async () => {
  const p = project({ ollama: { url: '', model: 'stub', chunkTokens: 120 } });
  makeSession(path.join(p.claudeDir, 'fix-session-1.jsonl'), { day: DAY });
  const saved = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  // Every simulated request costs the worst case: a full 16,000-token reply at $10 per million = $0.16.
  const prices = { priceIn: 0.000001, priceOut: 10 };
  const open = []; // every stub is closed in `finally`: a failed assertion must not leave a server holding the process open
  const fresh = async (o) => { const api = await stubClaude(() => ({ none: true }), { usage: { input_tokens: 1000, output_tokens: 16000 }, ...o }); open.push(api); return { api, cfg: { ...p.cfg, store: path.join(p.root, `s-${Math.random().toString(36).slice(2)}.sqlite`), distill: { provider: 'claude', model: 'claude-sonnet-5', url: api.url } } }; };
  const go = async (x, budget) => { const s = openStore(x.cfg.store); ingest.run(x.cfg, { mode: 'new' }, s); try { return await distill.run(x.cfg, { mode: 'session', session: 'fix-session-1' }, { kind: 'decisions', budget }, s); } finally { s.close(); } };
  try {
    // $0.40: two requests fit ($0.32). A third COULD reach $0.48, so it is not sent. (The old check sent it: $0.32 was "under the cap".)
    let x = await fresh();
    let r = await go(x, { cap: 0.40, ...prices });
    assert.ok(r.skipped === 0 && r.sent === 2, `sent ${r.sent}`); assert.equal(x.api.seen.length, 2);
    assert.ok(r.usd <= 0.40, `spent $${r.usd}`); assert.equal(r.capped, true);
    assert.match(r.capWhy, /stopped BEFORE the \$0\.4 cap: \$0\.32\d* spent, and the next request could cost up to \$0\.16/);
    x.api.close();
    // A cap too small for even one request: nothing is sent, and that is reported as the cap, not as success.
    x = await fresh(); r = await go(x, { cap: 0.10, ...prices });
    assert.deepEqual([r.sent, r.capped, x.api.seen.length, r.usd], [0, true, 0, 0]); x.api.close();
    // A request that was sent and whose cost never came back is counted at its worst case.
    x = await fresh({ drop: (n) => n === 1 }); r = await go(x, { cap: 0.20, ...prices });
    assert.equal(x.api.seen.length, 1, 'no second request on top of an unknown charge'); assert.equal(r.capped, true); assert.ok(r.usd > 0.15 && r.usd <= 0.20);
    x.api.close();
    // A budget without prices is refused outright.
    x = await fresh();
    await assert.rejects(go(x, { cap: 5 }), /a budget needs cap, priceIn and priceOut/); assert.equal(x.api.seen.length, 0);
  } finally { for (const a of open) a.close(); if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; }
});
