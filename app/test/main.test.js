'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.join(__dirname, '..', 'src');
// Objects built inside the vm context carry another realm's prototype, so normalize before comparing.
const plain = value => JSON.parse(JSON.stringify(value));

// Run the real main-process handlers with fake Electron/native boundaries: no desktop hooks.
async function harness({ platform = 'darwin', granted = true, paused = false, loadedError = null,
  loginItem = false, packaged = true, login = {} } = {}) {
  const policyContext = { module: { exports: {} }, process: { platform } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'policy.js'), 'utf8'), policyContext);
  const policy = policyContext.module.exports;
  const calls = { stop: 0, start: [], writes: [], workspaces: [] };
  // Fake executable paths; the login item code only compares them as strings.
  const execPath = platform === 'win32' ? 'C:/Copick/Copick.exe' : '/Applications/Copick.app/Contents/MacOS/Copick';
  const loginCalls = [];
  const loginState = { openAtLogin: login.openAtLogin ?? loginItem, entryEnabled: login.entryEnabled ?? true,
    path: login.path ?? execPath, status: login.status ?? null };
  let persisted = { paused, clipboardFallback: false, loginItem, blacklist: [] };
  let saveFails = false, startFails = false;
  const handlers = new Map(), windows = [], intervals = [], timeouts = new Map();
  let timerId = 0;
  class Hook extends EventEmitter {
    static FilterMode = { EXCLUDE_LIST: 2 };
    static PositionLevel = { SEL_FULL: 3 };
    constructor() { super(); Hook.instance = this; this.running = false; }
    macIsProcessTrusted() { return granted; }
    isRunning() { return this.running; }
    stop() { calls.stop++; this.running = false; return true; }
    start(options) { calls.start.push(options); this.running = !startFails; return !startFails; }
    enableClipboard() { return true; }
    disableClipboard() { return true; }
    writeToClipboard(text) { calls.writes.push(text); return true; }
    cleanup() {}
  }
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.focused = false;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: require('node:url').pathToFileURL(path.join(root, options.title ? 'settings.html' : 'popup.html')).href };
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (...args) => { this.messages = this.messages || []; this.messages.push(args); };
      windows.push(this);
    }
    isDestroyed() { return false; }
    isFocused() { return this.focused; }
    isVisible() { return false; }
    hide() { this.hidden = true; }
    show() {} focus() {} loadFile() {}
    showInactive() { this.hidden = false; calls.inactive = true; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces(...args) { calls.workspaces.push(args); }
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
  }
  class Tray extends EventEmitter {
    constructor() { super(); Tray.instance = this; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(menu) { this.menu = menu; }
  }
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true, setName() {}, setAppUserModelId() {}, isPackaged: packaged,
    whenReady: () => Promise.resolve(), getPath: () => '/fake', quit() {}, exit() {}, getVersion: () => 'test',
    dock: { setIcon: value => { calls.dockIcon = value; },
      show: () => new Promise(resolve => { calls.finishDockShow = () => { calls.dockIcon = 'Electron'; resolve(); }; }),
      hide() {} },
    getLoginItemSettings: () => platform === 'darwin'
      ? { openAtLogin: loginState.openAtLogin,
        status: loginState.status || (loginState.openAtLogin ? 'enabled' : 'not-registered') }
      : { openAtLogin: loginState.openAtLogin,
        executableWillLaunchAtLogin: loginState.openAtLogin && loginState.entryEnabled,
        launchItems: loginState.openAtLogin
          ? [{ name: 'local.copick.app', path: loginState.path, args: [], scope: 'user', enabled: loginState.entryEnabled }]
          : [] },
    setLoginItemSettings: settings => {
      loginCalls.push(settings);
      loginState.status = null;
      loginState.openAtLogin = Boolean(settings.openAtLogin);
      if (settings.openAtLogin && platform === 'win32') {
        loginState.path = settings.path;
        loginState.entryEnabled = true;
      }
    }
  });
  const electron = { app, BrowserWindow: Window, Tray, Menu: { buildFromTemplate: value => value },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    screen: { getCursorScreenPoint: () => ({ x: 20, y: 20 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 1000 } }) },
    nativeImage: { createFromPath: () => ({ resize() { return this; }, setTemplateImage() {} }) },
    dialog: { showErrorBox: (...args) => { throw new Error(args.join(' ')); } },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } } },
    shell: { openExternal() {} } };
  const context = { __dirname: root, console, process: { platform, argv: [], arch: 'arm64', versions: {}, execPath },
    setTimeout: (fn, delay) => { const id = ++timerId; timeouts.set(id, { fn, delay }); return id; },
    clearTimeout: id => timeouts.delete(id),
    setInterval: fn => { intervals.push(fn); return { unref() {} }; },
    require: name => name === 'electron' ? electron : name === 'selection-hook' ? Hook : name === './policy' ? policy :
      name === './config' ? { loadConfig: () => ({ config: persisted, error: loadedError }),
        saveConfig: (_file, value) => { if (saveFails) throw new Error('disk full'); persisted = policy.validateConfig(value); return persisted; } } :
      name === './diagnostics' ? { diagnosticsEnabled: () => false, errorMetadata: () => ({}) } : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context);
  await Promise.resolve();
  function invoke(name, value) {
    const window = windows.find(item => Boolean(item.options.title) === name.startsWith('settings:'));
    return handlers.get(name)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, value);
  }
  function open() { Tray.instance.menu.find(item => item.label === '设置与应用黑名单…').click(); }
  return { calls, windows, policy, app, hook: Hook.instance, tray: Tray.instance, invoke, open,
    loginCalls, loginState, execPath, timeouts,
    get persisted() { return persisted; }, grant(value) { granted = value; },
    failSave() { saveFails = true; }, failStart() { startFails = true; }, tick() { intervals.forEach(fn => fn()); } };
}

