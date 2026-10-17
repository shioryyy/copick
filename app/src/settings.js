'use strict';
const paused = document.getElementById('paused');
const fallback = document.getElementById('fallback');
const launch = document.getElementById('launch');
const blacklist = document.getElementById('blacklist');
const message = document.getElementById('message');
let dirty = false;
function render(value, force = false) {
  if (!dirty || force) {
    paused.checked = value.paused;
    fallback.checked = value.clipboardFallback;
    launch.checked = value.launchAtLogin;
    blacklist.value = value.blacklist.join('\n');
    dirty = false;
  }
  document.getElementById('launch-help').textContent = value.launchAtLogin && value.loginItemActual === false
    ? '系统中未登记开机启动项。便携版移动过目录会失效；请关闭后重新开启，或改用安装版。'
    : '登录后在后台启动，只显示托盘图标。';
  document.getElementById('status').textContent = [value.error, value.permissionMessage].filter(Boolean).join(' ') ||
    (value.paused ? '已暂停' : value.running ? '正在监听选区' : '监听未启动');
  const mac = value.accessibility !== null;
  document.getElementById('blacklist-help').textContent = mac
    ? '每行一个应用标识，例如 com.apple.Safari。命中的应用不触发划词。'
    : '每行一个程序名，例如 example.exe。命中的应用不触发划词。';
  blacklist.placeholder = mac ? 'com.apple.Safari' : 'example.exe';
  const recent = document.getElementById('recent');
  recent.textContent = value.lastProgram ? `最近取词：${value.lastProgram}` : '';
  recent.hidden = !value.lastProgram;
  const access = document.getElementById('mac-accessibility');
  if (access) access.hidden = value.accessibility === null;
  document.getElementById('accessibility-status').textContent = value.accessibility ? '已授权' : '未授权';
  document.getElementById('accessibility-help').hidden = value.accessibility !== false;
}
document.getElementById('settings').addEventListener('input', () => { dirty = true; message.textContent = '尚未保存'; });
document.getElementById('settings').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const result = await window.copickSettings.save({ paused: paused.checked,
      clipboardFallback: fallback.checked, launchAtLogin: launch.checked, blacklist: blacklist.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean) });
    render(result.state, result.ok);
    message.textContent = result.ok ? '已保存' : result.error;
  } catch { message.textContent = '保存失败，请重新打开设置后重试。'; }
  finally { button.disabled = false; }
});
window.copickSettings.onState(value => render(value));
const accessibilityButton = document.getElementById('open-accessibility');
if (accessibilityButton) accessibilityButton.addEventListener('click', () => window.copickSettings.openAccessibility());
const accessibilityCheckButton = document.getElementById('check-accessibility');
if (accessibilityCheckButton) accessibilityCheckButton.addEventListener('click', () => {
  window.copickSettings.read().then(value => render(value)).catch(() => { message.textContent = '无法检查权限。'; });
});
window.copickSettings.read().then(value => render(value, true)).catch(() => { message.textContent = '无法读取设置，请重启 Copick。'; });
