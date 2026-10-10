# Copick

macOS 通用划词复制小工具：在支持 macOS 辅助功能（AXAPI）的应用里选中文字，旁边弹出「复制」按钮，点击即复制。

- **纯本地**：无网络请求、无 AI、无遥测，不上传任何文本。
- **只做复制**：没有翻译、问 AI 等联网动作。
- **不动剪贴板**：只有点击按钮时才写入。
- **原生 Swift**：无第三方依赖，约 300 行源码可通读审计；产物约 260KB，内存约 25MB。

## 构建与安装

```bash
swift/build.sh
```

产物：`dist/Copick-swift/Copick.app`。

1. 拖进「应用程序」，首次打开右键选「打开」（未经 Apple 公证，会被 Gatekeeper 拦截）。
2. 「系统设置 → 隐私与安全性 → 辅助功能」勾选 Copick。

签名：默认用钥匙串里的 `Copick Dev` 代码签名证书（固定身份，重新构建不丢辅助功能授权）；找不到则回退 ad-hoc。可用 `COPICK_SIGN_ID` 指定其他证书。

## 使用

- 触发：拖选、双击/三击、Shift+点击。
- 浮窗在点击别处、滚动、按键时消失。
- 菜单栏图标：暂停/恢复、在最近划词的应用中禁用、清空自定义黑名单、开机自启、退出。
- 内置黑名单：Finder、钥匙串访问、1Password。自定义黑名单保存在 `~/Library/Application Support/Copick/config.json`。

## 已验证应用

| 应用 | 状态 |
|---|---|
| Safari（网页） | ✅ 经 WebKit TextMarker 接口取词 |
| Edge（网页，含 GitHub、禁止复制的飞书云文档网页） | ✅ |
| 飞书桌面客户端 | ✅ |
| Claude 桌面应用 | ⚠️ 偶尔取不到，疑似 Electron 的 AX 树未就绪 |
| Chrome、Firefox、终端类 | 未验证 |

取词走辅助功能接口，不受页面「禁止复制」限制，也因此只读取你自己屏幕上选中的文字，不会绕过任何访问控制。

## 隐私与安全自查

- 取词只用 macOS Accessibility API，不使用 `⌘C`，不读写剪贴板（点击复制除外）。
- 源码无任何网络调用，可自查：

  ```bash
  grep -rnE "URLSession|URLRequest|NWConnection|CFNetwork|Socket|http" swift/*.swift
  ```

  应无结果。
- 无第三方依赖，只链接系统框架：`otool -L dist/Copick-swift/Copick.app/Contents/MacOS/Copick`。
- 全局事件监听使用 `NSEvent` 全局监视器：只读、不能拦截或修改事件，也不需要「输入监控」权限。

## 目录

| 路径 | 说明 |
|---|---|
| `swift/` | 源码与 `build.sh` |
| `build/` | 图标（`make_icon.py` 生成） |
| `docs/DESIGN.md` | 设计说明 |

## 范围

仅 macOS，取词失败的应用暂无 `⌘C` 回退。最低系统版本 macOS 13，目前只编译 arm64。

## 许可

MIT。交互设计参考了 Cherry Studio 的开源划词助手（取词思路与浮窗行为）。
