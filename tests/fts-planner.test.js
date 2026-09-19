'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openStore } = require('../lib/store');
const recall = require('../lib/recall');

test('Find drives common-word searches from FTS, preserving every scoped result and its rank', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-fts-planner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.sqlite');
  fs.writeFileSync(path.join(dir, 'total_recall.json'), JSON.stringify({ project: 'alpha', transcripts: 'transcripts', store: file }));
  const s = openStore(file), wanted = new Set();
  s.tx(() => {
    for (let i = 0; i < 3000; i++) {
      const project = i % 5 ? 'alpha' : 'beta';
      const status = i % 11 ? 'active' : 'struck';
      const origin = i % 7 ? 'direct' : 'tool';
      const role = i % 3 ? 'user' : 'assistant';
      const id = s.insertDoc({ project, status, origin, role, kind: 'turn', source_client: 'codex',
        session_id: 'codex:fixture', ts: '2026-09-19T10:00:00Z', title: `record ${i}`,
        body: `${i % 2 ? 'the repeated common words' : 'a companion example'} record ${i}` }).id;
      if (project === 'alpha' && status === 'active' && origin !== 'tool' && role === 'user') wanted.add(id);
    }
  });
  const query = 'the companion';
  const expression = recall.normalize({ query, words: true }, { project: 'alpha' }).expr.match;
  // Independent FTS-only reference: scope is applied to the known fixture identities, not a join.
  const expected = s.db.prepare('SELECT rowid id,bm25(docs_fts) rank FROM docs_fts WHERE docs_fts MATCH ? ORDER BY rank,rowid')
    .all(expression).filter((d) => wanted.has(d.id));
  s.close();
  assert.ok(expected.length > 1000, 'exercise a broad result set, not a tiny selective search');

  const prepare = DatabaseSync.prototype.prepare, observed = [];
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    const statement = prepare.call(this, sql);
    if (!/^SELECT .*bm25\(docs_fts\).*FROM docs_fts .*JOIN docs d/.test(sql)) return statement;
    const db = this, all = statement.all;
    statement.all = function (...params) {
      const plan = prepare.call(db, `EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail);
      const fts = plan.findIndex((line) => /SCAN docs_fts VIRTUAL TABLE/.test(line));
      const docs = plan.findIndex((line) => /SEARCH d USING/.test(line));
      assert.ok(fts >= 0 && docs > fts, `FTS must be the outer loop, not repeated for every doc: ${plan.join('; ')}`);
      assert.match(plan[docs], /INTEGER PRIMARY KEY/);
      const rows = all.apply(this, params);
      observed.push(rows.map(({ id, rank }) => ({ id, rank })));
      return rows;
    };
    return statement;
  });
  const result = await recall.execute('find', { query, words: true, kind: 'all', client: 'codex', who: 'owner',
    limit: 100, chars: 30000 }, { root: dir, registryFile: path.join(dir, 'no-registry.json') });
  assert.equal(observed.length, 1, 'inspect the query actually used by Find');
  assert.deepEqual(observed[0], expected.map(({ id, rank }) => ({ id, rank })));
  assert.equal(result.counts.records, expected.length);
  assert.deepEqual(result.rows.map((d) => d.id), expected.slice(0, result.rows.length).map((d) => d.id));
  assert.ok(result.next, 'a display limit must not silently truncate the total matching set');
});
