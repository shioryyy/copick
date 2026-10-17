# Copick

本地划词复制小工具：选中文字，旁边弹出「复制」按钮，点击即复制。

- 纯本地运行：无网络请求、无 AI、无遥测，不保存选中文字。
- 统一 Electron + `selection-hook` 2.1.1 主路线，当前支持 macOS arm64 与 Windows x64。
- Windows 提供 NSIS 安装版（按用户安装，无需管理员）和便携 ZIP；macOS 提供 ZIP。两端都可在设置或托盘开启开机自动启动。

## 目录

| 路径 | 说明 |
|---|---|
| `app/` | 跨平台 Electron 主应用、浮窗、托盘、设置、策略与打包配置 |
| `build/` | 复用图标与构建辅助文件 |
| `docs/DESIGN.md` | 主路线与平台边界 |
| `docs/COMPATIBILITY.md` | 真机兼容性矩阵与发版前测试用例 |
| `.github/workflows/ci.yml` | macOS arm64 与 Windows x64 双平台 CI：检查、测试、smoke test、打包 |
| `.github/workflows/release.yml` | 推送 `v*` tag 后调用 CI 构建、核对版本号、生成 SHA256SUMS 并创建 GitHub Release |
| `CHANGELOG.md` | 更新日志，Release 说明从对应版本小节提取 |

## 开发与检查

在仓库根目录执行：

```bash
cd app
npm ci --registry=https://registry.npmjs.org
npm run check
npm test
# macOS arm64 ZIP
npm run pack:mac
# Windows x64 ZIP + NSIS 安装包（需在 Windows 执行）
npm run dist:win
```

产物位于 `app/release/`，文件名包含平台和架构。打包使用 Electron Builder、asar 和 selection-hook 官方预编译模块；Windows 安装器为 electron-builder 内置 NSIS（非 oneClick、按用户、可选目录、开始菜单快捷方式、不删用户数据），不增加框架、sidecar 或 updater。CI 会静默安装 NSIS 包、对安装后的二进制跑 smoke test 再静默卸载。Windows 构建由 Windows 环境负责，macOS 不模拟 Windows native 模块。

CI 在 macOS arm64 和 Windows x64 runner 上执行以上检查，并对打包后的产物再跑一次 `--smoke-test`，产物以 artifact 保留 14 天。Dependabot 每周检查 npm 依赖，`selection-hook` 被排除在自动升级之外，需人工核对 `docs/DESIGN.md` 中的契约后再升级。

发布：在 `CHANGELOG.md` 写好版本小节，把 `app/package.json` 的 `version` 改成同一号，提交后推送 `v<版本号>` tag。Release 工作流会在 tag 与版本号不一致、CHANGELOG 缺少该小节或 Release 已存在时失败。版本号含 `-` 的标为 Pre-release。在 Actions 页手动运行 Release 工作流是 dry run，只构建和生成校验值，不发布。

`electron . --smoke-test` 只加载 bundled `selection-hook` native module 并退出，不调用 `start()`、不启动全局监听、不发送合成按键。可用于静态/加载检查，不能代替桌面交互验证。

## 运行与权限

应用默认单实例，关闭设置窗口不会退出；托盘可暂停、启用回退、加入最近应用黑名单和退出。选中文字只存在主进程内存，复制浮窗使用短期 token。

- macOS：`programName` 是 selection-hook 原生源码返回的前台应用 **bundle identifier**（例如 `com.apple.finder`），不是臆造的 bundle id 或显示名称。辅助功能状态由 `macIsProcessTrusted()` 提供，每两秒及设置聚焦/托盘操作时刷新；授权后自动恢复监听，撤销后停止监听，不改变用户手动暂停设置，也不清除其他错误。设置页和托盘均可重新检查权限及打开系统设置。默认关闭快捷键剪贴板回退，可在设置中开启。
- 开机自启使用 Electron 的 `setLoginItemSettings`：Windows 写当前用户的注册表 Run 项，macOS 写登录项。设置页会显示系统中的实际状态；便携版移动目录后登记失效，需关闭再开启。未签名的 macOS 应用在登录项里可能显示为开发者未知。
- Windows：`programName` 是可执行程序名（例如 `code.exe`）。默认开启剪贴板回退，可在设置中关闭。Windows 坐标在进入 Electron bounds 前使用 `screenToDipPoint`；macOS 坐标直接使用 Cocoa screen points，不做该转换。
- VS Code、Cursor、Windsurf 这类基于 Monaco 的编辑器默认不开放编辑器文本的无障碍树，Copick 又对它们禁用了快捷键回退（避免打断集成终端），因此默认情况下不会弹窗。需要在编辑器设置里把 `editor.accessibilitySupport` 设为 `on`，之后走无障碍直接取词。
- 两个平台都在原生过滤器和 JS 层过滤。Windows 常见终端、密码管理器和 Copick 有平台内置完全黑名单；macOS Terminal/iTerm2（`com.apple.terminal` / `com.googlecode.iterm2`）及 IDE 只禁止快捷键回退，允许直接无障碍取词。过滤标识统一小写。
- 回退可能临时修改剪贴板，原生库尽力备份/恢复但不保证私有格式、并发复制或剪贴板管理器状态。关闭回退可避免该影响。

复制前前台身份核验尚未完整实现：selection-hook 2.1.1 没有只读前台身份 API，鼠标事件不含来源标识；`getCurrentSelection()` 会进入 AX → 快捷键回退管线，不能安全地当作身份查询。现有按键/鼠标/超时清理无法覆盖系统或程序主动切换前台后仍有效的旧 token，完整修复需要原生只读前台接口。关闭回退再查询会拒绝仅能通过回退取词的应用，本版未采用这一功能退化方案。

未实测限制：macOS Electron arm64 的实际辅助功能授权、各应用 AX/UIA 树延迟、Windows 混合 DPI/管理员窗口/焦点保持以及点击浮窗后源应用焦点，仍需对应桌面环境验证。macOS 本机无法证明 Windows GUI 行为；加载 smoke 不等同于交互测试。

## 安全边界

渲染器启用 context isolation、sandbox、禁用 nodeIntegration；只加载本地页面，禁止外部导航、webview、权限和非 file 请求。应用无网络、无选中文字历史；默认不写诊断日志。排查“没有弹窗”时，可从终端以 `--diagnostics` 启动，日志位于 `logs/selection.log`（Windows 为 `%APPDATA%\Copick\logs`，macOS 为 `~/Library/Logs/Copick`；配置文件在同名用户数据目录下的 `config.json`），只记录监听状态、事件计数、文本长度、过滤原因、浮窗关闭原因和 IPC 通道名，不记录选中文字、按键内容或程序名。

## 许可

MIT。
