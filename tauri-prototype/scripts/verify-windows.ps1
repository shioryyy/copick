param(
    [string]$Scenario = 'double',
    [string]$Executable = '',
    [int]$PrototypePid = 0,
    [string]$LogPath = ''
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$root = Split-Path -Parent $PSScriptRoot
$artifacts = Join-Path $root 'artifacts'
$node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$reportTool = Join-Path $PSScriptRoot 'verification-report.cjs'
$output = Join-Path $artifacts "windows-$Scenario"
$reportPath = Join-Path $output 'verification.json'
$guardianPath = Join-Path $output 'clipboard-guardian.json'
$guardianPidPath = Join-Path $output 'guardian-pid.txt'
& $node $reportTool prepare $reportPath
if ($LASTEXITCODE -ne 0) { throw '无法清理旧的 Windows 验证报告' }
# 上一轮的守护进程报告和 PID 同样不能被当成本次结果。
foreach ($stale in @($guardianPath, $guardianPidPath)) { if (Test-Path $stale) { Remove-Item $stale -Force } }
$compiler = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
$fixture = Join-Path $artifacts 'SelectionFixture.exe'
$automation = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\WPF'
& $compiler /nologo /target:winexe /platform:x64 /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll "/r:$automation\UIAutomationClient.dll" "/r:$automation\UIAutomationTypes.dll" "/r:$automation\WindowsBase.dll" "/out:$fixture" "$PSScriptRoot\verify-windows.cs" "$PSScriptRoot\windows-clipboard-guardian.cs"
if ($LASTEXITCODE -ne 0) { throw 'Windows 验证驱动编译失败' }
$app = $null
# 回退场景必须显式固定开关：Windows 平台默认已开启回退，只靠缺省值无法覆盖 disabled 分支。
$configDir = Join-Path $env:APPDATA 'local.copick.tauri'
$configPath = Join-Path $configDir 'config.json'
$configBackup = $null
$configTouched = $false
if (!$PrototypePid -and $Scenario -in @('fallback', 'fallback-disabled')) {
    if (Test-Path $configPath) { $configBackup = Get-Content $configPath -Raw }
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    # 必须写成无 BOM 的 UTF-8：serde_json 不接受 BOM，带 BOM 时会退回平台默认值，
    # 使 fallback-disabled 失去对照意义。
    $json = @{
        version = 1; paused = $false; clipboardFallback = ($Scenario -eq 'fallback')
        excludedApps = @(); diagnosticsEnabled = $true
    } | ConvertTo-Json
    [IO.File]::WriteAllText($configPath, $json)
    $configTouched = $true
}
if (!$PrototypePid) {
    if (!$Executable) { $Executable = Join-Path $root 'src-tauri\target\release\copick-tauri-prototype.exe' }
    if (!$LogPath) { $LogPath = Join-Path $artifacts ("prototype-$Scenario-" + [DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '.log') }
    $env:COPICK_PROTOTYPE_LOG = $LogPath
    $app = Start-Process $Executable -PassThru
    $PrototypePid = $app.Id
    Start-Sleep -Seconds 3
}
# fixture 被强杀或超时后，守护进程仍会走同一条恢复路径。这里核验它的报告
# 属于本轮 PID，并把结果写进产物，避免“测试失败但剪贴板无人确认”。
function Read-GuardianReport {
    if (!(Test-Path $guardianPath) -or !(Test-Path $guardianPidPath)) { return $null }
    $expectedPid = (Get-Content $guardianPidPath -Raw).Trim()
    $guardian = Get-Content $guardianPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (!($guardian.guardianPid -eq [int]$expectedPid)) { return $null }
    return $guardian
}
try {
    $arguments = '"' + $output + '" ' + $Scenario + ' ' + $PrototypePid
    $test = Start-Process $fixture -ArgumentList $arguments -PassThru
    # Retain the process handle so ExitCode remains available after a fast exit.
    $fixtureHandle = $test.Handle
    if (!$test.WaitForExit(25000)) {
        $test.Kill()
        $test.WaitForExit(5000)
        # 守护进程在管道断开后自行恢复；等待它的报告，而不是假定已经恢复。
        $deadline = (Get-Date).AddSeconds(30)
        do {
            Start-Sleep -Milliseconds 200
            $late = Read-GuardianReport
        } while ($null -eq $late -and (Get-Date) -lt $deadline)
        if ($null -ne $late) { $late | ConvertTo-Json -Depth 6 | Write-Output }
        throw '验证驱动超时；已核验守护进程恢复报告，见上方输出'
    }
    $fixtureExitCode = $test.ExitCode
    if ($null -eq $fixtureExitCode -or $fixtureExitCode -ne 0) {
        if (Test-Path $reportPath) { Get-Content $reportPath -Raw -Encoding UTF8 | Write-Output }
        throw "验证驱动退出失败：$fixtureExitCode"
    }
    $reportJson = & $node $reportTool read $reportPath $Scenario $fixtureExitCode $test.Id
    if ($LASTEXITCODE -ne 0) { throw 'Windows 验证报告缺失或不属于本次运行' }
    $report = $reportJson | ConvertFrom-Json
    # fixture 已自行核验过守护进程报告；这里再独立确认一次，避免报告被复用。
    $guardian = Read-GuardianReport
    if ($null -eq $guardian -or !$guardian.testClipboardRestored) {
        $report | Add-Member -NotePropertyName clipboardGuardianVerified -NotePropertyValue $false -Force
        $report.passed = $false
        if ($null -ne $guardian) { $guardian | ConvertTo-Json -Depth 6 | Write-Output }
    } else {
        $report | Add-Member -NotePropertyName clipboardGuardianVerified -NotePropertyValue $true -Force
    }
    if ($LogPath -and (Test-Path $LogPath)) {
        $events = Get-Content $LogPath -Encoding UTF8
        $match = [regex]::Matches(($events -join "`n"), 'method=(\d+)')
        if ($match.Count) {
            $method = [int]$match[$match.Count - 1].Groups[1].Value
            $report | Add-Member -NotePropertyName method -NotePropertyValue $method -Force
            if ($Scenario -eq 'fallback' -and $method -ne 99) { $report.passed = $false }
            if ($Scenario -in @('double', 'drag', 'background-drag') -and $method -eq 99) { $report.passed = $false }
        } elseif ($Scenario -in @('double', 'drag', 'background-drag', 'fallback')) { $report.passed = $false }
    } elseif ($Scenario -in @('double', 'drag', 'background-drag', 'fallback')) {
        $report.passed = $false
    }
    $report | ConvertTo-Json -Depth 6 | Set-Content $reportPath -Encoding UTF8
    $report | ConvertTo-Json -Depth 6
    if (!$report.passed) { throw 'Windows 核心链路验证未通过' }
} finally {
    if ($app -and !$app.HasExited) { $app.CloseMainWindow() | Out-Null; if (!$app.WaitForExit(5000)) { $app.Kill() } }
    # 验证改写过用户配置，必须还原到运行前的状态。
    if ($configTouched) {
        if ($null -eq $configBackup) { Remove-Item $configPath -Force -ErrorAction SilentlyContinue }
        else { [IO.File]::WriteAllText($configPath, $configBackup) }
    }
}
