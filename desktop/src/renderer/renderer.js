'use strict';

const $ = (sel) => document.querySelector(sel);

/** 仅当服务端没给 message 时兜底 */
const FALLBACK_TEXT = {
  AUTH_BAD_CREDENTIALS: '用户名或密码错误',
  AUTH_LOCKED: '尝试次数过多，账号已临时锁定，请稍后再试',
  AUTH_DISABLED: '账号已被禁用，请联系管理员',
  AUTH_SESSION_EXPIRED: '登录已过期，请重新登录',
  AUTH_BAD_REQUEST: '请求参数有误',
  AUTH_UNAVAILABLE: '服务暂不可用，请稍后再试',
  AUTH_INPUT_EMPTY: '请输入账号和密码',
  AUTH_STORAGE_ERROR: '本地登录状态保存失败，请检查磁盘权限',
  AUTH_CONFIG_ERROR: '未配置服务端地址，请联系管理员',
};

const els = {
  viewLogin: $('#view-login'),
  viewMain: $('#view-main'),
  form: $('#login-form'),
  username: $('#username'),
  password: $('#password'),
  remember: $('#remember'),
  loginBtn: $('#login-btn'),
  btnLabel: $('.btn-label'),
  spinner: $('.btn-spinner'),
  errorBox: $('#error-box'),
  errorText: $('#error-text'),
  userName: $('#user-name'),
  authNote: $('#auth-note'),
  userRole: $('#user-role'),
  validUntil: $('#valid-until'),
  remaining: $('#remaining'),
  banner: $('#banner'),
  dropzone: $('#dropzone'),
  dropTitle: $('#drop-title'),
  dropHint: $('#drop-hint'),
  fileInput: $('#file-input'),
  convertPanel: $('#convert-panel'),
  convertBtn: $('#convert-btn'),
  cancelBtn: $('#cancel-btn'),
  clearBtn: $('#clear-btn'),
  convertStatus: $('#convert-status'),
  fileList: $('#file-list'),
  matrix: $('#matrix'),
  matrixBody: $('#matrix-body'),
  logoutBtn: $('#logout-btn'),
  appVer: $('#app-ver'),
  portalLine: $('#portal-line'),
};

let submitting = false;
let lockedUntil = 0;
let formats = null;
let pendingTarget = null;
const runningJobs = new Map();
let progressTimer = null;
let defaultAccept = '';

/** 批次状态 */
const batch = {
  items: [], // {id, file, name, size, kind, status, result, error}
  target: '',
  running: false,
  cancelled: false,
  seq: 0,
};

// ── 登录 ────────────────────────────────────────────────
function showError(code, message) {
  els.errorText.textContent = message || FALLBACK_TEXT[code] || '登录失败，请稍后再试';
  els.errorBox.classList.remove('hidden');
}

function clearError() {
  els.errorBox.classList.add('hidden');
}

function setLoading(loading) {
  submitting = loading;
  const locked = Date.now() < lockedUntil;
  els.loginBtn.disabled = loading || locked;
  els.spinner.classList.toggle('hidden', !loading);
  els.btnLabel.style.visibility = loading ? 'hidden' : 'visible';
  els.username.disabled = loading;
  els.password.disabled = loading;
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function showLogin() {
  els.viewMain.classList.add('hidden');
  els.viewLogin.classList.remove('hidden');
  els.password.value = '';
  clearError();
  setLoading(false);
  els.username.focus();
}

function showMain(session) {
  els.viewLogin.classList.add('hidden');
  els.viewMain.classList.remove('hidden');

  els.userName.textContent = session.displayName || '—';
  els.authNote.textContent = '已完成服务端认证';
  els.userRole.textContent = session.role || '—';
  els.validUntil.textContent = formatDate(session.expiresAt);
  els.remaining.textContent = `${session.remainingDays ?? '—'} 天`;

  let banner = null;
  let danger = false;
  if (session.enterpriseSuspended) {
    banner = '所属企业已停用，暂时无法使用。请联系管理员。';
    danger = true;
  } else if (session.mustChangePassword) {
    banner = '需要先在平台修改密码，修改后重新登录。';
  }

  const blocked = Boolean(banner);
  if (banner) {
    els.banner.textContent = banner;
    els.banner.classList.remove('hidden');
    els.banner.classList.toggle('danger', danger);
  } else {
    els.banner.classList.add('hidden');
  }

  els.dropzone.classList.toggle('hidden', blocked);
  els.convertPanel.classList.add('hidden');
  if (blocked) els.matrix.classList.add('hidden');
  else renderMatrix();
}

// ── 批量转换 ────────────────────────────────────────────
function humanSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function kindByExt(name) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
  if (!ext || !formats) return 'unknown';
  const lower = ext.toLowerCase();
  const hit = formats.find((k) => k.exts.includes(lower));
  return hit ? hit.kind : 'unknown';
}

