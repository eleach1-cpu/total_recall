'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, noConfigMessage, transcriptSourcesOf, asList } = require('./config');
const { openStore, sha256 } = require('./store');
const { scrub } = require('./scrub');
const { readLines } = require('./jsonl');
const claude = require('./adapters/claude');
const codex = require('./adapters/codex');
const { bindSession, bindingSha } = require('./bind');

// A receipt describes the configured sources at this pass's file snapshots,
// not every conversation everywhere, nor files appended after those snapshots.
const receiptKey = (cfg, completed = false) => `ingest:${cfg.project}:${completed ? 'completed' : 'attempt'}`;
const coverageConfigSha = (cfg) => sha256(JSON.stringify({ project: cfg.project, root: cfg.root,
  transcripts: transcriptSourcesOf(cfg), notes: cfg.sources || {}, binding: bindingSha(cfg),
  adapters: [claude.ADAPTER, codex.ADAPTER], maxLine: maxLineOf(cfg) }));
const newAudit = () => ({ sources: [], scan_errors: [], tails: [], parser_warnings: [] });
// What a Codex thread writes before its first reply (as seen in 0.155): set-up records, the
// instructions, and any tool activity the first turn starts with.
const CODEX_OPENING = new Set(['event_msg|task_started', 'event_msg|thread_settings_applied', 'event_msg|token_count', 'message|developer',
  'world_state', 'turn_context', 'token_usage_record', 'response_item|reasoning', 'event_msg|item_completed|Reasoning',
  'response_item|function_call', 'response_item|function_call_output', 'response_item|custom_tool_call', 'response_item|custom_tool_call_output',
  'event_msg|item_completed|FunctionCallOutput', 'event_msg|item_completed|CommandExecution', 'event_msg|item_completed|McpToolCall']);

