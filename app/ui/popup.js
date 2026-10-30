'use strict';
const { invoke } = window.__TAURI__.core;
const button = document.getElementById('copy');
const label = document.getElementById('copy-label');
let token = null;
let revision = 0;
let copying = false;
let presented = false;
let copied = false;

async function select(value, state = {}) {
  if (value === token) return;
  token = value;
  const current = ++revision;
  copying = Boolean(state.copying);
  copied = Boolean(state.copied);
  presented = false;
  button.disabled = true;
  button.dataset.state = copied ? 'copied' : 'ready';
  label.textContent = copied ? '已复制' : '复制';
  button.setAttribute('aria-label', copied ? '已复制' : '复制选中的文字');
  if (!value || copied) return;
  try {
    const shown = await invoke('present', { token: value });
    if (current !== revision) return;
    presented = shown;
    button.disabled = !shown || copying || copied;
  } catch {
    if (current === revision) button.disabled = true;
  }
}

async function refresh() {
  const current = revision;
  try {
    const state = await invoke('popup_state');
    if (current === revision) select(state.token, state);
  } catch {
    if (current === revision) button.disabled = true;
  }
}
button.addEventListener('pointerdown', event => event.preventDefault());
button.addEventListener('click', async () => {
  if (!token || !presented || copying || copied || button.disabled) return;
  const current = revision;
  const attempted = token;
  copying = true;
  button.disabled = true;
  try {
    const ok = await invoke('copy_selection', { token: attempted });
    if (current !== revision) return;
    copied = ok;
    label.textContent = ok ? '已复制' : '重试';
    button.dataset.state = ok ? 'copied' : 'ready';
    button.setAttribute('aria-label', ok ? '已复制' : '重试复制');
    button.disabled = ok;
  } catch (error) {
    if (current !== revision) return;
    const uncertain = error && typeof error === 'string' && error.includes('可能已改变');
    label.textContent = uncertain ? '请检查剪贴板' : '重试';
    button.setAttribute('aria-label', uncertain ? '请检查剪贴板' : '重试复制');
    button.disabled = uncertain;
  } finally {
    if (current === revision) copying = false;
  }
});
// WKWebView 隐藏时会暂停计时器和 rAF；由原生 eval 唤起并提交重置后的按钮状态。
window.copickSelection = value => select(value);
refresh();
