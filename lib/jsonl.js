'use strict';
const fs = require('node:fs');

// The complete lines of a JSONL file between a byte offset and a fixed end, holding one line at a
// time. It splits on the newline BYTE, so a UTF-8 character cut in two by a read buffer is never
// decoded in halves, and `end` is a snapshot: a file that keeps growing cannot keep a pass running.
//
// Yields { text, start, end } per line (`end` is the byte after its newline: a safe checkpoint).
// A line longer than `maxLine` is never buffered: it yields { oversized: true, head, bytes, start,
// end } with only its first bytes, enough to say what kind of record was skipped. A final line with
// no newline yet is not yielded at all; the next pass picks it up whole.
const HEAD = 2048;

function* readLines(file, opts = {}) {
  const maxLine = opts.maxLine || 16 * 1024 * 1024;
  const chunk = opts.chunk || 1 << 20;
  const fd = fs.openSync(file, 'r');
  try {
    const stop = opts.end === undefined ? fs.fstatSync(fd).size : opts.end;
    const buf = Buffer.allocUnsafe(chunk);
    let pos = opts.start || 0;
    let lineStart = pos, parts = [], held = 0, over = false, head = null;
    const keep = (piece) => {
      if (over) return;
      if (held + piece.length > maxLine) {
        over = true;
        head = Buffer.concat([...parts, piece]).subarray(0, HEAD).toString('utf8');
        parts = [];
        return;
      }
      parts.push(Buffer.from(piece)); held += piece.length; // a copy: `buf` is reused by the next read
    };
    while (pos < stop) {
      const n = fs.readSync(fd, buf, 0, Math.min(chunk, stop - pos), pos);
      if (n <= 0) break;
      const view = buf.subarray(0, n);
      let from = 0;
      for (;;) {
        const nl = view.indexOf(10, from);
        if (nl === -1) { keep(view.subarray(from)); break; }
        keep(view.subarray(from, nl));
        const end = pos + nl + 1;
        if (over) yield { oversized: true, head, bytes: end - lineStart, start: lineStart, end };
        else {
          let text = Buffer.concat(parts).toString('utf8');
          if (text.endsWith('\r')) text = text.slice(0, -1);
          if (text.trim()) yield { text, start: lineStart, end };
        }
        lineStart = end; parts = []; held = 0; over = false; head = null;
        from = nl + 1;
      }
      pos += n;
    }
  } finally { fs.closeSync(fd); }
}

module.exports = { readLines };
