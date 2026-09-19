# Recall, Find, Read and Inspect Coverage

Total Recall is an external long-term memory system, not a transcript search engine. `Recall` is
the first-class orchestration operation for natural memory requests. It selects and combines the
available evidence lanes, then gives the calling assistant a grounded synthesis contract. `Find`
is explicit evidence search, `Read` opens authoritative records/session context, and `Inspect
Coverage` reports what was imported/indexed and what remains unknown.

```text
total_recall recall "What did we decide about long messages?"
total_recall recall "Why did we choose a sidecar?"
total_recall recall "Continue what we were doing last week"
total_recall find "sidecar embeddings" --kind all
total_recall read 123 --before 1 --after 1
total_recall inspect-coverage
```

MCP/API names are `recall_recall`, `recall_search` (compatibility name for explicit Find),
`recall_read`, and `recall_inventory {what:"coverage"}`. A Recall result includes the classified
intent, selected retrieval lanes, opened source passages, relationship/context labels, read
handles, coverage/fallback notes, and the synthesis contract. The current assistant, not the
embedding model, turns that packet into a coherent recollection and cites project-qualified
record IDs. No additional synthesis service is called.

### How Recall gathers context

The calling assistant interprets the owner's request and supplies `project`, `client`, `who`,
date fields, `topic` and `intent` when needed. The owner does not have to learn switches.
For example, “why did we choose that approach in August?” needs the actual subject from the
conversation as `topic` and the actual year/month as `on`. Never guess a missing project or year.
Common question prefixes are recognized automatically, as are trailing today/yesterday/last week.
Last week means the previous Monday through Sunday in the reported timezone; resolved dates
are returned and shared across all lanes. This convenience parser is not a language model.

Recall combines owner decision records, summaries/handoffs, and direct source turns. It balances
these kinds rather than letting derived decisions crowd out the conversation. Continuation and
overview favor recent context; rationale starts with source history. Instruction questions
include one-off approvals and rejections, not just standing rules. All candidate lanes retain
the selected project and explicit filters. Project-wide requests use `topic: ""`, without a
dummy keyword. Explicit arbitrary query syntax belongs in Find, not Recall.

Selected records are actually opened. Linked originals, replacements and both sides of a
recorded conflict are opened next, followed by nearby turns in the same client/session. Context
can contain another speaker/date than the candidate filters; its relationship is labelled and
it never crosses projects. The current assistant must check whether nearby text explains the
decision, not assume adjacency proves it. No decision is rewritten or silently retired.

Default bounds: 8 candidate anchors, 24,000 source-text characters, at most 40 opened records.
`limit` allows 1–30 anchors; `chars` allows 1,000–30,000 source-text characters. Metadata is extra.
Long records can open near a word match or a verified matching semantic chunk. Offsets and
unread-before/next handles make omissions visible. Follow `recall_read` continuations for more
source text, `unopened` handles for deferred context, and lane Find cursors for further candidates.
`partial` is not a failure and `no_matches` is not proof a subject was never discussed.

Coverage comes from the selected project's recorded inventory, not a made-up confidence score.
It is project-wide, not restricted to the query. Missing ingestion completion remains unknown.
One query-vector attempt is shared across lanes, including an offline failure. `words: true`
and project-wide metadata recall make no embedding calls. No bulk indexing starts automatically.
Invalid filters fail before any lane runs. Model failure is a visible words-only fallback.

These are the current CLI/MCP retrieval interfaces. Older internal `lib/search.js` helpers remain
for compatibility with ingestion-era scripts/tests; CLI and MCP use `lib/recall.js` together.
Reads open schema-2 stores read-only. They never create a store, ingest, migrate, distill, cache
vectors or alter a decision. Successful Recall or Find may still acknowledge the real caller's edit gate.

## Ordinary questions

```text
total_recall search --project my-project --kind turn --who owner --client codex --direct --oldest --limit 1 --words
total_recall search --who claude --before 2026-09-01 --newest --limit 1 --words
total_recall search --on yesterday --kind turn --oldest --words
total_recall search --outcome standing --who owner
total_recall search --outcome standing --who owner --include-unclear
total_recall search --outcome rejected
total_recall search --outcome open
total_recall search "migr* NOT video" --match advanced --words
total_recall search "NEAR(DBQ narrative, 10)" --match advanced --words
total_recall search "*missing hist?ry*" --match substring
total_recall search "retain the emblem" --mode meaning --oldest
total_recall read 123 --before 1 --after 1 --project my-project
total_recall read --session codex:actual-session-key --project my-project
total_recall inventory projects
total_recall inventory sessions --client codex
total_recall inventory coverage
```

The tool names are `recall_search`, `recall_read`, `recall_inventory`; options have the same names
as CLI switches, using underscores where needed (`include_superseded`). `recall_brief` stays
available and scoped. Search words are optional when filters/order/browse specify the request.
An accidental empty request gets help. Bare `*` in the default matching mode means no restriction.

“What are my rules?” is a keyword-free inventory, not a search for the word “the” or “rules”.
Find lists current owner standing records and follows `next` to retrieve the full set. The
natural Recall entry also recognizes standard rules/standing-orders requests and gathers a
standing-only decision lane, with actual totals and Find continuations. That bounded source
packet is not the full list. A named topic still narrows the rules intentionally.

