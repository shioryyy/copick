'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareReport, readReport } = require('../scripts/verification-report.cjs');
const tool = path.join(__dirname, '../scripts/verification-report.cjs');

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copick-verification-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'output with spaces', 'verification.json');
}
function writeReport(reportPath, overrides = {}) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ passed: true, scenario: 'double', sourcePid: 12345, ...overrides }));
}
function cli(...args) {
  return spawnSync(process.execPath, [tool, ...args.map(String)], { encoding: 'utf8' });
}
function fixture(reportPath, exitCode, scenario) {
  // A plain Node subprocess stands in for the fixture; it never opens a window.
  return spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const [reportPath, exitCode, scenario] = process.argv.slice(1);
    if (scenario) fs.writeFileSync(reportPath, JSON.stringify({ passed: true, scenario, sourcePid: process.pid }));
    process.exit(Number(exitCode));
  `, reportPath, String(exitCode), scenario || ''], { encoding: 'utf8' });
}

test('old passing report is removed before a crashed fixture can reuse it', t => {
  const reportPath = workspace(t);
  writeReport(reportPath);
  assert.equal(cli('prepare', reportPath).status, 0);
  assert.equal(fs.existsSync(reportPath), false);
  const run = fixture(reportPath, 7);
  const result = cli('read', reportPath, 'double', run.status, run.pid);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exit code.*7/i);
  assert.equal(result.stdout, '');
});

test('even a zero exit cannot reuse an old passing report without writing a new one', t => {
  const reportPath = workspace(t);
  writeReport(reportPath);
  assert.equal(cli('prepare', reportPath).status, 0);
  const run = fixture(reportPath, 0);
  const result = cli('read', reportPath, 'double', run.status, run.pid);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
  assert.equal(result.stdout, '');
});

test('a fresh passing report cannot override the fixture crash exit code', t => {
  const reportPath = workspace(t);
  prepareReport(reportPath);
  const run = fixture(reportPath, 9, 'double');
  assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).passed, true);
  const result = cli('read', reportPath, 'double', run.status, run.pid);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exit code.*9/i);
  assert.equal(result.stdout, '');
});

test('a fresh report for another scenario is rejected', t => {
  const reportPath = workspace(t);
  prepareReport(reportPath);
  const run = fixture(reportPath, 0, 'drag');
  const result = cli('read', reportPath, 'double', run.status, run.pid);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scenario/i);
  assert.equal(result.stdout, '');
});

test('a fresh matching report from the fixture succeeds and preserves report fields', t => {
  const reportPath = workspace(t);
  prepareReport(reportPath);
  const run = fixture(reportPath, 0, 'double');
  const result = cli('read', reportPath, 'double', run.status, run.pid);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { passed: true, scenario: 'double', sourcePid: run.pid });
});

test('reports from a different process and invalid exit codes are rejected', t => {
  const reportPath = workspace(t);
  writeReport(reportPath);
  assert.throws(() => readReport(reportPath, 'double', 0, 54321), /sourcePid/i);
  for (const exitCode of [null, undefined, NaN, '0']) {
    assert.throws(() => readReport(reportPath, 'double', exitCode, 12345), /exit code/i);
  }
});

test('malformed reports and truthy non-boolean passed values are rejected', t => {
  const reportPath = workspace(t);
  prepareReport(reportPath);
  for (const content of ['{', 'null', '[]', '{}', '{"scenario":"double","sourcePid":12345,"passed":"false"}']) {
    fs.writeFileSync(reportPath, content);
    assert.throws(() => readReport(reportPath, 'double', 0, 12345));
  }
});

test('a valid failing report remains available for the runner to print and fail', t => {
  const reportPath = workspace(t);
  writeReport(reportPath, { passed: false, result: 'fixture assertion failed' });
  assert.deepEqual(readReport(reportPath, 'double', 0, 12345), {
    passed: false, scenario: 'double', sourcePid: 12345, result: 'fixture assertion failed'
  });
});

test('UTF-8 BOM reports are readable and cleanup errors stop preparation', t => {
  const reportPath = workspace(t);
  prepareReport(reportPath);
  fs.writeFileSync(reportPath, '﻿' + JSON.stringify({ passed: true, scenario: 'double', sourcePid: 12345 }));
  assert.equal(readReport(reportPath, 'double', 0, 12345).passed, true);
  fs.rmSync(reportPath);
  fs.mkdirSync(reportPath);
  assert.throws(() => prepareReport(reportPath));
});