// Only identify exclusions from a complete, known envelope prefix. Never search
// arbitrary tool/message content for a type name. An unfamiliar envelope, a
// compaction, or a message containing images stays a possible conversation gap.
function oversizedCodexExclusion(head) {
  const m = /^\s*\{\s*"timestamp"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*(?:"ordinal"\s*:\s*\d+\s*,\s*)?"type"\s*:\s*"response_item"\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*"(function_call_output|custom_tool_call_output)"\s*[,}]/.exec(String(head || ''));
  return m ? `response_item|${m[1]}` : null;
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

// The first bytes of a file, hashed: a changed beginning means the file was rewritten, not
// appended to. `span` is how many bytes the LAST pass hashed (at most 4096, fewer for a file that
// was shorter then), so a small file that simply grew still matches its old fingerprint.
function fingerprint(file, span) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(span); const n = span ? fs.readSync(fd, buf, 0, span, 0) : 0; return sha256(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
}
const spanOf = (size) => Math.min(4096, size);

function walkJsonl(dir, recursive, out = [], errors = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { errors.push({ path: dir, code: e.code || 'READ_ERROR' }); return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (recursive) walkJsonl(p, true, out, errors); } else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Stream one file from `start` to the snapshot `end`. Docs and the checkpoint that says they were
// read commit in the same short transaction, so a crash can never mark unread records as consumed,
// and no write lock is held while a line is being read or parsed.
const BATCH = 400;
function streamFile(store, file, o) {
  let batch = [], last = o.start, flushed = o.start;
  let malformed = 0, oversized = 0;
  const flush = () => {
    if (!batch.length && last === flushed) return;
    store.tx(() => {
      for (const d of batch) {
        const r = store.insertDoc(d);
        if (r.inserted) o.out.turns++;
        else { o.out.skipped++; if (o.counts) o.counts.duplicates++; if (o.rewritten && store.reactivate(r.id)) o.out.superseded--; }
      }
      if (o.track) o.checkpoint(last);
    });
    batch = []; flushed = last;
  };
  for (const line of readLines(file, { start: o.start, end: o.end, maxLine: o.maxLine })) {
    last = line.end;
    // A true return means the adapter positively identified an intentionally
    // excluded record, not missing conversation. Everything else still warns.
    if (line.oversized) { if (o.onOversized(line) !== true) oversized++; }
    else {
      let rec = null;
      try { rec = JSON.parse(line.text); } catch { malformed++; if (o.counts) o.counts.malformed++; }
      if (rec) for (const d of o.toDocs(rec, line)) batch.push(d);
    }
    if (batch.length >= BATCH) flush();
    if (o.deadline && Date.now() > o.deadline) { flush(); o.out.pending = true; break; }
  }
  // readLines does not yield blank lines. A newline at the snapshot end means
  // their bytes were safely scanned too; an unfinished last record must wait.
  if (!o.out.pending && last < o.end) {
    const fd = fs.openSync(file, 'r');
    try { const b = Buffer.alloc(1); if (fs.readSync(fd, b, 0, 1, o.end - 1) === 1 && b[0] === 10) last = o.end; }
    finally { fs.closeSync(fd); }
    if (last < o.end && o.audit) o.audit.tails.push({ path: file, unread_bytes: o.end - last });
  }
  flush();
  if (o.audit && (malformed || oversized)) o.audit.parser_warnings.push(`${o.client || 'transcript'}: ${path.basename(file)}: ${malformed} malformed and ${oversized} oversized record(s) skipped`);
}

function maxLineOf(cfg) { return Math.max(1, Number((cfg.ingest && cfg.ingest.maxLineMB) || 16)) * 1024 * 1024; }

function ingestClaudeSource(store, cfg, src, sel, out, opts) {
  let files = walkJsonl(src.path, src.recursive, [], opts.audit.scan_errors);
  opts.audit.sources.push({ kind: 'transcript', ...src, discovered: files.length });
  if (sel.mode === 'session') {
    const want = String(sel.session).replace(/^claude:/i, '');
    files = files.filter((f) => path.basename(f, '.jsonl') === want);
  }
  // A range or a single session is a selection, not progress: it never moves a file's checkpoint
  // past records it chose not to take.
  const track = sel.mode === 'new' || sel.mode === 'all';
  for (const file of files) {
    if (out.pending) return;
    const st = fs.statSync(file);
    const prev = store.getSource(file);
    let offset = 0, rewritten = false;
    if (track && prev && sel.mode === 'new') {
      if (st.size < prev.offset || fingerprint(file, spanOf(prev.size)) !== prev.sha) { out.superseded += store.supersedePath(file); rewritten = true; }
      else offset = prev.offset;
    }
    if (offset >= st.size) continue;
    const sha = fingerprint(file, spanOf(st.size));
    streamFile(store, file, {
      start: offset, end: st.size, maxLine: maxLineOf(cfg), track, rewritten, out, deadline: opts.deadline, audit: opts.audit, client: 'claude',
      onOversized: () => { out.oversized = (out.oversized || 0) + 1; },
      toDocs: (rec, line) => {
        const doc = claude.recordToDoc(rec, cfg.project);
        if (!doc || !inRange(doc.ts, sel)) return [];
        doc.path = file; doc.src_offset = line.start;
        return [doc];
      },
      checkpoint: (at) => store.setSource({ path: file, kind: 'transcript', client: 'claude', size: st.size, mtime: st.mtime.toISOString(), sha, offset: at, ingested_at: new Date().toISOString() }),
    });
  }
}

function readMeta(file, size, maxLine) {
  for (const line of readLines(file, { end: size, maxLine })) {
    if (line.oversized) return null;
    try { return codex.metaOf(JSON.parse(line.text), file); } catch { return null; }
  }
  return null;
}

// Codex keeps every project's conversations in one tree, so a pass is three steps:
//   1. catalog   read each new file's FIRST record only: whose thread, which project, subagent or not
//   2. lineage   a thread continued in a second file names the byte where its first file stops counting
//   3. read      stream the eligible root files, oldest first, from their checkpoints
function ingestCodexSources(store, cfg, srcs, sel, out, opts) {
  const c = out.codex = { discovered: 0, eligible: 0, otherProject: 0, subagentFiles: 0, unresolved: [], unresolvedCount: 0, moved: 0, inheritedHeaders: 0,
    malformed: 0, oversized: 0, oversizedMessages: 0, oversizedExcluded: 0, oversizedExcludedTypes: {}, duplicates: 0, incompleteHistory: 0, bytesRead: 0, ...codex.newStats() };
  const track = sel.mode === 'new' || sel.mode === 'all';
  let filesReadFromStart = 0;
  const bsha = bindingSha(cfg);
  const maxLine = maxLineOf(cfg);
  const known = new Map(store.sourcesOfClient('codex').map((r) => [r.path, r]));
  const byBase = new Map();
  for (const r of known.values()) { try { const s = JSON.parse(r.state || '{}'); if (s.base) byBase.set(s.base, r); } catch {} }

  const files = [];
  for (const src of srcs) {
    const discovered = walkJsonl(src.path, src.recursive, [], opts.audit.scan_errors);
    opts.audit.sources.push({ kind: 'transcript', ...src, discovered: discovered.length });
    for (const file of discovered) {
      if (opts.deadline && Date.now() > opts.deadline) { out.pending = true; break; }
      c.discovered++;
      const st = fs.statSync(file);
      const base = path.basename(file);
      let prev = known.get(file) || null;
      if (!prev) {
        // The same rollout at a new address (active -> archived): carry its progress across.
        const twin = byBase.get(base);
        if (twin && twin.path !== file && !fs.existsSync(twin.path)) { store.moveSource(twin.path, file); prev = store.getSource(file); c.moved++; }
      }
      let state = null; try { state = prev && prev.state ? JSON.parse(prev.state) : null; } catch {}
      let dirty = false;
      if (!state || state.bsha !== bsha || !state.bind) {
        const meta = readMeta(file, st.size, maxLine);
        const b = !meta ? { bind: 'unresolved', reason: 'no readable session header' } : meta.subagent ? { bind: 'subagent', reason: 'subagent thread' } : bindSession(meta, cfg);
        state = { base, bsha, bind: b.bind, reason: b.reason, cut: state && state.cut !== undefined ? state.cut : null,
          ...(meta ? { thread: meta.thread, session: meta.session, segment: meta.segment, firstOrdinal: meta.firstOrdinal, inheritedBelow: meta.inheritedBelow,
            parent: meta.parent, forkedFrom: meta.forkedFrom, baseRef: meta.base, threadSource: meta.threadSource } : {}) };
        dirty = true;
      }
      files.push({ file, st, prev, state, dirty });
    }
  }

  // Lineage. Nothing is read THROUGH a history reference: the earlier file is ingested as itself
  // if it is in an approved root. The reference only says where the earlier file stops counting,
  // and, when that file is not available, that this conversation's beginning is missing.
  const mine = files.filter((f) => f.state.bind === 'project');
  for (const f of mine) {
    const ref = f.state.baseRef;
    if (!ref) { if (f.state.incomplete) { f.state.incomplete = false; f.dirty = true; } continue; }
    const earlier = mine.filter((g) => g !== f && g.state.thread === ref.thread && (ref.thread !== f.state.thread || (g.state.firstOrdinal || 0) < (f.state.firstOrdinal || 0)))
      .sort((a, b) => (b.state.firstOrdinal || 0) - (a.state.firstOrdinal || 0))[0];
    const usable = earlier && Number.isInteger(ref.endOffset) && ref.endOffset <= earlier.st.size;
    if (!!f.state.incomplete !== !usable) { f.state.incomplete = !usable; f.dirty = true; }
    // Same thread: what the earlier file holds past the named byte was replaced by the owner's own edit.
    if (usable && ref.thread === f.state.thread && earlier.state.cut !== ref.endOffset) {
      earlier.state.cut = ref.endOffset; earlier.dirty = true;
      if (track) store.supersedeBeyond(earlier.file, ref.endOffset);
    }
  }
  c.incompleteHistory = mine.filter((f) => f.state.incomplete).length;

  let targets = mine;
  if (sel.mode === 'session') { const want = String(sel.session).replace(/^codex:/i, ''); targets = mine.filter((f) => f.state.thread === want); }
  targets.sort((a, b) => (a.state.base < b.state.base ? -1 : 1)); // the file name leads with its start time
  for (const f of files) {
    if (f.state.bind === 'project') c.eligible++;
    else if (f.state.bind === 'subagent') c.subagentFiles++;
    else if (f.state.bind === 'excluded') c.otherProject++;
    else { c.unresolvedCount++; if (c.unresolved.length < 50) c.unresolved.push({ file: f.state.base, reason: f.state.reason }); }
  }

  const save = (f, offset, sha) => store.setSource({ path: f.file, kind: 'codex', client: 'codex', size: f.st.size, mtime: f.st.mtime.toISOString(),
    sha: sha !== undefined ? sha : (f.prev ? f.prev.sha : ''), offset: offset !== undefined ? offset : (f.prev ? f.prev.offset : 0),
    ingested_at: new Date().toISOString(), state: JSON.stringify(f.state) });

  for (const f of targets) {
    if (out.pending) break;
    const end = Number.isInteger(f.state.cut) ? Math.min(f.st.size, f.state.cut) : f.st.size;
    let offset = 0, rewritten = false;
    if (track && f.prev && sel.mode === 'new') {
      if (f.st.size < f.prev.offset || (f.prev.sha && fingerprint(f.file, spanOf(f.prev.size)) !== f.prev.sha)) { out.superseded += store.supersedePath(f.file); rewritten = true; }
      else offset = f.prev.offset;
    }
    if (offset >= end) continue;
    if (offset === 0) filesReadFromStart++;
    const sha = fingerprint(f.file, spanOf(f.st.size));
    // A thread an agent created: its opening prompt is unverified. Read from the top that is
    // decided afresh; resumed from a checkpoint it is whatever the checkpoint recorded. A
    // continuation file never holds the opening (it is in the thread's first file).
    const continuation = !!(f.state.baseRef && f.state.baseRef.thread === f.state.thread);
    const openingPending = f.state.threadSource === 'agent_created_thread' && !continuation && (offset === 0 || !f.state.openingSeen);
    const ctx = { thread: f.state.thread, session: f.state.session, segment: f.state.segment || '', inheritedBelow: f.state.inheritedBelow || 0, parent: f.state.parent, forkedFrom: f.state.forkedFrom, openingPending };
    const badRepliesBefore = c.badQuestionReplies;
    const priorBadReplies = offset > 0 ? f.state.badQuestionReplies || 0 : 0;
    streamFile(store, f.file, {
      start: offset, end, maxLine, track, rewritten, out, counts: c, deadline: opts.deadline, audit: opts.audit, client: 'codex',
      // Preserve the ordinary adapter's tool-output exclusion even when a dump
      // exceeds the line cap. Unknown records and image-bearing messages warn.
      onOversized: (line) => {
        const excluded = oversizedCodexExclusion(line.head);
        if (excluded) {
          c.oversized++; // Preserve the existing non-message total; exclusions are a subset.
          c.oversizedExcluded++;
          c.oversizedExcludedTypes[excluded] = (c.oversizedExcludedTypes[excluded] || 0) + 1;
          c.ignored[excluded] = (c.ignored[excluded] || 0) + 1;
          return true;
        }
        if (codex.sniff(line.head).isMessage) c.oversizedMessages++; else c.oversized++;
        return false;
      },
      toDocs: (rec, line) => {
        c.bytesRead += line.end - line.start;
        if (rec.type === 'session_meta') { if (line.start !== 0) c.inheritedHeaders++; return []; }
        return codex.recordToDocs(rec, ctx, cfg.project, c).filter(doc => inRange(doc.ts, sel))
          .map(doc => ({ ...doc, path: f.file, src_offset: line.start }));
      },
      checkpoint: (at) => {
        f.state.openingSeen = !ctx.openingPending;
        f.state.badQuestionReplies = priorBadReplies + c.badQuestionReplies - badRepliesBefore;
        save(f, at, sha); f.dirty = false; f.prev = { offset: at, sha, size: f.st.size };
      },
    });
  }
  // What was learned about files that were not read (another project, a subagent, nothing new) is
  // kept, so the next pass does not open them again.
  const rest = files.filter((f) => f.dirty);
  if (track && rest.length) store.tx(() => { for (const f of rest) save(f); });
  if (track) store.setMeta('codex_incomplete', c.incompleteHistory);
  const unresolvedReplies = track ? mine.reduce((n, f) => n + (f.state.badQuestionReplies || 0), 0) : c.badQuestionReplies;
  if (unresolvedReplies) out.warnings.push(`codex: ${unresolvedReplies} question reply payload(s) were not recognised; owner answers may be missing`);
  // A checkpoint tail can contain only tool activity or a compaction marker.
  // That does not establish that the conversation's format is unrecognised.
  // Nor does a thread read the moment it opened (Codex's session-start hook ingests then): no
  // reply yet, and nothing but the records a thread opens with. A record kind outside that set
  // still warns, since a renamed conversation record would land there.
  const justOpened = c.replies === 0 && Object.keys(c.ignored).every((k) => CODEX_OPENING.has(k));
  if (track && !out.pending && filesReadFromStart > 0 && c.bytesRead > 0 && c.messages === 0 && c.duplicates === 0 && !justOpened) {
    out.warnings.push(`codex: ${filesReadFromStart} file(s) of this project were read from the start and NOT ONE conversation message was recognised; the Codex transcript format may have changed (adapter ${codex.ADAPTER})`);
  }
}

function ingestTranscripts(store, cfg, sel, opts = {}) {
  opts = { ...opts, audit: opts.audit || newAudit() };
  const out = { turns: 0, skipped: 0, superseded: 0, pending: false, warnings: [], codex: null };
  const srcs = transcriptSourcesOf(cfg);
  for (const src of srcs.filter((s) => s.client === 'claude')) ingestClaudeSource(store, cfg, src, sel, out, opts);
  const cx = srcs.filter((s) => s.client === 'codex');
  if (cx.length && !out.pending) ingestCodexSources(store, cfg, cx, sel, out, opts);
  return out;
}

function globFiles(pattern, errors = []) {
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  try {
    const files = fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f)).sort();
    if (!files.length && !base.includes('*')) errors.push({ path: pattern, code: 'MISSING_FILE' });
    return files;
  } catch (e) { errors.push({ path: dir, code: e.code || 'READ_ERROR' }); return []; }
}

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) { // a memory file saved on Windows ends its lines with CRLF
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

function ingestMarkdown(store, cfg, sel, audit = newAudit()) {
  const out = { sections: 0, skipped: 0, superseded: 0, standing: 0 };
  for (const [kind, patterns] of Object.entries(cfg.sources || {})) {
    // One pattern or several (a Claude handoff pattern beside a Codex one); a file two patterns
    // both match is read once.
    const files = [...new Set(asList(patterns).flatMap((p) => {
      const matched = globFiles(p, audit.scan_errors);
      audit.sources.push({ kind, pattern: p, discovered: matched.length });
      return matched;
    }))];
    for (const file of files) {
      const raw = fs.readFileSync(file, 'utf8');
      const sha = sha256(raw);
      const st = fs.statSync(file);
      const prev = store.getSource(file);
      const track = sel.mode === 'new' || sel.mode === 'all';
      if (prev && prev.sha === sha && sel.mode !== 'all' && track) continue;
      if (prev && track) out.superseded += store.supersedePath(file);
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
        const r = store.insertDoc({ project: cfg.project, path: file, origin: 'file', ...d });
        // Same sha as a row this file already had: the section did not change, so it comes back
        // to life instead of staying superseded with the rest of the old version.
        if (!r.inserted) { if (store.reactivate(r.id)) out.superseded--; out.skipped++; continue; }
        if (d.kind === 'statement') out.standing++; else out.sections++;
      }
      if (track) {
        store.linkSupersession(file);
        store.setSource({ path: file, kind, size: st.size, mtime: st.mtime.toISOString(), sha, offset: st.size, ingested_at: new Date().toISOString() });
      }
    }
  }
  return out;
}

