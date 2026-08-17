// DM启动台 - 渲染进程
const $ = (s) => document.querySelector(s);

let games = [];
let settings = { scanDepth: 4, sort: 'name-asc', grouped: true, groups: [], minSizeMB: 10, excluded: [] };
let ctxTarget = null;
let argsTarget = null;
let nameTarget = null;
let grpModalTarget = null;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fileUrl(p) { return 'file:///' + String(p).replace(/\\/g, '/'); }
function status(t) { $('#statusbar').textContent = t; }
function disp(g) { return g.displayName || g.name; }

// 顶部消息提示：2 秒自动消失，不阻塞操作
function showToast(message, type) {
  const box = $('#toast');
  const item = document.createElement('div');
  item.className = 'toast-item' + (type === 'err' ? ' err' : '');
  item.textContent = message;
  box.appendChild(item);
  setTimeout(() => {
    item.style.transition = 'opacity .3s';
    item.style.opacity = '0';
    setTimeout(() => item.remove(), 320);
  }, 2000);
}

// 简易 Markdown → HTML（标题/列表/加粗/段落），用于使用说明弹窗
function mdInline(s) { return s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>'); }
function mdToHtml(md) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lines = String(md).split(/\r?\n/);
  let html = '';
  let inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); html += `<h${h[1].length}>${mdInline(esc(h[2]))}</h${h[1].length}>`; continue; }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${mdInline(esc(li[1]))}</li>`;
      continue;
    }
    closeList();
    if (!line.trim()) continue;
    html += `<p>${mdInline(esc(line))}</p>`;
  }
  closeList();
  return html;
}

// 关闭分组（平铺）时按文件夹去重；分组模式下保留跨组重复以便按组展示
function dedupeFlat(list) {
  const seen = new Set();
  const out = [];
  for (const g of list) {
    const k = g.folder.toLowerCase().replace(/[\\/]+$/, '');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(g);
  }
  return out;
}

// 图标：exe 图标 / 目录图标文件 → 显示；都没有 → 占位手柄
function iconHtml(g) {
  return g.iconPath ? `<img src="${fileUrl(g.iconPath)}" alt="">` : '🎮';
}

async function refresh() {
  status('正在扫描…');
  const r = await window.dm.listGames();
  if (!Array.isArray(r)) { status(r && r.error ? r.error : '扫描失败'); return; }
  games = r;
  const miss = games.filter((g) => !g.exePath).length;
  status(`共 ${games.length} 个游戏 · ${miss} 个未设置启动程序`);
  render();
  if (!document.querySelector('#settings-modal').classList.contains('hidden')) renderGroups();
  if (grpModalTarget && !document.querySelector('#grp-modal').classList.contains('hidden')) renderGrpModal();
}

function searchVal() { return (bpm ? $('#bpm-search') : $('#search')).value.trim().toLowerCase(); }

function sortedGames() {
  const q = searchVal();
  const list = games.filter((g) => !q || disp(g).toLowerCase().includes(q));
  const mode = $('#sort').value;
  const copy = list.slice();
  if (mode === 'name-asc' || mode === 'name-desc') {
    copy.sort((a, b) => disp(a).localeCompare(disp(b), 'zh'));
    if (mode === 'name-desc') copy.reverse();
  } else if (mode === 'mtime-desc' || mode === 'mtime-asc') {
    copy.sort((a, b) => a.mtime - b.mtime);
    if (mode === 'mtime-desc') copy.reverse();
  } else if (mode === 'random') {
    copy.sort(() => Math.random() - 0.5);
  }
  return copy;
}

function makeCard(g) {
  const card = document.createElement('div');
  card.className = 'card' + (g.exePath ? '' : ' missing');
  card.dataset.folder = g.folder;
  card.innerHTML = `<div class="ic">${iconHtml(g)}</div><div class="nm">${esc(disp(g))}</div>`;
  bindImgError(card);
  card.addEventListener('click', () => launch(g));
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); showCtx(e, g); });
  return card;
}

// 图标文件加载失败（损坏/被删）→ 回退占位
function bindImgError(card) {
  const img = card.querySelector('.ic img');
  if (img) img.addEventListener('error', () => {
    const ic = card.querySelector('.ic');
    if (ic) ic.textContent = '🎮';
  });
}
function render() {
  const grid = $('#grid');
  grid.innerHTML = '';
  const list = sortedGames();
  if (!list.length) {
    grid.innerHTML = '<div style="text-align:center;color:rgba(255,255,255,.4);padding:60px 0;font-size:14px">没有找到匹配的游戏</div>';
    return;
  }
  const cardsWrap = (items) => {
    const c = document.createElement('div');
    c.className = 'cards';
    for (const g of items) c.appendChild(makeCard(g));
    return c;
  };
  if (bpm) {
    // 大屏模式：统一平铺（去重）+ 手柄选中态
    const flat = dedupeFlat(list);
    grid.appendChild(cardsWrap(flat));
    afterSelect(flat);
    return;
  }
  if (settings.grouped) {
    const order = settings.groups.filter((g) => g.enabled).map((g) => g.id);
    let rendered = 0;
    for (const gid of order) {
      const items = list.filter((g) => g.groupId === gid);
      if (!items.length) continue;
      const grp = settings.groups.find((g) => g.id === gid);
      const sec = document.createElement('div');
      sec.className = 'section';
      sec.innerHTML = `<div class="sec-title">${esc(grp ? grp.name : '未分组')}<span class="sec-count">${items.length}</span></div>`;
      sec.appendChild(cardsWrap(items));
      grid.appendChild(sec);
      rendered += items.length;
    }
    if (!rendered) grid.innerHTML = '<div style="text-align:center;color:rgba(255,255,255,.4);padding:60px 0;font-size:14px">没有找到匹配的游戏</div>';
  } else {
    grid.appendChild(cardsWrap(dedupeFlat(list)));
  }
}

async function launch(g) {
  if (!g.exePath) {
    alert('「' + disp(g) + '」未设置启动程序，请右键「更改启动程序」手动指定。');
    return;
  }
  const r = await window.dm.launch(g.folder);
  if (r && !r.ok && r.error) alert(r.error);
}

// ---------- 右键菜单 ----------
function showCtx(e, g) {
  ctxTarget = g;
  const m = $('#ctxmenu');
  m.innerHTML = '';
  const add = (label, fn) => {
    const d = document.createElement('div');
    d.className = 'it';
    d.textContent = label;
    d.addEventListener('click', () => { hideCtx(); fn(); });
    m.appendChild(d);
  };
  const sep = () => { const d = document.createElement('div'); d.className = 'sep'; m.appendChild(d); };

  add('启动游戏', () => launch(g));
  add('打开文件夹', () => window.dm.openPath(g.folder));
  add('更改启动程序…', async () => { const p = await window.dm.chooseExe(g.folder); if (p) refresh(); });
  if (g.overridden) add('恢复自动识别', async () => { await window.dm.clearOverride(g.folder); refresh(); });
  sep();
  add('重命名…', () => showNameModal(g));
  if (g.renamed) add('恢复默认名称', async () => { await window.dm.setOptions(g.folder, { name: '' }); refresh(); });
  sep();
  const adminIt = document.createElement('div');
  adminIt.className = 'it' + (g.admin ? ' check' : '');
  adminIt.textContent = '以管理员身份启动';
  adminIt.addEventListener('click', async () => { hideCtx(); await window.dm.setOptions(g.folder, { admin: !g.admin }); refresh(); });
  m.appendChild(adminIt);
  add('设置启动参数…', () => showArgs(g));
  sep();
  add('从列表中排除该文件夹', async () => {
    if (!confirm('排除「' + g.folder + '」？以后扫描不再把它当作游戏（可在分组「详情」弹窗中恢复）。')) return;
    await window.dm.excludeGame(g.folder);
    await refresh();
  });
  sep();
  add('重新扫描', refresh);

  m.style.display = 'block';
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - r.height - 8)) + 'px';
}
function hideCtx() { $('#ctxmenu').style.display = 'none'; ctxTarget = null; }

// ---------- 重命名 / 启动参数 ----------
function showNameModal(g) {
  nameTarget = g;
  $('#name-title').textContent = '重命名：' + (g.renamed ? g.name : disp(g));
  $('#name-input').value = g.renamed ? disp(g) : '';
  $('#name-modal').classList.remove('hidden');
  $('#name-input').focus();
}

function showArgs(g) {
  argsTarget = g;
  $('#args-title').textContent = '启动参数：' + disp(g);
  $('#args-input').value = g.args || '';
  $('#args-modal').classList.remove('hidden');
  $('#args-input').focus();
}

// ---------- 分组管理 ----------
function groupBadge(type) {
  const label = { custom: '自定义', steam: 'Steam', wegame: 'WeGame', epic: 'Epic' }[type] || type;
  const cls = ['steam', 'wegame', 'epic'].includes(type) ? ' ' + type : '';
  return `<span class="badge${cls}">${label}</span>`;
}

function dirUnder(dir, root) {
  const d = dir.toLowerCase();
  const r = (/[\\/]$/.test(root) ? root : root + '\\').toLowerCase();
  return d.startsWith(r);
}

function groupGames(g) { return games.filter((x) => x.groupId === g.id); }

// 设置页：分组摘要列表
function renderGroups() {
  const box = $('#grp-list');
  box.innerHTML = '';
  if (!settings.groups.length) {
    box.innerHTML = '<div style="color:rgba(255,255,255,.4);font-size:13px;padding:8px 2px">还没有分组，点上方按钮导入目录或添加平台。</div>';
    return;
  }
  for (const g of settings.groups) {
    const isPlatform = ['steam', 'wegame', 'epic'].includes(g.type);
    const el = document.createElement('div');
    el.className = 'grp';
    el.innerHTML = `
      <div class="grp-head">
        ${isPlatform
          ? `<span class="grp-name grp-name-static" title="默认平台分组名称不可修改">${esc(g.name)}</span>`
          : `<input class="grp-name" type="text" value="${esc(g.name)}" spellcheck="false">`}
        ${groupBadge(g.type)}
        <label><input type="checkbox" class="grp-en" ${g.enabled ? 'checked' : ''}> 启用</label>
        <span class="dir-count">${g.dirs.length} 目录 · ${groupGames(g).length} 游戏</span>
        <div class="spacer"></div>
        <button class="btn" data-act="detail">详情</button>
        <button class="btn" data-act="up" title="上移">↑</button>
        <button class="btn" data-act="down" title="下移">↓</button>
        <button class="btn danger" data-act="del" title="删除分组">删除</button>
      </div>`;
    if (!isPlatform) {
      const nameInput = el.querySelector('.grp-name');
      nameInput.addEventListener('change', async () => {
        // 更新后同步本地分组数据，否则重绘会显示旧名称
        settings.groups = await window.dm.updateGroup({ id: g.id, name: nameInput.value.trim() || g.name });
        renderGroups();
        await refresh();
      });
    }
    el.querySelector('.grp-en').addEventListener('change', async (ev) => {
      settings.groups = await window.dm.updateGroup({ id: g.id, enabled: ev.target.checked });
      refresh();
    });
    el.querySelector('[data-act=detail]').addEventListener('click', () => showGroupModal(g));
    el.querySelector('[data-act=up]').addEventListener('click', async () => { settings.groups = await window.dm.moveGroup(g.id, -1); renderGroups(); await refresh(); });
    el.querySelector('[data-act=down]').addEventListener('click', async () => { settings.groups = await window.dm.moveGroup(g.id, 1); renderGroups(); await refresh(); });
    el.querySelector('[data-act=del]').addEventListener('click', async () => {
      if (!confirm('删除分组「' + g.name + '」？')) return;
      settings.groups = await window.dm.deleteGroup(g.id);
      renderGroups(); await refresh();
    });
    box.appendChild(el);
  }
}

// 分组详情二级弹窗：目录 + 已排除 + 组内游戏
function showGroupModal(g) {
  grpModalTarget = g;
  $('#grp-modal-title').textContent = '分组详情：' + g.name;
  renderGrpModal();
  $('#grp-modal').classList.remove('hidden');
}

function renderGrpModal() {
  const g = grpModalTarget;
  if (!g) return;
  const dirs = $('#grp-modal-dirs');
  dirs.innerHTML = '';
  if (!g.dirs.length) dirs.innerHTML = '<div style="color:rgba(255,255,255,.4);font-size:12px">（空，请添加目录）</div>';
  for (const d of g.dirs) {
    const chip = document.createElement('span');
    chip.className = 'dir-chip';
    chip.innerHTML = `${esc(d)}<span class="x" title="从分组移除">×</span>`;
    chip.querySelector('.x').addEventListener('click', async () => {
      await window.dm.updateGroup({ id: g.id, dirs: g.dirs.filter((x) => x !== d) });
      g.dirs = g.dirs.filter((x) => x !== d);
      renderGrpModal();
      await refresh();
    });
    dirs.appendChild(chip);
  }

  const exBox = $('#grp-modal-excluded');
  exBox.innerHTML = '';
  const exUnder = (settings.excluded || []).filter((x) => g.dirs.some((r) => dirUnder(x, r)));
  if (!exUnder.length) exBox.innerHTML = '<div style="color:rgba(255,255,255,.35);font-size:12px">（无）</div>';
  for (const x of exUnder) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.05);padding:5px 10px;border-radius:8px;font-size:12px';
    row.innerHTML = `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(255,255,255,.65)">${esc(x)}</span>`;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '恢复';
    btn.addEventListener('click', async () => {
      await window.dm.unexcludeGame(x);
      settings.excluded = (settings.excluded || []).filter((y) => y !== x);
      renderGrpModal();
      await refresh();
    });
    row.appendChild(btn);
    exBox.appendChild(row);
  }

  // 组内游戏列表
  const list = groupGames(g);
  $('#grp-games-count').textContent = list.length;
  const tbody = $('#grp-games-tbody');
  tbody.innerHTML = '';
  for (const game of list) {
    const tr = document.createElement('tr');
    const pathTxt = game.exePath
      ? (game.overridden ? '📌 ' : '') + game.exePath
      : (game.hasExe ? '' : '⚠ 未找到启动程序');
    tr.innerHTML = `<td title="${esc(game.renamed ? game.name : '')}">${esc(disp(game))}</td><td class="exepath" title="${esc(game.exePath || '')}">${esc(pathTxt)}</td>
      <td><div class="act">
        <button class="btn" data-a="rename">改名</button>
        <button class="btn" data-a="open">打开路径</button>
        <button class="btn" data-a="pick">更改程序</button>
        ${game.overridden ? '<button class="btn" data-a="reset">恢复自动</button>' : ''}
        <button class="btn" data-a="excl" title="以后扫描不再把它当作游戏">排除</button>
      </div></td>`;
    tr.querySelector('[data-a=rename]').addEventListener('click', () => showNameModal(game));
    tr.querySelector('[data-a=open]').addEventListener('click', () => window.dm.openPath(game.folder));
    tr.querySelector('[data-a=pick]').addEventListener('click', async () => {
      const p = await window.dm.chooseExe(game.folder);
      if (p) { renderGrpModal(); await refresh(); }
    });
    const resetBtn = tr.querySelector('[data-a=reset]');
    if (resetBtn) resetBtn.addEventListener('click', async () => { await window.dm.clearOverride(game.folder); renderGrpModal(); await refresh(); });
    tr.querySelector('[data-a=excl]').addEventListener('click', async () => {
      await window.dm.excludeGame(game.folder);
      renderGrpModal();
      await refresh();
    });
    tbody.appendChild(tr);
  }
}

