'use strict';
const paused = document.getElementById('paused');
const fallback = document.getElementById('fallback');
const blacklist = document.getElementById('blacklist');
const message = document.getElementById('message');
let dirty = false;
function render(value, force = false) {
  if (!dirty || force) {
    paused.checked = value.paused;
    fallback.checked = value.clipboardFallback;
    blacklist.value = value.blacklist.join('\n');
    dirty = false;
  }
  document.getElementById('status').textContent = value.error || (value.paused ? '已暂停' : '正在监听选区');
  document.getElementById('protected').textContent = `完全跳过：${value.protectedPrograms.join(' / ')}。仅禁止快捷键回退：${value.noClipboardPrograms.join(' / ')}。`;
  document.getElementById('recent').textContent = value.lastProgram ? `最近取词应用：${value.lastProgram}` : '还没有取词记录。';
  document.getElementById('config-path').textContent = `设置保存于 ${value.configPath}`;
  const access = document.getElementById('mac-accessibility');
  if (access) access.hidden = value.accessibility === null || value.accessibility === true;
}
document.getElementById('settings').addEventListener('input', () => { dirty = true; message.textContent = '尚未保存'; });
document.getElementById('settings').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const result = await window.copickSettings.save({ paused: paused.checked,
      clipboardFallback: fallback.checked, blacklist: blacklist.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean) });
    render(result.state, result.ok);
    message.textContent = result.ok ? '已保存' : result.error;
  } catch { message.textContent = '保存失败，请重新打开设置后重试。'; }
  finally { button.disabled = false; }
});
window.copickSettings.onState(value => render(value));
const accessibilityButton = document.getElementById('open-accessibility');
if (accessibilityButton) accessibilityButton.addEventListener('click', () => window.copickSettings.openAccessibility());
window.copickSettings.read().then(value => render(value, true)).catch(() => { message.textContent = '无法读取设置，请重启 Copick。'; });
