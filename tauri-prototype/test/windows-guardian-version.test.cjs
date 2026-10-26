'use strict';
// 锁住 Windows 剪贴板版本判据：这些规则由 2026-10-25 在 OMEN 上的实测确定，
// 且每一条都曾被写错并导致真实失败。这里用纯数据复现判据，不接触真实剪贴板。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../scripts/windows-clipboard-guardian.cs'), 'utf8');

function body(name) {
  const start = source.indexOf(name);
  assert.notEqual(start, -1, `${name} must exist`);
  // 取到下一个空行前的花括号块，足够做结构断言。
  const end = source.indexOf('\n    }\n', start);
  assert.notEqual(end, -1, `${name} must be a complete method`);
  return source.slice(start, end);
}

test('version checks never compare clipboard sequence numbers', () => {
  // 一次写入让序列号前进约 5 次（EmptyClipboard +1、SetClipboardData +1、
  // CloseClipboard +3），因此任何“序列号相等/恰好 +1”的判据都恒为假。
  for (const name of ['static bool ClaimAccepted(', 'static bool StillOwned(', 'static bool SameTextVersion(', 'static RestoreResult Restore(']) {
    const text = body(name);
    assert.doesNotMatch(text, /Sequence\s*==/, `${name} must not compare sequence for equality`);
    // 只拦“序列号参与算术”的表达式；诊断字符串里的拼接不算判据。
    assert.doesNotMatch(text, /Sequence\s*\+\s*\d/, `${name} must not do sequence arithmetic`);
    assert.doesNotMatch(text, /\d\s*\+\s*[^"]*Sequence/, `${name} must not do sequence arithmetic`);
  }
});

test('text comparison decodes UTF-16 to NUL instead of comparing raw lengths', () => {
  // GlobalAlloc 块大小向上对齐，读回长度可能大于请求长度。
  const text = body('static bool TextEquals(');
  assert.match(text, /DecodeText\(/, 'TextEquals must decode before comparing');
  assert.doesNotMatch(text, /Count\s*!=\s*1/, 'synthesized CF_TEXT/CF_LOCALE make a fixed format count invalid');
});

test('ownership claim requires the product confirmation flag, allowed text and the product pid', () => {
  const claim = body('static bool ClaimAccepted(');
  assert.match(claim, /productPid/, 'claim must check the owner pid');
  assert.match(claim, /TextEquals\(/, 'claim must check the text content');
  const run = body('public static int Run(');
  assert.match(run, /productCopyConfirmed/, 'claim path must require product confirmation');
  assert.match(run, /allowed/, 'claim path must restrict the expected text');
});

test('restore verifies formats and owner inside a single clipboard lock', () => {
  const restore = body('static RestoreResult Restore(');
  const open = restore.indexOf('OpenOwned(');
  const close = restore.indexOf('CloseClipboard()');
  const check = restore.indexOf('SameTextVersion(');
  const write = restore.indexOf('WriteFormats(');
  const verify = restore.indexOf('FormatsCover(after');
  assert.ok(open !== -1 && close !== -1 && check !== -1 && write !== -1 && verify !== -1, 'restore must do all steps');
  assert.ok(open < check && check < write && write < verify && verify < close,
    'check, write and read-back must all happen between OpenClipboard and CloseClipboard');
});

test('the guardian refuses to run without a complete backup', () => {
  const run = body('public static int Run(');
  const snapshot = run.indexOf('TakeSnapshot(out error)');
  const sentinel = run.indexOf('TryWriteSentinel(');
  assert.ok(snapshot !== -1 && sentinel !== -1 && snapshot < sentinel,
    'backup must be taken before any test write');
  assert.match(run, /outcome = "untouched"/, 'an unwritten clipboard must be reported as untouched');
});

test('the fixture refuses to start on Session 0', () => {
  const harness = fs.readFileSync(path.join(__dirname, '../scripts/verify-windows-guardian.cs'), 'utf8');
  assert.match(harness, /RequireInteractiveSession/, 'harness must check the session');
  assert.match(harness, /SessionId != 0/, 'Session 0 has no user clipboard');
});

// 2026-10-25 在 OMEN 上实测：所有者进程不泵消息时，另一个进程的
// EmptyClipboard 阻塞 5001ms；泵消息时只需 13ms。守护进程持有 sentinel
// 所有权，因此它在等待命令期间必须处理 WM_DESTROYCLIPBOARD，否则产品
// 自己的复制会卡到 2 秒截止时间并误报失败。
test('the guardian pumps messages while waiting for commands', () => {
  assert.match(source, /static void PumpMessages\(\)/, 'guardian must expose a message pump');
  assert.match(source, /PeekMessage\(/, 'pumping requires PeekMessage');
  assert.match(source, /DispatchMessage\(/, 'pumping requires DispatchMessage');
  // 命令读取不能阻塞主线程，否则泵不到消息。
  const reader = body('internal sealed class CommandReader');
  assert.match(reader, /new Thread\(/, 'command reading must happen off the clipboard thread');
  assert.match(reader, /PumpMessages\(\)/, 'the waiting loop must pump messages');
  const run = body('public static int Run(');
  assert.match(run, /new CommandReader\(/, 'the guardian loop must use the pumping reader');
  assert.doesNotMatch(run, /ReadCommand\(commandPipe/, 'blocking reads on the clipboard thread would stall the pump');
});