async function addPlatform(type) {
  const names = { steam: 'Steam', wegame: 'WeGame', epic: 'Epic' };
  // 平台已存在也正常扫描（合并目录）；仅以 toast 提示，不阻断
  const existed = settings.groups.some((g) => g.type === type);
  const res = await window.dm.detectGroup(type);
  if (!res.dirs.length) {
    showToast(names[type] + '：未检测到安装目录（可在分组「详情」手动「+ 添加目录」）', 'err');
    return;
  }
  settings.groups = await window.dm.addGroup({ name: names[type], type, dirs: res.dirs, layout: res.layout || 'subdirs' });
  renderGroups();
  await refresh();
  showToast(existed ? names[type] + ' 平台已存在，已更新目录并重新扫描' : names[type] + ' 平台已添加并扫描', 'ok');
}

// ---------- 设置页 ----------
function openSettings() {
  $('#set-depth').value = String(settings.scanDepth || 4);
  $('#set-minmb').value = settings.minSizeMB != null ? settings.minSizeMB : 10;
  renderGroups();
  $('#settings-modal').classList.remove('hidden');
}
function closeSettings() { $('#settings-modal').classList.add('hidden'); }

// ---------- 大屏模式（Steam 大屏风格，支持手柄） ----------
let bpm = false;
let bpmSelected = null;      // 当前选中游戏的文件夹
let gpPrev = new Map();      // 手柄按键状态快照
let gpInit = false;
let gpLastMove = 0;
let gpLoopId = null;

