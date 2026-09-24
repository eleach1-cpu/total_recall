'use strict';
const path = require('node:path');
const { scrub } = require('../scrub');
const { sha256 } = require('../store');

// Codex rollout files (JSONL under ~/.codex/sessions and ~/.codex/archived_sessions), as observed
// in desktop builds 0.146 - 0.154. The format is not a published interface, so everything this
// parser does not recognise is COUNTED and skipped, never guessed at.
//
//   session_meta            first record: who this file is (thread id, root session, parent, cwd, git, history_base)
//   response_item/message   THE conversation lane: role user|assistant|developer, content blocks
//                           input_text|output_text|input_image, assistant `phase` final_answer|commentary
//   event_msg/item_completed  a second copy of the same messages for the UI: duplicates, skipped,
//                           except FileChange, the one structured record of which files an edit touched
//   reasoning, compaction (encrypted), tool calls and outputs, world_state, token records,
//   agent_message (agent to agent): never conversation, never stored as something someone said
const ADAPTER = 'codex/2';
const PHASES = new Set(['final_answer', 'commentary']);

// File name: rollout-<time>-<thread>[_<segment>].jsonl. A thread continued in a second file keeps
// its thread id and adds a segment id; the first file has none.
function segmentOf(file, thread) {
  const base = path.basename(String(file), '.jsonl');
  const i = thread ? base.indexOf(`${thread}_`) : -1;
  return i === -1 ? '' : base.slice(i + thread.length + 1);
}

// The FIRST session_meta of a file is its identity. A later one (a child file replays its parent's
// header inside the inherited history) never changes whose file this is.
function metaOf(rec, file) {
  const p = (rec && rec.payload) || {};
  if (!rec || rec.type !== 'session_meta' || typeof p.id !== 'string' || !p.id) return null;
  const startKey = Object.keys(p).find((k) => /history_start_ordinal$/.test(k));
  return {
    thread: p.id,
    session: typeof p.session_id === 'string' && p.session_id ? p.session_id : p.id,
    parent: p.parent_thread_id || null,
    forkedFrom: p.forked_from_id || null,
    // A subagent says so in `source`. A fork the user made has a parent too, and is NOT a subagent.
    subagent: !!(p.source && typeof p.source === 'object' && p.source.subagent !== undefined),
    threadSource: typeof p.thread_source === 'string' ? p.thread_source : null,
    cwd: typeof p.cwd === 'string' ? p.cwd : null,
    repo: p.git && typeof p.git.repository_url === 'string' ? p.git.repository_url : null,
    // Records below this ordinal were inherited from the parent, not said in this thread.
    inheritedBelow: startKey && Number.isInteger(p[startKey]) ? p[startKey] : 0,
    base: p.history_base && typeof p.history_base.thread_id === 'string'
      ? { thread: p.history_base.thread_id, endOrdinal: p.history_base.end_ordinal_exclusive, endOffset: p.history_base.end_byte_offset } : null,
    firstOrdinal: Number.isInteger(rec.ordinal) ? rec.ordinal : 0,
    segment: segmentOf(file, p.id),
    version: typeof p.cli_version === 'string' ? p.cli_version : null,
  };
}

// What the OWNER typed in one text block, with what the app put in front of it taken off. The app
// wraps its own material and then, in the SAME block, carries the owner's words:
//
//   <in-app-browser-context>...</in-app-browser-context>        then the request
//   # Files mentioned by the user: / ## <file>: ...             then  ## My request [for Codex]:  and the request
//
// so a wrapper is removed, never the block. Only the wrapper goes: a block that is nothing but
// app material yields nothing. Structural on purpose: a message that merely mentions "summary" or
// "request" is untouched. An XML-style element followed by more text is only treated as the app's
// when its name looks like the app's (it contains _ or -); `<div>..</div> fix this` is the owner's.
const APP_HEADED = /^\s*# (AGENTS\.md instructions|Files mentioned by the user|Chrome tabs)\b/;
const MY_REQUEST = /^##\s+My request(?: for Codex)?\s*:?[ \t\r]*$/im;
function ownerPartsOf(text, stats) {
  let t = String(text);
  const parts = [];
  for (;;) {
    const m = /^\s*<([A-Za-z][\w:-]*)[\s>]/.exec(t);
    if (!m || m[1].toLowerCase() === 'image') break; // an image tag is an attachment marker, handled as one
    const close = `</${m[1]}>`;
    const i = t.indexOf(close);
    if (m[1] === 'send_user_message_question_reply') {
      // Only submitted answer strings are owner evidence. Question text is app
      // context, kept in a separate reference row by recordToDocs below.
      if (i === -1) { stats.badQuestionReplies++; return parts; }
      try {
        const entries = JSON.parse(t.slice(t.indexOf('>') + 1, i));
        if (!Array.isArray(entries)) throw new Error('unknown reply shape');
        for (const entry of entries) {
          if (!entry || typeof entry.question !== 'string' || !entry.question.trim() || typeof entry.answer !== 'string') {
            stats.badQuestionReplies++; continue;
          }
          if (entry.answer.trim()) parts.push({ text: entry.answer, question: entry.question });
        }
      } catch { stats.badQuestionReplies++; }
      t = t.slice(i + close.length);
      continue;
    }
    if (i === -1) break;
    const rest = t.slice(i + close.length);
    if (rest.trim() && !/[_-]/.test(m[1])) break;
    stats.injectedBlocks++;
    t = rest;
    if (!t.trim()) return parts;
  }
  if (APP_HEADED.test(t)) {
    stats.injectedBlocks++;
    const m = MY_REQUEST.exec(t);
    t = m ? t.slice(m.index + m[0].length).trim() : '';
  }
  if (t.trim()) parts.push({ text: t });
  return parts;
}
function ownerTextOf(text, stats) {
  return ownerPartsOf(text, stats).map(p => p.text).join('\n');
}
const isImageMarker = (text) => /^\s*<\/?image\b[^>]*>\s*$/i.test(String(text));

