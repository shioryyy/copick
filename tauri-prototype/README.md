# Copick Tauri

Copick Tauri 是基于 Tauri 2、Rust 和原生取词引擎的划词复制工具，支持 macOS arm64 与 Windows x64。在其他应用中双击选词、鼠标拖选或 Shift 点击扩展选区后，点击选区旁的复制按钮即可写入剪贴板。

应用以单实例运行，重复启动会打开已有实例的设置页。关闭设置窗口后仍在系统托盘常驻，可从托盘暂停、恢复、打开设置或退出。

## 使用与设置

macOS 首次使用需要在系统设置中授予 Copick Tauri 辅助功能权限，可从设置页点击「检查辅助功能权限」。设置页支持系统浅色／深色外观，并提供监听状态、开机启动、应用排除列表、诊断日志和退出操作。

排除列表每行填写一个程序名或 bundle id，按不区分大小写的子字符串匹配；保存时转为小写、去除首尾空白及重复项。最多 200 项，每项最多 128 个字符，不接受路径、通配符和控制字符。列表与诊断开关需保存，也可撤销未保存的更改；开机启动单独登记，系统仍可禁用该启动项，macOS 更改在下次登录时生效。

设置保存在 Tauri 应用标识 `local.copick.tauri` 对应的独立配置目录。首次建立配置时，只读导入 Electron 版的 `paused` 和 `blacklist`，不修改旧版文件，也不导入开机启动项。诊断日志默认关闭，可在设置页开启并打开日志文件夹。

## 运行与构建

需要 Node.js 22.12+、Rust stable；macOS 需要 Xcode Command Line Tools，Windows 需要 x64 MSVC C++ Build Tools、Windows SDK 和 WebView2。以下命令从仓库根目录执行。`app/` 的依赖提供构建所需的原生源码，无需启动 Electron。

```sh
npm --prefix app ci --ignore-scripts
npm --prefix tauri-prototype ci
npm --prefix tauri-prototype run dev
```

检查、测试、构建和打包：

```sh
npm --prefix tauri-prototype run check
npm --prefix tauri-prototype test
npm --prefix tauri-prototype run build
npm --prefix tauri-prototype run package
```

`package` 需在 `build` 成功后运行。平台产物、安装方式、签名及发布步骤见 [RELEASE.md](RELEASE.md)。

## 当前支持范围

macOS 通过 Accessibility（AX）读取选区，Windows 使用 UIA／MSAA。Windows 在无障碍取词失败后默认使用兼容复制回退（模拟 Ctrl+Insert／Ctrl+C），可在设置中关闭；回退会临时改动剪贴板，取消时恢复备份。macOS 的回退无法在事务内取消，因此始终关闭，仅 UIA／AX 可读的应用可用。键盘选区自动触发暂未支持。

当前版本不承诺与 Electron 版的全部手势、应用兼容性及发行行为一致。历史桌面验证记录和已知边界见 [VALIDATION.md](VALIDATION.md)，逐应用的真机结果见 [COMPATIBILITY.md](COMPATIBILITY.md)；历史结果不代替当前安装包验收。
