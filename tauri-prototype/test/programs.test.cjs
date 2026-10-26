const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('Windows 过滤列表覆盖终端、凭据界面与 IDE，并保留用户排除项', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'copick-programs-'));
  try {
    const source = path.join(directory, 'programs.cc');
    const executable = path.join(directory, process.platform === 'win32' ? 'programs.exe' : 'programs');
    const native = path.resolve(__dirname, '../src-tauri/native');
    writeFileSync(source, `
#include "programs.h"
#include <algorithm>
#include <cassert>
#include <cctype>
#include <string>
static bool Matches(const std::vector<std::string> &list, std::string name) {
    std::transform(name.begin(), name.end(), name.begin(),
        [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    for (const auto &item : list) if (name.find(item) != std::string::npos) return true;
    return false;
}
int main() {
    const auto &protectedList = copick::ProtectedPrograms();
    // 终端、远程会话与凭据界面在任何取词路径之前就被排除。
    for (const char *name : {"windowsterminal.exe", "windowsterminalpreview.exe", "cmd.exe",
        "powershell.exe", "powershell_ise.exe", "pwsh.exe", "conhost.exe", "openconsole.exe",
        "wsl.exe", "wslhost.exe", "mintty.exe", "putty.exe", "credentialuibroker.exe",
        "logonui.exe", "copick-tauri-prototype.exe", "1password.exe", "Bitwarden.exe"})
        assert(Matches(protectedList, name));
    assert(!Matches(protectedList, "notepad.exe"));
    assert(!Matches(protectedList, "word.exe"));
    // IDE 只关闭复制回退，无障碍取词必须保持可用。
    assert(!Matches(protectedList, "code.exe"));
    assert(!Matches(protectedList, "cursor.exe"));

    const auto clipboard = copick::ClipboardExclusions({"my-private-app.exe"});
    for (const char *name : {"code.exe", "cursor.exe", "windowsterminal.exe", "my-private-app.exe"})
        assert(Matches(clipboard, name));
    assert(!Matches(clipboard, "notepad.exe"));
    assert(copick::ClipboardExclusions({}).size() ==
        copick::ProtectedPrograms().size() + copick::NoClipboardPrograms().size());
}
`);
    const compiler = process.env.CXX || (process.platform === 'win32' ? 'cl' : 'clang++');
    const msvc = /(?:^|[\\/])cl(?:\.exe)?$/i.test(compiler);
    const args = msvc
      ? ['/nologo', '/std:c++17', '/EHsc', '/utf-8', '/W4', '/WX', `/I${native}`, source, `/Fe:${executable}`, `/Fo:${path.join(directory, 'programs.obj')}`]
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
