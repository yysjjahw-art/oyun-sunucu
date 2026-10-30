// VoxelEdition - Çok oyunculu sunucu (Node.js + WebSocket)
// Özellikler: özel odalar (kod ile), rakip bulma (eşleştirme), veri aktarımı, sohbet
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const MATCH_SIZE = 2;        // rakip bulmada kaç kişi eşleşsin
const PRIVATE_MAX = 8;       // özel odada en fazla oyuncu

// Render'ın sunucuyu kontrol etmesi için basit sayfa
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("VoxelEdition sunucusu calisiyor. Oyuncu: " + clients.size);
});

const wss = new WebSocketServer({ server });

let nextId = 1;
const clients = new Map();   // id -> { id, name, ws, room, alive }
const rooms = new Map();     // code -> { code, players:Set<id>, max, matched }
let queue = [];              // eşleşme bekleyen oyuncu id'leri

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function playerList(room) {
  return [...room.players].map((pid) => ({ id: pid, name: clients.get(pid).name }));
}

function broadcast(room, obj, exceptId) {
  for (const pid of room.players) {
    if (pid === exceptId) continue;
    const c = clients.get(pid);
    if (c) send(c.ws, obj);
  }
}

function joinRoom(client, room, matched) {
  room.players.add(client.id);
  client.room = room.code;
  send(client.ws, {
    type: matched ? "match_found" : "room_joined",
    code: room.code,
    you: client.id,
    players: playerList(room),
  });
  broadcast(room, { type: "player_joined", id: client.id, name: client.name }, client.id);
}

function leaveRoom(client) {
  if (!client.room) return;
  const room = rooms.get(client.room);
  client.room = null;
  if (!room) return;
  room.players.delete(client.id);
  if (room.players.size === 0) {
    rooms.delete(room.code);
  } else {
    broadcast(room, { type: "player_left", id: client.id });
  }
}

function removeFromQueue(id) {
  queue = queue.filter((q) => q !== id);
}

function tryMatch() {
  while (queue.length >= MATCH_SIZE) {
    const group = queue.splice(0, MATCH_SIZE).map((id) => clients.get(id)).filter(Boolean);
    if (group.length < MATCH_SIZE) {
      // biri kopmuş, kalanları kuyruğa geri koy
      queue.unshift(...group.map((g) => g.id));
      break;
    }
    const code = makeCode();
    const room = { code, players: new Set(), max: MATCH_SIZE, matched: true };
    rooms.set(code, room);
    group.forEach((c) => joinRoom(c, room, true));
  }
}

wss.on("connection", (ws) => {
  const client = { id: nextId++, name: "Oyuncu" + (nextId - 1), ws, room: null, alive: true };
  clients.set(client.id, client);
  send(ws, { type: "welcome", id: client.id, name: client.name });

  ws.on("pong", () => (client.alive = true));

  ws.on("message", (raw) => {
    if (raw.length > 8192) return; // çok büyük mesajları yok say
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case "hello": {
        const n = String(msg.name || "").trim().slice(0, 16);
        if (n) client.name = n;
        send(ws, { type: "welcome", id: client.id, name: client.name });
        break;
      }
      case "create_room": {
        leaveRoom(client); removeFromQueue(client.id);
        const room = { code: makeCode(), players: new Set(), max: PRIVATE_MAX, matched: false };
        rooms.set(room.code, room);
        joinRoom(client, room, false);
        break;
      }
      case "join_room": {
        const code = String(msg.code || "").toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) return send(ws, { type: "error", message: "Oda bulunamadi" });
        if (room.players.size >= room.max) return send(ws, { type: "error", message: "Oda dolu" });
        leaveRoom(client); removeFromQueue(client.id);
        joinRoom(client, room, false);
        break;
      }
      case "find_match": {
        leaveRoom(client);
        if (!queue.includes(client.id)) queue.push(client.id);
        send(ws, { type: "searching" });
        tryMatch();
        break;
      }
      case "cancel_match": {
        removeFromQueue(client.id);
        send(ws, { type: "search_cancelled" });
        break;
      }
      case "leave_room": {
        leaveRoom(client);
        send(ws, { type: "left_room" });
        break;
      }
      case "relay": {
        // konum, hareket, blok koyma/kırma gibi her şeyi odadakilere ilet
        const room = client.room && rooms.get(client.room);
        if (room) broadcast(room, { type: "relay", from: client.id, data: msg.data }, client.id);
        break;
      }
      case "chat": {
        const room = client.room && rooms.get(client.room);
        const text = String(msg.text || "").slice(0, 200);
        if (room && text) broadcast(room, { type: "chat", from: client.id, name: client.name, text });
        break;
      }
      case "ping":
        send(ws, { type: "pong" });
        break;
    }
  });

  ws.on("close", () => {
    removeFromQueue(client.id);
    leaveRoom(client);
    clients.delete(client.id);
  });
  ws.on("error", () => {});
});

// Kopan bağlantıları temizle (her 30 saniye)
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch {}
  }
}, 30000);

server.listen(PORT, () => console.log("Sunucu calisiyor, port:", PORT));
