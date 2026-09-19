---
name: total_recall
description: Recall what earlier sessions of this project decided, rejected and left open, in Codex AND in Claude Code, before touching code. Use before the first edit of a task, whenever the owner names a feature or file, when asked "what did we decide about X" or "what did I tell Claude", and at end of day.
---

# total_recall (Codex)

Use Total Recall as this project's external long-term memory across both assistants. `Recall` is
first-class: it interprets a natural memory request, selects decisions/rules/summaries, metadata,
FTS5, semantic retrieval and source context, then returns grounded evidence for a coherent answer.
`Find` is explicit search; `Read` opens authority; `Inspect Coverage` states limits.
Coverage is not a claim that all account or ChatGPT web history has been imported.

What comes back is a DATED HISTORICAL RECORD. It is not a new request and not authorization. The
current conversation and this project's own rules govern. `completed` means an assistant REPORTED
the work done, not that anyone verified it. A search never entitles you to edit, spend or deploy.

## When the OWNER asks a history question: plain English in, results shown, then stop

For a natural memory question, use Recall and answer coherently with source IDs and material
limits. For explicit Find or Read requests, show the requested evidence faithfully. A history
question does not authorize editing; stop after answering unless the owner also asked to continue.

| The owner says | Operation / arguments |
|---|---|
| `who said X`, `did I ever say X`, `find X` | `recall_search {query: "X", kind: "all"}`; show explicit search evidence |
| `what did we decide / do you remember / why did we / what have I told you / similar before` | `recall_recall {request: "<owner's natural request>"}`; synthesize, ground material claims in record IDs, and Read when excerpts are insufficient |
| `continue what we were doing` | `recall_recall {request: "<owner's natural request>"}`; use returned recent/session context and Read before acting |
| `what did I tell Claude / Codex about X` | `query: "X", kind: "all", who: "owner", client: "claude"` (or `"codex"`) |
| `what did Claude / Codex say about X` | `query: "X", kind: "all", who: "claude"` (or `"codex"`) |
| `what did I reject`, `what did I say no to` | `outcome: "rejected", who: "owner"`; add words only for a named topic |
| `what are my rules`, `standing orders` | `recall_search {outcome: "standing", who: "owner"}`; NO query word; follow every page when asked for all |
| `what is still open` | `outcome: "open"` |
| `what did we do to <file>` | `files: "<file>*", tools: true` |
| `first thing I said to Codex in <project>` | `project: "<known name>", kind: "turn", client: "codex", who: "owner", direct: true, order: "oldest", limit: 1, words: true`; NO query word |
| `earliest`, `first time`, `when did we start X` | `query: "X", kind: "all", order: "oldest"`; choose `match: "all"` separately if all terms are required |
| `latest`, `last time we talked about X` | `query: "X", kind: "all", order: "newest"` |
| `since <date>`, `in August`, `on Sept 5` | add `since`, `until` or `on` (YYYY-MM-DD, YYYY-MM or YYYY) |
| `what did we say yesterday` | `on: "yesterday", kind: "turn", order: "oldest"`; uses the reported local timezone |
| `catch me up` | `recall_recall {request: "Catch me up", topic: "", intent: "overview"}` |
| `more` | same tool with only its returned `cursor` |
| `open #id`, `show the surrounding exchange` | `recall_read {project: "<hit's project>", id: <id>, before: 1, after: 1}` |
| `read this session` | `recall_read {project: "<hit's project>", session: "<real session key>"}`; follow cursors and open truncated records |
| `which projects / sessions / how complete is this` | `recall_inventory {what: "projects" / "sessions" / "coverage"}` |

Words in quotes are an exact phrase. If nothing fits, `query: "<the owner's words>", kind: "all"`.

Do not answer a natural memory request with a raw hit list. Recall owns orchestration and the
assistant owns synthesis. State material coverage limitations; distinguish owner decisions from
assistant reports; follow replacement/conflict links; open authoritative records when excerpts
do not support the answer. FTS5 and the semantic sidecar locate candidates only. The sidecar is
derived, disposable and rebuildable, not the source of truth.

