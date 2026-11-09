/**
 * 网页版的「任务」模型：上传 → 后台转换 → 轮询进度 → 取结果。
 *
 * 原来的请求-响应模型没有进度可看（浏览器只能等），所以拆成三步：
 *   POST /api/jobs            上传，返回 jobId
 *   GET  /api/jobs/:id        查状态与百分比
 *   GET  /api/jobs/:id/result 取转换结果
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..', 'desktop');
const { convertBuffer, ConvertError } = require(path.join(desktopRoot, 'src', 'main', 'converter.js'));

const MAX_BYTES = 200 * 1024 * 1024;
const JOB_TTL_MS = 10 * 60 * 1000;

/** jobId → {status, pct, filename, mime, buffer?, error?, createdAt} */
const jobs = new Map();

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        reject(new ConvertError('FILE_TOO_LARGE', '文件超过 200 MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}
setInterval(sweep, 60 * 1000).unref?.();

export async function handleCreateJob(req, res, url) {
  const target = String(url.searchParams.get('target') || '').toLowerCase();
  const jobId = String(req.headers['x-job-id'] || '').trim();
  const filename = decodeURIComponent(String(req.headers['x-filename'] || '')) || `input.${target}`;

  if (!jobId) return sendJson(res, 200, { ok: false, error: { code: 'BAD_JOB_ID', message: '缺少 x-job-id' } });

  let buffer;
  try {
    buffer = await readRaw(req);
    if (!buffer.length) throw new ConvertError('EMPTY_BODY', '没有收到文件内容');
  } catch (err) {
    return sendJson(res, 200, { ok: false, error: { code: err.code || 'UPLOAD_FAILED', message: err.message } });
  }

  jobs.set(jobId, { status: 'running', pct: 0, filename, target, createdAt: Date.now() });

  // 后台跑，立即返回
  convertBuffer({
    buffer,
    filename,
    target,
    onProgress: (pct) => {
      const job = jobs.get(jobId);
      if (job) job.pct = pct;
    },
  })
    .then((result) => {
      const job = jobs.get(jobId);
      if (!job) return;
      Object.assign(job, {
        status: 'done',
        pct: 100,
        buffer: result.buffer,
        filename: result.filename,
        mime: result.mime,
        bytes: result.bytes,
      });
    })
    .catch((err) => {
      const job = jobs.get(jobId);
      if (!job) return;
      job.status = 'error';
      job.error = { code: err.code || 'CONVERT_FAILED', message: err.message };
      console.log(`[job ${jobId}] ${filename} → ${target} 失败: ${job.error.code} ${err.message}`);
    });

  return sendJson(res, 200, { ok: true, data: { jobId } });
}

export function handleJobStatus(res, jobId) {
  const job = jobs.get(jobId);
  if (!job) return sendJson(res, 200, { ok: false, error: { code: 'JOB_NOT_FOUND', message: '任务不存在或已过期' } });
  return sendJson(res, 200, {
    ok: true,
    data: {
      status: job.status,
      pct: job.pct,
      filename: job.filename,
      bytes: job.bytes || 0,
      error: job.error || null,
    },
  });
}

export function handleJobResult(res, jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'done' || !job.buffer) {
    return sendJson(res, 404, { ok: false, error: { code: 'JOB_NOT_READY', message: '任务尚未完成' } });
  }
  res.writeHead(200, {
    'content-type': job.mime,
    'content-length': job.buffer.length,
    'x-out-name': encodeURIComponent(job.filename),
    'cache-control': 'no-store',
  });
  res.end(job.buffer);
}
