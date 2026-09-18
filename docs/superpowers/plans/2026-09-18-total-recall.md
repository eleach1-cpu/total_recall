# total_recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-dependency Node CLI that ingests Claude Code transcripts and project notes into a per-project SQLite FTS5 store, distils them into provenance-tagged statements with a local Ollama model, and forces every new session to read a brief and run a recall search before its first edit.

**Architecture:** One `bin/total_recall.js` entry dispatches to one module per command under `lib/`. `lib/store.js` owns the SQLite schema and every query; nothing else writes SQL. Ingest is idempotent by content hash and tracks progress per source file; distill records completion per chunk separately from what it found; the gate is a marker file keyed on the Claude session uuid that both hooks and the Bash-tool shell can see.

**Tech Stack:** Node >= 22.13 (`node:sqlite` unflagged, `node:test`, global `fetch`), SQLite FTS5 via `node:sqlite`, Ollama HTTP API for distillation. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-18-total-recall-design.md`

## Global Constraints

- Node >= 22.13; `package.json` `"engines": { "node": ">=22.13" }`. Zero npm dependencies, ever.
- Repo `C:\Users\<you>\total_recall`, MIT licence, CommonJS modules (`'use strict'`, `require`).
- Every command with no `total_recall.json` found prints `total_recall: no total_recall.json found above <cwd>; nothing to do` and exits 0.
- Only hook-invoked commands (`session-start`, `gate --arm`, `gate --check`, `gate --check-bash`) read stdin. `search`, `ingest`, `distill`, `brief` never do.
- Session id resolution order: hook stdin `session_id`, then env `CLAUDE_CODE_SESSION_ID`, then `--session <id>`, then none. Never a daily fallback.
- Tool results are never stored. Sidechain records are never stored. Every stored body passes `scrub()` first.
- Failure is loud: a distill chunk that cannot be parsed stores nothing, records no run, and exits non-zero. No empty rows, no swallowed catch.
- Default model `qwen3:14b`; chunk 6,000 tokens at 4 chars/token = 24,000 chars.
- Brief caps: 15 standing lines, 40 total lines. Search defaults: 12 distilled hits, 6 deep, raw-recent fallback 5 hits over 7 days.
- Commits in this repo: `git -C C:/Users/<you>/total_recall add <files>` then, as its own call, `CLAUDE_USER_APPROVED=1 git -C C:/Users/<you>/total_recall commit -m '...'`. The owner's shell hook denies any other shape. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Tests: `node --test tests/` from the repo root. Temp files go under `os.tmpdir()` via `fs.mkdtempSync`.
- No em-dashes in any file (the owner's projects scrub them). Use commas or colons.

---

## File map

| File | Responsibility |
|---|---|
| `bin/total_recall.js` | Suppress the `node:sqlite` experimental warning, parse `<cmd> [sub] --flags`, load config, dispatch. Exit codes: 0 ok, 1 error, 2 gate block. |
| `lib/args.js` | `parseArgs(argv) -> { cmd, sub, flags, positional }`. Pure. |
| `lib/config.js` | Find `total_recall.json` walking up from cwd; apply defaults; resolve paths. |
| `lib/scrub.js` | `scrub(text) -> text`. Pure secret replacer. |
| `lib/store.js` | Schema, open, `insertDoc`, supersession, `sources`, `distill_runs`, every SELECT. |
| `lib/session.js` | `readHookPayload()`, `resolveSessionId()`. |
| `lib/gate.js` | Marker paths, `arm`, `ack`, `isOpen`, `checkEdit`, `checkBash`. |
| `lib/ingest.js` | Transcript record -> doc, per-file offsets, markdown section splitter, feedback memory -> standing statement, selectors. |
| `lib/search.js` | FTS match builder, filters, raw-recent fallback, `--deep`, formatting, marker write. |
| `lib/distill.js` | Chunking, prompt, Ollama call, validation, statement storage, run records. |
| `lib/brief.js` | Standing rules + recent work, git-scored, capped. |
| `lib/session-start.js` | `arm -> ingest -> brief` in one process. |
| `skill/SKILL.md` | The `/total_recall` skill. |
| `hooks/settings.snippet.json` | Hook block for a tenant project. |
| `tests/fixtures/make-session.js` | Deterministic 30-record JSONL generator used by every test. |
| `tests/*.test.js` | One file per module. |

Interfaces shared across tasks (exact names, defined once here, repeated in each task's block):

```js
// lib/store.js
openStore(file) -> Store
Store.insertDoc(doc) -> { id: number, inserted: boolean }
//   doc = { project, kind, status?, session_id?, ts, role?, path?, title, body,
//           files_json?, tools_json?, who?, outcome?, evidence_ids?, quote?, reason?, sha? }
Store.supersedePath(path) -> number            // rows set superseded
Store.linkSupersession(path) -> number         // superseded_by pointers written
Store.getSource(path) -> row|undefined ; Store.setSource(row)
Store.search(match, f) -> rows                 // f = { kinds, includeSuperseded, who, outcomes, since, session, files, limit }
Store.getDoc(id) -> row ; Store.neighbours(id) -> { prev, next }
Store.turnsForSession(sid) -> rows (ts asc)
Store.recentSessionIds(n) -> string[]
Store.statementsForSessions(ids) -> rows ; Store.handoffsBetween(fromTs, toTs) -> rows
Store.standing(limit) -> rows ; Store.standingCount() -> number
Store.hasRun(key) -> boolean ; Store.insertRun(row)   // key = { session_id, turn_from, turn_to, model, prompt_sha }
Store.sessionsWithRuns() -> Set<string>
Store.recentUndistilledTurns(match, sinceTs, limit, excludeSessions) -> rows
Store.close()
```

---

### Task 1: Scaffold, arg parser, entry point

**Files:**
- Create: `package.json`, `LICENSE`, `.gitignore`, `README.md`, `bin/total_recall.js`, `lib/args.js`
- Test: `tests/args.test.js`

**Interfaces:**
- Produces: `parseArgs(argv: string[]) -> { cmd: string|null, sub: string|null, flags: Record<string, string|true>, positional: string[] }`. A `--k v` pair becomes `flags.k = 'v'` unless `v` starts with `--`; a lone `--k` is `true`. `sub` is the first bare word after `cmd` only for `gate` (`--arm` etc. stay flags; `sub` is unused there) and is otherwise null. Positional words after the cmd are collected in order.

- [ ] **Step 1: Write the failing test**

`tests/args.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../lib/args');

test('parses cmd, flags with values, boolean flags, positional', () => {
  const a = parseArgs(['search', 'tax math', '--kind', 'turn,statement', '--deep', '--limit', '3']);
  assert.equal(a.cmd, 'search');
  assert.deepEqual(a.positional, ['tax math']);
  assert.equal(a.flags.kind, 'turn,statement');
  assert.equal(a.flags.deep, true);
  assert.equal(a.flags.limit, '3');
});

test('a flag followed by another flag is boolean', () => {
  const a = parseArgs(['gate', '--check', '--session', 'abc']);
  assert.equal(a.cmd, 'gate');
  assert.equal(a.flags.check, true);
  assert.equal(a.flags.session, 'abc');
});

test('no args gives null cmd', () => {
  assert.equal(parseArgs([]).cmd, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/args.test.js`
Expected: FAIL, `Cannot find module '../lib/args'`

- [ ] **Step 3: Write the scaffold and parser**

`package.json`:
```json
{
  "name": "total_recall",
  "version": "0.1.0",
  "description": "Searchable, distilled memory of Claude Code sessions: FTS5 store, local-LLM distillation, session brief and edit gate.",
  "license": "MIT",
  "bin": { "total_recall": "bin/total_recall.js" },
  "engines": { "node": ">=22.13" },
  "scripts": { "test": "node --test tests/" }
}
```

`LICENSE`: the MIT text with `Copyright (c) 2026 the project owner`.

`.gitignore`:
```
node_modules/
*.sqlite
*.sqlite-wal
*.sqlite-shm
.DS_Store
```

`README.md` (first cut; Task 12 completes it):
```markdown
# total_recall

Searchable, distilled memory for Claude Code sessions. One SQLite file per project, FTS5 ranked,
a local-LLM pass that turns conversation into who-said-what statements with the original quote,
and a session-start brief plus edit gate so a new session looks before it codes.

Spec: docs/superpowers/specs/2026-09-18-total-recall-design.md
```

`lib/args.js`:
```js
'use strict';

// Tiny flag parser: `<cmd> [positional...] --k v --flag`. No dependencies.
function parseArgs(argv) {
  const out = { cmd: null, sub: null, flags: {}, positional: [] };
  const rest = [...argv];
  if (rest.length && !rest[0].startsWith('--')) out.cmd = rest.shift();
  while (rest.length) {
    const a = rest.shift();
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (rest.length && !rest[0].startsWith('--')) out.flags[key] = rest.shift();
      else out.flags[key] = true;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

module.exports = { parseArgs };
```

`bin/total_recall.js`:
```js
#!/usr/bin/env node
'use strict';

// node:sqlite still prints an ExperimentalWarning on Node 22-24; it is noise in a hook.
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.error(w); });

const { parseArgs } = require('../lib/args');

const USAGE = `total_recall <command> [options]

  ingest   [--all | --since D | --from D --to D | --session ID]
  distill  [--all | --since D | --from D --to D | --session ID | --today] [--model TAG]
  search   "<query>" [--kind k,k] [--who owner|claude] [--outcome o,o] [--files GLOB]
           [--session ID] [--since D] [--deep] [--limit N] [--include-superseded]
  brief
  gate     --arm | --check | --check-bash | --ack
  session-start        (hook only: arm, ingest, brief)
  --help
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cmd || args.flags.help) { process.stdout.write(USAGE); return 0; }
  const commands = {
    ingest: () => require('../lib/ingest').command(args),
    distill: () => require('../lib/distill').command(args),
    search: () => require('../lib/search').command(args),
    brief: () => require('../lib/brief').command(args),
    gate: () => require('../lib/gate').command(args),
    'session-start': () => require('../lib/session-start').command(args),
  };
  const fn = commands[args.cmd];
  if (!fn) { process.stderr.write(`total_recall: unknown command "${args.cmd}"\n${USAGE}`); return 1; }
  return await fn();
}

main().then((code) => { process.exitCode = code || 0; }, (err) => {
  process.stderr.write(`total_recall: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
});
```

Every `command(args)` in later tasks returns a number: the exit code.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/args.test.js`
Expected: 3 passing. Also `node bin/total_recall.js --help` prints the usage and exits 0.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/<you>/total_recall add package.json LICENSE .gitignore README.md bin/total_recall.js lib/args.js tests/args.test.js
```
then alone:
```bash
CLAUDE_USER_APPROVED=1 git -C C:/Users/<you>/total_recall commit -m 'feat: scaffold, arg parser and command dispatch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

---

### Task 2: Config discovery

**Files:**
- Create: `lib/config.js`
- Test: `tests/config.test.js`

**Interfaces:**
- Produces: `loadConfig(startDir?: string) -> Config|null`. `Config = { project, transcripts (abs), sources: {kind: absGlob}, ollama: {url, model, chunkTokens}, brief: {sessions, maxLines, standingLines}, search: {rawRecentDays, rawRecentLimit}, store (abs), root (dir of the json), file (abs path of the json) }`. Returns `null` when no `total_recall.json` is found walking up from `startDir` (default `process.cwd()`). Throws when the file lacks `project` or `transcripts`.
- Produces: `noConfigMessage(cwd) -> string` = `total_recall: no total_recall.json found above ${cwd}; nothing to do`.

- [ ] **Step 1: Write the failing test**

`tests/config.test.js`:
```js
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
  assert.equal(cfg.sources.handoff, path.join(root, 'notes', 'HANDOFF-*.md'));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config.test.js`
Expected: FAIL, `Cannot find module '../lib/config'`

- [ ] **Step 3: Write config.js**

```js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = {
  ollama: { url: 'http://localhost:11434', model: 'qwen3:14b', chunkTokens: 6000 },
  brief: { sessions: 3, maxLines: 40, standingLines: 15 },
  search: { rawRecentDays: 7, rawRecentLimit: 5 },
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
    ollama: { ...DEFAULTS.ollama, ...(raw.ollama || {}) },
    brief: { ...DEFAULTS.brief, ...(raw.brief || {}) },
    search: { ...DEFAULTS.search, ...(raw.search || {}) },
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/config.test.js`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/<you>/total_recall add lib/config.js tests/config.test.js
```
```bash
CLAUDE_USER_APPROVED=1 git -C C:/Users/<you>/total_recall commit -m 'feat: config discovery with defaults

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

---

### Task 3: Secret scrubber

**Files:**
- Create: `lib/scrub.js`
- Test: `tests/scrub.test.js`

**Interfaces:**
- Produces: `scrub(text: string) -> string`. Pure. Replaces, never removes lines. Replacement token is `[scrubbed]`.

- [ ] **Step 1: Write the failing test**

`tests/scrub.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scrub } = require('../lib/scrub');

test('known token shapes are replaced', () => {
  const s = scrub('use sk-abcdefghijklmnopqrstuvwxyz123456 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12 and xoxb-1234567890-abc and AKIAABCDEFGHIJKLMNOP');
  assert.equal((s.match(/\[scrubbed\]/g) || []).length, 4);
  assert.doesNotMatch(s, /sk-abc|ghp_ABC|xoxb-1234|AKIAABC/);
});

test('bearer tokens keep the word Bearer', () => {
  assert.equal(scrub('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'), 'Authorization: Bearer [scrubbed]');
});

test('long hex after the word token is replaced, short is kept', () => {
  assert.equal(scrub('token: 0123456789abcdef0123456789abcdef'), 'token: [scrubbed]');
  assert.equal(scrub('token: abc123'), 'token: abc123');
});

test('env assignment lines ending in _KEY/_SECRET/_TOKEN/PASSWORD are masked, others untouched', () => {
  const s = scrub('MAIL_API_KEY=re_live_123\nPORT=3000\nDB_PASSWORD=hunter2\n');
  assert.equal(s, 'MAIL_API_KEY=[scrubbed]\nPORT=3000\nDB_PASSWORD=[scrubbed]\n');
});

test('ordinary prose survives unchanged', () => {
  const p = 'The Tax Math Calculator uses rule 4.25 and the invoice total.';
  assert.equal(scrub(p), p);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/scrub.test.js`
Expected: FAIL, `Cannot find module '../lib/scrub'`

- [ ] **Step 3: Write scrub.js**

```js
'use strict';

const TOKEN = '[scrubbed]';

const SIMPLE = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
];
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g;
const NEAR_KEYWORD = /\b(token|key|secret|password)\b([^\n]{0,40}?)([A-Fa-f0-9]{32,}|[A-Za-z0-9+/=]{32,})/gi;
const ENV_LINE = /^([A-Za-z0-9_]*(?:_KEY|_SECRET|_TOKEN|PASSWORD))=.*$/gm;

function scrub(text) {
  let out = String(text ?? '');
  for (const re of SIMPLE) out = out.replace(re, TOKEN);
  out = out.replace(BEARER, `Bearer ${TOKEN}`);
  out = out.replace(NEAR_KEYWORD, (m, kw, mid) => `${kw}${mid}${TOKEN}`);
  out = out.replace(ENV_LINE, (m, key) => `${key}=${TOKEN}`);
  return out;
}

module.exports = { scrub, TOKEN };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/scrub.test.js`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/<you>/total_recall add lib/scrub.js tests/scrub.test.js
```
```bash
CLAUDE_USER_APPROVED=1 git -C C:/Users/<you>/total_recall commit -m 'feat: secret scrubber

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

---

### Task 4: Store (schema and every query)

**Files:**
- Create: `lib/store.js`
- Test: `tests/store.test.js`

**Interfaces:**
- Produces: everything in the "Interfaces shared across tasks" block above. Row shapes are the `docs` columns as plain objects; `search` rows also carry `rank` (bm25, lower is better).

- [ ] **Step 1: Write the failing test**

`tests/store.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../lib/store');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-store-'));
  return openStore(path.join(dir, 'p.sqlite'));
}
const turn = (over) => ({ project: 'p', kind: 'turn', session_id: 's1', ts: '2026-09-18T10:00:00.000Z', role: 'user', title: 't', body: 'b', ...over });

test('insertDoc is idempotent by sha and reports it', () => {
  const s = fresh();
  const a = s.insertDoc(turn({ body: 'hello tax math' }));
  const b = s.insertDoc(turn({ body: 'hello tax math' }));
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, false);
  assert.equal(a.id, b.id);
  s.close();
});

test('search ranks a title hit above a body hit and honours kind and status filters', () => {
  const s = fresh();
  s.insertDoc(turn({ title: 'tax math calculator', body: 'nothing else' }));
  s.insertDoc(turn({ title: 'other', body: 'tax math in the body', ts: '2026-09-18T10:01:00.000Z' }));
  s.insertDoc({ project: 'p', kind: 'statement', ts: '2026-09-18T10:02:00.000Z', title: 'tax math stays', body: 'tax math stays', who: 'owner', outcome: 'standing', quote: 'q' });
  const all = s.search('"tax" OR "math"', { kinds: ['turn'], limit: 10 });
  assert.equal(all.length, 2);
  assert.equal(all[0].title, 'tax math calculator');
  const st = s.search('"tax"', { kinds: ['statement'], outcomes: ['standing'], who: 'owner', limit: 10 });
  assert.equal(st.length, 1);
  s.close();
});

test('supersedePath hides rows from search and linkSupersession points at the same-title replacement', () => {
  const s = fresh();
  const old = s.insertDoc({ project: 'p', kind: 'memory', ts: '2026-08-01T00:00:00.000Z', path: '/m/a.md', title: 'Rule A', body: 'old wording alpha' });
  assert.equal(s.supersedePath('/m/a.md'), 1);
  const neu = s.insertDoc({ project: 'p', kind: 'memory', ts: '2026-09-01T00:00:00.000Z', path: '/m/a.md', title: 'Rule A', body: 'new wording alpha' });
  assert.equal(s.linkSupersession('/m/a.md'), 1);
  assert.equal(s.getDoc(old.id).superseded_by, neu.id);
  assert.equal(s.search('"alpha"', { kinds: ['memory'], limit: 10 }).length, 1);
  assert.equal(s.search('"alpha"', { kinds: ['memory'], includeSuperseded: true, limit: 10 }).length, 2);
  s.close();
});

test('neighbours, session listing, sources and runs', () => {
  const s = fresh();
  const a = s.insertDoc(turn({ body: 'one', ts: '2026-09-18T10:00:00.000Z' }));
  const b = s.insertDoc(turn({ body: 'two', ts: '2026-09-18T10:01:00.000Z', role: 'assistant' }));
  const c = s.insertDoc(turn({ body: 'three', ts: '2026-09-18T10:02:00.000Z' }));
  s.insertDoc(turn({ body: 'other session', session_id: 's2', ts: '2026-09-19T10:00:00.000Z' }));
  const n = s.neighbours(b.id);
  assert.equal(n.prev.id, a.id);
  assert.equal(n.next.id, c.id);
  assert.deepEqual(s.recentSessionIds(5), ['s2', 's1']);
  assert.equal(s.turnsForSession('s1').length, 3);
  s.setSource({ path: '/t/s1.jsonl', kind: 'transcript', size: 10, mtime: 'm', sha: 'h', offset: 10, ingested_at: 'now' });
  assert.equal(s.getSource('/t/s1.jsonl').offset, 10);
  const key = { session_id: 's1', turn_from: a.id, turn_to: c.id, model: 'm', prompt_sha: 'p' };
  assert.equal(s.hasRun(key), false);
  s.insertRun({ ...key, ran_at: 'now', lines: 0 });
  assert.equal(s.hasRun(key), true);
  assert.deepEqual([...s.sessionsWithRuns()], ['s1']);
  const raw = s.recentUndistilledTurns('"other"', '2026-09-01T00:00:00.000Z', 5, s.sessionsWithRuns());
  assert.equal(raw.length, 1);
  assert.equal(raw[0].session_id, 's2');
  s.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/store.test.js`
Expected: FAIL, `Cannot find module '../lib/store'`

- [ ] **Step 3: Write store.js**

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id            INTEGER PRIMARY KEY,
  project       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  session_id    TEXT,
  ts            TEXT NOT NULL,
  role          TEXT,
  path          TEXT,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  files_json    TEXT NOT NULL DEFAULT '[]',
  tools_json    TEXT NOT NULL DEFAULT '[]',
  who           TEXT,
  outcome       TEXT,
  evidence_ids  TEXT NOT NULL DEFAULT '[]',
  quote         TEXT,
  reason        TEXT,
  superseded_by INTEGER REFERENCES docs(id),
  sha           TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS docs_session ON docs(session_id, ts);
CREATE INDEX IF NOT EXISTS docs_kind_status_ts ON docs(kind, status, ts);
CREATE INDEX IF NOT EXISTS docs_path ON docs(path);
CREATE INDEX IF NOT EXISTS docs_outcome ON docs(outcome) WHERE kind = 'statement';
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  title, body, content='docs', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE OF title, body ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO docs_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TABLE IF NOT EXISTS sources (
  path        TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mtime       TEXT NOT NULL,
  sha         TEXT NOT NULL,
  offset      INTEGER NOT NULL DEFAULT 0,
  ingested_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS distill_runs (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL,
  turn_from   INTEGER NOT NULL,
  turn_to     INTEGER NOT NULL,
  model       TEXT NOT NULL,
  prompt_sha  TEXT NOT NULL,
  ran_at      TEXT NOT NULL,
  lines       INTEGER NOT NULL,
  UNIQUE(session_id, turn_from, turn_to, model, prompt_sha)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function docSha(d) {
  if (d.sha) return d.sha;
  if (d.kind === 'statement') return sha256(['statement', d.who, d.outcome, d.title, d.quote || ''].join('\u0001'));
  return sha256([d.kind, d.session_id || '', d.ts, d.role || '', d.path || '', d.body].join('\u0001'));
}

const COLS = ['project', 'kind', 'status', 'session_id', 'ts', 'role', 'path', 'title', 'body',
  'files_json', 'tools_json', 'who', 'outcome', 'evidence_ids', 'quote', 'reason', 'sha'];

function openStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);

  const insert = db.prepare(`INSERT OR IGNORE INTO docs (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`);
  const byShaId = db.prepare('SELECT id FROM docs WHERE sha = ?');

  function insertDoc(d) {
    const sha = docSha(d);
    const row = {
      project: d.project, kind: d.kind, status: d.status || 'active', session_id: d.session_id || null,
      ts: d.ts, role: d.role || null, path: d.path || null, title: d.title, body: d.body,
      files_json: d.files_json || '[]', tools_json: d.tools_json || '[]', who: d.who || null,
      outcome: d.outcome || null, evidence_ids: d.evidence_ids || '[]', quote: d.quote || null,
      reason: d.reason ?? null, sha,
    };
    const r = insert.run(...COLS.map((c) => row[c]));
    if (r.changes > 0) return { id: Number(r.lastInsertRowid), inserted: true };
    return { id: byShaId.get(sha).id, inserted: false };
  }

  function search(match, f = {}) {
    const where = ['docs_fts MATCH ?'];
    const params = [match];
    if (f.kinds && f.kinds.length) { where.push(`d.kind IN (${f.kinds.map(() => '?').join(',')})`); params.push(...f.kinds); }
    if (!f.includeSuperseded) where.push(`d.status = 'active'`);
    if (f.who) { where.push('d.who = ?'); params.push(f.who); }
    if (f.outcomes && f.outcomes.length) { where.push(`d.outcome IN (${f.outcomes.map(() => '?').join(',')})`); params.push(...f.outcomes); }
    if (f.since) { where.push('d.ts >= ?'); params.push(f.since); }
    if (f.session) { where.push('d.session_id = ?'); params.push(f.session); }
    if (f.files) { where.push('d.files_json LIKE ?'); params.push('%' + String(f.files).replace(/\*/g, '%') + '%'); }
    params.push(f.limit || 12);
    return db.prepare(`SELECT d.*, bm25(docs_fts, 3.0, 1.0) AS rank FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
      WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`).all(...params);
  }

  const api = {
    db,
    insertDoc,
    search,
    getDoc: (id) => db.prepare('SELECT * FROM docs WHERE id = ?').get(id),
    supersedePath: (p) => db.prepare(`UPDATE docs SET status = 'superseded' WHERE path = ? AND status = 'active'`).run(p).changes,
    linkSupersession(p) {
      const olds = db.prepare(`SELECT id, kind, title FROM docs WHERE path = ? AND status = 'superseded' AND superseded_by IS NULL`).all(p);
      const find = db.prepare(`SELECT id FROM docs WHERE path = ? AND kind = ? AND title = ? AND status = 'active' ORDER BY id DESC LIMIT 1`);
      const link = db.prepare('UPDATE docs SET superseded_by = ? WHERE id = ?');
      let n = 0;
      for (const o of olds) { const r = find.get(p, o.kind, o.title); if (r && r.id !== o.id) { link.run(r.id, o.id); n++; } }
      return n;
    },
    neighbours(id) {
      const d = api.getDoc(id);
      if (!d || !d.session_id) return { prev: null, next: null };
      const prev = db.prepare(`SELECT * FROM docs WHERE session_id = ? AND kind = 'turn' AND (ts < ? OR (ts = ? AND id < ?)) ORDER BY ts DESC, id DESC LIMIT 1`).get(d.session_id, d.ts, d.ts, id) || null;
      const next = db.prepare(`SELECT * FROM docs WHERE session_id = ? AND kind = 'turn' AND (ts > ? OR (ts = ? AND id > ?)) ORDER BY ts ASC, id ASC LIMIT 1`).get(d.session_id, d.ts, d.ts, id) || null;
      return { prev, next };
    },
    turnsForSession: (sid) => db.prepare(`SELECT * FROM docs WHERE session_id = ? AND kind = 'turn' AND status = 'active' ORDER BY ts, id`).all(sid),
    recentSessionIds: (n) => db.prepare(`SELECT session_id FROM docs WHERE kind = 'turn' AND session_id IS NOT NULL GROUP BY session_id ORDER BY MAX(ts) DESC LIMIT ?`).all(n).map((r) => r.session_id),
    statementsForSessions(ids) {
      if (!ids.length) return [];
      return db.prepare(`SELECT * FROM docs WHERE kind = 'statement' AND status = 'active' AND session_id IN (${ids.map(() => '?').join(',')}) ORDER BY ts DESC`).all(...ids);
    },
    handoffsBetween: (a, b) => db.prepare(`SELECT * FROM docs WHERE kind = 'handoff' AND status = 'active' AND ts >= ? AND ts <= ? ORDER BY ts DESC`).all(a, b),
    standing: (limit) => db.prepare(`SELECT * FROM docs WHERE kind = 'statement' AND status = 'active' AND outcome = 'standing' ORDER BY ts DESC LIMIT ?`).all(limit),
    standingCount: () => db.prepare(`SELECT COUNT(*) AS n FROM docs WHERE kind = 'statement' AND status = 'active' AND outcome = 'standing'`).get().n,
    getSource: (p) => db.prepare('SELECT * FROM sources WHERE path = ?').get(p),
    setSource: (r) => db.prepare(`INSERT INTO sources(path, kind, size, mtime, sha, offset, ingested_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, size=excluded.size, mtime=excluded.mtime, sha=excluded.sha, offset=excluded.offset, ingested_at=excluded.ingested_at`)
      .run(r.path, r.kind, r.size, r.mtime, r.sha, r.offset, r.ingested_at),
    hasRun: (k) => !!db.prepare('SELECT 1 FROM distill_runs WHERE session_id = ? AND turn_from = ? AND turn_to = ? AND model = ? AND prompt_sha = ?').get(k.session_id, k.turn_from, k.turn_to, k.model, k.prompt_sha),
    insertRun: (r) => db.prepare('INSERT OR IGNORE INTO distill_runs(session_id, turn_from, turn_to, model, prompt_sha, ran_at, lines) VALUES (?,?,?,?,?,?,?)').run(r.session_id, r.turn_from, r.turn_to, r.model, r.prompt_sha, r.ran_at, r.lines),
    sessionsWithRuns: () => new Set(db.prepare('SELECT DISTINCT session_id FROM distill_runs').all().map((r) => r.session_id)),
    recentUndistilledTurns(match, sinceTs, limit, excludeSessions) {
      const ex = [...(excludeSessions || [])];
      const notIn = ex.length ? `AND d.session_id NOT IN (${ex.map(() => '?').join(',')})` : '';
      return db.prepare(`SELECT d.*, bm25(docs_fts, 3.0, 1.0) AS rank FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
        WHERE docs_fts MATCH ? AND d.kind = 'turn' AND d.status = 'active' AND d.ts >= ? ${notIn} ORDER BY rank LIMIT ?`).all(match, sinceTs, ...ex, limit);
    },
    close: () => db.close(),
  };
  return api;
}

