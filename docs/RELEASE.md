# 发布、签名与公证

发布流程见 README 的「开发与检查」一节和 `.github/workflows/release.yml`。本文件记录代码签名与公证的凭据、CI 行为与验证方法。

## CI 行为

- **无凭据**：照常构建并发布未签名产物。Release 说明会提醒 Windows 的 SmartScreen 提示，以及 macOS 未签名时辅助功能授权可能在重新解压后失效。
- **有凭据**：`Package` 步骤读取下方 Secrets 后自动签名；macOS 在检测到 `APPLE_ID` 时以 `--config.mac.notarize=true` 构建并公证。
- 缺失的 Secrets 会以空字符串出现在环境变量里，`Package` 步骤会先把空值 unset：macOS 打包把空 `CSC_LINK` 当成证书路径（只判 null，不判空串），不清理会直接失败。

## Windows 代码签名

| Secret | 内容 |
|---|---|
| `WIN_CSC_LINK` | PFX 证书（含私钥）的 base64 |
| `WIN_CSC_KEY_PASSWORD` | PFX 密码 |

生成 base64（PowerShell）：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx')) | Set-Clipboard
```

签名覆盖 `Copick.exe`、NSIS 安装包与卸载器。本地验证：

```powershell
Get-AuthenticodeSignature release\win-unpacked\Copick.exe |
  Format-List Status, StatusMessage, SignerCertificate
```

`Status` 为 `Valid` 表示证书链可信。自签证书会显示 `UnknownError` 或 `NotTrusted`，只用于验证签名管线本身。

证书来源：Azure Trusted Signing（按月订阅，无需硬件令牌）或传统 OV/EV 证书。个人开发者一般适用 OV。

在无符号链接特权的 Windows 账户上首次签名时，7-Zip 解包 winCodeSign 会对 darwin 目录的符号链接报错（日志里的 `7z reported error but extracted files`）。这是无害警告：Windows 签名工具已正确解出，构建与签名不受影响。

## macOS 签名与公证

| Secret | 内容 |
|---|---|
| `MAC_CSC_LINK` | Developer ID Application 证书 `.p12` 的 base64 |
| `MAC_CSC_KEY_PASSWORD` | `.p12` 密码 |
| `APPLE_ID` | Apple 开发者账号邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 该账号的 App 专用密码 |
| `APPLE_TEAM_ID` | 团队 ID |

前置条件：Apple Developer Program 会员。签名使用 hardened runtime 与 `app/build/entitlements.mac.plist`（JIT、非签名可执行内存、库校验放宽，分别对应 Electron 与 selection-hook 原生模块）。

本地验证：

```bash
codesign -dv --verbose=4 Copick.app
spctl -a -vv Copick.app
xcrun stapler validate Copick.app
```

辅助功能授权与代码签名绑定：未签名或未公证的版本在重新下载、重新解压后可能要求重新授权；公证版本不会。

未验证项：公证路径已接线，但截至 2026-10-18 尚未用真实 Apple 凭据跑过；Windows 签名管线已用自签证书端到端验证（签名成功、卸载器与安装包同样签名）。
