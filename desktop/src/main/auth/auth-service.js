'use strict';

const path = require('node:path');
const { CODES, AuthError, MESSAGES } = require('./errors');

const AUTH_FILE = 'auth.bin';
const DEFAULT_SKEW_MS = 5 * 60 * 1000; // access 剩余不足 5 分钟就续

/**
 * 认证服务（依据 2026-11-09 实测重写）。
 *
 * 设计要点：
 *   - 只连 cloud-server 一个地址，不直接访问门户
 *   - token 是 HS512，客户端**不验签**（对称密钥在服务端，客户端也拿不到）
 *   - 长期状态由 refreshToken 轮换承担，不自造本地凭证
 *   - 本地只做一件事：DPAPI 加密存两个 token + 展示用字段
 *   - 客户端读 `exp` 只用于决定何时提前续期，属于健壮性，不是安全措施
 */
class AuthService {
  constructor({
    serverBaseUrl,
    dataDir,
    refreshSkewMs = DEFAULT_SKEW_MS,
    fetchImpl,
    now = () => Date.now(),
  }) {
    this.refreshSkewMs = refreshSkewMs;
    this.now = now;
    this.authFile = path.join(dataDir, AUTH_FILE);

    const { ServerClient } = require('./server-client');
    this.server = new ServerClient({ baseUrl: serverBaseUrl, fetchImpl });
    this._sessionLostHandlers = new Set();
  }

  // ── 登录 ──────────────────────────────────────────────
  async login(username, password) {
    const user = String(username || '').trim();
    const pass = String(password || '');

    if (!user || !pass) {
      throw new AuthError(CODES.AUTH_INPUT_EMPTY, MESSAGES[CODES.AUTH_INPUT_EMPTY]);
    }

    const tokens = await this.server.login(user, pass);
    const state = this._buildState(tokens, null, user);
    this._save(state);
    return toPublic(state);
  }

  // ── 读取 ──────────────────────────────────────────────
  getSession() {
    const state = this._load();
    if (!state) return null;
    if (this.now() >= state.refreshExp) return null;
    return toPublic(state);
  }

  async status() {
    return this.getSession() ? 'authenticated' : 'need-login';
  }

  // ── 静默续期 ──────────────────────────────────────────
  async ensureFresh() {
    const state = this._load();
    if (!state) return null;

    const now = this.now();

    // refresh 本身过期：14 天没用过，必须重新登录
    if (now >= state.refreshExp) {
      this._clearAndEmit('refresh 已过期');
      return null;
    }

    // access 还够用
    if (state.accessExp - now > this.refreshSkewMs) return toPublic(state);

    if (!state.refreshToken) return toPublic(state);

    let tokens;
    try {
      tokens = await this.server.refresh(state.refreshToken);
    } catch (err) {
      // 网络不通：保留会话，离线继续用，下个周期再试
      if (err.code === CODES.AUTH_UNAVAILABLE) return toPublic(state);

      // 40000 / 40103 / 401：本地凭证已不可用
      if (err.code === CODES.AUTH_SESSION_EXPIRED || err.code === CODES.AUTH_BAD_REQUEST) {
        this._clearAndEmit(err.message);
        return null;
      }
      throw err;
    }

    const next = this._buildState(tokens, state, state.username);
    this._save(next);
    return toPublic(next);
  }

  // ── 登出 ──────────────────────────────────────────────
  async logout() {
    const state = this._load();
    if (state && state.accessToken) {
      // 吊销服务端 jti；失败不阻塞本地登出
      await this.server.logout(state.accessToken);
    }
    const { removeSecret } = require('./secure-store');
    removeSecret(this.authFile);
  }

  // ── 会话失效通知（给 UI 用）────────────────────────────
  onSessionLost(handler) {
    this._sessionLostHandlers.add(handler);
    return () => this._sessionLostHandlers.delete(handler);
  }

  // ── 内部 ─────────────────────────────────────────────
  _buildState(tokens, previous, fallbackUsername) {
    const claims = decodePayload(tokens.accessToken);
    const refreshClaims = tokens.refreshToken ? decodePayload(tokens.refreshToken) : {};
    const now = this.now();
    const user = tokens.user || (previous && previous.user) || {};

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || (previous && previous.refreshToken) || null,
      username: user.username || (previous && previous.username) || fallbackUsername,
      nickname: user.nickname || (previous && previous.nickname) || null,
      role: user.role || (previous && previous.role) || null,
      enterpriseId: num(user.enterpriseId, previous && previous.enterpriseId),
      scope: user.scope || (previous && previous.scope) || null,
      mustChangePassword: Boolean(user.mustChangePassword),
      enterpriseSuspended: Boolean(user.enterpriseSuspended),
      quotaBytes: num(user.quotaBytes, previous && previous.quotaBytes),
      usedBytes: num(user.usedBytes, previous && previous.usedBytes),
      accessExp: claims.exp ? claims.exp * 1000 : now + 2 * 60 * 60 * 1000,
      refreshExp: refreshClaims.exp ? refreshClaims.exp * 1000 : now + 14 * 24 * 60 * 60 * 1000,
      savedAt: now,
    };
  }

  _load() {
    const { loadSecret } = require('./secure-store');
    const state = loadSecret(this.authFile);
    if (!state || !state.accessToken || !state.refreshToken) return null;

    // 系统时间回拨：凭证不可能“未来签发”
    if (typeof state.savedAt === 'number' && this.now() < state.savedAt - 60 * 60 * 1000) return null;
    return state;
  }

  _save(state) {
    const { saveSecret } = require('./secure-store');
    return saveSecret(this.authFile, state);
  }

  _clearAndEmit(reason) {
    const { removeSecret } = require('./secure-store');
    removeSecret(this.authFile);
    for (const handler of this._sessionLostHandlers) {
      try {
        handler(reason);
      } catch {
        /* 单个回调异常不影响其它 */
      }
    }
  }
}

function num(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  return Number.isFinite(fallback) ? fallback : null;
}

/** 只解码，不验签 —— token 对客户端是不透明字符串 */
function decodePayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** 交给渲染层的字段：没有 token、没有签名 */
function toPublic(state) {
  const now = Date.now();
  return {
    displayName: state.nickname || state.username,
    username: state.username,
    role: state.role,
    enterpriseId: state.enterpriseId,
    scope: state.scope,
    mustChangePassword: state.mustChangePassword,
    enterpriseSuspended: state.enterpriseSuspended,
    quotaBytes: state.quotaBytes,
    usedBytes: state.usedBytes,
    expiresAt: state.refreshExp, // 从 refresh 的 exp 读，14 天
    remainingDays: Math.max(0, Math.ceil((state.refreshExp - now) / (24 * 60 * 60 * 1000))),
  };
}

module.exports = { AuthService, decodePayload };
