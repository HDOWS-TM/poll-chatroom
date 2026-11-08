# 轮询聊天室（Poll Chatroom）

一个**轻量多人聊天室**：不用 WebSocket，靠 HTTP 轮询同步消息，延迟 **0.5~2.5 秒**（每次随机抖动，避免所有人同时请求）。单端口 Node 服务、**零第三方依赖**、Node >= 18。

> 开源仓库：<https://github.com/HDOWS-TM/poll-chatroom> · MIT 许可证
>
> **想让 AI 帮你自动部署？** 把 [`ONE_CLICK_PROMPT.md`](ONE_CLICK_PROMPT.md) 里的提示词整段复制给任意 AI 助手（WorkBuddy / Cursor / Claude Code / Copilot 等）即可，它不依赖特定平台。

## 部署

| 文档 | 内容 |
|------|------|
| [`DEPLOY.md`](DEPLOY.md) | **6 套部署方案**：平台发布、Docker、VPS + 反代、PaaS 导入、内网穿透、Serverless 兼容性 |
| [`AGENTS.md`](AGENTS.md) | 给 AI 读的部署契约：能力探测 → 选方案 → 执行命令 → 验收清单 |
| [`ONE_CLICK_PROMPT.md`](ONE_CLICK_PROMPT.md) | 可直接复制的一键部署提示词（含锁定指定方案的变体） |
| [`API.md`](API.md) | 完整 HTTP API 文档 |

## 运行

```bash
node server.js                 # 默认 3000
PORT=8080 node server.js       # 指定端口
docker compose up -d --build   # 或 Docker
```

打开 `http://localhost:3000`。服务读取 `PORT` 环境变量并绑定 `0.0.0.0`，可直接发布为在线应用。

## 功能（进阶版）

- 多人实时群聊、昵称、彩色头像、在线人数与在线列表
- **多房间**：侧栏切换、新建房间，房间人数实时更新
- **表情**：表情面板一键发送大表情；输入框也可直接输入 emoji
- **图片消息**：前端 canvas 自动压缩（最长边 1280px、JPEG 0.72）后发送，点击可放大
- **历史消息**：每个房间保留最近 2000 条，顶部可"加载更早"；消息持久化到 `data/messages.json`，重启不丢
- **正在输入**提示
- **断线重连**：轮询失败显示状态，恢复后自动继续
- 乐观上屏（自己发的消息立即显示，靠 `clientId` 去重）
- 亮 / 暗主题自适应、移动端适配

## 架构

```
浏览器 ──(每 0.5~2.5s)──> GET /api/poll?since=游标 ──> 增量消息 / 在线 / 正在输入
       ──(发消息)──────> POST /api/send ──────────────> 服务端内存 + 文件存档
```

| API | 方法 | 说明 |
|-----|------|------|
| `/api/join` | POST | 加入房间，返回历史消息、在线列表、房间列表、游标 |
| `/api/room` | POST | 切换 / 新建房间 |
| `/api/poll` | GET | 增量拉取（同时作为在线心跳） |
| `/api/send` | POST | 发送消息（text / image / sticker） |
| `/api/typing` | POST | 上报"正在输入" |
| `/api/history` | GET | 加载更早的历史消息 |
| `/api/rooms` | GET | 房间列表 |
| `/api/health` | GET | 健康检查（含服务端真实边界 `limits`） |

在线判定：9 秒无心跳自动离线；`正在输入` 3.5 秒过期。

> ⚠️ 状态保存在**单进程内存**里，部署时必须单实例常驻，不要开多副本 / 自动扩容；纯 Serverless 平台不兼容，详见 `DEPLOY.md` 方案 F。

## 安全

- 所有用户内容在前端用 `textContent` 渲染，避免 XSS；图片仅接受 base64 白名单格式。
- 服务端限制请求体 3MB、文本 8000 字、昵称 32 字、房间名 40 字；单房间保留最近 2000 条、全局 12000 条。
- 这是演示级应用，**没有账号体系与鉴权**，请勿用于敏感场景。

## 文件

```
server.js           # Node 原生 http 服务 + API + 内存/文件存储
public/index.html   # 聊天室页面结构
public/style.css    # 聊天室样式（亮暗自适应、响应式）
public/app.js       # 轮询、渲染、发送、图片压缩等前端逻辑
package.json        # npm start -> node server.js
API.md              # 完整 HTTP API 文档
DEPLOY.md           # 多平台部署方案
AGENTS.md           # 给 AI 的部署契约
ONE_CLICK_PROMPT.md # 一键部署提示词
Dockerfile / docker-compose.yml / render.yaml / Procfile  # 各平台适配
data/               # 运行时自动生成的消息存档（.gitignore 已排除，不进仓库）
```

## 许可证

MIT — 见 [`LICENSE`](LICENSE)。
