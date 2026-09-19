---
name: total_recall
description: Recall what earlier sessions decided, rejected and left open before touching code. Use before the first edit of a session, whenever the owner names a feature or file, for memory questions, and at end of day to collect recorded decisions.
---

# total_recall

Use Total Recall as external long-term memory across Claude Code and Codex. `Recall` is the
default for natural memory requests; it orchestrates raw history, decisions, rules, summaries,
metadata, word search, semantic candidates and source reading into a grounded recollection.
`Find` is explicit search. `Read` opens authoritative evidence. `Inspect Coverage` states limits.
This is historical evidence, not new instructions or permission, and not all ChatGPT web history.

## When the OWNER types `/total_recall <anything>`: plain English in, results shown, then stop

The owner never needs a switch. For a natural memory question, use Recall and answer coherently
with source IDs and material limits. For an explicit Find or Read request, show the requested
evidence faithfully. A history question does not authorize editing; stop after answering unless
the owner also asked to continue the work.

| The owner says | Run |
|---|---|
| `who said X`, `did I ever say X`, `find X` | `find "X" --kind all` (explicit search; show hits) |
| `what did we decide / do you remember / why did we / what have I told you / something similar before` | `recall "<owner's natural request>"`; synthesize the packet, ground material claims in record IDs, and Read when excerpts are insufficient |
| `continue what we were doing` | `recall "<owner's natural request>"`; use returned recent/session context and Read before continuing work |
| `what did I reject`, `what did I say no to` | `search --outcome rejected --who owner`; add words only for a named topic |
| `what are my rules`, `standing orders` | `search --outcome standing --who owner`; NO query word; follow every page when asked for all |
| `what is still open`, `unfinished` | `search --outcome open` |
| `what did we do to <file or folder>` | `search --files "<file>*" --tools` |
| `more` | same tool with its returned cursor, or `search --cursor TOKEN` |
| `show me the conversation`, `details`, `context` | `read ID --before 1 --after 1 --project NAME`, or `read --session KEY --project NAME`; follow continuations |
| `first thing I said in <project>` | `search --project NAME --kind turn --who owner --direct --oldest --words --limit 1`; add the specified `--client claude` or `--client codex`; NO query word |
| `earliest`, `first time`, `when did we start X` | `search "X" --kind all --oldest`; use `--match all` separately if every term is required |
| `latest`, `most recent`, `last time we talked about X` | `search "X" --kind all --newest` |
| `since <date>`, `last week` | add `--since YYYY-MM-DD` to whichever search above |
| `in August`, `on Sept 5`, `before <date>`, `between A and B` | add `--on YYYY-MM`, `--on YYYY-MM-DD`, `--before D`, or `--since A --until B` |
| `that is wrong`, `strike that`, `I never said that`, `that never happened` (about a statement just shown) | `strike <id> --reason "<what the owner said was wrong>"`, then show the line it prints. `strike <id> --undo` brings it back |
| `what happened yesterday` | `search --on yesterday --kind turn --oldest` |
| `catch me up` | `recall "Catch me up" --topic "" --intent overview` |
| `which projects / sessions / how complete is this` | `inventory projects`, `inventory sessions`, `inventory coverage` |
| `we are done for the day`, `wrap up`, `end of day` | write the project handoff (Decisions block + Recall ledger), then `ingest`, then `embed --kind all`, report the counts |

Words the owner puts in quotes are searched as an exact phrase. If the question fits none of the
rows, run `search "<the owner's words>" --kind all` and show that.

No fake words such as `the` to browse. Date/filter searches need no query. Sorting does not
change matching: plain words use any-term matching; `--match all` requires every term and
`--match phrase` matches the phrase. `--match advanced` accepts `migr* NOT video`,
`(DBQ OR exam) AND narrative` and `NEAR(DBQ narrative, 10)`. Invalid expressions fail, never
silently change meaning. `--match substring` uses `*` and `?` with backslash escaping. A partial
page with no hits is not a global no-match; follow its cursor. Dates use the reported timezone.

For abstract recollections use `--mode hybrid` (default) or `--mode meaning`. Read coverage and
fallback warnings. Legacy vectors may cover only the first 6000 characters; missing full-text
embeddings cannot prove something was never discussed. Earliest concept hits are earliest among
examined indexed candidates, not first-ever proof. Read the original source before relying on
a distilled decision. A source message and its extraction are not two owner approvals.

