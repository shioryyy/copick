'use strict';
// 多显示器浮窗定位回归：编译 bridge.mm 到原生夹具，逐屏检查锚点与工作区。
// 需要至少两块屏幕的真实 macOS 桌面；单屏机器会明确报未执行。
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { prepareReport, readReport } = require('./verification-report.cjs');
const root = path.resolve(__dirname, '..');
const source = path.resolve(root, 'node_modules/selection-hook/src/mac');
const output = path.join(root, 'artifacts', process.argv[2] || 'native-displays');
assert.equal(process.platform, 'darwin', 'Requires a real macOS desktop');
// 锁屏时前台应用是 loginwindow，来源校验无法放行；先明确拒绝而不是报“定位失败”。
require('./macos-desktop.cjs').requireUnlockedDesktop();
fs.mkdirSync(output, { recursive: true });
const bundle = path.join(root, 'artifacts/native-display-fixture/CopickNativeDisplayFixture.app/Contents');
const executable = path.join(bundle, 'MacOS/CopickNativeDisplayFixture');
fs.mkdirSync(path.dirname(executable), { recursive: true });
fs.writeFileSync(path.join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>CopickNativeDisplayFixture</string><key>CFBundleIdentifier</key><string>local.test.copick-native-display-fixture</string><key>CFBundleName</key><string>CopickNativeDisplayFixture</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/></dict></plist>
`);
const compiled = spawnSync('clang++', ['-std=c++17', '-fno-objc-arc', '-fblocks', '-fexceptions', '-frtti',
  '-include', 'algorithm', '-include', 'cctype', '-I', source,
  path.join(__dirname, 'verify-macos-displays.mm'), path.join(root, 'src-tauri/native/bridge.mm'),
  path.join(source, 'core/engine.mm'), path.join(source, 'lib/utils.mm'), path.join(source, 'lib/clipboard.mm'),
  '-framework', 'Cocoa', '-framework', 'ApplicationServices', '-framework', 'WebKit', '-o', executable],
{ encoding: 'utf8' });
assert.ifError(compiled.error);
assert.equal(compiled.status, 0, compiled.stderr);
const reportPath = path.join(output, 'verification.json');
prepareReport(reportPath);
// 夹具只做窗口定位，不读写剪贴板，也不需要辅助功能授权。
const result = spawnSync(executable, [output], { stdio: 'inherit', timeout: 20000 });
assert.ifError(result.error);
assert.equal(result.signal, null, `Native harness signalled: ${result.signal}`);
const report = readReport(reportPath, 'native-displays', result.status, result.pid);
assert.equal(report.passed, true, report.result);
assert.equal(report.clipboardTouched, false);
console.log(JSON.stringify({ ...report, fixtureExitCode: result.status, fixturePid: result.pid }, null, 2));
console.log(`Artifacts: ${output}`);
