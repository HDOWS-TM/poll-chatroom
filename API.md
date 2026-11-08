# 轮询聊天室 · HTTP API

纯 JSON over HTTP，无 WebSocket、无第三方依赖。所有请求走同一个端口，前端就是靠这套接口轮询同步消息。

## 基地址

```
https://<YOUR_HOST>/?sharecode=<YOUR_SHARECODE>
```

> ⚠️ **若你的部署平台通过网关鉴权**（例如 URL 上带 `sharecode`），每个 API 请求都必须原样带上该查询参数，否则会被网关拦截。示例：
> `/api/health?sharecode=<YOUR_SHARECODE>`、`/api/poll?sharecode=<YOUR_SHARECODE>&uid=...&since=0`
>
> 自建 / 反向代理部署通常不需要鉴权参数，基地址写 `http://localhost:3000` 或你的域名即可。把 `<YOUR_HOST>`、`<YOUR_SHARECODE>` 换成你实际部署出来的值。

---

## 端点总览

| 端点 | 方法 | 作用 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/join` | POST | 加入房间（同时作为上线心跳） |
| `/api/room` | POST | 切换 / 新建房间 |
| `/api/poll` | GET | **核心**：增量拉取消息、在线列表、正在输入 |
| `/api/send` | POST | 发送消息 |
| `/api/typing` | POST | 上报"正在输入" |
| `/api/history` | GET | 翻页加载更早的历史消息 |
| `/api/rooms` | GET | 房间列表与人数 |

所有响应均为 `Content-Type: application/json; charset=utf-8`，`Cache-Control: no-store`。

---

## 数据结构

**消息对象 Message**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | number | 全局自增 ID，用作轮询游标 |
| `clientId` | string | 客户端生成的去重 ID（乐观上屏用） |
| `room` | string | 所属房间 |
| `uid` | string | 发送者 ID |
| `nick` | string | 发送者昵称 |
| `type` | string | `text` / `image` / `sticker` / `system` |
| `content` | string | 文本；图片为 `data:image/...;base64,...`；表情为单个 emoji |
| `ts` | number | 服务端时间戳（毫秒） |
| `color` | string | 头像色，如 `hsl(210 62% 52%)` |

**在线用户 User**：`{ uid, nick, color }`
**房间 Room**：`{ name, count }`

---

## 端点详情

### GET `/api/health`

```json
{ "ok": true, "ts": 1794035790767, "uptime": 699.23 }
```

### POST `/api/join`

请求体：

```json
{ "uid": "u_abc123", "nick": "小明", "room": "大厅" }
```

响应：

```json
{
  "ok": true,
  "cursor": 30,
  "serverTime": 1794035790767,
  "history": [ /* 最近 60 条 Message，按时间正序 */ ],
  "users":  [ /* 该房间在线 User */ ],
  "rooms":  [ /* Room 列表 */ ]
}
```

> `cursor` 是**当前全局消息游标**。加入后从 `since=cursor` 开始轮询，只拿新消息。

### GET `/api/poll` ⭐ 核心

查询参数：`uid`、`nick`、`room`、`since`

| 参数 | 必填 | 说明 |
|------|------|------|
| `uid` | 是 | 你的用户 ID（同时作为在线心跳） |
| `nick` | 否 | 昵称 |
| `room` | 否 | 默认 `大厅` |
| `since` | 否 | 上次拿到的 `cursor`，只返回 `id > since` 的消息，默认 0 |

响应：

```json
{
  "ok": true,
  "cursor": 32,
  "serverTime": 1794035790767,
  "messages": [ /* 新增 Message，最多 100 条 */ ],
  "users":  [ /* 在线 User */ ],
  "rooms":  [ /* Room */ ],
  "typing": ["小红", "小刚"]
}
```

**轮询节奏**：前端每次间隔在 **0.5~2.5 秒随机**（`500 + Math.random()*2000` 毫秒），避免多个客户端同时请求造成惊群。每次轮询即一次心跳，**9 秒**无心跳自动离线。

### POST `/api/send`

```json
{
  "uid": "u_abc123",
  "clientId": "c_xyz789",
  "type": "text",
  "content": "你好"
}
```

`type` 取值与 `content` 约束：

| type | content |
|------|---------|
| `text` | 纯文本，≤ 2000 字 |
| `sticker` | 单个 emoji，≤ 32 字 |
| `image` | 必须是 `data:image/(png\|jpe?g\|gif\|webp);base64,...`，≤ 2MB |

响应：`{ "ok": true, "message": { /* 带 id 与 ts 的完整 Message */ } }`

> `clientId` 用于去重：前端乐观上屏后立即显示，轮询带回同一条时按 `clientId` 跳过。

### POST `/api/typing`

```json
{ "uid": "u_abc123" }
```

响应 `{ "ok": true }`。状态 **3.5 秒**后自动过期。

### POST `/api/room`

```json
{ "uid": "u_abc123", "room": "摸鱼区" }
```

房间不存在即自动创建。响应同 `/api/join`，含新房间的 `history`、`users`、`rooms`。

### GET `/api/history`

参数：`room`、`before`（返回 `id < before` 的最近 60 条）。用于"加载更早的消息"翻页。

```json
{ "ok": true, "messages": [ /* Message */ ] }
```

### GET `/api/rooms`

```json
{ "ok": true, "rooms": [ { "name": "大厅", "count": 2 }, { "name": "摸鱼区", "count": 0 } ] }
```

---

## 可复制示例（替换 `UID` 即可）

把下面命令里的 `BASE` / `C` 换成你实际部署出来的地址与鉴权参数（若平台不需要鉴权，把 `C` 留空即可）。

```bash
BASE="https://<YOUR_HOST>"
C="sharecode=<YOUR_SHARECODE>"

