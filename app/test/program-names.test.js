'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { programName } = require('../src/program-names');

// 两个平台的标识在同一进程中验证，不依赖测试机的操作系统。
const macPrograms = [
  ['com.apple.Safari', 'Safari'],
  ['com.google.Chrome', 'Chrome'],
  ['org.mozilla.firefox', 'Firefox'],
  ['com.microsoft.edgemac', 'Edge'],
  ['com.microsoft.VSCode', 'VS Code'],
  ['com.todesktop.2305228j7', 'Cursor'],
  ['com.exafunction.windsurf', 'Windsurf'],
  ['com.apple.Terminal', 'Terminal'],
  ['com.googlecode.iterm2', 'iTerm2'],
  ['com.apple.finder', 'Finder'],
  ['com.apple.TextEdit', 'TextEdit'],
  ['com.microsoft.Word', 'Word'],
  ['com.microsoft.Excel', 'Excel'],
  ['com.microsoft.Powerpoint', 'PowerPoint'],
  ['com.electron.lark', 'Feishu'],
  ['com.larksuite.larkApp', 'Lark'],
  ['com.tencent.xinWeChat', 'WeChat'],
  ['com.1password.1password', '1Password'],
  ['com.agilebits.onepassword7', '1Password'],
  ['com.agilebits.onepassword4', '1Password']
];
const windowsPrograms = [
  ['chrome.exe', 'Chrome'],
  ['firefox.exe', 'Firefox'],
  ['msedge.exe', 'Edge'],
  ['Code.exe', 'VS Code'],
  ['Cursor.exe', 'Cursor'],
  ['Windsurf.exe', 'Windsurf'],
  ['WindowsTerminal.exe', 'Windows Terminal'],
  ['explorer.exe', 'File Explorer'],
  ['notepad.exe', 'Notepad'],
  ['WINWORD.EXE', 'Word'],
  ['EXCEL.EXE', 'Excel'],
  ['POWERPNT.EXE', 'PowerPoint'],
  ['Feishu.exe', 'Feishu'],
  ['Lark.exe', 'Lark'],
  ['WeChat.exe', 'WeChat'],
  ['Weixin.exe', 'WeChat'],
  ['1Password.exe', '1Password']
];

test('macOS 常见 bundle identifier 映射为显示名称', () => {
  for (const [identifier, expected] of macPrograms) {
    assert.equal(programName(identifier), expected, identifier);
  }
});

test('Windows 常见 exe 映射为显示名称', () => {
  for (const [identifier, expected] of windowsPrograms) {
    assert.equal(programName(identifier), expected, identifier);
  }
});

test('匹配忽略大小写，调用者保留原始 identifier', () => {
  for (const [identifier, expected] of [...macPrograms, ...windowsPrograms]) {
    const entry = Object.freeze({ identifier: identifier.toUpperCase() });
    assert.equal(programName(entry.identifier), expected);
    assert.equal(programName(identifier.toLowerCase()), expected);
    assert.equal(entry.identifier, identifier.toUpperCase());
  }
});

test('未知标识、空值及非字符串输入原样返回', () => {
  const object = { identifier: 'com.example.App' };
  for (const identifier of [
    'com.example.MyApp', 'Unknown.EXE', '未知程序', '', ' ',
    'constructor', 'toString', '__proto__', 'hasOwnProperty',
    undefined, null, false, 42, object
  ]) {
    assert.equal(programName(identifier), identifier);
  }
});

test('不误匹配片段、相似名称、路径、空白或命令行参数', () => {
  for (const identifier of [
    'chrome', 'Safari', 'vscode.exe', 'word.exe', 'powerpoint.exe',
    'com.example.com.apple.Safari', 'com.apple.SafariTechnologyPreview',
    'com.google.Chrome.helper', 'mychrome.exe', 'chrome.exe.bak',
    'notepad++.exe', 'com.fake.1password',
    'com.bytedance.lark', 'com.bytedance.lark.helper', 'com.larksuite.lark',
    '/Applications/Safari.app', 'C:\\Program Files\\Chrome\\chrome.exe',
    '/usr/bin/notepad.exe', 'chrome.exe --incognito',
    ' chrome.exe', 'chrome.exe ', 'com.apple.Safari\n'
  ]) {
    assert.equal(programName(identifier), identifier);
  }
});

const source = fs.readFileSync(path.join(__dirname, '../src/program-names.js'), 'utf8');

test('浏览器直接加载，无需 module、require、process 或其他宿主能力', () => {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.deepEqual(Object.keys(context.copickPrograms), ['programName']);
  for (const [identifier, expected] of [...macPrograms, ...windowsPrograms]) {
    assert.equal(context.copickPrograms.programName(identifier), expected);
  }
  assert.equal(context.copickPrograms.programName('Unknown.EXE'), 'Unknown.EXE');
  assert.deepEqual(Object.keys(context), ['copickPrograms']);
  // 重复加载脚本不会产生顶层变量重声明错误。
  vm.runInContext(source, context);
  assert.equal(context.copickPrograms.programName('CODE.EXE'), 'VS Code');
});

test('CommonJS 仅导出 programName，不向全局注入命名空间', () => {
  const context = vm.createContext({ module: { exports: {} } });
  vm.runInContext(source, context);
  assert.deepEqual(Object.keys(context.module.exports), ['programName']);
  assert.equal(context.module.exports.programName('com.apple.Safari'), 'Safari');
  assert.equal(context.module.exports.programName('notepad.exe'), 'Notepad');
  assert.equal(context.copickPrograms, undefined);
  assert.deepEqual(Object.keys(require('../src/program-names')), ['programName']);
});
