'use strict';
const vscode = require('vscode');
const lib = require('./lib');

const KEY_ACTIVE_WS = 'vimMarks.activeProject'; // workspaceState: project used by this workspace
const KEY_LAST = 'vimMarks.lastProject'; // globalState: last selected project (fallback)
const KEY_SORT = 'vimMarks.sort'; // workspaceState
const KEY_CONFIRM = 'vimMarks.confirmOverwrite'; // globalState: ask before replacing a mark (default on)
const KEY_OLD_MARKS = 'vimMarks.marks'; // workspaceState of v0.1/v0.2 (copied once, never deleted)
const KEY_MIGRATED = 'vimMarks.migrated'; // workspaceState flag: old marks were already copied
const DEFAULT_PROJECT = 'default';
const STORE_FILE = 'marks.json';
// Tree drag & drop uses a mime type derived from the view id: application/vnd.code.tree.<viewid lower-cased>
const DND_MIME = 'application/vnd.code.tree.vimmarks.list';

let ctx;
let provider;
let treeView;
let statusItem;
let storeUri;

/** project names in display order */
let order = [];
/** project name -> mark[]   mark = {letter, uri, line, col, text, seq} */
let data = {};
let activeProject = DEFAULT_PROJECT;
let sortMode = 'created';
let confirmOverwrite = true;

let saveTimer;
let dirty = false;
let writing = Promise.resolve();
let lastMtime = 0;
const decoTypes = new Map();

// ---------- helpers ----------

function curMarks() {
  if (!data[activeProject]) data[activeProject] = [];
  return data[activeProject];
}

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

/** Last two folder names of a file, e.g. "arch/riscv" — to tell same-named files apart. */
function shortDir(uriString) {
  const parts = vscode.Uri.parse(uriString).path.split('/').filter(Boolean);
  parts.pop(); // the file name itself
  return parts.slice(-2).join('/');
}

function say(msg) {
  vscode.window.setStatusBarMessage(msg, 2500);
}

// ---------- persistence (a JSON file in the extension's global storage folder) ----------

async function readStoreText() {
  try {
    const bytes = await vscode.workspace.fs.readFile(storeUri);
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) {
    return ''; // file does not exist yet
  }
}

async function statMtime() {
  try {
    return (await vscode.workspace.fs.stat(storeUri)).mtime;
  } catch (e) {
    return 0;
  }
}

function applyStore(parsed) {
  order = parsed.order.slice();
  data = parsed.projects;
  if (!order.length) {
    order = [DEFAULT_PROJECT];
    data[DEFAULT_PROJECT] = [];
  }
}

async function loadStore() {
  await vscode.workspace.fs.createDirectory(ctx.globalStorageUri);
  storeUri = vscode.Uri.joinPath(ctx.globalStorageUri, STORE_FILE);
  const text = await readStoreText();
  let parsed = lib.parseStore(text);
  if (parsed === null) {
    // Unreadable file: keep a copy instead of silently overwriting it.
    try {
      const backup = vscode.Uri.joinPath(ctx.globalStorageUri, `marks.corrupt-${Date.now()}.json`);
      await vscode.workspace.fs.writeFile(backup, new TextEncoder().encode(text));
    } catch (e) {
      /* ignore */
    }
    vscode.window.showWarningMessage(
      'Vim Marks: marks.json could not be read. A copy was kept next to it and an empty store was started.'
    );
    parsed = { order: [], projects: {} };
  }
  applyStore(parsed);
  lastMtime = await statMtime();
}

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 200);
}

function flush() {
  clearTimeout(saveTimer);
  if (!dirty) return writing;
  dirty = false;
  const text = lib.serializeStore(order, data);
  writing = writing
    .then(() => vscode.workspace.fs.writeFile(storeUri, new TextEncoder().encode(text)))
    .then(async () => {
      lastMtime = await statMtime();
    })
    .catch((err) =>
      vscode.window.showErrorMessage('Vim Marks: could not save marks: ' + (err && err.message))
    );
  return writing;
}

