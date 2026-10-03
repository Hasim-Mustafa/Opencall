/**
 * OpenCall signaling server.
 *
 * This server never touches audio or video. It only passes small text
 * messages between browsers so they can find each other and open direct
 * peer-to-peer connections. Media flows browser-to-browser after that.
 *
 * Run:  npm install && npm start
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PER_ROOM = 6; // mesh topology degrades past this

// Supabase holds accounts, friends and rooms. The publishable key is public
// by design; the database's row-level security does the real protecting.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://digxpaplfwupprgqlrrl.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_CskiJhY892G7-FGU2VgZ-Q_K6JmpNO0';
const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

/**
 * Is the holder of this login token a member of this room?
 * Asks Supabase as that user: the room_members table only shows rows for
 * rooms you belong to, so any row back means yes.
 */
async function isRoomMember(roomId, token) {
  if (!token) return false;
  try {
    const url = `${SUPABASE_URL}/rest/v1/room_members?select=room_id&room_id=eq.${roomId.toLowerCase()}&limit=1`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    console.error('membership check failed', err.message);
    return false;
  }
}

/** roomId -> Set<socket> of home screens watching who's in that room */
const watchers = new Map();

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

// ---------------------------------------------------------------- HTTP

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // Any unknown path serves the app, so /ABC-123 works as a join link.
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  let resolved = path.join(PUBLIC_DIR, filePath);

  // Block path traversal.
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    resolved = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(resolved);
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(500).end('Server error');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ----------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ server });

/** roomId -> Map<peerId, { socket, name }> */
const rooms = new Map();

let nextId = 1;
const makeId = () => `p${nextId++}`;

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function roomRoster(roomId, exceptId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return [...room.entries()]
    .filter(([id]) => id !== exceptId)
    .map(([id, peer]) => ({ id, name: peer.name }));
}

function leaveRoom(client) {
  const { roomId, peerId } = client;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  room.delete(peerId);

  if (room.size === 0) {
    rooms.delete(roomId);
    console.log(`[room ${roomId}] closed`);
  } else {
    for (const peer of room.values()) {
      send(peer.socket, { type: 'peer-left', id: peerId });
    }
    console.log(`[room ${roomId}] ${peerId} left, ${room.size} remain`);
  }

  client.roomId = null;
  broadcastOccupancy(roomId);
}

// Phones that go to the background can vanish without closing their
// connection. Ping every socket; drop any that don't answer, so their
// tile disappears for everyone instead of freezing.
const HEARTBEAT_MS = 20000;
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
  const client = { socket, peerId: makeId(), roomId: null, name: 'Guest' };
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        const roomId = String(msg.room || '').toUpperCase().slice(0, 64);
        if (!roomId) return;

        // Account rooms are private: only members get in.
        if (UUID_RE.test(roomId) && !(await isRoomMember(roomId, msg.token))) {
          send(socket, { type: 'denied' });
          return;
        }

        leaveRoom(client);

        if (!rooms.has(roomId)) rooms.set(roomId, new Map());
        const room = rooms.get(roomId);

        if (room.size >= MAX_PER_ROOM) {
          send(socket, { type: 'room-full', limit: MAX_PER_ROOM });
          return;
        }

        client.roomId = roomId;
        client.name = String(msg.name || 'Guest').slice(0, 24);

        // Tell the newcomer who is already here. The newcomer sends the
        // offers, so only one side ever initiates and there is no glare.
        send(socket, {
          type: 'joined',
          id: client.peerId,
          room: roomId,
          peers: roomRoster(roomId, client.peerId),
        });

        for (const peer of room.values()) {
          send(peer.socket, {
            type: 'peer-joined',
            id: client.peerId,
            name: client.name,
          });
        }

        room.set(client.peerId, { socket, name: client.name });
        console.log(`[room ${roomId}] ${client.peerId} (${client.name}) joined, ${room.size} present`);
        broadcastOccupancy(roomId);
        break;
      }

      // Home screen: tell me who's in these rooms, now and as it changes.
      case 'watch': {
        unwatchAll(client);
        const ids = (Array.isArray(msg.rooms) ? msg.rooms : [])
          .slice(0, 100)
          .map((r) => String(r).toUpperCase())
          .filter((r) => UUID_RE.test(r));
        for (const roomId of ids) {
          if (!watchers.has(roomId)) watchers.set(roomId, new Set());
          watchers.get(roomId).add(socket);
          client.watching.add(roomId);
          send(socket, { type: 'occupancy', room: roomId, people: occupancyOf(roomId) });
        }
        break;
      }

      // Blind relay of SDP offers, answers and ICE candidates.
      case 'signal': {
        const room = rooms.get(client.roomId);
        if (!room) return;
        const target = room.get(msg.to);
        if (!target) return;
        send(target.socket, {
          type: 'signal',
          from: client.peerId,
          data: msg.data,
        });
        break;
      }

      // Mute / camera / screen-share state, mirrored to the room.
      case 'state': {
        const room = rooms.get(client.roomId);
        if (!room) return;
        for (const [id, peer] of room.entries()) {
          if (id === client.peerId) continue;
          send(peer.socket, { type: 'state', from: client.peerId, state: msg.state });
        }
        break;
      }

      case 'ping':
        send(socket, { type: 'pong' });
        break;
    }
  });

  socket.on('close', () => { leaveRoom(client); unwatchAll(client); });
  socket.on('error', () => { leaveRoom(client); unwatchAll(client); });
});

server.listen(PORT, () => {
  console.log(`OpenCall running at http://localhost:${PORT}`);
});
