# total_recall and Codex

Give Codex project memory it can use across sessions. Total Recall reads the conversation files
Codex already writes (`~/.codex/sessions` and `~/.codex/archived_sessions`) so your AI can recover
earlier research, decisions and lessons before continuing the work. Claude Code's history can be
included too; using both tools is optional. Speakers stay labelled (`owner`, `claude`, `codex`).

Importing local Codex files requires no OpenAI API key and uploads nothing. Optional distillation
uses `distill.provider` (local Ollama by default). Recalled text enters your AI's conversation context;
optional paid distillation also sends selected text to its configured provider.

Every path and id below is an example.

## 1. Tell the project where Codex's files are

In `total_recall.json`, replace `transcripts` with a list, and say what this project is:

```json
{
  "project": "demo-project",
  "projectRepos": ["https://example.test/acme/demo-project.git"],
  "transcriptSources": [
    { "client": "claude", "path": "C:/Users/example/.claude/projects/demo-project" },
    { "client": "codex",  "path": "C:/Users/example/.codex/sessions" },
    { "client": "codex",  "path": "C:/Users/example/.codex/archived_sessions" }
  ],
  "sources": { "handoff": ["notes/CLAUDE-SESSION-HANDOFF-*.md", "notes/CODEX-SESSION-HANDOFF-*.md"] }
}
```

Codex keeps EVERY project's conversations in those two folders. A conversation is taken only when
what it recorded about itself says it is this project: its working directory is the project folder
(or inside it, or a live git worktree of it), or its git remote is listed in `projectRepos`, or
the folder is listed in `historicalRoots`, or its thread id is in `includeSessions`. A conversation
in another folder that merely talks about this project is not taken. One whose worktree folder is
gone and that recorded no git remote is reported as `unresolved` and skipped, never guessed.

Do not point the `memory` source at Codex's generated memories: a `feedback` memory file becomes
an owner standing rule, and a machine-written summary is not something the owner said.

For an existing older store, run the explicit `total_recall migrate` step (it takes a backup
first) before `total_recall ingest`. A new project can begin with `ingest`.
The first ingest of a large archive takes minutes and says what it saw:

```
codex: 40 files found, 9 in this project (25 subagent files skipped, 5 from other projects, 1 unresolved)
codex: 1200 messages read, 0 already present, 1204 event copies and 60 agent-to-agent messages skipped, 31 app-injected blocks removed (4 user messages were nothing else)
codex: 3 oversized records skipped
codex: unresolved rollout-2026-01-05T09-00-00-0199aaaa.jsonl: worktree removed, no git remote recorded
```

## 2. What is read, and what never is

Read, from `response_item` records of type `message`: what the owner typed (`input_text`) and what
Codex answered (`output_text`), in the phases `final_answer` and `commentary` and in older records
with no phase. Each keeps its original time, its record ordinal, its message id and the byte where
it was read.

The app often puts its own material in FRONT of the owner's words, inside the same text block: a
`<in-app-browser-context>` element and then the question, or `# Files mentioned by the user` with
the attachment list and then `## My request for Codex:` and the request. Only the wrapper is
removed. The request is kept, as the owner's own words; the attachment list, the page address and
the page title are not his words and are not kept.

Submitted choice-button replies (`<send_user_message_question_reply>`) are read too.
Each answer is an owner turn; its question is a separate, labelled app-context reference,
never owner evidence. Each pair keeps the source message's date and location. Unselected
options and widget IDs are not approvals. Unrecognised reply payloads produce a warning.

When updating from the old parser, a normal incremental ingest does not revisit old file
offsets. After a consistent backup, run `ingest --all` on the intended project to recover
previously discarded answers. No model or embedding job is involved. Existing source IDs
remain intact; recovered answers get their original timestamps, not the import time.
Pending and unverified decision records are checked again against original evidence. They
become active only when one matching exchange is found; no later workaround is backdated.

Never stored as something someone said: system and developer messages, base instructions, app
context the client inserts into a user message (`<environment_context>`, `<recommended_plugins>`,
browser context, the AGENTS.md block, the mentioned-files list), reasoning and encrypted content, compaction
records (they are encrypted in this format), tool calls, tool output, command output, world state,
token counts, agent-to-agent messages, images and other binary (an image leaves the marker
`[image]`). The event stream's second copy of each message is skipped as a duplicate. Which files
an edit touched is kept, from the structured `FileChange` record only, as a tool-only row for
`--files`. Subagent threads are skipped whole, like Claude's sidechains. Secrets are scrubbed
before anything is stored.

Kept searchable but NEVER turned into a decision (`origin: reference`, printed as
`[owner, reference]` or `[codex, reference]`): an AI message in a phase this parser has not
seen; history a fork inherited when the parent thread's own file is not available; and the OPENING
prompt of a thread an agent created (`thread_source: agent_created_thread`), because nobody can
show the owner typed it. That is one message: the conversation is kept, and everything the owner
says after the opening is his and counts as his.

Lineage, as the format is understood today (desktop 0.146 to 0.154; it is not a published
interface, so anything unrecognised is counted and reported, and a pass that reads eligible files
and recognises no message at all ends with a WARNING and a non-zero exit):

- A file's FIRST `session_meta` is its identity. A later one inside the file (a child replays its
  parent's header) never changes whose file it is.
- A thread continued in a second file (`rollout-<time>-<thread>_<segment>.jsonl`) names, in
  `history_base`, the byte where its first file stops counting. What the first file holds past
  that byte was replaced by the owner's own edit and is retired. If the first file is not
  available the conversation is marked incomplete, and an `--oldest` search says the earliest hit
  may not be the first discussion.