function kindOfFile(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type === 'application/pdf') return 'pdf';
  return kindByExt(file.name);
}

function targetsOf(kind) {
  const def = formats && formats.find((k) => k.kind === kind);
  if (!def) return [];
  const bad = def.unsupported || {};
  return def.targets.filter((t) => !bad[t]);
}

function defaultTargetFor(kind) {
  const list = targetsOf(kind);
  return list.length ? list[0] : null;
}

function statusText(item) {
  switch (item.status) {
    case 'pending':
      return '等待中';
    case 'running':
      return typeof item.pct === 'number' ? `转换中 ${item.pct}%` : '转换中…';
    case 'done':
      return '已完成';
    case 'error':
      return item.error || '失败';
    case 'skipped':
      return '已取消';
    default:
      return '';
  }
}

function renderList() {
  els.fileList.innerHTML = '';
  for (const item of batch.items) {
    const li = document.createElement('li');
    li.className = 'file-item';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    name.title = item.name;

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = humanSize(item.size);

    const targets = targetsOf(item.kind);
    const targetSel = document.createElement('select');
    targetSel.className = 'row-target';
    if (!targets.length) {
      targetSel.disabled = true;
      const opt = document.createElement('option');
      opt.textContent = '不支持';
      targetSel.appendChild(opt);
    } else {
      for (const t of targets) {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t.toUpperCase();
        targetSel.appendChild(opt);
      }
      if (!targets.includes(item.target)) item.target = targets[0];
      targetSel.value = item.target;
      targetSel.disabled = batch.running || item.status === 'done';
      targetSel.addEventListener('change', () => {
        item.target = targetSel.value;
      });
    }

    const status = document.createElement('span');
    status.className = `status ${item.status === 'done' ? 'ok' : item.status === 'error' ? 'error' : ''}`;
    status.textContent = statusText(item);

    const action = document.createElement('span');
    action.className = 'action';
    if (item.status === 'done' && item.result) {
      const btn = document.createElement('button');
      btn.className = 'link';
      btn.type = 'button';
      if (item.result.blob) {
        btn.textContent = '下载';
        btn.addEventListener('click', () => {
          const url = URL.createObjectURL(item.result.blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = item.result.filename;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        });
      } else if (item.result.path) {
        btn.textContent = '打开文件夹';
        btn.addEventListener('click', () => window.api.app.reveal(item.result.path));
      }
      action.appendChild(btn);
    }

    li.append(name, meta, targetSel, status, action);
    els.fileList.appendChild(li);
  }
}


function renderMatrix() {
  if (!formats || !formats.length) {
    els.matrix.classList.add('hidden');
    return;
  }
  els.matrixBody.innerHTML = '';

  for (const kind of formats) {
    const row = document.createElement('div');
    row.className = 'matrix-row';

    const label = document.createElement('span');
    label.className = 'matrix-kind';
    label.textContent = kind.label || kind.kind;

    // 左：输入什么（全部支持的源格式）
    const sources = document.createElement('span');
    sources.className = 'matrix-src';
    const exp = kind.experimental || [];
    sources.textContent =
      (kind.exts || []).map((e) => e.toUpperCase() + (exp.includes(e) ? '*' : '')).join(' · ');
    sources.title = sources.textContent + (exp.length ? '\n* 实验性支持' : '');

    const arrow = document.createElement('span');
    arrow.className = 'matrix-arrow';
    arrow.textContent = '→';

    // 右：可以变成什么（可点，点了直接按这个组合选文件）
    const chips = document.createElement('div');
    chips.className = 'matrix-chips';

    const bad = kind.unsupported || {};
    for (const target of kind.targets || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      const reason = bad[target];
      btn.disabled = kind.available === false || Boolean(reason);
      btn.title = reason
        ? target.toUpperCase() + '：' + reason
        : '选 ' + (kind.exts || []).join(' / ') + ' 转成 ' + target.toUpperCase();
      btn.innerHTML =
        '<span class="dot"></span><span class="to">' + target.toUpperCase() + '</span>' +
        (reason ? '<span class="mark">×</span>' : '');
      if (!reason) btn.addEventListener('click', () => openPickerFor(kind, target));
      chips.appendChild(btn);
    }

    row.append(label, sources, arrow, chips);
    els.matrixBody.appendChild(row);
  }

  els.matrix.classList.remove('hidden');
}

function openPickerFor(kind, target) {
  pendingTarget = target;
  els.fileInput.accept = (kind.exts || []).map((e) => '.' + e).join(',');
  els.fileInput.click();
}

function refreshSummary() {
  els.clearBtn.classList.toggle('hidden', batch.running || !batch.items.length);

  if (!batch.items.length) {
    els.convertPanel.classList.add('hidden');
    return;
  }

  const pending = batch.items.filter((i) => i.status === 'pending');
  const unsupported = batch.items.filter((i) => !targetsOf(i.kind).length).length;

  els.convertBtn.disabled = batch.running || !pending.length;

  const parts = [`共 ${batch.items.length} 个文件`];
  if (pending.length) parts.push(`待转换 ${pending.length}`);
  if (unsupported) parts.push(`${unsupported} 个类型不支持`);
  els.convertStatus.textContent = parts.join(' · ');
  els.convertStatus.dataset.kind = unsupported ? 'error' : 'muted';
}

function addFiles(fileList) {
  if (!fileList || !fileList.length) return;
  const wasEmpty = batch.items.length === 0;

  for (const file of fileList) {
    const kind = kindOfFile(file);
    batch.items.push({
      id: ++batch.seq,
      file,
      name: file.name,
      size: file.size,
      kind,
      target: pendingTarget && targetsOf(kind).includes(pendingTarget) ? pendingTarget : defaultTargetFor(kind),
      status: 'pending',
      pct: null,
      result: null,
      error: null,
    });
  }

  if (wasEmpty) batch.cancelled = false;

  pendingTarget = null;

  els.convertPanel.classList.remove('hidden');
  renderList();
  refreshSummary();
}

async function runOne(item, target) {
  item.status = 'running';
  item.pct = 0;
  renderList();

  const jobId = 'job-' + item.id + '-' + Date.now();
  runningJobs.set(jobId, item);

  try {
    const res = await window.api.convert.run(item.file, target, jobId);
    if (res && res.ok) {
      item.status = 'done';
      item.result = res.data;
    } else {
      item.status = 'error';
      item.error = (res && res.error && res.error.message) || '转换失败';
    }
  } catch (err) {
    item.status = 'error';
    item.error = (err && err.message) || '转换失败';
  } finally {
    runningJobs.delete(jobId);
  }
  renderList();
}

async function startBatch() {
  if (batch.running || !batch.items.length) return;

  const pending = batch.items.filter((i) => i.status === 'pending' || i.status === 'error' || i.status === 'skipped');
  if (!pending.length) return;

  const runnable = [];
  for (const item of pending) {
    item.result = null;
    item.error = null;
    if (item.target && targetsOf(item.kind).includes(item.target)) {
      item.status = 'pending';
      runnable.push(item);
    } else {
      item.status = 'error';
      item.error = '不支持该格式';
    }
  }
  if (!runnable.length) {
    renderList();
    refreshSummary();
    return;
  }

  batch.running = true;
  batch.cancelled = false;
  els.convertBtn.disabled = true;
  els.cancelBtn.classList.remove('hidden');
  els.convertStatus.textContent = `转换中…（并发 2）`;
  els.convertStatus.dataset.kind = 'muted';
  renderList();

  const queue = [...runnable];
  const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
    while (queue.length && !batch.cancelled) {
      const item = queue.shift();
      await runOne(item, item.target);
    }
  });
  await Promise.all(workers);

  // 取消后剩余任务标记掉
  for (const item of queue) {
    item.status = 'skipped';
  }

  batch.running = false;
  els.convertBtn.disabled = false;
  els.cancelBtn.classList.add('hidden');

  const done = batch.items.filter((i) => i.status === 'done').length;
  const failed = batch.items.filter((i) => i.status === 'error').length;
  els.convertStatus.textContent = `完成 ${done} 个${failed ? `，失败 ${failed} 个` : ''}`;
  els.convertStatus.dataset.kind = failed ? 'error' : 'ok';
  renderList();
}

