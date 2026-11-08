'use strict';

/**
 * 轻量轮询式聊天室 —— 单端口 HTTP 服务，零第三方依赖
 * 前端每 0.5~2.5 秒（随机抖动）轮询 /api/poll 拉取新消息。
 * 监听 PORT 环境变量并绑定 0.0.0.0，便于发布为在线应用。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'messages.json');

const ONLINE_TIMEOUT = 9000;   // 9s 无心跳视为离线（轮询上限 2.5s，留足容错）
const TYPING_TIMEOUT = 3500;
const MAX_BODY = 3 * 1024 * 1024; // 3MB（图片 base64），物理安全边界，保留
const MAX_HISTORY_PER_ROOM = 2000;  // 单房间保留条数（避免长会话历史被过早裁掉）
const MAX_TOTAL = 12000;            // 全局消息上限
const MAX_SAVE = 6000;              // 落盘保留条数
const MAX_TEXT = 8000;              // 文本消息字数上限
const MAX_STICKER = 64;             // 表情 / 系统消息字数上限
const MAX_NICK = 32;                // 昵称字数上限
const MAX_ROOM = 40;                // 房间名字数上限
const DEFAULT_ROOM = '大厅';

// ---------- 内存状态 ----------
let seq = 0;
let messages = [];                 // {id, clientId, room, uid, nick, type, content, ts, color}
const users = new Map();           // uid -> {nick, room, lastSeen, color}
const roomTyping = new Map();      // room -> Map<uid, ts>

function ensureTyping(room) {
  if (!roomTyping.has(room)) roomTyping.set(room, new Map());
  return roomTyping.get(room);
}

function clean(str, max) {
  return String(str == null ? '' : str).trim().slice(0, max || MAX_TEXT);
}

// ---------- 持久化（历史消息重启不丢） ----------
try {
  if (fs.existsSync(DATA_FILE)) {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(d.messages)) {
      messages = d.messages;
      seq = Number(d.seq) || messages.reduce((m, x) => Math.max(m, x.id || 0), 0);
    }
  }
} catch (e) { /* 忽略损坏的存档 */ }

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify({ seq, messages: messages.slice(-MAX_SAVE) }));
    } catch (e) { /* 只读环境下降级为纯内存 */ }
  }, 800);
}

