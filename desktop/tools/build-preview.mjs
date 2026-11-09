/**
 * 把 src/renderer 打成单文件 preview.html：
 * 样式、脚本、mock 桥全部内联，双击即可在任何浏览器里打开。
 *
 *   node tools/build-preview.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BRIDGE } from './preview-bridge.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'src', 'renderer');

const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

// 直接从 formats.js 取能力表，保证预览与实际一致
const { KINDS, ENABLED_KINDS } = require(path.join(root, 'src', 'main', 'formats.js'));
const kinds = ENABLED_KINDS.map((kind) => ({
  kind,
  label: KINDS[kind].label,
  exts: KINDS[kind].exts,
  targets: KINDS[kind].targets,
  experimental: KINDS[kind].experimental || [],
  unsupported: KINDS[kind].unsupported || {},
  engine: KINDS[kind].engine,
  available: ['text', 'subtitle', 'ffmpeg', 'libreoffice', 'poppler'].includes(KINDS[kind].engine),
}));

const css = read('styles.css');
const renderer = read('renderer.js');
let html = read('index.html');

// 单文件内联需要去掉 CSP（它会禁止 inline script）
html = html.replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '');
html = html.replace('<link rel="stylesheet" href="styles.css" />', `<style>\n${css}\n</style>`);
html = html.replace(
  '<script src="renderer.js"></script>',
  `<script>window.__FMT_KINDS__ = ${JSON.stringify(kinds)};</script>\n<script>\n${BRIDGE}\n</script>\n    <script>\n${renderer}\n</script>`
);
html = html.replace('<title>格式转换器</title>', '<title>格式转换器 · 界面预览</title>');

const out = path.join(root, 'preview.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`已生成 ${out}（${(Buffer.byteLength(html) / 1024).toFixed(1)} KB）`);
console.log('双击用浏览器打开即可；账号任意，密码 demo1234');
