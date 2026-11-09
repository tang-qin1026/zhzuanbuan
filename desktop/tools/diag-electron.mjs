/**
 * Electron 启动诊断：把这台机器上 Electron 能不能跑、卡在哪一步，一次性收集出来。
 *
 *   node tools\diag-electron.mjs
 *
 * 结果同时打印到控制台并写入 desktop\diag-report.txt。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, '.electron', 'electron.exe');
const lines = [];

const log = (s = '') => {
  lines.push(s);
  console.log(s);
};

function exitText(code, signal) {
  if (signal) return `signal=${signal}`;
  const hex = code === null ? '—' : `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  return `code=${code} (${hex})`;
}

log('==== Electron 启动诊断 ====');
log(`时间      ${new Date().toISOString()}`);
log(`系统      ${os.type()} ${os.release()} (${process.arch})`);
log(`Node      ${process.version}`);
log(`Electron  ${exe}`);
log(`存在      ${fs.existsSync(exe)}`);
log('');

// 1) 关键 DLL 是否齐全
log('---- 依赖检查 ----');
const dlls = ['electron.exe', 'resources.pak', 'icudtl.dat', 'd3dcompiler_47.dll', 'libEGL.dll', 'libGLESv2.dll', 'vulkan-1.dll'];
for (const d of dlls) {
  const p = path.join(root, '.electron', d);
  log(`${fs.existsSync(p) ? '有  ' : '缺失'}  ${d}`);
}
const sys32 = path.join(process.env.WINDIR || 'C:\\Windows', 'System32');
for (const d of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) {
  log(`${fs.existsSync(path.join(sys32, d)) ? '有  ' : '缺失'}  System32\\${d}`);
}
log('');

// 2) 逐个参数组合试启动
const variants = [
  { name: '--version（只验二进制）', args: ['--version'], timeout: 15000 },
  { name: '默认启动', args: ['.'], timeout: 20000 },
  { name: '--no-sandbox', args: ['.', '--no-sandbox'], timeout: 20000 },
  { name: '--no-sandbox --disable-gpu', args: ['.', '--no-sandbox', '--disable-gpu'], timeout: 20000 },
  {
    name: '--no-sandbox --disable-gpu --in-process-gpu',
    args: ['.', '--no-sandbox', '--disable-gpu', '--in-process-gpu', '--disable-software-rasterizer'],
    timeout: 20000,
  },
  { name: '--no-sandbox --single-process', args: ['.', '--no-sandbox', '--single-process', '--no-zygote'], timeout: 20000 },
];

log('---- 启动测试 ----');
for (const v of variants) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELECTRON_ENABLE_LOGGING = '1';

  const started = Date.now();
  const res = spawnSync(exe, v.args, {
    cwd: root,
    env,
    timeout: v.timeout,
    encoding: 'utf8',
    windowsHide: true,
  });
  const ms = Date.now() - started;

  // 超时被杀 = 进程一直活着，通常意味着窗口起来了（我们只关心能否启动）
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  const status = timedOut ? `运行中（${ms}ms 后超时终止，可能已弹窗）` : exitText(res.status, res.signal);

  log(`[${v.name}] ${status}`);
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (out) {
    for (const line of out.split(/\r?\n/).slice(-12)) log(`    ${line}`);
  }
  if (res.error && !timedOut) log(`    错误: ${res.error.message}`);
  log('');
}

const report = lines.join('\r\n');
fs.writeFileSync(path.join(root, 'diag-report.txt'), report, 'utf8');
console.log(`\n报告已写入 ${path.join(root, 'diag-report.txt')}`);
