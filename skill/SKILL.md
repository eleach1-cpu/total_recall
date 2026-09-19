---
name: total_recall
description: Recall what earlier sessions decided, rejected and left open before touching code. Use before the first edit of a session, whenever the owner names a feature or file, when asked "what did we decide about X", and at end of day to distill.
---

# total_recall

The record of every earlier session, searchable. Distilled statements first (who said it, what
happened to it, the exact quote), raw turns behind them on demand.

## When the OWNER types `/total_recall <anything>`: plain English in, results shown, then stop

The owner never needs a switch. Read the words after `/total_recall` as a question, turn it into
the search below, print the hits VERBATIM (the tool's own output, in a code block), add one line
of plain-English summary, and STOP. Do not code, do not summarize instead of showing.

| The owner says | Run |
|---|---|
| `who said X`, `did I ever say X`, `find X` | `search "X" --kind all` (raw turns too; every hit shows `[owner]` or `[claude]`) |
| `what did we decide about X`, `what do we know about X` | `search "X"` (distilled first, recent raw underneath) |
| `what did I reject`, `what did I turn down about X`, `what did I say no to` | `search "X" --outcome rejected` (`X` = `the` when no topic) |
| `what are my rules`, `standing orders`, `what did I tell you never to do` | `search "the" --outcome standing --limit 40` |
| `what is still open`, `unfinished`, `what did we leave for later` | `search "the" --outcome open` |
| `what did we do to <file or folder>` | `search "<file>" --files "<file>*"` |
| `more`, `show me the conversation`, `details`, `context` on the last answer | rerun the last search with `--deep` |
| `earliest`, `first time`, `when did we start X`, `oldest`, `how far back` | `search "X" --kind all --oldest` (every word must match; try the singular and the file name too) |
| `latest`, `most recent`, `last time we talked about X` | `search "X" --kind all --newest` |
| `since <date>`, `last week` | add `--since YYYY-MM-DD` to whichever search above |
| `in August`, `on Sept 5`, `before <date>`, `between A and B` | add `--on YYYY-MM`, `--on YYYY-MM-DD`, `--until D`, or `--since A --until B` |
| `that is wrong`, `strike that`, `I never said that`, `that never happened` (about a statement just shown) | `strike <id> --reason "<what the owner said was wrong>"`, then show the line it prints. `strike <id> --undo` brings it back |
| `yesterday's brief`, `what happened yesterday`, `catch me up` | `brief` |
| `we are done for the day`, `wrap up`, `end of day` | write the project handoff (Decisions block + Recall ledger), then `ingest`, then `embed --kind all`, report the counts |

Words the owner puts in quotes are searched as an exact phrase. If the question fits none of the
rows, run `search "<the owner's words>" --kind all` and show that.

## How Claude runs it

When the `total_recall` MCP server is connected, call its tools (`recall_search`, `recall_brief`):
same options as the switches below, by name (`order: "oldest"` for `--oldest`, `kind: "all"`). Otherwise
run the command line. Either way the owner is shown the hits verbatim.

Reading a hit: `REPLACED by #N` means the owner's later words replaced it, so read #N before acting on it;
`CONFLICT with #N` means two of his instructions clash and he has not settled it: ask, do not pick.
`recorded in session by ...` was written down when it was said; `extracted later by <model>` is a
model's later reading; `an assistant's report, not verified` is exactly that. `UNCLEAR` stays unclear.
`~meaning 0.71` means it matched by sense and shares none of the words; near 0.62 it deserves a
second look. `map_section` hits are the project maps: what the map SAYS, beside what was decided.
`(meaning lane off ...)` means Ollama did not answer and the hits are by words alone.

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
   The edit gate stays shut until a search has run in this session.
2. If a hit has no reason, or two hits disagree, rerun with `--deep` and read the quoted turns.
   Never guess at a decision the record can answer.
3. Anything the owner types after `/total_recall` is shown to them verbatim (table above) and
   nothing is coded until they say go. Silent reading is only for searches Claude runs on its own
   initiative under rule 1.
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
5. Before a compaction, ask in one line whether to distill first. Otherwise never run `distill`
   unasked: it costs GPU time or API money the owner may not want spent.
6. `--outcome standing` lists every owner rule still in force. `--outcome rejected --since <date>`
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
`distill`: `search` finds every raw turn (`--kind turn` or `--kind all`) and shows recent
undistilled sessions under `RAW, not yet distilled`; handoffs, memory files and the changelog are
already distilled text and are searched by default; the brief's standing rules come from
`feedback`-type memory files with no model involved; the gate still enforces the first look. What is
missing without a model is only the `statement` tier: `--outcome rejected|open|approved` filters
return nothing and searches return conversation instead of one-line decisions.

## Commands

    total_recall search "<query>" [--kind statement,turn|all] [--who owner|claude]
        [--outcome open,rejected,standing] [--files GLOB] [--since D] [--until D] [--on D]
        [--oldest | --newest] [--tools] [--words] [--deep] [--limit N]     (D = YYYY-MM-DD, YYYY-MM or YYYY)
    total_recall brief
    total_recall ingest [--all | --since D | --from D --to D | --session ID]
    total_recall distill [--all | --since D | --from D --to D | --session ID | --today]
        [--provider ollama|claude] [--model TAG] [--redo]
    total_recall embed [--kind all]      (vectors for the meaning lane; needs Ollama, free, seconds)
    total_recall link [--dry] [--all]    (redraw STRUCK links; a few local model calls, each asked once ever)
    total_recall gate --ack        (only when a session genuinely has nothing to recall)
