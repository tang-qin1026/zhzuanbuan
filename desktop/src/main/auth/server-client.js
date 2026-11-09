'use strict';

const { CODES, AuthError, MESSAGES } = require('./errors');

const DEFAULT_TIMEOUT_MS = 15000;

/** cloud-server 业务码 */
const SERVER_CODE = {
  OK: 0,
  BAD_REQUEST: 40000,
  BAD_CREDENTIALS: 40101,
  DISABLED: 40102,
  SESSION_LOST: 40103,
  BUSY: 50000,
};

/**
 * cloud-server 客户端。
 *
 * 与 v1 的差别（依据 2026-11-09 实测）：
 *   - 地址是 cloud-server，不是门户；客户端不直接访问门户
 *   - token 是 HS512，对称密钥在服务端 → 客户端**无法也不应**验签
 *   - 业务结果看 body.code；HTTP 状态码只作辅助（nginx 可能直接返 401 + HTML）
 *   - message 是动态的（含剩余尝试次数），必须原样透传
 */
class ServerClient {
  constructor({ baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl } = {}) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    if (!this.baseUrl) {
      throw new AuthError(CODES.AUTH_CONFIG_ERROR, MESSAGES[CODES.AUTH_CONFIG_ERROR]);
    }
  }

  async login(username, password) {
    const data = await this._call('/api/auth/login', { username, password });
    return this._tokens(data, '登录');
  }

  async refresh(refreshToken) {
    if (!refreshToken) {
      throw new AuthError(CODES.AUTH_SESSION_EXPIRED, MESSAGES[CODES.AUTH_SESSION_EXPIRED]);
    }
    const data = await this._call('/api/auth/refresh', { refreshToken });
    return this._tokens(data, '刷新');
  }

  /** 登出：吊销服务端 jti。失败不影响本地清理。 */
  async logout(accessToken) {
    try {
      await this._call('/api/auth/logout', {}, { bearer: accessToken });
    } catch {
      /* 网络失败 / token 已失效：忽略 */
    }
  }

  _tokens(data, action) {
    if (!data || !data.accessToken) {
      throw new AuthError(CODES.AUTH_UNAVAILABLE, `${action}成功但未返回 accessToken`);
    }
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || null,
      user: data.user || null,
    };
  }

  async _call(pathname, payload, { bearer } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res;
    let text;
    try {
      const headers = { 'content-type': 'application/json', accept: 'application/json' };
      if (bearer) headers.authorization = `Bearer ${bearer}`;

      res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload || {}),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      const reason = err && err.name === 'AbortError' ? '请求超时' : err.message;
      throw new AuthError(CODES.AUTH_UNAVAILABLE, `服务端不可达：${reason}`);
    } finally {
      clearTimeout(timer);
    }

    // 先试着解析 JSON；nginx 的 401 很可能是 HTML
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }

    if (body && typeof body.code === 'number') {
      this._throwForCode(body.code, body.message);
      return body.data || {};
    }

    // 没有业务码：才回退看 HTTP 状态
    if (res.status === 401) {
      throw new AuthError(CODES.AUTH_SESSION_EXPIRED, MESSAGES[CODES.AUTH_SESSION_EXPIRED]);
    }
    if (!res.ok) {
      throw new AuthError(CODES.AUTH_UNAVAILABLE, `服务端返回 HTTP ${res.status}`);
    }
    throw new AuthError(CODES.AUTH_UNAVAILABLE, '服务端响应无法解析');
  }

  _throwForCode(code, message) {
    const text = message && String(message).trim();
    switch (code) {
      case SERVER_CODE.OK:
        return;
      case SERVER_CODE.BAD_CREDENTIALS: {
        // 注意：“还可尝试 2 次（超过将锁定 15 分钟）”里也有“锁定”二字，
        // 不能用它判定已锁定；只认“已锁定”。
        const locked = /已锁定/.test(text || '');
        throw new AuthError(locked ? CODES.AUTH_LOCKED : CODES.AUTH_BAD_CREDENTIALS, text || MESSAGES[CODES.AUTH_BAD_CREDENTIALS]);
      }
      case SERVER_CODE.DISABLED:
        throw new AuthError(CODES.AUTH_DISABLED, text || MESSAGES[CODES.AUTH_DISABLED], { locked: true });
      case SERVER_CODE.SESSION_LOST:
        throw new AuthError(CODES.AUTH_SESSION_EXPIRED, text || MESSAGES[CODES.AUTH_SESSION_EXPIRED]);
      case SERVER_CODE.BAD_REQUEST:
        throw new AuthError(CODES.AUTH_BAD_REQUEST, text || MESSAGES[CODES.AUTH_BAD_REQUEST]);
      case SERVER_CODE.BUSY:
        throw new AuthError(CODES.AUTH_UNAVAILABLE, text || MESSAGES[CODES.AUTH_UNAVAILABLE]);
      default:
        throw new AuthError(CODES.AUTH_UNAVAILABLE, text || `服务端返回 code=${code}`);
    }
  }
}

module.exports = { ServerClient, SERVER_CODE };
