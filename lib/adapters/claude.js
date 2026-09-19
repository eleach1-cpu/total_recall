'use strict';
const { scrub } = require('../scrub');

const ADAPTER = 'claude/1';
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
    source_client: 'claude', native_session: rec.sessionId || null, item_key: rec.uuid || null,
    origin: rec.isCompactSummary ? 'summary' : body ? 'direct' : 'tool', adapter: ADAPTER,
  };
}

module.exports = { recordToDoc, ADAPTER, PATHISH };
