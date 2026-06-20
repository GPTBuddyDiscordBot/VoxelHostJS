const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const config = { port: 0, maxPlayers: 20, motd: 'VoxelHost Server', worldSeed: 'voxelhost', pvp: true, spawnProtection: true, adminPassword: 'voxelcraft', mods: { sharks: false, skateboard: false } };
try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); Object.assign(config, c); console.log('[config] Loaded. adminPassword=' + config.adminPassword); } catch(e) { console.log('[config] Using defaults. adminPassword=' + config.adminPassword); }

const rooms = new Map();

// ─── Bans (persisted to bans.json) ───
const BANS_PATH = path.join(__dirname, 'bans.json');
const bans = new Map();
function loadBans() {
  try {
    const raw = fs.readFileSync(BANS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [deviceId, entry] of Object.entries(parsed)) {
        if (entry && typeof entry === 'object') {
          bans.set(deviceId, { username: String(entry.username || ''), until: entry.until === null ? null : Number(entry.until) || 0, reason: String(entry.reason || 'Banned') });
        }
      }
    }
    const now = Date.now();
    let purged = 0;
    for (const [id, b] of bans.entries()) {
      if (b.until !== null && b.until < now) { bans.delete(id); purged++; }
    }
    if (purged > 0) saveBans();
    console.log('[bans] Loaded ' + bans.size + ' ban(s)' + (purged ? ' (purged ' + purged + ' expired)' : ''));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[bans] Could not read bans.json:', err.message);
  }
}
function saveBans() {
  try {
    const obj = {};
    for (const [id, b] of bans.entries()) { obj[id] = { username: b.username, until: b.until, reason: b.reason }; }
    fs.writeFileSync(BANS_PATH, JSON.stringify(obj, null, 2));
  } catch (err) { console.warn('[bans] Could not write bans.json:', err.message); }
}
function isBanned(deviceId) {
  if (!deviceId) return null;
  const b = bans.get(deviceId);
  if (!b) return null;
  if (b.until !== null && b.until < Date.now()) { bans.delete(deviceId); saveBans(); return null; }
  return b;
}
loadBans();

// ─── Player data (persists to players.json) ───
// Keyed by deviceId:roomId so each player's data is per-server.
const PLAYERS_PATH = path.join(__dirname, 'players.json');
const playerData = new Map();
function loadPlayerData() {
  try {
    const raw = fs.readFileSync(PLAYERS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [key, val] of Object.entries(parsed)) {
        playerData.set(key, val);
      }
    }
    console.log('[data] Loaded ' + playerData.size + ' player data record(s)');
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[data] Could not read players.json:', err.message);
  }
}
function savePlayerData() {
  try {
    const obj = {};
    for (const [key, val] of playerData.entries()) obj[key] = val;
    fs.writeFileSync(PLAYERS_PATH, JSON.stringify(obj, null, 2));
  } catch (err) { console.warn('[data] Could not write players.json:', err.message); }
}
loadPlayerData();

function genId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
function genRoomId() { return 'r_' + Math.random().toString(36).slice(2, 10); }

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { players: new Map(), created: Date.now(), name: 'Server ' + roomId.slice(0, 6), motd: config.motd, maxPlayers: config.maxPlayers, worldSeed: roomId });
    console.log('[room] Created ' + roomId + ' seed=' + roomId + ' (' + rooms.size + ' total)');
  }
  return rooms.get(roomId);
}

function deleteRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return false;
  for (const [ws, p] of room.players) {
    try { ws.send(JSON.stringify({ type: 'disconnect', reason: 'Server deleted' })); } catch {}
    try { ws.close(1001); } catch {}
  }
  rooms.delete(roomId);
  console.log('[room] Deleted ' + roomId + ' (' + rooms.size + ' remaining)');
  return true;
}

function broadcastRoom(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const c of room.players.keys()) {
    if (c === except || c.readyState !== 1) continue;
    try { c.send(data); } catch {}
  }
}

function roomSnapshot(room) {
  return [...room.players.values()].filter(p => !p.isAdmin).map(p => ({
    id: p.id, username: p.username, mcUsername: p.mcUsername || '',
    x: p.x, y: p.y, z: p.z, yaw: p.yaw, heldItemId: p.heldItemId,
    armor: p.armor || [null, null, null, null], isOwner: false,
  }));
}

