param(
    [string]$Installer = '',
    [string]$InstallDir = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$artifacts = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null

if (!$Installer) {
    # 优先用 package.cjs 产出的发布包；没有就退回构建目录里的原始安装器。
    $packaged = Join-Path $artifacts 'release'
    if (Test-Path $packaged) {
        $Installer = (Get-ChildItem $packaged -Filter 'Copick-Tauri-Setup-*.exe' | Select-Object -First 1).FullName
    }
    if (!$Installer) {
        $Installer = (Get-ChildItem (Join-Path $root 'src-tauri\target\release\bundle\nsis') -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
    }
}
if (!$Installer -or !(Test-Path $Installer)) { throw '找不到 NSIS 安装包；先运行 npm run build 或 npm run package' }
if (!$InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'CopickTauriInstallCheck' }

$compiler = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$driver = Join-Path $artifacts 'InstallerCheck.exe'
# .NET Framework 里 RegistryKey 在 mscorlib/System 中，没有独立的 Microsoft.Win32.Registry 程序集。
# 设置页是 WebView2，点启动项开关要用 UIAutomationClient。
$automation = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\WPF'
& $compiler /nologo /target:exe /platform:x64 /r:System.dll /r:System.Core.dll `
    "/r:$automation\UIAutomationClient.dll" "/r:$automation\UIAutomationTypes.dll" "/r:$automation\WindowsBase.dll" `
    "/out:$driver" "$PSScriptRoot\verify-windows-installer.cs"
if ($LASTEXITCODE -ne 0) { throw '安装包验证驱动编译失败' }

$reportPath = Join-Path $artifacts 'installer-verification.json'
Remove-Item $reportPath -Force -ErrorAction SilentlyContinue
Write-Host "installer: $Installer"
Write-Host "install dir: $InstallDir"
& $driver $Installer $InstallDir $reportPath
$code = $LASTEXITCODE
if (Test-Path $reportPath) { Get-Content $reportPath -Raw | Write-Output }
if ($code -ne 0) { throw "安装包验证未通过（退出码 $code）" }
Write-Host 'installer verification OK'
