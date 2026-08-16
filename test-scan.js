// 独立测试：卸载屏蔽 / 运行库屏蔽 / WeGame 结构 / 显示名（不依赖 Electron）
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { scanGames, dedupePaths, folderSize, pickMain, parseLibraryFoldersVdf, detectPlatform, iconFileUsable } = require('./scanner');

const TMP = path.join(__dirname, '.testdata');
const ZONE_U = path.join(TMP, 'U1'); // 卸载屏蔽测试区
const ZONE_R = path.join(TMP, 'R1'); // 运行库屏蔽测试区
const ZONE_W = path.join(TMP, 'W1'); // WeGame 结构测试区

async function fixture() {
  // 1) 卸载屏蔽
  await fsp.mkdir(path.join(ZONE_U, 'UninstallOnly'), { recursive: true });
  await fsp.writeFile(path.join(ZONE_U, 'UninstallOnly', 'unins000.exe'), 'x');
  await fsp.writeFile(path.join(ZONE_U, 'UninstallOnly', 'Uninstall.exe'), 'x');
  await fsp.mkdir(path.join(ZONE_U, 'GameWithUninstall'), { recursive: true });
  await fsp.writeFile(path.join(ZONE_U, 'GameWithUninstall', 'MyGame.exe'), 'x');
  await fsp.writeFile(path.join(ZONE_U, 'GameWithUninstall', '卸载程序.exe'), 'x');
  // 2) 运行库类文件夹
  await fsp.mkdir(path.join(ZONE_R, 'RealGame'), { recursive: true });
  await fsp.writeFile(path.join(ZONE_R, 'RealGame', 'RealGame.exe'), 'x');
  for (const d of ['_CommonRedist', 'DirectX', '运行库', 'VC_Redist', 'Installer', 'DotNet', 'Steamworks Shared']) {
    await fsp.mkdir(path.join(ZONE_R, d), { recursive: true });
    await fsp.writeFile(path.join(ZONE_R, d, 'setup.exe'), 'x');
  }
  // 3) WeGame 结构
  await fsp.mkdir(path.join(ZONE_W, 'GameX'), { recursive: true });
  await fsp.writeFile(path.join(ZONE_W, 'GameX', 'GameX.exe'), 'x');
  for (const d of ['common_apps', 'downloading', 'rail_user_data']) {
    await fsp.mkdir(path.join(ZONE_W, d), { recursive: true });
    await fsp.writeFile(path.join(ZONE_W, d, 'junk.exe'), 'x');
  }
  await fsp.mkdir(path.join(ZONE_W, 'rail_apps', '1001'), { recursive: true });
  await fsp.mkdir(path.join(ZONE_W, 'rail_apps', '1002'), { recursive: true });
  await fsp.writeFile(path.join(ZONE_W, 'rail_apps', '1001', 'App1.exe'), 'x');
  await fsp.writeFile(path.join(ZONE_W, 'rail_apps', '1002', 'App2.exe'), 'x');
  // 4) 显示名
}

