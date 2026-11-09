# zhzuanbuan · 格式转换器

本地文件格式转换工具。桌面端（Electron）+ 网页版共用同一套界面与认证。

## 功能

- **认证**：对接 cloud-server 登录（HS512 token + refresh 轮换），本地 DPAPI 加密存储，支持静默续期、锁定态、阻断态
- **转换**：图片 / 音频 / 视频（FFmpeg）、Word / Excel / PPT → PDF（LibreOffice）、PDF → 图片（Poppler）、PDF → 文本（pdfjs）、PDF → Word（docengine）、图片 → PDF（pdf-lib）、图片 OCR（tesseract.js）、文本与字幕互转（内置）
- **批量**：多选、拖拽、并发 2、逐条状态、取消、进度百分比
- **网页版**：按浏览器隔离会话，每人用自己的账号登录

## 目录

```
desktop/    桌面端外壳（Electron 主进程 / preload / 渲染层 / 引擎适配）
web/        网页版外壳（本地 Node 服务 + 同源 HTTP 桥）
docs/       实施方案 v1.1、外壳交付说明
```

## 运行

```powershell
cd desktop
node scripts/run-electron.mjs        # 桌面端
```

```powershell
cd web
node server.mjs --server http://192.168.9.104 --port 5185
```

引擎二进制（约 1.5 GB）与 `node_modules` 不在此仓库，需按 `docs/外壳交付说明.md` 第 2 节准备。

## 文档

- [实施方案 v1.1](docs/桌面端格式转换工具-实施方案-v1.1.md)
- [外壳交付说明](docs/外壳交付说明.md)
