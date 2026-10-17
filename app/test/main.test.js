'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.join(__dirname, '..', 'src');

// Run the real main-process handlers with fake Electron/native boundaries: no desktop hooks.
async function harness({ platform = 'darwin', granted = true, paused = false, loadedError = null } = {}) {
  const policyContext = { module: { exports: {} }, process: { platform } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'policy.js'), 'utf8'), policyContext);
  const policy = policyContext.module.exports;
  const calls = { stop: 0, start: [], writes: [], workspaces: [] };
  let persisted = { paused, clipboardFallback: false, blacklist: [] };
  let saveFails = false, startFails = false;
  const handlers = new Map(), windows = [], intervals = [];
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
      this.webContents.send = () => {};
      windows.push(this);
    }
    isDestroyed() { return false; }
    isFocused() { return this.focused; }
    isVisible() { return false; }
    hide() {} show() {} focus() {} loadFile() {} showInactive() { calls.inactive = true; }
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
    requestSingleInstanceLock: () => true, setName() {}, setAppUserModelId() {},
    whenReady: () => Promise.resolve(), getPath: () => '/fake', quit() {}, exit() {}, getVersion: () => 'test'
  });
  const electron = { app, BrowserWindow: Window, Tray, Menu: { buildFromTemplate: value => value },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    screen: { getCursorScreenPoint: () => ({ x: 20, y: 20 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 1000 } }) },
    nativeImage: { createFromPath: () => ({ resize() { return this; }, setTemplateImage() {} }) },
    dialog: { showErrorBox: (...args) => { throw new Error(args.join(' ')); } },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } } },
    shell: { openExternal() {} } };
  const context = { __dirname: root, console, process: { platform, argv: [], arch: 'arm64', versions: {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: fn => { intervals.push(fn); return { unref() {} }; },
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
