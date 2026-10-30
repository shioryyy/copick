param([string]$Executable = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$artifacts = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
$compiler = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$automation = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\WPF'
$driver = Join-Path $artifacts 'SettingsCloseCheck.exe'
& $compiler /nologo /target:exe /platform:x64 /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll "/r:$automation\UIAutomationClient.dll" "/r:$automation\UIAutomationTypes.dll" "/r:$automation\WindowsBase.dll" "/out:$driver" "$PSScriptRoot\verify-windows-settings.cs"
if ($LASTEXITCODE -ne 0) { throw '设置页验证驱动编译失败' }
if (!$Executable) { $Executable = Join-Path $root 'src-tauri\target\release\copick-tauri-prototype.exe' }
Get-Process copick-tauri-prototype -ErrorAction SilentlyContinue | Stop-Process -Force
# 每次从没有配置文件的状态开始，确保设置页展示的是默认值。
Remove-Item (Join-Path $env:APPDATA 'local.copick.tauri') -Recurse -Force -ErrorAction SilentlyContinue
$app = Start-Process $Executable -PassThru
try {
    $output = & $driver $app.Id.ToString()
    $code = $LASTEXITCODE
    $output | Write-Output
    if ($code -ne 0) { throw '设置页关闭确认验证未通过' }
} finally {
    if ($app -and !$app.HasExited) { $app.CloseMainWindow() | Out-Null; Start-Sleep -Milliseconds 500; if (!$app.HasExited) { $app.Kill() } }
}
