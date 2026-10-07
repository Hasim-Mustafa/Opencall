/**
 * GMST server.
 *
 * Two jobs, neither of which involves your audio or video:
 *   1. Serve the app's files, with security headers.
 *   2. Pass small setup messages between devices so they can open direct,
 *      encrypted connections to each other. Media never touches this server.
 *
 * Who you are, who your friends are and which rooms you belong to live in
 * Supabase. Every room join is checked against it using your login.
 *
 * Run:  npm install && npm start
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PER_ROOM = 6;            // mesh calling degrades past this
const MAX_MESSAGE_BYTES = 64 * 1024;
const HEARTBEAT_MS = 20000;

// The publishable key is public by design; the database's row-level
// security is what actually protects the data.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://digxpaplfwupprgqlrrl.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_CskiJhY892G7-FGU2VgZ-Q_K6JmpNO0';
const SUPABASE_HOST = new URL(SUPABASE_URL).host;
const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const RING_MS = Number(process.env.RING_MS) || 45000; // how long a call rings

// Optional, for ringing phones whose app is closed. Set on Render.
//   SUPABASE_SECRET_KEY   lets the server look up friends' push tokens
//   FCM_SERVICE_ACCOUNT   Firebase service account JSON (raw or base64)
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY || '';
const FCM_SA = (() => {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  for (const text of [raw, Buffer.from(raw, 'base64').toString('utf8')]) {
    try {
      const sa = JSON.parse(text);
      if (sa.client_email && sa.private_key && sa.project_id) return sa;
    } catch {}
  }
  console.error('FCM_SERVICE_ACCOUNT is set but is not a valid service account JSON');
  return null;
})();
const FCM_BASE = process.env.FCM_BASE || 'https://fcm.googleapis.com';

// ======================================================= Supabase checks

async function supa(pathAndQuery, token) {
  const res = await fetch(`${SUPABASE_URL}${pathAndQuery}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}`);
  return res.json();
}

/**
 * Who does this login token belong to? Returns { id, username } or null.
 * The username comes from the profiles table, never from the phone, so
 * nobody can join a call under someone else's name. Cached briefly so a
 * reconnect doesn't cost three round trips.
 */
const userCache = new Map(); // token -> { user, expires }

async function verifyUser(token) {
  if (!token || typeof token !== 'string' || token.length > 4096) return null;
  const hit = userCache.get(token);
  if (hit && hit.expires > Date.now()) return hit.user;
  try {
    const u = await supa('/auth/v1/user', token);
    if (!u || !u.id) return null;
    const rows = await supa(`/rest/v1/profiles?select=username&id=eq.${encodeURIComponent(u.id)}`, token);
    if (!rows.length) return null;
    const user = { id: u.id, username: rows[0].username };
    userCache.set(token, { user, expires: Date.now() + 5 * 60 * 1000 });
    if (userCache.size > 5000) userCache.delete(userCache.keys().next().value);
    return user;
  } catch (err) {
    console.error('verifyUser failed:', err.message);
    return null;
  }
}

/** Which of these rooms is the token holder a member of? (upper-case ids) */
async function memberRooms(roomIds, token) {
  if (!token || !roomIds.length) return new Set();
  try {
    const list = roomIds.map((r) => r.toLowerCase()).join(',');
    const rows = await supa(`/rest/v1/room_members?select=room_id&room_id=in.(${list})`, token);
    return new Set(rows.map((r) => String(r.room_id).toUpperCase()));
  } catch (err) {
    console.error('memberRooms failed:', err.message);
    return new Set();
  }
}

// ================================================== push (ring when closed)

const b64url = (buf) => Buffer.from(buf).toString('base64url');
let fcmToken = { value: null, expires: 0 };

