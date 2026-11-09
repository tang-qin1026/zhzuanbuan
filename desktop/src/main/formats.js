'use strict';

/**
 * 格式矩阵：全项目唯一的「什么能转什么」的真相源。
 * 参照飞鼠格式的能力表整理，UI、校验、诊断都从这里取。
 *
 * 每个类别声明：
 *   exts           支持的输入扩展名
 *   targets        声明的输出格式
 *   experimental   实验性输入（能转但不保证）
 *   unsupported    明确不支持的输出 → 原因（UI 置灰并说明）
 *   engine         负责的引擎
 */

const KINDS = {
  image: {
    label: '图片',
    engine: 'ffmpeg',
    exts: [
      'ai', 'avif', 'bmp', 'gif', 'heic', 'heif', 'ico', 'j2k', 'jfif', 'jp2', 'jpe', 'jpeg',
      'jpg', 'jxl', 'png', 'ppm', 'psd', 'qoi', 'svg', 'tga', 'tif', 'tiff', 'webp',
    ],
    targets: ['png', 'jpg', 'webp', 'gif', 'avif', 'tiff', 'ico', 'bmp', 'tga', 'jp2', 'ppm', 'pdf', 'txt'],
    experimental: ['ai', 'heic', 'heif', 'j2k', 'jp2', 'jxl', 'ppm', 'psd', 'qoi', 'tga'],
    unsupported: {},
  },
  text: {
    label: '文本',
    engine: 'text',
    exts: ['csv', 'epub', 'htm', 'html', 'json', 'log', 'markdown', 'md', 'mobi', 'txt', 'xml', 'yaml', 'yml'],
    targets: ['txt', 'md', 'html', 'json', 'csv', 'docx', 'epub'],
    unsupported: {
      docx: '需要 Word 引擎（未接入）',
      epub: '需要电子书引擎（未接入）',
    },
  },
  subtitle: {
    label: '字幕',
    engine: 'subtitle',
    exts: ['srt', 'vtt', 'ass', 'ssa'],
    targets: ['srt', 'vtt', 'ass', 'ssa', 'txt'],
  },
  document: {
    label: 'Word 文档',
    engine: 'libreoffice',
    exts: ['doc', 'docx', 'odt', 'odf', 'rtf', 'wpd', 'wps', 'wpt'],
    targets: ['pdf', 'docx', 'odt', 'rtf', 'txt', 'html', 'md'],
    experimental: ['wpd', 'wps', 'wpt'],
    unsupported: {
      md: 'LibreOffice 不直接产出 Markdown',
    },
  },
  spreadsheet: {
    label: 'Excel 表格',
    engine: 'libreoffice',
    exts: ['csv', 'et', 'ett', 'ods', 'tsv', 'xls', 'xlsm', 'xlsx'],
    targets: ['pdf', 'xlsx', 'xls', 'ods', 'csv', 'html'],
    experimental: ['et', 'ett'],
  },
  presentation: {
    label: 'PPT 演示',
    engine: 'libreoffice',
    exts: ['dps', 'dpt', 'odp', 'ppt', 'pptx'],
    targets: ['pdf', 'pptx', 'odp', 'html', 'png', 'jpg'],
    experimental: ['dps', 'dpt'],
  },
  pdf: {
    label: 'PDF',
    engine: 'poppler',
    exts: ['pdf'],
    targets: ['png', 'jpg', 'txt', 'html', 'docx', 'xlsx', 'md'],
    unsupported: {
      html: '需要 LibreOffice HTML 导出，链路上未接',
      xlsx: '表格重建质量不稳定，暂不提供',
      md: 'Markdown 不适用',
    },
  },
  audio: {
    label: '音频',
    engine: 'ffmpeg',
    exts: ['aac', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav', 'wma'],
    targets: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'opus', 'wma'],
  },
  video: {
    label: '视频',
    engine: 'ffmpeg',
    exts: ['avi', 'flv', 'm2ts', 'm4s', 'm4v', 'mkv', 'mov', 'mp4', 'mst', 'mts', 'ts', 'webm', 'wmv'],
    targets: ['mp4', 'webm', 'mkv', 'mov', 'gif', 'mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'opus', 'wma'],
  },
};

const EXT_TO_KIND = (() => {
  const map = {};
  for (const [kind, def] of Object.entries(KINDS)) {
    for (const ext of def.exts) map[ext] = kind;
  }
  return map;
})();

const ENABLED_KINDS = Object.keys(KINDS);

function extOf(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : '';
}

function kindOf(filename) {
  return EXT_TO_KIND[extOf(filename)] || 'unknown';
}

/** 可选目标（排除源格式本身；已被标记不支持的仍然返回，由 UI 置灰） */
function targetsFor(filename) {
  const kind = kindOf(filename);
  const def = KINDS[kind];
  if (!def) return [];
  return def.targets.filter((t) => t !== extOf(filename));
}

/**
 * 同一扩展名可能同时属于多个类别（csv 既是文本也是表格）。
 * 先按默认类别判断，目标不在其能力里时，再找能覆盖该目标的类别。
 */
function resolveKind(filename, target) {
  const ext = extOf(filename);
  const primary = EXT_TO_KIND[ext] || 'unknown';
  if (target && KINDS[primary] && KINDS[primary].targets.includes(target)) return primary;

  for (const [kind, def] of Object.entries(KINDS)) {
    if (!def.exts.includes(ext)) continue;
    if (!target || def.targets.includes(target)) return kind;
  }
  return primary;
}

function isEnabled(kind) {
  return ENABLED_KINDS.includes(kind);
}

/** 按文件头识别（扩展名可以骗人） */
function sniff(buffer) {
  if (!buffer || buffer.length < 12) return 'unknown';
  const b = buffer;

  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image';
  if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) return 'image';
  if (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a) return 'image';
  if (b.toString('ascii', 0, 4) === 'RIFF') {
    const sub = b.toString('ascii', 8, 12);
    if (sub === 'WEBP') return 'image';
    if (sub === 'WAVE') return 'audio';
    if (sub === 'AVI ') return 'video';
  }
  if (b.toString('ascii', 4, 8) === 'ftyp') return 'video';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio';
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'audio';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'video';
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2) return 'video'; // asf/wmv

  return 'unknown';
}

/** 该类别能否用纯文本方式处理 */
const TEXT_KINDS = new Set(['text', 'subtitle']);

function isTextKind(kind) {
  return TEXT_KINDS.has(kind);
}

module.exports = {
  KINDS,
  ENABLED_KINDS,
  EXT_TO_KIND,
  extOf,
  kindOf,
  targetsFor,
  sniff,
  isEnabled,
  isTextKind,
  resolveKind,
};
