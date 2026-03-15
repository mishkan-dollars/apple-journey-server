const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(__dirname));
app.use(express.static('public'));

// ============================================================
//  UPSTASH REDIS
// ============================================================
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || 'https://cosmic-snapper-73256.upstash.io';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAR4oAAIncDFjZjk3ZDE3ZjdiYWY0Nzk1OWMzOGZiNDMyMjk1YzQ2OXAxNzMyNTY';

async function rGet(key) {
  try {
    const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const d = await r.json();
    if (!d.result) return null;
    try { return JSON.parse(d.result); } catch(e) { return d.result; }
  } catch(e) { return null; }
}

async function rSet(key, value) {
  try {
    await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(value) })
    });
  } catch(e) {}
}

async function rDel(key) {
  try {
    await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
  } catch(e) {}
}

// ============================================================
//  PLAYER DB
// ============================================================
async function getPlayer(id) { return await rGet('p:' + id); }
async function savePlayer(p) { await rSet('p:' + p.id, p); }
async function getPlayerByToken(token) {
  const id = await rGet('t:' + token);
  if (!id) return null;
  return await getPlayer(id);
}

// ============================================================
//  IN-MEMORY STATE
// ============================================================
const conns = new Map();      // playerId -> ws
const wsMap = new Map();      // ws -> playerId
const playerLobby = new Map(); // playerId -> lobbyId
const brRooms = new Map();    // playerId -> Set of playerIds in same match

// ============================================================
//  MATCHMAKING QUEUE
// ============================================================
let queue = null;

function mmJoin(playerId, nick, charIcon) {
  if (!queue) {
    queue = {
      id: uuidv4().slice(0,8).toUpperCase(),
      players: [],
      startTime: Date.now(),
      secondsLeft: 10
    };
    queue.timer = setInterval(() => mmTick(), 1000);
    console.log('[MM] Новая очередь', queue.id);
  }

  if (queue.players.find(p => p.id === playerId)) return;
  queue.players.push({ id: playerId, nick: nick || '???', charIcon: charIcon || '🍎' });
  console.log('[MM] Игрок', nick, '| В очереди:', queue.players.length);

  mmBroadcast();

  if (queue.players.length >= 10) mmLaunch();
}

function mmLeave(playerId) {
  if (!queue) return;
  queue.players = queue.players.filter(p => p.id !== playerId);
  if (queue.players.length === 0) {
    clearInterval(queue.timer);
    queue = null;
  } else {
    mmBroadcast();
  }
}

function mmTick() {
  if (!queue) return;
  queue.secondsLeft--;
  mmBroadcast();
  if (queue.secondsLeft <= 0) mmLaunch();
}

function mmBroadcast() {
  if (!queue) return;
  queue.players.forEach(p => {
    const ws = conns.get(p.id);
    if (ws) send(ws, {
      type: 'MM_UPDATE',
      found: queue.players.length,
      total: 10,
      timeLeft: queue.secondsLeft,
      players: queue.players.map(x => ({ nick: x.nick, charIcon: x.charIcon }))
    });
  });
}

function mmLaunch() {
  if (!queue || queue.players.length === 0) return;
  clearInterval(queue.timer);
  const q = queue;
  queue = null;

  console.log('[MM] Запуск матча! Игроков:', q.players.length);

  const teams = {};
  q.players.forEach((p, i) => { teams[p.id] = i % 2 === 0 ? 'A' : 'B'; });

  const playersInfo = q.players.map(p => ({
    id: p.id,
    nickname: p.nick,
    team: teams[p.id],
    charIcon: p.charIcon
  }));

  // Создаём комнату для синхронизации BR
  const roomSet = new Set(q.players.map(p => p.id));
  q.players.forEach(p => { brRooms.set(p.id, roomSet); });

  q.players.forEach(p => {
    const ws = conns.get(p.id);
    if (ws) send(ws, {
      type: 'MM_LAUNCH',
      roomId: q.id,
      teams,
      players: playersInfo,
      realPlayers: q.players.length
    });
  });
}

