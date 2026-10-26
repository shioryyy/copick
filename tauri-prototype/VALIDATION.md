# Tauri 核心链路验证记录

日期：2026-10-23。环境：本机 macOS Darwin 27.0.0、Apple Silicon arm64，Rust 1.99.1，Tauri 2.12.5，CLI 2.12.4，selection-hook 2.1.1。

## 兼容复制回退默认策略（2026-10-26）

本轮改变回退策略并做了两平台验证。Windows 引擎的 `GetSelectedText` 接受 stop token，回退可在备份后、发送快捷键前和轮询中取消并恢复备份；macOS 引擎没有该参数，回退无法在事务内取消。因此：

| 平台 | 默认 | 设置页 | 配置层 |
|---|---|---|---|
| Windows | 开启 | 可关闭，说明会临时改动剪贴板 | `Config::default` 与反序列化缺省均为 true |
| macOS | 关闭 | 禁用并说明「无法在事务内取消」 | `validate()` 强制改回 false，忽略旧配置或导入的开启意图 |

Electron 版 `clipboardFallback` 会在首次启动迁移时沿用；启动项不随迁移导入。

### 自动检查

本机 macOS 与 OMEN（Windows 11 x64 build 26200）均通过 `npm test`：48 条 Node 测试、20 条 Rust 测试。新增的 Rust 测试锁定 Windows 默认开启、macOS 强制关闭，以及迁移只读取 Electron 侧的回退值。

### Windows 真机（OMEN，交互式桌面会话）

用 `src-tauri/target/release/copick-tauri-prototype.exe`（3,697,152 bytes，本轮构建）跑 `scripts/verify-windows.ps1`：

| 场景 | 次数 | 结果 | 证据 |
|---|---:|---|---|
| `fallback`（仅支持复制的自绘控件） | 6 | 全部通过 | `method=99`，`clipboardRestoredBeforeClick=true`，点击后文本正确、焦点与选区保留，守护进程 `restoredVerified` |
| 无配置文件启动 | 2 | 全部通过 | 缺省值直接落到回退，`method=99` |
| `fallback-disabled` | 1 | 通过 | 无浮窗，`copyShortcutCount=0`，剪贴板内容与序列号均未变 |
| `double` / `drag` | 各 1 | 通过 | `method=1`，默认开启回退没有抢占 UIA 路径 |

### 夹具与脚本修正

1. `verify-windows.cs` 的 `SentinelIntact()` 要求剪贴板序列号停在守护进程写入的那一版。开启回退后，产品必然备份并重写剪贴板，序列号一定前进，该断言在回退场景下不可能成立。现改为：回退场景以**文本内容**判定恢复完成（`clipboardRestoredBeforeClick`），并单独记录 `clipboardSequenceBumped`；格式完整性与最终写回仍由守护进程报告独立核验。其余场景继续使用严格判据。
2. `scripts/verify-windows.ps1` 在 `fallback` / `fallback-disabled` 前显式写入平台配置（`%APPDATA%\local.copick.tauri\config.json`），否则 Windows 默认开启后 `fallback-disabled` 失去对照意义。写入必须是无 BOM 的 UTF-8——`serde_json` 不接受 BOM，带 BOM 时会静默回落到默认值。运行结束后还原原始配置。

### 已知限制

- 回退过程中剪贴板序列号会前进；剪贴板管理器（如 Win+V）可能记录一次中间内容。私有格式、并发复制与恢复期间的进程退出仍不保证完整恢复。
- 本轮早期出现过连续两次取词在 2 秒截止内未完成（`COPICK_CAPTURE_TIMEOUT`），随后六轮连续通过，未能定位根因；与历史记录中「Windows fallback 曾首次失败、复跑 `method=99` 通过」的偶发一致，暂不改动超时。
- 只验证了自绘 WinForms 控件这一条回退路径；Excel、PDF 阅读器、微信、资源管理器等真实应用仍待兼容矩阵复测。
- macOS 回退保持关闭，本轮没有新增 macOS 端回退验证。

## v0.1.0 产品化验收（2026-10-26）

本轮针对完整产品行为（单实例、托盘、设置页、配置持久化、关闭常驻、开机启动、退出）在最终源码上重新 build 和 package。Windows 环境为 OMEN Windows 11 x64 build 26200、2560×1440、150% 缩放、已登录 console Session 2；所有桌面交互经普通权限 Interactive 计划任务执行，未绕过锁屏或权限。

最终产物（同一份源码，两平台分别构建）：

| 产物 | 字节 | SHA-256 |
|---|---:|---|
| `Copick-Tauri-0.1.0-mac-arm64.zip` | 1,573,387 | `e26146d5d7a853301201a28d9ae907e3a78972e23c5527b666d2312f7dc87281` |
| `Copick-Tauri-0.1.0-win-x64.zip` | 1,544,621 | `df3044c5441269023ac0554193b9c6d0f4731db1d3b736328b1feb4be6a0f586` |
| `Copick-Tauri-Setup-0.1.0-win-x64.exe` | 1,309,840 | `c8140375fa70cc28b9f3ebfa1e982de79c4e174a4272b6946ae5eb07a3e8ee01` |

Windows 便携包内 `copick-tauri-prototype.exe` 为 3,698,688 bytes。两平台均未签名（macOS 仅 ad-hoc、未公证）。

### macOS 真实桌面

- 最终构建直接运行，`two-round` 真实鼠标交互通过：两轮分别点击浮窗完成复制，隐藏/清除旧标签，`selectionLength=15`，`focusAfterClick`、`selectionPreserved`、`clipboardMatches` 均为 true，`hiddenBetweenRounds=true`，guardian `restoredVerified`。报告：`artifacts/acceptance-20261026-two-round/verification.json`（`passed=true`）。
- 最终构建的设置页快照已保存并查看，与上一构建的渲染逐字节一致（PNG SHA-256 `506570ed140648da1e8fd01d70b1e06996be00f7e4a10a52caddda882583f99e`）。设置页此前实机验证过：暂停跨退出重启保留、排除项保存后重启回读、关闭窗口后进程常驻、重复启动唤回窗口、「退出 Copick」真实退出。本轮最终改动只涉及窗口尺寸适配与 Windows 专用文案，不影响上述路径。

### Windows 交互桌面（最终便携包）

