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
  launchAtLogin = false, packaged = true, login = {}, diagnostics = false, autoReady = true } = {}) {
  const policyContext = { module: { exports: {} }, process: { platform } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'policy.js'), 'utf8'), policyContext);
  const policy = policyContext.module.exports;
  const calls = { stop: 0, start: [], writes: [], workspaces: [], dialogChoice: 0 };
  // Fake executable paths; the login item code only compares them as strings.
  const execPath = platform === 'win32' ? 'C:/Copick/Copick.exe' : '/Applications/Copick.app/Contents/MacOS/Copick';
  const loginCalls = [];
  const loginState = { openAtLogin: login.openAtLogin ?? launchAtLogin, entryEnabled: login.entryEnabled ?? true,
    path: login.path ?? execPath, status: login.status ?? null };
  const paths = { appData: '/fake', userData: '/fake/copick-app', logs: '/fake/copick-app/logs' };
  let persisted = { paused, clipboardFallback: false, launchAtLogin, blacklist: [] };
  let saveFails = false, startFails = false, foregroundFails = false;
  let active = { program: platform === 'darwin' ? 'com.apple.textedit' : 'notepad.exe', pid: 100 };
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
      this.webContents.send = (...args) => {
        this.messages = this.messages || []; this.messages.push(args);
        if (autoReady && args[0] === 'popup:selection') {
          handlers.get('popup:ready')({ sender: this.webContents, senderFrame: this.webContents.mainFrame }, args[1]);
        }
      };
      windows.push(this);
    }
    isDestroyed() { return false; }
    isFocused() { return this.focused; }
    isVisible() { return false; }
    hide() { this.hidden = true; }
    show() {} focus() {} loadFile() {}
    close() { calls.settingsClose = (calls.settingsClose || 0) + 1; }
    showInactive() { this.hidden = false; calls.inactive = true; }
    moveTop() { calls.moveTop = (calls.moveTop || 0) + 1; }
    setAlwaysOnTop(...args) { calls.alwaysOnTop = args; }
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
    setPath(name, value) { paths[name] = value; },
    setAppLogsPath() { paths.logs = path.join(paths.userData, 'logs'); calls.logsPath = paths.logs; },
    whenReady: () => Promise.resolve(), getPath: name => paths[name],
    quit() { calls.quit = (calls.quit || 0) + 1; }, exit() {}, getVersion: () => 'test',
    dock: { setIcon: value => { calls.dockIcon = value; },
      show: () => new Promise(resolve => { calls.finishDockShow = () => { calls.dockIcon = 'Electron'; resolve(); }; }),
      hide() {} },
    getLoginItemSettings: options => {
      calls.loginReadOptions = options;
      return platform === 'darwin'
        ? { openAtLogin: loginState.openAtLogin,
          status: loginState.status || (loginState.openAtLogin ? 'enabled' : 'not-registered') }
        : { openAtLogin: loginState.openAtLogin && loginState.path.toLowerCase() === execPath.toLowerCase(),
          executableWillLaunchAtLogin: loginState.openAtLogin && loginState.entryEnabled &&
            loginState.path.toLowerCase() === execPath.toLowerCase(),
          launchItems: loginState.openAtLogin
            ? [{ name: 'Copick', path: loginState.path, args: [], scope: 'user', enabled: loginState.entryEnabled }]
            : [] };
    },
    setLoginItemSettings: settings => {
      loginCalls.push(settings);
      calls.loginItems = (calls.loginItems || []).concat(settings);
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
    dialog: { showErrorBox: (...args) => { throw new Error(args.join(' ')); },
      showMessageBoxSync: (_window, options) => { calls.closeDialog = options; return calls.dialogChoice; } },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } } },
    shell: { openExternal() {}, openPath: async value => { calls.openPath = value; return ''; } } };
  const context = { __dirname: root, console, process: { platform, argv: [], arch: 'arm64', versions: {}, execPath },
    setTimeout: (fn, delay) => { const id = ++timerId; timeouts.set(id, { fn, delay }); return id; },
    clearTimeout: id => timeouts.delete(id),
    setInterval: fn => { intervals.push(fn); return { unref() {} }; },
    require: name => name === 'electron' ? electron : name === 'selection-hook' ? Hook : name === './policy' ? policy :
      name === './config' ? { loadConfig: file => { calls.configPath = file; return { config: persisted, error: loadedError }; },
        saveConfig: (_file, value) => { if (saveFails) throw new Error('disk full'); persisted = policy.validateConfig(value); return persisted; } } :
      name === './program-names' ? require('../src/program-names') :
      name === './foreground' ? { sameApplication: require('../src/foreground').sameApplication,
        readForeground: () => { if (foregroundFails) throw new Error('query failed'); return active; } } :
      name === './diagnostics' ? { diagnosticsEnabled: () => diagnostics, errorMetadata: () => ({}),
        createDiagnostics: () => ({ log: (event, metadata) => {
          calls.diagnostics = calls.diagnostics || []; calls.diagnostics.push([event, metadata]);
        } }) } : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context);
  await Promise.resolve();
  function invoke(name, value) {
    const window = windows.findLast(item => Boolean(item.options.title) === name.startsWith('settings:'));
    return handlers.get(name)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, value);
  }
  function open() { Tray.instance.menu.find(item => item.label === '设置…').click(); }
  return { calls, windows, policy, app, hook: Hook.instance, tray: Tray.instance, invoke, open,
    loginCalls, loginState, execPath, timeouts,
    get persisted() { return persisted; }, grant(value) { granted = value; },
    foreground(value) { active = value; }, failForeground() { foregroundFails = true; },
    failSave() { saveFails = true; }, failStart() { startFails = true; }, tick() { intervals.forEach(fn => fn()); },
    setLoginItem(value) { Object.assign(loginState, value); } };
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
    assert.equal(popup.options.alwaysOnTop, true);
    assert.deepEqual(plain(h.calls.alwaysOnTop), [true, 'pop-up-menu']);
    popup.webContents.emit('did-finish-load');
    h.hook.emit('text-selection', { text: 'sample', programName: platform === 'darwin' ? 'com.apple.TextEdit' : 'notepad.exe',
      mousePosEnd: { x: 20, y: 20 }, posLevel: 0 });
    assert.equal(h.calls.inactive, true);
    assert.equal(h.calls.moveTop, 1);
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

