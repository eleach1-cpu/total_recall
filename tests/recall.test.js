'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { openStore } = require('../lib/store');
const { loadConfig } = require('../lib/config');
const recall = require('../lib/recall');
const rd = require('../lib/recall-db');
const meaning = require('../lib/recall-meaning');
const dates = require('../lib/recall-dates');
const mcp = require('../lib/mcp');
const gate = require('../lib/gate');
process.env.TOTAL_RECALL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-gates-'));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-retrieval-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roots = ['alpha','beta'].map((s) => path.join(dir,s));
  const file = path.join(dir,'shared.sqlite'), registry = path.join(dir,'projects.json');
  for (const [i, root] of roots.entries()) {
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root,'total_recall.json'), JSON.stringify({ project: i ? 'beta' : 'alpha', transcripts: 'transcripts', store: file, projectAliases: i ? ['Second'] : ['Platform'], projectRegistry: registry, timezone: 'America/New_York' }));
  }
  fs.writeFileSync(registry, JSON.stringify({ projects: roots.map((root) => ({ root })) }));
  const cfg = loadConfig(roots[0]), s = openStore(file), ids = {};
  const put = (name, opts = {}) => {
    const d = { project: 'alpha', kind: 'turn', status: 'active', session_id: 'codex:one', source_client: 'codex', origin: 'direct', role: 'user', ts: '2026-09-18T12:00:00Z', title: name, body: name, ...opts };
    ids[name] = s.insertDoc(d).id; return ids[name];
  };
  put('reference', { ts: '2020-01-01T00:00:00Z', origin: 'reference' });
  put('earliest original', { ts: '2026-08-01T01:00:00+02:00', body: 'A first original request.' });
  put('lexically earlier but actually later', { ts: '2026-08-01T00:00:00Z' });
  put('other client', { session_id: 'one', source_client: 'claude', ts: '2026-07-01T00:00:00Z' });
  put('foreign', { project: 'beta', session_id: 'codex:foreign', body: 'secret project beta migraine DBQ', ts: '2010-01-01T00:00:00Z' });
  put('assistant reply', { session_id: 'one', source_client: 'claude', role: 'assistant', body: 'Claude explains the limits.', ts: '2026-08-31T18:00:00Z' });
  put('questionnaire', { body: 'DBQ narrative migraines with missing history.', files_json: JSON.stringify(['src/claim-check.js']), ts: '2026-09-18T03:59:59.999Z' });
  put('late same day', { body: 'migraines video', ts: '2026-09-18T23:59:00-04:00' });
  put('following day', { body: 'DBQ narrative', ts: '2026-09-19T00:00:00-04:00' });
  put('bad time', { ts: 'not-a-date' });
  put('unknown provenance', { origin: null, ts: '2000-01-01T00:00:00Z' });
  put('long source', { body: 'Opening.\n\n' + 'ordinary detail '.repeat(600) + '\n\nPreserve the full crest rather than lettering alone.\nLast line.', ts: '2026-06-01T00:00:00Z' });
  put('standing', { kind: 'statement', who: 'owner', outcome: 'standing', role: null, quote: 'Keep the full crest.', body: 'Keep the full crest.', evidence_ids: JSON.stringify([ids['long source']]), path: 'decide:codex', origin: 'decision' });
  put('rejected', { kind: 'statement', who: 'owner', outcome: 'rejected', role: null, body: 'No plain lettering.', quote: 'No plain lettering.', evidence_ids: JSON.stringify([ids['long source']]) });
  put('open', { kind: 'statement', who: 'owner', outcome: 'open', role: null, body: 'Need to choose a size.' });
  put('tool record', { origin: 'tool', body: '(tool-only turn: Edit) a.js' });
  s.close();
  const ctx = { root: roots[0], registryFile: registry, now: Date.parse('2026-09-19T16:00:00Z') };
  const find = (a = {}, c = {}) => recall.execute('search', { words: true, ...a }, { ...ctx, ...c });
  return { dir, cfg, ids, put, ctx, roots, registry, file, find };
}

test('A1/A2: earliest/latest without words, original provenance, real instant order and project/client/speaker filters', async (t) => {
  const p = fixture(t);
  const r = await p.find({ project: 'Platform', kind: 'turn', client: 'codex', who: 'owner', direct: true, order: 'oldest', limit: 1 });
  // The long source is genuinely earlier; no keyword invented to hide it.
  assert.equal(r.rows[0].id, p.ids['long source']);
  const aug = await p.find({ kind: 'turn', direct: true, client: 'codex', who: 'owner', since: '2026-07', order: 'oldest', limit: 1 });
  assert.equal(aug.rows[0].id, p.ids['earliest original']);
  assert.match(r.notes.join(' '), /unknown direct-message provenance/);
  const latest = await p.find({ who: 'claude', before: '2026-09-01', order: 'newest', limit: 1 });
  assert.equal(latest.rows[0].id, p.ids['assistant reply']);
  await assert.rejects(p.find({ project: 'missing', browse: true }), /unknown project/);
  await assert.rejects(p.find({ project: 'beta', root: p.roots[0], browse: true }), /different projects/);
  assert.equal((await p.find({ project: 'Second', browse: true })).rows[0].id, p.ids.foreign);
});