/** OAuth access token for Firebase, from the service account key. */
async function fcmAccessToken() {
  if (fcmToken.value && fcmToken.expires > Date.now() + 60000) return fcmToken.value;
  const now = Math.floor(Date.now() / 1000);
  const aud = FCM_SA.token_uri || 'https://oauth2.googleapis.com/token';
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: FCM_SA.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud, iat: now, exp: now + 3600,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(FCM_SA.private_key, 'base64url');
  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claim}.${sig}`,
    }),
  });
  if (!res.ok) throw new Error(`fcm auth ${res.status}`);
  const j = await res.json();
  fcmToken = { value: j.access_token, expires: Date.now() + (j.expires_in || 3600) * 1000 };
  return fcmToken.value;
}

async function pushTokensFor(userIds) {
  if (!SUPABASE_SECRET || !userIds.length) return [];
  const list = userIds.map(encodeURIComponent).join(',');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/push_tokens?select=token,user_id&user_id=in.(${list})`, {
    headers: { apikey: SUPABASE_SECRET },
  });
  if (!res.ok) throw new Error(`push tokens ${res.status}`);
  return res.json();
}

async function dropPushToken(token) {
  await fetch(`${SUPABASE_URL}/rest/v1/push_tokens?token=eq.${encodeURIComponent(token)}`, {
    method: 'DELETE', headers: { apikey: SUPABASE_SECRET },
  }).catch(() => {});
}

/**
 * Wake these users' phones. Messages are data-only, so the phone's own
 * call code decides what to show:
 *   ring    the full incoming-call screen, ringing until answered
 *   cancel  stop ringing now (answered elsewhere, caller hung up, declined,
 *           nobody answered); turns into "Missed call" where that fits
 */
async function pushTo(userIds, data, ttlSeconds) {
  if (!userIds.length) return;
  if (!FCM_SA || !SUPABASE_SECRET) {
    if (data.type === 'ring') console.log('[push] ring not sent: ringing closed apps is off (check FCM_SERVICE_ACCOUNT and SUPABASE_SECRET_KEY)');
    return;
  }
  try {
    const rows = await pushTokensFor(userIds);
    if (!rows.length) {
      console.log(`[push] ${data.type} not sent: no phones registered for that person (they need the newest APK, opened once, with notifications allowed)`);
      return;
    }
    const access = await fcmAccessToken();
    let sent = 0;
    await Promise.all(rows.map(async ({ token, user_id }) => {
      const payload = { ...data };
      // Each person gets their own key to decline from the notification.
      if (data.type === 'ring' && data.keys) payload.key = data.keys[user_id] || '';
      delete payload.keys;
      for (const k of Object.keys(payload)) payload[k] = String(payload[k] ?? '');
      const res = await fetch(`${FCM_BASE}/v1/projects/${FCM_SA.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: { token, data: payload, android: { priority: 'HIGH', ttl: `${ttlSeconds}s` } },
        }),
      });
      if (res.ok) {
        sent++;
      } else {
        const t = await res.text();
        console.error(`[push] Google refused the ${data.type} (${res.status}): ${t.slice(0, 200)}`);
        if (/UNREGISTERED|INVALID_ARGUMENT.*token/i.test(t)) dropPushToken(token);
      }
    }));
    console.log(`[push] ${data.type} delivered to Google for ${sent} of ${rows.length} phone(s)`);
  } catch (err) {
    console.error('[push] failed:', err.message);
  }
}

const newKey = () => crypto.randomBytes(16).toString('hex');

// ============================================================ HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

/**
 * Content Security Policy: the page may only run its own scripts and talk
 * to this server and Supabase. If someone ever slipped a malicious script
 * in, the browser would refuse to run it or let it send data elsewhere.
 *
 * In browsers, the page's inline scripts are pinned by hash. The Android app
 * gets a looser script rule, because the app framework injects its own
 * bridge script into the page; the connection limits still apply there.
 */
function cspFor(html, host, isApp) {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  const scripts = isApp ? ["'unsafe-inline'"] : hashes;
  return [
    "default-src 'self'",
    `script-src 'self' https://cdn.jsdelivr.net ${scripts.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    `connect-src 'self' wss://${host} ws://${host} https://${SUPABASE_HOST} wss://${SUPABASE_HOST}`,
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
}

function securityHeaders(req) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...(req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted
      ? { 'Strict-Transport-Security': 'max-age=31536000' }
      : {}),
  };
}

/**
 * Declining from the notification while the app is closed. The phone has
 * no login there, so it proves itself with the one-time key that came in
 * that call's ring push.
 */
function handleDecline(req, res) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 2048) req.destroy();
  });
  req.on('end', () => {
    let msg = {};
    try { msg = JSON.parse(body); } catch {}
    const key = String(msg.key || '');
    const ok = (a, b) => a.length === b.length && a.length > 0 && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    const call = calls.get(String(msg.call || '').toUpperCase());
    if (call && !call.answered && ok(key, call.key)) endRinging(String(msg.call).toUpperCase(), 'declined');
    const roomId = String(msg.room || '').toUpperCase();
    const ring = roomRings.get(roomId);
    if (ring) {
      for (const [userId, k] of ring.waiting) if (ok(key, k)) stopRoomRing(roomId, userId, 'declined');
    }
    res.writeHead(204, securityHeaders(req)).end();
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/decline') {
    handleDecline(req, res);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, securityHeaders(req)).end();
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400, securityHeaders(req)).end();
    return;
  }

  // Unknown paths (invite links like /i/abc123) get the app itself.
  let resolved = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) {
    res.writeHead(403, securityHeaders(req)).end();
    return;
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    resolved = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(resolved);
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(500, securityHeaders(req)).end();
      return;
    }
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', ...securityHeaders(req) };
    if (ext === '.html') {
      const isApp = /GMSTApp/.test(req.headers['user-agent'] || '');
      headers['Content-Security-Policy'] = cspFor(data.toString('utf8'), req.headers.host, isApp);
      headers['Cache-Control'] = 'no-cache';
    }
    if (path.basename(resolved) === 'sw.js') headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

