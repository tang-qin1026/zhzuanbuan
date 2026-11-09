# 网页版前端（cloud-server 认证）

浏览器通过本地 Node 服务登录 **cloud-server**。与桌面端共用同一套 UI 和同一套认证实现：

```
浏览器  ──HTTP──▶  本地 Node 服务  ──HTTP──▶  cloud-server
                         │                    /api/auth/login
                         └─ 存 token、静默续期（token 不回传页面）
```

这样做的原因：

- 浏览器直连 cloud-server 会被 CORS 拦；由服务端代理没有这个问题
- accessToken / refreshToken 全程留在服务端，页面里拿不到
- 换机器只要一个 Node，不用装 Electron

## 启动

```
cd web
node server.mjs --server http://192.168.9.104 --port 5180
```

或双击 `start-web.cmd`。

启动后打印本机与局域网地址：

```
本机访问   http://127.0.0.1:5180
局域网     http://192.168.x.x:5180
```

浏览器打开，用平台真实账号登录。

## 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--server` | `http://192.168.9.104` | cloud-server 地址 |
| `--port` | `5180` | 监听端口 |
| `--host` | `0.0.0.0` | 监听地址，`127.0.0.1` 仅本机 |
| `--skew` | `5` | access 剩余多少分钟开始续期 |

环境变量：`SERVER_BASE_URL`、`PORT`、`REFRESH_SKEW_MINUTES`。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | `{username, password}` → 会话（不含 token） |
| GET | `/api/session` | 读本地凭证，必要时静默续期 |
| GET | `/api/status` | `authenticated` / `need-login` |
| POST | `/api/logout` | 吊销并清空 |
| GET | `/api/info` | 服务端地址、版本、数据目录 |

失败统一返回 `{ok:false, error:{code, message}}`，`message` 是服务端原文（含"还可尝试 N 次"这类动态文案）。

## 联调

```
# 窗口 1
cd desktop
node tools\stub-server.mjs --port 4789

# 窗口 2
cd web
node server.mjs --server http://127.0.0.1:4789 --port 5180
```

账号：`demo` / `demo1234`。

## 数据

- 凭证：`web/.data/auth.bin`（DPAPI 加密）
- 删掉 `.data` 即可重置登录状态

## 注意

- **没有 HTTPS**，只适合内网联调（R10 上线阻断项）
- 服务端是单用户设计，多人共用会看到同一份凭证
- 服务端不可达时提示"服务暂不可用"，不会误报成密码错误
