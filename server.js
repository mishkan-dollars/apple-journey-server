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
//  DATABASE
// ============================================================
const DB_FILE = path.join(__dirname, 'db.json');
function loadDB() {
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) {}
  return { players: {}, lobbies: {} };
}
function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch(e) {}
}
let db = loadDB();
setInterval(saveDB, 10000);

// ============================================================
//  CONNECTIONS
// ============================================================
const connections = new Map(); // playerId -> ws
const wsToPlayer  = new Map(); // ws -> playerId

// ============================================================
//  ACTIVE GAME ROOMS  { roomId -> GameRoom }
// ============================================================
const gameRooms = new Map();

// ============================================================
//  GENERATE PLAYER ID
// ============================================================
function generatePlayerId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    const p1 = Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
    const p2 = Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
    id = `AJ-${p1}-${p2}`;
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
  playerIds.forEach(pid => { const ws = connections.get(pid); if (ws) send(ws, msg); });
}
function getOnlineStatus(pid) { return connections.has(pid); }
function getLobbyByPlayer(pid) {
  return Object.values(db.lobbies).find(l => l.players.includes(pid));
}
function buildLobbyData(lobby) {
  return { ...lobby, playerNames: lobby.players.reduce((a,pid) => { a[pid] = db.players[pid]?.nickname||'???'; return a; }, {}) };
}
function assignTeams(playerIds) {
  const t = {};
  playerIds.forEach((pid,i) => { t[pid] = i%2===0?'A':'B'; });
  return t;
}

// ============================================================
//  GAME ROOM — real-time multiplayer state
// ============================================================
class GameRoom {
  constructor(lobbyId, players) {
    this.id = lobbyId;
    this.players = players; // [{id, nickname, charId, team}]
    this.states = {};       // playerId -> {x,y,hp,maxHp,alive,charIcon,nick,team,superCharge}
    this.kills = {};        // playerId -> count
    this.remoteProjectiles = []; // projectiles from other players to render
    this.tick = 0;
    this.startTime = Date.now();
    this.finished = false;

    // Init states
    players.forEach(p => {
      this.states[p.id] = {
        x: 800 + Math.random()*400 - 200,
        y: 600 + Math.random()*400 - 200,
        hp: 1000, maxHp: 1000,
        alive: true,
        charIcon: p.charIcon || '🍎',
        nick: p.nickname,
        team: p.team,
        superCharge: 0,
        emojiId: null
      };
      this.kills[p.id] = 0;
    });

    // Broadcast state every 50ms
    this.interval = setInterval(() => this.broadcastState(), 50);
  }

  updateState(playerId, state) {
    if (this.states[playerId]) {
      Object.assign(this.states[playerId], state);
    }
  }

  addProjectile(proj) {
    // Forward projectile to all other players in room
    this.players.forEach(p => {
      if (p.id !== proj.ownerId) {
        const ws = connections.get(p.id);
        if (ws) send(ws, { type: 'REMOTE_PROJECTILE', proj });
      }
    });
  }

  applyHit(fromId, toId, damage) {
    const state = this.states[toId];
    if (!state || !state.alive) return;
    state.hp = Math.max(0, state.hp - damage);
    if (state.hp <= 0) {
      state.alive = false;
      state.hp = 0;
      this.kills[fromId] = (this.kills[fromId] || 0) + 1;
      // Notify target they died
      const ws = connections.get(toId);
      if (ws) send(ws, { type: 'REMOTE_KILLED', byId: fromId, byNick: this.states[fromId]?.nick || '???' });
      // Notify killer
      const kws = connections.get(fromId);
      if (kws) send(kws, { type: 'REMOTE_KILL_CONFIRMED', targetId: toId, targetNick: state.nick });
      // Broadcast kill
      this.broadcastAll({ type: 'REMOTE_PLAYER_DIED', playerId: toId, nick: state.nick, killerNick: this.states[fromId]?.nick });
    }
    // Send updated HP to target
    const tws = connections.get(toId);
    if (tws) send(tws, { type: 'REMOTE_DAMAGE', damage, fromId, newHp: state.hp });
  }

  broadcastState() {
    if (this.finished) return;
    const msg = {
      type: 'ROOM_STATE',
      states: this.states,
      kills: this.kills,
      tick: this.tick++
    };
    this.players.forEach(p => {
      const ws = connections.get(p.id);
      if (ws) send(ws, msg);
    });
  }

