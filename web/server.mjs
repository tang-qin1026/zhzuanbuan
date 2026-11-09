/**
 * 网页版前端：浏览器通过本地服务登录 cloud-server。
 *
 *   node web/server.mjs --server http://192.168.9.104 --port 5180
 *
 * 与桌面端共用同一套 UI（src/renderer）和同一套认证实现（src/main/auth），
 * 区别只是：Electron 的 IPC 换成 HTTP 接口，浏览器不直接碰门户（避开 CORS，
 * 也避免把 token 暴露在页面里）。
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB_BRIDGE } from './bridge.mjs';
import { handleConvert, handleFormats } from './convert-routes.mjs';
import { handleCreateJob, handleJobStatus, handleJobResult } from './jobs.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..', 'desktop');
const rendererDir = path.join(desktopRoot, 'src', 'renderer');
const dataDir = path.join(here, '.data');

const { AuthService } = require(path.join(desktopRoot, 'src', 'main', 'auth', 'auth-service.js'));

// ── 参数 ──────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const serverBaseUrl = (arg('server', process.env.SERVER_BASE_URL) || 'http://192.168.9.104').replace(/\/+$/, '');
const port = Number(arg('port', process.env.PORT || 5180));
const host = arg('host', '127.0.0.1');
const allowLan = process.argv.includes('--allow-lan');

// 默认只监听本机。会话是服务端单例，一旦暴露到局域网，
// 任何能访问该端口的人都共享同一个已登录会话（等于免登录用你的账号）。
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && !allowLan) {
  console.error('');
  console.error('拒绝启动：--host ' + host + ' 会把服务暴露到本机以外。');
  console.error('这个服务的会话是全局单例，暴露出去等于把登录态共享给所有人。');
  console.error('确实需要局域网访问，请显式加上 --allow-lan，并清楚风险。');
  console.error('');
  process.exit(1);
}
const refreshSkewMinutes = Number(arg('skew', process.env.REFRESH_SKEW_MINUTES || 5));

const refreshSkewMs = Math.max(0, refreshSkewMinutes) * 60 * 1000;

/**
 * 每个浏览器一个会话：cookie 里的 sid → 独立的 AuthService + 独立数据目录。
 * 这样多个人用同一个地址，各自登录各自的账号，互不可见。
 */
const sessionRoot = path.join(dataDir, 'sessions');
fs.mkdirSync(sessionRoot, { recursive: true });

const sessions = new Map(); // sid -> { auth, lastSeen }

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sidOf(req) {
  const sid = parseCookies(req).fmt_sid;
  return sid && /^[0-9a-f-]{36}$/i.test(sid) ? sid : null;
}

function sessionFor(sid) {
  if (!sid) return null;
  let entry = sessions.get(sid);
  if (!entry) {
    entry = {
      auth: new AuthService({ serverBaseUrl, dataDir: path.join(sessionRoot, sid), refreshSkewMs }),
      lastSeen: Date.now(),
    };
    sessions.set(sid, entry);
  }
  entry.lastSeen = Date.now();
  return entry;
}

function ensureSession(req, res) {
  let sid = sidOf(req);
  if (!sid) {
    sid = randomUUID();
    res.setHeader('set-cookie', `fmt_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600`);
  }
  return sessionFor(sid);
}

function clearSessionCookie(res) {
  res.setHeader('set-cookie', 'fmt_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

// 空闲 14 天以上的会话连同数据一起清掉
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of sessions) {
    if (now - entry.lastSeen > 14 * 24 * 60 * 60 * 1000) {
      sessions.delete(sid);
      fs.rmSync(path.join(sessionRoot, sid), { recursive: true, force: true });
    }
  }
}, 60 * 60 * 1000).unref?.();

// ── 工具 ──────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

const ok = (res, data) => sendJson(res, 200, { ok: true, data });
const fail = (res, err) =>
  sendJson(res, 200, {
    ok: false,
    error: { code: (err && err.code) || 'UNKNOWN', message: (err && err.message) || '未知错误' },
  });

function readJson(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// ── 服务 ──────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readJson(req);
      const entry = ensureSession(req, res);
      try {
        const session = await entry.auth.login(body.username, body.password);
        console.log(`[login] ${body.username} ok (${session.storage})`);
        return ok(res, session);
      } catch (err) {
        console.log(`[login] ${body.username} 失败: ${err.code} ${err.message}`);
        return fail(res, err);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/session') {
      const entry = sessionFor(sidOf(req));
      if (!entry) return ok(res, null);
      try {
        return ok(res, await entry.auth.ensureFresh());
      } catch (err) {
        return fail(res, err);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const entry = sessionFor(sidOf(req));
      if (!entry) return ok(res, 'need-login');
      try {
        return ok(res, await entry.auth.status());
      } catch (err) {
        return fail(res, err);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/formats') {
      return handleFormats(res);
    }

    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      return handleCreateJob(req, res, url);
    }

    const jobMatch = /^\/api\/jobs\/([^/]+)(\/result)?$/.exec(url.pathname);
    if (req.method === 'GET' && jobMatch) {
      return jobMatch[2] ? handleJobResult(res, jobMatch[1]) : handleJobStatus(res, jobMatch[1]);
    }

    if (req.method === 'POST' && url.pathname === '/api/convert') {
      return handleConvert(req, res, url);
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const sid = sidOf(req);
      const entry = sid ? sessions.get(sid) : null;
      if (entry) await entry.auth.logout();
      if (sid) {
        sessions.delete(sid);
        fs.rmSync(path.join(sessionRoot, sid), { recursive: true, force: true });
      }
      clearSessionCookie(res);
      return ok(res, true);
    }

    if (req.method === 'GET' && url.pathname === '/api/info') {
      return ok(res, {
        version: '0.1.0',
        serverBaseUrl,
        refreshSkewMinutes,
        dataDir,
        mode: 'web',
      });
    }

    if (url.pathname === '/__bridge.js') {
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
      return res.end(WEB_BRIDGE);
    }

    // 静态资源
    let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(rendererDir, pathname.replace(/^\/+/, ''));
    if (!file.startsWith(rendererDir)) {
      res.writeHead(403);
      return res.end('forbidden');
    }

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
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    console.error('[server]', err);
    sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: String(err.message || err) } });
  }
});

server.listen(port, host, () => {
  const nets = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);

  console.log('=========================================');
  console.log('  格式转换器 · 网页版（cloud-server 认证）');
  console.log('=========================================');
  console.log(`服务端     ${serverBaseUrl}`);
  console.log(`监听       ${host}:${port}`);
  console.log(`本机访问   http://127.0.0.1:${port}`);
  if (host === '127.0.0.1' || host === 'localhost') {
    console.log('访问范围   仅本机（局域网不可达）');
  } else {
    for (const ip of nets) console.log(`局域网     http://${ip}:${port}  ⚠️ 会话共享`);
  }
  console.log(`数据目录   ${dataDir}`);
  console.log('');
  console.log('只在内网联调时使用，不要暴露到公网（无 HTTPS）。');
});
