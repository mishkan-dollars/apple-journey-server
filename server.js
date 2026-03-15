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

async function redisGet(key) {
  try {
    const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const data = await res.json();
    if (data.result === null || data.result === undefined) return null;
    try { return JSON.parse(data.result); } catch(e) { return data.result; }
  } catch(e) { console.error('Redis GET error:', e); return null; }
}

async function redisSet(key, value) {
  try {
    await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(value) })
    });
  } catch(e) { console.error('Redis SET error:', e); }
}

async function redisDel(key) {
  try {
    await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
  } catch(e) {}
}

async function redisKeys(pattern) {
  try {
    const res = await fetch(`${REDIS_URL}/keys/${encodeURIComponent(pattern)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const data = await res.json();
    return data.result || [];
  } catch(e) { return []; }
}

// ============================================================
//  PLAYER HELPERS
// ============================================================
async function getPlayer(id) { return await redisGet(`player:${id}`); }
async function savePlayer(p) { await redisSet(`player:${p.id}`, p); }
async function getLobby(id) { return await redisGet(`lobby:${id}`); }
async function saveLobby(l) { await redisSet(`lobby:${l.id}`, l); }
async function delLobby(id) { await redisDel(`lobby:${id}`); }
async function getPlayerByToken(token) {
  const id = await redisGet(`token:${token}`);
  if (!id) return null;
  return await getPlayer(id);
}

// ============================================================
//  CONNECTIONS
// ============================================================
const connections = new Map();
const wsToPlayer  = new Map();
const gameRooms   = new Map();
const playerLobbies = new Map(); // playerId -> lobbyId (in-memory)

// ============================================================
//  GENERATE ID
// ============================================================
function generatePlayerId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const p1 = Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
  const p2 = Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
  return `AJ-${p1}-${p2}`;
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

// ============================================================
//  GAME ROOM
// ============================================================
class GameRoom {
  constructor(lobbyId, players) {
    this.id = lobbyId;
    this.players = players;
    this.states = {};
    this.kills = {};
    this.finished = false;
    this.tick = 0;

    players.forEach(p => {
      this.states[p.id] = {
        x: 800 + Math.random()*400-200, y: 600 + Math.random()*400-200,
        hp: 1000, maxHp: 1000, alive: true,
        charIcon: p.charIcon||'🍎', nick: p.nickname, team: p.team, superCharge: 0, emojiId: null
      };
      this.kills[p.id] = 0;
    });

    this.interval = setInterval(() => this.broadcastState(), 50);
  }

  updateState(pid, state) {
    if (this.states[pid]) Object.assign(this.states[pid], state);
  }

  addProjectile(proj) {
    this.players.forEach(p => {
      if (p.id !== proj.ownerId) {
        const ws = connections.get(p.id);
        if (ws) send(ws, { type:'REMOTE_PROJECTILE', proj });
      }
    });
  }

  applyHit(fromId, toId, damage) {
    const state = this.states[toId];
    if (!state || !state.alive) return;
    state.hp = Math.max(0, state.hp - damage);
    if (state.hp <= 0) {
      state.alive = false;
      this.kills[fromId] = (this.kills[fromId]||0) + 1;
      const tws = connections.get(toId);
      if (tws) send(tws, { type:'REMOTE_KILLED', byId:fromId, byNick:this.states[fromId]?.nick||'???' });
      const kws = connections.get(fromId);
      if (kws) send(kws, { type:'REMOTE_KILL_CONFIRMED', targetId:toId, targetNick:state.nick });
      this.broadcastAll({ type:'REMOTE_PLAYER_DIED', playerId:toId, nick:state.nick, killerNick:this.states[fromId]?.nick });
    } else {
      const tws = connections.get(toId);
      if (tws) send(tws, { type:'REMOTE_DAMAGE', damage, fromId, newHp:state.hp });
    }
  }

  broadcastState() {
    if (this.finished) return;
    const msg = { type:'ROOM_STATE', states:this.states, kills:this.kills, tick:this.tick++ };
    this.players.forEach(p => { const ws=connections.get(p.id); if(ws) send(ws,msg); });
  }

  broadcastAll(msg) {
    this.players.forEach(p => { const ws=connections.get(p.id); if(ws) send(ws,msg); });
  }

  finish() {
    this.finished = true;
    clearInterval(this.interval);
    gameRooms.delete(this.id);
  }
}

function findRoomByPlayer(pid) {
  for (const room of gameRooms.values()) {
    if (room.players.find(p => p.id === pid)) return room;
  }
  return null;
}

// ============================================================
//  REST API
// ============================================================
app.post('/api/auth', async (req, res) => {
  const { nickname, deviceToken } = req.body;
  if (!nickname || nickname.trim().length < 2) return res.status(400).json({ error:'Слишком короткий ник' });

  // Найти по токену
  if (deviceToken) {
    const existing = await getPlayerByToken(deviceToken);
    if (existing) {
      if (existing.nickname !== nickname.trim()) {
        existing.nickname = nickname.trim().slice(0,25);
        await savePlayer(existing);
      }
      return res.json({ playerId:existing.id, nickname:existing.nickname, deviceToken:existing.deviceToken, isNew:false });
    }
  }

  // Новый игрок
  const playerId = generatePlayerId();
  const newToken = deviceToken || uuidv4();
  const player = {
    id: playerId,
    nickname: nickname.trim().slice(0,25),
    deviceToken: newToken,
    createdAt: Date.now(),
    friends: [], friendRequests: [], sentRequests: [],
    stats: { wins:0, games:0 }
  };
  await savePlayer(player);
  await redisSet(`token:${newToken}`, playerId);
  res.json({ playerId, nickname:player.nickname, deviceToken:newToken, isNew:true });
});

app.get('/api/player/:id', async (req, res) => {
  const p = await getPlayer(req.params.id);
  if (!p) return res.status(404).json({ error:'Не найден' });
  res.json({ id:p.id, nickname:p.nickname, online:getOnlineStatus(p.id), stats:p.stats, friendsCount:(p.friends||[]).length });
});

app.get('/api/friends/:playerId', async (req, res) => {
  const p = await getPlayer(req.params.playerId);
  if (!p) return res.status(404).json({ error:'Не найден' });
  const friends = await Promise.all((p.friends||[]).map(async fid => {
    const f = await getPlayer(fid);
    return f ? { id:f.id, nickname:f.nickname, online:getOnlineStatus(fid), stats:f.stats } : null;
  }));
  const incoming = await Promise.all((p.friendRequests||[]).map(async fid => {
    const f = await getPlayer(fid);
    return f ? { id:fid, nickname:f.nickname } : null;
  }));
  res.json({ friends:friends.filter(Boolean), incoming:incoming.filter(Boolean) });
});

app.get('/api/status', (req, res) => {
  res.json({ online:connections.size, rooms:gameRooms.size, uptime:Math.floor(process.uptime()) });
});

app.get('*', (req, res) => {
  const p1 = path.join(__dirname,'public','index.html');
  const p2 = path.join(__dirname,'index.html');
  if (fs.existsSync(p1)) res.sendFile(p1);
  else if (fs.existsSync(p2)) res.sendFile(p2);
  else res.status(404).send('Not found');
});

// ============================================================
//  WEBSOCKET
// ============================================================
wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }
    const { type, playerId } = msg;
    const player = playerId ? await getPlayer(playerId) : null;

    switch(type) {

      case 'CONNECT': {
        if (!player) return send(ws,{type:'ERROR',text:'Игрок не найден. Перезагрузи страницу.'});
        const old = connections.get(playerId);
        if (old && old!==ws) old.close();
        connections.set(playerId, ws);
        wsToPlayer.set(ws, playerId);
        send(ws,{type:'CONNECTED',playerId,nickname:player.nickname});
        // Уведомить друзей
        for (const fid of (player.friends||[])) {
          const fw = connections.get(fid);
          if (fw) send(fw,{type:'FRIEND_ONLINE',friendId:playerId,nickname:player.nickname});
        }
        // Входящие заявки
        if ((player.friendRequests||[]).length > 0) {
          const reqs = await Promise.all(player.friendRequests.map(async fid => {
            const f = await getPlayer(fid);
            return f ? {id:fid,nickname:f.nickname} : null;
          }));
          const valid = reqs.filter(Boolean);
          if (valid.length) send(ws,{type:'FRIEND_REQUESTS',requests:valid});
        }
        // Лобби
        const lobbyId = playerLobbies.get(playerId);
        if (lobbyId) {
          const lobby = await getLobby(lobbyId);
          if (lobby) send(ws,{type:'LOBBY_DATA',lobby:await buildLobbyData(lobby)});
          else { send(ws,{type:'LOBBY_DATA',lobby:null}); playerLobbies.delete(playerId); }
        } else {
          send(ws,{type:'LOBBY_DATA',lobby:null});
        }
        break;
      }

      case 'FRIEND_REQUEST': {
        if (!player) return;
        const { targetId } = msg;
        const target = await getPlayer(targetId);
        if (!target) return send(ws,{type:'ERROR',text:'Игрок с таким ID не найден'});
        if (targetId===playerId) return send(ws,{type:'ERROR',text:'Нельзя добавить себя'});
        if ((player.friends||[]).includes(targetId)) return send(ws,{type:'ERROR',text:'Уже в друзьях'});
        if ((player.sentRequests||[]).includes(targetId)) return send(ws,{type:'ERROR',text:'Заявка уже отправлена'});
        if (!player.sentRequests) player.sentRequests=[];
        if (!target.friendRequests) target.friendRequests=[];
        player.sentRequests.push(targetId);
        target.friendRequests.push(playerId);
        await savePlayer(player);
        await savePlayer(target);
        send(ws,{type:'FRIEND_REQUEST_SENT',targetId,targetNick:target.nickname});
        const tw = connections.get(targetId);
        if (tw) send(tw,{type:'FRIEND_REQUEST_IN',fromId:playerId,fromNick:player.nickname});
        break;
      }

      case 'FRIEND_ACCEPT': {
        if (!player) return;
        const { fromId } = msg;
        const from = await getPlayer(fromId);
        if (!from) return;
        player.friendRequests=(player.friendRequests||[]).filter(id=>id!==fromId);
        from.sentRequests=(from.sentRequests||[]).filter(id=>id!==playerId);
        if (!player.friends) player.friends=[];
        if (!from.friends) from.friends=[];
        if (!player.friends.includes(fromId)) player.friends.push(fromId);
        if (!from.friends.includes(playerId)) from.friends.push(playerId);
        await savePlayer(player);
        await savePlayer(from);
        send(ws,{type:'FRIEND_ADDED',friend:{id:fromId,nickname:from.nickname,online:getOnlineStatus(fromId)}});
        const fw=connections.get(fromId);
        if(fw) send(fw,{type:'FRIEND_ADDED',friend:{id:playerId,nickname:player.nickname,online:true}});
        break;
      }

      case 'FRIEND_DECLINE': {
        if (!player) return;
        const { fromId } = msg;
        const from = await getPlayer(fromId);
        player.friendRequests=(player.friendRequests||[]).filter(id=>id!==fromId);
        if(from){ from.sentRequests=(from.sentRequests||[]).filter(id=>id!==playerId); await savePlayer(from); }
        await savePlayer(player);
        send(ws,{type:'FRIEND_DECLINED',fromId});
        break;
      }

      case 'LOBBY_CREATE': {
        if (!player) return;
        const oldLobbyId = playerLobbies.get(playerId);
        if (oldLobbyId) {
          const oldLobby = await getLobby(oldLobbyId);
          if (oldLobby) {
            oldLobby.players=oldLobby.players.filter(id=>id!==playerId);
            if (!oldLobby.players.length) await delLobby(oldLobbyId);
            else await saveLobby(oldLobby);
          }
          playerLobbies.delete(playerId);
        }
        const lid = uuidv4().slice(0,8).toUpperCase();
        const lobby = { id:lid, host:playerId, players:[playerId], maxPlayers:4, status:'waiting', createdAt:Date.now() };
        await saveLobby(lobby);
        playerLobbies.set(playerId, lid);
        send(ws,{type:'LOBBY_CREATED',lobbyId:lid,lobby:await buildLobbyData(lobby)});
        break;
      }

      case 'LOBBY_INVITE': {
        if (!player) return;
        const { friendId } = msg;
        const lobbyId = playerLobbies.get(playerId);
        if (!lobbyId) return send(ws,{type:'ERROR',text:'Сначала создай лобби'});
        const lobby = await getLobby(lobbyId);
        if (!lobby) return send(ws,{type:'ERROR',text:'Лобби не найдено'});
        if (lobby.players.length>=lobby.maxPlayers) return send(ws,{type:'ERROR',text:'Лобби заполнено (макс. 4)'});
        if (!(player.friends||[]).includes(friendId)) return send(ws,{type:'ERROR',text:'Не в друзьях'});
        const fw=connections.get(friendId);
        const fr=await getPlayer(friendId);
        if(!fw||!fr) return send(ws,{type:'ERROR',text:'Друг не в сети'});
        send(fw,{type:'LOBBY_INVITE_IN',lobbyId:lobby.id,hostId:playerId,hostNick:player.nickname});
        send(ws,{type:'LOBBY_INVITE_SENT',friendId,friendNick:fr.nickname});
        break;
      }

      case 'LOBBY_JOIN': {
        if (!player) return;
        const { lobbyId } = msg;
        const lobby = await getLobby(lobbyId);
        if (!lobby) return send(ws,{type:'ERROR',text:'Лобби не найдено'});
        if (lobby.players.length>=lobby.maxPlayers) return send(ws,{type:'ERROR',text:'Лобби заполнено'});
        if (lobby.status!=='waiting') return send(ws,{type:'ERROR',text:'Игра уже началась'});
        // Покинуть старое лобби
        const oldId=playerLobbies.get(playerId);
        if (oldId&&oldId!==lobbyId) {
          const old=await getLobby(oldId);
          if(old){ old.players=old.players.filter(id=>id!==playerId); if(!old.players.length) await delLobby(oldId); else await saveLobby(old); broadcast(old.players,{type:'LOBBY_UPDATED',lobby:old}); }
          playerLobbies.delete(playerId);
        }
        if (!lobby.players.includes(playerId)) lobby.players.push(playerId);
        await saveLobby(lobby);
        playerLobbies.set(playerId, lobbyId);
        broadcast(lobby.players,{type:'LOBBY_UPDATED',lobby:await buildLobbyData(lobby)});
        break;
      }

      case 'LOBBY_DECLINE': {
        const { lobbyId } = msg;
        const lobby=await getLobby(lobbyId);
        if(lobby){ const hw=connections.get(lobby.host); if(hw) send(hw,{type:'LOBBY_INVITE_DECLINED',byId:playerId,byNick:player?.nickname}); }
        break;
      }

      case 'LOBBY_LEAVE': {
        if (!player) return;
        const lobbyId=playerLobbies.get(playerId);
        if (!lobbyId) return;
        const lobby=await getLobby(lobbyId);
        if (!lobby) { playerLobbies.delete(playerId); return; }
        lobby.players=lobby.players.filter(id=>id!==playerId);
        playerLobbies.delete(playerId);
        if (!lobby.players.length) { await delLobby(lobbyId); }
        else { if(lobby.host===playerId) lobby.host=lobby.players[0]; await saveLobby(lobby); broadcast(lobby.players,{type:'LOBBY_UPDATED',lobby:await buildLobbyData(lobby)}); }
        send(ws,{type:'LOBBY_LEFT'});
        break;
      }

      case 'LOBBY_GET': {
        const lobbyId=playerLobbies.get(playerId);
        if (lobbyId) {
          const lobby=await getLobby(lobbyId);
          send(ws,{type:'LOBBY_DATA',lobby:lobby?await buildLobbyData(lobby):null});
        } else {
          send(ws,{type:'LOBBY_DATA',lobby:null});
        }
        break;
      }

      case 'LOBBY_START_KB': {
        if (!player) return;
        const lobbyId=playerLobbies.get(playerId);
        if (!lobbyId) return send(ws,{type:'ERROR',text:'Нет лобби'});
        const lobby=await getLobby(lobbyId);
        if (!lobby) return send(ws,{type:'ERROR',text:'Лобби не найдено'});
        if (lobby.host!==playerId) return send(ws,{type:'ERROR',text:'Только хост может начать'});
        lobby.status='kb';
        await saveLobby(lobby);
        const teams={};
        lobby.players.forEach((pid,i)=>{ teams[pid]=i%2===0?'A':'B'; });
        const playersInfo = await Promise.all(lobby.players.map(async pid => ({
          id: pid,
          nickname: (await getPlayer(pid))?.nickname||'???',
          team: teams[pid],
          charIcon: msg.playerIcons?.[pid]||'🍎'
        })));
        const room = new GameRoom(lobby.id, playersInfo);
        gameRooms.set(lobby.id, room);
        broadcast(lobby.players,{type:'LOBBY_KB_START',lobbyId:lobby.id,roomId:lobby.id,teams,players:playersInfo});
        break;
      }

      case 'GAME_STATE': {
        const room=findRoomByPlayer(playerId);
        if(room) room.updateState(playerId,{x:msg.x,y:msg.y,hp:msg.hp,maxHp:msg.maxHp,alive:msg.alive,charIcon:msg.charIcon,nick:player?.nickname,superCharge:msg.superCharge,emojiId:msg.emojiId});
        break;
      }

      case 'GAME_PROJECTILE': {
        const room=findRoomByPlayer(playerId);
        if(room) room.addProjectile({...msg.proj,ownerId:playerId,ownerNick:player?.nickname});
        break;
      }

      case 'GAME_HIT': {
        const room=findRoomByPlayer(playerId);
        if(room) room.applyHit(playerId,msg.targetId,msg.damage);
        break;
      }

      case 'KB_RESULT': {
        if (!player) return;
        player.stats=player.stats||{wins:0,games:0};
        player.stats.games++;
        if(msg.won) player.stats.wins++;
        await savePlayer(player);
        const lobbyId=playerLobbies.get(playerId);
        if(lobbyId){ const lobby=await getLobby(lobbyId); if(lobby){ lobby.status='waiting'; await saveLobby(lobby); broadcast(lobby.players,{type:'LOBBY_UPDATED',lobby:await buildLobbyData(lobby)}); } }
        break;
      }

      case 'LOBBY_CHAT': {
        if (!player) return;
        const lobbyId=playerLobbies.get(playerId);
        if (!lobbyId) return;
        const lobby=await getLobby(lobbyId);
        if (!lobby) return;
        const text=(msg.text||'').trim().slice(0,100);
        if(!text) return;
        broadcast(lobby.players,{type:'LOBBY_CHAT_MSG',fromId:playerId,fromNick:player.nickname,text});
        break;
      }

      case 'SEND_GIFT': {
        if (!player) return;
        const tw=connections.get(msg.targetId);
        const target=await getPlayer(msg.targetId);
        if(!tw||!target) return send(ws,{type:'ERROR',text:'Игрок не в сети'});
        const desc=msg.giftType==='money'?`${msg.amount} F-Bucks`:`${msg.amount} кристаллов`;
        send(tw,{type:'GIFT_RECEIVED',fromId:playerId,fromNick:player.nickname,giftType:msg.giftType,amount:msg.amount,[msg.giftType]:msg.amount,desc});
        break;
      }

      case 'TRADE_OFFER': {
        if (!player) return;
        const tw=connections.get(msg.targetId);
        if(!tw) return send(ws,{type:'ERROR',text:'Игрок не в сети'});
        send(tw,{type:'TRADE_REQUEST',fromId:playerId,fromNick:player.nickname,offer:msg.offer});
        break;
      }

      case 'TRADE_ACCEPT': {
        if (!player) return;
        const fw=connections.get(msg.fromId);
        if(fw) send(fw,{type:'TRADE_ACCEPTED',byId:playerId,byNick:player.nickname});
        break;
      }

      case 'TRADE_DECLINE': {
        if (!player) return;
        const fw=connections.get(msg.fromId);
        if(fw) send(fw,{type:'TRADE_DECLINED',byId:playerId,byNick:player.nickname});
        break;
      }

      case 'CLICKBATTLE_CHALLENGE': {
        if (!player) return;
        const tw=connections.get(msg.targetId);
        if(!tw) return send(ws,{type:'ERROR',text:'Друг не в сети'});
        send(tw,{type:'CLICKBATTLE_INVITE',fromId:playerId,fromNick:player.nickname});
        break;
      }

      case 'CLICKBATTLE_ACCEPT': {
        if (!player) return;
        const fw=connections.get(msg.targetId);
        if(!fw) return;
        ws._cbOpponent=msg.targetId;
        fw._cbOpponent=playerId;
        send(ws,{type:'CLICKBATTLE_START',oppNick:(await getPlayer(msg.targetId))?.nickname||'?',oppId:msg.targetId});
        send(fw,{type:'CLICKBATTLE_START',oppNick:player.nickname,oppId:playerId});
        break;
      }

      case 'CLICKBATTLE_CLICK': {
        if (!player) return;
        const tid=ws._cbOpponent;
        if(tid){ const tw=connections.get(tid); if(tw) send(tw,{type:'CLICKBATTLE_UPDATE',oppScore:msg.score}); }
        ws._cbScore=msg.score;
        break;
      }

      case 'CLICKBATTLE_DONE': {
        if (!player) return;
        const tid=ws._cbOpponent;
        if(tid){
          const tw=connections.get(tid);
          const myScore=msg.score;
          const oppScore = tw ? (tw._cbScore || 0) : 0;
          const winnerId=myScore>=oppScore?playerId:tid;
          send(ws,{type:'CLICKBATTLE_END',winnerId,myScore,oppScore});
          if(tw) send(tw,{type:'CLICKBATTLE_END',winnerId,myScore:oppScore,oppScore:myScore});
        }
        break;
      }
    }
  });

  ws.on('close', async () => {
    const playerId=wsToPlayer.get(ws);
    if(!playerId) return;
    connections.delete(playerId);
    wsToPlayer.delete(ws);
    const player=await getPlayer(playerId);
    if(player) for(const fid of (player.friends||[])){ const fw=connections.get(fid); if(fw) send(fw,{type:'FRIEND_OFFLINE',friendId:playerId}); }
    const lobbyId=playerLobbies.get(playerId);
    if(lobbyId){
      const lobby=await getLobby(lobbyId);
      if(lobby){
        lobby.players=lobby.players.filter(id=>id!==playerId);
        playerLobbies.delete(playerId);
        if(!lobby.players.length){ await delLobby(lobbyId); }
        else { if(lobby.host===playerId) lobby.host=lobby.players[0]; await saveLobby(lobby); broadcast(lobby.players,{type:'LOBBY_UPDATED',lobby:await buildLobbyData(lobby)}); }
      }
    }
    const room=findRoomByPlayer(playerId);
    if(room){ const state=room.states[playerId]; if(state){ state.alive=false; room.broadcastAll({type:'REMOTE_PLAYER_DIED',playerId,nick:player?.nickname,killerNick:'disconnect'}); } }
  });
});

async function buildLobbyData(lobby) {
  const names = {};
  for (const pid of lobby.players) {
    const p = await getPlayer(pid);
    names[pid] = p?.nickname || '???';
  }
  return { ...lobby, playerNames: names };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Apple Journey Server запущен на порту ${PORT}`);
});
