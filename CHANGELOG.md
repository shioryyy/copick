# 更新日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。发布流程：更新本文件的对应版本小节，把 `app/src-tauri/tauri.conf.json` 与 `app/package.json` 的版本改成同一号。仓库目前没有自动创建 GitHub Release 的工作流，产物从 Actions 的 Tauri packages 附件下载，校验与安装见 `app/RELEASE.md`。

## [Unreleased]

### 变更

- 移除 Electron 版：`app/`、`docs/`、`build/` 以及 `ci.yml`、`release.yml` 一并删除，Tauri 版成为唯一实现并移入 `app/`（原 `tauri-prototype/`）。`selection-hook@2.1.1` 改为 `app` 自己的依赖，原生源码不再从 Electron 的 `node_modules` 取。
- 设置页按用途分组，支持系统深浅色主题、清晰的权限与保存状态、排除应用列表和一键添加最近取词应用。
- 复制成功后显示“已复制”约 650 毫秒再隐藏；旧反馈计时器不会关闭新选区的浮窗。
- 登录后自动启动展示系统生效状态，保留系统禁用选择，并说明待批准及开发模式限制。
- 托盘保留暂停、排除最近应用、设置与退出；权限检查和会话诊断归入“帮助与诊断”。
- 暂停划词、兼容复制、登录后自动启动改为即时保存；排除应用单独保存，开关操作保留未提交的列表草稿，并提供撤销和关闭时的未保存提醒。
- 常见应用显示易读名称及原始标识，未知应用保留原标识。
- 设置页新增“没有出现复制按钮？”排查步骤和诊断日志开关，诊断仅本次运行有效。

### 修复

- 新选区先在隐藏状态重置复制按钮，经过绘制周期并确认 token 后再显示，避免短暂闪现上次绿色“已复制”状态；过期或已撤销选区的迟到确认不会重开浮窗。
- 接收选区和复制前只读核验前台应用，绑定应用标识与 PID；检测到切换或身份不可读取时清除旧浮窗与 token，保留取词事件缺少原始 PID 等限制。
- 修复深色模式的悬停、按下样式覆盖复制成功颜色，导致“已复制”文字与绿色背景表现不同步。
- 修复复制浮窗隐藏后，延迟的应用激活事件误打开设置窗口；普通激活只恢复已有设置窗口，新建设置窗口由托盘或重新启动应用等明确入口触发。
- macOS Dock 重新显示后再次应用 Copick 图标，避免开发模式恢复 Electron 默认图标。

## [0.3.0-beta.2] - 2026-10-18

### 修复

- 源应用自身置顶时复制浮窗会被盖在下面、点击落到源窗口；显示后调用 `moveTop()` 修复（Windows 真机复现）。
- IPC 发送方校验改为比较解码后的页面路径而非 URL 字符串，含空格、中文或盘符大小写不同的安装路径不再导致设置页和复制按钮静默失效。
- 用户数据与日志目录由 `copick-app` 改为 `Copick`。

### 新增

- Windows NSIS 安装包 `Copick-Setup-<版本>-win-x64.exe`：按用户安装、无需管理员、可选目录、开始菜单快捷方式，卸载保留设置。便携 ZIP 继续提供。
- 开机自动启动开关（设置页与托盘），两端通用；设置页显示系统实际登记状态。

### 变更

- 诊断日志新增浮窗关闭原因（copied、timeout、mouse-down-outside、mouse-wheel、key-down）和 IPC 通过/拒绝事件（只含通道名）。
- 设置页回退说明写明关闭回退会失去哪些应用，以及 VS Code 需开启 `editor.accessibilitySupport`。

### 工程

- GitHub Actions 双平台 CI（macOS arm64、Windows x64）：语法检查、单元测试、开发态与打包产物的原生模块 smoke test、依赖审计。
- Dependabot 每周检查 npm 与 Actions 依赖，`selection-hook` 需人工升级。
- `docs/COMPATIBILITY.md` 兼容性矩阵，Windows x64 已有 13 个应用的真机结论。
- 打包接线代码签名：Windows 提供证书 secret 后自动签名 zip 与 NSIS 产物（已用自签证书验证签名管线）；macOS 预置 hardened runtime 与 entitlements，配置 Apple 凭据后自动公证。凭据与验证方法见 `docs/RELEASE.md`。

## [0.3.0-beta.1] - 2026-10-16

首个统一 Electron + selection-hook 跨平台预发布版，取代原 Swift 实现。

### 新增

- macOS arm64 与 Windows x64 共用的复制浮窗、托盘、暂停、应用黑名单和设置页。
- macOS 辅助功能权限状态检测，授权后自动恢复监听。
- 私有诊断日志（`--diagnostics`），不记录选中文字、按键或程序名。
- 配置原子持久化与读取失败时的闭锁行为。

### 已知限制

- 未签名、未公证，无安装器与自动更新。
- 底层库没有只读前台身份接口，非键鼠触发的前台切换可能在超时前留下旧浮窗。

[Unreleased]: https://github.com/shioryyy/copick/compare/v0.3.0-beta.2...HEAD
[0.3.0-beta.2]: https://github.com/shioryyy/copick/releases/tag/v0.3.0-beta.2
[0.3.0-beta.1]: https://github.com/shioryyy/copick/releases/tag/v0.3.0-beta.1
