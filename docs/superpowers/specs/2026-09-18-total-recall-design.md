# total_recall, design spec

Date: 2026-09-18. Owner: the project owner. Status: revised after owner review, awaiting sign-off.

## 1. The problem

Every Claude Code session starts blank. What the previous session decided, rejected, or left
half-done survives only if someone wrote it into a file, and even then the new session has to know
which file to open. On the first project 109 sessions of transcript (2026-07-13 to today, 3.35
GB of JSONL) sit on disk unread, while the existing "brain" (repo-index) indexes the repository,
not the conversations, has to be refreshed by hand several times a day, and is never consulted
unless the owner says so.

total_recall makes the conversation record searchable in milliseconds, distils it into one-line
statements that say who said what and whether it stood, and forces the new session to look before
it codes. The thing it must be best at is remembering corrections, rejections and standing
instructions, with the original sentence one hop away, so that both people can trust it.

## 2. What it is

A local command-line tool plus a Claude Code skill and a small hook block. No server, no daemon,
no dependencies beyond Node 22 (its built-in `node:sqlite` carries FTS5) and, for distillation
only, a local Ollama.

- **Store:** one SQLite file per project, FTS5 bm25 ranked, the same first stage the first project's
  own site search uses.
- **Two tiers:** distilled statements (read first, cheap) and the raw turns behind them (read when
  the why is missing). Every distilled statement carries who said it, what happened to it, and the
  exact turn it came from.
- **Standing rules never age out.** An owner directive from a month ago is in every brief until it
  is struck.
- **Forced use:** the session opens with a brief, and the first edit of a session is blocked until
  a recall search has run. Same blocking mechanism as the project's existing `maps-gate.js`. This
  is a recall checkpoint, not obedience: any search unlocks it, and section 11 says what it does
  not cover.
- **On-demand distillation:** the local LLM runs only when the owner asks. Section 12 is the one
  consent rule.
- **Project-agnostic:** installed once, opted into per project with a config file. the first project is
  tenant one. Public repo, MIT.

## 3. Repository

`C:\Users\<you>\total_recall`, git, MIT. Node >= 22, zero npm dependencies.

```
bin/total_recall.js          entry: parses <cmd> and flags, dispatches to lib/
lib/config.js                finds and validates total_recall.json for the current project
lib/session.js               resolves the session id (section 10)
lib/store.js                 opens the SQLite, creates schema, upsert, supersede, FTS sync
lib/scrub.js                 secret scrubber, pure function
lib/ingest.js                JSONL and file ingestion, per-source progress
lib/distill.js               Ollama chunking, prompt, validation, store
lib/search.js                bm25 query, raw-recent fallback, --deep, output shaping
lib/brief.js                 session-start brief: standing rules + recent work
lib/gate.js                  marker file: arm, check, ack
lib/session-start.js         arm -> ingest -> brief, in order, one process
skill/SKILL.md               the /total_recall skill text
hooks/settings.snippet.json  the hook block to paste into a project's .claude/settings.json
tests/                       node:test, fixtures/ holds a synthetic JSONL and md files
README.md
docs/superpowers/specs/      this file
```

## 4. Configuration

Per project, `total_recall.json` at the project root (committed by the project, not by this repo):

```json
{
  "project": "my-project",
  "transcripts": "C:/Users/<you>/.claude/projects/C--Users-<you>-my-project",
  "sources": {
    "handoff":   "notes/SESSION-HANDOFF-*.md",
    "memory":    "C:/Users/<you>/.claude/projects/C--Users-<you>-my-project/memory/*.md",
    "changelog": "CHANGELOG.md"
  },
  "ollama": { "url": "http://localhost:11434", "model": "qwen3:14b", "chunkTokens": 6000 },
  "brief": { "sessions": 3, "maxLines": 40, "standingLines": 15 },
  "search": { "rawRecentDays": 7, "rawRecentLimit": 5 },
  "store": "C:/Users/<you>/.total_recall/my-project.sqlite"
}
```

`store` defaults to `~/.total_recall/<project>.sqlite`. The tool finds the config by walking up
from the current working directory, the way git finds `.git`. No config, no action: every command
says so and exits 0, so a hook line in a project that has not opted in is harmless.

## 5. The store

One SQLite file, WAL mode, opened with `node:sqlite` `DatabaseSync`.

