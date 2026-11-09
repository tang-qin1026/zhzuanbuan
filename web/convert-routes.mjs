/**
 * 网页版的转换接口。
 *
 *   GET  /api/formats            → 支持的类别与目标格式
 *   POST /api/convert?target=xx  → 请求体是文件字节，响应体是转换结果
 *                                 文件名放在 x-filename（URL 编码），结果名放在 x-out-name
 *
 * 用裸字节而不是 multipart：省掉手写边界解析，也少一层依赖。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..', 'desktop');
const { probe, convertBuffer, ConvertError } = require(path.join(desktopRoot, 'src', 'main', 'converter.js'));
const { KINDS, ENABLED_KINDS } = require(path.join(desktopRoot, 'src', 'main', 'formats.js'));
const { engineAvailability } = require(path.join(desktopRoot, 'src', 'main', 'engines'));

const MAX_BYTES = 200 * 1024 * 1024;

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

export async function handleFormats(res) {
  const availability = engineAvailability({});
  const kinds = ENABLED_KINDS.map((kind) => ({
    kind,
    label: KINDS[kind].label,
    exts: KINDS[kind].exts,
    targets: KINDS[kind].targets,
    experimental: KINDS[kind].experimental || [],
    unsupported: KINDS[kind].unsupported || {},
    engine: KINDS[kind].engine,
    available: Boolean(availability[KINDS[kind].engine]),
  }));
  sendJson(res, 200, { ok: true, data: { kinds } });
}

export async function handleConvert(req, res, url) {
  const target = String(url.searchParams.get('target') || '').toLowerCase();
  const rawName = req.headers['x-filename'] || '';
  const filename = decodeURIComponent(String(rawName)) || `input.${target}`;

  try {
    const buffer = await readRaw(req);
    if (!buffer.length) throw new ConvertError('EMPTY_BODY', '没有收到文件内容');

    const info = probe({ buffer, filename });
    const result = await convertBuffer({ buffer, filename, target });

    res.writeHead(200, {
      'content-type': result.mime,
      'content-length': result.bytes,
      'x-out-name': encodeURIComponent(result.filename),
      'x-in-kind': info.kind,
      'cache-control': 'no-store',
    });
    res.end(result.buffer);
  } catch (err) {
    const code = err && err.code ? err.code : 'CONVERT_FAILED';
    console.log(`[convert] ${filename} → ${target} 失败: ${code} ${err.message}`);
    sendJson(res, 200, { ok: false, error: { code, message: err.message } });
  }
}
