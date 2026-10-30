'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { prepareReport, readReport } = require('./verification-report.cjs');
const root = path.resolve(__dirname, '..');
const source = path.resolve(root, 'node_modules/selection-hook/src/mac');
const output = path.join(root, 'artifacts', process.argv[2] || `native-show-failure-${Date.now()}`);
assert.equal(process.platform, 'darwin', 'Requires a real macOS desktop');
fs.mkdirSync(output, { recursive: true });
const bundle = path.join(root, 'artifacts/native-show-fixture/CopickNativeShowFixture.app/Contents');
const executable = path.join(bundle, 'MacOS/CopickNativeShowFixture');
fs.mkdirSync(path.dirname(executable), { recursive: true });
fs.writeFileSync(path.join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>CopickNativeShowFixture</string><key>CFBundleIdentifier</key><string>local.test.copick-native-show-fixture</string><key>CFBundleName</key><string>CopickNativeShowFixture</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/></dict></plist>
`);
const compiled = spawnSync('clang++', ['-std=c++17', '-fno-objc-arc', '-fblocks', '-fexceptions', '-frtti',
  '-include', 'algorithm', '-include', 'cctype', '-I', source,
  path.join(__dirname, 'verify-macos-show.mm'), path.join(root, 'src-tauri/native/bridge.mm'),
  path.join(source, 'core/engine.mm'), path.join(source, 'lib/utils.mm'), path.join(source, 'lib/clipboard.mm'),
  '-framework', 'Cocoa', '-framework', 'ApplicationServices', '-framework', 'WebKit', '-o', executable],
{ encoding: 'utf8' });
assert.ifError(compiled.error);
assert.equal(compiled.status, 0, compiled.stderr);
const reportPath = path.join(output, 'verification.json');
prepareReport(reportPath);
// This harness never reads or writes clipboard contents and needs no AX access.
const result = spawnSync(executable, [output], { stdio: 'inherit', timeout: 10000 });
assert.ifError(result.error);
assert.equal(result.signal, null, `Native harness signalled: ${result.signal}`);
const report = readReport(reportPath, 'native-show-failure', result.status, result.pid);
assert.equal(report.passed, true, report.result);
assert.equal(report.clipboardTouched, false);
console.log(JSON.stringify({ ...report, fixtureExitCode: result.status, fixturePid: result.pid }, null, 2));
console.log(`Artifacts: ${output}`);