Standing records marked `decision-unclear` are omitted from a rules filter by default, matching
the brief's certainty boundary. `--include-unclear` / MCP `include_unclear: true` includes them
for review with an UNCLEAR label; read-by-ID and ordinary all-history searches still retain them.
No row is rewritten or deleted. Counts describe stored decision records, not distinct rules.
Imported feedback-memory notes remain in this inventory, but their stored excerpts are labelled
`memory-note-excerpt`, not verified owner quotations. The displayed authority says when no
conversation evidence is linked. Note summaries and conversation-derived rules may overlap.

`--match any` is default. `all`, `phrase`, `advanced` and `substring` are explicit alternatives.
Changing order never changes matching. Advanced syntax is SQLite FTS5 prefix, Boolean, grouping
and NEAR syntax; malformed expressions fail and are not rerun as a different query. Hard `all`,
`phrase` and `advanced` constraints apply to meaning results too. Plain `any` hybrid queries allow
paraphrases that share no words. A wildcard is not a shell expression, SQL or an executable variable.

Dates accept real YYYY, YYYY-MM, YYYY-MM-DD calendar periods, today/yesterday, or an ISO timestamp
with a timezone. `since` and `until` include the named periods; `before` and `after` exclude them.
`on` selects one whole period. The default timezone is `America/New_York`, overridable in config
or the request. Relative periods are frozen in the continuation. Original timestamps stay intact;
invalid/zone-less timestamps cannot establish a date-ordered first/last hit and are reported.

## Project registration

The current config's canonical project name, explicit `projectAliases`, and root folder name are
known aliases. Other projects must be registered, not discovered by crawling disk:

```json
{
  "projects": [
    { "root": "C:/work/project-one", "aliases": ["Project One"] },
    { "root": "C:/work/project-two" }
  ]
}
```

Put this in `~/.total_recall/projects.json` or point a project's `projectRegistry` at it. Roots are
relative to the registry file if not absolute. Each root must resolve to a valid config. Duplicate
or ambiguous aliases fail. `--root` and `--project` must agree. A project filter applies even when
several projects share a custom store. No request silently broadens to all projects.

## Continuing and counting

Default 20 rows/page, maximum 100, with a default 12,000-character evidence budget. Each excerpt
has a read handle. `read ID` returns a lossless text stream with a continuation when needed.
Session pages give every source handle, including clearly labelled reference/summary entries.
Context may include other speakers/dates, but never another project/client/session.

Pass the returned cursor to the same operation, without changing other query options. Chronology
uses timestamp/id keys; relevance uses an offset bound to the corpus revision. Changed corpus or
meaning index invalidates continuation rather than silently skipping/repeating results. An active
ingest/distill can therefore require a new search. Cursors are opaque continuation data, not secrets
or authorization tokens. Returned historical prose never changes the tool's scope or permissions.

Counts distinguish records, messages, sessions and decision records. A source and its extraction
are not two independent owner approvals. Substring scanning stops after 10,000 candidates, about
5 seconds, or a full page. Its counts/order describe the examined batch, not the entire corpus;
continue to examine the rest. A partial empty page is not a negative answer. No fuzzy deduplication
or automatic supersession was added. Current searches omit replaced/struck rows unless requested;
read-by-id can still show them and their relations.

## Full-text concept coverage

Existing vectors are reused with an explicit warning: they may cover only the first 6,000 characters
and do not pin the historical model version. Verified full-text coverage uses an optional derived
sidecar, `<source-store>.search.sqlite` (override `search.index` with an absolute filename).
This avoids a migration or any rewrite of source IDs, hashes, quotes, decisions or Sonnet runs.

The sidecar stores parent identity/content hash, model metadata signature, chunker version,
character offsets, vectors and completeness. Paragraph-aware 2,048-character chunks overlap by
256 characters. The local encoder is called with `truncate: false`; oversized inputs fail visibly,
not silently. A failed record keeps completed chunks for resumption and never claims full coverage.
This uses the documented [Ollama embedding endpoint](https://docs.ollama.com/api/embed) and
[model metadata endpoint](https://github.com/ollama/ollama/blob/main/docs/api.md#show-model-information).
Changed source/model/chunker invalidates only derived chunks. Removed source rows are never queried.

```text
total_recall index --dry
total_recall index --limit 100
```

`--dry` makes no model calls or writes. The real command needs separate approval: it uses local
GPU time. Repeating it skips unchanged complete records and resumes partial ones. It does not
call a paid provider. `embed` remains the legacy one-vector-per-record command for compatibility;
it is not a substitute for full-text chunk coverage. No bulk indexing happens during a search.

Search checks the current local model identity and asks for one query vector under the configured
query timeout (default six seconds). Model unavailable means an explicit words-only fallback.
Every eligible vector is considered before chronological ordering; there is no top-relevance-20
shortcut masquerading as earliest. Even complete embeddings cannot prove semantic recall is
perfect. Say "earliest relevant among indexed candidates examined," not "first ever."

Coverage lists configured sources and recorded checkpoints without source scans. A checkpoint
does not prove a completed ingest. Missing knowledge is null/unknown, not zero. The imported
Claude Code/Codex corpus is not the entirety of ChatGPT web project history.

## Review and activation

Code, tests and skill sources can be reviewed in isolation. Activation, installed skills/MCP
allowlist changes, live-data rehearsal, and a real indexing run are separate steps. Nothing in
this retrieval work changes the decision reader prompt, source identity rules or paid-run meter.
