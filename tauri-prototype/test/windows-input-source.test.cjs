const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('Windows gesture binds the hit root before activation and validates source identity', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'copick-windows-source-'));
  try {
    const source = path.join(directory, 'source.cc');
    const executable = path.join(directory, process.platform === 'win32' ? 'source.exe' : 'source');
    const native = path.resolve(__dirname, '../src-tauri/native');
    writeFileSync(source, `
#include "windows_input_source.h"
#include <cassert>
using namespace copick;
int main() {
    constexpr WindowIdentity a{10, 100}, b{20, 200}, popup{30, 999};
    GestureSource gesture;
    uint64_t foreground = a.window;
    const auto down = gesture.Begin(b.window, b.pid);
    assert(down.window == b.window && down.pid == b.pid);
    // cp_arm accepts a live hit root even before Windows activates it.
    assert(ValidSource(down, b.window, b.pid, popup.pid));
    assert(down.window != foreground);
    foreground = b.window;
    const auto up = gesture.End();
    assert(up.window == down.window && up.pid == down.pid);
    assert(up.window == foreground);
    assert(gesture.End().window == 0);
    // Foreground changes must not replace a gesture's original source.
    gesture.Begin(b.window, b.pid);
    foreground = a.window;
    const auto changed = gesture.End();
    assert(changed.window == b.window && changed.window != foreground);
    // A destroyed/reused HWND, a child HWND, or our popup cannot arm capture.
    assert(!ValidSource(down, 0, 0, popup.pid));
    assert(!ValidSource(down, b.window, b.pid + 1, popup.pid));
    assert(!ValidSource({21, b.pid}, b.window, b.pid, popup.pid));
    assert(!ValidSource(popup, popup.window, popup.pid, popup.pid));
    assert(!ValidSource({}, 0, 0, popup.pid));
    gesture.Begin(b.window, b.pid);
    gesture.Reset();
    assert(gesture.End().window == 0);
    // A popup down has its own identity; it never inherits background B.
    const auto popupDown = gesture.Begin(popup.window, popup.pid);
    assert(popupDown.window == popup.window);
    assert(gesture.End().window == popup.window);
}
`);
    const compiler = process.env.CXX || (process.platform === 'win32' ? 'cl' : 'clang++');
    const msvc = /(?:^|[\\/])cl(?:\.exe)?$/i.test(compiler);
    const args = msvc
      ? ['/nologo', '/std:c++17', '/EHsc', '/utf-8', '/W4', '/WX', `/I${native}`, source, `/Fe:${executable}`, `/Fo:${path.join(directory, 'source.obj')}`]
      : ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', native, source, '-o', executable];
    const compiled = spawnSync(compiler, args, { encoding: 'utf8', cwd: directory });
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const result = spawnSync(executable, [], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