```sql
CREATE TABLE docs (
  id           INTEGER PRIMARY KEY,
  project      TEXT NOT NULL,
  kind         TEXT NOT NULL,   -- turn | statement | handoff | memory | changelog | compact_summary
  status       TEXT NOT NULL DEFAULT 'active',   -- active | superseded  (row lifecycle, section 8)
  session_id   TEXT,            -- Claude session uuid; null for file sources
  ts           TEXT NOT NULL,   -- ISO 8601
  role         TEXT,            -- turns: user | assistant
  path         TEXT,            -- source file (jsonl or md)
  title        TEXT NOT NULL,   -- turns: first 80 chars; statements: the statement; files: heading
  body         TEXT NOT NULL,
  files_json   TEXT NOT NULL DEFAULT '[]',   -- file paths touched in this turn
  tools_json   TEXT NOT NULL DEFAULT '[]',   -- tool names used in this turn
  -- statement provenance (kind = 'statement' only; null otherwise)
  who          TEXT,            -- owner | claude
  outcome      TEXT,            -- proposed | approved | rejected | completed | superseded | standing | open
  evidence_ids TEXT NOT NULL DEFAULT '[]',   -- the specific turn ids that support it (never a whole chunk)
  quote        TEXT,            -- verbatim sentence from the evidence turn, <= 240 chars
  reason       TEXT,            -- the stated why, or null when none was given
  superseded_by INTEGER REFERENCES docs(id),
  sha          TEXT NOT NULL UNIQUE          -- sha256(kind + session_id + ts + role + body)
);
CREATE INDEX docs_session ON docs(session_id, ts);
CREATE INDEX docs_kind_status_ts ON docs(kind, status, ts);
CREATE INDEX docs_outcome ON docs(outcome) WHERE kind = 'statement';
CREATE VIRTUAL TABLE docs_fts USING fts5(title, body, content='docs', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2');
-- external-content index kept in sync by the three standard triggers

CREATE TABLE sources (              -- per-source-file progress (section 8)
  path        TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,        -- transcript | handoff | memory | changelog
  size        INTEGER NOT NULL,
  mtime       TEXT NOT NULL,
  sha         TEXT NOT NULL,        -- md files: content hash; transcripts: hash of the first 4 KB
  offset      INTEGER NOT NULL DEFAULT 0,   -- transcripts: bytes consumed (append-only JSONL)
  ingested_at TEXT NOT NULL
);

CREATE TABLE distill_runs (         -- completion record, separate from what was found (section 7)
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL,
  turn_from   INTEGER NOT NULL,     -- first docs.id in the chunk
  turn_to     INTEGER NOT NULL,     -- last docs.id in the chunk
  model       TEXT NOT NULL,
  prompt_sha  TEXT NOT NULL,        -- so a changed prompt re-runs, an unchanged one does not
  ran_at      TEXT NOT NULL,
  lines       INTEGER NOT NULL,     -- 0 for NONE, and that is still a completed run
  UNIQUE(session_id, turn_from, turn_to, model, prompt_sha)
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);   -- schema_version
```

Ranking: `bm25(docs_fts, 3.0, 1.0)`, title weighted 3, body 1. Only `status = 'active'` rows are
searched by default. `sha` makes every ingest idempotent. No embeddings in phase 1 (section 15).

`kind` is the seam for phase 2: a map section is just another row with `kind = 'map_section'`.

## 6. Ingest

`total_recall ingest [selector]`

Selectors, exactly one: `--all` | `--since <date>` | `--from <date> --to <date>` |
`--session <id>` | none, which means "whatever each source file has that it did not have last
time" (section 8).

What a transcript record becomes:

- Records with `type` `user` or `assistant` only. `isSidechain: true` (subagent traffic) is
  skipped. `user` records whose content is a `tool_result` array are skipped: tool output is the
  tier the owner excluded.
- One row per record. `body` is the text blocks joined; for an assistant record the `tool_use`
  blocks contribute their tool `name` to `tools_json` and any `file_path`, `path`, or the first
  path-shaped token of a Bash `command` to `files_json`. Their inputs are not stored.