test('A3: real calendar validation, local days, DST and stable relative-date paging', async (t) => {
  const p = fixture(t);
  const r = await p.find({ on: 'yesterday', order: 'oldest', limit: 1 });
  assert.equal(r.resolved_dates.lo, Date.parse('2026-09-18T04:00:00Z'));
  const ids = [];
  let page = r;
  do { ids.push(...page.rows.map((d) => d.id)); page = page.next ? await recall.execute('search', { cursor: page.next }, { ...p.ctx, now: Date.parse('2026-12-01T00:00:00Z') }) : null; } while (page);
  assert.ok(ids.includes(p.ids['late same day']));
  assert.ok(!ids.includes(p.ids.questionnaire));
  assert.ok(!ids.includes(p.ids['following day']));
  for (const value of ['2026-02-30','2026-13','2026-00-10']) await assert.rejects(p.find({ on: value }), /invalid calendar/);
  await assert.rejects(p.find({ since: '2026-09', until: '2026-08' }), /reversed/);
  await assert.rejects(p.find({ on: '2026-09', timezone: 'Mars/Now' }), /invalid timezone/);
  await assert.rejects(p.find({ order: 'oldest', newest: true, browse: true }), /conflicting/);
  assert.equal(dates.period('2026-03-08','America/New_York').end - dates.period('2026-03-08','America/New_York').start, 23 * 3600000);
  assert.equal(dates.period('2026-11-01','America/New_York').end - dates.period('2026-11-01','America/New_York').start, 25 * 3600000);
});

test('A4/A5: outcome inventory, Boolean/prefix/NEAR, phrase and order-independent matching', async (t) => {
  const p = fixture(t);
  for (const outcome of ['standing','rejected','open']) assert.equal((await p.find({ outcome })).counts.decisions, 1);
  const prefix = await p.find({ query: 'migr* NOT video', match: 'advanced' });
  assert.deepEqual(prefix.rows.map((d) => d.id), [p.ids.questionnaire]);
  const near = await p.find({ query: 'NEAR(DBQ narrative, 10)', match: 'advanced' });
  assert.equal(near.counts.messages, 2);
  await assert.rejects(p.find({ query: 'migraine AND (', match: 'advanced' }), /invalid full-text expression/);
  const set = async (order, match) => (await p.find({ query: 'DBQ video', match, order })).rows.map((d) => d.id).sort();
  assert.deepEqual(await set('oldest','any'), await set('newest','any'));
  assert.equal((await set('oldest','all')).length, 0);
  assert.equal((await p.find({ query: 'missing history', match: 'phrase' })).counts.records, 1);
  await assert.rejects(p.find({ query: '"unfinished' }), /unfinished/);
  await assert.rejects(recall.execute('search', {}, p.ctx), /give words/);
});

test('A6: bounded substring, escaped wildcard, path filter and resumable no-match batches', async (t) => {
  const p = fixture(t);
  assert.equal(recall.wildcard('abc*def', 'abc\\*d?f'), true);
  assert.equal(recall.wildcard('ordinary', 'x*'), false);
  assert.equal(recall.wildcard('ab😀cd', 'ab?cd'), true);
  const r = await p.find({ query: '*missing hist?ry*', match: 'substring' }, { scanRows: 2 });
  assert.equal(r.partial, true); assert.equal(r.rows.length, 0); assert.ok(r.next);
  const ids = []; let page = r, loops = 0;
  do { ids.push(...page.rows.map((d) => d.id)); page = page.next ? await recall.execute('search', { cursor: page.next }, { ...p.ctx, scanRows: 2 }) : null; assert.ok(++loops < 30); } while (page);
  assert.deepEqual(ids, [p.ids.questionnaire]);
  assert.equal((await p.find({ files: 'src/*check.?s', browse: true })).rows[0].id, p.ids.questionnaire);
  await assert.rejects(p.find({ query: 'x\\', match: 'substring' }), /unfinished escape/);
});

