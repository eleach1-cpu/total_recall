# Total Recall

**Give your AI memory from one session to the next.**

Total Recall is a session-to-session memory tool for **OpenAI's Codex and Anthropic's
Claude Code**. It keeps your project's past conversations, research, decisions and lessons
available so your AI can find that context and use it when the work comes up again,
days, weeks or months later.

You should not have to explain the same project three times, watch your AI repeat a failed
approach, or send it searching for a source it already found with you last month.

**The point is continuity: your next session can build on what you and your AI already learned.**

[Get started](docs/SETUP.md) · [Using Recall](docs/RETRIEVAL.md) · [Codex integration](docs/CODEX.md)

> **Early access (v0.1.0):** includes Recall and the expanded search, date, project and source-reading
> tools, tested against imported conversation history. Existing users should update their local
> checkout, installed skills and MCP configuration, then reconnect their AI client.

## “Go update the MOS Lookup Tool to add more MOS IDs.”

That sounds like a new task. But suppose you and your AI have worked on it in three earlier
sessions. You found a useful source, discovered a problem with its data, tried an approach that
failed, and agreed on a better one.

A new session may see the current code and instructions in files such as `CLAUDE.md` or
`AGENTS.md`. Those files help, but they are not the whole conversation. Unless someone preserved
the details, your AI may have no idea **why** you chose that source or **what went wrong** before.
You end up paying for the same learning again, in time, repeated explanations and model usage.

**With Total Recall connected, recalling that history becomes part of starting the work:**

1. You ask for the MOS Lookup Tool update in a new session.
2. Your AI searches this project's earlier work on the tool before making changes.
3. It reads the relevant exchanges: useful sources, rejected approaches, gotchas and your decisions.
4. It continues with that context, checking what still applies instead of starting the research over.

You do not have to remember which session held the answer or explicitly say “search your memory”
every time. The connected skill directs your AI to look back when you name a feature or file,
before editing. Supported hooks can reinforce that with a search-before-edit checkpoint.

![Earlier sessions supply sources, mistakes, fixes and decisions to Total Recall. In a new session, your request to add more MOS IDs prompts your AI to search and read that history before continuing with the lessons learned.](docs/assets/my-long-term-memory.svg)

*Example: returning to a project task in a new session.*

## What that memory is for

- **Keep the lessons.** Recover what worked, what failed and the reason for a decision.
- **Reuse the research.** Find the sources and resources already discussed, then check whether
  they are still suitable.
- **Stop making you repeat yourself.** Bring your preferences, corrections and project context
  into the next session.
- **Save time and potentially tokens.** Avoid repeated explanations, research and dead ends.
  Recall has its own overhead, so savings vary by task.

It works with **Codex alone, Claude Code alone, or both**. If you use both, they can draw on
the same project history. That is an extra benefit, not the reason you need it.

## How your AI gets that memory

Total Recall imports your saved local conversations and project notes into a searchable record.
The history remains available after a session ends. In a later session, your AI uses Total Recall
to find and read the relevant parts, bringing them into its current working context.

That is external long-term memory. It does not retrain the model or squeeze every old session
into each new one. It retrieves the context the current task needs.

Your Markdown notes still matter. Total Recall makes them searchable **alongside the conversations
behind them**, rather than relying on a short handoff to capture every detail. Dates, projects,
sessions and speakers stay attached to the words.

Search can use names and phrases, dates and project filters, or optional **meaning search** to
find related ideas even when you describe them differently. Your AI reads the original exchanges
and reasons from them; a matching search result is only the starting point.

## You can ask it directly, too

Memory is useful during ordinary work, not just for history questions. But when you want to
look something up, ask your AI naturally:

> “Which source did we use for the MOS codes last time, and why?”
>
> “We tried this before. What went wrong?”
>
> “What is still open, and where did we leave off?”
>
> “We talked about something similar last month. Can you find it?”
>
> “What was the first thing I said in this project?”

Your AI chooses the project, dates and search approach. You do not need to know a record ID,
a database query or a special set of keywords. If “that project” is ambiguous, your AI should
resolve it with you, not guess.

