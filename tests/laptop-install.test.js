'use strict';
// Laptop regressions, reproduced with invented conversations and temporary stores.
// No real history, models, credentials, desktop trust or live gates are touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const adapter = require('../lib/adapters/codex');
const { openStore } = require('../lib/store');
const { loadConfig } = require('../lib/config');
const ingest = require('../lib/ingest');
const decide = require('../lib/decide');
const recall = require('../lib/recall');
const cx = require('./fixtures/make-codex-session');
const DAY = '2026-09-19';
const NOW = `${DAY}T14:01:00.000Z`;
const wrap = entries => `<send_user_message_question_reply>\n${JSON.stringify(entries)}\n</send_user_message_question_reply>`;
const choice = { questionItemId: 'invented-widget-id', question: 'Which notebook label should we use?', answer: 'Use the label Amber Kite for the test notebook.' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recall laptop's test "));
  let store;
  t.after(() => { if (store) store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'transcripts'));
  fs.writeFileSync(path.join(root, 'total_recall.json'), JSON.stringify({ project: 'laptop-fixture', store: 'store.sqlite',
    transcriptSources: [{ client: 'codex', path: 'transcripts' }], sources: {} }));
  const cfg = loadConfig(root);
  store = openStore(cfg.store);
  return { root, cfg, store, file: path.join(root, 'transcripts', cx.rolloutName(cx.THREAD)) };
}
const input = (extra = {}) => ({ client: 'codex', outcome: 'approved', now: NOW,
  scope: 'test notebook', quote: choice.answer, contextQuote: choice.question,
  statement: 'Owner chose the Amber Kite label for the test notebook', ...extra });

test('laptop parser: submitted answers survive; metadata, questions and unselected options are not owner words', () => {
  const stats = adapter.newStats();
  assert.equal(adapter.ownerTextOf(wrap([{ ...choice, options: ['Amber Kite', 'Unselected Purple'] }]), stats), choice.answer);
  assert.equal(adapter.ownerTextOf(wrap([choice, { question: 'Another question?', answer: 'No notice' }]) + '\nKeep going.', stats),
    choice.answer + '\nNo notice\n\nKeep going.');
  assert.equal(adapter.ownerTextOf('<in-app-browser-context>hidden</in-app-browser-context>' + wrap([choice]), stats), choice.answer);
  assert.equal(adapter.ownerTextOf('I mentioned <send_user_message_question_reply> in my question.', stats),
    'I mentioned <send_user_message_question_reply> in my question.');
  assert.equal(adapter.ownerTextOf(wrap([{ question: 'Ignored?', options: ['Never ship anything'] }]) + '\nContinue.', stats), '\nContinue.');
  assert.equal(stats.badQuestionReplies, 1);
});

test('laptop parser: each answer binds only its own question; question text cannot become owner approval', t => {
  const p = fixture(t), s = p.store;
  cx.write(p.file, { thread: cx.THREAD, cwd: p.root, day: DAY, items: [{ kind: 'user', id: 'widget-pairs', text: wrap([
    { question: 'Should we publish the report?', answer: 'No' },
    { question: 'Should we keep the report private?', answer: 'Yes' },
  ]) }] });
  ingest.run(p.cfg, { mode: 'all' }, s);
  const rows = s.turnsForSession(`codex:${cx.THREAD}`);
  assert.deepEqual(rows.filter(r => r.role === 'user').map(r => r.body), ['No', 'Yes']);
  assert.ok(rows.filter(r => r.role === 'assistant').every(r => r.origin === 'reference'));
  const right = decide.record(s, p.cfg, input({ quote: 'Yes', contextQuote: 'Should we keep the report private?', statement: 'Owner approved keeping the report private' }));
  assert.equal(right.status, 'active');
  const wrong = decide.record(s, p.cfg, input({ quote: 'Yes', contextQuote: 'Should we publish the report?', statement: 'Owner approved publishing the report' }));
  assert.equal(wrong.status, 'pending');
  const stolen = decide.record(s, p.cfg, input({ quote: 'publish the report', contextQuote: null, statement: 'Owner approved report publication' }));
  assert.equal(stolen.status, 'pending');
  const owner = rows.find(r => r.body === 'Yes');
  assert.equal(owner.ts, `${DAY}T14:00:01.000Z`);
  assert.equal(owner.item_key, 'widget-pairs');
  assert.equal(owner.origin, 'direct');
});

