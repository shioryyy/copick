'use strict';
// 两个真实前台应用进程 + Copick，真实查询系统身份；模拟取词和写入，保护桌面剪贴板。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require(process.env.COPICK_PLAYWRIGHT_PATH || 'playwright');
const executablePath = require('electron');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copick-foreground-'));
const hostEntry = path.join(directory, 'host.cjs');
const entry = path.join(directory, 'copick.cjs');
fs.writeFileSync(hostEntry, `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 500, height: 240, title: 'Copick 前台核验测试' });
  window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<h1>前台应用测试</h1><p>用于验证应用进程切换，不读取桌面文字。</p>'));
});
`);
fs.writeFileSync(entry, `const { app } = require('electron');
app.setPath('appData', ${JSON.stringify(directory)});
global.readForeground = require(${JSON.stringify(path.join(root, 'src/foreground.js'))}).readForeground;
global.clipboardFingerprint = async () => {
  const clipboard = require('electron').clipboard;
  const hash = require('node:crypto').createHash('sha256');
  for (const item of await clipboard.read()) {
    for (const type of [...item.types].sort()) {
      const data = await item.getType(type);
      hash.update(type).update(typeof data.arrayBuffer === 'function'
        ? Buffer.from(await data.arrayBuffer()) : JSON.stringify(data));
    }
  }
  return hash.digest('hex');
};
const { EventEmitter } = require('node:events');
const Module = require('node:module');
class Hook extends EventEmitter {
  static FilterMode = { EXCLUDE_LIST: 2 };
  static PositionLevel = { SEL_FULL: 3 };
  constructor() { super(); global.testHook = this; this.running = false; }
  macIsProcessTrusted() { return true; }
  isRunning() { return this.running; }
  start() { this.running = true; return true; }
  stop() { this.running = false; return true; }
  enableClipboard() { return true; }
  disableClipboard() { return true; }
  writeToClipboard() { global.copyCount = (global.copyCount || 0) + 1; return true; }
  cleanup() {}
}
const load = Module._load;
Module._load = function(name, ...args) { return name === 'selection-hook' ? Hook : load.call(this, name, ...args); };
require(${JSON.stringify(path.join(root, 'src/main.js'))});
`);
const apps = [];
async function waitFor(read, predicate, description) {
  const expires = Date.now() + 5000;
  while (Date.now() < expires) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(description);
}
(async () => {
  try {
    const copick = await _electron.launch({ executablePath, args: [entry] }); apps.push(copick);
    const popup = await copick.firstWindow();
    await popup.waitForURL('**/popup.html');
    await popup.waitForSelector('#copy', { state: 'attached' });
    await popup.evaluate(() => window.copickPopup.onSelection(token => { window.testToken = token; }));
    const read = () => copick.evaluate(() => global.readForeground());
    const fingerprint = () => copick.evaluate(() => global.clipboardFingerprint());
    const before = await fingerprint();
    const hosts = [];
    for (let index = 0; index < 2; index++) {
      const host = await _electron.launch({ executablePath, args: [hostEntry] }); apps.push(host);
      await host.firstWindow();
      hosts.push({ app: host, pid: await host.evaluate(() => process.pid) });
    }
    async function focus(host) {
      await host.app.evaluate(({ app, BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus();
        app.focus({ steal: true });
      });
      return waitFor(read, value => value?.pid === host.pid, '系统前台身份未随窗口切换更新');
    }
    async function select(source) {
      await copick.evaluate(({ screen }, source) => global.testHook.emit('text-selection', {
        text: 'Foreground regression sample', programName: source.program,
        mousePosEnd: screen.getCursorScreenPoint(), posLevel: 0
      }), source);
      await waitFor(() => popup.evaluate(() => document.getElementById('copy').disabled), value => !value, '未显示新选区');
    }
    const first = await focus(hosts[0]);
    assert.ok(first.program);
    await select(first);
    await popup.locator('#copy').click();
    await popup.waitForFunction(() => document.getElementById('copy-label').textContent === '已复制');
    assert.equal(await copick.evaluate(() => global.copyCount), 1);
    await popup.screenshot({ path: path.join(directory, 'copied.png') });
    await focus(hosts[0]);
    await select(first);
    const oldToken = await popup.evaluate(() => window.testToken);
    const second = await focus(hosts[1]);
    assert.notEqual(first.pid, second.pid);
    assert.equal(first.program, second.program);
    await waitFor(() => copick.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find(window => window.webContents.getURL().endsWith('/popup.html')).isVisible()), value => !value, '切换进程后浮窗未隐藏');
    assert.equal(await popup.evaluate(token => window.copickPopup.copy(token), oldToken), false);
    await focus(hosts[0]);
    assert.equal(await popup.evaluate(token => window.copickPopup.copy(token), oldToken), false);
    assert.equal(await copick.evaluate(() => global.copyCount), 1);
    // 迟到的不同应用标识不得覆盖新前台状态。
    await copick.evaluate(({ screen }) => global.testHook.emit('text-selection', {
      text: 'Stale sample', programName: 'com.example.stale.exe', mousePosEnd: screen.getCursorScreenPoint(), posLevel: 0
    }));
    assert.equal(await copick.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find(window => window.webContents.getURL().endsWith('/popup.html')).isVisible()), false);
    assert.equal(await fingerprint(), before);
    console.log(JSON.stringify({ ok: true, screenshots: directory,
      checked: ['真实系统前台查询随进程切换更新', '同标识不同 PID 拒绝旧选区', '正常来源点击复制成功',
        '切换后隐藏及 token 失效', '切回原进程旧 token 仍失效', '迟到事件丢弃', 'Electron 可读取的剪贴板格式内容保持不变'],
      boundary: '原生身份查询、窗口切换和 IPC 真实运行；选区与写剪贴板动作模拟，未验证原生 AX/UIA 取词。' }, null, 2));
  } finally { for (const app of apps.reverse()) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