module.exports = { openStore, docSha, sha256 };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/store.test.js`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/<you>/total_recall add lib/store.js tests/store.test.js
```
```bash
CLAUDE_USER_APPROVED=1 git -C C:/Users/<you>/total_recall commit -m 'feat: sqlite store with fts5, supersession, sources and run records

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

---

### Task 5: Session identity and the gate

**Files:**
- Create: `lib/session.js`, `lib/gate.js`
- Test: `tests/gate.test.js`

**Interfaces:**
- Produces `lib/session.js`: `readHookPayload() -> object|null` (reads all of fd 0 when `!process.stdin.isTTY`, parses JSON, null on empty or bad); `resolveSessionId({ payload, flags, env }) -> string|null` in the order payload.session_id, env.CLAUDE_CODE_SESSION_ID, flags.session.
- Produces `lib/gate.js`: `markerPath(project, sid) -> string` under `~/.total_recall/gate/<project>/<sid>` (overridable with env `TOTAL_RECALL_HOME` for tests); `arm(project, sid)`, `ack(project, sid)`, `isOpen(project, sid) -> boolean`, `checkEdit(project, sid) -> { ok, message }`, `checkBash(project, sid, command, root) -> { ok, message }`, `command(args) -> number` (exit code; 2 on block; writes the message to stderr).
- The block message, exactly: `BLOCKED by total_recall: run  total_recall search "<the files or topic you are about to touch>"  first. (session <sid>)`.

- [ ] **Step 1: Write the failing test**

`tests/gate.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TOTAL_RECALL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-gate-'));
const gate = require('../lib/gate');
const { resolveSessionId } = require('../lib/session');