function bpmCards() { return dedupeFlat(sortedGames()); }

function enterBPM() {
  if (bpm) return;
  bpm = true;
  document.body.classList.add('bpm');
  window.dm.setFullscreen(true);
  window.dm.setSettings({ bigPicture: true });
  render();
  startGamepad();
}
function exitBPM() {
  if (!bpm) return;
  bpm = false;
  document.body.classList.remove('bpm');
  window.dm.setFullscreen(false);
  window.dm.setSettings({ bigPicture: false });
  stopGamepad();
  render();
}

function afterSelect(list) {
  if (!bpm) return;
  if (!bpmSelected || !list.some((g) => g.folder === bpmSelected)) {
    bpmSelected = list.length ? list[0].folder : null;
  }
  document.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
  if (!bpmSelected) return;
  let found = null;
  for (const c of document.querySelectorAll('.card')) {
    if (c.dataset.folder === bpmSelected) { found = c; break; }
  }
  if (found) {
    found.classList.add('selected');
    found.scrollIntoView({ block: 'nearest' });
  }
}

function gridCols() {
  const cards = document.querySelector('#grid .cards');
  if (!cards) return 1;
  const t = getComputedStyle(cards).gridTemplateColumns;
  const n = t.split(' ').filter((s) => s && s !== 'none').length;
  return n || 1;
}

