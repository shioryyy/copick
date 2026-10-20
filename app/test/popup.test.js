'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(copy) {
  const listeners = {}, attributes = {};
  const button = { dataset: {}, disabled: false,
    setAttribute: (name, value) => { attributes[name] = value; },
    addEventListener: (name, handler) => { listeners[name] = handler; } };
  const label = { textContent: '' };
  let select;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'popup.js'), 'utf8'), {
    document: { getElementById: id => id === 'copy' ? button : label },
    window: { copickPopup: { onSelection: callback => { select = callback; }, copy } }
  });
  return { button, label, attributes, select: value => select(value), click: () => listeners.click() };
}

test('复制成功显示确认并保持禁用，新选区恢复复制按钮', async () => {
  const h = harness(async () => true);
  h.select('first');
  await h.click();
  assert.equal(h.label.textContent, '已复制');
  assert.equal(h.button.dataset.state, 'copied');
  assert.equal(h.button.disabled, true);
  assert.equal(h.attributes['aria-label'], '已复制');
  h.select('second');
  assert.equal(h.label.textContent, '复制');
  assert.equal(h.button.dataset.state, 'ready');
  assert.equal(h.button.disabled, false);
});

test('复制失败或异常时允许重试', async () => {
  for (const copy of [async () => false, async () => { throw new Error('failed'); }]) {
    const h = harness(copy);
    h.select('first');
    await h.click();
    assert.equal(h.label.textContent, '重试');
    assert.equal(h.button.disabled, false);
  }
});

test('旧选区的复制结果不会覆盖新选区的按钮状态', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  h.select('first');
  const pending = h.click();
  h.select('second');
  resolve(true);
  await pending;
  assert.equal(h.label.textContent, '复制');
  assert.equal(h.button.dataset.state, 'ready');
  assert.equal(h.button.disabled, false);
});