function clearBatch() {
  if (batch.running) return;
  batch.items = [];
  els.fileList.innerHTML = '';
  els.convertPanel.classList.add('hidden');
  els.convertStatus.textContent = '';
  refreshSummary();
}

function cancelBatch() {
  if (!batch.running) return;
  batch.cancelled = true;
  els.convertStatus.textContent = '正在取消，等待进行中的任务结束…';
}

function wireConvert() {
  defaultAccept = els.fileInput.accept;
  if (!window.api.convert) {
    els.dropTitle.textContent = '转换功能需在桌面端使用';
    els.dropHint.textContent = '当前环境未接入转换模块';
    els.dropzone.classList.add('disabled');
    return;
  }

  els.dropzone.addEventListener('click', () => els.fileInput.click());
  els.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') els.fileInput.click();
  });

  els.fileInput.addEventListener('change', () => {
    addFiles(Array.from(els.fileInput.files || []));
    els.fileInput.value = '';
    els.fileInput.accept = defaultAccept;
  });

  for (const type of ['dragenter', 'dragover']) {
    els.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropzone.classList.add('dragging');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    els.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropzone.classList.remove('dragging');
    });
  }
  els.dropzone.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) addFiles(Array.from(files));
  });

  if (window.api.convert.onProgress) {
    window.api.convert.onProgress(({ jobId, pct }) => {
      const item = runningJobs.get(jobId);
      if (!item) return;
      item.pct = pct;
      // 400ms 内合并一次渲染，避免每帧重排整个列表
      if (progressTimer) return;
      progressTimer = setTimeout(() => {
        progressTimer = null;
        renderList();
      }, 200);
    });
  }

  els.convertBtn.addEventListener('click', startBatch);
  els.cancelBtn.addEventListener('click', cancelBatch);
  els.clearBtn.addEventListener('click', clearBatch);
}

