'use strict';
// Smoke test: runs the real extension.js against a stub of the vscode API.
// Usage: node test/smoke.js [path-to-extension-folder]
const Module = require('module');
const assert = require('assert');
const path = require('path');

const EXT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');

// ---------- stub of the vscode API ----------
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(s, e) { this.start = s; this.end = e; this.isEmpty = s.line === e.line && s.character === e.character; } }
class Selection { constructor(a, b) { this.anchor = a; this.active = b; } }
class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} }
class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
class ThemeIcon { constructor(id) { this.id = id; } }

const Uri = {
  parse(s) {
    const m = s.match(/^([a-z-]+):\/\/(.*)$/);
    if (!m) return { scheme: 'data', path: s, fsPath: s, toString: () => s };
    return { scheme: m[1], path: m[2], fsPath: m[2], toString: () => s };
  },
  joinPath(base, ...parts) {
    return Uri.parse(base.toString().replace(/\/$/, '') + '/' + parts.join('/'));
  },
};

// in-memory file system (stands for the extension's global storage folder)
const fsFiles = new Map();
const fsMtime = new Map();
let clock = 1000;
const vfs = {
  async createDirectory() {},
  async readFile(uri) {
    const k = uri.toString();
    if (!fsFiles.has(k)) throw new Error('ENOENT');
    return fsFiles.get(k);
  },
  async writeFile(uri, bytes) {
    const k = uri.toString();
    fsFiles.set(k, bytes);
    fsMtime.set(k, ++clock);
  },
  async stat(uri) {
    const k = uri.toString();
    if (!fsMtime.has(k)) throw new Error('ENOENT');
    return { mtime: fsMtime.get(k) };
  },
};
const STORE = 'file:///store/marks.json';
const storeJson = () => JSON.parse(new TextDecoder().decode(fsFiles.get(STORE)));

function memento(map) {
  return {
    get: (k, d) => (map.has(k) ? map.get(k) : d),
    update: (k, v) => {
      if (v === undefined) map.delete(k);
      else map.set(k, v);
      return Promise.resolve();
    },
  };
}

function makeDoc(uriStr, lines) {
  return {
    uri: Uri.parse(uriStr),
    lineCount: lines.length,
    lineAt: (n) => ({ text: lines[n], firstNonWhitespaceCharacterIndex: lines[n].search(/\S|$/) }),
  };
}
let docA = makeDoc('file:///proj/a.c', ['int a;', '  int b;', 'void f() {', '}']);
const docB = makeDoc('file:///proj/b.c', ['#include <x.h>', 'int main() {', '  return 0;', '}']);

const S = {
  commands: new Map(),
  status: [],
  shown: [],
  treeView: null,
  statusItem: null,
  changeHandler: null,
  focusHandler: null,
  activeEditor: null,
  qp: [],
  ib: [],
  warn: 'Delete',
};

const vscode = {
  Uri, Position, Range, Selection, EventEmitter, TreeItem, ThemeIcon,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1 },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  commands: { registerCommand(id, fn) { S.commands.set(id, fn); return { dispose() {} }; } },
  window: {
    visibleTextEditors: [],
    get activeTextEditor() { return S.activeEditor; },
    createTreeView(id, opts) { S.treeView = { id, opts, dispose() {} }; return S.treeView; },
    createStatusBarItem() { S.statusItem = { show() {}, dispose() {} }; return S.statusItem; },
    createTextEditorDecorationType(o) { return { opts: o }; },
    setStatusBarMessage(m) { S.status.push(m); },
    onDidChangeVisibleTextEditors() { return { dispose() {} }; },
    onDidChangeWindowState(fn) { S.focusHandler = fn; return { dispose() {} }; },
    async showTextDocument(doc) {
      const ed = { document: doc, selection: null, revealRange() {}, setDecorations() {} };
      S.shown.push(ed);
      S.activeEditor = ed;
      return ed;
    },
    async showInputBox(opts) {
      const v = S.ib.shift();
      if (v !== undefined && opts && opts.validateInput && opts.validateInput(v)) return undefined;
      return v;
    },
    async showQuickPick(items) {
      const want = S.qp.shift();
      if (want === undefined) return undefined;
      return items.find((i) => i.label === want || i.project === want);
    },
    async showWarningMessage() { return S.warn; },
    async showErrorMessage() {},
  },
  workspace: {
    fs: vfs,
    workspaceFolders: [{ name: 'seL4' }],
    openTextDocument: async (uri) => (uri.toString() === docB.uri.toString() ? docB : docA),
    onDidChangeTextDocument(fn) { S.changeHandler = fn; return { dispose() {} }; },
  },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscode;
  return origLoad.apply(this, arguments);
};

