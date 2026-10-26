'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
require('./macos-desktop.cjs').requireUnlockedDesktop();
const fault = process.argv[2] || 'marker-failure';
assert(['marker-failure', 'busy-timeout'].includes(fault));
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
const output = path.join(artifacts, `provider-cleanup-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
async function main() {
  const before = new Set(fs.readdirSync(artifacts));
  const runner = spawn(process.execPath, [path.join(__dirname, 'verify-macos-provider.cjs'), 'control', 'hung-provider'], {
    env: process.env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  runner.stdout.on('data', value => { log += value; });
  runner.stderr.on('data', value => { log += value; });
  const finished = new Promise(resolve => runner.on('exit', (code, signal) => resolve({ code, signal })));
  let folder;
  let result;
  let restoration;
  let stoppedProbe;
  try {
    const deadline = Date.now() + 20000;
    while (!folder) {
      for (const name of fs.readdirSync(artifacts)) {
        if (!before.has(name) && name.startsWith('hung-provider-control-') && fs.existsSync(path.join(artifacts, name, 'provider-entered'))) {
          folder = path.join(artifacts, name); break;
        }
      }
      assert(runner.exitCode === null, log);
      assert(Date.now() < deadline, 'Provider did not enter before cleanup fault');
      if (!folder) await delay(20);
    }
    {
      const fixtureExecutable = path.join(artifacts, 'fixture/CopickFixture.app/Contents/MacOS/CopickFixture');
      const end = Date.now() + 15000;
      let stopped = false;
      while (!stopped) {
        const { spawnSync } = require('node:child_process');
        const list = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
        assert.ifError(list.error);
        for (const row of list.stdout.split('\n')) {
          const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
          if (match && Number(match[2]) === runner.pid && match[3].startsWith(fixtureExecutable) && match[3].endsWith(path.join(folder, 'busy-probe'))) {
            if (fault === 'busy-timeout') {
              stoppedProbe = Number(match[1]);
              process.kill(stoppedProbe, 'SIGSTOP');
            } else {
              // busy-probe 启动说明超时/控制断言已通过，再注入 finally 的写入故障。
              fs.mkdirSync(path.join(folder, 'provider-finish'));
            }
            stopped = true; break;
          }
        }
        assert(Date.now() < end, 'Busy probe did not start');
        if (!stopped) await delay(10);
      }
    }
    result = await finished;
    assert.notEqual(result.code, 0, 'Cleanup fault must not report success');
    const end = Date.now() + 5000;
    while (!fs.existsSync(path.join(folder, 'clipboard-guardian.json'))) {
      assert(Date.now() < end, 'Independent guardian completion was not observed');
      await delay(20);
    }
    restoration = JSON.parse(fs.readFileSync(path.join(folder, 'clipboard-guardian.json'), 'utf8'));
    assert.equal(restoration.outcome, 'restoredVerified');
    assert.equal(restoration.testClipboardRestored, true);
    const interaction = JSON.parse(fs.readFileSync(path.join(folder, 'interaction.json'), 'utf8'));
    assert.equal(interaction.passed, false);
    if (fault === 'busy-timeout') assert.match(interaction.error, /Busy probe exceeded external deadline/);
    else assert.match(interaction.error, /EISDIR|illegal operation on a directory/);
    const report = { scenario: `provider-cleanup-${fault}`, sourcePid: process.pid, passed: true,
      runnerPid: runner.pid, expectedRunnerExitCode: result.code, providerFolder: folder, restoration,
      recoveryConfirmedByOuterHarness: true, runnerWaitsForGuardian: false };
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    try { fs.writeFileSync(path.join(output, 'runner.log'), log); }
    finally {
      if (stoppedProbe) {
        try { process.kill(stoppedProbe, 'SIGCONT'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGTERM');
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