function findPlayerByName(room, name) {
  const lower = String(name || '').toLowerCase();
  for (const p of room.players.values()) {
    if (p.username && p.username.toLowerCase() === lower) return p;
  }
  return null;
}

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/create-room') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const roomId = genRoomId();
        const room = getOrCreateRoom(roomId);
        room.name = String(data.name || 'My Server').slice(0, 50);
        room.motd = String(data.motd || data.name || 'VoxelCraft Server').slice(0, 100);
        room.maxPlayers = Math.min(50, Math.max(1, Number(data.maxPlayers) || 20));
        room.creatorPw = String(data.adminPassword || config.adminPassword);
        console.log('[create] ' + roomId + ' name="' + room.name + '" seed="' + room.worldSeed + '"');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ roomId, name: room.name, motd: room.motd, maxPlayers: room.maxPlayers, worldSeed: room.worldSeed, pvp: config.pvp }));
      } catch (e) { res.writeHead(400); res.end('{"error":"bad request"}'); }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/delete-room') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const roomId = String(data.roomId || '');
        const password = String(data.password || '');
        const room = rooms.get(roomId);
        if (!room) { res.writeHead(404); res.end('{"error":"room not found"}'); return; }
        if (password !== config.adminPassword && password !== room.creatorPw) {
          res.writeHead(403); res.end('{"error":"wrong password"}'); return;
        }
        deleteRoom(roomId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"success":true}');
      } catch (e) { res.writeHead(400); res.end('{"error":"bad request"}'); }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    const roomId = url.searchParams.get('room');
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      const players = [...room.players.values()].filter(p => !p.isAdmin).map(p => p.username);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ online: true, roomId, name: room.name, motd: room.motd, playerCount: players.length, maxPlayers: room.maxPlayers, pvp: config.pvp, worldSeed: room.worldSeed || config.worldSeed, mods: config.mods, players, created: room.created }));
      return;
    }
    let total = 0; const roomList = [];
    for (const [id, r] of rooms) {
      const count = [...r.players.values()].filter(p => !p.isAdmin).length;
      total += count;
      roomList.push({ roomId: id, name: r.name, motd: r.motd, playerCount: count, maxPlayers: r.maxPlayers, created: r.created, worldSeed: r.worldSeed });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ online: true, totalRooms: rooms.size, totalPlayers: total, rooms: roomList }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/rooms') {
    const roomList = [];
    for (const [id, r] of rooms) {
      const count = [...r.players.values()].filter(p => !p.isAdmin).length;
      if (count === 0 && Date.now() - r.created > 300000) { rooms.delete(id); continue; }
      roomList.push({ roomId: id, name: r.name, motd: r.motd, playerCount: count, maxPlayers: r.maxPlayers, created: r.created });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rooms: roomList }));
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room') || 'default';
  const room = getOrCreateRoom(roomId);
  const ip = req.socket.remoteAddress || 'unknown';

  if (room.players.size >= room.maxPlayers) {
    try { ws.send(JSON.stringify({ type: 'disconnect', reason: 'Server is full' })); } catch {}
    ws.close(1013); return;
  }

  const player = { id: genId(), ws, ip, roomId, deviceId: '', username: 'Player', mcUsername: '', x: 8.5, y: 45, z: 8.5, yaw: 0, heldItemId: 0, armor: [null, null, null, null], isAdmin: false };
  room.players.set(ws, player);

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || !msg.type) return;
    const p = room.players.get(ws);
    if (!p) return;

    switch (msg.type) {
      case 'set_username': {
        const name = String(msg.username || 'Player').slice(0, 32) || 'Player';
        p.deviceId = String(msg.deviceId || '').slice(0, 128);

        // ─── Ban check by deviceId ───
        const ban = isBanned(p.deviceId);
        if (ban) {
          const untilStr = ban.until === null ? 'permanently' : 'until ' + new Date(ban.until).toLocaleString();
          try { ws.send(JSON.stringify({ type: 'banned', data: { msg: ban.reason + ' (' + untilStr + ')', until: ban.until } })); } catch {}
          console.log('[ban] Rejected ' + name + ' (device=' + p.deviceId + ') — banned ' + untilStr);
          room.players.delete(ws);
          try { ws.close(1008, 'Banned'); } catch {}
          return;
        }

        p.mcUsername = String(msg.mcUsername || '').slice(0, 32);
        const lower = name.toLowerCase();
        for (const o of room.players.values()) {
          if (o !== p && o.username && o.username.toLowerCase() === lower) {
            try { ws.send(JSON.stringify({ type: 'duplicate_name', data: { msg: 'Name already in use' } })); } catch {}
            room.players.delete(ws); try { ws.close(1008); } catch {}
            return;
          }
        }
        p.username = name;
        ws.send(JSON.stringify({ type: 'joined', data: { id: p.id, players: roomSnapshot(room), serverMods: config.mods, roomId: p.roomId, roomName: room.name, worldSeed: room.worldSeed } }));
        broadcastRoom(room, { type: 'player_joined', data: { id: p.id, username: p.username, mcUsername: p.mcUsername, x: p.x, y: p.y, z: p.z, yaw: p.yaw, heldItemId: p.heldItemId, armor: p.armor, isOwner: false } }, ws);
        console.log('[join] ' + p.username + ' -> ' + roomId + ' (' + room.players.size + ')');

        // ─── Restore saved player data ───
        if (p.deviceId) {
          const playerKey = p.deviceId + ':' + roomId;
          const saved = playerData.get(playerKey);
          if (saved) {
            try { ws.send(JSON.stringify({ type: 'player_data_loaded', data: saved })); } catch {}
            console.log('[data] Restored data for ' + p.username + ' (device=' + p.deviceId + ')');
          }
        }
        break;
      }
      case 'pos': {
        p.x = +msg.x || p.x; p.y = +msg.y || p.y; p.z = +msg.z || p.z; p.yaw = +msg.yaw || 0; p.heldItemId = +msg.heldItemId || 0;
        if (Array.isArray(msg.armor)) p.armor = msg.armor.slice(0, 4);
        if (msg.mcUsername !== undefined) p.mcUsername = String(msg.mcUsername).slice(0, 32);
        p.sneaking = !!msg.sneaking; p.hitting = !!msg.hitting;
        broadcastRoom(room, { type: 'player_pos', data: { id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, heldItemId: p.heldItemId, ...(msg.armor ? { armor: p.armor } : {}), ...(msg.mcUsername !== undefined ? { mcUsername: p.mcUsername } : {}), sneaking: p.sneaking, hitting: p.hitting } }, ws);
        break;
      }
      case 'block': { broadcastRoom(room, { type: 'block_update', data: { x: Math.floor(+msg.x), y: Math.floor(+msg.y), z: Math.floor(+msg.z), blockId: +msg.blockId | 0 } }, ws); break; }
      case 'chat': { const t = String(msg.msg || '').slice(0, 256); if (t) broadcastRoom(room, { type: 'chat_msg', data: { username: p.username, msg: t } }); break; }
      case 'player_hit': { const t = [...room.players.values()].find(pp => pp.id === msg.targetId); if (t && t !== p) try { t.ws.send(JSON.stringify({ type: 'player_hit', data: { sourceId: p.id, targetId: t.id, damage: +msg.damage || 4, sourceUsername: p.username } })); } catch {} break; }
      case 'mods': { const m = msg.mods || {}; if (typeof m.sharks === 'boolean') config.mods.sharks = m.sharks; if (typeof m.skateboard === 'boolean') config.mods.skateboard = m.skateboard; broadcastRoom(room, { type: 'mod_sync', data: config.mods }); break; }

      // ─── Save player data ───
      case 'save_player_data': {
        if (p.deviceId) {
          const key = p.deviceId + ':' + roomId;
          playerData.set(key, msg.data);
          savePlayerData();
        }
        break;
      }

      case 'admin_auth': {
        const password = String(msg.password || '');
        if ((password === config.adminPassword && config.adminPassword) || (room.creatorPw && password === room.creatorPw)) {
          p.isAdmin = true;
          try { ws.send(JSON.stringify({ type: 'admin_auth_result', success: true })); } catch {}
          console.log('[admin] SUCCESS from ' + p.ip);
        } else {
          try { ws.send(JSON.stringify({ type: 'admin_auth_result', success: false, error: 'Wrong password' })); } catch {}
          console.log('[admin] FAILED from ' + p.ip);
        }
        break;
      }
      case 'admin_command': {
        if (!p.isAdmin) { try { ws.send(JSON.stringify({ type: 'admin_output', text: 'Not authenticated.' })); } catch {} break; }
        const cmd = String(msg.command || '').toLowerCase(); const args = Array.isArray(msg.args) ? msg.args : [];
        let result = null;
        switch (cmd) {
          case 'list': {
            const l = ['Players in ' + roomId + ' (' + room.players.size + '/' + room.maxPlayers + ')'];
            let i = 1;
            for (const pp of room.players.values()) { if (pp.isAdmin) continue; l.push('  ' + (i++) + '. ' + pp.username + ' (device=' + (pp.deviceId||'-') + ')'); }
            result = l.join('\n'); break;
          }
          case 'kick': {
            const t = findPlayerByName(room, args[0]);
            if (!t) { result = 'Not found.'; break; }
            const reason = args.slice(1).join(' ') || 'Kicked by admin';
            try { t.ws.send(JSON.stringify({ type: 'disconnect', reason: 'Kicked: ' + reason })); t.ws.close(); } catch {}
            room.players.delete(t.ws);
            broadcastRoom(room, { type: 'player_left', data: { id: t.id } });
            result = 'Kicked ' + t.username + ' (' + reason + ')'; break;
          }
          case 'ban': {
            const t = findPlayerByName(room, args[0]);
            if (!t) { result = 'Not found.'; break; }
            if (!t.deviceId) { result = 'No deviceId.'; break; }
            let days = 0; let reasonStart = 1;
            if (args[1] !== undefined && !isNaN(Number(args[1]))) { days = Math.max(0, Number(args[1])); reasonStart = 2; }
            const reason = args.slice(reasonStart).join(' ') || 'Banned by admin';
            const until = days > 0 ? Date.now() + days * 86400000 : null;
            bans.set(t.deviceId, { username: t.username, until, reason });
            saveBans();
            try { t.ws.send(JSON.stringify({ type: 'banned', data: { msg: reason, until } })); t.ws.close(); } catch {}
            room.players.delete(t.ws);
            broadcastRoom(room, { type: 'player_left', data: { id: t.id } });
            result = 'Banned ' + t.username + ' (' + (until ? new Date(until).toISOString() : 'permanent') + ') ' + reason; break;
          }
          case 'unban': {
            const lower = String(args[0]||'').toLowerCase();
            let removed = 0;
            for (const [id, b] of bans.entries()) { if (b.username.toLowerCase() === lower) { bans.delete(id); removed++; } }
            if (removed > 0) { saveBans(); result = 'Removed ' + removed + ' ban(s).'; } else { result = 'Not found.'; }
            break;
          }
          case 'bans': {
            if (bans.size === 0) { result = 'No bans.'; break; }
            const l = ['--- Bans (' + bans.size + ') ---']; let i = 1;
            for (const [id, b] of bans.entries()) { l.push('  ' + (i++) + '. ' + b.username + ' ' + (b.until ? new Date(b.until).toISOString() : 'permanent') + ' ' + b.reason); }
            result = l.join('\n'); break;
          }
          case 'say': { broadcastRoom(room, { type: 'chat_msg', data: { username: 'Server', msg: args.join(' ') } }); result = 'Sent.'; break; }
          case 'info': { result = 'Room: ' + roomId + '\nName: ' + room.name + '\nSeed: ' + room.worldSeed + '\nPlayers: ' + room.players.size + '/' + room.maxPlayers; break; }
          case 'help': { result = 'Commands: /list /kick <user> [reason] /ban <user> [days] [reason] /unban <user> /bans /say <msg> /info /help'; break; }
          default: result = 'Unknown: /' + cmd;
        }
        if (result) try { ws.send(JSON.stringify({ type: 'admin_output', text: result })); } catch {}
        break;
      }
    }
  });

  ws.on('close', () => {
    const p = room.players.get(ws);
    room.players.delete(ws);
    if (p) { broadcastRoom(room, { type: 'player_left', data: { id: p.id } }); console.log('[leave] ' + p.username + ' <- ' + roomId); }
    if (room.players.size === 0) setTimeout(() => { if (room.players.size === 0) rooms.delete(roomId); }, 300000);
  });

  ws.on('error', () => {});
});

const PORT = config.port > 0 ? config.port : (process.env.PORT ? +process.env.PORT : 3001);
httpServer.listen(PORT, () => {
  console.log('\n============================================');
  console.log('  VoxelHost Game Server');
  console.log('============================================');
  console.log('  Port: ' + PORT);
  console.log('  Admin PW: ' + config.adminPassword);
  console.log('  Unique seeds: ENABLED (per room)');
  console.log('  Ban system: deviceId-based (bans.json)');
  console.log('  Player data: SAVED (players.json)');
  console.log('============================================\n');
});
