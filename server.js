// MoMinecraft online sunucu (Render): LOBI + ARENA PVP (herkes ayni odada) + BedWars ve DUELS 1v1 2 kisilik eslesme (her oyunun kendi kuyrugu var).
// Baslatma: npm start   (Node 18+)   Saglik kontrolu: GET /
const http = require("http");
const { WebSocketServer } = require("ws");
const AUTH = require("./auth");
const SOCIAL = require("./social");
const REQUIRE_LOGIN = process.env.REQUIRE_LOGIN !== "0";   // giris yapmayan oyuncu lobiye / eslesmeye giremez

const PORT = process.env.PORT || 3000;
const LOBBY_MAX = 40;
const ARENA_MAX = 30;            // Arena PvP: herkes ayni acik arenada (eslesme yok)
const MATCH_SIZE = 2;            // Duels 1v1
const BW_MAX = 8;               // BedWars: en fazla 8 oyuncu (1/8)
const BW_MIN = 2;               // 2 oyuncu olunca sayim baslar
const BW_COUNTDOWN = 30;        // saniye
const BW_TEAM_ORDER = [3, 5, 2, 4, 0, 6, 1, 7];   // SOLO: her oyuncu ayri takim/ada (ilk iki oyuncu karsi adalarda)

let nextId = 1;
const clients = new Map();   // ws -> {id, name, room, alive}
const rooms = new Map();     // oda adi -> Set<ws>     ("lobby" ve "m-xxxx")
const queues = { bedwars: [], duels: [] };   // oyuna gore eslesme bekleyenler (ws)
function dequeue(ws) {
  const had = queues.bedwars.includes(ws);
  for (const g of Object.keys(queues)) queues[g] = queues[g].filter((w) => w !== ws);
  if (had) bwUpdate();
}
// ---- BedWars bekleme odasi: 1/8, 2 oyuncuda 30 sn, 8 oyuncuda hemen
let bwTimer = null;
let bwStartAt = 0;
function bwBroadcast() {
  const q = queues.bedwars;
  const names = q.map((w) => (clients.get(w) || {}).name || "Oyuncu");
  const left = bwTimer ? Math.max(0, Math.ceil((bwStartAt - Date.now()) / 1000)) : -1;
  q.forEach((w) => send(w, { type: "queue", game: "bedwars", count: q.length, need: BW_MAX, min: BW_MIN, countdown: left, names }));
}
function bwUpdate() {
  const q = queues.bedwars;
  if (q.length >= BW_MAX) { bwStart(); return; }
  if (q.length >= BW_MIN && !bwTimer) {
    bwStartAt = Date.now() + BW_COUNTDOWN * 1000;
    bwTimer = setTimeout(bwStart, BW_COUNTDOWN * 1000);
  } else if (q.length < BW_MIN && bwTimer) {
    clearTimeout(bwTimer);
    bwTimer = null;
  }
  bwBroadcast();
}
function bwStart() {
  if (bwTimer) { clearTimeout(bwTimer); bwTimer = null; }
  if (queues.bedwars.length < BW_MIN) { bwBroadcast(); return; }
  const group = queues.bedwars.splice(0, BW_MAX);
  const code = "m-" + (matchCounter++);
  group.forEach((w, i) => { clients.get(w).team = BW_TEAM_ORDER[i % BW_TEAM_ORDER.length]; });
  group.forEach((w) => joinRoom(w, code));
  const players = listOf(code);
  group.forEach((w) => send(w, { type: "match_found", code, game: "bedwars", you: clients.get(w).id, players }));
  if (queues.bedwars.length > 0) bwUpdate();
}
let matchCounter = 1;

const server = http.createServer(async (req, res) => {
  if (await AUTH.handleHttp(req, res)) return;
  if (await SOCIAL.handleHttp(req, res)) return;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, online: clients.size, lobby: (rooms.get("lobby") || new Set()).size, arena: (rooms.get("arena") || new Set()).size, queue: { bedwars: queues.bedwars.length, duels: queues.duels.length }, playing: (() => { const s = statsNow(); return { bedwars: s.bedwars, duels: s.duels }; })() }));
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });

