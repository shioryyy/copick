'use strict';
let native;
function load() {
  if (!native) native = require('../native/foreground/build/Release/foreground.node');
  return native;
}
function readForeground() {
  const value = load().read();
  if (!value || typeof value.program !== 'string' || !value.program.trim() ||
      !Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
  return { program: value.program.toLowerCase(), pid: value.pid };
}
function sameApplication(left, right) {
  return Boolean(left && right && left.pid === right.pid && left.program === right.program);
}
module.exports = { readForeground, sameApplication };
