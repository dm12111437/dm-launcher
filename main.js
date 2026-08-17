// DM启动台 - 主进程
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { scanGames, detectPlatform, dedupePaths } = require('./scanner');

const APP_DIR = __dirname;
const ASSETS = path.join(APP_DIR, 'assets');

// 冒烟测试：数据目录放到项目内，方便自动化验证
if (process.env.DM_SMOKE) {
  try { app.setPath('userData', path.join(APP_DIR, '.smoke-data')); } catch (e) {}
  app.commandLine.appendSwitch('disable-gpu');
}

const DEFAULT_SETTINGS = { scanDepth: 4, sort: 'name-asc', grouped: true, minSizeMB: 10, excluded: [] };
const PLATFORM_NAMES = { steam: 'Steam', wegame: 'WeGame', epic: 'Epic' };

let win = null;
let tray = null;
let isQuitting = false;
let gameRunning = false;
let lastGames = [];

function settingsFile() { return path.join(app.getPath('userData'), 'settings.json'); }
function overridesFile() { return path.join(app.getPath('userData'), 'overrides.json'); }
function loadJson(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } }
function saveJson(file, obj) { try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch (e) { console.error('保存失败', e); } }

// 设置：含分组列表；旧版 depth 自动迁移。
// 不默认创建任何目录/分组：首次运行也是空列表，由用户自行添加
function getSettings() {
  const raw = loadJson(settingsFile(), {});
  const s = { ...DEFAULT_SETTINGS, ...raw };
  if (s.depth && !s.scanDepth) s.scanDepth = s.depth;
  if (!Array.isArray(s.groups)) s.groups = [];
  return s;
}
function saveSettings(s) { saveJson(settingsFile(), s); }
function getOverrides() { return loadJson(overridesFile(), {}); }
function saveOverrides(o) { saveJson(overridesFile(), o); }

function newGroupId() { return 'g-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

// ---------- 扫描与识别 ----------
async function doScan() {
  const settings = getSettings();
  const depth = Math.min(8, Math.max(1, settings.scanDepth || 4));
  let games;
  try {
    games = await scanGames({
      groups: settings.groups,
      depth,
      overrides: getOverrides(),
      excluded: settings.excluded || [],
      minSizeMB: settings.minSizeMB || 0
    });
  } catch {
    return { error: '扫描失败' };
  }
  // 无图标功能：游戏卡片统一使用默认样式，不支持修改图标
  lastGames = games;
  return games;
}

// ---------- 启动游戏 ----------
function findCached(folder) { return lastGames.find((g) => g.folder === folder) || null; }

function reportLaunchError(name, err) {
  if (win && !win.isDestroyed()) win.webContents.send('launch-error', { name, message: String((err && err.message) || err) });
}

function launchGame(game, ov) {
  const exe = ov.exePath || game.autoExe;
  if (!exe) return { ok: false, error: '未设置启动程序，请右键「更改启动程序」' };
  if (!fs.existsSync(exe)) return { ok: false, error: '启动程序不存在：' + exe };
  const cwd = path.dirname(exe);
  const args = ov.args ? ov.args.split(/\s+/) : [];
  if (ov.admin) {
    // 管理员权限：经 PowerShell Start-Process -Verb RunAs 启动（弹 UAC），无法跟踪退出，保持最小化到托盘
    hideToTray();
    const q = (s) => "'" + s.replace(/'/g, "''") + "'";
    let ps = `Start-Process -FilePath ${q(exe)} -WorkingDirectory ${q(cwd)}`;
    if (args.length) ps += ' -ArgumentList ' + args.map(q).join(',');
    const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { stdio: 'ignore', detached: true });
    child.on('error', (err) => { reportLaunchError(game.name, err); showWindow(); });
    child.unref();
    setTimeout(showWindow, 3000);
    return { ok: true, elevated: true };
  }
  // 普通启动：运行时销毁窗口释放资源（省约 100~200MB），游戏退出后重建窗口并快速重扫
  gameRunning = true;
  if (win) win.destroy();
  const child = spawn(exe, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', (err) => { reportLaunchError(game.name, err); gameRunning = false; restoreWindow(); });
  child.on('exit', () => { if (!isQuitting) { gameRunning = false; restoreWindow(); } });
  return { ok: true, pid: child.pid };
}

// ---------- 窗口与托盘 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 840,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: '#0b0e1a',
    title: 'DM启动台',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: { preload: path.join(APP_DIR, 'preload.js'), contextIsolation: true }
  });
  win.loadFile('index.html');
  win.once('ready-to-show', () => {
    win.show();
    if (process.env.DM_SMOKE) { console.log('DM_SMOKE_READY'); setTimeout(() => app.exit(0), 1500); }
  });
  win.on('close', (e) => { if (!isQuitting && !gameRunning) { e.preventDefault(); hideToTray(); } });
  win.on('closed', () => { win = null; });
}

function restoreWindow() { if (!win) createWindow(); else showWindow(); }
function showWindow() {
  if (!win) { createWindow(); return; }
  if (!win.isVisible()) win.show();
  win.focus();
}
function hideToTray() { if (win) win.hide(); }

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
  tray.setToolTip('DM启动台');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 DM启动台', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', showWindow);
}

