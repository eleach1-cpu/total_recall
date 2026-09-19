'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const voyage = require('../lib/voyage');
const meaning = require('../lib/recall-meaning');
const legacy = require('../lib/embed');
const { openStore } = require('../lib/store');
const rd = require('../lib/recall-db');
const cfg = { embed: { provider: 'voyage', allowRemote: true, model: 'voyage-4-lite', dimensions: 256 } };
const v = n => [n, ...Array(255).fill(0)];
function key(t) {
  const previous = process.env.VOYAGE_API_KEY;
  process.env.VOYAGE_API_KEY = 'synthetic-key-not-a-secret';
  t.after(() => { if (previous === undefined) delete process.env.VOYAGE_API_KEY; else process.env.VOYAGE_API_KEY = previous; });
}
function reply(input, changes = {}) {
  return { ok: true, json: async () => ({ model: 'voyage-4-lite', usage: { total_tokens: 5 }, data: input.map((_, i) => ({ index: i, embedding: v(1) })), ...changes }) };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-voyage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { ...cfg, project: 'alpha', store: path.join(dir, 'source.sqlite') };
  const writer = openStore(config.store);
  for (let i = 0; i < 3; i++) writer.insertDoc({ project: 'alpha', kind: 'turn', role: 'user', origin: 'direct', source_client: i === 0 ? 'claude' : 'codex', title: `text ${i}`, body: `text ${i} about keeping memories`, ts: '2026-09-19T10:00:00Z' });
  writer.close();
  return config;
}
test('Voyage request contract uses task types, exact text, sorted indices and reported usage', async t => {
  key(t); const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.voyageai.com/v1/embeddings');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer synthetic-key-not-a-secret');
    const body = JSON.parse(options.body); requests.push(body);
    return reply(body.input, { data: body.input.map((_, i) => ({ index: i, embedding: v(i + 1) })).reverse() });
  });
  const enc = voyage.encoder(cfg, 1000, { document: true, maxBytes: 100 });
  assert.deepEqual(await enc.embed(['hello', 'world'], 'search_document'), [v(1), v(2)]);
  assert.equal(requests[0].input_type, 'document'); assert.deepEqual(requests[0].input, ['hello', 'world']);
  assert.equal(requests[0].truncation, false); assert.equal(requests[0].output_dimension, 256);
  const q = voyage.encoder(cfg, 1000); await q.embed(['question'], 'search_query');
  assert.equal(requests[1].input_type, 'query');
  assert.equal(enc.usage.reported_tokens, 5); assert.equal(enc.usage.input_bytes, 10);
  await assert.rejects(q.embed(['private history'], 'search_document'), /explicit indexing/);
});
test('disabled provider, missing key, invalid configuration and legacy uploads fail before fetch', async t => {
  key(t); let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('must not call'); });
  assert.throws(() => voyage.encoder({ embed: { provider: 'voyage' } }, 1000), /disabled/);
  assert.throws(() => voyage.encoder(cfg, 1000, { document: true }), /limit/);
  assert.throws(() => voyage.settings({ embed: { model: 'nomic-embed-text' } }), /requires/);
  assert.throws(() => voyage.settings({ embed: { dimensions: 77 } }), /dimensions/);
  assert.throws(() => voyage.provider({ embed: { provider: 'typo' } }), /provider/);
  delete process.env.VOYAGE_API_KEY;
  assert.throws(() => voyage.encoder(cfg, 1000), /VOYAGE_API_KEY/);
  await assert.rejects(legacy.run(cfg), /local-only/);
  await assert.rejects(legacy.embedTexts(cfg, ['history'], 'search_document'), /local-only/);
  await assert.rejects(legacy.queryVector(cfg, {}, 'query'), /local-only/);
  assert.equal(calls, 0);
});
test('upload-volume limit counts UTF-8 bytes and stops before another request', async t => {
  key(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_, o) => { calls++; return reply(JSON.parse(o.body).input); });
  const enc = voyage.encoder(cfg, 1000, { document: true, maxBytes: 4 });
  await enc.embed(['éé'], 'search_document');
  await assert.rejects(enc.embed(['a'], 'search_document'), /before sending/);
  assert.equal(calls, 1); assert.equal(enc.usage.input_bytes, 4);
});
test('invalid batches, HTTP and timeouts never retry or expose response text', async t => {
  key(t); let calls = 0, current;
  t.mock.method(globalThis, 'fetch', async () => { calls++; if (current instanceof Error) throw current; return current; });
  for (const bad of [
    { data: [{ index: 0, embedding: v(1) }, { index: 0, embedding: v(1) }] },
    { data: [{ index: 0, embedding: [1] }, { index: 1, embedding: v(1) }] },
    { data: [{ index: 0, embedding: v(0) }, { index: 1, embedding: v(1) }] },
    { model: 'wrong-model' }, { usage: {} },
  ]) {
    current = reply(['a', 'b'], bad);
    await assert.rejects(voyage.encoder(cfg, 1000).embed(['a', 'b'], 'search_query'), /no automatic retry/);
  }
  current = { ok: false, status: 429, text: async () => 'SECRET response' };
  await assert.rejects(voyage.encoder(cfg, 1000).embed(['a'], 'search_query'), /HTTP 429/);
  current = new Error('SECRET private URL or timeout');
  await assert.rejects(voyage.encoder(cfg, 1000).embed(['a'], 'search_query'), e => !e.message.includes('SECRET') && /may have been billed/.test(e.message));
  assert.equal(calls, 7);
});
test('Voyage index isolates model/dimensions, resumes failures and leaves source and Ollama unchanged', async t => {
  key(t); const config = fixture(t), local = { ...config, embed: { model: 'fixture' } };
  let s = rd.open(local);
  await meaning.build(s, { all: true }, { encoder: { version: 'local-v1', embed: async texts => texts.map(() => [1, 0]) } }); s.close();
  const localBytes = fs.readFileSync(meaning.indexFile(local)), sourceBytes = fs.readFileSync(config.store);
  assert.notEqual(meaning.indexFile(config), meaning.indexFile(local));
  assert.notEqual(meaning.indexFile(config), meaning.indexFile({ ...config, embed: { ...config.embed, dimensions: 512 } }));
  assert.notEqual(meaning.indexFile(config), meaning.indexFile({ ...config, embed: { ...config.embed, model: 'voyage-4' } }));
  assert.throws(() => meaning.indexFile({ ...config, search: { index: config.store } }), /separate/);
  s = rd.open(config); let calls = 0, fail = true;
  t.mock.method(globalThis, 'fetch', async (_, o) => {
    calls++; if (calls === 2 && fail) throw new Error('offline');
    return reply(JSON.parse(o.body).input);
  });
  await meaning.build(s, { all: true, dry: true }); assert.equal(calls, 0);
  await assert.rejects(meaning.build(s, { all: true }), /explicit/); assert.equal(calls, 0);
  const opts = { all: true, batch: 1, 'allow-remote': true, 'max-remote-bytes': 10000 };
  await assert.rejects(meaning.build(s, opts), /no automatic retry/);
  assert.equal(meaning.coverage(s).full_text_chunked_records, 1);
  fail = false;
  const result = await meaning.build(s, opts);
  assert.equal(result.embedded_records, 2); assert.equal(result.remote_usage.requests, 2);
  assert.equal(meaning.coverage(s).missing_or_incomplete, 0);
  await meaning.build(s, opts); assert.equal(calls, 4);
  assert.deepEqual(fs.readFileSync(config.store), sourceBytes);
  assert.deepEqual(fs.readFileSync(meaning.indexFile(local)), localBytes);
  s.close();
});
test('new Voyage configuration cannot query legacy vectors; missing key falls back after indexing', async t => {
  key(t); const config = fixture(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_, o) => { calls++; return reply(JSON.parse(o.body).input); });
  const writer = openStore(config.store); writer.putVector(1, 'voyage-4-lite', v(1)); writer.close();
  const s = rd.open(config);
  const o = { query: 'memories', mode: 'hybrid', match: 'any', files: [] }, f = { where: 'd.project=?', params: ['alpha'] };
  let found = await meaning.search(s, o, f, [{ id: 1 }]);
  assert.equal(found.coverage.enabled, false); assert.equal(calls, 0); assert.equal(found.coverage.legacy_vectors, 0);
  await meaning.build(s, { all: true, 'allow-remote': true, 'max-remote-bytes': 10000 });
  found = await meaning.search(s, o, f, []);
  assert.equal(found.coverage.enabled, true); assert.equal(found.rows.length, 3);
  delete process.env.VOYAGE_API_KEY;
  found = await meaning.search(s, o, f, [{ id: 1 }]);
  assert.equal(found.coverage.enabled, false); assert.match(found.notes.join(' '), /words only/);
  s.close();
});
