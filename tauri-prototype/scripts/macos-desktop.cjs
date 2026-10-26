'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
function requireUnlockedDesktop() {
  const registry = spawnSync('ioreg', ['-n', 'Root', '-d1', '-a'], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(registry.error);
  assert.equal(registry.status, 0, 'Unable to read desktop session');
  const locked = spawnSync('plutil', ['-extract', 'IOConsoleLocked', 'raw', '-o', '-', '-'], {
    input: registry.stdout, encoding: 'utf8', timeout: 5000
  });
  assert.ifError(locked.error);
  assert.equal(locked.status, 0, 'Unable to verify desktop lock state');
  assert.equal(locked.stdout.trim(), 'false', 'macOS desktop is locked; no fixture or input was started');
}
module.exports = { requireUnlockedDesktop };