/** Another window may have written marks.json; pick that up when this window gets focus. */
async function syncFromDisk() {
  if (dirty) return; // our own unsaved changes are about to be written
  const m = await statMtime();
  if (!m || m === lastMtime) return;
  const parsed = lib.parseStore(await readStoreText());
  if (!parsed) return;
  lastMtime = m;
  applyStore(parsed);
  if (!order.includes(activeProject)) activeProject = order[0];
  refreshView();
  refreshAllDecorations();
}

/**
 * Marks saved by v0.1/v0.2 lived in the workspace's own storage. Copy them once into the new
 * store. They are never mixed into marks that already exist (that could drop same-letter marks):
 * if "default" already has marks, they go into a new section named after the workspace folder.
 * The old data is left untouched; a flag only prevents importing it twice.
 */
function migrateOldMarks() {
  if (ctx.workspaceState.get(KEY_MIGRATED)) return;
  const old = ctx.workspaceState.get(KEY_OLD_MARKS);
  if (!Array.isArray(old) || !old.length) return;
  const incoming = old.filter(lib.validMark).map(lib.cleanMark);
  if (!incoming.length) return;

  let target = DEFAULT_PROJECT;
  if (data[DEFAULT_PROJECT] && data[DEFAULT_PROJECT].length) {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    target = lib.uniqueName(folder && folder.name, order);
    order.push(target);
    data[target] = [];
  } else if (!data[DEFAULT_PROJECT]) {
    order.push(DEFAULT_PROJECT);
    data[DEFAULT_PROJECT] = [];
  }
  const list = data[target];
  for (const m of incoming.sort((a, b) => a.seq - b.seq)) {
    if (!list.some((x) => x.letter === m.letter)) list.push({ ...m, seq: lib.nextSeq(list) });
  }
  ctx.workspaceState.update(KEY_MIGRATED, true);
  ctx.workspaceState.update(KEY_ACTIVE_WS, target); // this workspace keeps working in the imported section
  scheduleSave();
}

function chooseActive() {
  const wanted = ctx.workspaceState.get(KEY_ACTIVE_WS) || ctx.globalState.get(KEY_LAST);
  activeProject = order.includes(wanted) ? wanted : order[0];
}

