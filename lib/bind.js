'use strict';
const fs = require('node:fs');
const { canon, isUnder, mainCheckoutOf } = require('./config');
const { sha256 } = require('./store');

// Does this Codex conversation belong to this project? Decided from what the session recorded
// about itself (its working directory, its git remote) and from explicit config. What the
// conversation talks about is never evidence: a chat that mentions the project is not in it.
//
//   project     cwd is a project root or inside one; or a live git worktree of one; or the
//               session's git remote is listed in projectRepos; or cwd is under a historicalRoot;
//               or the thread id is listed in includeSessions
//   excluded    the session recorded a different place
//   unresolved  the session's directory is gone and nothing else identifies it: reported, skipped
const normRepo = (u) => String(u || '').trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '').replace(/^git@([^:]+):/, 'https://$1/');

// A historical root may use * for exactly one path segment (the temporary worktree id).
function underPattern(dir, pattern) {
  const d = canon(dir).split('/'), p = canon(pattern).split('/');
  if (d.length < p.length) return false;
  return p.every((seg, i) => seg === '*' || seg === d[i]);
}

function bindSession(meta, cfg) {
  if (!meta) return { bind: 'unresolved', reason: 'no session header' };
  if ((cfg.includeSessions || []).some((s) => s === meta.thread || s === `codex:${meta.thread}`)) return { bind: 'project', reason: 'includeSessions' };
  const roots = cfg.projectRoots && cfg.projectRoots.length ? cfg.projectRoots : [cfg.root];
  if (meta.cwd) {
    if (roots.some((r) => isUnder(meta.cwd, r))) return { bind: 'project', reason: 'cwd in a project root' };
    if ((cfg.historicalRoots || []).some((h) => underPattern(meta.cwd, h))) return { bind: 'project', reason: 'cwd in a historical root' };
    let exists = false; try { exists = fs.statSync(meta.cwd).isDirectory(); } catch {}
    if (exists) {
      const main = mainCheckoutOf(meta.cwd);
      if (main && roots.some((r) => canon(main) === canon(r))) return { bind: 'project', reason: 'a git worktree of a project root' };
    }
  }
  const repos = (cfg.projectRepos || []).map(normRepo);
  if (meta.repo && repos.includes(normRepo(meta.repo))) return { bind: 'project', reason: 'git remote listed in projectRepos' };
  if (meta.repo) return { bind: 'excluded', reason: 'another repository' };
  if (meta.cwd) {
    let exists = false; try { exists = fs.statSync(meta.cwd).isDirectory(); } catch {}
    // A directory that still exists and is not ours is simply another project. One that is gone,
    // under a worktree parent, might have been ours: say so instead of guessing.
    if (exists || !/[\\/]worktrees[\\/]/i.test(meta.cwd)) return { bind: 'excluded', reason: 'another directory' };
    return { bind: 'unresolved', reason: 'worktree removed, no git remote recorded' };
  }
  return { bind: 'unresolved', reason: 'no working directory recorded' };
}

// A verdict is cached per file and redone when the inputs that decide it change.
const bindingSha = (cfg) => sha256(JSON.stringify([cfg.projectRoots || [cfg.root], cfg.projectRepos || [], cfg.historicalRoots || [], cfg.includeSessions || []])).slice(0, 16);

module.exports = { bindSession, bindingSha, normRepo, underPattern };
