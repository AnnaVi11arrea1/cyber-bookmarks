'use strict';

const $ = (sel) => document.querySelector(sel);
const treeEl = $('#tree');
const menuEl = $('#menu');
const searchEl = $('#search');
const modal = $('#modal');

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const state = {
  rootId: '0',
  roots: [],            // Bookmarks bar, Other bookmarks, (Mobile if non-empty)
  nodes: new Map(),     // id -> BookmarkTreeNode
  expanded: null,       // Set of open folder ids (persisted)
  selected: new Set(),
  anchor: null,         // last clicked id, for shift-range select
  visible: [],          // ids in on-screen order
  query: '',
  drag: null,           // ids being dragged from inside the panel
  flash: new Set(),     // ids to highlight on next render
};

// Folder color by nesting level: top-level folders purple, then blue, teal, ... and it cycles.
const FOLDER_COLORS = ['#bc13fe', '#2d7dff', '#00e5c7', '#39ff14', '#f3ff3a', '#ff9f1c', '#ff2bd6'];

const FULL = new URLSearchParams(location.search).has('full');
if (FULL) document.body.classList.add('full');

// ---------- data ----------

async function refresh() {
  const [root] = await chrome.bookmarks.getTree();
  state.rootId = root.id;
  state.nodes.clear();
  (function index(n) { state.nodes.set(n.id, n); n.children?.forEach(index); })(root);
  state.roots = root.children.filter((n, i) => i < 2 || n.children?.length);
  state.expanded ??= new Set(store.get('expanded', [state.roots[0]?.id]));
  for (const id of state.selected) if (!state.nodes.has(id)) state.selected.delete(id);
  render();
}

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 40);
}
for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) {
  chrome.bookmarks[ev].addListener(scheduleRefresh);
}

const isFolder = (n) => !n.url;
const isRoot = (n) => n.parentId === state.rootId;

function isAncestor(ancestorId, id) {
  for (let n = state.nodes.get(id); n; n = state.nodes.get(n.parentId)) {
    if (n.parentId === ancestorId) return true;
  }
  return false;
}

function countLinks(n) {
  return n.url ? 1 : n.children.reduce((sum, c) => sum + countLinks(c), 0);
}

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function favicon(url) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', '32');
  return u.href;
}

function persistExpanded() {
  store.set('expanded', [...state.expanded]);
}

// Selected ids in on-screen order, minus roots and minus items whose ancestor is also selected.
function selection() {
  const ids = state.visible.filter((id) => state.selected.has(id));
  return ids.filter((id) => !isRoot(state.nodes.get(id)) && !ids.some((o) => o !== id && isAncestor(o, id)));
}

// Where toolbar "+" actions land: the single selected folder, else the bookmarks bar.
function targetFolder() {
  const sel = selection();
  if (sel.length === 1 && isFolder(state.nodes.get(sel[0]))) return state.nodes.get(sel[0]);
  return state.roots[0];
}

// ---------- rendering ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function actBtn(act, label, title) {
  const b = el('button', 'act', label);
  b.type = 'button';
  b.dataset.act = act;
  b.title = title;
  return b;
}

function render() {
  const q = state.query.trim().toLowerCase();
  const matches = (n) => !isRoot(n) && (n.title.toLowerCase().includes(q) || (n.url ?? '').toLowerCase().includes(q));
  const hits = new Map();
  const subtreeHit = (n) => {
    if (!hits.has(n.id)) hits.set(n.id, matches(n) || (n.children ?? []).some(subtreeHit));
    return hits.get(n.id);
  };

  const frag = document.createDocumentFragment();
  state.visible = [];
  const walk = (n, depth, filtering) => {
    if (filtering && !subtreeHit(n)) return;
    frag.append(makeRow(n, depth, Boolean(q)));
    state.visible.push(n.id);
    if (isFolder(n) && (q || state.expanded.has(n.id))) {
      // A folder that matches by name shows all of its contents.
      const childFiltering = filtering && !matches(n);
      n.children.forEach((c) => walk(c, depth + 1, childFiltering));
    }
  };
  state.roots.forEach((r) => walk(r, 0, Boolean(q)));

  if (!state.visible.length) {
    const empty = el('div', 'empty');
    empty.append(el('b', null, 'NO SIGNAL'), `nothing matches “${state.query.trim()}”`);
    frag.append(empty);
  }
  treeEl.replaceChildren(frag);
  state.flash.clear();

  const links = state.roots.reduce((sum, r) => sum + countLinks(r), 0);
  let folders = 0;
  for (const n of state.nodes.values()) if (isFolder(n) && n.parentId && !isRoot(n)) folders++;
  $('#stats').textContent = `${links} LINKS // ${folders} NODES ONLINE`;
  updateToolbar();
}

