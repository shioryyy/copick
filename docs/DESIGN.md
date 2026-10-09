# Copick 设计

选中文字，点击即复制。macOS 原生，纯本地，无网络，无 AI。

## 范围
- 仅 macOS，Swift 原生，无第三方依赖。
- 不做：AI、翻译等联网动作；`⌘C` 剪贴板回退（取词失败的应用暂不支持）。
- 历史：早期用 Electron + selection-hook 验证过可行性（飞书支持 AXAPI 取词，selection-hook 的 I-beam 判断会漏触发），随后用 Swift 重写并删除了 Electron 版。

## 模块（swift/）
| 文件 | 职责 |
|---|---|
| Source | AXAPI 取选中文本、所属应用、选区矩形 |
| Trigger | 判定「选择完成」：拖选（≥8pt）、双击/三击、Shift+点击；滚轮/按键/点击别处取消 |
| Filter | bundle id 黑/白名单，内置黑名单 |
| Anchor | 纯函数：选区矩形 + 拖动方向 → 浮窗位置，限制在当前屏幕可见区域内 |
| Popup | 非激活 NSPanel，不抢焦点，全屏/所有桌面可见 |
| Config | `Application Support/Copick/config.json`：`mode` / `list` / `paused` |
| main | 托盘菜单、开机自启（SMAppService）、单实例检查、串联各模块 |

## 关键行为
- 取词只走 AXAPI，不用剪贴板。
- 触发由自己判定，不依赖光标形状。
- 浮窗位置：有选区矩形时，向下/水平拖选放在选区下方，向上拖选放在上方；无矩形时放在鼠标下方。
- 坐标：AX 原点在主屏左上，Cocoa 在左下，`Source` 内统一转换。

## 安全
- 无任何网络 API 调用；无第三方依赖，只链接系统框架。
- 全局监听为只读的 `NSEvent` 全局监视器。

## 待办
- 为 Anchor / Filter 补单测；公证（需 Apple Developer 账号）；`⌘C` 回退（按应用开启）。