![You ask about an earlier discussion. Total Recall finds relevant sessions and opens the actual exchanges. Your AI compares the reasons, decisions and later changes, then answers with sources and explains any gaps.](docs/assets/session-search-and-reasoning.svg)

*Session search and reasoning: find the conversation, read it in context, then explain what it means.*

## Four ways to use it

| Operation | What it does | Example |
|---|---|---|
| **Recall** | Gathers and reads past context for work or a question. | “What should we remember before updating this?” |
| **Find** | Locates records by words, meaning, dates or filters. | “Find what I told Codex in August.” |
| **Read** | Opens an original message, its surrounding exchange or a session. | “Show me what I was answering.” |
| **Inspect Coverage** | Shows which projects, sessions and history are available. | “How far back does this record go?” |

Dates work without a keyword. Projects and speakers are separate filters. Long records and
result lists have continuation, so the answer does not have to end at a short excerpt.

The [retrieval guide](docs/RETRIEVAL.md) covers direct commands, earliest/latest queries,
phrases, wildcards, project aliases and continuation.

## Remember decisions while they happen

With decision capture connected, new decisions become part of that memory as you work.

When you clearly approve, reject or change something, your AI will record the decision
with your exact words and the proposal you were answering. New work does not require a separate
model to re-read the entire session afterward.

**The original conversation remains the authority. Neither AI gets to silently rewrite your history.**

An ambiguous “go” stays pending if the tool cannot identify one matching exchange. A question
is not an approval. A summary is not proof that you agreed. A matching quote proves the words
were present, not that your AI understood them correctly.

Earlier decisions are not erased because a later one sounds similar. In-session replacements
need explicit owner confirmation; unresolved conflicts stay visible. Older model-generated links
still need checking against the conversation. Only the owner can strike a recorded decision as
wrong. See [decision capture and maintenance](docs/MAINTENANCE.md).

## Start small

You need **Node.js 22.13 or newer**, saved local conversations and a project configuration.
The tool has **no npm dependencies**. You can begin with word and date searches; a model is
not required to import or read the record.

1. Get the tool and tell it where this project’s conversations are saved.
2. Import the history you want available.
3. Connect Claude Code, Codex or both, and try a question you already know the answer to.
4. Add meaning search if it helps. Backlog distillation is optional, not a setup requirement.

The [setup guide](docs/SETUP.md) walks through this. Hooks can also provide a brief at session
start and require a search before editing. They are a reminder to look, not proof that the
AI read carefully, and they only work in a client that actually runs them. Importing new sessions
keeps the memory current; it cannot recall conversations that have not reached the store yet.

## Does maintenance use AI?

- **`ingest`: no AI.** Reads new or changed conversation files and project notes into the local
  database. Their words and dates become searchable without a model.
- **`embed`: uses AI for meaning search.** Builds the older search index, which may cover only
  the first 6,000 characters of each record.
- **`index`: uses AI for full-text meaning search.** Splits long records into overlapping passages
  so the index can cover the whole text. Later runs skip unchanged, completed records.

By default both embedding commands use Ollama, normally running on your own computer
with `nomic-embed-text`. **With local Ollama, these jobs keep the processing local and incur no
OpenAI or Anthropic API bill.** Embedding uses your computer's processing power; it does not rerun
the Sonnet backlog pass, interpret new decisions or rewrite your conversation history.

