// remote/server.js — EnjoySubs Phone Remote Relay
// Relays WebSocket messages between the Chrome extension and the phone remote UI.
// Also serves the phone.html page.

const http = require('http');
const fs   = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 9876;

// ── Rooms: map roomCode → Set of { ws, role } ──────────────────
const rooms = new Map();

// ── HTTP server ─────────────────────────────────────────────────
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
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket server (using ws package) ─────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const room = url.searchParams.get('room') || '';
  const role = url.searchParams.get('role') || 'unknown';

  if (!room || room.length < 3) { ws.close(); return; }

  const conn = { ws, role };
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(conn);

  console.log(`[+] ${role} joined room "${room}" (${rooms.get(room).size} in room)`);

  // Notify peers
  broadcast(room, conn, JSON.stringify({ type: 'PEER_JOINED', role }));

  ws.on('message', (data) => {
    const msg = typeof data === 'string' ? data : data.toString();
    broadcast(room, conn, msg);
  });

  ws.on('close', () => cleanup(conn, room));
  ws.on('error', () => cleanup(conn, room));
});

function broadcast(room, sender, msg) {
  const peers = rooms.get(room);
  if (!peers) return;
  for (const peer of peers) {
    if (peer === sender) continue;
    if (peer.ws.readyState === WebSocket.OPEN) {
      try { peer.ws.send(msg); } catch (_) {}
    }
  }
}

function cleanup(conn, room) {
  const peers = rooms.get(room);
  if (peers) {
    peers.delete(conn);
    broadcast(room, conn, JSON.stringify({ type: 'PEER_LEFT', role: conn.role }));
    if (peers.size === 0) rooms.delete(room);
    else console.log(`[-] ${conn.role} left room "${room}" (${peers.size} remain)`);
  }
}

// Heartbeat: close dead connections every 30s
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// ── Start ────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  EnjoySubs Remote Relay');
  console.log('  ----------------------');
  console.log(`  Listening on port ${PORT}`);
  console.log('');
});
