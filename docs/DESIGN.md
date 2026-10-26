# Copick 设计

## 主路线

`app/` 是唯一的跨平台 Electron 主路线：主进程统一负责 selection-hook 生命周期、浮窗、托盘、设置、配置和 IPC；平台差异集中在策略标识、权限提示、坐标单位、图标和打包目标。当前目标是 macOS arm64 与 Windows x64，不引入框架、sidecar 或 updater；Windows 提供 electron-builder 内置 NSIS 安装包（按用户安装、可选目录、开始菜单快捷方式、卸载保留用户数据），便携 ZIP 继续提供。

## selection-hook 2.1.1 契约

- macOS 原生 `GetProgramNameFromFrontApp` 取 `NSRunningApplication.bundleIdentifier`，事件中的 `programName` 是 bundle identifier，例如 `com.apple.finder`。
- Windows 事件中的 `programName` 是可执行程序名，例如 `code.exe`。
- `TextSelectionData` 和鼠标事件坐标由库声明为 screen pixels。Electron 的窗口 bounds 使用 DIP：Windows 转换为 `screen.screenToDipPoint`；macOS 使用 Cocoa screen points，不转换。
- macOS 权限使用 `macIsProcessTrusted()` 查询，每两秒及设置聚焦/托盘操作时刷新，只在授权状态变化时启停；未授权时不启动监听，撤销权限时停止。恢复授权保留用户 paused 意图及其他错误。设置和托盘始终提供状态、重新检查与系统 Accessibility 隐私页入口。
- `enableClipboard` 与 `clipboardMode` 只控制回退；直接 AX/UIA 取词仍可用。macOS 默认回退关闭，Windows 默认回退开启；配置可覆盖。
- `writeToClipboard` 由原生库串行化回退事务，浮窗复制使用它而不是 Electron clipboard API。

## 策略

平台内置黑名单使用 selection-hook 实际 programName：macOS 使用 bundle identifier，Windows 使用 `.exe` 名称。Windows 常见终端、密码管理器和自身完全跳过；macOS Terminal/iTerm2（本机 Info.plist 核实 `com.apple.Terminal` / `com.googlecode.iterm2`）与 VS Code、Cursor、Windsurf 等 IDE 仅加入 clipboard filter，禁止快捷键回退而保留直接无障碍取词。自定义名单经过平台对应格式校验，按标识片段匹配。

## 开机启动

`launchAtLogin` 是配置字段，默认关闭，经 `validateConfig` 校验；缺该字段时兼容读取开发版的 `loginItem`，两者同时存在时以 `launchAtLogin` 为准，保存只输出统一字段。旧配置文件两者均缺失时按 false 处理，不触发失败闭锁。启动时和每次保存后各同步一次：Windows 用 `app.setLoginItemSettings` 写 `HKCU\...\Run`，读写共用 `{ path: process.execPath, args: [] }`，因为该平台按字符串比较命令行；便携包移动或改名后启动时会用当前路径重新登记，已被任务管理器禁用的项不覆盖用户选择。macOS 13+ 以登录项状态判断（`status === 'enabled'`），`requires-approval` 时只提示并保留待批状态，不重复登记。Windows 的状态读取使用 `executableWillLaunchAtLogin` 与 `launchItems[].enabled`，因为 Run 值在系统禁用后依然存在，只看 `openAtLogin` 会误报。`app.isPackaged` 为 false 时不写入系统登录项，避免注册 Electron 二进制。

## 浮窗与安全

主进程保留选中文字，渲染器只收到短期 token。复制成功后清除文字、拒绝同一 token 重复复制，并显示约 650 毫秒的确认再隐藏；计时器校验 token，避免关闭后续新选区的浮窗。macOS 浮窗设置 `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`，使用不可聚焦窗口与 `showInactive()` 避免激活或主动切换 Space；点击别处、滚轮、按键、策略更新或 7 秒超时清理。窗口位置先处理无效坐标，再按 work area 限制；慢返回且鼠标已离开时丢弃。显示后调用 `moveTop()`，否则源应用自身置顶时浮窗会留在它下面，点击落到源窗口（Windows 真机复现并修复）。

新选区先隐藏浮窗并建立新 token，渲染器重置文字、颜色和可点击状态后，经过两次 requestAnimationFrame 回调再用固定 popup:ready 接口确认。仅当前有效 token 的首次确认可显示浮窗，过期、撤销、换源、重复或错误页面的确认均不能唤起窗口；显示前不能复制。浮窗禁用 backgroundThrottling，确保隐藏期间也能完成绘制周期，不依赖任意固定毫秒延迟。