test('session id order: payload, env, flag, none', () => {
  assert.equal(resolveSessionId({ payload: { session_id: 'p' }, env: { CLAUDE_CODE_SESSION_ID: 'e' }, flags: { session: 'f' } }), 'p');
  assert.equal(resolveSessionId({ payload: null, env: { CLAUDE_CODE_SESSION_ID: 'e' }, flags: { session: 'f' } }), 'e');
  assert.equal(resolveSessionId({ payload: null, env: {}, flags: { session: 'f' } }), 'f');
  assert.equal(resolveSessionId({ payload: null, env: {}, flags: {} }), null);
});

test('edit gate blocks before a search and opens after ack', () => {
  const r1 = gate.checkEdit('demo', 'sid1');
  assert.equal(r1.ok, false);
  assert.match(r1.message, /BLOCKED by total_recall: run  total_recall search/);
  gate.ack('demo', 'sid1');
  assert.equal(gate.checkEdit('demo', 'sid1').ok, true);
  gate.arm('demo', 'sid1');
  assert.equal(gate.checkEdit('demo', 'sid1').ok, false);
});

test('a session id of null blocks and says so', () => {
  const r = gate.checkEdit('demo', null);
  assert.equal(r.ok, false);
  assert.match(r.message, /no session id/);
});

