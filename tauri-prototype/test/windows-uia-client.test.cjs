'use strict';
// 锁住 Windows 桥接的 UIA 客户端选择：只用 CUIAutomation8，失败就明确不初始化，
// 不在请求失败后退回另一套客户端。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bridge = fs.readFileSync(path.resolve(__dirname, '../src-tauri/native/bridge_win.cc'), 'utf8')
  .replace(/\r\n/g, '\n');
const build = fs.readFileSync(path.resolve(__dirname, '../src-tauri/build.rs'), 'utf8')
  .replace(/\r\n/g, '\n');

test('桥接只创建设计好的单一 UIA 客户端', () => {
  // 记事本是唯一已知分叉：CUIAutomation 给的是不提供 TextPattern 的 Edit，
  // CUIAutomation8 给的是 Document。两个客户端都建会让人误以为可以随时切换。
  assert.match(bridge, /CoCreateInstance\(CLSID_CUIAutomation8/);
  assert.doesNotMatch(bridge, /CLSID_CUIAutomation\b(?!8)/, 'legacy 客户端不应再被创建');
  assert.doesNotMatch(bridge, /windows_uia_policy\.h/);
});

test('客户端创建失败时明确不初始化，而不是静默降级', () => {
  // 静默退回另一个客户端会让同一个应用读出不同结果，调用方无法分辨。
  assert.match(bridge, /FAILED\(created\)/);
  assert.match(bridge, /CUIAutomation8 creation failed/);
  assert.match(bridge, /const bool ready = SUCCEEDED\(created\) && automation != nullptr;/);
});

test('每个请求只调用一次引擎，失败后不重试另一套', () => {
  // 失败后换客户端重试会绕过 non-text 短路，还可能重复触发剪贴板回退。
  assert.equal((bridge.match(/engine\.GetSelectedText\(/g) || []).length, 1);
  assert.doesNotMatch(bridge, /InvokeUiaClient|SelectUiaClient/);
});

test('保留来源、取消和结果校验', () => {
  assert.match(bridge, /ForegroundMatches\(request->source\)/);
  assert.match(bridge, /request->cancel\.load\(\)/);
  assert.match(bridge, /ToUtf8\(request->selection\.text, request->utf8\)/);
  assert.match(bridge, /GetProgramNameFromHwnd\(request->source\.hwnd, program\)/);
});

test('不再有构建期客户端开关', () => {
  assert.doesNotMatch(build, /COPICK_WINDOWS_UIA_MODE/);
  assert.doesNotMatch(bridge, /COPICK_WINDOWS_UIA_MODE/);
});
