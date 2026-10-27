# Copick Tauri 兼容性矩阵

只记录 **Tauri 重构版** 的真机结果。Electron 版的记录在 [docs/COMPATIBILITY.md](../docs/COMPATIBILITY.md)，两者的取词引擎实现不同，结果不能互相继承。

## 记录规则

- 每个单元格填写：`✅ 日期/method`、`⚠️ 日期 备注`、`❌ 日期 原因` 或 `—` 未测。
- 「取词」列是关闭剪贴板回退后的结果，只反映无障碍（UIA / AX）路径；「回退」列是默认配置下的结果。`method=1` 表示 UIA，`method=99` 表示剪贴板回退。失败原因取自日志，例如 `COPICK_CAPTURE_EMPTY`。
- 每格都要求：拖选后浮窗出现、点击后剪贴板等于所选文字、浮窗随后隐藏、源应用保持前台。

## 测试机

| 机器 | 系统 | 显示 | 运行方式 |
|---|---|---|---|
| OMEN | Windows 11 x64 10.0.26200.9711 | 3840×2160，100% 缩放，单屏 | 交互式桌面会话，非管理员，`--background` 启动 |
| MacBook（Apple Silicon） | macOS Darwin 27.0.0 | 内建 1440×900 @2x + PHL 275S1 2048×1152 @2x（副屏在左侧） | 浮窗定位夹具 + TextEdit / Safari 应用级取词 |

## 测试方法

`scripts/verify-windows-apps.ps1 -App <notepad|edge|cmd>`：编译 `verify-windows-apps.cs`，用 `SendInput` 绝对移动做真实拖选，找到 Tauri 浮窗（同进程、88×40 缩放后的窗口），点击它并读回剪贴板，最后等浮窗隐藏。记事本与 Edge 会跑两轮——先关回退测无障碍，再开回退测可用性；终端只跑一轮，要求完全不出现选区请求。

注意：`SetCursorPos` 产生的移动不会进入产品的低级鼠标钩子，拖动会被当成单击（`gesture=0`）。脚本必须用 `SendInput` 的绝对移动，这个坑在第一次运行时暴露过。

macOS 用 `npm run verify:mac-textedit` / `npm run verify:mac-safari`（等价于 `node scripts/verify-macos-apps.cjs <app>`）。驱动把测试文字写进临时文件、用 `open -a` 交给目标应用，再按 AX 文档 URL 精确定位本次窗口（TextEdit 会保留上一次的窗口，不锁定就会在旧文档上拖选），最后用 `CGEventPost` 发真实拖选并调用产品的 `cp_capture_begin`。

注意：驱动**不**打包成 `.app`——辅助功能授权按 bundle 记录，新 bundle 要人工去系统设置勾选，而终端子进程直接继承终端已有的授权。运行时会移动鼠标、抢走前台焦点约 3 秒，且桌面必须解锁。剪贴板由 `macos-clipboard-guardian` 备份，并由 `clipboardRestoration.testClipboardRestored` 断言已还原。

## Windows x64

| 应用 | 程序名 | 取词 | 回退 | 备注 |
|---|---|---|---|---|
| Edge（本地 HTML） | msedge.exe | ✅ 2026-10-26 method=1 | ✅ 2026-10-26 method=1 | 正值对照：证明夹具能观察到 UIA 成功。浮窗 `780,229 88x40`，复制内容与选区一致 |
| 记事本 | notepad.exe | ❌ 2026-10-26 `COPICK_CAPTURE_EMPTY` | ✅ 2026-10-26 method=99 | Windows 11 的 WinUI 记事本连续 5 次拖选都取不到文本，回退复制正确 |
| 命令提示符 | cmd.exe | 应不触发 ✅ 2026-10-26 | 应不触发 ✅ 2026-10-26 | 日志无 `COPICK_SELECTION_RECEIVED`，终端全局过滤生效 |
| Windows Terminal | windowsterminal.exe | — | — | 机器上未安装，未测 |
| Chrome | chrome.exe | — | — | 未测 |
| Firefox | firefox.exe | — | — | 未测 |
| Word / Excel | winword.exe / excel.exe | — | — | 需 Office，未测 |
| Edge 内置 PDF | msedge.exe | — | — | 未测 |
| 微信 / 飞书 | weixin.exe / feishu.exe | — | — | 未测 |
| VS Code | code.exe | — | 禁用 | 只在复制回退列表里，未人工验证 |

记事本的 `CAPTURE_EMPTY` 与 Electron 版记录（2026-10-18 记事本 UIA ✅）不一致，最可能的原因是当时测的是经典记事本，而当前系统是 WinUI 版。下一轮要么在经典记事本上复测，要么把这一行标注为「WinUI 记事本不支持 UIA」。

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
| 混合缩放（100% + 150%） | — | 测试机只有 100% |
| 全屏 Space（macOS） | — | 未测 |
| 高 DPI 下浮窗尺寸与点击命中 | ✅ 2026-10-26 100% | 4K 屏 100% 缩放下浮窗为 88×40，点击命中 |
| 终端 / 凭据界面完全过滤 | ⚠️ 2026-10-26 cmd 通过 | UAC、登录界面、Windows Terminal、PowerShell 未逐一验证 |
| 剪贴板管理器同时运行 | — | 未测 |
| Windows NSIS：安装 / 自启开关 / 覆盖升级 / 卸载 | ✅ 2026-10-27 自动化 | `scripts/verify-windows-installer.ps1`，7 项断言全通过，已接入 `tauri.yml` |

## 需要人工确认的部分

自动化只覆盖「拖选 → 浮窗 → 点击复制」这一条主路径。以下仍必须人工在目标机器上执行：双击/三击选词、滚动或按键后浮窗消失、7 秒过期后不再复制旧内容、选中后鼠标移开 100px 不出现浮窗、暂停/恢复监听。开机自启与 NSIS 安装/卸载已由 `verify-windows-installer.ps1` 覆盖。
