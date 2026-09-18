'use strict';
const fs = require('node:fs');

// Hook-only. Claude Code pipes a JSON payload on stdin to every hook command.
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

function resolveSessionId({ payload, flags, env }) {
  const e = env || process.env;
  const f = flags || {};
  if (payload && typeof payload.session_id === 'string' && payload.session_id) return payload.session_id;
  if (e.CLAUDE_CODE_SESSION_ID) return e.CLAUDE_CODE_SESSION_ID;
  if (typeof f.session === 'string' && f.session) return f.session;
  return null;
}

module.exports = { readHookPayload, resolveSessionId };
