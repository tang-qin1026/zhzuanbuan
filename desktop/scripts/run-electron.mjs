import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, '.electron', 'electron.exe');

if (!fs.existsSync(exe)) {
  console.error(`找不到 Electron 运行时：${exe}`);
  console.error('请把 electron-v*-win32-x64.zip 解压到 desktop/.electron/ 后重试。');
  process.exit(1);
}

// 某些环境（含 DSH 沙箱）会预设 ELECTRON_RUN_AS_NODE=1，
// 这会把 Electron 降级成纯 Node，require('electron') 直接失败。
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = ['.', ...process.argv.slice(2)];

if (env.FMT_DEBUG === '1') {
  env.ELECTRON_ENABLE_LOGGING = '1';
  args.push('--enable-logging=stderr', '--v=1');
}

console.log(`[run-electron] ${exe} ${args.join(' ')}`);

const child = spawn(exe, args, {
  cwd: root,
  stdio: 'inherit',
  windowsHide: false,
  env,
});

child.on('error', (err) => {
  console.error(`[run-electron] 无法启动 Electron：${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  console.log(`[run-electron] Electron 已退出：code=${code} signal=${signal ?? 'none'}`);
  process.exit(code ?? 0);
});
