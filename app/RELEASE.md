# Copick Tauri 构建与分发

产品名为 **Copick Tauri**，应用标识为 `local.copick.tauri`，可执行文件名仍为 `copick-tauri-prototype`（Windows 带 `.exe`）。版本取自 `src-tauri/tauri.conf.json`，发布前应同步核对 `package.json` 和 `src-tauri/Cargo.toml` 的版本。

没有配置签名密钥时，产物**未经过可信代码签名**：macOS 只有 ad-hoc 签名、未公证，Windows 未做 Authenticode 签名。配置了仓库密钥后，CI 会自动做 Developer ID 签名 + 公证，以及 Windows Authenticode 签名（见「CI 签名管线」）。`tauri.yml` 只生成可下载附件，不创建 GitHub Release。自动构建通过不等于完成真实安装和桌面功能验收。

## 构建要求

- macOS：Apple Silicon（arm64），Xcode Command Line Tools，Node.js 22.12+，Rust stable；应用配置的最低系统版本为 macOS 12.0，实际兼容性需在目标系统确认。使用系统 WKWebView，无需随包分发 WebView。
- Windows：x64 Windows，Visual Studio 2022 C++ Build Tools / Windows SDK，x64 MSVC Rust stable，Node.js 22.12+。原生编译与 C++ 单元测试必须在 x64 Developer PowerShell 中执行；仅安装 MSVC 而没有加载开发环境会导致 `cl` 不可用。
- Windows 运行需要系统安装 **Microsoft Edge WebView2 Evergreen Runtime**。便携 ZIP 不包含该运行时，应提前从微软官方渠道安装；NSIS 在缺少运行时时下载引导程序，因此首次安装可能需要网络及组织策略允许。当前不提供离线 WebView2 安装包。CI 的 smoke test 不创建 WebView，不能证明目标机器具备 WebView2。
- `selection-hook@2.1.1` 的原生源码由 `app/package-lock.json` 固定，`build.rs` 直接从 `app/node_modules/selection-hook` 编译。装依赖时用 `--ignore-scripts`，避免执行该包自带的 native 重建脚本。

## 手动构建

以下命令从仓库根目录执行，不需要启动 Electron。

```sh
npm --prefix app ci
npm --prefix app test
npm --prefix app run build
npm --prefix app run package
```

Windows 在已加载 x64 MSVC 环境的 Developer PowerShell 中执行相同命令。可先检查：

```powershell
cl
rustc -vV
```

`rustc -vV` 的 host 应为 `x86_64-pc-windows-msvc`。`cl` 不带源文件会显示版本和用法；这一步只用于确认编译器可用。旧的 `scripts/build-windows.ps1 -Release` 使用 `--no-bundle`，不能替代这里的 `npm run build`，后者才会生成 NSIS。

默认 build 在 macOS 选择 `--bundles app`，Windows 选择 `--bundles nsis`，保留显式传入的 Tauri 参数。发布打包只支持本机 macOS arm64 / Windows x64，以及默认的 `src-tauri/target/release` 目录；不要给发布构建传入 `--debug`、`--target`、`--no-bundle`、`--config` 产品/版本覆盖，也不要设置 `CARGO_TARGET_DIR` 或 `CARGO_BUILD_TARGET`。切换版本或构建配置后先清理旧的 `src-tauri/target/release/bundle` 再重新 build，避免误取旧包；多个 NSIS EXE 会使打包直接失败。

`npm run package` **不会自动编译**，必须在成功 build 后运行。打包器先检查必要文件，再运行实际 `.app` 中或 Windows 便携暂存目录中的可执行文件，带 `--smoke-test`，要求退出码为 0 且标准输出是含 `"ok": true` 的 JSON。`permission` 可以为 false，CI 不请求辅助功能授权、不启动正常 UI、不安装 NSIS。macOS 使用 `/usr/bin/ditto` 保留 `.app` 结构和资源；Windows 使用 PowerShell `Compress-Archive`，路径通过环境变量传入，不拼接到 PowerShell 源码。

成功后，`app/artifacts/release/` 只包含当前平台文件（下表以版本 0.1.0 为例）：

