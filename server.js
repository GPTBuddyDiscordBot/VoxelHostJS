const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const config = { port: 0, maxPlayers: 20, motd: 'VoxelHost Server', worldSeed: 'voxelhost', pvp: true, spawnProtection: true, adminPassword: 'voxelcraft', mods: { sharks: false, skateboard: false } };
try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); Object.assign(config, c); console.log('[config] Loaded. adminPassword=' + config.adminPassword); } catch(e) { console.log('[config] Using defaults. adminPassword=' + config.adminPassword); }

const rooms = new Map();

function genId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
function genRoomId() { return 'r_' + Math.random().toString(36).slice(2, 10); }

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { players: new Map(), created: Date.now(), name: 'Server ' + roomId.slice(0, 6), motd: config.motd, maxPlayers: config.maxPlayers });
    console.log('[room] Created ' + roomId + ' (' + rooms.size + ' total)');
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

// Find a player by username (case-insensitive) within a room
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
        console.log('[create] ' + roomId + ' name="' + room.name + '" pw="' + room.creatorPw + '"');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ roomId, name: room.name, motd: room.motd, maxPlayers: room.maxPlayers, worldSeed: config.worldSeed, pvp: config.pvp }));
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
      res.end(JSON.stringify({ online: true, roomId, name: room.name, motd: room.motd, playerCount: players.length, maxPlayers: room.maxPlayers, pvp: config.pvp, worldSeed: config.worldSeed, mods: config.mods, players, created: room.created }));
      return;
    }
    let total = 0; const roomList = [];
    for (const [id, r] of rooms) {
      const count = [...r.players.values()].filter(p => !p.isAdmin).length;
      total += count;
      roomList.push({ roomId: id, name: r.name, motd: r.motd, playerCount: count, maxPlayers: r.maxPlayers, created: r.created });
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
        ws.send(JSON.stringify({ type: 'joined', data: { id: p.id, players: roomSnapshot(room), serverMods: config.mods, roomId: p.roomId, roomName: room.name } }));
        broadcastRoom(room, { type: 'player_joined', data: { id: p.id, username: p.username, mcUsername: p.mcUsername, x: p.x, y: p.y, z: p.z, yaw: p.yaw, heldItemId: p.heldItemId, armor: p.armor, isOwner: false } }, ws);
        console.log('[join] ' + p.username + ' -> ' + roomId + ' (' + room.players.size + ')');
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
      case 'admin_auth': {
        const password = String(msg.password || '');
        console.log('[admin] Auth attempt: password="' + password + '" roomPw="' + (room.creatorPw||'none') + '" globalPw="' + config.adminPassword + '"');
        if ((password === config.adminPassword && config.adminPassword) || (room.creatorPw && password === room.creatorPw)) {
          p.isAdmin = true;
          try { ws.send(JSON.stringify({ type: 'admin_auth_result', success: true })); } catch {}
          console.log('[admin] SUCCESS from ' + p.ip);
        } else {
          try { ws.send(JSON.stringify({ type: 'admin_auth_result', success: false, error: 'Wrong password (you sent: ' + password + ')' })); } catch {}
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
            for (const pp of room.players.values()) { if (pp.isAdmin) continue; l.push('  ' + (i++) + '. ' + pp.username + ' (' + pp.x.toFixed(0) + ',' + pp.y.toFixed(0) + ',' + pp.z.toFixed(0) + ')'); }
            result = l.join('\n');
            break;
          }
          case 'kick': {
            // /kick <user> [reason...]
            const targetName = args[0];
            if (!targetName) { result = 'Usage: /kick <username> [reason]'; break; }
            const target = findPlayerByName(room, targetName);
            if (!target) { result = 'Player "' + targetName + '" not found.'; break; }
            const reason = args.slice(1).join(' ') || 'Kicked by admin';
            try { target.ws.send(JSON.stringify({ type: 'disconnect', reason: 'Kicked: ' + reason })); } catch {}
            try { target.ws.close(1009, 'Kicked'); } catch {}
            room.players.delete(target.ws);
            broadcastRoom(room, { type: 'player_left', data: { id: target.id } });
            result = 'Kicked ' + target.username + ' (reason: ' + reason + ')';
            console.log('[kick] ' + target.username + ' by admin (reason: ' + reason + ')');
            break;
          }
          case 'ban': {
            // /ban <user> [days] [reason...]
            const targetName = args[0];
            if (!targetName) { result = 'Usage: /ban <username> [days] [reason]'; break; }
            const target = findPlayerByName(room, targetName);
            if (!target) { result = 'Player "' + targetName + '" is not currently connected.'; break; }
            if (!target.deviceId) { result = 'Player "' + target.username + '" has no deviceId — cannot ban.'; break; }
            // Parse days (optional, second arg if it's a number)
            let days = 0; let reasonStart = 1;
            if (args[1] !== undefined && !isNaN(Number(args[1]))) {
              days = Math.max(0, Number(args[1]));
              reasonStart = 2;
            }
            const reason = args.slice(reasonStart).join(' ') || 'Banned by admin';
            const until = days > 0 ? Date.now() + days * 86400000 : null;
            // Store ban (would need a bans map — for now just kick with ban message)
            try { target.ws.send(JSON.stringify({ type: 'banned', data: { msg: reason, until: until } })); } catch {}
            try { target.ws.close(1008, 'Banned'); } catch {}
            room.players.delete(target.ws);
            broadcastRoom(room, { type: 'player_left', data: { id: target.id } });
            const untilStr = until ? 'until ' + new Date(until).toISOString() : 'permanently';
            result = 'Banned ' + target.username + ' ' + untilStr + ' (reason: ' + reason + ')';
            console.log('[ban] ' + target.username + ' by admin ' + untilStr + ' (reason: ' + reason + ')');
            break;
          }
          case 'say': {
            const message = args.join(' ');
            if (!message) { result = 'Usage: /say <message>'; break; }
            broadcastRoom(room, { type: 'chat_msg', data: { username: 'Server', msg: message } });
            result = '[Server] ' + message;
            break;
          }
          case 'info': {
            result = 'Room: ' + roomId + '\nName: ' + room.name + '\nPlayers: ' + room.players.size + '/' + room.maxPlayers + '\nMOTD: ' + room.motd;
            break;
          }
          case 'help': {
            result = 'Commands:\n  /list                          — list players\n  /kick <user> [reason]          — kick with reason\n  /ban <user> [days] [reason]    — ban (0=perm, days optional)\n  /say <message>                 — broadcast\n  /info                          — server info\n  /help                          — this help';
            break;
          }
          default: result = 'Unknown: /' + cmd + '. Try /help';
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
  console.log('============================================\n');
});
