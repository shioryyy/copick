'use strict';
// PowerShell 5.1 在没有 BOM 时按系统 ANSI 代码页（中文 Windows 为 GBK）解码脚本，
// 而不是 UTF-8。含中文注释的脚本会因此被错误解码，最坏情况下吞掉换行符，
// 把下一行代码并入注释，产生“意外的标记 }”这类与代码无关的解析错误。
// 2026-10-25 在 OMEN 上就因 verify-windows.ps1 的新增中文注释而真实失败过。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scriptsDir = path.join(__dirname, '../scripts');
const scripts = fs.readdirSync(scriptsDir).filter((name) => name.endsWith('.ps1'));

test('every PowerShell script is present', () => {
  assert.ok(scripts.length > 0, 'expected PowerShell verification scripts');
});

for (const name of scripts) {
  test(`${name} is UTF-8 with BOM so PowerShell 5.1 decodes it correctly`, () => {
    const bytes = fs.readFileSync(path.join(scriptsDir, name));
    assert.ok(
      bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
      `${name} must start with a UTF-8 BOM; without it PowerShell 5.1 decodes non-ASCII text as ANSI and can break parsing`
    );
    // BOM 之后必须是合法 UTF-8，否则 BOM 只是掩盖了坏文件。
    const text = bytes.subarray(3).toString('utf8');
    assert.ok(!text.includes('�'), `${name} must be valid UTF-8 after the BOM`);
  });
}
