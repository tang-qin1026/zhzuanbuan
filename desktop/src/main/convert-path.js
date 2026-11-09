'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { kindOf, targetsFor, isEnabled, extOf, KINDS, ENABLED_KINDS, resolveKind } = require('./formats');
const { convertByEngine, engineAvailability } = require('./engines');

/**
 * 桌面端的转换编排（按文件路径，不经过内存拷贝）。
 */

class ConvertError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConvertError';
    this.code = code;
  }
}

function formatsPayload(configured = {}) {
  const availability = engineAvailability(configured);
  return {
    kinds: ENABLED_KINDS.map((kind) => ({
      kind,
      label: KINDS[kind].label,
      exts: KINDS[kind].exts,
      targets: KINDS[kind].targets,
      experimental: KINDS[kind].experimental || [],
      unsupported: KINDS[kind].unsupported || {},
      engine: KINDS[kind].engine,
      available: Boolean(availability[KINDS[kind].engine]),
    })),
    engines: availability,
  };
}

/** 输出路径：同目录、同主名、换扩展名，重名自动加 (1)(2)… */
function outputPathFor(inputPath, target) {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  let candidate = path.join(dir, `${base}.${target}`);
  let i = 1;
  while (fs.existsSync(candidate) && path.resolve(candidate) !== path.resolve(inputPath)) {
    candidate = path.join(dir, `${base} (${i}).${target}`);
    i += 1;
    if (i > 50) throw new ConvertError('OUTPUT_NOT_WRITABLE', '同目录下重名文件过多');
  }
  return candidate;
}

async function convertPath({ inputPath, target, configured = {}, onProgress }) {
  let stat;
  try {
    stat = fs.statSync(inputPath);
  } catch {
    throw new ConvertError('INPUT_NOT_FOUND', '找不到输入文件');
  }
  if (!stat.isFile()) throw new ConvertError('INPUT_NOT_FOUND', '请选择文件而不是文件夹');

  const ext = extOf(inputPath);
  const kind = resolveKind(inputPath, target);
  if (!isEnabled(kind)) {
    throw new ConvertError('UNSUPPORTED_KIND', `暂不支持 ${ext || '该'} 类型的转换（引擎未安装）`);
  }
  const allowed = (KINDS[kind] && KINDS[kind].targets) || [];
  if (!allowed.includes(target)) {
    throw new ConvertError('UNSUPPORTED_PAIR', `不支持 ${ext} → ${target}`);
  }

  const output = outputPathFor(inputPath, target);

  let result;
  try {
    result = await convertByEngine({
      kind,
      target,
      input: inputPath,
      output,
      outputDir: path.dirname(inputPath),
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

  return {
    path: result.output,
    filename: path.basename(result.output),
    bytes: result.bytes,
    engine: result.engine,
  };
}

module.exports = { formatsPayload, convertPath, ConvertError, outputPathFor };