- Records with `isCompactSummary: true` are stored as `kind = 'compact_summary'`.
- `role`, `ts`, `session_id` come from the record. `title` is the first 80 characters of `body`.
- Empty bodies (a tool-only assistant turn) still produce a row when `files_json` is non-empty,
  with `title` = the joined file paths, so "what did we touch" queries can find them.

File sources (`handoff`, `memory`, `changelog`) are split at `## ` headings; each section is a row
with `title` = heading, `ts` = the date parsed from the file name or the entry stamp, falling back
to file mtime. Memory files keep their frontmatter `description` as the title, and a memory whose
frontmatter `type` is `feedback` is ALSO written as a `statement` row with `who = 'owner'`,
`outcome = 'standing'`, `quote` = its first body line, `evidence_ids = []`, `path` = the file. That
is how the existing owner directives enter the standing-rules tier on day one without an LLM.

Every `body` passes through `scrub()` before it is hashed or stored. The scrubber replaces, never
drops the row: `sk-...`, `ghp_...`, `xox[abp]-...`, `Bearer <token>`, `AKIA...`, hex or base64
runs of 32+ characters that follow `token|key|secret|password` within 40 characters, and any
`KEY=value` line whose key ends in `_KEY`, `_SECRET`, `_TOKEN` or `PASSWORD`. Replacement is
`[scrubbed]`. Tested against a planted token in the fixture.

Output: `ingested N turns, M file sections (S superseded), K skipped (already present), T seconds`.

## 7. Distill

`total_recall distill [selector] [--model <tag>]`, same selectors as ingest, plus `--today`.

**Chunking.** Groups `turn` rows by session, orders by `ts`, chunks to about `chunkTokens` (6,000;
a token is estimated at 4 characters). 6K keeps `qwen3:14b` Q4_K_M (9.3 GB of weights) fully on a
16 GB GPU with its KV cache; the model's native 40K window would spill to CPU. Each turn in the
chunk is rendered as `[T<docs.id>] <role>: <body>` so the model can cite ids.

**Prompt** (fixed, its sha stored on the run record). Sent to `/api/generate` with
`stream: false`, `think: false`, `format: "json"`:

> You are reading a slice of a work session between a software OWNER and CLAUDE. Each turn is
> labelled `[T<id>] owner:` or `[T<id>] claude:`. Extract every statement worth remembering later:
> a proposal, an approval, a rejection, a correction, an owner instruction, a completed piece of
> work, or an item left open. For each, output a JSON object on its own line with exactly these
> keys: `who` ("owner" or "claude": who made the statement), `outcome` (one of proposed, approved,
> rejected, completed, superseded, standing, open), `statement` (under 30 words, plain), `quote`
> (a verbatim sentence copied from one turn, under 240 characters), `turn` (the T id that quote
> came from), `reason` (the reason as stated, or null if none was given: never invent one). Use
> `standing` only for an owner rule meant to apply from now on ("never", "always", "from now on",
> "do not ... again"). If nothing in the slice is worth remembering, output the single line
> `{"none": true}`.

**Validation, per line, before anything is stored.** A line is dropped, and counted as dropped,
when: the JSON does not parse; `who` or `outcome` is outside the enum; `turn` is not a turn id in
this chunk; or `quote` is not a substring (after whitespace collapse) of that turn's body. The
quote-must-exist rule is what stops invented statements: the model can only cite what is there.
`evidence_ids` = `[turn]`, plus the immediately previous turn when the cited turn is Claude's and
the previous is the owner's (a "yes" is evidence only with the question it answered).

**Storage.** Each surviving line is a `statement` row: `title` = statement, `body` = statement +
quote + reason + session id + date, `ts` = the cited turn's ts. Its `sha` is over
`(who, outcome, statement, quote)` so the same finding from a re-run does not duplicate.

**Completion is recorded separately from findings.** Every chunk that comes back parseable,
including `{"none": true}`, writes a `distill_runs` row. A later run skips any chunk with a
matching `(session_id, turn_from, turn_to, model, prompt_sha)` row. A changed prompt or model
therefore re-runs; an unchanged one never repeats a chunk, NONE or not.

**Failure is loud.** Ollama unreachable, a non-200, an empty body, or a chunk with zero parseable
lines ends the run non-zero with the reason, writes no `distill_runs` row for that chunk, and
stores nothing from it. (A swallowed catch that fails forever looks exactly like an empty table.)

