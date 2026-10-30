'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { prepareReport, readReport } = require('./verification-report.cjs');
const root = path.resolve(__dirname, '..');
assert.equal(process.platform, 'darwin', 'Requires macOS WKWebView');
const output = path.join(root, 'artifacts', process.argv[2] || `first-frame-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const bundle = path.join(output, 'CopickFirstFrameFixture.app/Contents');
const executable = path.join(bundle, 'MacOS/CopickFirstFrameFixture');
fs.mkdirSync(path.dirname(executable), { recursive: true });
fs.writeFileSync(path.join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>CopickFirstFrameFixture</string><key>CFBundleIdentifier</key><string>local.test.copick-first-frame</string><key>CFBundleName</key><string>CopickFirstFrameFixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>
`);
const native = path.join(root, 'src-tauri/native');
const source = path.resolve(root, 'node_modules/selection-hook/src/mac');
const compiled = spawnSync('clang++', ['-std=c++17', '-fno-objc-arc', '-fblocks', '-fexceptions', '-frtti', '-pthread',
  '-include', 'algorithm', '-include', 'cctype', '-I', native, '-I', source,
  path.join(__dirname, 'verify-macos-first-frame.mm'), path.join(native, 'bridge.mm'),
  path.join(source, 'core/engine.mm'), path.join(source, 'lib/utils.mm'), path.join(source, 'lib/clipboard.mm'),
  '-framework', 'Cocoa', '-framework', 'ApplicationServices', '-framework', 'WebKit', '-o', executable],
{ encoding: 'utf8', timeout: 60000 });
assert.ifError(compiled.error);
assert.equal(compiled.status, 0, compiled.stderr);
const reportPath = path.join(output, 'verification.json');
prepareReport(reportPath);
// No selection AX access or clipboard use. This tests page reset/show snapshot ordering.
const result = spawnSync(executable, [output, path.join(root, 'ui')], { stdio: 'inherit', timeout: 20000 });
assert.ifError(result.error);
assert.equal(result.signal, null, `First-frame harness signalled: ${result.signal}`);
const report = readReport(reportPath, 'popup-first-frame', result.status, result.pid);
assert.equal(report.passed, true, report.result);
console.log(JSON.stringify({ ...report, fixtureExitCode: result.status, fixturePid: result.pid }, null, 2));
console.log(`Artifacts: ${output}`);
