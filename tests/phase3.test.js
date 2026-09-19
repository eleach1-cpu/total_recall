'use strict';
// Phase 3: Codex conversations beside Claude's. Everything here is synthetic: invented project,
// paths, ids and sentences. No model is called (an HTTP stub answers) and no vector is needed
// (`words: true`).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

process.env.TOTAL_RECALL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-p3-home-'));

const { openStore, SCHEMA_V1, SCHEMA_VERSION, sha256 } = require('../lib/store');
const { loadConfig, isUnder, mainCheckoutOf } = require('../lib/config');
const { bindSession } = require('../lib/bind');
const { readLines } = require('../lib/jsonl');
const ingest = require('../lib/ingest');
const search = require('../lib/search');
const distill = require('../lib/distill');
const brief = require('../lib/brief');
const gate = require('../lib/gate');
const mcp = require('../lib/mcp');
const hook = require('../lib/codex-hook');
const migrate = require('../lib/migrate');
const codexAdapter = require('../lib/adapters/codex');
const { makeSession } = require('./fixtures/make-session');
const cx = require('./fixtures/make-codex-session');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A project folder with a real total_recall.json, a Claude transcript folder and two Codex roots.
function project(extra = {}) {
  const root = tmp('tr-p3-');
  const proj = path.join(root, 'work', 'demo-project');
  const live = path.join(root, 'codex', 'sessions', '2026', '09', '12');
  const arch = path.join(root, 'codex', 'archived_sessions');
  const claudeDir = path.join(root, 'claude');
  for (const d of [proj, live, arch, claudeDir, path.join(proj, 'notes')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(proj, 'total_recall.json'), JSON.stringify({
    project: 'demo', store: path.join(root, 's.sqlite'),
    transcriptSources: [{ client: 'claude', path: claudeDir }, { client: 'codex', path: path.join(root, 'codex', 'sessions') }, { client: 'codex', path: arch }],
    sources: { handoff: ['notes/CLAUDE-HANDOFF-*.md', 'notes/CODEX-HANDOFF-*.md', 'notes/*-HANDOFF-*.md'] },
    ollama: { url: '', model: 'stub', chunkTokens: 6000 }, search: { rawRecentDays: 36500, rawRecentLimit: 5 }, ...extra,
  }));
  return { root, proj, live, arch, claudeDir, cfg: loadConfig(proj) };
}
const rootThread = (p, over = {}) => ({ thread: cx.THREAD, cwd: p.proj, items: cx.standardItems(), ...over });
const find = async (cfg, store, flags, query) => (await search.answerFull(cfg, store, search.optsFrom({ words: true, ...flags }, query).opts, null, 'claude')).text;

function stubOllama(replies) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const reply = replies.shift();
      if (reply === 'HTTP500') { res.writeHead(500); res.end('boom'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: reply }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}

// ---------------------------------------------------------------- configuration

test('config: the old shorthand is a Claude source; the new list names clients; ambiguity and unknown clients are refused', () => {
  const p = project();
  assert.deepEqual(p.cfg.transcriptSources.map((s) => [s.client, s.recursive]), [['claude', false], ['codex', true], ['codex', true]]);
  assert.equal(p.cfg.transcripts, p.claudeDir, 'callers written before there were two clients still find the Claude folder');
  assert.equal(p.cfg.sources.handoff.length, 3);
  assert.equal(p.cfg.distill.provider, 'ollama', 'a Codex INPUT never changes the model that reads the record');

  const old = tmp('tr-p3-old-');
  fs.writeFileSync(path.join(old, 'total_recall.json'), JSON.stringify({ project: 'demo', transcripts: 't' }));
  assert.deepEqual(loadConfig(old).transcriptSources, [{ client: 'claude', path: path.join(old, 't'), recursive: false }]);

  fs.writeFileSync(path.join(old, 'total_recall.json'), JSON.stringify({ project: 'demo', transcripts: 't', transcriptSources: [{ client: 'codex', path: 'c' }] }));
  assert.throws(() => loadConfig(old), /both "transcripts" and "transcriptSources"/);
  fs.writeFileSync(path.join(old, 'total_recall.json'), JSON.stringify({ project: 'demo', transcriptSources: [{ client: 'chatgpt', path: 'c' }] }));
  assert.throws(() => loadConfig(old), /unknown transcript client "chatgpt"/);
  fs.writeFileSync(path.join(old, 'total_recall.json'), JSON.stringify({ project: 'demo', transcriptSources: [{ client: 'codex', path: 'c' }, { client: 'codex', path: './c/' }] }));
  assert.equal(loadConfig(old).transcriptSources.length, 1, 'the same root typed two ways is read once');
});

// ---------------------------------------------------------------- project identity

test('project identity: checkout, subfolder, linked worktree, same-prefix folder, other repo, removed worktree, explicit inclusion', () => {
  const p = project({ projectRepos: ['https://example.test/acme/demo-project.git'] });
  const meta = (o) => ({ thread: 't1', cwd: null, repo: null, ...o });
  assert.equal(bindSession(meta({ cwd: p.proj }), p.cfg).bind, 'project');
  assert.equal(bindSession(meta({ cwd: path.join(p.proj, 'src') }), p.cfg).bind, 'project');
  assert.equal(bindSession(meta({ cwd: p.proj.toUpperCase().replace(/\\/g, '/') }), p.cfg).bind, process.platform === 'win32' ? 'project' : 'excluded');

  const copy = `${p.proj}-copy`; fs.mkdirSync(copy);
  assert.equal(isUnder(copy, p.proj), false, 'a directory boundary, not a string prefix');
  assert.equal(bindSession(meta({ cwd: copy }), p.cfg).bind, 'excluded');

  // A linked git worktree: a .git FILE pointing at <main>/.git/worktrees/<name>, whose commondir leads home.
  fs.mkdirSync(path.join(p.proj, '.git', 'worktrees', 'wt1'), { recursive: true });
  fs.writeFileSync(path.join(p.proj, '.git', 'worktrees', 'wt1', 'commondir'), '../..\n');
  const wt = path.join(p.root, 'codex', 'worktrees', 'ab12', 'demo-project'); fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(p.proj, '.git', 'worktrees', 'wt1')}\n`);
  assert.equal(path.resolve(mainCheckoutOf(wt)), path.resolve(p.proj));
  assert.deepEqual(bindSession(meta({ cwd: wt }), p.cfg), { bind: 'project', reason: 'a git worktree of a project root' });
  assert.equal(loadConfig(wt).root, p.proj, 'a worktree uses the main checkout\'s config, never a copy of its own');

  const gone = path.join(p.root, 'codex', 'worktrees', 'dead', 'demo-project');
  assert.equal(bindSession(meta({ cwd: gone }), p.cfg).bind, 'unresolved', 'a removed worktree is reported, not guessed');
  assert.equal(bindSession(meta({ cwd: gone, repo: 'https://example.test/acme/demo-project' }), p.cfg).bind, 'project', 'its recorded git remote settles it');
  assert.equal(bindSession(meta({ cwd: gone, repo: 'https://example.test/acme/other.git' }), p.cfg).bind, 'excluded');
  assert.equal(bindSession(meta({ cwd: gone }), { ...p.cfg, historicalRoots: [path.join(p.root, 'codex', 'worktrees', '*', 'demo-project')] }).bind, 'project');
  assert.equal(bindSession(meta({ cwd: path.join(p.root, 'codex', 'worktrees', 'dead', 'other-project') }), { ...p.cfg, historicalRoots: [path.join(p.root, 'codex', 'worktrees', '*', 'demo-project')] }).bind, 'unresolved');
  assert.equal(bindSession(meta({ cwd: copy, thread: 'chosen' }), { ...p.cfg, includeSessions: ['chosen'] }).bind, 'project', 'the owner may include a conversation by id');
});

// ---------------------------------------------------------------- the streaming reader

test('reader: UTF-8 split across buffers, CRLF, a partial last record, an append, an oversized line', () => {
  const file = path.join(tmp('tr-p3-jsonl-'), 'a.jsonl');
  const a = JSON.stringify({ n: 1, t: 'naïve — 測試 🙂' }), b = JSON.stringify({ n: 2, big: 'x'.repeat(5000) }), c = JSON.stringify({ n: 3 });
  fs.writeFileSync(file, `${a}\r\n${b}\r\n${c.slice(0, 4)}`);
  let got = [...readLines(file, { chunk: 7, maxLine: 1000 })];
  assert.equal(got.length, 2, 'the unfinished last record is not yielded');
  assert.deepEqual(JSON.parse(got[0].text), JSON.parse(a), 'a multi-byte character cut by a 7-byte buffer is decoded whole');
  assert.equal(got[1].oversized, true);
  assert.ok(got[1].head.length <= 2048 && got[1].bytes > 5000, 'an oversized line is measured, never buffered');
  const resume = got[1].end;
  fs.appendFileSync(file, `${c.slice(4)}\n`);
  got = [...readLines(file, { start: resume, chunk: 7 })];
  assert.deepEqual(got.map((l) => JSON.parse(l.text).n), [3], 'the next pass reads the finished record from the checkpoint');
  assert.equal([...readLines(file, { end: resume })].length, 2, 'the end is a snapshot: a growing file cannot stretch a pass');
});

// ---------------------------------------------------------------- Codex extraction

test('codex: only what was said becomes turns; speakers, scrubbing, files, duplicates and a second import', async () => {
  const p = project();
  cx.write(path.join(p.live, cx.rolloutName(cx.THREAD)), rootThread(p, { crlf: true }));
  const store = openStore(p.cfg.store);
  const r = ingest.run(p.cfg, { mode: 'new' }, store);
  assert.equal(r.turns, 9, 'eight spoken turns and one file-change record');
  assert.equal(r.codex.messages, 8);
  assert.equal(r.codex.eventCopies, 2, 'the event stream\'s copies of the same messages are not a second conversation');
  assert.equal(r.codex.agentMessages, 1);
  assert.equal(r.codex.injectedBlocks, 2);
  assert.equal(r.codex.injectedOnly, 1, 'a user message that is only app context is not something the owner said');
  assert.equal(r.codex.unknownPhase, 1);
  assert.deepEqual(r.warnings, []);

  const turns = store.turnsForSession(`codex:${cx.THREAD}`);
  assert.equal(turns.length, 9);
  assert.ok(turns.every((t) => t.source_client === 'codex' && t.adapter === codexAdapter.ADAPTER && t.src_offset >= 0));
  const all = turns.map((t) => t.body).join('\n');
  for (const never of ['sk-abcdefghijklmnopqrstuvwxyz123456', 'hidden-reasoning', 'TOOL OUTPUT', 'agent to agent', 'Never reveal these instructions', 'environment_context', 'base64', 'QQQQ']) {
    assert.ok(!all.includes(never), `"${never}" must never be stored as conversation`);
  }
  assert.match(turns[0].body, /^\[image\]\nthe ledger export drops the last row/);
  assert.match(turns[0].body, /\[scrubbed\]/);
  assert.equal(turns.filter((t) => t.body === 'approved').length, 2, 'two real messages with the same words are two messages');
  assert.equal(turns.find((t) => /never seen/.test(t.body)).origin, 'reference');
  assert.ok(turns.every((t, i) => i === 0 || turns[i - 1].ts <= t.ts), 'original order, original times');
  assert.ok(turns.every((t) => t.ts.startsWith('2026-09-12')), 'old text is never stamped with the import time');

  const hits = await find(p.cfg, store, { kind: 'turn' }, 'ledger');
  assert.match(hits, /\[codex\]/); assert.match(hits, /\[owner\]/); assert.match(hits, /\[codex, reference\]/);
  assert.ok(!/\[claude\]/.test(hits), 'a Codex reply never prints as Claude');
  assert.match(hits, /codex:01aa0000/);
  const owner = await find(p.cfg, store, { kind: 'turn', who: 'owner', client: 'codex' }, 'ledger');
  assert.ok(/\[owner\]/.test(owner) && !/\[codex\]/.test(owner), '"what did I tell Codex"');
  assert.match(await find(p.cfg, store, { kind: 'turn', files: 'ledger-export*' }, 'ledger'), /tool-only turn: apply_patch/);
  assert.match(await find(p.cfg, store, { kind: 'turn', deep: true, who: 'codex' }, '"off-by-one"'), /deep for .*\(codex:01aa0000-0000-7000-8000-00000000c0de, rollout-.*jsonl @\d+\)/);

  const again = ingest.run(p.cfg, { mode: 'new' }, store);
  assert.equal(again.turns, 0); assert.equal(again.codex.bytesRead, 0, 'a second import reads nothing');
  store.close();
});

test('codex: an archive move adds nothing and reads nothing; an append is picked up; a range import leaves the checkpoint alone', () => {
  const p = project();
  const name = cx.rolloutName(cx.THREAD);
  const items = cx.standardItems();
  const w = cx.write(path.join(p.live, name), rootThread(p, { items: items.slice(0, 10) }));
  const store = openStore(p.cfg.store);

  const ranged = ingest.run(p.cfg, { mode: 'range', since: '2030-01-01' }, store);
  assert.equal(ranged.turns, 0);
  assert.equal(store.getSource(path.join(p.live, name)), undefined, 'a selection is not progress');

  const first = ingest.run(p.cfg, { mode: 'new' }, store);
  const moved = path.join(p.arch, name);
  fs.renameSync(path.join(p.live, name), moved);
  const after = ingest.run(p.cfg, { mode: 'new' }, store);
  assert.equal(after.codex.moved, 1); assert.equal(after.turns, 0); assert.equal(after.codex.bytesRead, 0);
  assert.equal(store.turnsForSession(`codex:${cx.THREAD}`)[0].path, moved, 'the evidence now cites where the file lives');

  fs.writeFileSync(moved, cx.build(rootThread(p, { items })).join('\n') + '\n');
  assert.ok(fs.statSync(moved).size > w.size);
  const grown = ingest.run(p.cfg, { mode: 'new' }, store);
  assert.equal(first.turns + grown.turns, 9, 'only the appended records are read');
  assert.equal(grown.superseded, 0, 'an append is not a rewrite');
  fs.appendFileSync(moved, JSON.stringify({ timestamp: '2026-09-19T12:00:00Z', type: 'response_item', payload: { type: 'function_call_output', output: 'tool result only' } }) + '\n');
  const toolTail = ingest.run(p.cfg, { mode: 'new' }, store);
  assert.ok(toolTail.codex.bytesRead > 0);
  assert.equal(toolTail.codex.messages, 0);
  assert.deepEqual(toolTail.warnings, [], 'an incremental tool-only tail is not an unreadable conversation');
  store.close();
});

test('codex: a start-up budget stops early at a checkpoint and the next pass finishes without a duplicate', () => {
  const p = project();
  const items = [];
  for (let i = 0; i < 1500; i++) items.push({ kind: i % 2 ? 'assistant' : 'user', id: `msg_bulk_${i}`, phase: i % 2 ? 'final_answer' : undefined, text: `ledger note number ${i}` });
  cx.write(path.join(p.live, cx.rolloutName(cx.THREAD)), rootThread(p, { items }));
  const store = openStore(p.cfg.store);
  const r1 = ingest.run(p.cfg, { mode: 'new' }, store, { budgetMs: 1 });
  assert.equal(r1.pending, true, 'a cold archive is never imported inside a session start');
  assert.ok(r1.turns < 1500);
  let total = r1.turns;
  for (let i = 0; i < 50 && total < 1500; i++) total += ingest.run(p.cfg, { mode: 'new' }, store).turns;
  assert.equal(total, 1500);
  assert.equal(store.turnsForSession(`codex:${cx.THREAD}`).length, 1500);
  store.close();
});

test('codex: a crash mid-batch commits neither the rows nor the checkpoint', () => {
  const p = project();
  const file = path.join(p.live, cx.rolloutName(cx.THREAD));
  cx.write(file, rootThread(p));
  const store = openStore(p.cfg.store);
  const out = { turns: 0, skipped: 0, superseded: 0 };
  const real = store.insertDoc; let n = 0;
  store.insertDoc = (d) => { if (++n === 3) throw new Error('power cut'); return real(d); };
  assert.throws(() => ingest.streamFile(store, file, { start: 0, end: fs.statSync(file).size, maxLine: 1 << 20, track: true, out,
    onOversized() {}, toDocs: (rec) => (rec.type === 'response_item' && rec.payload.role === 'user' ? [{ project: 'demo', kind: 'turn', ts: rec.timestamp, title: 't', body: `b${rec.ordinal}` }] : []),
    checkpoint: (at) => store.setSource({ path: file, kind: 'codex', client: 'codex', size: 1, mtime: 'x', sha: '', offset: at, ingested_at: 'x' }) }), /power cut/);
  assert.equal(store.getSource(file), undefined, 'no checkpoint survives the failed transaction');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM docs').get().n, 0);
  store.close();
});

test('codex: malformed and oversized records are counted, an oversized MESSAGE is said, and an eligible corpus with no messages is a warning', () => {
  const p = project({ ingest: { maxLineMB: 1 } });
  const huge = JSON.stringify({ timestamp: cx.at('2026-09-12', 40), ordinal: 90, type: 'response_item', payload: { type: 'message', id: 'msg_huge', role: 'user', content: [{ type: 'input_text', text: 'z'.repeat(1100000) }] } });
  const blob = JSON.stringify({ timestamp: cx.at('2026-09-12', 41), ordinal: 91, type: 'response_item', payload: { type: 'function_call_output', id: 'fco_big', output: 'y'.repeat(1100000) } });
  cx.write(path.join(p.live, cx.rolloutName(cx.THREAD)), rootThread(p, { items: [...cx.standardItems(), { kind: 'text', text: '{"not json' }, { kind: 'text', text: huge }, { kind: 'text', text: blob }] }));
  const store = openStore(p.cfg.store);
  const r = ingest.run(p.cfg, { mode: 'new' }, store);
  assert.equal(r.codex.malformed, 1); assert.equal(r.codex.oversizedMessages, 1); assert.equal(r.codex.oversized, 1);
  assert.match(ingest.codexReport(r.codex).join('\n'), /1 OVERSIZED MESSAGES skipped \(conversation missing\)/);
  assert.ok(!ingest.codexReport(r.codex).join('\n').includes('zzzz'), 'a diagnostic never prints a private line');
  store.close();

  const q = project();
  cx.write(path.join(q.live, cx.rolloutName(cx.THREAD)), rootThread(q, { items: [{ kind: 'raw', type: 'conversation_v9', payload: { said: 'a format this parser does not know' } }] }));
  const s2 = openStore(q.cfg.store);
  assert.match(ingest.run(q.cfg, { mode: 'new' }, s2).warnings.join(' '), /NOT ONE conversation message was recognised/);
  s2.close();
});

test('codex: the owner\'s request survives the app\'s wrapper around it, and the wrapper never becomes his words (review fix 1)', () => {
  const p = project();
  const files = (name, heading, request, eol = '\n') => ['# Files mentioned by the user:', '', `## ${name}: C:/work/demo-project/private/${name}`, '', heading, request].join(eol);
  cx.write(path.join(p.live, cx.rolloutName(cx.THREAD)), rootThread(p, { items: [
    { kind: 'user', id: 'msg_f1', text: files('ledger.png', '## My request for Codex:', 'make the ledger header sticky, and never ship it without a screenshot') },
    { kind: 'user', id: 'msg_f2', text: files('notes.txt', '## My request:', 'approved, use the blue ledger header', '\r\n') },
    { kind: 'user', id: 'msg_f3', text: '# Files mentioned by the user:\n\n## only.txt: C:/work/demo-project/private/only.txt\n' },
    { kind: 'user', id: 'msg_b1', text: '<in-app-browser-context>\nURL: https://example.test/secret-page\nTitle: Ledger admin\n</in-app-browser-context>\nwhy is the ledger total red on this page?' },
    { kind: 'user', id: 'msg_b2', text: '<in-app-browser-context>\nURL: https://example.test/secret-page\n</in-app-browser-context>' },
    { kind: 'user', id: 'msg_h1', text: '<div class="total">12</div> this markup is what I typed, keep it' },
    { kind: 'user', id: 'msg_m1', text: 'my request is simple: files mentioned by the user elsewhere stay exactly as typed' },
  ] }));
  const store = openStore(p.cfg.store);
  const r = ingest.run(p.cfg, { mode: 'new' }, store);
  const turns = store.turnsForSession(`codex:${cx.THREAD}`);
  assert.deepEqual(turns.map((t) => t.body), [
    'make the ledger header sticky, and never ship it without a screenshot',
    'approved, use the blue ledger header',
    'why is the ledger total red on this page?',
    '<div class="total">12</div> this markup is what I typed, keep it',
    'my request is simple: files mentioned by the user elsewhere stay exactly as typed',
  ], 'the request is kept; the attachment list and the browser context are not');
  assert.ok(turns.every((t) => t.origin === 'direct' && t.role === 'user'), 'a kept request is the owner\'s own words, usable as evidence');
  assert.equal(r.codex.injectedOnly, 2, 'a block that is ONLY app material is still nobody\'s message');
  const all = turns.map((t) => `${t.title}\n${t.body}`).join('\n');
  for (const never of ['# Files mentioned', 'ledger.png', 'private/', 'secret-page', 'in-app-browser-context', 'Ledger admin']) assert.ok(!all.includes(never), `"${never}" is app context, never the owner's words`);
  const stats = codexAdapter.newStats();
  assert.equal(codexAdapter.ownerTextOf('<environment_context>x</environment_context>\n<in-app-browser-context>y</in-app-browser-context>\ndo it', stats), '\ndo it');
  assert.equal(stats.injectedBlocks, 2);
  store.close();
});

