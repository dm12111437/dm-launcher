# DM启动台

本地游戏启动器（Electron）：扫描游戏目录，将每个一级文件夹识别为一个游戏，一键启动。界面参考 iOS 启动台。

## 运行

```bash
npm install   # 已安装依赖可跳过
npm start     # 启动应用
```

> ⚠️ 本机 npm 配置了 `allow-scripts` 脚本白名单（`allow-scripts=@anthropic-ai/claude-code`），
> 并设置了环境变量 `npm_config_allow_scripts`，这会导致安装带 postinstall 脚本的包（如 electron）报
> `EALLOWSCRIPTS`。项目内已提供 `.npmrc`（`allow-scripts=electron`）放行 electron，
> 但**环境变量优先级高于 .npmrc**，所以重新安装依赖时需先移除该环境变量：
>
> ```powershell
> Remove-Item Env:npm_config_allow_scripts   # 仅当前窗口有效
> npm install
> ```

## 功能

- **分组管理**：设置页只显示分组摘要（名称/类型/启用/目录数/游戏数），点「详情」在**二级弹窗**里管理：目录增删、已排除文件夹恢复、组内游戏（打开路径/更改程序/排除）
- **识别规则**：卸载类程序（unins/Uninstall/卸载）**硬屏蔽**，继续向下找真正的游戏 exe，绝不选中卸载程序；常见**运行库类文件夹**（CommonRedist/DirectX/运行库/VC_Redist/DotNet/Steamworks Shared 等）直接不作为游戏；辅助目录（launcher/client/report 等）里的 exe 排序降权，优先选真正的游戏主程序
- **图标**：所有游戏卡片统一使用默认图标样式，无图标识别/提取/修改功能
- **WeGame 启动入口**：根目录存在 `QQLogin.exe` 时优先作为启动程序（如 CF 穿越火线）
- **默认平台分组（Steam/WeGame/Epic）名称锁定**，不可修改；自定义分组可改名
- **大屏模式**：主界面「大屏」按钮 → 全屏大图标界面（参考 Steam 大屏），支持手柄（方向键/摇杆移动、A 启动、B/START 退出）与键盘（方向键/回车/Esc）；游戏退出后自动回到大屏
- **去重策略**：同一分组内按文件夹去重；跨分组允许重复（分组模式下按组展示，关闭分组平铺时自动去重）
- **WeGame**：自动探测游戏根目录（注册表/客户端同级 WeGameApps/各盘根，优先含 rail_apps 的目录）；一级游戏文件夹直接识别，`rail_apps` 下每个文件夹对应一个游戏，`common_apps`/`downloading`/`rail_user_data` 直接屏蔽
- **重命名**：右键游戏卡片「重命名…」可修改主界面显示名（可恢复默认）
- **平台自动扫描**：Steam（注册表 + libraryfolders.vdf 多库）、WeGame（游戏根目录）、Epic（Manifests JSON），路径大小写自动去重、平台组重复添加时提示、路径可手动修改
- **排除文件夹**：右键游戏卡片或设置表格里点「排除」，该文件夹以后不再算作游戏（路径弹窗里可恢复）
- **最小文件夹大小**：小于阈值（默认 10MB，可设置，0=不过滤）的文件夹不算游戏，过滤卸载残留
- 主界面「分组」开关：开 → 按分组显示小标题；关 → 全部混排统一排序
- 自动识别主程序 exe（剔除杂质 → 名称匹配 → 路径浅 → 名称短），可逐游戏手动指定
- iOS 启动台风格图标网格，图标从 exe 提取并缓存
- 搜索、多种排序（名称/修改时间/随机）
- 右键菜单：打开文件夹 / 更改启动程序 / 管理员启动 / 启动参数
- 启动游戏后**销毁窗口**释放资源（省约 100~200MB 内存），游戏退出后自动重建窗口并快速重扫；托盘菜单可随时退出
- 管理员身份启动时无法跟踪进程退出，保持最小化到托盘，3 秒后恢复窗口

## 打包为独立 exe（可选）

```powershell
Remove-Item Env:npm_config_allow_scripts   # 本机 npm 脚本白名单限制，必须先移除
npm install --save-dev electron-builder --registry https://registry.npmmirror.com
npx electron-builder --win
```

产物在 `dist\` 目录（NSIS 安装版 + portable 免安装版）。

## 目录结构

```
dm-launcher/
├── main.js        # 主进程：扫描、启动、托盘、IPC、分组管理
├── scanner.js     # 扫描识别 + 平台探测（纯逻辑，可独立测试）
├── preload.js     # 安全桥接
├── index.html     # 界面
├── styles.css     # iOS 启动台风格样式
├── renderer.js    # 渲染逻辑
├── test-scan.js   # 扫描/分组/平台探测独立测试
└── assets/        # 应用图标
```

配置数据存放在 `%APPDATA%\dm-launcher\`（settings.json 含分组 / overrides.json 按游戏文件夹路径 / icons/）。
