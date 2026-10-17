# Copick 设计

## 主路线

`app/` 是唯一的跨平台 Electron 主路线：主进程统一负责 selection-hook 生命周期、浮窗、托盘、设置、配置和 IPC；平台差异集中在策略标识、权限提示、坐标单位、图标和打包目标。当前目标是 macOS arm64 与 Windows x64，不引入框架、sidecar、安装器或 updater。

## selection-hook 2.1.1 契约

- macOS 原生 `GetProgramNameFromFrontApp` 取 `NSRunningApplication.bundleIdentifier`，事件中的 `programName` 是 bundle identifier，例如 `com.apple.finder`。
- Windows 事件中的 `programName` 是可执行程序名，例如 `code.exe`。
- `TextSelectionData` 和鼠标事件坐标由库声明为 screen pixels。Electron 的窗口 bounds 使用 DIP：Windows 转换为 `screen.screenToDipPoint`；macOS 使用 Cocoa screen points，不转换。
- macOS 权限使用 `macIsProcessTrusted()` 查询，每两秒及设置聚焦/托盘操作时刷新，只在授权状态变化时启停；未授权时不启动监听，撤销权限时停止。恢复授权保留用户 paused 意图及其他错误。设置和托盘始终提供状态、重新检查与系统 Accessibility 隐私页入口。
- `enableClipboard` 与 `clipboardMode` 只控制回退；直接 AX/UIA 取词仍可用。macOS 默认回退关闭，Windows 默认回退开启；配置可覆盖。
- `writeToClipboard` 由原生库串行化回退事务，浮窗复制使用它而不是 Electron clipboard API。

## 策略

平台内置黑名单使用 selection-hook 实际 programName：macOS 使用 bundle identifier，Windows 使用 `.exe` 名称。Windows 常见终端、密码管理器和自身完全跳过；macOS Terminal/iTerm2（本机 Info.plist 核实 `com.apple.Terminal` / `com.googlecode.iterm2`）与 VS Code、Cursor、Windsurf 等 IDE 仅加入 clipboard filter，禁止快捷键回退而保留直接无障碍取词。自定义名单经过平台对应格式校验，按标识片段匹配。

## 浮窗与安全

主进程保留选中文字，渲染器只收到短期 token。macOS 浮窗设置 `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`，使用不可聚焦窗口与 `showInactive()` 避免激活或主动切换 Space；点击别处、滚轮、按键、策略更新或 7 秒超时清理。窗口位置先处理无效坐标，再按 work area 限制；慢返回且鼠标已离开时丢弃。

复制前无法通过现有库可靠核验当前前台应用：`index.d.ts` 没有只读身份接口，`MouseEventData` 仅含坐标/按钮；macOS `GetCurrentSelection` 进入 `SelectionEngine::GetSelectedText`，AX 失败会尝试 ⌘C 回退。为保留仅回退取词的复制能力，未采用关闭回退后再次取词的保守拒绝方案。非键鼠触发的前台切换仍可能留下旧 token，需要原生只读前台身份接口才可完整修复。

配置保存先校验并原子持久化，再停止/重配监听；非法输入及持久化失败保留已有配置和监听。启动失败保留已保存用户意图、停止运行并单独报告错误，避免磁盘与内存的暂停/回退设置不一致。

渲染器使用 context isolation、sandbox、无 nodeIntegration；IPC 仅有固定的设置读取/保存、辅助功能入口和 token 复制接口，并校验页面 URL、frame 和 sender。应用无远程内容、网络、遥测和选中文字落盘。

## 验证边界

`npm run check` 和 `npm test` 验证静态语法、平台策略、标识格式、配置失败闭锁和纯坐标函数。`--smoke-test` 只加载 native module，不启动 hook、不发送按键。实际 macOS Accessibility/AX 应用兼容性、Windows 混合 DPI/管理员窗口/焦点保持必须在对应桌面交互测试；本机静态或加载测试不能替代它们。真机结果记录在 `docs/COMPATIBILITY.md`，发版前按其中的用例逐项更新。

IPC 发送方校验比较的是 `fileURLToPath` 解码后的页面路径（Windows 下忽略大小写），而不是 URL 字符串，避免 Chromium 与 Node 对含空格、非 ASCII 字符或盘符大小写的安装路径编码不一致时所有 IPC 静默失败。