test('bash gate blocks write-shaped commands and passes reads', () => {
  const root = 'C:/proj';
  const blocked = ['git commit -m x', 'sed -i "s/a/b/" src/a.js', 'echo hi > notes.md', 'cat a >> src/b.js',
    'cp a.txt src/b.txt', 'mv a.txt C:/proj/b.txt', 'node -e "require(\'fs\').writeFileSync(\'x\',1)"',
    'python -c "open(\'x\',\'w\').write(\'y\')"', 'Set-Content -Path a.txt -Value b', 'tee src/out.js'];
  for (const c of blocked) assert.equal(gate.checkBash('demo', 'sid2', c, root).ok, false, c);
  const passed = ['git status', 'ls -la', 'grep -n foo src/a.js', 'node --test tests/', 'echo hi > /tmp/scratch.txt', 'cp a.txt /tmp/b.txt'];
  for (const c of passed) assert.equal(gate.checkBash('demo', 'sid2', c, root).ok, true, c);
  gate.ack('demo', 'sid2');
  assert.equal(gate.checkBash('demo', 'sid2', 'git commit -m x', root).ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/gate.test.js`
Expected: FAIL, `Cannot find module '../lib/gate'`

- [ ] **Step 3: Write session.js and gate.js**

`lib/session.js`:
```js
'use strict';
const fs = require('node:fs');

// Hook-only. Claude Code pipes a JSON payload on stdin to every hook command.
function readHookPayload() {
  try {
    if (process.stdin.isTTY) return null;
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveSessionId({ payload, flags, env }) {
  const e = env || process.env;
  const f = flags || {};
  if (payload && typeof payload.session_id === 'string' && payload.session_id) return payload.session_id;
  if (e.CLAUDE_CODE_SESSION_ID) return e.CLAUDE_CODE_SESSION_ID;
  if (typeof f.session === 'string' && f.session) return f.session;
  return null;
}

module.exports = { readHookPayload, resolveSessionId };
```

`lib/gate.js`:
```js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, noConfigMessage } = require('./config');
const { readHookPayload, resolveSessionId } = require('./session');

function home() { return process.env.TOTAL_RECALL_HOME || path.join(os.homedir(), '.total_recall'); }
function markerPath(project, sid) { return path.join(home(), 'gate', project, String(sid)); }

function ack(project, sid) {
  const p = markerPath(project, sid);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, new Date().toISOString());
}
function arm(project, sid) { try { fs.unlinkSync(markerPath(project, sid)); } catch {} }
function isOpen(project, sid) { return !!sid && fs.existsSync(markerPath(project, sid)); }

function blockMessage(sid) {
  return `BLOCKED by total_recall: run  total_recall search "<the files or topic you are about to touch>"  first. (session ${sid})`;
}

function checkEdit(project, sid) {
  if (!sid) return { ok: false, message: 'BLOCKED by total_recall: no session id (hook stdin session_id or CLAUDE_CODE_SESSION_ID); run  total_recall gate --ack --session <id>  after a search.' };
  if (isOpen(project, sid)) return { ok: true, message: '' };
  return { ok: false, message: blockMessage(sid) };
}

// Heuristic, documented as one in the spec: catches the common write shapes, not every one.
const WRITE_VERBS = [
  /\bgit\s+commit\b/, /\bsed\s+-i\b/, /\btee\s+\S/, /\b(Set-Content|Out-File|Add-Content)\b/i,
  /\b(node\s+-e|python3?\s+-c)\b[\s\S]*\b(writeFile|open\([^)]*['"]w)/,
];
const REDIRECT = /(^|[^<>])>{1,2}\s*([^\s&|;]+)/g;
const COPY_MOVE = /\b(cp|mv)\s+(?:-\S+\s+)*\S+\s+(\S+)/g;

function underProject(target, root) {
  const t = String(target).replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  if (/^\/tmp\b|\/temp\/|appdata\/local\/temp/i.test(t)) return false;
  if (/^([A-Za-z]:)?\//.test(t)) return root ? t.toLowerCase().startsWith(String(root).replace(/\\/g, '/').toLowerCase()) : false;
  return true; // relative paths are inside the project cwd
}

function isWriteCommand(command, root) {
  const c = String(command || '');
  if (WRITE_VERBS.some((re) => re.test(c))) return true;
  for (const m of c.matchAll(REDIRECT)) if (underProject(m[2], root)) return true;
  for (const m of c.matchAll(COPY_MOVE)) if (underProject(m[2], root)) return true;
  return false;
}

function checkBash(project, sid, command, root) {
  if (!isWriteCommand(command, root)) return { ok: true, message: '' };
  return checkEdit(project, sid);
}

function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const payload = (args.flags.check || args.flags['check-bash'] || args.flags.arm) ? readHookPayload() : null;
  const sid = resolveSessionId({ payload, flags: args.flags });
  if (args.flags.arm) { if (sid) arm(cfg.project, sid); return 0; }
  if (args.flags.ack) {
    if (!sid) { process.stderr.write('total_recall: no session id; gate not touched\n'); return 1; }
    ack(cfg.project, sid); process.stdout.write(`total_recall: gate opened by hand for session ${sid}\n`); return 0;
  }
  let r;
  if (args.flags['check-bash']) {
    const cmd = payload && payload.tool_input ? payload.tool_input.command : '';
    r = checkBash(cfg.project, sid, cmd, cfg.root);
  } else if (args.flags.check) {
    r = checkEdit(cfg.project, sid);
  } else {
    process.stderr.write('total_recall gate: one of --arm --check --check-bash --ack\n'); return 1;
  }
  if (r.ok) return 0;
  process.stderr.write(r.message + '\n');
  return 2;
}

module.exports = { markerPath, arm, ack, isOpen, checkEdit, checkBash, isWriteCommand, command };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/gate.test.js`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/<you>/total_recall add lib/session.js lib/gate.js tests/gate.test.js
```
```bash
CLAUDE_USER_APPROVED=1 git -C C:/Users/<you>/total_recall commit -m 'feat: session identity and the edit gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

---

### Task 6: Fixture generator

**Files:**
- Create: `tests/fixtures/make-session.js`, `tests/fixtures/memory-feedback.md`, `tests/fixtures/handoff-v1.md`, `tests/fixtures/handoff-v2.md`

**Interfaces:**
- Produces: `makeSession(outFile, { sessionId = 'fix-session-1', day = '2026-09-10' }) -> { records: number, turns: number }`. Writes JSONL with the exact record shapes Claude Code writes (`type`, `message.role`, `message.content` as string or block array, `isSidechain`, `timestamp`, `sessionId`, `cwd`, `isCompactSummary`).
- The fixture has, in order: 12 owner/claude text exchanges (24 records), 2 tool-only assistant records (one `Edit` with `file_path: 'src/tax-math.js'`, one `Bash` with `command: 'node --test tests/'`), 2 `tool_result` user records, 1 sidechain assistant record, 1 compact summary user record. Total 30. Text turn 7 (owner) contains `sk-abcdefghijklmnopqrstuvwxyz123456`. Text turn 9 (owner) is `Never ship the invoice total rounding change again, it broke three orders.` Turn 10 (claude) is `Understood, the invoice rounding stays as it is.`

- [ ] **Step 1: Write the generator and the markdown fixtures**

`tests/fixtures/make-session.js`:
```js
'use strict';
const fs = require('node:fs');

const TEXT = [
  ['user', 'let us work on the Tax Math Calculator today'],
  ['assistant', 'Reading the calculator first. It lives in src/tax-math.js and uses tax-math-core.'],
  ['user', 'the invoice total result looks off by one percent'],
  ['assistant', 'The rounding happens before the invoice add. I propose rounding after it.'],
  ['user', 'approved, do it'],
  ['assistant', 'Done. Rounding now happens after the invoice total is added.'],
  ['user', 'here is the api key for later sk-abcdefghijklmnopqrstuvwxyz123456 keep it private'],
  ['assistant', 'I will not store that. Use an env file.'],
  ['user', 'Never ship the invoice total rounding change again, it broke three orders.'],
  ['assistant', 'Understood, the invoice rounding stays as it is.'],
  ['user', 'what about the refund calculator, is it still in pilot'],
  ['assistant', 'The refund calculator is public since August 27; the flag file reverts it to pilot.'],
];

function rec(type, content, i, sid, day, extra = {}) {
  const ts = new Date(`${day}T10:${String(i).padStart(2, '0')}:00.000Z`).toISOString();
  return JSON.stringify({
    parentUuid: null, isSidechain: false, type,
    message: { role: type, content },
    uuid: `u-${i}`, timestamp: ts, sessionId: sid, cwd: 'C:\\proj', version: '2.1.260', gitBranch: 'master', ...extra,
  });
}

function makeSession(outFile, opts = {}) {
  const sid = opts.sessionId || 'fix-session-1';
  const day = opts.day || '2026-09-10';
  const lines = [];
  let i = 0;
  for (const [role, text] of TEXT) lines.push(rec(role, text, i++, sid, day));
  lines.push(rec('assistant', [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/tax-math.js', old_string: 'a', new_string: 'b' } }], i++, sid, day));
  lines.push(rec('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'The file src/tax-math.js has been updated' }], i++, sid, day));
  lines.push(rec('assistant', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'node --test tests/', description: 'run tests' } }], i++, sid, day));
  lines.push(rec('user', [{ type: 'tool_result', tool_use_id: 't2', content: 'pass 12 fail 0' }], i++, sid, day));
  lines.push(rec('assistant', [{ type: 'text', text: 'subagent chatter that must not be stored' }], i++, sid, day, { isSidechain: true }));
  lines.push(rec('user', 'Summary of the conversation so far: the invoice rounding was moved after the add and then frozen by owner directive.', i++, sid, day, { isCompactSummary: true }));
  fs.writeFileSync(outFile, lines.join('\n') + '\n');
  return { records: lines.length, turns: TEXT.length };
}

module.exports = { makeSession, TEXT };
```

`tests/fixtures/memory-feedback.md`:
```markdown
---
name: never-text-only-logo
description: Never ship a text-only logo; the full logo at every size.
metadata:
  type: feedback
---

Never ship a text-only logo. The owner would rather eat the file size.

**Why:** the old icon was rejected on sight on 2026-09-17.
**How to apply:** keep the full logo at 16, 32 and 48.
```

`tests/fixtures/handoff-v1.md`:
```markdown
# Claude session handoff, 2026-09-10

## What shipped

The Tax Math rounding fix, commit abc123.

## Open

The refund calculator flag file still needs a test.
```

`tests/fixtures/handoff-v2.md` (same file, one section edited):
```markdown
# Claude session handoff, 2026-09-10

## What shipped

The Tax Math rounding fix, commit abc123, and its guard test.

## Open

The refund calculator flag file still needs a test.
```

- [ ] **Step 2: Verify the generator runs**

Run: `node -e "const {makeSession}=require('./tests/fixtures/make-session');console.log(makeSession(require('os').tmpdir()+'/tr-fix.jsonl'))"`
Expected: `{ records: 30, turns: 12 }`

- [ ] **Step 3: Commit**

```bash
git -C C:/Users/<you>/total_recall add tests/fixtures
```
```bash
CLAUDE_USER_APPROVED=1 git -C C:/Users/<you>/total_recall commit -m 'test: deterministic session and markdown fixtures

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

---

### Task 7: Ingest

**Files:**
- Create: `lib/ingest.js`
- Test: `tests/ingest.test.js`

**Interfaces:**
- Consumes: `openStore`, `scrub`, `loadConfig`, `noConfigMessage`, `tests/fixtures/make-session.js`.
- Produces: `recordToDoc(rec, project) -> doc|null`; `splitSections(text, kind) -> [{ title, body, ts|null }]`; `parseSelector(flags) -> { mode: 'new'|'all'|'range'|'session', since?, to?, session? }`; `ingestTranscripts(store, cfg, sel) -> { turns, skipped, superseded }`; `ingestMarkdown(store, cfg, sel) -> { sections, skipped, superseded, standing }`; `run(cfg, sel, store?) -> { turns, sections, skipped, superseded, standing, seconds }`; `command(args) -> number`.
- Date selectors compare against ISO `ts`; `--since 2026-09-01` means `ts >= '2026-09-01'`; `--to D` means `ts < D + 1 day`.

- [ ] **Step 1: Write the failing test**

`tests/ingest.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../lib/store');
const ingest = require('../lib/ingest');
const { makeSession } = require('./fixtures/make-session');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-ingest-'));
  const transcripts = path.join(root, 'transcripts');
  const notes = path.join(root, 'notes');
  const memory = path.join(root, 'memory');
  fs.mkdirSync(transcripts); fs.mkdirSync(notes); fs.mkdirSync(memory);
  makeSession(path.join(transcripts, 'fix-session-1.jsonl'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'handoff-v1.md'), path.join(notes, 'SESSION-HANDOFF-2026-09-10.md'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'memory-feedback.md'), path.join(memory, 'feedback_logo.md'));
  const cfg = {
    project: 'demo', root, transcripts,
    sources: { handoff: path.join(notes, 'SESSION-HANDOFF-*.md'), memory: path.join(memory, '*.md') },
    store: path.join(root, 'store.sqlite'),
  };
  return { root, cfg, transcripts, notes, store: openStore(cfg.store) };
}

test('transcript ingest keeps text turns, tool-only turns with files, compact summaries; drops sidechain and tool results; scrubs', () => {
  const { cfg, store } = setup();
  const r = ingest.run(cfg, { mode: 'new' }, store);
  assert.equal(r.turns, 12 + 2 + 1); // 12 text, 2 tool-only, 1 compact summary
  const turns = store.turnsForSession('fix-session-1');
  assert.equal(turns.length, 14);
  assert.ok(!turns.some((t) => /subagent chatter/.test(t.body)));
  assert.ok(!turns.some((t) => /pass 12 fail 0/.test(t.body)));
  const keyTurn = turns.find((t) => /api key for later/.test(t.body));
  assert.match(keyTurn.body, /\[scrubbed\]/);
  assert.doesNotMatch(keyTurn.body, /sk-abc/);
  const edit = turns.find((t) => JSON.parse(t.files_json).includes('src/tax-math.js'));
  assert.ok(edit, 'edit turn carries its file');
  assert.deepEqual(JSON.parse(edit.tools_json), ['Edit']);
  const cs = store.search('"invoice"', { kinds: ['compact_summary'], limit: 5 });
  assert.equal(cs.length, 1);
  store.close();
});

test('second run adds nothing; appended records ingest exactly; truncation re-reads and supersedes', () => {
  const { cfg, store, transcripts } = setup();
  ingest.run(cfg, { mode: 'new' }, store);
  const again = ingest.run(cfg, { mode: 'new' }, store);
  assert.equal(again.turns, 0);
  const file = path.join(transcripts, 'fix-session-1.jsonl');
  const extra = [1, 2, 3].map((i) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: `late note ${i}` }, timestamp: `2026-09-10T11:0${i}:00.000Z`, sessionId: 'fix-session-1' })).join('\n') + '\n';
  fs.appendFileSync(file, extra);
  assert.equal(ingest.run(cfg, { mode: 'new' }, store).turns, 3);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: 'rewritten from zero' }, timestamp: '2026-09-10T12:00:00.000Z', sessionId: 'fix-session-1' }) + '\n');
  const r = ingest.run(cfg, { mode: 'new' }, store);
  assert.equal(r.turns, 1);
  assert.ok(r.superseded >= 17);
  assert.equal(store.turnsForSession('fix-session-1').length, 1);
  store.close();
});

test('markdown sections, feedback memory becomes a standing statement, edited handoff supersedes its section', () => {
  const { cfg, store, notes } = setup();
  const r = ingest.run(cfg, { mode: 'new' }, store);
  assert.equal(r.sections, 2 + 1);   // two handoff sections + one memory doc
  assert.equal(r.standing, 1);
  const st = store.standing(10);
  assert.equal(st.length, 1);
  assert.equal(st[0].who, 'owner');
  assert.match(st[0].title, /text-only logo/);
  assert.match(st[0].quote, /Never ship a text-only logo/);
  const shipped = store.search('"abc123"', { kinds: ['handoff'], limit: 5 });
  assert.equal(shipped.length, 1);
  assert.equal(shipped[0].ts.slice(0, 10), '2026-09-10');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'handoff-v2.md'), path.join(notes, 'SESSION-HANDOFF-2026-09-10.md'));
  const r2 = ingest.run(cfg, { mode: 'new' }, store);
  assert.equal(r2.superseded, 2);
  const after = store.search('"abc123"', { kinds: ['handoff'], limit: 5 });
  assert.equal(after.length, 1);
  assert.match(after[0].body, /guard test/);
  const old = store.search('"abc123"', { kinds: ['handoff'], includeSuperseded: true, limit: 5 }).find((d) => d.status === 'superseded');
  assert.equal(old.superseded_by, after[0].id);
  store.close();
});

test('selectors: range filters by ts and leaves offsets alone; session selects one file', () => {
  const { cfg, store } = setup();
  const r = ingest.run(cfg, { mode: 'range', since: '2026-09-11', to: '2026-09-12' }, store);
  assert.equal(r.turns, 0);
  assert.equal(store.getSource(path.join(cfg.transcripts, 'fix-session-1.jsonl')), undefined);
  const s = ingest.run(cfg, { mode: 'session', session: 'fix-session-1' }, store);
  assert.equal(s.turns, 15);
  assert.deepEqual(ingest.parseSelector({ all: true }), { mode: 'all' });
  assert.deepEqual(ingest.parseSelector({ since: '2026-09-01' }), { mode: 'range', since: '2026-09-01', to: undefined });
  assert.deepEqual(ingest.parseSelector({ from: '2026-09-01', to: '2026-09-02' }), { mode: 'range', since: '2026-09-01', to: '2026-09-02' });
  assert.deepEqual(ingest.parseSelector({}), { mode: 'new' });
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ingest.test.js`
Expected: FAIL, `Cannot find module '../lib/ingest'`

- [ ] **Step 3: Write ingest.js**

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, noConfigMessage } = require('./config');
const { openStore, sha256 } = require('./store');
const { scrub } = require('./scrub');

const PATHISH = /(?:^|\s)((?:[A-Za-z]:)?[\w.\-~]*(?:[\/\\][\w.\-~]+)+\.[A-Za-z0-9]{1,8})(?=\s|$)/;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

function toolsAndFiles(content) {
  const tools = [], files = [];
  if (!Array.isArray(content)) return { tools, files };
  for (const b of content) {
    if (!b || b.type !== 'tool_use') continue;
    if (b.name) tools.push(b.name);
    const inp = b.input || {};
    for (const k of ['file_path', 'path', 'notebook_path']) if (typeof inp[k] === 'string') files.push(inp[k]);
    if (typeof inp.command === 'string') { const m = PATHISH.exec(inp.command); if (m) files.push(m[1]); }
  }
  return { tools: [...new Set(tools)], files: [...new Set(files)] };
}

// One Claude Code transcript record -> one doc, or null when it is not ours to keep.
function recordToDoc(rec, project) {
  if (!rec || (rec.type !== 'user' && rec.type !== 'assistant')) return null;
  if (rec.isSidechain) return null;
  const msg = rec.message || {};
  const content = msg.content;
  if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) return null;
  const body = scrub(textOf(content)).trim();
  const { tools, files } = toolsAndFiles(content);
  if (!body && !files.length) return null;
  const kind = rec.isCompactSummary ? 'compact_summary' : 'turn';
  const title = body ? body.slice(0, 80) : files.join(' ');
  return {
    project, kind, session_id: rec.sessionId || null, ts: rec.timestamp, role: rec.type,
    title, body: body || `(tool-only turn: ${tools.join(', ')})`,
    files_json: JSON.stringify(files), tools_json: JSON.stringify(tools),
  };
}

function parseSelector(flags) {
  if (flags.all) return { mode: 'all' };
  if (flags.session && typeof flags.session === 'string') return { mode: 'session', session: flags.session };
  if (flags.since || flags.from) return { mode: 'range', since: flags.since || flags.from, to: flags.to };
  if (flags.today) { const d = new Date().toISOString().slice(0, 10); return { mode: 'range', since: d, to: d }; }
  return { mode: 'new' };
}

function inRange(ts, sel) {
  if (sel.mode !== 'range') return true;
  if (sel.since && ts < sel.since) return false;
  if (sel.to) { const end = new Date(sel.to + 'T00:00:00.000Z'); end.setUTCDate(end.getUTCDate() + 1); if (ts >= end.toISOString()) return false; }
  return true;
}

function headSha(file) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, 0); return sha256(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
}

function ingestTranscripts(store, cfg, sel) {
  const out = { turns: 0, skipped: 0, superseded: 0 };
  if (!fs.existsSync(cfg.transcripts)) return out;
  let files = fs.readdirSync(cfg.transcripts).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(cfg.transcripts, f));
  if (sel.mode === 'session') files = files.filter((f) => path.basename(f, '.jsonl') === sel.session);
  const trackProgress = sel.mode === 'new' || sel.mode === 'all';
  for (const file of files) {
    const st = fs.statSync(file);
    const sha = headSha(file);
    const prev = store.getSource(file);
    let offset = 0;
    if (trackProgress && prev && sel.mode === 'new') {
      if (st.size < prev.offset || prev.sha !== sha) { out.superseded += store.supersedePath(file); offset = 0; }
      else offset = prev.offset;
    }
    if (offset >= st.size) continue;
    const buf = Buffer.alloc(st.size - offset);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    const complete = lastNl === -1 ? '' : text.slice(0, lastNl + 1);
    for (const line of complete.split('\n')) {
      if (!line.trim()) continue;
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      const doc = recordToDoc(rec, cfg.project);
      if (!doc || !inRange(doc.ts, sel)) continue;
      doc.path = file;
      const r = store.insertDoc(doc);
      if (r.inserted) out.turns++; else out.skipped++;
    }
    if (trackProgress) {
      store.setSource({ path: file, kind: 'transcript', size: st.size, mtime: st.mtime.toISOString(), sha, offset: offset + Buffer.byteLength(complete, 'utf8'), ingested_at: new Date().toISOString() });
    }
  }
  return out;
}

function globFiles(pattern) {
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f)).sort();
}

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const mm = /^\s*([\w-]+):\s*(.*)$/.exec(line);
    if (mm) meta[mm[1]] = mm[2].trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

function splitSections(text, kind) {
  const sections = [];
  if (kind === 'changelog') {
    const parts = text.split(/\n(?=\*\*\d{4}-\d{2}-\d{2})/);
    for (const p of parts) {
      const m = /^\*\*(\d{4}-\d{2}-\d{2})\s*[,:]?\s*([^*]+)\*\*/.exec(p.trim());
      if (!m) continue;
      sections.push({ title: m[2].trim(), body: p.trim(), ts: `${m[1]}T00:00:00.000Z` });
    }
    return sections;
  }
  const parts = text.split(/\n(?=## )/);
  for (const p of parts) {
    const m = /^## +(.+)\n?([\s\S]*)$/.exec(p.trim());
    if (!m) continue;
    const body = m[2].trim();
    if (!body) continue;
    sections.push({ title: m[1].trim(), body, ts: null });
  }
  return sections;
}

function ingestMarkdown(store, cfg, sel) {
  const out = { sections: 0, skipped: 0, superseded: 0, standing: 0 };
  for (const [kind, pattern] of Object.entries(cfg.sources || {})) {
    for (const file of globFiles(pattern)) {
      const raw = fs.readFileSync(file, 'utf8');
      const sha = sha256(raw);
      const st = fs.statSync(file);
      const prev = store.getSource(file);
      if (prev && prev.sha === sha) continue;
      if (prev) out.superseded += store.supersedePath(file);
      const fileDate = DATE_RE.exec(path.basename(file));
      const fallbackTs = fileDate ? `${fileDate[1]}T00:00:00.000Z` : st.mtime.toISOString();
      const { meta, body } = parseFrontmatter(raw);
      const docs = [];
      if (kind === 'memory') {
        const title = meta.description || path.basename(file, '.md');
        docs.push({ kind, title, body: scrub(body.trim()), ts: fallbackTs });
        if (meta.type === 'feedback' || /^\s*type:\s*feedback/m.test(raw)) {
          const firstLine = body.trim().split('\n').find((l) => l.trim()) || title;
          docs.push({ kind: 'statement', title, body: `${title}\n${firstLine}\n(from ${path.basename(file)})`, ts: fallbackTs,
            who: 'owner', outcome: 'standing', quote: scrub(firstLine.trim()).slice(0, 240), evidence_ids: '[]' });
        }
      } else {
        for (const s of splitSections(body, kind)) docs.push({ kind, title: s.title, body: scrub(s.body), ts: s.ts || fallbackTs });
      }
      for (const d of docs) {
        if (!inRange(d.ts, sel)) continue;
        const r = store.insertDoc({ project: cfg.project, path: file, ...d });
        if (!r.inserted) { out.skipped++; continue; }
        if (d.kind === 'statement') out.standing++; else out.sections++;
      }
      store.linkSupersession(file);
      store.setSource({ path: file, kind, size: st.size, mtime: st.mtime.toISOString(), sha, offset: st.size, ingested_at: new Date().toISOString() });
    }
  }
  return out;
}

function run(cfg, sel, store) {
  const t0 = Date.now();
  const own = !store;
  const s = store || openStore(cfg.store);
  try {
    const a = ingestTranscripts(s, cfg, sel);
    const b = ingestMarkdown(s, cfg, sel);
    return { turns: a.turns, sections: b.sections, skipped: a.skipped + b.skipped, superseded: a.superseded + b.superseded, standing: b.standing, seconds: (Date.now() - t0) / 1000 };
  } finally { if (own) s.close(); }
}

function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const r = run(cfg, parseSelector(args.flags));
  process.stdout.write(`ingested ${r.turns} turns, ${r.sections} file sections (${r.superseded} superseded, ${r.standing} standing rules), ${r.skipped} skipped (already present), ${r.seconds.toFixed(1)} seconds\n`);
  return 0;
}

module.exports = { recordToDoc, splitSections, parseSelector, ingestTranscripts, ingestMarkdown, run, command, globFiles };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ingest.test.js`
Expected: 4 passing. If the truncation test's `superseded` count is off, the number to expect is 17 (14 turns + 3 appended, all superseded when the file is rewritten).

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/<you>/total_recall add lib/ingest.js tests/ingest.test.js
```
```bash
CLAUDE_USER_APPROVED=1 git -C C:/Users/<you>/total_recall commit -m 'feat: ingest transcripts and notes with per-source progress and supersession

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

---

### Task 8: Search

**Files:**
- Create: `lib/search.js`
- Test: `tests/search.test.js`

**Interfaces:**
- Consumes: `Store.search`, `Store.recentUndistilledTurns`, `Store.sessionsWithRuns`, `Store.getDoc`, `Store.neighbours`, `gate.ack`, `resolveSessionId`.
- Produces: `buildMatch(query) -> string|null` (each bare token becomes `"tok"`, quoted phrases stay phrases, all OR-joined; null for an empty query); `runSearch(store, cfg, opts) -> { distilled: rows, raw: rows, deepBlocks: [{ hit, turns }] }` with `opts = { query, kinds, who, outcomes, files, session, since, deep, limit, includeSuperseded }`; `format(result, opts) -> string`; `command(args) -> number`.
- Default kinds `['statement','handoff','memory','compact_summary']`. `--kind all` = every kind. Raw fallback runs unless `kinds` includes `turn`.

- [ ] **Step 1: Write the failing test**

`tests/search.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.TOTAL_RECALL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-search-home-'));
const { openStore } = require('../lib/store');
const ingest = require('../lib/ingest');
const search = require('../lib/search');
const gate = require('../lib/gate');
const { makeSession } = require('./fixtures/make-session');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-search-'));
  const transcripts = path.join(root, 'transcripts'); fs.mkdirSync(transcripts);
  const today = new Date().toISOString().slice(0, 10);
  makeSession(path.join(transcripts, 'fix-session-1.jsonl'), { day: today });
  const cfg = { project: 'demo', root, transcripts, sources: {}, store: path.join(root, 's.sqlite'), search: { rawRecentDays: 7, rawRecentLimit: 5 } };
  const store = openStore(cfg.store);
  ingest.run(cfg, { mode: 'new' }, store);
  return { cfg, store };
}

test('buildMatch quotes tokens, keeps phrases, OR-joins', () => {
  assert.equal(search.buildMatch('tax math "invoice total"'), '"tax" OR "math" OR "invoice total"');
  assert.equal(search.buildMatch('  '), null);
});

test('an undistilled recent session surfaces under RAW; a distilled one does not', () => {
  const { cfg, store } = setup();
  const r = search.runSearch(store, cfg, { query: 'invoice rounding' });
  assert.equal(r.distilled.length, 1); // the compact summary
  assert.ok(r.raw.length >= 1, 'raw fallback present');
  assert.match(search.format(r, { query: 'invoice rounding' }), /RAW, not yet distilled/);
  const t = store.turnsForSession('fix-session-1');
  store.insertRun({ session_id: 'fix-session-1', turn_from: t[0].id, turn_to: t[t.length - 1].id, model: 'm', prompt_sha: 'p', ran_at: 'now', lines: 0 });
  const r2 = search.runSearch(store, cfg, { query: 'invoice rounding' });
  assert.equal(r2.raw.length, 0);
  store.close();
});

test('--deep follows evidence to the turn and its neighbours; --files and --kind filter', () => {
  const { cfg, store } = setup();
  const t = store.turnsForSession('fix-session-1');
  const owner = t.find((x) => /Never ship the invoice/.test(x.body));
  store.insertDoc({ project: 'demo', kind: 'statement', session_id: 'fix-session-1', ts: owner.ts, title: 'Invoice rounding change must never ship again', body: 'Invoice rounding change must never ship again\nquote', who: 'owner', outcome: 'standing', quote: 'Never ship the invoice total rounding change again', evidence_ids: JSON.stringify([owner.id]) });
  const r = search.runSearch(store, cfg, { query: 'invoice', deep: true, kinds: ['statement'] });
  assert.equal(r.distilled.length, 1);
  assert.equal(r.deepBlocks.length, 1);
  const ids = r.deepBlocks[0].turns.map((x) => x.id);
  assert.ok(ids.includes(owner.id));
  assert.equal(ids.length, 3);
  const out = search.format(r, { query: 'invoice', deep: true });
  assert.match(out, /owner standing/);
  assert.match(out, /quote: "Never ship/);
  const byFile = search.runSearch(store, cfg, { query: 'tool-only', kinds: ['turn'], files: 'src/*.js' });
  assert.equal(byFile.distilled.length, 1);
  store.close();
});

test('a search opens the gate for the session it was given', () => {
  const { cfg, store } = setup();
  assert.equal(gate.isOpen('demo', 'sid-x'), false);
  search.runSearch(store, cfg, { query: 'tax math' }, 'sid-x');
  assert.equal(gate.isOpen('demo', 'sid-x'), true);
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/search.test.js`
Expected: FAIL, `Cannot find module '../lib/search'`

- [ ] **Step 3: Write search.js**

```js
'use strict';
const { loadConfig, noConfigMessage } = require('./config');
const { openStore } = require('./store');
const gate = require('./gate');
const { resolveSessionId } = require('./session');

const DISTILLED = ['statement', 'handoff', 'memory', 'compact_summary'];
const ALL = ['turn', ...DISTILLED, 'changelog'];

function buildMatch(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const parts = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    const tok = (m[1] || m[2]).replace(/"/g, '').trim();
    if (tok) parts.push(`"${tok}"`);
  }
  return parts.length ? parts.join(' OR ') : null;
}

function parseKinds(flag) {
  if (!flag || flag === true) return DISTILLED;
  if (flag === 'all') return ALL;
  return String(flag).split(',').map((s) => s.trim()).filter(Boolean);
}

function deepFor(store, hit) {
  let ids = [];
  try { ids = JSON.parse(hit.evidence_ids || '[]'); } catch {}
  if (!ids.length && hit.kind === 'turn') ids = [hit.id];
  const seen = new Map();
  for (const id of ids) {
    const d = store.getDoc(id);
    if (!d) continue;
    const { prev, next } = store.neighbours(id);
    for (const t of [prev, d, next]) if (t) seen.set(t.id, t);
  }
  return [...seen.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id));
}

function runSearch(store, cfg, opts, sid) {
  const match = buildMatch(opts.query);
  const kinds = opts.kinds || DISTILLED;
  const result = { distilled: [], raw: [], deepBlocks: [] };
  if (match) {
    result.distilled = store.search(match, {
      kinds, who: opts.who, outcomes: opts.outcomes, since: opts.since, session: opts.session,
      files: opts.files, limit: opts.limit || 12, includeSuperseded: !!opts.includeSuperseded,
    });
    if (!kinds.includes('turn')) {
      const days = (cfg.search && cfg.search.rawRecentDays) || 7;
      const lim = (cfg.search && cfg.search.rawRecentLimit) || 5;
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const exclude = store.sessionsWithRuns();
      for (const h of store.handoffsBetween(since, '9999')) {
        // a session with a handoff written the same day counts as covered
        for (const sidx of store.recentSessionIds(50)) {
          const turns = store.turnsForSession(sidx);
          if (turns.length && turns[turns.length - 1].ts.slice(0, 10) === h.ts.slice(0, 10)) exclude.add(sidx);
        }
      }
      result.raw = store.recentUndistilledTurns(match, since, lim, exclude);
    }
    if (opts.deep) {
      for (const hit of result.distilled.slice(0, opts.deepLimit || 6)) result.deepBlocks.push({ hit, turns: deepFor(store, hit) });
    }
  }
  if (sid) gate.ack(cfg.project, sid);
  return result;
}

function header(d) {
  const tag = d.kind === 'statement' ? ` [${d.who} ${d.outcome}]` : '';
  const struck = d.superseded_by ? ' STRUCK' : '';
  return `#${d.id} ${d.kind} ${String(d.ts).slice(0, 10)} ${d.session_id ? d.session_id.slice(0, 8) : 'file'}${tag}${struck}`;
}

function format(result, opts) {
  const lines = [];
  if (!result.distilled.length && !result.raw.length) lines.push(`no hits for "${opts.query}"`);
  for (const d of result.distilled) {
    lines.push(header(d), `  ${d.title}`);
    if (d.kind === 'statement' && d.quote) lines.push(`  quote: "${d.quote}"`);
    if (d.kind === 'statement' && d.reason) lines.push(`  reason: ${d.reason}`);
  }
  if (result.raw.length) {
    lines.push('', 'RAW, not yet distilled:');
    for (const d of result.raw) lines.push(header(d), `  ${d.role}: ${d.body.slice(0, 200).replace(/\s+/g, ' ')}`);
  }
  for (const b of result.deepBlocks) {
    lines.push('', `deep for ${header(b.hit)}:`);
    for (const t of b.turns) lines.push(`  [T${t.id}] ${t.role}: ${t.body.replace(/\s+/g, ' ').slice(0, 600)}`);
  }
  return lines.join('\n') + '\n';
}

function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const query = args.positional.join(' ');
  if (!query.trim()) { process.stderr.write('total_recall search: give a query\n'); return 1; }
  const f = args.flags;
  const opts = {
    query, kinds: parseKinds(f.kind), who: typeof f.who === 'string' ? f.who : undefined,
    outcomes: typeof f.outcome === 'string' ? f.outcome.split(',') : undefined,
    files: typeof f.files === 'string' ? f.files : undefined, session: typeof f.session === 'string' ? f.session : undefined,
    since: typeof f.since === 'string' ? f.since : undefined, deep: !!f.deep,
    limit: f.limit ? Number(f.limit) : 12, includeSuperseded: !!f['include-superseded'],
  };
  const sid = resolveSessionId({ payload: null, flags: {} });
  const store = openStore(cfg.store);
  try {
    const r = runSearch(store, cfg, opts, sid);
    process.stdout.write(format(r, opts));
    if (!sid) process.stdout.write('(no session id; gate not touched)\n');
  } finally { store.close(); }
  return 0;
}

module.exports = { buildMatch, parseKinds, runSearch, format, command, DISTILLED, ALL };
```

Note: `resolveSessionId` in `command` deliberately passes empty `flags` for the session id so that `--session` on search means "filter to that session", not "act as that session"; the gate is opened for the env session only.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/search.test.js`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/<you>/total_recall add lib/search.js tests/search.test.js
```
```bash
CLAUDE_USER_APPROVED=1 git -C C:/Users/<you>/total_recall commit -m 'feat: search with raw-recent fallback, deep evidence and gate marker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

---

### Task 9: Distill

**Files:**
- Create: `lib/distill.js`
- Test: `tests/distill.test.js`

**Interfaces:**
- Consumes: `Store.turnsForSession`, `Store.recentSessionIds`, `Store.hasRun`, `Store.insertRun`, `Store.insertDoc`, `ingest.parseSelector`.
- Produces: `PROMPT` (string), `PROMPT_SHA`; `chunkTurns(turns, maxChars) -> [{ turns, turn_from, turn_to }]`; `renderChunk(turns) -> string`; `parseReply(text) -> { none: boolean, items: object[] }|null`; `validate(item, turns) -> { ok: true, statement } | { ok: false, reason }`; `distillSession(store, cfg, sid, opts) -> { sent, skipped, stored, dropped, dropReasons }`; `run(cfg, sel, opts, store?)`; `command(args) -> number`.
- Reply contract with Ollama: request `format: 'json'`, so the model answers ONE JSON object: `{ "none": true }` or `{ "items": [ { who, outcome, statement, quote, turn, reason } ] }`. `parseReply` also accepts a bare array and JSON-lines, so a model that ignores the shape still parses. (The spec wrote "one object per line"; `format: 'json'` needs a single object, so the object-with-items form is the wire shape and the spec's intent is unchanged.)
- `turn` is the integer after `T` in the rendered label; `evidence_ids` = `[turn]` plus the previous owner turn when the cited turn is Claude's.

- [ ] **Step 1: Write the failing test**

`tests/distill.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { openStore } = require('../lib/store');
const ingest = require('../lib/ingest');
const distill = require('../lib/distill');
const { makeSession } = require('./fixtures/make-session');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-distill-'));
  const transcripts = path.join(root, 'transcripts'); fs.mkdirSync(transcripts);
  makeSession(path.join(transcripts, 'fix-session-1.jsonl'));
  const cfg = { project: 'demo', root, transcripts, sources: {}, store: path.join(root, 's.sqlite'), ollama: { url: '', model: 'stub', chunkTokens: 6000 } };
  const store = openStore(cfg.store);
  ingest.run(cfg, { mode: 'new' }, store);
  return { cfg, store };
}

function stubOllama(replies) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.push(JSON.parse(body));
      const reply = replies.shift();
      if (reply === 'HTTP500') { res.writeHead(500); res.end('boom'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: reply }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}

test('chunking keeps order and respects the size', () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, role: 'user', body: 'x'.repeat(100), ts: `2026-09-10T10:0${i}:00.000Z` }));
  const chunks = distill.chunkTurns(turns, 350);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0].turn_from, 1);
  assert.equal(chunks[chunks.length - 1].turn_to, 10);
});

test('valid items become statements with evidence; bad quote and bad turn are dropped and counted; NONE still records a run', async () => {
  const { cfg, store } = setup();
  const turns = store.turnsForSession('fix-session-1');
  const owner = turns.find((t) => /Never ship the invoice/.test(t.body));
  const claude = turns.find((t) => /Understood, the invoice/.test(t.body));
  const good = { who: 'owner', outcome: 'standing', statement: 'Invoice rounding change must never ship again', quote: 'Never ship the invoice total rounding change again', turn: owner.id, reason: 'it broke three orders' };
  const ack = { who: 'claude', outcome: 'approved', statement: 'Claude confirmed the rounding stays', quote: 'the invoice rounding stays as it is', turn: claude.id, reason: null };
  const badQuote = { who: 'owner', outcome: 'approved', statement: 'made up', quote: 'this sentence is not in the turn', turn: owner.id, reason: null };
  const badTurn = { who: 'owner', outcome: 'approved', statement: 'x', quote: 'approved, do it', turn: 999999, reason: null };
  const stub = await stubOllama([JSON.stringify({ items: [good, ack, badQuote, badTurn] })]);
  cfg.ollama.url = stub.url;
  const r = await distill.distillSession(store, cfg, 'fix-session-1', {});
  stub.close();
  assert.equal(r.sent, 1);
  assert.equal(r.stored, 2);
  assert.equal(r.dropped, 2);
  const st = store.standing(10);
  assert.equal(st.length, 1);
  assert.deepEqual(JSON.parse(st[0].evidence_ids), [owner.id]);
  assert.equal(st[0].reason, 'it broke three orders');
  const conf = store.search('"confirmed"', { kinds: ['statement'], limit: 5 })[0];
  assert.deepEqual(JSON.parse(conf.evidence_ids).sort((a, b) => a - b), [owner.id, claude.id]);
  assert.equal(conf.reason, null);
  const stub2 = await stubOllama([JSON.stringify({ none: true })]);
  cfg.ollama.url = stub2.url;
  const r2 = await distill.distillSession(store, cfg, 'fix-session-1', {});
  stub2.close();
  assert.equal(r2.sent, 0, 'same chunk, same prompt: nothing re-sent');
  const r3 = await distill.distillSession(store, cfg, 'fix-session-1', { model: 'other-model' });
  assert.equal(r3.sent, 0, 'stub is closed, but the chunk under a new model was not skipped by the run table; it fails instead');
  store.close();
});

test('NONE writes a run row; empty and 500 replies fail loud with nothing stored', async () => {
  const { cfg, store } = setup();
  const stub = await stubOllama([JSON.stringify({ none: true })]);
  cfg.ollama.url = stub.url;
  const r = await distill.distillSession(store, cfg, 'fix-session-1', {});
  stub.close();
  assert.equal(r.sent, 1); assert.equal(r.stored, 0);
  assert.equal(store.sessionsWithRuns().has('fix-session-1'), true);
  const stub2 = await stubOllama(['']);
  cfg.ollama.url = stub2.url;
  await assert.rejects(() => distill.distillSession(store, cfg, 'fix-session-1', { model: 'm2' }), /empty reply/);
  stub2.close();
  const stub3 = await stubOllama(['HTTP500']);
  cfg.ollama.url = stub3.url;
  await assert.rejects(() => distill.distillSession(store, cfg, 'fix-session-1', { model: 'm3' }), /500/);
  stub3.close();
  assert.equal(store.search('"anything"', { kinds: ['statement'], limit: 5 }).length, 0);
  store.close();
});
```

Correction to the second test's last assertion before running it: `r3` will reject because the stub is closed. Replace those two lines with:
```js
  await assert.rejects(() => distill.distillSession(store, cfg, 'fix-session-1', { model: 'other-model' }));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/distill.test.js`
Expected: FAIL, `Cannot find module '../lib/distill'`

- [ ] **Step 3: Write distill.js**

```js
'use strict';
const { loadConfig, noConfigMessage } = require('./config');
const { openStore, sha256 } = require('./store');
const { parseSelector } = require('./ingest');

const OUTCOMES = new Set(['proposed', 'approved', 'rejected', 'completed', 'superseded', 'standing', 'open']);
const WHO = new Set(['owner', 'claude']);

const PROMPT = `You are reading a slice of a work session between a software OWNER and CLAUDE. Each turn is labelled [T<id>] owner: or [T<id>] claude:. Extract every statement worth remembering later: a proposal, an approval, a rejection, a correction, an owner instruction, a completed piece of work, or an item left open.
Answer with ONE JSON object and nothing else. Shape: {"items":[{"who":"owner"|"claude","outcome":"proposed"|"approved"|"rejected"|"completed"|"superseded"|"standing"|"open","statement":"<under 30 words, plain>","quote":"<a verbatim sentence copied from one turn, under 240 characters>","turn":<the T number that quote came from>,"reason":"<the reason as stated, or null if none was given; never invent one>"}]}
Use "standing" only for an owner rule meant to apply from now on (never, always, from now on, do not ... again). "who" is who made the statement. If nothing in the slice is worth remembering, answer exactly {"none":true}.
The slice:
`;
const PROMPT_SHA = sha256(PROMPT);

function chunkTurns(turns, maxChars) {
  const chunks = [];
  let cur = [], size = 0;
  for (const t of turns) {
    const len = t.body.length + 24;
    if (cur.length && size + len > maxChars) { chunks.push(cur); cur = []; size = 0; }
    cur.push(t); size += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((c) => ({ turns: c, turn_from: c[0].id, turn_to: c[c.length - 1].id }));
}

const label = (t) => (t.role === 'user' ? 'owner' : 'claude');
function renderChunk(turns) {
  return turns.map((t) => `[T${t.id}] ${label(t)}: ${t.body.replace(/\s+/g, ' ').trim()}`).join('\n');
}

function parseReply(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const tryJson = (x) => { try { return JSON.parse(x); } catch { return undefined; } };
  let j = tryJson(s);
  if (j === undefined) {
    const items = s.split('\n').map((l) => tryJson(l.trim())).filter((x) => x && typeof x === 'object');
    if (!items.length) return null;
    if (items.length === 1 && items[0].none) return { none: true, items: [] };
    return { none: false, items };
  }
  if (Array.isArray(j)) return { none: false, items: j };
  if (j && j.none) return { none: true, items: [] };
  if (j && Array.isArray(j.items)) return { none: false, items: j.items };
  return null;
}

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

function validate(item, turns) {
  if (!item || typeof item !== 'object') return { ok: false, reason: 'not an object' };
  if (!WHO.has(item.who)) return { ok: false, reason: `who=${item.who}` };
  if (!OUTCOMES.has(item.outcome)) return { ok: false, reason: `outcome=${item.outcome}` };
  if (typeof item.statement !== 'string' || !item.statement.trim()) return { ok: false, reason: 'no statement' };
  const turnId = Number(String(item.turn).replace(/^T/i, ''));
  const idx = turns.findIndex((t) => t.id === turnId);
  if (idx === -1) return { ok: false, reason: `turn ${item.turn} not in chunk` };
  const quote = String(item.quote || '').trim();
  if (!quote || quote.length > 240 || !collapse(turns[idx].body).includes(collapse(quote))) return { ok: false, reason: `quote not in T${turnId}` };
  const evidence = [turnId];
  if (turns[idx].role === 'assistant' && idx > 0 && turns[idx - 1].role === 'user') evidence.unshift(turns[idx - 1].id);
  const reason = typeof item.reason === 'string' && item.reason.trim() && item.reason.trim().toLowerCase() !== 'null' ? item.reason.trim() : null;
  return { ok: true, statement: { who: item.who, outcome: item.outcome, statement: item.statement.trim().slice(0, 300), quote, evidence, reason, ts: turns[idx].ts } };
}

async function callOllama(cfg, model, prompt) {
  const res = await fetch(`${cfg.ollama.url.replace(/\/$/, '')}/api/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, think: false, format: 'json', options: { temperature: 0, num_ctx: 8192 } }),
  });
  if (!res.ok) throw new Error(`ollama answered ${res.status} for ${model}`);
  const j = await res.json();
  const text = j && typeof j.response === 'string' ? j.response : '';
  if (!text.trim()) throw new Error('ollama returned an empty reply');
  return text;
}