test('A7/A11: exact long text, context scope, session paging, revisions and count units', async (t) => {
  const p = fixture(t);
  let r = await recall.execute('read', { id: p.ids['long source'], chars: 500, before: 1, after: 1 }, p.ctx);
  let body = r.text;
  while (r.next) { r = await recall.execute('read', { cursor: r.next }, p.ctx); body += r.text; }
  const db = rd.open(p.cfg); const expected = rd.doc(db, p.ids['long source']).body; db.close();
  assert.equal(body, expected); assert.match(body, /\nLast line\.$/);
  await assert.rejects(recall.execute('read', { id: p.ids.foreign }, p.ctx), /not found/);
  await assert.rejects(recall.execute('read', { session: 'one' }, p.ctx), /ambiguous/);
  let page = await recall.execute('read', { session: 'codex:one', limit: 2 }, p.ctx);
  const ids = [];
  do { ids.push(...page.rows.map((d) => d.id)); page = page.next ? await recall.execute('read', { cursor: page.next }, p.ctx) : null; } while (page);
  assert.equal(new Set(ids).size, ids.length); assert.ok(!ids.includes(p.ids.foreign)); assert.ok(!ids.includes(p.ids['other client']));
  const count = await p.find({ query: '*', limit: 1 });
  assert.equal(count.counts.decisions, 3); assert.ok(count.counts.records > count.counts.messages);
  await assert.rejects(recall.execute('search', { cursor: count.next, query: 'different' }, p.ctx), /cursor alone/);
  const s = openStore(p.file); s.insertDoc({ project: 'alpha', kind: 'memory', ts: '2026-09-20T00:00:00Z', title: 'new', body: 'new' }); s.close();
  await assert.rejects(recall.execute('search', { cursor: count.next }, p.ctx), /collection changed/);
});

test('A8/A12: registry/session/coverage inventory, unknown stays unknown, no source scan', async (t) => {
  const p = fixture(t);
  const projects = await recall.execute('inventory', { what: 'projects' }, p.ctx);
  assert.deepEqual(projects.projects.map((d) => d.project), ['alpha','beta']);
  const r = await recall.execute('inventory', { what: 'sessions', client: 'codex', limit: 1 }, p.ctx);
  assert.equal(r.count, 1); assert.equal(r.sessions[0].session, 'codex:one');
  const c = await recall.execute('inventory', {}, p.ctx);
  assert.equal(c.last_completed_ingest, null); assert.equal(c.unregistered_or_missing_sources, null);
  assert.equal(c.meaning.chunk_indexed_records, 0);
  assert.ok(c.imported.records > 1);
});

const fakeEncoder = { version: 'fixture-v1', async embed(texts) { return texts.map((s) => /crest|emblem/i.test(s) ? [1,0] : [0,1]); } };
test('A9/A10: full-text semantic chunks find a paraphrase beyond character 6000, preserve hard filters and reject stale model/index pages', async (t) => {
  const p = fixture(t);
  const s = rd.open(p.cfg);
  const before = fs.readFileSync(p.file);
  await meaning.build(s, { limit: 100 }, { encoder: fakeEncoder });
  s.close();
  assert.deepEqual(fs.readFileSync(p.file), before, 'sidecar indexing never rewrites source store');
  const r = await recall.execute('search', { query: 'retain emblem', mode: 'meaning', order: 'oldest', kind: 'turn', who: 'owner', client: 'codex', direct: true }, { ...p.ctx, encoder: fakeEncoder });
  assert.equal(r.rows[0].id, p.ids['long source']);
  assert.ok(r.meaning.verified_complete_for_query > 0);
  assert.match(r.earliest_scope, /not a proven first-ever/);
  const hard = await recall.execute('search', { query: 'unseenword', match: 'all', mode: 'meaning' }, { ...p.ctx, encoder: fakeEncoder });
  assert.equal(hard.rows.length, 0);
  const second = rd.open(p.cfg); const again = await meaning.build(second, { limit: 100 }, { encoder: fakeEncoder }); second.close();
  assert.equal(again.embedded_records, 0, 'resume skips unchanged complete chunks');
  const src = openStore(p.file); src.putVector(p.ids.questionnaire, 'nomic-embed-text', [1,0]); src.close();
  const missing = await recall.execute('search', { query: 'emblem', mode: 'meaning' }, { ...p.ctx, encoder: { ...fakeEncoder, version: 'changed-model' } });
  assert.match(missing.notes.join(' '), /lack verified full-text/);
});

