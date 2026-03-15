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
//  БАЗА ДАННЫХ (файл — для Oracle Free Tier без доп. услуг)
// ============================================================
const DB_FILE = path.join(__dirname, 'db.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) {}
  return { players: {}, lobbies: {} };
}

function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch(e) {}
}

let db = loadDB();
setInterval(saveDB, 10000); // авто-сохранение каждые 10 сек

// ============================================================
//  АКТИВНЫЕ СОЕДИНЕНИЯ  { playerId -> ws }
// ============================================================
const connections = new Map(); // playerId -> ws
const wsToPlayer  = new Map(); // ws -> playerId

// ============================================================
//  ГЕНЕРАЦИЯ УНИКАЛЬНОГО PLAYER ID  (формат: AJ-XXXX-XXXX)
// ============================================================
function generatePlayerId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    const part1 = Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
    const part2 = Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
    id = `AJ-${part1}-${part2}`;
  } while (db.players[id]);
  return id;
}

// ============================================================
//  HELPERS
// ============================================================
function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(playerIds, msg) {
  playerIds.forEach(pid => {
    const ws = connections.get(pid);
    if (ws) send(ws, msg);
  });
}

function getOnlineStatus(playerId) {
  return connections.has(playerId);
}

function getLobbyByPlayer(playerId) {
  return Object.values(db.lobbies).find(l => l.players.includes(playerId));
}

// ============================================================
//  REST API
// ============================================================

// Регистрация / вход по nickname + device token
app.post('/api/auth', (req, res) => {
  const { nickname, deviceToken } = req.body;
  if (!nickname || nickname.trim().length < 2) {
    return res.status(400).json({ error: 'Никнейм слишком короткий' });
  }

  // Ищем существующего игрока по deviceToken
  if (deviceToken) {
    const existing = Object.values(db.players).find(p => p.deviceToken === deviceToken);
    if (existing) {
      return res.json({ playerId: existing.id, nickname: existing.nickname, isNew: false });
    }
  }

  // Новый игрок
  const playerId = generatePlayerId();
  const newToken = deviceToken || uuidv4();
  db.players[playerId] = {
    id: playerId,
    nickname: nickname.trim().slice(0, 25),
    deviceToken: newToken,
    createdAt: Date.now(),
    friends: [],
    friendRequests: [],   // входящие заявки
    sentRequests: [],     // исходящие заявки
    stats: { wins: 0, games: 0 }
  };
  saveDB();
  res.json({ playerId, nickname: db.players[playerId].nickname, deviceToken: newToken, isNew: true });
});

// Профиль игрока
app.get('/api/player/:id', (req, res) => {
  const player = db.players[req.params.id];
  if (!player) return res.status(404).json({ error: 'Игрок не найден' });
  res.json({
    id: player.id,
    nickname: player.nickname,
    online: getOnlineStatus(player.id),
    stats: player.stats,
    friendsCount: player.friends.length
  });
});

// Список друзей
app.get('/api/friends/:playerId', (req, res) => {
  const player = db.players[req.params.playerId];
  if (!player) return res.status(404).json({ error: 'Игрок не найден' });

  const friends = (player.friends || []).map(fid => {
    const f = db.players[fid];
    if (!f) return null;
    return { id: f.id, nickname: f.nickname, online: getOnlineStatus(fid), stats: f.stats };
  }).filter(Boolean);

  const incoming = (player.friendRequests || []).map(fid => {
    const f = db.players[fid];
    if (!f) return null;
    return { id: f.id, nickname: f.nickname };
  }).filter(Boolean);

  res.json({ friends, incoming });
});

// Удалить друга
app.delete('/api/friends/:playerId/:friendId', (req, res) => {
  const { playerId, friendId } = req.params;
  const player = db.players[playerId];
  const friend = db.players[friendId];
  if (!player || !friend) return res.status(404).json({ error: 'Не найден' });

  player.friends = (player.friends || []).filter(id => id !== friendId);
  friend.friends = (friend.friends || []).filter(id => id !== playerId);
  saveDB();
  res.json({ ok: true });
});

// Статус сервера
app.get('/api/status', (req, res) => {
  res.json({
    online: connections.size,
    lobbies: Object.keys(db.lobbies).length,
    players: Object.keys(db.players).length,
    uptime: Math.floor(process.uptime())
  });
});