# 1. 健康检查
curl -s "$BASE/api/health?$C"

# 2. 加入大厅
curl -s -X POST "$BASE/api/join?$C" \
  -H 'Content-Type: application/json' \
  -d '{"uid":"u_demo","nick":"机器人","room":"大厅"}'

# 3. 发一条文本（先调用 join，否则返回 403）
curl -s -X POST "$BASE/api/send?$C" \
  -H 'Content-Type: application/json' \
  -d '{"uid":"u_demo","clientId":"c_001","type":"text","content":"来自 API 的问候"}'

# 4. 轮询新消息（把 since 换成上一步 join 返回的 cursor）
curl -s "$BASE/api/poll?$C&uid=u_demo&nick=%E6%9C%BA%E5%99%A8%E4%BA%BA&room=%E5%A4%A7%E5%8E%85&since=0"

# 5. 房间列表
curl -s "$BASE/api/rooms?$C"

# 6. 历史消息
curl -s "$BASE/api/history?$C&room=%E5%A4%A7%E5%8E%85&before=0"
```

**Python 最小轮询客户端**

```python
import time, random, requests

BASE = "https://<YOUR_HOST>"
C = {"sharecode": "<YOUR_SHARECODE>"}
uid, nick, room = "u_demo", "机器人", "大厅"

r = requests.post(f"{BASE}/api/join", params=C,
                  json={"uid": uid, "nick": nick, "room": room}).json()
cursor = r["cursor"]

while True:
    d = requests.get(f"{BASE}/api/poll", params={**C,
        "uid": uid, "nick": nick, "room": room, "since": cursor},
        timeout=10).json()
    cursor = d["cursor"]
    for m in d["messages"]:
        print(f'[{m["nick"]}] {m["content"]}')
    time.sleep(0.5 + random.random() * 2.0)   # 0.5~2.5 秒
```

---

## 限制与注意事项

| 项 | 值 |
|----|----|
| 请求体上限 | 3 MB |
| 文本长度 | ≤ 2000 字 |
| 昵称 / 房间名 | ≤ 16 / 20 字 |
| 单房间历史保留 | 300 条，超出自动淘汰最旧 |
| 在线判定 | 9 秒无心跳离线 |
| 鉴权 | **无账号体系**；访问凭据只有 URL 上的 `sharecode` |

- **无鉴权**：拿到链接的人都能读写，请勿用于敏感内容。
- **消息持久化**：写盘 `data/messages.json`，服务重启不丢；但沙箱长期回收后可能清空。
- **图片消息**：建议先压缩再发（前端已做：最长边 1280px、JPEG 0.72）。
- **CORS**：未显式放行跨域头，浏览器跨站调用需同源或自行加代理。
- 错误响应统一为 `{ "ok": false, "error": "原因" }`，常见 HTTP 400/403/404。