test('invalid settings and failed persistence leave config and running hook untouched', async () => {
  const h = await harness(); h.open();
  const original = h.persisted;
  const before = h.calls.stop;
  const invalid = h.invoke('settings:save', { ...original, blacklist: ['*'] });
  assert.equal(invalid.ok, false);
  assert.equal(h.calls.stop, before);
  assert.equal(h.hook.isRunning(), true);
  assert.equal(h.persisted, original);
  h.failSave();
  const failed = h.invoke('settings:save', { ...original, paused: true });
  assert.equal(failed.ok, false);
  assert.equal(h.calls.stop, before);
  assert.equal(h.hook.isRunning(), true);
  assert.equal(h.persisted, original);
});

test('start failure keeps persisted configuration and stops runtime', async () => {
  const h = await harness(); h.open(); h.failStart();
  const result = h.invoke('settings:save', { paused: false, clipboardFallback: true, blacklist: ['com.example.app'] });
  assert.equal(result.ok, false);
  assert.equal(result.state.paused, h.persisted.paused);
  assert.equal(result.state.clipboardFallback, h.persisted.clipboardFallback);
  assert.equal(result.state.running, false);
  assert.ok(result.state.error);
});

test('first grant starts once, revocation stops once, regrant resumes without altering pause', async () => {
  const h = await harness({ granted: false });
  assert.equal(h.calls.start.length, 0);
  assert.ok(h.invoke('settings:read').permissionMessage);
  h.grant(true); h.tick(); h.tick();
  assert.equal(h.calls.start.length, 1);
  assert.equal(h.invoke('settings:read').accessibility, true);
  h.grant(false); h.tick(); h.tick();
  assert.equal(h.calls.stop, 1);
  assert.equal(h.invoke('settings:read').paused, false);
  h.grant(true); h.tick();
  assert.equal(h.calls.start.length, 2);
});

test('permission refresh on settings focus preserves user pause and unrelated error', async () => {
  for (const options of [{ paused: true }, { loadedError: 'invalid config' }]) {
    const h = await harness({ ...options, granted: false });
    h.grant(true);
    h.windows.find(window => window.options.title).emit('focus');
    assert.equal(h.calls.start.length, 0);
    const state = h.invoke('settings:read');
    assert.equal(state.paused, Boolean(options.paused));
    assert.equal(state.error, options.loadedError || null);
  }
});