async function distillSession(store, cfg, sid, opts) {
  const model = opts.model || cfg.ollama.model;
  const maxChars = (cfg.ollama.chunkTokens || 6000) * 4;
  const out = { sent: 0, skipped: 0, stored: 0, dropped: 0, dropReasons: [] };
  const turns = store.turnsForSession(sid);
  for (const chunk of chunkTurns(turns, maxChars)) {
    const key = { session_id: sid, turn_from: chunk.turn_from, turn_to: chunk.turn_to, model, prompt_sha: PROMPT_SHA };
    if (store.hasRun(key)) { out.skipped++; continue; }
    const reply = await callOllama(cfg, model, PROMPT + renderChunk(chunk.turns));
    out.sent++;
    const parsed = parseReply(reply);
    if (!parsed) throw new Error(`chunk T${chunk.turn_from}-T${chunk.turn_to}: reply was not parseable JSON; nothing stored`);
    let lines = 0;
    for (const item of parsed.items) {
      const v = validate(item, chunk.turns);
      if (!v.ok) { out.dropped++; if (out.dropReasons.length < 3) out.dropReasons.push(v.reason); continue; }
      const s = v.statement;
      const r = store.insertDoc({
        project: cfg.project, kind: 'statement', session_id: sid, ts: s.ts, path: null,
        title: s.statement, body: `${s.statement}\nquote: ${s.quote}${s.reason ? `\nreason: ${s.reason}` : ''}\nsession ${sid} ${s.ts.slice(0, 10)}`,
        who: s.who, outcome: s.outcome, evidence_ids: JSON.stringify(s.evidence), quote: s.quote, reason: s.reason,
      });
      if (r.inserted) { out.stored++; lines++; }
    }
    store.insertRun({ ...key, ran_at: new Date().toISOString(), lines });
  }
  return out;
}