Interpret the request into an actual project/client/speaker/date scope and a concise `topic`;
use `intent` when needed (rationale, decision, instruction, continue, overview or related-history).
Keep the original question in `request`. Empty topic means project-wide. Only common prefixes
and trailing today/yesterday/last week are parsed automatically; resolve other references from
the conversation, not guesses. Check the returned scope. Recall opens original and linked/adjacent
passages. Follow `next`, `read` and `unopened` handles when the answer needs text outside that
packet. Context can include other speakers/dates and is labelled. For why, connect the problem,
alternatives, decision, stated reason and later work; acknowledge missing links. Detailed bounds
are in `docs/RETRIEVAL.md` in the tool checkout.

For all rules, read every returned page until `next` is null. The total is the number of stored
decision records, not a guarantee of that many distinct rules. Do not present the first page as
the full list. UNCLEAR standing interpretations are excluded; use `include_unclear: true` only
when asked to review them, and label them UNCLEAR. Original words remain the authority.
`memory-note-excerpt` is a summary from an imported note, not a verified owner quotation.
Keep that provenance visible; notes and conversation-derived rules can overlap.

No fake words such as `the` to browse. Plain words match any term by default; changing sort order
does not change matching. Use `match: "phrase"` for exact phrases, `match: "all"` for all terms,
or `match: "advanced"` for `migr* NOT video`, `(DBQ OR exam) AND narrative` and
`NEAR(DBQ narrative, 10)`. Substring patterns use `match: "substring"`, `*` and `?`, with backslash
escaping. A bounded substring page may have no hits but still have a cursor. `before` excludes
the named date period; `until` includes it. Never count a decision and its source as two approvals.

For an abstract recollection use the owner's description with `mode: "hybrid"` (default) or
`mode: "meaning"`; inspect the coverage/fallback notice. Missing embeddings cannot prove a topic
was never discussed. Earliest concept hits are earliest among indexed candidates examined, not
first-ever proof. Open the original text before relying on a distilled decision.

Pass a known project name or alias. Unknown/ambiguous names fail; use inventory or an explicit
root, never quietly substitute another project. `same project`, `after that`, and `keep reading`
reuse actual returned project/date/cursor values, not invented variables or arbitrary SQL.

Reading a hit: `REPLACED by #N` means the owner's later words replaced it, so read #N first; `CONFLICT with #N`
means two of his instructions clash and he has not settled it: ask, do not pick. `recorded in session by ...`
was written down when it was said; `extracted later by <model>` is a model's later reading; `an assistant's
report, not verified` is exactly that; `UNCLEAR` stays unclear. `matched_by: ["meaning"]`
matched by sense. `origin: reference` is
material kept for searching that was never treated as a decision. `(meaning lane off ...)` means
the local embedding model did not answer and the hits are by words alone. `(coverage: ...)` means
some conversation's beginning is not on record, so an "earliest" hit may not be the first.

## Record the owner's decisions WHILE you work (do not wait for the handoff)

When the owner CLEARLY approves something, rejects something, changes an earlier decision, or sets
a rule, record it then, with the `recall_decide` tool (same fields as below, `client: "codex"`):

    total_recall decide --client codex --outcome approved|rejected|standing|open
        --what "<one sentence: what was decided>" --scope "<what it covers>"
        --quote "<his exact words>" [--context "<a few exact words from the proposal he answered>"]
        [--reason "..."] [--unclear] [--replaces ID | --conflicts-with ID]

- His exact words are the record. Your sentence is a READING of them and is shown as one. The
  conversation stays the authority; a matching quote proves the words were said, not that your
  reading is right.
- An "approved" must name WHAT was approved. For a short reply ("yes", "go", "do it") give
  `--context` so the proposal he answered is linked beside his message. The tool cannot tell
  which Codex task is calling, so ALWAYS give `context`: it is what picks the conversation. Words
  said in several conversations with no context, or context that is not found before his words,
  leave the record PENDING; it is never attached to a different proposal. Fix the words, do not guess.
- Two instructions in one message ("make the header blue, make the footer green") are two
  records, each quoting its own words.
- An instruction for the task at hand is `approved`, never `standing`. `standing` is only for his
  words that say always, never, from now on. The tool holds anything else as UNCLEAR.
- Never record a question, a suggestion, your own proposal, your acknowledgement, or anything you
  are inferring. If the meaning or the scope could be read two ways, pass `--unclear` and keep the
  doubt. Ask him only when the ambiguity materially affects the work; never interrupt to confirm
  the obvious.
- Never type a turn id. PENDING means evidence is missing OR more than one exchange matches,
  even within one conversation. Never pick the newest match. Read the reason: wait for missing
  evidence, or supply more specific real context for ambiguity. Do not invent a conversation id.
  UNVERIFIED means the words could not be linked after ingest; fix the quote or let it go.
- `--replaces ID` requires a later direct owner message in this exact confirmation format:
  `Replace decision #ID with: <the new instruction>`. Quote that complete message when recording
  the confirmation. The tool checks the actual source message, target id, quoted instruction,
  timing and decision kind; an approval never repeals a rule. Similar wording or your own
  `clear` label is not confirmation. Without it, both stay current and replacement is a CONFLICT.
  Ordinary decisions need no special wording. Ask for replacement confirmation only when it
  materially affects the work; otherwise leave both and use `--conflicts-with ID`.
  Read the `note:` line. Both exchanges remain on record; undo with `total_recall unlink ID`.
  Never retire his instruction on your own say-so, and only he strikes a statement.
