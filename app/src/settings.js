'use strict';
const paused = document.getElementById('paused');
const fallback = document.getElementById('fallback');
const launchAtLogin = document.getElementById('login-item');
const blacklist = document.getElementById('blacklist');
const message = document.getElementById('message');
const save = document.getElementById('save');
const fields = document.getElementById('settings-fields');
const { programName } = window.copickPrograms;
let dirty = false, saving = false, latest = null, helpRequest = 0;

function entries() {
  return blacklist.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}
function listSignature(list) {
  return JSON.stringify([...new Set(list.map(name => name.trim().toLowerCase()))]);
}
function feedback(text, tone = 'neutral') {
  message.textContent = text;
  message.dataset.tone = tone;
}
function idleMessage() {
  return dirty ? '排除应用有未保存的更改；开关会自动保存' : '开关自动保存，排除应用需单独保存';
}
function updateSave() {
  save.disabled = !latest || saving || !dirty;
  save.textContent = saving ? '正在保存…' : '保存排除应用';
  fields.disabled = !latest || saving;
  document.getElementById('retry').disabled = !latest || saving;
  document.getElementById('discard').hidden = !dirty;
  document.getElementById('discard').disabled = saving;
}
function clearFieldError() {
  document.getElementById('blacklist-error').hidden = true;
  blacklist.removeAttribute('aria-invalid');
}
function updateLoginStatus() {
  if (!latest) return;
  const badge = document.getElementById('login-item-status');
  badge.textContent = latest.launchAtLogin
    ? latest.loginItemActive ? '已生效' : '未生效，需检查系统设置' : '已关闭';
  badge.dataset.tone = latest.launchAtLogin && !latest.loginItemActive ? 'warning'
    : latest.launchAtLogin ? 'positive' : 'neutral';
  document.getElementById('login-item-help').textContent = latest.loginItemMessage || '';
  document.getElementById('retry-login').hidden = !latest.launchAtLogin || latest.loginItemActive ||
    /开发模式|系统禁用|任务管理器|允许 Copick/.test(latest.loginItemMessage || '');
  document.getElementById('open-login-items').hidden = latest.accessibility === null ||
    (!latest.launchAtLogin && !latest.loginItemActive);
}
function updateRecent() {
  if (!latest) return;
  const recent = latest.lastProgram;
  document.getElementById('recent-row').hidden = !recent;
  document.getElementById('recent').textContent = recent ? programName(recent) : '';
  document.getElementById('recent-id').textContent = recent && programName(recent) !== recent ? recent : '';
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
    const copy = document.createElement('span');
    copy.className = 'app-name';
    const label = document.createElement('span');
    label.textContent = programName(name);
    copy.append(label);
    if (programName(name) !== name) {
      const identifier = document.createElement('span');
      identifier.className = 'program-name help';
      identifier.textContent = name;
      copy.append(identifier);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-app';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `移除 ${programName(name)}`);
    remove.addEventListener('click', () => {
      blacklist.value = entries().filter((_name, item) => item !== index).join('\n');
      changed();
      const next = list.querySelectorAll('button');
      (next[Math.min(index, next.length - 1)] || document.querySelector('#manual-entry summary')).focus();
    });
    row.append(copy, remove);
    list.append(row);
  });
  document.getElementById('empty-list').hidden = list.children.length > 0;
  updateRecent();
}
function changed() {
  if (!latest) return;
  dirty = listSignature(entries()) !== listSignature(latest.blacklist);
  clearFieldError();
  feedback(idleMessage());
  renderApps();
  updateSave();
}
function renderHelp(value) {
  const steps = [
    ['暂停状态', value.paused ? '当前已暂停。关闭“暂停划词”即可恢复，开关会自动保存。' : '当前未暂停。'],
    ['系统权限', value.accessibility === null ? 'Windows 无需辅助功能授权；管理员窗口可能无法取词，请先在普通权限窗口测试。'
      : value.accessibility ? '辅助功能已授权。' : '尚未授权。请在上方打开系统设置，允许 Copick 后重新检查。'],
    ['应用排除', value.lastProgram ? `最近取词应用：${programName(value.lastProgram)}。${
      [...value.protectedPrograms, ...value.blacklist].some(name => value.lastProgram.toLowerCase().includes(name.toLowerCase()))
        ? '该应用已被排除；内置保护无法移除，自定义排除可在上方编辑。' : '该应用未在已保存的排除列表中。'}`
      : '尚未识别取词应用。这不代表已被排除；请在目标应用选中一段普通文字后重试。'],
    ['兼容复制', value.clipboardFallback ? '已开启。受保护应用及终端、部分编辑器仍不使用快捷键复制。'
      : '已关闭。部分应用需要开启兼容复制；它会临时改动剪贴板，也可能被剪贴板历史记录。'],
    ['编辑器支持', 'VS Code、Cursor 等编辑器请将 editor.accessibilitySupport 设为 on。扫描版 PDF、图片文字和密码输入框可能无法取词。']
  ];
  const list = document.getElementById('help-steps');
  list.replaceChildren();
  for (const [title, text] of steps) {
    const item = document.createElement('li');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const description = document.createElement('p');
    description.textContent = text;
    item.append(heading, description);
    list.append(item);
  }
  document.getElementById('diagnostics').checked = value.diagnosticsEnabled;
  document.getElementById('open-logs').disabled = !value.diagnosticsEnabled;
  if (value.helpRequest > helpRequest) {
    const help = document.getElementById('troubleshooting');
    help.open = true;
    help.scrollIntoView({ block: 'start' });
    help.querySelector('summary').focus();
  }
  helpRequest = value.helpRequest || 0;
}
function render(value, savedList = false) {
  latest = value;
  paused.checked = value.paused;
  fallback.checked = value.clipboardFallback;
  launchAtLogin.checked = value.launchAtLogin;
  if (!dirty || savedList) blacklist.value = value.blacklist.join('\n');
  dirty = listSignature(entries()) !== listSignature(value.blacklist);
  renderApps();
  let title, description, tone;
  if (value.error) {
    title = '需要检查设置'; description = value.error; tone = 'danger';
  } else if (value.accessibility === false) {
    title = '需要辅助功能权限'; tone = 'warning';
    description = '在系统设置中允许 Copick。授权后自动恢复监听，无需重启。';
  } else if (value.paused) {
    title = '划词已暂停'; tone = 'neutral';
    description = '关闭下方的暂停开关即可恢复，开关会自动保存。';
  } else if (value.running) {
    title = '正在监听选区'; tone = 'positive';
    description = '选中文字后，点击附近的复制按钮即可。';
  } else {
    title = '监听未启动'; tone = 'warning';
    description = '点击“重试监听”，或重新启动 Copick。';
  }
  document.getElementById('status').textContent = title;
  document.getElementById('status-description').textContent = description;
  document.getElementById('status-panel').dataset.tone = tone;
  document.getElementById('retry').hidden = !value.error && (value.running || value.paused || value.accessibility === false);
  const mac = value.accessibility !== null;
  document.getElementById('mac-accessibility').hidden = !mac;
  document.getElementById('accessibility-status').textContent = value.accessibility ? '已授权' : '未授权';
  document.getElementById('blacklist-help').textContent = mac
    ? '每行一个应用标识，例如 com.apple.Safari。不支持路径或通配符。'
    : '每行一个程序名，例如 example.exe。不支持路径或通配符。';
  blacklist.placeholder = mac ? 'com.apple.Safari' : 'example.exe';
  document.getElementById('protected-programs').textContent = (value.protectedPrograms || []).map(programName).join(' · ');
  document.getElementById('no-clipboard-programs').textContent = (value.noClipboardPrograms || []).map(programName).join(' · ');
  updateLoginStatus();
  renderHelp(value);
  updateSave();
}
async function persist(patch, saveList = false) {
  if (!latest || saving) return;
  saving = true;
  updateSave();
  if (saveList) clearFieldError();
  feedback('正在保存…');
  try {
    // 开关以已保存列表为基准，避免将未提交的列表草稿一并写入。
    const { paused, clipboardFallback, launchAtLogin, blacklist: savedBlacklist } = latest;
    const result = await window.copickSettings.save({ paused, clipboardFallback, launchAtLogin, blacklist: savedBlacklist, ...patch });
    render(result.state, saveList && result.ok);
    feedback(result.ok ? (dirty ? '开关已保存；排除应用仍有未保存的更改' : '已自动保存') : result.error,
      result.ok ? 'positive' : 'danger');
    if (saveList && result.ok) feedback('排除应用已保存', 'positive');
    if (!result.ok && saveList && /程序标识|每行|最多允许/.test(result.error)) {
      const error = document.getElementById('blacklist-error');
      error.textContent = result.error;
      error.hidden = false;
      document.getElementById('manual-entry').open = true;
      blacklist.setAttribute('aria-invalid', 'true');
    }
  } catch {
    render(latest);
    feedback('保存失败，开关已恢复；请重试。未保存的应用列表已保留。', 'danger');
  } finally {
    saving = false;
    updateSave();
    if (blacklist.hasAttribute('aria-invalid')) blacklist.focus();
  }
}
for (const [element, key] of [[paused, 'paused'], [fallback, 'clipboardFallback'], [launchAtLogin, 'launchAtLogin']]) {
  element.addEventListener('change', () => persist({ [key]: element.checked }));
}
blacklist.addEventListener('input', changed);
document.getElementById('add-recent').addEventListener('click', () => {
  if (!latest?.lastProgram) return;
  blacklist.value = [...entries(), latest.lastProgram.toLowerCase()].join('\n');
  changed();
});
document.getElementById('settings').addEventListener('submit', event => {
  event.preventDefault();
  if (!save.disabled) persist({ blacklist: entries() }, true);
});
document.getElementById('retry').addEventListener('click', () => persist({}));
document.getElementById('retry-login').addEventListener('click', () => persist({}));
document.getElementById('discard').addEventListener('click', () => {
  if (!latest || saving) return;
  render(latest, true);
  clearFieldError();
  feedback('已撤销应用列表更改');
});
window.copickSettings.onState(value => {
  const initial = !latest, wasDirty = dirty;
  render(value);
  if (!saving && (initial || wasDirty !== dirty)) feedback(idleMessage());
});
document.getElementById('open-accessibility').addEventListener('click', () => {
  window.copickSettings.openAccessibility().catch(() => feedback('无法打开系统设置，请手动打开辅助功能设置。', 'danger'));
});
document.getElementById('open-login-items').addEventListener('click', () => {
  window.copickSettings.openLoginItems().catch(() => feedback('无法打开登录项设置，请手动打开系统设置。', 'danger'));
});
document.getElementById('diagnostics').addEventListener('change', async event => {
  const checkbox = event.target;
  checkbox.disabled = true;
  try { render(await window.copickSettings.setDiagnostics(checkbox.checked)); }
  catch { checkbox.checked = Boolean(latest?.diagnosticsEnabled); feedback('无法更改诊断日志状态，请重试。', 'danger'); }
  finally { checkbox.disabled = false; }
});
document.getElementById('open-logs').addEventListener('click', () => {
  window.copickSettings.openLogs().catch(() => feedback('无法打开日志目录，请确认已开启诊断并重试。', 'danger'));
});
async function refresh() {
  try {
    const value = await window.copickSettings.read();
    const initial = !latest, wasDirty = dirty;
    render(value);
    if (!saving && (initial || wasDirty !== dirty)) feedback(idleMessage());
  } catch { feedback('无法读取设置，请重新打开设置或重启 Copick。', 'danger'); }
}
document.getElementById('check-accessibility').addEventListener('click', refresh);
window.addEventListener('focus', refresh);
window.addEventListener('beforeunload', event => {
  if (dirty || saving) { event.preventDefault(); event.returnValue = ''; }
});
refresh();