- A message's own id is its identity. The same message in an archived copy, a continuation file or
  a fork's replay is one row (where else it was seen is noted). Two real messages that both say
  "approved" are two rows.
- A rollout that moves from `sessions` to `archived_sessions` keeps its checkpoint; nothing is read again.

Limits worth knowing: a document the owner PASTES into a message is part of that message, exactly
as with Claude; nothing structural marks it as a quotation. A conversation's session key is
`codex:<thread id>`; Claude's stay bare, as they always were.

## 3. Search, from either AI

```
total_recall search "ledger export" --client codex            only Codex conversations
total_recall search "ledger export" --client codex --who owner   what I told Codex
total_recall search "ledger export" --who assistant           what either AI said
total_recall search "x" --session codex:01aa0000              one conversation (or claude:<id>)
```

`--client` leaves file notes (handoffs, memory, maps) out, because no client wrote them. Every hit
prints its date, speaker, `#id` and Read handle. `--deep` supplies additional source/context handles;
`read` opens the text and its provenance. Source and meaning results obey the same candidate filters.

## 4. Give Codex the tools (MCP)

Project scope, in the repository's `.codex/config.toml` (Codex asks you to trust the project):

```toml
[mcp_servers.total_recall]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\tools\total_recall\bin\total_recall.js', 'mcp', '--client', 'codex', '--root', 'C:\work\demo-project']
enabled_tools = ['recall_recall', 'recall_search', 'recall_read', 'recall_inventory', 'recall_brief', 'recall_decide']
```

Do not put a server pinned to one project's `--root` in the USER-level config: every other project
would silently search this one's history.

## 5. Brief at start, search before the first edit (hooks)

`.codex/hooks.json` in the repository (template: `hooks/codex-hooks.snippet.json`). One command
handles all three events; Codex hands it the real session id on stdin.

### Windows: use the actual hook shell

The Windows command in the snippet is **PowerShell syntax**. Replace both absolute paths
with the installed Node executable and Total Recall entry point. `commandWindows` selects
Windows command text; it does not mean "run this in Command Prompt."

For a PowerShell session, a custom memory home can be set like this (JSON string value):

```json
"commandWindows": "$env:TOTAL_RECALL_HOME = 'C:/work/demo-project/.recall'; & 'C:/Program Files/nodejs/node.exe' 'C:/tools/total_recall/bin/total_recall.js' codex-hook; exit $LASTEXITCODE"
```

Use that same home for MCP and all three hooks, or they will look for different stores/gates.
Omit the assignment if using the normal default home. Keep the paths single-quoted; a literal
apostrophe inside a PowerShell path must be doubled. Do not use `set "NAME=value" && ...`
in PowerShell: that is cmd.exe syntax and can fail before Node starts. If the actual hook
shell is cmd.exe, use a cmd-compatible command instead; do not paste the PowerShell snippet.
Do not change the user's shell just to make a mismatched command work.

Review the command in the hook's real shell with synthetic stdin, checking both stdout and
stderr. Then review/trust the changed hook definitions in Settings > Hooks; changing their
commands changes their trust hashes. Never edit trust records or gate markers to manufacture
a pass. Finally use a fresh task and an owner-authorized disposable file: a pre-search edit
must be denied, then a successful project-scoped search must allow it. A direct handler test
does not prove the desktop invoked the hook. Check the startup brief/import there too.

This shell mismatch was reproduced during a Windows laptop install on September 19, 2026.
See the [official hook documentation](https://learn.chatgpt.com/docs/hooks).

### Events and trust

| Event | What happens |
|---|---|
| `SessionStart` `startup\|resume\|clear` | arm this task's gate, ingest what is new for at most 2 seconds, print the brief (it enters as developer context, and opens by saying it is a dated record, not a request) |
| `SessionStart` `compact` | print the brief again; a gate this task already opened stays open |
| `PreToolUse` `apply_patch` | return a structured deny with the reason until this task has searched |
| `PreToolUse` `Bash` | the same, only for a command that writes into the project; reading is never gated |
| `PostToolUse` `mcp__total_recall__recall_search` or `mcp__total_recall__recall_recall` | successful Find or Recall (zero hits counts; an error, a refused date, another project do not) opens this task's gate |

The gate is a workflow checkpoint, not a security boundary and not permission to do anything. It
cannot know your AI understood what it read, and it does not see every way a shell can
write. It is keyed by project, client and session: task A cannot open task B, and Claude's search
cannot open Codex's gate. Hooks must be reviewed and trusted before they run: in the desktop app,
use **Settings > Hooks** and **Trust** each Total Recall entry; the CLI uses `/hooks`.
Project trust alone is not hook trust. The structured denial is important: a live desktop test
allowed an edit after an exit-code-only refusal, but blocked the same edit with the explicit
`hookSpecificOutput.permissionDecision: "deny"` response.

On a build without hooks,
the honest fallback is the skill's instruction to search first, plus
`total_recall search "<topic>" --as codex --caller <session id>` to record it by hand.

When upgrading, the new `recall_recall` tool needs both the MCP allowlist and the PostToolUse
matcher in the development snippet. Do not install either without owner approval. Fixture hook
tests are not evidence that a particular desktop build invokes them.

## 6. The skill

`skill/codex/SKILL.md`, installed to `~/.agents/skills/total_recall/SKILL.md` (user scope) or
`<repo>/.agents/skills/total_recall/SKILL.md`. One scope only: two skills of one name collide.