test('新选区等待页面准备才显示，旧 token 和重复确认无法唤起浮窗', async () => {
  const h = await harness({ autoReady: false });
  const popup = h.windows[0];
  popup.webContents.emit('did-finish-load');
  const select = text => {
    h.hook.emit('text-selection', { text, programName: 'com.apple.TextEdit',
      mousePosEnd: { x: 20, y: 20 }, posLevel: 0 });
    return popup.messages.at(-1)[1];
  };
  const first = select('first');
  assert.equal(popup.hidden, true);
  assert.equal(h.calls.moveTop, undefined);
  assert.equal(h.invoke('popup:copy', first), false);
  assert.equal(h.invoke('popup:ready', first), true);
  assert.equal(popup.hidden, false);
  assert.equal(h.invoke('popup:copy', first), true);
  const second = select('second');
  assert.equal(popup.hidden, true);
  assert.equal(h.invoke('popup:ready', first), false);
  assert.equal(popup.hidden, true);
  assert.equal(h.invoke('popup:ready', second), true);
  assert.equal(h.invoke('popup:ready', second), false);
  assert.equal(h.calls.moveTop, 2);
  const third = select('third');
  h.hook.emit('key-down');
  assert.equal(h.invoke('popup:ready', third), false);
  assert.equal(popup.hidden, true);
  const fourth = select('fourth');
  h.foreground({ program: 'com.example.other', pid: 200 });
  assert.equal(h.invoke('popup:ready', fourth), false);
  assert.equal(popup.hidden, true);
  assert.deepEqual(h.calls.writes, ['first']);
});

