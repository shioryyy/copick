'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Only explicitly allowed scalar metadata reaches disk. Never pass event/error objects.
const fields = new Set(['appVersion', 'hookVersion', 'electronVersion', 'nodeVersion', 'platform', 'arch',
  'accessibility', 'permissionProbe', 'paused', 'clipboardFallback', 'blacklistCount', 'protectedCount',
  'result', 'running', 'ready', 'settingsFocused', 'settingsVisible', 'reason', 'textLength', 'programKnown',
  'method', 'posLevel', 'mousePointValid', 'selectionPointValid', 'cursorDistance', 'count', 'suppressed',
  'mouseDown', 'mouseUp', 'selections', 'shown', 'dropped', 'errorName', 'errorCode', 'errorMessageLength']);
function errorMetadata(error) {
  return {
    errorName: ['Error', 'TypeError', 'RangeError', 'SyntaxError'].includes(error?.name) ? error.name : 'Error',
    errorCode: typeof error?.code === 'number' ? error.code : undefined,
    errorMessageLength: typeof error?.message === 'string' ? error.message.length : 0
  };
}
function createDiagnostics(directory, now = Date.now) {
  const file = path.join(directory, 'selection.log');
  const limits = new Map();
  let failed = false;
  function log(event, metadata = {}, interval = 5000) {
    const time = now();
    const key = `${event}:${metadata.reason || ''}`;
    const previous = limits.get(key);
    if (previous && time - previous.time < interval) { previous.suppressed++; return; }
    const row = { time: new Date(time).toISOString(), event };
    for (const [name, value] of Object.entries(metadata)) {
      if (fields.has(name) && (typeof value === 'boolean' || typeof value === 'string' ||
          (typeof value === 'number' && Number.isFinite(value)) || value === null)) row[name] = value;
    }
    if (previous?.suppressed) row.suppressed = previous.suppressed;
    limits.set(key, { time, suppressed: 0 });
    try {
      fs.mkdirSync(directory, { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size >= 512 * 1024) {
        fs.rmSync(`${file}.1`, { force: true });
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    } catch {
      if (!failed) console.error('Copick diagnostics could not be written.');
      failed = true;
    }
  }
  return { file, log };
}
function diagnosticsEnabled(args = []) { return args.includes('--diagnostics'); }
module.exports = { createDiagnostics, errorMetadata, diagnosticsEnabled };
