'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, noConfigMessage } = require('./config');
const { openStore, sha256 } = require('./store');
const { scrub } = require('./scrub');

const PATHISH = /(?:^|\s)((?:[A-Za-z]:)?[\w.\-~]*(?:[\/\\][\w.\-~]+)+\.[A-Za-z0-9]{1,8})(?=\s|$)/;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

function toolsAndFiles(content) {
  const tools = [], files = [];
  if (!Array.isArray(content)) return { tools, files };
  for (const b of content) {
    if (!b || b.type !== 'tool_use') continue;
    if (b.name) tools.push(b.name);
    const inp = b.input || {};
    for (const k of ['file_path', 'path', 'notebook_path']) if (typeof inp[k] === 'string') files.push(inp[k]);
    if (typeof inp.command === 'string') { const m = PATHISH.exec(inp.command); if (m) files.push(m[1]); }
  }
  return { tools: [...new Set(tools)], files: [...new Set(files)] };
}

// One Claude Code transcript record -> one doc, or null when it is not ours to keep.
function recordToDoc(rec, project) {
  if (!rec || (rec.type !== 'user' && rec.type !== 'assistant')) return null;
  if (rec.isSidechain) return null;
  const msg = rec.message || {};
  const content = msg.content;
  if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) return null;
  const body = scrub(textOf(content)).trim();
  const { tools, files } = toolsAndFiles(content);
  if (!body && !files.length) return null;
  const kind = rec.isCompactSummary ? 'compact_summary' : 'turn';
  const title = body ? body.slice(0, 80) : files.join(' ');
  return {
    project, kind, session_id: rec.sessionId || null, ts: rec.timestamp, role: rec.type,
    title, body: body || `(tool-only turn: ${tools.join(', ')}) ${files.join(' ')}`.trim(),
    files_json: JSON.stringify(files), tools_json: JSON.stringify(tools),
  };
}

function parseSelector(flags) {
  if (flags.all) return { mode: 'all' };
  if (flags.session && typeof flags.session === 'string') return { mode: 'session', session: flags.session };
  if (flags.since || flags.from) return { mode: 'range', since: flags.since || flags.from, to: flags.to };
  if (flags.today) { const d = new Date().toISOString().slice(0, 10); return { mode: 'range', since: d, to: d }; }
  return { mode: 'new' };
}

function inRange(ts, sel) {
  if (sel.mode !== 'range') return true;
  if (sel.since && ts < sel.since) return false;
  if (sel.to) { const end = new Date(sel.to + 'T00:00:00.000Z'); end.setUTCDate(end.getUTCDate() + 1); if (ts >= end.toISOString()) return false; }
  return true;
}

function headSha(file) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, 0); return sha256(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
}

function ingestTranscripts(store, cfg, sel) {
  const out = { turns: 0, skipped: 0, superseded: 0 };
  if (!fs.existsSync(cfg.transcripts)) return out;
  let files = fs.readdirSync(cfg.transcripts).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(cfg.transcripts, f));
  if (sel.mode === 'session') files = files.filter((f) => path.basename(f, '.jsonl') === sel.session);
  const trackProgress = sel.mode === 'new' || sel.mode === 'all';
  for (const file of files) {
    const st = fs.statSync(file);
    const sha = headSha(file);
    const prev = store.getSource(file);
    let offset = 0;
    if (trackProgress && prev && sel.mode === 'new') {
      if (st.size < prev.offset || prev.sha !== sha) { out.superseded += store.supersedePath(file); offset = 0; }
      else offset = prev.offset;
    }
    if (offset >= st.size) continue;
    const buf = Buffer.alloc(st.size - offset);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    const complete = lastNl === -1 ? '' : text.slice(0, lastNl + 1);
    for (const line of complete.split('\n')) {
      if (!line.trim()) continue;
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      const doc = recordToDoc(rec, cfg.project);
      if (!doc || !inRange(doc.ts, sel)) continue;
      doc.path = file;
      const r = store.insertDoc(doc);
      if (r.inserted) out.turns++; else out.skipped++;
    }
    if (trackProgress) {
      store.setSource({ path: file, kind: 'transcript', size: st.size, mtime: st.mtime.toISOString(), sha, offset: offset + Buffer.byteLength(complete, 'utf8'), ingested_at: new Date().toISOString() });
    }
  }
  return out;
}

function globFiles(pattern) {
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f)).sort();
}

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const mm = /^\s*([\w-]+):\s*(.*)$/.exec(line);
    if (mm) meta[mm[1]] = mm[2].trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