把最终 ZIP 解压到 `C:\Users\shiory\CopickTauriVerify`，直接运行解压后的 EXE，用 UIA 定位窗口、Win32 鼠标事件与键盘输入驱动真实设置页。下表各项断言全部通过（后台启动与单实例为单独一轮）：
| 检查 | 结果 |
|---|---|
| 解压后 EXE 存在并启动 | PASS |
| 窗口完整落在屏幕内 | PASS（top=266，height=1136，screen=1440） |
| 点击「暂停监听」后配置写入 `paused=true` | PASS |
| 勾选「开机启动」写入 HKCU Run 精确命令 `"…\copick-tauri-prototype.exe" --background` | PASS |
| 取消勾选后启动项删除 | PASS |
| 文本框输入并保存排除项，配置写入 `notepad.exe` | PASS |
| 点击关闭按钮后进程仍存活（关闭到托盘） | PASS |
| 再次启动唤回已有实例，配置在重启后保留 | PASS |
| `--background` 启动时进程存活且设置窗口隐藏 | PASS |
| 随后普通启动显示已存在实例的窗口，第二个进程自行退出 | PASS |

另以同一构建单独验证「退出 Copick」按钮：进程退出码 0。截图与日志归档在 `artifacts/windows-settings-20261026/`（本机忽略目录）；测试后已删除测试期间新建的配置目录、HKCU Run 值、便携解压目录与 WebView2 缓存，未遗留进程或计划任务。

最终构建（`target/release` 中的 EXE，3,698,688 bytes）另跑了一次真实桌面 `double` 场景：fixture 双击选词、真实鼠标输入、产品浮窗渲染与点击复制全部通过，`passed=true`、`method=1`、`testClipboardRestored=true`、`clipboardGuardianVerified=true`，剪贴板时间线显示点击前为 sentinel、复制后为目标文本，guardian `restoredVerified`（backupSequence 4996 → restoreEndingSequence 5011）。报告与浮窗截图归档在 `artifacts/windows-double-20261026/`。

### Windows NSIS 安装与卸载

在同一台机器上用 `/S` 静默安装最终 NSIS 包：安装器退出码 0，按当前用户安装到 `%LOCALAPPDATA%\Copick Tauri`，包含 `copick-tauri-prototype.exe`（与便携包同尺寸 3,698,688 bytes）、`NOTICE-selection-hook.txt` 和 `uninstall.exe`，并写入 HKCU 卸载项。从安装目录启动应用，设置页正常显示，开机启动开关可用；勾选后 HKCU Run 精确写入 `"C:\Users\shiory\AppData\Local\Copick Tauri\copick-tauri-prototype.exe" --background`，取消后删除。随后执行 `uninstall.exe /S`：退出码 0，安装目录与卸载注册表项均被删除，Run 值与配置目录无残留。该轮系统处于深色主题，设置页深色样式渲染正常（截图 `artifacts/windows-settings-20261026/10-installed.png`）。

限制：本机已安装 WebView2，未覆盖缺少运行时的引导下载；未测试交互式安装界面、覆盖升级、SmartScreen/组织策略拦截，也未测试登录后由系统实际拉起 `--background` 项（仅验证了登记命令与手动 `--background` 启动行为）。

### 本轮发现并修复

1. 设置窗口默认高 720 逻辑像素，在 1080p、150% 缩放（逻辑高度 720）的屏幕上会超出屏幕底部，导致保存/退出按钮不可达。现在启动时按显示器逻辑尺寸的 90% 收缩并居中；该逻辑有纯函数单测（1440p 不触发收缩，1080p@150% 收缩到 648）。OMEN 1440p 实测未触发收缩，窗口完整可见。
2. Windows 排除列表此前沿用 macOS 文案与占位符 `com.apple.Terminal`。现在 Windows 显示进程名示例 `notepad.exe` 与「程序名（进程名）」说明。

### 自动检查

最终源码通过 `npm test`：47 条 Node 测试、19 条 Rust 测试，以及 Tauri `check`；两平台 build、`package` 的真实二进制 `--smoke-test` 均返回 `ok=true`。

### 仍未验证

NSIS 覆盖升级、缺少 WebView2 时的引导下载、交互式安装界面与 SmartScreen 行为、Windows ARM64、代码签名与公证、第三方应用兼容矩阵、多显示器与混合缩放。`.github/workflows/tauri.yml` 的 macOS/Windows 作业尚未在真实 GitHub Actions 运行（本机与 OMEN 手动执行了相同命令）。自动剪贴板回退保持关闭；本轮验证的是显式点击浮窗的复制路径。以上均不因本轮结果而视为已验收。


## 解锁后最终 macOS 验收（2026-10-25）

本轮直接运行最终 release `.app`，SHA-256 为 `000cae806139a8abb61cbca96fab23fefef1d989d839ff909bbae01256b1fde9`，与前次锁屏前最终构建一致；本轮只调整测试驱动，没有改产品源码。桌面预检确认为未锁定，实际辅助功能监听可用。

| 验收范围 | 结果与证据 |
|---|---|
| 十项核心桌面场景 | double、drag、samepid-switch、switch、expiry、other-click、fallback-disabled、document-switch、document-copy、two-round 全部取得通过报告；每份核验退出码、scenario、本次 PID 和 guardian 恢复 |
| 来源与复制 | 双击/拖选精确 15 字符，焦点/选区保留；同窗口换文档后隐藏，立即点旧浮窗也不写旧正文；回退关闭时 copyShortcutCount=0 |
| 两轮实际 Tauri 复用 | AX 确认第一轮“已复制”、原生中间隐藏、第二轮清除旧反馈并复制不同词；已改为浮窗中心命中查询，避免遍历整个 AX 树错过 650ms 反馈 |
| slow-provider control / exit | 暂停恢复 1,516ms、退出 571ms；均早于六秒 provider 返回，无迟到浮窗或写入，恢复通过 |
| hung-provider control / exit | 暂停恢复 1,027ms、退出 411ms；等待时超时文案、忙碌拒绝/重启提示均通过；busy-probe 不改剪贴板，原 provider 释放后再次 double 通过 |
| copy-provider control / exit | 真实浮窗点击后原生 copy 已接受。预解析真实按钮的 AXPressAction 返回分别约 1.560ms / 39.656ms；前者日志确认 cancel outcome=1，后者另核验原 PID 已退出。该耗时仅为 AX action 返回，不是全程交互/系统延迟指标；释放后无迟到成功或写入 |
| guardian 八项 | confirmed-sentinel-kill、external-write-kill、same-text-rewrite-kill、unclaimed-copy-kill、ready-ack-disconnect、claim-ack-disconnect、sigint-owner-kill、sigterm-owner-kill 全通过；逐场核验 guardian PID、正常退出及预期退出码/状态；外部写与不确定版本保留，外层只条件清理自己写的对抗数据 |
| 异常清理两项 | 外层暂停无备份 busy-probe，确认 runner 外部 20 秒截止生效；在 busy-probe 启动后将 provider-finish 建为目录，确认 finally 的 EISDIR 故障。runner 两项均按预期退出 1，外层另行等待 guardian 报告、确认恢复；不宣称普通 runner 自己已等待 guardian |
| 独立 native harness | 真实系统剪贴板共享 gate 五个强制顺序、native show-failure、WKWebView snapshot 对比均通过；产品 popup 与 first-frame harness 截图已查看。show fixture 改为有实际文本内容的窗口后进入 WindowServer 来源列表 |
| 自动检查 | Tauri 18 条 Node/C++、8 条 Rust 与 check 全通过；前次 Electron check＋56 测试通过，本轮没有修改 Electron |