test('read paths never create stores and CLI/MCP use the same engine and real caller gate', async (t) => {
  const p = fixture(t);
  const input = { kind: 'turn', client: 'codex', who: 'owner', direct: true, order: 'oldest', words: true, limit: 1 };
  const expected = await p.find(input);
  const actual = await mcp.callTool('recall_search', input, { ...p.ctx, env: { CLAUDE_CODE_SESSION_ID: 'session-here' }, client: 'claude' });
  assert.equal(actual.data.rows[0].id, expected.rows[0].id); assert.equal(gate.isOpen('alpha', 'session-here'), true);
  const foreign = await mcp.callTool('recall_search', { project: 'beta', browse: true, words: true }, { ...p.ctx, env: { CLAUDE_CODE_SESSION_ID: 'other-gate' }, client: 'claude' });
  assert.equal(foreign.meta.project, 'beta'); assert.equal(gate.isOpen('alpha','other-gate'), false); assert.equal(gate.isOpen('beta','other-gate'), false);
  const out = execFileSync(process.execPath, [path.join(__dirname, '../bin/total_recall.js'), 'search', '--root', p.roots[0], '--kind', 'turn', '--client', 'codex', '--who', 'owner', '--direct', '--oldest', '--words', '--limit', '1', '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(out).rows[0].id, expected.rows[0].id);
  const missing = path.join(p.dir,'not-created','missing.sqlite');
  assert.throws(() => rd.open({ ...p.cfg, store: missing }), /unable to open/); assert.equal(fs.existsSync(path.dirname(missing)), false);
  assert.throws(() => meaning.indexFile({ ...p.cfg, search: { index: p.file } }), /separate from/);
  const store = openStore(p.file, { readOnly: true });
  assert.throws(() => store.insertDoc({ project: 'alpha', kind: 'memory', title: 'oops', body: 'oops', ts: 'now' }), /readonly/); store.close();
});

test('replacements, conflicts and deep/brief stay inside their project, without rewriting evidence', async (t) => {
  const p = fixture(t), s = openStore(p.file);
  const { DatabaseSync } = require('node:sqlite');
  s.close();
  const db = new DatabaseSync(p.file);
  db.prepare('UPDATE docs SET superseded_by=? WHERE id=?').run(p.ids.rejected,p.ids.standing);
  db.prepare('INSERT INTO link_verdicts VALUES (?,?,?,?,?)').run(p.ids.rejected,p.ids.open,'owner-decision-conflict','owner',0);
  db.close();
  assert.equal((await p.find({ outcome: 'standing' })).counts.records, 0);
  const all = await p.find({ outcome: 'standing', include_superseded: true, deep: true });
  assert.equal(all.rows[0].superseded_by, p.ids.rejected); assert.ok(all.deep[0].open);
  const conflict = await p.find({ outcome: 'rejected' }); assert.equal(conflict.rows[0].relations.length, 1);
  const brief = await recall.execute('brief', {}, p.ctx); assert.doesNotMatch(brief.brief, /secret project beta/);
});

test('substring character-budget continuation does not skip/duplicate rows after batch sorting', async (t) => {
  const p = fixture(t);
  let r = await p.find({ query: '*', match: 'substring', order: 'newest', chars: 500, limit: 3 });
  const seen = []; let pages = 0;
  do { seen.push(...r.rows.map((d) => d.id)); r = r.next ? await recall.execute('search', { cursor: r.next }, p.ctx) : null; assert.ok(++pages < 30); } while (r);
  const expected = await p.find({ query: '*', order: 'newest', limit: 100 });
  assert.deepEqual([...seen].sort((a,b)=>a-b), expected.rows.map((d)=>d.id).sort((a,b)=>a-b));
  assert.equal(new Set(seen).size, seen.length);
});

test('interrupted chunk indexing resumes and never labels partial or stale source as complete', async (t) => {
  const p = fixture(t);
  let calls = 0;
  const unstable = { ...fakeEncoder, async embed(texts, prefix) { if (++calls === 3) throw new Error('interrupted'); return fakeEncoder.embed(texts,prefix); } };
  let store = rd.open(p.cfg);
  await assert.rejects(meaning.build(store, { limit: 100 }, { encoder: unstable }), /interrupted/);
  assert.ok(meaning.coverage(store).missing_or_incomplete > 0);
  await meaning.build(store, { limit: 100 }, { encoder: fakeEncoder });
  store.close();
  const before = await recall.execute('search', { query: 'emblem', mode: 'meaning', limit: 1 }, { ...p.ctx, encoder: fakeEncoder });
  assert.ok(before.next);
  await assert.rejects(recall.execute('search', { cursor: before.next }, { ...p.ctx, encoder: { ...fakeEncoder, version: 'new-model' } }), /meaning index/);
  const fallback = await recall.execute('search', { query: 'crest', mode: 'meaning' }, { ...p.ctx, encoder: { version: 'offline', async embed() { throw new Error('model offline'); } } });
  assert.equal(fallback.meaning.enabled, false); assert.match(fallback.notes.join(' '), /words only/);
  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(p.file);
  db.prepare('UPDATE docs SET body=body || ? WHERE id=?').run(' changed',p.ids['long source']); db.close();
  store = rd.open(p.cfg); assert.ok(meaning.coverage(store).missing_or_incomplete > 0); store.close();
});

test('Recall is a first-class natural-memory orchestrator above Find and Read', async (t) => {
  const p = fixture(t);
  const decision = await recall.execute('recall', { request: 'What did we decide about the full crest?', limit: 10 }, p.ctx);
  assert.equal(decision.operation, 'recall');
  assert.equal(decision.intent, 'decision');
  assert.ok(decision.orchestration.some((x) => x.lane === 'source-history'));
  assert.ok(decision.evidence.some((x) => x.id === p.ids.standing));
  assert.match(decision.source_of_truth, /Authoritative imported records/);
  assert.match(decision.source_of_truth, /sidecar is disposable and rebuildable/);
  assert.match(decision.synthesis_contract, /coherent recollection/);

  const continuation = await recall.execute('recall', { request: 'Continue what we were doing', client: 'codex' }, p.ctx);
  assert.equal(continuation.intent, 'continue');
  assert.ok(continuation.orchestration.some((x) => x.lane === 'recent-context'));
  assert.ok(continuation.evidence.length > 0);

  const found = await recall.execute('find', { query: 'crest', kind: 'turn', words: true }, p.ctx);
  assert.equal(found.rows[0].id, p.ids['long source']);
  const coverage = await recall.execute('inspect-coverage', {}, p.ctx);
  assert.equal(coverage.last_completed_ingest, null);
});

test('MCP exposes Recall separately from explicit Find/Search, Read and Coverage', async (t) => {
  const p = fixture(t);
  const names = mcp.TOOLS.map((x) => x.name);
  for (const name of ['recall_recall','recall_search','recall_read','recall_inventory']) assert.ok(names.includes(name));
  const out = await mcp.callTool('recall_recall', { request: 'Why did we keep the full crest?' }, { ...p.ctx, env: {}, client: 'codex' });
  assert.equal(out.meta.ok, true);
  assert.equal(out.data.operation, 'recall');
  assert.equal(out.data.intent, 'rationale');
});

function story(p) {
  const s = openStore(p.file);
  let n = 0;
  const put = (body, extra = {}) => s.insertDoc({ project: 'alpha', kind: 'turn', status: 'active',
    session_id: 'codex:sidecar', source_client: 'codex', origin: 'direct', role: 'user',
    ts: `2026-09-10T12:${String(n++).padStart(2, '0')}:00Z`, title: body, body, ...extra }).id;
  const problem = put('The conversation store must remain untouched.');
  const proposal = put('Option A rewrites the conversation database. Option B uses a sidecar. It avoids a source migration.', { role: 'assistant' });
  const approval = put('Go with B. That keeps the original words safe.');
  const implemented = put('I implemented the sidecar reader. It opens the source read-only.', { role: 'assistant' });
  const waiting = put('Do not activate it yet. I need to review it.');
  const decision = put('Sidecar choice approved.', { kind: 'statement', role: null, who: 'owner', outcome: 'approved', origin: 'decision', path: 'decide:codex', quote: 'Go with B. That keeps the original words safe.', evidence_ids: JSON.stringify([proposal, approval]) });
  const handoff = put('Sidecar is built locally. Activation awaits owner review.', { kind: 'handoff', role: null, origin: 'file', source_client: null, session_id: null });
  const foreign = put('SECRET sidecar choice from another project', { project: 'beta' });
  s.close();
  return { problem, proposal, approval, implemented, waiting, decision, handoff, foreign };
}

test('Recall opens a short approval with its proposal, reason and later implementation, without editing sources', async (t) => {
  const p = fixture(t), ids = story(p), before = fs.readFileSync(p.file);
  const r = await recall.execute('recall', { request: 'Why did we choose a sidecar?', words: true }, p.ctx);
  const seen = new Map(r.evidence.map((e) => [e.id, e]));
  for (const id of [ids.problem, ids.proposal, ids.approval, ids.implemented, ids.decision]) assert.ok(seen.has(id), `opened #${id}`);
  assert.equal(seen.get(ids.approval).text, 'Go with B. That keeps the original words safe.');
  assert.equal(seen.get(ids.implemented).speaker, 'codex');
  assert.match(seen.get(ids.decision).text, /EXACT QUOTE[\s\S]*INTERPRETATION/);
  assert.ok(r.evidence.every((e) => e.project === 'alpha'));
  assert.doesNotMatch(JSON.stringify(r), /SECRET sidecar/);
  assert.match(recall.format(r), /Go with B\. That keeps the original words safe/);
  assert.equal(r.coverage.last_completed_ingest, null);
  assert.deepEqual(fs.readFileSync(p.file), before);
  assert.equal(fs.existsSync(`${p.file}.search.sqlite`), false);
});

test('Recall instruction questions retain one-off approvals and open both sides of a conflict and replacements', async (t) => {
  const p = fixture(t), ids = story(p), { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(p.file);
  db.prepare('INSERT INTO link_verdicts VALUES (?,?,?,?,?)').run(ids.decision, p.ids.open, 'owner-decision-conflict', 'owner', 0);
  db.prepare('UPDATE docs SET superseded_by=? WHERE id=?').run(p.ids.rejected, p.ids.open);
  // Invalid cross-project evidence is excluded even if a stored relation points at it.
  db.prepare('INSERT INTO link_verdicts VALUES (?,?,?,?,?)').run(ids.decision, ids.foreign, 'owner-decision-conflict', 'owner', 0);
  db.close();
  const r = await recall.execute('recall', { request: 'What have I told you about the sidecar?', words: true }, p.ctx);
  const seen = new Map(r.evidence.map((e) => [e.id, e]));
  assert.ok(seen.has(ids.decision), 'one-off approved instruction is not excluded by standing-only filter');
  assert.equal(seen.get(p.ids.open).via, 'conflict');
  assert.equal(seen.get(p.ids.rejected).via, 'replacement');
  assert.ok(!seen.has(ids.foreign));
  assert.equal(seen.get(p.ids.open).superseded_by, p.ids.rejected);
});

test('Recall resolves last week and project-wide overview without inventing search words; hints preserve scope', async (t) => {
  const p = fixture(t), ids = story(p);
  const r = await recall.execute('recall', { request: 'Continue what we were doing last week', words: true }, p.ctx);
  assert.equal(r.query, '');
  assert.equal(r.resolved_dates.lo, Date.parse('2026-09-07T04:00:00Z'));
  assert.equal(r.resolved_dates.hi, Date.parse('2026-09-14T04:00:00Z'));
  assert.ok(r.evidence.some((e) => e.id === ids.handoff));
  assert.ok(r.evidence.some((e) => e.id === ids.waiting));
  const overview = await recall.execute('recall', { request: 'What do you remember about our Platform project?', project: 'Platform', words: true }, p.ctx);
  assert.equal(overview.query, ''); assert.equal(overview.intent, 'overview');
  const filtered = await recall.execute('recall', { request: 'Our discussion before the weekend', topic: 'sidecar', intent: 'rationale', project: 'Platform', who: 'owner', client: 'codex', on: '2026-09-10', words: true }, p.ctx);
  for (const lane of filtered.orchestration) for (const hit of lane.rows) {
    assert.equal(hit.project, 'alpha'); assert.equal(hit.client, 'codex'); assert.equal(hit.speaker, 'owner');
  }
  // Linked proposals may have another speaker; the relation is explicit, not a broadened search.
  assert.equal(filtered.evidence.find((e) => e.id === ids.proposal).via, 'linked-source');
});

test('Recall finds semantic-only long-message detail and shares one embedding across lanes', async (t) => {
  const p = fixture(t), s = rd.open(p.cfg);
  await meaning.build(s, { limit: 100 }, { encoder: fakeEncoder }); s.close();
  let calls = 0;
  const encoder = { ...fakeEncoder, async embed(...args) { calls++; return fakeEncoder.embed(...args); } };
  const r = await recall.execute('recall', { request: 'Do you remember retaining the emblem?', topic: 'retain emblem', mode: 'meaning', chars: 18000 }, { ...p.ctx, encoder });
  assert.equal(calls, 1);
  const original = r.evidence.find((e) => e.id === p.ids['long source']);
  assert.ok(original.offset > 6000);
  assert.match(original.text, /Preserve the full crest/);
  assert.equal(original.unread_before, true);
  let failed = 0;
  const fallback = await recall.execute('recall', { request: 'Remember the crest?', topic: 'crest' }, { ...p.ctx, encoder: { version: 'offline', async embed() { failed++; throw new Error('offline'); } } });
  assert.equal(failed, 1);
  assert.match(fallback.limitations.join(' '), /words only/);
  assert.ok(fallback.evidence.length > 0);
});

test('Recall small budgets leave usable Read/Find continuations and never hide unavailable evidence', async (t) => {
  const p = fixture(t); story(p);
  const r = await recall.execute('recall', { request: 'Catch me up', topic: '', chars: 1000, limit: 1, words: true }, p.ctx);
  assert.equal(r.partial, true); assert.ok(r.text_budget.used <= 1000);
  assert.ok(r.unopened.length || r.evidence.some((e) => e.next) || r.orchestration.some((l) => l.next));
  for (const lane of r.orchestration.filter((l) => l.next)) {
    const next = await recall.execute('find', { cursor: lane.next }, p.ctx); assert.equal(next.project, 'alpha');
  }
  const long = await recall.execute('recall', { request: 'Remember crest?', topic: 'crest', chars: 1000, words: true }, p.ctx);
  const original = long.evidence.find((e) => e.id === p.ids['long source']);
  if (original) assert.equal((await recall.execute('read', original.read, p.ctx)).id, original.id);
  const empty = await recall.execute('recall', { request: 'Remember zzzabsent?', topic: 'zzzabsent', words: true }, p.ctx);
  assert.equal(empty.evidence_status, 'no_matches'); assert.ok(empty.coverage.imported.records > 0);
  for (const bad of [{ on: '2026-02-30' }, { project: 'missing' }, { topic: 8 }, { intent: 'telepathy' }, { kind: 'turn' }]) {
    await assert.rejects(recall.execute('recall', { request: 'Remember sidecar?', words: true, ...bad }, p.ctx));
  }
});

test('Recall CLI/MCP/API agree and only successful same-project Recall acknowledges the real caller gate', async (t) => {
  const p = fixture(t); story(p);
  const input = { request: 'Why did we choose a sidecar?', topic: 'sidecar', words: true };
  const api = await recall.execute('recall', input, p.ctx);
  const cli = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '../bin/total_recall.js'), 'recall', input.request, '--topic', input.topic, '--words', '--root', p.roots[0], '--json'], { encoding: 'utf8' }));
  const result = await mcp.callTool('recall_recall', input, { ...p.ctx, client: 'claude', env: { CLAUDE_CODE_SESSION_ID: 'recall-here' } });
  assert.deepEqual(cli.evidence.map((d) => d.id), api.evidence.map((d) => d.id));
  assert.deepEqual(result.data.evidence.map((d) => d.id), api.evidence.map((d) => d.id));
  assert.equal(gate.isOpen('alpha', 'recall-here'), true);
  await mcp.callTool('recall_recall', { ...input, project: 'beta' }, { ...p.ctx, client: 'claude', env: { CLAUDE_CODE_SESSION_ID: 'recall-other' } });
  assert.equal(gate.isOpen('alpha', 'recall-other'), false);
  const invalid = await mcp.callTool('recall_recall', { ...input, on: '2026-99' }, { ...p.ctx, client: 'claude', env: { CLAUDE_CODE_SESSION_ID: 'recall-bad' } });
  assert.equal(invalid.meta.ok, false); assert.equal(gate.isOpen('alpha', 'recall-bad'), false);
  const hook = require('../lib/codex-hook');
  const snippet = JSON.parse(fs.readFileSync(path.join(__dirname, '../hooks/codex-hooks.snippet.json'), 'utf8'));
  const matcher = new RegExp(snippet.hooks.PostToolUse[0].matcher);
  assert.ok(matcher.test('mcp__total_recall__recall_recall')); assert.ok(matcher.test('mcp__total_recall__recall_search'));
  const post = (sid, meta) => hook.handle({ hook_event_name: 'PostToolUse', tool_name: 'mcp__total_recall__recall_recall', session_id: sid, cwd: p.roots[0], tool_response: { total_recall: meta } });
  post('codex-recall', result.meta); assert.equal(gate.isOpen('alpha', 'codex-recall', 'codex'), true);
  post('codex-bad', invalid.meta); assert.equal(gate.isOpen('alpha', 'codex-bad', 'codex'), false);
  post('codex-wrong', { ...result.meta, project: 'beta' }); assert.equal(gate.isOpen('alpha', 'codex-wrong', 'codex'), false);
  post('codex-spoof', { ...result.meta, tool: 'recall_search' }); assert.equal(gate.isOpen('alpha', 'codex-spoof', 'codex'), false);
});