async function run(cfg, sel, opts, store) {
  const own = !store;
  const s = store || openStore(cfg.store);
  const t0 = Date.now();
  try {
    let sessions;
    if (sel.mode === 'session') sessions = [sel.session];
    else {
      sessions = s.recentSessionIds(10000);
      if (sel.mode === 'range') {
        sessions = sessions.filter((sid) => { const t = s.turnsForSession(sid); if (!t.length) return false; const last = t[t.length - 1].ts; const first = t[0].ts;
          if (sel.since && last < sel.since) return false;
          if (sel.to) { const end = new Date(sel.to + 'T00:00:00.000Z'); end.setUTCDate(end.getUTCDate() + 1); if (first >= end.toISOString()) return false; }
          return true; });
      }
    }
    const total = { sent: 0, skipped: 0, stored: 0, dropped: 0, dropReasons: [], sessions: sessions.length };
    for (const sid of sessions) {
      const r = await distillSession(s, cfg, sid, opts);
      total.sent += r.sent; total.skipped += r.skipped; total.stored += r.stored; total.dropped += r.dropped;
      total.dropReasons.push(...r.dropReasons.slice(0, 3 - total.dropReasons.length));
    }
    total.seconds = (Date.now() - t0) / 1000;
    total.model = opts.model || cfg.ollama.model;
    return total;
  } finally { if (own) s.close(); }
}

