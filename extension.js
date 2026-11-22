'use strict';
const vscode = require('vscode');
const lib = require('./lib');

const STATE_MARKS = 'vimMarks.marks';
const STATE_SORT = 'vimMarks.sort';
const STATE_SEQ = 'vimMarks.seq';

/** @type {{letter:string, uri:string, line:number, col:number, text:string, seq:number}[]} */
let marks = [];
let sortMode = 'created';
let seq = 0;
let ctx;
let provider;
let treeView;
let saveTimer;
const decoTypes = new Map();

// ---------- helpers ----------

function letterSvg(letter) {
  const upper = letter === letter.toUpperCase();
  const bg = upper ? '#e5c07b' : '#61afef';
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
    `<rect x="1" y="1" width="14" height="14" rx="3" fill="${bg}"/>` +
    '<text x="8" y="12" font-size="11" font-family="monospace" font-weight="bold" ' +
    `text-anchor="middle" fill="#1e1e1e">${letter}</text></svg>`;
  return vscode.Uri.parse('data:image/svg+xml;utf8,' + encodeURIComponent(svg));
}

function baseName(uriString) {
  const p = vscode.Uri.parse(uriString).path;
  return p.split('/').pop() || p;
}

function say(msg) {
  vscode.window.setStatusBarMessage(msg, 2500);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    ctx.workspaceState.update(STATE_MARKS, marks);
    ctx.workspaceState.update(STATE_SEQ, seq);
  }, 300);
}

// ---------- gutter decorations ----------

function getDecoType(letter) {
  let t = decoTypes.get(letter);
  if (!t) {
    t = vscode.window.createTextEditorDecorationType({
      gutterIconPath: letterSvg(letter),
      gutterIconSize: 'contain',
    });
    decoTypes.set(letter, t);
  }
  return t;
}

function refreshDecorations(editor) {
  const key = editor.document.uri.toString();
  const here = new Map();
  for (const m of marks) {
    if (m.uri === key) here.set(m.letter, m);
  }
  const letters = new Set([...decoTypes.keys(), ...here.keys()]);
  for (const l of letters) {
    const type = getDecoType(l);
    const m = here.get(l);
    if (m && m.line < editor.document.lineCount) {
      const p = new vscode.Position(m.line, 0);
      editor.setDecorations(type, [new vscode.Range(p, p)]);
    } else {
      editor.setDecorations(type, []);
    }
  }
}

function refreshAllDecorations() {
  for (const e of vscode.window.visibleTextEditors) refreshDecorations(e);
}

// ---------- tree view ----------

class MarksProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
  }
  refresh() {
    this._emitter.fire(undefined);
  }
  getChildren(element) {
    return element ? [] : lib.sortMarks(marks, sortMode);
  }
  getTreeItem(m) {
    const uri = vscode.Uri.parse(m.uri);
    const item = new vscode.TreeItem(
      `${m.letter}   ${baseName(m.uri)}:${m.line + 1}`,
      vscode.TreeItemCollapsibleState.None
    );
    const preview = (m.text || '').trim();
    item.id = `mark-${m.letter}-${m.seq}`;
    item.description = preview.slice(0, 80);
    item.tooltip = `${uri.fsPath || uri.path}:${m.line + 1}:${m.col + 1}\n${preview}`;
    item.iconPath = letterSvg(m.letter);
    item.contextValue = 'mark';
    item.command = { command: 'vimMarks.open', title: 'Open Mark', arguments: [m.letter] };
    return item;
  }
}

function refreshView() {
  provider.refresh();
  treeView.description = sortMode === 'created' ? 'creation order' : 'letter order';
  treeView.message = marks.length ? undefined : 'No marks yet. In normal mode press m{letter} to set one.';
}

function changed() {
  scheduleSave();
  refreshView();
  refreshAllDecorations();
}

// ---------- commands ----------

