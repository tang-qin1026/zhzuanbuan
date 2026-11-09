'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { kindOf, targetsFor, sniff, isEnabled, extOf, resolveKind, KINDS } = require('./formats');
const { convertByEngine } = require('./engines');

/**
 * 转换编排（内存版，网页版用）。
 * 桌面端走 convert-path.js。
 */

class ConvertError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConvertError';
    this.code = code;
  }
}

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  srt: 'text/plain; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
  ass: 'text/plain; charset=utf-8',
  ssa: 'text/plain; charset=utf-8',
};

function mimeOf(ext) {
  return MIME[String(ext).toLowerCase()] || 'application/octet-stream';
}

/** 识别：优先文件头，其次扩展名 */
function probe({ buffer, filename }) {
  const byMagic = buffer ? sniff(buffer) : 'unknown';
  const byExt = kindOf(filename);
  const kind = byMagic !== 'unknown' ? byMagic : byExt;

  return {
    filename,
    ext: extOf(filename),
    kind,
    size: buffer ? buffer.length : 0,
    supported: isEnabled(kind),
    targets: targetsFor(filename),
  };
}

function scratchDir() {
  // 引擎（尤其 Poppler）对非 ASCII 路径敏感，临时目录要保持纯 ASCII
  const base = path.join(os.tmpdir(), 'fmt-scratch');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

/**
 * 转换内存中的文件（网页版用）。
 */
async function convertBuffer({ buffer, filename, target, configured = {}, onProgress }) {
  const info = probe({ buffer, filename });
  // 同扩展名多类别时，以目标格式反查引擎
  info.kind = resolveKind(filename, target);
  info.targets = (KINDS[info.kind] && KINDS[info.kind].targets) || [];

  if (!info.supported) {
    throw new ConvertError('UNSUPPORTED_KIND', '暂不支持该类型的转换（引擎未安装）');
  }
  if (!info.targets.includes(target)) {
    throw new ConvertError('UNSUPPORTED_PAIR', `不支持 ${info.ext || info.kind} → ${target}`);
  }

  const dir = fs.mkdtempSync(path.join(scratchDir(), 'job-'));
  const inputPath = path.join(dir, `input.${info.ext || 'bin'}`);
  const outputPath = path.join(dir, `output.${target}`);

  try {
    fs.writeFileSync(inputPath, buffer);

    let result;
    try {
      result = await convertByEngine({
        kind: info.kind,
        target,
        input: inputPath,
        output: outputPath,
        outputDir: dir,
        configured,
        onProgress,
      });
    } catch (err) {
      if (err.code === 'ENGINE_MISSING' || err.code === 'UNSUPPORTED_PAIR') {
        throw new ConvertError(err.code, err.message);
      }
      throw new ConvertError('CONVERT_FAILED', err.message);
    }

    if (typeof onProgress === 'function') onProgress(100);

    const out = fs.readFileSync(result.output);
    return {
      buffer: out,
      filename: `${path.basename(filename, path.extname(filename))}.${target}`,
      mime: mimeOf(target),
      bytes: out.length,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { probe, convertBuffer, ConvertError, mimeOf, scratchDir };
