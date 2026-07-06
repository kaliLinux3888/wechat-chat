const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
// V4_CHANGE: 引入 JWT 实现有状态身份，解决 nickname 重复冲突和重连身份丢失
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 3000;
// V4_CHANGE: JWT 签名密钥，生产环境应通过环境变量注入
const JWT_SECRET = process.env.JWT_SECRET || 'wechat-chat-jwt-secret-2026';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const FRIENDS_FILE = path.join(DATA_DIR, 'friends.json');
const FRIEND_REQUESTS_FILE = path.join(DATA_DIR, 'friend_requests.json');
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
const users = new Map();       // userId → { id, nickname, avatarColor, online, lastSeen }
const eventQueues = new Map(); // userId → [{ seq, type, data, ts }]
const messages = new Map();    // "userId1:userId2" → [...messages]
const friends = new Map();     // userId → Set<friendId>  （双向好友关系）
const friendRequests = new Map(); // userId → [{from, fromNickname, fromAvatarColor, to, status, timestamp}]
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
    if (fs.existsSync(FRIENDS_FILE)) {
      const data = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8') || '[]');
      data.forEach(([uid, fids]) => friends.set(uid, new Set(fids)));
    }
    if (fs.existsSync(FRIEND_REQUESTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(FRIEND_REQUESTS_FILE, 'utf8') || '[]');
      data.forEach(([uid, reqs]) => friendRequests.set(uid, reqs));
    }
    console.log(`[持久化] 已加载 ${users.size} 个用户，${messages.size} 个会话，${friends.size} 个好友关系`);
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
    fs.writeFileSync(FRIENDS_FILE, JSON.stringify(Array.from(friends.entries()).map(([k,v]) => [k, Array.from(v)])), 'utf8');
    fs.writeFileSync(FRIEND_REQUESTS_FILE, JSON.stringify(Array.from(friendRequests.entries())), 'utf8');
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

// ── 好友系统 ──────────────────────────────────────────────
function areFriends(a, b) {
  const set = friends.get(a);
  return set && set.has(b);
}

function addFriendPair(a, b) {
  if (!friends.has(a)) friends.set(a, new Set());
  if (!friends.has(b)) friends.set(b, new Set());
  friends.get(a).add(b);
  friends.get(b).add(a);
  scheduleSave();
}

function getFriendsList(userId) {
  const set = friends.get(userId);
  if (!set) return [];
  return Array.from(set).map(fid => {
    const u = users.get(fid);
    return u ? { id: u.id, nickname: u.nickname, avatarColor: u.avatarColor, online: u.online } : null;
  }).filter(Boolean);
}

function getPendingRequests(userId) {
  // 发给 userId 的好友请求
  const all = [];
  friendRequests.forEach((reqs, fromUid) => {
    reqs.forEach(r => {
      if (r.to === userId && r.status === 'pending') {
        all.push({ ...r, requestId: r.from + '_' + r.to + '_' + r.timestamp });
      }
    });
  });
  all.sort((a, b) => b.timestamp - a.timestamp);
  return all;
}