function colorOf(uid) {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 62% 52%)`;
}

function onlineUsers(room) {
  const now = Date.now();
  const out = [];
  for (const [uid, u] of users) {
    if (now - u.lastSeen > ONLINE_TIMEOUT) { users.delete(uid); continue; }
    if (!room || u.room === room) out.push({ uid, nick: u.nick, color: u.color });
  }
  return out;
}

function roomList() {
  const now = Date.now();
  const map = new Map([[DEFAULT_ROOM, 0]]);
  for (const [uid, u] of users) {
    if (now - u.lastSeen > ONLINE_TIMEOUT) { users.delete(uid); continue; }
    map.set(u.room, (map.get(u.room) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name === DEFAULT_ROOM ? -1 : b.name === DEFAULT_ROOM ? 1 : a.name.localeCompare(b.name));
}

function typingList(room) {
  const now = Date.now();
  const t = ensureTyping(room);
  const out = [];
  for (const [uid, ts] of t) {
    if (now - ts > TYPING_TIMEOUT) { t.delete(uid); continue; }
    const u = users.get(uid);
    if (u && u.room === room && now - u.lastSeen < ONLINE_TIMEOUT && u.nick) out.push(u.nick);
  }
  return out;
}

function historyFor(room, before, limit) {
  const arr = messages.filter(m => m.room === room && (!before || m.id < before));
  return arr.slice(-(limit || 60));
}

function addMessage(m) {
  m.id = ++seq;
  m.ts = Date.now();
  messages.push(m);
  const list = messages.filter(x => x.room === m.room);
  if (list.length > MAX_HISTORY_PER_ROOM) {
    const drop = new Set(list.slice(0, list.length - MAX_HISTORY_PER_ROOM).map(x => x.id));
    messages = messages.filter(x => !drop.has(x.id));
  }
  if (messages.length > MAX_TOTAL) messages = messages.slice(-MAX_SAVE);
  scheduleSave();
  return m;
}

// ---------- HTTP 工具 ----------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return json(res, 403, { ok: false, error: 'forbidden' });
  fs.readFile(full, (err, buf) => {
    if (err) return json(res, 404, { ok: false, error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function touch(uid, nick, room) {
  if (!uid) return;
  const prev = users.get(uid);
  users.set(uid, {
    nick: clean(nick, MAX_NICK) || (prev && prev.nick) || '匿名',
    room: clean(room, MAX_ROOM) || (prev && prev.room) || DEFAULT_ROOM,
    color: colorOf(uid),
    lastSeen: Date.now(),
  });
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  const body = req.method === 'POST' ? await readBody(req) : {};

  if (p === '/api/health' && req.method === 'GET') {
    return json(res, 200, {
      ok: true, ts: Date.now(), uptime: process.uptime(),
      limits: {
        maxText: MAX_TEXT, maxSticker: MAX_STICKER, maxNick: MAX_NICK,
        maxRoom: MAX_ROOM, historyPerRoom: MAX_HISTORY_PER_ROOM,
        maxBody: MAX_BODY, onlineTimeout: ONLINE_TIMEOUT,
      },
    });
  }

  if (p === '/api/join' && req.method === 'POST') {
    const uid = clean(body.uid, 64), nick = clean(body.nick, MAX_NICK), room = clean(body.room, MAX_ROOM) || DEFAULT_ROOM;
    if (!uid || !nick) return json(res, 400, { ok: false, error: '缺少 uid 或 nick' });
    touch(uid, nick, room);
    return json(res, 200, {
      ok: true, cursor: seq, serverTime: Date.now(),
      history: historyFor(room, 0, 60),
      users: onlineUsers(room), rooms: roomList(),
    });
  }

  if (p === '/api/room' && req.method === 'POST') {
    const uid = clean(body.uid, 64), room = clean(body.room, MAX_ROOM) || DEFAULT_ROOM;
    touch(uid, null, room);
    return json(res, 200, {
      ok: true, cursor: seq, room,
      history: historyFor(room, 0, 60),
      users: onlineUsers(room), rooms: roomList(),
    });
  }

  if (p === '/api/poll' && req.method === 'GET') {
    const uid = clean(q.get('uid'), 64);
    const room = clean(q.get('room'), MAX_ROOM) || DEFAULT_ROOM;
    const since = Number(q.get('since')) || 0;
    touch(uid, q.get('nick'), room);   // 轮询即心跳
    const fresh = messages.filter(m => m.room === room && m.id > since).slice(-MAX_HISTORY_PER_ROOM);
    return json(res, 200, {
      ok: true, cursor: seq, serverTime: Date.now(),
      messages: fresh,
      users: onlineUsers(room),
      rooms: roomList(),
      typing: typingList(room),
    });
  }

  if (p === '/api/send' && req.method === 'POST') {
    const uid = clean(body.uid, 64);
    const u = users.get(uid);
    if (!u) return json(res, 403, { ok: false, error: '请先加入房间' });
    const type = ['text', 'image', 'sticker', 'system'].includes(body.type) ? body.type : 'text';
    let content = String(body.content == null ? '' : body.content);
    if (type === 'text') content = content.trim().slice(0, MAX_TEXT);
    else if (type === 'image') content = content.slice(0, 2 * 1024 * 1024);
    else content = content.slice(0, MAX_STICKER);
    if (!content) return json(res, 400, { ok: false, error: '内容为空' });
    if (type === 'image' && !/^data:image\/(png|jpe?g|gif|webp);base64,/.test(content)) {
      return json(res, 400, { ok: false, error: '图片格式不支持' });
    }
    touch(uid, u.nick, u.room);
    const msg = addMessage({
      clientId: clean(body.clientId, 64), room: u.room, uid, nick: u.nick,
      type, content, color: u.color,
    });
    const t = ensureTyping(u.room); t.delete(uid);
    return json(res, 200, { ok: true, message: msg });
  }

  if (p === '/api/typing' && req.method === 'POST') {
    const uid = clean(body.uid, 64);
    const u = users.get(uid);
    if (u) ensureTyping(u.room).set(uid, Date.now());
    return json(res, 200, { ok: true });
  }

  if (p === '/api/history' && req.method === 'GET') {
    const room = clean(q.get('room'), MAX_ROOM) || DEFAULT_ROOM;
    const before = Number(q.get('before')) || 0;
    return json(res, 200, { ok: true, messages: historyFor(room, before, 60) });
  }

  if (p === '/api/rooms' && req.method === 'GET') {
    return json(res, 200, { ok: true, rooms: roomList() });
  }

  return json(res, 404, { ok: false, error: 'unknown api' });
}

// ---------- 服务器 ----------
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { return json(res, 400, { ok: false, error: 'bad url' }); }
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    handleApi(req, res, url).catch(err => json(res, 400, { ok: false, error: err.message }));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'method not allowed' });

  if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
  if (p === '/style.css') return serveStatic(res, 'style.css');
  if (p === '/app.js') return serveStatic(res, 'app.js');
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  return json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`聊天室已启动: http://${HOST}:${PORT}  (轮询延迟 0.5~2.5s)`);
});

process.on('SIGTERM', () => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify({ seq, messages: messages.slice(-MAX_SAVE) })); } catch (e) {} process.exit(0); });