原始失败也保留：首次两轮场景被提前启动的下一项 GUI 验证干扰；独占重跑又暴露 AX 全树遍历错过短反馈的问题，改为控件命中后通过。copy control 初版启动脚本晚于 300ms AX 查询失败，未获得 pending cancel；预先解析真实按钮后获得 outcome=1。show 空窗口两次未进入 WindowServer 列表，增加实际内容后通过。一次 marker 对抗测试先被超时文案失败截断，不计作准确故障命中；另一次检测外部剪贴板变化，guardian 报 skippedExternalChange，保留现场且不算恢复通过，独占复跑最终准确命中 EISDIR 并恢复。

归档在 `artifacts/stage1-acceptance-20261025/`，含通过/失败报告、原始 runner 日志、截图和 manifest；manifest 列出可计数的通过报告及产品/驱动指纹。所有本轮产品进程均通过关闭控制窗正常退出 0，没有遗留 fixture/guardian/action 进程。

**结论：本轮 macOS 核心链路与测试恢复场景验收通过。**剩余边界：完整产品提交后的各指令竞态尚未全部强制调度（当前由共享 gate harness 覆盖）；真正 compositor scanout 首帧未直接测量。AX 不暴露 document、相同 URL 内容变化及跨进程最终检查到写入之间仍无原子保证。guardian 自身 SIGKILL/重启/系统 IPC 永久挂住不承诺恢复，日志＋文本＋changeCount 也不证明 writer 身份。自动回退继续关闭，不能切换默认发行。

## Windows 独立剪贴板守护进程（2026-10-25）

此前 Windows fixture 在自身进程内备份用户剪贴板：fixture 被 runner 25 秒超时强杀时备份随之丢失，正常恢复也缺少外部版本所有权核验。本轮改为独立守护进程持有唯一备份，并在 OMEN（Windows 11 x64 build 26200，用户 shiory，Session 2 交互桌面）通过 Interactive 计划任务实测。

| 场景 | 守护进程结果 | 验证内容 |
|---|---|---|
| finish-restored | `restoredVerified` | 正常 finish 后自行恢复，退出码 0 |
| owner-killed | `restoredVerified` | fixture 被强杀（命令管道 EOF）后备份仍在守护进程内存中 |
| external-write-killed | `skippedExternalChange` | 外部写入不被覆盖，保留现场，退出码 1 |
| same-text-unclaimed-killed | `indeterminate` | 外部写入与产品完全同文本，靠所有者 PID 判为未归属 |
| verified-copy-killed | `restoredVerified` | 错误 PID、缺产品确认、错误文本三项各自单独被拒后，正确声明被接受 |
| claim-ack-disconnect | `restoredVerified` | ACK 无人接收后版本归属仍成立，恢复完成 |

六项全部通过，`failures=0`，最终 `testClipboardRestored=true`，备份格式 4 项。恢复的版本核验在**同一次 `OpenClipboard` 锁内**完成：读取全部格式、比较所有者 PID、写入备份、读回核验，因此其他进程无法在校验与写入之间插入。

### 所有者必须泵消息（同日发现并修复）

把守护进程接入完整产品路径后，double 场景稳定失败：产品日志出现 `COPICK_COPY_TIMEOUT request=2 ms=2000`、紧接着 `COPICK_COPY_CANCEL outcome=2`（已提交，无法撤销）与 `COPICK_COPY_LATE reason=no_flight`，剪贴板停在产品文本上而归属未获确认。

用独立探针（`owner` / `clear` 两个进程）在同一台机器上做对照实测，确认根因：

| 所有者进程 | `OpenClipboard` | `EmptyClipboard` | 合计 |
|---|---|---|---|
| 不泵消息（阻塞等待） | 0ms | **5001ms** | 5002ms |
| 持续泵消息 | 0ms | **13ms** | 13ms |

守护进程持有 sentinel 的剪贴板所有权，却阻塞在读命名管道上，从不处理 `WM_DESTROYCLIPBOARD`，于是系统只能等约 5 秒的通知超时；产品的 `EmptyClipboard` 因此超过它自己的 2 秒截止时间。修复方式：管道读取移到后台线程，守护进程主线程持续 `PeekMessage`/`DispatchMessage`，**所有剪贴板调用仍然只发生在创建所有者窗口的那个线程上**（`OpenClipboard` 的所有者只在该线程第一次打开时确定）。

修复后 double 的复制在 1387ms 内完成并获确认，`claimed=true`、`outcome=restoredVerified`、退出码 0。新增回归测试锁住该结构（必须存在消息泵、命令读取必须在后台线程、主循环不得用阻塞读取），并已验证在改回阻塞读取时会失败。

### 十项产品场景串行回归（同一构建）

修复后在 OMEN 交互桌面经 Interactive 计划任务串行运行十项，全部 `passed=true`、`testClipboardRestored=true`、`clipboardGuardianVerified=true`：