test('Recall marks unselected candidate anchors partial even when each lane has no next page', async (t) => {
  const p = fixture(t), s = openStore(p.file);
  for (const kind of ['turn', 'statement', 'handoff']) for (let n = 0; n < 3; n++) {
    s.insertDoc({ project: 'alpha', kind, title: `uniquetopic ${kind} ${n}`, body: `uniquetopic ${kind} ${n}`,
      ts: '2026-09-18T00:00:00Z', role: 'user', who: 'owner', outcome: kind === 'statement' ? 'approved' : null,
      origin: kind === 'turn' ? 'direct' : 'file', source_client: 'codex', session_id: null });
  }
  s.close();
  const r = await recall.execute('recall', { request: 'Remember uniquetopic?', topic: 'uniquetopic', limit: 3, words: true }, p.ctx);
  assert.ok(r.orchestration.every((l) => l.next === null));
  assert.equal(r.evidence.length, 3); assert.equal(r.unopened.length, 6); assert.equal(r.partial, true);
  assert.deepEqual(new Set(r.evidence.map((e) => e.kind)), new Set(['statement','handoff','turn']));
  for (const h of r.unopened) assert.equal((await recall.execute('read', { project: h.project, id: h.id }, p.ctx)).id, h.id);
});

test('standing inventories exclude unclear interpretations without hiding their history', async (t) => {
  const p = fixture(t), s = openStore(p.file);
  const seed = { project: 'alpha', kind: 'statement', status: 'active', who: 'owner',
    source_client: 'codex', session_id: 'codex:one', origin: 'decision-unclear',
    path: 'decide:codex', ts: '2026-09-19T12:00:00Z', quote: 'Maybe keep this preference',
    body: 'uncertainpreference', title: 'uncertainpreference' };
  const unclear = s.insertDoc({ ...seed, outcome: 'standing' }).id;
  const rejected = s.insertDoc({ ...seed, outcome: 'rejected', title: 'uncertainrejection' }).id;
  s.close();
  const before = fs.readFileSync(p.file);
  const input = { outcome: 'standing', who: 'owner', client: 'codex', words: true };
  const rules = await recall.execute('find', input, p.ctx);
  assert.equal(rules.counts.decisions, 1);
  assert.ok(!rules.rows.some((d) => d.id === unclear));
  assert.match(rules.notes.join(' '), /UNCLEAR.*excluded/);
  const natural = await recall.execute('recall', { request: 'what are my rules', words: true }, p.ctx);
  assert.ok(!natural.orchestration[0].rows.some((d) => d.id === unclear));
  const history = await recall.execute('find', { query: 'uncertainpreference', words: true }, p.ctx);
  assert.ok(history.rows.some((d) => d.id === unclear));
  assert.match(recall.format(history), /UNCLEAR interpretation/);
  const mixed = await recall.execute('find', { ...input, outcome: 'standing,rejected' }, p.ctx);
  assert.ok(mixed.rows.some((d) => d.id === rejected));
  assert.ok(!mixed.rows.some((d) => d.id === unclear));
  const explicit = await recall.execute('find', { ...input, include_unclear: true }, p.ctx);
  assert.equal(explicit.counts.decisions, 2);
  assert.ok(explicit.rows.some((d) => d.id === unclear));
  const wire = await mcp.callTool('recall_search', { ...input, include_unclear: true }, p.ctx);
  assert.deepEqual(wire.data.rows.map((d) => d.id), explicit.rows.map((d) => d.id));
  const cli = JSON.parse(execFileSync(process.execPath, [path.resolve(__dirname, '../bin/total_recall.js'),
    'find', '--outcome', 'standing', '--who', 'owner', '--client', 'codex', '--words', '--include-unclear',
    '--root', p.roots[0], '--json'], { encoding: 'utf8' }));
  assert.deepEqual(cli.rows.map((d) => d.id), explicit.rows.map((d) => d.id));
  const opened = await recall.execute('read', { id: unclear }, p.ctx);
  assert.equal(opened.origin, 'decision-unclear');
  assert.match(recall.format(opened), /UNCLEAR interpretation/);
  const db = rd.open(p.cfg);
  try { assert.ok(!rd.briefView(db).standing(100).some((d) => d.id === unclear)); }
  finally { db.close(); }
  assert.deepEqual(fs.readFileSync(p.file), before, 'filtering never reclassifies or rewrites history');
});

