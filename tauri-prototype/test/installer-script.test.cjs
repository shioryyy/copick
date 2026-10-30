'use strict';
// 锁住安装包验证驱动的几条硬约束。这些都是真机上踩出来的，改错会静默变成“验证通过”。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../scripts/verify-windows-installer.cs'), 'utf8')
  .replace(/\r\n/g, '\n');
const launcher = fs.readFileSync(path.join(__dirname, '../scripts/start-windows-installer-verification.ps1'), 'utf8')
  .replace(/\r\n/g, '\n');

test('the launch-at-login check drives the real toggle instead of faking config', () => {
  // 产品只在用户点设置页开关时写注册表，不读配置里的启动项字段。
  // 早期版本靠写一份“已开启”的配置来验证，结果永远测不到真正的写入路径。
  assert.match(source, /Toggle\(startup\)/, 'the toggle must be clicked');
  assert.match(source, /launchAtLoginToggleOff/, 'turning it back off must be verified too');
  assert.match(source, /--background/, 'the stored command must carry --background, or login pops the settings window');
});

test('the app is started without --background so the settings window exists', () => {
  // 用 --background 启动时设置窗口不显示，UIA 找不到开关，验证会误报。
  const start = source.match(/Process\.Start\(new ProcessStartInfo\(exe\)[^)]*\)/);
  assert.ok(start, 'the product must be started to obtain its settings window');
  assert.doesNotMatch(source, /new ProcessStartInfo\(exe, "--background"\) \{ UseShellExecute = false \}\);[\s\S]{0,400}FindWindow/,
    'starting with --background would leave no window to automate');
});

test('the uninstall verdict is based on the files, not the NSIS exit code', () => {
  // NSIS 卸载器会先把自己复制到临时目录再运行，退出码不可靠。
  assert.match(source, /uninstalled = !File\.Exists\(exe\)/);
});

test('GUI verification runs in an interactive session, never over ssh', () => {
  // ssh 落在 Session 0，创建 WebView2 会报“无效的窗口句柄”。
  assert.match(launcher, /LogonType Interactive/);
  assert.match(launcher, /Register-ScheduledTask/);
});