// ---------- gutter decorations (marks of the active project only) ----------

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
  for (const m of curMarks()) {
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

// ---------- tree view: projects at the top level, their marks below ----------

class MarksProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
  }
  refresh() {
    this._emitter.fire(undefined);
  }
  getChildren(element) {
    if (!element) return order.map((name) => ({ kind: 'project', name }));
    if (element.kind === 'project') {
      const list = data[element.name] || [];
      if (sortMode === 'file') {
        return lib
          .groupByFile(list)
          .map((g) => ({ kind: 'file', project: element.name, uri: g.uri, marks: g.marks }));
      }
      return lib.sortByCreation(list).map((mark) => ({ kind: 'mark', project: element.name, mark }));
    }
    if (element.kind === 'file') {
      return element.marks.map((mark) => ({ kind: 'mark', project: element.project, mark }));
    }
    return [];
  }
  getTreeItem(el) {
    if (el.kind === 'project') {
      const n = (data[el.name] || []).length;
      const active = el.name === activeProject;
      const item = new vscode.TreeItem(
        el.name,
        active ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
      );
      // The id changes with the active state so the active project always opens, the others close.
      item.id = `project-${el.name}-${active ? 'active' : 'idle'}`;
      item.description = `${n} mark${n === 1 ? '' : 's'}${active ? ' · active' : ''}`;
      item.iconPath = new vscode.ThemeIcon(active ? 'pass-filled' : 'circle-outline');
      item.contextValue = 'project';
      item.tooltip = active
        ? 'Active project: new marks are added here'
        : 'Click to make this the active project';
      item.command = { command: 'vimMarks.selectProject', title: 'Select Project', arguments: [el.name] };
      return item;
    }
    if (el.kind === 'file') {
      const n = el.marks.length;
      const dir = shortDir(el.uri);
      const fileItem = new vscode.TreeItem(baseName(el.uri), vscode.TreeItemCollapsibleState.Expanded);
      fileItem.id = `file-${el.project}-${el.uri}`;
      fileItem.description = `${dir}${dir ? ' · ' : ''}${n} mark${n === 1 ? '' : 's'}`;
      fileItem.iconPath = new vscode.ThemeIcon('file');
      fileItem.contextValue = 'file';
      const fu = vscode.Uri.parse(el.uri);
      fileItem.tooltip = fu.fsPath || fu.path;
      return fileItem;
    }
    const m = el.mark;
    const uri = vscode.Uri.parse(m.uri);
    // Under a file node the file name is already shown, so only the line number is needed.
    const label =
      sortMode === 'file'
        ? `${m.letter}   line ${m.line + 1}`
        : `${m.letter}   ${baseName(m.uri)}:${m.line + 1}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    const preview = (m.text || '').trim();
    item.id = `mark-${el.project}-${m.letter}-${m.seq}`;
    item.description = preview.slice(0, 80);
    item.tooltip = `${uri.fsPath || uri.path}:${m.line + 1}:${m.col + 1}\n${preview}`;
    item.iconPath = letterSvg(m.letter);
    item.contextValue = 'mark';
    item.command = { command: 'vimMarks.open', title: 'Open Mark', arguments: [el.project, m.letter] };
    return item;
  }
}

function refreshView() {
  provider.refresh();
  treeView.title = `Marks · ${activeProject}`;
  treeView.description =
    (sortMode === 'created' ? 'creation order' : 'grouped by file') +
    ` · overwrite: ${confirmOverwrite ? 'ask' : 'no ask'}`;
  const any = order.some((p) => (data[p] || []).length);
  treeView.message = any ? undefined : 'No marks yet. In normal mode press m{letter} to set one.';
  statusItem.text = `$(bookmark) ${activeProject}`;
  statusItem.tooltip = `Vim Marks project: ${activeProject} (${curMarks().length} marks). Click to switch.`;
}

function changed() {
  scheduleSave();
  refreshView();
  refreshAllDecorations();
}

// ---------- mark commands ----------

/**
 * One-key yes/no question. Resolves to true (y), false (n, or Enter on the default item = the safe
 * answer) or null (Esc / the box was closed).
 */
function askYesNo(title, placeholder, noText, yesText, detail) {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.title = title;
    qp.placeholder = placeholder;
    qp.items = [
      { label: 'n', description: noText, detail },
      { label: 'y', description: yesText },
    ];
    qp.activeItems = [qp.items[0]];
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      resolve(answer);
      qp.dispose();
    };
    qp.onDidChangeValue((v) => {
      const k = v.trim().toLowerCase();
      if (k === 'y') finish(true);
      else if (k === 'n') finish(false);
    });
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0] || qp.activeItems[0];
      finish(!!sel && sel.label === 'y');
    });
    qp.onDidHide(() => finish(null));
    qp.show();
  });
}

/** Setting a mark whose letter is used elsewhere: y = move it here; n, Enter and Esc keep the old one. */
async function askOverwrite(letter, existing) {
  const answer = await askYesNo(
    `Mark '${letter}' already exists in "${activeProject}"`,
    'Overwrite it?  Press  y  (yes)  or  n  (no)',
    'No — keep the existing mark',
    'Yes — move the mark to the current position',
    `${baseName(existing.uri)}:${existing.line + 1}   ${(existing.text || '').trim()}`
  );
  return answer === true;
}

function setConfirm(value) {
  confirmOverwrite = value;
  ctx.globalState.update(KEY_CONFIRM, value);
  vscode.commands.executeCommand('setContext', 'vimMarks.overwriteConfirmOff', !value);
  say(`Overwrite confirmation: ${value ? 'on' : 'off'}`);
  refreshView();
}

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
  const existing = curMarks().find((m) => m.letter === letter);
  const action = lib.decideSetMark(existing, doc.uri.toString(), pos.line, confirmOverwrite);
  if (action === 'remove') {
    // Pressing the same letter again on the same line toggles the mark off.
    data[activeProject] = curMarks().filter((m) => m.letter !== letter);
    say(`[${activeProject}] mark '${letter}' removed from ${baseName(existing.uri)}:${existing.line + 1} (press again to set it)`);
    changed();
    return;
  }
  if (action === 'ask') {
    const yes = await askOverwrite(letter, existing);
    if (!yes) {
      say(`Mark '${letter}' kept at ${baseName(existing.uri)}:${existing.line + 1}`);
      return;
    }
  }
  const list = curMarks().filter((m) => m.letter !== letter);
  list.push({
    letter,
    uri: doc.uri.toString(),
    line: pos.line,
    col: pos.character,
    text: doc.lineAt(pos.line).text,
    seq: lib.nextSeq(list),
  });
  data[activeProject] = list;
  say(`[${activeProject}] mark '${letter}' set at ${baseName(doc.uri.toString())}:${pos.line + 1}`);
  changed();
}

async function openMark(project, letter, exact) {
  const m = (data[project] || []).find((x) => x.letter === letter);
  if (!m) {
    say(`Mark '${letter}' is not set in "${project}"`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(m.uri));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  let line = Math.max(0, Math.min(m.line, doc.lineCount - 1));
  const moved = lib.relocateLine((n) => doc.lineAt(n).text, doc.lineCount, line, m.text);
  if (moved !== line) {
    line = moved;
    m.line = moved;
    m.text = doc.lineAt(moved).text;
    scheduleSave();
    refreshView();
  }
  const info = doc.lineAt(line);
  const col = exact ? Math.min(m.col, info.text.length) : info.firstNonWhitespaceCharacterIndex;
  const pos = new vscode.Position(line, col);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function jump(arg, exact) {
  let letter = arg;
  if (letter === undefined) {
    const pick = await vscode.window.showQuickPick(
      lib.sortByCreation(curMarks()).map((m) => ({
        label: m.letter,
        description: `${baseName(m.uri)}:${m.line + 1}`,
        detail: (m.text || '').trim(),
      })),
      { placeHolder: `Jump to mark in "${activeProject}"` }
    );
    if (!pick) return;
    letter = pick.label;
  }
  await openMark(activeProject, letter, exact);
}

function deleteMark(el) {
  if (!el || el.kind !== 'mark') return;
  data[el.project] = (data[el.project] || []).filter((m) => m.letter !== el.mark.letter);
  changed();
}

async function clearActive() {
  const n = curMarks().length;
  if (!n) return;
  const ok = await vscode.window.showWarningMessage(
    `Delete all ${n} marks in project "${activeProject}"?`,
    { modal: true },
    'Delete'
  );
  if (ok === 'Delete') {
    data[activeProject] = [];
    changed();
  }
}

// ---------- project commands ----------

function projectNameOf(arg) {
  if (typeof arg === 'string') return arg;
  return arg && arg.kind === 'project' ? arg.name : undefined;
}

function selectProject(arg) {
  const name = projectNameOf(arg);
  if (!name || !data[name]) return;
  if (name !== activeProject) {
    activeProject = name;
    ctx.workspaceState.update(KEY_ACTIVE_WS, name);
    ctx.globalState.update(KEY_LAST, name);
    say(`Marks project: ${name}`);
  }
  refreshView();
  refreshAllDecorations();
}

async function pickProject(placeHolder) {
  const pick = await vscode.window.showQuickPick(
    order.map((p) => ({
      label: p,
      project: p,
      description: p === activeProject ? 'active' : '',
      detail: `${(data[p] || []).length} marks`,
    })),
    { placeHolder }
  );
  return pick ? pick.project : undefined;
}

async function newProject(arg) {
  let name = typeof arg === 'string' ? arg : undefined;
  if (name === undefined) {
    name = await vscode.window.showInputBox({
      prompt: 'New project name',
      validateInput: (v) => lib.validateProjectName(v, order),
    });
  }
  if (name === undefined) return;
  const err = lib.validateProjectName(name, order);
  if (err) {
    vscode.window.showWarningMessage(`Vim Marks: ${err}`);
    return;
  }
  name = name.trim();
  order.push(name);
  data[name] = [];
  scheduleSave();
  selectProject(name);
}

async function switchProject() {
  const items = order.map((p) => ({
    label: p,
    project: p,
    description: p === activeProject ? 'active' : '',
    detail: `${(data[p] || []).length} marks`,
  }));
  items.push({ label: '$(add) New project...', alwaysShow: true, isNew: true });
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Active project: ${activeProject}`,
  });
  if (!pick) return;
  if (pick.isNew) return newProject();
  selectProject(pick.project);
}

