'use strict';

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const release = path.join(root, 'src-tauri', 'target', 'release');
const artifacts = path.join(root, 'artifacts');
const output = path.join(artifacts, 'release');
const binaryName = 'copick-tauri-prototype';

function requirePath(file, directory = false) {
  const stat = fs.statSync(file);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Unexpected artifact type: ${file}`);
  return file;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000, ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(executable)} failed (exit ${result.status}, signal ${result.signal}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function smokeTest(executable) {
  const stdout = run(executable, ['--smoke-test'], { timeout: 30000 });
  let result;
  try { result = JSON.parse(stdout.trim()); }
  catch { throw new Error(`Smoke test did not return JSON: ${stdout}`); }
  if (result?.ok !== true) throw new Error(`Smoke test did not return ok: true: ${stdout}`);
  console.log(`Smoke test passed: ${JSON.stringify(result)}`);
}

function zipWindows(directory, destination) {
  // Keep paths out of PowerShell source; -LiteralPath also handles wildcard characters.
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; $files = @(Get-ChildItem -LiteralPath $env:COPICK_PACKAGE_SOURCE -File | ForEach-Object { $_.FullName }); Compress-Archive -LiteralPath $files -DestinationPath $env:COPICK_PACKAGE_ZIP -CompressionLevel Optimal"], {
    env: { ...process.env, COPICK_PACKAGE_SOURCE: directory, COPICK_PACKAGE_ZIP: destination },
  });
}

function main() {
  const platform = process.platform;
  const architecture = { darwin: 'arm64', win32: 'x64' }[platform];
  if (!architecture || process.arch !== architecture) {
    throw new Error('Build and package natively on macOS arm64 or Windows x64.');
  }
  if (process.argv.length !== 2 || process.env.CARGO_TARGET_DIR || process.env.CARGO_BUILD_TARGET) {
    throw new Error('Package expects the default native release build in src-tauri/target/release; custom target directories, build targets and package arguments are unsupported.');
  }
  if (config.productName !== 'Copick Tauri' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(config.version)) {
    throw new Error('Expected productName Copick Tauri and a valid version in tauri.conf.json.');
  }

  fs.mkdirSync(artifacts, { recursive: true });
  const staging = fs.mkdtempSync(path.join(artifacts, 'package-'));
  const packages = path.join(staging, 'release');
  fs.mkdirSync(packages);
  try {
    const names = [];
    const version = config.version;
    if (platform === 'darwin') {
      const app = requirePath(path.join(release, 'bundle', 'macos', `${config.productName}.app`), true);
      requirePath(path.join(app, 'Contents', 'Resources', 'NOTICE-selection-hook.txt'));
      smokeTest(requirePath(path.join(app, 'Contents', 'MacOS', binaryName)));
      const name = `Copick-Tauri-${version}-mac-arm64.zip`;
      run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, path.join(packages, name)]);
      names.push(name);
    } else {
      const installers = path.join(release, 'bundle', 'nsis');
      const candidates = fs.readdirSync(installers).filter(name => name.toLowerCase().endsWith('.exe'));
      if (candidates.length !== 1) throw new Error(`Expected exactly one NSIS installer in ${installers}; clean old bundles and rebuild.`);
      const installer = requirePath(path.join(installers, candidates[0]));
      const portable = path.join(staging, 'portable');
      fs.mkdirSync(portable);
      const executable = path.join(portable, `${binaryName}.exe`);
      fs.copyFileSync(requirePath(path.join(release, `${binaryName}.exe`)), executable);
      fs.copyFileSync(requirePath(path.join(root, 'src-tauri', 'NOTICE-selection-hook.txt')), path.join(portable, 'NOTICE-selection-hook.txt'));
      smokeTest(executable);
      const zip = `Copick-Tauri-${version}-win-x64.zip`;
      const setup = `Copick-Tauri-Setup-${version}-win-x64.exe`;
      zipWindows(portable, path.join(packages, zip));
      fs.copyFileSync(installer, path.join(packages, setup));
      names.push(zip, setup);
    }
    const sums = names.map(name => {
      const hash = createHash('sha256').update(fs.readFileSync(requirePath(path.join(packages, name)))).digest('hex');
      return `${hash}  ${name}\n`;
    }).join('');
    fs.writeFileSync(path.join(packages, 'SHA256SUMS.txt'), sums, 'utf8');
    // Replace only the release directory owned by this script, after every check succeeds.
    fs.rmSync(output, { recursive: true, force: true });
    fs.renameSync(packages, output);
    console.log(`Release artifacts: ${output}\n${sums}`);
    console.log('Signing is not performed by this script. Default builds have no trusted code signature; macOS builds are not notarized. Configure and verify signing separately before claiming otherwise.');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

try { main(); }
catch (error) {
  console.error(`Packaging failed: ${error.message}`);
  process.exitCode = 1;
}
