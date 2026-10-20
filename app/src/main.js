'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { loadConfig, saveConfig } = require('./config');
const { PROTECTED, NO_CLIPBOARD, validateConfig, blockedPrograms, isBlocked, validPoint, popupBounds } = require('./policy');
const { createDiagnostics, errorMetadata, diagnosticsEnabled } = require('./diagnostics');

let hook, popup, settings, tray, config, configFile, diagnostics;
let current = null, expiry, ready = false, lastProgram = '', failure = null;
let permissionGranted = null;
const permissionMessage = '需要辅助功能权限，选区监听已暂停。请在系统设置中允许 Copick，然后重新检查权限。';
function diag(event, metadata, interval) { if (diagnostics) diagnostics.log(event, metadata, interval); }
const page = name => path.join(__dirname, `${name}.html`);
const pageURL = name => pathToFileURL(page(name)).href;
const preload = path.join(__dirname, 'preload.js');
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const icon = path.join(__dirname, '..', 'assets', isMac ? 'icon.icns' : 'icon.ico');

function hidePopup() {
  clearTimeout(expiry);
  current = null;
  if (popup && !popup.isDestroyed()) popup.hide();
}
function state() {
  const login = loginItemState();
  return { ...config, protectedPrograms: [...PROTECTED], noClipboardPrograms: [...NO_CLIPBOARD], lastProgram,
    accessibility: permissionGranted, permissionMessage: permissionGranted === false ? permissionMessage : null,
    loginItemActive: login.active, loginItemMessage: login.message,
    running: Boolean(hook?.isRunning()), error: failure, configPath: configFile };
}
function publish() {
  if (settings && !settings.isDestroyed()) settings.webContents.send('settings:state', state());
  rebuildTray();
}
function checked(result) {
  if (!result) throw new Error('无法启动或配置选区监听。请暂停后重试，或重新启动 Copick。');
}
function pointInDip(point) {
  if (!validPoint(point)) return null;
  // selection-hook emits screen pixels. Electron screen coordinates are DIP on Windows;
  // macOS screen coordinates are already Cocoa points, so only Windows converts them.
  return isWindows && typeof screen.screenToDipPoint === 'function'
    ? screen.screenToDipPoint(point) : point;
}
function accessibilityState() {
  return isMac && hook && typeof hook.macIsProcessTrusted === 'function'
    ? hook.macIsProcessTrusted() : null;
}
function refreshPermissions() {
  if (!isMac || !hook || !config) return;
  const granted = accessibilityState();
  if (granted === permissionGranted) return;
  permissionGranted = granted;
  diag('permissions', { accessibility: granted }, 0);
  try {
    if (!granted) {
      hidePopup();
      if (hook.isRunning()) checked(hook.stop());
    } else if (!config.paused && !failure) {
      applyHook();
    }
  } catch (error) { failure = error.message; }
  publish();
}
function openAccessibilitySettings() {
  if (!isMac) return;
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
}
function openLoginItemsSettings() {
  if (!isMac) return;
  shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension');
}
// Windows stores one Run value per app; macOS 13+ answers through login item status instead.
// Both resolve the executable path, so reads and writes must share the same options.
const loginItemOptions = () => (isWindows ? { path: process.execPath, args: [] } : {});
function readLoginItem() {
  try { return app.getLoginItemSettings(loginItemOptions()) || {}; } catch { return {}; }
}
function loginItemEntry(settings) {
  const target = String(process.execPath).toLowerCase();
  return (settings.launchItems || [])
    .find(item => typeof item.path === 'string' && item.path.toLowerCase() === target) || null;
}
// Windows keeps the Run value while Task Manager reports the entry as disabled, so openAtLogin alone lies.
function loginItemActive(settings = readLoginItem()) {
  return isWindows ? Boolean(settings.executableWillLaunchAtLogin) : settings.status === 'enabled';
}
function loginItemState() {
  if (!app.isPackaged) return { active: false, message: '开发模式运行，不写入系统登录项；打包后生效。' };
  const settings = readLoginItem();
  const active = loginItemActive(settings);
  if (active || !config?.loginItem) return { active, message: null };
  if (isWindows) {
    return { active: false, message: loginItemEntry(settings)
      ? '启动项已被系统禁用，请在「任务管理器 > 启动应用」中重新启用。'
      : '系统尚未登记启动项，请重新保存设置。' };
  }
  return { active: false, message: settings.status === 'requires-approval'
    ? '需要在「系统设置 > 通用 > 登录项」中允许 Copick，否则不会开机启动。'
    : '系统未登记该登录项；未签名或未公证的构建可能无法生效。' };
}
function writeLoginItem(openAtLogin) { app.setLoginItemSettings({ openAtLogin, ...loginItemOptions() }); }
function applyLoginItem() {
  // An unpackaged run would register the Electron binary instead of Copick.
  if (!app.isPackaged) return;
  try {
    const settings = readLoginItem();
    if (!config.loginItem) {
      if (settings.openAtLogin || loginItemActive(settings) || loginItemEntry(settings)) writeLoginItem(false);
      return;
    }
    // Re-assert a moved or renamed portable folder, but leave an OS-side disable for the user to undo.
    const registered = isWindows ? Boolean(loginItemEntry(settings))
      : settings.status === 'requires-approval' || loginItemActive(settings);
    if (!registered) writeLoginItem(true);
  } catch (error) { diag('login-item-error', errorMetadata(error)); }
}
const counts = { mouseDown: 0, mouseUp: 0, selections: 0, shown: 0, dropped: 0 };
function gateState() {
  return { ready, paused: config?.paused, running: hook?.isRunning(),
    settingsFocused: Boolean(settings && !settings.isDestroyed() && settings.isFocused()),
    settingsVisible: Boolean(settings && !settings.isDestroyed() && settings.isVisible()) };
}
function applyHook() {
  hidePopup();
  if (hook.isRunning()) checked(hook.stop());
  diag('hook-config', { paused: config.paused, clipboardFallback: config.clipboardFallback,
    blacklistCount: config.blacklist.length, protectedCount: PROTECTED.length }, 0);
  if (config.paused || (isMac && permissionGranted !== true)) return;
  // 2.1.1 start() skips values equal to defaults, even after a previous stop().
  // Explicitly restore clipboard state so false -> true really enables fallback.
  checked(config.clipboardFallback ? hook.enableClipboard() : hook.disableClipboard());
  const result = hook.start({
    debug: false, enableMouseMoveEvent: false, enableClipboard: config.clipboardFallback,
    globalFilterMode: hook.constructor.FilterMode.EXCLUDE_LIST,
    globalFilterList: blockedPrograms(config),
    clipboardMode: hook.constructor.FilterMode.EXCLUDE_LIST,
    clipboardFilterList: [...blockedPrograms(config), ...NO_CLIPBOARD]
  });
  diag('hook-start', { result, running: hook.isRunning() }, 0);
  checked(result);
}
function updateConfig(next) {
  // Reject invalid input and persistence failures before touching the running hook.
  const validated = validateConfig(next);
  const saved = saveConfig(configFile, validated);
  hidePopup();
  config = saved;
  failure = null;
  applyLoginItem();
  try {
    applyHook();
  } catch (error) {
    diag('hook-config-error', errorMetadata(error));
    // Keep the persisted user intent; runtime failure is reported separately.
    hook.stop();
    failure = error.message;
    publish();
    throw error;
  }
  publish();
}
function safeUpdate(next) {
  try { updateConfig(next); }
  catch { showSettings(); }
}
function secureWindow(options) {
  const window = new BrowserWindow({ ...options, icon, webPreferences: {
    preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
    webSecurity: true, devTools: false, spellcheck: false
  } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  return window;
}
function showSettings() {
  refreshPermissions();
  hidePopup();
  if (isMac && app.dock) {
    app.dock.show().then(() => {
      if (settings && !settings.isDestroyed()) {
        app.dock.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
      }
    }).catch(error => diag('dock-show-error', errorMetadata(error)));
  }
  if (settings && !settings.isDestroyed()) { settings.show(); settings.focus(); return; }
  settings = secureWindow({ width: 560, height: 760, minWidth: 460, minHeight: 540,
    title: 'Copick 设置', backgroundColor: '#f5f6f8', autoHideMenuBar: true });
  settings.loadFile(page('settings'));
  settings.on('focus', refreshPermissions);
  settings.on('closed', () => {
    settings = null;
    if (isMac) app.dock?.hide();
  });
}
function rebuildTray() {
  if (!tray) return;
  const login = loginItemState();
  tray.setToolTip(`Copick · ${permissionGranted === false ? '需要辅助功能权限' : failure ? '需要检查设置' : config.paused ? '已暂停' : '运行中'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Copick · 本地划词复制', enabled: false },
    { label: '暂停划词', type: 'checkbox', checked: config.paused,
      click: item => safeUpdate({ ...config, paused: item.checked }) },
    { label: `启用快捷键回退（${isMac ? '⌘C' : 'Ctrl+C'}）`, type: 'checkbox', checked: config.clipboardFallback,
      click: item => safeUpdate({ ...config, clipboardFallback: item.checked }) },
    { label: `开机启动${config.loginItem && !login.active ? '（未生效）' : ''}`, type: 'checkbox', checked: config.loginItem,
      click: item => safeUpdate({ ...config, loginItem: item.checked }) },
    { type: 'separator' },
    { label: lastProgram ? `禁用最近取词应用：${lastProgram}` : '禁用最近取词应用',
      enabled: Boolean(lastProgram && !isBlocked(lastProgram, config)),
      click: () => safeUpdate({ ...config, blacklist: [...config.blacklist, lastProgram.toLowerCase()] }) },
    { label: '设置与应用黑名单…', click: showSettings },
    ...(isMac ? [
      { label: permissionGranted ? '辅助功能权限：已授权' : '辅助功能权限：未授权', enabled: false },
      { label: '重新检查辅助功能权限', click: refreshPermissions },
      { label: '打开辅助功能设置…', click: openAccessibilitySettings }
    ] : []),
    { label: diagnostics ? '打开诊断日志目录…' : '诊断日志：未开启（--diagnostics）', enabled: Boolean(diagnostics),
      click: () => { shell.openPath(app.getPath('logs')).catch(() => {}); } },
    { type: 'separator' },
    { label: '退出 Copick', click: () => app.quit() }
  ]));
}
function trusted(event, window, name) {
  return window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === pageURL(name);
}
function installIPC() {
  ipcMain.handle('settings:read', event => {
    if (!trusted(event, settings, 'settings')) throw new Error('Invalid sender');
    refreshPermissions();
    return state();
  });
  ipcMain.handle('settings:save', (event, next) => {
    if (!trusted(event, settings, 'settings')) throw new Error('Invalid sender');
    try { updateConfig(next); return { ok: true, state: state() }; }
    catch (error) { return { ok: false, error: error.message, state: state() }; }
  });
  ipcMain.handle('settings:open-accessibility', event => {
    if (!trusted(event, settings, 'settings')) throw new Error('Invalid sender');
    openAccessibilitySettings();
    return true;
  });
  ipcMain.handle('settings:open-login-items', event => {
    if (!trusted(event, settings, 'settings')) throw new Error('Invalid sender');
    openLoginItemsSettings();
    return true;
  });
  ipcMain.handle('popup:copy', (event, token) => {
    if (!trusted(event, popup, 'popup') || !current || current.copied || token !== current.token ||
        config.paused || (isMac && permissionGranted !== true) || !hook.isRunning() || failure ||
        Date.now() > current.expires || isBlocked(current.program, config)) return false;
    // Native method serializes against fallback clipboard transactions; Electron.writeText does not.
    const success = hook.writeToClipboard(current.text);
    if (success) {
      current.text = '';
      current.copied = true;
      clearTimeout(expiry);
      expiry = setTimeout(() => {
        if (current?.token === token) hidePopup();
      }, 650);
    }
    return success;
  });
}
function showSelection(data) {
  counts.selections++;
  const metadata = { ...gateState(), textLength: typeof data?.text === 'string' ? data.text.length : 0,
    programKnown: Boolean(data?.programName), method: data?.method, posLevel: data?.posLevel,
    mousePointValid: Boolean(validPoint(data?.mousePosEnd)), selectionPointValid: Boolean(validPoint(data?.endBottom)) };
  diag('selection', metadata);
  const drop = reason => { counts.dropped++; diag('selection-drop', { ...metadata, reason }); };
  if (!ready) return drop('popup-not-ready');
  if (config.paused) return drop('paused');
  if ((isMac && permissionGranted !== true) || failure || !hook.isRunning()) return drop('not-listening');
  if (!data || isBlocked(data.programName, config)) return drop(data?.programName ? 'blocked-program' : 'unknown-program');
  if (typeof data.text !== 'string' || !data.text.trim()) return drop('empty-text');
  if (data.text.length > 1024 * 1024) return drop('text-too-long');
  if (metadata.settingsFocused) return drop('settings-focused');
  // Hook coordinates are physical pixels; Electron window bounds use DIP on Windows.
  const raw = data.posLevel >= hook.constructor.PositionLevel.SEL_FULL && validPoint(data.endBottom)
    ? data.endBottom : data.mousePosEnd;
  const cursor = screen.getCursorScreenPoint();
  const point = pointInDip(raw) || cursor;
  if (validPoint(data.mousePosEnd)) {
    const end = pointInDip(data.mousePosEnd);
    // Discard slow results if the pointer has already left the selection.
    metadata.cursorDistance = end ? Math.hypot(end.x - cursor.x, end.y - cursor.y) : null;
    if (end && metadata.cursorDistance > 100) return drop('cursor-moved');
  }
  lastProgram = data.programName;
  current = { text: data.text, program: data.programName, token: randomUUID(), expires: Date.now() + 7000 };
  popup.setBounds(popupBounds(point, screen.getDisplayNearestPoint(point).workArea));
  popup.webContents.send('popup:selection', current.token);
  popup.showInactive();
  counts.shown++;
  diag('selection-shown', metadata);
  clearTimeout(expiry);
  expiry = setTimeout(hidePopup, 7000);
  publish();
}

if (!isMac && !isWindows) {
  console.error('Copick supports macOS and Windows only.');
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName('Copick');
  if (isWindows) app.setAppUserModelId('local.copick.app');
  app.on('second-instance', () => { if (tray) showSettings(); });
  app.on('activate', (_event, hasVisibleWindows) => {
    // Only reopen from the Dock when no window is visible; popup interaction is not a settings request.
    if (tray && !hasVisibleWindows && !current && !popup?.isVisible()) showSettings();
  });
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { hidePopup(); if (hook) hook.cleanup(); if (tray) tray.destroy(); });
  app.whenReady().then(() => {
    if (isMac) app.dock?.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
    if (diagnosticsEnabled(process.argv)) diagnostics = createDiagnostics(app.getPath('logs'));
    diag('startup', { appVersion: app.getVersion(), hookVersion: '2.1.1', electronVersion: process.versions.electron,
      nodeVersion: process.versions.node, platform: process.platform, arch: process.arch }, 0);
    const SelectionHook = require('selection-hook');
    hook = new SelectionHook();
    hook.on('error', error => {
      diag('hook-error', errorMetadata(error));
      failure = '选区监听发生错误。请暂停后恢复，或重新启动 Copick。';
      hidePopup();
      publish();
    });
    if (process.argv.includes('--smoke-test')) {
      // No hooks or synthetic keys: load the bundled native module only.
      console.log('COPICK_SMOKE_OK selection-hook=2.1.1 native module loaded');
      app.quit();
      return;
    }
    configFile = path.join(app.getPath('userData'), 'config.json');
    const loaded = loadConfig(configFile);
    config = loaded.config;
    failure = loaded.error;
    applyLoginItem();
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith('file://') });
    });
    popup = secureWindow({ width: 88, height: 40, frame: false, transparent: true,
      show: false, focusable: false, skipTaskbar: true, alwaysOnTop: true,
      resizable: false, movable: false, hasShadow: false });
    popup.setAlwaysOnTop(true, 'pop-up-menu');
    if (isMac) popup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    popup.loadFile(page('popup'));
    popup.webContents.on('did-finish-load', () => { ready = true; diag('popup-ready', { ready }, 0); });
    popup.webContents.on('did-fail-load', () => { ready = false; diag('popup-load-error', { ready }, 0); });
    popup.webContents.on('render-process-gone', () => { ready = false; hidePopup(); diag('popup-renderer-gone', { ready }, 0); });
    installIPC();
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', isMac ? 'trayTemplate.png' : 'icon.png'))
      .resize({ width: isMac ? 18 : 32, height: isMac ? 18 : 32 });
    if (isMac) trayIcon.setTemplateImage(true);
    tray = new Tray(trayIcon);
    if (isMac) app.dock?.hide();
    tray.on('double-click', showSettings);
    tray.on('click', refreshPermissions);
    tray.on('right-click', refreshPermissions);
    hook.on('text-selection', showSelection);
    if (diagnostics) {
      hook.on('mouse-up', () => { counts.mouseUp++; });
      const heartbeat = setInterval(() => diag('heartbeat', { ...counts, ...gateState() }, 0), 30000);
      heartbeat.unref();
    }
    hook.on('mouse-down', data => {
      if (diagnostics) counts.mouseDown++;
      if (!current) return;
      const point = pointInDip({ x: data.x, y: data.y });
      if (!point) return;
      const bounds = popup.getBounds();
      if (point.x < bounds.x || point.x >= bounds.x + bounds.width ||
          point.y < bounds.y || point.y >= bounds.y + bounds.height) hidePopup();
    });
    hook.on('mouse-wheel', hidePopup);
    hook.on('key-down', hidePopup);
    permissionGranted = accessibilityState();
    diag('permissions', { accessibility: permissionGranted,
      permissionProbe: isMac ? 'mac-accessibility' : 'windows-no-permission-probe-api' }, 0);
    if (!failure) {
      try { applyHook(); } catch (error) { diag('hook-start-error', errorMetadata(error), 0); failure = error.message; }
    } else diag('hook-skipped', { reason: 'startup-failure', paused: config.paused }, 0);
    if (isMac) {
      const permissionTimer = setInterval(refreshPermissions, 2000);
      permissionTimer.unref();
    }
    publish();
    if (failure || permissionGranted === false) showSettings();
  }).catch(error => {
    diag('startup-error', errorMetadata(error), 0);
    dialog.showErrorBox('Copick 无法启动', isMac
      ? '无法加载本地模块或应用资源。请确认已授予辅助功能权限，并完整解压应用。'
      : '无法加载本地模块或应用资源。请完整解压 Windows x64 便携包后重试。');
    app.exit(1);
  });
}
