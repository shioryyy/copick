'use strict';
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tools = path.resolve(root, '..', '.tauri-tools');
const env = { ...process.env };
const localTools = process.platform === 'win32' ? path.join(root, '.tools') : tools;
if (existsSync(path.join(localTools, 'cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'))) {
  env.CARGO_HOME = path.join(localTools, 'cargo');
  env.RUSTUP_HOME = path.join(localTools, 'rustup');
  env.PATH = `${path.join(env.CARGO_HOME, 'bin')}${path.delimiter}${env.PATH}`;
}
const [command, ...args] = process.argv.slice(2);
if (command === 'build' && !args.some(arg => arg === '--no-bundle' || arg === '--bundles' || arg.startsWith('--bundles='))) {
  const bundle = { darwin: 'app', win32: 'nsis' }[process.platform];
  if (!bundle) {
    console.error('Copick Tauri packaging supports only macOS and Windows.');
    process.exit(1);
  }
  args.push('--bundles', bundle);
}
const cargo = command === 'check' || command === 'test';
const executable = cargo ? 'cargo' : process.execPath;
const arguments_ = cargo ? [command, ...args]
  : [require.resolve('@tauri-apps/cli/tauri.js'), command || 'dev', ...args];
const result = spawnSync(executable, arguments_, {
  cwd: cargo ? path.join(root, 'src-tauri') : root, env, stdio: 'inherit'
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
