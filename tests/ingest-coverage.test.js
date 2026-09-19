'use strict';
// Synthetic fixtures only. No personal store, transcript or model is opened.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore, sha256 } = require('../lib/store');
const { loadConfig } = require('../lib/config');
const ingest = require('../lib/ingest');
const recall = require('../lib/recall');
const cx = require('./fixtures/make-codex-session');
const { spawnSync } = require('node:child_process');

function fixture(t, sources = { handoff: ['notes/*.md'] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-coverage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'transcripts')); fs.mkdirSync(path.join(root, 'notes'));
  fs.writeFileSync(path.join(root, 'total_recall.json'), JSON.stringify({ project: 'fixture', transcripts: 'transcripts', sources, store: 'store.sqlite' }));
  const cfg = loadConfig(root), file = path.join(root, 'transcripts', 'one.jsonl');
  const line = (text = 'synthetic owner words') => JSON.stringify({ type: 'user', sessionId: 'one', timestamp: '2026-09-19T10:00:00Z', message: { content: text } }) + '\n';
  fs.writeFileSync(file, line());
  fs.writeFileSync(path.join(root, 'notes', 'SESSION-HANDOFF-2026-09-19.md'), '## Work\nSynthetic work only.\n');
  return { root, cfg, file, line };
}
const saved = (s, cfg, completed = false) => JSON.parse(s.getMeta(ingest.receiptKey(cfg, completed)));

test('completion receipt covers transcript and note sources, inventory is read-only and config/project-bound', async t => {
  const p = fixture(t), s = openStore(p.cfg.store);
  const sonnet = s.insertDoc({ project: p.cfg.project, kind: 'statement', ts: '2026-09-18T00:00:00Z', title: 'model record', body: 'Do not touch this existing interpretation.', who: 'owner', outcome: 'approved', model: 'fixture-sonnet' }).id;
  const before = { ...s.getDoc(sonnet) };
  const r = ingest.run(p.cfg, { mode: 'all' }, s);
  assert.equal(r.receipt.coverage_complete, true);
  assert.equal(r.receipt.sources.length, 2);
  assert.equal(r.receipt.sources.every(x => x.discovered === 1), true);
  const id = s.turnsForSession('one')[0].id;
  const second = ingest.run(p.cfg, { mode: 'all' }, s);
  assert.equal(second.turns, 0); assert.equal(s.turnsForSession('one')[0].id, id);
  assert.deepEqual({ ...s.getDoc(sonnet) }, before);
  s.close();
  const bytes = fs.readFileSync(p.cfg.store);
  const c = await recall.execute('inventory', { what: 'coverage' }, { root: p.root });
  assert.equal(c.last_completed_ingest, second.receipt.finished_at);
  assert.equal(c.last_ingest_attempt.coverage_complete, true);
  assert.deepEqual(c.configured_note_sources, p.cfg.sources);
  assert.deepEqual(fs.readFileSync(p.cfg.store), bytes);
  const raw = JSON.parse(fs.readFileSync(path.join(p.root, 'total_recall.json')));
  raw.sources.handoff.push('notes/EXTRA-*.md');
  fs.writeFileSync(path.join(p.root, 'total_recall.json'), JSON.stringify(raw));
  assert.equal((await recall.execute('inventory', {}, { root: p.root })).last_completed_ingest, null);
  raw.project = 'other'; fs.writeFileSync(path.join(p.root, 'total_recall.json'), JSON.stringify(raw));
  assert.equal((await recall.execute('inventory', {}, { root: p.root })).last_ingest_attempt, null);
});

test('missing or unreadable source roots are warnings, never empty successful imports', t => {
  const p = fixture(t), s = openStore(p.cfg.store);
  const good = ingest.run(p.cfg, { mode: 'all' }, s).receipt;
  const real = fs.readdirSync;
  fs.readdirSync = function (dir, ...args) { if (dir === p.cfg.transcripts) { const e = new Error('fixture denied'); e.code = 'EACCES'; throw e; } return real.call(fs, dir, ...args); };
  try {
    const r = ingest.run(p.cfg, { mode: 'new' }, s);
    assert.equal(r.receipt.snapshot_complete, false);
    assert.match(r.warnings.join(' '), /EACCES/);
    assert.equal(saved(s, p.cfg, true).finished_at, good.finished_at);
  } finally { fs.readdirSync = real; }
  const cfg = { ...p.cfg, sources: { memory: path.join(p.root, 'absent', '*.md') }, transcriptSources: [{ client: 'claude', path: path.join(p.root, 'missing'), recursive: false }] };
  const r = ingest.run(cfg, { mode: 'new' }, s);
  assert.equal(r.receipt.scan_errors.length, 2); assert.equal(r.receipt.status, 'partial');
  s.close();
});

