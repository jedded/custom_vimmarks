'use strict';
// Checks the key bindings in package.json (written by scripts/gen_keybindings.py).
// Usage: node test/keys.test.js
const assert = require('assert');
const path = require('path');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const kb = pkg.contributes.keybindings;
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const keyName = (l) => (l === l.toUpperCase() ? 'shift+' + l.toLowerCase() : l);
const find = (key) => kb.filter((b) => b.key === key);
let n = 0;
const ok = (msg) => console.log('ok -', msg, `(${++n})`);

const seen = new Set();
for (const b of kb) {
  const id = `${b.key} | ${b.when}`;
  assert.ok(!seen.has(id), 'duplicate binding: ' + id);
  seen.add(id);
}
ok(`${kb.length} bindings, no duplicates`);

// Plain-letter chords would swallow typed text, so they must stay limited to Vim normal mode.
for (const b of kb) {
  if (/^[m'`,] /.test(b.key)) {
    assert.strictEqual(b.when.includes("vim.active && vim.mode == 'Normal'"), true, `${b.key}: ${b.when}`);
  }
}
ok("m / ' / ` / , chords only work in Vim normal mode");

// Without Vim: Ctrl+Alt+K, then the letter = m + letter. Works in any mode, needs only editor focus.
for (const l of LETTERS) {
  const k = keyName(l);
  const mine = find(`ctrl+alt+k ${k}`);
  assert.strictEqual(mine.length, 1, `ctrl+alt+k ${k}`);
  assert.deepStrictEqual(
    { command: mine[0].command, args: mine[0].args, when: mine[0].when },
    { command: 'vimMarks.set', args: l, when: 'editorTextFocus' }
  );
  const vim = find(`m ${k}`);
  assert.ok(vim.length === 1 && vim[0].command === mine[0].command && vim[0].args === mine[0].args, `m ${k}`);
}
ok('ctrl+alt+k <letter> sets the same mark as m <letter> (a-z, A-Z), only needs editor focus');

// Without Vim: Ctrl+Alt+J, then the letter = ` + letter (back to the exact position).
for (const l of LETTERS) {
  const k = keyName(l);
  const mine = find(`ctrl+alt+j ${k}`);
  assert.strictEqual(mine.length, 1, `ctrl+alt+j ${k}`);
  assert.deepStrictEqual(
    { command: mine[0].command, args: mine[0].args, when: mine[0].when },
    { command: 'vimMarks.jumpExact', args: l, when: 'editorTextFocus' }
  );
  const vim = find('` ' + k);
  assert.ok(vim.length === 1 && vim[0].command === mine[0].command && vim[0].args === mine[0].args, '` ' + k);
}
ok('ctrl+alt+j <letter> jumps like ` <letter> (a-z, A-Z), only needs editor focus');

console.log(`\nkeys test passed (${n} checks)`);
