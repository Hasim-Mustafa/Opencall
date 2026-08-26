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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
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
}

wss.on('connection', (socket) => {
  const client = { socket, peerId: makeId(), roomId: null, name: 'Guest' };

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        const roomId = String(msg.room || '').toUpperCase().slice(0, 32);
        if (!roomId) return;

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

  socket.on('close', () => leaveRoom(client));
  socket.on('error', () => leaveRoom(client));
});

server.listen(PORT, () => {
  console.log(`OpenCall running at http://localhost:${PORT}`);
});