function makeRow(n, depth, searching) {
  const folder = isFolder(n);
  const root = isRoot(n);
  const open = folder && (searching || state.expanded.has(n.id));
  const row = el('div', `row ${folder ? 'folder' : 'mark'}`);
  row.classList.toggle('root', root);
  row.classList.toggle('open', open);
  row.classList.toggle('selected', state.selected.has(n.id));
  row.classList.toggle('dragging', Boolean(state.drag?.includes(n.id)));
  row.classList.toggle('flash', state.flash.has(n.id));
  row.dataset.id = n.id;
  row.style.setProperty('--depth', depth);
  row.draggable = !root;

  const acts = el('span', 'acts');
  if (folder) {
    if (!root) row.style.setProperty('--fc', FOLDER_COLORS[(depth - 1) % FOLDER_COLORS.length]);
    row.title = n.title;
    row.append(el('span', 'caret'), el('span', 'ico folder-ico'), el('span', 'title', n.title || 'untitled'));
    row.append(el('span', 'count', String(countLinks(n))));
    acts.append(actBtn('add-tab', '⇣', 'Save current tab here'), actBtn('sub', '+', 'New subfolder'));
    if (!root) acts.append(actBtn('edit', '✎', 'Rename'), actBtn('del', '✕', 'Delete'));
  } else {
    row.title = `${n.title}\n${n.url}`;
    const img = el('img', 'ico fav');
    img.src = favicon(n.url);
    img.alt = '';
    img.loading = 'lazy';
    img.draggable = false;
    row.append(el('span', 'caret-spacer'), img, el('span', 'title', n.title || host(n.url) || n.url));
    row.append(el('span', 'host', host(n.url)));
    acts.append(actBtn('edit', '✎', 'Edit'), actBtn('del', '✕', 'Delete'));
  }
  row.append(acts);
  return row;
}

function paintSelection() {
  for (const row of treeEl.querySelectorAll('.row')) row.classList.toggle('selected', state.selected.has(row.dataset.id));
  updateToolbar();
}

function updateToolbar() {
  const k = selection().length;
  $('#btn-group').disabled = k === 0;
  $('#sel-count').textContent = k ? ` [${k}]` : '';
}

const rowFor = (id) => treeEl.querySelector(`.row[data-id="${CSS.escape(id)}"]`);

// ---------- selection ----------

function toggleSelect(id) {
  if (isRoot(state.nodes.get(id))) return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  state.anchor = id;
  paintSelection();
}

function selectRange(a, b) {
  const i = state.visible.indexOf(a);
  const j = state.visible.indexOf(b);
  if (i < 0 || j < 0) return toggleSelect(b);
  const [lo, hi] = i < j ? [i, j] : [j, i];
  for (const id of state.visible.slice(lo, hi + 1)) if (!isRoot(state.nodes.get(id))) state.selected.add(id);
  paintSelection();
}

function clearSelection() {
  state.selected.clear();
  state.anchor = null;
  paintSelection();
}

function toggleFolder(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  persistExpanded();
  render();
}

// ---------- actions ----------

async function openUrl(url, newTab) {
  try {
    if (newTab || FULL) return await chrome.tabs.create({ url, active: !newTab });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await chrome.tabs.update(tab.id, { url });
    else await chrome.tabs.create({ url });
  } catch {
    toast(url.startsWith('javascript:') ? 'Bookmarklets can only run from the real bookmarks bar' : 'Could not open that link', true);
  }
}