async function renameProject(arg) {
  let oldName = projectNameOf(arg);
  if (!oldName) oldName = await pickProject('Rename which project?');
  if (!oldName || !data[oldName]) return;
  const others = order.filter((p) => p !== oldName);
  const input = await vscode.window.showInputBox({
    prompt: `New name for "${oldName}"`,
    value: oldName,
    validateInput: (v) => lib.validateProjectName(v, others),
  });
  if (input === undefined) return;
  const newName = input.trim();
  if (lib.validateProjectName(newName, others) || newName === oldName) return;
  data[newName] = data[oldName];
  delete data[oldName];
  order = order.map((p) => (p === oldName ? newName : p));
  if (activeProject === oldName) {
    activeProject = newName;
    ctx.workspaceState.update(KEY_ACTIVE_WS, newName);
    ctx.globalState.update(KEY_LAST, newName);
  }
  changed();
}

async function deleteProject(arg) {
  let name = projectNameOf(arg);
  if (!name) name = await pickProject('Delete which project?');
  if (!name || !data[name]) return;
  const n = data[name].length;
  const ok = await vscode.window.showWarningMessage(
    `Delete project "${name}" and its ${n} mark${n === 1 ? '' : 's'}?`,
    { modal: true },
    'Delete'
  );
  if (ok !== 'Delete') return;
  delete data[name];
  order = order.filter((p) => p !== name);
  if (!order.length) {
    order = [DEFAULT_PROJECT];
    data[DEFAULT_PROJECT] = [];
  }
  if (name === activeProject) {
    activeProject = order[0];
    ctx.workspaceState.update(KEY_ACTIVE_WS, activeProject);
    ctx.globalState.update(KEY_LAST, activeProject);
  }
  changed();
}