Output: chunks sent, chunks skipped as done, lines stored, lines dropped by validation (with the
first three reasons), seconds, model.

Handoff sections are not sent to Ollama; they are already distilled.

## 8. Change and supersession

**Per-source progress**, `sources` table, replaces any single global timestamp:

- Transcripts are append-only JSONL. Each file's `offset` is the byte count consumed; the next
  ingest resumes there. A file whose `size` is below its stored `offset`, or whose first-4KB `sha`
  changed, is treated as new: its old rows are superseded and it is read from zero. A transcript
  copied in later, whatever its dates, is simply a file not yet in `sources`.
- Markdown sources (`handoff`, `memory`, `changelog`) are versioned wholes. When a file's content
  sha changes, every active row with that `path` is set `status = 'superseded'` with
  `superseded_by` pointing at the new row that has the same heading (or null when the heading is
  gone), and the new sections are inserted. Superseded rows stay in the store for `--deep` and
  history, but leave the default search and the brief. A corrected memory file therefore replaces
  the old instruction rather than sitting beside it.
- A deleted markdown source supersedes its rows with `superseded_by = null` on the next ingest.

**Statement supersession.** A `statement` with `outcome = 'superseded'` cites, in `reason`, what it
replaces when the model said so; the brief and search show the newer statement and mark the older
one `struck` when both are active and share 60% of their title tokens. Full automatic linking is
phase 2; phase 1 shows both with dates so a reader can see the order.

## 9. Search

`total_recall search "<query>" [--kind k[,k]] [--who owner|claude] [--outcome o[,o]] [--files <glob>] [--session <id>] [--since <date>] [--deep] [--limit n] [--include-superseded]`

- Default kinds: `statement,handoff,memory,compact_summary` (the distilled tier). `--kind turn`
  or `--kind all` opens the raw tier.
- Query goes to FTS5 with each token quoted and OR-joined; a double-quoted phrase is passed as an
  FTS phrase. bm25 orders the rest.
- **Raw-recent fallback, always on.** After the distilled hits, the search also runs the same
  query over `turn` rows from the last `search.rawRecentDays` (7) days whose session has NO
  `distill_runs` row and NO `handoff` row, and prints up to `search.rawRecentLimit` (5) of them
  under the heading `RAW, not yet distilled`. A fresh conversation is therefore visible the moment
  it is ingested, labelled as conversation rather than dressed up as a settled decision.
- `--deep` follows each hit's `evidence_ids` (or, for a handoff row, its session date) to the raw
  turns and prints them plus one neighbour on each side.
- Output, one hit per block:
  `#<id> <kind> <date> <session-short> [<who> <outcome>]` then the title, then `quote: "..."` for
  statements, then for `--deep` the raw text indented. A statement whose `superseded_by` is set, or
  that section 8 marks struck, prints `STRUCK` in the header. Default limit 12 distilled, 6 deep.
- Every search writes the gate marker for the current session (section 10). That is its only side
  effect.

## 10. Session identity

The hook receives `session_id` on stdin. An ordinary `total_recall search` run from Claude's Bash
tool does not, but that shell carries `CLAUDE_CODE_SESSION_ID` in its environment, and it is the
same value (verified 2026-09-18: env `3f9a1c2e-15a6-4443-a5b2-99e9c21802ae`, transcript file
`3f9a1c2e-15a6-4443-a5b2-99e9c21802ae.jsonl`). `lib/session.js` resolves the id in this order:

1. `session_id` from hook stdin JSON, when the process was started by a hook;
2. `CLAUDE_CODE_SESSION_ID` from the environment;
3. `--session <id>` on the command line;
4. none: the command says `no session id; gate not touched` and continues. It never invents a daily
   fallback, because a fallback marker is exactly the thing that lets the gate and the search
   disagree.

Both the hook and the search therefore key the marker on the same uuid, and two concurrent
sessions on one project cannot unlock each other.

## 11. Gate

Marker file `~/.total_recall/gate/<project>/<session-id>`.

- `gate --arm` (part of session-start): deletes the marker for this session.
- `gate --check` (PreToolUse on `Edit|Write|MultiEdit|NotebookEdit`): exits 2 with
  `BLOCKED by total_recall: run  total_recall search "<the files or topic you are about to
  touch>"  first.` when no marker exists for the session. Exit 2 is what Claude Code reads as
  "block this call".