| 平台 | 文件 | 内容 |
| --- | --- | --- |
| macOS arm64 | `Copick-Tauri-0.1.0-mac-arm64.zip` | 顶层 `Copick Tauri.app`，内含第三方 NOTICE |
| Windows x64 | `Copick-Tauri-0.1.0-win-x64.zip` | `copick-tauri-prototype.exe` 和 `NOTICE-selection-hook.txt` |
| Windows x64 | `Copick-Tauri-Setup-0.1.0-win-x64.exe` | 当前用户 NSIS 安装程序，第三方 NOTICE 作为应用资源安装 |
| 每个平台 | `SHA256SUMS.txt` | 该平台 ZIP / EXE 的 SHA-256 值 |

目录仅在本次所有检查及归档成功后替换；失败时旧目录可能仍在，**不能将上次成功留下的附件当成本次结果**。两平台分别构建，分别校验各自清单；从 CI 下载后保存到不同目录，避免两个 `SHA256SUMS.txt` 互相覆盖。

## 独立 CI

`.github/workflows/tauri.yml` 支持 Actions 中手动 `workflow_dispatch`，以及 main push / PR 的 Tauri 路径变化；`.github/workflows/tauri.yml` 与 `app/**` 的改动会触发。使用 `macos-latest` arm64 和 `windows-latest` x64 MSVC，先验证 runner 架构，再安装 Node 22 / Rust stable、依赖，运行 `npm test`，build、smoke test、打包，最后上传 `copick-tauri-mac-arm64` / `copick-tauri-win-x64` 附件，保留 14 天。

CI 使用 `contents: read` 权限。下载的 Actions artifact 是外层容器 ZIP，先解开，再取其中的产品 ZIP / EXE 与校验文件。

### CI 签名管线

签名与 Electron 版共用同一组仓库 secrets，全部缺失时行为与以前完全一致（macOS ad-hoc、Windows 未签名），不会半途失败。**截至 2026-10-26 仓库尚未配置任何签名 secret**，CI 只跑过「缺密钥」分支；证书导入、`signtool` 签名与公证的代码路径仍未真实执行。

| Secret | 平台 | 作用 |
| --- | --- | --- |
| `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` | macOS | base64 PKCS#12 证书，交给 Tauri 的 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` |
| `MAC_SIGNING_IDENTITY` | macOS | 可选，指定签名身份；缺省时由 Tauri 从导入证书里选 Developer ID |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | macOS | 三者齐全才启用公证（映射到 `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`）；有证书但缺公证凭据时只签名 |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows | base64 PFX，build 之后、package 之前用 Windows SDK 的 `signtool` 签可执行文件与 NSIS 安装包 |

Windows 签名顺序很重要：便携 ZIP 由 `npm run package` 从已签名的可执行文件生成，签名必须在它之前完成。签名后脚本用 `Get-AuthenticodeSignature` 要求每个文件状态为 `Valid`，否则 job 失败。macOS 若同时给了公证凭据，Tauri 在 `npm run build` 内完成公证与 stapler。

### 发布现状

仓库里没有自动创建 GitHub Release 的工作流：`tauri.yml` 只把产物作为 Actions 附件保留 14 天。需要对外发布时，从 Actions 下载附件，按下面的步骤校验，再手工创建 Release。旧 Electron 版的发布流水线已随 `app/` 一并删除。

## 校验与安装

macOS 在下载附件的目录检查哈希：

```sh
shasum -a 256 -c SHA256SUMS.txt
```

Windows 可用以下命令查看两份文件的哈希，逐一对照同目录的 `SHA256SUMS.txt`（哈希大小写不影响比较）：

```powershell
Get-FileHash -Algorithm SHA256 .\Copick-Tauri-0.1.0-win-x64.zip
Get-FileHash -Algorithm SHA256 .\Copick-Tauri-Setup-0.1.0-win-x64.exe
Get-Content .\SHA256SUMS.txt
```

macOS 解压产品 ZIP，将 `Copick Tauri.app` 拖入“应用程序”。首次打开可能被 Gatekeeper 拦截；确认来源及哈希后，可按系统提示在“系统设置 → 隐私与安全性”允许打开，不要全局关闭 Gatekeeper。进入“隐私与安全性 → 辅助功能”，允许 **Copick Tauri**；从终端运行开发版获得的授权不能代表安装版已经授权。升级前从托盘退出旧实例，替换后重新核对授权，必要时移除旧条目再授权。

