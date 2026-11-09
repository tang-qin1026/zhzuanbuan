/**
 * 静态校验：把渲染层/主进程/预加载之间的约定对一遍，
 * 防止写完代码后才发现 id 拼错、IPC 通道名不一致。
 *
 *   node tools/validate-ui.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('src/renderer/index.html');
const renderer = read('src/renderer/renderer.js');
const preload = read('src/preload/index.js');
const main = read('src/main/index.js');

const problems = [];
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const bad = (msg) => {
  problems.push(msg);
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
};

// 1) renderer.js 里用到的 #id 必须在 HTML 中存在
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const used = new Set(
  [...renderer.matchAll(/(?:querySelector|\$)\(\s*'#([^']+)'\s*\)/g)].map((m) => m[1])
);
const missing = [...used].filter((id) => !ids.has(id));
missing.length === 0
  ? ok(`渲染层引用的 ${used.size} 个 DOM id 全部存在`)
  : bad(`HTML 缺少 id: ${missing.join(', ')}`);

// 2) preload 暴露的 IPC 通道必须在主进程注册
const invokeChannels = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);
const handled = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]));
const missingChannels = invokeChannels.filter((c) => !handled.has(c));
missingChannels.length === 0
  ? ok(`preload 的 ${invokeChannels.length} 个 IPC 通道均已注册`)
  : bad(`主进程未注册通道: ${missingChannels.join(', ')}`);

// 3) preload 必须开启 contextIsolation 且不暴露 node
if (/contextIsolation:\s*true/.test(main)) ok('contextIsolation 已开启');
else bad('主进程未开启 contextIsolation');

if (/nodeIntegration:\s*true/.test(main)) bad('nodeIntegration 不应开启');
else ok('nodeIntegration 已关闭');

// 4) 渲染层不应出现 node 能力
const forbidden = ['require(', 'child_process', 'fs.'].filter((t) => renderer.includes(t));
forbidden.length === 0
  ? ok('渲染层未使用 Node 能力')
  : bad(`渲染层出现 Node 能力: ${forbidden.join(', ')}`);

// 5) CSP 存在
/CONTENT-SECURITY-POLICY/i.test(html) || /Content-Security-Policy/.test(html)
  ? ok('页面已声明 CSP')
  : bad('页面缺少 CSP');

console.log(problems.length === 0 ? '\n全部通过\n' : `\n${problems.length} 项未通过\n`);
process.exit(problems.length === 0 ? 0 : 1);
