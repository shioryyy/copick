'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createDiagnostics, errorMetadata, diagnosticsEnabled } = require('../src/diagnostics');

test('diagnostics are opt-in for this launch only', () => {
  assert.equal(diagnosticsEnabled(), false);
  assert.equal(diagnosticsEnabled(['Copick.exe']), false);
  assert.equal(diagnosticsEnabled(['Copick.exe', '--diagnostics']), true);
  assert.equal(diagnosticsEnabled(['Copick.exe', '--smoke-test']), false);
});

function mainHarness() {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const context = vm.createContext({ require: name => name === 'electron'
    ? { app: { requestSingleInstanceLock: () => false, quit() {} } } : require(name.startsWith('./') ? `../src/${name.slice(2)}` : name),
  __dirname: path.join(__dirname, '../src'), process: { platform: 'win32' }, console, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  return code => vm.runInContext(code, context);
}
test('fallback off -> on explicitly restores native state before start (2.1.1 skips default values)', () => {
  const run = mainHarness();
  run(`config = { paused: false, clipboardFallback: false, blacklist: [] };
    hook = { constructor: { FilterMode: { EXCLUDE_LIST: 2 } }, enabled: true,
      stop: () => true, isRunning: () => true,
      disableClipboard() { this.enabled = false; return true; },
      enableClipboard() { this.enabled = true; return true; },
      start(options) { if (!options.enableClipboard) this.enabled = false; return true; } };
    applyHook();`);
  assert.equal(run('hook.enabled'), false);
  run('config.clipboardFallback = true; applyHook();');
  assert.equal(run('hook.enabled'), true);
});
test('visible background settings do not drop selections; focused settings have a distinct reason', () => {
  const run = mainHarness();
  run(`config = { paused: false, clipboardFallback: true, blacklist: [] }; ready = true;
    hook = { isRunning: () => true, constructor: { PositionLevel: { SEL_FULL: 3 } } };
    settings = { isDestroyed: () => false, isVisible: () => true, isFocused: () => false };
    var events = []; diagnostics = { log: (event, metadata) => events.push([event, metadata]) };
    var data = { text: 'private selection', programName: 'notepad.exe', posLevel: 0 };
    var passedGate = false; pointInDip = () => { passedGate = true; return null; };`);
  // No Electron screen here: reaching the coordinate stage proves the settings gate passed.
  assert.throws(() => run('showSelection(data)'), /getCursorScreenPoint/);
  run('settings.isFocused = () => true; showSelection(data);');
  assert.equal(run("events.at(-1)[1].reason"), 'settings-focused');
  assert.equal(run("events.at(-1)[1].textLength"), 17);
  assert.equal(run("events.at(-1)[1].text"), undefined);
});
test('diagnostics allow only metadata, rate limit per reason, rotate and survive I/O errors', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copick-log-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let time = 10000;
  const logger = createDiagnostics(directory, () => time);
  logger.log('selection-drop', { reason: 'paused', text: 'SECRET', uniKey: 'SECRET', textLength: 6 });
  logger.log('selection-drop', { reason: 'paused' });
  logger.log('selection-drop', { reason: 'settings-focused' });
  time += 5000;
  logger.log('selection-drop', { reason: 'paused' });
  const rows = fs.readFileSync(logger.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].suppressed, 1);
  assert.equal(JSON.stringify(rows).includes('SECRET'), false);
  assert.equal(JSON.stringify(errorMetadata(new Error('SECRET'))).includes('SECRET'), false);
  fs.writeFileSync(logger.file, 'x'.repeat(512 * 1024));
  logger.log('heartbeat');
  assert.ok(fs.existsSync(`${logger.file}.1`));
  assert.ok(fs.statSync(logger.file).size < 1024);
  const blocked = path.join(directory, 'file');
  fs.writeFileSync(blocked, '');
  assert.doesNotThrow(() => createDiagnostics(blocked).log('startup'));
});
