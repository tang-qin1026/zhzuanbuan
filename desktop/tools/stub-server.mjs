/**
 * 本地桩服务端：模拟 cloud-server 的认证契约（依据 2026-11-09 实测）。
 *
 *   POST /api/auth/login     → {code, message, data:{accessToken, refreshToken, user}}
 *   POST /api/auth/refresh   → 轮换 access + refresh
 *   POST /api/auth/logout    → 吊销 jti
 *   GET  /health
 *   POST /__revoke           → 手动吊销 refreshToken（测试用）
 *
 * token 为 HS512（对称密钥在服务端），iss=cloud-server。
 * 业务码：0 / 40000 / 40101 / 40102 / 40103 / 50000，HTTP 恒 200。
 */
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';

const SECRET = 'stub-hs512-secret';
const ISSUER = 'cloud-server';
const ACCESS_TTL = 7200; // 120 分钟
const REFRESH_TTL = 1209600; // 14 天
const SHORT_TTL = 120; // shortttl 账号

const b64url = (input) => Buffer.from(input).toString('base64url');

const USERS = {
  demo: { password: 'demo1234', nickname: '演示用户', role: 'user' },
  shortttl: { password: 'demo1234', nickname: '短令牌', role: 'user' },
  mustchange: { password: 'demo1234', nickname: '待改密', role: 'user', mustChangePassword: true },
  suspended: { password: 'demo1234', nickname: '停用企业', role: 'user', enterpriseSuspended: true },
};

export function createStubServer() {
  const refreshTokens = new Map(); // token → {sub, username}
  const revokedJti = new Set();
  const failures = new Map(); // username → 次数

  function sign(claims) {
    const header = { alg: 'HS512', typ: 'JWT' };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const signature = createHmac('sha512', SECRET).update(input).digest('base64url');
    return `${input}.${signature}`;
  }

  function issue(username, profile, { shortTtl = false } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const sub = String(profile.sub || Math.floor(Math.random() * 1000) + 10);
    const access = sign({
      jti: randomUUID(),
      iss: ISSUER,
      sub,
      username,
      role: profile.role || 'user',
      typ: 'access',
      uv: 0,
      iat: now,
      exp: now + (shortTtl ? SHORT_TTL : ACCESS_TTL),
    });
    const refresh = sign({ jti: randomUUID(), iss: ISSUER, sub, typ: 'refresh', iat: now, exp: now + REFRESH_TTL });
    refreshTokens.set(refresh, { sub, username });
    return { accessToken: access, refreshToken: refresh, sub };
  }

  function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 1e6) req.destroy();
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'));
        } catch {
          resolve(null);
        }
      });
    });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, refreshTokens: refreshTokens.size });
    }

    if (req.method === 'POST' && url.pathname === '/__revoke') {
      const body = (await readBody(req)) || {};
      if (body.refreshToken) refreshTokens.delete(body.refreshToken);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = (await readBody(req)) || {};
      const username = String(body.username || '');
      const password = String(body.password || '');

      if (username === 'disabled') return json(res, 200, { code: 40102, message: '账号已被禁用' });
      if (username === 'busy') return json(res, 200, { code: 50000, message: '系统繁忙，请稍后再试' });
      if (username === 'locked') {
        return json(res, 200, { code: 40101, message: '账号已锁定，请 15 分钟后再试' });
      }

      const profile = USERS[username];
      if (!profile || password !== profile.password) {
        const used = (failures.get(username) || 0) + 1;
        failures.set(username, used);
        const left = Math.max(0, 3 - used);
        if (left === 0) {
          return json(res, 200, { code: 40101, message: '用户名或密码错误，账号已锁定 15 分钟' });
        }
        return json(res, 200, {
          code: 40101,
          message: `用户名或密码错误，还可尝试 ${left} 次（超过将锁定 15 分钟）`,
        });
      }

      failures.delete(username);
      const { accessToken, refreshToken, sub } = issue(username, profile, {
        shortTtl: username === 'shortttl',
      });
      return json(res, 200, {
        code: 0,
        message: 'ok',
        data: {
          accessToken,
          refreshToken,
          user: {
            id: Number(sub),
            username: `portal_${sub}`,
            nickname: profile.nickname,
            role: profile.role,
            mustChangePassword: Boolean(profile.mustChangePassword),
            enterpriseSuspended: Boolean(profile.enterpriseSuspended),
            quotaBytes: 21474836480,
            usedBytes: 1073741824,
          },
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/refresh') {
      const body = (await readBody(req)) || {};
      const token = body.refreshToken;

      // 模拟 nginx 直接 401 + HTML（无业务码）
      if (token === 'html-401') {
        res.writeHead(401, { 'content-type': 'text/html' });
        return res.end('<html><body>401 Authorization Required</body></html>');
      }
      if (typeof token !== 'string' || token.split('.').length !== 3) {
        return json(res, 200, { code: 40000, message: 'refreshToken 格式非法' });
      }

      const entry = refreshTokens.get(token);
      if (!entry) return json(res, 200, { code: 40103, message: '登录已过期，请重新登录' });

      refreshTokens.delete(token); // 轮换
      const profile = USERS[entry.username] || { role: 'user' };
      const { accessToken, refreshToken } = issue(entry.username, { ...profile, sub: entry.sub });
      return json(res, 200, { code: 0, message: 'ok', data: { accessToken, refreshToken } });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const auth = req.headers.authorization || '';
      const token = auth.replace(/^Bearer\s+/i, '');
      const claims = token.split('.').length === 3 ? JSON.parse(Buffer.from(token.split('.')[1], 'base64url')) : null;
      if (claims && claims.jti) revokedJti.add(claims.jti);
      return json(res, 200, { code: 0, message: 'ok', data: true });
    }

    return json(res, 404, { code: 404, message: 'not found' });
  });

  return { server, refreshTokens, revokedJti, failures };
}

export function startStubServer({ port = 0 } = {}) {
  const { server, refreshTokens, revokedJti } = createStubServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        refreshTokens,
        revokedJti,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('stub-server.mjs');
if (isMain) {
  const idx = process.argv.indexOf('--port');
  const port = idx > -1 ? Number(process.argv[idx + 1]) : 4789;
  startStubServer({ port }).then((s) => {
    console.log(`[stub-server] listening on ${s.url}`);
    console.log('[stub-server] 正常账号: demo / demo1234（shortttl、mustchange、suspended 同名密码）');
    console.log('[stub-server] 异常账号: disabled / busy / locked，任意错误密码会累计到锁定');
    console.log('[stub-server] 刷新: POST /api/auth/refresh（轮换，旧 token 立即失效）');
  });
}
