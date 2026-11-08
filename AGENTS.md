# AGENTS.md — 给 AI Agent 的部署契约

> 本文件是给自动化 Agent（以及任何 AI 编程助手）读的**执行契约**。
> 目标：把本仓库部署成一个公网可访问的在线聊天室，并把**完整的分享链接**交回用户。
> 不要假设用户用的是某个特定平台或某个特定 AI 工具。

## 1. 项目事实（不要猜测，按此执行）

| 项 | 值 |
|----|----|
| 形态 | 单端口 Node.js HTTP 服务 + 自带前端页面（**不是静态站点**） |
| 依赖 | **零第三方依赖**，只用 Node 内置模块；Node >= 18 |
| 入口 | `server.js`，`npm start` = `node server.js` |
| 静态文件 | `public/`（必须随代码一起部署） |
| 端口 | 读 `process.env.PORT`，默认 `3000`，绑定 `0.0.0.0` |
| 健康检查 | `GET /api/health` → `200 {"ok":true,...}` |
| 数据 | 运行时写入 `data/messages.json`（仓库中**不含**此目录，`.gitignore` 已排除） |
| 状态 | **有状态**：消息/在线用户/房间都在进程内存 + 本地文件 |
| 鉴权 | 无账号、无鉴权，拿到 URL 即可读写 |
| 页面 | `/` 聊天室（静态资源在 `public/`） |

**最重要的约束**：因为状态在**单进程内存**里，所以必须**单实例常驻运行**。
- 不要开多副本 / 自动扩容 / 多 worker（各实例内存不共享，会互相看不到消息）。
- 纯函数型 Serverless（Vercel / Netlify / Cloudflare Workers）**不能原样部署**，见方案 F。

## 2. 先探测能力，再选方案（从上到下，第一个满足就执行）

| 探测到的能力 | 用哪个方案 |
|--------------|-----------|
| 环境提供「发布为应用 / 托管应用 / 生成分享链接」能力（WorkBuddy 等 AI 平台） | **A. 平台发布** |
| 有 `docker`（或 `docker compose`） | **B. Docker**（最稳，已实测） |
| 有 shell + 可开放公网端口的 VPS / 云主机 / 容器 | **C. 裸 Node + 反向代理** |
| 平台支持「从 GitHub 导入常驻 Web Service」（Render / Railway / Fly.io / Koyeb / Zeabur / Northflank / Dokku / Heroku / CapRover） | **D. PaaS 导入** |
| 只有本机、在 NAT 后、只需要一个临时分享链接 | **E. 内网穿透** |
| 只有 Serverless 函数平台（Vercel / Netlify / CF Workers / 云函数） | **F. 需改造，禁止原样部署后声称可用** |

> 若同时满足多个，优先级：A > B > D > C > E。
> 人类的完整图文步骤见 [`DEPLOY.md`](DEPLOY.md)，可直接引用其中的命令。

## 3. 各方案的确切执行命令

### A. 平台发布（有应用托管能力时）

参数是固定的，照填即可：

| 参数 | 值 |
|------|----|
| 语言 / runtime | `node` |
| 安装命令 | **空**（零依赖，不要跑 `npm install` 也行；跑了也不报错） |
| 启动命令 | `node server.js`（或 `npm start`） |
| 端口 | 由平台注入 `PORT`，代码自动读取 |
| 目录 | 仓库根目录（含 `server.js` 与 `public/`） |

若环境是 WorkBuddy，等价命令：

```bash
node <sites-skill>/scripts/publish.js --dir <repo-dir> --language node \
  --install-cmd "" --start-cmd "node server.js"
```

其他平台请调用其等价能力（Deploy / Publish / Create Web Service）。
**务必取回平台生成的完整公开 URL，包含所有必需的查询参数**（例如 `?sharecode=xxxx`），不要截断。

### B. Docker（推荐，跨平台最稳）

```bash
git clone https://github.com/HDOWS-TM/poll-chatroom.git
cd poll-chatroom
docker compose up -d --build
curl -s http://localhost:3000/api/health
```

等价的单容器方式：

```bash
docker build -t poll-chatroom .
docker run -d --name poll-chatroom -p 3000:3000 -v "$(pwd)/data:/app/data" poll-chatroom
```

公网访问：开放 3000 端口得到 `http://<IP>:3000/`，或用 Caddy / Nginx 反代 + HTTPS。
`data/` 已挂 volume，重启容器不丢消息。