| 场景 | method | 结果 |
|---|---|---|
| double | 1 | 真实鼠标点击复制完成 |
| drag | 1 | 真实鼠标点击复制完成 |
| samepid-switch | 1 | 选区失效验证 |
| switch | 1 | 选区失效验证 |
| expiry | 1 | 选区失效验证 |
| fallback-disabled | — | 回退关闭，无快捷键副作用 |
| background-drag | 1 | 真实鼠标点击复制完成 |
| slow-control | — | 真实 WM_GETOBJECT provider-dispatch 等待；拒绝迟到结果 |
| slow-exit | — | 真实 WM_GETOBJECT provider-dispatch 等待；拒绝迟到结果 |
| blocked-exit | — | 真实 WM_GETOBJECT provider-dispatch 等待；拒绝迟到结果 |

每次运行都记录了剪贴板时间线（序列号 + 内容摘要，不存正文），可核对点击前是 sentinel、结束后是用户原始内容。守护进程实现改动后，六场景对抗验收也已重跑，仍为 `failures=0`、`testClipboardRestored=true`。

本轮实测推翻了几条原本写进设计的假设，均已在实现注释中记录：

- 一次写入让 `GetClipboardSequenceNumber` 前进约 5 次（`EmptyClipboard` +1、`SetClipboardData` +1、`CloseClipboard` +3）。任何"序列号恰好 +1"或"序列号相等"的判据在本平台恒为假，已全部移除。
- 写入 `CF_UNICODETEXT` 后系统会按需合成 `CF_TEXT`/`CF_OEMTEXT`/`CF_LOCALE`，"格式数恰好为 1"必然失败。
- `GlobalAlloc` 块大小向上对齐，读回长度可能大于请求长度，文本必须按 UTF-16 解码到 NUL 比较。
- 守护进程一旦自己开关过剪贴板，`GetClipboardOwner` 就指向它自己；所有者 PID 因此只用于 claim 时的一次性归属判定，后续漂移检测只看文本内容。
- SSH 是 Session 0，那里的剪贴板不是用户的。harness 已加 Session 0 预检并直接拒绝；所有结果都必须经 Interactive 计划任务取得。

归档在 `artifacts/stage1-windows-guardian-20261025/`，含 `manifest.json`、完整运行日志与六份场景报告。**仍未关闭**：守护进程自身被强杀或重启、某进程永久占住剪贴板锁、不可备份格式（GDI/owner-display/图元文件/私有）场景；本 harness 直接写入测试文本，不经过完整产品复制入口。

## 第一阶段后续修复与证据边界（2026-10-24）

- 同窗口文档变化已先红后绿：旧构建的 `document-switch-before` 在 PID/窗口不变、文档身份改变后 800ms 仍显示旧浮窗；修复后 `document-switch-after` 隐藏。bridge 在单个串行 executor 上异步核验 AX document，最短间隔 200ms、最多一个后台检查，以来源 revision 隔离迟到结果；UI 线程不等待 AX。`document-copy` 真实点击文档变化后的旧浮窗也拒绝写入。
- 显式复制的最后 AX 查询移到 `TryCommit` 前。`copy-provider` 经真实浮窗点击，日志确认原生 copy 已接受；暂停在 306ms 返回且 `COPICK_COPY_CANCEL outcome=1`，外部释放 provider 后 sentinel 未变、没有迟到成功。等待期间退出在 330ms 完成，provider 尚未释放。此场景可能阻塞在同一 executor 上先行的后台文档检查，证明已接受的复制在查询等待/排队期间可取消，不声称强制暂停在完整产品每一个提交指令位置。提交后五种顺序仍由独立共享 gate harness 覆盖。
- macOS `present` 增加隐藏状态下 `afterScreenUpdates=YES` 的异步 WebKit snapshot 准备，完成后重新校验 generation、token、期限、权限和来源才显示。单槽位、两秒等待上限，失败保持隐藏。真实 Tauri 两轮不同词验证通过：第一轮 AX 确认“已复制”，中间原生隐藏，第二轮清除旧状态并精确复制，焦点和选区保留。产品 snapshot 已查看；这仍不是 compositor scanout 首帧测量。
- 含绘制准备的构建完成十项串行桌面回归：double、drag、samepid-switch、switch、expiry、other-click、fallback-disabled、document-switch、document-copy、two-round；全部 fixture 退出 0、PID/scenario 匹配、恢复通过。slow-provider 暂停/恢复 1,081ms，通过。随后 hung 控制页超时文案断言失败（日志实际已记录取词超时）；驱动改为有界等待页面一秒轮询刷新，此改动尚未复验。
- 新增独立内存剪贴板 guardian，fixture 不再独占备份。实际通过四个强杀场景：已确认 sentinel 后 kill owner 可逐格式恢复；外部新内容、相同文本重写、未确认复制后 kill 均保留当前版本。报告区分 `restoredVerified`、`skippedExternalChange`、`indeterminate`、`restoreFailed`、`untouched`；拒绝恢复不得写 `testClipboardRestored=true`。随后审查又收紧成功复制日志确认、nil 备份拒绝、断管/SIGPIPE 和终端信号、恢复报告 PID/退出码校验；最终驱动已编译，但这些后续收紧未完成真实重跑。初始化清空/写入未完整确认时保守报告 indeterminate，不承诺恢复。备份和格式数据不落盘。
- macOS changeCount＋文本＋产品成功日志仍不能证明 writer 身份，最后核验与恢复也无 CAS；恢复验证仅适用于无外部并发写入的专用测试会话。fixture 与 guardian 同时被 SIGKILL、系统重启、IPC 永久挂住不能靠内存备份恢复。Windows fixture 尚未接入独立 guardian。
- provider runner 已补 busy-probe 的外部截止时间和 marker 写入失败清理。marker 无法写入时终止 fixture，只会通过管道 EOF 触发独立 guardian 尝试条件恢复；runner 此时不等待或确认 guardian 恢复，输出目录不可写也可能导致恢复报告无法保存。这条降级路径必须报告失败，不能计为剪贴板已恢复；尚待真实验证。
- 一次未加 guardian 的 expiry 回归检测到 sentinel 变化且失败，产品日志无复制请求；原因未确认，不能计为通过。之后带 guardian 的 expiry 通过。失败记录同样保留。