(async () => {
  let fail = 0;
  const ok = (cond, msg) => { console.log((cond ? '✅' : '❌') + ' ' + msg); if (!cond) fail = 1; };

  await fixture();

  // 1) 卸载类硬屏蔽
  const groupsU = [{ id: 'a', name: 'T', type: 'custom', dirs: [ZONE_U], enabled: true, layout: 'subdirs' }];
  const g1 = await scanGames({ groups: groupsU, depth: 4, minSizeMB: 0 });
  const uo = g1.find((x) => x.name === 'UninstallOnly');
  ok(uo && !uo.exePath && !uo.hasExe, `只有卸载程序的文件夹不选中任何 exe（hasExe=${uo && uo.hasExe}）`);
  const gw = g1.find((x) => x.name === 'GameWithUninstall');
  ok(gw && gw.exePath === path.join(ZONE_U, 'GameWithUninstall', 'MyGame.exe'), `有卸载程序时继续找到 MyGame.exe`);
  ok(pickMain('X', TMP, [path.join(TMP, 'Uninstall.exe')]) === null, '单独 uninstall 也不选中');

  // 2) 运行库类文件夹屏蔽
  const groupsR = [{ id: 'b', name: 'R', type: 'custom', dirs: [ZONE_R], enabled: true, layout: 'subdirs' }];
  const gr = await scanGames({ groups: groupsR, depth: 4, minSizeMB: 0 });
  ok(gr.some((x) => x.name === 'RealGame'), '真实游戏保留');
  const junk = gr.filter((x) => x.name !== 'RealGame').map((x) => x.name);
  ok(junk.length === 0, `运行库文件夹全部屏蔽（残留: ${junk.join(',') || '(无)'}）`);

  // 3) WeGame 结构布局
  const groupsW = [{ id: 'c', name: 'WeGame', type: 'wegame', dirs: [ZONE_W], enabled: true, layout: 'wegame' }];
  const gw2 = await scanGames({ groups: groupsW, depth: 4, minSizeMB: 0 });
  const names = gw2.map((x) => x.name);
  ok(names.includes('GameX'), `一级游戏文件夹识别（GameX）`);
  ok(names.includes('1001') && names.includes('1002'), `rail_apps 下每个文件夹=游戏（1001,1002），实际 ${names.join(',')}`);
  const blocked = names.filter((n) => ['common_apps', 'downloading', 'rail_user_data'].includes(n));
  ok(blocked.length === 0, `common_apps/downloading/rail_user_data 已屏蔽`);
  const a1 = gw2.find((x) => x.name === '1001');
  ok(a1 && a1.exePath === path.join(ZONE_W, 'rail_apps', '1001', 'App1.exe'), `rail_apps 游戏找到 exe: ${a1 && a1.exePath}`);

  // 4) 显示名重命名
  const overrides = {};
  overrides[path.join(ZONE_W, 'rail_apps', '1001')] = { name: '改名游戏' };
  const g4 = await scanGames({ groups: groupsW, depth: 4, minSizeMB: 0, overrides });
  const renamed = g4.find((x) => x.name === '1001');
  ok(renamed && renamed.displayName === '改名游戏' && renamed.renamed === true, `显示名覆盖: ${renamed && renamed.displayName}`);

  // 5) 跨组重复允许 + 组内去重
  const dupeGroups = [
    { id: 'x', name: 'X', dirs: [ZONE_U], enabled: true, layout: 'subdirs' },
    { id: 'y', name: 'Y', dirs: [ZONE_U], enabled: true, layout: 'subdirs' }
  ];
  const gd = await scanGames({ groups: dupeGroups, depth: 4, minSizeMB: 0 });
  const dupCount = gd.filter((x) => x.name === 'GameWithUninstall').length;
  ok(dupCount === 2, `跨组重复允许（GameWithUninstall 在两组各出现一次，实际 ${dupCount}）`);
  const sameGroup = [{ id: 'z', name: 'Z', dirs: [ZONE_U, ZONE_U.toLowerCase()], enabled: true, layout: 'subdirs' }];
  const gz = await scanGames({ groups: sameGroup, depth: 4, minSizeMB: 0 });
  const sameCount = gz.filter((x) => x.name === 'GameWithUninstall').length;
  ok(sameCount === 1, `同组重复路径只算一次（实际 ${sameCount}）`);

  // 6) 图标文件可用性校验（存在且非空）
  const ico = path.join(TMP, 'icotest.png');
  await fsp.writeFile(ico, 'x');
  ok(iconFileUsable(ico) === true, '存在非空文件可用');
  ok(iconFileUsable(path.join(TMP, 'nope.png')) === false, '不存在文件不可用');

  // 7) 回归：去重 / VDF / Epic 探测 / D:\Game
  ok(dedupePaths(['D:\\A', 'd:\\a\\']).length === 1, '路径去重回归');
  ok(parseLibraryFoldersVdf('"path" "C:\\\\Steam"').length === 1, 'VDF 解析回归');
  const wg = await detectPlatform('wegame');
  ok(wg.layout === 'wegame', `WeGame 探测 layout=wegame（本机未装 → 目录空属正常）: ${wg.dirs.length ? wg.dirs.join(' | ') : '(未检测到)'}`);
  const t0 = Date.now();
  const real = await scanGames({ groups: [{ id: 'm', name: '我的游戏', type: 'custom', dirs: ['D:\\Game'], enabled: true, layout: 'subdirs' }], depth: 4, minSizeMB: 10 });
  console.log(`--- D:\\Game 实测：${real.length} 个游戏，耗时 ${Date.now() - t0}ms ---`);
  const ep = await detectPlatform('epic');
  console.log(`--- Epic 探测：${ep.dirs.length ? ep.dirs.join(' | ') : '(未检测到)'} ---`);

  console.log(fail ? '\n有测试失败 ❌' : '\n全部测试通过 ✅');
  process.exitCode = fail;
})();
