'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = {
  // distill.provider: 'ollama' (local, free) or 'claude' (the Claude API, needs ANTHROPIC_API_KEY
  // or ANTHROPIC_AUTH_TOKEN in the environment). distill.model overrides the provider default.
  // This is the model that READS the record. Which assistant WROTE a conversation is `client`.
  distill: { provider: 'ollama', model: null },
  ollama: { url: 'http://localhost:11434', model: 'qwen3:14b', chunkTokens: 6000 },
  // maxChars: the brief is injected into a session's context, so it has a size cap, not only a line cap.
  brief: { sessions: 3, maxLines: 40, standingLines: 15, maxChars: 8000 },
  // minSim: a hit found by meaning alone (none of the query's words) must be at least this close.
  search: { rawRecentDays: 7, rawRecentLimit: 5, minSim: 0.62 },
  // The meaning lane of search. Served by the same Ollama as distill; the model is small (274 MB).
  embed: { model: 'nomic-embed-text', batch: 32, queryTimeoutMs: 6000 },
  // Automatic supersession links between statements: how alike two statements must be to be NOMINATED; the model then judges each pair.
  link: { minSim: 0.8, minOverlap: 0.3 },
  // maxLineMB: one JSONL record larger than this is never buffered (a pasted image, a huge tool
  // output); it is counted and skipped. startupBudgetMs: how long a session-start hook may ingest.
  ingest: { maxLineMB: 16, startupBudgetMs: 2000 },
};

const CLIENTS = new Set(['claude', 'codex']);

// Same directory, however it was typed: separators, case (Windows), a trailing slash.
function canon(p) {
  let s = path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}
// `dir` is `root` or inside it. A directory boundary, not a prefix: demo-project-copy is not in demo-project.
function isUnder(dir, root) {
  const d = canon(dir), r = canon(root);
  return d === r || d.startsWith(r + '/');
}

// A linked git worktree keeps a `.git` FILE naming its admin directory inside the main checkout;
// that directory's `commondir` leads back to the main `.git`. Read from disk, no git process.
function mainCheckoutOf(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    const dotgit = path.join(dir, '.git');
    let st = null; try { st = fs.statSync(dotgit); } catch {}
    if (st && st.isDirectory()) return dir;
    if (st && st.isFile()) {
      try {
        const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotgit, 'utf8'));
        if (!m) return null;
        const admin = path.resolve(dir, m[1].trim());
        let common = path.join(admin, '..', '..');
        try { common = path.resolve(admin, fs.readFileSync(path.join(admin, 'commondir'), 'utf8').trim()); } catch {}
        return path.dirname(common);
      } catch { return null; }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findUp(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, 'total_recall.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// One resolver for the CLI, the MCP server and every hook. Inside a linked worktree the MAIN
// checkout's config wins: the worktree's own copy would point the note sources at folders that
// only exist in the main checkout, and would make each temporary worktree look like its own project.
function findConfig(startDir) {
  const start = startDir || process.env.TOTAL_RECALL_ROOT || process.cwd();
  const main = mainCheckoutOf(start);
  if (main && canon(main) !== canon(start)) { const viaMain = findUp(main); if (viaMain) return viaMain; }
  return findUp(start);
}

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

// Old form `transcripts: "dir"` is a Claude source. New form `transcriptSources: [{client, path,
// recursive}]`. Both at once is ambiguous and refused, so nothing is ever ingested twice.
function normalizeTranscriptSources(raw, root, where) {
  if (raw.transcripts !== undefined && raw.transcriptSources !== undefined) {
    throw new Error(`total_recall.json has both "transcripts" and "transcriptSources"; keep one (${where})`);
  }
  const list = raw.transcriptSources !== undefined
    ? asList(raw.transcriptSources)
    : [{ client: 'claude', path: raw.transcripts, recursive: false }];
  const seen = new Set(); const out = [];
  for (const s of list) {
    if (!s || typeof s.path !== 'string' || !s.path) throw new Error(`a transcript source needs a "path" (${where})`);
    if (!CLIENTS.has(s.client)) throw new Error(`unknown transcript client "${s.client}"; use one of ${[...CLIENTS].join(', ')} (${where})`);
    const p = path.resolve(root, s.path);
    const key = `${s.client}|${canon(p)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ client: s.client, path: p, recursive: s.recursive === undefined ? s.client === 'codex' : !!s.recursive });
  }
  return out;
}

// A hand-built config (tests, scripts) may still carry only `transcripts`.
function transcriptSourcesOf(cfg) {
  if (Array.isArray(cfg.transcriptSources)) return cfg.transcriptSources;
  return cfg.transcripts ? [{ client: 'claude', path: cfg.transcripts, recursive: false }] : [];
}

function loadConfig(startDir) {
  const file = findConfig(startDir);
  if (!file) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw.project || (!raw.transcripts && !raw.transcriptSources)) {
    throw new Error(`total_recall.json needs "project" and "transcripts" (${file})`);
  }
  const root = path.dirname(file);
  const transcriptSources = normalizeTranscriptSources(raw, root, file);
  const firstClaude = transcriptSources.find((s) => s.client === 'claude');
  const cfg = {
    project: raw.project,
    projectAliases: [...new Set([...asList(raw.projectAliases), path.basename(root)])],
    projectRegistry: raw.projectRegistry ? path.resolve(root, raw.projectRegistry) : undefined,
    timezone: raw.timezone || 'America/New_York',
    transcriptSources,
    transcripts: firstClaude ? firstClaude.path : null, // kept for callers written before there were two clients
    // A note source is one pattern or several; overlapping patterns are read once.
    sources: Object.fromEntries(Object.entries(raw.sources || {}).map(([k, v]) => [k, [...new Set(asList(v).map((p) => path.resolve(root, p)))]])),
    // Which conversations belong to this project. A Codex root holds every project's sessions, so
    // membership comes from what the session recorded about itself, never from what it talks about.
    projectRoots: [...new Set([root, ...asList(raw.projectRoots).map((p) => path.resolve(root, p))])],
    projectRepos: asList(raw.projectRepos).map(String),
    historicalRoots: asList(raw.historicalRoots).map(String),
    includeSessions: asList(raw.includeSessions).map(String),
    distill: { ...DEFAULTS.distill, ...(raw.distill || {}) },
    ollama: { ...DEFAULTS.ollama, ...(raw.ollama || {}) },
    brief: { ...DEFAULTS.brief, ...(raw.brief || {}) },
    search: { ...DEFAULTS.search, ...(raw.search || {}), ...(raw.search?.index ? { index: path.resolve(root, raw.search.index) } : {}) },
    embed: { ...DEFAULTS.embed, ...(raw.embed || {}) },
    link: { ...DEFAULTS.link, ...(raw.link || {}) },
    ingest: { ...DEFAULTS.ingest, ...(raw.ingest || {}) },
    store: path.resolve(root, raw.store || path.join(os.homedir(), '.total_recall', `${raw.project}.sqlite`)),
    root,
    file,
  };
  return cfg;
}

function noConfigMessage(cwd) {
  return `total_recall: no total_recall.json found above ${cwd || process.env.TOTAL_RECALL_ROOT || process.cwd()}; nothing to do`;
}

module.exports = { findConfig, loadConfig, noConfigMessage, DEFAULTS, CLIENTS, canon, isUnder, mainCheckoutOf, transcriptSourcesOf, asList };
