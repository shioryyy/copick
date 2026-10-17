# Copick 兼容性矩阵

Copick 的全部价值是「在某个应用里选中文字后，浮窗可靠出现并能复制」。单元测试和 CI 的 smoke test 都不能证明这一点，只有真机交互测试可以。本文件是测试记录，每次发版前更新。

## 记录规则

- 每个单元格填写：`✅ 版本/日期`、`⚠️ 版本/日期 备注`、`❌ 版本/日期 原因` 或 `—` 未测。
- 「取词」列记录直接无障碍取词（AX / UIA）是否成功；「回退」列记录开启快捷键回退后是否成功。回退默认 macOS 关、Windows 开。
- 失败时附带 `--diagnostics` 日志中的 `reason` 或 `method` 字段，不要贴选中文字。`method=99` 表示走了剪贴板回退而非无障碍取词；`popup-hidden` 的 `reason` 说明浮窗为何消失；`ipc-rejected` 说明设置页或浮窗的请求被拒。
- 测试机信息写在矩阵下方：系统版本、显示器数量与缩放比、是否管理员运行。

## 通用用例

每个应用至少跑完以下 6 步：

1. 鼠标拖选一段文字 → 浮窗出现在选区右下方，不抢焦点。
2. 点击「复制」→ 剪贴板内容等于所选文字，浮窗消失，源应用保持焦点。
3. 双击单词、三击整段 → 浮窗出现。
4. 选中后滚动、按任意键、点击别处 → 浮窗消失。
5. 等待 7 秒不操作 → 浮窗消失，之后点击原位置不会复制旧内容。
6. 选中后立即把鼠标移开超过 100px → 不出现浮窗（慢返回丢弃）。

## macOS arm64

| 应用 | bundle identifier | 取词 | 回退 | 全屏 Space | 备注 |
|---|---|---|---|---|---|
| Safari | com.apple.Safari | — | — | — | |
| Chrome | com.google.Chrome | — | — | — | |
| Firefox | org.mozilla.firefox | — | — | — | |
| 文本编辑 | com.apple.TextEdit | — | — | — | |
| 备忘录 | com.apple.Notes | — | — | — | |
| 预览 PDF | com.apple.Preview | — | — | — | |
| 邮件 | com.apple.mail | — | — | — | |
| Pages | com.apple.iWork.Pages | — | — | — | |
| Word | com.microsoft.Word | — | — | — | |
| 微信 | com.tencent.xinWeChat | — | — | — | |
| 飞书 | com.electron.lark | — | — | — | Electron，需确认 AX 树开启 |
| Slack | com.tinyspeck.slackmacgap | — | — | — | Electron |
| VS Code | com.microsoft.VSCode | — | 禁用 | — | 平台内置禁止回退 |
| Terminal | com.apple.Terminal | — | 禁用 | — | 平台内置禁止回退 |
| Finder | com.apple.finder | 应不触发 | 应不触发 | — | 平台内置完全黑名单 |
| 1Password | com.1password.1password | 应不触发 | 应不触发 | — | 平台内置完全黑名单 |

### macOS 系统级用例

| 用例 | 结果 | 备注 |
|---|---|---|
| 首次启动未授权：托盘提示、设置页出现、监听不启动 | — | |
| 在系统设置中授权后 2 秒内自动开始监听，无需重启 | — | |
| 撤销授权后监听停止，恢复后不改变用户「暂停」状态 | — | |
| 重新解压同版本 ZIP 后授权是否仍有效 | — | 未签名应用预期会失效，记录实际行为 |
| 外接显示器 + 不同缩放比，浮窗位置正确 | — | |
| 浮窗在全屏 Space 中出现且不切换 Space | — | |
| 点击浮窗后源应用保持焦点 | — | |
| 剪贴板管理器（如 Paste、Maccy）运行时回退不丢内容 | — | |

## Windows x64

