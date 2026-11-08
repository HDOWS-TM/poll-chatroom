/* 轮询聊天室前端逻辑
 * 每 0.5~2.5 秒（随机抖动）拉取一次新消息；自己发的消息乐观上屏，靠 clientId 去重。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const LS_UID = 'chat_uid', LS_NICK = 'chat_nick';

  const state = {
    uid: localStorage.getItem(LS_UID) || '',
    nick: localStorage.getItem(LS_NICK) || '',
    room: '大厅',
    cursor: 0,
    timer: null,
    oldestId: Infinity,
    typingAt: 0,
    roomNames: [],
  };

  // clientId -> { el, msg } 待确认； 已确认的 clientId
  const pending = new Map();
  const rendered = new Set();

  const EMOJIS = ['😀','😂','🥰','😎','🤔','😭','😡','👍','👏','🙏','💪','🎉','❤️','🔥','✨','🌈',
                  '🍻','☕','🐱','🐶','🚀','💡','✅','❌','🌟','😴','🤝','😇','🥳','💯','🍀','🎁'];

  // ---------- 工具 ----------
  function uidGen() {
    return 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }
  function toast(msg, err) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (err ? ' err' : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 2400);
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ cache: 'no-store' }, opts || {}));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  function post(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  function setConn(ok, text) {
    const el = $('connStatus');
    el.className = 'conn ' + (ok ? 'ok' : 'bad');
    el.innerHTML = '<i></i> ' + (text || (ok ? '已连接' : '重连中…'));
  }
  function nearBottom() {
    const s = $('msgScroll');
    return s.scrollHeight - s.scrollTop - s.clientHeight < 140;
  }
  function scrollBottom() {
    const s = $('msgScroll');
    requestAnimationFrame(() => { s.scrollTop = s.scrollHeight; });
  }

  // ---------- 渲染单条消息 ----------
  function bubbleContent(el, m) {
    el.className = 'bubble' + (m.pending ? ' pending' : '') + (m.failed ? ' failed' : '');
    if (m.type === 'sticker') { el.classList.add('sticker'); el.textContent = m.content; return; }
    if (m.type === 'image') {
      el.classList.add('image');
      const img = document.createElement('img');
      img.src = m.content; img.alt = '图片消息'; img.loading = 'lazy';
      img.addEventListener('click', () => openLightbox(m.content));
      el.textContent = '';
      el.appendChild(img);
      return;
    }
    if (m.type === 'system') { el.classList.add('system-text'); el.textContent = m.content; return; }
    el.textContent = m.content;
  }

  function createMsgEl(m) {
    const wrap = document.createElement('div');
    wrap.className = 'msg' + (m.uid === state.uid ? ' mine' : '');

    if (m.type === 'system') {
      const s = document.createElement('div');
      s.className = 'system-msg'; s.textContent = m.content;
      wrap.appendChild(s);
      return { wrap, bubble: s, meta: null, avatar: null };
    }

    const av = document.createElement('span');
    av.className = 'avatar';
    av.style.background = m.color || 'var(--primary)';
    av.textContent = (m.nick || '?').slice(0, 1);

    const body = document.createElement('div');
    body.className = 'msg-body';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const nickEl = document.createElement('span'); nickEl.className = 'nick'; nickEl.textContent = m.nick || '匿名';
    const timeEl = document.createElement('span'); timeEl.textContent = fmtTime(m.ts || Date.now());
    meta.appendChild(nickEl); meta.appendChild(timeEl);

    const bubble = document.createElement('div');
    bubbleContent(bubble, m);

    body.appendChild(meta); body.appendChild(bubble);
    wrap.appendChild(av); wrap.appendChild(body);
    return { wrap, bubble, meta: timeEl, avatar: av };
  }

  function renderMsg(m, atTop) {
    if (m.clientId && rendered.has(m.clientId)) return null;
    const stick = nearBottom();
    const parts = createMsgEl(m);
    const list = $('msgList');
    if (atTop) list.insertBefore(parts.wrap, list.firstChild);
    else list.appendChild(parts.wrap);
    if (m.id && m.id < state.oldestId) state.oldestId = m.id;
    if (m.clientId) rendered.add(m.clientId);
    if (stick && !atTop) scrollBottom();
    return parts;
  }

  function upgradePending(m) {
    const p = pending.get(m.clientId);
    if (!p) return false;
    p.msg.id = m.id; p.msg.ts = m.ts; p.msg.pending = false; p.msg.failed = false;
    if (p.meta) p.meta.textContent = fmtTime(m.ts);
    bubbleContent(p.bubble, p.msg);
    pending.delete(m.clientId);
    rendered.add(m.clientId);
    return true;
  }

  function openLightbox(src) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    const img = document.createElement('img'); img.src = src;
    lb.appendChild(img);
    lb.addEventListener('click', () => lb.remove());
    document.body.appendChild(lb);
  }

  // ---------- 侧栏渲染 ----------
  function renderRooms(rooms) {
    state.roomNames = rooms.map(r => r.name);
    const box = $('roomList'); box.textContent = '';
    rooms.forEach(r => {
      const b = document.createElement('button');
      b.className = 'room-item' + (r.name === state.room ? ' active' : '');
      const h = document.createElement('span'); h.className = 'hash'; h.textContent = '#';
      const n = document.createElement('span'); n.textContent = r.name;
      const c = document.createElement('span'); c.className = 'rcount'; c.textContent = r.count ? r.count + ' 人' : '';
      b.appendChild(h); b.appendChild(n); b.appendChild(c);
      b.addEventListener('click', () => switchRoom(r.name));
      box.appendChild(b);
    });
  }

  function renderUsers(users) {
    const box = $('userList'); box.textContent = '';
    $('onlineCount').textContent = users.length;
    $('topOnline').textContent = users.length + ' 在线';
    users.forEach(u => {
      const d = document.createElement('div'); d.className = 'user-item';
      const dot = document.createElement('span'); dot.className = 'dot';
      const av = document.createElement('span'); av.className = 'avatar sm';
      av.style.background = u.color || 'var(--primary)'; av.textContent = (u.nick || '?').slice(0, 1);
      const n = document.createElement('span'); n.textContent = u.nick + (u.uid === state.uid ? '（我）' : '');
      d.appendChild(dot); d.appendChild(av); d.appendChild(n);
      box.appendChild(d);
    });
  }

  function renderTyping(list) {
    const others = list.filter(n => n !== state.nick);
    const bar = $('typingBar');
    if (!others.length) { bar.textContent = ''; return; }
    const b = document.createElement('b');
    b.textContent = others.slice(0, 3).join('、') + (others.length > 3 ? ' 等' + others.length + ' 人' : '');
    bar.textContent = ''; bar.appendChild(b);
    bar.appendChild(document.createTextNode(' 正在输入…'));
  }

  // ---------- 轮询 ----------
  function schedulePoll() {
    clearTimeout(state.timer);
    const delay = 500 + Math.random() * 2000;   // 0.5 ~ 2.5 秒
    $('delayLabel').title = '本次间隔 ' + (delay / 1000).toFixed(2) + 's';
    state.timer = setTimeout(poll, delay);
  }

  async function poll() {
    try {
      const q = new URLSearchParams({ uid: state.uid, nick: state.nick, room: state.room, since: String(state.cursor) });
      const d = await api('/api/poll?' + q.toString());
      if (!d.ok) throw new Error('poll failed');
      setConn(true);
      state.cursor = Math.max(state.cursor, d.cursor || 0);
      (d.messages || []).forEach(m => {
        if (m.clientId && (upgradePending(m) || rendered.has(m.clientId))) return;
        renderMsg(m);
      });
      renderRooms(d.rooms || []);
      renderUsers(d.users || []);
      renderTyping(d.typing || []);
    } catch (e) {
      setConn(false);
    }
    schedulePoll();
  }

  // ---------- 进入 / 切换房间 ----------
  function resetMessages(history) {
    const list = $('msgList'); list.textContent = '';
    pending.clear(); rendered.clear();
    state.oldestId = Infinity;
    (history || []).forEach(m => renderMsg(m));
    $('loadMore').classList.toggle('hidden', (history || []).length < 60);
    scrollBottom();
  }

  async function enter(nick) {
    state.uid = state.uid || uidGen();
    state.nick = nick;
    localStorage.setItem(LS_UID, state.uid);
    localStorage.setItem(LS_NICK, state.nick);
    $('meNick').textContent = state.nick;
    $('meAvatar').textContent = state.nick.slice(0, 1);
    $('meAvatar').style.background = 'var(--primary)';
    $('nickModal').classList.add('hidden');
    try {
      const d = await post('/api/join', { uid: state.uid, nick: state.nick, room: state.room });
      state.cursor = d.cursor || 0;
      resetMessages(d.history);
      renderRooms(d.rooms || []);
      renderUsers(d.users || []);
      setConn(true);
      schedulePoll();
      $('msgInput').focus();
    } catch (e) {
      setConn(false); toast('连接服务器失败，将自动重试', true);
      schedulePoll();
    }
  }

  async function switchRoom(room) {
    if (room === state.room) { document.querySelector('.sidebar').classList.remove('open'); return; }
    state.room = room;
    $('currentRoom').textContent = room;
    document.querySelector('.sidebar').classList.remove('open');
    try {
      const d = await post('/api/room', { uid: state.uid, room });
      state.cursor = d.cursor || 0;
      resetMessages(d.history);
      renderRooms(d.rooms || []);
      renderUsers(d.users || []);
      toast('已进入 #' + room);
    } catch (e) { toast('切换房间失败', true); }
  }

  async function loadMore() {
    if (!isFinite(state.oldestId)) return;
    try {
      const d = await api('/api/history?' + new URLSearchParams({ room: state.room, before: String(state.oldestId) }));
      const list = d.messages || [];
      if (!list.length) { $('loadMore').classList.add('hidden'); return; }
      const s = $('msgScroll');
      const before = s.scrollHeight;
      list.forEach(m => renderMsg(m, true));
      s.scrollTop += s.scrollHeight - before;
      if (list.length < 60) $('loadMore').classList.add('hidden');
    } catch (e) { toast('加载失败', true); }
  }

  // ---------- 发送 ----------
  function optimistic(type, content) {
    const clientId = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    const m = {
      clientId, uid: state.uid, nick: state.nick, type, content,
      ts: Date.now(), color: 'var(--primary)', pending: true,
    };
    const parts = renderMsg(m);
    if (parts) pending.set(clientId, { el: parts, msg: m });
    return { clientId, m, parts };
  }

  async function send(type, content) {
    if (!state.nick) { toast('请先设置昵称', true); return; }
    if (!content) return;
    const o = optimistic(type, content);
    try {
      const d = await post('/api/send', { uid: state.uid, clientId: o.clientId, type, content });
      if (!d.ok) throw new Error(d.error || '发送失败');
      const saved = d.message;
      const p = pending.get(o.clientId);
      if (p) {
        p.msg.id = saved.id; p.msg.ts = saved.ts; p.msg.pending = false;
        if (p.parts.meta) p.parts.meta.textContent = fmtTime(saved.ts);
        bubbleContent(p.parts.bubble, p.msg);
        pending.delete(o.clientId);
        rendered.add(o.clientId);
        if (saved.id < state.oldestId) state.oldestId = saved.id;
      }
    } catch (e) {
      const p = pending.get(o.clientId);
      if (p) { p.msg.failed = true; p.msg.pending = false; bubbleContent(p.parts.bubble, p.msg); }
      toast('发送失败：' + e.message, true);
    }
  }

  function sendText() {
    const el = $('msgInput');
    const text = el.value.trim();
    if (!text) return;
    el.value = ''; autoHeight(el);
    send('text', text);
  }

  // ---------- 图片压缩 ----------
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const MAX = 1280;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) { const s = Math.min(MAX / w, MAX / h); w = Math.round(w * s); h = Math.round(h * s); }
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        const out = c.toDataURL('image/jpeg', 0.72);
        if (out.length > 2 * 1024 * 1024) return reject(new Error('图片太大，请换一张'));
        resolve(out);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  // ---------- 事件绑定 ----------
  function autoHeight(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 130) + 'px';
  }

  function bind() {
    $('nickConfirm').addEventListener('click', () => {
      const n = $('nickInput').value.trim();
      if (!n) { toast('请输入昵称', true); return; }
      enter(n);
    });
    $('nickInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('nickConfirm').click(); });

    $('sendBtn').addEventListener('click', sendText);
    const input = $('msgInput');
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
    });
    input.addEventListener('input', () => {
      autoHeight(input);
      const now = Date.now();
      if (now - state.typingAt > 1800) {
        state.typingAt = now;
        post('/api/typing', { uid: state.uid }).catch(() => {});
      }
    });

    $('emojiBtn').addEventListener('click', e => {
      e.stopPropagation();
      $('emojiPanel').classList.toggle('hidden');
    });
    document.addEventListener('click', e => {
      if (!$('emojiPanel').contains(e.target) && e.target !== $('emojiBtn')) $('emojiPanel').classList.add('hidden');
    });

    $('imageBtn').addEventListener('click', () => $('imageInput').click());
    $('imageInput').addEventListener('change', async e => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (!f.type.startsWith('image/')) { toast('请选择图片文件', true); return; }
      toast('图片处理中…');
      try { const data = await compressImage(f); send('image', data); }
      catch (err) { toast(err.message, true); }
    });

    $('addRoomBtn').addEventListener('click', () => {
      const name = (window.prompt('新建房间名称（最多 20 字）：', '') || '').trim().slice(0, 20);
      if (!name) return;
      if (name === '大厅') { toast('大厅已存在', true); return; }
      switchRoom(name);
    });

    $('editNick').addEventListener('click', () => {
      const n = (window.prompt('修改昵称：', state.nick) || '').trim().slice(0, 16);
      if (!n || n === state.nick) return;
      state.nick = n;
      localStorage.setItem(LS_NICK, n);
      $('meNick').textContent = n;
      $('meAvatar').textContent = n.slice(0, 1);
      post('/api/join', { uid: state.uid, nick: n, room: state.room }).catch(() => {});
      toast('昵称已修改');
    });

    $('loadMore').addEventListener('click', loadMore);
    $('mobileMenu').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));

    // 表情面板
    const panel = $('emojiPanel');
    EMOJIS.forEach(em => {
      const b = document.createElement('button');
      b.textContent = em; b.title = '发送大表情';
      b.addEventListener('click', () => { panel.classList.add('hidden'); send('sticker', em); });
      panel.appendChild(b);
    });

    $('delayLabel').textContent = '0.5~2.5s';
  }

  // ---------- 启动 ----------
  bind();
  if (state.nick) {
    $('nickInput').value = state.nick;
    enter(state.nick);
  } else {
    $('nickModal').classList.remove('hidden');
    $('nickInput').focus();
  }
})();
