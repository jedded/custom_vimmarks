'use strict';
// Pure logic (no vscode dependency) so it can be unit-tested with plain node.

const ORDER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function isLetter(s) {
  return typeof s === 'string' && s.length === 1 && ORDER.includes(s);
}

/** mode: 'created' (oldest first) or 'letter' (a-z then A-Z). Returns a new array. */
function sortMarks(marks, mode) {
  const arr = marks.slice();
  if (mode === 'letter') {
    arr.sort((a, b) => ORDER.indexOf(a.letter) - ORDER.indexOf(b.letter));
  } else {
    arr.sort((a, b) => a.seq - b.seq);
  }
  return arr;
}

/**
 * Where does a mark on `line` end up after one text change?
 * ch = { startLine, startCol, endLine, isInsert, newLineCount, endsWithNewline }
 * (positions are relative to the document BEFORE the change)
 */
function adjustMarkLine(line, ch) {
  const removed = ch.endLine - ch.startLine;
  const delta = ch.newLineCount - removed;
  // Inserting whole line(s) at column 0 (e.g. `O`) pushes the current line down.
  if (ch.isInsert && ch.startCol === 0 && ch.endsWithNewline && line >= ch.startLine) {
    return line + delta;
  }
  if (line <= ch.startLine) return line;
  if (line > ch.endLine) return line + delta;
  // Line was inside the replaced region.
  return ch.startLine + Math.min(line - ch.startLine, ch.newLineCount);
}

/** Apply several changes of one edit (all relative to the old document). Mutates marks. */
function applyChanges(marks, changes) {
  const sorted = changes
    .slice()
    .sort((a, b) => b.startLine - a.startLine || b.startCol - a.startCol);
  for (const ch of sorted) {
    for (const m of marks) {
      m.line = adjustMarkLine(m.line, ch);
    }
  }
}

module.exports = { ORDER, isLetter, sortMarks, adjustMarkLine, applyChanges };