- `gate --check-bash` (PreToolUse on `Bash`): blocks, with the same message, when the command
  matches `git commit`, `sed -i`, `tee `, ` > ` or ` >> ` into a path under the project, `cp ` or
  `mv ` into the project, `python -c` or `node -e` containing `writeFile`, `Set-Content`,
  `Out-File`, `Add-Content`. This is a heuristic and is documented as one.
- `search` writes the marker. `gate --ack` writes it by hand for a session with nothing to recall
  (a new project) and prints that it was used.

**What this is and is not.** It is a checkpoint: the session cannot edit until a recall ran. It is
not obedience: any search unlocks it, including a lazy one, and a write shaped in a way the Bash
heuristic does not recognise gets through. The skill (section 13) carries the behaviour; the gate
only guarantees the first look happened.

## 12. Consent rule for distillation, one rule

`distill` runs only when the owner asks, in any words. "We are done for the day" and "run the
extract" both count as asking. Before a compaction Claude asks, in one line, whether to distill
first; silence or no means no. Claude never runs it on its own initiative, because it spends GPU
time the owner may need.

(This replaces the earlier draft's "distill before a compaction" instruction, which contradicted
"never unasked".)

## 13. Brief

`total_recall brief`, printed by session-start into Claude's context.

Two parts, two caps:

1. **Standing rules**, up to `brief.standingLines` (15): every active `statement` with
   `outcome = 'standing'` and every `memory` row of type `feedback`, newest first, each as
   `<date> RULE <who>: <statement>`. Age is irrelevant; they leave only by supersession. If more
   than 15 exist, the brief prints the 15 most recent and the line `+N more: total_recall search
   --outcome standing`.
2. **Recent work**, up to `brief.maxLines` (40) minus what part 1 used: `statement` and `handoff`
   rows from the last `brief.sessions` (3) sessions, scored +3 if `files_json` or text names a file
   in the project's last 5 commits (`git log -5 --name-only`), +2 for `outcome = 'open'`, +1 for
   `rejected` (a rejection is worth re-reading before repeating it), +1 per day of recency. Each
   line: `<date> <who> <outcome>: <statement>`.

Footer: `Run: total_recall search "<topic>" before the first edit. --deep for the raw turns.`

Empty store or no config: one line saying so, exit 0.

## 14. The skill

`skill/SKILL.md`, installed as `~/.claude/skills/total_recall/SKILL.md`:

1. Before the first edit of a session, run `total_recall search` on the files you are about to
   touch or the topic the owner named. Read the distilled hits first. A hit marked `rejected` or
   `STRUCK` is a warning, not a suggestion.
2. If a hit lacks its why, or two hits disagree, rerun with `--deep`. Do not guess at a decision
   the record can answer; read the quote.
3. `/total_recall <topic> --show`: run the search, print the hits verbatim to the owner, and STOP.
   No coding until the owner says go. If the owner answers `--deep`, rerun deep and show again.
   Without `--show`, read silently and proceed.
4. When the owner says the day is done: write the session handoff as the project requires, then
   run `total_recall ingest` and `total_recall distill --today`, and report the counts.
5. Before a compaction, ask in one line whether to distill first. Otherwise never run `distill`
   unasked (section 12).

## 15. Hooks

`hooks/settings.snippet.json`, pasted into a project's `.claude/settings.json`. Claude Code runs
the hooks of one event in parallel, so session start is ONE command that runs arm, ingest and brief
in order inside a single process:

```json
{
  "SessionStart": [{ "hooks": [
    { "type": "command", "command": "node C:/Users/<you>/total_recall/bin/total_recall.js session-start" } ] }],
  "PreToolUse": [
    { "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [
      { "type": "command", "command": "node C:/Users/<you>/total_recall/bin/total_recall.js gate --check" } ] },
    { "matcher": "Bash", "hooks": [
      { "type": "command", "command": "node C:/Users/<you>/total_recall/bin/total_recall.js gate --check-bash" } ] } ]
}
```

`session-start` = `gate --arm`, then `ingest` (new bytes only, seconds), then `brief`, and prints
the brief last so it is what Claude reads. Ingest runs at session start, not exit: on Windows the
shell is torn down before a Stop hook finishes. Hook paths are absolute because Claude Code runs
hooks from the project directory.

