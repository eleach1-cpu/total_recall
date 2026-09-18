'use strict';
const { execFileSync } = require('node:child_process');
const { loadConfig, noConfigMessage } = require('./config');
const { openStore } = require('./store');

function recentFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'log', '-5', '--name-only', '--format='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return new Set(out.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean));
  } catch { return new Set(); }
}

function mentionsRecentFile(d, recent) {
  if (!recent.size) return false;
  let files = [];
  try { files = JSON.parse(d.files_json || '[]'); } catch {}
  const text = `${d.title} ${d.body}`;
  for (const f of recent) {
    const base = f.split('/').pop();
    if (files.some((x) => String(x).replace(/\\/g, '/').endsWith(f))) return true;
    if (base && base.length > 5 && text.includes(base)) return true;
  }
  return false;
}

function buildBrief(store, cfg, recent) {
  const caps = cfg.brief || { sessions: 3, maxLines: 40, standingLines: 15 };
  const lines = [];
  const standing = store.standing(caps.standingLines);
  const standingTotal = store.standingCount();
  const sessions = store.recentSessionIds(caps.sessions);
  if (!standing.length && !sessions.length) return ['total_recall: store is empty; run  total_recall ingest --all'];
  lines.push('== total_recall brief ==');
  for (const s of standing) lines.push(`${s.ts.slice(0, 10)} RULE ${s.who}: ${s.title}`);
  if (standingTotal > standing.length) lines.push(`+${standingTotal - standing.length} more: total_recall search --outcome standing`);
  const budget = caps.maxLines - lines.length - 1;
  if (sessions.length && budget > 0) {
    const stmts = store.statementsForSessions(sessions).filter((d) => d.outcome !== 'standing');
    let oldest = '9999', newest = '0000';
    for (const sid of sessions) {
      const t = store.turnsForSession(sid);
      if (t.length) { oldest = t[0].ts < oldest ? t[0].ts : oldest; newest = t[t.length - 1].ts > newest ? t[t.length - 1].ts : newest; }
    }
    const handoffs = store.handoffsBetween(oldest.slice(0, 10), '9999');
    const rows = [...stmts, ...handoffs.map((h) => ({ ...h, who: 'handoff', outcome: 'note' }))];
    const t0 = Date.parse(oldest) || 0;
    const scored = rows.map((d) => {
      let score = 0;
      if (mentionsRecentFile(d, recent)) score += 3;
      if (d.outcome === 'open') score += 2;
      if (d.outcome === 'rejected') score += 1;
      score += Math.max(0, (Date.parse(d.ts) - t0) / 86400000);
      return { d, score };
    }).sort((a, b) => b.score - a.score || (a.d.outcome === 'open' ? -1 : b.d.outcome === 'open' ? 1 : 0));
    for (const { d } of scored.slice(0, budget)) {
      // A handoff heading alone ("Open", "Tests") says nothing; carry the first line of its body.
      const extra = d.kind === 'handoff' ? ` , ${String(d.body).replace(/\s+/g, ' ').trim().slice(0, 110)}` : '';
      lines.push(`${d.ts.slice(0, 10)} ${d.who} ${d.outcome}: ${d.title}${extra}`);
    }
  }
  lines.push('Run: total_recall search "<topic>" before the first edit. --deep for the raw turns.');
  return lines;
}

function command() {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const store = openStore(cfg.store);
  try { process.stdout.write(buildBrief(store, cfg, recentFiles(cfg.root)).join('\n') + '\n'); }
  finally { store.close(); }
  return 0;
}

module.exports = { recentFiles, buildBrief, command };
