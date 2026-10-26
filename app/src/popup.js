'use strict';
const button = document.getElementById('copy');
const label = document.getElementById('copy-label');
let token = null;
window.copickPopup.onSelection(value => {
  token = value;
  button.disabled = false;
  button.dataset.state = 'ready';
  button.setAttribute('aria-label', '复制选中的文字');
  label.textContent = '复制';
  // 让重置后的样式经过一个绘制周期，隐藏窗口也需保持帧回调运行。
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (token === value) window.copickPopup.ready(value).catch(() => {});
  }));
});
button.addEventListener('pointerdown', event => event.preventDefault());
button.addEventListener('click', async () => {
  if (!token) return;
  const attempted = token;
  button.disabled = true;
  try {
    const ok = await window.copickPopup.copy(attempted);
    if (token !== attempted) return;
    if (ok) {
      button.dataset.state = 'copied';
      button.setAttribute('aria-label', '已复制');
      label.textContent = '已复制';
    } else label.textContent = '重试';
  } catch { if (token === attempted) label.textContent = '重试'; }
  finally { if (token === attempted) button.disabled = button.dataset.state === 'copied'; }
});
