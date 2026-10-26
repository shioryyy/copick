(function () {
  'use strict';

  // 仅收录已知的完整标识；显示名称不用于替换配置或事件中的原始标识。
  const names = Object.freeze({
    // macOS bundle identifier，不依赖当前运行平台。
    'com.apple.safari': 'Safari',
    'com.google.chrome': 'Chrome',
    'org.mozilla.firefox': 'Firefox',
    'com.microsoft.edgemac': 'Edge',
    'com.microsoft.vscode': 'VS Code',
    'com.todesktop.2305228j7': 'Cursor',
    'com.exafunction.windsurf': 'Windsurf',
    'com.apple.terminal': 'Terminal',
    'com.googlecode.iterm2': 'iTerm2',
    'com.apple.finder': 'Finder',
    'com.apple.textedit': 'TextEdit',
    'com.microsoft.word': 'Word',
    'com.microsoft.excel': 'Excel',
    'com.microsoft.powerpoint': 'PowerPoint',
    'com.electron.lark': 'Feishu',
    'com.larksuite.larkapp': 'Lark',
    'com.tencent.xinwechat': 'WeChat',
    'com.1password.1password': '1Password',
    'com.agilebits.onepassword7': '1Password',
    'com.agilebits.onepassword4': '1Password',

    // Windows 可执行文件名，只匹配文件名本身，不解析路径或命令行。
    'chrome.exe': 'Chrome',
    'firefox.exe': 'Firefox',
    'msedge.exe': 'Edge',
    'code.exe': 'VS Code',
    'cursor.exe': 'Cursor',
    'windsurf.exe': 'Windsurf',
    'windowsterminal.exe': 'Windows Terminal',
    'explorer.exe': 'File Explorer',
    'notepad.exe': 'Notepad',
    'winword.exe': 'Word',
    'excel.exe': 'Excel',
    'powerpnt.exe': 'PowerPoint',
    'feishu.exe': 'Feishu',
    'lark.exe': 'Lark',
    'wechat.exe': 'WeChat',
    'weixin.exe': 'WeChat',
    '1password.exe': '1Password'
  });

  // 仅在查表时忽略大小写；未知值（包括空值）原样返回，不猜测名称。
  function programName(identifier) {
    if (typeof identifier !== 'string') return identifier;
    const key = identifier.toLowerCase();
    return Object.hasOwn(names, key) ? names[key] : identifier;
  }

  // 主进程使用 CommonJS；浏览器直接加载时只公开一个命名空间。
  const programs = { programName };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = programs;
  } else {
    globalThis.copickPrograms = programs;
  }
})();
