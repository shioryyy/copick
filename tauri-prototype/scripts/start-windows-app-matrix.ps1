param(
    [ValidateSet('notepad', 'cmd', 'edge', 'word', 'vscode')][string]$App = 'edge'
)
# 真实应用矩阵必须走交互桌面：ssh 是 Session 0，产品建不了 WebView2，
# 拖选也打不到真实窗口。这个脚本只负责注册、触发并取回结果。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskName = "CopickAppMatrix-$App"
$artifacts = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
$script = Join-Path $PSScriptRoot 'verify-windows-apps.ps1'
$log = Join-Path $artifacts ("appmatrix-$App-" + [DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '.log')

$arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $script + '" -App ' + $App
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 6)
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
try {
    $started = Get-Date
    Start-ScheduledTask -TaskName $taskName
    $deadline = $started.AddMinutes(6)
    do {
        Start-Sleep -Seconds 3
        $task = Get-ScheduledTask -TaskName $taskName
        $info = Get-ScheduledTaskInfo -TaskName $taskName
        $finished = $info.LastRunTime -ge $started.AddSeconds(-1) -and $task.State -ne 'Running' -and $info.LastTaskResult -ne 267009
    } while (!$finished -and (Get-Date) -lt $deadline)
    if (!$finished) { Stop-ScheduledTask -TaskName $taskName; throw "应用矩阵验证任务超时：$App" }
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    Write-Host "task result: $($info.LastTaskResult)"
    # 结果 JSON 由 verify-windows-apps.ps1 打印在任务输出里；任务计划不保留 stdout，
    # 所以直接读它写出的报告文件。
    Get-ChildItem $artifacts -Filter "apps-$App-*.json" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 2 |
        ForEach-Object { Write-Host "== $($_.Name)"; Get-Content $_.FullName -Raw -Encoding UTF8 }
    if ($info.LastTaskResult -ne 0) { throw "应用矩阵验证未通过：$App（$($info.LastTaskResult)）" }
} finally {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