// ============================================================ WebSocket

// Only this site and the app may connect. Stops other websites from using
// a visitor's browser to talk to this server.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_MESSAGE_BYTES,
  verifyClient: ({ req }) => originAllowed(req),
});

/** roomId -> Map<peerId, { socket, name, userId }> */
const rooms = new Map();
/** roomId -> Set<socket> of home screens watching who's in that room */
const watchers = new Map();
/** userId -> Set<socket> of that person's home screens (for ringing) */
const userSockets = new Map();
/**
 * Direct calls. callId -> { allowed:Set<userId>, caller:{id,name},
 * callee:{id,name}, answered, timer }
 */
const calls = new Map();
/** Group rings. roomId -> { from, roomName, waiting:Map<userId, declineKey>, timer, expiresAt } */
const roomRings = new Map();

function toUser(userId, payload) {
  for (const socket of userSockets.get(userId) || []) send(socket, payload);
}

function inACall(userId) {
  for (const room of rooms.values()) {
    for (const p of room.values()) if (p.userId === userId) return true;
  }
  return false;
}

function toRoom(roomId, payload) {
  for (const p of (rooms.get(roomId) || new Map()).values()) send(p.socket, payload);
}

/** Everything currently ringing for this person (used to re-sync phones). */
function incomingFor(userId) {
  const out = [];
  for (const [callId, call] of calls) {
    if (!call.answered && call.callee.id === userId) {
      out.push({ type: 'incoming', kind: 'direct', call: callId, from: call.caller.name, expiresAt: call.expiresAt });
    }
  }
  for (const [roomId, ring] of roomRings) {
    if (ring.waiting.has(userId)) {
      out.push({ type: 'incoming', kind: 'room', room: roomId, roomName: ring.roomName, from: ring.from, expiresAt: ring.expiresAt });
    }
  }
  return out;
}

/** A direct call stopped ringing: tell everyone involved and clean up. */
function endRinging(callId, reason) {
  const call = calls.get(callId);
  if (!call || call.answered) return;
  clearTimeout(call.timer);
  call.answered = true; // stops further ringing logic
  call.ended = true;    // the callee can no longer pick up
  toUser(call.callee.id, { type: 'ring-cancel', call: callId, reason });
  toRoom(callId, { type: 'call-update', status: reason, who: call.callee.name });
  pushTo([call.callee.id], { type: 'cancel', call: callId, reason, from: call.caller.name }, 120);
  if (!rooms.get(callId)) calls.delete(callId);
}

