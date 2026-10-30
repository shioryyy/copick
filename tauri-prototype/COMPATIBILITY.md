# Copick Tauri 兼容性矩阵

只记录 **Tauri 重构版** 的真机结果。Electron 版的记录在 [docs/COMPATIBILITY.md](../docs/COMPATIBILITY.md)，两者的取词引擎实现不同，结果不能互相继承。

## 记录规则

- 每个单元格填写：`✅ 日期/method`、`⚠️ 日期 备注`、`❌ 日期 原因` 或 `—` 未测。
- 「取词」列是关闭剪贴板回退后的结果，只反映无障碍（UIA / AX）路径；「回退」列是显式开启回退后的结果。Windows 上回退默认关闭。`method=1` 表示 UIA，`method=99` 表示剪贴板回退。失败原因取自日志，例如 `COPICK_CAPTURE_EMPTY`。
- 每格都要求：拖选后浮窗出现、点击后剪贴板等于所选文字、浮窗随后隐藏、源应用保持前台。

## 测试机

| 机器 | 系统 | 显示 | 运行方式 |
|---|---|---|---|
| OMEN | Windows 11 x64 10.0.26200.9711 | 3840×2160，150% 缩放，单屏 | 交互式桌面会话（计划任务 `LogonType Interactive`），非管理员，`--background` 启动 |
| MacBook（Apple Silicon） | macOS Darwin 27.0.0 | 内建 1440×900 @2x + PHL 275S1 2048×1152 @2x（副屏在左侧） | 浮窗定位夹具 + TextEdit / Safari 应用级取词 |

## 测试方法

`scripts/start-windows-app-matrix.ps1 -App <notepad|cmd|edge|word|vscode>` 注册一个 `LogonType Interactive` 的计划任务来跑 `scripts/verify-windows-apps.ps1`——ssh 落在 Session 0，建不了 WebView2，拖选也打不到真实窗口。脚本编译 `verify-windows-apps.cs`，用 `SendInput` 绝对移动做真实拖选，找到 Tauri 浮窗（同进程、88×40 缩放后的窗口），点击它并读回剪贴板，最后等浮窗隐藏。记事本、Edge、Word、VS Code 会跑两轮——先关回退测无障碍，再开回退测可用性；终端只跑一轮，要求完全不出现选区请求。

几条真机上踩出来的约束，都写进了驱动：

- **拖拽起点不能猜**。Windows 11 记事本正文在客户区顶部，Word 打开导航窗格时页面区从客户区 46% 处才开始，VS Code 有行号栏。驱动先用 UIA 找 `Document`/`Edit` 控件的外框，找不到才按比例扫一遍二维网格。
- **浮窗出现不代表选对了地方**。Edge 场景里误拖到地址栏同样会弹窗，剪贴板里就是 URL。驱动要求剪贴板内容确实来自测试文档，否则关掉浮窗换下一个坐标。
- **剪贴板必须先放哨兵**。产品异步写剪贴板，直接读会读到上一轮的残留；哨兵值能区分「产品没写」和「写了旧内容」。哨兵必须用 Win32 `SetClipboardData` 写，`.NET Clipboard.SetText` 的 OLE 延迟渲染会把产品的 `EmptyClipboard` 卡到超时。
- **DPI 感知必须显式打开**。UIA 的 `BoundingRectangle` 用物理像素，而 `GetClientRect` 默认返回逻辑像素；150% 缩放下 1265 宽的窗口会算出 1803 的右边界。
- **期望文本要在启动应用前另存一份**。Word 独占打开文档，驱动事后读会抛 `IOException`，整个场景就变成「验证失败」而不是「取词失败」。

注意：`SetCursorPos` 产生的移动不会进入产品的低级鼠标钩子，拖动会被当成单击（`gesture=0`）。脚本必须用 `SendInput` 的绝对移动，这个坑在第一次运行时暴露过。

这个驱动没有接入 CI，只在 OMEN 的交互桌面手动跑过，不是回归套件：它会写平台配置再还原，按进程名关掉正在运行的 VS Code 与 `copick-tauri-prototype`，VS Code 场景还会改 `%APPDATA%\Code\User\settings.json` 再写回——跑之前要确认这两处没有未保存的内容。它判定复制内容用的是「文档去空白后包含剪贴板文本」的包含关系，只能说明复制到了正确文档附近，不证明等于实际选区。

macOS 用 `npm run verify:mac-textedit` / `npm run verify:mac-safari`（等价于 `node scripts/verify-macos-apps.cjs <app>`）。驱动把测试文字写进临时文件、用 `open -a` 交给目标应用，再按 AX 文档 URL 精确定位本次窗口（TextEdit 会保留上一次的窗口，不锁定就会在旧文档上拖选），最后用 `CGEventPost` 发真实拖选并调用产品的 `cp_capture_begin`。