// ---------- drag & drop in the sidebar ----------

function dropProject(name, target) {
  let targetName;
  if (target) targetName = target.kind === 'project' ? target.name : target.project;
  const next = lib.reorderNames(order, name, targetName);
  if (!next) return;
  order = next;
  changed();
}

/**
 * Copy marks (by letter) from one section into another. The source section is left untouched.
 * Conflicts are decided by the user with one-key y/n questions:
 *   - another letter already marks the same line in the target  -> "change it to this letter?"
 *   - the letter is already used at another place in the target -> "overwrite it?"
 * n / Enter skip that one mark; Esc cancels the whole copy and nothing is changed.
 */
async function copyMarks(srcProject, letters, targetProject, beforeLetter) {
  const picked = lib.sortByCreation(data[srcProject] || []).filter((m) => letters.includes(m.letter));
  let list = (data[targetProject] || []).map((m) => ({ ...m }));
  const added = [];
  let same = 0;
  let skipped = 0;
  let n = 0;
  for (const m of picked) {
    n += 1;
    const step = picked.length > 1 ? `  (${n}/${picked.length})` : '';
    const plan = lib.planCopy(list, m);
    if (plan.action === 'same') {
      same += 1;
      continue;
    }
    const here = `${baseName(m.uri)}:${m.line + 1}   ${(m.text || '').trim()}`;
    if (plan.action === 'relabel') {
      const yes = await askYesNo(
        `This line is already marked '${plan.atPlace.letter}' in "${targetProject}"${step}`,
        `Change that mark to '${m.letter}'?  Press  y  (yes)  or  n  (no)`,
        'No — leave it as it is (skip this mark)',
        `Yes — mark this line '${m.letter}' instead of '${plan.atPlace.letter}'`,
        here
      );
      if (yes === null) return say('Copy cancelled — nothing was changed');
      if (!yes) {
        skipped += 1;
        continue;
      }
    }
    if (plan.holder) {
      const yes = await askYesNo(
        `Mark '${m.letter}' already exists in "${targetProject}"${step}`,
        'Overwrite it?  Press  y  (yes)  or  n  (no)',
        'No — keep the existing mark (skip this mark)',
        'Yes — replace it with the copied mark',
        `existing: ${baseName(plan.holder.uri)}:${plan.holder.line + 1}   ${(plan.holder.text || '').trim()}`
      );
      if (yes === null) return say('Copy cancelled — nothing was changed');
      if (!yes) {
        skipped += 1;
        continue;
      }
    }
    list = list.filter((x) => x !== plan.atPlace && x !== plan.holder);
    list.push({ ...m, seq: lib.nextSeq(list) });
    added.push(m.letter);
  }
  if (added.length) {
    data[targetProject] = list;
    if (beforeLetter) {
      const placed = lib.placeBefore(list, added, beforeLetter);
      if (placed) data[targetProject] = placed;
    }
    changed();
  }
  const parts = [`${added.length} copied to "${targetProject}"`];
  if (same) parts.push(`${same} already there`);
  if (skipped) parts.push(`${skipped} skipped`);
  say(`Marks: ${parts.join(', ')}`);
}

