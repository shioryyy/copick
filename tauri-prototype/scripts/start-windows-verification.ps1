param(
    [ValidateSet('double', 'drag', 'background-drag', 'fallback', 'fallback-disabled', 'expiry', 'switch', 'samepid-switch', 'slow-control', 'slow-exit', 'blocked-exit')]
    [string]$Scenario = 'double'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskName = "CopickTauriPrototypeVerify-$Scenario"
$artifacts = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
$script = Join-Path $PSScriptRoot 'run-windows-desktop.ps1'
$executable = Join-Path $root 'src-tauri\target\release\copick-tauri-prototype.exe'
if (!(Test-Path $executable)) { throw "找不到原型可执行文件：$executable" }
$log = Join-Path $artifacts ("prototype-$Scenario-" + [DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '.log')
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $script + '" -Scenario ' + $Scenario + ' -Executable "' + $executable + '" -LogPath "' + $log + '"')
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw "已有同名验证任务：$taskName" }
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
try {
    $started = Get-Date
    Start-ScheduledTask -TaskName $taskName
    $deadline = $started.AddMinutes(3)
    do {
        Start-Sleep -Seconds 2
        $task = Get-ScheduledTask -TaskName $taskName
        $info = Get-ScheduledTaskInfo -TaskName $taskName
        $finished = $info.LastRunTime -ge $started.AddSeconds(-1) -and $task.State -ne 'Running' -and $info.LastTaskResult -ne 267009
    } while (!$finished -and (Get-Date) -lt $deadline)
    if (!$finished) { Stop-ScheduledTask -TaskName $taskName; throw '交互桌面验证任务超时' }
    Get-Content (Join-Path $artifacts "desktop-$Scenario.log") -Encoding UTF8
    if ($info.LastTaskResult -ne 0) { throw "桌面任务失败：$($info.LastTaskResult)" }
    Get-Content (Join-Path $artifacts "windows-$Scenario\verification.json") -Raw -Encoding UTF8
} finally {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