async function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const sel = parseSelector(args.flags);
  if (sel.mode === 'new') sel.mode = 'all';
  const r = await run(cfg, sel, { model: typeof args.flags.model === 'string' ? args.flags.model : undefined });
  process.stdout.write(`distilled ${r.sessions} sessions: ${r.sent} chunks sent, ${r.skipped} already done, ${r.stored} statements stored, ${r.dropped} dropped by validation${r.dropReasons.length ? ` (${r.dropReasons.join('; ')})` : ''}, ${r.seconds.toFixed(1)} seconds, model ${r.model}\n`);
  return 0;
}

module.exports = { PROMPT, PROMPT_SHA, chunkTurns, renderChunk, parseReply, validate, distillSession, run, command };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/distill.test.js`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/<you>/total_recall add lib/distill.js tests/distill.test.js
```
```bash
CLAUDE_USER_APPROVED=1 git -C C:/Users/<you>/total_recall commit -m 'feat: distill turns into provenance-checked statements with a local model

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

---

### Task 10: Brief and session-start

**Files:**
- Create: `lib/brief.js`, `lib/session-start.js`
- Test: `tests/brief.test.js`

**Interfaces:**
- Consumes: `Store.standing`, `Store.standingCount`, `Store.recentSessionIds`, `Store.statementsForSessions`, `Store.handoffsBetween`, `Store.turnsForSession`, `ingest.run`, `gate.arm`, `readHookPayload`, `resolveSessionId`.
- Produces `lib/brief.js`: `recentFiles(root) -> Set<string>` (from `git -C root log -5 --name-only --format=`; empty set when git fails); `buildBrief(store, cfg, recent) -> string[]` (lines, capped); `command(args) -> number`.
- Produces `lib/session-start.js`: `command(args) -> number`: read hook payload, resolve sid, `gate.arm`, `ingest.run(cfg, { mode: 'new' })`, print one ingest line, then the brief.
- Scoring per spec section 13: +3 file match, +2 `open`, +1 `rejected`, +1 per day of recency inside the window (days since the oldest of the 3 sessions), `open` first within a tie.

- [ ] **Step 1: Write the failing test**

`tests/brief.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../lib/store');
const brief = require('../lib/brief');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-brief-'));
  const store = openStore(path.join(root, 's.sqlite'));
  const cfg = { project: 'demo', root, brief: { sessions: 3, maxLines: 40, standingLines: 15 } };
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const turn = (sid, n) => store.insertDoc({ project: 'demo', kind: 'turn', session_id: sid, ts: day(n), role: 'user', title: 't', body: `turn ${sid}` });
  for (let s = 1; s <= 5; s++) turn(`s${s}`, s);
  const st = (sid, n, over) => store.insertDoc({ project: 'demo', kind: 'statement', session_id: sid, ts: day(n), title: over.title, body: over.title, who: over.who || 'owner', outcome: over.outcome, quote: 'q', files_json: over.files || '[]' });
  st('s1', 1, { title: 'Recent decision', outcome: 'approved' });
  st('s1', 1, { title: 'Still open item', outcome: 'open' });
  st('s2', 2, { title: 'Touched the calculator', outcome: 'completed', files: JSON.stringify(['src/tax-math.js']) });
  st('s5', 5, { title: 'Too old to show', outcome: 'approved' });
  st('s5', 40, { title: 'Ancient standing rule', outcome: 'standing' });
  for (let i = 0; i < 20; i++) st('s1', 1, { title: `Standing rule ${i}`, outcome: 'standing' });
  return { store, cfg };
}

test('standing rules never age out and are capped with a pointer; open and file-matched lines rank first', () => {
  const { store, cfg } = setup();
  const lines = brief.buildBrief(store, cfg, new Set(['src/tax-math.js']));
  const text = lines.join('\n');
  assert.ok(lines.length <= 40);
  assert.equal(lines.filter((l) => / RULE /.test(l)).length, 15);
  assert.match(text, /\+6 more: total_recall search --outcome standing/);
  assert.doesNotMatch(text, /Too old to show/);
  const work = lines.filter((l) => /(open|approved|completed):/.test(l));
  assert.match(work[0], /Still open item|Touched the calculator/);
  assert.match(work[1], /Still open item|Touched the calculator/);
  assert.match(lines[lines.length - 1], /Run: total_recall search/);
  store.close();
});

test('empty store gives a one-line brief', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-brief-'));
  const store = openStore(path.join(root, 's.sqlite'));
  const lines = brief.buildBrief(store, { project: 'demo', root, brief: { sessions: 3, maxLines: 40, standingLines: 15 } }, new Set());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /empty/);
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/brief.test.js`
Expected: FAIL, `Cannot find module '../lib/brief'`

- [ ] **Step 3: Write brief.js and session-start.js**

`lib/brief.js`:
```js
'use strict';
const { execFileSync } = require('node:child_process');
const { loadConfig, noConfigMessage } = require('./config');
const { openStore } = require('./store');

function recentFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'log', '-5', '--name-only', '--format='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return new Set(out.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean));
  } catch { return new Set(); }
}

function mentionsRecentFile(d, recent) {
  if (!recent.size) return false;
  let files = [];
  try { files = JSON.parse(d.files_json || '[]'); } catch {}
  const text = `${d.title} ${d.body}`;
  for (const f of recent) {
    const base = f.split('/').pop();
    if (files.some((x) => String(x).replace(/\\/g, '/').endsWith(f))) return true;
    if (base && base.length > 5 && text.includes(base)) return true;
  }
  return false;
}

function buildBrief(store, cfg, recent) {
  const caps = cfg.brief || { sessions: 3, maxLines: 40, standingLines: 15 };
  const lines = [];
  const standing = store.standing(caps.standingLines);
  const standingTotal = store.standingCount();
  const sessions = store.recentSessionIds(caps.sessions);
  if (!standing.length && !sessions.length) return ['total_recall: store is empty; run  total_recall ingest --all'];
  lines.push('== total_recall brief ==');
  for (const s of standing) lines.push(`${s.ts.slice(0, 10)} RULE ${s.who}: ${s.title}`);
  if (standingTotal > standing.length) lines.push(`+${standingTotal - standing.length} more: total_recall search --outcome standing`);
  const budget = caps.maxLines - lines.length - 1;
  if (sessions.length && budget > 0) {
    const stmts = store.statementsForSessions(sessions).filter((d) => d.outcome !== 'standing');
    let oldest = '9999', newest = '0000';
    for (const sid of sessions) { const t = store.turnsForSession(sid); if (t.length) { oldest = t[0].ts < oldest ? t[0].ts : oldest; newest = t[t.length - 1].ts > newest ? t[t.length - 1].ts : newest; } }
    const handoffs = store.handoffsBetween(oldest.slice(0, 10), '9999');
    const rows = [...stmts, ...handoffs.map((h) => ({ ...h, who: 'handoff', outcome: 'note' }))];
    const t0 = Date.parse(oldest) || 0;
    const scored = rows.map((d) => {
      let score = 0;
      if (mentionsRecentFile(d, recent)) score += 3;
      if (d.outcome === 'open') score += 2;
      if (d.outcome === 'rejected') score += 1;
      score += Math.max(0, (Date.parse(d.ts) - t0) / 86400000);
      return { d, score };
    }).sort((a, b) => b.score - a.score || (a.d.outcome === 'open' ? -1 : b.d.outcome === 'open' ? 1 : 0));
    for (const { d } of scored.slice(0, budget)) lines.push(`${d.ts.slice(0, 10)} ${d.who} ${d.outcome}: ${d.title}`);
  }
  lines.push('Run: total_recall search "<topic>" before the first edit. --deep for the raw turns.');
  return lines;
}

function command() {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const store = openStore(cfg.store);
  try { process.stdout.write(buildBrief(store, cfg, recentFiles(cfg.root)).join('\n') + '\n'); }
  finally { store.close(); }
  return 0;
}

module.exports = { recentFiles, buildBrief, command };
```

`lib/session-start.js`:
```js
'use strict';
const { loadConfig, noConfigMessage } = require('./config');
const { openStore } = require('./store');
const { readHookPayload, resolveSessionId } = require('./session');
const gate = require('./gate');
const ingest = require('./ingest');
const brief = require('./brief');

// One process, in order: arm the gate, ingest what is new, print the brief.
// Claude Code runs the hooks of one event in parallel, so this cannot be three hook lines.
function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const payload = readHookPayload();
  const sid = resolveSessionId({ payload, flags: args.flags });
  if (sid) gate.arm(cfg.project, sid);
  const store = openStore(cfg.store);
  try {
    const r = ingest.run(cfg, { mode: 'new' }, store);
    process.stdout.write(`total_recall: ingested ${r.turns} turns, ${r.sections} sections (${r.seconds.toFixed(1)}s)${sid ? '' : '; no session id, gate not armed'}\n`);
    process.stdout.write(brief.buildBrief(store, cfg, brief.recentFiles(cfg.root)).join('\n') + '\n');
  } finally { store.close(); }
  return 0;
}