function userText(content, stats) {
  const parts = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (!b) continue;
    if (b.type === 'input_image' || (b.type === 'input_text' && isImageMarker(b.text))) { if (parts[parts.length - 1] !== '[image]') parts.push('[image]'); continue; }
    if (b.type !== 'input_text' || typeof b.text !== 'string') continue; // audio, files, binary: never stored
    const own = ownerTextOf(b.text, stats);
    if (own.trim()) parts.push(own.trim());
  }
  return parts.join('\n');
}

function assistantText(content) {
  return (Array.isArray(content) ? content : []).filter((b) => b && b.type === 'output_text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

const validTs = (ts) => typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(ts) && !Number.isNaN(Date.parse(ts));

function newStats() {
  // replies: assistant records seen in any shape, readable or not. None at all means the thread has
  // not answered yet (a file read the moment it opened), which is not a format change.
  return { messages: 0, replies: 0, injectedBlocks: 0, injectedOnly: 0, badQuestionReplies: 0, unknownPhase: 0, unverifiedOpenings: 0, badTimestamp: 0, inherited: 0, eventCopies: 0, agentMessages: 0, ignored: {} };
}

// One record of a ROOT thread's file -> a doc, or null. `ctx` is the file's identity (metaOf),
// `stats` is counted into so an ingest can say what it saw and what it left out.
function recordToDoc(rec, ctx, project, stats, ownerOverride) {
  if (!rec || typeof rec !== 'object') return null;
  const p = rec.payload || {};
  const ignore = (k) => { stats.ignored[k] = (stats.ignored[k] || 0) + 1; return null; };
  const inherited = Number.isInteger(rec.ordinal) && rec.ordinal < ctx.inheritedBelow;
  // An inherited record was said in the parent thread, at its original time. It keeps that
  // identity; here it can only ever be reference, never a fresh approval.
  const threadKey = `codex:${inherited && (ctx.forkedFrom || ctx.parent) ? (ctx.forkedFrom || ctx.parent) : ctx.thread}`;
  const base = {
    project, session_id: threadKey, source_client: 'codex', native_session: ctx.session, ordinal: Number.isInteger(rec.ordinal) ? rec.ordinal : null,
    segment: ctx.segment, adapter: ADAPTER, turn_key: (p.internal_chat_message_metadata_passthrough && p.internal_chat_message_metadata_passthrough.turn_id) || p.turn_id || null,
  };

  if (rec.type === 'event_msg') {
    const item = p.type === 'item_completed' && p.item ? p.item : null;
    if (item && item.type === 'FileChange' && item.changes && typeof item.changes === 'object' && !inherited) {
      const files = Object.keys(item.changes);
      if (!files.length || !validTs(rec.timestamp)) return ignore('event_msg|FileChange(empty)');
      return { ...base, kind: 'turn', ts: rec.timestamp, role: 'assistant', origin: 'tool', item_key: item.id || null,
        title: files.join(' ').slice(0, 200), body: `(tool-only turn: apply_patch) ${files.join(' ')}`,
        files_json: JSON.stringify(files), tools_json: '["apply_patch"]',
        sha: sha256(['codex', 'file', ctx.thread, item.id || `${ctx.segment}|${rec.ordinal}`].join('|')) };
    }
    if (item && (item.type === 'UserMessage' || item.type === 'AgentMessage')) { stats.eventCopies++; if (item.type === 'AgentMessage') stats.replies++; return null; }
    return ignore(`event_msg|${p.type}${item ? `|${item.type}` : ''}`);
  }
  if (rec.type !== 'response_item') return ignore(String(rec.type));
  if (p.type === 'agent_message') { stats.agentMessages++; return null; }
  if (p.type !== 'message') return ignore(`response_item|${p.type}`);
  if (p.role !== 'user' && p.role !== 'assistant') return ignore(`message|${p.role}`); // developer, system: instructions, not conversation

  if (p.role === 'assistant' && ownerOverride === undefined) stats.replies++;
  let origin = inherited ? 'reference' : 'direct';
  let text;
  if (p.role === 'user') text = ownerOverride === undefined ? userText(p.content, stats) : ownerOverride;
  else {
    text = assistantText(p.content);
    const phase = p.phase === undefined || p.phase === null ? '' : String(p.phase);
    // A phase this parser has never seen may be a channel that is not meant for the reader. It is
    // kept searchable and kept out of automatic decisions until someone has looked at it.
    if (phase && !PHASES.has(phase)) { stats.unknownPhase++; origin = 'reference'; }
  }
  const body = scrub(text).trim();
  if (!body || body === '[image]') { if (p.role === 'user') stats.injectedOnly++; return null; }
  // A thread an AGENT created opens with a prompt nobody can show the owner typed: the app, or
  // another assistant, may have written it. That ONE message stays searchable as reference and
  // can never become an approval or a standing rule. Everything the owner says after it in the
  // same conversation is his, and is kept as his.
  if (p.role === 'user' && ctx.openingPending && !inherited) { ctx.openingPending = false; origin = 'reference'; stats.unverifiedOpenings++; }
  // Old conversation text is never stamped with the time it was imported.
  if (!validTs(rec.timestamp)) { stats.badTimestamp++; return null; }
  if (inherited) stats.inherited++;
  stats.messages++;
  return { ...base, kind: 'turn', ts: rec.timestamp, role: p.role, origin, item_key: p.id || null,
    title: body.slice(0, 80), body, files_json: '[]', tools_json: '[]',
    // The message's own id is its identity: the same message replayed in a fork, a continuation
    // file or an archived copy is one row. Two real messages that both say "approved" have two ids.
    sha: p.id ? sha256(['codex', 'msg', p.id].join('|'))
      : sha256(['codex', 'anon', ctx.thread, ctx.segment, rec.ordinal, p.role, rec.timestamp, sha256(body)].join('|')) };
}

// Preserve each widget question/answer pair independently. A "yes" to question 2
// must never become evidence of approval of question 1. Ordinary messages keep
// their existing identities, including any text after an app wrapper.
function recordToDocs(rec, ctx, project, stats) {
  const p = rec?.payload;
  if (rec?.type !== 'response_item' || p?.type !== 'message' || p.role !== 'user' ||
      !(Array.isArray(p.content) ? p.content : []).some(b => b.type === 'input_text' && /<send_user_message_question_reply[\s>]/.test(b.text || ''))) {
    const d = recordToDoc(rec, ctx, project, stats);
    return d ? [d] : [];
  }
  const parts = [];
  for (const b of p.content || []) {
    if (b.type === 'input_text' && typeof b.text === 'string') parts.push(...ownerPartsOf(b.text, stats));
    else if (b.type === 'input_image') parts.push({ text: '[image]' });
  }
  const docs = [], wasOpening = ctx.openingPending;
  let index = 0;
  for (const part of parts.filter(p => p.question !== undefined)) {
    const d = recordToDoc(rec, { ...ctx }, project, stats, part.text);
    if (!d) continue;
    d.sha = sha256(JSON.stringify(['codex-question-answer', d.sha, index++]));
    d.adapter = `${ADAPTER}:question-answer`;
    const question = scrub(part.question).trim();
    docs.push({ ...d, role: 'assistant', origin: 'reference', title: 'App question context (not owner words)',
      body: question, adapter: `${ADAPTER}:question-context`, sha: sha256(`${d.sha}|question`) }, d);
  }
  const ordinary = parts.filter(p => p.question === undefined).map(p => p.text).join('\n');
  if (ordinary.trim()) {
    const d = recordToDoc(rec, { ...ctx, openingPending: wasOpening }, project, stats, ordinary);
    if (d) docs.push(d);
  }
  if (docs.length && wasOpening) ctx.openingPending = false;
  return docs;
}

// What kind of record an oversized line was, from its first bytes only.
function sniff(head) {
  const h = String(head || '');
  const type = (/"type":"(\w+)"/.exec(h) || [])[1] || 'unknown';
  const isMessage = type === 'response_item' && /"payload":\{"type":"message"/.test(h) && /"role":"(user|assistant)"/.test(h);
  return { type, isMessage };
}

module.exports = { ADAPTER, metaOf, segmentOf, recordToDoc, recordToDocs, ownerTextOf, newStats, sniff };
