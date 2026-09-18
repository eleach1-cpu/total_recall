'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = {
  // distill.provider: 'ollama' (local, free) or 'claude' (the Claude API, needs ANTHROPIC_API_KEY
  // or ANTHROPIC_AUTH_TOKEN in the environment). distill.model overrides the provider default.
  distill: { provider: 'ollama', model: null },
  ollama: { url: 'http://localhost:11434', model: 'qwen3:14b', chunkTokens: 6000 },
  brief: { sessions: 3, maxLines: 40, standingLines: 15 },
  // minSim: a hit found by meaning alone (none of the query's words) must be at least this close.
  search: { rawRecentDays: 7, rawRecentLimit: 5, minSim: 0.62 },
  // The meaning lane of search. Served by the same Ollama as distill; the model is small (274 MB).
  embed: { model: 'nomic-embed-text', batch: 32, queryTimeoutMs: 6000 },
  // Automatic supersession links between statements: how alike two statements must be to be NOMINATED; the model then judges each pair.
  link: { minSim: 0.8, minOverlap: 0.3 },
};

function findConfig(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    const candidate = path.join(dir, 'total_recall.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadConfig(startDir) {
  const file = findConfig(startDir);
  if (!file) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw.project || !raw.transcripts) {
    throw new Error(`total_recall.json needs "project" and "transcripts" (${file})`);
  }
  const root = path.dirname(file);
  const cfg = {
    project: raw.project,
    transcripts: path.resolve(root, raw.transcripts),
    sources: Object.fromEntries(Object.entries(raw.sources || {}).map(([k, v]) => [k, path.resolve(root, v)])),
    distill: { ...DEFAULTS.distill, ...(raw.distill || {}) },
    ollama: { ...DEFAULTS.ollama, ...(raw.ollama || {}) },
    brief: { ...DEFAULTS.brief, ...(raw.brief || {}) },
    search: { ...DEFAULTS.search, ...(raw.search || {}) },
    embed: { ...DEFAULTS.embed, ...(raw.embed || {}) },
    link: { ...DEFAULTS.link, ...(raw.link || {}) },
    store: path.resolve(root, raw.store || path.join(os.homedir(), '.total_recall', `${raw.project}.sqlite`)),
    root,
    file,
  };
  return cfg;
}

function noConfigMessage(cwd) {
  return `total_recall: no total_recall.json found above ${cwd || process.cwd()}; nothing to do`;
}

module.exports = { findConfig, loadConfig, noConfigMessage, DEFAULTS };