async function openAll(folder) {
  const urls = folder.children.filter((c) => c.url).map((c) => c.url);
  if (!urls.length) return toast('No links in this folder');
  if (urls.length > 12 && !(await ask({ title: 'Open all', message: `Open ${urls.length} tabs?`, ok: 'OPEN' }))) return;
  for (const url of urls) chrome.tabs.create({ url, active: false });
}

async function newFolder(parent) {
  const res = await ask({
    title: `New folder in ${parent.title}`,
    fields: [{ name: 'title', label: 'Folder name', value: 'New folder' }],
    ok: 'CREATE',
  });
  if (!res) return;
  const f = await chrome.bookmarks.create({ parentId: parent.id, title: res.title || 'New folder' });
  state.expanded.add(parent.id);
  persistExpanded();
  state.flash.add(f.id);
}

async function addCurrentTab(parent) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || tab.url.startsWith(chrome.runtime.getURL(''))) return toast('No tab to capture', true);
  const b = await chrome.bookmarks.create({ parentId: parent.id, title: tab.title || host(tab.url), url: tab.url });
  state.expanded.add(parent.id);
  persistExpanded();
  state.flash.add(b.id);
  toast(`Saved to ${parent.title}`);
}

async function edit(n) {
  const fields = [{ name: 'title', label: 'Name', value: n.title }];
  if (n.url) fields.push({ name: 'url', label: 'URL', value: n.url });
  const res = await ask({ title: n.url ? 'Edit link' : 'Rename folder', fields, ok: 'SAVE' });
  if (!res) return;
  const changes = { title: res.title };
  if (n.url) {
    try { new URL(res.url); } catch { return toast('That URL is not valid', true); }
    changes.url = res.url;
  }
  await chrome.bookmarks.update(n.id, changes);
  state.flash.add(n.id);
}

async function removeItems(ids) {
  if (!ids.length) return;
  const nodes = ids.map((id) => state.nodes.get(id));
  let message;
  if (nodes.length === 1) {
    const [n] = nodes;
    message = isFolder(n) ? `Delete folder “${n.title}” and the ${countLinks(n)} links inside it?` : `Delete “${n.title || n.url}”?`;
  } else {
    const links = nodes.reduce((sum, n) => sum + countLinks(n), 0);
    message = `Delete ${nodes.length} items (${links} links total)?`;
  }
  if (!(await ask({ title: 'Purge', message, ok: 'DELETE', danger: true }))) return;
  for (const n of nodes) await (isFolder(n) ? chrome.bookmarks.removeTree(n.id) : chrome.bookmarks.remove(n.id));
  ids.forEach((id) => state.selected.delete(id));
  toast(nodes.length === 1 ? 'Deleted' : `Deleted ${nodes.length} items`);
}

async function group(ids) {
  if (!ids.length) return toast('Select items first (Ctrl+click)', true);
  const res = await ask({
    title: `Group ${ids.length} item${ids.length > 1 ? 's' : ''}`,
    fields: [{ name: 'title', label: 'New folder name', value: 'New group' }],
    ok: 'GROUP',
  });
  if (!res) return;
  const first = state.nodes.get(ids[0]);
  const folder = await chrome.bookmarks.create({ parentId: first.parentId, index: first.index, title: res.title || 'New group' });
  for (const id of ids) await chrome.bookmarks.move(id, { parentId: folder.id });
  state.expanded.add(folder.id);
  persistExpanded();
  state.selected.clear();
  state.flash.add(folder.id);
}

async function sortFolder(folder) {
  const sorted = [...folder.children].sort((a, b) =>
    isFolder(b) - isFolder(a) || (a.title || a.url).localeCompare(b.title || b.url, undefined, { sensitivity: 'base', numeric: true }));
  for (let i = 0; i < sorted.length; i++) await chrome.bookmarks.move(sorted[i].id, { parentId: folder.id, index: i });
  toast(`Sorted ${folder.title}`);
}

// Act on the whole selection when the clicked item is part of it.
const scope = (n) => (state.selected.has(n.id) ? selection() : [n.id]);

