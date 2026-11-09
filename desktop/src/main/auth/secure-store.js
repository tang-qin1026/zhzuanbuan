'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { CODES, AuthError } = require('./errors');

/**
 * 本地敏感数据存储。
 *
 * Windows 上优先用 DPAPI（CryptProtectData / CurrentUser 范围），
 * 加密结果与当前 Windows 用户绑定，拷到别的机器/别的用户下解不开。
 *
 * DPAPI 通过 powershell.exe 调用。为避免沙箱/管道限制，
 * 采用「临时文件进、临时文件出」的方式，不走 stdin/stdout。
 *
 * 非 Windows 或 DPAPI 不可用时，退化为 AES-256-GCM + 机器绑定密钥
 * （hostname + 用户名 + 固定盐 scrypt 派生）。安全性弱于 DPAPI，
 * 属于“能用且不明文落盘”的兜底，正式发版前应替换为 win-dpapi 原生绑定。
 */

const PS_PROTECT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$raw   = [IO.File]::ReadAllText($env:FMT_IN)
$bytes = [Convert]::FromBase64String($raw)
$out   = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[IO.File]::WriteAllText($env:FMT_OUT, [Convert]::ToBase64String($out), [Text.Encoding]::ASCII)
`;

const PS_UNPROTECT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$raw   = [IO.File]::ReadAllText($env:FMT_IN)
$bytes = [Convert]::FromBase64String($raw)
$out   = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
[IO.File]::WriteAllText($env:FMT_OUT, [Convert]::ToBase64String($out), [Text.Encoding]::ASCII)
`;

function runPowerShell(script, env) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const exes = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : ['pwsh'];

  for (const exe of exes) {
    const res = spawnSync(
      exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        env: { ...process.env, ...env },
        stdio: 'ignore',
        windowsHide: true,
        timeout: 20000,
      }
    );
    if (res.status === 0) return true;
  }
  return false;
}

function viaDpapi(buffer, mode) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-dpapi-'));
  const inFile = path.join(tmpDir, 'in.txt');
  const outFile = path.join(tmpDir, 'out.txt');
  try {
    fs.writeFileSync(inFile, buffer.toString('base64'), 'ascii');
    const ok = runPowerShell(mode === 'protect' ? PS_PROTECT : PS_UNPROTECT, {
      FMT_IN: inFile,
      FMT_OUT: outFile,
    });
    if (!ok) return null;
    const text = fs.readFileSync(outFile, 'ascii').trim();
    if (!text) return null;
    return Buffer.from(text, 'base64');
  } catch {
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function machineKey() {
  const material = `${os.hostname()}|${os.userInfo().username}|${os.platform()}`;
  return crypto.scryptSync(material, 'fmt-desktop/session/v1', 32);
}

function aesEncrypt(buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', machineKey(), iv);
  const ct = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    mode: 'aes',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ct.toString('base64'),
  };
}

function aesDecrypt(record) {
  const iv = Buffer.from(record.iv, 'base64');
  const tag = Buffer.from(record.tag, 'base64');
  const data = Buffer.from(record.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', machineKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function saveSecret(file, payload) {
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  const protectedBuf = viaDpapi(plain, 'protect');
  const record = protectedBuf
    ? { v: 1, mode: 'dpapi', data: protectedBuf.toString('base64') }
    : aesEncrypt(plain);

  try {
    ensureDir(file);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    throw new AuthError(CODES.AUTH_STORAGE_ERROR, `写入本地登录状态失败: ${err.message}`);
  }
  return record.mode;
}

function loadSecret(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // 不存在 = 未登录
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return null; // 损坏 = 未登录
  }

  let plain;
  if (record.mode === 'dpapi') {
    plain = viaDpapi(Buffer.from(record.data, 'base64'), 'unprotect');
    if (!plain) return null; // 换了机器/用户，解不开
  } else if (record.mode === 'aes') {
    try {
      plain = aesDecrypt(record);
    } catch {
      return null;
    }
  } else {
    return null;
  }

  try {
    return JSON.parse(plain.toString('utf8'));
  } catch {
    return null;
  }
}

function removeSecret(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* 删除失败不影响登出流程 */
  }
}

module.exports = { saveSecret, loadSecret, removeSecret };