  broadcastAll(msg) {
    this.players.forEach(p => {
      const ws = connections.get(p.id);
      if (ws) send(ws, msg);
    });
  }

  finish() {
    this.finished = true;
    clearInterval(this.interval);
    gameRooms.delete(this.id);
  }
}

// ============================================================
//  REST API
// ============================================================
app.post('/api/auth', (req, res) => {
  const { nickname, deviceToken } = req.body;
  if (!nickname || nickname.trim().length < 2) return res.status(400).json({ error: 'Слишком короткий ник' });
  if (deviceToken) {
    const ex = Object.values(db.players).find(p => p.deviceToken === deviceToken);
    if (ex) {
      // Update nickname if changed
      if (ex.nickname !== nickname.trim()) {
        ex.nickname = nickname.trim().slice(0,25);
        saveDB();
      }
      return res.json({ playerId: ex.id, nickname: ex.nickname, deviceToken: ex.deviceToken, isNew: false });
    }
  }
  const playerId = generatePlayerId();
  const newToken = deviceToken || uuidv4();
  db.players[playerId] = {
    id: playerId,
    nickname: nickname.trim().slice(0,25),
    deviceToken: newToken,
    createdAt: Date.now(),
    friends: [], friendRequests: [], sentRequests: [],
    stats: { wins: 0, games: 0 }
  };
  saveDB();
  res.json({ playerId, nickname: db.players[playerId].nickname, deviceToken: newToken, isNew: true });
});

app.get('/api/player/:id', (req, res) => {
  const p = db.players[req.params.id];
  if (!p) return res.status(404).json({ error: 'Не найден' });
  res.json({ id: p.id, nickname: p.nickname, online: getOnlineStatus(p.id), stats: p.stats, friendsCount: (p.friends||[]).length });
});

app.get('/api/friends/:playerId', (req, res) => {
  const p = db.players[req.params.playerId];
  if (!p) return res.status(404).json({ error: 'Не найден' });
  const friends = (p.friends||[]).map(fid => {
    const f = db.players[fid];
    return f ? { id: f.id, nickname: f.nickname, online: getOnlineStatus(fid), stats: f.stats } : null;
  }).filter(Boolean);
  const incoming = (p.friendRequests||[]).map(fid => {
    const f = db.players[fid];
    return f ? { id: fid, nickname: f.nickname } : null;
  }).filter(Boolean);
  res.json({ friends, incoming });
});

