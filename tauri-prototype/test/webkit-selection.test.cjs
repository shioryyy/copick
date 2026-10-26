'use strict';
// 锁住 Safari 的 WebKit 取词回退。这段代码存在的唯一理由是：Safari 27 不再提供
// AXSelectedText，只给 AXSelectedTextMarkerRange，而上游引擎两条路都不走。
// 2026-10-27 在真机上确认过：撤掉回退，verify:mac-safari 立刻失败并报“回退没有生效”。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Git 在 Windows runner 上按 autocrlf 检出为 CRLF，这里统一成 LF 再按行解析。
const source = fs.readFileSync(path.join(__dirname, '../src-tauri/native/bridge.mm'), 'utf8')
  .replace(/\r\n/g, '\n');

function body(signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must exist`);
  // 取到下一个顶格花括号结束的函数体。
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${signature} must be a complete function`);
  return source.slice(start, end);
}

test('reads the selection through WebKit text markers', () => {
  const reader = body('static bool ReadTextMarkerRange(');
  assert.match(reader, /AXSelectedTextMarkerRange/, 'Safari only exposes the selection through this attribute');
  assert.match(reader, /AXStringForTextMarkerRange/, 'the marker range itself is opaque; the text needs a second call');
  // 与其它来源保持同样的上限，避免把整篇文档当成选区写进剪贴板。
  assert.match(reader, /1024 \* 1024/);
  assert.match(reader, /find\('\\0'\)/, 'text containing NUL must be rejected, as everywhere else');
});

test('the fallback asks the focused element first and never walks the tree', () => {
  const reader = body('static bool ReadWebKitSelection(');
  const focused = reader.indexOf('kAXFocusedUIElementAttribute');
  const window = reader.indexOf('FocusedWindow(');
  assert.ok(focused !== -1 && window !== -1, 'both probes must exist');
  assert.ok(focused < window, 'the focused element carries the web area; the window is only a fallback');
  // 遍历整棵树会在每次拖选后增加不可控的延迟，这里刻意不做。
  assert.doesNotMatch(reader, /kAXChildrenAttribute/, 'no tree walk: capture runs after every drag');
  assert.match(reader, /AXUIElementSetMessagingTimeout\([^)]*0\.3\)/, 'a hung provider must not stall capture');
});

test('the fallback runs after the engine and overrides its text', () => {
  const capture = body('extern "C" bool cp_capture_begin(');
  const engine = capture.indexOf('engine.GetSelectedText(');
  const fallback = capture.indexOf('ReadWebKitSelection(');
  assert.ok(engine !== -1 && fallback !== -1, 'both paths must be present');
  assert.ok(engine < fallback, 'the engine stays the primary path');
  // 引擎在 Safari 里会返回窗口的文档 URL，所以标记范围有值时必须覆盖。
  const after = capture.slice(fallback);
  assert.match(after, /info\.text = std::move\(marked\)/, 'marker text must replace whatever the engine produced');
  assert.match(after, /info\.method = SelectionMethod::AXAPI/, 'method stays AXAPI: it is still an AX query');
  assert.match(after, /info\.posLevel = SelectionPositionLevel::None/, 'markers carry no coordinates; keep the mouse anchor');
});
