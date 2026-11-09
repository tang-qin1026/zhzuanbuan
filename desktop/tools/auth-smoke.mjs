/**
 * 认证链路自测（cloud-server / HS512 语义）。
 *
 *   node tools/auth-smoke.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { startStubServer } from './stub-server.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { AuthService } = require(path.join(root, 'src/main/auth/auth-service.js'));
const { loadSecret } = require(path.join(root, 'src/main/auth/secure-store.js'));

const results = [];
const check = (name, fn) =>
  (async () => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
      results.push({ name, ok: false, err });
      console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
  })();

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert(err.code === code, `期望 ${code}，实际 ${err.code}（${err.message}）`);
    return err;
  }
  throw new Error(`期望抛出 ${code}，但没有抛错`);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-auth-'));
  const authFile = path.join(dataDir, 'auth.bin');
  const stub = await startStubServer();
  console.log(`\n桩服务端: ${stub.url}\n数据目录: ${dataDir}\n`);

  const auth = new AuthService({ serverBaseUrl: stub.url, dataDir });
  const readStored = () => loadSecret(authFile);

  // ── 登录 ──
  await check('登录成功：显示 nickname，响应不含 token', async () => {
    const s = await auth.login('demo', 'demo1234');
    assert(s.displayName === '演示用户', `displayName 应为 nickname，实际 ${s.displayName}`);
    assert(!('accessToken' in s) && !('refreshToken' in s), '不应把 token 暴露给渲染层');
    assert(s.expiresAt > Date.now(), 'expiresAt 应在未来');
    console.log(`      displayName=${s.displayName} role=${s.role} 剩余 ${s.remainingDays} 天`);
  });

  await check('会话可读回（冷启动不联网）', async () => {
    const s = auth.getSession();
    assert(s && s.remainingDays > 0, '应能读到会话');
    const stored = readStored();
    assert(stored.accessToken && stored.refreshToken, '本地应加密保存两个 token');
  });

  await check('账号显示名不是 portal_<uuid>', async () => {
    const stored = readStored();
    assert(stored.username.startsWith('portal_'), '服务端 username 确实是影子名');
    assert(auth.getSession().displayName === '演示用户', '展示名必须用 nickname');
  });

  // ── 登录异常 ──
  await check('密码错误：message 原样透传（含剩余次数）', async () => {
    const err = await expectCode(auth.login('demo', 'wrong'), 'AUTH_BAD_CREDENTIALS');
    assert(/还可尝试 \d 次/.test(err.message), `应透传动态文案，实际: ${err.message}`);
    console.log(`      "${err.message}"`);
  });

  await check('连续失败：第 3 次识别为锁定（AUTH_LOCKED）', async () => {
    await expectCode(auth.login('demo', 'wrong'), 'AUTH_BAD_CREDENTIALS');
    const err = await expectCode(auth.login('demo', 'wrong'), 'AUTH_LOCKED');
    assert(/锁定/.test(err.message), '锁定文案应透传');
  });

  await check('账号禁用 → AUTH_DISABLED', () => expectCode(auth.login('disabled', 'x'), 'AUTH_DISABLED'));
  await check('系统繁忙 50000 → AUTH_UNAVAILABLE', () => expectCode(auth.login('busy', 'x'), 'AUTH_UNAVAILABLE'));
  await check('空输入 → AUTH_INPUT_EMPTY', () => expectCode(auth.login('', ''), 'AUTH_INPUT_EMPTY'));

  // ── 续期 ──
  await check('access 临近过期 → ensureFresh 静默续期', async () => {
    const before = await auth.login('shortttl', 'demo1234');
    const after = await auth.ensureFresh();
    assert(after !== null, '续期后应仍有会话');
    assert(after.expiresAt >= before.expiresAt, 'refresh 到期时间不应回退');
    const stored = readStored();
    assert(stored.accessExp > Date.now() + 60 * 60 * 1000, 'access 应已换成 2 小时的新令牌');
    console.log(`      access 续期后剩余 ${Math.round((stored.accessExp - Date.now()) / 60000)} 分钟`);
  });

  await check('刷新令牌轮换：旧 refresh 立即失效', async () => {
    await auth.login('shortttl', 'demo1234');
    const old = readStored().refreshToken;
    await auth.ensureFresh();
    await expectCode(auth.server.refresh(old), 'AUTH_SESSION_EXPIRED');
  });

  await check('刷新返回 401 + HTML（无业务码）→ 仍判定登录失效', async () => {
    await expectCode(auth.server.refresh('html-401'), 'AUTH_SESSION_EXPIRED');
  });

  await check('refreshToken 格式非法（40000）→ AUTH_BAD_REQUEST', async () => {
    await expectCode(auth.server.refresh('not-a-jwt'), 'AUTH_BAD_REQUEST');
  });

  await check('刷新令牌被吊销 → 清空会话并通知 UI', async () => {
    await auth.login('shortttl', 'demo1234');
    const token = readStored().refreshToken;
    await fetch(`${stub.url}/__revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: token }),
    });

    let lost = false;
    const off = auth.onSessionLost(() => {
      lost = true;
    });
    const s = await auth.ensureFresh();
    off();

    assert(s === null, '失效后应返回 null');
    assert(lost, '应触发 onSessionLost');
    assert(auth.getSession() === null, '本地凭证应被清空');
  });

  await check('续期时服务端不可达 → 保留会话（离线可用）', async () => {
    await auth.login('shortttl', 'demo1234');
    const offline = new AuthService({ serverBaseUrl: 'http://127.0.0.1:1', dataDir });
    const s = await offline.ensureFresh();
    assert(s !== null && s.displayName === '短令牌', '离线时不应清空会话');
  });

  // ── 字段透传 ──
  await check('mustChangePassword 透传到渲染层', async () => {
    const s = await auth.login('mustchange', 'demo1234');
    assert(s.mustChangePassword === true, 'mustChangePassword 应为 true');
  });

  await check('enterpriseSuspended 透传到渲染层', async () => {
    const s = await auth.login('suspended', 'demo1234');
    assert(s.enterpriseSuspended === true, 'enterpriseSuspended 应为 true');
  });

  // ── 本地状态 ──
  await check('本地文件被篡改 → 视为未登录', async () => {
    fs.writeFileSync(authFile, '{ broken }', 'utf8');
    assert(auth.getSession() === null, '篡改后不应返回会话');
  });

  await check('登出：清本地 + 调服务端吊销', async () => {
    await auth.login('demo', 'demo1234');
    const access = readStored().accessToken;
    const jti = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString()).jti;
    await auth.logout();
    assert(!fs.existsSync(authFile), 'auth.bin 应被删除');
    assert(stub.revokedJti.has(jti), '服务端应收到登出请求并吊销 jti');
  });

  await stub.close();
  fs.rmSync(dataDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