async function runAction(act, n) {
  closeMenu();
  try {
    switch (act) {
      case 'open': return await openUrl(n.url, false);
      case 'open-new': return await openUrl(n.url, true);
      case 'open-all': return await openAll(n);
      case 'copy': await navigator.clipboard.writeText(n.url); return toast('URL copied');
      case 'sub': return await newFolder(n);
      case 'add-tab': return await addCurrentTab(n);
      case 'edit': return await edit(n);
      case 'sort': return await sortFolder(n);
      case 'group': return await group(scope(n));
      case 'del': return await removeItems(scope(n));
    }
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- tree events ----------

treeEl.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return clearSelection();
  const n = state.nodes.get(row.dataset.id);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act) return runAction(act, n);
  if (e.ctrlKey || e.metaKey) return toggleSelect(n.id);
  if (e.shiftKey && state.anchor) return selectRange(state.anchor, n.id);
  if (state.selected.size) clearSelection();
  state.anchor = n.id;
  if (isFolder(n)) toggleFolder(n.id);
  else openUrl(n.url, false);
});

// Middle-click opens in a background tab (and suppresses autoscroll).
treeEl.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
treeEl.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const n = state.nodes.get(e.target.closest('.row')?.dataset.id);
  if (n?.url) openUrl(n.url, true);
});

treeEl.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.preventDefault();
  const n = state.nodes.get(row.dataset.id);
  if (!state.selected.has(n.id)) clearSelection();
  const k = state.selected.has(n.id) ? selection().length : 1;
  const items = [];
  if (n.url) {
    items.push(['open', 'Open'], ['open-new', 'Open in new tab'], ['copy', 'Copy URL'], '-', ['edit', 'Edit…']);
  } else {
    items.push(['open-all', 'Open all in tabs'], ['add-tab', 'Save current tab here'], ['sub', 'New subfolder…'], ['sort', 'Sort A → Z']);
    if (!isRoot(n)) items.push('-', ['edit', 'Rename…']);
  }
  if (!isRoot(n)) {
    items.push(['group', k > 1 ? `Group ${k} selected into folder…` : 'Put in new folder…']);
    items.push('-', ['del', k > 1 ? `Delete ${k} selected` : 'Delete', 'danger']);
  }
  openMenu(items, e.clientX, e.clientY, n);
});

// ---------- drag and drop ----------

let expandTimer;
let dropRow = null;

function clearDrop() {
  clearTimeout(expandTimer);
  dropRow?.classList.remove('drop-before', 'drop-after', 'drop-inside');
  dropRow = null;
}

function endDrag() {
  clearDrop();
  if (!state.drag) return;
  state.drag = null;
  treeEl.querySelectorAll('.dragging').forEach((r) => r.classList.remove('dragging'));
}

function dropZone(row, e) {
  const n = state.nodes.get(row.dataset.id);
  if (isRoot(n)) return 'inside';
  const r = row.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  if (isFolder(n)) {
    if (y < 0.28) return 'before';
    // "after" an open folder would visually sit above its children, so treat it as inside.
    if (y > 0.72 && !row.classList.contains('open')) return 'after';
    return 'inside';
  }
  return y < 0.5 ? 'before' : 'after';
}

function canDrop(ids, targetId) {
  return ids.every((id) => id !== targetId && !isAncestor(id, targetId));
}

// chrome.bookmarks.move uses "insert before this index, counted before removal" semantics,
// so before/after a target is simply target.index / target.index + 1 even within one folder.
function destination(target, zone, open) {
  if (zone === 'inside') return open ? { parentId: target.id, index: 0 } : { parentId: target.id };
  return { parentId: target.parentId, index: target.index + (zone === 'after' ? 1 : 0) };
}

async function moveTo(ids, dest) {
  let { parentId, index } = dest;
  for (const id of ids) {
    const moved = await chrome.bookmarks.move(id, index === undefined ? { parentId } : { parentId, index });
    if (index !== undefined) index = moved.index + 1;
  }
}

