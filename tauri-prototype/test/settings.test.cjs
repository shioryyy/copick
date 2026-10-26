'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../ui/settings-model.js');

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function settings(overrides = {}) {
  return {
    config: { version: 1, excludedApps: ['terminal'], diagnosticsEnabled: false, clipboardFallback: false },
    fallbackAvailable: true,
    startupEnabled: false, startupAvailable: true, startupError: null, configError: null,
    migratedFromElectron: false, version: '1.2.3', ...overrides
  };
}
function status(overrides = {}) {
  return { permission: true, running: true, paused: false, fallback: false,
    selections: 0, presented: 0, copies: 0, focusPreserved: null, error: null, ...overrides };
}
function harness(userAgent = 'Macintosh') {
  const calls = [], timers = [];
  const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');
  const elements = {};
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const listeners = {};
    elements[match[1]] = {
      value: '', checked: false, textContent: '', disabled: /\bdisabled\b/.test(match[0]),
      hidden: /\bhidden\b/.test(match[0]), attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { listeners[name] = callback; },
      fire(name) { return listeners[name]({ preventDefault() {} }); }
    };
  }
  const window = { CopickSettings: model, __TAURI__: { core: { invoke(command, args) {
    const reply = deferred();
    calls.push({ command, args, ...reply });
    return reply.promise;
  } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/control.js'), 'utf8'), {
    window, document: { getElementById: id => elements[id] }, navigator: { userAgent },
    setInterval(callback, interval) { timers.push({ callback, interval }); }
  });
  return {
    elements, window, calls, timers,
    named: command => calls.filter(call => call.command === command),
    edit(text) { elements['excluded-apps'].value = text; elements['excluded-apps'].fire('input'); },
    poll() { return timers[0].callback(); }
  };
}
async function loaded(h, info = settings()) {
  h.named('settings')[0].resolve(info);
  h.named('status')[0].resolve(status());
  await flush();
}

