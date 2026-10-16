'use strict';
const button = document.getElementById('copy');
let token = null;
window.copickPopup.onSelection(value => {
  token = value;
  button.disabled = false;
  button.textContent = '复制';
});
button.addEventListener('pointerdown', event => event.preventDefault());
button.addEventListener('click', async () => {
  if (!token) return;
  const attempted = token;
  button.disabled = true;
  try {
    const ok = await window.copickPopup.copy(attempted);
    if (!ok && token === attempted) button.textContent = '重试';
  } catch { if (token === attempted) button.textContent = '重试'; }
  finally { if (token === attempted) button.disabled = false; }
});
