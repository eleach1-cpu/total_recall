# Decisions, history and maintenance

[Back to the overview](../README.md)

Search is a reader. Import, decision capture, corrections, migration and indexing are writers.
Permission to look something up is not permission to run a maintenance job.

## Record new decisions in the session

Your AI uses `recall_decide` to record clear decisions while working. The CLI equivalent is:

```sh
node /path/to/total_recall/bin/total_recall.js decide --client codex --outcome approved --what "Use a separate search index" --scope "this memory tool" --quote "Use a separate index." --context "separate search index"
```

This is an example, not a real approval. Supply the owner's actual words and exact nearby proposal
text. Missing evidence or more than one matching exchange leaves a record pending. Use `approved`
for the current task; `standing` is for an ongoing rule. Questions, AI proposals and inferred
approval are not owner decisions.

The quote is kept separately from your AI's interpretation. A match establishes wording,
not correctness of interpretation. Inspect the original exchange before relying on it. The
[Claude skill](../skill/SKILL.md) and [Codex skill](../skill/codex/SKILL.md) explain the full contract.

At handoff, collect existing records rather than extracting them again:

```sh
node /path/to/total_recall/bin/total_recall.js decisions --today
```

## Correcting a memory

Only the owner decides that a statement should be struck. `strike ID --reason "..."` marks it
wrong; `strike ID --undo` restores it. Neither deletes the original conversation.

An in-session replacement currently requires a later direct owner message:

```text
Replace decision #123 with: <the new instruction>
```

Your AI quotes that complete message when using `--replaces 123`. Otherwise a suspected
contradiction is a conflict and both records remain visible. Ordinary approvals need no special
wording. `unlink ID` reverses a recorded relation without rewriting either conversation. Do not
run corrections just because a model prefers one reading.

## Keeping history current

`ingest` uses no AI. It reads new or changed configured sources into the local store. Startup
hooks do a short, bounded import: they can leave material waiting and cannot include conversation
that happens afterward. They do not embed anything or replace end-of-day maintenance.

For an approved wrap-up, save the handoff first, then run:

```sh
total_recall ingest
total_recall index --all
total_recall inspect-coverage --json
```

The indexing step applies to projects whose initial full-text build is already approved and
established. For a first build, use `index --dry` to size it and get approval before backfilling.
`index --all` processes pending records, skips unchanged completed ones, and resumes partial
work. A limited run (`--limit N`, default 100) does not necessarily finish the backlog.
Report import warnings and missing/incomplete index records; command success alone is not
proof that all configured history is covered.

Indexing uses the configured embedding service, normally local Ollama with `nomic-embed-text`.
With Voyage selected, routine `index --all` refuses to upload. An approved external run needs
`--allow-remote` and a positive per-run `--max-remote-bytes`. This is an input-volume bound,
not a dollar cap. See [Voyage maintenance and privacy](VOYAGE.md). Do not automatically add
these flags to a routine wrap-up: external incremental uploads need their own approval.
With local Ollama this uses computer time, not an OpenAI/Anthropic API bill. It does not rerun
Sonnet or reinterpret decisions. Legacy `embed` may cover only the first 6,000 characters of a
record and is not a substitute for full-text indexing. See the [retrieval guide](RETRIEVAL.md#full-text-concept-coverage).

## Older conversations and optional distillation

Old conversations are searchable before a model summarizes them. Handoffs and supplied notes
are searchable too. Distillation is an optional way to extract additional decisions from that
backlog, not a requirement for everyday use.

`distill` supports local Ollama or the Anthropic API. Select the owner-decision reader with
`--prompt decisions`. Paid runs need an explicitly selected model, current prices and a spending
cap. Check the CLI help and driver first; do not reuse old README dollar estimates. The legacy
`link` command can also call a model and produces judged links between extracted statements,
not the same explicit-confirmation record as in-session capture. Check those links against the
source. Neither job should run as a side effect of a lookup.

Completed slices are tracked by source/model/prompt identity. Changing a reader prompt or using
`--redo` can send processed material again and incur another charge. Never alter the prompt or
start a second paid driver to “finish” an active batch. Preserve its run records, spending cap,
failed-slice reports and source identities.

Review source-linked results rather than treating them as unquestionable recollections. The
in-session workflow avoids a separate distillation pass for new decisions.

## Upgrades and backups

Stop or coordinate active writers before replacing a live installation. Keep code under review
separate from the running tool. Installing skills, MCP configuration and hooks is distinct from
editing their source files.

`migrate` creates a SQLite-consistent backup before upgrading an older store. Reads do not migrate.
Do not back up an active WAL database by copying only its main `.sqlite` file; committed data may
still be in the WAL. Use SQLite's backup mechanism or the supported migration procedure. Retain
the old code and backup until the upgrade is verified.

The retrieval upgrade uses a derived sidecar, without changing schema-2 source records. Original
messages, identities, speaker labels, decisions, corrections and paid-run records must survive.
A code rollback is not a database restore; restore with all connections closed and a matching
schema version.

## Test without sending private history

`npm test` uses synthetic fixtures and stubbed providers. It needs no GPU or paid API.
`scripts/eval-prompt.js` does call a model. Do not confuse it with the ordinary test suite.
Use an approved SQLite-consistent copy for real-history trials.
