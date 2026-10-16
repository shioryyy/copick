# Copick

本地划词复制小工具：选中文字，旁边弹出「复制」按钮，点击即复制。

- 纯本地运行：无网络请求、无 AI、无遥测，不保存选中文字。
- 统一 Electron + `selection-hook` 2.1.1 主路线，当前支持 macOS arm64 与 Windows x64。
- `swift/` 保留为 macOS 原生过渡验证实现，不是当前 Electron 发布路线；不改已安装的 Applications app。

## 目录

| 路径 | 说明 |
|---|---|
| `app/` | 跨平台 Electron 主应用、浮窗、托盘、设置、策略与打包配置 |
| `swift/` | macOS 原生过渡验证实现，保留不删除 |
| `build/` | 复用图标与构建辅助文件 |
| `docs/DESIGN.md` | 主路线与平台边界 |

## 开发与检查

在仓库根目录执行：

```bash
cd app
npm ci --registry=https://registry.npmjs.org
npm run check
npm test
# macOS arm64 ZIP
npm run pack:mac
# Windows x64 ZIP（需在 Windows 执行）
npm run dist:win
```

产物位于 `app/release/`，文件名包含平台和架构。打包使用 Electron Builder、asar 和 selection-hook 官方预编译模块；不增加框架、sidecar、安装器或 updater。Windows 构建由 Windows 环境负责，macOS 不模拟 Windows native 模块。

`electron . --smoke-test` 只加载 bundled `selection-hook` native module 并退出，不调用 `start()`、不启动全局监听、不发送合成按键。可用于静态/加载检查，不能代替桌面交互验证。

## 运行与权限

应用默认单实例，关闭设置窗口不会退出；托盘可暂停、启用回退、加入最近应用黑名单和退出。选中文字只存在主进程内存，复制浮窗使用短期 token。

- macOS：`programName` 是 selection-hook 原生源码返回的前台应用 **bundle identifier**（例如 `com.apple.finder`），不是臆造的 bundle id 或显示名称。辅助功能状态由 `macIsProcessTrusted()` 提供，设置页可打开系统辅助功能设置入口。默认关闭快捷键剪贴板回退，可在设置中开启。
- Windows：`programName` 是可执行程序名（例如 `code.exe`）。默认开启剪贴板回退，可在设置中关闭。Windows 坐标在进入 Electron bounds 前使用 `screenToDipPoint`；macOS 坐标直接使用 Cocoa screen points，不做该转换。
- 两个平台都在原生过滤器和 JS 层过滤。终端、密码管理器和 Copick 有平台内置完全黑名单；IDE 只禁止快捷键回退，不完全禁止直接无障碍取词。
- 回退可能临时修改剪贴板，原生库尽力备份/恢复但不保证私有格式、并发复制或剪贴板管理器状态。关闭回退可避免该影响。

未实测限制：macOS Electron arm64 的实际辅助功能授权、各应用 AX/UIA 树延迟、Windows 混合 DPI/管理员窗口/焦点保持以及点击浮窗后源应用焦点，仍需对应桌面环境验证。macOS 本机无法证明 Windows GUI 行为；加载 smoke 不等同于交互测试。

## macOS 原生过渡实现

`swift/` 仍可按其 `build.sh` 独立构建，用于对照 AXAPI 行为和回归验证。它不与 `app/` 共用运行时，也不会被 Electron 打包或自动替换已安装应用。

## 安全边界

渲染器启用 context isolation、sandbox、禁用 nodeIntegration；只加载本地页面，禁止外部导航、webview、权限和非 file 请求。应用无网络、无选中文字历史、无独立日志。

## 许可

MIT。