For local setup, install [Ollama](https://ollama.com/download), download the model with
`ollama pull nomic-embed-text`, and keep Ollama running. The model download is about 274 MB;
that is not its total running-memory requirement. A supported GPU helps, but CPU/system-RAM
operation is possible. See [local setup and hardware checks](docs/SETUP.md#local-ollama-installation-and-hardware)
for configuration, a connection check and how to tell where the model actually loaded.

**No local embedding model or GPU? You can use Voyage instead.** Both Claude Code and Codex
use the same project setting and local memory database. Voyage processes the text you send
and returns the vectors used for meaning search. It needs a separate Voyage account and API
key, not a ChatGPT or Claude subscription. Your imported conversation database stays local,
but indexed passages and meaning-search queries go to Voyage.

Voyage is optional and off by default. The default Voyage model is `voyage-4-lite` with
1,024 dimensions; `voyage-4` and `voyage-4-large` are also supported. As checked September 19,
2026, their standard rates are $0.02, $0.06 and $0.12 per million input tokens respectively,
before account allowances. [Current Voyage pricing](https://docs.voyageai.com/docs/pricing).
No local GPU or downloaded AI model is required for Voyage; Node, an internet connection and
disk space for the local index are still needed. This is not a promise that one model finds
your history better than another; try questions with known answers before switching.

Without either embedding option, you keep word/phrase/wildcard searches, dates, projects,
speakers, original conversations, decisions and session briefs. What you lose is the
**meaning-based search lane**, which can find related wording without the same keywords.

[Voyage setup and activation](docs/VOYAGE.md) explains credentials, privacy, bounded indexing
and switching back. Local and Voyage indexes are separate. Installing support does not
activate Voyage or upload existing history. Legacy `embed` remains local-only; Voyage uses
the full-text `index` command.

**When switching to Voyage, check the relevance cutoff too.** Our six-question paired trial
found useful Voyage results that the existing Ollama cutoff would discard. The trial was mixed,
not evidence that Voyage is universally better. Keep the working provider until known-answer
searches succeed. [Voyage cutoff guidance](docs/VOYAGE.md#check-search-quality-before-switching).

The session-start import has a short time limit and cannot include conversation that happens
after it runs. It does **not** embed or build the full-text index. Save the handoff before the
end-of-day import; new or changed records also need indexing to keep full-text meaning search
current. **Installing the code does not build that index.** See [maintenance](docs/MAINTENANCE.md).

## Your history stays yours

The database is local by default. Words-only searches, date-only queries and source reads do not call an
AI provider. Optional meaning search uses the configured embedding service, normally local Ollama.
An optional Anthropic backlog run sends the selected conversation text to that API and incurs
its charges. It must be chosen separately.

There is another important boundary: **when your AI receives recalled text, that text
enters its current conversation context** and is subject to its provider's handling.
“Local database” does not mean “nothing ever reaches a model.”

Known credential patterns are scrubbed, and tool outputs are excluded. Scrubbing is not a
guarantee that all sensitive information is removed. Keep the database, backups and any exported
recall results out of public repositories.

## What it cannot promise

- **History that was never imported.** This reads configured local Claude Code and Codex records,
  not every conversation in your ChatGPT or Claude account. “Earliest found” is not automatically
  “the first thing you ever said.”
- **Perfect interpretation.** Extracted decisions and semantic matches can be wrong. The original
  exchange, provenance and coverage warnings matter.
- **Unlimited context in one answer.** Recall uses a bounded evidence packet. More text remains
  available through Read and Find; your AI must follow those links when needed.
- **Guaranteed recall or obedience.** Your AI still has to use the tools and understand what it
  reads. An edit gate can require a search, not guarantee that every lesson is found. Old approval
  is history, not fresh permission to spend, publish or deploy.

## For contributors

This is an early-access release. Keep backups of your local memory database and review
updates before applying them. Please use synthetic examples in bug reports, not your real
conversations, credentials or database. For sensitive findings, see the [security policy](SECURITY.md).

Run `npm test` from this repository. The tests use synthetic records and stubbed providers;
they do not require a GPU or paid API. Prompt evaluations are separate model-calling jobs.

The CLI and MCP tools share the retrieval code in [`lib/recall.js`](lib/recall.js).
Decision capture lives in [`lib/decide.js`](lib/decide.js). Preserve original messages, source
identities and owner corrections when changing either.

[Setup](docs/SETUP.md) · [Retrieval reference](docs/RETRIEVAL.md) ·
[Decision capture & maintenance](docs/MAINTENANCE.md) · [Codex details](docs/CODEX.md) ·
[MIT license](LICENSE)
