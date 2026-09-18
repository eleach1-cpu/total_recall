'use strict';

// Tiny flag parser: `<cmd> [positional...] --k v --flag`. No dependencies.
function parseArgs(argv) {
  const out = { cmd: null, sub: null, flags: {}, positional: [] };
  const rest = [...argv];
  if (rest.length && !rest[0].startsWith('--')) out.cmd = rest.shift();
  while (rest.length) {
    const a = rest.shift();
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (rest.length && !rest[0].startsWith('--')) out.flags[key] = rest.shift();
      else out.flags[key] = true;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

module.exports = { parseArgs };
