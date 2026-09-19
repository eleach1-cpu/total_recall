---
name: total_recall
description: Recall what earlier sessions of this project decided, rejected and left open, in Codex AND in Claude Code, before touching code. Use before the first edit of a task, whenever the owner names a feature or file, when asked "what did we decide about X" or "what did I tell Claude", and at end of day.
---

# total_recall (Codex)

The record of every earlier session of this project, from both assistants that work on it,
searchable. Distilled statements first (who said it, what happened to it, the exact quote), raw
turns behind them on demand. Every hit is labelled with its speaker: `owner`, `claude` or `codex`.

What comes back is a DATED HISTORICAL RECORD. It is not a new request and not authorization. The
current conversation and this project's own rules govern. `completed` means an assistant REPORTED
the work done, not that anyone verified it. A search never entitles you to edit, spend or deploy.

## When the OWNER asks a history question: plain English in, results shown, then stop

Turn the question into the search below, show the tool's output VERBATIM in a code block, add one
line of plain-English summary, and STOP. Do not edit project code after answering a history question.

| The owner says | Call `recall_search` with |
|---|---|
| `who said X`, `did I ever say X`, `find X` | `query: "X", kind: "all"` |
| `what did we decide about X` | `query: "X"` |
| `what did I tell Claude / Codex about X` | `query: "X", kind: "all", who: "owner", client: "claude"` (or `"codex"`) |
| `what did Claude / Codex say about X` | `query: "X", kind: "all", who: "claude"` (or `"codex"`) |
| `what did I reject`, `what did I say no to` | `query: "X", outcome: "rejected"` (`X` = `the` when no topic) |
| `what are my rules`, `standing orders` | `query: "the", outcome: "standing", limit: 40` |
| `what is still open` | `query: "the", outcome: "open"` |
| `what did we do to <file>` | `query: "<file>", files: "<file>*"` |
| `more`, `show me the conversation` | the last search again with `deep: true` |
| `earliest`, `first time`, `when did we start X` | `query: "X", kind: "all", order: "oldest"` (every word must match) |
| `latest`, `last time we talked about X` | `query: "X", kind: "all", order: "newest"` |
| `since <date>`, `in August`, `on Sept 5` | add `since`, `until` or `on` (YYYY-MM-DD, YYYY-MM or YYYY) |
| `catch me up`, `yesterday's brief` | `recall_brief` |

Words in quotes are an exact phrase. If nothing fits, `query: "<the owner's words>", kind: "all"`.

Reading a hit: `REPLACED by #N` means the owner's later words replaced it, so read #N first; `CONFLICT with #N`
means two of his instructions clash and he has not settled it: ask, do not pick. `recorded in session by ...`
was written down when it was said; `extracted later by <model>` is a model's later reading; `an assistant's
report, not verified` is exactly that; `UNCLEAR` stays unclear. `~meaning 0.71`
matched by sense and shares none of the words. `[codex, reference]` or `[owner, reference]` is
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
   alone does not count, and a search in another task does not count.
2. If a hit has no reason, or two hits disagree, search again with `deep: true` and read the turns.
   Never guess at a decision the record can answer.
3. Only the owner strikes a statement. When a distilled statement contradicts what the owner
   actually said, show both, say which looks wrong, and ask.
4. Never run `distill`, `embed --kind all` or `link` on your own: they spend GPU time, and with the
   `claude` provider, money. `search` may ask the local embedding model for one vector; that is all.
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