treeEl.addEventListener('dragstart', (e) => {
  const row = e.target.closest?.('.row');
  if (!row) return;
  const id = row.dataset.id;
  const n = state.nodes.get(id);
  state.drag = state.selected.has(id) ? selection() : [id];
  e.dataTransfer.effectAllowed = 'copyMove';
  if (n.url) {
    // Lets a bookmark be dragged out onto a page or the tab strip too.
    e.dataTransfer.setData('text/uri-list', n.url);
    e.dataTransfer.setData('text/plain', n.url);
  } else {
    e.dataTransfer.setData('text/plain', n.title);
  }
  if (state.drag.length > 1) {
    const ghost = el('div', 'ghost', `⧉ ${state.drag.length} items`);
    document.body.append(ghost);
    e.dataTransfer.setDragImage(ghost, 12, 12);
    setTimeout(() => ghost.remove());
  }
  requestAnimationFrame(() => state.drag?.forEach((d) => rowFor(d)?.classList.add('dragging')));
});

treeEl.addEventListener('dragover', (e) => {
  const row = e.target.closest('.row');
  const external = !state.drag && e.dataTransfer.types.includes('text/uri-list');
  if (!row || (!state.drag && !external)) return clearDrop();
  const zone = dropZone(row, e);
  if (state.drag && !canDrop(state.drag, row.dataset.id)) return clearDrop();
  e.preventDefault();
  e.dataTransfer.dropEffect = state.drag ? 'move' : 'copy';

  if (dropRow !== row || !row.classList.contains(`drop-${zone}`)) {
    clearDrop();
    dropRow = row;
    row.classList.add(`drop-${zone}`);
    // Hovering inside a closed folder springs it open.
    if (zone === 'inside' && !row.classList.contains('open')) {
      expandTimer = setTimeout(() => {
        state.expanded.add(row.dataset.id);
        persistExpanded();
        render();
        dropRow = null;
      }, 700);
    }
  }
});

treeEl.addEventListener('dragleave', (e) => {
  if (!treeEl.contains(e.relatedTarget)) clearDrop();
});