注意：驱动**不**打包成 `.app`——辅助功能授权按 bundle 记录，新 bundle 要人工去系统设置勾选，而终端子进程直接继承终端已有的授权。运行时会移动鼠标、抢走前台焦点约 3 秒，且桌面必须解锁。剪贴板由 `macos-clipboard-guardian` 备份，并由 `clipboardRestoration.testClipboardRestored` 断言已还原。

## Windows x64

| 应用 | 程序名 | 取词 | 回退 | 备注 |
|---|---|---|---|---|
| Edge（本地 HTML） | msedge.exe | ✅ 2026-10-28 method=1 | ✅ 2026-10-27 method=1 | legacy 与 UIA8 构建都取到词 |
| 记事本（WinUI） | notepad.exe | ✅ 2026-10-28 method=1（UIA8） | ✅ 2026-10-28 method=99（UIA8 构建，显式开启） | 同一份产品源码分别构建：legacy 9 次拖选全部 `COPICK_CAPTURE_EMPTY`；`CUIAutomation8` 构建 `method=1` 直取成功。最终构建两轮都是 `method=1` |
| Word | winword.exe | ✅ 2026-10-28 method=1 | ✅ 2026-10-27 method=1 | legacy 与 UIA8 构建都取到词 |
| 命令提示符 | cmd.exe | ⚠️ 2026-10-28 无浮窗（UIA8） | 禁用（`ProtectedPrograms`） | 日志无 `COPICK_SELECTION_RECEIVED`；但驱动没法证明终端里确实选中了文字，见下 |
| VS Code | code.exe | ✅ 2026-10-28 method=1 | 禁用（`NoClipboardPrograms`） | 需要 `--force-renderer-accessibility`；legacy 与 UIA8 都取到词 |
| Windows Terminal | windowsterminal.exe | — | — | 机器上未安装，未测 |
| Excel | excel.exe | — | — | 机器上未安装，未测 |
| Chrome | chrome.exe | — | — | 机器上未安装，未测 |
| Firefox | firefox.exe | — | — | 机器上未安装，未测 |
| Edge 内置 PDF | msedge.exe | — | — | 未测 |
| 微信 / 飞书 | weixin.exe / feishu.exe | — | — | 未测 |

记事本的 `CAPTURE_EMPTY` 与 Electron 版记录（2026-10-18 记事本 UIA ✅）不一致，最可能还是经典记事本和 WinUI 版的差别。

早期的独立引擎对照实验已经定位到客户端：同一笔记事本、同一次拖选，`CUIAutomation` 拿到的焦点是 `Edit`、`GetCurrentPatternAs` 返回 `S_OK` 但指针为空；换成 `CUIAutomation8` 后焦点变成 `Document`，`TextPattern` 直接读出选区。

2026-10-28 在 OMEN 上用完整产品复核了这个结论。同一份源码分别构建 legacy 和 `notepad` 候选两种模式，各自启动真实产品、打开同一个临时记事本文档、由驱动拖选：

- legacy 构建：9 次拖选全部 `COPICK_CAPTURE_EMPTY`，浮窗不出现。
- `notepad` 候选构建：`COPICK_SELECTION_RECEIVED` / `COPICK_POPUP_PRESENTED method=1`，浮窗出现，点击后复制到 `pick UIA8 probe line two`（拖选起点落在行中间，前半截没选中，属驱动坐标问题）。

`method=1` 是 UIA 直取；该轮配置 `clipboardFallback=false`，所以不可能是剪贴板回退。

2026-10-28 又在 Edge、Word、VS Code、cmd 上做了 legacy / UIA8 配对（`COPICK_WINDOWS_UIA_MODE` 分别构建，各自启动真实产品和真实应用）：

| 应用 | legacy | UIA8 |
|---|---|---|
| 记事本 | ❌ 9 次全部 `CAPTURE_EMPTY` | ✅ `method=1` |
| Edge | ✅ `method=1` | ✅ `method=1` |
| Word | ✅ `method=1` | ✅ `method=1` |
| VS Code | ✅ `method=1` | ✅ `method=1` |
| cmd | 未测 | ⚠️ 无浮窗 |

四个应用的 UIA8 结果都不差于 legacy，记事本是唯一有明显收益的。cmd 在 UIA8 下同样没有浮窗、日志也没有 `COPICK_SELECTION_RECEIVED`，但驱动证明不了终端里真的选中了文字，所以这只能说明「没有发生取词」，不能单独证明全局过滤生效；过滤本身在程序名阶段完成，早于 UIA 客户端。

