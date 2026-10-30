param(
    [ValidateSet('notepad', 'cmd', 'edge', 'word', 'vscode')][string]$App = 'notepad',
    [string]$Executable = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$artifacts = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
$compiler = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$driver = Join-Path $artifacts 'AppCompatibility.exe'
# UIAutomation 的托管包装在 WPF 引用目录里；BoundingRectangle 返回 System.Windows.Rect，
# 还需要 WindowsBase。
$uia = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\WPF'
& $compiler /nologo /target:exe /platform:x64 /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll `
    /r:"$uia\UIAutomationClient.dll" /r:"$uia\UIAutomationTypes.dll" /r:"$uia\WindowsBase.dll" `
    "/out:$driver" "$PSScriptRoot\verify-windows-apps.cs"
# 编译失败必须立刻停：否则会继续用上一次的旧驱动，测出来的结果和源码无关。
if ($LASTEXITCODE -ne 0 -or !(Test-Path $driver)) { throw '真实应用兼容性驱动编译失败' }

if (!$Executable) { $Executable = Join-Path $root 'src-tauri\target\release\copick-tauri-prototype.exe' }
$configDir = Join-Path $env:APPDATA 'local.copick.tauri'
$configPath = Join-Path $configDir 'config.json'
$configBackup = $null
$haveBackup = Test-Path $configPath
if ($haveBackup) { $configBackup = Get-Content $configPath -Raw }
# 必须无 BOM，否则 serde_json 会回落到平台默认值，禁用回退的对照就失效了。
function Set-Fallback([bool]$enabled) {
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    $json = @{ version = 1; paused = $false; clipboardFallback = $enabled
        excludedApps = @(); diagnosticsEnabled = $true } | ConvertTo-Json
    [IO.File]::WriteAllText($configPath, $json)
}

$targetProcess = $null
$sample = Join-Path $artifacts 'compat-sample.txt'
# 期望文本必须在被测应用打开文档之前单独留一份：Word 会独占打开源文件，
# 驱动事后去读会抛 IOException，整个场景就变成“验证失败”而不是“取词失败”。
$expected = Join-Path $artifacts 'compat-expected.txt'
$text = "Copick compatibility sample text for accessibility capture`r`nSecond line for double click"
if ($App -eq 'edge') {
    $page = Join-Path $artifacts 'compat-edge.html'
    [IO.File]::WriteAllText($page, "<!doctype html><meta charset=`"utf-8`"><title>CopickCompat</title><body style=`"font:24px sans-serif;padding:40px`">Copick compatibility sample text for accessibility capture<br>Second line for double click</body>", (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText($expected, $text, (New-Object Text.UTF8Encoding($false)))
    $targetProcess = Start-Process msedge.exe -ArgumentList @('--no-first-run', $page) -PassThru
    $script:title = 'CopickCompat'
    $script:document = $expected
    Start-Sleep -Seconds 4
} elseif ($App -eq 'word') {
    # Word 用 RichEdit 类控件，UIA 走 TextPattern；标题会变成文档名加 " - Word"。
    [IO.File]::WriteAllText($sample, $text + "`r`n", (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText($expected, $text, (New-Object Text.UTF8Encoding($false)))
    $targetProcess = Start-Process winword.exe -ArgumentList ('"' + $sample + '"') -PassThru
    $script:title = 'compat-sample'
    $script:document = $expected
} elseif ($App -eq 'vscode') {
    # VS Code 的 Monaco 默认不建无障碍树，必须先打开 editor.accessibilitySupport。
    # 这里只对本次测试的临时用户配置生效，不改动用户已有设置。
    # 已在运行的 VS Code 会复用旧进程并忽略刚写的设置，必须全部关掉。
    Get-Process 'Code', 'Code - Insiders' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 800
    $vscodeSettings = Join-Path $env:APPDATA 'Code\User\settings.json'
    $vscodeBackup = $null
    if (Test-Path $vscodeSettings) { $vscodeBackup = Get-Content $vscodeSettings -Raw }
    New-Item -ItemType Directory -Force -Path (Split-Path $vscodeSettings) | Out-Null
    [IO.File]::WriteAllText($vscodeSettings, '{"editor.accessibilitySupport":"on"}', (New-Object Text.UTF8Encoding($false)))
    $script:vscodeBackup = $vscodeBackup
    [IO.File]::WriteAllText($sample, $text + "`r`n", (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText($expected, $text, (New-Object Text.UTF8Encoding($false)))
    # settings.json 里的 editor.accessibilitySupport 只影响编辑器的 ARIA 层；
    # --force-renderer-accessibility 才会打开 Chromium 的无障碍树，UIA 才看得见。
    $targetProcess = Start-Process code.exe -ArgumentList @('--new-window', '--disable-extensions', '--force-renderer-accessibility', $sample) -PassThru
    $script:title = 'compat-sample'
    $script:document = $expected
} elseif ($App -eq 'notepad') {
    [IO.File]::WriteAllText($sample, $text + "`r`n", (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText($expected, $text, (New-Object Text.UTF8Encoding($false)))
    $targetProcess = Start-Process notepad.exe -ArgumentList $sample -PassThru
    $script:title = 'compat-sample'
    $script:document = $expected
} else {
    $bat = Join-Path $artifacts 'compat-cmd.bat'
    [IO.File]::WriteAllText($bat, "@echo off`r`ntitle CopickCompat`r`necho Copick compatibility sample text`r`ncmd /k`r`n", (New-Object Text.ASCIIEncoding))
    $targetProcess = Start-Process $bat -WindowStyle Normal -PassThru
    $script:title = 'CopickCompat'
}
Start-Sleep -Seconds 2

function Invoke-Run([string]$Expect, [string]$Name) {
    $report = Join-Path $artifacts "apps-$Name.json"
    $clipboardFile = Join-Path $artifacts "apps-$Name.txt"
    if (Test-Path $clipboardFile) { Remove-Item $clipboardFile -Force }
    # 空字符串会被驱动当成“传了文档参数但内容为空”，必须整个参数省略。
    $arguments = @($report, $script:prototype.Id, $script:title, $Expect, $clipboardFile)
    if ($script:document) { $arguments += $script:document }
    $output = & $driver @arguments
    $line = @($output | Where-Object { $_ -and $_.ToString().Trim().StartsWith('{') })
    if (!$line.Count) { throw "兼容性驱动没有输出 JSON：$($output -join ' ')" }
    [Console]::WriteLine($line[-1])
    $parsed = $line[-1] | ConvertFrom-Json
    $expectedClipboard = if (Test-Path $clipboardFile) { (Get-Content $clipboardFile -Raw).Trim() } else { $null }
    return [pscustomobject]@{ report = $parsed; clipboard = $expectedClipboard }
}

function Read-Method([string]$Path) {
    if (!(Test-Path $Path)) { return $null }
    $events = Get-Content $Path -Encoding UTF8
    $match = [regex]::Matches(($events -join "`n"), 'method=(\d+)')
    if (!$match.Count) { return $null }
    return [int]$match[$match.Count - 1].Groups[1].Value
}

function Read-Capture([string]$Path) {
    if (!(Test-Path $Path)) { return $false }
    return [bool]((Get-Content $Path -Encoding UTF8) -match 'COPICK_SELECTION_RECEIVED|COPICK_POPUP_PRESENTED')
}

$results = @{}
try {
    if ($App -ne 'cmd') {
        # 先关掉回退，单独判定无障碍取词；失败再打开回退复测。
        Set-Fallback $false
        $script:logPath = Join-Path $artifacts ("apps-$App-direct-" + [DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '.log')
        $env:COPICK_PROTOTYPE_LOG = $script:logPath
        $script:prototype = Start-Process $Executable -ArgumentList '--background' -PassThru
        Start-Sleep -Seconds 3
        $direct = Invoke-Run 'popup' ($App + '-direct')
        $method = Read-Method $script:logPath
        $results['accessibility'] = [pscustomobject]@{
            passed = $direct.report.passed; method = $method; clipboard = $direct.clipboard
        }
        Stop-Process -Id $script:prototype.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500

        Set-Fallback $true
        $script:logPath = Join-Path $artifacts ("apps-$App-fallback-" + [DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '.log')
        $env:COPICK_PROTOTYPE_LOG = $script:logPath
        $script:prototype = Start-Process $Executable -ArgumentList '--background' -PassThru
        Start-Sleep -Seconds 3
        $fallback = Invoke-Run 'popup' ($App + '-fallback')
        $results['withFallback'] = [pscustomobject]@{
            passed = $fallback.report.passed; method = (Read-Method $script:logPath); clipboard = $fallback.clipboard
        }
        Stop-Process -Id $script:prototype.Id -Force -ErrorAction SilentlyContinue
    } else {
        # 终端应在任何取词路径之前被全局过滤：连选区请求都不应出现。
        Set-Fallback $true
        $script:logPath = Join-Path $artifacts ('apps-cmd-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '.log')
        $env:COPICK_PROTOTYPE_LOG = $script:logPath
        $script:prototype = Start-Process $Executable -ArgumentList '--background' -PassThru
        Start-Sleep -Seconds 3
        $blocked = Invoke-Run 'none' 'cmd'
        $results['blocked'] = [pscustomobject]@{
            passed = $blocked.report.passed; captured = (Read-Capture $script:logPath)
        }
        Stop-Process -Id $script:prototype.Id -Force -ErrorAction SilentlyContinue
    }
} finally {
    if ($targetProcess -and !$targetProcess.HasExited) { Stop-Process -Id $targetProcess.Id -Force -ErrorAction SilentlyContinue }
    Get-Process copick-tauri-prototype -ErrorAction SilentlyContinue | Stop-Process -Force
    if ($haveBackup) { [IO.File]::WriteAllText($configPath, $configBackup) }
    else { Remove-Item $configPath -Force -ErrorAction SilentlyContinue }
    if ($App -eq 'vscode') {
        $vscodeSettings = Join-Path $env:APPDATA 'Code\User\settings.json'
        if ($script:vscodeBackup) { [IO.File]::WriteAllText($vscodeSettings, $script:vscodeBackup) }
        else { Remove-Item $vscodeSettings -Force -ErrorAction SilentlyContinue }
    }
}
$results | ConvertTo-Json -Depth 5
# 无障碍取词失败但回退可用时，矩阵记 ❌/✅，脚本本身按“至少一条路径可用”判定通过。
$ok = if ($App -eq 'cmd') { $results['blocked'].passed -and !$results['blocked'].captured } else { $results['withFallback'].passed }
if (!$ok) { throw "真实应用兼容性验证未通过：$App" }