// ============================================================
//  HELPERS
// ============================================================
function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(ids, msg) {
  ids.forEach(id => { const ws = conns.get(id); if (ws) send(ws, msg); });
}

function genId() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const p1 = Array.from({length:4}, () => c[Math.floor(Math.random()*c.length)]).join('');
  const p2 = Array.from({length:4}, () => c[Math.floor(Math.random()*c.length)]).join('');
  return `AJ-${p1}-${p2}`;
}

// ============================================================
//  REST API
// ============================================================
app.post('/api/auth', async (req, res) => {
  const { nickname, deviceToken } = req.body;
  if (!nickname || nickname.trim().length < 2) {
    return res.status(400).json({ error: 'Ник слишком короткий' });
  }

  if (deviceToken) {
    const ex = await getPlayerByToken(deviceToken);
    if (ex) {
      if (ex.nickname !== nickname.trim()) {
        ex.nickname = nickname.trim().slice(0, 25);
        await savePlayer(ex);
      }
      return res.json({ playerId: ex.id, nickname: ex.nickname, deviceToken: ex.deviceToken });
    }
  }

  const id = genId();
  const token = deviceToken || uuidv4();
  const p = {
    id, nickname: nickname.trim().slice(0, 25),
    deviceToken: token, createdAt: Date.now(),
    friends: [], friendRequests: [], sentRequests: [],
    stats: { wins: 0, games: 0 }
  };
  await savePlayer(p);
  await rSet('t:' + token, id);
  res.json({ playerId: id, nickname: p.nickname, deviceToken: token });
});

app.get('/api/player/:id', async (req, res) => {
  const p = await getPlayer(req.params.id);
  if (!p) return res.status(404).json({ error: 'Не найден' });
  res.json({ id: p.id, nickname: p.nickname, online: conns.has(p.id), stats: p.stats, friendsCount: (p.friends||[]).length });
});

app.get('/api/friends/:id', async (req, res) => {
  const p = await getPlayer(req.params.id);
  if (!p) return res.status(404).json({ error: 'Не найден' });

  const friends = (await Promise.all((p.friends||[]).map(async fid => {
    const f = await getPlayer(fid);
    return f ? { id: f.id, nickname: f.nickname, online: conns.has(fid), stats: f.stats||{wins:0,games:0} } : null;
  }))).filter(Boolean);

  const incoming = (await Promise.all((p.friendRequests||[]).map(async fid => {
    const f = await getPlayer(fid);
    return f ? { id: fid, nickname: f.nickname } : null;
  }))).filter(Boolean);

  res.json({ friends, incoming });
});

app.get('/api/status', (req, res) => {
  res.json({
    online: conns.size,
    queue: queue ? queue.players.length : 0,
    uptime: Math.floor(process.uptime())
  });
});

app.get('*', (req, res) => {
  const p1 = path.join(__dirname, 'public', 'index.html');
  const p2 = path.join(__dirname, 'index.html');
  if (fs.existsSync(p1)) res.sendFile(p1);
  else if (fs.existsSync(p2)) res.sendFile(p2);
  else res.status(404).send('Not found');
});

