# Set up Total Recall

[Back to the overview](../README.md)

This guide describes the current version, including the Recall operation. Installing it,
importing private history and enabling hooks are deliberate steps. An existing installation
can stay untouched while you review the code.

## 1. Get the tool

Use Node.js 22.13 or newer. Clone the repository you have access to, or use your existing checkout.
Replace `YOUR_REPOSITORY_URL` with the clone address from the repository's **Code** button:

```sh
git clone YOUR_REPOSITORY_URL total_recall
cd total_recall
node bin/total_recall.js --help
```

Existing installations do not update automatically. Update your checkout, installed skills and
MCP configuration together. No `npm install` or global package install is needed.

Here, `/path/to/total_recall` means the tool checkout; `/path/to/project` means the project whose
history you want to remember. On Windows, substitute your actual `C:/...` paths.

## 2. Configure a project

Create `total_recall.json` in the project's root. Use actual paths, not these placeholders.
You may include Claude Code, Codex or both:

```json
{
  "project": "my-project",
  "projectAliases": ["My Project"],
  "timezone": "America/New_York",
  "transcriptSources": [
    { "client": "claude", "path": "C:/Users/example/.claude/projects/ACTUAL-PROJECT-FOLDER" },
    { "client": "codex", "path": "C:/Users/example/.codex/sessions" },
    { "client": "codex", "path": "C:/Users/example/.codex/archived_sessions" }
  ],
  "sources": {
    "handoff": ["notes/CLAUDE-SESSION-HANDOFF-*.md", "notes/CODEX-SESSION-HANDOFF-*.md"],
    "changelog": "CHANGELOG.md"
  }
}
```

Remove unused sources. Claude's source must be the actual transcript folder for this project,
not the directory containing every project. Codex shares its session directories across projects;
Total Recall uses recorded working-directory/repository information to decide membership, not
words inside the conversation. Unresolved membership is reported rather than guessed.

