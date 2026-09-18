'use strict';
const { loadConfig, noConfigMessage } = require('./config');
const { openStore } = require('./store');

// The distilled tier by default: a few thousand rows, seconds to embed. `--kind all` adds the
// spoken turns (tool-only turns are never embedded: their body is a file path).
const EMBED_KINDS = ['statement', 'handoff', 'memory', 'compact_summary', 'map_section', 'changelog'];
const MAX_CHARS = 6000;

const embedModel = (cfg) => (cfg.embed && cfg.embed.model) || 'nomic-embed-text';

// nomic-embed-text is trained with task prefixes; a query and a document embedded without them
// land in slightly different spaces and the similarity sags.
async function embedTexts(cfg, texts, prefix, timeoutMs) {
  const res = await fetch(`${cfg.ollama.url.replace(/\/$/, '')}/api/embed`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // keep_alive: the model is 274 MB; leaving it loaded turns a 3 s cold query into a 40 ms one.
    body: JSON.stringify({ model: embedModel(cfg), input: texts.map((t) => `${prefix}: ${String(t).slice(0, MAX_CHARS)}`), truncate: true, keep_alive: '30m' }),
    signal: AbortSignal.timeout(timeoutMs || 120000),
  });
  if (!res.ok) throw new Error(`ollama answered ${res.status} for ${embedModel(cfg)}`);
  const j = await res.json();
  if (!j || !Array.isArray(j.embeddings) || j.embeddings.length !== texts.length) throw new Error('ollama returned no embeddings');
  return j.embeddings;
}

// The query vector; null when the store has no vectors to compare it with (nothing to say about
// that). Throws when Ollama does not answer in time: the caller searches on words and SAYS so,
// because a silent fallback looks exactly like "nothing else was relevant".
async function queryVector(cfg, store, query) {
  if (!store.vectorCount(embedModel(cfg))) return null;
  const e = await embedTexts(cfg, [query], 'search_query', (cfg.embed && cfg.embed.queryTimeoutMs) || 6000);
  return Float32Array.from(normalize(e[0]));
}

function normalize(arr) {
  let n = 0; for (const x of arr) n += x * x;
  n = Math.sqrt(n) || 1;
  return arr.map((x) => x / n);
}

async function run(cfg, opts, store) {
  const own = !store;
  const s = store || openStore(cfg.store);
  const t0 = Date.now();
  try {
    const kinds = opts && opts.kinds && opts.kinds.length ? opts.kinds : EMBED_KINDS;
    const todo = s.docsMissingVectors(kinds, embedModel(cfg), true);
    const batch = (cfg.embed && cfg.embed.batch) || 32;
    let done = 0;
    for (let i = 0; i < todo.length; i += batch) {
      const slice = todo.slice(i, i + batch);
      const vecs = await embedTexts(cfg, slice.map((d) => (d.body.startsWith(d.title) ? d.body : `${d.title}\n${d.body}`)), 'search_document');
      slice.forEach((d, k) => s.putVector(d.id, embedModel(cfg), vecs[k]));
      done += slice.length;
      if (opts && opts.onProgress) opts.onProgress(done, todo.length);
    }
    return { embedded: done, total: s.vectorCount(embedModel(cfg)), model: embedModel(cfg), seconds: (Date.now() - t0) / 1000 };
  } finally { if (own) s.close(); }
}

async function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const k = args.flags.kind;
  const kinds = k === 'all' ? [...EMBED_KINDS, 'turn'] : typeof k === 'string' ? k.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
  let last = 0;
  try {
    const r = await run(cfg, { kinds, onProgress: (d, t) => { if (d - last >= 2000 || d === t) { last = d; process.stderr.write(`  ${d} of ${t}\n`); } } });
    process.stdout.write(`embedded ${r.embedded} rows (${r.total} vectors in the store), ${r.seconds.toFixed(1)} seconds, ${r.model}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`total_recall embed: ${e.message}; is Ollama running with ${embedModel(cfg)} pulled? Search still works on words alone.\n`);
    return 1;
  }
}

module.exports = { EMBED_KINDS, embedModel, embedTexts, queryVector, normalize, run, command };
