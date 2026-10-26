'use strict';
// 运行真实 Electron 窗口、页面和 IPC；只替换原生 hook，避免监听桌面或写系统剪贴板。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require(process.env.COPICK_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'copick-ui-'));
const entry = path.join(temp, 'launch.cjs');
const configFile = path.join(temp, 'Copick', 'config.json');
fs.writeFileSync(entry, `const { app, dialog, ipcMain } = require('electron');
const handle = ipcMain.handle.bind(ipcMain);
global.pendingPopupReady = [];
ipcMain.handle = (channel, callback) => handle(channel, (event, token) => {
  if (channel === 'popup:ready' && global.holdPopupReady) {
    return new Promise(resolve => global.pendingPopupReady.push(() => resolve(callback(event, token))));
  }
  return callback(event, token);
});
global.releasePopupReady = () => { global.pendingPopupReady.splice(0).forEach(callback => callback()); };
app.setPath('appData', ${JSON.stringify(temp)});
const { EventEmitter } = require('node:events');
const Module = require('node:module');
class Hook extends EventEmitter {
  static FilterMode = { EXCLUDE_LIST: 2 };
  static PositionLevel = { SEL_FULL: 3 };
  constructor() { super(); global.testHook = this; this.running = false; }
  macIsProcessTrusted() { return true; }
  isRunning() { return this.running; }
  start() { this.running = !global.failStart; return this.running; }
  stop() { this.running = false; return true; }
  enableClipboard() { return true; }
  disableClipboard() { return true; }
  writeToClipboard(text) { global.testCopy = text; return true; }
  cleanup() { global.cleanedUp = true; }
}
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'selection-hook') return Hook;
  if (name === './foreground') return { sameApplication: (left, right) => Boolean(left && right && left.pid === right.pid && left.program === right.program),
    readForeground: () => global.testForeground === undefined
      ? { program: process.platform === 'win32' ? 'notepad.exe' : 'com.apple.textedit', pid: 100 } : global.testForeground };
  return load.call(this, name, ...args);
};
global.dialogChoice = 0;
global.dialogCount = 0;
dialog.showMessageBoxSync = () => { global.dialogCount++; return global.dialogChoice; };
require(${JSON.stringify(path.join(root, 'src/main.js'))});
`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let electron;
const errors = [];
async function openSettings() {
  await electron.evaluate(({ app }) => app.emit('second-instance'));
  let page = electron.windows().find(page => page.url().endsWith('/settings.html'));
  if (!page) page = await electron.waitForEvent('window');
  await page.waitForURL('**/settings.html');
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !document.getElementById('settings-fields').disabled);
  return page;
}
async function closeSettings() {
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .find(window => window.webContents.getURL().endsWith('/settings.html')).close());
}
function config() { return JSON.parse(fs.readFileSync(configFile, 'utf8')); }
(async () => {
  try {
    electron = await _electron.launch({ executablePath: require('electron'), args: [entry], timeout: 30000 });
    const popup = await electron.firstWindow();
    popup.on('pageerror', error => errors.push(error.message));
    await popup.waitForURL('**/popup.html');
    await popup.waitForSelector('#copy', { state: 'attached' });
    const page = await openSettings();
    console.log('已打开设置窗口');
    const save = page.locator('#save');
    assert.equal(await save.isDisabled(), true);
    await page.locator('#manual-entry summary').click();
    await page.locator('#blacklist').fill('*');
    await page.locator('#paused').check();
    await page.waitForFunction(() => !document.getElementById('settings-fields').disabled);
    assert.equal(config().paused, true);
    assert.deepEqual(config().blacklist, []);
    assert.equal(await page.locator('#blacklist').inputValue(), '*');
    assert.equal(await save.isEnabled(), true);
    await save.click();
    await page.locator('#blacklist-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#blacklist').getAttribute('aria-invalid'), 'true');
    await page.locator('#fallback').check();
    await page.waitForFunction(() => !document.getElementById('settings-fields').disabled);
    assert.equal(config().clipboardFallback, true);
    assert.deepEqual(config().blacklist, []);
    assert.equal(await page.locator('#blacklist').inputValue(), '*');
    await page.locator('#discard').click();
    assert.equal(await page.locator('#blacklist').inputValue(), '');
    assert.equal(await save.isDisabled(), true);
    const identifier = process.platform === 'win32' ? 'chrome.exe' : 'com.google.chrome';
    await page.locator('#blacklist').fill(identifier);
    await save.click();
    await page.waitForFunction(() => document.getElementById('message').textContent === '排除应用已保存');
    assert.deepEqual(config().blacklist, [identifier]);
    assert.match(await page.locator('#app-list').innerText(), /Chrome/);
    assert.match(await page.locator('#app-list .program-name').innerText(), new RegExp(identifier.replaceAll('.', '\\.')));
    await page.getByRole('button', { name: '移除 Chrome', exact: true }).click();
    assert.deepEqual(config().blacklist, [identifier]);
    await save.click();
    await page.waitForFunction(() => document.getElementById('save').disabled);
    assert.deepEqual(config().blacklist, []);
    console.log('自动保存、草稿隔离与应用列表通过');
    await page.locator('#login-item').check();
    await page.waitForFunction(() => !document.getElementById('settings-fields').disabled);
    assert.equal(config().launchAtLogin, true);
    assert.match(await page.locator('#login-item-help').innerText(), /开发模式/);
    await page.locator('#login-item').uncheck();
    await page.waitForFunction(() => !document.getElementById('settings-fields').disabled);
    // 模拟配置已写入但监听启动失败，UI 应显示真实持久化状态并允许重试。
    await electron.evaluate(() => { global.failStart = true; });
    await page.locator('#paused').uncheck();
    await page.waitForFunction(() => document.getElementById('status').textContent === '需要检查设置');
    assert.equal(config().paused, false);
    assert.equal(await page.locator('#paused').isChecked(), false);
    await electron.evaluate(() => { global.failStart = false; });
    await page.locator('#retry').click();
    await page.waitForFunction(() => document.getElementById('status').textContent === '正在监听选区');
    console.log('监听失败与重试通过');
    await page.locator('#blacklist').fill(identifier);
    await closeSettings();
    await page.waitForFunction(() => !document.getElementById('settings-fields').disabled);
    assert.equal(await page.locator('#blacklist').inputValue(), identifier);
    assert.equal(await electron.evaluate(() => global.dialogCount), 1);
    // 退出被取消后，监听、托盘和草稿都应继续可用。
    await electron.evaluate(({ app }) => app.quit());
    await delay(150);
    assert.equal(await electron.evaluate(() => global.dialogCount), 2);
    assert.equal(await electron.evaluate(() => Boolean(global.cleanedUp)), false);
    assert.equal(await electron.evaluate(() => global.testHook.isRunning()), true);
    assert.equal(popup.isClosed(), false);
    await page.locator('#discard').click();
    console.log('关闭和退出时取消通过');
    const real = await page.evaluate(() => window.copickSettings.read());
    await electron.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()
      .find(window => window.webContents.getURL().endsWith('/settings.html')).webContents.send('settings:state', value),
    { ...real, helpRequest: real.helpRequest + 1 });
    await page.waitForFunction(() => document.getElementById('troubleshooting').open);
    await page.locator('#diagnostics').check();
    await page.waitForFunction(() => !document.getElementById('diagnostics').disabled);
    assert.equal(await page.locator('#open-logs').isEnabled(), true);
    const logs = await electron.evaluate(({ app }) => app.getPath('logs'));
    const logFile = path.join(logs, 'selection.log');
    assert.match(fs.readFileSync(logFile, 'utf8'), /diagnostics-enabled/);
    await page.locator('#diagnostics').uncheck();
    await page.waitForFunction(() => !document.getElementById('diagnostics').disabled);
    assert.equal(await page.locator('#open-logs').isDisabled(), true);
    assert.equal(Object.hasOwn(config(), 'diagnosticsEnabled'), false);
    console.log('帮助与诊断通过');
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.screenshot({ path: path.join(temp, `settings-${theme}.png`), fullPage: true });
    }
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find(window => window.webContents.getURL().endsWith('/settings.html')).setSize(460, 540));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(temp, 'settings-small.png') });
    await page.locator('#blacklist').fill(identifier);
    await electron.evaluate(() => { global.dialogChoice = 1; });
    await Promise.all([page.waitForEvent('close'), closeSettings()]);
    assert.deepEqual(config().blacklist, []);
    await delay(800);
    // 重复开关设置窗口，核对新窗口恢复已保存配置且脚本没有报错。
    for (let index = 0; index < 2; index++) {
      const settings = await openSettings();
      assert.equal(await settings.locator('#blacklist').inputValue(), '');
      assert.equal(await settings.locator('#troubleshooting').getAttribute('open'), null);
      await Promise.all([settings.waitForEvent('close'), closeSettings()]);
      await delay(800);
    }
    for (const theme of ['light', 'dark']) {
      await popup.emulateMedia({ colorScheme: theme });
      for (const pointer of ['away', 'hover', 'active']) {
        await popup.locator('#copy').evaluate(button => { button.dataset.state = 'copied'; button.disabled = false; });
        await popup.mouse.move(pointer === 'away' ? 0 : 44, pointer === 'away' ? 0 : 20);
        if (pointer === 'active') await popup.mouse.down();
        assert.equal(await popup.locator('#copy').evaluate(button => getComputedStyle(button).backgroundColor), 'rgb(35, 116, 81)');
        if (pointer === 'active') await popup.mouse.up();
      }
    }
    await electron.evaluate(({ screen }) => {
      global.testHook.emit('text-selection', { text: 'UI regression sample',
        programName: process.platform === 'win32' ? 'notepad.exe' : 'com.apple.TextEdit',
        mousePosEnd: screen.getCursorScreenPoint(), posLevel: 0 });
    });
    await popup.locator('#copy').click();
    await popup.waitForFunction(() => document.getElementById('copy-label').textContent === '已复制');
    assert.equal(await electron.evaluate(() => global.testCopy), 'UI regression sample');
    await popup.screenshot({ path: path.join(temp, 'copied.png') });
    const popupVisible = () => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find(window => window.webContents.getURL().endsWith('/popup.html')).isVisible());
    const emitSelection = () => electron.evaluate(({ screen }) => global.testHook.emit('text-selection', {
      text: 'Fresh selection sample', programName: process.platform === 'win32' ? 'notepad.exe' : 'com.apple.TextEdit',
      mousePosEnd: screen.getCursorScreenPoint(), posLevel: 0
    }));
    for (const hiddenFirst of [false, true]) {
      if (hiddenFirst) await delay(900);
      await electron.evaluate(() => { global.holdPopupReady = true; });
      await emitSelection();
      await popup.waitForFunction(() => document.getElementById('copy').dataset.state === 'ready');
      await delay(120);
      assert.equal(await popupVisible(), false, '渲染就绪确认前必须保持隐藏');
      assert.equal(await popup.locator('#copy-label').innerText(), '复制');
      await electron.evaluate(() => { global.holdPopupReady = false; global.releasePopupReady(); });
      for (let attempt = 0; attempt < 100 && !await popupVisible(); attempt++) await delay(20);
      assert.equal(await popupVisible(), true);
      assert.equal(await popup.locator('#copy').getAttribute('data-state'), 'ready');
      assert.notEqual(await popup.locator('#copy').evaluate(button => getComputedStyle(button).backgroundColor), 'rgb(35, 116, 81)');
      await popup.screenshot({ path: path.join(temp, `new-selection-${hiddenFirst ? 'hidden' : 'visible'}.png`) });
      await popup.locator('#copy').click();
      await popup.waitForFunction(() => document.getElementById('copy-label').textContent === '已复制');
    }
    await delay(900);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find(window => window.webContents.getURL().endsWith('/popup.html')).isVisible()), false);
    await electron.evaluate(({ app }) => { app.emit('activate', {}, false); app.emit('activate', {}, true); });
    await delay(150);
    assert.equal(electron.windows().some(page => page.url().endsWith('/settings.html')), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, screenshots: temp,
      checked: ['自动保存与非法草稿隔离', '列表校验、保存、移除与撤销', '登录启动状态', '监听失败与重试',
        '关闭及退出时保留草稿、明确放弃', '帮助与会话诊断', '应用名称与原标识', '深浅色与最小窗口',
        '成功态六种颜色状态', '新选区渲染确认前保持隐藏，显示时已恢复复制', '实际点击复制、650ms 确认和延迟激活'],
      boundary: '原生 hook 与关闭确认的选择已模拟；窗口、渲染器、配置文件、IPC 和计时器均真实运行。' }, null, 2));
  } finally {
    if (electron) {
      await electron.evaluate(() => { global.dialogChoice = 1; }).catch(() => {});
      await electron.close();
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
