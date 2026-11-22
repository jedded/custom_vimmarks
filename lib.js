'use strict';
// Pure logic (no vscode dependency) so it can be unit-tested with plain node.

const ORDER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function isLetter(s) {
  return typeof s === 'string' && s.length === 1 && ORDER.includes(s);
}

/** Oldest first (the order the marks were created in). Returns a new array. */
function sortByCreation(marks) {
  return marks.slice().sort((a, b) => a.seq - b.seq);
}

/**
 * Group marks by file for the "grouped by file" view.
 * Files are ordered by path, marks inside a file by position (line, then column).
 * Returns [{ uri, marks }].
 */
function groupByFile(marks) {
  const byUri = new Map();
  for (const m of marks) {
    if (!byUri.has(m.uri)) byUri.set(m.uri, []);
    byUri.get(m.uri).push(m);
  }
  const groups = [];
  for (const [uri, list] of byUri) {
    list.sort((a, b) => a.line - b.line || a.col - b.col);
    groups.push({ uri, marks: list });
  }
  groups.sort((a, b) => {
    const x = a.uri.toLowerCase();
    const y = b.uri.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return groups;
}

/** The two view modes are 'created' and 'file'. Anything else (e.g. the old 'letter') becomes 'created'. */
function normalizeSortMode(v) {
  return v === 'file' ? 'file' : 'created';
}

/** Next creation number for a list of marks. */
function nextSeq(marks) {
  return marks.reduce((a, m) => Math.max(a, m.seq || 0), 0) + 1;
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

/**
 * The file may have changed while a mark was not being tracked (e.g. its project was
 * inactive in another window). If the remembered line text is no longer at `line`,
 * look for the nearest identical line. Returns the (possibly new) line.
 */
function relocateLine(getText, lineCount, line, text, radius = 300) {
  const want = (text || '').trim();
  if (!want) return line;
  const at = (n) => n >= 0 && n < lineCount && getText(n).trim() === want;
  if (at(line)) return line;
  for (let d = 1; d <= radius; d++) {
    if (at(line - d)) return line - d;
    if (at(line + d)) return line + d;
  }
  return line;
}

// ---------- projects ----------

/** Returns an error message, or undefined when the name is fine. */
function validateProjectName(name, existing) {
  if (typeof name !== 'string') return 'Enter a name';
  const n = name.trim();
  if (!n) return 'Name cannot be empty';
  if (n.length > 40) return 'Name can be at most 40 characters';
  if (existing.some((e) => e.toLowerCase() === n.toLowerCase())) {
    return 'A project with this name already exists';
  }
  return undefined;
}

/** A name based on `base` that is not in `existing` yet (case-insensitive): "name", "name-2", ... */
function uniqueName(base, existing) {
  const clean = (typeof base === 'string' ? base.trim() : '').slice(0, 36) || 'imported';
  const taken = (n) => existing.some((e) => e.toLowerCase() === n.toLowerCase());
  if (!taken(clean)) return clean;
  for (let i = 2; ; i++) {
    const cand = `${clean}-${i}`;
    if (!taken(cand)) return cand;
  }
}

// ---------- persistence format ----------

function validMark(m) {
  return !!m && isLetter(m.letter) && typeof m.uri === 'string' &&
    Number.isInteger(m.line) && m.line >= 0 && Number.isInteger(m.col) && m.col >= 0;
}

function cleanMark(m) {
  return {
    letter: m.letter,
    uri: m.uri,
    line: m.line,
    col: m.col,
    text: typeof m.text === 'string' ? m.text : '',
    seq: Number.isFinite(m.seq) ? m.seq : 0,
  };
}

/**
 * Parse marks.json. Returns { order: string[], projects: {name: mark[]} },
 * an empty store for empty text, or null when the text is not a valid store.
 */
function parseStore(text) {
  if (!text || !text.trim()) return { order: [], projects: {} };
  let d;
  try {
    d = JSON.parse(text);
  } catch (e) {
    return null;
  }
  if (!d || typeof d !== 'object' || !d.projects || typeof d.projects !== 'object') return null;
  const order = [];
  if (Array.isArray(d.order)) {
    for (const n of d.order) {
      if (typeof n === 'string' && d.projects[n] !== undefined && !order.includes(n)) order.push(n);
    }
  }
  for (const n of Object.keys(d.projects)) {
    if (!order.includes(n)) order.push(n);
  }
  const projects = {};
  for (const n of order) {
    const list = Array.isArray(d.projects[n]) ? d.projects[n] : [];
    projects[n] = list.filter(validMark).map(cleanMark);
  }
  return { order, projects };
}

function serializeStore(order, projects) {
  return JSON.stringify({ version: 1, order, projects }, null, 2) + '\n';
}

module.exports = {
  ORDER,
  isLetter,
  sortByCreation,
  groupByFile,
  normalizeSortMode,
  nextSeq,
  adjustMarkLine,
  applyChanges,
  relocateLine,
  validateProjectName,
  uniqueName,
  validMark,
  cleanMark,
  parseStore,
  serializeStore,
};