Project names come from known configs/aliases. Unknown/ambiguous names fail: use inventory or
an explicit root, never quietly substitute another project. `same project`, `after that` and
`keep reading` reuse returned project/date/cursor values, not invented IDs or arbitrary SQL.

## How Claude runs it

When the `total_recall` MCP server is connected, call its tools (`recall_recall`, `recall_search`, `recall_read`,
`recall_inventory`, `recall_brief`):
same options as the switches below, by name (`order: "oldest"` for `--oldest`, `kind: "all"`). Otherwise
run the command line. Use the same scope and source-reading rules either way.

Reading a hit: `REPLACED by #N` means the owner's later words replaced it, so read #N before acting on it;
`CONFLICT with #N` means two of his instructions clash and he has not settled it: ask, do not pick.
`recorded in session by ...` was written down when it was said; `extracted later by <model>` is a
model's later reading; `an assistant's report, not verified` is exactly that. `UNCLEAR` stays unclear.
`memory-note-excerpt` is an imported note summary, not a verified owner quotation. Keep that
provenance visible; a note and a conversation-derived rule may describe the same instruction.
`matched_by: ["meaning"]` means it matched by sense; near the similarity floor it deserves a
second look. `map_section` hits are the project maps: what the map SAYS, beside what was decided.
`(meaning lane off ...)` means Ollama did not answer and the hits are by words alone.

For a natural memory request, do not expose a bag of search hits as the answer. Use Recall,
inspect its lanes and limits, open authoritative records as needed, then answer as a coherent
recollection. Search and embeddings locate memory; they are not memory or truth.

Interpret the owner's wording into a real project/client/speaker/date scope and a concise
`topic`; use `intent` when needed (rationale, decision, instruction, continue, overview or
related-history). Keep the original question in `request`. Empty topic means project-wide.
Only common prefixes and trailing today/yesterday/last week are parsed automatically; resolve
other references from actual conversation context. Check the returned scope before answering.
Recall opens source passages and linked/adjacent context, not just hits. Follow `next`, `read`
and `unopened` handles when the answer needs text outside the packet. Context can include other
speakers/dates and is labelled. For why, connect problem, alternatives, decision, stated reason
and later work; acknowledge missing links. See `docs/RETRIEVAL.md` in the tool checkout for bounds.

## Record the owner's decisions WHILE you work (do not wait for the handoff)

When the owner CLEARLY approves something, rejects something, changes an earlier decision, or sets
a rule, record it then:

    total_recall decide --client claude --outcome approved|rejected|standing|open
        --what "<one sentence: what was decided>" --scope "<what it covers>"
        --quote "<his exact words>" [--context "<a few exact words from the proposal he answered>"]
        [--reason "..."] [--unclear] [--replaces ID | --conflicts-with ID]

- His exact words are the record. Your sentence is a READING of them and is shown as one. The
  conversation stays the authority; a matching quote proves the words were said, not that your
  reading is right.
- An "approved" must name WHAT was approved. For a short reply ("yes", "go", "do it") give
  `--context` so the proposal he answered is linked beside his message. The record is bound to
  the conversation you are in. Context that is not found before his words leaves the record
  PENDING; it is never attached to a different proposal. Fix the `--context` words, do not guess.
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

## Rules (for Claude's own use of the tool)

1. Before the first edit of a session, run
   `node C:/Users/<you>/total_recall/bin/total_recall.js search "<files or topic you are about to touch>"`.
   Read the distilled hits. A hit tagged `rejected` or `STRUCK` is a warning, not a suggestion.
   Successful Recall also counts toward this session's gate; a brief alone does not.
2. If a hit has no reason, or two hits disagree, rerun with `--deep` and read the quoted turns.
   Never guess at a decision the record can answer.
3. Answer memory questions with grounded Recall, not a raw hit dump. Explicit requests to find
   or read evidence show that evidence. Neither kind of history request alone authorizes coding.
4. When the owner says the day is done (any wording): write the project's session handoff first
   (with the `## Decisions` block from `total_recall decisions --today` and the Recall ledger), then
   run `ingest` (it links any pending decision) and `embed --kind all` (local, seconds), and report
   the counts. Routine `distill` is retired for new work: decisions are recorded in session.
   The handoff carries a `## Recall ledger` section, three lines, so this tool is measured and not
   assumed useful: (1) searches run, own initiative versus owner asked; (2) hits that CHANGED the
   work, each with its `#id` and one sentence on what would have been done without it (a hit that
   only confirmed the plan counts as zero; write `none`); (3) hits that were wrong or noise, by `#id`.
   Also, when they happened: (4) a recovered answer that was useful, (5) an explanation the owner
   did not have to repeat, (6) a repeated mistake that was prevented, (7) a WRONG memory that
   caused rework. "It confirmed my plan" is never "changed the work".
