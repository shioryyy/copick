'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { prepareReport, readReport } = require('./verification-report.cjs');
const root = path.resolve(__dirname, '..');
assert.equal(process.platform, 'darwin', 'Requires macOS NSPasteboard');
const output = path.join(root, 'artifacts', process.argv[2] || `native-copy-gate-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const executable = path.join(output, 'CopickCopyGateFixture');
const compiled = spawnSync('clang++', ['-std=c++17', '-fno-objc-arc', '-pthread', '-Wall', '-Wextra', '-Werror',
  '-I', path.join(root, 'src-tauri/native'), path.join(__dirname, 'verify-macos-copy-gate.mm'),
  '-framework', 'Cocoa', '-o', executable], { encoding: 'utf8', timeout: 30000 });
assert.ifError(compiled.error);
assert.equal(compiled.status, 0, compiled.stderr);
const reportPath = path.join(output, 'verification.json');
prepareReport(reportPath);
// Do not impose a kill timeout on the process holding the clipboard backup.
// External process termination or hung pasteboard IPC still cannot guarantee restoration.
const result = spawnSync(executable, [output], { stdio: 'inherit' });
assert.ifError(result.error);
assert.equal(result.signal, null, `Native harness signalled: ${result.signal}`);
const report = readReport(reportPath, 'native-copy-gate', result.status, result.pid);
assert.equal(report.passed, true, report.result);
assert.equal(report.testClipboardRestored, true);
assert.equal(report.cases.length, 5);
console.log(JSON.stringify({ ...report, fixtureExitCode: result.status, fixturePid: result.pid }, null, 2));
console.log(`Artifacts: ${output}`);
