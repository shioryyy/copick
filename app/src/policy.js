'use strict';

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

// selection-hook reports Windows executable names and macOS bundle identifiers.
const PROTECTED = Object.freeze(isMac ? [
  'local.copick.app',
  'com.apple.finder',
  'com.apple.keychainaccess',
  'com.1password.1password',
  'com.agilebits.onepassword4',
  'com.lastpass.lastpass'
] : [
  'copick.exe', 'electron.exe', 'windowsterminal.exe', 'windowsterminalpreview.exe',
  'openconsole.exe', 'conhost.exe', 'cmd.exe', 'powershell.exe', 'powershell_ise.exe',
  'pwsh.exe', 'wsl.exe', 'wslhost.exe', 'bash.exe', 'mintty.exe', 'putty.exe',
  'kitty.exe', 'wezterm', 'alacritty.exe', 'hyper.exe', 'tabby.exe', 'ssh.exe',
  '1password', 'keepass', 'bitwarden', 'credentialuibroker.exe', 'logonui.exe'
]);

// IDEs may be read through accessibility APIs, but fallback copy can interrupt terminals.
const NO_CLIPBOARD = Object.freeze(isMac ? [
  'com.microsoft.visual-studio-code',
  'com.microsoft.vscode',
  'com.apple.terminal',
  'com.googlecode.iterm2',
  'com.todesktop.2305228j7', // Cursor
  'com.exafunction.windsurf'
] : ['code.exe', 'code - insiders.exe', 'cursor.exe', 'windsurf.exe']);

function normalizeList(input) {
  if (!Array.isArray(input) || input.length > 200) throw new Error('最多允许 200 个程序标识。');
  return [...new Set(input.map(value => {
    if (typeof value !== 'string') throw new Error('请输入程序标识。');
    const name = value.trim().toLowerCase();
    const valid = isMac
      ? /^[a-z0-9][a-z0-9.+-]{0,127}(?:\.[a-z0-9][a-z0-9.+-]{0,127})+$/.test(name)
      : /^[a-z0-9][a-z0-9 ._+-]{0,95}\.exe$/.test(name);
    if (!valid) throw new Error(isMac
      ? '每行填写一个 macOS bundle identifier，例如 com.example.App；不接受路径或通配符。'
      : '每行填写一个英文程序文件名，例如 example.exe；不接受路径或通配符。');
    return name;
  }))];
}

function validateConfig(value) {
  if (!value || typeof value !== 'object' || typeof value.paused !== 'boolean' ||
      typeof value.clipboardFallback !== 'boolean') throw new Error('设置格式无效。');
  // Prefer the unified field; migrate local configs that only have loginItem.
  // Configs written before either field existed still default to off.
  const launchAtLogin = value.launchAtLogin !== undefined ? value.launchAtLogin : value.loginItem;
  if (launchAtLogin !== undefined && typeof launchAtLogin !== 'boolean') throw new Error('设置格式无效。');
  return { paused: value.paused, clipboardFallback: value.clipboardFallback,
    launchAtLogin: launchAtLogin === true, blacklist: normalizeList(value.blacklist) };
}
function blockedPrograms(config) { return [...new Set([...PROTECTED, ...config.blacklist])]; }
function isBlocked(name, config) {
  return typeof name !== 'string' || !name.trim() ||
    blockedPrograms(config).some(item => name.toLowerCase().includes(item));
}
function validPoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x !== -99999 && point.y !== -99999;
}
function popupBounds(point, area, width = 88, height = 40) {
  const x = Math.max(area.x, Math.min(Math.round(point.x + 10), area.x + area.width - width));
  let y = Math.round(point.y + 12);
  if (y + height > area.y + area.height) y = Math.round(point.y - height - 12);
  y = Math.max(area.y, Math.min(y, area.y + area.height - height));
  return { x, y, width, height };
}
module.exports = { PROTECTED, NO_CLIPBOARD, normalizeList, validateConfig, blockedPrograms, isBlocked, validPoint, popupBounds };