// ---------- IPC：游戏 ----------
ipcMain.handle('games:list', async () => {
  try { return await doScan(); } catch (e) { return { error: String((e && e.message) || e) }; }
});
ipcMain.handle('game:launch', (e, folder) => {
  const g = findCached(folder);
  if (!g) return { ok: false, error: '未找到游戏' };
  return launchGame(g, getOverrides()[g.folder] || {});
});
ipcMain.handle('game:open-path', (e, folder) => {
  const g = findCached(folder);
  if (!g) return;
  const p = g.exePath && fs.existsSync(g.exePath) ? g.exePath : g.folder;
  if (p === g.exePath) shell.showItemInFolder(p); else shell.openPath(p);
});
ipcMain.handle('game:choose-exe', async (e, folder) => {
  const g = findCached(folder);
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '选择启动程序',
    defaultPath: (g && g.folder) || undefined,
    filters: [{ name: '程序 (*.exe)', extensions: ['exe'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  const ov = getOverrides();
  ov[folder] = { ...(ov[folder] || {}), exePath: p };
  saveOverrides(ov);
  return p;
});
ipcMain.handle('game:clear-override', (e, folder) => {
  const ov = getOverrides();
  if (ov[folder]) { delete ov[folder]; saveOverrides(ov); }
});
ipcMain.handle('game:set-options', (e, folder, opts) => {
  const ov = getOverrides();
  ov[folder] = { ...(ov[folder] || {}), ...opts };
  saveOverrides(ov);
});

// ---------- IPC：排除文件夹（运行库等不再算入） ----------
ipcMain.handle('games:exclude', (e, folder) => {
  const s = getSettings();
  const ex = s.excluded || [];
  const key = folder.toLowerCase();
  if (!ex.some((x) => x.toLowerCase() === key)) ex.push(folder);
  s.excluded = ex;
  saveSettings(s);
});
ipcMain.handle('games:unexclude', (e, folder) => {
  const s = getSettings();
  s.excluded = (s.excluded || []).filter((x) => x.toLowerCase() !== folder.toLowerCase());
  saveSettings(s);
});
ipcMain.handle('about:get', () => {
  try { return fs.readFileSync(path.join(APP_DIR, '使用说明.md'), 'utf8'); } catch { return '（使用说明文件缺失，请到项目目录查看 使用说明.md）'; }
});
// 大屏模式：切换全屏
ipcMain.handle('window:fullscreen', (e, flag) => { if (win) win.setFullScreen(!!flag); });

// ---------- IPC：分组 ----------
ipcMain.handle('groups:get', () => getSettings().groups);
ipcMain.handle('groups:detect', async (e, type) => {
  try { return await detectPlatform(type); } catch (err) { return { type, layout: 'subdirs', dirs: [], error: String(err) }; }
});
// 批量导入：多选目录 → 每个目录独立成组（组名=目录名）
ipcMain.handle('groups:import', async () => {
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '导入游戏目录（可多选）',
    properties: ['openDirectory', 'multiSelections']
  });
  if (r.canceled || !r.filePaths.length) return null;
  const s = getSettings();
  for (const p of r.filePaths) {
    s.groups.push({ id: newGroupId(), name: path.basename(p) || p, type: 'custom', dirs: [p], enabled: true, layout: 'subdirs' });
  }
  saveSettings(s);
  return s.groups;
});
// 选择目录（用于往分组里追加）
ipcMain.handle('groups:pick-dirs', async () => {
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '选择要添加的目录（可多选）',
    properties: ['openDirectory', 'multiSelections']
  });
  return r.canceled ? null : r.filePaths;
});
// 添加分组；平台组已存在时合并目录（避免重复导入，如 Steam/steam 两份）
ipcMain.handle('groups:add', (e, group) => {
  const s = getSettings();
  const existing = group.type && group.type !== 'custom'
    ? s.groups.find((x) => x.type === group.type)
    : null;
  if (existing) {
    existing.dirs = dedupePaths([...existing.dirs, ...(group.dirs || [])]);
    saveSettings(s);
    return s.groups;
  }
  s.groups.push({ id: newGroupId(), enabled: true, layout: 'subdirs', ...group });
  saveSettings(s);
  return s.groups;
});
ipcMain.handle('groups:update', (e, patch) => {
  const s = getSettings();
  const g = s.groups.find((x) => x.id === patch.id);
  if (g) { const { id, ...rest } = patch; Object.assign(g, rest); saveSettings(s); }
  return s.groups;
});
ipcMain.handle('groups:delete', (e, id) => {
  const s = getSettings();
  s.groups = s.groups.filter((x) => x.id !== id);
  saveSettings(s);
  return s.groups;
});
ipcMain.handle('groups:move', (e, id, delta) => {
  const s = getSettings();
  const i = s.groups.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i >= 0 && j >= 0 && j < s.groups.length) {
    const [g] = s.groups.splice(i, 1);
    s.groups.splice(j, 0, g);
    saveSettings(s);
  }
  return s.groups;
});

// ---------- IPC：设置与窗口 ----------
ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (e, s) => {
  const cur = getSettings();
  saveSettings({ ...cur, ...s });
});
ipcMain.handle('window:minimize', () => { if (win) win.minimize(); });
ipcMain.handle('window:hide', () => hideToTray());
ipcMain.handle('app:quit', () => { isQuitting = true; app.quit(); });

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    app.setAppUserModelId('com.dm.launcher');
    try { fs.mkdirSync(path.join(app.getPath('userData'), 'icons'), { recursive: true }); } catch {}
    createWindow();
    createTray();
  });
  app.on('before-quit', () => { isQuitting = true; });
  app.on('window-all-closed', () => { /* 常驻托盘，不退出 */ });
}
