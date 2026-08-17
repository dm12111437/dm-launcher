// DM启动台 - 扫描与识别（纯逻辑，不依赖 Electron，可独立测试）
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const IMPURITY = /(installer|setup|redist|crash|uninstall|unins|卸载|updater|downloader|webhelper|vc_redist|kerneldump|unicrash|unitycrashhandler|kernel|analyzer|benchmark|_be|launcher|report|proxy|assistant|startup|tiny|browser)/i;
// 硬屏蔽：卸载类程序绝不作为启动目标（防止误执行卸载）
const HARD_BLOCK = /(unins|卸载)/i;
// 常见运行库类文件夹：不作为游戏
const RUNTIME_LIB_FOLDER = /(commonredist|redistribut|directx|dxredist|运行库|vcredist|vc_redist|dotnet|physx|gfwl|xlive|steamworks|steam shared|^installers?$|^setups?$|^microsoftredist$)/i;
// WeGame 一级目录中直接屏蔽的文件夹
const WEGAME_BLOCKED = new Set(['common_apps', 'downloading', 'rail_user_data']);
// 路径层级惩罚：位于这些子目录下的 exe 视为辅助程序，排序时降权
const JUNK_SEG = /(launcher|client|tcls|cross|wegame|riot|tenio|qbblink|diagnostic|feed|support|redist|installer|common|content|engine|update)/i;

async function findExes(dir, depth, maxDepth) {
  const out = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < maxDepth) out.push(...(await findExes(full, depth + 1, maxDepth)));
    } else if (e.isFile() && /\.exe$/i.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

// 去掉版本号后缀和分隔符，用于名称匹配
function normName(s) {
  return s.toLowerCase().replace(/\b(v?\d+(\.\d+)+)\b/g, '').replace(/[_\-. ]+/g, '');
}

// Windows 路径比较键（大小写不敏感，去尾部斜杠；盘符根如 C:\ 保留）
function normPathKey(p) {
  let s = path.normalize(p);
  while (s.length > 3 && /[\\/]$/.test(s)) s = s.slice(0, -1);
  return s.toLowerCase();
}

// 路径去重（大小写不敏感，保留首个）
function dedupePaths(paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    if (!p) continue;
    const k = normPathKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

// 文件夹大小（提前退出：累计到 limit 即停，避免全量统计大文件夹）
async function folderSize(dir, limit) {
  let total = 0;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return total; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += await folderSize(full, limit - total);
    } else if (e.isFile()) {
      try { total += (await fsp.stat(full)).size; } catch {}
    }
    if (total >= limit) return total;
  }
  return total;
}

function pickMain(folderName, baseDir, exes) {
  if (!exes.length) return null;
  let cands = exes.filter((p) => !IMPURITY.test(path.basename(p)));
  if (!cands.length) {
    // 全部被过滤：若只剩卸载类则返回空（不选中卸载程序），否则用剩余非卸载项兜底
    const safe = exes.filter((p) => !HARD_BLOCK.test(path.basename(p)));
    cands = safe.length ? safe : [];
  }
  if (!cands.length) return null;
  const nf = normName(folderName);
  const matched = cands.filter((p) => {
    const ne = normName(path.basename(p, '.exe'));
    return ne && (ne.includes(nf) || nf.includes(ne));
  });
  if (matched.length) cands = matched;
  // 排序：路径层级惩罚（辅助目录里的 exe 降权）→ 路径深度 → 名称长度
  const segPenalty = (p) => {
    const rel = path.relative(baseDir, p);
    const segs = rel.split(path.sep).slice(0, -1);
    return segs.filter((s) => JUNK_SEG.test(s)).length;
  };
  cands.sort((a, b) => {
    const pa = segPenalty(a);
    const pb = segPenalty(b);
    if (pa !== pb) return pa - pb;
    const da = path.relative(baseDir, a).split(path.sep).length - 1;
    const db = path.relative(baseDir, b).split(path.sep).length - 1;
    if (da !== db) return da - db;
    return path.basename(a).length - path.basename(b).length;
  });
  return cands[0];
}