归档：`artifacts/stage1-followup-20261024/`，含修复前失败、本轮通过和失败报告、产品 snapshot/日志与 manifest。最后构建另补了绘制准备失败/超时清理与提示，SHA-256 为 `000cae806139a8abb61cbca96fab23fefef1d989d839ff909bbae01256b1fde9`；该最终构建通过 build、check、18 条 Node/C++ 与 8 条 Rust 测试，**尚未实际 GUI 复验**。Electron check＋56 测试通过。

后续验证期间系统锁屏（`IOConsoleLocked=true`），已停止 GUI 输入并清理本次原型；驱动新增锁屏预检，已验证在启动 fixture、改写剪贴板前拒绝。剩余：最终构建/驱动的十项回归、slow/hung/copy 控制与退出、guardian 最终信号/归属分支复验；Windows 独立恢复策略；完整产品更细的提交竞态及真实 compositor 首帧证据。第一阶段尚未完整验收，自动回退仍关闭。

## 授权后 macOS 产品链路复验（2026-10-24）

用户在系统设置授予辅助功能权限后，直接运行已有 release `.app`，控制页确认“原生监听运行中”。本次没有重建或修改产品代码，以下结果替代下节所述的 macOS 权限阻挡状态。全部验证串行执行，runner 核验本次 fixture PID、场景和退出码。

- 七项普通场景全部通过：double、drag、samepid-switch、switch、expiry、other-click、fallback-disabled。double/drag 精确复制 15 字符，源焦点与选区保留；原生日志确认 `method=11` 和展示成功回执。同 PID 切窗保持进程身份、改变实际 key window 后浮窗隐藏；所有失效场景 sentinel 不变，回退关闭时复制快捷键调用数为 0。
- 六秒慢 AX 等待期间，暂停/恢复耗时 1,069ms，正常退出耗时 459ms，均发生在 provider 返回前；返回后无迟到浮窗、sentinel 不变。
- 持续等待 AX 仅由外部 release marker 释放。产品在等待期间报告取词超时，暂停/恢复耗时 968ms；独立响应正常的来源请求被拒绝，并显示服务仍忙及重启提示。正常退出耗时 283ms，完成时 provider 尚未返回、release marker 尚未创建。fixture 由 runner 的 finally 释放，退出后无迟到浮窗或误写。
- 持续等待 provider 释放后，再次 double 精确复制通过，确认原串行 worker 可恢复接受请求。未宣称能强制终止任意 AX provider。
- 七项普通场景、一次释放后 double 和四项 provider 交互共 12 份主报告全部 `passed=true`，各 fixture 与额外 busy-probe 均 `testClipboardRestored=true`。产品 WKWebView snapshot 已保存并查看，按钮正常。两次测试应用均正常退出，未遗留原型或 fixture 进程。

归档：`artifacts/stage1-macos-authorized-20261024/`，包含全部报告、原生日志、popup.png 和 manifest.json。实测可执行文件 SHA-256：`b78442c7bc6d2e7d15c30d6e671d6dec86632f5d613561ebc6340d037a719c33`。manifest 同时记录本次源码及驱动文件指纹；这不是可复现构建证明。

第一阶段剩余门槛：同窗口文档变化的身份覆盖与竞态边界、完整产品复制路径的强制竞态调度验证、Tauri 实际窗口的 compositor 首帧，以及 fixture 被外部强杀后的剪贴板恢复策略。辅助功能授权和上述 macOS 产品回归已不再阻挡；独立 gate/snapshot harness 不能替代这些剩余验收。自动回退继续关闭，尚不能切换默认发行。

## 异步版实现与前次验证（2026-10-23）

本节保留 2026-10-23 的实现与验证记录，其中 macOS 权限阻挡已由上节 2026-10-24 的实测解除。下文标注为“历史基线”的结果来自异步改造之前，不应作为当前版本验收结论。

