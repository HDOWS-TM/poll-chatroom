'use strict';
// 零依赖冒烟测试：在临时目录启动一份隔离的 server.js，验证页面与全部 API。
// 刻意不碰项目目录的 data/，避免污染正在运行的聊天室数据。
// 用法：npm test  （本地与 GitHub Actions 均可直接跑，无需 npm install）

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-chatroom-smoke-'));
const PORT = 32000 + Math.floor(Math.random() * 2000);
let child = null;
let serverLog = '';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: urlPath, method, headers, timeout: 5000 },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let json = null;
          try { json = buf ? JSON.parse(buf) : null; } catch (e) { /* 静态资源不是 JSON */ }
          resolve({ status: res.statusCode, text: buf, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await request('GET', '/api/health');
      if (r.status === 200 && r.json && r.json.ok) return r.json;
    } catch (e) { /* 尚未监听 */ }
    await sleep(250);
  }
  throw new Error('服务未在 10 秒内就绪\n' + serverLog);
}

function copyFixture() {
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(TMP, 'server.js'));
  fs.cpSync(path.join(ROOT, 'public'), path.join(TMP, 'public'), { recursive: true });
}

async function main() {
  copyFixture();
  child = spawn(process.execPath, ['server.js'], {
    cwd: TMP,
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  const health = await waitReady();
  console.log('✓ /api/health ok=true, uptime=' + Math.round(health.uptime) + 's');

  // 1) 页面与静态资源
  for (const p of ['/', '/app.js', '/style.css']) {
    const r = await request('GET', p);
    assert(r.status === 200, p + ' 返回 HTTP ' + r.status);
  }
  const home = await request('GET', '/');
  assert(/<html/i.test(home.text), '首页不是 HTML');
  console.log('✓ 首页 / app.js / style.css 均 200');

  // 2) API 全链路（独立房间，不碰默认「大厅」）
  const ROOM = 'ci_smoke';
  const j = await request('POST', '/api/join', { uid: 'ci_a', nick: 'CI-A', room: ROOM });
  assert(j.status === 200 && j.json && j.json.ok, 'join 失败: ' + j.text);
  const cursor0 = j.json.cursor;
  await request('POST', '/api/join', { uid: 'ci_b', nick: 'CI-B', room: ROOM });

  const s1 = await request('POST', '/api/send', {
    uid: 'ci_a', clientId: 'c1', type: 'text', content: 'CI 冒烟测试',
  });
  assert(s1.json && s1.json.ok, 'send text 失败: ' + s1.text);
  const s2 = await request('POST', '/api/send', {
    uid: 'ci_b', clientId: 'c2', type: 'sticker', content: '🚀',
  });
  assert(s2.json && s2.json.ok, 'send sticker 失败: ' + s2.text);

  const p = await request('GET',
    '/api/poll?uid=ci_a&room=' + encodeURIComponent(ROOM) + '&since=' + cursor0);
  assert(p.json && p.json.ok, 'poll 失败');
  assert(p.json.messages.length === 2,
    '增量轮询应返回 2 条，实际 ' + p.json.messages.length);
  assert(p.json.cursor > cursor0, '游标应递增');

  const h = await request('GET',
    '/api/history?room=' + encodeURIComponent(ROOM) + '&before=0');
  assert(h.json && h.json.messages.length >= 2, 'history 应能读到消息');

  const rs = await request('GET', '/api/rooms');
  assert(rs.json && rs.json.rooms.some((r) => r.name === ROOM),
    '房间列表应含测试房间');

  // 3) 房间隔离
  const iso = await request('GET',
    '/api/poll?uid=ci_a&room=' + encodeURIComponent('ci_other') + '&since=0');
  assert(iso.json && iso.json.messages.length === 0, '房间消息未隔离');

  console.log('✓ join / send(text,sticker) / poll 增量 / history / rooms / 房间隔离 全部通过');
  console.log('\n冒烟测试通过 ✅');
}

function cleanup() {
  if (child) { try { child.kill('SIGKILL'); } catch (e) { /* 已退出 */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

main().then(cleanup).catch((e) => {
  console.error('\n✗ 冒烟测试失败:', e.message);
  if (serverLog) console.error('--- 服务日志 ---\n' + serverLog);
  cleanup();
  process.exit(1);
});