For old worktrees and explicit bindings, see [Codex source binding](CODEX.md#1-tell-the-project-where-codexs-files-are).
For named project selection, see [project registration](RETRIEVAL.md#project-registration).
The older `"transcripts": "..."` shorthand still works for one Claude folder. Do not combine it
with `transcriptSources`.

The default store is `~/.total_recall/<project>.sqlite`. A `store` path overrides it. Relative
paths resolve from the config folder. Linked Git worktrees use the main checkout's config.
Keep private configs and stores out of public commits.

## 3. Import and check

Run from the configured project, or pass `--root` explicitly:

```sh
node /path/to/total_recall/bin/total_recall.js ingest --root /path/to/project --all
node /path/to/total_recall/bin/total_recall.js inspect-coverage --root /path/to/project
node /path/to/total_recall/bin/total_recall.js find --root /path/to/project --who owner --oldest --limit 1 --words
```

Importing writes the local store. The first pass may take time; later passes use recorded
checkpoints. Reads never create or migrate a database. If an older store needs migration, see
[maintenance](MAINTENANCE.md#upgrades-and-backups) first.

Try a question you know the answer to. Open the record and check its project, speaker and date.
A successful import is not proof that every account conversation is available.

## 4. Connect your AI

### Claude Code

Copy [`skill/SKILL.md`](../skill/SKILL.md) into your Claude skill directory as
`total_recall/SKILL.md`. Merge this server entry into the project's `.mcp.json`, preserving
other entries and replacing both paths:

```json
{
  "mcpServers": {
    "total_recall": {
      "command": "node",
      "args": ["C:/tools/total_recall/bin/total_recall.js", "mcp", "--root", "C:/work/my-project"]
    }
  }
}
```

### Codex

Use the [Codex integration guide](CODEX.md#4-give-codex-the-tools-mcp) for the project-scoped MCP
entry, tool allowlist and Codex skill. The development allowlist includes `recall_recall`.
Do not pin one project's server in a user-wide config that other projects would inherit.

After connecting or restarting your client, check that it can list and call Recall, Find, Read
and Inventory. The CLI is also usable without MCP.

### Optional hooks

Hooks add a startup brief and search-before-edit checkpoint. They are not required to query
history manually. Review and merge the appropriate template; do not replace an existing config:

- [Claude hook entries](../hooks/settings.snippet.json) for `.claude/settings.json`.
- [Codex hook entries](../hooks/codex-hooks.snippet.json), explained in [Codex hooks](CODEX.md#5-brief-at-start-search-before-the-first-edit-hooks).

Use absolute tool paths. Startup performs a bounded import and prints a brief; it does not run a
distillation model. The gate is keyed to the real calling project/client/session. A lookup for
another project does not unlock this one. Verify hook execution on your client; a template file
alone does not prove it runs. To disable it, remove only the entries you added. Stored history
is not deleted.

The Claude template re-arms the gate on every message you send (`UserPromptSubmit` runs
`gate --arm`), so each new request needs its own search before the first edit. Without that
entry, one search at session start leaves the gate open for the rest of the session.

What the gate does not cover:

- The command inside an `ssh` or `docker exec` string is not read. The whole call is treated as
  a write, whether or not it changes anything.
- File changes made through an MCP filesystem tool are not gated at all.

## 5. Optional meaning search

You can stop at words and dates. For an external service shared by Claude and Codex, see
[Voyage setup](VOYAGE.md). It needs explicit activation and a separate API key, but no local GPU.

### Local Ollama installation and hardware

You can ask your AI: **“Set up local meaning search with Ollama, check that my computer can
run it, and show me the index size before building it.”** These commands are for your AI or
administrator; everyday recall still uses plain-English requests.

1. Install the current [Ollama release](https://ollama.com/download) for your operating system.
   Start the desktop app, or the Ollama service on Linux. If no service is running, `ollama serve`
   starts one; do not start a second server if the app already owns port 11434.
2. Download the local embedding model:

   ```sh
   ollama pull nomic-embed-text
   ```

3. Keep the existing project settings and set these fields in `total_recall.json`:

   ```json
   "ollama": { "url": "http://localhost:11434" },
   "embed": { "provider": "ollama", "model": "nomic-embed-text", "batch": 32, "queryTimeoutMs": 6000 }
   ```

   The embedding model is separate from the larger optional decision-distillation model.
   You do not need `qwen3:14b`, Sonnet or a chat-model download just to embed.
4. From the tool checkout, check the connection using made-up text (no history upload):

   ```sh
   node -e "const c={ollama:{url:'http://localhost:11434'},embed:{model:'nomic-embed-text'}};require('./lib/recall-meaning').encoder(c,{},30000).then(e=>e.embed(['A gardener waters vegetables.'],'search_document')).then(v=>console.log('Embedding received:',v[0].length,'dimensions')).catch(e=>{console.error(e.message);process.exitCode=1})"
   ollama ps
   ```

**Memory and graphics requirements:** the [model download](https://ollama.com/library/nomic-embed-text)
is about 274 MB, not a promise that 274 MB of free graphics memory is enough. Runtime buffers,
context length, batch size and other loaded models also use memory. On our tested installation,
`ollama ps` reported **323 MB, 100% GPU, context 2048** on September 19, 2026. That is one
measurement, not a tested minimum for every graphics card or workload.

There is no dedicated-GPU requirement for CPU operation. System RAM must still accommodate
Ollama, the model, the search process and the operating system. We have not established a
universal minimum RAM amount or a fixed VRAM point where every machine falls back to RAM.
Try a small build on your existing hardware before buying a GPU.

Check [supported GPUs and drivers](https://docs.ollama.com/gpu). After the connection test,
`ollama ps` shows **100% GPU** for fully GPU-loaded, **100% CPU** for system-memory loaded, or
a CPU/GPU split. This is how to check actual placement rather than guess from card capacity.
CPU execution is generally slower; a cold load or CPU-only query may need a larger
`embed.queryTimeoutMs`. Reduce `embed.batch` if indexing runs out of memory. System-memory
paging to disk is a separate slowdown, not the same thing as CPU offload.
[Ollama's memory-placement explanation](https://docs.ollama.com/faq#how-can-i-tell-if-my-model-was-loaded-onto-the-gpu).

Allow disk space for Ollama itself, downloaded models, your conversation database and its
derived index. After installation/download, local embeddings need no external API or API key.
Keep the service on localhost unless you intentionally configure a trusted remote server.

### Build and refresh the local index

Keep Ollama running. Creating the index uses local compute:

```sh
node /path/to/total_recall/bin/total_recall.js index --root /path/to/project --dry
node /path/to/total_recall/bin/total_recall.js index --root /path/to/project --limit 100
node /path/to/total_recall/bin/total_recall.js index --root /path/to/project --all
```

The dry run reports the job size without a model call or file write. `--limit 100` is only a sample,
not a complete build. After approval, `--all` finishes the pending backlog and also serves as the
later incremental refresh: unchanged completed records are skipped. The job writes a derived
sidecar, can resume after interruption, and does not rewrite the original record. Read
[full-text concept coverage](RETRIEVAL.md#full-text-concept-coverage) before a large indexing job.
An unavailable embedding service produces an explicit words-only fallback. `--words` skips it.

## Where to change settings

Use the smallest config you need. Current defaults are in [`lib/config.js`](../lib/config.js).
The retrieval guide covers project aliases/registration, dates, the sidecar and query timeout.
[Codex details](CODEX.md) explain source binding and parser limits. [Maintenance](MAINTENANCE.md)
covers decisions, backups and optional model jobs.
