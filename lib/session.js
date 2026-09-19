'use strict';
const fs = require('node:fs');

// Hook-only. Claude Code and Codex both pipe a JSON payload on stdin to every hook command.
function readHookPayload() {
  try {
    if (process.stdin.isTTY) return null;
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// The CALLING session: whose gate a search opens. Order: what the host's hook said, then Claude
// Code's own environment variable, then an explicit flag. `client: 'codex'` never reads Claude's
// variable: a Codex task started from a Claude terminal would otherwise open Claude's gate.
function resolveSessionId({ payload, flags, env, client }) {
  const e = env || process.env;
  const f = flags || {};
  if (payload && typeof payload.session_id === 'string' && payload.session_id) return payload.session_id;
  if (client !== 'codex' && e.CLAUDE_CODE_SESSION_ID) return e.CLAUDE_CODE_SESSION_ID;
  if (typeof f.session === 'string' && f.session) return f.session;
  return null;
}

module.exports = { readHookPayload, resolveSessionId };