/** The person being called picked up: stop their other devices ringing. */
function answeredCall(callId) {
  const call = calls.get(callId);
  if (!call || call.answered) return;
  clearTimeout(call.timer);
  call.answered = true;
  toUser(call.callee.id, { type: 'ring-cancel', call: callId, reason: 'answered' });
  pushTo([call.callee.id], { type: 'cancel', call: callId, reason: 'answered' }, 120);
}

function stopRoomRing(roomId, userId, reason = 'answered') {
  const ring = roomRings.get(roomId);
  if (!ring || !ring.waiting.has(userId)) return;
  ring.waiting.delete(userId);
  toUser(userId, { type: 'ring-cancel', room: roomId, reason });
  pushTo([userId], { type: 'cancel', room: roomId, reason, from: ring.from, roomName: ring.roomName }, 120);
  if (!ring.waiting.size) { clearTimeout(ring.timer); roomRings.delete(roomId); }
}

const makeId = () => 'p' + crypto.randomBytes(6).toString('hex');

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

function roomRoster(roomId, exceptId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return [...room.entries()]
    .filter(([id]) => id !== exceptId)
    .map(([id, peer]) => ({ id, name: peer.name }));
}

function occupancyOf(roomId) {
  const room = rooms.get(roomId);
  return room ? [...room.values()].map((p) => p.name) : [];
}

function broadcastOccupancy(roomId) {
  const set = watchers.get(roomId);
  if (!set) return;
  const people = occupancyOf(roomId);
  for (const socket of set) send(socket, { type: 'occupancy', room: roomId, people });
}

function unwatchAll(client) {
  for (const roomId of client.watching || []) {
    const set = watchers.get(roomId);
    if (!set) continue;
    set.delete(client.socket);
    if (set.size === 0) watchers.delete(roomId);
  }
  client.watching = new Set();
}

function leaveRoom(client) {
  const { roomId, peerId } = client;
  if (!roomId) return;
  const room = rooms.get(roomId);
  client.roomId = null;
  if (!room) return;

  room.delete(peerId);
  const call = calls.get(roomId);
  if (call && !call.answered && client.userId === call.caller.id) endRinging(roomId, 'cancelled');
  if (room.size === 0) {
    rooms.delete(roomId);
    if (call && call.answered) calls.delete(roomId);
    const ring = roomRings.get(roomId);
    if (ring) { for (const u of [...ring.waiting.keys()]) stopRoomRing(roomId, u, 'cancelled'); }
  } else {
    for (const peer of room.values()) send(peer.socket, { type: 'peer-left', id: peerId });
  }
  broadcastOccupancy(roomId);
}

// Phones in the background can vanish without closing their connection.
// Drop sockets that stop answering pings so their tile doesn't freeze.
setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_MS);