function snapPad(pad) {
  const m = new Map();
  (pad.buttons || []).forEach((b, i) => m.set(i, !!b.pressed));
  return m;
}

function startGamepad() {
  stopGamepad();
  gpInit = false;
  gpPrev = new Map();
  const step = () => {
    gpLoopId = requestAnimationFrame(step);
    let pads = [];
    try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch {}
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (!pad) { gpPrev = new Map(); gpInit = false; return; }
    if (!gpInit) { gpPrev = snapPad(pad); gpInit = true; return; } // 首次连接不触发
    const list = bpmCards();
    if (!list.length) { gpPrev = snapPad(pad); return; }
    const idx = Math.max(0, list.findIndex((g) => g.folder === bpmSelected));
    const cols = gridCols();
    const now = Date.now();
    const moved = now - gpLastMove > 170;
    const axes = pad.axes || [];
    let dx = 0, dy = 0;
    if (pad.buttons[14] && pad.buttons[14].pressed) dy = -1;
    else if (pad.buttons[15] && pad.buttons[15].pressed) dy = 1;
    else if (pad.buttons[12] && pad.buttons[12].pressed) dx = -1;
    else if (pad.buttons[13] && pad.buttons[13].pressed) dx = 1;
    if (!dx && !dy) {
      if (axes[0] > 0.5) dx = 1; else if (axes[0] < -0.5) dx = -1;
      if (axes[1] > 0.5) dy = 1; else if (axes[1] < -0.5) dy = -1;
    }
    let target = idx;
    if (dy === -1) target = Math.max(0, idx - cols);
    else if (dy === 1) target = Math.min(list.length - 1, idx + cols);
    else if (dx === -1) target = Math.max(0, idx - 1);
    else if (dx === 1) target = Math.min(list.length - 1, idx + 1);
    if ((dx || dy) && moved && target !== idx) {
      gpLastMove = now;
      bpmSelected = list[target].folder;
      afterSelect(list);
    }
    const press = (i) => !!pad.buttons[i] && pad.buttons[i].pressed && !gpPrev.get(i);
    if (press(0) || press(2)) { const g = list[idx]; gpPrev = snapPad(pad); if (g) launch(g); return; }
    if (press(1) || press(8) || press(9)) { gpPrev = snapPad(pad); exitBPM(); return; }
    gpPrev = snapPad(pad);
  };
  gpLoopId = requestAnimationFrame(step);
}
function stopGamepad() { if (gpLoopId) { cancelAnimationFrame(gpLoopId); gpLoopId = null; } }

