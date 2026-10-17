# 更新日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。发布流程：更新本文件的对应版本小节，把 `app/package.json` 的 `version` 改成同一版本号，推送 `v<版本号>` tag，`.github/workflows/release.yml` 会构建、校验并创建 GitHub Release；版本号含 `-` 的自动标为 Pre-release。

## [Unreleased]

### 修复

- 源应用自身置顶时复制浮窗会被盖在下面、点击落到源窗口；显示后调用 `moveTop()` 修复（Windows 真机复现）。
- IPC 发送方校验改为比较解码后的页面路径而非 URL 字符串，含空格、中文或盘符大小写不同的安装路径不再导致设置页和复制按钮静默失效。
- 用户数据与日志目录由 `copick-app` 改为 `Copick`。

### 变更

- 诊断日志新增浮窗关闭原因（copied、timeout、mouse-down-outside、mouse-wheel、key-down）和 IPC 通过/拒绝事件（只含通道名）。
- 设置页回退说明写明关闭回退会失去哪些应用，以及 VS Code 需开启 `editor.accessibilitySupport`。

### 工程

- GitHub Actions 双平台 CI（macOS arm64、Windows x64）：语法检查、单元测试、开发态与打包产物的原生模块 smoke test、依赖审计。
- Dependabot 每周检查 npm 与 Actions 依赖，`selection-hook` 需人工升级。
- `docs/COMPATIBILITY.md` 兼容性矩阵，Windows x64 已有 13 个应用的真机结论。

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

[Unreleased]: https://github.com/shioryyy/copick/compare/v0.3.0-beta.1...HEAD
[0.3.0-beta.1]: https://github.com/shioryyy/copick/releases/tag/v0.3.0-beta.1