wss.on('connection', (socket) => {
  const client = { socket, peerId: makeId(), roomId: null, name: null, watching: new Set() };
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'join': {
        const roomId = String(msg.room || '').toUpperCase();

        // Only real rooms or calls, only for their members, only under
        // your own name.
        if (!UUID_RE.test(roomId)) {
          send(socket, { type: 'denied' });
          return;
        }
        const user = await verifyUser(msg.token);
        const call = calls.get(roomId);
        const allowed = call
          ? !!user && call.allowed.has(user.id) && !(call.ended && user.id === call.callee.id)
          : !!user && (await memberRooms([roomId], msg.token)).has(roomId);
        if (!allowed) {
          send(socket, { type: 'denied' });
          return;
        }
        // The person being called picked up.
        if (call && !call.answered && user.id === call.callee.id) answeredCall(roomId);
        stopRoomRing(roomId, user.id, 'answered');

        leaveRoom(client);
        if (!rooms.has(roomId)) rooms.set(roomId, new Map());
        const room = rooms.get(roomId);
        if (room.size >= MAX_PER_ROOM) {
          send(socket, { type: 'room-full', limit: MAX_PER_ROOM });
          return;
        }

        client.roomId = roomId;
        client.name = user.username;
        client.userId = user.id;

        // The newcomer sends the offers, so only one side ever initiates.
        send(socket, {
          type: 'joined',
          id: client.peerId,
          room: roomId,
          name: client.name,
          peers: roomRoster(roomId, client.peerId),
        });
        for (const peer of room.values()) {
          send(peer.socket, { type: 'peer-joined', id: client.peerId, name: client.name });
        }
        room.set(client.peerId, { socket, name: client.name, userId: user.id });
        console.log(`[room ${roomId.slice(0, 8)}] ${client.name} joined, ${room.size} present`);
        broadcastOccupancy(roomId);
        break;
      }

      // Home screen: who's in my rooms, now and as it changes.
      case 'watch': {
        unwatchAll(client);
        const me = await verifyUser(msg.token);
        if (me && client.homeUser !== me.id) {
          client.homeUser = me.id;
          if (!userSockets.has(me.id)) userSockets.set(me.id, new Set());
          userSockets.get(me.id).add(socket);
        }
        // Whatever is ringing right now, so a phone that was asleep or
        // offline shows live calls and drops ones that already ended.
        if (me) send(socket, { type: 'rings', active: incomingFor(me.id) });
        const ids = (Array.isArray(msg.rooms) ? msg.rooms : [])
          .slice(0, 100)
          .map((r) => String(r).toUpperCase())
          .filter((r) => UUID_RE.test(r));
        const allowed = await memberRooms(ids, msg.token);
        for (const roomId of ids) {
          if (!allowed.has(roomId)) continue;
          if (!watchers.has(roomId)) watchers.set(roomId, new Set());
          watchers.get(roomId).add(socket);
          client.watching.add(roomId);
          send(socket, { type: 'occupancy', room: roomId, people: occupancyOf(roomId) });
        }
        break;
      }

      // Call a friend. Both must be friends; the call gets a fresh private id
      // only the two of you may join.
      case 'ring': {
        const me = await verifyUser(msg.token);
        const to = String(msg.to || '').toLowerCase();
        if (!me || !/^[0-9a-f-]{36}$/.test(to) || to === me.id) return;
        const [a, b] = me.id < to ? [me.id, to] : [to, me.id];
        let friends = [];
        try {
          friends = await supa(`/rest/v1/friendships?select=status&user_a=eq.${a}&user_b=eq.${b}`, msg.token);
        } catch {}
        if (!friends.length || friends[0].status !== 'accepted') {
          send(socket, { type: 'ring-failed', reason: 'not-friends' });
          return;
        }
        let calleeName = 'friend';
        try {
          const rows = await supa(`/rest/v1/profiles?select=username&id=eq.${to}`, msg.token);
          if (rows.length) calleeName = rows[0].username;
        } catch {}
        if (inACall(to)) {
          send(socket, { type: 'ring-failed', reason: 'busy', who: calleeName });
          return;
        }

        const callId = crypto.randomUUID().toUpperCase();
        const call = {
          allowed: new Set([me.id, to]),
          caller: { id: me.id, name: me.username },
          callee: { id: to, name: calleeName },
          answered: false,
          key: newKey(),
          expiresAt: Date.now() + RING_MS,
        };
        call.timer = setTimeout(() => endRinging(callId, 'no-answer'), RING_MS);
        calls.set(callId, call);

        send(socket, { type: 'ringing', call: callId, to: calleeName });
        toUser(to, { type: 'incoming', call: callId, from: me.username, kind: 'direct', expiresAt: call.expiresAt });
        pushTo([to], {
          type: 'ring', kind: 'direct', call: callId, from: me.username,
          expiresAt: call.expiresAt, keys: { [to]: call.key },
        }, Math.ceil(RING_MS / 1000));
        console.log(`[call] ${me.username} -> ${calleeName}`);
        break;
      }

      // Ring everyone in a room who isn't already in its call.
      case 'ring-room': {
        const me = await verifyUser(msg.token);
        const roomId = String(msg.room || '').toUpperCase();
        if (!me || !UUID_RE.test(roomId)) return;
        if (!(await memberRooms([roomId], msg.token)).has(roomId)) return;
        let members = [], roomName = 'Room';
        try {
          members = (await supa(`/rest/v1/room_members?select=user_id&room_id=eq.${roomId.toLowerCase()}`, msg.token))
            .map((r) => r.user_id);
          const r = await supa(`/rest/v1/rooms?select=name&id=eq.${roomId.toLowerCase()}`, msg.token);
          if (r.length) roomName = r[0].name;
        } catch {}
        const present = new Set([...(rooms.get(roomId) || new Map()).values()].map((p) => p.userId));
        const targets = members.filter((u) => u !== me.id && !present.has(u));
        if (!targets.length) return;

        const prev = roomRings.get(roomId);
        if (prev) clearTimeout(prev.timer);
        const ring = {
          from: me.username, roomName,
          waiting: new Map(targets.map((u) => [u, newKey()])),
          expiresAt: Date.now() + RING_MS,
        };
        ring.timer = setTimeout(() => {
          for (const u of [...ring.waiting.keys()]) stopRoomRing(roomId, u, 'no-answer');
        }, RING_MS);
        roomRings.set(roomId, ring);

        for (const u of targets) {
          toUser(u, { type: 'incoming', room: roomId, roomName, from: me.username, kind: 'room', expiresAt: ring.expiresAt });
        }
        pushTo(targets, {
          type: 'ring', kind: 'room', room: roomId, roomName, from: me.username,
          expiresAt: ring.expiresAt, keys: Object.fromEntries(ring.waiting),
        }, Math.ceil(RING_MS / 1000));
        send(socket, { type: 'ringing-room', room: roomId, count: targets.length });
        console.log(`[ring] ${me.username} rang ${targets.length} in ${roomName}`);
        break;
      }

      case 'decline': {
        const me = await verifyUser(msg.token);
        if (!me) return;
        const callId = String(msg.call || '').toUpperCase();
        const call = calls.get(callId);
        if (call && call.callee.id === me.id) endRinging(callId, 'declined');
        const roomId = String(msg.room || '').toUpperCase();
        if (roomRings.has(roomId)) stopRoomRing(roomId, me.id, 'declined');
        break;
      }

      // Connection setup messages, passed only to someone in the same room.
      case 'signal': {
        const room = rooms.get(client.roomId);
        const target = room && room.get(msg.to);
        if (!target) return;
        send(target.socket, { type: 'signal', from: client.peerId, data: msg.data });
        break;
      }

      // Mute / camera / screen-share state, mirrored to the room.
      case 'state': {
        const room = rooms.get(client.roomId);
        if (!room) return;
        const state = {
          mic: !!(msg.state && msg.state.mic),
          cam: !!(msg.state && msg.state.cam),
          sharing: !!(msg.state && msg.state.sharing),
        };
        for (const [id, peer] of room.entries()) {
          if (id !== client.peerId) send(peer.socket, { type: 'state', from: client.peerId, state });
        }
        break;
      }

      case 'ping':
        send(socket, { type: 'pong' });
        break;
    }
  });

  const done = () => {
    leaveRoom(client);
    unwatchAll(client);
    if (client.homeUser) {
      const set = userSockets.get(client.homeUser);
      if (set) { set.delete(socket); if (!set.size) userSockets.delete(client.homeUser); }
    }
  };
  socket.on('close', done);
  socket.on('error', done);
});

server.listen(PORT, () => {
  console.log(`GMST running on port ${PORT}`);
  console.log(FCM_SA && SUPABASE_SECRET
    ? 'Ringing closed apps: on'
    : 'Ringing closed apps: off (set FCM_SERVICE_ACCOUNT and SUPABASE_SECRET_KEY to enable)');
});
