# total_recall

Searchable, distilled memory for Claude Code sessions.

Every Claude Code session starts blank. What the last session decided, rejected or left half-done
survives only if someone wrote it down, and even then the new session has to know which file to
open. total_recall reads the transcripts Claude Code already writes to disk, indexes every turn in
a per-project SQLite full-text store, distils the conversation into one-line statements that carry
**who said it, what happened to it, and the exact quote it came from**, and then forces the next
session to look before it codes: a brief at session start, and an edit gate that stays shut until a
recall search has run.

Zero dependencies. Node 22.13 or newer. One SQLite file per project. MIT.

Built on 2026-09-18 for a project with 109 sessions of transcript (3.35 GB); the first ingest took
108 seconds and produced 86,685 searchable turns, 899 note sections and 95 standing rules.

---

## Contents

- [How it works](#how-it-works)
- [What a session sees](#what-a-session-sees)
- [Install](#install)
- [Opt a project in](#opt-a-project-in)
- [The hooks](#the-hooks)
- [The skill](#the-skill)
- [Commands and switches](#commands-and-switches)
- [Configuration reference](#configuration-reference)
- [The distill step: with and without an AI model](#the-distill-step-with-and-without-an-ai-model)
- [What gets stored, and what never does](#what-gets-stored-and-what-never-does)
- [Tuning the distill prompt](#tuning-the-distill-prompt)
- [Honest limits](#honest-limits)
- [Development](#development)

---

## How it works

Three tiers of memory live in one store, `~/.total_recall/<project>.sqlite`:

| Tier | What it is | Where it comes from | Costs a model? |
|---|---|---|---|
| **Raw turns** | your text and Claude's text, one row per turn, plus the tool names and file paths that turn touched | Claude Code's own transcript files (`~/.claude/projects/<project>/*.jsonl`) | no |
| **Notes** | session handoffs, memory files, a changelog, split by heading | files you name in `total_recall.json` | no |
| **Statements** | one line each: `who` (owner or claude), `outcome` (approved, rejected, standing, completed, open, proposed, superseded), a verbatim `quote`, the ids of the turns that prove it, and the stated reason if one was given | `total_recall distill`, a local Ollama model or the Claude API reading the raw turns in 6K-token slices | **yes** |

Searches read the statements and notes first (cheap, already condensed) and the raw turns on
demand (`--deep`, or `--kind turn`). Ranking is SQLite FTS5 bm25 with the title weighted three
times the body. A statement is stored only when its quote is found word for word in the turn it
cites, which is what keeps the model from inventing decisions.

**Standing rules never age out.** A rule the owner set a month ago ("never ship the text-only
icon") is in every brief until it is struck, however much newer work fills the store.

**Everything is idempotent.** Every row is keyed by a content hash; transcripts are read from a
per-file byte offset, so a session-start ingest costs a fraction of a second; an edited note file
supersedes its old sections instead of sitting beside them; a retuned distill prompt retires the
statements the old prompt produced and re-derives them.

## What a session sees

At session start, the hook prints a brief into Claude's context:

```
== total_recall brief ==
2026-09-18 RULE owner: never revert the site logo to the old text-only mark; the full logo stays at every size
2026-09-17 RULE owner: never call a page fast from a local run; measure it on the live server first
...
+80 more: total_recall search --outcome standing
2026-09-17 owner rejected: clearing the cache does not solve the problem
2026-09-17 handoff note: Open , two pages still show the old preview image...
Run: total_recall search "<topic>" before the first edit. --deep for the raw turns.
```

Then, the first time Claude tries to edit or write a file (or run a write-shaped shell command),
the gate blocks it:

```
BLOCKED by total_recall: run  total_recall search "<the files or topic you are about to touch>"  first. (session 3f9a1c2e-...)
```

One search opens the gate for that session. The search itself looks like this:

```
$ total_recall search "tax math" --deep
#87124 statement 2026-05-06 file [owner standing]
  The old quote builder was retired in April 2026; the checkout page was rewritten to totals only.
  quote: "never link to it, reference it, or rebuild it"
#87364 memory 2026-07-05 file
  tax-math-core.js is the ONE tax implementation; both calculator pages delegate to it.
  Never re-implement tax math inline...

RAW, not yet distilled:
#1197 turn 2026-09-18 3f9a1c2e
  user: the rounding is wrong again on the summary page...

deep for #87124 statement 2026-05-06 file [owner standing]:
  [T87120] owner: ...the exact turn the quote came from, with one neighbour each side...
```

## Install

Per machine, once:

```bash
git clone https://github.com/<you>/total_recall C:/Users/<you>/total_recall
mkdir -p ~/.claude/skills/total_recall
cp C:/Users/<you>/total_recall/skill/SKILL.md ~/.claude/skills/total_recall/SKILL.md
```

Requirements:

- **Node 22.13 or newer** (`node:sqlite` is built in and unflagged from 22.13; the tool prints one
  experimental-feature warning on Node 22 to 24 and silences it in hooks).
- For `distill` only: either a running [Ollama](https://ollama.com) with a pulled model
  (`ollama pull qwen3:14b`), or an Anthropic API key in the environment. See
  [the distill step](#the-distill-step-with-and-without-an-ai-model).

Nothing is installed globally. Every command is `node <path-to-repo>/bin/total_recall.js ...`; the
examples below write `total_recall` for short. Add an alias or a shim if you like.

## Opt a project in

1. Put a `total_recall.json` at the project root (the tool finds it by walking up from the
   current directory, the way git finds `.git`):

```json
{
  "project": "my-project",
  "transcripts": "C:/Users/<you>/.claude/projects/C--Users-<you>-my-project",
  "sources": {
    "handoff": "notes/SESSION-HANDOFF-*.md",
    "memory": "C:/Users/<you>/.claude/projects/C--Users-<you>-my-project/memory/*.md",
    "changelog": "CHANGELOG.md"
  }
}
```

   `transcripts` is the folder Claude Code writes this project's `*.jsonl` files to; the folder name
   is the project path with the separators replaced by `-`. `sources` are optional.

2. Merge [`hooks/settings.snippet.json`](hooks/settings.snippet.json) into the project's
   `.claude/settings.json`, fixing the path to this repo (see [The hooks](#the-hooks)).

3. Load the history and, if you have a model, distil the recent part:

```bash
total_recall ingest --all
total_recall distill --since 2026-09-01
```

4. Start a new Claude Code session in the project. The brief prints; the first edit is blocked until
   a search has run.

A project with no `total_recall.json` is untouched: every command says
`no total_recall.json found above <cwd>; nothing to do` and exits 0, so the hook lines are harmless
in a project that has not opted in.

## The hooks

Three hook entries, all in the project's `.claude/settings.json`:

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

| Hook | What it does |
|---|---|
| `SessionStart` -> `session-start` | One process that, in order: clears this session's gate marker, ingests whatever is new (seconds), prints the brief. It is one command because Claude Code runs the hooks of one event in parallel, so `ingest` and `brief` as separate lines could race. |
| `PreToolUse Edit\|Write\|...` -> `gate --check` | Exits 2 (Claude Code's "block this call") with the message above until a `search` has run in this session. |
| `PreToolUse Bash` -> `gate --check-bash` | Same block, only for write-shaped commands: `git commit`, `sed -i`, `tee`, `>` / `>>` into the project, `cp` / `mv` into the project, `node -e` / `python -c` that write files, `Set-Content` / `Out-File` / `Add-Content`. Reads (`git status`, `ls`, `grep`, tests) pass. |

**Session identity.** The hook receives `session_id` on stdin; a `search` run from Claude's shell
reads `CLAUDE_CODE_SESSION_ID` from its environment; they are the same uuid, so the search and the
gate always agree and two concurrent sessions on one project cannot unlock each other. There is no
daily fallback marker. If neither source is present, `search` says `no session id; gate not
touched` and the gate stays shut; `gate --ack --session <id>` opens it by hand.

**Paths are absolute** because Claude Code runs hooks from the project directory, not from this
repo. Ingest runs at session start rather than session end because on Windows the shell is torn
down before a Stop hook finishes.

**Turning it off:** remove the three entries. Opening the gate for one session without a search:
`total_recall gate --ack`.

## The skill

**For the owner, no switches.** Typing `/total_recall` followed by a plain sentence is enough:
`who said X`, `what did we decide about X`, `what did I reject about X`, `what are my rules`,
`what is still open`, `what did we do to src/x.js`, `more` (for the surrounding conversation),
`catch me up`, `we are done for the day`. Claude maps the sentence to the switches below and shows
the hits verbatim before saying anything. The switches exist for Claude, not for you.


[`skill/SKILL.md`](skill/SKILL.md), copied to `~/.claude/skills/total_recall/SKILL.md`, tells
Claude how to use the tool: search before the first edit, treat `rejected` and `STRUCK` hits as
warnings, go `--deep` when a hit has no reason, show hits to the owner and stop on
`/total_recall <topic> --show`, distil only when the owner asks, and what to do when no model is
available. The gate guarantees the first look happened; the skill carries the behaviour.

## Commands and switches

Every command finds the project's `total_recall.json` from the current directory, opens the store
it names, and exits 0 unless something is wrong. Dates are `YYYY-MM-DD`.

### `search "<query>"`

Full-text search, distilled tier first, then a short `RAW, not yet distilled` section of recent
turns from sessions nobody has distilled or written a handoff for. Each word of the query is
matched on its own and results are ranked by how many match (bm25); a phrase in double quotes is
matched as a phrase. Writes this session's gate marker.

| Switch | Meaning |
|---|---|
| `--kind k[,k]` | Which kinds to search. Default `statement,handoff,memory,compact_summary,map_section` (the distilled tier). `--kind turn` searches raw turns; `--kind all` searches everything. When `turn` is included the RAW section is not printed separately. |
| `--who owner\|claude` | Statements made by the owner or by Claude. |
| `--outcome o[,o]` | Statements by outcome: `approved`, `rejected`, `standing`, `completed`, `open`, `proposed`, `superseded`. |
| `--files GLOB` | Only rows whose turn touched a matching path, e.g. `--files "src/tax-math*"`. |
| `--session ID` | Only rows from that Claude session. Does not change which session the gate is opened for. |
| `--since D` | Only rows dated on or after `D`. `D` is `YYYY-MM-DD`, `YYYY-MM` or `YYYY`; anything else is refused rather than compared as text. `--from` is the same switch. |
| `--until D` | Only rows dated on or before `D`. A bare month or year covers the whole of it, so `--until 2026-08` includes 31 August. `--to` is the same switch. |
| `--on D` | Shorthand for `--since D --until D`: one day, one month or one year. |
| `--oldest`, `--newest` | Order hits by date instead of by relevance, for "when did we first talk about X" and "what is the latest on X". Every word of the query must then match (relevance is no longer there to push one-word hits down). Use with `--kind all` to reach raw turns. |
| `--tools` | Include tool-only turns (a turn whose whole body is `(tool-only turn: Edit) path`). They are left out of every search by default because they bury the conversation; `--files` brings them back on its own. |
| `--words` | Words lane only; skip the meaning lane even when the store has vectors. |
| `--deep` | For each hit, also print the turns it cites (statements cite their evidence turns; a raw hit cites itself) with one neighbour on each side. |
| `--limit N` | Number of distilled hits (default 12). Deep blocks are capped at 6. |
| `--include-superseded` | Also return rows that a newer version of the same note replaced. They print `STRUCK`. |

Output, one block per hit: `#<id> <kind> <date> <session-or-file> [<who> <outcome>]`, the title,
`quote: "..."` and `reason: ...` for statements, a body snippet for notes.

### `brief`

Prints what the session-start hook prints. Two parts with two caps: every active standing rule,
newest first (cap `brief.standingLines`, default 15, with a `+N more` pointer), then the last
`brief.sessions` (3) sessions' statements and handoff sections, scored: +3 when the line names a
file changed in the project's last five commits, +2 for `open`, +1 for `rejected`, +1 per day of
recency; `open` first on ties. Total cap `brief.maxLines` (40). Empty store: one line saying so.

### `ingest [selector]`

Reads transcripts and note files into the store. Idempotent; run it as often as you like.

| Switch | Meaning |
|---|---|
| *(none)* | Only what each source file has that it did not have last time: transcripts resume from their stored byte offset, note files are re-read only when their content hash changed. This is what the session-start hook runs. |
| `--all` | Read every file from the start. Adds nothing that is already stored (content hashes), but re-establishes offsets. |
| `--since D` | Only records dated on or after `D`. Offsets are not advanced. |
| `--from D --to D` | Only records dated inside the range, inclusive of both days. |
| `--session ID` | Only that session's transcript file. |

What a transcript record becomes: `user` and `assistant` records only; subagent (`isSidechain`)
records and tool results are skipped; a tool-only turn is kept when it touched a file, with the
tool name and path recorded; compaction summaries become their own kind. Every stored body passes
the secret scrubber first. A transcript file that shrank or whose head changed is treated as new:
its old rows are superseded and it is re-read from zero.

Note files are split at `## ` headings (the changelog at `**YYYY-MM-DD` entries). A memory file whose
frontmatter says `type: feedback` also becomes a `standing` statement with `who: owner`, which is
how existing owner directives reach the brief on day one with no model.

Output: `ingested N turns, M file sections (S superseded, R standing rules), K skipped (already
present), T seconds`.

### `distill [selector] [--provider ollama|claude] [--model TAG]`

Sends raw turns to a model in ~6K-token slices and stores the statements that pass validation.
Selectors are the same as `ingest`, plus `--today`; with no selector, every session is considered
(chunks already done are skipped). See [the distill step](#the-distill-step-with-and-without-an-ai-model).

| Switch | Meaning |
|---|---|
| `--provider ollama\|claude` | Which model to use for this run. Default from `distill.provider` in the config, else `ollama`. |
| `--model TAG` | Model tag for that provider (`qwen3:14b`, `claude-opus-5`, ...). Default from `distill.model`, else the provider's default. |
| `--redo` | Send chunks again although they already ran. The way to win back statements an older, stricter validator dropped; statements already stored are recognised by their sha, so nothing doubles. |

When the chunks are done, `distill` runs `embed` and then `link` (both below) so new statements
are searchable by meaning and the supersession links are current. Neither can fail a distill.

Per chunk: a run record is written when the model answered parseably, including a `{"none":true}`
answer, so it is never sent again for the same model and prompt. A chunk whose reply could not be
parsed, or that the provider refused or failed, is reported as FAILED, its raw reply is saved under
`~/.total_recall/failed/`, nothing is stored, no run record is written (so it retries next time),
and the run continues with the next chunk. Exit code 1 at the end if any chunk failed.

Validation, per statement: the outcome must be one of the seven labels; the cited turn must be in
the slice; the quote must be in that turn, either word for word or, for a quote of four words or
more, with every word present in order and at most three stray words between neighbours (the model
tidies quotes; what is stored is then the TURN's wording for that span, so the record stays
verbatim); `who` is derived from the turn's role
(never trusted from the model); only an owner turn can be `approved` or `standing`; an `open` item
cannot cite a question. Dropped statements are counted with their first three reasons.

Output: `distilled N sessions: A chunks sent, B already done, C statements stored, D dropped by
validation (...), T seconds, <provider> <model>`.

### `embed [--kind all|k,k]`

Gives rows a vector so `search` can find them by meaning as well as by words. Needs Ollama with
`nomic-embed-text` pulled (274 MB); nothing else does. Only rows without a vector are sent, so a
rerun is cheap. Default kinds are the distilled tier (statements, handoffs, memory, compaction
summaries, map sections, changelog): 1,926 rows took 35 seconds on the first real store.
`--kind all` adds the spoken turns (tool-only turns are never embedded), about 55 rows a second.

With vectors in the store, `search` runs two lanes and fuses them: the words lane (bm25) and the
meaning lane (every eligible vector scored against the query's vector; hits under `search.minSim`
are ignored). A hit that shares none of the query's words prints `~meaning 0.72` in its header.
Date-ordered searches stay words-only. If Ollama does not answer, the search says
`(meaning lane off ...)` and returns the word hits; `--words` skips the meaning lane on purpose.

### `link [--dry] [--all] [--provider ollama|claude]`

Redraws the supersession links between distilled statements: when a later decision replaces an
earlier one, the earlier one stays visible but prints `STRUCK by #<id>`.

Likeness only nominates a pair; the distill model decides, shown the words actually said, once per
pair per judge prompt (`lib/link-prompt.txt`), and the verdict is kept in `link_verdicts` and never
bought again. Nominated shapes: a statement the model labelled `superseded` with a later one in
the same session; an owner rejection over something approved, proposed or completed; an owner
approval, from a later session, over something rejected; a standing rule over a standing rule.
`--dry` asks nothing and writes nothing; `--all` prints every nominated pair with its verdict.

Why a judge: on the first real store, likeness plus an approved/rejected flip drew 14 links and 13
were wrong. With the judge and the same-session guard the same store draws none, which is correct.

### `strike <id> --reason "..."` and `strike <id> --undo`

The owner's correction of a statement the model got wrong (a 14B model will now and then read
"what?" as a refusal). The statement leaves every search and the brief, stays in the store with
the date and the reason, prints `STRUCK as wrong by the owner` under `--include-superseded`, and is
never revived by anything automatic: the same statement derived again has the same sha, so it is
ignored. `--undo` puts it back in force. Only statements can be struck; turns, notes and maps are
the record itself, not a model's reading of it.

### `mcp [--root DIR]`

Serves `search` and `brief` to Claude as Model Context Protocol tools (`recall_search`,
`recall_brief`) over stdio, so Claude calls them as tools instead of shell commands. Read-only:
`ingest`, `distill`, `embed` and `link` stay on the command line because they cost time or money.
Register it in the project's `.mcp.json`:

```json
{ "mcpServers": { "total_recall": { "command": "node",
    "args": ["C:/path/to/total_recall/bin/total_recall.js", "mcp", "--root", "C:/path/to/project"] } } }
```

A search through the server opens the edit gate when Claude Code's session id reaches the server
(`CLAUDE_CODE_SESSION_ID`); when it does not, the result says so and one command-line search opens it.

### `gate --arm | --check | --check-bash | --ack [--session ID]`

The edit gate. `--arm` clears this session's marker (run by `session-start`); `--check` and
`--check-bash` are the hook checks (they read the hook payload on stdin); `--ack` opens the gate
for this session by hand, for the rare session with nothing to recall. Exit 2 means blocked.

### `session-start`

Hook only. `gate --arm`, then `ingest` (new only), then `brief`, in one process.

## Configuration reference

`total_recall.json`, at the project root. Only `project` and `transcripts` are required.

```json
{
  "project": "my-project",
  "transcripts": "C:/Users/<you>/.claude/projects/<folder>",
  "sources": {
    "handoff":   "notes/SESSION-HANDOFF-*.md",
    "memory":    "C:/Users/<you>/.claude/projects/<folder>/memory/*.md",
    "changelog": "CHANGELOG.md",
    "map_section": "docs/PROJECT-MAP*.md"
  },
  "distill": { "provider": "ollama", "model": null },
  "ollama":  { "url": "http://localhost:11434", "model": "qwen3:14b", "chunkTokens": 6000 },
  "brief":   { "sessions": 3, "maxLines": 40, "standingLines": 15 },
  "search":  { "rawRecentDays": 7, "rawRecentLimit": 5, "minSim": 0.62 },
  "embed":   { "model": "nomic-embed-text", "batch": 32, "queryTimeoutMs": 6000 },
  "link":    { "minSim": 0.8, "minOverlap": 0.3 },
  "store":   "C:/Users/<you>/.total_recall/my-project.sqlite"
}
```

| Key | Default | Meaning |
|---|---|---|
| `project` | required | Name; also the default store file name and the gate marker folder. |
| `transcripts` | required | Folder of Claude Code `*.jsonl` transcripts for this project. Relative paths resolve from the config's folder. |
| `sources.handoff` / `.memory` / `.changelog` | none | Glob (one `*` in the file name) of note files to ingest, by kind. |
| `distill.provider` | `ollama` | `ollama` or `claude`. |
| `distill.model` | provider default | Model tag override for `distill`. |
| `ollama.url` | `http://localhost:11434` | Ollama endpoint. |
| `ollama.model` | `qwen3:14b` | Model tag when the provider is `ollama`. |
| `ollama.chunkTokens` | `6000` | Slice size sent to the model, in tokens (4 characters each). Sized so a 14B Q4 model fits a 16 GB GPU with its context. |
| `brief.sessions` | `3` | How many recent sessions the brief draws from. |
| `brief.maxLines` | `40` | Total cap on the brief. |
| `brief.standingLines` | `15` | Cap on the standing-rules part. |
| `search.rawRecentDays` | `7` | Window for the RAW fallback. |
| `search.rawRecentLimit` | `5` | Cap on RAW hits. |
| `search.minSim` | `0.62` | How close a hit found by meaning must be. Unrelated text scores about 0.50 with `nomic-embed-text`. |
| `sources.map_section` | none | Project maps and other reference documents. Cut at `##` and `###`; a section keeps its row until its words change, so an edited map adds one row, not nine hundred. Searched by default. |
| `embed.model` | `nomic-embed-text` | Ollama embedding model for the meaning lane. |
| `embed.batch` | `32` | Rows per embedding request. |
| `embed.queryTimeoutMs` | `6000` | How long a search waits for the query's vector before it falls back to words and says so. |
| `link.minSim` / `.minOverlap` | `0.8` / `0.3` | How alike two statements must be (by vector, or by shared title words when either has no vector) to be NOMINATED for the judge. |
| `store` | `~/.total_recall/<project>.sqlite` | Store file. |

Environment: `CLAUDE_CODE_SESSION_ID` (set by Claude Code in its shell; used for the gate),
`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` (the `claude` provider), `TOTAL_RECALL_HOME`
(overrides `~/.total_recall`, used by the tests).

## The distill step: with and without an AI model

`distill` is the only command that needs a model. Two providers:

**Ollama (default, local, free).** Install Ollama, `ollama pull qwen3:14b` (or another tag, set in
`ollama.model`), keep it running. On an RTX 5070 Ti (16 GB) the 14B model at Q4 handles a 6K-token
slice in roughly three minutes; a week of daily sessions is around 30 slices. The prompt asks for
JSON (`format: "json"`), temperature 0, thinking off.

**The Claude API.** Set `distill.provider` to `claude` (or pass `--provider claude`) and put
`ANTHROPIC_API_KEY` in the environment (or `ANTHROPIC_AUTH_TOKEN` after `ant auth login`). Default
model `claude-opus-5`; override with `distill.model` or `--model`. Each slice is one non-streaming
request of about 7K input tokens and under 2K output, so a week of sessions costs on the order of a
few dollars at current list prices. Requests carry the server-side refusal fallback
(`fallbacks: "default"`), so a policy decline reroutes to another model instead of failing the
chunk; a response that still ends in `refusal` is a FAILED chunk like any other. Calls go over raw
HTTP with Node's built-in `fetch` because this repo carries no npm dependencies.

**Without any model** the tool still does most of its job:

- `ingest`, `search`, `brief`, the gate and the hooks all work.
- `search` returns raw turns (`--kind turn`, `--kind all`) and always shows recent undistilled
  sessions under `RAW, not yet distilled`.
- Handoffs, memory files and the changelog are already distilled by their authors and are searched
  by default.
- The brief's standing rules come from `feedback`-type memory files, no model involved.

What you do not get is the `statement` tier: `--outcome rejected|open|approved` filters return
nothing, `--who` finds nothing, and searches answer with conversation instead of one-line
decisions. Run `distill` later, with either provider, and the same history fills in.

## What gets stored, and what never does

Stored: your text and Claude's text per turn; the tool names and file paths a turn touched;
compaction summaries; note-file sections; statements with their quotes and evidence ids.

Never stored: tool output (the results of Bash, Read, Grep and the rest, which are most of a
transcript's bytes and the place secrets and data rows live); subagent traffic; the inputs of tool
calls beyond a path.

Scrubbed before storage: `sk-...`, `ghp_...`, `xox[abp]-...`, `AKIA...` keys, `Bearer` tokens,
long hex or base64 runs near the words token, key, secret or password, and any `X_KEY=` /
`X_SECRET=` / `X_TOKEN=` / `PASSWORD=` line. The replacement is `[scrubbed]`; the row is kept.

The store never leaves your machine unless you run `distill --provider claude`, which sends the
raw turns of the chunks it distils to the Anthropic API.

## Tuning the distill prompt

The prompt is [`lib/distill-prompt.txt`](lib/distill-prompt.txt). Its sha is part of every run
record, so editing it re-runs every chunk and retires the statements the old prompt produced.
[`scripts/eval-prompt.js`](scripts/eval-prompt.js) scores a prompt against the gold set in
[`tests/prompt-eval/gold.json`](tests/prompt-eval/gold.json) (seven short slices with the
outcomes that must and must not appear) using the live model:

```bash
node scripts/eval-prompt.js                              # the shipped prompt, Ollama
node scripts/eval-prompt.js --prompt candidate.txt       # a candidate
node scripts/eval-prompt.js --provider claude            # the Claude API
```

The shipped prompt scores 13 of 13 gold labels with no forbidden labels on `qwen3:14b`. Seven
rounds got it there from 11 of 15; the record is in `docs/superpowers/plans/`.

## Honest limits

- The gate is a checkpoint, not obedience: any search opens it, and the Bash write heuristic will
  miss shapes it does not know.
- Without `embed`, ranking is bm25 only and a paraphrase can miss; try two searches. With it, the
  meaning lane's floor (`search.minSim`, 0.62) sits close to the noise: unrelated text scores about
  0.50 and loosely related text 0.60, so a `~meaning` hit near the floor deserves a second look.
- Supersession links depend on a 14B judge. It is shown the conversation, asked once, and guarded
  against the one shape it got wrong, but a missed reversal leaves both statements standing with
  their dates, exactly as before linking existed.
- A local 14B model mislabels sometimes; the validators catch the structural mistakes (who, quote,
  question-as-open) but not every judgement call. A pasted 18K-character shell log in one turn can
  make the model's JSON unparseable; that chunk is reported and skipped.
- The quote rule still drops a quote the model rewrote rather than tidied. Statements dropped
  before the fuzzy match existed come back only with `distill --redo` over those sessions.
- Windows paths, Windows hooks, Windows testing. It should run anywhere Node 22.13 does, but only
  Windows has been exercised.

## Development

```bash
npm test                       # node --test, 44 tests, no GPU or network needed
node scripts/eval-prompt.js    # prompt eval, needs a model
```

Design spec: [`docs/superpowers/specs/2026-09-18-total-recall-design.md`](docs/superpowers/specs/2026-09-18-total-recall-design.md).
Implementation plan with execution notes: [`docs/superpowers/plans/2026-09-18-total-recall.md`](docs/superpowers/plans/2026-09-18-total-recall.md).

Layout: `bin/total_recall.js` dispatches to one module per command in `lib/`; `lib/store.js` owns
the schema and every query; `tests/` is `node:test` with a synthetic transcript fixture and stub
HTTP servers for both providers.

Phase 2, built 2026-09-18: the meaning lane (`embed`, `lib/embed.js`); project maps as the
`map_section` kind (a `sources` entry, cut at `##` and `###`, one row per section whose words
changed); judged supersession links (`link`, `lib/link.js`); the MCP server (`mcp`, `lib/mcp.js`);
the fuzzy quote match and `distill --redo`. Tests for all five are in `tests/phase2.test.js`.
