'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('取消与复制提交只有一个获胜者，提交后明确返回不可撤销', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copick-commit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'gate.cc');
  const executable = path.join(directory, process.platform === 'win32' ? 'gate.exe' : 'gate');
  fs.writeFileSync(source, `
#include "operation_gate.h"
#include <cassert>
#include <thread>
int main() {
    copick::OperationGate cancelled;
    assert(cancelled.Cancel() == 1);
    assert(!cancelled.TryCommit());
    assert(cancelled.CancelledBeforeCommit());
    copick::OperationGate committed;
    assert(committed.TryCommit());
    assert(committed.Cancel() == 2);
    assert(!committed.TryCommit());
    committed.FinishCommit();
    assert(committed.Cancel() == 2);
    for (int n = 0; n < 2000; ++n) {
        copick::OperationGate gate;
        bool write = false;
        int cancellation = 0;
        std::thread a([&] { write = gate.TryCommit(); });
        std::thread b([&] { cancellation = gate.Cancel(); });
        a.join(); b.join();
        assert((cancellation == 1 && !write) || (cancellation == 2 && write));
    }
}
`);
  const compiler = process.env.CXX || (process.platform === 'win32' ? 'cl' : 'clang++');
  const native = path.resolve(__dirname, '../src-tauri/native');
  const args = /(?:^|[\\/])cl(?:\.exe)?$/i.test(compiler)
    // operation_gate.h 含中文注释；不带 /utf-8 时，中文代码页（如 936）会把
    // UTF-8 尾字节误读成转义或续行，吞掉后续声明。与 build.rs 的编译选项保持一致。
    ? ['/nologo', '/std:c++17', '/EHsc', '/utf-8', `/I${native}`, source, `/Fe:${executable}`, `/Fo:${path.join(directory, 'gate.obj')}`]
    : ['-std=c++17', '-pthread', '-Wall', '-Wextra', '-Werror', '-I', native, source, '-o', executable];
  const compiled = spawnSync(compiler, args, { encoding: 'utf8', cwd: directory, timeout: 30000 });
  assert.ifError(compiled.error);
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 30000 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