test('laptop parser: wrapper combinations keep context; inherited and agent-created openings never gain owner authority', t => {
  const p = fixture(t);
  const lines = cx.build({ thread: cx.THREAD, cwd: p.root, day: DAY, items: [{ kind: 'user', id: 'combined',
    text: '<in-app-browser-context>not owner words</in-app-browser-context>' + wrap([choice]) }] });
  const rec = JSON.parse(lines[1]);
  const ctx = { thread: cx.THREAD, session: cx.THREAD, segment: '', inheritedBelow: 0 };
  const docs = adapter.recordToDocs(rec, ctx, 'laptop-fixture', adapter.newStats());
  assert.equal(docs.length, 2);
  assert.equal(docs[0].body, choice.question);
  assert.equal(docs[1].body, choice.answer);
  const replay = adapter.recordToDocs(rec, { ...ctx, inheritedBelow: 99, parent: 'parent-thread' }, 'laptop-fixture', adapter.newStats());
  assert.ok(replay.every(d => d.origin === 'reference'));
  const opening = { ...ctx, openingPending: true };
  const created = adapter.recordToDocs(rec, opening, 'laptop-fixture', adapter.newStats());
  assert.ok(created.every(d => d.origin === 'reference'));
  assert.equal(opening.openingPending, false);
});

test('laptop recovery: full re-ingest restores skipped widget evidence without replacing IDs or backdating a workaround', async t => {
  const p = fixture(t), s = p.store;
  cx.write(p.file, { thread: cx.THREAD, cwd: p.root, day: DAY, items: [
    { kind: 'user', id: 'ordinary', text: 'Keep this ordinary record intact.' },
    { kind: 'user', id: 'widget', text: wrap([choice]) },
    { kind: 'assistant', id: 'later', ts: `${DAY}T14:30:00.000Z`, text: 'Later activity, not owner approval.' },
  ] });
  // Reproduce the old parser's discard while keeping its completed checkpoint.
  const parse = adapter.recordToDocs;
  try {
    adapter.recordToDocs = (rec, ...args) => JSON.stringify(rec.payload?.content || []).includes('send_user_message_question_reply') ? [] : parse(rec, ...args);
    ingest.run(p.cfg, { mode: 'all' }, s);
  } finally { adapter.recordToDocs = parse; }
  const original = s.turnsForSession(`codex:${cx.THREAD}`).map(r => [r.id, r.body, r.sha]);
  const d = decide.record(s, p.cfg, input());
  decide.linkPending(s);
  assert.equal(s.getDoc(d.id).status, 'unverified');
  assert.match(s.getDoc(d.id).body, /UNVERIFIED:/);
  assert.doesNotMatch(s.getDoc(d.id).body, /PENDING:/);
  assert.equal(ingest.run(p.cfg, { mode: 'new' }, s).turns, 0, 'incremental import alone does not reread old bytes');
  const repair = ingest.run(p.cfg, { mode: 'all' }, s);
  assert.equal(repair.decisions.linked, 1);
  assert.equal(repair.turns, 2, 'only the recovered question and answer are new');
  for (const [id, body, sha] of original) assert.deepEqual([s.getDoc(id).body, s.getDoc(id).sha], [body, sha]);
  const linked = s.getDoc(d.id);
  assert.equal(linked.status, 'active');
  assert.equal(linked.ts, `${DAY}T14:00:02.000Z`);
  assert.equal(ingest.run(p.cfg, { mode: 'all' }, s).turns, 0, 'repeat repair creates no duplicates');
  const found = await recall.execute('find', { query: 'Amber Kite', who: 'owner', kind: 'turn', words: true, on: DAY }, { root: p.root });
  assert.equal(found.rows.length, 1);
  assert.equal(found.rows[0].text, choice.answer);
});