// opts.budgetMs: a session-start hook gets a couple of seconds, not a cold multi-gigabyte import.
// What did not fit is left at its checkpoint and reported as pending.
function run(cfg, sel, store, opts = {}) {
  const t0 = Date.now();
  const own = !store;
  const s = store || openStore(cfg.store);
  const audit = newAudit(), configSha = coverageConfigSha(cfg);
  let previous = null;
  try { previous = JSON.parse(s.getMeta(receiptKey(cfg))); } catch {}
  if (previous?.config_sha !== configSha) previous = null;
  try {
    const deadline = opts.budgetMs ? t0 + opts.budgetMs : undefined;
    // Notes first: they are small, and they are what a brief needs even when the transcripts run out of time.
    const b = ingestMarkdown(s, cfg, sel, audit);
    const a = ingestTranscripts(s, cfg, sel, { deadline, audit });
    // Decisions recorded in session wait here until the conversation that holds the owner's words
    // has arrived; every ingest checks them.
    const decisions = require('./decide').linkPending(s);
    const finished = new Date().toISOString();
    const snapshotComplete = ['new', 'all'].includes(sel.mode) && !a.pending && !audit.scan_errors.length && !audit.tails.length;
    // An empty incremental pass cannot erase an earlier report of skipped
    // conversation. Only a full completed rescan can replace those warnings.
    const parserWarnings = [...new Set([
      ...(sel.mode === 'all' && snapshotComplete ? [] : previous?.parser_warnings || []),
      ...audit.parser_warnings,
      ...(a.codex?.badTimestamp ? [`codex: ${a.codex.badTimestamp} messages without a valid timestamp skipped`] : []),
      ...a.warnings
    ])];
    const warnings = [...parserWarnings,
      ...audit.scan_errors.map(e => `source scan ${e.code}: ${e.path}`),
      ...audit.tails.map(e => `unfinished transcript record (${e.unread_bytes} bytes waiting): ${e.path}`),
      ...(a.codex?.unresolvedCount ? [`codex: ${a.codex.unresolvedCount} files could not be assigned to a project`] : []),
      ...(a.codex?.incompleteHistory ? [`codex: ${a.codex.incompleteHistory} conversations have earlier history missing`] : [])];
    const receipt = { version: 1, project: cfg.project, config_sha: configSha,
      started_at: new Date(t0).toISOString(), finished_at: finished, selector: sel,
      status: snapshotComplete ? 'completed' : 'partial', snapshot_complete: snapshotComplete,
      baseline_all_at: sel.mode === 'all' && snapshotComplete ? finished : previous?.baseline_all_at || null,
      sources: audit.sources, scan_errors: audit.scan_errors, tails: audit.tails,
      parser_warnings: parserWarnings, warnings, codex: a.codex,
      boundary: 'Configured local sources at the recorded file snapshots only. Later appends and unconfigured sources were not checked.' };
    receipt.coverage_complete = snapshotComplete && !!receipt.baseline_all_at && warnings.length === 0;
    s.setMeta(receiptKey(cfg), JSON.stringify(receipt));
    if (snapshotComplete) s.setMeta(receiptKey(cfg, true), JSON.stringify(receipt));
    return { turns: a.turns, sections: b.sections, skipped: a.skipped + b.skipped, superseded: a.superseded + b.superseded, standing: b.standing,
      pending: a.pending, warnings, codex: a.codex, decisions, receipt, oversized: a.oversized || 0, seconds: (Date.now() - t0) / 1000 };
  } catch (e) {
    // A failed attempt must never refresh the completed receipt. No private
    // transcript text or exception message is written into the diagnostic.
    s.setMeta(receiptKey(cfg), JSON.stringify({ ...previous, version: 1, project: cfg.project, config_sha: configSha,
      started_at: new Date(t0).toISOString(), finished_at: new Date().toISOString(), selector: sel,
      status: 'failed', snapshot_complete: false, coverage_complete: false, error_code: e.code || 'IMPORT_FAILED',
      sources: audit.sources, scan_errors: audit.scan_errors, tails: audit.tails,
      parser_warnings: [...new Set([...(previous?.parser_warnings || []), ...audit.parser_warnings])] }));
    throw e;
  } finally { if (own) s.close(); }
}