test('imported memory-note rules are excerpts, not verified conversation quotes', async (t) => {
  const p = fixture(t), s = openStore(p.file), ids = [];
  for (const origin of [null, 'file']) ids.push(s.insertDoc({ project: 'alpha', kind: 'statement',
    status: 'active', who: 'owner', outcome: 'standing', origin, path: `notes/preference-${origin}.md`,
    title: `Preserve approved style ${origin}`, body: `The owner prefers keeping approved style (${origin}).`,
    quote: 'The owner prefers keeping approved style.', evidence_ids: '[]', ts: '2026-09-19T12:00:00Z' }).id);
  s.close();
  const before = fs.readFileSync(p.file);
  const found = await recall.execute('find', { query: 'style', outcome: 'standing', words: true }, p.ctx);
  assert.equal(found.counts.decisions, 2, 'notes are still available in the rules inventory');
  for (const row of found.rows) assert.equal(row.quote_kind, 'memory-note-excerpt');
  assert.doesNotMatch(recall.format(found), /Exact quote/);
  assert.match(recall.format(found), /not a verified owner quotation/);
  for (const id of ids) {
    const opened = await recall.execute('read', { id }, p.ctx);
    assert.match(opened.text, /^MEMORY-NOTE EXCERPT/);
    assert.match(opened.authority, /no linked conversation evidence/);
    assert.deepEqual(opened.evidence_ids, []);
  }
  const packet = await recall.execute('recall', { request: 'what are my rules about style', words: true }, p.ctx);
  assert.ok(packet.evidence.every((row) => row.quote_kind === 'memory-note-excerpt'));
  assert.doesNotMatch(recall.format(packet), /EXACT QUOTE/);
  const original = await recall.execute('read', { id: p.ids.standing }, p.ctx);
  assert.match(original.text, /^EXACT QUOTE/);
  assert.deepEqual(fs.readFileSync(p.file), before);
});