test('laptop status: Read corrects old stale PENDING prose without writing; result text respects stored status', async t => {
  const p = fixture(t), s = p.store;
  const d = decide.record(s, p.cfg, input());
  s.setStatus(d.id, 'unverified'); // old transition changed status, not the prose
  assert.match(s.getDoc(d.id).body, /PENDING:/);
  const before = { ...s.getDoc(d.id) };
  const read = await recall.execute('read', { id: d.id }, { root: p.root });
  assert.equal(read.status, 'unverified');
  assert.match(read.text, /UNVERIFIED:/); assert.doesNotMatch(read.text, /PENDING:/);
  assert.deepEqual({ ...s.getDoc(d.id) }, before);
  const duplicate = decide.record(s, p.cfg, input());
  assert.equal(duplicate.duplicate, true);
  assert.match(decide.resultText(duplicate), /^UNVERIFIED:/);
  assert.equal(decide.resultText({ status: 'active', evidence: [2, 3] }), 'linked to T2, T3');
});

test('laptop parser: malformed reply payload warns instead of certifying complete coverage', t => {
  const p = fixture(t), s = p.store;
  cx.write(p.file, { thread: cx.THREAD, cwd: p.root, day: DAY, items: [
    { kind: 'user', id: 'ordinary', text: 'A normal owner message.' },
    { kind: 'user', id: 'bad-widget', text: '<send_user_message_question_reply>{bad JSON}</send_user_message_question_reply>' },
  ] });
  const r = ingest.run(p.cfg, { mode: 'all' }, s);
  assert.equal(r.codex.badQuestionReplies, 1);
  assert.match(r.warnings.join('\n'), /question reply/);
  assert.equal(r.receipt.coverage_complete, false);
  const next = ingest.run(p.cfg, { mode: 'new' }, s);
  assert.match(next.warnings.join('\n'), /question reply/);
  assert.equal(next.receipt.coverage_complete, false, 'an empty incremental pass must not hide the earlier gap');
});

test('laptop launcher: PowerShell runs the reviewed Windows template with spaces, apostrophes and real stdin', { skip: process.platform !== 'win32' }, t => {
  const p = fixture(t);
  const template = JSON.parse(fs.readFileSync(path.join(__dirname, '../hooks/codex-hooks.snippet.json'), 'utf8'));
  const commands = Object.values(template.hooks).flatMap(entries => entries.flatMap(entry => entry.hooks.map(h => h.commandWindows)));
  assert.equal(new Set(commands).size, 1, 'all three events use the same launcher');
  const quotePath = v => v.replace(/\\/g, '/').replace(/'/g, "''");
  const script = path.resolve(__dirname, '../bin/total_recall.js');
  const command = `$env:TOTAL_RECALL_HOME = '${quotePath(path.join(p.root, '.recall'))}'; ` + commands[0]
    .replace('C:/Program Files/nodejs/node.exe', quotePath(process.execPath))
    .replace('C:/tools/total_recall/bin/total_recall.js', quotePath(script));
  const payload = { cwd: p.root, session_id: 'synthetic-laptop-task', hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: {} };
  const run = (cmd, data) => spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], { cwd: p.root, input: JSON.stringify(data), encoding: 'utf8', timeout: 15000 });
  const broken = run(`set "TOTAL_RECALL_HOME=${path.join(p.root, '.recall')}" && "${process.execPath}" "${script}" codex-hook`, payload);
  assert.notEqual(broken.status, 0); assert.equal(broken.stdout.trim(), '');
  const denied = run(command, payload);
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const posted = run(command, { ...payload, hook_event_name: 'PostToolUse', tool_name: 'mcp__total_recall__recall_search',
    tool_response: { total_recall: { tool: 'recall_search', ok: true, project: 'laptop-fixture' } } });
  assert.equal(posted.status, 0, posted.stderr);
  const allowed = run(command, payload);
  assert.equal(allowed.status, 0, allowed.stderr); assert.equal(allowed.stdout.trim(), '');
});