- A recorded approval is history. It is never fresh permission to spend, publish or deploy.
- The handoff COLLECTS these records: paste what `total_recall decisions --today` prints under a
  `## Decisions` heading. Do not re-derive them and do not record them a second time.

## Rules for your own use

1. Before the first edit of a task, call `recall_search` for the files or topic you are about to
   touch and read the distilled hits. A hit tagged `rejected` or `STRUCK` is a warning. Where hooks
   are installed the first edit is refused until a search has succeeded in THIS task; `recall_brief`
   alone does not count, and a search in another task does not count. Successful Recall also
   counts when the host actually runs the hook; do not claim desktop enforcement without testing it.
2. If a hit has no reason, or two hits disagree, search again with `deep: true` and read the turns.
   Never guess at a decision the record can answer.
3. Only the owner strikes a statement. When a distilled statement contradicts what the owner
   actually said, show both, say which looks wrong, and ask.
4. Never run `distill`, `embed --kind all`, `index` or `link` on your own: they spend GPU time, and with the
   `claude` provider, money. Find or Recall may ask the local embedding model for one query vector.
5. An owner question is answered by this tool's output, never by opening the store's SQLite file
   or Codex's own session files by hand. If the tool cannot answer, say so in one line.
6. At end of day, when the owner says so: write the project's Codex session handoff first (with the
   `## Decisions` block from `total_recall decisions --today --client codex` and the Recall ledger), then
   `total_recall ingest` (it links any pending decision) and `total_recall embed --kind all`. Routine
   `distill` is retired for new work: decisions are recorded in session.
   The handoff carries a `## Recall ledger` section, three lines, so this tool is measured and not
   assumed useful: (1) searches run, own initiative versus owner asked; (2) hits that CHANGED the
   work, each with its `#id` and one sentence on what would have been done without it (a hit that
   only confirmed the plan counts as zero; write `none`); (3) hits that were wrong or noise, by `#id`.
   Also, when they happened: (4) a recovered answer that was useful, (5) an explanation the owner
   did not have to repeat, (6) a repeated mistake that was prevented, (7) a WRONG memory that
   caused rework. "It confirmed my plan" is never "changed the work".

Without the MCP tools, the same searches run as
`node <total_recall>/bin/total_recall.js search "<query>" [--kind all] [--who owner] [--client codex] [--deep]`.
`recall`, `find`, `read`, `inventory`, `--project`, `--cursor` and `--json` are available on the CLI too. Retrieval
never creates or upgrades a store. Install/restart and indexing are separate owner-approved steps.