Windows 安装版运行 `Copick-Tauri-Setup-<版本>-win-x64.exe`，按当前用户安装，无需把应用作为管理员长期运行；可通过系统“已安装的应用”卸载。未签名包可能被 SmartScreen 或组织策略拦截，须由用户在确认来源后处理，不能假设所有机器都能直接放行。便携版完整解压到固定目录，保留 NOTICE，与系统 WebView2 一起使用，再运行 `copick-tauri-prototype.exe`。不要从压缩包内直接运行。更新或移动目录前先从托盘退出，移动后检查开机启动项是否需要重新设置。

应用标识为 `local.copick.tauri`，版本升级时仍应核对自己的配置、托盘及启动项行为。

## 可选签名

没有签名凭据时可以完成构建与打包，但分发说明必须保留“未签名 / 未公证”。打包器只归档已经构建的内容，不导入证书、不执行签名、不触发公证，也不会把“存在某个环境变量”当作验证签名成功。

macOS 如需可信签名，可在受控构建环境配置 Tauri 原生支持的 `APPLE_SIGNING_IDENTITY`；使用证书文件时按 Tauri 文档设置 `APPLE_CERTIFICATE`（base64 PKCS#12）及 `APPLE_CERTIFICATE_PASSWORD`。公证可使用 `APPLE_ID`、`APPLE_PASSWORD`（应用专用密码）和 `APPLE_TEAM_ID`，或 Tauri 支持的 App Store Connect API 凭据。手动构建不强制 ad-hoc；在 CI 使用前，需要将默认的 `APPLE_SIGNING_IDENTITY=-` 替换为实际配置并显式连接用户自己的 secrets。成功签名/公证后再归档，检查 `codesign --verify --deep --strict`、`spctl` 及 stapler 结果。

Windows 可在受控机器的证书存储安装代码签名证书，通过额外的 Tauri JSON 配置设置 `bundle.windows.certificateThumbprint`、`digestAlgorithm` 和时间戳 URL。如把该外部配置文件路径存于用户自定的 `COPICK_TAURI_SIGNING_CONFIG` 环境变量，Developer PowerShell 构建命令为：

```powershell
npm --prefix app run build -- --config $env:COPICK_TAURI_SIGNING_CONFIG
npm --prefix app run package
```

此覆盖文件只应配置签名，不覆盖产品名、版本、目标和资源。构建后对便携 EXE 和 NSIS EXE 分别用 `Get-AuthenticodeSignature` 确认签名与时间戳；若自行签名，也必须在 `npm run package` 前完成，从而让 SHA-256 对应最终内容。

CI 的签名走上一节的 secrets 与 `signtool`，不使用这份覆盖配置；两者不要同时启用。远程签名服务（Azure Trusted Signing 等）尚未接入，需要时替换 `Sign Windows artifacts` 步骤。不要把密码、私钥或证书写入仓库。

## 自动验证与剩余人工确认

脚本的基本静态检查：

```sh
node --check app/scripts/tauri.cjs
node --check app/scripts/package.cjs
```

CI 的 `npm test` 包含现有 JavaScript、C++ helper 和 Rust 测试；build 与 smoke test 验证实际原生产物可执行、NOTICE 齐全及归档成功。NSIS 本身不会在 CI 执行。历史真实桌面证据及边界见 [VALIDATION.md](VALIDATION.md)，不能将旧版 EXE 测试结果直接当作当前安装包验收。

实际对外发布前仍需在干净的目标机器确认：

- macOS ZIP 下载、解压、拖入应用程序、Gatekeeper 提示、辅助功能首次授权与授权恢复；应用图标、托盘、单实例、设置持久化和开机启动。
- Windows 便携包在已安装 WebView2 的机器运行；NSIS 在 WebView2 已有与缺失时的安装、首次启动、升级及卸载；网络不可用时的失败提示；组织策略与 SmartScreen 行为。
- 两平台用真实目标应用完成划词、浮窗、点击复制、源焦点保留、暂停/恢复及退出，复核第三方应用、多显示器、权限变更和长期运行边界。自动剪贴板回退目前禁用，不能作为发行功能承诺。
- 如配置可信签名，单独核对最终应用及安装器签名、公证和时间戳；核验下载后的 SHA-256 与最终附件一致。

本流程不会运行真实安装、操作真实桌面，也不会对外发布。以上人工确认未完成前应如实标注状态。
