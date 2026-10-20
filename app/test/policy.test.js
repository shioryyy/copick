'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NO_CLIPBOARD, normalizeList, validateConfig, isBlocked, popupBounds, validPoint } = require('../src/policy');
const { loadConfig, saveConfig } = require('../src/config');
const isMac = process.platform === 'darwin';
const config = { paused: false, clipboardFallback: !isMac, loginItem: false, blacklist: [] };

test('platform defaults and identifiers match selection-hook programName', () => {
  if (isMac) {
    assert.equal(config.clipboardFallback, false);
    assert.ok(normalizeList(['com.example.App']).includes('com.example.app'));
    assert.equal(isBlocked('com.apple.finder', config), true);
  } else {
    assert.equal(config.clipboardFallback, true);
    assert.ok(normalizeList(['Example.exe']).includes('example.exe'));
  }
});
test('terminal/editor/password protection survives clearing custom blacklist', () => {
  if (isMac) {
    for (const name of ['com.apple.finder', 'com.1password.1password', 'com.apple.keychainaccess']) {
      assert.equal(isBlocked(name, config), true, name);
    }
    assert.equal(isBlocked('com.apple.TextEdit', config), false);
    for (const name of ['com.microsoft.visual-studio-code', 'com.todesktop.2305228j7', 'com.exafunction.windsurf']) {
      assert.equal(isBlocked(name, config), false);
      assert.ok(NO_CLIPBOARD.includes(name));
    }
  } else {
    for (const name of ['WindowsTerminal.exe', 'pwsh.exe', '1Password.exe', 'Copick.exe']) {
      assert.equal(isBlocked(name, config), true, name);
    }
    assert.equal(isBlocked('notepad.exe', config), false);
    for (const name of ['code.exe', 'cursor.exe', 'windsurf.exe']) {
      assert.equal(isBlocked(name, config), false);
      assert.ok(NO_CLIPBOARD.includes(name));
    }
  }
  const customName = isMac ? 'com.example.app' : 'example.exe';
  assert.equal(isBlocked(isMac ? 'com.example.App' : 'My-Example.exe', { ...config, blacklist: [customName] }), true);
});
test('blacklist validation rejects paths, wildcards and invalid config', () => {
  assert.deepEqual(normalizeList(isMac ? [' com.example.App ', 'com.example.app'] : [' Example.exe ', 'example.exe']),
    [isMac ? 'com.example.app' : 'example.exe']);
  for (const name of (isMac ? ['*', '/Applications/App.app', 'com.example.*', 'example'] : ['*', 'C:\\cmd.exe', '../cmd.exe', 'exe', '', 'x\n.exe'])) {
    assert.throws(() => normalizeList([name]));
  }
  assert.throws(() => validateConfig({ ...config, clipboardFallback: 'true' }));
});
test('login item is optional for older config files and rejects non-boolean values', () => {
  const { loginItem, ...legacy } = config;
  assert.equal(loginItem, false);
  assert.deepEqual(validateConfig(legacy), config);
  assert.equal(validateConfig({ ...config, loginItem: true }).loginItem, true);
  assert.throws(() => validateConfig({ ...config, loginItem: 'true' }));
});
test('work area placement handles negative monitors and bottom edges', () => {
  assert.deepEqual(popupBounds({ x: -10, y: 1070 }, { x: -1920, y: 0, width: 1920, height: 1080 }),
    { x: -88, y: 1018, width: 88, height: 40 });
  assert.equal(validPoint({ x: -99999, y: 0 }), false);
  assert.equal(validPoint({ x: NaN, y: 0 }), false);
  assert.equal(validPoint({ x: -100, y: 10 }), true);
});
test('settings round trip, defaults, and corrupt-file fail-closed behavior', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copick-config-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'nested', 'config.json');
  assert.deepEqual(loadConfig(file).config, config);
  const disabled = { paused: true, clipboardFallback: false, loginItem: true,
    blacklist: [isMac ? 'com.example.app' : 'example.exe'] };
  saveConfig(file, disabled);
  assert.deepEqual(loadConfig(file).config, disabled);
  assert.throws(() => saveConfig(file, { ...config, blacklist: [isMac ? '*' : '*'] }));
  assert.deepEqual(loadConfig(file).config, disabled);
  fs.writeFileSync(file, '{broken');
  const broken = loadConfig(file);
  assert.equal(broken.config.paused, true);
  assert.equal(broken.config.clipboardFallback, false);
  assert.ok(broken.error);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
