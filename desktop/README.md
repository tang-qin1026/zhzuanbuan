# 桌面端 · 登录模块

本地格式转换工具的桌面客户端。当前完成 **cloud-server 认证 + 静默续期**（实施方案 v1.1 §3）。

## 目录

```
desktop/
├── src/main/
│   ├── index.js               # 主进程：窗口、IPC、会话失效通知
│   ├── config.js              # 配置（服务端地址、续期提前量）
│   └── auth/
│       ├── server-client.js   # 调 cloud-server 的 login / refresh / logout
│       ├── auth-service.js    # 登录、续期、登出、状态机
│       ├── secure-store.js    # DPAPI 加密（失败退化为机器绑定 AES-256-GCM）
│       └── errors.js          # 客户端错误码
├── src/preload/index.js       # contextBridge 白名单
├── src/renderer/              # 登录页 / 登录后首页
├── tools/stub-server.mjs      # 本地桩服务端（HS512 + 轮换 + 限流）
├── tools/auth-smoke.mjs       # 认证链路自测（18 项）
├── tools/validate-ui.mjs      # 静态校验（DOM id / IPC / 安全开关）
├── tools/preview-server.mjs   # 浏览器预览（mock）
└── scripts/run-electron.mjs   # 用内置 Electron 运行时启动
```

## 运行

```
cd desktop
node scripts/run-electron.mjs
```

Electron 运行时已在 `desktop/.electron/`。换机器可 `npm install` 后 `npm run start:npm`。

## 配置

`%APPDATA%\fmt-desktop\config.json`：

```json
{
  "serverBaseUrl": "http://192.168.9.104",
  "refreshSkewMinutes": 5
}
```

环境变量：`FMT_SERVER_BASE_URL`、`FMT_REFRESH_SKEW_MINUTES`。

## 认证流程

```
启动 → 读 %APPDATA%\fmt-desktop\auth.bin（DPAPI 解密）
     ├─ 无/失效 → 登录页
     │            → POST {server}/api/auth/login
     │            → 存 access + refresh（DPAPI）
     │            → 进主界面
     └─ 有 → ensureFresh()
              ├─ access 剩余 >5 分钟 → 直接进（不联网）
              ├─ 临近过期 → POST /api/auth/refresh（轮换）→ 进
              ├─ 服务端不可达 → 用本地凭证进（离线可用）
              └─ 40103 / 40000 / 401 → 清本地 → 回登录页
```

## 关键约定

- token 是 HS512，**客户端不验签**（对称密钥在服务端），只读 `exp`
- token 只存在于主进程与 DPAPI 文件，渲染层拿不到
- 界面显示 `nickname`，绝不显示 `portal_<uuid>` 的 `username`
- 服务端 message 原样展示（含"还可尝试 N 次"这类动态文案）
- 登出会调服务端吊销 jti，失败也清本地
- `mustChangePassword` / `enterpriseSuspended` 为 true 时隐藏工作区

## 自测

```
node tools/auth-smoke.mjs      # 18 项
node tools/validate-ui.mjs     # 静态校验

# 手动联调
node tools/stub-server.mjs --port 4789
set FMT_SERVER_BASE_URL=http://127.0.0.1:4789
node scripts/run-electron.mjs
```

桩服务端账号：

| 账号 | 结果 |
|---|---|
| `demo` / `demo1234` | 登录成功 |
| `shortttl` | access 仅 120 秒，用于验证续期 |
| `mustchange` / `suspended` | 触发阻断态 |
| `disabled` / `busy` / `locked` | 40102 / 50000 / 已锁定 |
| 错误密码 | 40101，累计 3 次后锁定 |

## 已知边界

- 同一账号多端会因 refresh 轮换互相作废（R9），测试期一人一号
- 离线期间账号被停用无法即时感知
- 客户端不可信：只做门禁与身份，不做配额闸门

## 转换（图片 / 音频 / 视频）

当前接入 FFmpeg 引擎，支持 image / audio / video 三类（文档、PDF、OCR 需要 LibreOffice / Poppler / Tesseract，尚未接入）。

引擎定位顺序：

1. 环境变量 `FFMPEG_PATH`
2. `C:\ProgramData\fmt-desktop\engines\ffmpeg\ffmpeg.exe`
3. `C:\ffmpeg\bin\ffmpeg.exe`
4. PATH 里的 `ffmpeg`

> ⚠️ 联调期间临时用了 `E:\flyingmouse-format\bin\ffmpeg\ffmpeg.exe`（飞鼠自带的 8.1.1 full build）。
> 正式发版必须换成我们自己分发的 LGPL 构建，不能复用第三方应用的二进制。

格式矩阵见 `src/main/formats.js`（唯一真相源）。加新格式只改那里。

转换流程：

```
选择文件 → 按文件头识别类别 → 取可用目标格式 → ffmpeg 转换 → 校验产物非空 → 下载
```

失败码：`UNSUPPORTED_KIND` / `UNSUPPORTED_PAIR` / `ENGINE_MISSING` / `CONVERT_FAILED` / `FILE_TOO_LARGE`。

## 引擎（本机已就位）

三套引擎已复制到 `desktop/engines/`，打包时会一起带上（`FormatConverter\engines\`）：

| 引擎 | 版本 / 来源 | 用途 | 体积 |
|---|---|---|---|
| FFmpeg | 8.1.1 full build (gyan.dev) | 图片 / 音频 / 视频 | 216.9 MB |
| LibreOffice | 便携版（独立 profile，并发安全） | 文档 / 表格 / 演示 → PDF | 888.7 MB |
| Poppler | 25.x（pdftoppm） | PDF → PNG / JPG | 104.7 MB |

查找顺序（每个引擎都一样）：

1. 配置里的 `ffmpegPath` / `sofficePath` / `popplerDir`
2. 环境变量 `FFMPEG_PATH` / `SOFFICE_PATH` / `POPPLER_BIN`
3. 程序同级的 `engines\`
4. 开发目录 `desktop\engines\`
5. 系统安装位置（Program Files 等）

> ⚠️ **来源说明**：本机访问不了外网（`https://` 全部 `SEC_E_NO_CREDENTIALS`，只有内网可达），
> 所以这三套是从本机已有的 `E:\flyingmouse-format\bin\` 复制的，**不是从上游下载的**。
> 正式发版必须换成我们自己从官方渠道下载/构建的版本，尤其是：
> - FFmpeg 要 LGPL 构建（不能带 GPL 组件）
> - Poppler 是 GPL-2.0，随包要附源码获取方式
> - LibreOffice 是 MPL-2.0，保留许可文件

OCR（Tesseract）尚未接入：本机只有 `tessdata` 语言包，没有原生 `tesseract.exe`（飞鼠用的是 wasm 版）。
