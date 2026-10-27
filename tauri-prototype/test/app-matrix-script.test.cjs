'use strict';
// 锁住真实应用矩阵驱动的几条硬约束。每一条都是真机上排查出来的：
// 改错不会报错，只会让矩阵静默变成「通过」，比失败更危险。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../scripts/verify-windows-apps.cs'), 'utf8')
  .replace(/\r\n/g, '\n');
// 注释里会提到 Clipboard.SetText（解释为什么不能用它），断言只看可执行代码。
const code = source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
const launcher = fs.readFileSync(path.join(__dirname, '../scripts/verify-windows-apps.ps1'), 'utf8')
  .replace(/\r\n/g, '\n');
const matrix = fs.readFileSync(path.join(__dirname, '../scripts/start-windows-app-matrix.ps1'), 'utf8')
  .replace(/\r\n/g, '\n');

test('the clipboard is seeded with a sentinel before clicking the popup', () => {
  // 产品在 worker 线程异步写剪贴板。不放哨兵就会读到上一轮残留，
  // 「复制成功」和「复制落空」看起来一模一样。
  assert.match(source, /copick-sentinel-/, 'a sentinel must be written before the click');
  assert.match(source, /clipboardUntouched/, 'the report must distinguish sentinel from real text');
});

test('the sentinel uses Win32 clipboard calls, not .NET Clipboard', () => {
  // .NET Clipboard.SetText 是 OLE 延迟渲染：产品的 EmptyClipboard 要等驱动渲染完，
  // 实测把复制打成 2 秒超时（COPICK_COPY_TIMEOUT），看起来像产品缺陷。
  assert.match(source, /SetClipboardData\(CF_UNICODETEXT/, 'the sentinel must be written with SetClipboardData');
  assert.doesNotMatch(code, /Clipboard\.SetText/, 'OLE-based Clipboard.SetText stalls the product copy');
  assert.doesNotMatch(code, /Clipboard\.ContainsText/, 'reading through OLE has the same problem');
});

test('a popup alone is not evidence: the clipboard text must come from the document', () => {
  // Edge 场景里误拖到地址栏也会弹窗，剪贴板里就是 URL。只判「有浮窗」等于没测。
  assert.match(source, /FromDocument\(/, 'clipboard text must be checked against the document');
  assert.match(source, /expected\.IndexOf\(squashed/, 'the comparison must tolerate tags and truncation');
  assert.match(source, /copied && fromDocument/, 'the copy verdict must require both popup and content');
});

test('the drag origin comes from UIA rather than fixed pixels', () => {
  // Word 打开导航窗格时正文从客户区 46% 处才开始；写死坐标会落在窗格里。
  assert.match(source, /TryFindContentRect/, 'the driver must locate the content control');
  assert.match(source, /ControlType\.Document/, 'Document and Edit are the text-bearing control types');
});

test('the driver is DPI aware, so UIA and client rects share a coordinate space', () => {
  // UIA 的 BoundingRectangle 用物理像素，GetClientRect 默认逻辑像素；
  // 150% 缩放下 1265 宽的窗口会算出 1803 的右边界，拖拽点整个偏掉。
  assert.match(source, /SetProcessDPIAware/, 'without this the two coordinate spaces diverge');
});

test('the expected text is saved before the target app opens the document', () => {
  // Word 独占打开文档，驱动事后读会抛 IOException，
  // 结果是「验证脚本自己失败」而不是「取词失败」。
  assert.match(launcher, /compat-expected\.txt/, 'a copy of the expected text must be kept');
  assert.match(source, /documentText/, 'the driver must compare against the pre-read copy');
});

test('compile failures stop the run instead of reusing the previous driver', () => {
  // 曾经因为缺 WindowsBase 引用编译失败，脚本继续用旧 exe 跑，
  // 报告里的字段和源码完全对不上。
  assert.match(launcher, /驱动编译失败/, 'a failed compile must abort');
  assert.match(launcher, /Test-Path \$driver/, 'a missing driver must abort too');
});

test('the matrix runs in an interactive session, never over ssh', () => {
  // ssh 落在 Session 0，产品建不了 WebView2，拖选也打不到真实窗口。
  assert.match(matrix, /LogonType Interactive/);
  assert.match(matrix, /Register-ScheduledTask/);
});