selection-hook 2.1.1 没有只读前台身份接口，`getCurrentSelection()` 会进入取词及快捷键回退管线，不能作为身份查询。仓库内 `native/foreground` 使用 Node-API 8，仅主进程加载：macOS 在 Electron 主线程用 NSWorkspace.frontmostApplication 读取 bundle identifier 与 PID；Windows 用 GetForegroundWindow / GetWindowThreadProcessId / OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) / QueryFullProcessImageNameW 读取 exe basename 与 PID，并复核查询期间 HWND/PID 一致。查询不读取 AX/UIA、选区、剪贴板、窗口标题，不发送按键。

接收结果时核对事件程序标识与当前前台标识，绑定当时的 PID。有尚未复制的选区时每 200ms 查询，复制前再次同步比较 program + PID；变化、查询异常或未知身份均清除选区和 token。复制成功后的 650ms 确认不再轮询身份。无选区时定时器不执行系统查询。日志仅记录 foreground-changed / foreground-unavailable 和脱敏异常元数据，不记录程序标识、PID 或路径。启动主动加载并调用查询，加载失败进入启动错误路径；无可识别前台返回 null 属于正常结果。

保证边界：取词事件没有原始 PID，同名另一进程的迟到结果可误绑定当前 PID；同一 PID 的不同窗口、文档、标签页不区分；两次轮询之间无键鼠事件的 A→B→A 不一定被观测。身份查询与 clipboard 写入不是系统原子操作。完整来源绑定需在上游原生取词请求和结果中携带来源身份。

该模块由 node-gyp 单独构建，使用 Node-API 稳定 ABI，不重编 selection-hook。npm start 按当前 Node 架构构建；macOS/Windows 打包前分别传 arm64/x64，二进制明确纳入 files 与 asarUnpack。CI 在目标平台编译，开发态和打包态 smoke 都调用该接口。

状态里的 `loginItemActual` 保留系统 `openAtLogin` 登记状态，`loginItemActive` 反映系统实际生效状态；`loginItemMessage` 提供未生效原因。设置页同时展示自动保存的意图与系统生效状态。

配置保存先校验并原子持久化，再停止/重配监听；非法输入及持久化失败保留已有配置和监听。启动失败保留已保存用户意图、停止运行并单独报告错误，避免磁盘与内存的暂停/回退设置不一致。

设置页开关即时保存，以最新已保存配置为基准；应用列表草稿独立，自动保存、状态广播和窗口聚焦刷新不能覆盖或误提交草稿。列表添加、移除及手动编辑统一显式保存，可撤销。beforeunload 阻止有草稿或正在保存的页面关闭，主进程在 will-prevent-unload 提供默认“继续编辑”的确认；只有明确放弃才允许关闭。退出时先请求关闭设置并确认草稿，再进入整体退出流程，避免取消后复制浮窗已被 Electron 销毁；清理放在 will-quit，避免用户取消退出后监听和托盘被提前销毁。应用显示名采用静态完整标识映射，大小写不敏感，未知原样返回；不扫描系统，不更改原始过滤标识。

渲染器使用 context isolation、sandbox、无 nodeIntegration；IPC 仅有固定的设置读取/保存、辅助功能与登录项入口、会话诊断开关/打开日志目录和 token 复制接口，并校验页面 URL、frame 和 sender。应用无远程内容、网络、遥测和选中文字落盘。

## 验证边界

`npm run check` 和 `npm test` 验证静态语法、平台策略、标识格式、配置失败闭锁和纯坐标函数。`--smoke-test` 加载两个原生模块并调用只读前台查询，不启动 hook、不发送按键。`test:foreground` 在真实 Electron 桌面上以两个独立窗口进程验证实时身份与 token 生命周期，模拟取词/复制写入并只读比对剪贴板内容。实际 macOS Accessibility/AX 应用兼容性、Windows 混合 DPI/管理员窗口/焦点保持必须在对应桌面交互测试；本机静态或加载测试不能替代它们。真机结果记录在 `docs/COMPATIBILITY.md`，发版前按其中的用例逐项更新。

诊断可由启动参数、托盘“帮助与诊断”或设置页开启，只在当前进程生效；动态开启即写入不含敏感内容的监听状态以创建日志目录，停用后不再写入且保留已有文件。故障排查面板使用最新已保存的状态解释暂停、权限、应用排除与兼容复制。

诊断日志记录 IPC 通过（`ipc`，含通道名）与拒绝（`ipc-rejected`）以及浮窗关闭原因（`popup-hidden`：copied、timeout、mouse-down-outside、mouse-wheel、key-down），不含文本。IPC 发送方校验比较的是 `fileURLToPath` 解码后的页面路径（Windows 下忽略大小写），而不是 URL 字符串，避免 Chromium 与 Node 对含空格、非 ASCII 字符或盘符大小写的安装路径编码不一致时所有 IPC 静默失败。