function checkPendingRequest(fromUid, toUid) {
  let found = false;
  friendRequests.forEach((reqs) => {
    reqs.forEach(r => {
      if (r.from === fromUid && r.to === toUid && r.status === 'pending') found = true;
    });
  });
  return found;
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

// V4_CHANGE: 从 query 或 body 中提取并校验 JWT，返回 userId 或 null
function verifyToken(req, query, body) {
  const tk = query.token || (body && body.token) || '';
  if (!tk) return null;
  try {
    const decoded = jwt.verify(tk, JWT_SECRET);
    // V4_CHANGE: 校验用户确实存在（防止已删除用户的 token 仍然有效）
    if (!users.has(decoded.userId)) return null;
    return decoded.userId;
  } catch (e) {
    return null;
  }
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
  // V4_CHANGE: 签发 JWT token，userId 由服务端分配（UUID），解决同名冲突和重连身份问题
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    const nickname = (body.nickname || '').trim() || '微信用户';
    let userId = body.userId;
    let user;
    // V4_CHANGE: 检查前端传来的 token，如果有效则复用旧用户（刷新页面恢复身份）
    let existingUserId = null;
    if (body.token) {
      existingUserId = verifyToken(req, query, body);
    }

    if (existingUserId && users.has(existingUserId)) {
      // V4_CHANGE: token 有效 → 复用旧身份，更新昵称
      userId = existingUserId;
      user = users.get(userId);
      user.nickname = nickname;
    } else if (userId && users.has(userId)) {
      // V4_CHANGE: 兜底：localStorage 中的 userId 匹配服务端记录（无 token 时）
      user = users.get(userId);
      user.nickname = nickname;
    } else {
      // V4_CHANGE: 全新用户，分配 UUID
      userId = genUserId();
      user = { id: userId, nickname, avatarColor: pickColor(), online: false, lastSeen: Date.now() };
      users.set(userId, user);
      eventQueues.set(userId, []);
    }
    setUserOnline(userId);
    // V4_CHANGE: 签发 JWT，payload 包含 userId，有效期 30 天
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    console.log(`[登录] ${user.nickname} (${userId})`);
    scheduleSave();
    sendJson(res, 200, { ok: true, user: { id: user.id, nickname: user.nickname, avatarColor: user.avatarColor }, token });
    return;
  }

  // ── 轮询：拉取增量事件 ──
  if (pathname === '/api/poll' && req.method === 'GET') {
    // V4_CHANGE: token 校验替代原先的 userId 参数直接信任
    const authUserId = verifyToken(req, query, null);
    const userId = query.userId;
    if (!authUserId || authUserId !== userId) { sendJson(res, 401, { error: 'token无效或已过期' }); return; }
    if (!users.has(userId)) { sendJson(res, 401, { error: '未登录' }); return; }
    const sinceSeq = parseInt(query.since) || 0;

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
    const chatMsgs = messages.get(chatKey);
    chatMsgs.push(msg);
    // 单个会话保留最近 5000 条，防止磁盘占满
    while (chatMsgs.length > 5000) chatMsgs.shift();

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

  // ── 搜索用户 ──
  if (pathname === '/api/search' && req.method === 'GET') {
    const q = (query.q || '').trim().toLowerCase();
    const selfId = query.userId;
    if (!q || q.length < 1) { sendJson(res, 200, { ok: true, users: [] }); return; }
    const results = [];
    users.forEach((u, uid) => {
      if (uid !== selfId && u.nickname.toLowerCase().includes(q)) {
        results.push({
          id: u.id, nickname: u.nickname, avatarColor: u.avatarColor, online: u.online,
          isFriend: areFriends(selfId, uid),
          hasPendingRequest: checkPendingRequest(selfId, uid)
        });
      }
    });
    results.sort((a, b) => (b.isFriend ? 1 : 0) - (a.isFriend ? 1 : 0));
    sendJson(res, 200, { ok: true, users: results });
    return;
  }

  // ── 发送好友请求 ──
  if (pathname === '/api/friend/request' && req.method === 'POST') {
    const body = await readBody(req);
    const fromUser = users.get(body.from);
    const toUser = users.get(body.to);
    if (!fromUser || !toUser) { sendJson(res, 404, { error: '用户不存在' }); return; }
    if (areFriends(body.from, body.to)) { sendJson(res, 400, { error: '已是好友' }); return; }

    const reqObj = { from: body.from, fromNickname: fromUser.nickname, fromAvatarColor: fromUser.avatarColor, to: body.to, status: 'pending', timestamp: Date.now() };
    if (!friendRequests.has(body.from)) friendRequests.set(body.from, []);
    friendRequests.get(body.from).push(reqObj);
    scheduleSave();

    // 推送给目标用户
    pushEvent(body.to, 'friend_request', reqObj);
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── 接受好友请求 ──
  if (pathname === '/api/friend/accept' && req.method === 'POST') {
    const body = await readBody(req);
    // 找到并更新请求状态
    let found = false;
    friendRequests.forEach((reqs, fromUid) => {
      reqs.forEach(r => {
        if (r.from === body.from && r.to === body.to && r.status === 'pending') {
          r.status = 'accepted';
          addFriendPair(body.from, body.to);
          found = true;
        }
      });
    });
    if (!found) { sendJson(res, 404, { error: '请求不存在' }); return; }
    scheduleSave();

    const accepter = users.get(body.to);
    pushEvent(body.from, 'friend_accepted', { from: body.to, fromNickname: accepter?.nickname, fromAvatarColor: accepter?.avatarColor });
    // 通知双方刷新好友列表
    pushEvent(body.from, 'friends_update', { friends: getFriendsList(body.from) });
    pushEvent(body.to, 'friends_update', { friends: getFriendsList(body.to) });
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── 拒绝好友请求 ──
  if (pathname === '/api/friend/reject' && req.method === 'POST') {
    const body = await readBody(req);
    friendRequests.forEach((reqs) => {
      reqs.forEach(r => {
        if (r.from === body.from && r.to === body.to && r.status === 'pending') r.status = 'rejected';
      });
    });
    scheduleSave();
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── 好友列表 ──
  if (pathname === '/api/friends' && req.method === 'GET') {
    const userId = query.userId;
    sendJson(res, 200, { ok: true, friends: getFriendsList(userId) });
    return;
  }

  // ── 好友请求列表 ──
  if (pathname === '/api/friend/requests' && req.method === 'GET') {
    const userId = query.userId;
    sendJson(res, 200, { ok: true, requests: getPendingRequests(userId) });
    return;
  }

  // ── WebRTC 信令：发送 offer ──
  if (pathname === '/api/call/offer' && req.method === 'POST') {
    const body = await readBody(req);
    const caller = users.get(body.from);
    if (!caller) { sendJson(res, 401, {}); return; }
    pushEvent(body.to, 'call_offer', { from: body.from, fromNickname: caller.nickname, fromAvatarColor: caller.avatarColor, sdp: body.sdp });
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── WebRTC 信令：发送 answer ──
  if (pathname === '/api/call/answer' && req.method === 'POST') {
    const body = await readBody(req);
    pushEvent(body.to, 'call_answer', { from: body.from, sdp: body.sdp });
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── WebRTC 信令：ICE candidate ──
  if (pathname === '/api/call/ice' && req.method === 'POST') {
    const body = await readBody(req);
    pushEvent(body.to, 'call_ice', { from: body.from, candidate: body.candidate });
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── 挂断通话 ──
  if (pathname === '/api/call/end' && req.method === 'POST') {
    const body = await readBody(req);
    pushEvent(body.to, 'call_end', { from: body.from });
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