test('Claude malformed and oversized gaps remain visible after an empty incremental pass', t => {
  const p = fixture(t), s = openStore(p.cfg.store);
  const cfg = { ...p.cfg, ingest: { maxLineMB: 1 } };
  fs.appendFileSync(p.file, '{bad json\n' + p.line('z'.repeat(1100000)));
  const r = ingest.run(cfg, { mode: 'all' }, s);
  assert.equal(r.receipt.snapshot_complete, true); assert.equal(r.receipt.coverage_complete, false);
  assert.match(r.warnings.join(' '), /1 malformed and 1 oversized/);
  assert.ok(!r.warnings.join(' ').includes('zzzz'));
  const again = ingest.run(cfg, { mode: 'new' }, s);
  assert.equal(again.turns, 0); assert.match(again.warnings.join(' '), /1 malformed and 1 oversized/);
  fs.writeFileSync(p.file, p.line());
  assert.equal(ingest.run(cfg, { mode: 'all' }, s).receipt.coverage_complete, true);
  s.close();
});

test('unfinished final records stay pending, trailing blank lines do not create a false gap', t => {
  const p = fixture(t), s = openStore(p.cfg.store);
  fs.appendFileSync(p.file, p.line('second').trimEnd());
  const first = ingest.run(p.cfg, { mode: 'all' }, s);
  assert.equal(first.turns, 1); assert.equal(first.receipt.snapshot_complete, false);
  assert.equal(first.receipt.tails.length, 1); assert.equal(saved(s, p.cfg, true), null);
  fs.appendFileSync(p.file, '\n\n\r\n');
  const next = ingest.run(p.cfg, { mode: 'all' }, s);
  assert.equal(next.turns, 1); assert.equal(next.receipt.coverage_complete, true);
  assert.equal(s.getSource(p.file).offset, fs.statSync(p.file).size);
  s.close();
});

test('selective Markdown imports never advance full-file progress; --all repairs legacy selective checkpoints', t => {
  const p = fixture(t, { changelog: 'notes/change.md' }), s = openStore(p.cfg.store);
  const file = path.join(p.root, 'notes', 'change.md');
  const body = '**2020-01-01, Earlier**\nold detail\n\n**2026-09-19, Later**\nnew detail\n';
  fs.writeFileSync(file, body);
  const partial = ingest.run(p.cfg, { mode: 'range', since: '2026-01-01' }, s);
  assert.equal(partial.sections, 1); assert.equal(s.getSource(file), undefined);
  assert.equal(partial.receipt.snapshot_complete, false);
  const st = fs.statSync(file);
  // Reproduce the older bug's whole-file checkpoint despite only a later section being present.
  s.setSource({ path: file, kind: 'changelog', size: st.size, mtime: st.mtime.toISOString(), sha: sha256(body), offset: st.size, ingested_at: '2026-09-19T00:00:00Z' });
  assert.equal(ingest.run(p.cfg, { mode: 'new' }, s).sections, 0);
  const full = ingest.run(p.cfg, { mode: 'all' }, s);
  assert.equal(full.sections, 1); assert.equal(full.receipt.coverage_complete, true);
  assert.equal(s.search('"old detail"', { kinds: ['changelog'] }).length, 1);
  assert.equal(s.search('"new detail"', { kinds: ['changelog'] }).length, 1);
  s.close();
});

test('budgeted and crashed passes cannot replace the last completed receipt', t => {
  const p = fixture(t), s = openStore(p.cfg.store);
  const good = ingest.run(p.cfg, { mode: 'all' }, s).receipt;
  fs.appendFileSync(p.file, p.line('extra'));
  const limited = ingest.run(p.cfg, { mode: 'new' }, s, { budgetMs: -1 });
  assert.equal(limited.pending, true); assert.equal(limited.receipt.status, 'partial');
  assert.equal(saved(s, p.cfg, true).finished_at, good.finished_at);
  fs.appendFileSync(p.file, p.line('crash fixture'));
  const real = s.insertDoc; s.insertDoc = () => { throw new Error('fixture failure'); };
  assert.throws(() => ingest.run(p.cfg, { mode: 'new' }, s), /fixture failure/);
  s.insertDoc = real;
  assert.equal(saved(s, p.cfg).status, 'failed');
  assert.equal(saved(s, p.cfg, true).finished_at, good.finished_at);
  s.close();
});

