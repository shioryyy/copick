'use strict';
// 真实第三方应用的取词矩阵驱动：编译 verify-macos-apps.mm + bridge.mm，
// 向目标应用发真实鼠标拖选，再用产品自己的 cp_capture_begin 取词。
//
// 必须以普通可执行文件运行、不能打包成 .app：辅助功能授权按 bundle 记录，
// 新 bundle 需要人工在系统设置里勾选，而 Terminal 的子进程直接继承 Terminal 的授权。
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { prepareReport, readReport } = require('./verification-report.cjs');

const root = path.resolve(__dirname, '..');
const source = path.resolve(root, '../app/node_modules/selection-hook/src/mac');
const mode = process.argv[2];
const output = path.join(root, 'artifacts', process.argv[3] || `app-${mode}`);
if (!['textedit', 'safari'].includes(mode)) {
  throw new Error(`Unknown app: ${mode}. Expected textedit or safari.`);
}
assert.equal(process.platform, 'darwin', 'Requires a real macOS desktop');
// 锁屏时前台应用是 loginwindow，来源校验无法放行；先明确拒绝而不是报“取词失败”。
require('./macos-desktop.cjs').requireUnlockedDesktop();

fs.mkdirSync(output, { recursive: true });
const executable = path.join(output, 'verify-macos-apps');
const compiled = spawnSync('clang++', [
  '-std=c++17', '-fno-objc-arc', '-fblocks', '-fexceptions', '-frtti',
  '-include', 'algorithm', '-include', 'cctype', '-I', source,
  path.join(__dirname, 'verify-macos-apps.mm'),
  path.join(root, 'src-tauri/native/bridge.mm'),
  path.join(source, 'core/engine.mm'),
  path.join(source, 'lib/utils.mm'),
  path.join(source, 'lib/clipboard.mm'),
  '-framework', 'Cocoa', '-framework', 'ApplicationServices', '-framework', 'WebKit',
  '-o', executable,
], { encoding: 'utf8' });
assert.ifError(compiled.error);
assert.equal(compiled.status, 0, compiled.stderr);

const reportPath = path.join(output, 'verification.json');
prepareReport(reportPath);
const result = spawnSync(executable, [output, mode], { stdio: 'inherit', timeout: 60000 });
assert.ifError(result.error);
assert.equal(result.signal, null, `App driver signalled: ${result.signal}`);
const report = readReport(reportPath, `app-${mode}`, result.status, result.pid);

// 剪贴板不能被这次测试弄脏。restoredVerified 是正常路径；
// skippedExternalChange 表示测试期间有别的进程写过剪贴板，守护进程按设计拒绝覆盖，
// 这同样是安全结果。indeterminate / restoreFailed 才说明可能留下了测试内容。
const guardian = report.clipboardRestoration || {};
const outcome = guardian.outcome;
assert.ok(
  guardian.testClipboardRestored === true || outcome === 'skippedExternalChange',
  `clipboard may have been left with test content: ${JSON.stringify(guardian)}`,
);
console.log(JSON.stringify({ ...report, exitCode: result.status, pid: result.pid }, null, 2));
console.log(`Artifacts: ${output}`);
