'use strict';
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { prepareReport, readReport } = require('./verification-report.cjs');
const root = path.resolve(__dirname, '..');
const mode = process.argv[2] || 'control';
const scenario = process.argv[3] || process.env.COPICK_PROVIDER_SCENARIO || 'slow-provider';
assert(['control', 'exit'].includes(mode), 'Expected control or exit');
assert(['slow-provider', 'hung-provider', 'copy-provider'].includes(scenario), 'Expected slow-provider, hung-provider or copy-provider scenario');
const hung = scenario === 'hung-provider';
const copyWait = scenario === 'copy-provider';
const externallyReleased = hung || copyWait;
const productLog = process.env.COPICK_PROTOTYPE_LOG;
assert(!copyWait || productLog, 'copy-provider requires the running app COPICK_PROTOTYPE_LOG path');
const initialLogBytes = copyWait && fs.existsSync(productLog) ? fs.statSync(productLog).size : 0;
function copyLog() { return fs.existsSync(productLog) ? fs.readFileSync(productLog).subarray(initialLogBytes).toString('utf8') : ''; }
const output = path.join(root, 'artifacts', `${scenario}-${mode}-${Date.now()}`);
const windowName = 'Copick 设置';
const page = `group 1 of UI element 1 of scroll area 1 of group 1 of group 1 of window "${windowName}"`;
const bundle = path.join(root, 'artifacts/fixture/CopickFixture.app/Contents');
const executable = path.join(bundle, 'MacOS/CopickFixture');
const marker = name => path.join(output, name);

