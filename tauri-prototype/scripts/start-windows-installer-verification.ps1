param(
    [string]$Installer = ''
)
# 安装包验证需要真实桌面：安装器要建窗口、产品启动时要建 WebView2。
# ssh 会话是 Session 0，创建 webview 会报「无效的窗口句柄」，所以必须走
# LogonType Interactive 的计划任务。这个脚本只负责注册、触发并取回结果。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskName = 'CopickTauriPrototypeInstallerVerify'
$artifacts = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
$script = Join-Path $PSScriptRoot 'verify-windows-installer.ps1'
$report = Join-Path $artifacts 'installer-verification.json'
Remove-Item $report -Force -ErrorAction SilentlyContinue
$log = Join-Path $artifacts ('installer-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '.log')

$arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $script + '"'
if ($Installer) { $arguments += ' -Installer "' + $Installer + '"' }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw "已有同名验证任务：$taskName" }
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
try {
    $started = Get-Date
    Start-ScheduledTask -TaskName $taskName
    $deadline = $started.AddMinutes(10)
    do {
        Start-Sleep -Seconds 3
        $task = Get-ScheduledTask -TaskName $taskName
        $info = Get-ScheduledTaskInfo -TaskName $taskName
        $finished = $info.LastRunTime -ge $started.AddSeconds(-1) -and $task.State -ne 'Running' -and $info.LastTaskResult -ne 267009
    } while (!$finished -and (Get-Date) -lt $deadline)
    if (!$finished) { Stop-ScheduledTask -TaskName $taskName; throw '安装包验证任务超时' }
    if (Test-Path $report) {
        # 报告是验证驱动写的 UTF-8 无 BOM JSON；PowerShell 5.1 需要显式指定编码才能正确显示中文。
        Get-Content $report -Raw -Encoding UTF8 | Write-Output
    }
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    Write-Host "task result: $($info.LastTaskResult)"
    if ($info.LastTaskResult -ne 0) { throw "安装包验证未通过（$($info.LastTaskResult)）" }
} finally {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
