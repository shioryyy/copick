param([switch]$Release)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$root = Split-Path -Parent $PSScriptRoot
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw '缺少 Visual Studio C++ 构建工具，请运行 setup-windows.ps1' }
$developer = Join-Path $vs 'Common7\Tools\Launch-VsDevShell.ps1'
& $developer -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
Set-Location $root
if ($Release) { & node scripts/tauri.cjs build --no-bundle }
else { & node scripts/tauri.cjs check }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