// What a Codex pass saw and what it left out, by count and by reason. Never a line of anyone's text.
function codexReport(c) {
  if (!c) return [];
  const lines = [`codex: ${c.discovered} files found, ${c.eligible} in this project (${c.subagentFiles} subagent files skipped, ${c.otherProject} from other projects, ${c.unresolvedCount ?? c.unresolved.length} unresolved${c.moved ? `, ${c.moved} moved` : ''})`,
    `codex: ${c.messages} messages read, ${c.duplicates} already present, ${c.eventCopies} event copies and ${c.agentMessages} agent-to-agent messages skipped, ${c.injectedBlocks} app-injected blocks removed (${c.injectedOnly} user messages were nothing else)`];
  const odd = [];
  if (c.oversizedExcluded) lines.push(`codex: ${c.oversizedExcluded} oversized tool-output records intentionally excluded (${Object.entries(c.oversizedExcludedTypes).map(([type, count]) => `${type}: ${count}`).join(', ')})`);
  if (c.malformed) odd.push(`${c.malformed} malformed records`);
  const oversizedUnknown = c.oversized - (c.oversizedExcluded || 0);
  if (oversizedUnknown) odd.push(`${oversizedUnknown} oversized records skipped (unclassified; possible conversation gap)`);
  if (c.oversizedMessages) odd.push(`${c.oversizedMessages} OVERSIZED MESSAGES skipped (conversation missing)`);
  if (c.unverifiedOpenings) odd.push(`${c.unverifiedOpenings} opening prompt(s) of agent-created threads kept as reference only (nobody can show the owner typed them)`);
  if (c.unknownPhase) odd.push(`${c.unknownPhase} assistant messages in an unknown phase kept as reference only`);
  if (c.badTimestamp) odd.push(`${c.badTimestamp} messages without a valid time skipped`);
  if (c.inherited) odd.push(`${c.inherited} inherited messages kept as reference`);
  if (c.incompleteHistory) odd.push(`${c.incompleteHistory} conversation(s) with earlier history missing`);
  if (odd.length) lines.push(`codex: ${odd.join(', ')}`);
  for (const u of c.unresolved.slice(0, 5)) lines.push(`codex: unresolved ${u.file}: ${u.reason}`);
  return lines;
}

