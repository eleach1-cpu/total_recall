'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.TOTAL_RECALL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-phase2-home-'));
const { openStore } = require('../lib/store');
const ingest = require('../lib/ingest');
const distill = require('../lib/distill');
const search = require('../lib/search');
const link = require('../lib/link');
const mcp = require('../lib/mcp');
const gate = require('../lib/gate');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-phase2-'));
  fs.mkdirSync(path.join(root, 'transcripts')); fs.mkdirSync(path.join(root, 'docs'));
  const raw = { project: 'demo', transcripts: 'transcripts', sources: { map_section: 'docs/MAP*.md' }, store: 's.sqlite' };
  fs.writeFileSync(path.join(root, 'total_recall.json'), JSON.stringify(raw));
  return { root, cfg: require('../lib/config').loadConfig(root) };
}

const stmt = (store, id, ts, who, outcome, title, session = 's1') =>
  store.insertDoc({ project: 'demo', kind: 'statement', session_id: session, ts, title, body: title, who, outcome, quote: title, evidence_ids: `[${id}]`, path: 'distill:x' }).id;

test('fuzzy quote: a tidied quote passes and the TURN\'s wording is stored; a reordered or stretched one does not', () => {
  const turns = [{ id: 7, role: 'user', ts: '2026-09-10T10:00:00.000Z', body: 'ok so, derive it from the records please, and never, ever hardcode a count on that page again' }];
  const item = (quote) => ({ turn: 7, outcome: 'standing', statement: 'Never hardcode a count', quote, reason: null });
  const v = distill.validate(item('never hardcode a count on that page again'), turns); // model dropped ", ever"
  assert.equal(v.ok, true);
  assert.equal(v.statement.quote, 'never, ever hardcode a count on that page again');
  assert.equal(distill.validate(item('hardcode never a count on that page'), turns).ok, false, 'words out of order');
  assert.equal(distill.validate(item('derive it from the page again'), turns).ok, false, 'too many words skipped between neighbours');
  assert.equal(distill.validate(item('derive the records'), turns).ok, false, 'under four words is exact-match only');
  assert.equal(distill.validate(item('derive it'), turns).ok, true, 'an exact short quote still passes');
});

test('map sections: cut at ## and ###, an unchanged section keeps its row across edits, a changed one is struck', () => {
  const { root, cfg } = project();
  const map = path.join(root, 'docs', 'MAP-PAGES.md');
  const v1 = '# Map\n\n## Section 1: pages\n\nIntro text.\n\n### /reports (public/reports.html)\n\nReads report-data.json.\n\n### /orders\n\nReads the 2019 order list.\n';
  fs.writeFileSync(map, v1);
  const store = openStore(cfg.store);
  const r1 = ingest.run(cfg, { mode: 'new' }, store);
  assert.equal(r1.sections, 3);
  const ships1 = store.search('"order list"', { kinds: ['map_section'] })[0];
  fs.writeFileSync(map, v1.replace('Reads report-data.json.', 'Reads report-data.json and publishes data-report-kind.'));
  const r2 = ingest.run(cfg, { mode: 'new' }, store);
  assert.equal(r2.sections, 1, 'only the section whose words changed is a new row');
  assert.equal(r2.superseded, 1);
  const ships2 = store.search('"order list"', { kinds: ['map_section'] });
  assert.equal(ships2.length, 1, 'the untouched section is still found');
  assert.equal(ships2[0].id, ships1.id);
  const out = search.format(search.runSearch(store, cfg, { query: 'report-data' }), { query: 'report-data' });
  assert.match(out, /map_section \S+ MAP-PAGES\.md/, 'default search covers the map and names the file');
  assert.match(out, /data-report-kind/);
  store.close();
});

test('meaning lane: a paraphrase that shares no word is found, labelled, and held to the similarity floor', () => {
  const { cfg } = project();
  const store = openStore(cfg.store);
  const a = stmt(store, 1, '2026-09-01T10:00:00.000Z', 'owner', 'rejected', 'Owner refused the text-only brand mark');
  const b = stmt(store, 2, '2026-09-02T10:00:00.000Z', 'owner', 'approved', 'Owner approved the CSV download');
  const c = stmt(store, 3, '2026-09-03T10:00:00.000Z', 'owner', 'approved', 'Owner wants the logo kept as the full logo');
  store.putVector(a, 'nomic-embed-text', [1, 0, 0]);
  store.putVector(b, 'nomic-embed-text', [0, 1, 0]);
  store.putVector(c, 'nomic-embed-text', [0.9, 0.1, 0]);
  const opts = { query: 'logo', qvec: Float32Array.from([1, 0, 0]), vecModel: 'nomic-embed-text' };
  const hits = search.runSearch(store, cfg, opts).distilled;
  assert.deepEqual(hits.map((d) => d.id).sort(), [a, c], 'the CSV statement is under the floor and shares no word');
  const icon = hits.find((d) => d.id === a);
  assert.equal(icon.byMeaning, true);
  assert.match(search.format({ distilled: hits, raw: [], deepBlocks: [] }, opts), /~meaning 1\.00/);
  assert.equal(hits.find((d) => d.id === c).byMeaning, false, 'found by its words too, so not labelled');
  assert.equal(search.runSearch(store, cfg, { query: 'logo' }).distilled.length, 1, 'without a query vector it is words alone');
  store.close();
});

