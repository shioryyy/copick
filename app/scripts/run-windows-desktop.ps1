param(
    [string]$Scenario = 'double',
    [string]$Executable = '',
    [string]$LogPath = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$artifacts = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
$transcript = Join-Path $artifacts "desktop-$Scenario.log"
Start-Transcript -Path $transcript -Force | Out-Null
try {
    if ((Get-Process -Id $PID).SessionId -eq 0) { throw '必须在已登录的交互桌面运行，不能使用 Session 0' }
    & "$PSScriptRoot\verify-windows.ps1" -Scenario $Scenario -Executable $Executable -LogPath $LogPath
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw '桌面验证失败' }
    'COPICK_WINDOWS_DESKTOP_OK'
} finally { Stop-Transcript | Out-Null }