async function dropMarks(payload, target) {
  let targetProject = payload.project; // dropped on empty space: stays in its own section
  let targetLetter;
  if (target) {
    if (target.kind === 'mark') {
      targetProject = target.project;
      targetLetter = target.mark.letter;
    } else if (target.kind === 'project') {
      targetProject = target.name;
    } else if (target.kind === 'file') {
      targetProject = target.project;
    } else return;
  }
  if (targetProject !== payload.project) {
    // Another section: copy. The position only matters in creation order view.
    await copyMarks(payload.project, payload.letters, targetProject, sortMode === 'created' ? targetLetter : undefined);
    return;
  }
  // Same section: rearrange.
  if (sortMode !== 'created') {
    say('Marks can only be rearranged in creation order view (press , z to switch)');
    return;
  }
  const list = data[payload.project] || [];
  const next =
    payload.letters.length === 1
      ? lib.reorderMarks(list, payload.letters[0], targetLetter)
      : lib.placeBefore(list, payload.letters, targetLetter);
  if (!next) return;
  data[payload.project] = next;
  changed();
}

class MarksDnd {
  constructor() {
    this.dragMimeTypes = [DND_MIME];
    this.dropMimeTypes = [DND_MIME];
  }
  handleDrag(source, dataTransfer) {
    const els = (source || []).filter(Boolean);
    if (!els.length) return;
    let payload;
    if (els.length === 1 && els[0].kind === 'project') {
      payload = { kind: 'project', name: els[0].name };
    } else {
      // marks, or whole file groups, from the multi-selection
      const picked = [];
      for (const el of els) {
        if (el.kind === 'mark') picked.push({ project: el.project, letter: el.mark.letter });
        else if (el.kind === 'file') for (const m of el.marks) picked.push({ project: el.project, letter: m.letter });
      }
      if (!picked.length) return;
      const projects = [...new Set(picked.map((x) => x.project))];
      if (projects.length !== 1) {
        say('Select marks from one section at a time');
        return;
      }
      payload = { kind: 'marks', project: projects[0], letters: [...new Set(picked.map((x) => x.letter))] };
    }
    dataTransfer.set(DND_MIME, new vscode.DataTransferItem(JSON.stringify(payload)));
  }
  async handleDrop(target, dataTransfer) {
    const item = dataTransfer.get(DND_MIME);
    if (!item) return;
    let payload;
    try {
      payload = JSON.parse(await item.asString());
    } catch (e) {
      return;
    }
    if (payload.kind === 'project') dropProject(payload.name, target);
    else if (payload.kind === 'marks') await dropMarks(payload, target);
  }
}

