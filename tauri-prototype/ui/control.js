'use strict';

const model = window.CopickSettings;
const elements = Object.fromEntries([
  'status', 'permission', 'pause', 'connection-error', 'listener-error',
  'settings-form', 'startup', 'startup-hint', 'startup-error', 'clipboard-fallback', 'fallback-hint',
  'excluded-apps',
  'exclusions-hint', 'exclusions-error', 'diagnostics', 'config-error', 'migration-note', 'version',
  'save', 'revert', 'reload-settings', 'settings-message', 'settings-action-error',
  'open-logs', 'quit', 'app-message', 'app-error'
].map(id => [id, document.getElementById(id)]));
const invoke = (command, args) => {
  if (!window.__TAURI__ || !window.__TAURI__.core) {
    return Promise.reject(new Error('无法连接 Copick 服务，请重新启动应用。'));
  }
  return window.__TAURI__.core.invoke(command, args);
};

let latestStatus = null;
let statusPending = false;
let listenerPending = false;
let statusGeneration = 0;
let savedConfig = null;
let settingsInfo = null;
let settingsPending = false;
let settingsNotice = '';
let appPending = false;

function message(id, text) {
  elements[id].textContent = text || '';
  elements[id].hidden = !text;
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
function draft() {
  return model.draftConfig(elements['excluded-apps'].value, elements.diagnostics.checked,
    elements['clipboard-fallback'].checked);
}
function dirty() {
  return model.hasChanges(savedConfig, elements['excluded-apps'].value, elements.diagnostics.checked,
    elements['clipboard-fallback'].checked);
}
function updateSettingsControls() {
  let validationError = '';
  if (savedConfig) {
    try { draft(); } catch (error) { validationError = errorText(error); }
  }
  message('exclusions-error', validationError);
  elements['excluded-apps'].setAttribute('aria-invalid', String(Boolean(validationError)));
  const changed = dirty();
  const locked = !savedConfig || settingsPending;
  elements['excluded-apps'].disabled = locked;
  elements.diagnostics.disabled = locked;
  elements.startup.disabled = locked || !settingsInfo.startupAvailable;
  elements['clipboard-fallback'].disabled = locked || !settingsInfo.fallbackAvailable;
  elements.save.disabled = locked || (!changed && !settingsInfo.configError) || Boolean(validationError);
  elements.revert.disabled = locked || !changed;
  elements['reload-settings'].disabled = settingsPending;
  elements['settings-form'].setAttribute('aria-busy', String(settingsPending));
  elements.save.textContent = settingsPending && savedConfig ? '处理中…' : '保存设置';
  elements['settings-message'].textContent = settingsPending
    ? (savedConfig ? '正在应用更改…' : '正在加载设置…')
    : !savedConfig ? '设置未加载。' : changed ? '有未保存的更改。'
      : settingsInfo.configError ? '修正设置后可保存，重新建立配置文件。' : settingsNotice || '设置已同步。';
  elements.quit.disabled = appPending || settingsPending;
}
function restoreDraft() {
  elements['excluded-apps'].value = savedConfig.excludedApps.join('\n');
  elements.diagnostics.checked = savedConfig.diagnosticsEnabled;
  elements['clipboard-fallback'].checked = savedConfig.clipboardFallback;
}
function renderSettingsInfo(info) {
  settingsInfo = info;
  elements.startup.checked = info.startupEnabled;
  // 回退属于草稿的一部分，只在加载、保存和撤销时同步，不能被开机启动等即时保存覆盖。
  elements['fallback-hint'].textContent = info.fallbackAvailable
    ? '无障碍取词失败时模拟复制快捷键读取选区。会临时改动剪贴板；私有格式、并发复制或剪贴板管理器可能无法完整恢复。'
    : '当前平台的回退无法在事务内取消，因此始终关闭。';
  elements['startup-hint'].textContent = info.startupAvailable
    ? (typeof info.startupNote === 'string' && info.startupNote
      ? info.startupNote : '开关表示启动项已登记，更改在下次登录时生效。')
    : '当前系统或安装方式不支持设置开机启动。';
  message('startup-error', info.startupError ? `开机启动：${info.startupError}` : '');
  message('config-error', info.configError ? `配置文件：${info.configError}` : '');
  elements['migration-note'].hidden = !info.migratedFromElectron;
  elements.version.textContent = info.version || '版本未知';
}
async function loadSettings() {
  if (settingsPending || savedConfig) return;
  settingsPending = true;
  message('settings-action-error', '');
  updateSettingsControls();
  try {
    const info = model.readSettings(await invoke('settings'));
    savedConfig = model.copyConfig(info.config);
    renderSettingsInfo(info);
    restoreDraft();
    elements['reload-settings'].hidden = true;
  } catch (error) {
    message('settings-action-error', `无法加载设置：${errorText(error)}`);
    elements.version.textContent = '版本读取失败';
    elements['startup-hint'].textContent = '设置加载成功后可修改。';
    elements['reload-settings'].hidden = false;
  } finally {
    settingsPending = false;
    updateSettingsControls();
  }
}
async function saveSettings(event) {
  event.preventDefault();
  if (settingsPending || !savedConfig || (!dirty() && !settingsInfo.configError)) return;
  let config;
  try { config = draft(); }
  catch { updateSettingsControls(); return; }
  settingsPending = true;
  message('settings-action-error', '');
  updateSettingsControls();
  try {
    const info = model.readSettings(await invoke('save_settings', { config }));
    // 以服务端返回的配置作为新基线，保留后端规范化结果。
    savedConfig = model.copyConfig(info.config);
    renderSettingsInfo(info);
    restoreDraft();
    settingsNotice = info.configError ? '请检查配置文件错误。' : '设置已保存。';
  } catch (error) {
    message('settings-action-error', `保存失败，更改仍保留：${errorText(error)}`);
  } finally {
    settingsPending = false;
    updateSettingsControls();
  }
}
async function changeStartup() {
  if (settingsPending || !settingsInfo || !settingsInfo.startupAvailable) return;
  const enabled = elements.startup.checked;
  settingsPending = true;
  message('startup-error', '');
  updateSettingsControls();
  try {
    const info = model.readSettings(await invoke('set_startup', { enabled }));
    // 修改开机启动时，保留排除列表和诊断设置的草稿及原始基线。
    renderSettingsInfo(info);
    if (!info.startupError && info.startupEnabled !== enabled) {
      message('startup-error', '开机启动未按请求更改，请重试。');
    }
  } catch (error) {
    elements.startup.checked = settingsInfo.startupEnabled;
    message('startup-error', `无法更改开机启动：${errorText(error)}`);
  } finally {
    settingsPending = false;
    updateSettingsControls();
  }
}

function updateListenerControls() {
  elements.permission.disabled = listenerPending;
  elements.pause.disabled = listenerPending || !latestStatus;
}
function renderStatus(state) {
  if (!state || !['permission', 'running', 'paused', 'fallback'].every(key => typeof state[key] === 'boolean') ||
      !(state.error === null || typeof state.error === 'string')) {
    throw new Error('监听状态响应格式不正确。');
  }
  latestStatus = state;
  elements.status.textContent = state.error ? `监听异常：${state.error}` : !state.permission
    ? (navigator.userAgent.includes('Windows')
      ? '监听权限不可用，请检查监听状态。'
      : '需要辅助功能权限。请在系统设置中允许 Copick，授权后监听会自动恢复。')
    : state.paused ? '监听已暂停。' : state.running ? '原生监听运行中。' : '监听尚未启动，请检查权限或重新启动 Copick。';
  elements.pause.textContent = state.paused ? '恢复监听' : '暂停监听';
  message('connection-error', '');
  updateListenerControls();
}
async function pollStatus() {
  if (statusPending || listenerPending) return;
  statusPending = true;
  const generation = statusGeneration;
  try {
    const state = await invoke('status');
    if (generation === statusGeneration) renderStatus(state);
  } catch (error) {
    if (generation === statusGeneration) {
      message('connection-error', `无法读取监听状态：${errorText(error)}`);
    }
  } finally {
    statusPending = false;
  }
}
async function listenerAction(command, args) {
  if (listenerPending) return;
  listenerPending = true;
  statusGeneration += 1;
  message('listener-error', '');
  updateListenerControls();
  try { renderStatus(await invoke(command, args)); }
  catch (error) { message('listener-error', `操作失败：${errorText(error)}`); }
  finally {
    listenerPending = false;
    updateListenerControls();
  }
}
async function appAction(command) {
  if (appPending || (command === 'quit' && settingsPending)) return;
  appPending = true;
  message('app-error', '');
  message('app-message', '');
  elements['open-logs'].disabled = true;
  elements.quit.disabled = true;
  try {
    await invoke(command);
    message('app-message', command === 'open_logs' ? '已请求打开日志文件夹。' : '正在退出 Copick…');
  } catch (error) {
    message('app-error', `${command === 'open_logs' ? '无法打开日志文件夹' : '退出失败'}：${errorText(error)}`);
  } finally {
    appPending = false;
    elements['open-logs'].disabled = false;
    elements.quit.disabled = settingsPending;
  }
}

if (navigator.userAgent.includes('Windows')) {
  elements.permission.textContent = '检查监听状态';
  elements['excluded-apps'].placeholder = '例如：notepad.exe';
  elements['exclusions-hint'].textContent = elements['exclusions-hint'].textContent
    .replace('程序名或 bundle id', '程序名（进程名）');
}
elements.permission.addEventListener('click', () => listenerAction('permission'));
elements.pause.addEventListener('click', () => {
  if (latestStatus) {
    return listenerAction('configure', { paused: !latestStatus.paused });
  }
});
elements['settings-form'].addEventListener('submit', saveSettings);
elements['reload-settings'].addEventListener('click', loadSettings);
elements.startup.addEventListener('change', changeStartup);
elements.revert.addEventListener('click', () => {
  if (!savedConfig || settingsPending) return;
  restoreDraft();
  settingsNotice = '已撤销未保存的更改。';
  message('settings-action-error', '');
  updateSettingsControls();
});
for (const [id, event] of [['excluded-apps', 'input'], ['diagnostics', 'change'],
  ['clipboard-fallback', 'change']]) {
  elements[id].addEventListener(event, () => {
    settingsNotice = '';
    updateSettingsControls();
  });
}
elements['open-logs'].addEventListener('click', () => appAction('open_logs'));
elements.quit.addEventListener('click', () => appAction('quit'));
updateListenerControls();
loadSettings();
pollStatus();
setInterval(pollStatus, 1000);
