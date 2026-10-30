param()
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$root = Split-Path -Parent $PSScriptRoot
$artifacts = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
$folder = Join-Path $artifacts ("clipboard-guardian-" + [DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $folder | Out-Null
$compiler = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$harness = Join-Path $artifacts 'ClipboardGuardianVerification.exe'
& $compiler /nologo /target:exe /platform:x64 /r:System.dll /r:System.Core.dll "/out:$harness" `
    "$PSScriptRoot\verify-windows-guardian.cs" "$PSScriptRoot\windows-clipboard-guardian.cs"
if ($LASTEXITCODE -ne 0) { throw 'Windows 剪贴板守护进程验收编译失败' }
# harness 用同一个可执行文件的不同模式启动真实守护进程进程。
& $harness $harness $folder
$code = $LASTEXITCODE
$reportPath = Join-Path $folder 'verification.json'
if (Test-Path $reportPath) { Get-Content $reportPath -Raw -Encoding UTF8 }
if ($code -ne 0) { throw "Windows 剪贴板守护进程验收失败：$code" }