// Главная страница
app.get('*', (req, res) => {
  const indexPath = __dirname + '/public/index.html';
  const rootPath = __dirname + '/index.html';
  if (require('fs').existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.sendFile(rootPath);
  }
});

// ============================================================
//  WEBSOCKET HANDLERS
// ============================================================
wss.on('connection', (ws) => {

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    const { type, playerId } = msg;
    const player = playerId ? db.players[playerId] : null;

    switch (type) {

      // ---------- Подключение игрока ----------
      case 'CONNECT': {
        if (!player) return send(ws, { type: 'ERROR', text: 'Игрок не найден' });

        // Закрыть старое соединение если было
        const oldWs = connections.get(playerId);
        if (oldWs && oldWs !== ws) oldWs.close();

        connections.set(playerId, ws);
        wsToPlayer.set(ws, playerId);

        send(ws, { type: 'CONNECTED', playerId, nickname: player.nickname });

        // Уведомить друзей об онлайне
        (player.friends || []).forEach(fid => {
          const fw = connections.get(fid);
          if (fw) send(fw, { type: 'FRIEND_ONLINE', friendId: playerId, nickname: player.nickname });
        });

        // Отправить входящие заявки
        if ((player.friendRequests || []).length > 0) {
          const reqs = player.friendRequests.map(fid => {
            const f = db.players[fid];
            return f ? { id: fid, nickname: f.nickname } : null;
          }).filter(Boolean);
          if (reqs.length) send(ws, { type: 'FRIEND_REQUESTS', requests: reqs });
        }
        break;
      }

      // ---------- Заявка в друзья ----------
      case 'FRIEND_REQUEST': {
        if (!player) return;
        const { targetId } = msg;
        const target = db.players[targetId];
        if (!target) return send(ws, { type: 'ERROR', text: 'Игрок с таким ID не найден' });
        if (targetId === playerId) return send(ws, { type: 'ERROR', text: 'Нельзя добавить себя' });
        if ((player.friends || []).includes(targetId)) return send(ws, { type: 'ERROR', text: 'Уже в друзьях' });
        if ((player.sentRequests || []).includes(targetId)) return send(ws, { type: 'ERROR', text: 'Заявка уже отправлена' });

        if (!player.sentRequests) player.sentRequests = [];
        if (!target.friendRequests) target.friendRequests = [];

        player.sentRequests.push(targetId);
        target.friendRequests.push(playerId);
        saveDB();

        send(ws, { type: 'FRIEND_REQUEST_SENT', targetId, targetNick: target.nickname });

        // Уведомить цель если онлайн
        const tws = connections.get(targetId);
        if (tws) send(tws, { type: 'FRIEND_REQUEST_IN', fromId: playerId, fromNick: player.nickname });
        break;
      }

      // ---------- Принять заявку ----------
      case 'FRIEND_ACCEPT': {
        if (!player) return;
        const { fromId } = msg;
        const from = db.players[fromId];
        if (!from) return;

        player.friendRequests = (player.friendRequests || []).filter(id => id !== fromId);
        from.sentRequests = (from.sentRequests || []).filter(id => id !== playerId);

        if (!player.friends) player.friends = [];
        if (!from.friends) from.friends = [];

        if (!player.friends.includes(fromId)) player.friends.push(fromId);
        if (!from.friends.includes(playerId)) from.friends.push(playerId);
        saveDB();

        send(ws, { type: 'FRIEND_ADDED', friend: { id: fromId, nickname: from.nickname, online: getOnlineStatus(fromId) } });

        const fromWs = connections.get(fromId);
        if (fromWs) send(fromWs, { type: 'FRIEND_ADDED', friend: { id: playerId, nickname: player.nickname, online: true } });
        break;
      }

      // ---------- Отклонить заявку ----------
      case 'FRIEND_DECLINE': {
        if (!player) return;
        const { fromId } = msg;
        const from = db.players[fromId];
        player.friendRequests = (player.friendRequests || []).filter(id => id !== fromId);
        if (from) from.sentRequests = (from.sentRequests || []).filter(id => id !== playerId);
        saveDB();
        send(ws, { type: 'FRIEND_DECLINED', fromId });
        break;
      }

      // ---------- Создать лобби ----------
      case 'LOBBY_CREATE': {
        if (!player) return;

        // Удалить из старого лобби если был
        const oldLobby = getLobbyByPlayer(playerId);
        if (oldLobby) {
          oldLobby.players = oldLobby.players.filter(id => id !== playerId);
          if (oldLobby.players.length === 0) delete db.lobbies[oldLobby.id];
        }

        const lobbyId = uuidv4().slice(0, 8).toUpperCase();
        db.lobbies[lobbyId] = {
          id: lobbyId,
          host: playerId,
          players: [playerId],
          maxPlayers: 4,
          status: 'waiting',
          createdAt: Date.now()
        };
        saveDB();
        send(ws, { type: 'LOBBY_CREATED', lobbyId, lobby: db.lobbies[lobbyId] });
        break;
      }

      // ---------- Пригласить в лобби ----------
      case 'LOBBY_INVITE': {
        if (!player) return;
        const { friendId } = msg;
        const lobby = getLobbyByPlayer(playerId);
        if (!lobby) return send(ws, { type: 'ERROR', text: 'Сначала создай лобби' });
        if (lobby.players.length >= lobby.maxPlayers) return send(ws, { type: 'ERROR', text: 'Лобби заполнено (макс. 4)' });
        if (!(player.friends || []).includes(friendId)) return send(ws, { type: 'ERROR', text: 'Не в списке друзей' });

        const friendWs = connections.get(friendId);
        const friend = db.players[friendId];
        if (!friendWs || !friend) return send(ws, { type: 'ERROR', text: 'Друг не в сети' });

        send(friendWs, {
          type: 'LOBBY_INVITE_IN',
          lobbyId: lobby.id,
          hostId: playerId,
          hostNick: player.nickname
        });
        send(ws, { type: 'LOBBY_INVITE_SENT', friendId, friendNick: friend.nickname });
        break;
      }

      // ---------- Принять/отклонить приглашение ----------
      case 'LOBBY_JOIN': {
        if (!player) return;
        const { lobbyId } = msg;
        const lobby = db.lobbies[lobbyId];
        if (!lobby) return send(ws, { type: 'ERROR', text: 'Лобби не найдено' });
        if (lobby.players.length >= lobby.maxPlayers) return send(ws, { type: 'ERROR', text: 'Лобби заполнено' });
        if (lobby.status !== 'waiting') return send(ws, { type: 'ERROR', text: 'Игра уже началась' });

        // Покинуть старое лобби
        const oldLobby = getLobbyByPlayer(playerId);
        if (oldLobby && oldLobby.id !== lobbyId) {
          oldLobby.players = oldLobby.players.filter(id => id !== playerId);
          if (oldLobby.players.length === 0) delete db.lobbies[oldLobby.id];
          broadcast(oldLobby.players, { type: 'LOBBY_UPDATED', lobby: oldLobby });
        }

        if (!lobby.players.includes(playerId)) lobby.players.push(playerId);
        saveDB();

        const lobbyData = buildLobbyData(lobby);
        broadcast(lobby.players, { type: 'LOBBY_UPDATED', lobby: lobbyData });
        break;
      }

      case 'LOBBY_DECLINE': {
        const { lobbyId } = msg;
        const lobby = db.lobbies[lobbyId];
        if (lobby) {
          const hostWs = connections.get(lobby.host);
          if (hostWs) send(hostWs, { type: 'LOBBY_INVITE_DECLINED', byId: playerId, byNick: player?.nickname });
        }
        break;
      }

      // ---------- Покинуть лобби ----------
      case 'LOBBY_LEAVE': {
        if (!player) return;
        const lobby = getLobbyByPlayer(playerId);
        if (!lobby) return;

        lobby.players = lobby.players.filter(id => id !== playerId);

        if (lobby.players.length === 0) {
          delete db.lobbies[lobby.id];
        } else {
          // Если хост вышел — передать хостинг следующему
          if (lobby.host === playerId) lobby.host = lobby.players[0];
          saveDB();
          broadcast(lobby.players, { type: 'LOBBY_UPDATED', lobby: buildLobbyData(lobby) });
        }
        saveDB();
        send(ws, { type: 'LOBBY_LEFT' });
        break;
      }

      // ---------- Получить лобби ----------
      case 'LOBBY_GET': {
        const lobby = getLobbyByPlayer(playerId);
        if (lobby) {
          send(ws, { type: 'LOBBY_DATA', lobby: buildLobbyData(lobby) });
        } else {
          send(ws, { type: 'LOBBY_DATA', lobby: null });
        }
        break;
      }

      // ---------- Начать KB матч ----------
      case 'LOBBY_START_KB': {
        if (!player) return;
        const lobby = getLobbyByPlayer(playerId);
        if (!lobby) return send(ws, { type: 'ERROR', text: 'Нет лобби' });
        if (lobby.host !== playerId) return send(ws, { type: 'ERROR', text: 'Только хост может начать' });
        if (lobby.players.length < 1) return send(ws, { type: 'ERROR', text: 'Нужен хотя бы 1 игрок' });

        lobby.status = 'kb';
        saveDB();

        // Разделить: игрок 1 — команда A, остальные — команда B (или по-другому)
        // Реальный игрок -> команда A, друг -> команда B
        const teams = assignTeams(lobby.players);
        broadcast(lobby.players, {
          type: 'LOBBY_KB_START',
          lobbyId: lobby.id,
          teams,
          players: lobby.players.map(pid => ({
            id: pid,
            nickname: db.players[pid]?.nickname,
            team: teams[pid]
          }))
        });
        break;
      }

      // ---------- KB матч завершён ----------
      case 'KB_RESULT': {
        if (!player) return;
        const lobby = getLobbyByPlayer(playerId);
        if (!lobby || lobby.status !== 'kb') return;

        const { won } = msg;
        player.stats = player.stats || { wins: 0, games: 0 };
        player.stats.games++;
        if (won) player.stats.wins++;
        saveDB();

        // Сбросить статус лобби
        lobby.status = 'waiting';
        saveDB();
        broadcast(lobby.players, { type: 'LOBBY_UPDATED', lobby: buildLobbyData(lobby) });
        break;
      }

      // ---------- Чат в лобби ----------
      case 'LOBBY_CHAT': {
        if (!player) return;
        const lobby = getLobbyByPlayer(playerId);
        if (!lobby) return;
        const text = (msg.text || '').trim().slice(0, 100);
        if (!text) return;
        broadcast(lobby.players, {
          type: 'LOBBY_CHAT_MSG',
          fromId: playerId,
          fromNick: player.nickname,
          text
        });
        break;
      }

    }
  });

  ws.on('close', () => {
    const playerId = wsToPlayer.get(ws);
    if (!playerId) return;

    connections.delete(playerId);
    wsToPlayer.delete(ws);

    const player = db.players[playerId];
    if (player) {
      // Уведомить друзей об оффлайне
      (player.friends || []).forEach(fid => {
        const fw = connections.get(fid);
        if (fw) send(fw, { type: 'FRIEND_OFFLINE', friendId: playerId });
      });
    }

    // Убрать из лобби
    const lobby = getLobbyByPlayer(playerId);
    if (lobby) {
      lobby.players = lobby.players.filter(id => id !== playerId);
      if (lobby.players.length === 0) {
        delete db.lobbies[lobby.id];
      } else {
        if (lobby.host === playerId) lobby.host = lobby.players[0];
        saveDB();
        broadcast(lobby.players, { type: 'LOBBY_UPDATED', lobby: buildLobbyData(lobby) });
      }
      saveDB();
    }
  });
});

// ============================================================
//  HELPERS
// ============================================================
function buildLobbyData(lobby) {
  return {
    ...lobby,
    playerNames: lobby.players.reduce((acc, pid) => {
      acc[pid] = db.players[pid]?.nickname || '???';
      return acc;
    }, {})
  };
}

function assignTeams(playerIds) {
  // Команда A: хост, Команда B: остальные (или чередуем)
  const teams = {};
  playerIds.forEach((pid, i) => {
    teams[pid] = i % 2 === 0 ? 'A' : 'B';
  });
  return teams;
}

// ============================================================
//  ОЧИСТКА СТАРЫХ ЛОББИ (старше 2 часов)
// ============================================================
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  Object.keys(db.lobbies).forEach(id => {
    if (db.lobbies[id].createdAt < cutoff) delete db.lobbies[id];
  });
  saveDB();
}, 30 * 60 * 1000);

// ============================================================
//  СТАРТ
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Apple Journey Server запущен на порту ${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`🌐 HTTP: http://localhost:${PORT}`);
});
