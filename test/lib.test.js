'use strict';
const assert = require('assert');
const {
  isLetter, sortByCreation, groupByFile, normalizeSortMode, nextSeq, adjustMarkLine, applyChanges,
  relocateLine, validateProjectName, uniqueName, parseStore, serializeStore,
} = require('../lib');

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

t('sortByCreation: oldest first, input not mutated', () => {
  const ms = [
    { letter: 'q', seq: 3 },
    { letter: 'B', seq: 1 },
    { letter: 'a', seq: 2 },
  ];
  assert.deepStrictEqual(sortByCreation(ms).map((m) => m.letter), ['B', 'a', 'q']);
  assert.deepStrictEqual(ms.map((m) => m.letter), ['q', 'B', 'a']);
});

t('groupByFile: files by path, marks by line then column', () => {
  const ms = [
    { letter: 'a', uri: 'file:///p/B.c', line: 5, col: 0, seq: 1 },
    { letter: 'b', uri: 'file:///p/a.c', line: 9, col: 0, seq: 2 },
    { letter: 'c', uri: 'file:///p/a.c', line: 1, col: 7, seq: 3 },
    { letter: 'd', uri: 'file:///p/a.c', line: 1, col: 2, seq: 4 },
  ];
  const g = groupByFile(ms);
  assert.deepStrictEqual(g.map((x) => x.uri), ['file:///p/a.c', 'file:///p/B.c']); // case-insensitive
  assert.deepStrictEqual(g[0].marks.map((m) => m.letter), ['d', 'c', 'b']);
  assert.deepStrictEqual(g[1].marks.map((m) => m.letter), ['a']);
  assert.deepStrictEqual(groupByFile([]), []);
});

t('normalizeSortMode: only "file" is kept, anything else is creation order', () => {
  assert.strictEqual(normalizeSortMode('file'), 'file');
  assert.strictEqual(normalizeSortMode('created'), 'created');
  assert.strictEqual(normalizeSortMode('letter'), 'created'); // value saved by v0.3.0
  assert.strictEqual(normalizeSortMode(undefined), 'created');
});

t('nextSeq continues after the highest number', () => {
  assert.strictEqual(nextSeq([]), 1);
  assert.strictEqual(nextSeq([{ seq: 4 }, { seq: 2 }]), 5);
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

t('relocateLine finds the remembered text near the old line', () => {
  const lines = ['x', 'y', 'target', 'z', 'w', 'q'];
  const get = (n) => lines[n];
  assert.strictEqual(relocateLine(get, lines.length, 2, 'target'), 2); // still in place
  assert.strictEqual(relocateLine(get, lines.length, 0, '  target  '), 2); // moved down
  assert.strictEqual(relocateLine(get, lines.length, 5, 'target'), 2); // moved up
  assert.strictEqual(relocateLine(get, lines.length, 4, 'gone'), 4); // not found -> unchanged
  assert.strictEqual(relocateLine(get, lines.length, 4, '   '), 4); // blank text -> unchanged
});

t('relocateLine prefers the nearest identical line', () => {
  const lines = ['a', 'dup', 'b', 'c', 'd', 'dup', 'e'];
  const get = (n) => lines[n];
  assert.strictEqual(relocateLine(get, lines.length, 4, 'dup'), 5);
  assert.strictEqual(relocateLine(get, lines.length, 2, 'dup'), 1);
});

t('validateProjectName', () => {
  assert.strictEqual(validateProjectName('seL4 study', ['default']), undefined);
  assert.ok(validateProjectName('', ['default']));
  assert.ok(validateProjectName('   ', ['default']));
  assert.ok(validateProjectName('Default', ['default'])); // case-insensitive duplicate
  assert.ok(validateProjectName('x'.repeat(41), []));
  assert.strictEqual(validateProjectName('x'.repeat(40), []), undefined);
  assert.ok(validateProjectName(undefined, []));
});

t('uniqueName: never returns a name that is already taken', () => {
  assert.strictEqual(uniqueName('seL4', ['default']), 'seL4');
  assert.strictEqual(uniqueName('seL4', ['default', 'sel4']), 'seL4-2'); // case-insensitive
  assert.strictEqual(uniqueName('seL4', ['seL4', 'seL4-2']), 'seL4-3');
  assert.strictEqual(uniqueName(undefined, []), 'imported');
  assert.strictEqual(uniqueName('   ', ['imported']), 'imported-2');
  assert.ok(uniqueName('x'.repeat(80), []).length <= 40);
});

t('store: serialize -> parse round trip', () => {
  const order = ['default', 'seL4'];
  const projects = {
    default: [{ letter: 'q', uri: 'file:///a.c', line: 3, col: 1, text: 'int x;', seq: 1 }],
    seL4: [],
  };
  const back = parseStore(serializeStore(order, projects));
  assert.deepStrictEqual(back.order, order);
  assert.deepStrictEqual(back.projects, projects);
});

t('store: empty text is an empty store, garbage is rejected', () => {
  assert.deepStrictEqual(parseStore(''), { order: [], projects: {} });
  assert.strictEqual(parseStore('{not json'), null);
  assert.strictEqual(parseStore('[]'), null);
  assert.strictEqual(parseStore('{"projects": 3}'), null);
});

t('store: invalid marks are dropped, missing order is rebuilt', () => {
  const text = JSON.stringify({
    projects: {
      b: [{ letter: 'a', uri: 'file:///x', line: 0, col: 0 }, { letter: '1', uri: 'file:///x', line: 0, col: 0 }, null],
      a: 'oops',
    },
    order: ['ghost', 'b'],
  });
  const s = parseStore(text);
  assert.deepStrictEqual(s.order, ['b', 'a']);
  assert.strictEqual(s.projects.b.length, 1);
  assert.strictEqual(s.projects.b[0].text, '');
  assert.deepStrictEqual(s.projects.a, []);
});

console.log(`\n${passed} tests passed`);
