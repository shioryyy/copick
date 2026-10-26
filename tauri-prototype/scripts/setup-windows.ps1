$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root '.tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$env:CARGO_HOME = Join-Path $tools 'cargo'
$env:RUSTUP_HOME = Join-Path $tools 'rustup'
if (!(Test-Path "$env:CARGO_HOME\bin\rustc.exe")) {
    $download = Join-Path $tools 'rustup-download'
    New-Item -ItemType Directory -Force -Path $download | Out-Null
    & curl.exe --fail --location --max-time 180 'https://mirrors.ustc.edu.cn/rust-static/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' -o "$download\rustup-init.exe"
    if ($LASTEXITCODE -ne 0) { throw 'Rust 下载失败' }
    $env:RUSTUP_DIST_SERVER = 'https://mirrors.ustc.edu.cn/rust-static'
    $env:RUSTUP_UPDATE_ROOT = 'https://mirrors.ustc.edu.cn/rust-static/rustup'
    & "$download\rustup-init.exe" -y --no-modify-path --profile minimal --default-toolchain stable
    if ($LASTEXITCODE -ne 0) { throw 'Rust 安装失败' }
}
& "$env:CARGO_HOME\bin\rustc.exe" --version
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$vs = if (Test-Path $vswhere) { & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }
if (!$vs) {
    $download = Join-Path $tools 'buildtools-download'
    New-Item -ItemType Directory -Force -Path $download | Out-Null
    & curl.exe --fail --location --max-time 180 'https://aka.ms/vs/17/release/vs_BuildTools.exe' -o "$download\vs_BuildTools.exe"
    if ($LASTEXITCODE -ne 0) { throw 'C++ 构建工具下载失败' }
    $install = Start-Process "$download\vs_BuildTools.exe" -ArgumentList '--wait --quiet --norestart --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.26100' -PassThru -Wait
    if ($install.ExitCode -ne 0 -and $install.ExitCode -ne 3010) { throw "C++ 构建工具安装失败：$($install.ExitCode)" }
}
Write-Output 'COPICK_WINDOWS_TOOLS_READY'
