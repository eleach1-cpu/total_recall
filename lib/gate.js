'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig, noConfigMessage } = require('./config');
const { readHookPayload, resolveSessionId } = require('./session');

function home() { return process.env.TOTAL_RECALL_HOME || path.join(os.homedir(), '.total_recall'); }

// One marker per (project, calling client, host session). A Claude session keeps the marker it
// always had, so nothing about a working Claude install moves; any other client lives in its own
// folder, so a search in one client can never open the other's gate even with identical ids. An id
// that is not a plain token is hashed instead of being trusted as a path fragment.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const hashed = (s) => 'h-' + crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
function markerPath(project, sid, client) {
  const proj = SAFE_ID.test(String(project)) ? String(project) : hashed(project);
  const id = SAFE_ID.test(String(sid)) ? String(sid) : hashed(sid);
  if (!client || client === 'claude') return path.join(home(), 'gate', proj, id);
  return path.join(home(), 'gate', proj, SAFE_ID.test(client) ? client : hashed(client), id);
}

function ack(project, sid, client) {
  const p = markerPath(project, sid, client);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, new Date().toISOString());
}
function arm(project, sid, client) { try { fs.unlinkSync(markerPath(project, sid, client)); } catch {} }
function isOpen(project, sid, client) {
  if (!sid) return false;
  try { return fs.statSync(markerPath(project, sid, client)).isFile(); } catch { return false; }
}

function blockMessage(sid, client) {
  const how = client === 'codex' ? 'call the recall_search tool with' : 'run  total_recall search';
  return `BLOCKED by total_recall: ${how} "<the files or topic you are about to touch>"  first. (session ${sid})`;
}

function checkEdit(project, sid, client) {
  if (!sid) return { ok: false, message: 'BLOCKED by total_recall: no session id (hook stdin session_id or CLAUDE_CODE_SESSION_ID); run  total_recall gate --ack --session <id>  after a search.' };
  if (isOpen(project, sid, client)) return { ok: true, message: '' };
  return { ok: false, message: blockMessage(sid, client) };
}

// Heuristic, documented as one in the spec: catches the common write shapes, not every one.
const WRITE_VERBS = [
  /\bgit\s+commit\b/, /\bsed\s+-i\b/, /\btee\s+\S/, /\b(Set-Content|Out-File|Add-Content)\b/i,
  /\b(node\s+-e|python3?\s+-c)\b[\s\S]*\b(writeFile|open\([^)]*['"]w)/,
];
const REDIRECT = /(^|[^<>])>{1,2}\s*([^\s&|;]+)/g;
const COPY_MOVE = /\b(cp|mv)\s+(?:-\S+\s+)*\S+\s+(\S+)/g;

function underProject(target, root) {
  const t = String(target).replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  if (/^\/tmp\b|\/temp\/|appdata\/local\/temp/i.test(t)) return false;
  if (/^([A-Za-z]:)?\//.test(t)) return root ? t.toLowerCase().startsWith(String(root).replace(/\\/g, '/').toLowerCase()) : false;
  return true; // relative paths are inside the project cwd
}

function isWriteCommand(command, root) {
  const c = String(command || '');
  // The recall command itself is always allowed: it is how the gate gets opened.
  if (/\btotal_recall(\.js)?["']?\s+(search|brief|gate|decide|decisions)\b/.test(c)) return false;
  if (WRITE_VERBS.some((re) => re.test(c))) return true;
  for (const m of c.matchAll(REDIRECT)) if (underProject(m[2], root)) return true;
  for (const m of c.matchAll(COPY_MOVE)) if (underProject(m[2], root)) return true;
  return false;
}

function checkBash(project, sid, command, root, client) {
  if (!isWriteCommand(command, root)) return { ok: true, message: '' };
  return checkEdit(project, sid, client);
}

function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const client = args.flags.client === 'codex' ? 'codex' : 'claude';
  const payload = (args.flags.check || args.flags['check-bash'] || args.flags.arm) ? readHookPayload() : null;
  const sid = resolveSessionId({ payload, flags: args.flags, client });
  if (args.flags.arm) { if (sid) arm(cfg.project, sid, client); return 0; }
  if (args.flags.ack) {
    if (!sid) { process.stderr.write('total_recall: no session id; gate not touched\n'); return 1; }
    ack(cfg.project, sid, client); process.stdout.write(`total_recall: gate opened by hand for ${client} session ${sid}\n`); return 0;
  }
  let r;
  if (args.flags['check-bash']) {
    const cmd = payload && payload.tool_input ? payload.tool_input.command : '';
    r = checkBash(cfg.project, sid, cmd, cfg.root, client);
  } else if (args.flags.check) {
    r = checkEdit(cfg.project, sid, client);
  } else {
    process.stderr.write('total_recall gate: one of --arm --check --check-bash --ack\n'); return 1;
  }
  if (r.ok) return 0;
  process.stderr.write(r.message + '\n');
  return 2;
}

module.exports = { markerPath, arm, ack, isOpen, checkEdit, checkBash, isWriteCommand, command };