- capture/copy 改为 request 自有内存＋异步完成回调，Rust 使用 request ID、generation、两秒截止时间和 UUID token。主线程不等待取词/复制完成；Windows worker/hook 初始化仍存在有界同步等待。
- 有界输入队列增加 epoch 与 500ms 年龄限制，暂停/溢出会拒绝旧事件；completion overflow 会使当前状态失效。展示只在原生 show 成功且来源仍匹配时确认，复制等待最终完成回执。
- 控制页实测发现 `tauri://localhost` 的空 path 被来源白名单误拒绝，导致状态/暂停不可用；新增 Rust 回归先失败后修复，只对 control 接受合法本地首页空路径，其他页面、来源和窗口仍拒绝。修复后实际点击暂停/恢复，状态依次为运行中→已暂停→运行中；恢复后 double 精确复制通过，关闭控制窗口后进程退出码为 0、没有原型/fixture 残留。此验证未模拟慢 provider。
- `npm --prefix tauri-prototype test`：7 条 JS popup、9 条验证报告回归、1 条实际编译 C++ 来源 helper、1 条 operation gate 并发回归和 8 条 Rust 生命周期/来源/队列测试通过。此前 popup、报告和控制页来源测试都在修复前复现失败；gate 回归使用同一产品 helper 竞争取消和提交 2,000 次。另有 macOS 独立 harness 在真实系统剪贴板强制五个顺序通过，不经过完整产品 AX/copy 路径。
- macOS 前一轮 release `.app` 六项桌面回归已通过；本轮新增窗口绑定/提交边界后的构建也成功，但辅助功能权限阻挡了新产品链路复验。前一轮驱动先确认测试窗口位于前台，再发送真实鼠标输入；double、drag、expiry、switch、other-click、fallback-disabled 六场景通过。double/drag 使用 `method=11`，精确复制 15 字符且源焦点和选区保留；expiry/switch 隐藏浮窗、sentinel 未变，switch 额外确认前台确已变化；fallback-disabled 的复制快捷键调用数为 0。WKWebView snapshot 已保存并查看，按钮正常。
- 新增 other-click 回归在旧构建上确认中键点击后浮窗仍可见；补齐 `kCGEventOtherMouseDown/Up` 订阅后通过。最终构建的五项交互报告在 `artifacts/async-mac-final-<场景>/verification.json`，回退关闭报告在 `artifacts/async-mac-fallback-disabled/verification.json`，截图为 `artifacts/async-mac-fixed-popup.png`。中键实测通过不等于侧键硬件兼容性已验证。
- 两平台验证驱动在启动前删除旧报告，要求 fixture 退出码为 0，报告场景和 sourcePid 必须属于本次运行；缺失、崩溃和旧报告不会误计通过。macOS 增加 18 秒进程内 watchdog，常规超时会先恢复剪贴板；备份中任一格式无法读取或 changeCount 变化则在写 sentinel 前停止。六项最终报告均确认 `testClipboardRestored=true`；若进程彻底挂死或被外部强杀，仍不能保证恢复。Windows 新 runner 已在冻结源码的十项场景中真实执行，逐场景验证 fixture 退出与报告来源，不能追溯性提升此前旧记录的证据强度。
- native show failure 独立 harness 已真实通过：正常 NSPanel 展示后切换 replacement window 并隐藏原 source，`sourceInvalidated`、`invalidSourceShowRejected` 和 `popupHiddenAfterFailure` 均为 true；missing panel/source、NaN 坐标也拒绝，`clipboardTouched=false`。最终报告位于 `artifacts/native-show-failure-current/verification.json`。
- popup first-frame 独立 harness 加载真实 popup HTML/JS 和 WKWebView，以 mock Tauri `invoke` 产生“已复制”旧态，然后隐藏、换 token、立即调用原生显示并 `takeSnapshot`。本机通过：第一次新帧 PNG SHA-256 与“复制”准备态和 250ms 后稳定态相同，且不同于“已复制”态；报告在 `artifacts/stage1-first-frame-current/verification.json`，图片已查看。它验证该 WKWebView fixture 的 reset/show/snapshot 排序，不声称捕获真实 compositor scanout，也未覆盖完整 Tauri window 重置路径的所有时序。
- 新增真实系统剪贴板 gate harness 使用同一 `OperationGate`，以 barrier 强制 5 个顺序：提交前取消（剪贴板不变）；提交后、清空后、完成后取消（都返回不可撤销且实际写入成功）；以及清空后注入失败（剪贴板为空、返回不确定状态 2）。本机五项通过，changeCount 对每个真实 write 变化核验为 1；测试前唯一声明格式已逐格式数据备份并恢复，`testClipboardRestored=true`；不是对完整产品 AX/copy 入口或 OS 级写入失败的模拟。报告位于 `artifacts/stage1-copy-gate-current/verification.json`。
- 前一轮 macOS 六秒慢 AX provider 已实测通过：独立 `SlowTextView` 在选区属性请求中阻塞六秒，进入/返回标记确认交互发生在等待期间。持久驱动 `verify-macos-provider.cjs control` 在 1,478ms 完成暂停/恢复，`exit` 在 425ms 关闭原型并确认进程消失，均早于 provider 返回；迟到结果无浮窗、sentinel 未变，fixture 恢复成功。另一次等待后 double 精确复制通过，说明 provider 返回后新请求可恢复。报告位于 `artifacts/slow-provider-control-1792763635521/`、`slow-provider-exit-1792763656311/` 和 `async-mac-after-slow-double/`；日志确认 `COPICK_CAPTURE_TIMEOUT`。该场景为有限六秒延迟，不能推导永久挂起或 Windows UIA 已验收。
- 显式复制新增共享 `OperationGate`：Pending 取消获胜则禁止提交；提交先获胜则取消返回不可撤销，callback 区分未写入失败/成功/提交后不确定，Rust 和 popup 对不确定结果要求检查剪贴板、禁止盲目重试。Mac 的 AX/pasteboard IPC 均在 worker，主线程只做短授权；Windows 在 EmptyClipboard 前竞争 gate。主线程命令调度也增加独立截止时间/取消 gate，超时且尚未开始的闭包不会迟到执行。已开始的操作不假报为无副作用取消。
- macOS 增加 WindowServer window ID 绑定和 worker 内 AX focused-window/document 比对，停止监听时清理 retained 来源对象；有文档属性的 provider 在取词前后及复制临近写入检查。窗口轮询不查询 AX，避免慢 provider 阻塞 UI。本轮新 release 构建通过，但产品 app 显示缺少辅助功能权限，samepid-switch 和 hung-provider fixture 已编译、暂未获得有效产品链路验收。未绕过 TCC 或自动授权。窗口内文档变更与剪贴板提交不具备系统原子性；未暴露 document 属性的应用仍只能做到窗口级来源限制，不能宣称所有文档绑定完整。
- Windows 最终 release EXE 构建通过，Rust/bridge/gate/popup/control 的本机与 OMEN SHA-256 一致。十项场景在固定源码上串行运行，每个独立 Interactive 任务，fixture 退出码、报告 PID、场景和恢复断言均核验，runner 总退出码为 0。

| 当前 Windows 场景 | 结果 | 关键断言 |
|---|---|---|
| double | 通过 | `method=1`；原生展示回执；真实点击后精确文本、源焦点和选区保留 |
| drag | 通过 | `method=1`；完整选区与上述点击断言 |
| expiry | 通过 | 七秒后隐藏、sentinel 未改变 |
| switch | 通过 | 跨应用前台确已变化、浮窗隐藏、sentinel 未改变 |
| samepid-switch | 通过 | 前台 HWND 变化且 PID 相同、浮窗隐藏、sentinel 未改变 |
| fallback-disabled | 通过 | 控件不出现浮窗，sentinel、焦点和选区保留，copyShortcutCount=0 |
| background-drag | 通过 | 独立进程 A 前台、命中后台 B、仅一组 down/up，B 激活且选区 15 字符，UIA 复制精确并保留焦点/选区 |
| slow-control | 通过 | WM_GETOBJECT provider dispatch 等待六秒期间确认暂停/恢复，完成早于 provider 返回，迟到无浮窗/sentinel 不变 |
| slow-exit | 通过 | provider 返回前应用退出，迟到无浮窗、剪贴板恢复 |
| blocked-exit | 通过 | provider 不按固定时间返回，仅外部 release marker 释放，退出发生在释放前，剪贴板恢复 |

Windows 后台窗口首次拖选来源修复使用 down 命中的 root HWND/PID，up 沿用同一来源，arm 允许有效但尚未激活的窗口；capture、展示、copy 仍要求当前前台匹配。持久 helper 回归已在 macOS clang++ 和 OMEN MSVC 通过。此前 WinForms OLE `SetText` 报错和 RichEdit 首次激活消费选区输入阻挡了验证；新 fixture 改用显式 HWND owner 的有界 Win32 剪贴板备份/写入/恢复，遇到无法保真的句柄格式会在 sentinel 前停止，RichEdit 明确允许首次点击激活。最终 background-drag 在独立 A 进程与 B fixture 上通过完整身份/手势/选区/复制断言，不以程序化设置选区代替拖选。每个 Windows 场景备份的四种格式均恢复并逐字节核验。