async function makeGame(folder, name, depth, group, overrides, opts = {}) {
  const { minSizeBytes = 0, excluded = [] } = opts;
  // 被排除的文件夹不再计算
  const key = normPathKey(folder);
  if (excluded.some((x) => normPathKey(x) === key)) return null;
  // 常见运行库类文件夹不作为游戏
  if (RUNTIME_LIB_FOLDER.test(name)) return null;
  // 过小的文件夹（卸载残留等）不算游戏
  if (minSizeBytes > 0) {
    const size = await folderSize(folder, minSizeBytes);
    if (size < minSizeBytes) return null;
  }
  let mtime = 0;
  try { mtime = (await fsp.stat(folder)).mtimeMs; } catch { return null; }
  const exes = await findExes(folder, 0, depth);
  let auto = pickMain(name, folder, exes);
  // WeGame 游戏：根目录存在 QQLogin.exe 时优先作为启动入口（如 CF 应选 QQLogin.exe）
  if (auto && group.type === 'wegame') {
    const qq = exes.find((p) => path.basename(p).toLowerCase() === 'qqlogin.exe' && path.dirname(p) === folder);
    if (qq) auto = qq;
  }
  const ov = overrides[folder] || {};
  const exePath = ov.exePath || auto;
  return {
    name,
    displayName: ov.name || name, // 支持重命名显示名
    renamed: !!ov.name,
    folder,
    groupId: group.id,
    groupName: group.name,
    groupType: group.type,
    mtime,
    autoExe: auto,
    exePath: exePath || null,
    hasExe: !!auto,
    overridden: !!ov.exePath,
    admin: !!ov.admin,
    args: ov.args || ''
  };
}

// 分组扫描：layout 'subdirs'（一级文件夹=游戏，自定义/Steam）
//           layout 'each'   （每个目录本身就是一个游戏，Epic/WeGame 解析结果）
//           layout 'wegame' （WeGame 根目录结构）
// 去重策略：同一分组内按文件夹去重（大小写不敏感）；跨分组允许重复（主界面按分组展示，关闭分组时前端再去重）
async function scanGames({ groups, depth, overrides = {}, excluded = [], minSizeMB = 0 }) {
  const games = [];
  const seenByGroup = new Map();
  const minSizeBytes = minSizeMB > 0 ? minSizeMB * 1024 * 1024 : 0;
  const opts = { minSizeBytes, excluded };
  for (const group of groups) {
    if (!group.enabled) continue;
    const layout = group.layout || 'subdirs';
    for (const dir of group.dirs) {
      if (layout === 'each') {
        const g = await makeGame(dir, path.basename(dir) || dir, depth, group, overrides, opts);
        if (g) pushUniqueGroup(games, seenByGroup, group.id, g);
        continue;
      }
      if (layout === 'wegame') {
        // WeGame 根目录：一级游戏文件夹（exe 在文件夹内）；
        // rail_apps 下每个文件夹对应一个游戏；common_apps/downloading/rail_user_data 直接屏蔽
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          if (WEGAME_BLOCKED.has(e.name.toLowerCase())) continue;
          if (e.name.toLowerCase() === 'rail_apps') {
            let subs;
            try {
              subs = (await fsp.readdir(path.join(dir, e.name), { withFileTypes: true })).filter((x) => x.isDirectory());
            } catch { subs = []; }
            for (const s of subs) {
              const folder = path.join(dir, e.name, s.name);
              const g = await makeGame(folder, s.name, depth, group, overrides, opts);
              if (g) pushUniqueGroup(games, seenByGroup, group.id, g);
            }
            continue;
          }
          const folder = path.join(dir, e.name);
          const g = await makeGame(folder, e.name, depth, group, overrides, opts);
          if (g) pushUniqueGroup(games, seenByGroup, group.id, g);
        }
        continue;
      }
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      const dirs = entries.filter((e) => e.isDirectory());
      for (const e of dirs) {
        const folder = path.join(dir, e.name);
        const g = await makeGame(folder, e.name, depth, group, overrides, opts);
        if (g) pushUniqueGroup(games, seenByGroup, group.id, g);
      }
    }
  }
  return games;
}