| 应用 | 程序名 | 取词 | 回退 | 高 DPI | 备注 |
|---|---|---|---|---|---|
| Edge 网页 | msedge.exe | ✅ 2026-10-18 UIA | — | ✅ 100% | 第一次拖选因鼠标移开过快被丢弃（cursor-moved），第二次 UIA 取词、复制成功 |
| Chrome | chrome.exe | ✅ 2026-10-18 UIA | ✅ 2026-10-18 | ✅ 100% | 第一轮首次取词走回退（method=99），关闭回退复测走 UIA。推测 Chromium 的无障碍树在首次被 UIA 客户端查询后才激活，首次选择会落到回退 |
| Firefox | firefox.exe | ✅ 2026-10-18 UIA | ✅ 2026-10-18 | ✅ 100% | 与 Chrome 相同：第一轮走回退，关闭回退复测走 UIA，无障碍按需激活 |
| 记事本 | notepad.exe | ✅ 2026-10-18 UIA | — | ✅ 100% | 关闭回退后仍弹窗，走 UIA |
| Word | winword.exe | ✅ 2026-10-18 UIA | — | ✅ 100% | 关闭回退后仍弹窗，走 UIA |
| Excel 单元格 | excel.exe | ❌ 2026-10-18 | ✅ 2026-10-18 | ✅ 100% | 关闭回退后无弹窗，只能靠回退 |
| Outlook | outlook.exe | — | — | — | 2026-10-18 未测 |
| Acrobat Reader | acrord32.exe / acrobat.exe | — | — | — | 2026-10-18 未测 |
| Edge PDF | msedge.exe | ❌ 2026-10-18 | ✅ 2026-10-18 | ✅ 100% | 关闭回退后无弹窗，只能靠回退；同一进程的网页可走 UIA |
| 微信 | weixin.exe | ❌ 2026-10-18 | ✅ 2026-10-18 | ✅ 100% | 关闭回退后无弹窗，只能靠回退 |
| 飞书 8.2 | feishu.exe | ✅ 2026-10-18 UIA | — | ✅ 100% | Electron，两轮均走 UIA |
| 资源管理器文件名 | explorer.exe | ❌ 2026-10-18 | ✅ 2026-10-18 | ✅ 100% | 关闭回退后无弹窗，只能靠回退 |
| VS Code 1.132 | code.exe | ⚠️ 2026-10-18 | 禁用 | ✅ 100% | 默认设置下无任何事件：Monaco 编辑器不开放无障碍树（UIA 报 "The editor is not accessible at this time"），而回退被策略禁用。把 `editor.accessibilitySupport` 设为 `on` 后 UIA 取词成功（method=1，posLevel=3），浮窗位置正确。临时配置目录对照实验，两种配置各拖选两次 |
| 自建 Win32 Edit 测试宿主（见下方说明） | copicktesthost.exe | ❌ UIA 未取到 | ✅ 0.3.0-beta.1 2026-10-17 | ✅ 100% | 通用 6 步全部通过：浮窗位置、复制内容、焦点保持、7 秒超时、点击/滚轮消失、快速移开丢弃。取词走 method=99 回退，说明关闭回退后经典 Win32 Edit 控件取不到词 |
| Windows Terminal | windowsterminal.exe | ✅ 不触发 2026-10-18 | ✅ 不触发 | — | 平台内置完全黑名单，用户真机确认 |
| 1Password | 1password.exe | 应不触发 | 应不触发 | — | 平台内置完全黑名单 |

### Windows 系统级用例

