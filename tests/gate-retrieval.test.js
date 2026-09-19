'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../lib/gate');

const root = 'C:/work/demo';
const tool = 'node C:/tools/total_recall/bin/total_recall.js';
const allowed = (command) => {
  assert.equal(gate.isWriteCommand(command, root), false, command);
  assert.equal(gate.checkBash('demo', null, command, root, 'codex').ok, true, command);
};
const blocked = (command) => {
  assert.equal(gate.isWriteCommand(command, root), true, command);
  assert.equal(gate.checkBash('demo', null, command, root, 'codex').ok, false, command);
};

test('retrieval commands do not treat quoted question words as shell writes', () => {
  for (const command of ['search', 'recall', 'find', 'read', 'inventory', 'inspect-coverage', 'brief']) {
    allowed(`${tool} ${command} "Why did we decide to git commit this?" --words`);
    allowed(`${tool} ${command} 'What did Set-Content, tee src/file and a > b mean?'`);
    allowed(`${tool} ${command} "Did we use a && b; c | d, then git commit?"`);
  }
  allowed('total_recall recall "Why did we git commit?"');
  allowed('node --no-warnings /opt/tools/total_recall/bin/total_recall.js find "git commit"');
  allowed('& "C:\\Program Files\\nodejs\\node.exe" "C:\\my tools\\total_recall\\bin\\total_recall.js" recall "Why git commit?"');
});

test('legacy gate and decision commands retain their argument exemption', () => {
  for (const command of ['gate', 'decide', 'decisions']) {
    allowed(`${tool} ${command} --quote "Never git commit without approval"`);
  }
});

test('a retrieval invocation never exempts another shell command before or after it', () => {
  const query = `${tool} recall "Why did we git commit?" --words`;
  for (const tail of [
    '; git commit -m change',
    ' && sed -i "s/a/b/" src/file.js',
    ' || Set-Content -Path notes.md -Value changed',
    ' | tee src/output.txt',
    '\necho changed > notes.md',
    ' & cp from.txt src/to.txt',
  ]) blocked(query + tail);
  blocked(`git commit -m change; ${query}`);
  blocked(`echo "total_recall search query"; git commit -m change`);
  blocked(`${tool} search "old command"; git commit -m change`);
  allowed(`${query}; git status`);
  allowed(`${query} && ${tool} find 'A literal git commit; not a second command' --words`);
});

test('real retrieval output redirection still checks its destination', () => {
  blocked(`${tool} recall "Why git commit?" > report.md`);
  blocked(`${tool} find "history" >> "C:/work/demo/two words.md"`);
  allowed(`${tool} recall "Why git commit?" > /tmp/report.md`);
  allowed(`${tool} find "history" > "C:/Temp/two words.md"`);
  allowed(`${tool} recall "Why git commit?" 2>&1`);
});

test('shell substitutions and wrappers are not given a blanket retrieval exemption', () => {
  blocked(`${tool} recall "$(git commit -m change)"`);
  blocked(`${tool} find "history" $(Set-Content notes.md changed)`);
  blocked(`${tool} recall "\`git commit -m change\`"`);
  blocked(`bash -c '${tool} recall history; git commit -m change'`);
  allowed(`${tool} recall 'Literal $(git commit) and \`git commit\` text'`);
});
