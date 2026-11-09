/**
 * 找 cloud-server：逐个探测候选地址的 /api/auth/login，
 * 看谁返回 cloud-server 的业务码（40101），而不是门户的 2003。
 *
 *   node tools/find-server.mjs
 *   node tools/find-server.mjs 192.168.9.222 192.168.9.105
 */
const HOSTS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const CANDIDATES = HOSTS.length ? HOSTS : ['192.168.9.222', '192.168.9.105'];
const PORTS = [80, 3000, 3001, 8080, 8081, 8000, 9000];
const TIMEOUT_MS = 2500;

const BODY = JSON.stringify({ username: '__probe__', password: '__probe__' });

async function probe(host, port) {
  const url = `http://${host}${port === 80 ? '' : `:${port}`}/api/auth/login`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: BODY,
      signal: controller.signal,
    });
    const text = await res.text();
    let code = null;
    let message = '';
    try {
      const body = JSON.parse(text);
      code = body.code;
      message = body.message || '';
    } catch {
      /* 非 JSON */
    }
    return {
      url,
      status: res.status,
      server: res.headers.get('server') || '',
      code,
      message: String(message).slice(0, 40),
      ms: Date.now() - started,
    };
  } catch (err) {
    return { url, error: err.name === 'AbortError' ? 'timeout' : 'refused', ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const results = await Promise.all(
  CANDIDATES.flatMap((host) => PORTS.map((port) => probe(host, port)))
);

console.log('');
console.log('地址                                    状态    code   Server        耗时   判定');
console.log('─'.repeat(96));
for (const r of results) {
  const verdict = r.error
    ? '—'
    : r.code === 40101
      ? '★ cloud-server'
      : r.code === 2003
        ? '门户（不是它）'
        : r.status
          ? '在线，非认证接口'
          : '—';
  console.log(
    `${r.url.padEnd(40)} ${String(r.status ?? r.error).padEnd(6)} ${String(r.code ?? '-').padEnd(6)} ${String(r.server || '-').padEnd(14)} ${String(r.ms).padEnd(6)} ${verdict}`
  );
}
console.log('');
console.log('目标：code=40101（cloud-server）。code=2003 是门户，客户端不连它。');
