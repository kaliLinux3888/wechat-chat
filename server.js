const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const POLL_INTERVAL = 2000;       // 客户端轮询间隔(毫秒)
const EVENT_TTL = 120000;         // 事件保留时长(毫秒)，2分钟
const MAX_EVENTS = 500;           // 每用户最多保留事件数
const SAVE_INTERVAL = 30000;      // 自动保存周期(毫秒)

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── 数据存储 ──────────────────────────────────────────────
const users = new Map();       // userId → { id, nickname, avatarColor, online, lastSeen, lastSeq }
const eventQueues = new Map(); // userId → [{ seq, type, data, ts }]
const messages = new Map();    // "userId1:userId2" → [...messages]
let globalSeq = 0;
let messageIdCounter = 0;
let saveTimer = null;

const COLORS = ['#07C160', '#1485EE', '#FA5151', '#FFC300', '#965DF2', '#10AEFF', '#E64340', '#F76260', '#576B95', '#FF7C7C'];

// ── 持久化工具 ──────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, 'utf8');
      const data = JSON.parse(raw || '[]');
      data.forEach(u => {
        u.online = false; // 启动时不认为任何人在线
        users.set(u.id, u);
      });
    }
    if (fs.existsSync(MESSAGES_FILE)) {
      const raw = fs.readFileSync(MESSAGES_FILE, 'utf8');
      const data = JSON.parse(raw || '[]');
      data.forEach(([key, msgs]) => messages.set(key, msgs));
    }
    if (fs.existsSync(META_FILE)) {
      const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8') || '{}');
      globalSeq = meta.globalSeq || 0;
      messageIdCounter = meta.messageIdCounter || 0;
    }
    console.log(`[持久化] 已加载 ${users.size} 个用户，${messages.size} 个会话`);
  } catch (e) {
    console.error('[持久化] 加载失败', e.message);
  }
}

function saveData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(Array.from(users.values())), 'utf8');
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(Array.from(messages.entries())), 'utf8');
    fs.writeFileSync(META_FILE, JSON.stringify({ globalSeq, messageIdCounter }), 'utf8');
  } catch (e) {
    console.error('[持久化] 保存失败', e.message);
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveData();
    saveTimer = null;
  }, 500); // 500ms 防抖，避免高频写入
}
function getChatKey(a, b) { return [a, b].sort().join(':'); }
function nextMessageId() { return ++messageIdCounter; }
function nextSeq() { return ++globalSeq; }
function genUserId() { return 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function pickColor() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }

// ── 事件队列 ──────────────────────────────────────────────
function pushEvent(userId, type, data) {
  if (!eventQueues.has(userId)) eventQueues.set(userId, []);
  const queue = eventQueues.get(userId);
  queue.push({ seq: nextSeq(), type, data, ts: Date.now() });
  // 清理过期 & 超量事件
  const now = Date.now();
  while (queue.length > 0 && (queue[0].ts < now - EVENT_TTL || queue.length > MAX_EVENTS)) {
    queue.shift();
  }
  // 事件队列无需持久化（重启后用户自然会重新拉取历史）
}

function getEvents(userId, sinceSeq) {
  const queue = eventQueues.get(userId) || [];
  return queue.filter(e => e.seq > sinceSeq);
}

function broadcast(type, data, excludeUserId = null) {
  users.forEach((u, uid) => {
    if (uid !== excludeUserId) pushEvent(uid, type, data);
  });
}

function getOnlineUsers(excludeUserId = null) {
  const list = [];
  users.forEach((u, uid) => {
    if (u.online && uid !== excludeUserId) {
      list.push({ id: u.id, nickname: u.nickname, avatarColor: u.avatarColor });
    }
  });
  return list;
}

function setUserOnline(userId) {
  const u = users.get(userId);
  if (!u) return;
  const wasOffline = !u.online;
  u.online = true;
  u.lastSeen = Date.now();
  if (wasOffline) {
    broadcast('user_online', { id: u.id, nickname: u.nickname, avatarColor: u.avatarColor }, userId);
    broadcast('users', { users: getOnlineUsers() });
  }
}

function setUserOffline(userId) {
  const u = users.get(userId);
  if (!u) return;
  if (u.online) {
    u.online = false;
    u.lastSeen = Date.now();
    broadcast('user_offline', { userId });
    broadcast('users', { users: getOnlineUsers() });
  }
}

// ── HTTP 工具 ──────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  const safePath = path.normalize(filePath);
  if (!safePath.startsWith(path.join(__dirname, 'public'))) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(__dirname, 'public', 'index.html');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ── 路由处理 ──────────────────────────────────────────────