test('popup ready 确认拒绝错误页面及已超时的选区', async () => {
  const h = await harness({ autoReady: false });
  const popup = h.windows[0];
  popup.webContents.emit('did-finish-load');
  h.hook.emit('text-selection', { text: 'sample', programName: 'com.apple.TextEdit',
    mousePosEnd: { x: 20, y: 20 }, posLevel: 0 });
  const token = popup.messages.at(-1)[1];
  const url = popup.webContents.mainFrame.url;
  popup.webContents.mainFrame.url = url.replace('popup.html', 'settings.html');
  assert.equal(h.invoke('popup:ready', token), false);
  popup.webContents.mainFrame.url = url;
  [...h.timeouts.values()].forEach(timer => timer.fn());
  assert.equal(h.invoke('popup:ready', token), false);
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

test('应用激活只恢复已有设置窗口，不创建新窗口', async () => {
  const h = await harness();
  h.app.emit('activate', {}, false);
  assert.equal(h.windows.length, 1);
  h.open();
  const settings = h.windows[1];
  let shown = 0;
  settings.show = () => { shown++; };
  h.app.emit('activate', {}, false);
  assert.equal(shown, 1);
  assert.equal(h.windows.length, 2);
});

test('复制成功并隐藏后到达的激活事件不会打开设置，托盘仍可打开', async () => {
  const h = await harness();
  const popup = h.windows[0];
  popup.webContents.emit('did-finish-load');
  h.hook.emit('text-selection', { text: 'sample', programName: 'com.apple.TextEdit',
    mousePosEnd: { x: 20, y: 20 }, posLevel: 0 });
  h.app.emit('activate', {}, false);
  assert.equal(h.windows.length, 1);
  assert.equal(h.invoke('popup:copy', popup.messages.at(-1)[1]), true);
  h.app.emit('activate', {}, true);
  assert.equal(h.windows.length, 1);
  [...h.timeouts.values()].forEach(timer => timer.fn());
  assert.equal(popup.hidden, true);
  for (const visible of [false, true, false]) h.app.emit('activate', {}, visible);
  assert.equal(h.windows.length, 1);
  h.open();
  assert.equal(h.windows.length, 2);
});

test('浮窗超时或被键鼠关闭后的激活事件不会创建设置窗口', async () => {
  for (const dismiss of ['timeout', 'key-down', 'mouse-wheel', 'mouse-down']) {
    const h = await harness();
    const popup = h.windows[0];
    popup.webContents.emit('did-finish-load');
    h.hook.emit('text-selection', { text: 'sample', programName: 'com.apple.TextEdit',
      mousePosEnd: { x: 20, y: 20 }, posLevel: 0 });
    if (dismiss === 'timeout') [...h.timeouts.values()].forEach(timer => timer.fn());
    else h.hook.emit(dismiss, { x: 900, y: 900 });
    assert.equal(popup.hidden, true);
    h.app.emit('activate', {}, false);
    assert.equal(h.windows.length, 1, dismiss);
  }
});

test('浮窗交互不会唤起已有设置窗口，重新启动应用仍可打开设置', async () => {
  const h = await harness();
  h.open();
  const settings = h.windows[1];
  let shown = 0;
  settings.show = () => { shown++; };
  const popup = h.windows[0];
  popup.isVisible = () => true;
  h.app.emit('activate', {}, false);
  assert.equal(shown, 0);
  popup.isVisible = () => false;
  h.app.emit('second-instance');
  assert.equal(shown, 1);
});

test('Windows heals a moved portable folder and reports the live Task Manager state', async () => {
  const moved = await harness({ platform: 'win32', launchAtLogin: true,
    login: { openAtLogin: true, path: 'C:/Old/Copick.exe' } });
  assert.deepEqual(plain(moved.loginCalls), [{ openAtLogin: true, name: 'Copick', path: moved.execPath, args: [] }]);
  moved.open();
  const state = moved.invoke('settings:read');
  assert.equal(state.launchAtLogin, true);
  assert.equal(state.loginItemActive, true);
  assert.equal(state.loginItemMessage, null);

  const disabled = await harness({ platform: 'win32', launchAtLogin: true,
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
  assert.equal(h.invoke('settings:save', { ...h.persisted, launchAtLogin: true }).ok, true);
  assert.deepEqual(plain(h.loginCalls.at(-1)), { openAtLogin: true, name: 'Copick', path: h.execPath, args: [] });
  assert.equal(h.persisted.launchAtLogin, true);
  assert.equal(h.invoke('settings:save', { ...h.persisted, launchAtLogin: false }).ok, true);
  assert.deepEqual(plain(h.loginCalls.at(-1)), { openAtLogin: false, name: 'Copick', path: h.execPath, args: [] });

  const dev = await harness({ packaged: false, launchAtLogin: true });
  assert.equal(dev.loginCalls.length, 0);
  dev.open();
  assert.match(dev.invoke('settings:read').loginItemMessage, /开发模式/);
});

test('macOS reads login item status, leaves a pending approval alone, cleans up leftovers', async () => {
  const steady = await harness({ platform: 'darwin', launchAtLogin: true, login: { openAtLogin: true } });
  assert.equal(steady.loginCalls.length, 0);
  steady.open();
  assert.equal(steady.invoke('settings:read').loginItemActive, true);

  const pending = await harness({ platform: 'darwin', launchAtLogin: true, login: { status: 'requires-approval' } });
  assert.equal(pending.loginCalls.length, 0);
  pending.open();
  assert.equal(pending.invoke('settings:read').loginItemActive, false);
  assert.match(pending.invoke('settings:read').loginItemMessage, /登录项/);
  assert.equal(pending.invoke('settings:open-login-items'), true);

  const leftover = await harness({ platform: 'darwin', login: { openAtLogin: true } });
  assert.deepEqual(plain(leftover.loginCalls), [{ openAtLogin: false, name: 'Copick' }]);
});

test('IPC sender check compares decoded page paths, not URL spelling', async () => {
  const h = await harness({ platform: process.platform === 'win32' ? 'win32' : 'darwin' }); h.open();
  const settings = h.windows.find(window => window.options.title);
  const href = settings.webContents.mainFrame.url;
  // Chromium may spell the same file URL differently from Node: percent-encoding of
  // non-ASCII or space-containing install paths, or drive-letter case on Windows.
  settings.webContents.mainFrame.url = href.replace(/settings\.html$/, 'settings%2Ehtml');
  assert.ok(h.invoke('settings:read'));
  if (process.platform === 'win32') {
    settings.webContents.mainFrame.url = href.replace(/^file:\/\/\/([A-Z]):/, (_match, drive) => `file:///${drive.toLowerCase()}:`);
    assert.ok(h.invoke('settings:read'));
  }
  for (const url of [href.replace('settings.html', 'popup.html'), href.replace(/^file:/, 'http:'),
    'file:///tmp/settings.html', 'not a url', undefined]) {
    settings.webContents.mainFrame.url = url;
    assert.throws(() => h.invoke('settings:read'), /Invalid sender/);
  }
});

test('launchAtLogin writes the system login item only when it changes and reports actual state', async () => {
  const h = await harness(); h.open();
  assert.equal(h.calls.loginItems, undefined);
  const on = h.invoke('settings:save', { ...h.persisted, launchAtLogin: true });
  assert.equal(on.ok, true);
  assert.equal(JSON.stringify(h.calls.loginItems), JSON.stringify([{ openAtLogin: true, name: 'Copick' }]));
  assert.equal(on.state.launchAtLogin, true);
  assert.equal(on.state.loginItemActual, true);
  h.invoke('settings:save', { ...h.persisted, paused: true });
  assert.equal(h.calls.loginItems.length, 1);
  // Entry vanished (moved portable folder): state exposes the mismatch; restart re-asserts it.
  h.setLoginItem({ openAtLogin: false });
  assert.equal(h.invoke('settings:read').loginItemActual, false);
  const off = h.invoke('settings:save', { ...h.persisted, launchAtLogin: false });
  assert.equal(JSON.stringify(h.calls.loginItems.at(-1)), JSON.stringify({ openAtLogin: false, name: 'Copick' }));
  assert.equal(off.state.loginItemActual, false);
});
test('saving retries a missing login item without rewriting disabled or pending entries', async () => {
  const missing = await harness({ launchAtLogin: true }); missing.open();
  missing.setLoginItem({ openAtLogin: false });
  assert.equal(missing.invoke('settings:read').loginItemActual, false);
  assert.equal(missing.invoke('settings:save', missing.persisted).ok, true);
  assert.deepEqual(plain(missing.loginCalls), [{ openAtLogin: true, name: 'Copick' }]);
  assert.equal(missing.invoke('settings:read').loginItemActual, true);

  for (const options of [
    { platform: 'win32', login: { openAtLogin: true, entryEnabled: false } },
    { platform: 'darwin', login: { status: 'requires-approval' } }
  ]) {
    const h = await harness({ ...options, launchAtLogin: true }); h.open();
    assert.equal(h.invoke('settings:save', h.persisted).ok, true);
    assert.equal(h.loginCalls.length, 0);
    assert.equal(h.invoke('settings:read').loginItemActive, false);
  }
});

test('userData and logs use the Copick directory before loading config', async () => {
  for (const platform of ['darwin', 'win32']) {
    const h = await harness({ platform }); h.open();
    const expected = path.join('/fake', 'Copick');
    assert.equal(h.app.getPath('userData'), expected);
    assert.equal(h.calls.logsPath, path.join(expected, 'logs'));
    assert.equal(h.calls.configPath, path.join(expected, 'config.json'));
    assert.equal(h.invoke('settings:read').configPath, h.calls.configPath);
  }
});

test('popup IPC diagnostics reject the wrong page and record copied after the feedback delay', async () => {
  const h = await harness({ diagnostics: true });
  const popup = h.windows[0];
  popup.webContents.emit('did-finish-load');
  h.hook.emit('text-selection', { text: 'private selection', programName: 'com.apple.TextEdit',
    mousePosEnd: { x: 20, y: 20 }, posLevel: 0 });
  const token = popup.messages.at(-1)[1];
  const href = popup.webContents.mainFrame.url;
  popup.webContents.mainFrame.url = href.replace('popup.html', 'settings.html');
  assert.equal(h.invoke('popup:copy', token), false);
  assert.deepEqual(h.calls.writes, []);
  assert.ok(h.calls.diagnostics.some(([event, metadata]) => event === 'ipc-rejected' && metadata.channel === 'popup:copy'));
  popup.webContents.mainFrame.url = href.replace('popup.html', 'popup%2Ehtml');
  assert.equal(h.invoke('popup:copy', token), true);
  assert.equal(popup.hidden, false);
  assert.equal(h.calls.diagnostics.some(([event, metadata]) => event === 'popup-hidden' && metadata.reason === 'copied'), false);
  [...h.timeouts.values()].find(timer => timer.delay === 650).fn();
  assert.equal(popup.hidden, true);
  assert.ok(h.calls.diagnostics.some(([event, metadata]) => event === 'popup-hidden' && metadata.reason === 'copied'));
  assert.equal(JSON.stringify(h.calls.diagnostics).includes('private selection'), false);
});

test('托盘保留常用操作，帮助入口可打开设置并请求展开排查', async () => {
  const h = await harness();
  assert.deepEqual(plain(h.tray.menu.filter(item => item.type !== 'separator').map(item => item.label)),
    ['Copick · 运行中', '暂停划词', '在最近取词应用中停用', '设置…', '帮助与诊断', '退出 Copick']);
  const help = h.tray.menu.find(item => item.label === '帮助与诊断').submenu;
  help.find(item => item.label === '没有出现复制按钮？').click();
  assert.equal(h.windows.length, 2);
  assert.equal(h.invoke('settings:read').helpRequest, 1);
  h.windows[0].webContents.emit('did-finish-load');
  h.foreground({ program: 'com.apple.safari', pid: 200 });
  h.hook.emit('text-selection', { text: 'sample', programName: 'com.apple.Safari',
    mousePosEnd: { x: 20, y: 20 }, posLevel: 0 });
  const exclude = h.tray.menu.find(item => item.label === '在此应用中停用：Safari');
  assert.ok(exclude.enabled);
  exclude.click();
  assert.deepEqual(plain(h.persisted.blacklist), ['com.apple.safari']);
  h.windows[1].emit('closed');
  h.open();
  assert.equal(h.invoke('settings:read').helpRequest, 0);
});

test('诊断开关即时生效且不写配置，关闭后拒绝打开日志目录', async () => {
  const h = await harness(); h.open();
  const original = h.persisted;
  assert.equal(h.invoke('settings:read').diagnosticsEnabled, false);
  await assert.rejects(h.invoke('settings:open-logs'), /先开启/);
  assert.throws(() => h.invoke('settings:diagnostics', 'true'), /Invalid request/);
  assert.equal(h.invoke('settings:diagnostics', true).diagnosticsEnabled, true);
  assert.equal(h.persisted, original);
  assert.ok(h.calls.diagnostics.some(([event]) => event === 'diagnostics-enabled'));
  h.hook.emit('mouse-up'); h.tick();
  assert.ok(h.calls.diagnostics.some(([event, metadata]) => event === 'heartbeat' && metadata.mouseUp === 1));
  assert.equal(await h.invoke('settings:open-logs'), true);
  assert.equal(h.calls.openPath, h.app.getPath('logs'));
  const settings = h.windows[1];
  const href = settings.webContents.mainFrame.url;
  settings.webContents.mainFrame.url = href.replace('settings.html', 'popup.html');
  assert.throws(() => h.invoke('settings:diagnostics', false), /Invalid request/);
  await assert.rejects(h.invoke('settings:open-logs'), /Invalid sender/);
  settings.webContents.mainFrame.url = href;
  assert.equal(h.invoke('settings:diagnostics', false).diagnosticsEnabled, false);
  const count = h.calls.diagnostics.length;
  h.hook.emit('mouse-up'); h.tick();
  assert.equal(h.calls.diagnostics.length, count);
  await assert.rejects(h.invoke('settings:open-logs'), /先开启/);
});

test('未保存关闭默认保留编辑，明确放弃才允许卸载页面', async () => {
  const h = await harness(); h.open();
  const settings = h.windows[1];
  let allowed = false;
  const event = { preventDefault() { allowed = true; } };
  settings.webContents.emit('will-prevent-unload', event);
  assert.equal(allowed, false);
  assert.equal(h.calls.closeDialog.defaultId, 0);
  assert.equal(h.calls.closeDialog.cancelId, 0);
  h.calls.dialogChoice = 1;
  settings.webContents.emit('will-prevent-unload', event);
  assert.equal(allowed, true);
});

test('退出先关闭设置，取消后保留浮窗，再次退出仍可确认', async () => {
  const h = await harness(); h.open();
  const settings = h.windows[1];
  let prevented = 0;
  const event = { preventDefault() { prevented++; } };
  h.app.emit('before-quit', event);
  assert.equal(prevented, 1);
  assert.equal(h.calls.settingsClose, 1);
  assert.equal(h.windows.length, 2);
  settings.webContents.emit('will-prevent-unload', event);
  assert.equal(prevented, 1);
  h.app.emit('before-quit', event);
  assert.equal(h.calls.settingsClose, 2);
  h.calls.dialogChoice = 1;
  settings.webContents.emit('will-prevent-unload', event);
  settings.emit('closed');
  assert.equal(h.calls.quit, 1);
});

test('前台应用变化、同名不同进程及查询失败均拒绝复制并销毁旧 token', async () => {
  for (const platform of ['darwin', 'win32']) {
    for (const changed of [
      { program: platform === 'darwin' ? 'com.example.other' : 'other.exe', pid: 200 },
      { program: platform === 'darwin' ? 'com.apple.textedit' : 'notepad.exe', pid: 200 },
      null, 'error'
    ]) {
      const h = await harness({ platform, diagnostics: true });
      const popup = h.windows[0];
      popup.webContents.emit('did-finish-load');
      const program = platform === 'darwin' ? 'com.apple.TextEdit' : 'notepad.exe';
      h.hook.emit('text-selection', { text: 'private selection', programName: program,
        mousePosEnd: { x: 20, y: 20 }, posLevel: 0 });
      const token = popup.messages.at(-1)[1];
      if (changed === 'error') h.failForeground(); else h.foreground(changed);
      assert.equal(h.invoke('popup:copy', token), false);
      assert.equal(popup.hidden, true);
      assert.deepEqual(h.calls.writes, []);
      h.foreground({ program: program.toLowerCase(), pid: 100 });
      assert.equal(h.invoke('popup:copy', token), false);
      assert.equal(JSON.stringify(h.calls.diagnostics).includes('private selection'), false);
      assert.equal(JSON.stringify(h.calls.diagnostics).includes(program), false);
    }
  }
});

test('轮询发现前台切换后清除旧选区，切回来源也无法复用', async () => {
  const h = await harness();
  const popup = h.windows[0];
  popup.webContents.emit('did-finish-load');
  h.hook.emit('text-selection', { text: 'sample', programName: 'com.apple.TextEdit',
    mousePosEnd: { x: 20, y: 20 }, posLevel: 0 });
  const token = popup.messages.at(-1)[1];
  h.foreground({ program: 'com.example.other', pid: 200 });
  h.tick();
  assert.equal(popup.hidden, true);
  h.foreground({ program: 'com.apple.textedit', pid: 100 });
  assert.equal(h.invoke('popup:copy', token), false);
  assert.deepEqual(h.calls.writes, []);
});

test('迟到的其他应用选区和未知前台来源不会显示浮窗', async () => {
  for (const active of [null, { program: 'com.example.other', pid: 200 }]) {
    const h = await harness();
    const popup = h.windows[0];
    popup.webContents.emit('did-finish-load');
    h.foreground(active);
    h.hook.emit('text-selection', { text: 'sample', programName: 'com.apple.TextEdit',
      mousePosEnd: { x: 20, y: 20 }, posLevel: 0 });
    assert.equal(h.calls.inactive, undefined);
    assert.deepEqual(h.calls.writes, []);
  }
});

test('config files written before launchAtLogin existed still load with it off', async () => {
  const h = await harness();
  const legacy = h.policy.validateConfig({ paused: false, clipboardFallback: true, blacklist: [] });
  assert.equal(legacy.launchAtLogin, false);
  assert.throws(() => h.policy.validateConfig({ paused: false, clipboardFallback: true, launchAtLogin: 'yes', blacklist: [] }));
});
