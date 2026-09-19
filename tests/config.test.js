'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, noConfigMessage } = require('../lib/config');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tr-config-')); }

test('walks up to find total_recall.json and applies defaults', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'total_recall.json'), JSON.stringify({
    project: 'demo', transcripts: 'transcripts', sources: { handoff: 'notes/HANDOFF-*.md' },
  }));
  const nested = path.join(root, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  const cfg = loadConfig(nested);
  assert.equal(cfg.project, 'demo');
  assert.equal(cfg.transcripts, path.join(root, 'transcripts'));
  // A note source is one pattern or several now that two clients write handoffs: always a list.
  assert.deepEqual(cfg.sources.handoff, [path.join(root, 'notes', 'HANDOFF-*.md')]);
  assert.equal(cfg.ollama.model, 'qwen3:14b');
  assert.equal(cfg.ollama.chunkTokens, 6000);
  assert.equal(cfg.brief.standingLines, 15);
  assert.equal(cfg.search.rawRecentDays, 7);
  assert.equal(cfg.store, path.join(os.homedir(), '.total_recall', 'demo.sqlite'));
  assert.equal(cfg.root, root);
});

test('explicit store and ollama overrides win, absolute paths stay absolute', () => {
  const root = tmp();
  const abs = path.join(root, 'elsewhere', 'store.sqlite');
  fs.writeFileSync(path.join(root, 'total_recall.json'), JSON.stringify({
    project: 'demo', transcripts: root, store: abs, ollama: { model: 'qwen3:8b' },
  }));
  const cfg = loadConfig(root);
  assert.equal(cfg.store, abs);
  assert.equal(cfg.ollama.model, 'qwen3:8b');
  assert.equal(cfg.ollama.url, 'http://localhost:11434');
});

test('no config returns null and the message names the cwd', () => {
  const root = tmp();
  assert.equal(loadConfig(root), null);
  assert.match(noConfigMessage(root), /no total_recall\.json found above/);
});

test('missing project or transcripts throws', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'total_recall.json'), JSON.stringify({ project: 'x' }));
  assert.throws(() => loadConfig(root), /needs "project" and "transcripts"/);
});