test('supersession links: likeness nominates, the judge decides once, and two approvals are never a pair', async () => {
  const { cfg } = project();
  const store = openStore(cfg.store);
  const old = stmt(store, 1, '2026-09-01T10:00:00.000Z', 'claude', 'completed', 'Logo changed to the text-only mark', 's1');
  const rej = stmt(store, 2, '2026-09-05T10:00:00.000Z', 'owner', 'rejected', 'Owner rejected the text-only logo mark', 's2');
  const ap1 = stmt(store, 3, '2026-09-06T10:00:00.000Z', 'owner', 'approved', 'Owner approved the product list CSV download', 's3');
  const ap2 = stmt(store, 4, '2026-09-07T10:00:00.000Z', 'owner', 'approved', 'Owner approved the product list CSV corrections', 's4');
  const sup = stmt(store, 5, '2026-09-08T10:00:00.000Z', 'owner', 'superseded', 'Hardcode the tile count at 291', 's5');
  const nxt = stmt(store, 6, '2026-09-08T10:05:00.000Z', 'owner', 'approved', 'Derive the tile count instead of hardcode 291', 's5');
  const asked = [];
  const judge = (o, n) => { asked.push([o.id, n.id]); return true; };
  const r = await link.run(cfg, store, { judge });
  assert.deepEqual(asked, [[old, rej], [sup, nxt]], 'only pairs that could be a replacement AND are about the same thing reach the judge');
  assert.deepEqual(r.links.map((l) => [l.old.id, l.neu.id]), [[old, rej], [sup, nxt]]);
  assert.equal(store.getDoc(ap1).superseded_by, null, 'two approvals of similar things are two decisions');
  const out = search.format(search.runSearch(store, cfg, { query: 'logo mark' }), { query: 'logo mark' });
  assert.match(out, new RegExp(`#${old} statement \\S+ s1 \\[claude completed\\] STRUCK by #${rej}`));
  const again = await link.run(cfg, store, { judge });
  assert.equal(again.linked, 2, 'redrawing is idempotent');
  assert.equal(again.judged, 0, 'a pair is judged once, ever');
  assert.equal(asked.length, 2);
  assert.equal(ap2 > 0 && store.getDoc(old).status, 'active', 'a struck statement stays active and visible');
  store.close();
  // The same pairs, a judge that says no: nominated, asked, and left alone.
  const other = openStore(project().cfg.store);
  stmt(other, 1, '2026-09-01T10:00:00.000Z', 'claude', 'completed', 'Logo changed to the text-only mark', 's1');
  stmt(other, 2, '2026-09-05T10:00:00.000Z', 'owner', 'rejected', 'Owner rejected the text-only logo mark', 's2');
  const no = await link.run(cfg, other, { judge: () => false });
  assert.deepEqual([no.nominated, no.judged, no.linked], [1, 1, 0]);
  other.close();
});

test('mcp: initialize, list, a search that opens the gate, a bad date refused, an unknown method refused', async () => {
  const { root, cfg } = project();
  const store = openStore(cfg.store);
  stmt(store, 1, '2026-09-01T10:00:00.000Z', 'owner', 'standing', 'Never ship a text-only logo');
  store.close();
  const ctx = { root, env: { CLAUDE_CODE_SESSION_ID: 'sid-mcp' } };
  const rpc = (method, params, id = 1) => mcp.handle({ jsonrpc: '2.0', id, method, params }, ctx);
  const init = await rpc('initialize', { protocolVersion: '2025-03-26' });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null, 'a notification is never answered');
  assert.deepEqual((await rpc('tools/list')).result.tools.map((t) => t.name), ['recall_search', 'recall_brief']);
  assert.equal(gate.isOpen('demo', 'sid-mcp'), false);
  const hit = await rpc('tools/call', { name: 'recall_search', arguments: { query: 'logo' } });
  assert.equal(hit.result.isError, false);
  assert.match(hit.result.content[0].text, /\[owner standing\]\n {2}Never ship a text-only logo/);
  assert.equal(gate.isOpen('demo', 'sid-mcp'), true, 'a search through the server counts as the first look');
  const bad = await rpc('tools/call', { name: 'recall_search', arguments: { query: 'logo', since: 'last week' } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /is not a date/);
  assert.match((await rpc('tools/call', { name: 'recall_brief', arguments: {} })).result.content[0].text, /RULE owner: Never ship/);
  assert.equal((await rpc('resources/list')).error.code, -32601);
});