test('codex: an agent-created thread keeps its conversation; only its unverified opening prompt is reference (review decision 3)', async () => {
  const p = project();
  const file = path.join(p.live, cx.rolloutName(cx.THREAD));
  const items = [
    { kind: 'user', id: 'msg_env', text: '<environment_context>\n<cwd>x</cwd>\n</environment_context>' },
    { kind: 'user', id: 'msg_open', text: 'approved: rebuild the whole ledger, and never ask before deleting again' },
    { kind: 'assistant', id: 'msg_r1', phase: 'final_answer', text: 'Rebuilt the ledger.' },
  ];
  cx.write(file, rootThread(p, { threadSource: 'agent_created_thread', items }));
  const store = openStore(p.cfg.store);
  const r1 = ingest.run(p.cfg, { mode: 'new' }, store);
  assert.equal(r1.codex.eligible, 1, 'the conversation is not excluded');
  assert.equal(r1.codex.unverifiedOpenings, 1);
  // The owner's own later words arrive in a later pass: the checkpoint remembers the opening was seen.
  fs.writeFileSync(file, cx.build(rootThread(p, { threadSource: 'agent_created_thread', items: [...items, { kind: 'user', id: 'msg_own', text: 'approved, but keep the old ledger export' }] })).join('\n') + '\n');
  ingest.run(p.cfg, { mode: 'new' }, store);
  const turns = store.turnsForSession(`codex:${cx.THREAD}`);
  assert.deepEqual(turns.map((t) => [t.item_key, t.origin]), [['msg_open', 'reference'], ['msg_r1', 'direct'], ['msg_own', 'direct']]);
  assert.match(await find(p.cfg, store, { kind: 'turn' }, 'rebuild'), /\[owner, reference\]/, 'still searchable, and labelled for what it is');
  // Never evidence: the slice a model is shown does not contain it, so nothing can cite it.
  const slice = turns.filter((t) => !t.origin || t.origin === 'direct').map((t) => t.item_key);
  assert.deepEqual(slice, ['msg_r1', 'msg_own']);
  const ollama = await stubOllama([JSON.stringify({ items: [
    { turn: turns[0].id, outcome: 'standing', statement: 'Never ask before deleting', quote: 'never ask before deleting again', reason: null },
    { turn: turns[0].id, outcome: 'approved', statement: 'Owner approved rebuilding the ledger', quote: 'rebuild the whole ledger', reason: null },
    { turn: turns[2].id, outcome: 'approved', statement: 'Owner approved keeping the old ledger export', quote: 'keep the old ledger export', reason: null }] })]);
  try {
    const d = await distill.run({ ...p.cfg, ollama: { ...p.cfg.ollama, url: ollama.url } }, { mode: 'session', session: `codex:${cx.THREAD}` }, {}, store);
    assert.equal(d.stored, 1); assert.equal(d.dropped, 2);
    assert.deepEqual(store.distilledStatements().map((s) => s.title), ['Owner approved keeping the old ledger export']);
    assert.ok(!ollama.calls[0].prompt.includes('rebuild the whole ledger'), 'the unverified prompt is not even shown to the model');
  } finally { ollama.close(); }
  store.close();

  // A continuation file of such a thread never holds the opening: its first message is the owner's.
  const q = project();
  const base = cx.write(path.join(q.live, cx.rolloutName(cx.THREAD)), rootThread(q, { threadSource: 'agent_created_thread', items }));
  cx.write(path.join(q.live, cx.rolloutName(cx.THREAD, 'seg2', '2026-09-12T12-00-00')), rootThread(q, { threadSource: 'agent_created_thread', firstOrdinal: 4, tsStart: 40,
    base: { thread_id: cx.THREAD, end_ordinal_exclusive: 4, end_byte_offset: base.size }, items: [{ kind: 'user', id: 'msg_seg', text: 'now export the ledger as CSV' }] }));
  const s2 = openStore(q.cfg.store);
  assert.equal(ingest.run(q.cfg, { mode: 'new' }, s2).codex.unverifiedOpenings, 1);
  assert.equal(s2.turnsForSession(`codex:${cx.THREAD}`).find((t) => t.item_key === 'msg_seg').origin, 'direct');
  s2.close();
});