// ============================================================
//  WEBSOCKET
// ============================================================
wss.on('connection', ws => {
  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }
    const { type, playerId } = msg;
    const player = playerId ? await getPlayer(playerId) : null;

    switch (type) {

      // ---- AUTH ----
      case 'CONNECT': {
        if (!player) return send(ws, { type: 'ERROR', text: 'Игрок не найден' });
        const old = conns.get(playerId);
        if (old && old !== ws) old.close();
        conns.set(playerId, ws);
        wsMap.set(ws, playerId);
        send(ws, { type: 'CONNECTED', playerId, nickname: player.nickname });

        // Уведомить друзей
        for (const fid of (player.friends||[])) {
          const fw = conns.get(fid);
          if (fw) send(fw, { type: 'FRIEND_ONLINE', friendId: playerId, nickname: player.nickname });
        }

        // Входящие заявки
        if ((player.friendRequests||[]).length > 0) {
          const reqs = (await Promise.all(player.friendRequests.map(async fid => {
            const f = await getPlayer(fid);
            return f ? { id: fid, nickname: f.nickname } : null;
          }))).filter(Boolean);
          if (reqs.length) send(ws, { type: 'FRIEND_REQUESTS', requests: reqs });
        }
        break;
      }

      // ---- MATCHMAKING ----
      case 'MM_JOIN': {
        if (!player) return send(ws, { type: 'ERROR', text: 'Нет подключения' });
        mmJoin(playerId, player.nickname, msg.charIcon);
        break;
      }

      case 'MM_LEAVE': {
        mmLeave(playerId);
        send(ws, { type: 'MM_LEFT' });
        break;
      }

      // ---- FRIENDS ----
      case 'FRIEND_REQUEST': {
        if (!player) return;
        const target = await getPlayer(msg.targetId);
        if (!target) return send(ws, { type: 'ERROR', text: 'Игрок не найден' });
        if (msg.targetId === playerId) return send(ws, { type: 'ERROR', text: 'Нельзя добавить себя' });
        if ((player.friends||[]).includes(msg.targetId)) return send(ws, { type: 'ERROR', text: 'Уже в друзьях' });
        if ((player.sentRequests||[]).includes(msg.targetId)) return send(ws, { type: 'ERROR', text: 'Заявка уже отправлена' });

        if (!player.sentRequests) player.sentRequests = [];
        if (!target.friendRequests) target.friendRequests = [];
        player.sentRequests.push(msg.targetId);
        target.friendRequests.push(playerId);
        await savePlayer(player);
        await savePlayer(target);

        send(ws, { type: 'FRIEND_REQUEST_SENT', targetId: msg.targetId, targetNick: target.nickname });
        const tw = conns.get(msg.targetId);
        if (tw) send(tw, { type: 'FRIEND_REQUEST_IN', fromId: playerId, fromNick: player.nickname });
        break;
      }

      case 'FRIEND_ACCEPT': {
        if (!player) return;
        const from = await getPlayer(msg.fromId);
        if (!from) return;

        player.friendRequests = (player.friendRequests||[]).filter(id => id !== msg.fromId);
        from.sentRequests = (from.sentRequests||[]).filter(id => id !== playerId);
        if (!player.friends) player.friends = [];
        if (!from.friends) from.friends = [];
        if (!player.friends.includes(msg.fromId)) player.friends.push(msg.fromId);
        if (!from.friends.includes(playerId)) from.friends.push(playerId);
        await savePlayer(player);
        await savePlayer(from);

        send(ws, { type: 'FRIEND_ADDED', friend: { id: msg.fromId, nickname: from.nickname, online: conns.has(msg.fromId) } });
        const fw = conns.get(msg.fromId);
        if (fw) send(fw, { type: 'FRIEND_ADDED', friend: { id: playerId, nickname: player.nickname, online: true } });
        break;
      }

      case 'FRIEND_DECLINE': {
        if (!player) return;
        const from = await getPlayer(msg.fromId);
        player.friendRequests = (player.friendRequests||[]).filter(id => id !== msg.fromId);
        if (from) { from.sentRequests = (from.sentRequests||[]).filter(id => id !== playerId); await savePlayer(from); }
        await savePlayer(player);
        send(ws, { type: 'FRIEND_DECLINED', fromId: msg.fromId });
        break;
      }

      // ---- LOBBY ----
      case 'LOBBY_CREATE': {
        if (!player) return;
        const oldId = playerLobby.get(playerId);
        if (oldId) {
          const old = await rGet('lobby:' + oldId);
          if (old) {
            old.players = old.players.filter(id => id !== playerId);
            if (!old.players.length) await rDel('lobby:' + oldId);
            else await rSet('lobby:' + oldId, old);
          }
        }
        const lid = uuidv4().slice(0,8).toUpperCase();
        const lobby = { id: lid, host: playerId, players: [playerId], maxPlayers: 4, status: 'waiting', createdAt: Date.now() };
        await rSet('lobby:' + lid, lobby);
        playerLobby.set(playerId, lid);
        send(ws, { type: 'LOBBY_CREATED', lobbyId: lid, lobby: await buildLobby(lobby) });
        break;
      }

      case 'LOBBY_INVITE': {
        if (!player) return;
        brRooms.delete(playerId);
    const lobbyId = playerLobby.get(playerId);
        if (!lobbyId) return send(ws, { type: 'ERROR', text: 'Сначала создай лобби' });
        const lobby = await rGet('lobby:' + lobbyId);
        if (!lobby) return send(ws, { type: 'ERROR', text: 'Лобби не найдено' });
        if (lobby.players.length >= 4) return send(ws, { type: 'ERROR', text: 'Лобби заполнено' });
        const fr = await getPlayer(msg.friendId);
        const fw = conns.get(msg.friendId);
        if (!fr || !fw) return send(ws, { type: 'ERROR', text: 'Друг не в сети' });
        send(fw, { type: 'LOBBY_INVITE_IN', lobbyId: lobby.id, hostId: playerId, hostNick: player.nickname });
        send(ws, { type: 'LOBBY_INVITE_SENT', friendId: msg.friendId, friendNick: fr.nickname });
        break;
      }

      case 'LOBBY_JOIN': {
        if (!player) return;
        const lobby = await rGet('lobby:' + msg.lobbyId);
        if (!lobby) return send(ws, { type: 'ERROR', text: 'Лобби не найдено' });
        if (lobby.players.length >= 4) return send(ws, { type: 'ERROR', text: 'Лобби заполнено' });
        if (!lobby.players.includes(playerId)) lobby.players.push(playerId);
        await rSet('lobby:' + msg.lobbyId, lobby);
        playerLobby.set(playerId, msg.lobbyId);
        broadcast(lobby.players, { type: 'LOBBY_UPDATED', lobby: await buildLobby(lobby) });
        break;
      }

      case 'LOBBY_DECLINE': {
        const lobby = await rGet('lobby:' + msg.lobbyId);
        if (lobby) {
          const hw = conns.get(lobby.host);
          if (hw) send(hw, { type: 'LOBBY_INVITE_DECLINED', byNick: player?.nickname });
        }
        break;
      }

      case 'LOBBY_LEAVE': {
        if (!player) return;
        brRooms.delete(playerId);
    const lobbyId = playerLobby.get(playerId);
        if (!lobbyId) return;
        const lobby = await rGet('lobby:' + lobbyId);
        playerLobby.delete(playerId);
        if (!lobby) return;
        lobby.players = lobby.players.filter(id => id !== playerId);
        if (!lobby.players.length) { await rDel('lobby:' + lobbyId); }
        else {
          if (lobby.host === playerId) lobby.host = lobby.players[0];
          await rSet('lobby:' + lobbyId, lobby);
          broadcast(lobby.players, { type: 'LOBBY_UPDATED', lobby: await buildLobby(lobby) });
        }
        send(ws, { type: 'LOBBY_LEFT' });
        break;
      }

      case 'LOBBY_GET': {
        brRooms.delete(playerId);
    const lobbyId = playerLobby.get(playerId);
        if (lobbyId) {
          const lobby = await rGet('lobby:' + lobbyId);
          send(ws, { type: 'LOBBY_DATA', lobby: lobby ? await buildLobby(lobby) : null });
        } else {
          send(ws, { type: 'LOBBY_DATA', lobby: null });
        }
        break;
      }

      case 'LOBBY_START_KB': {
        if (!player) return;
        brRooms.delete(playerId);
    const lobbyId = playerLobby.get(playerId);
        if (!lobbyId) return send(ws, { type: 'ERROR', text: 'Нет лобби' });
        const lobby = await rGet('lobby:' + lobbyId);
        if (!lobby) return send(ws, { type: 'ERROR', text: 'Лобби не найдено' });
        if (lobby.host !== playerId) return send(ws, { type: 'ERROR', text: 'Только хост' });

        const teams = {};
        lobby.players.forEach((pid, i) => { teams[pid] = i % 2 === 0 ? 'A' : 'B'; });
        const playersInfo = await Promise.all(lobby.players.map(async pid => ({
          id: pid,
          nickname: (await getPlayer(pid))?.nickname || '???',
          team: teams[pid],
          charIcon: msg.playerIcons?.[pid] || '🍎'
        })));

        lobby.status = 'kb';
        await rSet('lobby:' + lobbyId, lobby);
        broadcast(lobby.players, { type: 'LOBBY_KB_START', lobbyId, roomId: lobbyId, teams, players: playersInfo });
        break;
      }

      case 'LOBBY_CHAT': {
        if (!player) return;
        brRooms.delete(playerId);
    const lobbyId = playerLobby.get(playerId);
        if (!lobbyId) return;
        const lobby = await rGet('lobby:' + lobbyId);
        if (!lobby) return;
        const text = (msg.text||'').trim().slice(0,100);
        if (!text) return;
        broadcast(lobby.players, { type: 'LOBBY_CHAT_MSG', fromId: playerId, fromNick: player.nickname, text });
        break;
      }

      // ---- GIFTS ----
      case 'SEND_GIFT': {
        if (!player) return;
        const tw = conns.get(msg.targetId);
        const target = await getPlayer(msg.targetId);
        if (!tw || !target) return send(ws, { type: 'ERROR', text: 'Игрок не в сети' });
        const desc = msg.giftType === 'money' ? `${msg.amount} F-Bucks` : `${msg.amount} кристаллов`;
        send(tw, { type: 'GIFT_RECEIVED', fromId: playerId, fromNick: player.nickname, giftType: msg.giftType, amount: msg.amount, [msg.giftType]: msg.amount, desc });
        break;
      }

      // ---- TRADE ----
      case 'TRADE_OFFER': {
        if (!player) return;
        const tw = conns.get(msg.targetId);
        if (!tw) return send(ws, { type: 'ERROR', text: 'Не в сети' });
        send(tw, { type: 'TRADE_REQUEST', fromId: playerId, fromNick: player.nickname, offer: msg.offer });
        break;
      }
      case 'TRADE_ACCEPT': {
        if (!player) return;
        const fw = conns.get(msg.fromId);
        if (fw) send(fw, { type: 'TRADE_ACCEPTED', byNick: player.nickname });
        break;
      }
      case 'TRADE_DECLINE': {
        if (!player) return;
        const fw = conns.get(msg.fromId);
        if (fw) send(fw, { type: 'TRADE_DECLINED', byNick: player.nickname });
        break;
      }

      // ---- CLICK BATTLE ----
      case 'CB_CHALLENGE': {
        if (!player) return;
        const tw = conns.get(msg.targetId);
        if (!tw) return send(ws, { type: 'ERROR', text: 'Друг не в сети' });
        send(tw, { type: 'CB_INVITE', fromId: playerId, fromNick: player.nickname });
        break;
      }
      case 'CB_ACCEPT': {
        if (!player) return;
        const fw = conns.get(msg.targetId);
        if (!fw) return;
        ws._cbOpp = msg.targetId;
        fw._cbOpp = playerId;
        ws._cbScore = 0;
        fw._cbScore = 0;
        const oppNick = (await getPlayer(msg.targetId))?.nickname || '???';
        send(ws, { type: 'CB_START', oppNick, oppId: msg.targetId });
        send(fw, { type: 'CB_START', oppNick: player.nickname, oppId: playerId });
        break;
      }
      case 'CB_CLICK': {
        ws._cbScore = msg.score || 0;
        const tid = ws._cbOpp;
        if (tid) { const tw = conns.get(tid); if (tw) send(tw, { type: 'CB_UPDATE', oppScore: ws._cbScore }); }
        break;
      }
      case 'CB_DONE': {
        const tid = ws._cbOpp;
        if (!tid) break;
        const tw = conns.get(tid);
        const myScore = msg.score || 0;
        const oppScore = tw ? (tw._cbScore || 0) : 0;
        const winnerId = myScore >= oppScore ? playerId : tid;
        send(ws, { type: 'CB_END', winnerId, myScore, oppScore });
        if (tw) send(tw, { type: 'CB_END', winnerId, myScore: oppScore, oppScore: myScore });
        ws._cbOpp = null;
        if (tw) tw._cbOpp = null;
        break;
      }

      // ---- BR SYNC ----
      case 'BR_POS': {
        // Рассылаем позицию всем в той же очереди/комнате
        if (!player) break;
        const room = brRooms.get(playerId);
        if (!room) break;
        room.forEach(pid => {
          if (pid === playerId) return;
          const tw = conns.get(pid);
          if (tw) send(tw, { type: 'BR_POS', playerId, x: msg.x, y: msg.y, hp: msg.hp, maxHp: msg.maxHp, alive: msg.alive, charIcon: msg.charIcon, emojiId: msg.emojiId });
        });
        break;
      }

      case 'BR_SHOT': {
        if (!player) break;
        const room = brRooms.get(playerId);
        if (!room) break;
        room.forEach(pid => {
          if (pid === playerId) return;
          const tw = conns.get(pid);
          if (tw) send(tw, { type: 'BR_SHOT', playerId, ...msg });
        });
        break;
      }

      case 'BR_HIT': {
        if (!player) break;
        const tw = conns.get(msg.targetId);
        if (tw) send(tw, { type: 'BR_DAMAGE', fromId: playerId, fromNick: player.nickname, damage: msg.damage, newHp: Math.max(0, (msg.currentHp || 1000) - msg.damage) });
        break;
      }

      case 'KB_RESULT': {
        if (!player) return;
        player.stats = player.stats || { wins: 0, games: 0 };
        player.stats.games++;
        if (msg.won) player.stats.wins++;
        await savePlayer(player);
        brRooms.delete(playerId);
    const lobbyId = playerLobby.get(playerId);
        if (lobbyId) {
          const lobby = await rGet('lobby:' + lobbyId);
          if (lobby) { lobby.status = 'waiting'; await rSet('lobby:' + lobbyId, lobby); broadcast(lobby.players, { type: 'LOBBY_UPDATED', lobby: await buildLobby(lobby) }); }
        }
        break;
      }
    }
  });

  ws.on('close', async () => {
    const playerId = wsMap.get(ws);
    if (!playerId) return;
    conns.delete(playerId);
    wsMap.delete(ws);
    mmLeave(playerId);

    const player = await getPlayer(playerId);
    if (player) {
      for (const fid of (player.friends||[])) {
        const fw = conns.get(fid);
        if (fw) send(fw, { type: 'FRIEND_OFFLINE', friendId: playerId });
      }
    }

    brRooms.delete(playerId);
    const lobbyId = playerLobby.get(playerId);
    if (lobbyId) {
      const lobby = await rGet('lobby:' + lobbyId);
      playerLobby.delete(playerId);
      if (lobby) {
        lobby.players = lobby.players.filter(id => id !== playerId);
        if (!lobby.players.length) { await rDel('lobby:' + lobbyId); }
        else {
          if (lobby.host === playerId) lobby.host = lobby.players[0];
          await rSet('lobby:' + lobbyId, lobby);
          broadcast(lobby.players, { type: 'LOBBY_UPDATED', lobby: await buildLobby(lobby) });
        }
      }
    }
  });
});

async function buildLobby(lobby) {
  const names = {};
  for (const pid of lobby.players) {
    const p = await getPlayer(pid);
    names[pid] = p?.nickname || '???';
  }
  return { ...lobby, playerNames: names };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('🎮 Apple Journey Server запущен на порту ' + PORT);
});