test('oversized known Codex tool outputs are counted exclusions, not conversation gaps', t => {
  const p = fixture(t), s = openStore(p.cfg.store);
  const cfg = { ...p.cfg, transcriptSources: [{ client: 'codex', path: path.dirname(p.file), recursive: false }], ingest: { maxLineMB: 1 } };
  cx.write(p.file, { thread: cx.THREAD, cwd: p.root, items: [
    { kind: 'user', id: 'fixture-owner', text: 'Keep this owner message.' },
    ...['function_call_output', 'custom_tool_call_output'].map(type => ({ kind: 'raw', type: 'response_item', payload: { type, output: 'x'.repeat(1100000) } }))
  ] });
  const first = ingest.run(cfg, { mode: 'all' }, s);
  assert.equal(first.receipt.coverage_complete, true);
  assert.deepEqual(first.warnings, []);
  assert.equal(first.codex.oversizedExcluded, 2);
  assert.deepEqual(first.codex.oversizedExcludedTypes, { 'response_item|function_call_output': 1, 'response_item|custom_tool_call_output': 1 });
  assert.equal(first.codex.oversized, 2); assert.equal(first.codex.oversizedMessages, 0);
  assert.match(ingest.codexReport(first.codex).join(' '), /2 oversized tool-output records intentionally excluded/);
  const owner = s.turnsForSession(`codex:${cx.THREAD}`)[0];
  assert.equal(owner.body, 'Keep this owner message.');
  assert.equal(owner.sha, sha256(['codex', 'msg', 'fixture-owner'].join('|')));
  const again = ingest.run(cfg, { mode: 'all' }, s);
  assert.equal(again.turns, 0); assert.equal(s.turnsForSession(`codex:${cx.THREAD}`)[0].id, owner.id);
  s.close();
});

test('oversized image-bearing messages, compactions, unknown records and misleading embedded types still warn', t => {
  const p = fixture(t), s = openStore(p.cfg.store);
  const cfg = { ...p.cfg, transcriptSources: [{ client: 'codex', path: path.dirname(p.file), recursive: false }], ingest: { maxLineMB: 1 } };
  cx.write(p.file, { thread: cx.THREAD, cwd: p.root, items: [
    { kind: 'user', id: 'small-owner', text: 'Small owner message.' },
    { kind: 'user', id: 'image-owner', blocks: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(1100000) }, { type: 'input_text', text: 'Do not lose these words beside my image.' }] },
    { kind: 'raw', type: 'compacted', payload: { message: 'Summary that must not be assumed empty.', replacement_history: ['x'.repeat(1100000)] } },
    { kind: 'raw', type: 'response_item', payload: { type: 'future_message', content: 'x'.repeat(1100000) } },
    { kind: 'raw', type: 'unknown', payload: { type: 'function_call_output', content: 'x'.repeat(1100000) } }
  ] });
  const first = ingest.run(cfg, { mode: 'all' }, s);
  assert.equal(first.receipt.coverage_complete, false);
  assert.equal(first.codex.oversizedExcluded, 0);
  assert.equal(first.codex.oversizedMessages, 1); assert.equal(first.codex.oversized, 3);
  assert.match(first.warnings.join(' '), /0 malformed and 4 oversized/);
  assert.match(ingest.run(cfg, { mode: 'new' }, s).warnings.join(' '), /4 oversized/);
  // A bounded higher cap plus full rescan recovers text; hashes keep old rows stable.
  const ownerId = s.turnsForSession(`codex:${cx.THREAD}`)[0].id;
  const recovered = ingest.run({ ...cfg, ingest: { maxLineMB: 2 } }, { mode: 'all' }, s);
  assert.equal(recovered.turns, 1); assert.equal(recovered.receipt.coverage_complete, true);
  const rows = s.turnsForSession(`codex:${cx.THREAD}`);
  assert.equal(rows.find(d => d.item_key === 'small-owner').id, ownerId);
  assert.equal(rows.find(d => d.item_key === 'image-owner').body, '[image]\nDo not lose these words beside my image.');
  s.close();
});

test('successful selected CLI imports exit zero while retaining partial global coverage', t => {
  const p = fixture(t);
  const bin = path.resolve(__dirname, '../bin/total_recall.js');
  for (const flags of [['--session', 'one'], ['--since', '2026-09-19']]) {
    const result = spawnSync(process.execPath, [bin, 'ingest', ...flags], { cwd: p.root, env: { ...process.env, TOTAL_RECALL_ROOT: p.root }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /source coverage: partial/);
    assert.match(result.stdout, /not a verified complete corpus/);
  }
  fs.appendFileSync(p.file, '{bad json\n');
  const warned = spawnSync(process.execPath, [bin, 'ingest', '--session', 'one'], { cwd: p.root, env: { ...process.env, TOTAL_RECALL_ROOT: p.root }, encoding: 'utf8' });
  assert.equal(warned.status, 1); assert.match(warned.stderr, /WARNING.*malformed/);
});