VS Code 在 2026-10-27 那轮用同样的启动参数读到空串，2026-10-28 却连续两轮成功，差别没有查清。这一行按「可用但依赖 `--force-renderer-accessibility`、结果偶发」记录，不能当成稳定通过。

**UIA8 范围：** 以上五个应用之外未测。这些是自动化拖选的结果，驱动的坐标是固定偏移，不代表所有选区位置都能命中；`method=1` 只说明走的是 UIA 直取，不说明读到的文字与手选内容逐字一致。

配对结果没有发现 UIA8 不如 legacy 的应用，因此产品已改为只创建 `CUIAutomation8`，构建开关与候选策略都已删除。函数式夹具同时验证了显式开启回退时 UIA8 仍会执行合成复制（`method=99`），默认关闭时无浮窗、无快捷键副作用；细节见 [VALIDATION.md](VALIDATION.md)。

## macOS arm64

2026-10-27 补了真实应用的取词测试，`scripts/verify-macos-apps.cjs` 把 `bridge.mm` 编进一个独立进程，用 CGEvent 向目标应用发真实拖选，再用产品自己的 `cp_capture_begin` 取词。编译的是产品源码而不是打包后的 `.app`，因此覆盖的是取词与浮窗路径，不含 Tauri 外壳。

| 应用 | bundle identifier | 取词 | 回退 | 备注 |
|---|---|---|---|---|
| TextEdit | com.apple.TextEdit | ✅ 2026-10-27 method=11 | 禁用 | 拖选一段文字，取到 `CopickPrototype`，浮窗与复制均正确，剪贴板已还原 |
| Safari | com.apple.Safari | ✅ 2026-10-27 method=11 | 禁用 | 依赖 `bridge.mm` 里的 WebKit 文本标记回退。Safari 27 只提供 `AXSelectedTextMarkerRange`，`AXSelectedText` 为空，上游引擎因此取不到词；回退补上后取词、浮窗、复制均正确 |
| Chrome | com.google.Chrome | — | 禁用 | 本机未安装 |
| Terminal | com.apple.Terminal | 应不触发 | 禁用 | 内置黑名单常量，未做交互验证 |
| Finder | com.apple.finder | 应不触发 | 禁用 | 内置黑名单常量，未做交互验证 |

Safari 那一行最初是 ❌，矩阵暴露出的**产品缺口**而不是测试环境问题：驱动在同一轮里同时记录了三条独立证据——网页 `onmouseup` 写入标题的选区、`AXSelectedText`（空）、`AXStringForTextMarkerRange`（正确）。现在 `bridge.mm` 在引擎之后补了一次文本标记查询（`ReadWebKitSelection`），Safari 恢复可用。

这条回退目前只在 `bridge.mm` 里，上游 `selection-hook` 的 `GetSelectedTextFromElement` 仍然只有 `AXSelectedText` 与「`AXValue` + `AXSelectedTextRange`」两条路径，因此 **Electron 版依然取不到 Safari 的选区**。要么给上游提 PR，要么承认两个版本的 Safari 行为已经不一致。

macOS 的剪贴板回退按设计始终关闭（引擎不提供事务内取消），因此「回退」列固定为「禁用」。

## 系统级用例

| 用例 | 结果 | 备注 |
|---|---|---|
| 多显示器浮窗定位 | ✅ 2026-10-26 | 双屏（内建 1440×900@2x + 左侧 2048×1152@2x）7 个锚点偏差全为 0，含虚拟桌面外锚点，见 [VALIDATION.md](VALIDATION.md) |
| 混合缩放（100% + 150%） | — | 测试机单屏，未测混合缩放 |
| 全屏 Space（macOS） | — | 未测 |
| 高 DPI 下浮窗尺寸与点击命中 | ⚠️ 2026-10-26 | 当时记录为 4K 屏 100% 缩放下浮窗 88×40、点击命中；后来测试机改到 150%，这一项没有复测 |
| 终端 / 凭据界面完全过滤 | — 未验证 | cmd 拖选没确认成功；UAC、登录界面、Windows Terminal、PowerShell 未测 |
| 剪贴板管理器同时运行 | — | 未测 |
| Windows NSIS：安装 / 自启开关 / 覆盖升级 / 卸载 | ✅ 2026-10-27 自动化 | `scripts/verify-windows-installer.ps1`，7 项断言全通过，已接入 `tauri.yml` |

## 需要人工确认的部分

自动化只覆盖「拖选 → 浮窗 → 点击复制」这一条主路径。以下仍必须人工在目标机器上执行：双击/三击选词、滚动或按键后浮窗消失、7 秒过期后不再复制旧内容、选中后鼠标移开 100px 不出现浮窗、暂停/恢复监听。开机自启与 NSIS 安装/卸载已由 `verify-windows-installer.ps1` 覆盖。
