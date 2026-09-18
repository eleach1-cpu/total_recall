#!/usr/bin/env node
'use strict';
// Prompt tuning harness. Runs a prompt against the live Ollama model over the gold chunks in
// tests/prompt-eval/gold.json and scores outcome labels. Not part of `npm test` (needs a GPU).
//
//   node scripts/eval-prompt.js                       uses lib/distill.js PROMPT
//   node scripts/eval-prompt.js --prompt cand.txt     uses a candidate prompt file
//   node scripts/eval-prompt.js --model qwen3:8b      overrides the model
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('../lib/args');
const distill = require('../lib/distill');

//   node scripts/eval-prompt.js --provider claude       uses the Claude API (ANTHROPIC_API_KEY)
const args = parseArgs(process.argv.slice(2));
const provider = typeof args.flags.provider === 'string' ? args.flags.provider : 'ollama';
const url = typeof args.flags.url === 'string' ? args.flags.url : 'http://localhost:11434';
const cfg = { distill: { provider, model: typeof args.flags.model === 'string' ? args.flags.model : null }, ollama: { url, model: 'qwen3:14b', chunkTokens: 6000 } };
const model = distill.modelFor(cfg, {});
const prompt = typeof args.flags.prompt === 'string' ? fs.readFileSync(args.flags.prompt, 'utf8') : distill.PROMPT;
const gold = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'prompt-eval', 'gold.json'), 'utf8'));

const ask = (text) => distill.callModel(cfg, {}, text);

(async () => {
  let goldTotal = 0, goldHit = 0, forbidViolations = 0, reasonMiss = 0, dropped = 0;
  let nextId = 1;
  const t0 = Date.now();
  for (const chunk of gold.chunks) {
    const turns = chunk.turns.map((t, i) => ({ id: nextId + i, role: t.role, body: t.body, ts: `2026-09-18T10:${String(i).padStart(2, '0')}:00.000Z` }));
    const base = nextId; nextId += turns.length;
    const reply = await ask(prompt + distill.renderChunk(turns));
    const parsed = distill.parseReply(reply);
    const items = [];
    if (!parsed) console.log(`  ${chunk.name}: UNPARSEABLE reply`);
    else for (const it of parsed.items) { const v = distill.validate(it, turns); if (v.ok) items.push(v.statement); else dropped++; }
    const got = items.map((s) => `${s.evidence[s.evidence.length - 1] - base + 1}:${s.outcome}`);
    const misses = [];
    for (const [turnNo, outcome] of chunk.gold) {
      goldTotal++;
      if (items.some((s) => s.evidence[s.evidence.length - 1] === base + turnNo - 1 && s.outcome === outcome)) goldHit++;
      else misses.push(`${turnNo}:${outcome}`);
    }
    const bad = items.filter((s) => chunk.forbid.includes(s.outcome)).map((s) => `${s.evidence[s.evidence.length - 1] - base + 1}:${s.outcome}`);
    forbidViolations += bad.length;
    if (chunk.reasonOn) {
      const r = items.find((s) => s.evidence[s.evidence.length - 1] === base + chunk.reasonOn - 1);
      if (!r || !r.reason) { reasonMiss++; misses.push(`${chunk.reasonOn}:reason`); }
    }
    console.log(`${misses.length || bad.length ? 'FAIL' : ' ok '} ${chunk.name}\n      got: ${got.join(', ') || '(none)'}${misses.length ? `\n      missed: ${misses.join(', ')}` : ''}${bad.length ? `\n      forbidden: ${bad.join(', ')}` : ''}`);
  }
  console.log(`\ngold ${goldHit}/${goldTotal}, forbidden ${forbidViolations}, reason misses ${reasonMiss}, validation drops ${dropped}, ${((Date.now() - t0) / 1000).toFixed(0)}s, model ${model}`);
  process.exitCode = goldHit === goldTotal && forbidViolations === 0 && reasonMiss === 0 ? 0 : 1;
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