// ---------- activation ----------

async function activate(context) {
  ctx = context;
  sortMode = lib.normalizeSortMode(ctx.workspaceState.get(KEY_SORT));
  confirmOverwrite = ctx.globalState.get(KEY_CONFIRM, true) !== false;
  vscode.commands.executeCommand('setContext', 'vimMarks.overwriteConfirmOff', !confirmOverwrite);
  await loadStore();
  migrateOldMarks();
  chooseActive();

  provider = new MarksProvider();
  treeView = vscode.window.createTreeView('vimMarks.list', {
    treeDataProvider: provider,
    dragAndDropController: new MarksDnd(),
    canSelectMany: true, // Ctrl/Shift click to pick several marks, then drag them together
  });
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'vimMarks.switchProject';
  statusItem.show();

  context.subscriptions.push(
    treeView,
    statusItem,
    vscode.commands.registerCommand('vimMarks.set', setMark),
    vscode.commands.registerCommand('vimMarks.jump', (l) => jump(l, false)),
    vscode.commands.registerCommand('vimMarks.jumpExact', (l) => jump(l, true)),
    vscode.commands.registerCommand('vimMarks.open', (project, letter) => openMark(project, letter, true)),
    vscode.commands.registerCommand('vimMarks.toggleSort', () => {
      sortMode = sortMode === 'created' ? 'file' : 'created';
      ctx.workspaceState.update(KEY_SORT, sortMode);
      say(`Marks: ${sortMode === 'created' ? 'creation order' : 'grouped by file'}`);
      refreshView();
    }),
    vscode.commands.registerCommand('vimMarks.delete', deleteMark),
    vscode.commands.registerCommand('vimMarks.clear', clearActive),
    vscode.commands.registerCommand('vimMarks.enableConfirm', () => setConfirm(true)),
    vscode.commands.registerCommand('vimMarks.disableConfirm', () => setConfirm(false)),
    vscode.commands.registerCommand('vimMarks.toggleConfirm', () => setConfirm(!confirmOverwrite)),
    vscode.commands.registerCommand('vimMarks.selectProject', selectProject),
    vscode.commands.registerCommand('vimMarks.switchProject', switchProject),
    vscode.commands.registerCommand('vimMarks.newProject', newProject),
    vscode.commands.registerCommand('vimMarks.renameProject', renameProject),
    vscode.commands.registerCommand('vimMarks.deleteProject', deleteProject),
    vscode.window.onDidChangeVisibleTextEditors(refreshAllDecorations),
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) syncFromDisk();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!e.contentChanges.length) return;
      const key = e.document.uri.toString();
      const changes = e.contentChanges.map((c) => ({
        startLine: c.range.start.line,
        startCol: c.range.start.character,
        endLine: c.range.end.line,
        isInsert: c.range.isEmpty,
        newLineCount: (c.text.match(/\r\n|\r|\n/g) || []).length,
        endsWithNewline: /\n$/.test(c.text),
      }));
      let touched = false;
      // Keep the marks of ALL projects in step with edits, not only the active one.
      for (const name of order) {
        const docMarks = (data[name] || []).filter((m) => m.uri === key);
        if (!docMarks.length) continue;
        lib.applyChanges(docMarks, changes);
        for (const m of docMarks) {
          m.line = Math.max(0, Math.min(m.line, e.document.lineCount - 1));
          m.text = e.document.lineAt(m.line).text;
        }
        touched = true;
      }
      if (touched) changed();
    })
  );

  refreshView();
  refreshAllDecorations();
}

function deactivate() {
  return flush();
}

module.exports = { activate, deactivate };
