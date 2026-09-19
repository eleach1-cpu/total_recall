# Optional Voyage meaning search

Voyage can provide meaning search for both Claude Code and Codex. They use the same Total
Recall project configuration and index. There is no separate Claude or Codex embedding bill.
Voyage bills its own account. Your usual AI subscription does not include that bill.

## Ask your AI to set it up

You can say: **“Set up Voyage for this project's memory. Show me what will be sent and
estimate the size before uploading my history.”** You do not need to operate the commands below;
they are the implementation reference for your AI or administrator.

1. Create a Voyage account and API key. Store the key securely as `VOYAGE_API_KEY` in the
   environment available to Total Recall's process. Do not put it in chat, source control,
   a handoff or the project JSON. Claude and Codex must both pass it to their Total Recall
   processes. Restart those processes after changing their environment.
2. Keep the current configuration so it can be restored. Enabling Voyage is a separate
   choice from installing this code: it allows meaning-search queries to leave the computer.
3. Set the project's `embed` configuration as below. The default Voyage model is
   `voyage-4-lite`; the model can also be `voyage-4` or `voyage-4-large`. Dimensions may be
   256, 512, 1024 or 2048. Do not change provider/model/dimensions without planning a new index.
4. Run a no-network size check, agree on the upload scope, then explicitly authorize a bounded
   indexing run. Before using real history, test the credentials with synthetic text and confirm
   a few known-answer searches. A mocked test is not a real-service quality or account check.

```json
"embed": {
  "provider": "voyage",
  "model": "voyage-4-lite",
  "dimensions": 1024,
  "allowRemote": true,
  "batch": 32,
  "queryTimeoutMs": 6000
}
```

Keep `allowRemote` false until external processing is approved. A missing key or disabled
remote processing does not silently call Ollama instead. Search reports that its meaning
lane is unavailable and returns word matches. Words-only queries and importing do not call Voyage.

## Indexing and ongoing updates

Example commands for the AI/operator, from the configured project (not a request to run them):

```sh
total_recall index --dry
total_recall index --limit 100 --allow-remote --max-remote-bytes 1000000
total_recall inspect-coverage --json
```

The example permits at most 1,000,000 UTF-8 bytes of passage text in that invocation. **This
is an upload-volume limit, not a token count or a guaranteed dollar cap.** The dry run reports
the bytes for a full rebuild, including passage overlap; it does not subtract already-indexed
records. Actual successful runs report requests, submitted bytes and Voyage-reported tokens.
Check the Voyage account for billing, including requests with uncertain outcomes.

For an approved full backfill, use `--all` instead of `--limit 100`, with an explicitly chosen
byte limit. Limits restart with each invocation. Repeated invocations are not a shared account
budget. The tool does not automatically retry failed or rate-limited requests; it reports that
the failed request may have been billed. Resume only after checking the failure. Completed
chunks are reused; an uncommitted failed batch may need to be sent again.

The usual `index --all` maintenance command **refuses external uploads** without `--allow-remote`
and a positive `--max-remote-bytes` for that run. Approve external incremental maintenance
separately; otherwise new conversations remain searchable by words and dates but lack updated
Voyage meaning coverage. Startup imports do not upload or embed. The older `embed` command
and distill's legacy auto-embedding cannot upload to Voyage.

## Check search quality before switching

**Do not assume Ollama's similarity cutoff works for Voyage.** `search.minSim` defaults to
0.62. It removes meaning matches below that score; this is not a 62% probability of correctness.
Different models use different score ranges.

In our September 19, 2026 comparison, the same 45,689 complete records were searched with
six real history questions. With the cutoff disabled for the diagnostic, Voyage found useful
matches. Applying the existing 0.62 cutoff would have returned no meaning hits for four of
those six questions. Word matches can still appear in hybrid search, hiding this problem.
Ollama and Voyage each had strengths; the small trial did not establish an overall Voyage advantage.

Ask your AI to compare known-answer questions before activating Voyage:

1. Keep the current provider and its configuration available for rollback. Build Voyage's
   separate index first; changing providers does not convert existing vectors.
2. In a temporary comparison configuration, use `search.minSim: -1` to inspect rankings without
   rejecting low scores. **This is diagnostic only**, not a recommended production setting:
   it admits unrelated results too. Use meaning-only search to isolate the embedding results.
3. Check the retrieved original passages, not just whether any result appeared. Include
   paraphrases, exact terms and unrelated questions with no expected answer. Then set a
   provider-appropriate `search.minSim` based on those results and check normal hybrid search.
4. Restore the prior cutoff when switching back to Ollama. There is no validated universal
   Voyage cutoff supplied by this release; a lower threshold cannot repair bad rankings.

An index with full coverage and a successful API connection does not by itself establish
good recall. Until these checks work for your project, keep your existing provider active.

## Privacy, costs and switching back

- Passage text and search queries go to `https://api.voyageai.com/v1/embeddings`. Treat history
  as potentially sensitive even after credential scrubbing. Review Voyage's account terms
  and data handling before activation. The tool does not upload the SQLite database itself.
- It uses the standard embeddings endpoint, not Batch, Files, reranking or a chat model.
  No local GPU or Ollama installation is required for Voyage.
- Standard rates checked September 19, 2026: `voyage-4-lite` $0.02, `voyage-4` $0.06,
  `voyage-4-large` $0.12 per million input tokens, before any account allowances. Query
  embeddings also count. Confirm [current pricing](https://docs.voyageai.com/docs/pricing).
- The original database is read-only during indexing. The existing local index is untouched.
  Voyage gets a sidecar whose name includes its provider/model/dimension fingerprint, appended
  to the normal index path, even if `search.index` is customized. Coverage reports the exact path.
- Restore the previous `embed` configuration to use Ollama and its existing index again.
  No original conversations or decisions need to be re-imported. Conversations added since
  the last local build need local incremental indexing. Keeping two indexes consumes extra disk.
- The existing similarity cutoff is not proof of Voyage search quality. Test known queries
  against your own history before relying on it; adjust `search.minSim` only with that evidence.

API contract: [Voyage text embeddings](https://docs.voyageai.com/reference/embeddings-api).
