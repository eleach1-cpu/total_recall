'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { openStore } = require('../lib/store');
const ingest = require('../lib/ingest');
const distill = require('../lib/distill');
const { makeSession } = require('./fixtures/make-session');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-distill-'));
  const transcripts = path.join(root, 'transcripts'); fs.mkdirSync(transcripts);
  makeSession(path.join(transcripts, 'fix-session-1.jsonl'));
  const cfg = { project: 'demo', root, transcripts, sources: {}, store: path.join(root, 's.sqlite'), ollama: { url: '', model: 'stub', chunkTokens: 6000 } };
  const store = openStore(cfg.store);
  ingest.run(cfg, { mode: 'new' }, store);
  return { cfg, store };
}

function stubOllama(replies) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.push(JSON.parse(body));
      const reply = replies.shift();
      if (reply === 'HTTP500') { res.writeHead(500); res.end('boom'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: reply }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}

test('chunking keeps order and respects the size', () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, role: 'user', body: 'x'.repeat(100), ts: `2026-09-10T10:0${i}:00.000Z` }));
  const chunks = distill.chunkTurns(turns, 350);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0].turn_from, 1);
  assert.equal(chunks[chunks.length - 1].turn_to, 10);
});

test('valid items become statements with evidence; bad quote and bad turn are dropped and counted; same chunk is not re-sent', async () => {
  const { cfg, store } = setup();
  const turns = store.turnsForSession('fix-session-1');
  const owner = turns.find((t) => /Never ship the invoice/.test(t.body));
  const claude = turns.find((t) => /Understood, the invoice/.test(t.body));
  const good = { who: 'owner', outcome: 'standing', statement: 'Invoice rounding change must never ship again', quote: 'Never ship the invoice total rounding change again', turn: owner.id, reason: 'it broke three orders' };
  // A claude turn cannot be `approved` (the validator drops that); `completed` is the claude-side label.
  const ack = { who: 'claude', outcome: 'completed', statement: 'Claude confirmed the rounding stays', quote: 'the invoice rounding stays as it is', turn: claude.id, reason: null };
  const badQuote = { who: 'owner', outcome: 'approved', statement: 'made up', quote: 'this sentence is not in the turn', turn: owner.id, reason: null };
  const badTurn = { who: 'owner', outcome: 'approved', statement: 'x', quote: 'approved, do it', turn: 999999, reason: null };
  const stub = await stubOllama([JSON.stringify({ items: [good, ack, badQuote, badTurn] })]);
  cfg.ollama.url = stub.url;
  const r = await distill.distillSession(store, cfg, 'fix-session-1', {});
  stub.close();
  assert.equal(r.sent, 1);
  assert.equal(r.stored, 2);
  assert.equal(r.dropped, 2);
  assert.ok(stub.calls[0].format === 'json' && stub.calls[0].stream === false);
  assert.match(stub.calls[0].prompt, /\[T\d+\] owner: Never ship the invoice/);
  const st = store.standing(10);
  assert.equal(st.length, 1);
  assert.deepEqual(JSON.parse(st[0].evidence_ids), [owner.id]);
  assert.equal(st[0].reason, 'it broke three orders');
  const conf = store.search('"confirmed"', { kinds: ['statement'], limit: 5 })[0];
  assert.deepEqual(JSON.parse(conf.evidence_ids).sort((a, b) => a - b), [owner.id, claude.id]);
  assert.equal(conf.reason, null);
  const stub2 = await stubOllama([JSON.stringify({ none: true })]);
  cfg.ollama.url = stub2.url;
  const r2 = await distill.distillSession(store, cfg, 'fix-session-1', {});
  stub2.close();
  assert.equal(r2.sent, 0, 'same chunk, same prompt, same model: nothing re-sent');
  assert.equal(r2.skipped, 1);
  const r3 = await distill.distillSession(store, cfg, 'fix-session-1', { model: 'other-model' });
  assert.equal(r3.failed.length, 1, 'a new model is a new run, and the stub is gone, so the chunk fails and is reported');
  assert.equal(r3.stored, 0);
  store.close();
});