module.exports = { command };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/brief.test.js`
Expected: 2 passing. Then the whole suite: `node --test tests/` expected all passing.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/<you>/total_recall add lib/brief.js lib/session-start.js tests/brief.test.js
```
```bash
CLAUDE_USER_APPROVED=1 git -C C:/Users/<you>/total_recall commit -m 'feat: session brief with standing rules, and the sequential session-start

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

---

### Task 11: Skill, hook snippet, README

**Files:**
- Create: `skill/SKILL.md`, `hooks/settings.snippet.json`
- Modify: `README.md`

- [ ] **Step 1: Write the skill**

`skill/SKILL.md`:
```markdown
---
name: total_recall
description: Recall what earlier sessions decided, rejected and left open before touching code. Use before the first edit of a session, whenever the owner names a feature or file, when asked "what did we decide about X", and at end of day to distill.
---

# total_recall

The record of every earlier session, searchable. Distilled statements first (who said it, what
happened to it, the exact quote), raw turns behind them on demand.

## Rules

1. Before the first edit of a session, run
   `node C:/Users/<you>/total_recall/bin/total_recall.js search "<files or topic you are about to touch>"`.
   Read the distilled hits. A hit tagged `rejected` or `STRUCK` is a warning, not a suggestion.
   The edit gate stays shut until a search has run in this session.
2. If a hit has no reason, or two hits disagree, rerun with `--deep` and read the quoted turns.
   Never guess at a decision the record can answer.
3. `/total_recall <topic> --show`: run the search, print the hits verbatim to the owner, and STOP.
   Do not code until the owner says go. If the owner answers `--deep`, rerun with `--deep` and show
   again. Without `--show`, read silently and proceed.
4. When the owner says the day is done (any wording): write the project's session handoff first,
   then run `ingest`, then `distill --today`, and report the counts it prints.
5. Before a compaction, ask in one line whether to distill first. Otherwise never run `distill`
   unasked: it uses the GPU the owner may need.
6. `--outcome standing` lists every owner rule still in force. `--outcome rejected --since <date>`
   lists what was turned down. `--files "src/x/*"` narrows to turns that touched those files.

## Commands

    total_recall search "<query>" [--kind statement,turn|all] [--who owner|claude]
        [--outcome open,rejected,standing] [--files GLOB] [--since D] [--deep] [--limit N]
    total_recall brief
    total_recall ingest [--all | --since D | --from D --to D | --session ID]
    total_recall distill [--all | --since D | --from D --to D | --session ID | --today] [--model TAG]
    total_recall gate --ack        (only when a session genuinely has nothing to recall)
```

`hooks/settings.snippet.json`:
```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node C:/Users/<you>/total_recall/bin/total_recall.js session-start" } ] }
    ],
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [ { "type": "command", "command": "node C:/Users/<you>/total_recall/bin/total_recall.js gate --check" } ] },
      { "matcher": "Bash",
        "hooks": [ { "type": "command", "command": "node C:/Users/<you>/total_recall/bin/total_recall.js gate --check-bash" } ] }
    ]
  }
}
```

- [ ] **Step 2: Complete the README**

Append to `README.md`:
```markdown
## Install (per machine)

    git clone <this repo> C:/Users/<you>/total_recall
    mkdir -p ~/.claude/skills/total_recall && cp skill/SKILL.md ~/.claude/skills/total_recall/SKILL.md

Needs Node >= 22.13. For `distill`, a running Ollama with the model named in your config
(`ollama pull qwen3:14b`).

## Opt a project in

1. Put `total_recall.json` at the project root:

```json
{
  "project": "my-project",
  "transcripts": "C:/Users/<you>/.claude/projects/<the project's transcript folder>",
  "sources": {
    "handoff": "notes/SESSION-HANDOFF-*.md",
    "memory": "C:/Users/<you>/.claude/projects/<folder>/memory/*.md"
  }
}
```

2. Merge `hooks/settings.snippet.json` into the project's `.claude/settings.json`, fixing the path
   to this repo.
3. `node C:/Users/<you>/total_recall/bin/total_recall.js ingest --all`, then `distill --since <a date>`.

## What a session sees

At start: standing rules (never age out), then the last three sessions' statements, scored by the
files in your last five commits. Before the first edit: the gate blocks until
`total_recall search "<topic>"` has run. `--deep` shows the quoted turns behind any statement.

## Honest limits

- The gate is a checkpoint, not obedience: any search opens it, and the Bash write heuristic will
  miss shapes it does not know.
- Ranking is bm25 only. Paraphrase can miss; use two searches. Embedding re-rank is phase 2.
- Distillation is a local model reading 6K-token slices; a statement is stored only when its quote
  is found verbatim in the cited turn, which drops invention but also drops paraphrased quotes.

## Tests

    node --test tests/
```

- [ ] **Step 3: Verify the snippet parses and the skill front matter is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('hooks/settings.snippet.json','utf8'));console.log('ok')"` (from the repo root)
Expected: `ok`. Open `skill/SKILL.md` and confirm the front matter has `name` and `description`.

- [ ] **Step 4: Commit**

```bash
git -C C:/Users/<you>/total_recall add skill/SKILL.md hooks/settings.snippet.json README.md
```
```bash
CLAUDE_USER_APPROVED=1 git -C C:/Users/<you>/total_recall commit -m 'docs: skill, hook snippet and README

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

---

### Task 12: First tenant (the first project) and the first real run

**Files:**
- Create in the first project repo: `C:\Users\<you>\my-project\total_recall.json`
- Modify in the first project repo: `C:\Users\<you>\my-project\.claude\settings.json` (merge the hook block)
- Create on the machine: `C:\Users\<you>\.claude\skills\total_recall\SKILL.md` (copy)

Everything in this task touches the OWNER's project and machine. Each git action there needs its own approval under that project's rules (a per-action yes from the owner).

- [ ] **Step 1: Write the tenant config**

`C:\Users\<you>\my-project\total_recall.json`:
```json
{
  "project": "my-project",
  "transcripts": "C:/Users/<you>/.claude/projects/C--Users-<you>-my-project",
  "sources": {
    "handoff": "notes/SESSION-HANDOFF-*.md",
    "memory": "C:/Users/<you>/.claude/projects/C--Users-<you>-my-project/memory/*.md",
    "changelog": "CHANGELOG.md"
  },
  "ollama": { "url": "http://localhost:11434", "model": "qwen3:14b", "chunkTokens": 6000 },
  "brief": { "sessions": 3, "maxLines": 40, "standingLines": 15 },
  "search": { "rawRecentDays": 7, "rawRecentLimit": 5 }
}
```

- [ ] **Step 2: Full ingest, timed**

Run from `C:\Users\<you>\my-project`:
`node C:/Users/<you>/total_recall/bin/total_recall.js ingest --all`
Expected: one line with counts and seconds. Record them. Then run it again and confirm `0 turns` and a large `skipped`.

- [ ] **Step 3: Distill this week, timed**

`node C:/Users/<you>/total_recall/bin/total_recall.js distill --since 2026-09-15`
Expected: chunks sent, statements stored, dropped count with reasons, seconds, `model qwen3:14b`. If Ollama is not running the command exits 1 and says so; start Ollama and rerun. Record the numbers.

- [ ] **Step 4: Brief and the three searches**

```
node C:/Users/<you>/total_recall/bin/total_recall.js brief
node C:/Users/<you>/total_recall/bin/total_recall.js search "tax math"
node C:/Users/<you>/total_recall/bin/total_recall.js search "tax math" --deep
node C:/Users/<you>/total_recall/bin/total_recall.js search --outcome rejected --since 2026-09-01 "rejected"
```
Compare the brief by eye against `notes/SESSION-HANDOFF-2026-09-17-4.md`: the handoff's "deliberately not done" and "owner directive" items should appear as `open` / `standing` lines. Write down what is missing.

- [ ] **Step 5: Install the skill and hooks**

```
mkdir -p ~/.claude/skills/total_recall && cp C:/Users/<you>/total_recall/skill/SKILL.md ~/.claude/skills/total_recall/SKILL.md
```
Merge `hooks/settings.snippet.json` into `C:\Users\<you>\my-project\.claude\settings.json`: append the one SessionStart entry and the two PreToolUse entries to the existing arrays; do not remove any existing hook.

- [ ] **Step 6: Prove the gate in a fresh session**

Start a new Claude Code session in the first project. Expected: the brief prints at session start; the first `Edit` is blocked with the `BLOCKED by total_recall` message; after `total_recall search "<topic>"` the same edit passes. Record that this happened.

- [ ] **Step 7: Commit the tenant files (the first project repo, owner approval per action)**

```bash
git -C C:/Users/<you>/my-project add total_recall.json .claude/settings.json
```
```bash
CLAUDE_USER_APPROVED=1 git -C C:/Users/<you>/my-project commit -m 'chore: opt this project into total_recall

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```
Push only when the owner says so, under that project's own release rules.

---

## Self-review

**Spec coverage.** Sections 3 (repo), 4 (config), 5 (store), 6 (ingest), 7 (distill), 8 (change and supersession), 9 (search), 10 (session identity), 11 (gate), 12 (consent rule: skill rule 5), 13 (brief), 14 (skill), 15 (hooks), 16 (tests, and the first real run is Task 12) all map to tasks. Section 8's "statement supersession, show both with dates" is met by search printing dates and `STRUCK` when `superseded_by` is set; the 60%-token-overlap heuristic is not implemented in phase 1 and is noted in the spec as such (phase 2 lists automatic linking). Section 17 (phase 2) has no tasks by design.

**Placeholders.** None: every step has its code or its exact command.

**Type consistency.** `Store` method names used in Tasks 7-10 match Task 4: `insertDoc`, `search`, `getDoc`, `supersedePath`, `linkSupersession`, `neighbours`, `turnsForSession`, `recentSessionIds`, `statementsForSessions`, `handoffsBetween`, `standing`, `standingCount`, `getSource`, `setSource`, `hasRun`, `insertRun`, `sessionsWithRuns`, `recentUndistilledTurns`, `close`. `parseSelector` is defined in Task 7 and consumed in Task 9. `gate.ack`/`arm`/`isOpen` from Task 5 are used in Tasks 8 and 10. `command(args)` returns a number everywhere; `distill.command` is async and `bin` awaits it.

---

## Execution notes (2026-09-18, inline run)

Deviations from the plan as written, each decided during execution and reported to the owner:

- **Fixture size:** the generator writes 18 records (12 text + 2 tool-only + 2 tool_result + 1 sidechain + 1 compact summary); the plan said 30 by double-counting the 12 exchanges. Tests were written against the real 18.
- **Ingest counts in Task 7's test:** the Bash-only fixture turn names no file, so the spec rule drops it (14 kept, not 15), and `turnsForSession` returns `kind = 'turn'` only (13, the compact summary being its own kind). The code follows the spec; the test numbers were corrected.
- **`npm test` script:** `node --test tests/` is not a runner pattern on Node 24 ("Cannot find module ...\tests"); the script is `node --test "tests/*.test.js"`.
- **Display fixes after the first real run** (own commit): file-section hits and brief handoff lines carry a body snippet instead of a bare heading; tool-only turns name their files in the body (55,616 existing rows fixed up in place by a one-off UPDATE that left their `sha` untouched).
- **`PRAGMA busy_timeout = 5000`** added to the store so a session-start ingest waits on a running distill instead of failing SQLITE_BUSY.
- **Task 12 commit to the first project repo was NOT made**: `total_recall.json` and the `.claude/settings.json` hook merge are in that working tree, uncommitted, for the owner's per-action approval.

First real run, measured: `ingest --all` over 109 sessions = 86,685 turns, 899 file sections, 95 standing rules, 49,927 duplicates skipped, 108.3 s; store 107 MB; rerun `ingest` = 2 new turns in 0.1 s. Gate proven at CLI level: edit blocked (exit 2) before a search, passes after; Bash read passes, Bash write blocked. Distill of the 2026-09-15+ sessions (~36 chunks) ran on `qwen3:14b` at roughly 3 minutes a chunk; its counts are in the session handoff.

## Later the same day: tuning, providers, docs

- Prompt tuning against `tests/prompt-eval/gold.json` with `scripts/eval-prompt.js`: 11/15 with
  two forbidden labels -> 13/13 with none, in seven rounds. Prompt moved to `lib/distill-prompt.txt`.
  Validators: `who` from the cited turn's role; `approved` and `standing` only from owner turns;
  `open` never cites a question; old-prompt statements superseded on a prompt change.
- Failed chunks no longer end the run: recorded, raw reply saved, retried next time, exit 1 at the
  end. Tool-only turns are excluded from distill slices (they made the model answer
  `{"error": "Invalid command"}`). One active statement per (session, cited turn, outcome).
- `distill --provider claude`: raw HTTP to the Claude API, `claude-opus-5` default, refusal
  fallback on, credentials from the environment only. Stub-tested; not run against the live API.
- Final numbers for the 2026-09-15+ sessions on `qwen3:14b`: 24 chunks, 298 s, 215 active
  statements after dedupe (162 approved, 33 completed, 9 rejected, 5 standing, 3 open, 3 proposed).
  3 chunks fail permanently (pasted shell logs).
- README rewritten as the full manual; SKILL.md says which command needs a model and what works
  without one.