## 16. Testing

`node --test tests/`, no frameworks. Fixtures: `session.jsonl` (a synthetic 30-turn session with
two tool-only turns, one sidechain turn, one compact summary, one planted `sk-` token, one
`file_path` edit, and an owner "never do X again" line), `memory-feedback.md`, `handoff.md`, and a
second copy of `handoff.md` with one section edited.

- ingest: 30 records produce the expected rows; a second run adds 0; the sidechain and tool_result
  turns are absent; the token is `[scrubbed]`; the edit turn's `files_json` holds its path; the
  feedback memory yields a `standing` statement with `who = 'owner'`.
- progress: appending 3 records to the fixture ingests exactly 3; truncating the file re-reads it
  from zero and supersedes the old rows.
- supersession: ingesting the edited `handoff.md` supersedes the old section, points
  `superseded_by` at the new one, and the old one leaves default search but answers
  `--include-superseded`.
- search: a title hit outranks a body hit for the same word; `--files` narrows; `--who` and
  `--outcome` filter; `--deep` returns the evidence turn plus neighbours; a session with no
  `distill_runs` and no handoff surfaces under `RAW, not yet distilled`; an empty store returns
  zero rows and exit 0.
- session: with `CLAUDE_CODE_SESSION_ID` set, search and `gate --check` (fed the same id on stdin)
  agree; with neither, search says the gate was not touched and `--check` still blocks.
- gate: `--check` exits 2 before any search and 0 after one; `--check-bash` blocks `git commit`
  and `sed -i`, passes `git status` and `ls`.
- distill: against a stub Ollama, three valid JSON lines store three statements with the cited
  turn as evidence and the stated reason (null preserved); a line whose quote is not in the cited
  turn is dropped and counted; `{"none": true}` stores nothing and still writes a `distill_runs`
  row; a second run over the same chunk sends nothing; a changed prompt sha re-sends; an empty
  reply exits non-zero, writes no run row and stores nothing.
- brief: a `standing` statement from 40 days ago is present; an `open` line outranks a same-day
  decision; the two caps hold.

First real run, in order, each reported with counts and seconds: `ingest --all` over the 109
the first project sessions; `distill --since 2026-09-15`; `brief`, compared by eye against
`SESSION-HANDOFF-2026-09-17-4.md`; `search "tax math"` and `search "tax math" --deep`;
`search --outcome rejected --since 2026-09-01` to see whether rejections read as trustworthy.

## 17. Not in phase 1

- Embedding re-rank with `nomic-embed-text` (the site's hybrid second stage). Add when bm25
  measurably misses paraphrase; the `docs` row already has the id an embedding table would key on.
- Map sections as a kind, so a routed map read replaces one long index read.
- Automatic supersession links between statements (section 8 shows both with dates for now).
- An MCP wrapper. The CLI is the product.
- Any per-prompt automatic recall. Rejected: fights the batching rule, costs tokens on "yes".
- Tool results in the store. Rejected: 98% of the bytes, secrets risk, little recall value.

## 18. Decisions made in the brainstorm and review, for the record

- Two tiers, distilled first, raw on demand: raw alone is noise, distilled alone loses the why.
- Every distilled statement carries who, outcome, a verbatim quote and the exact turn ids; a quote
  that is not in the cited turn is dropped. Reasons are optional and never invented.
- Standing rules are a separate part of the brief with their own cap and no age limit.
- Distilled comes from handoffs and memory (free) plus an on-demand local-LLM pass: a nightly job
  needs the desktop on, a Stop-hook ritual costs tokens every session.
- One consent rule: the LLM runs only when the owner asks; before a compaction Claude asks.
- Enforcement is a blocking gate on the first edit, documented as a checkpoint, not obedience.
- Session identity is `CLAUDE_CODE_SESSION_ID` / hook `session_id`, never a daily fallback.
- Session start is one sequential command because same-event hooks run in parallel.
- Per-source progress and markdown supersession, not one global timestamp.
- Completion of a distill chunk is recorded apart from its findings, so NONE is still done.
- CLI plus skill, not MCP; `distill`, not `extract`; global install, per-project store; public repo.
- Model default `qwen3:14b`: the Qwen 3.5 9B the owner named is not installed; 14b at Q4_K_M fits
  the 5070 Ti at an 8K context.