### C. 裸 Node + 反向代理（VPS / 云主机）

```bash
git clone https://github.com/HDOWS-TM/poll-chatroom.git
cd poll-chatroom
PORT=3000 node server.js          # 前台验证；生产用 systemd / pm2 / supervisor 守护
curl -s http://127.0.0.1:3000/api/health
```

- 用 systemd / pm2 保证崩溃自动重启；反代模板（Caddy / Nginx）见 `DEPLOY.md`。
- 反代务必允许 **≥ 3MB** 请求体（图片消息 base64），Nginx 需 `client_max_body_size 4m;`。
- 最终链接形如 `https://chat.example.com/`。

### D. PaaS 从 GitHub 导入

| 平台 | 做法 |
|------|------|
| Render | 仓库根已带 `render.yaml`，New → **Blueprint** → 连接仓库即自动创建；健康检查 `/api/health` |
| Railway / Zeabur / Koyeb / Northflank | New Project → Deploy from GitHub → 自动识别 `package.json` 的 `start`；无需构建命令 |
| Fly.io | `fly launch` 生成 `fly.toml`；需常驻进程，并 `fly volumes create` 挂载 `data/` 才能持久化 |
| Heroku / Dokku / CapRover / Coolify | 仓库根已带 `Procfile`（`web: node server.js`），`git push` 即部署 |

`PORT` 由这些平台自动注入，**不要硬编码 3000**。免费实例通常会休眠，首次访问有几秒~几十秒冷启动，属正常。

### E. 内网穿透（本机临时分享链接）

```bash
git clone https://github.com/HDOWS-TM/poll-chatroom.git && cd poll-chatroom
PORT=3000 node server.js &
npx localtunnel --port 3000
# 或：cloudflared tunnel --url http://localhost:3000
# 或：ngrok http 3000
```

把输出的 `https://xxxx.loca.lt` / `https://xxxx.trycloudflare.com` 原样作为分享链接。
仅适合演示：本机一关、链接即失效；`data/` 仍在本机。

### F. Serverless —— 不要原样部署

本项目是**常驻单进程 + 内存状态 + 本地文件存档**，而 Serverless 每次请求可能是不同实例、文件系统只读或临时。原样部署的后果：轮询读不到别人发的消息、`data/` 写入丢失、在线列表永远为空。

若必须用 Serverless，需要**先改造**：
1. 把 `messages` / `users` / `roomTyping` 外置到共享存储（Redis / PostgreSQL / Supabase / Upstash 等）；
2. 把 `server.js` 里的读写改成走共享存储；
3. 或者改用 WebSocket + 实时数据库架构。

**严禁**跳过改造就直接部署并告诉用户"已完成"。若无法改造，请明确告知用户该平台不兼容，并建议改用 B / C / D。

## 4. 验收清单（部署后逐项执行，缺一不可）

- [ ] `GET <URL>/api/health` 返回 `200` 且 body 含 `"ok":true`
- [ ] `GET <URL>/` 返回 `200`，聊天室页面能打开
- [ ] `GET <URL>/app.js`、`GET <URL>/style.css` 返回 `200`（确认 `public/` 没漏）
- [ ] 可选：`POST /api/join` → `/api/send` → `/api/poll` 在独立测试房间走通
- [ ] **把完整 URL 原样返回用户**，含全部必需查询参数，不要省略 `?sharecode=...` 之类
- [ ] 说明采用了哪个方案、数据是否持久化、是否会休眠/冷启动

## 5. 硬性约束

1. 不修改业务逻辑，不删 `public/`，不改动 `server.js` 的接口语义。
2. **绝不**把 `data/`（真实聊天记录）提交进仓库或 echo 到日志/回复。
3. **绝不**在仓库文件、提交信息、日志或回复中写入任何密钥 / Token；部署凭据只用环境变量临时注入。
4. 单实例运行，不开多副本、不开 cluster。
5. 如实说明：无鉴权、链接拿到即可读写，勿放敏感内容；免费/休眠平台不承诺"永久在线"。

## 6. 完成后按此格式输出

| 项 | 值 |
|----|----|
| 分享链接 | `<完整 URL，含全部参数>` |
| 采用方案 | A / B / C / D / E / F |
| 健康检查 | `ok:true` |
| 数据持久化 | 落盘 / 仅内存 / 可能被回收 |
| 休眠与冷启动 | 说明 |
