'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, canon } = require('./config');

// An explicit registry, never a crawl of the user's disk. Entries name config roots.
// { projects: [{ root: '/work/project', aliases: ['Display name'] }] }
function inventory(current, registryFile) {
  const file = registryFile || current?.projectRegistry || path.join(os.homedir(), '.total_recall', 'projects.json');
  let entries = [];
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw.projects)) throw new Error('project registry needs a projects array');
    entries = raw.projects.map((e) => {
      if (!e || typeof e.root !== 'string') throw new Error('each registered project needs a root');
      const cfg = loadConfig(path.resolve(path.dirname(file), e.root));
      if (!cfg) throw new Error(`registered project has no config: ${e.root}`);
      return { cfg, aliases: [...cfg.projectAliases, ...(e.aliases || [])] };
    });
  }
  if (current) entries.push({ cfg: current, aliases: current.projectAliases || [] });
  const byFile = new Map();
  for (const e of entries) {
    const k = canon(e.cfg.file);
    const prev = byFile.get(k);
    byFile.set(k, { cfg: e.cfg, aliases: [...new Set([...(prev?.aliases || []), ...e.aliases])] });
  }
  return [...byFile.values()];
}

function resolve(args = {}, ctx = {}) {
  const caller = loadConfig(ctx.root);
  const explicit = typeof args.root === 'string' ? loadConfig(args.root) : null;
  if (args.root && !explicit) throw new Error(`no project config at ${args.root}`);
  const current = explicit || caller;
  if (!args.project) {
    if (!current) throw new Error('no current project; give --root or a registered --project');
    return { cfg: current, caller };
  }
  const key = String(args.project).toLocaleLowerCase('en-US');
  const matches = inventory(current, ctx.registryFile).filter((e) =>
    [e.cfg.project, ...e.aliases].some((n) => String(n).toLocaleLowerCase('en-US') === key));
  if (matches.length !== 1) throw new Error(`${matches.length ? 'ambiguous' : 'unknown'} project "${args.project}"; use inventory projects or register an exact alias`);
  const cfg = matches[0].cfg;
  if (explicit && canon(explicit.file) !== canon(cfg.file)) throw new Error('--root and --project select different projects');
  return { cfg, caller };
}

module.exports = { resolve, inventory };