function script(action, timeout = 5000) {
  const result = spawnSync('osascript', ['-e', `tell application "System Events" to tell process "copick-tauri-prototype"
${action}
end tell`], { encoding: 'utf8', timeout });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function status() {
  return script(`get entire contents of window "${windowName}"
get value of static text 1 of group 1 of group "监听状态" of ${page}`);
}
async function waitFor(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert(Date.now() < deadline, message);
    await delay(50);
  }
}
function appAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function compileFixture() {
  const source = path.resolve(root, 'node_modules/selection-hook/src/mac');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>CopickFixture</string><key>CFBundleIdentifier</key><string>local.test.selection-fixture</string><key>CFBundleName</key><string>CopickFixture</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/></dict></plist>
`);
  const result = spawnSync('clang++', ['-std=c++17', '-fno-objc-arc', '-fblocks', '-include', 'algorithm', '-include', 'cctype', '-I', source,
    path.join(__dirname, 'verify-macos.mm'), path.join(source, 'lib/clipboard.mm'),
    '-framework', 'Cocoa', '-framework', 'ApplicationServices', '-o', executable], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}
function launchFixture(folder, fixtureScenario) {
  fs.mkdirSync(folder, { recursive: true });
  const reportPath = path.join(folder, 'verification.json');
  prepareReport(reportPath);
  const child = spawn(executable, [folder], {
    env: { ...process.env, COPICK_VERIFY_MODE: fixtureScenario, COPICK_VERIFY_PROVIDER_RUNNER: '1' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', value => { log += value; });
  child.stderr.on('data', value => { log += value; });
  const finished = new Promise(resolve => {
    child.on('error', error => resolve({ error }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, finished, reportPath, scenario: fixtureScenario, log: () => log };
}
async function verifyFinished(fixture) {
  const result = await fixture.finished;
  assert.ifError(result.error);
  assert.equal(result.signal, null, `Fixture was signalled: ${result.signal}`);
  const report = readReport(fixture.reportPath, fixture.scenario, result.code, fixture.child.pid);
  assert.equal(report.passed, true, fixture.log());
  if (fixture.scenario === 'busy-provider') {
    assert.equal(report.clipboardTouched, false);
    assert.equal(report.clipboardRestoration.outcome, 'untouched');
  } else assert.equal(report.testClipboardRestored, true);
  return { ...report, fixtureExitCode: result.code, fixturePid: fixture.child.pid };
}

async function main() {
  assert.equal(process.platform, 'darwin', 'Requires a real macOS desktop');
  require('./macos-desktop.cjs').requireUnlockedDesktop();
  fs.mkdirSync(output, { recursive: true });
  const appPid = Number(script('get unix id'));
  assert(Number.isSafeInteger(appPid) && appPid > 0, 'Missing app PID');
  // 计时前初始化设置页的 WKWebView AX 树，不修改辅助功能授权。
  script(`set frontmost to true
repeat 10 times
try
get entire contents of window "${windowName}"
get buttons of group "监听状态" of ${page}
exit repeat
end try
delay 0.1
end repeat`);
  assert.match(status(), /原生监听运行中/, 'App is not listening; check accessibility permission');
  await compileFixture();
  let copyActor;
  if (copyWait) {
    const actorExecutable = marker('CopickControlAction');
    const compiled = spawnSync('clang++', ['-std=c++17', '-fno-objc-arc', path.join(__dirname, 'verify-macos-action.mm'),
      '-framework', 'Cocoa', '-framework', 'ApplicationServices', '-o', actorExecutable], { encoding: 'utf8' });
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, compiled.stderr);
    const actor = spawn(actorExecutable, [String(appPid), output, productLog, String(initialLogBytes), mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    actor.stdout.on('data', value => { stdout += value; });
    actor.stderr.on('data', value => { stderr += value; });
    copyActor = { child: actor, finished: new Promise(resolve => actor.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))) };
    await waitFor(() => {
      assert(actor.exitCode === null, stderr);
      return fs.existsSync(marker('actor-ready'));
    }, 'Copy interaction actor did not initialize', 5000);
  }
  const fixture = launchFixture(output, scenario);
  let failure;
  let interaction;
  let interrupted;
  const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
    interrupted = signal;
    if (externallyReleased) {
      try {
        fs.writeFileSync(marker('provider-release'), `runner received ${signal}`);
        fs.writeFileSync(marker('provider-finish'), 'interrupted; restore clipboard');
      } catch { fixture.child.kill('SIGTERM'); }
    }
  }]));
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  try {
    await waitFor(() => {
      assert(!interrupted, `Interrupted by ${interrupted}`);
      assert(fixture.child.exitCode === null && fixture.child.signalCode === null, `Fixture exited before AX request: ${fixture.log()}`);
      return fs.existsSync(marker('provider-entered'));
    }, 'Provider did not receive AX request');
    assert(!fs.existsSync(marker('provider-returned')), 'Provider returned before interaction');
    // A fixed observation interval does not release the provider: its selected
    // text getter remains blocked until finally creates provider-release.
    if (hung) await delay(2500);
    let timeoutState;
    if (hung) await waitFor(() => {
      timeoutState = status();
      return /取词请求超时/.test(timeoutState);
    }, 'Timed-out request was not reported while provider remained blocked', 2000);
    if (copyWait) {
      await waitFor(() => /COPICK_COPY_BEGIN request=\d+/.test(copyLog()), 'Explicit copy was not accepted while provider waited', 1500);
      assert.doesNotMatch(copyLog(), /COPICK_COPY_OK/, 'Copy committed before cancellation interaction');
    }
    // 关闭设置窗口只会隐藏到托盘，退出场景必须点击“关于”中的真实退出按钮。
    const action = mode === 'exit'
      ? `click button "退出 Copick" of group "关于" of ${page}`
      : copyWait ? `click button "暂停监听" of group "监听状态" of ${page}`
      : `set page to ${page}
click button "暂停监听" of group "监听状态" of page
delay 0.3
get entire contents of window "${windowName}"
set pausedState to value of static text 1 of group 1 of group "监听状态" of page
set pausedButton to name of button "恢复监听" of group "监听状态" of page
click button "恢复监听" of group "监听状态" of page
delay 0.3
set resumedState to value of static text 1 of group 1 of group "监听状态" of page
set resumedButton to name of button "暂停监听" of group "监听状态" of page
return {pausedState, pausedButton, resumedState, resumedButton}`;
    const start = Date.now();
    let actorResult;
    if (copyWait) {
      actorResult = await copyActor.finished;
      assert.equal(actorResult.code, 0, actorResult.stderr);
    }
    let result = copyWait ? actorResult.stdout.trim() : script(`get entire contents of window "${windowName}"
${action}`);
    if (mode === 'exit') await waitFor(() => !appAlive(appPid), 'Original app PID did not exit during provider wait', 2000);
    interaction = {
      mode, scenario, appPid, fixturePid: fixture.child.pid,
      durationMs: copyWait ? Number(actorResult.stdout.trim()) : Date.now() - start, output: result, exitCode: 0,
      providerStillBlocked: !fs.existsSync(marker('provider-returned')),
      providerReleaseAbsent: !fs.existsSync(marker('provider-release')),
      ...(hung ? { timeoutState, captureTimeoutReported: true } : {}),
      ...(copyWait ? { interactionMethod: 'pre-resolved AXPressAction on real control button', durationScope: 'AXPressAction return only; app exit verified separately', explicitCopyAccepted: /COPICK_COPY_BEGIN request=\d+/.test(copyLog()), copyCommittedBeforeInteraction: /COPICK_COPY_OK/.test(copyLog()) } : {}),
      ...(mode === 'exit' ? { appExited: !appAlive(appPid) } : {})
    };
    assert(interaction.providerStillBlocked, 'Interaction completed only after provider returned');
    if (externallyReleased) assert(interaction.providerReleaseAbsent, 'Provider released before interaction completed');
    if (mode === 'control') {
      if (copyWait) {
        await waitFor(() => /COPICK_COPY_CANCEL request=\d+ outcome=1/.test(copyLog()), 'Pause did not cancel a pending native copy before commit', 1000);
        interaction.cancelBeforeCommitVerified = true;
        result = script(`get entire contents of window "${windowName}"
set page to ${page}
set pausedButton to name of button "恢复监听" of group "监听状态" of page
click button "恢复监听" of group "监听状态" of page
delay 0.2
set resumedButton to name of button "暂停监听" of group "监听状态" of page
return {pausedButton, resumedButton}`);
        interaction.output = result;
      }
      assert.match(result, /恢复监听/);
      assert.match(result, /暂停监听/);
      if (!externallyReleased) {
        assert.match(result, /监听已暂停/);
        assert.match(result, /原生监听运行中/);
      }
      if (hung) {
        // A different, responsive source avoids querying the hung provider's UI.
        // The native operation is still busy after pause/resume; a fresh gesture
        // must be rejected with the real product restart guidance, not recovered
        // by spawning another worker or accepting a stale result.
        const busy = launchFixture(path.join(output, 'busy-probe'), 'busy-provider');
        let busyTimer;
        try {
          interaction.busyProbe = await Promise.race([
            verifyFinished(busy),
            new Promise((_, reject) => { busyTimer = setTimeout(() => {
              busy.child.kill('SIGKILL'); // 此 probe 不持有或修改剪贴板备份。
              reject(new Error('Busy probe exceeded external deadline'));
            }, 20000); })
          ]);
        } finally { clearTimeout(busyTimer); }
        interaction.busyState = status();
        assert.match(interaction.busyState, /服务仍忙.*重启原型/);
        interaction.restartGuidanceVerified = true;
        assert(!fs.existsSync(marker('provider-returned')), 'Provider returned during busy/restart probe');
      }
    }
    assert(!interrupted, `Interrupted by ${interrupted}`);
  } catch (error) { failure = error; }
  finally {
    if (copyActor && copyActor.child.exitCode === null) copyActor.child.kill('SIGTERM');
    if (externallyReleased) {
      // 正常路径先释放 provider；marker 无法写入时让 fixture 退出，
      // 独立 guardian 经管道 EOF 尝试条件恢复；此降级路径未等待或确认恢复。
      try {
        fs.writeFileSync(marker('provider-release'), 'runner finally release');
        await delay(700);
        fs.writeFileSync(marker('provider-finish'), 'runner interactions complete; restore clipboard');
      } catch (error) {
        failure ||= error;
        fixture.child.kill('SIGTERM');
      }
    }
  }
  let fixtureReport;
  try {
    fixtureReport = await verifyFinished(fixture);
    if (copyWait) {
      assert.doesNotMatch(copyLog(), /COPICK_COPY_OK/, 'Cancelled or invalidated copy reported a late commit');
      interaction ||= {};
      interaction.noLateCopySuccess = true;
      fs.writeFileSync(marker('product.log'), copyLog());
    }
  }
  catch (error) { failure ||= error; }
  finally { for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler); }
  const report = {
    ...interaction, appPid, fixturePid: fixture.child.pid, scenario, mode,
    passed: !failure, ...(failure ? { error: failure.message } : {}), fixture: fixtureReport
  };
  fs.writeFileSync(marker('interaction.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Artifacts: ${output}`);
  if (failure) throw failure;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
