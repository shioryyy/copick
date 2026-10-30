'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.resolve(root, 'node_modules/selection-hook/src/mac');
const bundle = path.join(root, 'artifacts/fixture/CopickFixture.app/Contents');
const executable = path.join(bundle, 'MacOS/CopickFixture');
const output = path.join(root, 'artifacts', process.argv[2] || 'verification');
const { prepareReport, readReport } = require('./verification-report.cjs');
const scenario = process.env.COPICK_VERIFY_MODE || 'double';
const reportPath = path.join(output, 'verification.json');
if (process.platform !== 'darwin') throw new Error('此验证驱动需要真实 macOS 桌面。');
require('./macos-desktop.cjs').requireUnlockedDesktop();
fs.mkdirSync(path.dirname(executable), { recursive: true });
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>CopickFixture</string><key>CFBundleIdentifier</key><string>local.test.selection-fixture</string><key>CFBundleName</key><string>CopickFixture</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/></dict></plist>
`);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run('clang++', ['-std=c++17', '-fno-objc-arc', '-fblocks', '-include', 'algorithm', '-include', 'cctype', '-I', source,
  path.join(__dirname, 'verify-macos.mm'), path.join(source, 'lib/clipboard.mm'),
  '-framework', 'Cocoa', '-framework', 'ApplicationServices', '-o', executable]);
prepareReport(reportPath);
for (const marker of ['provider-entered', 'provider-returned']) fs.rmSync(path.join(output, marker), { force: true });
const result = spawnSync(executable, [output], { stdio: 'inherit', timeout: 25000 });
if (result.error) throw result.error;
const report = readReport(reportPath, scenario, result.status, result.pid);
console.log(JSON.stringify(report, null, 2));
process.exit(report.passed ? 0 : 1);