treeEl.addEventListener('drop', async (e) => {
  const row = e.target.closest('.row');
  const drag = state.drag;
  endDrag();
  if (!row) return;
  e.preventDefault();
  const target = state.nodes.get(row.dataset.id);
  const zone = dropZone(row, e);
  const open = row.classList.contains('open');
  try {
    if (drag) {
      if (!canDrop(drag, target.id)) return;
      await moveTo(drag, destination(target, zone, open));
      if (zone === 'inside' && !open) state.flash.add(target.id);
      else drag.forEach((id) => state.flash.add(id));
    } else {
      await dropExternal(e.dataTransfer, destination(target, zone, open));
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// The drag source row can be re-rendered away mid-drag (spring-open), so it may never get
// dragend. The first mousemove after any drag reliably means it is over.
treeEl.addEventListener('dragend', endDrag);
document.addEventListener('mousemove', () => { if (state.drag) endDrag(); });

async function dropExternal(dt, dest) {
  const url = dt.getData('text/uri-list').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
  if (!url) return;
  let title = '';
  const html = dt.getData('text/html');
  if (html) title = new DOMParser().parseFromString(html, 'text/html').body.textContent.trim();
  const plain = dt.getData('text/plain').trim();
  if (!title && plain && plain !== url) title = plain;
  const b = await chrome.bookmarks.create({ ...dest, title: (title || host(url) || url).slice(0, 200), url });
  state.flash.add(b.id);
  toast('Link captured');
}

// ---------- context menu ----------

function openMenu(items, x, y, n) {
  menuEl.replaceChildren();
  for (const item of items) {
    if (item === '-') { menuEl.append(el('hr')); continue; }
    const [act, label, cls] = item;
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', () => runAction(act, n));
    menuEl.append(b);
  }
  menuEl.hidden = false;
  const { width, height } = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(4, Math.min(x, innerWidth - width - 4))}px`;
  menuEl.style.top = `${Math.max(4, Math.min(y, innerHeight - height - 4))}px`;
}

function closeMenu() {
  menuEl.hidden = true;
}

document.addEventListener('mousedown', (e) => { if (!menuEl.contains(e.target)) closeMenu(); });
treeEl.addEventListener('scroll', closeMenu);
addEventListener('blur', closeMenu);

// ---------- modal + toast ----------

function ask({ title, message, fields = [], ok = 'EXECUTE', danger = false }) {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    const body = $('#modal-body');
    body.replaceChildren();
    if (message) body.append(el('p', 'modal-msg', message));
    const inputs = fields.map((f) => {
      const label = el('label', f.type === 'checkbox' ? 'field check' : 'field');
      const input = el('input');
      input.name = f.name;
      input.type = f.type ?? 'text';
      if (f.type === 'checkbox') input.checked = Boolean(f.value);
      else input.value = f.value ?? '';
      if (f.placeholder) input.placeholder = f.placeholder;
      input.spellcheck = false;
      input.autocomplete = 'off';
      label.append(el('span', null, f.label), input);
      if (f.hint) label.append(el('small', null, f.hint));
      body.append(label);
      return input;
    });
    const okBtn = $('#modal-ok');
    okBtn.textContent = ok;
    okBtn.classList.toggle('danger', danger);
    modal.returnValue = '';
    modal.addEventListener('close', () => {
      if (modal.returnValue !== 'ok') return resolve(null);
      resolve(Object.fromEntries(inputs.map((i) => [i.name, i.type === 'checkbox' ? i.checked : i.value.trim()])));
    }, { once: true });
    modal.showModal();
    inputs[0]?.select();
  });
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- toolbar + keyboard ----------

$('#btn-tab').addEventListener('click', () => runAction('add-tab', targetFolder()));
$('#btn-folder').addEventListener('click', () => runAction('sub', targetFolder()));
$('#btn-group').addEventListener('click', async () => {
  try { await group(selection()); } catch (err) { toast(err.message, true); }
});
$('#btn-expand').addEventListener('click', () => {
  for (const n of state.nodes.values()) if (isFolder(n) && n.parentId) state.expanded.add(n.id);
  persistExpanded();
  render();
});
$('#btn-collapse').addEventListener('click', () => {
  state.expanded.clear();
  persistExpanded();
  render();
});
$('#btn-full').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('panel.html?full') }));

searchEl.addEventListener('input', () => {
  state.query = searchEl.value;
  render();
});

document.addEventListener('keydown', (e) => {
  if (modal.open) return;
  if (e.target === searchEl) {
    if (e.key === 'Escape' && searchEl.value) { searchEl.value = ''; state.query = ''; render(); }
    return;
  }
  const sel = selection();
  if (e.key === '/') { e.preventDefault(); searchEl.focus(); }
  else if (e.key === 'Escape') { closeMenu(); clearSelection(); }
  else if (e.key === 'Delete' && sel.length) removeItems(sel).catch((err) => toast(err.message, true));
  else if (e.key === 'F2' && sel.length === 1) runAction('edit', state.nodes.get(sel[0]));
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g' && sel.length) {
    e.preventDefault();
    group(sel).catch((err) => toast(err.message, true));
  }
});

// ---------- signal feed (data is polled by background.js) ----------
// One horizontal ticker per source, stacked, each scrolling that source's 10 latest items.

const SOURCE_META = {
  linkedin: { label: 'LINKEDIN', glyph: 'in' },
  devto: { label: 'DEV', glyph: 'D' },
  server: { label: 'JETSON', glyph: '⛨' },
  sales: { label: 'SALES', glyph: '$' },
};
const TICKER_ITEMS = 10;
const TICKER_SPEED = 35;  // px per second
const feedEl = $('#feed');
const tickersEl = $('#tickers');
const tickers = new Map();  // source -> { el, sig }
const feed = { items: [], errors: {}, updatedAt: 0, seenAt: 0, settings: {} };
let seenTimer;

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

async function loadFeed() {
  const data = await chrome.storage.local.get(['feed', 'seenAt', 'settings']);
  feed.items = data.feed?.items ?? [];
  feed.errors = data.feed?.errors ?? {};
  feed.updatedAt = data.feed?.updatedAt ?? 0;
  feed.seenAt = data.seenAt ?? Date.now();
  feed.settings = data.settings ?? {};
  renderFeed();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.feed || changes.seenAt || changes.settings)) loadFeed();
});

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function money(cents, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function activeSources() {
  const s = feed.settings;
  const on = {
    linkedin: s.linkedin !== false,
    devto: s.devto !== false,
    server: Boolean(s.serverUrl),
    sales: Boolean(s.stripeKey),
  };
  return Object.keys(SOURCE_META).filter((src) => on[src]);
}

function renderFeed() {
  const isNew = (i) => i.ts > feed.seenAt;

  const total = feed.items.filter(isNew).length;
  $('#feed-new').hidden = !total;
  $('#feed-new').textContent = `${total} NEW`;

  const midnight = new Date().setHours(0, 0, 0, 0);
  const today = feed.items.filter((i) => i.source === 'sales' && !i.refunded && i.ts >= midnight);
  $('#feed-today').textContent = today.length
    ? `TODAY ${money(today.reduce((sum, i) => sum + i.amount, 0), today[0].currency)} · ${today.length}`
    : '';

  const sources = activeSources();
  for (const [src, t] of tickers) {
    if (!sources.includes(src)) { t.el.remove(); tickers.delete(src); }
  }
  tickersEl.querySelector('.feed-empty')?.remove();
  if (!sources.length) tickersEl.append(el('div', 'feed-empty', 'No sources connected. Hit ⚙ to jack in.'));

  sources.forEach((src, idx) => {
    const items = feed.items.filter((i) => i.source === src).slice(0, TICKER_ITEMS);
    const error = feed.errors[src];
    let t = tickers.get(src);
    if (!t) {
      t = { el: makeTicker(src), sig: null };
      tickers.set(src, t);
    }
    // Re-inserting a node restarts its animation, so only move it when it is out of place.
    if (tickersEl.children[idx] !== t.el) tickersEl.insertBefore(t.el, tickersEl.children[idx] ?? null);
    // Only rebuild the track when its content changes, so the scroll doesn't jump on every sync.
    const sig = JSON.stringify([items.map((i) => [i.id, i.title, i.detail, i.level]), error]);
    if (t.sig !== sig) {
      t.sig = sig;
      fillTicker(t.el, items, error);
    }
    t.el.querySelector('.ticker-label b').textContent = items.filter(isNew).length || '';
  });

  // Times and "new" dots update in place.
  for (const item of tickersEl.querySelectorAll('.tk-item')) {
    const ts = Number(item.dataset.ts);
    item.classList.toggle('new', ts > feed.seenAt);
    item.querySelector('time').textContent = ago(ts);
  }

  $('#feed-refresh').title = feed.updatedAt ? `Last sync ${new Date(feed.updatedAt).toLocaleTimeString()}. Refresh now` : 'Refresh now';

  // Items count as seen once the open feed has been on screen for a few seconds.
  clearTimeout(seenTimer);
  if (total && !feedEl.classList.contains('collapsed') && document.visibilityState === 'visible') {
    seenTimer = setTimeout(() => send('seen'), 6000);
  }
}

function makeTicker(src) {
  const row = el('div', `ticker src-${src}`);
  const label = el('span', 'ticker-label');
  label.append(el('span', 'fi-glyph', SOURCE_META[src].glyph), el('span', null, SOURCE_META[src].label), el('b'));
  const view = el('div', 'ticker-view');
  view.append(el('div', 'ticker-track'));
  row.append(label, view);
  return row;
}

function tickerItem(i) {
  const href = /^https?:\/\//.test(i.url ?? '') ? i.url : null;
  const item = el(href ? 'a' : 'span', 'tk-item');
  if (href) {
    item.href = href;
    item.target = '_blank';
    item.rel = 'noreferrer';
  }
  if (i.level) item.classList.add(`lvl-${i.level}`);
  item.classList.toggle('unread', Boolean(i.unread));
  item.dataset.ts = i.ts;
  item.title = [i.title, i.detail, new Date(i.ts).toLocaleString()].filter(Boolean).join('\n');
  item.append(el('span', 'tk-title', i.title));
  if (i.detail) item.append(el('span', 'tk-detail', i.detail.length > 80 ? `${i.detail.slice(0, 80)}…` : i.detail));
  item.append(el('time', null, ago(i.ts)));
  return item;
}

function fillTicker(row, items, error) {
  const group = el('div', 'tk-group');
  if (error) group.append(el('span', 'tk-error', `⚠ ${error}`), el('span', 'tk-sep', '◆'));
  for (const i of items) group.append(tickerItem(i), el('span', 'tk-sep', '◆'));
  if (!items.length && !error) group.append(el('span', 'tk-quiet', 'quiet on this channel'), el('span', 'tk-sep', '◆'));
  row.querySelector('.ticker-track').replaceChildren(group);
  layoutTicker(row);
}

// Repeat the group until it overfills the view, then slide by exactly one group width so the loop is seamless.
function layoutTicker(row) {
  const view = row.querySelector('.ticker-view');
  const track = row.querySelector('.ticker-track');
  const group = track.firstElementChild;
  track.querySelectorAll('.tk-group[aria-hidden]').forEach((g) => g.remove());
  const w = group?.offsetWidth;
  if (!w) return;  // hidden (feed collapsed); laid out again when shown
  const copies = Math.ceil(view.clientWidth / w) + 1;
  for (let k = 1; k < copies; k++) {
    const clone = group.cloneNode(true);
    clone.setAttribute('aria-hidden', 'true');
    clone.querySelectorAll('a').forEach((a) => { a.tabIndex = -1; });
    track.append(clone);
  }
  track.style.setProperty('--shift', `${w}px`);
  track.style.animationDuration = `${w / TICKER_SPEED}s`;
}

function relayoutTickers() {
  for (const t of tickers.values()) layoutTicker(t.el);
}

async function openSettings() {
  const s = feed.settings;
  const res = await ask({
    title: 'Signal sources',
    fields: [
      { name: 'linkedin', type: 'checkbox', label: 'LinkedIn notifications', value: s.linkedin !== false, hint: 'Uses the LinkedIn login already in this browser.' },
      { name: 'devto', type: 'checkbox', label: 'dev.to notifications', value: s.devto !== false, hint: 'Uses the dev.to login already in this browser.' },
      { name: 'serverUrl', label: 'Jetson feed URL', value: s.serverUrl ?? '', placeholder: 'http://192.168.1.x:8890/feed' },
      { name: 'serverToken', type: 'password', label: 'Jetson feed token', value: s.serverToken ?? '' },
      { name: 'stripeKey', type: 'password', label: 'Stripe restricted key', value: s.stripeKey ?? '', placeholder: 'rk_live_…', hint: 'Restricted key with only "Charges: Read".' },
      { name: 'alerts', type: 'checkbox', label: 'Desktop alerts for sales, dev.to + server warnings', value: s.alerts !== false },
    ],
    ok: 'SAVE',
  });
  if (!res) return;
  if (res.serverUrl) {
    let u;
    try { u = new URL(res.serverUrl); } catch { return toast('Jetson URL is not valid', true); }
    try {
      const ok = await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
      if (!ok) return toast('Chrome needs permission to reach the Jetson', true);
    } catch (err) {
      return toast(err.message, true);
    }
  }
  await chrome.storage.local.set({ settings: res });
  if (res.stripeKey && !res.stripeKey.startsWith('rk_')) toast('Saved, but use a read-only restricted key (rk_…), not a secret key', true);
  else toast('Sources saved, syncing…');
  send('poll');
}

$('#feed-toggle').addEventListener('click', () => {
  store.set('feedCollapsed', feedEl.classList.toggle('collapsed'));
  relayoutTickers();
  renderFeed();
});
$('#feed-settings').addEventListener('click', openSettings);
$('#feed-refresh').addEventListener('click', async () => {
  const b = $('#feed-refresh');
  b.classList.add('spin');
  await send('poll');
  b.classList.remove('spin');
});
document.addEventListener('visibilitychange', renderFeed);
setInterval(renderFeed, 60_000);

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(relayoutTickers, 150);
});

feedEl.classList.toggle('collapsed', store.get('feedCollapsed', false));

refresh();
loadFeed().then(() => { if (Date.now() - feed.updatedAt > 2 * 60_000) send('poll'); });
