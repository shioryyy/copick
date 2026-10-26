'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
if (!['darwin', 'win32'].includes(process.platform)) {
  console.error('Copick 原生模块只支持 macOS 和 Windows。');
  process.exit(1);
}
// Node-API 8 不依赖 V8/Electron ABI，可使用当前 Node 头文件构建。
const arch = process.argv[2] || process.arch;
if (!['arm64', 'x64'].includes(arch)) {
  console.error('Copick 原生模块仅构建 arm64 或 x64。');
  process.exit(1);
}
const result = spawnSync(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'),
  'rebuild', `--arch=${arch}`, '--directory', path.resolve(__dirname, '../native/foreground')], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
