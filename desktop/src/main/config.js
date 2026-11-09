'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  // cloud-server 地址（不是门户）。真实环境改成内网/公网地址，
  // 或用环境变量 FMT_SERVER_BASE_URL 覆盖。
  serverBaseUrl: 'http://192.168.9.104',
  // access 剩余不足多少分钟开始静默续期
  refreshSkewMinutes: 5,
  // 引擎路径：留空则按内置目录 / 环境变量自动查找
  ffmpegPath: '',
  sofficePath: '',
  popplerDir: '',
};

function loadConfig(dataDir) {
  const file = path.join(dataDir, 'config.json');
  let stored = {};

  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    stored = {};
  }

  const config = { ...DEFAULTS, ...stored };

  if (process.env.FMT_SERVER_BASE_URL) {
    config.serverBaseUrl = process.env.FMT_SERVER_BASE_URL;
  }
  if (process.env.FMT_REFRESH_SKEW_MINUTES) {
    const minutes = Number(process.env.FMT_REFRESH_SKEW_MINUTES);
    if (Number.isFinite(minutes) && minutes >= 0) config.refreshSkewMinutes = minutes;
  }

  if (!fs.existsSync(file)) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2), 'utf8');
    } catch {
      /* 写不了也不影响启动 */
    }
  }

  return config;
}

module.exports = { loadConfig, DEFAULTS };