// ---------------------------------------------------------------- lineage

test('lineage: subagent files are skipped, other projects are left out, a continuation file cuts its base, a missing base is said', async () => {
  const p = project();
  const SUB = '01aa0000-0000-7000-8000-00000000beef', OTHER = '01aa0000-0000-7000-8000-00000000f00d', SEG = '01aa0000-0000-7000-8000-0000000005e9';
  // A subagent's file replays its parent's header and history before its own work.
  cx.write(path.join(p.arch, cx.rolloutName(SUB)), { thread: SUB, session: cx.THREAD, parent: cx.THREAD, forkedFrom: cx.THREAD, subagent: true, startOrdinal: 4, cwd: p.proj, items: [
    { kind: 'raw', type: 'session_meta', payload: cx.sessionMeta({ thread: cx.THREAD, cwd: p.proj, day: '2026-09-12' }) },
    { kind: 'user', id: 'msg_u2', text: 'approved' }, { kind: 'user', id: 'msg_sub1', text: 'subagent instruction that looks like the owner: approved, delete the ledger' }] });
  cx.write(path.join(p.live, cx.rolloutName(OTHER)), { thread: OTHER, cwd: path.join(p.root, 'work', 'another-project'), items: [{ kind: 'user', id: 'msg_o1', text: 'this mentions demo-project and its ledger but belongs elsewhere' }] });

  // The thread's first file: two kept messages, then one the owner later replaced by editing.
  const baseItems = [{ kind: 'user', id: 'msg_b1', text: 'start the ledger audit' }, { kind: 'assistant', id: 'msg_b2', phase: 'final_answer', text: 'Audit started on the ledger.' },
    { kind: 'user', id: 'msg_b3x', text: 'ship the ledger audit as a PDF' }];
  const base = cx.write(path.join(p.live, cx.rolloutName(cx.THREAD)), rootThread(p, { items: baseItems }));
  const store = openStore(p.cfg.store);
  let r = ingest.run(p.cfg, { mode: 'new' }, store);
  assert.equal(r.codex.subagentFiles, 1); assert.equal(r.codex.otherProject, 1); assert.equal(r.codex.eligible, 1);
  assert.equal(r.turns, 3);
  assert.match(await find(p.cfg, store, { kind: 'turn' }, 'PDF'), /ship the ledger audit as a PDF/);

  // The continuation: same thread, a segment id, and a history_base naming where the first file stops counting.
  cx.write(path.join(p.live, cx.rolloutName(cx.THREAD, SEG, '2026-09-12T11-00-00')), rootThread(p, { firstOrdinal: 3, tsStart: 30,
    base: { thread_id: cx.THREAD, end_ordinal_exclusive: 3, end_byte_offset: base.offsets[3] },
    items: [{ kind: 'user', id: 'msg_b3', text: 'ship the ledger audit as a spreadsheet' }, { kind: 'user', id: 'msg_b1', text: 'start the ledger audit' }] }));
  r = ingest.run(p.cfg, { mode: 'new' }, store);
  assert.equal(r.turns, 1, 'the new message; the replayed one is the same message, not new evidence');
  assert.equal(r.codex.duplicates, 1); assert.equal(r.codex.incompleteHistory, 0);
  const bodies = store.turnsForSession(`codex:${cx.THREAD}`).map((t) => t.body);
  assert.deepEqual(bodies, ['start the ledger audit', 'Audit started on the ledger.', 'ship the ledger audit as a spreadsheet'], 'one conversation, the replaced message gone, the segment under the same key');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM occurrences').get().n, 1, 'where else the replayed message was seen is kept');
  assert.ok(!/delete the ledger|belongs elsewhere/.test(await find(p.cfg, store, { kind: 'all' }, 'ledger')));
  store.close();

  // The same continuation with its first file absent: coverage is incomplete, and said.
  const q = project();
  cx.write(path.join(q.live, cx.rolloutName(cx.THREAD, SEG)), rootThread(q, { firstOrdinal: 3, base: { thread_id: cx.THREAD, end_ordinal_exclusive: 3, end_byte_offset: 999 },
    items: [{ kind: 'user', id: 'msg_b3', text: 'ship the ledger audit as a spreadsheet' }] }));
  const s2 = openStore(q.cfg.store);
  assert.equal(ingest.run(q.cfg, { mode: 'new' }, s2).codex.incompleteHistory, 1);
  assert.match(await find(q.cfg, s2, { kind: 'all', oldest: true }, 'ledger'), /missing their earlier history, so the earliest hit here may not be the first discussion/);
  s2.close();
});