// 同一分组内同一文件夹（大小写不敏感）只算一次
function pushUniqueGroup(games, seenByGroup, groupId, g) {
  let set = seenByGroup.get(groupId);
  if (!set) { set = new Set(); seenByGroup.set(groupId, set); }
  const k = normPathKey(g.folder);
  if (set.has(k)) return;
  set.add(k);
  games.push(g);
}

// 取深度<=maxDepth、直接含 exe 的目录（取最浅层，用于 WeGame 解析 appid 目录）

// ---------- 平台探测 ----------
function regQueryValue(key, name) {
  return new Promise((resolve) => {
    try {
      execFile('reg', ['query', key, '/v', name], { windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const m = String(stdout).match(/REG_SZ\s+(.+)/);
        resolve(m ? m[1].trim() : null);
      });
    } catch {
      resolve(null); // reg 不可用/被拦截时按未检测到处理
    }
  });
}

// Steam: 注册表安装路径 + libraryfolders.vdf 全部库目录；
// 注册表缺失时按常见安装路径逐盘符探测（适配不同电脑的盘符差异）
const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
function parseLibraryFoldersVdf(text) {
  const out = [];
  const re = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const p = m[1].replace(/\\\\/g, '\\').trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

async function detectSteamCommonDirs() {
  const out = [];
  let steamPath = await regQueryValue('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  if (!steamPath) {
    // 注册表缺失：常见安装位置逐盘符探测（Program Files (x86)/Program Files/盘根 Steam）
    for (const L of DRIVE_LETTERS) {
      for (const rel of ['Program Files (x86)\\Steam', 'Program Files\\Steam', 'Steam']) {
        const p = L + ':\\' + rel;
        if (fs.existsSync(p)) { steamPath = p; break; }
      }
      if (steamPath) break;
    }
  }
  const roots = steamPath ? [steamPath] : [];
  for (const r of roots) {
    const vdf = path.join(r, 'steamapps', 'libraryfolders.vdf');
    try {
      const libs = parseLibraryFoldersVdf(await fsp.readFile(vdf, 'utf8'));
      for (const lib of libs) out.push(path.join(lib, 'steamapps', 'common'));
    } catch {}
    const common = path.join(r, 'steamapps', 'common');
    if (fs.existsSync(common)) out.push(common);
  }
  // 独立库目录探测（没有 Steam 客户端也能找到游戏库）
  if (!out.length) {
    for (const L of DRIVE_LETTERS) {
      for (const rel of ['SteamLibrary\\steamapps\\common', 'Steam Games\\steamapps\\common', 'SteamGames\\steamapps\\common']) {
        const p = L + ':\\' + rel;
        if (fs.existsSync(p)) out.push(p);
      }
    }
  }
  return dedupePaths(out).filter((d) => fs.existsSync(d));
}

// WeGame: 游戏根目录（含 rail_apps/common_apps/rail_user_data）。
// 优先注册表客户端路径 → 客户端同级 WeGameApps → 各盘根 WeGameApps；
// 多个候选中优先选择含 rail_apps 的游戏根
async function detectWegameRoots() {
  const candidates = [];
  const pushIf = (p) => { if (p && fs.existsSync(p)) candidates.push(p); };

  // 1) 注册表安装路径（客户端目录），及其同级 WeGameApps
  for (const [key, name] of [
    ['HKCU\\Software\\Tencent\\WeGame', 'InstallPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\WeGame', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Tencent\\WeGame', 'InstallPath']
  ]) {
    const v = await regQueryValue(key, name);
    if (!v) continue;
    let p = v;
    try { if (fs.statSync(p).isFile()) p = path.dirname(p); } catch {}
    pushIf(p);
    pushIf(path.join(path.dirname(p), 'WeGameApps'));
    break;
  }
  // 2) 常见客户端路径，及其同级 WeGameApps
  for (const p of [
    'C:\\Program Files (x86)\\WeGame',
    'C:\\Program Files\\WeGame',
    'D:\\WeGame',
    'C:\\WeGame'
  ]) {
    if (!fs.existsSync(p)) continue;
    pushIf(p);
    pushIf(path.join(path.dirname(p), 'WeGameApps'));
    break;
  }
  // 3) 各盘根下的 WeGameApps（全盘符，适配不同电脑）
  for (const L of DRIVE_LETTERS) {
    pushIf(L + ':\\WeGameApps');
  }
  const roots = dedupePaths(candidates);
  const withRail = roots.filter((p) => fs.existsSync(path.join(p, 'rail_apps')));
  return withRail.length ? withRail : roots;
}

// Epic: ProgramData Manifests\*.item（JSON）里的 InstallLocation；兜底默认安装目录
async function detectEpicDirs() {
  const out = [];
  const manifestDir = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
  try {
    const files = (await fsp.readdir(manifestDir)).filter((f) => /\.item$/i.test(f));
    for (const f of files) {
      try {
        const data = JSON.parse(await fsp.readFile(path.join(manifestDir, f), 'utf8'));
        if (data && data.InstallLocation && fs.existsSync(data.InstallLocation)) out.push(data.InstallLocation);
      } catch {}
    }
  } catch {}
  if (!out.length) {
    const fb = 'C:\\Program Files\\Epic Games';
    try {
      const dirs = await fsp.readdir(fb, { withFileTypes: true });
      for (const d of dirs) if (d.isDirectory()) out.push(path.join(fb, d.name));
    } catch {}
  }
  return dedupePaths(out);
}

async function detectPlatform(type) {
  if (type === 'steam') return { type, layout: 'subdirs', dirs: await detectSteamCommonDirs() };
  if (type === 'wegame') return { type, layout: 'wegame', dirs: await detectWegameRoots() };
  if (type === 'epic') return { type, layout: 'each', dirs: await detectEpicDirs() };
  return { type, layout: 'subdirs', dirs: [] };
}

// 目录内搜索图标文件（exe 无图标时的兜底）：
// 优先名字含 icon 或与文件夹同名的 .ico/.png，其次任意 .ico；搜索深度 ≤2，跳过常见资源目录
async function findFolderIcon(folder) {
  const found = [];
  const walk = async (dir, depth) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const low = e.name.toLowerCase();
      if (low.endsWith('.ico')) found.push({ p: path.join(dir, e.name), kind: 'ico' });
      else if (low.endsWith('.png')) found.push({ p: path.join(dir, e.name), kind: 'png' });
    }
    if (depth < 2) {
      for (const e of entries) {
        if (e.isDirectory() && !/^(bin|logs?|cache|data|content|engine|lib|redist|support|screenshots?)/i.test(e.name)) {
          await walk(path.join(dir, e.name), depth + 1);
        }
      }
    }
  };
  await walk(folder, 0);
  if (!found.length) return null;
  const base = path.basename(folder).toLowerCase();
  const prefer = found.find((f) => /icon/.test(f.p.toLowerCase()) || path.basename(f.p, path.extname(f.p)).toLowerCase() === base);
  const anyIco = found.find((f) => f.kind === 'ico');
  return prefer ? prefer.p : (anyIco ? anyIco.p : null);
}

module.exports = {
  findExes,
  normName,
  normPathKey,
  dedupePaths,
  folderSize,
  pickMain,
  makeGame,
  scanGames,
  parseLibraryFoldersVdf,
  detectPlatform,
  findFolderIcon
};
