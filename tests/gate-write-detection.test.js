'use strict';
/**
 * What the Bash gate counts as a write.
 *
 * The original list was four patterns (git commit, sed -i, tee, PowerShell Set-Content) plus
 * redirects and cp/mv. The owner flagged the gap in the 2026-09-18 design review, verbatim:
 * "shell-based file edits are not covered by the proposed Bash gate". It stayed open until
 * 2026-09-19, so `git add`, `git push`, `rm -rf`, `ssh host "..."`, `docker exec`, `npm install`
 * and `touch` all reached the repo without a recall search ever running.
 *
 * Over-blocking is the safe direction: a false positive costs one search, a false negative is an
 * edit made with no memory consulted. But the read-only shapes below are most of the work and
 * MUST stay open, or the gate becomes something to route around.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { isWriteCommand } = require('../lib/gate');

const ROOT = 'C:/Users/eleac/RateMyVSO_Platform';

const WRITES = [
  // git, by mutating subcommand. Only `commit` was caught before.
  'git add -A', 'git commit -m "x"', 'git push origin master', 'git checkout -- file.js',
  'git reset --hard origin/main', 'git stash', 'git rm old.js', 'git apply patch.diff',
  // Deleting and truncating is writing; nothing covered removal at all.
  'rm -rf build', 'rmdir old', 'truncate -s 0 log.txt', 'Remove-Item foo.txt',
  // Creating, linking, permissions.
  'touch new.js', 'mkdir -p a/b', 'chmod +x deploy.sh', 'ln -s a b',
  // In-place editors.
  'sed -i s/a/b/ f.js', 'perl -i -pe "s/a/b/" f.js',
  // Another machine or container is still production.
  'ssh deploy@80.190.75.182 "sudo rm -rf /app/data"', 'scp local.js host:/remote.js',
  'docker exec container node -e "1"', 'rsync -a ./ host:/srv/',
  // Installers rewrite the tree.
  'npm install', 'pip install requests',
  // Still caught by the original mechanisms.
  'echo hi > out.txt', 'cp a.js b.js', 'tee out.txt', 'dd if=a of=b',
];

const READS = [
  'git log --oneline -3', 'git status --porcelain', 'git diff --stat', 'git show HEAD:file.js',
  'cat file.js', 'grep -n pattern file.js', 'ls -la', 'head -20 file.js',
  'node --test tests/gate.test.js', 'curl -s https://example.com/', 'node -e "console.log(1)"',
];

test('every mutating shape is treated as a write', () => {
  const missed = WRITES.filter((c) => !isWriteCommand(c, ROOT));
  assert.deepStrictEqual(missed, [], `these would reach the repo with no recall search:\n${missed.join('\n')}`);
});

test('read-only work stays open, or the gate becomes something to route around', () => {
  const blocked = READS.filter((c) => isWriteCommand(c, ROOT));
  assert.deepStrictEqual(blocked, [], `these are reads and must not be gated:\n${blocked.join('\n')}`);
});

test('a recall invocation never gates itself, even when its query text says "git commit"', () => {
  // The exemption that existed before and must survive the widening: query arguments are DATA.
  assert.strictEqual(
    isWriteCommand('node C:/Users/eleac/total_recall/bin/total_recall.js search "git commit rm -rf"', ROOT),
    false,
  );
  // ...but a recall command that redirects its output into the project is still a write.
  assert.strictEqual(
    isWriteCommand('node C:/Users/eleac/total_recall/bin/total_recall.js search "x" > notes.md', ROOT),
    true,
  );
});
