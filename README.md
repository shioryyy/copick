# Copick

本地划词复制小工具：在其他应用里选中文字，选区旁弹出「复制」按钮，点击即复制。

- 纯本地运行：无网络请求、无 AI、无遥测，不保存选中文字。
- Tauri 2 + Rust + 原生取词引擎，宿主系统 WebView，支持 macOS arm64 与 Windows x64。
- Windows 提供 NSIS 安装版（按用户安装，无需管理员）和便携 ZIP；macOS 提供 ZIP。两端都可在设置中开启登录后自动启动。

## 下载

[GitHub Releases](https://github.com/shioryyy/copick/releases) 里现有的包是旧的 Electron 版，不再更新。当前版本只有 CI 附件：在 Actions 的 **Tauri packages** 运行里下载 `copick-tauri-mac-arm64` / `copick-tauri-win-x64`，解开外层 ZIP 后按 [app/RELEASE.md](app/RELEASE.md) 校验与安装。产物未代码签名，首次运行可能被系统拦截。

## 目录

| 路径 | 说明 |
|---|---|
| `app/` | 产品源码：Tauri 外壳、Rust 主进程、原生桥、设置页与打包脚本 |
| `app/COMPATIBILITY.md` | 逐应用真机取词矩阵 |
| `app/VALIDATION.md` | 真机验证记录与已知边界 |
| `app/RELEASE.md` | 构建、打包、签名与安装说明 |
| `.github/workflows/tauri.yml` | 两平台 CI：测试、构建、smoke test、打包、上传附件 |
| `CHANGELOG.md` | 更新日志 |

## 运行与构建

需要 Node.js 22.12+、Rust stable；macOS 需要 Xcode Command Line Tools，Windows 需要 x64 MSVC C++ Build Tools、Windows SDK 和 WebView2。以下命令从仓库根目录执行——`selection-hook` 的原生源码由 `app` 自己的依赖提供，构建时不启动任何 Electron 进程。

```sh
npm --prefix app ci
npm --prefix app run dev
```

检查、测试、构建和打包：

```sh
npm --prefix app run check
npm --prefix app test
npm --prefix app run build
npm --prefix app run package
```

`package` 需在 `build` 成功后运行。Windows 的构建与 C++ 单元测试必须在已加载 x64 MSVC 环境的 Developer PowerShell 中执行。平台产物、签名及发布步骤见 [app/RELEASE.md](app/RELEASE.md)。

## 使用与设置

macOS 首次使用需要在系统设置中授予辅助功能权限，可从设置页点击「检查辅助功能权限」。设置页支持系统浅色／深色外观，并提供监听状态、开机启动、应用排除列表、诊断日志和退出操作。

排除列表每行填写一个程序名或 bundle id，按不区分大小写的子字符串匹配；保存时转为小写、去除首尾空白及重复项。最多 200 项，每项最多 128 个字符，不接受路径、通配符和控制字符。列表与诊断开关需保存，也可撤销未保存的更改；开机启动单独登记，系统仍可禁用该启动项，macOS 更改在下次登录时生效。

应用以单实例运行，重复启动会打开已有实例的设置页。关闭设置窗口后仍在系统托盘常驻，可从托盘暂停、恢复、打开设置或退出。

设置保存在 Tauri 应用标识 `local.copick.tauri` 对应的独立配置目录。诊断日志默认关闭，可在设置页开启并打开日志文件夹。

## 当前支持范围

macOS 通过 Accessibility（AX）读取选区，Windows 使用 UI Automation（`CUIAutomation8`）／MSAA。Windows 的兼容复制回退（模拟 Ctrl+Insert／Ctrl+C）默认关闭，可在设置中开启；回退会临时改动剪贴板，取消时恢复备份。回退关闭时取不到词不会静默：设置页会显示最近一次失败的应用和原因，需要时可直接为它开启回退（对全部应用生效）。macOS 的回退无法在事务内取消，因此始终关闭，仅 UIA／AX 可读的应用可用。键盘选区自动触发暂未支持。

当前版本不承诺与旧 Electron 版的全部手势、应用兼容性及发行行为一致。历史桌面验证记录和已知边界见 [VALIDATION.md](app/VALIDATION.md)，逐应用的真机结果见 [COMPATIBILITY.md](app/COMPATIBILITY.md)；历史结果不代替当前安装包验收。

## 安全边界

设置页只加载本地页面，CSP 禁止外部脚本、样式与连接；应用无网络请求、无选中文字历史。诊断日志默认关闭，可写的内容由固定 schema 白名单约束：事件名、请求序号、固定枚举的原因和压缩后的程序 token，不接纳窗口标题、路径或选中文字。日志位于配置目录下的 `logs/selection.log`：Windows 为 `%APPDATA%\local.copick.tauri\logs`，macOS 为 `~/Library/Application Support/local.copick.tauri/logs`。

## 许可

MIT。
