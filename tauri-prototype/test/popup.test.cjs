'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const listeners = {}, calls = [];
  const button = { disabled: true, dataset: {}, setAttribute() {},
    addEventListener: (name, handler) => { listeners[name] = handler; } };
  const label = { textContent: '' };
  const window = { __TAURI__: { core: { invoke: (command, args) => {
    const reply = deferred();
    calls.push({ command, args, ...reply });
    return reply.promise;
  } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/popup.js'), 'utf8'), {
    window, document: { getElementById: id => id === 'copy' ? button : label }
  });
  return { button, label, calls, select: value => window.copickSelection(value),
    click: () => listeners.click(), named: command => calls.filter(call => call.command === command) };
}
async function shown(h, token) {
  h.select(token);
  h.named('present').at(-1).resolve(true);
  await flush();
}

test('展示成功回执前禁止复制，失败保持禁用', async () => {
  const h = harness();
  h.select('first');
  const click = h.click();
  assert.equal(h.named('copy_selection').length, 0);
  await click;
  h.named('present')[0].resolve(false);
  await flush();
  assert.equal(h.button.disabled, true);
});
test('迟到的初始快照不能覆盖原生推送的新选区', async () => {
  const h = harness();
  await shown(h, 'new');
  h.named('popup_state')[0].resolve({ token: 'old', copying: false, copied: false });
  await flush();
  assert.equal(h.named('present').length, 1);
  h.click();
  assert.equal(h.named('copy_selection')[0].args.token, 'new');
});
test('重复的同一 token 不重复展示，也不清除已复制反馈', async () => {
  const h = harness();
  await shown(h, 'first');
  const copy = h.click();
  h.named('copy_selection')[0].resolve(true);
  await copy;
  h.select('first');
  assert.equal(h.named('present').length, 1);
  assert.equal(h.label.textContent, '已复制');
  assert.equal(h.button.disabled, true);
});
test('旧复制异常不能覆盖新选区或解锁新复制请求', async () => {
  const h = harness();
  await shown(h, 'first');
  const first = h.click();
  await shown(h, 'second');
  const second = h.click();
  assert.equal(h.named('copy_selection').length, 2);
  h.named('copy_selection')[0].reject(new Error('old failure'));
  await first;
  assert.equal(h.label.textContent, '复制');
  assert.equal(h.button.disabled, true);
  await h.click();
  assert.equal(h.named('copy_selection').length, 2);
  h.named('copy_selection')[1].resolve(true);
  await second;
  assert.equal(h.label.textContent, '已复制');
});
test('旧展示回执和快照异常不修改新选区', async () => {
  const h = harness();
  h.select('old');
  await shown(h, 'new');
  h.named('present')[0].resolve(false);
  h.named('popup_state')[0].reject(new Error('old snapshot'));
  await flush();
  assert.equal(h.button.disabled, false);
});
test('复制结果不确定时禁止盲目重试并提示检查剪贴板', async () => {
  const h = harness();
  await shown(h, 'first');
  const copying = h.click();
  h.named('copy_selection')[0].reject('复制已进入提交或完成，无法撤销；剪贴板可能已改变。');
  await copying;
  assert.equal(h.label.textContent, '请检查剪贴板');
  assert.equal(h.button.disabled, true);
  await h.click();
  assert.equal(h.named('copy_selection').length, 1);
});

test('当前复制失败可以重试，成功后拒绝重复点击', async () => {
  const h = harness();
  await shown(h, 'first');
  const failed = h.click();
  h.named('copy_selection')[0].resolve(false);
  await failed;
  assert.equal(h.label.textContent, '重试');
  assert.equal(h.button.disabled, false);
  const retry = h.click();
  h.named('copy_selection')[1].resolve(true);
  await retry;
  await h.click();
  assert.equal(h.named('copy_selection').length, 2);
  assert.equal(h.button.disabled, true);
});
