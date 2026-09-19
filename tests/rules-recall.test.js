'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { openStore } = require('../lib/store');
const recall = require('../lib/recall');
const mcp = require('../lib/mcp');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-recall-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'alpha'), otherRoot = path.join(dir, 'beta');
  const file = path.join(dir, 'fixture.sqlite'), registry = path.join(dir, 'projects.json');
  for (const [project, at] of [['alpha', root], ['beta', otherRoot]]) {
    fs.mkdirSync(at);
    fs.writeFileSync(path.join(at, 'total_recall.json'), JSON.stringify({
      project, store: file, transcripts: 'transcripts', projectRegistry: registry,
      timezone: 'America/New_York',
    }));
  }
  fs.writeFileSync(registry, JSON.stringify({ projects: [{ root }, { root: otherRoot, aliases: ['Second'] }] }));
  const store = openStore(file);
  const base = { project: 'alpha', kind: 'statement', status: 'active', who: 'owner',
    role: null, source_client: 'codex', session_id: 'codex:one', origin: 'decision',
    path: 'decide:codex', outcome: 'standing', ts: '2026-09-19T12:00:00Z' };
  const ids = [];
  for (let i = 0; i < 48; i++) {
    const body = i < 31 ? `Always preserve the crest ${i}` : `Never publish without approval ${i}`;
    ids.push(store.insertDoc({ ...base, title: `Preference ${i}`, body, quote: body,
      source_client: i % 2 ? 'claude' : 'codex', session_id: i % 2 ? 'one' : 'codex:one',
      ts: i < 24 ? '2026-08-19T12:00:00Z' : '2026-09-19T12:00:00Z',
    }).id);
  }
  const approval = store.insertDoc({ ...base, outcome: 'approved', title: 'One task',
    body: 'Use this crest today', quote: 'Use this crest today' }).id;
  store.insertDoc({ ...base, project: 'beta', title: 'Other project', body: 'Never use pink', quote: 'Never use pink' });
  store.close();
  const ctx = { root, registryFile: registry, now: Date.parse('2026-09-19T16:00:00Z'),
    env: {}, client: 'codex' };
  return { dir, root, file, ctx, ids, approval };
}

test('rules-list Recall removes question words and recovers 48 rules rather than the 31 containing the', async (t) => {
  const p = fixture(t);
  const old = await recall.execute('search', { query: 'the', outcome: 'standing', who: 'owner', words: true }, p.ctx);
  assert.equal(old.counts.decisions, 31, 'fixture reproduces the reported omission');
  for (const request of ['what are my rules?', 'standing orders', 'Please list all my current rules']) {
    const r = await recall.execute('recall', { request, words: true, limit: 7 }, p.ctx);
    assert.equal(r.operation, 'recall');
    assert.equal(r.intent, 'instruction');
    assert.equal(r.query, '');
    assert.equal(r.orchestration.length, 1);
    const lane = r.orchestration[0];
    assert.equal(lane.request.outcome, 'standing');
    assert.equal(lane.counts.decisions, 48);
    assert.ok(lane.rows.every((d) => d.outcome === 'standing'));
    assert.equal(r.partial, true);
    const seen = lane.rows.map((d) => d.id);
    let next = lane.next;
    while (next) {
      const page = await recall.execute('find', { cursor: next }, p.ctx);
      assert.equal(page.counts.decisions, 48);
      seen.push(...page.rows.map((d) => d.id));
      next = page.next;
    }
    assert.equal(seen.length, 48);
    assert.equal(new Set(seen).size, 48);
    assert.deepEqual(seen.sort((a, b) => a - b), p.ids);
  }
});

test('rules-list Recall preserves topic, project, client and date scope; MCP and CLI agree', async (t) => {
  const p = fixture(t);
  const input = { request: 'What are my rules about crest?', client: 'codex', since: '2026-09', words: true };
  const r = await recall.execute('recall', input, p.ctx);
  assert.equal(r.topic, 'crest');
  assert.equal(r.query, 'crest');
  assert.equal(r.orchestration[0].counts.decisions, 4);
  const wire = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'recall_recall', arguments: input } }, p.ctx);
  assert.equal(wire.result.isError, false);
  assert.deepEqual(wire.result.structuredContent.recall.orchestration[0].rows.map((d) => d.id), r.orchestration[0].rows.map((d) => d.id));
  const cli = JSON.parse(execFileSync(process.execPath, [path.resolve(__dirname, '../bin/total_recall.js'),
    'recall', input.request, '--client', 'codex', '--since', '2026-09', '--words', '--json'],
  { cwd: p.root, env: { ...process.env, TOTAL_RECALL_ROOT: p.root }, encoding: 'utf8' }));
  assert.equal(cli.orchestration[0].counts.decisions, 4);
  const explicit = await recall.execute('recall', { request: 'What are my rules about crest?', topic: 'publish', words: true }, p.ctx);
  assert.equal(explicit.query, 'publish');
  assert.equal(explicit.orchestration[0].counts.decisions, 17, 'an explicit topic is not overwritten');
  const other = await recall.execute('recall', { request: 'standing orders', project: 'Second', words: true }, p.ctx);
  assert.equal(other.project, 'beta');
  assert.equal(other.orchestration[0].counts.decisions, 1);
});

test('ordinary instruction Recall still includes one-off decisions', async (t) => {
  const p = fixture(t);
  const r = await recall.execute('recall', { request: 'What have I told you about crest?', words: true, limit: 30 }, p.ctx);
  assert.equal(r.intent, 'instruction');
  assert.equal(r.orchestration.length, 3);
  const lane = r.orchestration.find((l) => l.lane === 'decisions');
  assert.equal(lane.counts.decisions, 32);
  assert.ok(lane.rows.some((d) => d.id === p.approval));
});

test('unclear option aliases reach Recall filters and unclear records remain clearly labelled', async (t) => {
  const p = fixture(t), store = openStore(p.file);
  const id = store.insertDoc({ project: 'alpha', kind: 'statement', status: 'active', who: 'owner',
    source_client: 'codex', origin: 'decision-unclear', path: 'decide:codex', outcome: 'standing',
    title: 'Possibly a standing rule', body: 'Make header blue', quote: 'Make header blue', ts: '2026-09-19T13:00:00Z' }).id;
  store.close();
  for (const key of ['include_unclear', 'include-unclear']) {
    const r = await recall.execute('recall', { request: 'what are my rules', words: true, [key]: true }, p.ctx);
    assert.equal(r.orchestration[0].request.include_unclear, true);
    assert.ok(r.evidence.some((d) => d.id === id));
    assert.match(recall.format(r), /UNCLEAR interpretation/);
  }
  const found = await recall.execute('find', { outcome: 'standing', words: true, include_unclear: true, order: 'newest' }, p.ctx);
  assert.match(recall.format(found), /UNCLEAR interpretation/);
  const opened = await recall.execute('read', { id }, p.ctx);
  assert.match(recall.format(opened), /UNCLEAR interpretation/);
  await assert.rejects(recall.execute('recall', { request: 'what are my rules', words: true, include_unclear: 'yes' }, p.ctx), /include_unclear must be boolean/);
});
