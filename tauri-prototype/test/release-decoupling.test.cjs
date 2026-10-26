'use strict';
// 锁住「Electron 发布不被 Tauri 构建拖死」这条规则。
// 背景：Tauri 版是旁路构建，默认产物不挂 Release；如果它在打 tag 时失败，
// 正式版的发布不能被一起拦下。但一旦开启 COPICK_PUBLISH_TAURI，Tauri 产物
// 就是发布内容，失败必须拦住。这两条正好互为反例，改动其中一条时容易破坏另一条。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Git 在 Windows runner 上按 autocrlf 检出为 CRLF，本机是 LF。
const source = fs.readFileSync(path.join(__dirname, '../../.github/workflows/release.yml'), 'utf8')
  .replace(/\r\n/g, '\n');

// 取出某个顶层作业（两空格缩进）的完整文本。
function job(name) {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `${name} job must exist`);
  const rest = source.slice(start + 1);
  // 下一个两空格缩进的键就是兄弟作业。
  const next = rest.slice(1).search(/\n {2}[a-zA-Z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

// 取出作业里的一个折叠标量（`if: >-` 之类）并压成一行，便于做语义断言。
function folded(text, key) {
  const match = text.match(new RegExp(`\\n    ${key}: >-?\\n((?:      .*\\n)+)`));
  assert.ok(match, `${key} must be a folded scalar`);
  return match[1].split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
}

test('publish still waits for the Tauri job so artifacts are complete', () => {
  // 解耦的是“失败是否阻塞”，不是“是否等待”。不等的话 Tauri 产物可能还没上传。
  assert.match(job('publish'), /\n    needs: \[build, tauri\]\n/);
});

test('a failed Tauri build does not block the Electron release by default', () => {
  const condition = folded(job('publish'), 'if');
  assert.match(condition, /always\(\)/, 'without always() a failed need skips the job');
  assert.match(condition, /needs\.build\.result == 'success'/, 'the Electron build must still gate publishing');
  assert.match(condition, /needs\.tauri\.result == 'success' \|\| vars\.COPICK_PUBLISH_TAURI != 'true'/,
    'Tauri may only block publishing when its packages are actually attached');
});

test('the publish condition is a truth table over build, Tauri and the attach flag', () => {
  // 把条件的字符串求值成布尔值，直接验证四种组合，而不是用正则猜语义。
  const condition = folded(job('publish'), 'if')
    .replace('always()', 'true')
    .replace('needs.build.result', 'build')
    .replace('needs.tauri.result', 'tauri')
    .replace('vars.COPICK_PUBLISH_TAURI', 'attach');
  const run = new Function('build', 'tauri', 'attach', `return (${condition});`);
  const cases = [
    // 默认：Tauri 挂了不影响 Electron 发布。
    ['success', 'failure', 'false', true, 'attached=false, Tauri failed → still publish'],
    ['success', 'skipped', undefined, true, 'no variable set at all → still publish'],
    // 开了挂载：Tauri 是发布内容的一部分，失败必须拦住。
    ['success', 'failure', 'true', false, 'attached=true, Tauri failed → block'],
    ['success', 'success', 'true', true, 'attached=true, Tauri ok → publish'],
    // Electron 自己失败永远不发布，与 Tauri 无关。
    ['failure', 'success', 'false', false, 'Electron build failed → block'],
  ];
  for (const [build, tauri, attach, expected, why] of cases) {
    assert.equal(run(build, tauri, attach), expected, why);
  }
});

test('a skipped Tauri build leaves a visible warning in the release run', () => {
  // 发布成功但重构版没通过时，不能让维护者以为一切正常。
  const publish = job('publish');
  assert.match(publish, /TAURI_RESULT: \$\{\{ needs\.tauri\.result \}\}/);
  assert.match(publish, /::warning::Tauri 构建结果/);
});