// ── 启动 ────────────────────────────────────────────────
async function restoreRememberedAccount() {
  try {
    const saved = localStorage.getItem('fmt.rememberedUser');
    if (saved) {
      els.username.value = saved;
      els.remember.checked = true;
    }
  } catch {
    /* localStorage 不可用不影响登录 */
  }
}

async function boot() {
  try {
    const info = await window.api.app.info();
    if (info && info.ok) {
      els.appVer.textContent = `v${info.data.version}`;
      const base = info.data.serverBaseUrl;
      if (base && base !== '预览模式') {
        els.portalLine.textContent = `服务 · ${base}`;
        els.portalLine.classList.remove('hidden');
      }
    }
  } catch {
    /* 版本号只是展示 */
  }

  wireConvert();

  if (window.api.convert) {
    try {
      const res = await window.api.convert.formats();
      if (res && res.ok) formats = res.data.kinds;
    } catch {
      /* 拿不到格式表就按不支持处理 */
    }
  }

  await restoreRememberedAccount();

  if (window.api.auth.onSessionLost) {
    window.api.auth.onSessionLost(() => {
      showLogin();
      showError('AUTH_SESSION_EXPIRED');
    });
  }

  try {
    const res = await window.api.auth.session();
    if (res && res.ok && res.data) {
      showMain(res.data);
      return;
    }
  } catch {
    /* 读不到会话就按未登录处理 */
  }

  showLogin();
}

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting || Date.now() < lockedUntil) return;

  clearError();
  const username = els.username.value.trim();
  const password = els.password.value;

  if (!username || !password) {
    showError('AUTH_INPUT_EMPTY');
    return;
  }

  setLoading(true);
  try {
    const res = await window.api.auth.login(username, password);
    if (!res || !res.ok) {
      const err = (res && res.error) || {};
      showError(err.code, err.message);

      if (err.code === 'AUTH_LOCKED' || err.locked) {
        lockedUntil = Date.now() + 15 * 60 * 1000;
        els.btnLabel.textContent = '已锁定，请稍后再试';
        setTimeout(() => {
          lockedUntil = 0;
          els.btnLabel.textContent = '登录';
          setLoading(false);
        }, 15 * 60 * 1000);
      }
      setLoading(false);
      return;
    }

    try {
      if (els.remember.checked) localStorage.setItem('fmt.rememberedUser', username);
      else localStorage.removeItem('fmt.rememberedUser');
    } catch {
      /* 忽略 */
    }

    setLoading(false);
    showMain(res.data);
  } catch (err) {
    showError('AUTH_UNAVAILABLE', err && err.message);
    setLoading(false);
  }
});

els.logoutBtn.addEventListener('click', async () => {
  try {
    await window.api.auth.logout();
  } finally {
    showLogin();
  }
});

boot();
