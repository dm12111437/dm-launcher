// DM启动台 - 主进程
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, net } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { scanGames, detectPlatform, dedupePaths, findFolderIcon } = require('./scanner');

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
function iconCachePath(exePath) { return path.join(app.getPath('userData'), 'icons', crypto.createHash('sha1').update(exePath).digest('hex') + '.png'); }
function customIconDir() { return path.join(app.getPath('userData'), 'custom-icons'); }

function newGroupId() { return 'g-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

// ---------- 自定义图标 ----------
function copyToCustomIcon(src) {
  try {
    const ext = path.extname(src).toLowerCase() || '.png';
    const dest = path.join(customIconDir(), crypto.createHash('sha1').update(src).digest('hex') + ext);
    if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    return dest;
  } catch { return null; }
}
function imageExtByMagic(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return '.jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return '.gif';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return '.ico';
  if (buf[0] === 0x42 && buf[1] === 0x4D) return '.bmp';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return null;
}
async function fetchWithTimeout(url, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const doFetch = (net && net.fetch) ? net.fetch.bind(net) : fetch;
    const res = await doFetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'DM-Launcher/1.0' } });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; } finally { clearTimeout(t); }
}

// ---------- 图标（第一版规则：ExtractAssociatedIcon 逐游戏提取） ----------
// 第一版机制：每个游戏用 PowerShell 从 exe 直接提取 32px 小图标，缓存复用；
// exe 提取失败时兜底搜索目录内图标文件；都没有才显示占位
function iconFileUsable(p) {
  try { return !!p && fs.existsSync(p) && fs.statSync(p).size > 0; } catch { return false; }
}
function sendIcon(folder, png) { if (win && !win.isDestroyed()) win.webContents.send('icon-ready', { name: folder, png }); }

// 逐游戏提取（第一版实现）：ExtractAssociatedIcon → PNG
function extractIcon(exe, png) {
  return new Promise((resolve) => {
    const q = (s) => "'" + s.replace(/'/g, "''") + "'";
    const script = [
      'Add-Type -AssemblyName System.Drawing',
      `$src=${q(exe)}`,
      `$dst=${q(png)}`,
      'try {',
      '  $icon=[System.Drawing.Icon]::ExtractAssociatedIcon($src)',
      '  if($icon){ $icon.ToBitmap().Save($dst,[System.Drawing.Imaging.ImageFormat]::Png); $icon.Dispose() }',
      '} catch {}'
    ].join('; ');
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && fs.existsSync(png)));
  });
}

// 确实没有图标的游戏（exe 与目录都没有），本次会话不再重复尝试
const iconFailed = new Set();

// 顺序提取缺失图标（第一版流程），完成后以 icon-ready 事件刷新卡片
function scheduleIcons(games) {
  let i = 0;
  const next = () => {
    while (i < games.length) {
      const g = games[i++];
      if (!g.exePath || g.iconPath || iconFailed.has(g.folder)) continue;
      const png = iconCachePath(g.exePath);
      if (iconFileUsable(png)) { sendIcon(g.folder, png); continue; }
      extractIcon(g.exePath, png).then(async (ok) => {
        if (ok) {
          sendIcon(g.folder, png);
        } else {
          // exe 无图标 → 目录图标文件兜底
          const folderIcon = await findFolderIcon(g.folder);
          if (folderIcon) sendIcon(g.folder, folderIcon);
          else iconFailed.add(g.folder);
        }
      }).finally(next);
      return;
    }
  };
  next();
}

// ---------- 扫描与识别 ----------
async function doScan() {
  const settings = getSettings();
  const depth = Math.min(8, Math.max(1, settings.scanDepth || 4));
  let scanned;
  try {
    scanned = await scanGames({
      groups: settings.groups,
      depth,
      overrides: getOverrides(),
      excluded: settings.excluded || [],
      minSizeMB: settings.minSizeMB || 0
    });
  } catch {
    return { error: '扫描失败' };
  }
  // 图标：自定义 → exe 提取缓存 → 交给 scheduleIcons（提取 + 目录兜底）
  const ov = getOverrides();
  const games = scanned.map((g) => {
    let iconPath = null;
    const custom = ov[g.folder] && ov[g.folder].icon;
    if (custom && iconFileUsable(custom)) iconPath = custom;
    else if (g.exePath && iconFileUsable(iconCachePath(g.exePath))) iconPath = iconCachePath(g.exePath);
    return { ...g, iconPath, customIcon: !!custom };
  });
  lastGames = games;
  scheduleIcons(games);
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
// ---------- IPC：自定义图标 ----------
ipcMain.handle('icon:set-local', async (e, folder) => {
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '选择图标图片',
    // 直接打开该游戏的目录，方便就地找图标文件
    defaultPath: folder || undefined,
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'ico', 'gif', 'webp', 'bmp'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths.length) return null;
  const dest = copyToCustomIcon(r.filePaths[0]);
  if (!dest) return { error: '复制图标文件失败' };
  const ov = getOverrides();
  ov[folder] = { ...(ov[folder] || {}), icon: dest };
  saveOverrides(ov);
  return dest;
});
ipcMain.handle('icon:set-url', async (e, folder, url) => {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { error: '请输入有效的 http/https 图片地址' };
  const buf = await fetchWithTimeout(u);
  if (!buf) return { error: '下载失败（网络或超时），请确认能访问该地址' };
  if (buf.length < 100 || buf.length > 10 * 1024 * 1024) return { error: '文件大小不合法' };
  const ext = imageExtByMagic(buf);
  if (!ext) return { error: '下载的内容不是图片文件' };
  const dest = path.join(customIconDir(), crypto.createHash('sha1').update(u).digest('hex') + ext);
  try { fs.writeFileSync(dest, buf); } catch { return { error: '保存图标失败' }; }
  const ov = getOverrides();
  ov[folder] = { ...(ov[folder] || {}), icon: dest };
  saveOverrides(ov);
  return dest;
});
ipcMain.handle('icon:clear', (e, folder) => {
  const ov = getOverrides();
  if (ov[folder]) {
    delete ov[folder].icon;
    if (!Object.keys(ov[folder]).length) delete ov[folder];
    saveOverrides(ov);
  }
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
    try { fs.mkdirSync(customIconDir(), { recursive: true }); } catch {}
    createWindow();
    createTray();
  });
  app.on('before-quit', () => { isQuitting = true; });
  app.on('window-all-closed', () => { /* 常驻托盘，不退出 */ });
}