// Bir OP rank verince / alinca: o oyuncu su an bagliysa rankini guncelle, kendisine ve odadaki herkese haber ver.
AUTH.setRankListener((name, rank) => {
  const low = String(name).toLowerCase();
  for (const [ws, c] of clients) {
    if (!c.authed || String(c.name).toLowerCase() !== low) continue;
    c.rank = rank;
    const msg = { type: "rank", id: c.id, rank };
    send(ws, msg);
    const set = c.room && rooms.get(c.room);
    if (set) for (const w of set) if (w !== ws) send(w, msg);
  }
});

// Bir OP susturunca / susturmayi kaldirinca: o oyuncu su an bagliysa hemen haber ver (sohbet mesajlari sunucuda zaten engellenir)
const muteMsg = (m) => (m ? { left: Math.max(1, Math.ceil((m.until - Date.now()) / 1000)), by: m.by, reason: m.reason } : { left: 0 });
AUTH.setMuteListener((name, info) => {
  const low = String(name).toLowerCase();
  for (const [ws, c] of clients) {
    if (!c.authed || String(c.name).toLowerCase() !== low) continue;
    c.mute = info;
    send(ws, { type: "mute", ...muteMsg(info) });
  }
});

// Bir OP banlayinca: o oyuncu su an bagliysa "banned" mesaji gonder ve baglantiyi kes.
AUTH.setBanListener((name, info) => {
  const low = String(name).toLowerCase();
  for (const [ws, c] of clients) {
    if (String(c.name).toLowerCase() !== low) continue;
    send(ws, { type: "banned", by: info.by, reason: info.reason, perm: !!info.perm, left: Math.max(1, Math.ceil((info.until - Date.now()) / 1000)) });
    setTimeout(() => { try { ws.close(); } catch (e) {} }, 400);
  }
});

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
  return { type: "stats", bedwars, duels, lobby: (rooms.get("lobby") || new Set()).size, arena: (rooms.get("arena") || new Set()).size, online: clients.size };
}
function listOf(room) {
  const out = [];
  for (const w of rooms.get(room) || []) {
    const c = clients.get(w);
    if (c) out.push({ id: c.id, name: c.name, team: c.team, rank: c.rank || "" });
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
  for (const w of set) send(w, { type: "player_joined", id: c.id, name: c.name, rank: c.rank || "" });
  set.add(ws);
  c.room = room;
}
function cleanName(v) {
  let s = String(v || "Oyuncu").replace(/[^\p{L}\p{N} _\-.]/gu, "").trim().slice(0, 16);
  return s || "Oyuncu";
}

// ---- SESLI SOHBET (v180): SES KANALLARI. "Genel" herkese acik; oyuncular sifreli / sifresiz oda kurabilir.
// Ses paketi: istemciden [0x01][seq][u-law ses...]  ->  ayni KANALDAKI digerlerine [0x01][gonderen id u32 LE][seq][u-law ses...]
// Ses sunucuda islenmez / kaydedilmez, sadece iletilir. Susturulmus (/mute) oyuncunun sesi de kimseye gitmez.
const crypto = require("crypto");
const VOICE_MAX_BYTES = 1500;      // tek paket ust siniri (normal paket ~642 bayt = 40 ms)
const VOICE_MAX_PER_SEC = 60;      // spam / sel korumasi (normal ~25 paket/sn)
const VOICE_GENEL_MAX = 30;        // Genel kanal en fazla 30 kisi
const VOICE_ROOM_MAX = 10;         // kurulan oda en fazla 10 kisi
const VOICE_ROOMS_LIMIT = 40;      // ayni anda en fazla 40 oda
const vrooms = new Map();          // kanal id -> {id, name, pass(hash|null), max, members:Set<ws>, ownerName, fixed}
vrooms.set("genel", { id: "genel", name: "Genel", pass: null, max: VOICE_GENEL_MAX, members: new Set(), ownerName: "", fixed: true });
let vCounter = 1;
const hashPass = (p) => crypto.createHash("sha256").update("vc:" + p).digest("hex");
function vInfo(r) { return { id: r.id, name: r.name, count: r.members.size, max: r.max, locked: !!r.pass, owner: r.ownerName }; }
function vMembers(r) {
  const out = [];
  for (const w of r.members) { const c = clients.get(w); if (c) out.push({ id: c.id, name: c.name }); }
  return out;
}
function vBroadcast(r) {
  const m = vMembers(r);
  for (const w of r.members) send(w, { type: "voice_update", id: r.id, name: r.name, members: m });
}
function vLeave(ws) {
  const c = clients.get(ws);
  if (!c || !c.voice) return;
  const r = vrooms.get(c.voice);
  c.voice = null;
  if (!r) return;
  r.members.delete(ws);
  if (!r.fixed && r.members.size === 0) vrooms.delete(r.id);   // bos oda silinir
  else vBroadcast(r);
}
function vEnter(ws, c, r) {
  if (c.voice !== r.id) { vLeave(ws); r.members.add(ws); c.voice = r.id; }
  send(ws, { type: "voice_joined", id: r.id, name: r.name, locked: !!r.pass, members: vMembers(r) });
  vBroadcast(r);
}
function vList() {
  const arr = [...vrooms.values()];
  arr.sort((x, y) => (y.fixed ? 1 : 0) - (x.fixed ? 1 : 0));   // Genel hep ilk
  return arr.map(vInfo);
}
function cleanRoomName(v) {
  return String(v || "").replace(/[^\p{L}\p{N} _\-.]/gu, "").replace(/\s+/g, " ").trim().slice(0, 16);
}
function voiceMsg(ws, c, msg) {
  if (REQUIRE_LOGIN && !c.authed) { send(ws, { type: "voice_error", message: "Giris gerekli" }); return; }
  switch (msg.type) {
    case "voice_list":
      send(ws, { type: "voice_list", rooms: vList(), you: c.voice || "" });
      break;
    case "voice_join": {
      const r = vrooms.get(String(msg.id || ""));
      if (!r) { send(ws, { type: "voice_error", message: "Oda bulunamadi" }); break; }
      if (c.voice !== r.id) {
        if (r.members.size >= r.max) { send(ws, { type: "voice_error", message: "Oda dolu" }); break; }
        if (r.pass && hashPass(String(msg.pass || "").slice(0, 16)) !== r.pass) { send(ws, { type: "voice_error", message: "Sifre yanlis" }); break; }
      }
      vEnter(ws, c, r);
      break;
    }
    case "voice_create": {
      const name = cleanRoomName(msg.name);
      if (name.length < 2) { send(ws, { type: "voice_error", message: "Oda adi en az 2 harf olmali" }); break; }
      if (vrooms.size >= VOICE_ROOMS_LIMIT) { send(ws, { type: "voice_error", message: "Cok fazla oda var, biraz sonra dene" }); break; }
      for (const r0 of vrooms.values()) if (r0.name.toLowerCase() === name.toLowerCase()) { send(ws, { type: "voice_error", message: "Bu isimde bir oda var" }); return; }
      const pw = String(msg.pass || "").slice(0, 16);
      const r = { id: "v-" + (vCounter++), name, pass: pw ? hashPass(pw) : null, max: VOICE_ROOM_MAX, members: new Set(), ownerName: c.name, fixed: false };
      vrooms.set(r.id, r);
      vEnter(ws, c, r);
      break;
    }
    case "voice_leave":
      vLeave(ws);
      send(ws, { type: "voice_left" });
      break;
  }
}
function relayVoice(ws, c, buf) {
  if (!c.voice || !Buffer.isBuffer(buf)) return;
  if (REQUIRE_LOGIN && !c.authed) return;
  if (buf.length < 3 || buf.length > VOICE_MAX_BYTES || buf[0] !== 1) return;
  if (c.mute) {
    if (c.mute.until > Date.now()) return;
    c.mute = null;
  }
  const now = Date.now();
  if (now - c.vWin >= 1000) { c.vWin = now; c.vCnt = 0; }
  if (++c.vCnt > VOICE_MAX_PER_SEC) return;
  const r = vrooms.get(c.voice);
  if (!r || r.members.size < 2) return;
  const out = Buffer.allocUnsafe(buf.length + 4);
  out[0] = 1;
  out.writeUInt32LE(c.id >>> 0, 1);
  buf.copy(out, 5, 1);
  for (const w of r.members) if (w !== ws && w.readyState === 1) w.send(out, { binary: true });
}

wss.on("connection", (ws) => {
  const c = { id: nextId++, name: "Oyuncu", room: null, alive: true, authed: false, rank: "", mute: null, chain: Promise.resolve(), vWin: 0, vCnt: 0, voice: null };
  clients.set(ws, c);
  send(ws, { type: "welcome", id: c.id });

  ws.on("pong", () => { c.alive = true; });
  const onMsg = async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "hello": {
        const acc = await AUTH.verifyUser(msg.token);   // gecerli token -> isim + rank hesaptan gelir (taklit edilemez)
        if (acc && acc.banned) {                         // banli hesap: bildir + at
          send(ws, { type: "banned", by: acc.banned.by, reason: acc.banned.reason, perm: !!acc.banned.perm, left: Math.max(1, Math.ceil((acc.banned.until - Date.now()) / 1000)) });
          setTimeout(() => { try { ws.close(); } catch (e) {} }, 400);
          break;
        }
        c.authed = !!acc;
        c.name = acc ? acc.name : cleanName(msg.name);
        c.rank = acc ? acc.rank : "";
        c.mute = acc ? acc.mute : null;
        send(ws, { type: "mute", ...muteMsg(c.mute) });   // susturulduysa istemci bilsin (kalici: hesaptan gelir)
        if (!acc) send(ws, { type: "auth", ok: false });
        break;
      }
      case "join_lobby": {
        if (REQUIRE_LOGIN && !c.authed) { send(ws, { type: "error", message: "Giris gerekli" }); break; }
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
      case "join_arena": {
        if (REQUIRE_LOGIN && !c.authed) { send(ws, { type: "error", message: "Giris gerekli" }); break; }
        dequeue(ws);
        const arena = rooms.get("arena");
        if (arena && arena.size >= ARENA_MAX && !arena.has(ws)) {
          send(ws, { type: "error", message: "Arena dolu" });
          break;
        }
        joinRoom(ws, "arena");
        send(ws, { type: "arena_joined", you: c.id, players: listOf("arena") });
        break;
      }
      case "leave_arena":
        if (c.room === "arena") leaveRoom(ws);
        break;
      case "find_match": {
        if (REQUIRE_LOGIN && !c.authed) { send(ws, { type: "error", message: "Giris gerekli" }); break; }
        leaveRoom(ws);                       // lobiden cik
        dequeue(ws);
        const game = msg.game === "duels" ? "duels" : "bedwars";   // eski istemci game gondermez -> bedwars
        const queue = queues[game];
        queue.push(ws);
        if (game === "bedwars") {
          bwUpdate();
          break;
        }
        if (queue.length >= MATCH_SIZE) {
          const group = queue.splice(0, MATCH_SIZE);
          const code = "d-" + (matchCounter++);
          group.forEach((w) => joinRoom(w, code));
          const players = listOf(code);
          group.forEach((w) => send(w, { type: "match_found", code, game, you: clients.get(w).id, players }));
        } else {
          send(ws, { type: "searching" });
        }
        break;
      }
      case "voice_list":
      case "voice_join":
      case "voice_create":
      case "voice_leave":
        voiceMsg(ws, c, msg);
        break;
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
        // SUSTURULMUS oyuncunun sohbet mesaji kimseye gitmez (Lobi / Bed Wars / Duels / Arena hepsi buradan gecer)
        if (c.mute && msg.data && typeof msg.data === "object" && msg.data.kind === "chat") {
          if (c.mute.until > Date.now()) { send(ws, { type: "chat_muted", ...muteMsg(c.mute) }); break; }
          c.mute = null;      // sure doldu
        }
        const set = c.room && rooms.get(c.room);
        if (!set || typeof msg.data !== "object") break;
        const out = JSON.stringify({ type: "relay", from: c.id, data: msg.data });
        for (const w of set) if (w !== ws && w.readyState === 1) w.send(out);
        break;
      }
    }
  };
  ws.on("message", (raw, isBinary) => {
    if (isBinary) { relayVoice(ws, c, raw); return; }   // SESLI SOHBET: ikili paket, JSON'a girmez
    c.chain = c.chain.then(() => onMsg(raw)).catch(() => {});
  });
  ws.on("close", () => {
    vLeave(ws);
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
