# 部署指南（多平台）

本项目是**单端口 Node 服务**，零依赖、`node server.js` 就能跑。下面 6 套方案任选其一，都能拿到可访问的分享链接。

> 给 AI 看的自动化版本请读 [`AGENTS.md`](AGENTS.md)：里面有「能力探测 → 选方案」的决策树和验收清单。

## 方案总览

| 方案 | 适用场景 | 常驻进程 | 免费 | 分享链接形态 |
|------|----------|:--------:|:----:|--------------|
| **A. 平台发布** | WorkBuddy 等带「发布为应用」能力的 AI/托管平台 | ✅ | 视平台 | 平台生成，可能带 `?sharecode=xxx` |
| **B. Docker** | 任何装了 Docker 的机器 / VPS | ✅ | ✅ | `http://IP:3000` 或反代域名 |
| **C. 裸 Node + 反代** | 自己的 VPS / 云主机，要长期稳定 + HTTPS | ✅ | ✅ | `https://chat.example.com` |
| **D. PaaS 导入** | Render / Railway / Fly.io / Koyeb / Zeabur / Dokku / Heroku | ✅ | 多数有免费额 | `xxx.onrender.com` 等平台域名 |
| **E. 内网穿透** | 本机演示、NAT 后、只要临时链接 | ✅（本机） | ✅ | `xxx.loca.lt` / `xxx.trycloudflare.com` |
| **F. Serverless** | Vercel / Netlify / Cloudflare Workers | ❌ | ✅ | **不兼容，需先改造** |

**通用前提**：Node >= 18；`PORT` 环境变量（默认 3000）；服务绑定 `0.0.0.0`；`public/` 必须和 `server.js` 在同一目录层级。

---

## A. 平台发布（AI 托管 / 应用发布能力）

| 参数 | 值 |
|------|----|
| 语言 | `node` |
| 安装命令 | 留空（零依赖） |
| 启动命令 | `node server.js` |
| 端口 | 平台注入 `PORT` |
| 部署目录 | 仓库根目录 |

WorkBuddy 等价命令：

```bash
node <sites-skill>/scripts/publish.js --dir . --language node \
  --install-cmd "" --start-cmd "node server.js"
```

其他平台（如各类 AI IDE 的 Deploy 按钮、内部 PaaS）填同样的参数即可。取回平台给出的**完整 URL**（含 `?sharecode=` 等全部参数）再分享。

---

## B. Docker / Docker Compose（推荐）

仓库自带 `Dockerfile`、`docker-compose.yml`、`.dockerignore`。

```bash
git clone https://github.com/HDOWS-TM/poll-chatroom.git
cd poll-chatroom

# 方式一：Compose（含健康检查 + 数据卷 + 自动重启）
docker compose up -d --build
docker compose ps
curl -s http://localhost:3000/api/health

# 方式二：单容器
docker build -t poll-chatroom .
docker run -d --name poll-chatroom -p 3000:3000 \
  -v "$(pwd)/data:/app/data" poll-chatroom
```

- 镜像基于 `node:20-alpine`，**不需要 `npm install`**；`VOLUME /app/data` 已挂好，容器重建不丢消息。
- 要换宿主机端口：`ports: - "8080:3000"`（容器内仍监听 3000）。
- 公网：安全组/防火墙放行该端口，访问 `http://<公网IP>:3000/`；要 HTTPS 请再套一层 Caddy / Nginx（见方案 C）。

---

## C. 裸 Node + 反向代理（VPS 长期运行）

### 1. 起服务

```bash
git clone https://github.com/HDOWS-TM/poll-chatroom.git /opt/poll-chatroom
cd /opt/poll-chatroom
PORT=3000 node server.js          # 先前台跑一次确认，Ctrl+C 退出
curl -s http://127.0.0.1:3000/api/health
```

### 2. 用 systemd 守护（崩溃自动重启）

`/etc/systemd/system/poll-chatroom.service`：

```ini
[Unit]
Description=Poll Chatroom
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/poll-chatroom
Environment=PORT=3000
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now poll-chatroom
sudo systemctl status poll-chatroom
```

> 也可用 `pm2 start server.js --name chatroom && pm2 save`。

### 3. 反向代理 + HTTPS

**Caddy（自动申请证书，最省事）** — `Caddyfile`：

