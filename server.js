// MoMinecraft online sunucu (Render): LOBI (herkes ayni odada) + BedWars ve DUELS 1v1 2 kisilik eslesme (her oyunun kendi kuyrugu var).
// Baslatma: npm start   (Node 18+)   Saglik kontrolu: GET /
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const LOBBY_MAX = 40;
const MATCH_SIZE = 2;

let nextId = 1;
const clients = new Map();   // ws -> {id, name, room, alive}
const rooms = new Map();     // oda adi -> Set<ws>     ("lobby" ve "m-xxxx")
const queues = { bedwars: [], duels: [] };   // oyuna gore eslesme bekleyenler (ws)
function dequeue(ws) {
  for (const g of Object.keys(queues)) queues[g] = queues[g].filter((w) => w !== ws);
}
let matchCounter = 1;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, online: clients.size, lobby: (rooms.get("lobby") || new Set()).size, queue: { bedwars: queues.bedwars.length, duels: queues.duels.length }, playing: (() => { const s = statsNow(); return { bedwars: s.bedwars, duels: s.duels }; })() }));
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
// Oyunda kac kisi var: BedWars odalari ("m-..."), Duels odalari ("d-...") + eslesme kuyrugunda bekleyenler.
function statsNow() {
  let bedwars = queues.bedwars.length;
  let duels = queues.duels.length;
  for (const [, c] of clients) {
    if (!c.room) continue;
    if (c.room.startsWith("m-")) bedwars++;
    else if (c.room.startsWith("d-")) duels++;
  }
  return { type: "stats", bedwars, duels, lobby: (rooms.get("lobby") || new Set()).size, online: clients.size };
}
function listOf(room) {
  const out = [];
  for (const w of rooms.get(room) || []) {
    const c = clients.get(w);
    if (c) out.push({ id: c.id, name: c.name });
  }
  return out;
}
function leaveRoom(ws) {
  const c = clients.get(ws);
  if (!c || !c.room) return;
  const set = rooms.get(c.room);
  const old = c.room;
  c.room = null;
  if (set) {
    set.delete(ws);
    for (const w of set) send(w, { type: "player_left", id: c.id });
    if (set.size === 0) rooms.delete(old);
  }
}
function joinRoom(ws, room) {
  const c = clients.get(ws);
  leaveRoom(ws);
  if (!rooms.has(room)) rooms.set(room, new Set());
  const set = rooms.get(room);
  for (const w of set) send(w, { type: "player_joined", id: c.id, name: c.name });
  set.add(ws);
  c.room = room;
}
function cleanName(v) {
  let s = String(v || "Oyuncu").replace(/[^\p{L}\p{N} _\-.]/gu, "").trim().slice(0, 16);
  return s || "Oyuncu";
}

wss.on("connection", (ws) => {
  const c = { id: nextId++, name: "Oyuncu", room: null, alive: true };
  clients.set(ws, c);
  send(ws, { type: "welcome", id: c.id });

  ws.on("pong", () => { c.alive = true; });
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "hello":
        c.name = cleanName(msg.name);
        break;
      case "join_lobby": {
        dequeue(ws);
        const lobby = rooms.get("lobby");
        if (lobby && lobby.size >= LOBBY_MAX && !lobby.has(ws)) {
          send(ws, { type: "error", message: "Lobi dolu" });
          break;
        }
        joinRoom(ws, "lobby");
        send(ws, { type: "lobby_joined", you: c.id, players: listOf("lobby") });
        break;
      }
      case "leave_lobby":
        if (c.room === "lobby") leaveRoom(ws);
        break;
      case "find_match": {
        leaveRoom(ws);                       // lobiden cik
        dequeue(ws);
        const game = msg.game === "duels" ? "duels" : "bedwars";   // eski istemci game gondermez -> bedwars
        const queue = queues[game];
        queue.push(ws);
        if (queue.length >= MATCH_SIZE) {
          const group = queue.splice(0, MATCH_SIZE);
          const code = (game === "duels" ? "d-" : "m-") + (matchCounter++);
          group.forEach((w) => joinRoom(w, code));
          const players = listOf(code);
          group.forEach((w) => send(w, { type: "match_found", code, game, you: clients.get(w).id, players }));
        } else {
          send(ws, { type: "searching" });
        }
        break;
      }
      case "stats":
        send(ws, statsNow());
        break;
      case "cancel_match":
        dequeue(ws);
        break;
      case "leave_room":
        dequeue(ws);
        leaveRoom(ws);
        break;
      case "relay": {
        const set = c.room && rooms.get(c.room);
        if (!set || typeof msg.data !== "object") break;
        const out = JSON.stringify({ type: "relay", from: c.id, data: msg.data });
        for (const w of set) if (w !== ws && w.readyState === 1) w.send(out);
        break;
      }
    }
  });
  ws.on("close", () => {
    dequeue(ws);
    leaveRoom(ws);
    clients.delete(ws);
  });
  ws.on("error", () => {});
});

// Render bosta kalan baglantiyi kapatmasin + olu baglantilari temizle
setInterval(() => {
  for (const [ws, c] of clients) {
    if (!c.alive) { ws.terminate(); continue; }
    c.alive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 25000);

server.listen(PORT, () => console.log("MoMinecraft sunucu hazir, port " + PORT));
