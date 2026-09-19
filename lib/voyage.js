'use strict';
const { hash } = require('./recall-db');

function provider(cfg) {
  const p = cfg.embed?.provider || 'ollama';
  if (!['ollama', 'voyage'].includes(p)) throw new Error('embed.provider must be ollama or voyage');
  return p;
}
function settings(cfg) {
  const model = cfg.embed?.model || 'voyage-4-lite';
  const dimensions = cfg.embed?.dimensions ?? 1024;
  if (!['voyage-4-lite', 'voyage-4', 'voyage-4-large'].includes(model)) throw new Error('Voyage support requires voyage-4-lite, voyage-4 or voyage-4-large');
  if (![256, 512, 1024, 2048].includes(dimensions)) throw new Error('Voyage dimensions must be 256, 512, 1024 or 2048');
  return { model, dimensions };
}
function identity(cfg) {
  const { model, dimensions } = settings(cfg);
  return hash(['voyage-v1', model, dimensions, 'float', 'query/document', 'no-truncation']);
}
function encoder(cfg, timeout, { document = false, maxBytes } = {}) {
  const { model, dimensions } = settings(cfg);
  if (cfg.embed?.allowRemote !== true) throw new Error('Voyage is disabled: external processing requires embed.allowRemote=true');
  const key = process.env.VOYAGE_API_KEY;
  if (!key?.trim()) throw new Error('Voyage requires VOYAGE_API_KEY in the tool process environment');
  const limit = document ? Number(maxBytes) : 32768;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Voyage indexing requires a positive max-remote-bytes limit for this run');
  const usage = { requests: 0, input_bytes: 0, reported_tokens: 0, uncertain_requests: 0, max_input_bytes: limit };
  const deadline = document ? null : AbortSignal.timeout(timeout);
  return { version: identity(cfg), usage, async embed(texts, prefix) {
    const type = prefix === 'search_query' ? 'query' : prefix === 'search_document' ? 'document' : null;
    if (!type || (type === 'document' && !document)) throw new Error('Voyage document upload requires an explicit indexing run');
    if (!Array.isArray(texts) || !texts.length || texts.length > 128 || texts.some(t => typeof t !== 'string' || !t.length || Buffer.byteLength(t, 'utf8') > 32768)) throw new Error('Voyage input exceeds the supported request size');
    const bytes = texts.reduce((n, t) => n + Buffer.byteLength(t, 'utf8'), 0);
    if (bytes > 100000) throw new Error('Voyage batch exceeds 100000 input bytes; reduce the batch size');
    if (usage.input_bytes + bytes > limit) throw new Error(`Voyage input-byte limit reached before sending another request (${usage.input_bytes}/${limit}); committed chunks can be resumed`);
    // Reserve before sending. This is an upload-volume bound, NOT a token or dollar cap.
    usage.input_bytes += bytes; usage.requests++;
    try {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST', redirect: 'error', signal: deadline || AbortSignal.timeout(timeout),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input: texts, input_type: type, truncation: false, output_dimension: dimensions, output_dtype: 'float' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = await res.json();
      if (r.model !== model || !Array.isArray(r.data) || r.data.length !== texts.length || !Number.isSafeInteger(r.usage?.total_tokens) || r.usage.total_tokens < 0) throw new Error('invalid response metadata');
      usage.reported_tokens += r.usage.total_tokens;
      const result = new Array(texts.length), seen = new Set();
      for (const item of r.data) {
        const v = item.embedding, i = item.index;
        if (!Number.isInteger(i) || i < 0 || i >= texts.length || seen.has(i) || !Array.isArray(v) || v.length !== dimensions || !v.every(n => Number.isFinite(n) && Number.isFinite(Math.fround(n))) || !v.some(n => Math.fround(n) !== 0)) throw new Error('invalid embedding batch');
        seen.add(i); result[i] = v;
      }
      return result;
    } catch (e) {
      usage.uncertain_requests++;
      // Never echo provider bodies, submitted text, credentials, or arbitrary network errors.
      const detail = /^HTTP \d{3}$/.test(e.message) ? e.message : 'network, timeout or invalid response';
      throw new Error(`Voyage request failed (${detail}); no automatic retry. Usage: ${JSON.stringify(usage)}. The failed request may have been billed.`);
    }
  } };
}
module.exports = { provider, settings, identity, encoder };