| 用例 | 结果 | 备注 |
|---|---|---|
| 解压到含中文或空格的路径下启动，设置页可读取并保存 | ⚠️ 2026-10-17 | 路径 `测试 目录 (1)` 下启动、监听、浮窗就绪均正常；设置页 IPC 见下一行 |
| 中文路径下设置页 IPC 可用 | ✅ 2026-10-17 | 诊断日志出现 `ipc channel=settings:read`，无 `ipc-rejected` |
| 源应用自身置顶（TopMost）时浮窗仍在最上层且可点击 | ✅ 2026-10-17 | 修复前浮窗被置顶宿主盖住、点击落到源窗口；显示后调用 `moveTop()` 修复 |
| 安装版：静默安装、安装后二进制、静默卸载 | ✅ 2026-10-18 本机与 CI | 静默安装到临时目录；安装后的 Copick.exe 通过 `--smoke-test`；卸载后 Copick.exe 与开始菜单快捷方式清除。本机与 Windows runner 均通过 |
| 开机自启：配置开启后系统登记 Run 项 | ✅ 2026-10-18 CI | Windows runner 上以暂停配置启动安装版一次，HKCU Run 项出现，覆盖配置为开而系统未登记时的启动补登记路径；保存开关时的写入由单元测试覆盖 |
| 主屏 100% + 副屏 150% 缩放，两屏浮窗位置均正确 | — | screenToDipPoint 转换 |
| 以管理员运行的应用（如管理员 PowerShell 外的记事本）能否取词 | — | 普通权限 Copick 预期不能注入高完整性窗口 |
| 点击浮窗后源应用保持焦点，输入不中断 | — | |
| 系统休眠唤醒后监听仍工作 | — | |
| 切换用户 / 锁屏后恢复 | — | |
| SmartScreen 对未签名 ZIP 的提示文案 | — | 记录以便写用户指引 |
| 剪贴板历史（Win+V）开启时回退是否留下记录 | — | README 已说明可能发生 |

## Windows 上关闭回退的代价

2026-10-18 的真机结果说明，Windows 默认开启回退是必要的：关闭后 Excel 单元格、Edge 内置 PDF、微信聊天记录和资源管理器文件名全部取不到词，只剩浏览器网页、记事本、Word、飞书这类实现了 UIA TextPattern 的应用。另外 Chrome 和 Firefox 在启动后的首次取词会落到回退，因为它们的无障碍树要等第一个 UIA 客户端查询后才激活；关闭回退时这第一次选择会静默失败，第二次起正常。设置页应让用户知道这一点。

## 关于「自建 Win32 Edit 测试宿主」

这不是真实应用，而是一个几十行的 WinForms 程序（一个窗口加一个多行 TextBox），用于在不触碰用户正在使用的应用的前提下做可重复的自动化回归：鼠标事件由 `mouse_event` 注入，浮窗通过枚举窗口定位，剪贴板前后对比。它代表的是经典 Win32 Edit 控件这一类目标，结论可推广到老式对话框和记事本以外的 Win32 程序，但不能替代真实应用测试。源码不在仓库内，需要时可按 `docs/COMPATIBILITY.md` 的描述几分钟内重建。

## 测试机记录

| 日期 | 平台 | 系统版本 | Copick 版本 | 显示器 / 缩放 | 测试人 |
|---|---|---|---|---|---|
| 2026-10-17 | Windows x64 | Windows 11 Pro 10.0.26300 | 0.3.0-beta.1（打包版与开发态） | 单屏 2560×1440 / 100% | 自动化脚本，鼠标事件由 mouse_event 注入 |
| 2026-10-18 | Windows x64 | Windows 11 Pro 10.0.26300 | 0.3.0-beta.1 含 moveTop 修复 | 单屏 2560×1440 / 100% | 用户真鼠标按本表顺序测试：10 次弹窗全部复制成功，UIA 4 次、回退 6 次。第一轮 10 次弹窗按本表顺序对应 Edge、Chrome、Firefox、记事本、Word、Excel、Edge PDF、微信、飞书、资源管理器，method 序列为 1/99/99/1/1/99/99/99/1/99。随后关闭回退复测：Edge、Chrome、Firefox、记事本、Word、飞书仍弹窗（UIA）；Excel、Edge PDF、微信、资源管理器文件名无弹窗（仅回退）；VS Code、Terminal 无弹窗（策略）。两轮互相印证 |