test('lineage: a fork the USER made is kept, its replayed history is not new evidence, and without the parent it is reference only', () => {
  const FORK = '01aa0000-0000-7000-8000-0000000f0421';
  const parentItems = [{ kind: 'user', id: 'msg_p1', text: 'approved, merge the ledger branch' }, { kind: 'assistant', id: 'msg_p2', phase: 'final_answer', text: 'Merged the ledger branch.' }];
  const forkFile = (p) => cx.write(path.join(p.live, cx.rolloutName(FORK, '', '2026-09-13T09-00-00')), { thread: FORK, parent: cx.THREAD, forkedFrom: cx.THREAD, cwd: p.proj, day: '2026-09-13',
    startOrdinal: 3, startKey: 'fork_history_start_ordinal',
    items: [...parentItems.map((it, i) => ({ ...it, ordinal: i + 1, ts: cx.at('2026-09-12', i + 1) })), { kind: 'user', id: 'msg_f1', ordinal: 3, text: 'now try the ledger merge the other way' }] });

  const p = project();
  cx.write(path.join(p.live, cx.rolloutName(cx.THREAD)), rootThread(p, { items: parentItems }));
  forkFile(p);
  const store = openStore(p.cfg.store);
  const r = ingest.run(p.cfg, { mode: 'new' }, store);
  assert.equal(r.codex.subagentFiles, 0, 'a parent does not make a thread a subagent');
  assert.equal(r.turns, 3); assert.equal(r.codex.duplicates, 2);
  assert.deepEqual(store.turnsForSession(`codex:${FORK}`).map((t) => t.body), ['now try the ledger merge the other way']);
  assert.equal(store.turnsForSession(`codex:${cx.THREAD}`).length, 2);
  store.close();

  const q = project();
  forkFile(q);
  const s2 = openStore(q.cfg.store);
  ingest.run(q.cfg, { mode: 'new' }, s2);
  const inherited = s2.turnsForSession(`codex:${cx.THREAD}`);
  assert.deepEqual(inherited.map((t) => [t.origin, t.ts.slice(0, 10)]), [['reference', '2026-09-12'], ['reference', '2026-09-12']], 'original thread, original day, reference only');
  s2.close();
});