function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const r = run(cfg, parseSelector(args.flags));
  process.stdout.write(`ingested ${r.turns} turns, ${r.sections} file sections (${r.superseded} superseded, ${r.standing} standing rules), ${r.skipped} skipped (already present), ${r.seconds.toFixed(1)} seconds\n`);
  for (const l of codexReport(r.codex)) process.stdout.write(l + '\n');
  if (r.decisions.linked || r.decisions.waiting || r.decisions.unverified) process.stdout.write(`decisions: ${r.decisions.linked} linked to the conversation, ${r.decisions.waiting} still waiting for it, ${r.decisions.unverified} UNVERIFIED (the quoted words are not in the conversation)\n`);
  for (const w of r.warnings) process.stderr.write(`WARNING ${w}\n`);
  process.stdout.write(`source coverage: ${r.receipt.status}; ${r.receipt.sources.length} configured source entries scanned; ${r.receipt.coverage_complete ? 'full configured-source baseline verified' : 'not a verified complete corpus'}; ${r.receipt.finished_at}\n`);
  const fullPass = ['new', 'all'].includes(r.receipt.selector.mode);
  return r.warnings.length || r.pending || (fullPass && !r.receipt.snapshot_complete) ? 1 : 0;
}

module.exports = { recordToDoc: claude.recordToDoc, splitSections, parseSelector, ingestTranscripts, ingestMarkdown, run, command, globFiles, codexReport, fingerprint, streamFile, receiptKey, coverageConfigSha };