async function setMark(arg) {
  let letter = arg;
  if (letter === undefined) {
    letter = await vscode.window.showInputBox({
      prompt: 'Mark letter (a-z, A-Z)',
      validateInput: (v) => (lib.isLetter(v) ? undefined : 'Enter exactly one letter'),
    });
  }
  if (!lib.isLetter(letter)) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const pos = editor.selection.active;
  const doc = editor.document;
  marks = marks.filter((m) => m.letter !== letter);
  seq += 1;
  marks.push({
    letter,
    uri: doc.uri.toString(),
    line: pos.line,
    col: pos.character,
    text: doc.lineAt(pos.line).text,
    seq,
  });
  say(`Mark '${letter}' set at ${baseName(doc.uri.toString())}:${pos.line + 1}`);
  changed();
}

async function openMark(m, exact) {
  const uri = vscode.Uri.parse(m.uri);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const line = Math.max(0, Math.min(m.line, doc.lineCount - 1));
  const lineInfo = doc.lineAt(line);
  const col = exact
    ? Math.min(m.col, lineInfo.text.length)
    : lineInfo.firstNonWhitespaceCharacterIndex;
  const pos = new vscode.Position(line, col);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function jump(arg, exact) {
  let letter = arg;
  if (letter === undefined) {
    const pick = await vscode.window.showQuickPick(
      lib.sortMarks(marks, sortMode).map((m) => ({
        label: m.letter,
        description: `${baseName(m.uri)}:${m.line + 1}`,
        detail: (m.text || '').trim(),
      })),
      { placeHolder: 'Jump to mark' }
    );
    if (!pick) return;
    letter = pick.label;
  }
  const m = marks.find((x) => x.letter === letter);
  if (!m) {
    say(`Mark '${letter}' is not set`);
    return;
  }
  await openMark(m, exact);
}

function letterOf(arg) {
  return typeof arg === 'string' ? arg : arg && arg.letter;
}

function activate(context) {
  ctx = context;
  marks = context.workspaceState.get(STATE_MARKS, []);
  sortMode = context.workspaceState.get(STATE_SORT, 'created');
  seq = context.workspaceState.get(STATE_SEQ, marks.reduce((a, m) => Math.max(a, m.seq || 0), 0));

  provider = new MarksProvider();
  treeView = vscode.window.createTreeView('vimMarks.list', { treeDataProvider: provider });

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('vimMarks.set', setMark),
    vscode.commands.registerCommand('vimMarks.jump', (l) => jump(l, false)),
    vscode.commands.registerCommand('vimMarks.jumpExact', (l) => jump(l, true)),
    vscode.commands.registerCommand('vimMarks.open', (l) => jump(letterOf(l), true)),
    vscode.commands.registerCommand('vimMarks.toggleSort', () => {
      sortMode = sortMode === 'created' ? 'letter' : 'created';
      ctx.workspaceState.update(STATE_SORT, sortMode);
      say(`Marks sorted by ${sortMode === 'created' ? 'creation order' : 'letter'}`);
      refreshView();
    }),
    vscode.commands.registerCommand('vimMarks.delete', (arg) => {
      const l = letterOf(arg);
      marks = marks.filter((m) => m.letter !== l);
      changed();
    }),
    vscode.commands.registerCommand('vimMarks.clear', async () => {
      if (!marks.length) return;
      const ok = await vscode.window.showWarningMessage('Delete all marks?', { modal: true }, 'Delete');
      if (ok === 'Delete') {
        marks = [];
        changed();
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(refreshAllDecorations),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!e.contentChanges.length) return;
      const key = e.document.uri.toString();
      const docMarks = marks.filter((m) => m.uri === key);
      if (!docMarks.length) return;
      const changes = e.contentChanges.map((c) => ({
        startLine: c.range.start.line,
        startCol: c.range.start.character,
        endLine: c.range.end.line,
        isInsert: c.range.isEmpty,
        newLineCount: (c.text.match(/\r\n|\r|\n/g) || []).length,
        endsWithNewline: /\n$/.test(c.text),
      }));
      lib.applyChanges(docMarks, changes);
      for (const m of docMarks) {
        m.line = Math.max(0, Math.min(m.line, e.document.lineCount - 1));
        m.text = e.document.lineAt(m.line).text;
      }
      changed();
    })
  );

  refreshView();
  refreshAllDecorations();
}

function deactivate() {
  clearTimeout(saveTimer);
  if (ctx) {
    ctx.workspaceState.update(STATE_MARKS, marks);
    ctx.workspaceState.update(STATE_SEQ, seq);
  }
}

module.exports = { activate, deactivate };
