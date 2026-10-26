(function (root) {
  'use strict';

  function parseExcludedApps(text) {
    const items = [];
    const seen = new Set();
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/[\u0000-\u001f\u007f-\u009f]/u.test(line)) {
        throw new Error(`第 ${index + 1} 行含有控制字符，请删除后重试。`);
      }
      const value = line.trim().toLowerCase();
      if (!value) continue;
      if (/[\\/*?]/u.test(value)) {
        throw new Error(`第 ${index + 1} 行含有路径或通配符，请仅填写程序名或 bundle id。`);
      }
      if (Array.from(value).length > 128) {
        throw new Error(`第 ${index + 1} 行超过 128 个字符。`);
      }
      if (!seen.has(value)) {
        seen.add(value);
        items.push(value);
        if (items.length > 200) throw new Error('应用排除列表最多允许 200 项。');
      }
    }
    return items;
  }

  // 单独保存已加载配置的副本。paused 等运行状态由 configure 管理，
  // 不应通过 save_settings 回传。
  function copyConfig(config) {
    if (!config || config.version !== 1 || !Array.isArray(config.excludedApps) ||
        !config.excludedApps.every(item => typeof item === 'string') ||
        typeof config.diagnosticsEnabled !== 'boolean') {
      throw new Error('设置响应中的配置格式不正确。');
    }
    return {
      version: 1,
      excludedApps: [...config.excludedApps],
      diagnosticsEnabled: config.diagnosticsEnabled
    };
  }

  function readSettings(value) {
    const config = copyConfig(value && value.config);
    if (typeof value.startupEnabled !== 'boolean' || typeof value.startupAvailable !== 'boolean' ||
        typeof value.version !== 'string' || typeof value.migratedFromElectron !== 'boolean' ||
        ![value.startupError, value.configError].every(error => error === null || typeof error === 'string')) {
      throw new Error('设置响应格式不正确。');
    }
    return { ...value, config };
  }

  function draftConfig(text, diagnosticsEnabled) {
    return { version: 1, excludedApps: parseExcludedApps(text), diagnosticsEnabled };
  }

  function hasChanges(saved, text, diagnosticsEnabled) {
    return Boolean(saved) && (text !== saved.excludedApps.join('\n') ||
      diagnosticsEnabled !== saved.diagnosticsEnabled);
  }

  const api = { parseExcludedApps, copyConfig, readSettings, draftConfig, hasChanges };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CopickSettings = api;
})(globalThis);
