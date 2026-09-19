'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { openStore } = require('../lib/store');
const rd = require('../lib/recall-db');
const meaning = require('../lib/recall-meaning');

function fixture(t, count = 7) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-index-maintenance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { project: 'alpha', store: path.join(dir, 'source.sqlite'), ollama: { url: 'http://fixture.invalid' }, embed: { model: 'fixture', batch: 4 } };
  const s = openStore(cfg.store), ids = [];
  for (let i = 0; i < count; i++) ids.push(s.insertDoc({ project: 'alpha', kind: 'turn', origin: 'direct', role: 'user', source_client: 'codex', title: `record ${i}`, body: `record ${i} has meaningful original text`, ts: '2026-09-19T10:00:00Z' }).id);
  s.close();
  return { cfg, ids };
}
const fakeEncoder = { version: 'fixture-v1', async embed(texts) { return texts.map(() => [1, 0]); } };

test('index requests get fresh timeouts, while a search retains one shared deadline', async (t) => {
  const controllers = [], seen = [];
  t.mock.method(AbortSignal, 'timeout', () => { const c = new AbortController(); controllers.push(c); return c.signal; });
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    seen.push(opts.signal);
    opts.signal.throwIfAborted();
    return { ok: true, json: async () => url.endsWith('/show') ? { model_info: { family: 'test' }, modelfile: 'fixture' } : { embeddings: [[1, 0]] } };
  });
  const enc = await meaning.encoder({ embed: { model: 'fixture' } }, {}, 120000, true);
  controllers.at(-1).abort(); // enough time passed to expire an earlier request
  await enc.embed(['first passage'], 'search_document');
  controllers.at(-1).abort();
  await enc.embed(['later passage'], 'search_document');
  assert.equal(new Set(seen).size, 3);
  const query = await meaning.encoder({ embed: { model: 'fixture' } }, {}, 6000);
  controllers.at(-1).abort();
  await assert.rejects(query.embed(['query'], 'search_query'), /abort/i);
  assert.equal(seen.at(-1), seen.at(-2), 'query metadata and embedding keep one deadline');
});

test('index batches across records, completes --all, skips unchanged and catches a new record', async (t) => {
  const { cfg } = fixture(t);
  const calls = [], encoder = { ...fakeEncoder, async embed(texts) { calls.push(texts.length); return fakeEncoder.embed(texts); } };
  const before = fs.readFileSync(cfg.store);
  let s = rd.open(cfg);
  const dry = await meaning.build(s, { all: true, dry: true }, { encoder });
  assert.equal(dry.total_chunks, 7); assert.equal(calls.length, 0);
  const first = await meaning.build(s, { all: true }, { encoder });
  assert.deepEqual(calls, [4, 3]); assert.equal(first.embedded_records, 7);
  assert.equal(meaning.coverage(s).missing_or_incomplete, 0);
  const repeat = await meaning.build(s, { all: true }, { encoder });
  assert.equal(repeat.embedded_records, 0); assert.equal(repeat.skipped_records, 7);
  s.close();
  assert.deepEqual(fs.readFileSync(cfg.store), before);
  const writer = openStore(cfg.store);
  writer.insertDoc({ project: 'alpha', kind: 'memory', title: 'new session', body: 'Remember this next time.', ts: '2026-09-19T11:00:00Z' });
  writer.close();
  s = rd.open(cfg);
  assert.equal(meaning.coverage(s).missing_or_incomplete, 1);
  const next = await meaning.build(s, { all: true }, { encoder });
  assert.equal(next.embedded_records, 1); assert.equal(meaning.coverage(s).missing_or_incomplete, 0);
  s.close();
});

test('failed batch leaves only committed chunks; resume completes without re-embedding them', async (t) => {
  const { cfg } = fixture(t);
  let calls = 0;
  const unstable = { ...fakeEncoder, async embed(texts) { if (++calls === 2) throw new Error('connection interrupted'); return fakeEncoder.embed(texts); } };
  const s = rd.open(cfg);
  await assert.rejects(meaning.build(s, { all: true }, { encoder: unstable }), /interrupted/);
  assert.equal(meaning.coverage(s).full_text_chunked_records, 4);
  const resumed = await meaning.build(s, { all: true }, { encoder: fakeEncoder });
  assert.equal(resumed.embedded_records, 3); assert.equal(resumed.embedded_chunks, 3);
  assert.equal(meaning.coverage(s).missing_or_incomplete, 0);
  s.close();
});

test('invalid batch is never labelled complete and coverage uses the same eligible set as index', async (t) => {
  const { cfg } = fixture(t, 2);
  const writer = openStore(cfg.store);
  writer.insertDoc({ project: 'alpha', kind: 'turn', title: 'old tool', body: '(tool-only turn: Edit) old.js', origin: null, ts: '2026-09-19T10:00:00Z' });
  writer.close();
  const s = rd.open(cfg);
  assert.equal(meaning.coverage(s).eligible_records, 2);
  await assert.rejects(meaning.build(s, { all: true }, { encoder: { version: 'fixture-v1', async embed() { return [[1, 0]]; } } }), /incomplete batch/);
  assert.equal(meaning.coverage(s).full_text_chunked_records, 0);
  await meaning.build(s, { all: true }, { encoder: fakeEncoder });
  assert.equal(meaning.coverage(s).missing_or_incomplete, 0);
  await assert.rejects(meaning.build(s, { all: true, limit: 1 }, { encoder: fakeEncoder }), /not both/);
  s.close();
});

test('a partial long record is resumed and changed source text invalidates only its derived chunks', async (t) => {
  const { cfg, ids } = fixture(t, 1);
  let db = new DatabaseSync(cfg.store);
  db.prepare('UPDATE docs SET body=? WHERE id=?').run('long source '.repeat(1500), ids[0]); db.close();
  let s = rd.open(cfg), calls = 0;
  await assert.rejects(meaning.build(s, { all: true, batch: 2 }, { encoder: { ...fakeEncoder, async embed(texts) { if (++calls === 2) throw new Error('stop'); return fakeEncoder.embed(texts); } } }), /stop/);
  assert.equal(meaning.coverage(s).full_text_chunked_records, 0);
  const total = meaning.chunks(rd.doc(s, ids[0]).body).length;
  const resumed = await meaning.build(s, { all: true, batch: 2 }, { encoder: fakeEncoder });
  assert.equal(resumed.embedded_chunks, total - 2); s.close();
  db = new DatabaseSync(cfg.store);
  db.prepare('UPDATE docs SET body=? WHERE id=?').run('changed source', ids[0]); db.close();
  s = rd.open(cfg); assert.equal(meaning.coverage(s).missing_or_incomplete, 1);
  await meaning.build(s, { all: true }, { encoder: fakeEncoder });
  assert.equal(meaning.coverage(s).missing_or_incomplete, 0); s.close();
});