test('macOS terminal filters allow AX and prohibit fallback; Windows keeps full terminal block', async () => {
  for (const platform of ['darwin', 'win32']) {
    const h = await harness({ platform });
    const options = h.calls.start[0];
    for (const name of platform === 'darwin' ? ['com.apple.terminal', 'com.googlecode.iterm2'] : ['cmd.exe', 'pwsh.exe']) {
      assert.equal(h.policy.isBlocked(name.toUpperCase(), h.persisted), platform === 'win32');
      assert.ok(options.clipboardFilterList.includes(name));
      assert.equal(options.globalFilterList.includes(name), platform === 'win32');
    }
    assert.ok(options.clipboardFilterList.every(name => name === name.toLowerCase()));
  }
});

test('macOS popup spans fullscreen workspaces and still shows inactive; Windows skips workspace API', async () => {
  for (const platform of ['darwin', 'win32']) {
    const h = await harness({ platform });
    assert.equal(h.calls.workspaces.length, platform === 'darwin' ? 1 : 0);
    if (platform === 'darwin') {
      assert.equal(h.calls.workspaces[0][0], true);
      assert.equal(h.calls.workspaces[0][1].visibleOnFullScreen, true);
    }
    const popup = h.windows[0];
    assert.equal(popup.options.focusable, false);
    popup.webContents.emit('did-finish-load');
    h.hook.emit('text-selection', { text: 'sample', programName: platform === 'darwin' ? 'com.apple.TextEdit' : 'notepad.exe',
      mousePosEnd: { x: 20, y: 20 }, posLevel: 0 });
    assert.equal(h.calls.inactive, true);
  }
});
test('successful popup copy shows feedback before hiding and rejects duplicate clicks', async () => {
  const h = await harness();
  const popup = h.windows[0];
  popup.webContents.emit('did-finish-load');
  h.hook.emit('text-selection', { text: 'sample', programName: 'com.apple.TextEdit',
    mousePosEnd: { x: 20, y: 20 }, posLevel: 0 });
  const selection = popup.messages.find(([channel]) => channel === 'popup:selection');
  assert.ok(selection);
  const token = selection[1];
  assert.equal(h.invoke('popup:copy', token), true);
  assert.deepEqual(h.calls.writes, ['sample']);
  assert.equal(popup.hidden, false);
  assert.deepEqual([...h.timeouts.values()].map(timer => timer.delay), [650]);
  assert.equal(h.invoke('popup:copy', token), false);
  assert.deepEqual(h.calls.writes, ['sample']);
  [...h.timeouts.values()].forEach(timer => timer.fn());
  assert.equal(popup.hidden, true);
});

test('old feedback timer cannot hide a new selection', async () => {
  const h = await harness();
  const popup = h.windows[0];
  popup.webContents.emit('did-finish-load');
  const select = text => h.hook.emit('text-selection', { text, programName: 'com.apple.TextEdit',
    mousePosEnd: { x: 20, y: 20 }, posLevel: 0 });
  select('first');
  const firstToken = popup.messages.at(-1)[1];
  assert.equal(h.invoke('popup:copy', firstToken), true);
  const oldTimer = [...h.timeouts.values()][0];
  select('second');
  assert.deepEqual([...h.timeouts.values()].map(timer => timer.delay), [7000]);
  oldTimer.fn();
  assert.equal(popup.hidden, false);
  assert.equal(h.invoke('popup:copy', popup.messages.at(-1)[1]), true);
  assert.deepEqual(h.calls.writes, ['first', 'second']);
});

test('failed popup copy stays available for retry', async () => {
  const h = await harness();
  const popup = h.windows[0];
  popup.webContents.emit('did-finish-load');
  h.hook.emit('text-selection', { text: 'sample', programName: 'com.apple.TextEdit',
    mousePosEnd: { x: 20, y: 20 }, posLevel: 0 });
  const token = popup.messages.at(-1)[1];
  h.hook.writeToClipboard = () => false;
  assert.equal(h.invoke('popup:copy', token), false);
  assert.equal(popup.hidden, false);
  assert.deepEqual([...h.timeouts.values()].map(timer => timer.delay), [7000]);
  h.hook.writeToClipboard = () => true;
  assert.equal(h.invoke('popup:copy', token), true);
});

