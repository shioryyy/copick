'use strict';
const fs = require('node:fs');
const path = require('node:path');

function prepareReport(reportPath) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  // A fixture that exits before writing must never inherit the previous result.
  fs.rmSync(reportPath, { force: true });
}

function readReport(reportPath, scenario, exitCode, fixturePid) {
  if (exitCode !== 0) throw new Error(`Fixture exit code must be 0; got ${exitCode}`);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8').replace(/^﻿/, ''));
  if (!report || Array.isArray(report) || typeof report !== 'object') {
    throw new Error('Invalid verification report');
  }
  if (report.scenario !== scenario) {
    throw new Error(`Report scenario mismatch: expected ${scenario}, got ${report.scenario}`);
  }
  if (!Number.isSafeInteger(fixturePid) || fixturePid <= 0 || report.sourcePid !== fixturePid) {
    throw new Error(`Report sourcePid mismatch: expected ${fixturePid}, got ${report.sourcePid}`);
  }
  if (typeof report.passed !== 'boolean') throw new Error('Report passed must be a boolean');
  return report;
}

module.exports = { prepareReport, readReport };

if (require.main === module) {
  try {
    const [operation, reportPath, scenario, exitCode, fixturePid] = process.argv.slice(2);
    if (operation === 'prepare') prepareReport(reportPath);
    else if (operation === 'read') console.log(JSON.stringify(readReport(reportPath, scenario, Number(exitCode), Number(fixturePid))));
    else throw new Error('Expected prepare or read');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
