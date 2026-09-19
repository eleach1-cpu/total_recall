'use strict';

function glob(pattern) {
  if (typeof pattern !== 'string' || !pattern.length || pattern.length > 1000) throw new Error('pattern needs 1 to 1000 characters');
  let r = '', escaped = false;
  for (const c of pattern) {
    if (escaped) { r += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); escaped = false; }
    else if (c === '\\') escaped = true;
    else if (c === '*') { if (!r.endsWith('[\\s\\S]*')) r += '[\\s\\S]*'; }
    else if (c === '?') r += '[\\s\\S]';
    else r += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  if (escaped) throw new Error('pattern ends with an unfinished escape');
  return r;
}

function expression(query, mode = 'any') {
  const q = String(query || '').trim();
  if (!q || (q === '*' && ['any','all'].includes(mode))) return null;
  if (q.length > 2000) throw new Error('query is too long (maximum 2000 characters)');
  if (mode === 'substring') return { pattern: q };
  if (mode === 'advanced') {
    // SQLite validates the actual FTS5 grammar before execution. Only title/body are searchable;
    // this cannot become SQL, and no alternate query is tried after an error.
    return { match: q };
  }
  if (mode === 'phrase') return { match: `"${q.replace(/"/g, '""')}"` };
  if (!['any', 'all'].includes(mode)) throw new Error('match must be any, all, phrase, advanced or substring');
  const terms = []; let pos = 0;
  const re = /\s*("(?:[^"]|"")*"|[^\s"]+)/gy;
  while (pos < q.length) {
    re.lastIndex = pos; const m = re.exec(q);
    if (!m) throw new Error('unfinished quoted phrase');
    terms.push(m[1].startsWith('"') ? m[1] : `"${m[1].replace(/"/g, '""')}"`); pos = re.lastIndex;
  }
  return { match: terms.join(mode === 'all' ? ' AND ' : ' OR ') };
}
module.exports = { expression, glob };