test('macOS sets the bundled Copick Dock icon', async () => {
  const h = await harness({ platform: 'darwin' });
  assert.match(h.calls.dockIcon, /assets[\\/]icon\.png$/);
});

test('Dock 显示完成后恢复 Copick 图标，再次显示时也会恢复', async () => {
  const h = await harness({ platform: 'darwin' });
  for (let index = 0; index < 2; index++) {
    h.open();
    h.calls.finishDockShow();
    assert.equal(h.calls.dockIcon, 'Electron');
    await Promise.resolve();
    assert.match(h.calls.dockIcon, /assets[\\/]icon\.png$/);
  }
});

test('Windows does not try to configure a Dock icon', async () => {
  const h = await harness({ platform: 'win32' });
  assert.equal(h.calls.dockIcon, undefined);
});

test('popup activation does not open settings; Dock activation without windows does', async () => {
  const h = await harness();
  const popup = h.windows[0];
  popup.isVisible = () => true;
  h.app.emit('activate', {}, true);
  assert.equal(h.windows.length, 1);
  h.app.emit('activate', {}, false);
  assert.equal(h.windows.length, 1);
  popup.isVisible = () => false;
  h.app.emit('activate', {}, false);
  assert.equal(h.windows.length, 2);
});

test('Windows heals a moved portable folder and reports the live Task Manager state', async () => {
  const moved = await harness({ platform: 'win32', loginItem: true,
    login: { openAtLogin: true, path: 'C:/Old/Copick.exe' } });
  assert.deepEqual(plain(moved.loginCalls), [{ openAtLogin: true, path: moved.execPath, args: [] }]);
  moved.open();
  const state = moved.invoke('settings:read');
  assert.equal(state.loginItem, true);
  assert.equal(state.loginItemActive, true);
  assert.equal(state.loginItemMessage, null);

  const disabled = await harness({ platform: 'win32', loginItem: true,
    login: { openAtLogin: true, entryEnabled: false } });
  assert.equal(disabled.loginCalls.length, 0);
  disabled.open();
  const blockedState = disabled.invoke('settings:read');
  assert.equal(blockedState.loginItemActive, false);
  assert.match(blockedState.loginItemMessage, /任务管理器/);
});

test('saving the toggle registers and removes the login item, unpackaged runs stay out', async () => {
  const h = await harness({ platform: 'win32' });
  h.open();
  assert.equal(h.invoke('settings:save', { ...h.persisted, loginItem: true }).ok, true);
  assert.deepEqual(plain(h.loginCalls.at(-1)), { openAtLogin: true, path: h.execPath, args: [] });
  assert.equal(h.persisted.loginItem, true);
  assert.equal(h.invoke('settings:save', { ...h.persisted, loginItem: false }).ok, true);
  assert.deepEqual(plain(h.loginCalls.at(-1)), { openAtLogin: false, path: h.execPath, args: [] });

  const dev = await harness({ packaged: false, loginItem: true });
  assert.equal(dev.loginCalls.length, 0);
  dev.open();
  assert.match(dev.invoke('settings:read').loginItemMessage, /开发模式/);
});

test('macOS reads login item status, leaves a pending approval alone, cleans up leftovers', async () => {
  const steady = await harness({ platform: 'darwin', loginItem: true, login: { openAtLogin: true } });
  assert.equal(steady.loginCalls.length, 0);
  steady.open();
  assert.equal(steady.invoke('settings:read').loginItemActive, true);

  const pending = await harness({ platform: 'darwin', loginItem: true, login: { status: 'requires-approval' } });
  assert.equal(pending.loginCalls.length, 0);
  pending.open();
  assert.equal(pending.invoke('settings:read').loginItemActive, false);
  assert.match(pending.invoke('settings:read').loginItemMessage, /登录项/);
  assert.equal(pending.invoke('settings:open-login-items'), true);

  const leftover = await harness({ platform: 'darwin', login: { openAtLogin: true } });
  assert.deepEqual(plain(leftover.loginCalls), [{ openAtLogin: false }]);
});
