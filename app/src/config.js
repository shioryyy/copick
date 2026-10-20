'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateConfig } = require('./policy');
const defaults = () => ({ paused: false, clipboardFallback: process.platform === 'win32', loginItem: false, blacklist: [] });
function loadConfig(file) {
  try { return { config: validateConfig(JSON.parse(fs.readFileSync(file, 'utf8'))), error: null }; }
  catch (error) {
    if (error.code === 'ENOENT') return { config: defaults(), error: null };
    // Fail closed if a previously disabled fallback cannot be read; don't overwrite it.
    return { config: { ...defaults(), paused: true, clipboardFallback: false },
      error: '无法读取设置，已暂停并关闭快捷键回退。请在设置中保存有效配置。' };
  }
}
function saveConfig(file, value) {
  const config = validateConfig(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return config;
}
module.exports = { loadConfig, saveConfig };