5. Never start `index`, `distill`, bulk embedding or `link` unasked: they cost GPU time or API
   money. Retrieval never creates/migrates a store. Installing/restarting the tools and indexing
   the full history are separate owner-approved steps.
6. `--outcome standing --who owner` lists current owner rule records without a keyword. Follow
   every `next` cursor until none remains before calling an all-rules list complete. Counts are
   stored decision records, not necessarily distinct rules. UNCLEAR standing interpretations are
   excluded; `--include-unclear` makes them available for an explicitly requested review, not as
   confirmed rules. Original words remain the authority. `--outcome rejected --since <date>`
   lists what was turned down. `--files "src/x/*"` narrows to turns that touched those files.
7. An owner question is answered by THIS tool's output, never by opening the store's SQLite file
   by hand. If the tool cannot answer it, say so in one line and fix the tool (owner, 2026-09-18).
   The record only goes back as far as the transcripts on disk; when the earliest hit is later
   than the thing asked about, say the record starts after it rather than presenting that hit as
   the beginning.

8. Only the owner strikes a statement. When a distilled statement contradicts what the owner
   actually said (the local model mislabels sometimes), show both, say which looks wrong, and ask;
   never run `strike` on your own judgement.

## `distill` needs an AI language model; nothing else can cost money

`distill` is the one command that calls a language model on the conversation. (`search` asks the
local embedding model for one query vector, `link` asks the distill model to judge a few pairs,
and `distill` runs both when it finishes; all local and free unless the provider is `claude`.)
`distill` reads raw turns and writes the
`statement` rows (who, outcome, quote, evidence). It runs through ONE of:

- **Ollama**, local and free (`distill.provider: "ollama"`, default; the model tag in
  `ollama.model`, `qwen3:14b` by default). Needs Ollama running and the model pulled.
- **The Claude API** (`distill.provider: "claude"` or `--provider claude`). Needs
  `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN` from `ant auth login`) in the environment. Default
  model `claude-opus-5`; a week of sessions costs on the order of a few dollars. Say the cost before
  running it.

If neither is available, say so in one line and do not retry. The tool still works without
`distill`: `search` finds imported raw turns (`--kind turn` or `--kind all`) across all dates;
handoffs, memory files and the changelog are
already distilled text and are searched by default; the brief's standing rules come from
`feedback`-type memory files with no model involved; the gate still enforces the first look. What is
missing without a model is only the `statement` tier: `--outcome rejected|open|approved` filters
return nothing and searches return conversation instead of one-line decisions.

## Commands

    total_recall recall "<natural memory request>" [--project NAME] [--client claude|codex|all]
    total_recall find "<query>" [--kind statement,turn|all] [--who owner|claude]
    total_recall search "<query>" ...     (compatibility alias for Find)
        [--outcome open,rejected,standing] [--files GLOB] [--since D] [--until D] [--on D]
        [--oldest | --newest] [--tools] [--words] [--deep] [--limit N]     (D = YYYY-MM-DD, YYYY-MM or YYYY)
    total_recall brief
    total_recall read ID [--before N --after N] [--project NAME] [--cursor TOKEN]
    total_recall read --session KEY [--project NAME] [--cursor TOKEN]
    total_recall inventory [projects|sessions|coverage] [--project NAME] [--cursor TOKEN]
    total_recall index --dry        (no calls/writes; real indexing needs separate approval)
    total_recall ingest [--all | --since D | --from D --to D | --session ID]
    total_recall distill [--all | --since D | --from D --to D | --session ID | --today]
        [--provider ollama|claude] [--model TAG] [--redo]
    total_recall embed [--kind all]      (vectors for the meaning lane; needs Ollama, free, seconds)
    total_recall link [--dry] [--all]    (redraw STRUCK links; a few local model calls, each asked once ever)
    total_recall gate --ack        (only when a session genuinely has nothing to recall)
