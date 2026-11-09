/**
 * 浏览器预览用的 mock 桥：形状与 preload 暴露的 window.api 一致。
 * 仅用于看界面，不做真实认证。
 */
export const BRIDGE = `
// 预览用 mock：形状与 preload 暴露的 window.api 完全一致
(() => {
  const KEY = 'fmt.preview.session';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const read = () => {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
  };
  const makeSession = (username) => {
    const now = Date.now();
    return {
      displayName: username === 'demo' ? '演示用户' : username,
      username: 'portal_' + username,
      role: 'user',
      enterpriseId: null,
      scope: null,
      mustChangePassword: username === 'mustchange',
      enterpriseSuspended: username === 'suspended',
      quotaBytes: 21474836480,
      usedBytes: 1073741824,
      expiresAt: now + 14 * 24 * 60 * 60 * 1000,
      remainingDays: 14,
    };
  };

  window.api = {
    auth: {
      login: async (username, password) => {
        await sleep(600);
        if (username === 'disabled') {
          return { ok: false, error: { code: 'AUTH_DISABLED', message: '账号已被禁用' } };
        }
        if (password !== 'demo1234') {
          return {
            ok: false,
            error: {
              code: 'AUTH_BAD_CREDENTIALS',
              message: '用户名或密码错误，还可尝试 2 次（超过将锁定 15 分钟）',
            },
          };
        }
        const session = makeSession(username);
        localStorage.setItem(KEY, JSON.stringify(session));
        return { ok: true, data: session };
      },
      session: async () => ({ ok: true, data: read() }),
      status: async () => ({ ok: true, data: read() ? 'authenticated' : 'need-login' }),
      logout: async () => {
        localStorage.removeItem(KEY);
        return { ok: true, data: true };
      },
    },
    app: {
      info: async () => ({
        ok: true,
        data: { version: '0.1.0', serverBaseUrl: '预览模式', refreshSkewMinutes: 5, dataDir: '—', dev: true },
      }),
    },
    convert: {
      formats: async () => ({
        ok: true,
        data: { kinds: window.__FMT_KINDS__ || [] },
      }),
      __legacyFormats: async () => ({
        ok: true,
        data: {
          kinds: [
            { kind: 'image', label: '图片', exts: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'], targets: ['png', 'jpg', 'webp', 'bmp'], engine: 'ffmpeg', available: true },
            { kind: 'audio', label: '音频', exts: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'], targets: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'], engine: 'ffmpeg', available: true },
            { kind: 'video', label: '视频', exts: ['mp4', 'mkv', 'avi', 'mov', 'webm'], targets: ['mp4', 'mkv', 'webm', 'gif'], engine: 'ffmpeg', available: true },
            { kind: 'document', label: '文档', exts: ['doc', 'docx', 'odt', 'rtf', 'txt'], targets: ['pdf'], engine: 'libreoffice', available: true },
            { kind: 'spreadsheet', label: '表格', exts: ['xls', 'xlsx', 'ods', 'csv'], targets: ['pdf'], engine: 'libreoffice', available: true },
            { kind: 'presentation', label: '演示', exts: ['ppt', 'pptx', 'odp'], targets: ['pdf'], engine: 'libreoffice', available: true },
            { kind: 'pdf', label: 'PDF', exts: ['pdf'], targets: ['png', 'jpg'], engine: 'poppler', available: true },
          ],
        },
      }),
      run: async () => ({
        ok: false,
        error: { code: 'PREVIEW', message: '预览模式不做真实转换' },
      }),
    },
  };

  addEventListener('DOMContentLoaded', () => {
    const tag = document.createElement('div');
    tag.textContent = '浏览器预览 · 登录结果为模拟数据';
    tag.style.cssText =
      'position:fixed;left:12px;bottom:10px;font:11px/1.4 system-ui,sans-serif;' +
      'color:#a99a89;background:rgba(255,255,255,.7);border:1px solid #eee2d3;' +
      'border-radius:999px;padding:3px 10px;pointer-events:none';
    document.body.appendChild(tag);
  });
})();
`;