test('排除列表兼容 CRLF，trim、小写去重并忽略空行', () => {
  assert.deepEqual(model.parseExcludedApps(' Terminal \r\n\nCOM.Apple.Terminal\nterminal\n浏览器 '),
    ['terminal', 'com.apple.terminal', '浏览器']);
  assert.deepEqual(model.parseExcludedApps(''), []);
});
test('校验 Unicode 字符长度、200 项边界和控制字符', () => {
  assert.equal(model.parseExcludedApps('😀'.repeat(128))[0].length, 256);
  assert.throws(() => model.parseExcludedApps('😀'.repeat(129)), /128/);
  const hundred = Array.from({ length: 200 }, (_, index) => `app${index}`).join('\n');
  assert.equal(model.parseExcludedApps(hundred).length, 200);
  assert.equal(model.parseExcludedApps(`${hundred}\nAPP0`).length, 200);
  assert.throws(() => model.parseExcludedApps(`${hundred}\nextra`), /200/);
  for (const value of ['/Applications/App', 'folder\\app', '*.exe', 'app?']) {
    assert.throws(() => model.parseExcludedApps(value), /路径或通配符/);
  }
  for (const code of [0, 9, 11, 13, 31, 127, 128, 159]) {
    assert.throws(() => model.parseExcludedApps(`app${String.fromCharCode(code)}`), /控制字符/);
  }
});
test('配置快照独立复制并忽略 paused，诊断与回退值必须是布尔值', () => {
  const source = { version: 1, excludedApps: ['Terminal'], diagnosticsEnabled: false, clipboardFallback: true, paused: true };
  const snapshot = model.copyConfig(source);
  source.excludedApps.push('new');
  assert.deepEqual(snapshot, { version: 1, excludedApps: ['Terminal'], diagnosticsEnabled: false, clipboardFallback: true });
  assert.throws(() => model.readSettings(settings({ config: { ...snapshot, diagnosticsEnabled: 'false' } })), /配置格式/);
  assert.throws(() => model.readSettings(settings({ config: { ...snapshot, clipboardFallback: 'true' } })), /配置格式/);
});
test('加载原始配置，轮询只更新监听状态，不覆盖草稿', async () => {
  const h = harness();
  assert.equal(h.elements.save.disabled, true);
  assert.equal(h.elements.diagnostics.checked, false);
  await loaded(h, settings({ migratedFromElectron: true, configError: '读取旧配置失败' }));
  assert.equal(h.elements['excluded-apps'].value, 'terminal');
  assert.equal(h.elements.version.textContent, '1.2.3');
  assert.equal(h.elements['migration-note'].hidden, false);
  assert.match(h.elements['config-error'].textContent, /读取旧配置失败/);
  assert.equal(h.elements.save.disabled, false, '允许保存以修复损坏的配置文件');
  h.edit('unsaved');
  h.elements.diagnostics.checked = true;
  h.elements.diagnostics.fire('change');
  const polling = h.poll();
  h.named('status')[1].resolve(status({ paused: true, running: false }));
  await polling;
  assert.equal(h.elements['excluded-apps'].value, 'unsaved');
  assert.equal(h.elements.diagnostics.checked, true);
  assert.equal(h.elements.pause.textContent, '恢复监听');
  assert.equal(h.named('settings').length, 1);
  assert.equal(h.timers[0].interval, 1000);
});
test('加载失败显示原错误且可重试，失败前禁止保存空配置', async () => {
  const h = harness();
  h.named('settings')[0].reject('配置读取失败');
  h.named('status')[0].resolve(status());
  await flush();
  assert.match(h.elements['settings-action-error'].textContent, /配置读取失败/);
  assert.equal(h.elements.save.disabled, true);
  assert.equal(h.elements['reload-settings'].hidden, false);
  const retry = h.elements['reload-settings'].fire('click');
  h.named('settings')[1].resolve(settings());
  await retry;
  assert.equal(h.elements['excluded-apps'].disabled, false);
  assert.equal(h.elements['settings-action-error'].hidden, true);
});
test('无效设置禁止保存，但仍可撤销', async () => {
  const h = harness();
  await loaded(h);
  h.edit('a\tb');
  await h.elements['settings-form'].fire('submit');
  assert.equal(h.named('save_settings').length, 0);
  assert.equal(h.elements.save.disabled, true);
  assert.equal(h.elements.revert.disabled, false);
  assert.match(h.elements['exclusions-error'].textContent, /控制字符/);
  h.elements.revert.fire('click');
  assert.equal(h.elements['excluded-apps'].value, 'terminal');
  assert.equal(h.elements['exclusions-error'].hidden, true);
});
test('保存规范化配置，期间锁定重复提交；以服务端返回值建立撤销基线', async () => {
  const h = harness();
  await loaded(h);
  h.edit(' Safari \nSAFARI\ncom.apple.Terminal');
  h.elements.diagnostics.checked = true;
  const saving = h.elements['settings-form'].fire('submit');
  await h.elements['settings-form'].fire('submit');
  const call = h.named('save_settings')[0];
  assert.deepEqual(JSON.parse(JSON.stringify(call.args)), { config: {
    version: 1, excludedApps: ['safari', 'com.apple.terminal'], diagnosticsEnabled: true, clipboardFallback: false
  } });
  assert.equal(h.named('save_settings').length, 1);
  for (const id of ['save', 'revert', 'startup', 'excluded-apps', 'diagnostics', 'clipboard-fallback', 'quit']) {
    assert.equal(h.elements[id].disabled, true, id);
  }
  call.resolve(settings({ config: { version: 1, excludedApps: ['normalized'], diagnosticsEnabled: true, clipboardFallback: true } }));
  await saving;
  assert.equal(h.elements['excluded-apps'].value, 'normalized');
  assert.equal(h.elements.save.disabled, true);
  h.edit('new');
  h.elements.revert.fire('click');
  assert.equal(h.elements['excluded-apps'].value, 'normalized');
  assert.equal(h.elements.diagnostics.checked, true);
});
test('保存失败保留草稿，轮询成功也保留错误，撤销回加载的配置', async () => {
  const h = harness();
  await loaded(h);
  h.edit('new');
  const saving = h.elements['settings-form'].fire('submit');
  h.named('save_settings')[0].reject('磁盘只读');
  await saving;
  assert.equal(h.elements['excluded-apps'].value, 'new');
  assert.equal(h.elements.save.disabled, false);
  const polling = h.poll();
  h.named('status')[1].resolve(status());
  await polling;
  assert.match(h.elements['settings-action-error'].textContent, /磁盘只读/);
  h.elements.revert.fire('click');
  assert.equal(h.elements['excluded-apps'].value, 'terminal');
});
test('启动设置返回其他配置时也不替换草稿或撤销基线', async () => {
  const h = harness();
  await loaded(h);
  h.edit('new');
  h.elements.diagnostics.checked = true;
  h.elements.startup.checked = true;
  const changing = h.elements.startup.fire('change');
  h.named('set_startup')[0].resolve(settings({ startupEnabled: true,
    config: { version: 1, excludedApps: ['unrelated'], diagnosticsEnabled: true, clipboardFallback: true } }));
  await changing;
  assert.equal(h.elements['excluded-apps'].value, 'new');
  assert.equal(h.elements.diagnostics.checked, true);
  assert.equal(h.elements['clipboard-fallback'].checked, false, '开机启动响应不得覆盖回退草稿');
  assert.equal(h.elements.startup.checked, true);
  h.elements.revert.fire('click');
  assert.equal(h.elements['excluded-apps'].value, 'terminal');
  assert.equal(h.elements.diagnostics.checked, false);
  assert.equal(h.elements.startup.checked, true);
});
test('开机启动异常回滚复选框并显示错误，不支持时禁用', async () => {
  const h = harness();
  await loaded(h);
  h.elements.startup.checked = true;
  const changing = h.elements.startup.fire('change');
  h.named('set_startup')[0].reject('拒绝访问');
  await changing;
  assert.equal(h.elements.startup.checked, false);
  assert.match(h.elements['startup-error'].textContent, /拒绝访问/);
  const unsupported = harness();
  await loaded(unsupported, settings({ startupAvailable: false, startupError: '不支持' }));
  assert.equal(unsupported.elements.startup.disabled, true);
  assert.match(unsupported.elements['startup-error'].textContent, /不支持/);
});
test('回退开关仅在支持平台可用，改动进入草稿并可保存', async () => {
  const unsupported = harness();
  await loaded(unsupported, settings({ fallbackAvailable: false }));
  assert.equal(unsupported.elements['clipboard-fallback'].disabled, true);
  assert.match(unsupported.elements['fallback-hint'].textContent, /始终关闭/);

  const h = harness();
  await loaded(h, settings({ fallbackAvailable: true }));
  assert.equal(h.elements['clipboard-fallback'].disabled, false);
  assert.equal(h.elements.save.disabled, true);
  h.elements['clipboard-fallback'].checked = true;
  h.elements['clipboard-fallback'].fire('change');
  assert.equal(h.elements.save.disabled, false, '回退改动进入草稿');
  const saving = h.elements['settings-form'].fire('submit');
  const call = h.named('save_settings')[0];
  assert.equal(call.args.config.clipboardFallback, true);
  call.resolve(settings({ config: { version: 1, excludedApps: ['terminal'],
    diagnosticsEnabled: false, clipboardFallback: true } }));
  await saving;
  assert.equal(h.elements['clipboard-fallback'].checked, true);
  assert.equal(h.elements.save.disabled, true);
});
test('迟到的轮询不能覆盖暂停结果；configure 只提交暂停意图', async () => {
  const h = harness();
  await loaded(h);
  const polling = h.poll();
  const pausing = h.elements.pause.fire('click');
  await h.elements.pause.fire('click');
  assert.equal(h.named('configure').length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.named('configure')[0].args)), { paused: true });
  h.named('configure')[0].resolve(status({ paused: true, running: false }));
  await pausing;
  h.named('status')[1].resolve(status());
  await polling;
  assert.equal(h.elements.pause.textContent, '恢复监听');
  assert.match(h.elements.status.textContent, /已暂停/);
});
test('未获得权限时仍可暂停和恢复监听', async () => {
  const h = harness();
  h.named('settings')[0].resolve(settings());
  h.named('status')[0].resolve(status({ permission: false, running: false }));
  await flush();
  assert.equal(h.elements.pause.disabled, false);
  const pausing = h.elements.pause.fire('click');
  const pauseCall = h.named('configure')[0];
  assert.deepEqual(JSON.parse(JSON.stringify(pauseCall.args)), { paused: true });
  pauseCall.resolve(status({ permission: false, running: false, paused: true }));
  await pausing;
  assert.equal(h.elements.pause.disabled, false);
  assert.equal(h.elements.pause.textContent, '恢复监听');
  const resuming = h.elements.pause.fire('click');
  const resumeCall = h.named('configure')[1];
  assert.deepEqual(JSON.parse(JSON.stringify(resumeCall.args)), { paused: false });
  resumeCall.resolve(status({ permission: false, running: false }));
  await resuming;
  assert.equal(h.elements.pause.disabled, false);
  assert.equal(h.elements.pause.textContent, '暂停监听');
});
test('轮询不重入；监听操作失败不被下次状态轮询清除', async () => {
  const h = harness();
  await loaded(h);
  const first = h.poll();
  await h.poll();
  assert.equal(h.named('status').length, 2);
  h.named('status')[1].resolve(status());
  await first;
  const checking = h.elements.permission.fire('click');
  h.named('permission')[0].reject('权限检查失败');
  await checking;
  const polling = h.poll();
  h.named('status')[2].resolve(status());
  await polling;
  assert.match(h.elements['listener-error'].textContent, /权限检查失败/);
});
test('日志命令的 void 响应不会作为状态渲染，退出错误可见且按钮解锁', async () => {
  const h = harness();
  await loaded(h);
  const opening = h.elements['open-logs'].fire('click');
  h.named('open_logs')[0].resolve(undefined);
  await opening;
  assert.match(h.elements['app-message'].textContent, /日志文件夹/);
  assert.match(h.elements.status.textContent, /原生监听运行中/);
  const quitting = h.elements.quit.fire('click');
  h.named('quit')[0].reject('退出受阻');
  await quitting;
  assert.match(h.elements['app-error'].textContent, /退出受阻/);
  assert.equal(h.elements.quit.disabled, false);
});
test('Windows 保留检查监听状态按钮名称，macOS 保留权限与暂停按钮 ID', () => {
  const h = harness('Windows');
  assert.equal(h.elements.permission.textContent, '检查监听状态');
  assert.equal(h.elements['excluded-apps'].placeholder, '例如：notepad.exe');
  const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');
  assert.match(html, /id="permission"[^>]*>检查辅助功能权限</);
  assert.match(html, /id="pause"[^>]*>暂停监听</);
  assert.doesNotMatch(html, /id="fallback"|id="selections"|id="copies"/);
});
