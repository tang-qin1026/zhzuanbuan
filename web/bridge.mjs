/**
 * 网页版的 window.api 桥：形状与 Electron preload 完全一致，
 * 只是把 IPC 换成同源 HTTP 请求。令牌全程留在服务端。
 *
 * 转换走「任务」模型：上传 → 轮询进度 → 取结果，
 * 这样浏览器里也能看到百分比。
 */
export const WEB_BRIDGE = `
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let progressHandler = null;

  async function call(url, options) {
    try {
      const res = await fetch(url, options);
      return await res.json();
    } catch (err) {
      return { ok: false, error: { code: 'AUTH_UNAVAILABLE', message: '无法连接本地服务' } };
    }
  }
  const post = (url, body) =>
    call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  const get = (url) => call(url);

  async function runConvert(file, target, jobId) {
    const id = jobId || 'job-' + Date.now() + '-' + Math.random().toString(16).slice(2);

    let created;
    try {
      const res = await fetch('/api/jobs?target=' + encodeURIComponent(target), {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-filename': encodeURIComponent(file.name),
          'x-job-id': id,
        },
        body: file,
      });
      created = await res.json();
    } catch (err) {
      return { ok: false, error: { code: 'CONVERT_FAILED', message: '上传失败' } };
    }
    if (!created.ok) return created;

    let last = null;
    for (let i = 0; i < 1800; i += 1) {
      await sleep(400);
      const s = await get('/api/jobs/' + encodeURIComponent(id));
      if (!s.ok) return s;
      last = s.data;
      if (typeof s.data.pct === 'number' && progressHandler) {
        progressHandler({ jobId: id, pct: s.data.pct });
      }
      if (s.data.status !== 'running') break;
    }

    if (!last || last.status === 'error') {
      return { ok: false, error: (last && last.error) || { code: 'CONVERT_FAILED', message: '转换失败' } };
    }
    if (last.status !== 'done') {
      return { ok: false, error: { code: 'TIMEOUT', message: '转换超时' } };
    }

    const rres = await fetch('/api/jobs/' + encodeURIComponent(id) + '/result');
    const blob = await rres.blob();
    const name = decodeURIComponent(rres.headers.get('x-out-name') || 'out.' + target);
    return { ok: true, data: { blob, filename: name } };
  }

  window.api = {
    auth: {
      login: (username, password) => post('/api/login', { username, password }),
      session: () => get('/api/session'),
      status: () => get('/api/status'),
      logout: () => post('/api/logout'),
    },
    app: {
      info: () => get('/api/info'),
    },
    convert: {
      formats: () => get('/api/formats'),
      run: runConvert,
      onProgress: (callback) => {
        progressHandler = callback;
        return () => {
          progressHandler = null;
        };
      },
    },
  };
})();
`;
