'use strict';
const { loadConfig } = require('./config');
const { readHookPayload } = require('./session');
const gate = require('./gate');
const sessionStart = require('./session-start');

// ONE hook command for Codex, dispatching on the event the host names in its stdin payload:
//
//   SessionStart  source startup | resume | clear : arm this task's gate, bounded ingest, print the brief
//                 source compact                 : print the brief again, keep a gate this task already opened
//   PreToolUse    apply_patch                    : refuse until this task has searched
//                 Bash / shell                   : refuse only a command that writes into the project
//   PostToolUse   this server's recall_search    : a SUCCESSFUL search opens this task's gate
//
// The calling session is the `session_id` the HOST puts in the payload. It is never taken from a
// search argument (that is a filter, the model chose it) or from the MCP server's environment (one
// server can serve several tasks). Refusal is exit code 2 with the reason on stderr.
//
// Honest limits: this is a workflow checkpoint, not a security boundary. It cannot know the
// assistant understood what it read, it does not see every way a shell can write a file, and it
// only works on a Codex build that actually runs hooks and has trusted them.

const isSubagent = (p) => !!(p && (p.is_subagent || p.parent_session_id || p.agent_path || (p.source && typeof p.source === 'object' && p.source.subagent !== undefined)));

// The structured note recall_search attaches to its result, wherever the host's envelope puts it.
function completionOf(resp, depth = 0) {
  if (!resp || depth > 5) return null;
  if (typeof resp === 'string') { try { return completionOf(JSON.parse(resp), depth + 1); } catch { return null; } }
  if (typeof resp !== 'object') return null;
  if (resp.total_recall && typeof resp.total_recall === 'object') return resp.total_recall;
  for (const v of Array.isArray(resp) ? resp : Object.values(resp)) { const r = completionOf(v, depth + 1); if (r) return r; }
  return null;
}

function commandText(input) {
  if (!input) return '';
  const c = input.command !== undefined ? input.command : input.cmd;
  return Array.isArray(c) ? c.join(' ') : String(c || '');
}

function handle(payload, io = { out: process.stdout, err: process.stderr }) {
  if (!payload || typeof payload !== 'object') { io.err.write('total_recall codex-hook: no hook payload on stdin; nothing done\n'); return 0; }
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : undefined;
  let cfg = null;
  try { cfg = loadConfig(cwd); } catch (e) { io.err.write(`total_recall: ${e.message}\n`); return 0; }
  if (!cfg) return 0; // a project that has not opted in is left alone, silently
  const sid = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null;
  const event = payload.hook_event_name || payload.event;
  const tool = String(payload.tool_name || '');

  if (event === 'SessionStart') {
    if (isSubagent(payload)) return 0; // a child agent starting must never re-arm its parent's gate
    const compact = payload.source === 'compact';
    return sessionStart.start(cfg, { sid, client: 'codex', arm: !compact, out: io.out });
  }
  if (event === 'PostToolUse') {
    if (!/recall_search$/.test(tool) || !sid) return 0;
    const done = completionOf(payload.tool_response !== undefined ? payload.tool_response : payload.tool_result);
    // Zero hits is still a search. An error, a refused date, a missing store, another project: not one.
    if (done && done.tool === 'recall_search' && done.ok === true && done.project === cfg.project) gate.ack(cfg.project, sid, 'codex');
    return 0;
  }
  if (event === 'PreToolUse') {
    let r = { ok: true };
    if (/^(apply_patch|Edit|Write)$/i.test(tool)) r = gate.checkEdit(cfg.project, sid, 'codex');
    else if (/^(Bash|shell|exec|local_shell|unified_exec)$/i.test(tool)) r = gate.checkBash(cfg.project, sid, commandText(payload.tool_input), cfg.root, 'codex');
    if (r.ok) return 0;
    io.err.write(r.message + '\n');
    return 2;
  }
  return 0;
}

function command() { return handle(readHookPayload()); }

module.exports = { handle, command, completionOf, isSubagent };
