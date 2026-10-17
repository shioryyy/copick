# Copick 兼容性矩阵

Copick 的全部价值是「在某个应用里选中文字后，浮窗可靠出现并能复制」。单元测试和 CI 的 smoke test 都不能证明这一点，只有真机交互测试可以。本文件是测试记录，每次发版前更新。

## 记录规则

- 每个单元格填写：`✅ 版本/日期`、`⚠️ 版本/日期 备注`、`❌ 版本/日期 原因` 或 `—` 未测。
- 「取词」列记录直接无障碍取词（AX / UIA）是否成功；「回退」列记录开启快捷键回退后是否成功。回退默认 macOS 关、Windows 开。
- 失败时附带 `--diagnostics` 日志中的 `reason` 或 `method` 字段，不要贴选中文字。
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
| Edge | msedge.exe | — | — | — | |
| Chrome | chrome.exe | — | — | — | |
| Firefox | firefox.exe | — | — | — | |
| 记事本 | notepad.exe | — | — | — | Win11 新版为 UWP 容器 |
| Word | winword.exe | — | — | — | |
| Excel 单元格 | excel.exe | — | — | — | |
| Outlook | outlook.exe | — | — | — | |
| Acrobat Reader | acrord32.exe / acrobat.exe | — | — | — | |
| Edge PDF | msedge.exe | — | — | — | |
| 微信 | wechat.exe / weixin.exe | — | — | — | |
| 飞书 | feishu.exe | — | — | — | Electron |
| 资源管理器文件名 | explorer.exe | — | — | — | |
| VS Code | code.exe | — | 禁用 | — | 平台内置禁止回退 |
| Windows Terminal | windowsterminal.exe | 应不触发 | 应不触发 | — | 平台内置完全黑名单 |
| 1Password | 1password.exe | 应不触发 | 应不触发 | — | 平台内置完全黑名单 |

### Windows 系统级用例

| 用例 | 结果 | 备注 |
|---|---|---|
| 解压到含中文或空格的路径下启动，设置页可读取并保存 | — | 验证 IPC 页面校验不受路径编码影响 |
| 主屏 100% + 副屏 150% 缩放，两屏浮窗位置均正确 | — | screenToDipPoint 转换 |
| 以管理员运行的应用（如管理员 PowerShell 外的记事本）能否取词 | — | 普通权限 Copick 预期不能注入高完整性窗口 |
| 点击浮窗后源应用保持焦点，输入不中断 | — | |
| 系统休眠唤醒后监听仍工作 | — | |
| 切换用户 / 锁屏后恢复 | — | |
| SmartScreen 对未签名 ZIP 的提示文案 | — | 记录以便写用户指引 |
| 剪贴板历史（Win+V）开启时回退是否留下记录 | — | README 已说明可能发生 |

## 测试机记录

| 日期 | 平台 | 系统版本 | Copick 版本 | 显示器 / 缩放 | 测试人 |
|---|---|---|---|---|---|
| | | | | | |