test('NONE writes a run row; empty, 500 and unparseable replies are FAILED chunks: nothing stored, no run row, run continues', async () => {
  process.env.TOTAL_RECALL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-distill-home-'));
  const { cfg, store } = setup();
  const stub = await stubOllama([JSON.stringify({ none: true })]);
  cfg.ollama.url = stub.url;
  const r = await distill.distillSession(store, cfg, 'fix-session-1', {});
  stub.close();
  assert.equal(r.sent, 1); assert.equal(r.stored, 0); assert.equal(r.failed.length, 0);
  assert.equal(store.sessionsWithRuns().has('fix-session-1'), true);
  const stub2 = await stubOllama(['']);
  cfg.ollama.url = stub2.url;
  const r2 = await distill.distillSession(store, cfg, 'fix-session-1', { model: 'm2' });
  stub2.close();
  assert.equal(r2.failed.length, 1); assert.match(r2.failed[0].reason, /empty reply/);
  const stub3 = await stubOllama(['HTTP500']);
  cfg.ollama.url = stub3.url;
  const r3 = await distill.distillSession(store, cfg, 'fix-session-1', { model: 'm3' });
  stub3.close();
  assert.equal(r3.failed.length, 1); assert.match(r3.failed[0].reason, /500/);
  const stub4 = await stubOllama(['this is not json {{{']);
  cfg.ollama.url = stub4.url;
  const r4 = await distill.distillSession(store, cfg, 'fix-session-1', { model: 'm4' });
  stub4.close();
  assert.equal(r4.failed.length, 1); assert.match(r4.failed[0].reason, /not parseable/);
  const kept = fs.readdirSync(path.join(process.env.TOTAL_RECALL_HOME, 'failed'));
  assert.equal(kept.length, 1, 'the raw unparseable reply is kept for diagnosis');
  assert.equal(store.search('"anything"', { kinds: ['statement'], limit: 5 }).length, 0);
  for (const m of ['m2', 'm3', 'm4']) {
    const t = store.turnsForSession('fix-session-1');
    assert.equal(store.hasRun({ session_id: 'fix-session-1', turn_from: t[0].id, turn_to: t[t.length - 1].id, model: m, prompt_sha: distill.PROMPT_SHA }), false, `no run row for ${m}`);
  }
  store.close();
});

test('parseReply accepts the object shape, a bare array, JSON lines, and rejects garbage', () => {
  assert.deepEqual(distill.parseReply('{"none":true}'), { none: true, items: [] });
  assert.equal(distill.parseReply('{"items":[{"a":1}]}').items.length, 1);
  assert.equal(distill.parseReply('[{"a":1},{"b":2}]').items.length, 2);
  assert.equal(distill.parseReply('{"a":1}\n{"b":2}').items.length, 2);
  assert.equal(distill.parseReply('not json at all'), null);
  assert.equal(distill.parseReply(''), null);
});

test('claude provider: sends the right headers and body, parses text blocks, treats a refusal as a failed chunk, refuses to run without credentials', async () => {
  const { cfg, store } = setup();
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body) });
      const turns = store.turnsForSession('fix-session-1');
      const owner = turns.find((t) => /Never ship the invoice/.test(t.body));
      const reply = seen.length === 1
        ? { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ items: [{ outcome: 'standing', statement: 'Invoice rounding change must never ship again', quote: 'Never ship the invoice total rounding change again', turn: owner.id, reason: 'it broke three orders' }] }) }] }
        : { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'test' }, content: [] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cfg.distill = { provider: 'claude', model: null, url: `http://127.0.0.1:${server.address().port}/v1/messages` };
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  try {
    assert.equal(distill.modelFor(cfg, {}), 'claude-opus-5', 'the claude provider defaults to claude-opus-5');
    const r = await distill.distillSession(store, cfg, 'fix-session-1', {});
    assert.equal(r.sent, 1); assert.equal(r.stored, 1); assert.equal(r.failed.length, 0);
    const h = seen[0].headers;
    assert.equal(h['x-api-key'], 'sk-ant-test-key');
    assert.equal(h['anthropic-version'], '2023-06-01');
    assert.match(h['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.equal(seen[0].body.model, 'claude-opus-5');
    assert.equal(seen[0].body.fallbacks, 'default');
    assert.match(seen[0].body.messages[0].content, /\[T\d+\] owner: Never ship the invoice/);
    const r2 = await distill.distillSession(store, cfg, 'fix-session-1', { model: 'claude-sonnet-5' });
    assert.equal(r2.failed.length, 1);
    assert.match(r2.failed[0].reason, /refused/);
    assert.equal(seen[1].body.model, 'claude-sonnet-5');
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
    server.close();
  }
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
  const r3 = await distill.distillSession(store, cfg, 'fix-session-1', { model: 'claude-opus-4-8' });
  assert.equal(r3.failed.length, 1);
  assert.match(r3.failed[0].reason, /ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN/);
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  store.close();
});
