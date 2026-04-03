// remote/server.js — EnjoySubs Phone Remote Relay
// Run: node remote/server.js
// Relays WebSocket messages between the Chrome extension and the phone remote UI.
// Also serves the phone.html page.

const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 9876;

// ── Rooms: map roomCode → Set of WebSocket connections ──────────
const rooms = new Map();

// ── HTTP server: serves phone.html + shows local IP ─────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/phone.html') || req.url.startsWith('/?')) {
    const filePath = path.join(__dirname, 'phone.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    });
    return;
  }
  // Health check
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket server (raw, no dependencies) ─────────────────────
// Minimal WebSocket implementation using Node's built-in crypto

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  // Parse room from URL: ws://host:port/ws?room=XXXX
  const url = new URL(req.url, 'http://localhost');
  const room = url.searchParams.get('room') || '';
  if (!room || room.length < 3) {
    socket.destroy();
    return;
  }

  // Parse role: 'extension' or 'phone'
  const role = url.searchParams.get('role') || 'unknown';

  // WebSocket handshake
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5515BE7AFA13')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n' +
    '\r\n'
  );

  // Track connection
  const conn = { socket, room, role, alive: true };
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(conn);

  console.log(`[+] ${role} joined room "${room}" (${rooms.get(room).size} in room)`);

  // Notify peers that someone joined
  broadcast(room, conn, JSON.stringify({ type: 'PEER_JOINED', role }));

  // Handle incoming data
  let buffer = Buffer.alloc(0);

  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);

    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      const totalLen = offset + maskLen + payloadLen;
      if (buffer.length < totalLen) return;

      // Close frame
      if (opcode === 0x8) {
        cleanup(conn);
        return;
      }

      // Ping → Pong
      if (opcode === 0x9) {
        const pong = Buffer.alloc(2);
        pong[0] = 0x8a; // fin + pong
        pong[1] = 0;
        try { socket.write(pong); } catch (_) {}
        buffer = buffer.slice(totalLen);
        continue;
      }

      // Pong
      if (opcode === 0xa) {
        conn.alive = true;
        buffer = buffer.slice(totalLen);
        continue;
      }

      // Text frame
      if (opcode === 0x1) {
        let payload = buffer.slice(offset + maskLen, offset + maskLen + payloadLen);
        if (masked) {
          const mask = buffer.slice(offset, offset + 4);
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= mask[i & 3];
          }
        }
        const msg = payload.toString('utf8');
        // Forward to all other connections in the same room
        broadcast(room, conn, msg);
      }

      buffer = buffer.slice(totalLen);
    }
  });

  socket.on('close', () => cleanup(conn));
  socket.on('error', () => cleanup(conn));
});

function broadcast(room, sender, msg) {
  const peers = rooms.get(room);
  if (!peers) return;
  const frame = encodeFrame(msg);
  for (const peer of peers) {
    if (peer === sender) continue;
    try { peer.socket.write(frame); } catch (_) {}
  }
}

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // fin + text
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function cleanup(conn) {
  try { conn.socket.destroy(); } catch (_) {}
  const peers = rooms.get(conn.room);
  if (peers) {
    peers.delete(conn);
    broadcast(conn.room, conn, JSON.stringify({ type: 'PEER_LEFT', role: conn.role }));
    if (peers.size === 0) rooms.delete(conn.room);
    else console.log(`[-] ${conn.role} left room "${conn.room}" (${peers.size} remain)`);
  }
}

// Heartbeat: ping all connections every 30s, drop dead ones
setInterval(() => {
  for (const [, peers] of rooms) {
    for (const conn of peers) {
      if (!conn.alive) { cleanup(conn); continue; }
      conn.alive = false;
      const ping = Buffer.alloc(2);
      ping[0] = 0x89;
      ping[1] = 0;
      try { conn.socket.write(ping); } catch (_) { cleanup(conn); }
    }
  }
}, 30000);

// ── Start ────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  EnjoySubs Remote Relay');
  console.log('  ----------------------');
  console.log(`  Listening on port ${PORT}`);
  console.log('');
});