// ---------- helpers ----------
function loadExt() {
  for (const f of ['extension.js', 'lib.js']) delete require.cache[path.join(EXT_DIR, f)];
  return require(path.join(EXT_DIR, 'extension.js'));
}
function memCtx(ws, gl) {
  return {
    subscriptions: [],
    workspaceState: memento(ws),
    globalState: memento(gl),
    globalStorageUri: Uri.parse('file:///store'),
  };
}
async function session(ws, gl) {
  S.commands.clear();
  const ext = loadExt();
  await ext.activate(memCtx(ws, gl));
  return { ext, p: S.treeView.opts.treeDataProvider };
}
const cmd = (id, ...a) => S.commands.get(id)(...a);
const names = (p) => p.getChildren().map((r) => r.name);
const letters = (p, name) => p.getChildren({ kind: 'project', name }).map((k) => k.mark.letter);
const at = (doc, line, col) => {
  S.activeEditor = { document: doc, selection: { active: new Position(line, col) }, setDecorations() {} };
};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (msg) => console.log('ok -', msg, `(${++n})`);

(async () => {
  const ws1 = new Map();
  const gl = new Map();
  let { ext, p } = await session(ws1, gl);

  // A. first start
  assert.deepStrictEqual(names(p), ['default']);
  assert.strictEqual(S.treeView.title, 'Marks · default');
  assert.ok(/default/.test(S.statusItem.text));
  assert.ok(/No marks yet/.test(S.treeView.message));
  const cmds = ['set', 'jump', 'jumpExact', 'open', 'toggleSort', 'delete', 'clear', 'selectProject',
    'switchProject', 'newProject', 'renameProject', 'deleteProject'];
  for (const c of cmds) assert.ok(S.commands.has('vimMarks.' + c), 'registered ' + c);
  ok(`activate: ${cmds.length} commands, default project, title and status bar`);

  // B. marks accumulate in the active project
  at(docA, 2, 5); await cmd('vimMarks.set', 'q');
  at(docB, 1, 0); await cmd('vimMarks.set', 'B');
  assert.deepStrictEqual(letters(p, 'default'), ['q', 'B']);
  ok('marks q, B added to project "default" (creation order)');

  // C. create a project from the sidebar flow; new marks go there
  await cmd('vimMarks.newProject', 'seL4 study');
  assert.deepStrictEqual(names(p), ['default', 'seL4 study']);
  assert.strictEqual(S.treeView.title, 'Marks · seL4 study');
  at(docA, 0, 0); await cmd('vimMarks.set', 'x');
  assert.deepStrictEqual(letters(p, 'seL4 study'), ['x']);
  assert.deepStrictEqual(letters(p, 'default'), ['q', 'B']);
  const itemActive = p.getTreeItem(p.getChildren()[1]);
  const itemIdle = p.getTreeItem(p.getChildren()[0]);
  assert.strictEqual(itemActive.iconPath.id, 'pass-filled');
  assert.ok(/active/.test(itemActive.description));
  assert.strictEqual(itemIdle.iconPath.id, 'circle-outline');
  assert.strictEqual(itemActive.collapsibleState, 2);
  assert.strictEqual(itemIdle.collapsibleState, 1);
  assert.strictEqual(itemIdle.command.command, 'vimMarks.selectProject');
  ok('new project "seL4 study" is active; its marks stay separate; active/idle shown in the tree');

  // D. select another project by clicking it in the sidebar
  await cmd('vimMarks.selectProject', 'default');
  assert.strictEqual(S.treeView.title, 'Marks · default');
  await cmd('vimMarks.jump', 'B');
  assert.strictEqual(S.shown.at(-1).document.uri.toString(), docB.uri.toString());
  const before = S.shown.length;
  await cmd('vimMarks.jump', 'x'); // x belongs to the other project
  assert.strictEqual(S.shown.length, before);
  assert.ok(S.status.some((m) => /'x' is not set in "default"/.test(m)));
  ok('selectProject switches the active project; jump uses only the active project\'s marks');

  // E. view toggle: creation order <-> grouped by file
  at(docA, 0, 0); await cmd('vimMarks.set', 'a');
  assert.deepStrictEqual(letters(p, 'default'), ['q', 'B', 'a']); // creation order
  assert.strictEqual(S.treeView.description, 'creation order');
  const flatItem = p.getTreeItem(p.getChildren({ kind: 'project', name: 'default' })[0]);
  assert.ok(/^q\s+a\.c:3$/.test(flatItem.label), flatItem.label);
  await cmd('vimMarks.toggleSort');
  assert.strictEqual(S.treeView.description, 'grouped by file');
  const files = p.getChildren({ kind: 'project', name: 'default' });
  assert.deepStrictEqual(files.map((f) => f.kind), ['file', 'file']);
  assert.deepStrictEqual(files.map((f) => f.uri), ['file:///proj/a.c', 'file:///proj/b.c']);
  assert.deepStrictEqual(p.getChildren(files[0]).map((k) => k.mark.letter), ['a', 'q']); // by line: a(0), q(2)
  assert.deepStrictEqual(p.getChildren(files[1]).map((k) => k.mark.letter), ['B']);
  const fileItem = p.getTreeItem(files[0]);
  assert.strictEqual(fileItem.label, 'a.c');
  assert.ok(/2 marks/.test(fileItem.description), fileItem.description);
  assert.strictEqual(fileItem.collapsibleState, 2); // expanded
  assert.strictEqual(fileItem.iconPath.id, 'file');
  const markItem = p.getTreeItem(p.getChildren(files[0])[0]);
  assert.ok(/^a\s+line 1$/.test(markItem.label), markItem.label);
  assert.strictEqual(markItem.command.command, 'vimMarks.open');
  await cmd('vimMarks.delete', p.getChildren(files[1])[0]); // delete B from inside a file node
  assert.deepStrictEqual(p.getChildren({ kind: 'project', name: 'default' }).map((f) => f.uri), ['file:///proj/a.c']);
  at(docB, 1, 0); await cmd('vimMarks.set', 'B'); // put it back (newest mark)
  await cmd('vimMarks.toggleSort');
  assert.strictEqual(S.treeView.description, 'creation order');
  assert.deepStrictEqual(letters(p, 'default'), ['q', 'a', 'B']);
  ok('toggle: creation order <-> grouped by file (files by path, marks by line, delete works inside files)');

  // F. persistence: close and reopen VS Code (same storage, brand-new workspace state)
  await ext.deactivate();
  const saved = storeJson();
  assert.deepStrictEqual(saved.order, ['default', 'seL4 study']);
  assert.strictEqual(saved.projects.default.length, 3);
  assert.strictEqual(saved.projects['seL4 study'].length, 1);
  ok('marks.json written: 2 projects, 3 + 1 marks');
  ({ ext, p } = await session(new Map(), gl));
  assert.deepStrictEqual(names(p), ['default', 'seL4 study']);
  assert.deepStrictEqual(letters(p, 'default'), ['q', 'a', 'B']); // B was re-created last in step E
  assert.deepStrictEqual(letters(p, 'seL4 study'), ['x']);
  assert.strictEqual(S.treeView.title, 'Marks · default'); // last selected project
  ok('restart: all projects and marks restored; last selected project is active again');

  // G. the same workspace remembers its own project
  await cmd('vimMarks.selectProject', 'seL4 study');
  const ws2 = new Map([['vimMarks.activeProject', 'seL4 study']]);
  await ext.deactivate();
  ({ ext, p } = await session(ws2, gl));
  assert.strictEqual(S.treeView.title, 'Marks · seL4 study');
  ok('a workspace reopens with the project it used last');

  // H. edits keep the marks of every project in step
  at(docA, 2, 0); await cmd('vimMarks.set', 'z'); // seL4 study: z at line 2
  await cmd('vimMarks.selectProject', 'default'); // default has q at line 2
  const docA2 = makeDoc('file:///proj/a.c', ['', 'int a;', '  int b;', 'void f() {', '}']);
  S.changeHandler({
    document: docA2,
    contentChanges: [{ range: new Range(new Position(0, 0), new Position(0, 0)), text: '\n' }],
  });
  const lineOf = (proj, l) => p.getChildren({ kind: 'project', name: proj }).find((k) => k.mark.letter === l).mark.line;
  assert.strictEqual(lineOf('default', 'q'), 3);
  assert.strictEqual(lineOf('seL4 study', 'z'), 3);
  assert.strictEqual(lineOf('default', 'B'), 1); // other file untouched
  ok('inserting a line shifted marks of both projects (q: 2->3, z: 2->3), other file untouched');

  // I. rename, delete
  S.ib.push('sel4');
  await cmd('vimMarks.renameProject', { kind: 'project', name: 'seL4 study' });
  assert.deepStrictEqual(names(p), ['default', 'sel4']);
  assert.deepStrictEqual(letters(p, 'sel4').sort(), ['x', 'z']);
  ok('rename project keeps its marks');
  await cmd('vimMarks.delete', { kind: 'mark', project: 'sel4', mark: { letter: 'z' } });
  assert.deepStrictEqual(letters(p, 'sel4'), ['x']);
  ok('delete a single mark from a (non-active) project');
  await cmd('vimMarks.deleteProject', { kind: 'project', name: 'sel4' });
  assert.deepStrictEqual(names(p), ['default']);
  await cmd('vimMarks.deleteProject', { kind: 'project', name: 'default' });
  assert.deepStrictEqual(names(p), ['default']); // last project is recreated empty
  assert.deepStrictEqual(letters(p, 'default'), []);
  ok('delete project; deleting the last one leaves an empty "default"');

  // J. validation
  const before2 = names(p).length;
  await cmd('vimMarks.newProject', 'Default'); // duplicate (case-insensitive)
  await cmd('vimMarks.newProject', '   ');
  assert.strictEqual(names(p).length, before2);
  ok('invalid / duplicate project names are rejected');

  // K. clear active project
  at(docA2, 1, 0); await cmd('vimMarks.set', 'm');
  await cmd('vimMarks.clear');
  assert.deepStrictEqual(letters(p, 'default'), []);
  ok('clear removes all marks of the active project');

  // L. jump relocates a mark whose line moved while it was not tracked
  at(docA, 2, 0); await cmd('vimMarks.set', 'r'); // text 'void f() {' at line 2
  docA = makeDoc('file:///proj/a.c', ['// c1', '// c2', 'int a;', '  int b;', 'void f() {', '}']);
  await cmd('vimMarks.jump', 'r');
  assert.strictEqual(S.shown.at(-1).selection.active.line, 4);
  ok('jump found the remembered line after the file changed (line 2 -> 4)');

  // M. another window changed marks.json -> picked up on focus
  await ext.deactivate();
  const cur = storeJson();
  cur.order.push('extern');
  cur.projects.extern = [{ letter: 'e', uri: 'file:///proj/b.c', line: 0, col: 0, text: 'x', seq: 1 }];
  await vfs.writeFile(Uri.parse(STORE), new TextEncoder().encode(JSON.stringify(cur)));
  S.focusHandler({ focused: true });
  await tick();
  assert.deepStrictEqual(names(p), ['default', 'extern']);
  ok('marks.json changed by another window is reloaded when this window gets focus');

  // N. migration from v0.1/v0.2 (marks used to live in workspaceState)
  await ext.deactivate();
  fsFiles.clear(); fsMtime.clear();
  const ws3 = new Map([['vimMarks.marks', [{ letter: 'k', uri: 'file:///proj/a.c', line: 1, col: 0, text: '  int b;', seq: 1 }]]]);
  const glN = new Map();
  ({ ext, p } = await session(ws3, glN));
  assert.deepStrictEqual(letters(p, 'default'), ['k']);
  assert.ok(ws3.has('vimMarks.marks'), 'old data must not be deleted');
  assert.strictEqual(ws3.get('vimMarks.migrated'), true);
  await ext.deactivate();
  ({ ext, p } = await session(ws3, glN)); // restart: must not import a second time
  assert.deepStrictEqual(names(p), ['default']);
  assert.deepStrictEqual(letters(p, 'default'), ['k']);
  ok('old workspace marks were copied into "default" once (old data kept, no second import)');

  // O. unreadable marks.json is kept, not overwritten
  await ext.deactivate();
  fsFiles.clear(); fsMtime.clear();
  await vfs.writeFile(Uri.parse(STORE), new TextEncoder().encode('{broken'));
  ({ ext, p } = await session(new Map(), new Map()));
  assert.deepStrictEqual(names(p), ['default']);
  const backups = [...fsFiles.keys()].filter((k) => k.includes('marks.corrupt-'));
  assert.strictEqual(backups.length, 1);
  ok('corrupt marks.json: copy kept, empty store started');

  // Q. old marks must never overwrite existing ones (same letters in another workspace)
  await ext.deactivate();
  fsFiles.clear(); fsMtime.clear();
  const glQ = new Map();
  ({ ext, p } = await session(new Map(), glQ));
  at(docB, 1, 0); await cmd('vimMarks.set', 'a'); // "default" already holds an 'a' (b.c)
  await ext.deactivate();
  const wsOld = new Map([['vimMarks.marks', [
    { letter: 'a', uri: 'file:///proj/a.c', line: 2, col: 0, text: 'void f() {', seq: 1 },
    { letter: 'w', uri: 'file:///proj/a.c', line: 1, col: 0, text: '  int b;', seq: 2 },
  ]]]);
  ({ ext, p } = await session(wsOld, glQ));
  assert.deepStrictEqual(names(p), ['default', 'seL4']); // new section named after the folder
  assert.deepStrictEqual(letters(p, 'default'), ['a']); // untouched
  assert.strictEqual(p.getChildren({ kind: 'project', name: 'default' })[0].mark.uri, 'file:///proj/b.c');
  assert.deepStrictEqual(letters(p, 'seL4'), ['a', 'w']); // the same letter survived, nothing lost
  assert.strictEqual(S.treeView.title, 'Marks · seL4'); // this workspace continues in its own section
  assert.ok(wsOld.has('vimMarks.marks'));
  await ext.deactivate();
  ({ ext, p } = await session(wsOld, glQ)); // restart: no second import
  assert.deepStrictEqual(names(p), ['default', 'seL4']);
  assert.deepStrictEqual(letters(p, 'seL4'), ['a', 'w']);
  ok('old marks with clashing letters went into their own section "seL4"; nothing overwritten or lost');

  // P. view mode is remembered per workspace; the old 'letter' value falls back to creation order
  await ext.deactivate();
  fsFiles.clear(); fsMtime.clear();
  ({ ext, p } = await session(new Map([['vimMarks.sort', 'file']]), new Map()));
  assert.strictEqual(S.treeView.description, 'grouped by file');
  await ext.deactivate();
  ({ ext, p } = await session(new Map([['vimMarks.sort', 'letter']]), new Map()));
  assert.strictEqual(S.treeView.description, 'creation order');
  ok('saved view mode "file" is restored; the old "letter" value becomes creation order');

  await ext.deactivate();
  console.log(`\nsmoke test passed (${n} checks)`);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