function splitSections(text, kind) {
  const sections = [];
  const t = String(text).replace(/\r\n/g, '\n');
  if (kind === 'changelog') {
    const parts = t.split(/\n(?=\*\*\d{4}-\d{2}-\d{2})/);
    for (const p of parts) {
      const m = /^\*\*(\d{4}-\d{2}-\d{2})\s*[,:]?\s*([^*]+)\*\*/.exec(p.trim());
      if (!m) continue;
      sections.push({ title: m[2].trim(), body: p.trim(), ts: `${m[1]}T00:00:00.000Z` });
    }
    return sections;
  }
  // A project map files its real content one level down (`### /the/route`), under `## ` chapters
  // hundreds of lines long, so a map is cut at both levels; notes are cut at `## ` only.
  const deep = kind === 'map_section';
  const parts = t.split(deep ? /\n(?=#{2,3} )/ : /\n(?=## )/);
  for (const p of parts) {
    const m = (deep ? /^#{2,3} +(.+)\n?([\s\S]*)$/ : /^## +(.+)\n?([\s\S]*)$/).exec(p.trim());
    if (!m) continue;
    const body = m[2].trim();
    if (!body) continue;
    sections.push({ title: m[1].trim(), body, ts: null });
  }
  return sections;
}

function ingestMarkdown(store, cfg, sel) {
  const out = { sections: 0, skipped: 0, superseded: 0, standing: 0 };
  for (const [kind, pattern] of Object.entries(cfg.sources || {})) {
    for (const file of globFiles(pattern)) {
      const raw = fs.readFileSync(file, 'utf8');
      const sha = sha256(raw);
      const st = fs.statSync(file);
      const prev = store.getSource(file);
      if (prev && prev.sha === sha) continue;
      if (prev) out.superseded += store.supersedePath(file);
      const fileDate = DATE_RE.exec(path.basename(file));
      const fallbackTs = fileDate ? `${fileDate[1]}T00:00:00.000Z` : st.mtime.toISOString();
      const { meta, body } = parseFrontmatter(raw);
      const docs = [];
      if (kind === 'memory') {
        const title = meta.description || path.basename(file, '.md');
        docs.push({ kind, title, body: scrub(body.trim()), ts: fallbackTs });
        if (meta.type === 'feedback' || /^\s*type:\s*feedback/m.test(raw)) {
          const firstLine = body.trim().split('\n').find((l) => l.trim()) || title;
          docs.push({ kind: 'statement', title, body: `${title}\n${firstLine}\n(from ${path.basename(file)})`, ts: fallbackTs,
            who: 'owner', outcome: 'standing', quote: scrub(firstLine.trim()).slice(0, 240), evidence_ids: '[]' });
        }
      } else {
        for (const s of splitSections(body, kind)) {
          const d = { kind, title: s.title, body: scrub(s.body), ts: s.ts || fallbackTs };
          // A map has no date in its name, so its sections would take the file's mtime and every
          // edit would re-insert all ~900 of them. Identity without the date: only a section whose
          // words changed becomes a new row, and its date is when that wording first appeared.
          if (kind === 'map_section') d.sha = sha256(['map_section', file, d.title, d.body].join('|'));
          docs.push(d);
        }
      }
      for (const d of docs) {
        if (!inRange(d.ts, sel)) continue;
        const r = store.insertDoc({ project: cfg.project, path: file, ...d });
        // Same sha as a row this file already had: the section did not change, so it comes back
        // to life instead of staying superseded with the rest of the old version.
        if (!r.inserted) { if (store.reactivate(r.id)) out.superseded--; out.skipped++; continue; }
        if (d.kind === 'statement') out.standing++; else out.sections++;
      }
      store.linkSupersession(file);
      store.setSource({ path: file, kind, size: st.size, mtime: st.mtime.toISOString(), sha, offset: st.size, ingested_at: new Date().toISOString() });
    }
  }
  return out;
}

function run(cfg, sel, store) {
  const t0 = Date.now();
  const own = !store;
  const s = store || openStore(cfg.store);
  try {
    const a = ingestTranscripts(s, cfg, sel);
    const b = ingestMarkdown(s, cfg, sel);
    return { turns: a.turns, sections: b.sections, skipped: a.skipped + b.skipped, superseded: a.superseded + b.superseded, standing: b.standing, seconds: (Date.now() - t0) / 1000 };
  } finally { if (own) s.close(); }
}

function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const r = run(cfg, parseSelector(args.flags));
  process.stdout.write(`ingested ${r.turns} turns, ${r.sections} file sections (${r.superseded} superseded, ${r.standing} standing rules), ${r.skipped} skipped (already present), ${r.seconds.toFixed(1)} seconds\n`);
  return 0;
}

module.exports = { recordToDoc, splitSections, parseSelector, ingestTranscripts, ingestMarkdown, run, command, globFiles };
