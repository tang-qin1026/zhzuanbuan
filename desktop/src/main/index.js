'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { loadConfig } = require('./config');
const { AuthService } = require('./auth/auth-service');
const { formatsPayload, convertPath } = require('./convert-path');

const isDev = !app.isPackaged;
let mainWindow = null;
let auth = null;
let config = null;
let refreshTimer = null;

/** 启动期异常统一落盘 + 弹窗，避免窗口闪退后什么线索都没有 */
function logFatal(err) {
  const text = `[${new Date().toISOString()}] ${(err && (err.stack || err.message)) || err}\n`;
  try {
    process.stderr.write(text);
  } catch {
    /* 无控制台时忽略 */
  }
  try {
    fs.appendFileSync(path.join(app.getPath('temp'), 'fmt-desktop-startup.log'), text);
  } catch {
    /* 落盘失败也不影响弹窗 */
  }
  try {
    dialog.showErrorBox('格式转换器启动失败', String((err && err.message) || err));
  } catch {
    /* 窗口系统不可用时忽略 */
  }
}

process.on('uncaughtException', (err) => {
  logFatal(err);
  app.exit(1);
});
process.on('unhandledRejection', (err) => {
  logFatal(err);
});

function toEnvelopeError(err) {
  return {
    code: err && err.code ? err.code : 'UNKNOWN',
    message: (err && err.message) || '未知错误',
    locked: Boolean(err && err.locked),
  };
}

function registerIpc() {
  ipcMain.handle('auth:login', async (_event, payload) => {
    try {
      const session = await auth.login(payload && payload.username, payload && payload.password);
      return { ok: true, data: session };
    } catch (err) {
      return { ok: false, error: toEnvelopeError(err) };
    }
  });

  ipcMain.handle('auth:session', async () => {
    try {
      const session = await auth.ensureFresh();
      return { ok: true, data: session };
    } catch (err) {
      return { ok: false, error: toEnvelopeError(err) };
    }
  });

  ipcMain.handle('auth:status', async () => {
    try {
      return { ok: true, data: await auth.status() };
    } catch (err) {
      return { ok: false, error: toEnvelopeError(err) };
    }
  });

  ipcMain.handle('auth:logout', async () => {
    try {
      await auth.logout();
      return { ok: true, data: true };
    } catch (err) {
      return { ok: false, error: toEnvelopeError(err) };
    }
  });

  ipcMain.handle('convert:formats', async () => ({
    ok: true,
    data: formatsPayload({
      ffmpeg: config.ffmpegPath,
      soffice: config.sofficePath,
      poppler: config.popplerDir,
    }),
  }));

  ipcMain.handle('convert:run', async (_event, payload) => {
    try {
      if (!payload || !payload.path) {
        return { ok: false, error: { code: 'INPUT_NOT_FOUND', message: '没有拿到文件路径' } };
      }
      const jobId = payload.jobId || null;
      const emitProgress = (pct) => {
        if (!jobId) return;
        try {
          _event.sender.send('convert:progress', { jobId, pct });
        } catch {
          /* 窗口已关 */
        }
      };

      const result = await convertPath({
        inputPath: payload.path,
        target: String(payload.target || '').toLowerCase(),
        onProgress: emitProgress,
        configured: {
          ffmpeg: config.ffmpegPath,
          soffice: config.sofficePath,
          poppler: config.popplerDir,
        },
      });
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: { code: err.code || 'CONVERT_FAILED', message: err.message } };
    }
  });

  ipcMain.handle('app:reveal', async (_event, target) => {
    try {
      if (target) shell.showItemInFolder(target);
      return { ok: true, data: true };
    } catch (err) {
      return { ok: false, error: { code: 'REVEAL_FAILED', message: err.message } };
    }
  });

  ipcMain.handle('app:info', async () => ({
    ok: true,
    data: {
      version: app.getVersion(),
      serverBaseUrl: config.serverBaseUrl,
      refreshSkewMinutes: config.refreshSkewMinutes,
      dataDir: app.getPath('userData'),
      dev: isDev,
    },
  }));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#FDF6EC',
    title: '格式转换器',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (isDev && process.env.FMT_DEVTOOLS) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(() => {
  try {
    config = loadConfig(app.getPath('userData'));
    console.log(`[boot] electron=${process.versions.electron} node=${process.versions.node}`);
    console.log(`[boot] userData=${app.getPath('userData')}`);
    console.log(`[boot] server=${config.serverBaseUrl}`);

    auth = new AuthService({
      serverBaseUrl: config.serverBaseUrl,
      dataDir: app.getPath('userData'),
      refreshSkewMs: Math.max(0, Number(config.refreshSkewMinutes) || 0) * 60 * 1000,
    });

    // refresh 失效时主动通知 UI 回登录页（不用等下一次操作）
    auth.onSessionLost((reason) => {
      console.log(`[auth] 会话失效: ${reason}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('auth:lost', { reason });
      }
    });

    registerIpc();
    createWindow();
    console.log('[boot] window created');

    // 每 30 分钟静默续期一次，避免客户端常开时 access 悄悄过期
    refreshTimer = setInterval(() => {
      auth.ensureFresh().catch(() => {});
    }, 30 * 60 * 1000);
    if (typeof refreshTimer.unref === 'function') refreshTimer.unref();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (err) {
    logFatal(err);
    app.exit(1);
  }
});

app.on('window-all-closed', () => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (process.platform !== 'darwin') app.quit();
});
