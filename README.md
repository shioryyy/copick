# Copick

本地划词复制小工具：选中文字，旁边弹出「复制」按钮，点击即复制。

- 纯本地运行：无网络请求、无 AI、无遥测，不保存选中文字。
- 统一 Electron + `selection-hook` 2.1.1 主路线，当前支持 macOS arm64 与 Windows x64。
- Windows 提供 NSIS 安装版（按用户安装，无需管理员）和便携 ZIP；macOS 提供 ZIP。两端都可在设置中开启登录后自动启动。

## 下载

预编译版本见 [GitHub Releases](https://github.com/shioryyy/copick/releases)：Windows x64 提供 NSIS 安装版（`Copick-Setup-*.exe`）与便携 ZIP，macOS arm64 提供 ZIP。产物未代码签名，首次运行可能被系统拦截；校验值随 Release 一同提供。

## 目录

| 路径 | 说明 |
|---|---|
| `app/` | 跨平台 Electron 主应用、浮窗、托盘、设置、策略与打包配置 |
| `build/` | 复用图标与构建辅助文件 |
| `docs/DESIGN.md` | 主路线与平台边界 |
| `docs/COMPATIBILITY.md` | 真机兼容性矩阵与发版前测试用例 |
| `docs/RELEASE.md` | 发布、代码签名与公证所需的凭据和验证方法 |
| `.github/workflows/ci.yml` | macOS arm64 与 Windows x64 双平台 CI：检查、测试、smoke test、打包 |
| `.github/workflows/release.yml` | 推送 `v*` tag 后调用 CI 构建、核对版本号、生成 SHA256SUMS 并创建 GitHub Release |
| `CHANGELOG.md` | 更新日志，Release 说明从对应版本小节提取 |

## 开发与检查

在仓库根目录执行：

```bash
cd app
npm ci --registry=https://registry.npmjs.org
npm run build:native
npm run check
npm test
# macOS arm64 ZIP
npm run pack:mac
# Windows x64 ZIP + NSIS 安装包（需在 Windows 执行）
npm run dist:win
```

前台应用查询使用仓库内的小型 Node-API 8 模块。开发机需 Python 3，macOS 需 Xcode Command Line Tools，Windows 需 Visual Studio C++ Build Tools 与 Windows SDK；`npm start` 和打包命令会自动构建。macOS 打包明确编译 arm64，Windows 打包明确编译 x64；`selection-hook` 继续使用上游预编译模块。

产物位于 `app/release/`，文件名包含平台和架构。打包使用 Electron Builder、asar 和 selection-hook 官方预编译模块；Windows 安装器为 electron-builder 内置 NSIS（非 oneClick、按用户、可选目录、开始菜单快捷方式、不删用户数据），不增加框架、sidecar 或 updater。CI 会静默安装 NSIS 包、对安装后的二进制跑 smoke test 再静默卸载。Windows 构建由 Windows 环境负责，macOS 不模拟 Windows native 模块。

CI 在 macOS arm64 和 Windows x64 runner 上执行以上检查，并对打包后的产物再跑一次 `--smoke-test`，产物以 artifact 保留 14 天。Dependabot 每周检查 npm 依赖，`selection-hook` 被排除在自动升级之外，需人工核对 `docs/DESIGN.md` 中的契约后再升级。

发布：在 `CHANGELOG.md` 写好版本小节，把 `app/package.json` 的 `version` 改成同一号，提交后推送 `v<版本号>` tag。Release 工作流会在 tag 与版本号不一致、CHANGELOG 缺少该小节或 Release 已存在时失败。版本号含 `-` 的标为 Pre-release。在 Actions 页手动运行 Release 工作流是 dry run，只构建和生成校验值，不发布。提供签名凭据后产物在流水线中自动签名，macOS 配置 Apple 凭据后自动公证，见 `docs/RELEASE.md`。

`npm run test:ui` 运行可重复的 Electron 交互回归，需要可用的图形桌面和 Playwright。可先在独立目录安装驱动，再指定其路径（不加入应用依赖）：

```bash
driver=$(mktemp -d /tmp/copick-ui-driver.XXXXXX)
npm install --prefix "$driver" --no-save --package-lock=false playwright
COPICK_PLAYWRIGHT_PATH="$driver/node_modules/playwright" npm --prefix app run test:ui
```

脚本使用隔离的临时配置，模拟原生 hook、前台身份与关闭确认的选择，不监听桌面、不写系统剪贴板；实际运行设置/复制窗口、渲染器、配置保存、IPC 和计时器，覆盖自动保存与非法草稿隔离、校验及撤销、关闭/退出保护、会话诊断、深浅色、复制确认与延迟激活。运行结果输出截图目录。它不能代替原生 AX/UIA、焦点和 Windows 真机验证。

`npm run test:foreground` 使用相同的 Playwright 路径，自动构建原生模块并启动两个独立测试窗口进程，验证真实系统前台查询、同名不同 PID 切换、旧 token 失效及剪贴板内容保持不变。该脚本会暂时切换前台窗口；取词与写剪贴板动作模拟，不替代 AX/UIA 真机验证。

`electron . --smoke-test` 加载 `selection-hook` 和前台身份原生模块、调用一次只读身份查询并退出，不调用 `start()`、不启动全局监听、不发送合成按键。可用于静态/加载检查，不能代替桌面交互验证。

## 运行与权限

应用默认单实例，关闭设置窗口不会退出；托盘提供暂停划词、在最近取词应用中停用、设置、帮助与诊断和退出。暂停划词、兼容复制、登录后自动启动的开关会自动保存；排除应用的添加、移除和手动编辑需点击“保存排除应用”，也可撤销更改。开关操作不会提交或覆盖未保存的应用列表，关闭设置或退出时会提醒保留或放弃草稿。常见应用同时显示名称和原标识，未知标识原样显示。选中文字只存在主进程内存，复制浮窗使用短期 token。

- macOS：`programName` 是 selection-hook 原生源码返回的前台应用 **bundle identifier**（例如 `com.apple.finder`），不是臆造的 bundle id 或显示名称。辅助功能状态由 `macIsProcessTrusted()` 提供，每两秒及设置聚焦/托盘操作时刷新；授权后自动恢复监听，撤销后停止监听，不改变用户手动暂停设置，也不清除其他错误。设置页和托盘均可重新检查权限及打开系统设置。默认关闭快捷键剪贴板回退，可在设置中开启。
- Windows：`programName` 是可执行程序名（例如 `code.exe`）。默认开启剪贴板回退，可在设置中关闭。Windows 坐标在进入 Electron bounds 前使用 `screenToDipPoint`；macOS 坐标直接使用 Cocoa screen points，不做该转换。
- VS Code、Cursor、Windsurf 这类基于 Monaco 的编辑器默认不开放编辑器文本的无障碍树，Copick 又对它们禁用了快捷键回退（避免打断集成终端），因此默认情况下不会弹窗。需要在编辑器设置里把 `editor.accessibilitySupport` 设为 `on`，之后走无障碍直接取词。
- 两个平台都在原生过滤器和 JS 层过滤。Windows 常见终端、密码管理器和 Copick 有平台内置完全黑名单；macOS Terminal/iTerm2（`com.apple.terminal` / `com.googlecode.iterm2`）及 IDE 只禁止快捷键回退，允许直接无障碍取词。过滤标识统一小写。
- 回退可能临时修改剪贴板，原生库尽力备份/恢复但不保证私有格式、并发复制或剪贴板管理器状态。关闭回退可避免该影响。
- 登录后自动启动默认关闭，可在设置页开关。macOS 走系统登录项（macOS 13+ 的 BTM/SMAppService），系统可能要求用户在「系统设置 > 通用 > 登录项」中批准；未签名或未公证的构建可能登记失败，设置页会直接说明原因。Windows 写入 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，不需要管理员权限。Windows 提供 NSIS 安装包和便携 ZIP，登录项记录可执行文件的绝对路径，移动或改名后应用会在下次启动时重新登记；被任务管理器禁用的启动项不会在启动时被强行改回。开发模式（未打包）不写入系统登录项。

前台身份核验通过独立原生模块读取当前应用标识与 PID，不访问选区、剪贴板或发送快捷键。接收选区时先核对程序标识并绑定当前进程；有待复制选区时每 200 毫秒检查一次，复制前再同步检查。身份变化或不可读取时隐藏浮窗并销毁 token，切回来源也不会恢复已失效 token。查询只用于主进程，不暴露给渲染器，也不写入诊断日志。

核验边界：selection-hook 2.1.1 的结果不携带原始 PID，因此同名另一进程的迟到取词结果仍可能绑定到当前进程；同一进程的窗口、文档及标签页不作区分；两次轮询之间无键鼠事件的快速离开再返回可能未被观测。系统前台查询与原生剪贴板写入也不是原子操作。彻底绑定取词来源需要上游将原始进程身份随请求和结果一起传递。

未实测限制：macOS Electron arm64 的实际辅助功能授权、各应用 AX/UIA 树延迟、Windows 混合 DPI/管理员窗口/焦点保持以及点击浮窗后源应用焦点，仍需对应桌面环境验证。macOS 本机无法证明 Windows GUI 行为；加载 smoke 不等同于交互测试。

## 安全边界

渲染器启用 context isolation、sandbox、禁用 nodeIntegration；只加载本地页面，禁止外部导航、webview、权限和非 file 请求。应用无网络、无选中文字历史；默认不写诊断日志。排查“没有弹窗”时，可从托盘“帮助与诊断”或设置页“没有出现复制按钮？”开启诊断，也可从终端以 `--diagnostics` 启动。开关仅本次运行有效，关闭后停止记录但不删除已有日志；日志位于 `logs/selection.log`（Windows 为 `%APPDATA%\Copick\logs`，macOS 为 `~/Library/Logs/Copick`；配置文件在同名用户数据目录下的 `config.json`），只记录监听状态、事件计数、文本长度、过滤原因、浮窗关闭原因和 IPC 通道名，不记录选中文字、按键内容或程序名。

## 许可

MIT。