最终 EXE 为 3,318,272 bytes，SHA-256 为 `EDB5280CE1E57709874FF71893F7AEB516D7ECA8C1B13AFEFF42AADFB60AFE63`。十项 JSON 在 OMEN `artifacts/windows-<场景>/verification.json`，本机归档为 `artifacts/stage1-omen-20261023/windows-<场景>/`。慢/挂起三项验证的是 UIA/MSAA 实际进入 `WM_GETOBJECT` provider dispatch 时的阻塞，不是自定义 TextPattern.GetSelection 无响应，也不能宣称能强制终止任意 COM provider。

**兼容性退让：两平台自动剪贴板回退当前都禁用，显式点击浮窗复制仍保留。**改造中 Windows fallback 曾首次失败、复跑 `method=99` 通过；该偶发问题未查明根因。随后审查发现上游 macOS 回退不支持事务内取消，Windows 回退未绑定执行时前台来源，两平台恢复均缺少外部写入所有权保证，因此不能继续把旧回退标记为当前安全可用。没有修改 `node_modules`，bridge 强制关闭且控制页说明原因。完整剪贴板事务留待独立修复和验收。

本轮未完成的第一阶段门槛：macOS 新窗口/文档绑定后的 double/drag/samepid-switch、慢与持续等待 provider 的产品链路复验（当前 TCC 权限阻挡）；同窗口文档切换的可观察身份覆盖与竞态边界；完整产品复制路径的强制竞态调度验证，以及 fixture 被外部强杀后的剪贴板恢复策略。共享提交 gate 已在真实系统剪贴板上完成五个强制顺序，但独立 harness 不经过产品 AX/copy 入口，不能替代端到端并发验收。首帧 harness 验证了 WKWebView snapshot 的新状态显示，但 Tauri 实际窗口的 compositor 首帧仍待验证。native show failure 已通过独立真实 NSPanel harness；Windows 十项已在当前冻结源码通过。原生取消不保证强制中止 provider；一个被挂住的 worker 会拒绝后续工作并提示重启，不会无限重建线程。提交闸门已定义取消和不可撤销写入的先后语义，但不构成跨进程系统原子事务。本阶段仍未完整验收，不能切换默认发行。

## 历史基线：macOS（异步改造前）

macOS 上的“选词 → 浮窗 → 点击复制”已在开发版和最终 release `.app` 中实际运行。测试使用独立 AppKit NSTextView、真实 CGEvent 鼠标输入以及系统剪贴板，没有注入虚构选区或绕过前台身份校验。

| 场景 | 最终发布包结果 | 检查内容 |
|---|---|---|
| 双击选词，AX 取词 | 通过 | `method=11`；浮窗出现；真实点击后剪贴板等于预期；源 PID 与选区保留 |
| 鼠标拖选，AX 取词 | 通过 | 同上，15 字符完整选区 |
| 七秒超时 | 通过 | 浮窗隐藏；剪贴板 sentinel 未改变 |
| 切换前台应用 | 通过 | 浮窗隐藏；剪贴板 sentinel 未改变 |
| 关闭 AX 选区暴露，开启兼容回退 | 通过 | `method=99`；Cmd+C 后恢复 sentinel；真实点击后写入预期；源 PID 与选区保留 |
| 关闭 AX 选区暴露，保持回退关闭 | 未出现浮窗，符合配置 | 这是回退测试的对照，不能计作 AX 支持 |
| 浮窗实际渲染 | 通过 | WKWebView `takeSnapshot` 保存并查看，按钮正常显示 |
| JS 语法、Cargo check、release 打包 | 通过 | 原生 engine、bridge 与 Rust 主程序均可编译链接 |

最终报告在本机忽略目录 `artifacts/release-double/`、`release-drag/`、`release-expiry/`、`release-switch/`、`release-fallback-enabled/` 的 `verification.json`，截图是 `artifacts/release-popup.png`。可用 README 的命令重跑。

权限状态为本次运行环境中已授权。没有修改系统 TCC 数据库、自动授予权限或验证全新用户首次授权。

## 实测体积

最终产物：`src-tauri/target/release/bundle/macos/Copick Tauri Prototype.app`。`otool -L` 确认依赖系统 WebKit／AppKit 等 framework，不携带 Node、Chromium 或 Node sidecar。

| 口径 | Tauri 原型 | 已有 Electron 0.3.0-beta.1 基线 |
|---|---:|---:|
| 解包 `.app` 磁盘占用（`du -sk`） | 3,400 KiB，约 3.32 MiB | 约 292.09 MiB |
| ZIP 文件字节数 | 1,371,668 bytes，约 1.31 MiB | 约 123.89 MiB |

原型包含控制页、浮窗、AX／兼容取词与复制、权限状态、暂停和临时凭证；尚未包含完整设置、托盘、开机启动、用户配置和诊断持久化。上述 macOS 体积测量早于 Windows 接入；Windows EXE 的单独口径见下文。此对比证明运行时减重空间，不是完整产品功能相同的性能对照。

压缩产物在 `artifacts/Copick-Tauri-Prototype-macos-arm64.zip`。未作 Developer ID 签名和公证。

没有给出正式的内存和 CPU 优劣结论：macOS WebKit 会启动独立 WebContent／GPU／Networking XPC 进程，只统计主进程 RSS 会低估开销；现有交互取样也不能替代相同工作负载、相同功能和持续时长的对照测量。

## 历史基线中发现并处理的问题

1. 隐藏的 WKWebView 未完成定时器／rAF 准备确认，最初收到选区后不出现浮窗。改为原生执行固定页面函数，重置按钮后由页面确认显示。
2. 普通 Tauri NSWindow 即使设置 NonactivatingPanel style，点击仍会导致选区提前失效。改用真正的 `NSPanel` 承载 WebView，点击前后保持源 PID 和源选区。
3. 将 contentView 移入 NSPanel 后，Tao 仍会读取原窗口 contentView；为原窗口保留占位视图后恢复稳定运行。此做法依赖平台实现，正式迁移应封装和持续回归。
4. 系统 `screencapture` 被屏幕权限阻止。改用 WKWebView snapshot 查看真实按钮渲染，未更改系统屏幕录制权限。
5. 回退测试控件需要真实的 AppKit 复制菜单才能响应合成 ⌘C；补齐后验证 `method=99`，并检查浮窗点击前剪贴板已恢复。