app.get('/api/status', (req, res) => {
  res.json({ online: connections.size, lobbies: Object.keys(db.lobbies).length, rooms: gameRooms.size, players: Object.keys(db.players).length, uptime: Math.floor(process.uptime()) });
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
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }
    const { type, playerId } = msg;
    const player = playerId ? db.players[playerId] : null;

    switch(type) {

      case 'CONNECT': {
        if (!player) return send(ws, { type:'ERROR', text:'Игрок не найден' });
        const old = connections.get(playerId);
        if (old && old !== ws) old.close();
        connections.set(playerId, ws);
        wsToPlayer.set(ws, playerId);
        send(ws, { type:'CONNECTED', playerId, nickname: player.nickname });
        (player.friends||[]).forEach(fid => { const fw=connections.get(fid); if(fw) send(fw,{type:'FRIEND_ONLINE',friendId:playerId,nickname:player.nickname}); });
        if ((player.friendRequests||[]).length > 0) {
          const reqs = player.friendRequests.map(fid=>{ const f=db.players[fid]; return f?{id:fid,nickname:f.nickname}:null; }).filter(Boolean);
          if (reqs.length) send(ws,{type:'FRIEND_REQUESTS',requests:reqs});
        }
        break;
      }

      case 'FRIEND_REQUEST': {
        if (!player) return;
        const { targetId } = msg;
        const target = db.players[targetId];
        if (!target) return send(ws,{type:'ERROR',text:'Игрок не найден'});
        if (targetId===playerId) return send(ws,{type:'ERROR',text:'Нельзя добавить себя'});
        if ((player.friends||[]).includes(targetId)) return send(ws,{type:'ERROR',text:'Уже в друзьях'});
        if ((player.sentRequests||[]).includes(targetId)) return send(ws,{type:'ERROR',text:'Заявка уже отправлена'});
        if (!player.sentRequests) player.sentRequests=[];
        if (!target.friendRequests) target.friendRequests=[];
        player.sentRequests.push(targetId);
        target.friendRequests.push(playerId);
        saveDB();
        send(ws,{type:'FRIEND_REQUEST_SENT',targetId,targetNick:target.nickname});
        const tw=connections.get(targetId);
        if(tw) send(tw,{type:'FRIEND_REQUEST_IN',fromId:playerId,fromNick:player.nickname});
        break;
      }

      case 'FRIEND_ACCEPT': {
        if (!player) return;
        const { fromId } = msg;
        const from = db.players[fromId];
        if (!from) return;
        player.friendRequests=(player.friendRequests||[]).filter(id=>id!==fromId);
        from.sentRequests=(from.sentRequests||[]).filter(id=>id!==playerId);
        if (!player.friends) player.friends=[];
        if (!from.friends) from.friends=[];
        if (!player.friends.includes(fromId)) player.friends.push(fromId);
        if (!from.friends.includes(playerId)) from.friends.push(playerId);
        saveDB();
        send(ws,{type:'FRIEND_ADDED',friend:{id:fromId,nickname:from.nickname,online:getOnlineStatus(fromId)}});
        const fw=connections.get(fromId);
        if(fw) send(fw,{type:'FRIEND_ADDED',friend:{id:playerId,nickname:player.nickname,online:true}});
        break;
      }

      case 'FRIEND_DECLINE': {
        if (!player) return;
        const { fromId } = msg;
        const from = db.players[fromId];
        player.friendRequests=(player.friendRequests||[]).filter(id=>id!==fromId);
        if(from) from.sentRequests=(from.sentRequests||[]).filter(id=>id!==playerId);
        saveDB();
        send(ws,{type:'FRIEND_DECLINED',fromId});
        break;
      }

      case 'LOBBY_CREATE': {
        if (!player) return;
        const old = getLobbyByPlayer(playerId);
        if (old) { old.players=old.players.filter(id=>id!==playerId); if(!old.players.length) delete db.lobbies[old.id]; }
        const lid = uuidv4().slice(0,8).toUpperCase();
        db.lobbies[lid]={ id:lid, host:playerId, players:[playerId], maxPlayers:4, status:'waiting', createdAt:Date.now() };
        saveDB();
        send(ws,{type:'LOBBY_CREATED',lobbyId:lid,lobby:db.lobbies[lid]});
        break;
      }

      case 'LOBBY_INVITE': {
        if (!player) return;
        const { friendId } = msg;
        const lobby = getLobbyByPlayer(playerId);
        if (!lobby) return send(ws,{type:'ERROR',text:'Сначала создай лобби'});
        if (lobby.players.length>=lobby.maxPlayers) return send(ws,{type:'ERROR',text:'Лобби заполнено'});
        if (!(player.friends||[]).includes(friendId)) return send(ws,{type:'ERROR',text:'Не в друзьях'});
        const fw=connections.get(friendId);
        const fr=db.players[friendId];
        if (!fw||!fr) return send(ws,{type:'ERROR',text:'Друг не в сети'});
        send(fw,{type:'LOBBY_INVITE_IN',lobbyId:lobby.id,hostId:playerId,hostNick:player.nickname});
        send(ws,{type:'LOBBY_INVITE_SENT',friendId,friendNick:fr.nickname});
        break;
      }

      case 'LOBBY_JOIN': {
        if (!player) return;
        const { lobbyId } = msg;
        const lobby = db.lobbies[lobbyId];
        if (!lobby) return send(ws,{type:'ERROR',text:'Лобби не найдено'});
        if (lobby.players.length>=lobby.maxPlayers) return send(ws,{type:'ERROR',text:'Лобби заполнено'});
        if (lobby.status!=='waiting') return send(ws,{type:'ERROR',text:'Игра уже началась'});
        const old=getLobbyByPlayer(playerId);
        if(old&&old.id!==lobbyId){ old.players=old.players.filter(id=>id!==playerId); if(!old.players.length) delete db.lobbies[old.id]; broadcast(old.players,{type:'LOBBY_UPDATED',lobby:buildLobbyData(old)}); }
        if(!lobby.players.includes(playerId)) lobby.players.push(playerId);
        saveDB();
        broadcast(lobby.players,{type:'LOBBY_UPDATED',lobby:buildLobbyData(lobby)});
        break;
      }

      case 'LOBBY_DECLINE': {
        const { lobbyId } = msg;
        const lobby=db.lobbies[lobbyId];
        if(lobby){ const hw=connections.get(lobby.host); if(hw) send(hw,{type:'LOBBY_INVITE_DECLINED',byId:playerId,byNick:player?.nickname}); }
        break;
      }

      case 'LOBBY_LEAVE': {
        if (!player) return;
        const lobby=getLobbyByPlayer(playerId);
        if (!lobby) return;
        lobby.players=lobby.players.filter(id=>id!==playerId);
        if(!lobby.players.length){ delete db.lobbies[lobby.id]; }
        else { if(lobby.host===playerId) lobby.host=lobby.players[0]; saveDB(); broadcast(lobby.players,{type:'LOBBY_UPDATED',lobby:buildLobbyData(lobby)}); }
        saveDB();
        send(ws,{type:'LOBBY_LEFT'});
        break;
      }

      case 'LOBBY_GET': {
        const lobby=getLobbyByPlayer(playerId);
        send(ws,{type:'LOBBY_DATA',lobby:lobby?buildLobbyData(lobby):null});
        break;
      }

      // ============================================================
      //  START KB — creates real game room
      // ============================================================
      case 'LOBBY_START_KB': {
        if (!player) return;
        const lobby=getLobbyByPlayer(playerId);
        if (!lobby) return send(ws,{type:'ERROR',text:'Нет лобби'});
        if (lobby.host!==playerId) return send(ws,{type:'ERROR',text:'Только хост'});
        lobby.status='kb';
        saveDB();
        const teams=assignTeams(lobby.players);
        // Collect player info including charIcon from message
        const playersInfo = lobby.players.map(pid=>({
          id: pid,
          nickname: db.players[pid]?.nickname||'???',
          team: teams[pid],
          charIcon: msg.playerIcons?.[pid] || '🍎'
        }));
        // Create game room
        const room = new GameRoom(lobby.id, playersInfo);
        gameRooms.set(lobby.id, room);
        broadcast(lobby.players,{
          type:'LOBBY_KB_START',
          lobbyId:lobby.id,
          roomId:lobby.id,
          teams,
          players: playersInfo
        });
        break;
      }

      // ============================================================
      //  REAL-TIME GAME MESSAGES
      // ============================================================

      // Player sends their position every 50ms
      case 'GAME_STATE': {
        const room = findRoomByPlayer(playerId);
        if (!room) return;
        room.updateState(playerId, {
          x: msg.x, y: msg.y,
          hp: msg.hp, maxHp: msg.maxHp,
          alive: msg.alive,
          charIcon: msg.charIcon,
          nick: player?.nickname,
          superCharge: msg.superCharge,
          emojiId: msg.emojiId
        });
        break;
      }

      // Player fires a projectile — broadcast to others
      case 'GAME_PROJECTILE': {
        const room = findRoomByPlayer(playerId);
        if (!room) return;
        room.addProjectile({ ...msg.proj, ownerId: playerId, ownerNick: player?.nickname });
        break;
      }

      // Player reports they hit another player
      case 'GAME_HIT': {
        const room = findRoomByPlayer(playerId);
        if (!room) return;
        room.applyHit(playerId, msg.targetId, msg.damage);
        break;
      }

      // Player finished their game (died or won)
      case 'KB_RESULT': {
        if (!player) return;
        const { won } = msg;
        player.stats = player.stats||{wins:0,games:0};
        player.stats.games++;
        if(won) player.stats.wins++;
        saveDB();
        const lobby=getLobbyByPlayer(playerId);
        if(lobby){ lobby.status='waiting'; saveDB(); broadcast(lobby.players,{type:'LOBBY_UPDATED',lobby:buildLobbyData(lobby)}); }
        const room=findRoomByPlayer(playerId);
        if(room&&msg.finalStats){
          room.broadcastAll({type:'PLAYER_FINAL_STATS',playerId,stats:msg.finalStats,nick:player.nickname});
        }
        break;
      }

      case 'LOBBY_CHAT': {
        if (!player) return;
        const lobby=getLobbyByPlayer(playerId);
        if (!lobby) return;
        const text=(msg.text||'').trim().slice(0,100);
        if(!text) return;
        broadcast(lobby.players,{type:'LOBBY_CHAT_MSG',fromId:playerId,fromNick:player.nickname,text});
        break;
      }

      // Gifts
      case 'SEND_GIFT': {
        if (!player) return;
        const { targetId, giftType, amount } = msg;
        const tw=connections.get(targetId);
        const target=db.players[targetId];
        if (!tw||!target) return send(ws,{type:'ERROR',text:'Игрок не в сети'});
        const desc = giftType==='money'?`${amount} F-Bucks`:giftType==='crystals'?`${amount} кристаллов`:'подарок';
        send(tw,{type:'GIFT_RECEIVED',fromId:playerId,fromNick:player.nickname,giftType,amount,[giftType]:amount,desc});
        break;
      }

      // Trade
      case 'TRADE_OFFER': {
        if (!player) return;
        const { targetId, offer } = msg;
        const tw=connections.get(targetId);
        if (!tw) return send(ws,{type:'ERROR',text:'Игрок не в сети'});
        send(tw,{type:'TRADE_REQUEST',fromId:playerId,fromNick:player.nickname,offer});
        break;
      }
      case 'TRADE_ACCEPT': {
        if (!player) return;
        const { fromId } = msg;
        const fw=connections.get(fromId);
        if(fw) send(fw,{type:'TRADE_ACCEPTED',byId:playerId,byNick:player.nickname});
        break;
      }
      case 'TRADE_DECLINE': {
        if (!player) return;
        const { fromId } = msg;
        const fw=connections.get(fromId);
        if(fw) send(fw,{type:'TRADE_DECLINED',byId:playerId,byNick:player.nickname});
        break;
      }

      // Click battle
      case 'CLICKBATTLE_CHALLENGE': {
        if (!player) return;
        const tw=connections.get(msg.targetId);
        if(!tw) return send(ws,{type:'ERROR',text:'Не в сети'});
        send(tw,{type:'CLICKBATTLE_INVITE',fromId:playerId,fromNick:player.nickname});
        break;
      }
      case 'CLICKBATTLE_ACCEPT': {
        if (!player) return;
        const fw=connections.get(msg.targetId);
        if(!fw) return;
        send(ws,{type:'CLICKBATTLE_START',oppNick:db.players[msg.targetId]?.nickname||'?',oppId:msg.targetId});
        send(fw,{type:'CLICKBATTLE_START',oppNick:player.nickname,oppId:playerId});
        break;
      }
      case 'CLICKBATTLE_CLICK': {
        if (!player) return;
        // Find opponent — stored in active cb sessions (simple: broadcast to same session)
        // For simplicity, find who challenged whom via active ws data
        const targetId = ws._cbOpponent;
        if(targetId){ const tw=connections.get(targetId); if(tw) send(tw,{type:'CLICKBATTLE_UPDATE',oppScore:msg.score}); }
        break;
      }
      case 'CLICKBATTLE_DONE': {
        if (!player) return;
        const targetId = ws._cbOpponent;
        if(targetId){
          const tw=connections.get(targetId);
          const myScore=msg.score;
          const oppScore=ws._cbOppScore||0;
          const winnerId=myScore>=oppScore?playerId:targetId;
          send(ws,{type:'CLICKBATTLE_END',winnerId,myScore,oppScore});
          if(tw) send(tw,{type:'CLICKBATTLE_END',winnerId,myScore:oppScore,oppScore:myScore});
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const playerId=wsToPlayer.get(ws);
    if(!playerId) return;
    connections.delete(playerId);
    wsToPlayer.delete(ws);
    const player=db.players[playerId];
    if(player) (player.friends||[]).forEach(fid=>{ const fw=connections.get(fid); if(fw) send(fw,{type:'FRIEND_OFFLINE',friendId:playerId}); });
    const lobby=getLobbyByPlayer(playerId);
    if(lobby){
      lobby.players=lobby.players.filter(id=>id!==playerId);
      if(!lobby.players.length){ delete db.lobbies[lobby.id]; }
      else { if(lobby.host===playerId) lobby.host=lobby.players[0]; saveDB(); broadcast(lobby.players,{type:'LOBBY_UPDATED',lobby:buildLobbyData(lobby)}); }
      saveDB();
    }
    // Remove from game room
    const room=findRoomByPlayer(playerId);
    if(room){
      const state=room.states[playerId];
      if(state){ state.alive=false; room.broadcastAll({type:'REMOTE_PLAYER_DIED',playerId,nick:player?.nickname,killerNick:'disconnect'}); }
    }
  });
});

function findRoomByPlayer(playerId) {
  for(const room of gameRooms.values()) {
    if(room.players.find(p=>p.id===playerId)) return room;
  }
  return null;
}

// Cleanup old lobbies
setInterval(() => {
  const cutoff=Date.now()-2*60*60*1000;
  Object.keys(db.lobbies).forEach(id=>{ if(db.lobbies[id].createdAt<cutoff) delete db.lobbies[id]; });
  saveDB();
}, 30*60*1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Apple Journey Server запущен на порту ${PORT}`);
});