test('identity: Claude and Codex may use the very same raw id without colliding', async () => {
  const p = project();
  makeSession(path.join(p.claudeDir, `${cx.THREAD}.jsonl`), { sessionId: cx.THREAD, day: '2026-09-12' });
  cx.write(path.join(p.live, cx.rolloutName(cx.THREAD)), rootThread(p));
  const store = openStore(p.cfg.store);
  ingest.run(p.cfg, { mode: 'new' }, store);
  assert.ok(store.turnsForSession(cx.THREAD).every((t) => t.source_client === 'claude'));
  assert.ok(store.turnsForSession(`codex:${cx.THREAD}`).every((t) => t.source_client === 'codex'));
  assert.deepEqual(store.resolveSession(cx.THREAD).sort(), [cx.THREAD, `codex:${cx.THREAD}`].sort());
  assert.match(await find(p.cfg, store, { kind: 'turn', session: cx.THREAD }, 'ledger invoice'), /matches 2 conversations; name one: .*claude:01aa.*codex:01aa|matches 2 conversations; name one: .*codex:01aa.*claude:01aa/);
  const one = await find(p.cfg, store, { kind: 'turn', session: `claude:${cx.THREAD}` }, 'invoice ledger');
  assert.ok(/\[claude\]|\[owner\]/.test(one) && !/codex/.test(one));
  // The same-day Claude handoff covers Claude's session only: Codex's raw work still shows.
  fs.writeFileSync(path.join(p.proj, 'notes', 'CLAUDE-HANDOFF-2026-09-12.md'), '# h\n\n## Done\nInvoice rounding frozen.\n');
  ingest.run(p.cfg, { mode: 'new' }, store);
  const raw = await find(p.cfg, store, {}, 'ledger invoice');
  assert.match(raw, /RAW, not yet distilled:[\s\S]*codex:01aa0000/);
  assert.ok(!/RAW, not yet distilled:[\s\S]*\[claude\]/.test(raw));
  assert.ok(!/RAW[\s\S]*\[codex\]/.test(await find(p.cfg, store, { client: 'claude' }, 'ledger invoice')), 'the RAW block obeys the same client filter as the rest');
  store.close();
});

// ---------------------------------------------------------------- migration