## 历史基线：Windows OMEN（异步改造前）

日期：2026-10-23。环境：OMEN，Windows 11 x64（build 26200），用户 `OMEN\shiory` 的已登录 console Session 2，150% 缩放；MSVC 19.44、Windows SDK 10.0.26100.0、Rust 1.99.1、Tauri 2.12.5、系统 WebView2。

原生 engine 静态编译进 release EXE，无 Node runtime／sidecar。通过当前用户普通权限的 Interactive 一次性计划任务运行独立 WinForms fixture；双击和点击通过 SendInput，拖选通过后台输入线程发送 SendInput 移动事件，未注入取词结果、未程序化设置选区、未绕过来源校验。最终五个场景按顺序重跑，整体命令退出码为 0。

| 场景 | 结果 | 检查内容 |
|---|---|---|
| 双击选词，UIA | 通过 | `method=1`；浮窗出现；真实点击后剪贴板严格等于预期；来源 HWND 与选区保留 |
| 鼠标拖选，UIA | 通过 | `method=1`；15 字符完整选区；真实点击后内容正确，焦点与选区保留 |
| 只支持复制快捷键的控件 | 通过 | `method=99`；回退后 sentinel 恢复；点击后复制正确，焦点与选区保留 |
| 七秒凭证失效 | 通过 | 浮窗隐藏；剪贴板 sentinel 未改变 |
| 切换前台应用 | 通过 | 显式断言前台已经改变；浮窗隐藏；剪贴板 sentinel 未改变 |
| 实际浮窗渲染 | 通过 | 保存并查看 CopyFromScreen 截图，按钮非空、中文正常；132×60 物理像素，对应 150% 下 88×40 逻辑尺寸 |
| MSVC bridge 单独编译、Cargo check、release EXE | 通过 | Windows 真实目标编译链接；macOS 最终 Cargo check 也通过 |

远程产物目录：`C:\Users\shiory\copick-tauri-verify-20261023\tauri-prototype\artifacts\`。最终 JSON 和截图也复制到本机忽略目录 `artifacts/omen-20261023/windows-<场景>/`。验证后一次性计划任务、原型和 fixture 进程均已清理；驱动恢复测试前可解析的剪贴板格式。PowerShell 5.1 输出的中文 transcript 在 SSH 中存在代码页乱码，不影响 JSON 中的布尔断言和原生 method 日志。

EXE：`src-tauri/target/release/copick-tauri-prototype.exe`，**3,284,992 bytes，约 3.13 MiB**。这是依赖系统 WebView2 的裸 EXE 体积，不是 NSIS 安装包体积，也不包含 WebView2 runtime；不能与 macOS `.app` 或 Electron 安装包按相同口径直接比较。NSIS、签名、干净机器安装和缺少 WebView2 的引导均未验证。

### Windows 验证中发现的问题

1. Tauri 即使 `--no-bundle` 也需要有效 ICO 生成 Win32 resource；补充 `icons/icon.ico` 及 Windows 图标配置后通过。
2. 初版 WinForms TextBox／旧 RichEdit 会走剪贴板回退，双击还可能包含尾随空格。原生测试改用系统 `RICHEDIT50W`，以 `method=1` 严格确认 UIA；这不代表旧控件被验证为 UIA 支持。
3. 在 fixture UI 线程上阻塞发出拖选会让控件不能及时消费事件；只用 SetCursorPos 也不能验证完整低级 hook 手势。改为后台线程的 SendInput 移动后，真实拖选链路通过。
4. 原型 Windows MTA worker 确保 COM／UIA 线程归属，但 Rust 主线程仍同步等待最多 1.8 秒；慢 provider 会卡住 UI，超时后禁用捕获与复制直到重启。尚未用无响应 provider 实测此超时路径。
5. 鼠标事件的来源 HWND／PID 和 cursor 在主线程消费时采样，快速切窗及队列延迟仍有边界；同 PID 不同窗口的展示成功回传也未完善。正式迁移前应采用事件时刻快照、异步完成通知和更严格的窗口来源绑定。

## 尚未验证／实现

- Windows ARM64、NSIS 安装器、无 WebView2 的安装引导、MSAA 独立路径与管理员窗口；已验证的是 x64 UIA 与剪贴板回退两条路径。
- 第三方真实应用的完整矩阵：浏览器、PDF、Excel、微信和 IDE 等。
- 多显示器、混合缩放、负坐标显示器、全屏 Space、系统安全输入。
- 首次授权、运行中撤销与恢复权限、长期驻留／睡眠唤醒。
- 完整格式／空剪贴板／外部并发写入下的回退恢复。原型沿用上游事务的已知限制。
- 原型已将异步 capture/copy 移出 Tauri UI 主线程，并加入 request/generation、事件年龄/overflow、迟到结果、来源变化和展示回执保护；这些保护已有确定性 popup 回归，macOS 有限六秒慢 AX provider 已真实验证暂停、恢复、退出及后续新请求；Windows WM_GETOBJECT provider dispatch 的有限慢响应与外部 marker 持续等待场景已通过 UI 操作/退出验证；macOS 新窗口绑定后的对应复验受权限阻挡，任意 TextPattern/AX provider 的强制终止能力未实现。WKWebView snapshot 首帧 harness 验证 reset 后的首个快照与新状态一致，但不覆盖 compositor scanout。
- macOS 与 Windows 的自动剪贴板回退当前均保持关闭：上游回退在异步取消、前台切换和外部剪贴板写入时仍可能产生不可撤销副作用；显式点击浮窗复制不受影响。

## 判断

macOS 和 Windows 的历史核心链路验证及数 MiB 产物支持继续投入 Tauri。当前异步改造已落地并通过 Windows 原生路径回归，但第一阶段尚未达到完整验收，自动回退也暂时停用。应先补齐当前门槛和剪贴板事务，再进入兼容矩阵、产品 parity、安装发行；在此之前保留 Electron 和可回滚路径，不切换默认下载。