async function handleApi(req, res, pathname, query) {
  // ── 登录 ──
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    const nickname = (body.nickname || '').trim() || '微信用户';
    let userId = body.userId;
    let user;

    if (userId && users.has(userId)) {
      user = users.get(userId);
      user.nickname = nickname;
    } else {
      userId = genUserId();
      user = { id: userId, nickname, avatarColor: pickColor(), online: false, lastSeen: Date.now() };
      users.set(userId, user);
      eventQueues.set(userId, []);
    }
    // 登录即标记在线（建立首次轮询前先置位）
    setUserOnline(userId);
    console.log(`[登录] ${user.nickname} (${userId})`);
    scheduleSave();
    sendJson(res, 200, { ok: true, user: { id: user.id, nickname: user.nickname, avatarColor: user.avatarColor } });
    return;
  }

  // ── 轮询：拉取增量事件 ──
  if (pathname === '/api/poll' && req.method === 'GET') {
    const userId = query.userId;
    const sinceSeq = parseInt(query.since) || 0;
    if (!users.has(userId)) { sendJson(res, 401, { error: '未登录' }); return; }

    // 心跳：标记在线
    setUserOnline(userId);

    const events = getEvents(userId, sinceSeq);
    const lastSeq = events.length > 0 ? events[events.length - 1].seq : sinceSeq;

    sendJson(res, 200, {
      ok: true,
      events,
      lastSeq,
      onlineUsers: getOnlineUsers(userId),
      serverTime: Date.now(),
    });
    return;
  }

  // ── 发送消息 ──
  if (pathname === '/api/message' && req.method === 'POST') {
    const body = await readBody(req);
    const user = users.get(body.from);
    if (!user) { sendJson(res, 401, { error: '未登录' }); return; }

    const text = (body.text || '').trim();
    if (!text) { sendJson(res, 400, { error: '消息为空' }); return; }

    const chatKey = getChatKey(user.id, body.to);
    const msg = {
      id: nextMessageId(),
      from: user.id,
      fromNickname: user.nickname,
      fromAvatarColor: user.avatarColor,
      to: body.to,
      text,
      timestamp: Date.now(),
    };
    if (!messages.has(chatKey)) messages.set(chatKey, []);
    messages.get(chatKey).push(msg);

    // 推事件给接收方
    pushEvent(body.to, 'message', { message: msg });
    scheduleSave();

    sendJson(res, 200, { ok: true, message: msg });
    return;
  }

  // ── 输入状态 ──
  if (pathname === '/api/typing' && req.method === 'POST') {
    const body = await readBody(req);
    const user = users.get(body.from);
    if (!user) { sendJson(res, 401, { error: '未登录' }); return; }
    pushEvent(body.to, 'typing', { from: user.id, fromNickname: user.nickname, isTyping: !!body.isTyping });
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── 历史消息 ──
  if (pathname === '/api/history' && req.method === 'GET') {
    const userId = query.userId;
    const withId = query.with;
    if (!users.has(userId)) { sendJson(res, 401, { error: '未登录' }); return; }
    const chatKey = getChatKey(userId, withId);
    const history = messages.get(chatKey) || [];
    sendJson(res, 200, { ok: true, with: withId, messages: history });
    return;
  }

  // ── 退出登录（页面关闭时尽力上报） ──
  if (pathname === '/api/logout' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.userId) setUserOffline(body.userId);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'Not Found' });
}

// ── 离线检测：超过 15 秒未轮询视为离线 ──
setInterval(() => {
  const now = Date.now();
  users.forEach((u, uid) => {
    if (u.online && now - u.lastSeen > 15000) {
      setUserOffline(uid);
    }
  });
}, 5000);

// ── 创建服务器 ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, pathname, query);
    } catch (e) {
      console.error('[API错误]', e.message);
      sendJson(res, 500, { error: '服务器错误' });
    }
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  loadData();
  console.log(`\n  💬 微信风格聊天服务器已启动 (轮询版 · 数据持久化)`);
  console.log(`  🌐 本地访问: http://localhost:${PORT}`);
  console.log(`  📡 监听地址: 0.0.0.0:${PORT}`);
  console.log(`  💾 数据目录: ${DATA_DIR}`);
  console.log(`  ⏱️  轮询间隔: ${POLL_INTERVAL}ms\n`);
});

// 定时保存兜底
setInterval(() => saveData(), SAVE_INTERVAL);
