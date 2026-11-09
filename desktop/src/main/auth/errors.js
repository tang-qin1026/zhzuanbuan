'use strict';

/**
 * 统一错误码。
 *
 * 服务端业务码（40101/40102/40103/40000/50000）映射到客户端码，
 * 但 **文案一律以服务端返回的 message 为准**（如“还可尝试 3 次”是动态的）。
 */
const CODES = {
  AUTH_BAD_CREDENTIALS: 'AUTH_BAD_CREDENTIALS',
  AUTH_LOCKED: 'AUTH_LOCKED',
  AUTH_DISABLED: 'AUTH_DISABLED',
  AUTH_SESSION_EXPIRED: 'AUTH_SESSION_EXPIRED',
  AUTH_BAD_REQUEST: 'AUTH_BAD_REQUEST',
  AUTH_UNAVAILABLE: 'AUTH_UNAVAILABLE',
  AUTH_INPUT_EMPTY: 'AUTH_INPUT_EMPTY',
  AUTH_STORAGE_ERROR: 'AUTH_STORAGE_ERROR',
  AUTH_CONFIG_ERROR: 'AUTH_CONFIG_ERROR',
};

class AuthError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    if (extra && typeof extra === 'object') Object.assign(this, extra);
  }

  toJSON() {
    return { code: this.code, message: this.message, locked: Boolean(this.locked) };
  }
}

/** 仅在服务端没给 message 时兜底 */
const MESSAGES = {
  [CODES.AUTH_BAD_CREDENTIALS]: '用户名或密码错误',
  [CODES.AUTH_LOCKED]: '尝试次数过多，账号已临时锁定',
  [CODES.AUTH_DISABLED]: '账号已被禁用',
  [CODES.AUTH_SESSION_EXPIRED]: '登录已过期，请重新登录',
  [CODES.AUTH_BAD_REQUEST]: '请求参数有误',
  [CODES.AUTH_UNAVAILABLE]: '服务暂不可用，请稍后再试',
  [CODES.AUTH_INPUT_EMPTY]: '请输入账号和密码',
  [CODES.AUTH_STORAGE_ERROR]: '本地登录状态读写失败',
  [CODES.AUTH_CONFIG_ERROR]: '未配置服务端地址',
};

module.exports = { CODES, AuthError, MESSAGES };