```
chat.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**Nginx**：

```nginx
server {
    listen 80;
    server_name chat.example.com;
    client_max_body_size 4m;      # 图片消息最大 3MB，务必放宽

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

再用 `certbot --nginx` 套 HTTPS。最终链接：`https://chat.example.com/`。

---

## D. PaaS 从 GitHub 导入（零命令行）

| 平台 | 操作 | 仓库里已准备的适配文件 |
|------|------|------------------------|
| **Render** | New → **Blueprint** → 连接本仓库 | `render.yaml`（含健康检查 `/api/health`） |
| **Railway / Zeabur / Koyeb / Northflank** | New Project → Deploy from GitHub | `package.json` 的 `start` 脚本 |
| **Fly.io** | `fly launch`；再 `fly volumes create data` 挂载 `/app/data` | `Dockerfile` |
| **Heroku / Dokku / CapRover / Coolify** | 连接仓库 / `git push` 部署 | `Procfile` |

注意：

- `PORT` 由平台自动注入，**不要写死 3000**（代码已读 `process.env.PORT`）。
- 必须**单实例**：不要开多副本 / autoscaling，否则各实例内存不共享，会互相看不到消息。
- 免费实例通常闲置休眠，首次打开有几秒~几十秒冷启动；休眠时内存态的在线列表会清空，但落盘的历史消息不丢（前提是挂了持久卷 / 平台不清空文件系统）。
- 若平台每次部署都重置文件系统（多数 Serverless 型 PaaS 如此），历史消息会丢——需要外置存储，见方案 F。

---

## E. 内网穿透（本机临时分享）

```bash
git clone https://github.com/HDOWS-TM/poll-chatroom.git && cd poll-chatroom
PORT=3000 node server.js &

npx localtunnel --port 3000
# 或：cloudflared tunnel --url http://localhost:3000
# 或：ngrok http 3000
```

把输出的 `https://xxxx.loca.lt`、`https://xxxx.trycloudflare.com` 直接发给别人即可，无需服务器。
局限：本机一关链接就失效；localtunnel 首次访问可能要输一个验证密码；不适合长期使用。

> 不想在本机开终端？Fork 仓库后到 **Actions** 页手动运行 **Node.js CI**，工作流会自动拉起服务、建立临时隧道，并把公网地址输出在本次运行的 Summary 里。步骤见 [README](README.md) 的「Fork 后用 GitHub Actions 跑起来」。性质与本节相同：runner 是一次性虚拟机，job 结束链接即失效。

---

## F. Serverless（不兼容，需改造）

Vercel / Netlify / Cloudflare Workers / 各类云函数**不能直接跑本项目**：

| 冲突点 | 原因 |
|--------|------|
| 消息/在线用户在**进程内存** | 每次请求可能落在不同实例，A 发的消息 B 轮询不到 |
| `data/messages.json` 落盘 | 函数环境文件系统只读或临时，写入即丢 |
| 常驻监听端口 | 函数平台没有长期运行的 `listen()` |

若必须上 Serverless，改造方向：

1. 把 `messages` / `users` / `roomTyping` 迁到共享存储（Redis、PostgreSQL、Supabase、Upstash、Durable Objects 等）；
2. `server.js` 的读写改为访问共享存储，去掉本地文件存档；
3. 或整体改成 WebSocket + 实时数据库架构；
4. 之后按平台规范把每个 `/api/*` 暴露成函数，前端 `public/` 作为静态资源托管。

改造超出本项目范围，**请勿原样部署后声称可用**；建议改用 B / C / D。

---

## 验证与常见问题

```bash
curl -s <URL>/api/health                 # {"ok":true,...}
curl -s -o /dev/null -w "%{http_code}" <URL>/          # 200
curl -s -o /dev/null -w "%{http_code}" <URL>/app.js    # 200
curl -s -o /dev/null -w "%{http_code}" <URL>/style.css # 200
```

| 现象 | 原因 / 处理 |
|------|-------------|
| 页面 200 但 `app.js` 404 | `public/` 没随代码部署，或工作目录不对（必须在仓库根启动） |
| 图片发不出去 | 反代请求体限制太小，Nginx 设 `client_max_body_size 4m;` |
| 别人发的消息看不到 | 开了多实例 / 多副本，状态不共享 → 缩回单实例 |
| 重启后历史没了 | 文件系统被平台重置 → 挂持久卷，或外置数据库 |
| 首次打开很慢 | 免费实例休眠冷启动，等几秒刷新即可 |
| 端口不通 | 检查 `PORT` 是否注入、是否绑定 `0.0.0.0`、防火墙/安全组 |

## 安全提示

- **无账号、无鉴权**：拿到链接的人都能读写所有房间消息，请勿用于敏感内容。
- 链接本身若带 `sharecode` 之类的网关参数，等同于访问凭据，按敏感信息处理。
- 建议前置一层访问控制（Basic Auth、IP 白名单、网关鉴权）再对公网开放。

完整 HTTP 接口见 [`API.md`](API.md)。
