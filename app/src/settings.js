'use strict';
const paused = document.getElementById('paused');
const fallback = document.getElementById('fallback');
const loginItem = document.getElementById('login-item');
const blacklist = document.getElementById('blacklist');
const message = document.getElementById('message');
const save = document.getElementById('save');
const fields = document.getElementById('settings-fields');
let dirty = false, saving = false, latest = null;

function entries() {
  return blacklist.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}
function draft() {
  return { paused: paused.checked, clipboardFallback: fallback.checked,
    loginItem: loginItem.checked, blacklist: entries() };
}
function signature(value) {
  return JSON.stringify([value.paused, value.clipboardFallback, value.loginItem,
    [...new Set(value.blacklist.map(name => name.trim().toLowerCase()))]]);
}
function feedback(text, tone = 'neutral') {
  message.textContent = text;
  message.dataset.tone = tone;
}
function updateSave() {
  const needsRetry = latest && (latest.error ||
    (!latest.paused && !latest.running && latest.accessibility !== false) ||
    (latest.loginItem && !latest.loginItemActive));
  save.disabled = !latest || saving || (!dirty && !needsRetry);
  save.textContent = saving ? '正在保存…' : '保存设置';
}
function clearFieldError() {
  document.getElementById('blacklist-error').hidden = true;
  blacklist.removeAttribute('aria-invalid');
}
function updateLoginStatus() {
  if (!latest) return;
  const pending = loginItem.checked !== latest.loginItem;
  const badge = document.getElementById('login-item-status');
  badge.textContent = pending ? '待保存' : latest.loginItem
    ? latest.loginItemActive ? '已生效' : '未生效，需检查系统设置' : '已关闭';
  badge.dataset.tone = pending || (latest.loginItem && !latest.loginItemActive) ? 'warning'
    : latest.loginItem ? 'positive' : 'neutral';
  document.getElementById('login-item-help').textContent = pending
    ? '保存后应用此更改，系统实际状态将在这里显示。' : latest.loginItemMessage || '';
  document.getElementById('open-login-items').hidden = latest.accessibility === null ||
    (!latest.loginItem && !latest.loginItemActive);
}
function updateRecent() {
  if (!latest) return;
  const recent = latest.lastProgram;
  document.getElementById('recent-row').hidden = !recent;
  document.getElementById('recent').textContent = recent || '';
  const excluded = recent && [...entries(), ...(latest.protectedPrograms || [])]
    .some(name => recent.toLowerCase().includes(name.toLowerCase()));
  const button = document.getElementById('add-recent');
  button.disabled = !recent || Boolean(excluded);
  button.textContent = excluded ? '已排除' : '添加排除';
}
function renderApps() {
  const list = document.getElementById('app-list');
  list.replaceChildren();
  entries().forEach((name, index) => {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'program-name';
    label.textContent = name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-app';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `移除 ${name}`);
    remove.addEventListener('click', () => {
      blacklist.value = entries().filter((_name, item) => item !== index).join('\n');
      changed();
      const next = list.querySelectorAll('button');
      (next[Math.min(index, next.length - 1)] || document.querySelector('#manual-entry summary')).focus();
    });
    row.append(label, remove);
    list.append(row);
  });
  document.getElementById('empty-list').hidden = list.children.length > 0;
  updateRecent();
}
function changed() {
  if (!latest) return;
  dirty = signature(draft()) !== signature(latest);
  clearFieldError();
  feedback(dirty ? '有未保存的更改' : '所有更改已保存');
  renderApps();
  updateLoginStatus();
  updateSave();
}
function render(value, force = false) {
  latest = value;
  if (!dirty || force) {
    paused.checked = value.paused;
    fallback.checked = value.clipboardFallback;
    loginItem.checked = value.loginItem;
    blacklist.value = value.blacklist.join('\n');
    dirty = false;
    renderApps();
  } else {
    dirty = signature(draft()) !== signature(value);
  }
  fields.disabled = saving;
  let title, description, tone;
  if (value.error) {
    title = '需要检查设置'; description = value.error; tone = 'danger';
  } else if (value.accessibility === false) {
    title = '需要辅助功能权限'; tone = 'warning';
    description = '在系统设置中允许 Copick。授权后自动恢复监听，无需重启。';
  } else if (value.paused) {
    title = '划词已暂停'; tone = 'neutral';
    description = '关闭下方的暂停开关并保存，即可恢复划词复制。';
  } else if (value.running) {
    title = '正在监听选区'; tone = 'positive';
    description = '选中文字后，点击附近的复制按钮即可。';
  } else {
    title = '监听未启动'; tone = 'warning';
    description = '请重新保存设置以重试，或重新启动 Copick。';
  }
  document.getElementById('status').textContent = title;
  document.getElementById('status-description').textContent = description;
  document.getElementById('status-panel').dataset.tone = tone;
  const mac = value.accessibility !== null;
  document.getElementById('mac-accessibility').hidden = !mac;
  document.getElementById('accessibility-status').textContent = value.accessibility ? '已授权' : '未授权';
  document.getElementById('blacklist-help').textContent = mac
    ? '每行一个应用标识，例如 com.apple.Safari。不支持路径或通配符。'
    : '每行一个程序名，例如 example.exe。不支持路径或通配符。';
  blacklist.placeholder = mac ? 'com.apple.Safari' : 'example.exe';
  document.getElementById('protected-programs').textContent = (value.protectedPrograms || []).join(' · ');
  document.getElementById('no-clipboard-programs').textContent = (value.noClipboardPrograms || []).join(' · ');
  updateRecent();
  updateLoginStatus();
  updateSave();
}
document.getElementById('settings').addEventListener('input', changed);
document.getElementById('add-recent').addEventListener('click', () => {
  if (!latest?.lastProgram) return;
  blacklist.value = [...entries(), latest.lastProgram.toLowerCase()].join('\n');
  changed();
});
document.getElementById('settings').addEventListener('submit', async event => {
  event.preventDefault();
  if (save.disabled) return;
  saving = true;
  fields.disabled = true;
  updateSave();
  clearFieldError();
  feedback('正在保存…');
  try {
    const result = await window.copickSettings.save(draft());
    render(result.state, result.ok);
    feedback(result.ok ? '设置已保存' : result.error, result.ok ? 'positive' : 'danger');
    if (!result.ok && /程序标识|每行|最多允许/.test(result.error)) {
      const error = document.getElementById('blacklist-error');
      error.textContent = result.error;
      error.hidden = false;
      document.getElementById('manual-entry').open = true;
      blacklist.setAttribute('aria-invalid', 'true');
    }
  } catch {
    feedback('保存失败，请重试或重新打开设置。', 'danger');
  } finally {
    saving = false;
    fields.disabled = false;
    updateSave();
    if (blacklist.hasAttribute('aria-invalid')) blacklist.focus();
  }
});
window.copickSettings.onState(value => {
  const initial = !latest, wasDirty = dirty;
  render(value);
  if (!saving && (initial || wasDirty !== dirty)) feedback(dirty ? '有未保存的更改' : '所有更改已保存');
});
document.getElementById('open-accessibility').addEventListener('click', () => {
  window.copickSettings.openAccessibility().catch(() => feedback('无法打开系统设置，请手动打开辅助功能设置。', 'danger'));
});
document.getElementById('open-login-items').addEventListener('click', () => {
  window.copickSettings.openLoginItems().catch(() => feedback('无法打开登录项设置，请手动打开系统设置。', 'danger'));
});
async function refresh() {
  try {
    const value = await window.copickSettings.read();
    const initial = !latest, wasDirty = dirty;
    render(value);
    if (!saving && (initial || wasDirty !== dirty)) feedback(dirty ? '有未保存的更改' : '所有更改已保存');
  } catch { feedback('无法读取设置，请重新打开设置或重启 Copick。', 'danger'); }
}
document.getElementById('check-accessibility').addEventListener('click', refresh);
window.addEventListener('focus', refresh);
refresh();