// ---------- 事件绑定 ----------
$('#search').addEventListener('input', render);
$('#sort').addEventListener('change', () => { window.dm.setSettings({ sort: $('#sort').value }); render(); });
$('#group-btn').addEventListener('click', async () => {
  settings.grouped = !settings.grouped;
  await window.dm.setSettings({ grouped: settings.grouped });
  $('#group-btn').classList.toggle('on', !!settings.grouped);
  render();
});
$('#bpm-btn').addEventListener('click', enterBPM);
$('#bpm-exit').addEventListener('click', exitBPM);
$('#bpm-search').addEventListener('input', render);
document.addEventListener('keydown', (e) => {
  if (!bpm) return;
  if (e.key === 'Escape') { exitBPM(); return; }
  const list = bpmCards();
  if (!list.length) return;
  const idx = Math.max(0, list.findIndex((g) => g.folder === bpmSelected));
  const cols = gridCols();
  let t = idx;
  if (e.key === 'ArrowUp') t = Math.max(0, idx - cols);
  else if (e.key === 'ArrowDown') t = Math.min(list.length - 1, idx + cols);
  else if (e.key === 'ArrowLeft') t = Math.max(0, idx - 1);
  else if (e.key === 'ArrowRight') t = Math.min(list.length - 1, idx + 1);
  else if (e.key === 'Enter') { const g = list[idx]; if (g) launch(g); return; }
  else return;
  if (t !== idx) { bpmSelected = list[t].folder; afterSelect(list); }
  e.preventDefault();
});
$('#refresh').addEventListener('click', refresh);
$('#settings-btn').addEventListener('click', openSettings);
$('#min-btn').addEventListener('click', () => window.dm.minimize());
$('#close-btn').addEventListener('click', () => window.dm.hide());
$('#set-cancel').addEventListener('click', closeSettings);
$('#set-save').addEventListener('click', async () => {
  await window.dm.setSettings({
    scanDepth: parseInt($('#set-depth').value, 10),
    minSizeMB: Math.max(0, parseInt($('#set-minmb').value, 10) || 0)
  });
  closeSettings();
  await refresh();
});
$('#about-btn').addEventListener('click', async () => {
  const md = await window.dm.getAbout();
  $('#about-content').innerHTML = mdToHtml(md);
  $('#about-modal').classList.remove('hidden');
});
$('#about-close').addEventListener('click', () => $('#about-modal').classList.add('hidden'));
$('#grp-import').addEventListener('click', async () => {
  const groups = await window.dm.importGroups();
  if (groups) { settings.groups = groups; renderGroups(); await refresh(); }
});
$('#grp-steam').addEventListener('click', () => addPlatform('steam'));
$('#grp-wegame').addEventListener('click', () => addPlatform('wegame'));
$('#grp-epic').addEventListener('click', () => addPlatform('epic'));
$('#grp-modal-add').addEventListener('click', async () => {
  const dirs = await window.dm.pickDirs();
  if (!dirs || !dirs.length) return;
  const g = grpModalTarget;
  const merged = [...g.dirs, ...dirs.filter((d) => !g.dirs.includes(d))];
  await window.dm.updateGroup({ id: g.id, dirs: merged });
  g.dirs = merged;
  renderGrpModal();
  await refresh();
});
$('#grp-modal-close').addEventListener('click', () => $('#grp-modal').classList.add('hidden'));
$('#args-cancel').addEventListener('click', () => $('#args-modal').classList.add('hidden'));
$('#args-ok').addEventListener('click', async () => {
  const v = $('#args-input').value.trim();
  if (argsTarget) await window.dm.setOptions(argsTarget.folder, { args: v });
  $('#args-modal').classList.add('hidden');
  await refresh();
});
$('#args-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#args-ok').click(); });
$('#name-cancel').addEventListener('click', () => $('#name-modal').classList.add('hidden'));
$('#name-ok').addEventListener('click', async () => {
  const v = $('#name-input').value.trim();
  if (nameTarget) await window.dm.setOptions(nameTarget.folder, { name: v });
  $('#name-modal').classList.add('hidden');
  await refresh();
});
$('#name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#name-ok').click(); });
document.addEventListener('click', (e) => { if (!e.target.closest('#ctxmenu')) hideCtx(); });

window.dm.onLaunchError((info) => alert('启动失败：' + info.name + '\n' + info.message));
window.dm.onToast((info) => showToast(info.message, info.type));

(async function init() {
  settings = await window.dm.getSettings();
  $('#sort').value = settings.sort || 'name-asc';
  $('#group-btn').classList.toggle('on', !!settings.grouped);
  await refresh();
  // 大屏模式持久化：游戏退出重建窗口后自动恢复大屏
  if (settings.bigPicture) enterBPM();
})();