test('migration: explicit, backed up, id-preserving, idempotent; a newer store is refused', () => {
  const p = project();
  const db = new DatabaseSync(p.cfg.store);
  db.exec(SCHEMA_V1);
  db.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', '1')`).run();
  const ins = db.prepare(`INSERT INTO docs (id, project, kind, status, session_id, ts, role, path, title, body, who, outcome, evidence_ids, quote, superseded_by, sha) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run(10, 'demo', 'turn', 'active', 's-old', '2026-09-01T10:00:00.000Z', 'user', 't.jsonl', 'approved, freeze the ledger', 'approved, freeze the ledger', null, null, '[]', null, null, 'sha-10');
  ins.run(11, 'demo', 'statement', 'active', 's-old', '2026-09-01T10:00:00.000Z', null, 'distill:abc', 'Owner froze the ledger', 'Owner froze the ledger', 'owner', 'approved', '[10]', 'freeze the ledger', null, 'sha-11');
  ins.run(12, 'demo', 'statement', 'struck', 's-old', '2026-09-01T10:00:00.000Z', null, 'distill:abc', 'Owner rejected the ledger', 'x\nstruck 2026-09-02: wrong', 'owner', 'rejected', '[10]', 'freeze', null, 'sha-12');
  ins.run(13, 'demo', 'statement', 'active', 's-old', '2026-08-01T10:00:00.000Z', null, 'distill:abc', 'Older ledger rule', 'Older ledger rule', 'owner', 'standing', '[10]', 'x', 11, 'sha-13');
  ins.run(14, 'demo', 'statement', 'active', null, '2026-08-01T10:00:00.000Z', null, 'memory.md', 'A rule from a memory file', 'A rule from a memory file', 'owner', 'standing', '[]', 'x', null, 'sha-14');
  db.prepare('INSERT INTO vectors(doc_id, model, vec) VALUES (?,?,?)').run(11, 'm', Buffer.from(new Float32Array([1, 0]).buffer));
  db.prepare('INSERT INTO distill_runs(session_id, turn_from, turn_to, model, prompt_sha, ran_at, lines) VALUES (?,?,?,?,?,?,?)').run('s-old', 10, 10, 'stub', 'abc', 'x', 1);
  db.prepare('INSERT INTO link_verdicts(old_id, new_id, prompt_sha, model, replaces) VALUES (?,?,?,?,?)').run(13, 11, 'j', 'stub', 1);
  db.prepare('INSERT INTO sources(path, kind, size, mtime, sha, offset, ingested_at) VALUES (?,?,?,?,?,?,?)').run('t.jsonl', 'transcript', 50, 'x', 'h', 50, 'x');
  db.close();

  assert.throws(() => openStore(p.cfg.store), (e) => e.code === 'NEEDS_MIGRATION' && /total_recall migrate/.test(e.message), 'a search or a hook never upgrades the store as a side effect');
  const r = migrate.run(p.cfg);
  assert.deepEqual([r.from, r.to], [1, SCHEMA_VERSION]);
  const bak = new DatabaseSync(r.backup);
  assert.equal(bak.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get().value, '1', 'the backup is a whole, usable version-1 store');
  assert.equal(bak.prepare('SELECT COUNT(*) AS n FROM docs').get().n, 5); bak.close();

  const store = openStore(p.cfg.store);
  assert.deepEqual(store.db.prepare('SELECT id, source_client, origin FROM docs ORDER BY id').all().map((d) => [d.id, d.source_client, d.origin]),
    [[10, 'claude', 'direct'], [11, 'claude', null], [12, 'claude', null], [13, 'claude', null], [14, null, null]], 'ids kept; a memory-file rule is nobody\'s client');
  assert.equal(store.search('"freeze"', { kinds: ['turn'] })[0].id, 10, 'the FTS index still answers');
  assert.equal(store.getDoc(12).status, 'struck'); assert.equal(store.getDoc(13).superseded_by, 11);
  assert.ok(store.getVector(11, 'm')); assert.equal(store.getVerdict(13, 11, 'j'), true);
  assert.ok(store.hasRun({ session_id: 's-old', turn_from: 10, turn_to: 10, model: 'stub', prompt_sha: 'abc' }));
  assert.equal(store.getSource('t.jsonl').client, 'claude');
  assert.equal(store.unstrike(12).status, 'active', 'undo still works');
  store.close();
  assert.equal(migrate.run(p.cfg).nothing, true, 'a second run does nothing');

  const up = new DatabaseSync(p.cfg.store); up.prepare(`UPDATE meta SET value = '99' WHERE key = 'schema_version'`).run(); up.close();
  assert.throws(() => openStore(p.cfg.store), /schema version 99 and this total_recall understands up to/);
});

test('migration: a record hashed by Phase 2 is recognised after the migration; re-importing it unchanged adds nothing and moves no id (review fix 2)', () => {
  // Pinned from the Phase 2 program itself (its docSha, run on these exact fields). The separator
  // inside these hashes is the invisible control character U+0001; retyping the function with an
  // empty separator is what this guards.
  const { docSha } = require('../lib/store');
  assert.equal(docSha({ kind: 'turn', session_id: 'fix-session-1', ts: '2026-09-10T10:04:00.000Z', role: 'user', path: 'C:/t/fix-session-1.jsonl', body: 'approved, do it' }),
    'e10e439eace18406c24a8f163a5c8e87318e518ad754600c8fcbb98338920ddf');
  assert.equal(docSha({ kind: 'statement', who: 'owner', outcome: 'standing', title: 'Never ship a text-only logo', quote: 'Never ship a text-only logo.' }),
    'a5c37b346bd824171e0ee8d8f55f626135c0ba25ee065ba56468930bf94d345c');

  const p = project({ sources: { memory: 'memory/*.md', handoff: 'notes/SESSION-HANDOFF-*.md' } });
  makeSession(path.join(p.claudeDir, 'fix-session-1.jsonl'));
  fs.mkdirSync(path.join(p.proj, 'memory'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'memory-feedback.md'), path.join(p.proj, 'memory', 'feedback_2026-09-01_logo.md'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'handoff-v1.md'), path.join(p.proj, 'notes', 'SESSION-HANDOFF-2026-09-10.md'));

  // What Phase 2 would have stored for these unchanged files: the rows' fields, hashed by an
  // INDEPENDENT copy of the Phase 2 formula, in a hand-built version-1 store, under ids of its own.
  const scratchFile = path.join(p.root, 'scratch.sqlite');
  const scratch = openStore(scratchFile);
  ingest.run({ ...p.cfg, store: scratchFile }, { mode: 'all' }, scratch);
  const rows = scratch.db.prepare('SELECT * FROM docs ORDER BY id').all();
  scratch.close();
  assert.ok(rows.some((d) => d.kind === 'turn') && rows.some((d) => d.kind === 'statement') && rows.some((d) => d.kind === 'memory') && rows.some((d) => d.kind === 'handoff') && rows.some((d) => d.kind === 'compact_summary'));
  const SEP = String.fromCharCode(1);
  const phase2Sha = (d) => sha256((d.kind === 'statement' ? ['statement', d.who, d.outcome, d.title, d.quote || ''] : [d.kind, d.session_id || '', d.ts, d.role || '', d.path || '', d.body]).join(SEP));
  const db = new DatabaseSync(p.cfg.store);
  db.exec(SCHEMA_V1);
  db.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', '1')`).run();
  const ins = db.prepare(`INSERT INTO docs (id, project, kind, status, session_id, ts, role, path, title, body, files_json, tools_json, who, outcome, evidence_ids, quote, reason, sha) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  rows.forEach((d, i) => ins.run(500 + i * 3, d.project, d.kind, d.status, d.session_id, d.ts, d.role, d.path, d.title, d.body, d.files_json, d.tools_json, d.who, d.outcome, d.evidence_ids, d.quote, d.reason, phase2Sha(d)));
  db.close();

  migrate.run(p.cfg);
  const store = openStore(p.cfg.store);
  const snapshot = () => store.db.prepare('SELECT id, sha, status FROM docs ORDER BY id').all().map((d) => `${d.id}:${d.sha}:${d.status}`);
  const before = snapshot();
  assert.equal(before.length, rows.length);
  const r = ingest.run(p.cfg, { mode: 'all' }, store); // no checkpoints exist, so every record is read again
  assert.deepEqual([r.turns, r.sections, r.standing], [0, 0, 0], 'an unchanged Phase 2 record is the SAME record, not a second copy');
  assert.equal(r.skipped, rows.length, 'every one of them was recognised');
  assert.deepEqual(snapshot(), before, 'same rows, same ids, same hashes');
  store.close();
});

// ---------------------------------------------------------------- distillation

test('distill: speakers come from the record, an assistant cannot approve, reference is never evidence, a failed or foreign run retires nothing, a strike survives', async () => {
  const p = project();
  makeSession(path.join(p.claudeDir, 'claude-one.jsonl'), { sessionId: 'claude-one', day: '2026-09-11' });
  cx.write(path.join(p.live, cx.rolloutName(cx.THREAD)), rootThread(p));
  const store = openStore(p.cfg.store);
  ingest.run(p.cfg, { mode: 'new' }, store);
  const key = `codex:${cx.THREAD}`;
  const t = Object.fromEntries(store.turnsForSession(key).map((d) => [d.item_key, d]));
  // What an OLDER prompt once said about the Claude session: must survive everything below.
  const cl = store.turnsForSession('claude-one');
  const legacy = store.insertDoc({ project: 'demo', kind: 'statement', session_id: 'claude-one', source_client: 'claude', ts: cl[4].ts, path: 'distill:an-older-prompt', title: 'Owner approved the rounding fix', body: 'x', who: 'owner', outcome: 'approved', evidence_ids: JSON.stringify([cl[4].id]), quote: 'approved, do it' });

  const good = JSON.stringify({ items: [
    { turn: t.msg_u1.id, outcome: 'approved', statement: 'Owner asked for the ledger export to be fixed', quote: 'the ledger export drops the last row, fix it', reason: null },
    { turn: t.msg_a2.id, outcome: 'completed', statement: 'The ledger export off-by-one is fixed', quote: 'the off-by-one is fixed', reason: null },
    { turn: t.msg_a2.id, outcome: 'approved', statement: 'Codex approved its own work', quote: 'the off-by-one is fixed', reason: null },
    { turn: t.msg_a4.id, outcome: 'completed', statement: 'From a channel nobody has read', quote: 'A channel this parser has never seen', reason: null },
    { turn: t.msg_u4.id, outcome: 'standing', statement: 'Never round ledger totals before the export', quote: 'Never round the ledger totals before the export again.', reason: null, who: 'claude' },
  ] });
  const ollama = await stubOllama(['HTTP500', good, JSON.stringify({ items: [{ turn: t.msg_a2.id, outcome: 'completed', statement: 'Reworded: the export bug got repaired', quote: 'the off-by-one is fixed', reason: null }] })]);
  const cfg = { ...p.cfg, ollama: { ...p.cfg.ollama, url: ollama.url } };
  try {
    const failed = await distill.run(cfg, { mode: 'session', session: key }, {}, store);
    assert.equal(failed.failed.length, 1);
    assert.equal(store.getDoc(legacy.id).status, 'active', 'a failed Codex chunk retires nothing');

    const r = await distill.run(cfg, { mode: 'session', session: key }, {}, store);
    assert.equal(r.stored, 3); assert.equal(r.dropped, 2);
    assert.ok(r.dropReasons.some((x) => /approved cited a codex turn/.test(x)), 'an assistant\'s "approved" approves nothing');
    assert.ok(r.dropReasons.some((x) => /not in chunk/.test(x)), 'a reference row is not in the slice at all');
    const stmts = store.distilledStatements().filter((s) => s.session_id === key);
    assert.deepEqual(stmts.map((s) => [s.who, s.outcome, s.source_client]).sort(), [['codex', 'completed', 'codex'], ['owner', 'approved', 'codex'], ['owner', 'standing', 'codex']], 'who is the cited turn\'s speaker, whatever the model claimed');
    assert.equal(store.getDoc(legacy.id).status, 'active', 'a Codex run never retires Claude\'s statements, whatever prompt wrote them');

    const sent = ollama.calls[1].prompt;
    assert.ok(sent.includes('CODEX, an AI assistant') && /\[T\d+\] codex: /.test(sent) && !/\bclaude\b/i.test(sent), 'the Codex prompt names the right assistant');
    assert.equal(distill.PROMPT_SHA, sha256(distill.PROMPT), 'the Claude prompt, and every run keyed by it, is untouched');
    assert.notEqual(distill.promptFor('codex').sha, distill.PROMPT_SHA);

    const done = stmts.find((s) => s.outcome === 'completed');
    store.strike(done.id, 'the owner says this never happened');
    const redo = await distill.run(cfg, { mode: 'session', session: key }, { redo: true }, store);
    assert.equal(redo.stored, 0, 'a struck finding does not come back reworded');
    assert.equal(store.getDoc(done.id).status, 'struck');
  } finally { ollama.close(); }

  // The brief: both assistants' sessions, labelled; a replaced or struck rule is not current; capped.
  const rule = store.distilledStatements().find((s) => s.outcome === 'standing');
  const old = store.insertDoc({ project: 'demo', kind: 'statement', session_id: 'claude-one', source_client: 'claude', ts: cl[8].ts, title: 'Round the ledger totals first', body: 'x', who: 'owner', outcome: 'standing', evidence_ids: JSON.stringify([cl[8].id]), quote: 'x' });
  store.linkStatement(old.id, rule.id);
  const lines = brief.buildBrief(store, p.cfg, new Set());
  assert.equal(lines[1], brief.BOUNDARY, 'injected recall opens by saying it is a record, not a request');
  const text = lines.join('\n');
  assert.match(text, /RULE owner: Never round ledger totals before the export/);
  assert.ok(!text.includes('Round the ledger totals first'), 'a rule a later rule replaced is not presented as current');
  assert.ok(!text.includes('off-by-one'), 'a struck statement stays out');
  assert.match(text, /owner approved: Owner asked for the ledger export to be fixed \(#\d+\)/);
  assert.match(text, /owner approved: Owner approved the rounding fix/, 'the other assistant\'s session is still in view');
  const small = brief.buildBrief(store, { ...p.cfg, brief: { ...p.cfg.brief, maxChars: 400 } }, new Set());
  assert.ok(small.join('\n').length <= 400 + 60 && /cut at its size cap/.test(small.join('\n')));
  store.close();
});

// ---------------------------------------------------------------- MCP, gate, hooks

test('gate: one marker per project, client and session; ids are never trusted as paths', () => {
  gate.ack('demo', 'same-id', 'claude');
  assert.equal(gate.isOpen('demo', 'same-id', 'claude'), true);
  assert.equal(gate.isOpen('demo', 'same-id'), true, 'Claude\'s marker is where it always was');
  assert.equal(gate.isOpen('demo', 'same-id', 'codex'), false, 'Claude\'s search cannot open Codex\'s gate');
  gate.ack('demo', 'task-A', 'codex');
  assert.equal(gate.isOpen('demo', 'task-B', 'codex'), false, 'a search in task A cannot open task B');
  const evil = gate.markerPath('demo', '..\\..\\..\\evil', 'codex');
  assert.ok(evil.startsWith(path.join(process.env.TOTAL_RECALL_HOME, 'gate', 'demo', 'codex')) && !evil.includes('..'));
  assert.equal(gate.isWriteCommand('node C:/tools/total_recall/bin/total_recall.js search "ledger > totals"', 'C:/work/demo-project'), false, 'the recall command is always allowed');
  assert.equal(gate.isWriteCommand('type src/ledger.js', 'C:/work/demo-project'), false);
  assert.equal(gate.isWriteCommand('echo x > src/ledger.js', 'C:/work/demo-project'), true);
});

test('mcp + codex hook: a successful search (even with zero hits) opens only the calling task\'s gate; a brief, an error or another project does not', async () => {
  const p = project();
  cx.write(path.join(p.live, cx.rolloutName(cx.THREAD)), rootThread(p));
  const io = () => { const o = { text: '', errText: '' }; o.out = { write: (s) => { o.text += s; } }; o.err = { write: (s) => { o.errText += s; } }; return o; };
  const call = (name, args, ctx) => mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { root: p.proj, env: { CLAUDE_CODE_SESSION_ID: 'claude-live' }, client: 'codex', ...ctx });

  // Start-up: arm, bounded ingest, brief. No model, and the brief is delimited as a record.
  let o = io();
  assert.equal(hook.handle({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'task-1', cwd: p.proj }, o), 0);
  assert.match(o.text, /ingested 9 turns/); assert.match(o.text, /== total_recall brief ==/);

  o = io();
  assert.equal(hook.handle({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', session_id: 'task-1', cwd: p.proj, tool_input: {} }, o), 0);
  assert.equal(JSON.parse(o.text).hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(JSON.parse(o.text).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(o.text).hookSpecificOutput.permissionDecisionReason, /BLOCKED by total_recall: call the recall_search tool/);
  assert.equal(hook.handle({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'task-1', cwd: p.proj, tool_input: { command: ['git', 'status'] } }, io()), 0, 'reading is never gated');
  o = io();
  assert.equal(hook.handle({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'task-1', cwd: p.proj, tool_input: { command: 'echo x > src/a.js' } }, o), 0);
  assert.equal(JSON.parse(o.text).hookSpecificOutput.permissionDecision, 'deny');

  const post = (sid, res) => hook.handle({ hook_event_name: 'PostToolUse', tool_name: 'mcp__total_recall__recall_search', session_id: sid, cwd: p.proj, tool_response: res }, io());
  const bad = await call('recall_search', { query: 'ledger', since: 'last week' });
  assert.equal(bad.result.isError, true); assert.equal(bad.result.structuredContent.total_recall.ok, false);
  post('task-1', bad.result);
  assert.equal(gate.isOpen('demo', 'task-1', 'codex'), false, 'a refused search is not a search');
  post('task-1', (await call('recall_brief', {})).result);
  assert.equal(gate.isOpen('demo', 'task-1', 'codex'), false, 'the brief alone does not open the gate');
  post('task-1', { structuredContent: { total_recall: { tool: 'recall_search', ok: true, project: 'some-other-project' } } });
  assert.equal(gate.isOpen('demo', 'task-1', 'codex'), false, 'a search of another project is not this project\'s search');

  const ok = await call('recall_search', { query: 'zebra-nothing-matches', words: true });
  assert.deepEqual(ok.result.structuredContent.total_recall, { tool: 'recall_search', ok: true, project: 'demo', hits: 0 });
  assert.equal(JSON.parse(JSON.stringify(ok)).jsonrpc, '2.0');
  assert.equal(gate.isOpen('demo', 'claude-live', 'claude'), false, 'a server started for Codex never takes a caller from its own environment');
  post('task-1', JSON.stringify(ok.result)); // the host may hand the envelope over as text
  assert.equal(gate.isOpen('demo', 'task-1', 'codex'), true, 'zero hits is still a search');
  assert.equal(gate.isOpen('demo', 'task-2', 'codex'), false);
  assert.equal(hook.handle({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', session_id: 'task-1', cwd: p.proj }, io()), 0);

  // Compaction refreshes the brief and keeps the gate; a resume asks for a fresh look; a child agent arms nothing.
  hook.handle({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'task-1', cwd: p.proj }, io());
  assert.equal(gate.isOpen('demo', 'task-1', 'codex'), true);
  hook.handle({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'task-1', cwd: p.proj, agent_path: '/root/helper' }, io());
  assert.equal(gate.isOpen('demo', 'task-1', 'codex'), true);
  hook.handle({ hook_event_name: 'SessionStart', source: 'resume', session_id: 'task-1', cwd: p.proj }, io());
  assert.equal(gate.isOpen('demo', 'task-1', 'codex'), false);

  // Under Claude the same server still opens Claude's gate from its environment, as before.
  await call('recall_search', { query: 'ledger', words: true, client: 'codex', who: 'owner' }, { client: 'claude' });
  assert.equal(gate.isOpen('demo', 'claude-live', 'claude'), true);

  o = io();
  assert.equal(hook.handle({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'x', cwd: os.tmpdir() }, o), 0);
  assert.equal(o.text, '', 'a project that has not opted in is left alone');
});

// ---------------------------------------------------------------- privacy of the repository itself

test('tracked files carry no private machine strings', () => {
  const banned = new RegExp(['ele' + 'ac', 'rate' + 'myvso', 'Users[\\\\/]+(?!example|<you>|you\\b)[A-Za-z]+[\\\\/]+\\.(codex|claude)'].join('|'), 'i');
  const roots = ['lib', 'bin', 'tests', 'skill', 'hooks', 'docs', 'README.md'];
  const bad = [];
  const walk = (f) => { const st = fs.statSync(f); if (st.isDirectory()) { for (const e of fs.readdirSync(f)) walk(path.join(f, e)); } else if (/\.(js|json|md|txt|toml)$/.test(f) && banned.test(fs.readFileSync(f, 'utf8'))) bad.push(f); };
  for (const r of roots) { const f = path.join(__dirname, '..', r); if (fs.existsSync(f)) walk(f); }
  assert.deepEqual(bad, []);
});
