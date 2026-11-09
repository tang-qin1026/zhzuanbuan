/**
 * 浏览器预览：把 src/renderer 原样跑起来，用 mock 替换 window.api。
 * 用途：在没有 Electron / 无法启动图形进程的环境里检查界面。
 *
 *   node tools/preview-server.mjs --port 5178
 *
 * 注意：这里没有真实认证，登录结果由 mock 决定，仅供看界面与交互。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE } from './preview-bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererDir = path.join(root, 'src', 'renderer');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;

  if (pathname === '/') pathname = '/index.html';

  if (pathname === '/__bridge.js') {
    res.writeHead(200, { 'content-type': MIME['.js'] });
    return res.end(BRIDGE);
  }

  const file = path.join(rendererDir, pathname.replace(/^\/+/, ''));
  if (!file.startsWith(rendererDir)) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  try {
    let body = await readFile(file);
    if (pathname.endsWith('.html')) {
      body = Buffer.from(
        body
          .toString('utf8')
          .replace(
            '<script src="renderer.js"></script>',
            '<script src="/__bridge.js"></script>\n    <script src="renderer.js"></script>'
          ),
        'utf8'
      );
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

const idx = process.argv.indexOf('--port');
const port = idx > -1 ? Number(process.argv[idx + 1]) : 5178;

server.listen(port, '127.0.0.1', () => {
  console.log(`[preview] http://127.0.0.1:${port}`);
  console.log('[preview] 账号任意，密码 demo1234；用户名 disabled 可看禁用提示');
});
