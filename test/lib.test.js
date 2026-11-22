'use strict';
const assert = require('assert');
const { isLetter, sortMarks, adjustMarkLine, applyChanges } = require('../lib');

let passed = 0;
function t(name, fn) {
  fn();
  passed += 1;
  console.log('ok -', name);
}

t('isLetter accepts a-z/A-Z only', () => {
  assert.ok(isLetter('a') && isLetter('Z'));
  assert.ok(!isLetter('') && !isLetter('ab') && !isLetter('1') && !isLetter(undefined));
});

t('sortMarks: creation order vs letter order', () => {
  const ms = [
    { letter: 'q', seq: 3 },
    { letter: 'B', seq: 1 },
    { letter: 'a', seq: 2 },
  ];
  assert.deepStrictEqual(sortMarks(ms, 'created').map((m) => m.letter), ['B', 'a', 'q']);
  assert.deepStrictEqual(sortMarks(ms, 'letter').map((m) => m.letter), ['a', 'q', 'B']);
  // original array is not mutated
  assert.deepStrictEqual(ms.map((m) => m.letter), ['q', 'B', 'a']);
});

t('open line above (O) pushes the current line down', () => {
  const ch = { startLine: 5, startCol: 0, endLine: 5, isInsert: true, newLineCount: 1, endsWithNewline: true };
  assert.strictEqual(adjustMarkLine(3, ch), 3);
  assert.strictEqual(adjustMarkLine(5, ch), 6);
  assert.strictEqual(adjustMarkLine(9, ch), 10);
});

t('open line below (o) keeps the current line', () => {
  const ch = { startLine: 5, startCol: 10, endLine: 5, isInsert: true, newLineCount: 1, endsWithNewline: false };
  assert.strictEqual(adjustMarkLine(5, ch), 5);
  assert.strictEqual(adjustMarkLine(6, ch), 7);
});

t('delete a line (dd) moves later marks up, collapses the deleted one', () => {
  const ch = { startLine: 5, startCol: 0, endLine: 6, isInsert: false, newLineCount: 0, endsWithNewline: false };
  assert.strictEqual(adjustMarkLine(4, ch), 4);
  assert.strictEqual(adjustMarkLine(5, ch), 5);
  assert.strictEqual(adjustMarkLine(6, ch), 5);
  assert.strictEqual(adjustMarkLine(7, ch), 6);
});

t('typing a character does not move marks', () => {
  const ch = { startLine: 5, startCol: 0, endLine: 5, isInsert: true, newLineCount: 0, endsWithNewline: false };
  for (const l of [0, 5, 9]) assert.strictEqual(adjustMarkLine(l, ch), l);
});

t('delete several lines collapses marks inside the region', () => {
  const ch = { startLine: 2, startCol: 0, endLine: 6, isInsert: false, newLineCount: 0, endsWithNewline: false };
  assert.strictEqual(adjustMarkLine(4, ch), 2);
  assert.strictEqual(adjustMarkLine(10, ch), 6);
});

t('multi-cursor edit: changes are applied highest first', () => {
  const marks = [{ line: 1 }, { line: 4 }, { line: 8 }];
  const changes = [
    { startLine: 2, startCol: 0, endLine: 2, isInsert: true, newLineCount: 1, endsWithNewline: true },
    { startLine: 6, startCol: 0, endLine: 6, isInsert: true, newLineCount: 1, endsWithNewline: true },
  ];
  applyChanges(marks, changes);
  assert.deepStrictEqual(marks.map((m) => m.line), [1, 5, 10]);
});

console.log(`\n${passed} tests passed`);
