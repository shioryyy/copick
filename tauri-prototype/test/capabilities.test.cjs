'use strict';
// 设置页靠 __TAURI__.event.listen 接收主进程事件（close-blocked、settings-changed）。
// Tauri 2 的核心命令受 ACL 控制，缺少能力文件时 listen 会被拒绝，
// 而前端为了不让订阅失败打断加载吞掉了这个错误——关闭确认和托盘停用会静默失效。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'src-tauri', 'capabilities', 'default.json');

test('control window may subscribe to core events', () => {
  const capability = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(capability.windows.includes('control'), '能力必须覆盖 control 窗口');
  const granted = capability.permissions.some(permission =>
    permission === 'core:default' || permission === 'core:event:default' || permission === 'core:event:allow-listen');
  assert.ok(granted, '必须授予 core:event:default（或等价的 listen 权限）');
});

test('no AppleDouble sidecar shadows the capability', () => {
  const directory = path.dirname(file);
  const strays = fs.readdirSync(directory).filter(name => name.startsWith('._'));
  assert.deepEqual(strays, [], '源码包不应带上 macOS 的 ._ 附属文件');
});
