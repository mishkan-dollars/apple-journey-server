// ================================================================
//  APPLE JOURNEY MULTIPLAYER v3
//  Подключить в игру: <script src="/multiplayer.js"></script>
// ================================================================

const SERVER_HTTP = 'https://apple-journey-server.onrender.com';
const SERVER_WS   = 'wss://apple-journey-server.onrender.com';

// ================================================================
//  CORE — подключение и авторизация
// ================================================================
const MP = {
  ws: null,
  playerId: null,
  nickname: null,
  deviceToken: null,
  friends: [],
  friendRequests: [],
  currentLobby: null,
  connected: false,
  _retryTimer: null,

  // Получить ник из игры
  getNick() {
    try {
      const s = localStorage.getItem('appleRebirthGame');
      if (s) {
        const d = JSON.parse(s);
        if (d.username && d.username.length >= 2) return d.username;
      }
    } catch(e) {}
    if (window.gameData && window.gameData.username && window.gameData.username.length >= 2) {
      return window.gameData.username;
    }
    return null;
  },

  // Авторизация
  async auth(nick) {
    const token = localStorage.getItem('mp_token') || null;
    const res = await fetch(SERVER_HTTP + '/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: nick, deviceToken: token })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    this.playerId  = data.playerId;
    this.nickname  = data.nickname;
    this.deviceToken = data.deviceToken;
    localStorage.setItem('mp_token', data.deviceToken);
    localStorage.setItem('mp_id', data.playerId);
    localStorage.setItem('mp_nick', data.nickname);
    return data;
  },

  // WebSocket подключение
  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (!this.playerId) return;
    clearTimeout(this._retryTimer);

    this.ws = new WebSocket(SERVER_WS);

    this.ws.onopen = () => {
      this.connected = true;
      this.ws.send(JSON.stringify({ type: 'CONNECT', playerId: this.playerId }));
    };

    this.ws.onmessage = (e) => {
      try { this._handle(JSON.parse(e.data)); } catch(err) {}
    };

    this.ws.onclose = () => {
      this.connected = false;
      this._retryTimer = setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = () => { this.ws.close(); };
  },

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ ...msg, playerId: this.playerId }));
    }
  },

  // ---- Обработка входящих сообщений ----
  _handle(msg) {
    switch (msg.type) {

      case 'CONNECTED':
        this.loadFriends();
        this.send({ type: 'LOBBY_GET' });
        break;

      case 'ERROR':
        _notify('❌ ' + msg.text, '', 'trophies');
        break;

      // ---- MATCHMAKING ----
      case 'MM_UPDATE':
        MM.onUpdate(msg);
        break;

      case 'MM_LAUNCH':
        MM.onLaunch(msg);
        break;

      case 'MM_LEFT':
        MM.onLeft();
        break;

      // ---- FRIENDS ----
      case 'FRIEND_ONLINE':
        this._setFriendOnline(msg.friendId, true);
        _notify('🟢 ' + msg.nickname, 'вошёл в игру', 'unlock');
        UI.renderFriends();
        break;

      case 'FRIEND_OFFLINE':
        this._setFriendOnline(msg.friendId, false);
        UI.renderFriends();
        break;

      case 'FRIEND_REQUEST_IN':
        if (!this.friendRequests.find(r => r.id === msg.fromId)) {
          this.friendRequests.push({ id: msg.fromId, nickname: msg.fromNick });
        }
        _notify('👥 Заявка', msg.fromNick + ' хочет добавить вас', 'unlock');
        UI.renderFriends();
        break;

      case 'FRIEND_REQUESTS':
        this.friendRequests = msg.requests || [];
        UI.renderFriends();
        break;

      case 'FRIEND_REQUEST_SENT':
        _notify('✅ Заявка отправлена', msg.targetNick, 'unlock');
        break;

      case 'FRIEND_ADDED':
        this.loadFriends();
        _notify('🎉 Новый друг!', (msg.friend && msg.friend.nickname) || '???', 'unlock');
        break;

      case 'FRIEND_DECLINED':
        this.friendRequests = this.friendRequests.filter(r => r.id !== msg.fromId);
        UI.renderFriends();
        break;

      // ---- LOBBY ----
      case 'LOBBY_CREATED':
      case 'LOBBY_UPDATED':
      case 'LOBBY_DATA':
        this.currentLobby = msg.lobby;
        UI.renderLobby();
        break;

      case 'LOBBY_LEFT':
        this.currentLobby = null;
        UI.renderLobby();
        break;

      case 'LOBBY_INVITE_IN':
        UI.showLobbyInvite(msg);
        break;

      case 'LOBBY_INVITE_SENT':
        _notify('📨 Отправлено', msg.friendNick, 'unlock');
        break;

      case 'LOBBY_INVITE_DECLINED':
        _notify('❌ Отклонено', (msg.byNick||'???') + ' отклонил', 'trophies');
        break;

      case 'LOBBY_KB_START':
        UI.startKB(msg);
        break;

      case 'LOBBY_CHAT_MSG':
        UI.addChat(msg);
        break;

      // ---- GIFTS ----
      case 'GIFT_RECEIVED':
        _notify('🎁 Подарок от ' + msg.fromNick, msg.desc, 'unlock');
        if (msg.money && window.gameData) {
          window.gameData.balance = (window.gameData.balance||0) + msg.money;
          if (typeof saveGameData === 'function') saveGameData();
          if (typeof updateUI === 'function') updateUI();
        }
        if (msg.crystals && window.gameData) {
          window.gameData.crystals = (window.gameData.crystals||0) + msg.crystals;
          if (typeof saveGameData === 'function') saveGameData();
          if (typeof updateUI === 'function') updateUI();
        }
        break;

      // ---- CLICK BATTLE ----
      case 'CB_INVITE':
        CB.showInvite(msg);
        break;
      case 'CB_START':
        CB.start(msg);
        break;
      case 'CB_UPDATE':
        CB.update(msg);
        break;
      case 'CB_END':
        CB.end(msg);
        break;
    }
  },

  _setFriendOnline(fid, online) {
    const f = this.friends.find(x => x.id === fid);
    if (f) f.online = online;
  },

  async loadFriends() {
    if (!this.playerId) return;
    try {
      const res = await fetch(SERVER_HTTP + '/api/friends/' + this.playerId);
      const data = await res.json();
      this.friends = (data.friends || []).map(f => ({
        id: f.id,
        nickname: f.nickname || '???',
        online: f.online || false,
        stats: f.stats || { wins: 0, games: 0 }
      }));
      this.friendRequests = (data.incoming || []).map(r => ({
        id: r.id,
        nickname: r.nickname || '???'
      }));
      UI.renderFriends();
    } catch(e) {}
  },

  // Методы
  addFriend(id)         { this.send({ type: 'FRIEND_REQUEST', targetId: id }); },
  acceptFriend(fromId)  { this.send({ type: 'FRIEND_ACCEPT', fromId }); },
  declineFriend(fromId) { this.send({ type: 'FRIEND_DECLINE', fromId }); },
  createLobby()         { this.send({ type: 'LOBBY_CREATE' }); },
  joinLobby(id)         { this.send({ type: 'LOBBY_JOIN', lobbyId: id }); },
  leaveLobby()          { this.send({ type: 'LOBBY_LEAVE' }); this.currentLobby = null; UI.renderLobby(); },
  inviteToLobby(fid)    { this.send({ type: 'LOBBY_INVITE', friendId: fid }); },
  startKB()             { this.send({ type: 'LOBBY_START_KB' }); },
  sendChat(text)        { this.send({ type: 'LOBBY_CHAT', text }); },

  sendGift(targetId, type, amount) {
    if (type === 'money') {
      if (!window.gameData || window.gameData.balance < amount) return _notify('❌ Недостаточно', '', 'trophies');
      window.gameData.balance -= amount;
    }
    if (type === 'crystals') {
      if (!window.gameData || window.gameData.crystals < amount) return _notify('❌ Недостаточно', '', 'trophies');
      window.gameData.crystals -= amount;
    }
    if (typeof saveGameData === 'function') saveGameData();
    if (typeof updateUI === 'function') updateUI();
    this.send({ type: 'SEND_GIFT', targetId, giftType: type, amount });
    _notify('🎁 Подарок отправлен!', '', 'unlock');
  },

  challengeCB(targetId) { this.send({ type: 'CB_CHALLENGE', targetId }); }
};

// ================================================================
//  MATCHMAKING
// ================================================================
const MM = {
  active: false,
  timer: null,

  join() {
    if (this.active) return;
    if (!MP.playerId) return _notify('❌ Нет подключения', 'Введи ник в игре', 'trophies');
    this.active = true;

    let charIcon = '🍎';
    try {
      const cid = window.gameData && window.gameData.selectedCharacterId;
      if (cid) {
        const ch = window.gameData.characters.find(c => c.id === cid);
        if (ch && ch.icon && !ch.icon.startsWith('<') && !ch.icon.startsWith('http')) charIcon = ch.icon;
      }
    } catch(e) {}

    MP.send({ type: 'MM_JOIN', charIcon });

    // Показать UI поиска
    const lobby = document.getElementById('br-lobby');
    if (lobby) lobby.style.display = 'none';
    this.showSearchUI();
  },

  cancel() {
    this.active = false;
    clearInterval(this.timer);
    MP.send({ type: 'MM_LEAVE' });
    this.hideSearchUI();
    const lobby = document.getElementById('br-lobby');
    if (lobby) lobby.style.display = 'flex';
  },

  onUpdate(msg) {
    if (!this.active) return;
    const countEl = document.getElementById('mm-count');
    const timeEl  = document.getElementById('mm-time');
    const barEl   = document.getElementById('mm-bar');
    const listEl  = document.getElementById('mm-players');
    if (countEl) countEl.textContent = msg.found + ' / ' + msg.total;
    if (timeEl)  timeEl.textContent  = msg.timeLeft + ' сек';
    if (barEl)   barEl.style.width   = Math.min(100, (msg.found / msg.total) * 100) + '%';
    if (listEl && msg.players) {
      listEl.innerHTML = msg.players.map(p =>
        '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;">' +
        '<span style="font-size:16px">' + (p.charIcon || '🍎') + '</span>' +
        '<span style="color:var(--matrix-green);font-size:12px">' + (p.nick || '???') + '</span>' +
        '</div>'
      ).join('');
    }
  },

  onLeft() {
    this.active = false;
    this.hideSearchUI();
    const lobby = document.getElementById('br-lobby');
    if (lobby) lobby.style.display = 'flex';
  },

  onLaunch(msg) {
    this.active = false;
    clearInterval(this.timer);
    this.hideSearchUI();

    const myTeam = msg.teams && msg.teams[MP.playerId];
    const banner = document.createElement('div');
    banner.id = 'mm-launch-banner';
    banner.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
      'background:rgba(0,0,0,0.97);border:3px solid ' + (myTeam === 'A' ? '#00ff41' : '#ff4444') + ';' +
      'border-radius:18px;padding:28px 40px;z-index:99999;text-align:center;' +
      'font-family:Share Tech Mono,monospace;min-width:280px;';
    banner.innerHTML =
      '<div style="font-size:14px;color:#888;margin-bottom:8px;">МАТЧ НАЙДЕН!</div>' +
      '<div style="font-size:30px;color:' + (myTeam === 'A' ? '#00ff41' : '#ff4444') + ';letter-spacing:4px;margin-bottom:10px;">КОМАНДА ' + (myTeam || '?') + '</div>' +
      '<div style="font-size:12px;color:#888;margin-bottom:6px;">Игроков: ' + msg.realPlayers + ' | Остальные — боты</div>' +
      '<div id="mm-launch-count" style="font-size:52px;color:#FFD700;margin-top:8px;">3</div>';
    document.body.appendChild(banner);

    let n = 3;
    const tick = setInterval(function() {
      n--;
      const el = document.getElementById('mm-launch-count');
      if (el) el.textContent = n > 0 ? n : '⚔️';
      if (n <= 0) {
        clearInterval(tick);
        setTimeout(function() {
          const b = document.getElementById('mm-launch-banner');
          if (b) b.remove();
          // Запуск КБ
          const lobbyEl = document.getElementById('br-lobby');
          if (lobbyEl) lobbyEl.style.display = 'none';
          if (typeof startBattleRoyale === 'function') startBattleRoyale();
        }, 500);
      }
    }, 1000);
  },

  showSearchUI() {
    let el = document.getElementById('mm-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mm-overlay';
      el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:5000;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:Share Tech Mono,monospace;';
      el.innerHTML =
        '<div style="font-size:20px;color:var(--matrix-green);letter-spacing:3px;margin-bottom:20px;">ПОИСК МАТЧА</div>' +
        '<div style="font-size:36px;color:#FFD700;margin-bottom:8px;" id="mm-count">0 / 10</div>' +
        '<div style="width:280px;height:6px;background:rgba(255,255,255,0.1);border-radius:3px;margin-bottom:12px;overflow:hidden;">' +
        '<div id="mm-bar" style="height:100%;background:linear-gradient(90deg,#00ff41,#FFD700);border-radius:3px;width:0%;transition:width 0.5s;"></div></div>' +
        '<div style="font-size:13px;color:#44bb44;margin-bottom:16px;">Запуск через: <span id="mm-time">10</span></div>' +
        '<div id="mm-players" style="min-height:60px;margin-bottom:20px;text-align:left;"></div>' +
        '<button onclick="MM.cancel()" style="background:rgba(40,0,0,0.8);border:1px solid rgba(255,60,60,0.5);color:#ff6666;border-radius:8px;padding:10px 24px;cursor:pointer;font-family:Share Tech Mono,monospace;font-size:13px;">❌ ОТМЕНА</button>';
      document.body.appendChild(el);
    }
    el.style.display = 'flex';
  },

  hideSearchUI() {
    const el = document.getElementById('mm-overlay');
    if (el) el.style.display = 'none';
  }
};

// ================================================================
//  CLICK BATTLE
// ================================================================
const CB = {
  oppId: null,

  showInvite(msg) {
    const old = document.getElementById('cb-invite');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'cb-invite';
    el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,15,0,0.97);border:2px solid #FFD700;border-radius:14px;padding:16px 20px;z-index:9999;min-width:260px;font-family:Share Tech Mono,monospace;';
    el.innerHTML =
      '<div style="color:#FFD700;font-size:14px;margin-bottom:6px;">⚡ КЛИК-БАТЛ!</div>' +
      '<div style="color:#44bb44;font-size:12px;margin-bottom:12px;">' + msg.fromNick + ' вызывает тебя</div>' +
      '<div style="display:flex;gap:8px;">' +
      '<button onclick="MP.send({type:\'CB_ACCEPT\',targetId:\'' + msg.fromId + '\'});CB.oppId=\'' + msg.fromId + '\';document.getElementById(\'cb-invite\').remove();" style="flex:1;background:linear-gradient(45deg,#001a00,#FFD700);border:1px solid #FFD700;color:#000;border-radius:8px;padding:8px;cursor:pointer;font-family:Share Tech Mono,monospace;font-weight:bold;">⚡ ПРИНЯТЬ</button>' +
      '<button onclick="document.getElementById(\'cb-invite\').remove();" style="flex:1;background:rgba(40,0,0,0.7);border:1px solid rgba(255,60,60,0.4);color:#ff6666;border-radius:8px;padding:8px;cursor:pointer;font-family:Share Tech Mono,monospace;">✖</button>' +
      '</div>';
    document.body.appendChild(el);
    setTimeout(() => { if (document.getElementById('cb-invite')) document.getElementById('cb-invite').remove(); }, 20000);
  },

  start(msg) {
    this.oppId = msg.oppId;
    this.myScore = 0;
    this.oppScore = 0;
    this.timeLeft = 30;

    const el = document.createElement('div');
    el.id = 'cb-game';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.96);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:Share Tech Mono,monospace;';
    el.innerHTML =
      '<div style="font-size:18px;color:#FFD700;letter-spacing:3px;margin-bottom:16px;">⚡ КЛИК-БАТЛ</div>' +
      '<div style="display:flex;gap:50px;margin-bottom:20px;">' +
      '<div style="text-align:center;"><div style="font-size:12px;color:var(--matrix-green);">ТЫ</div><div id="cb-my" style="font-size:52px;color:var(--matrix-green);">0</div></div>' +
      '<div style="text-align:center;"><div style="font-size:12px;color:#ff4444;">' + msg.oppNick + '</div><div id="cb-opp" style="font-size:52px;color:#ff4444;">0</div></div>' +
      '</div>' +
      '<div id="cb-timer" style="font-size:24px;color:#FFD700;margin-bottom:20px;">30</div>' +
      '<button id="cb-btn" style="width:160px;height:160px;border-radius:50%;background:linear-gradient(45deg,#001a00,#00ff41);border:4px solid var(--matrix-green);color:#000;font-size:48px;cursor:pointer;box-shadow:0 0 40px rgba(0,255,65,0.5);">🍎</button>' +
      '<div style="font-size:11px;color:#44bb44;margin-top:12px;">ЖМИ БЫСТРЕЕ!</div>';
    document.body.appendChild(el);

    const btn = document.getElementById('cb-btn');
    const click = () => {
      this.myScore++;
      document.getElementById('cb-my').textContent = this.myScore;
      btn.style.transform = 'scale(0.92)';
      setTimeout(() => { btn.style.transform = ''; }, 60);
      MP.send({ type: 'CB_CLICK', score: this.myScore });
    };
    btn.addEventListener('click', click);
    btn.addEventListener('touchstart', e => { e.preventDefault(); click(); }, { passive: false });

    const interval = setInterval(() => {
      this.timeLeft--;
      const t = document.getElementById('cb-timer');
      if (t) t.textContent = this.timeLeft;
      if (this.timeLeft <= 0) {
        clearInterval(interval);
        MP.send({ type: 'CB_DONE', score: this.myScore });
      }
    }, 1000);
  },

  update(msg) {
    this.oppScore = msg.oppScore;
    const el = document.getElementById('cb-opp');
    if (el) el.textContent = msg.oppScore;
  },

  end(msg) {
    const el = document.getElementById('cb-game');
    if (!el) return;
    const won = msg.winnerId === MP.playerId;
    const reward = won ? 500 : 100;
    el.innerHTML =
      '<div style="text-align:center;">' +
      '<div style="font-size:48px;margin-bottom:12px;">' + (won ? '🏆' : '😔') + '</div>' +
      '<div style="font-size:24px;color:' + (won ? '#FFD700' : '#ff4444') + ';letter-spacing:3px;margin-bottom:10px;">' + (won ? 'ПОБЕДА!' : 'ПОРАЖЕНИЕ') + '</div>' +
      '<div style="color:var(--matrix-green);margin-bottom:4px;">Ты: ' + msg.myScore + '</div>' +
      '<div style="color:#ff4444;margin-bottom:12px;">Соперник: ' + msg.oppScore + '</div>' +
      '<div style="color:#FFD700;margin-bottom:20px;">+' + reward + ' F-Bucks</div>' +
      '<button onclick="document.getElementById(\'cb-game\').remove()" style="background:rgba(0,30,0,0.8);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:8px;padding:10px 24px;cursor:pointer;font-family:Share Tech Mono,monospace;">ЗАКРЫТЬ</button>' +
      '</div>';
    if (won && window.gameData) {
      window.gameData.balance = (window.gameData.balance||0) + reward;
      if (typeof saveGameData === 'function') saveGameData();
      if (typeof updateUI === 'function') updateUI();
    }
  }
};

// ================================================================
//  UI — вкладка Друзья и Лобби
// ================================================================
const UI = {
  tab: 'friends',
  chatMsgs: [],

  renderFriends() {
    const el = document.getElementById('mp-friends-content');
    if (!el || this.tab !== 'friends') return;
    const f = MP.friends;
    const r = MP.friendRequests;

    el.innerHTML =
      // Мой ID
      '<div style="background:rgba(0,30,0,0.7);border:1px solid var(--matrix-green);border-radius:10px;padding:12px;margin-bottom:12px;">' +
      '<div style="font-size:10px;color:#44bb44;margin-bottom:4px;">МОЙ ID</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
      '<span id="mp-my-id" style="font-size:15px;color:var(--matrix-green);letter-spacing:2px;font-weight:bold;">' + (MP.playerId || '—') + '</span>' +
      '<button onclick="UI.copyId()" style="background:rgba(0,50,0,0.8);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:5px;padding:3px 10px;font-size:11px;cursor:pointer;font-family:Share Tech Mono,monospace;">📋 КОПИРОВАТЬ</button>' +
      '</div>' +
      '<div style="font-size:10px;color:#44bb44;margin-top:3px;">Ник: <span style="color:var(--matrix-green);">' + (MP.nickname || '—') + '</span></div>' +
      '</div>' +
      // Добавить
      '<div style="background:rgba(0,15,0,0.7);border:1px solid rgba(0,255,65,0.25);border-radius:10px;padding:12px;margin-bottom:12px;">' +
      '<div style="font-size:10px;color:#44bb44;margin-bottom:8px;">ДОБАВИТЬ ПО ID</div>' +
      '<div style="display:flex;gap:8px;">' +
      '<input id="mp-add-input" type="text" placeholder="AJ-XXXX-XXXX" maxlength="12" oninput="this.value=this.value.toUpperCase()" style="flex:1;background:rgba(0,20,0,0.8);border:1px solid var(--matrix-green);border-radius:6px;color:var(--matrix-green);font-family:Share Tech Mono,monospace;font-size:13px;padding:6px 10px;outline:none;"/>' +
      '<button onclick="UI.sendRequest()" style="background:rgba(0,30,0,0.8);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:6px;padding:6px 12px;cursor:pointer;font-family:Share Tech Mono,monospace;">➕</button>' +
      '</div></div>' +
      // Заявки
      (r.length > 0 ?
        '<div style="margin-bottom:12px;">' +
        '<div style="font-size:10px;color:#FFD700;margin-bottom:6px;">ВХОДЯЩИЕ ЗАЯВКИ (' + r.length + ')</div>' +
        r.map(x =>
          '<div style="display:flex;align-items:center;justify-content:space-between;background:rgba(20,15,0,0.8);border:1px solid rgba(255,215,0,0.3);border-radius:8px;padding:8px 12px;margin-bottom:5px;">' +
          '<span style="color:#FFD700;">' + x.nickname + '</span>' +
          '<div style="display:flex;gap:6px;">' +
          '<button onclick="MP.acceptFriend(\'' + x.id + '\')" style="background:rgba(0,50,0,0.8);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:5px;padding:3px 10px;font-size:11px;cursor:pointer;">✔</button>' +
          '<button onclick="MP.declineFriend(\'' + x.id + '\')" style="background:rgba(40,0,0,0.8);border:1px solid rgba(255,60,60,0.5);color:#ff6666;border-radius:5px;padding:3px 10px;font-size:11px;cursor:pointer;">✖</button>' +
          '</div></div>'
        ).join('') + '</div>' : '') +
      // Список друзей
      '<div style="font-size:10px;color:#44bb44;margin-bottom:8px;">ДРУЗЬЯ (' + f.length + ')</div>' +
      (f.length === 0 ? '<div style="text-align:center;color:rgba(0,255,65,0.3);padding:20px;font-size:13px;">Нет друзей. Добавь по ID!</div>' :
        f.map(x =>
          '<div style="background:rgba(0,12,0,0.8);border:1px solid rgba(0,255,65,0.2);border-radius:8px;padding:10px 12px;margin-bottom:6px;">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
          '<span style="width:8px;height:8px;border-radius:50%;background:' + (x.online ? '#00ff41' : '#333') + ';box-shadow:' + (x.online ? '0 0 6px #00ff41' : 'none') + ';flex-shrink:0;"></span>' +
          '<div><div style="color:var(--matrix-green);font-size:13px;">' + x.nickname + '</div>' +
          '<div style="color:#44bb44;font-size:10px;">' + (x.online ? '🟢 В сети' : '⚫ Не в сети') + ' · ' + x.id + '</div></div></div>' +
          (x.online ?
            '<div style="display:flex;gap:5px;flex-wrap:wrap;">' +
            (MP.currentLobby && MP.currentLobby.host === MP.playerId ?
              '<button onclick="MP.inviteToLobby(\'' + x.id + '\')" style="background:rgba(0,30,0,0.8);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:5px;padding:3px 8px;font-size:10px;cursor:pointer;font-family:Share Tech Mono,monospace;">📨 ЛОББИ</button>' : '') +
            '<button onclick="UI.showGift(\'' + x.id + '\',\'' + x.nickname + '\')" style="background:rgba(0,25,0,0.8);border:1px solid rgba(0,255,65,0.4);color:var(--matrix-green);border-radius:5px;padding:3px 8px;font-size:10px;cursor:pointer;font-family:Share Tech Mono,monospace;">🎁 ПОДАРОК</button>' +
            '<button onclick="MP.challengeCB(\'' + x.id + '\')" style="background:rgba(20,15,0,0.8);border:1px solid rgba(255,215,0,0.4);color:#FFD700;border-radius:5px;padding:3px 8px;font-size:10px;cursor:pointer;font-family:Share Tech Mono,monospace;">⚡ БАТЛ</button>' +
            '<button onclick="UI.viewProfile(\'' + x.id + '\')" style="background:rgba(0,15,20,0.8);border:1px solid rgba(0,200,255,0.4);color:#00ccff;border-radius:5px;padding:3px 8px;font-size:10px;cursor:pointer;font-family:Share Tech Mono,monospace;">👤</button>' +
            '</div>' : '') +
          '</div>'
        ).join(''));
  },

  renderLobby() {
    const el = document.getElementById('mp-lobby-content');
    if (!el || this.tab !== 'lobby') return;
    const lobby = MP.currentLobby;

    if (!lobby) {
      el.innerHTML =
        '<div style="text-align:center;padding:20px;">' +
        '<div style="color:rgba(0,255,65,0.4);font-size:13px;margin-bottom:16px;">Вы не в лобби</div>' +
        '<button onclick="MP.createLobby()" style="background:linear-gradient(45deg,#001a00,#00ff41);border:2px solid var(--matrix-green);color:#000;border-radius:10px;padding:12px 28px;font-size:14px;font-weight:bold;cursor:pointer;font-family:Share Tech Mono,monospace;letter-spacing:2px;">➕ СОЗДАТЬ ЛОББИ</button>' +
        '</div>';
      return;
    }

    const isHost = lobby.host === MP.playerId;
    const players = lobby.players || [];
    const names = lobby.playerNames || {};
    const onlineFriends = MP.friends.filter(f => f.online && !players.includes(f.id));

    el.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
      '<div><div style="font-size:10px;color:#44bb44;">ЛОББИ ' + (isHost ? '👑' : '') + '</div>' +
      '<div style="font-size:14px;color:var(--matrix-green);">' + lobby.id + '</div></div>' +
      '<button onclick="MP.leaveLobby()" style="background:rgba(40,0,0,0.7);border:1px solid rgba(255,60,60,0.5);color:#ff6666;border-radius:6px;padding:5px 10px;font-size:11px;cursor:pointer;font-family:Share Tech Mono,monospace;">🚪 ВЫЙТИ</button>' +
      '</div>' +
      // Слоты
      '<div style="margin-bottom:12px;">' +
      '<div style="font-size:10px;color:#44bb44;margin-bottom:5px;">ИГРОКИ (' + players.length + '/4)</div>' +
      [0,1,2,3].map(i => {
        const pid = players[i];
        if (pid) return '<div style="background:rgba(0,20,0,0.8);border:1px solid rgba(0,255,65,0.3);border-radius:7px;padding:8px 12px;margin-bottom:4px;color:var(--matrix-green);font-size:13px;">' +
          (pid === lobby.host ? '👑 ' : '') + (names[pid] || '???') + (pid === MP.playerId ? ' (ты)' : '') + '</div>';
        return '<div style="background:rgba(0,8,0,0.5);border:1px dashed rgba(0,255,65,0.15);border-radius:7px;padding:8px 12px;margin-bottom:4px;color:rgba(0,255,65,0.25);font-size:12px;">— слот свободен</div>';
      }).join('') + '</div>' +
      // Пригласить
      (isHost && onlineFriends.length > 0 ?
        '<div style="margin-bottom:12px;"><div style="font-size:10px;color:#44bb44;margin-bottom:5px;">ПРИГЛАСИТЬ</div>' +
        onlineFriends.map(f =>
          '<button onclick="MP.inviteToLobby(\'' + f.id + '\')" style="width:100%;background:rgba(0,25,0,0.8);border:1px solid rgba(0,255,65,0.4);color:var(--matrix-green);border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:Share Tech Mono,monospace;margin-bottom:4px;text-align:left;">📨 ' + f.nickname + '</button>'
        ).join('') + '</div>' : '') +
      // Кнопка КБ
      (lobby.status === 'waiting' ?
        '<button onclick="' + (isHost ? 'MP.startKB()' : '') + '" style="width:100%;padding:13px;background:' + (isHost ? 'linear-gradient(45deg,#001a00,#00ff41)' : 'rgba(0,15,0,0.5)') + ';border:2px solid ' + (isHost ? 'var(--matrix-green)' : 'rgba(0,255,65,0.2)') + ';color:' + (isHost ? '#000' : 'rgba(0,255,65,0.3)') + ';border-radius:10px;font-family:Share Tech Mono,monospace;font-size:14px;font-weight:bold;cursor:' + (isHost ? 'pointer' : 'not-allowed') + ';margin-bottom:12px;letter-spacing:2px;">⚔️ НАЧАТЬ КБ' + (!isHost ? ' (только хост)' : '') + '</button>' :
        '<div style="text-align:center;color:#FFD700;font-size:12px;padding:8px;border:1px solid rgba(255,215,0,0.3);border-radius:8px;margin-bottom:12px;">⚔️ КБ ИДЁТ...</div>') +
      // Чат
      '<div style="border:1px solid rgba(0,255,65,0.2);border-radius:8px;overflow:hidden;">' +
      '<div id="mp-chat" style="height:75px;overflow-y:auto;padding:6px 10px;font-size:11px;color:#44bb44;">' +
      this.chatMsgs.slice(-15).map(m => '<div><span style="color:var(--matrix-green);">' + m.fromNick + ':</span> ' + m.text + '</div>').join('') +
      '</div>' +
      '<div style="display:flex;border-top:1px solid rgba(0,255,65,0.15);">' +
      '<input id="mp-chat-input" type="text" placeholder="Сообщение..." maxlength="100" style="flex:1;background:rgba(0,8,0,0.8);border:none;color:var(--matrix-green);font-family:Share Tech Mono,monospace;font-size:12px;padding:6px 10px;outline:none;" onkeypress="if(event.key===\'Enter\'){UI.sendChat();}" />' +
      '<button onclick="UI.sendChat()" style="background:rgba(0,30,0,0.8);border:none;color:var(--matrix-green);padding:6px 12px;cursor:pointer;">➤</button>' +
      '</div></div>';

    const chat = document.getElementById('mp-chat');
    if (chat) chat.scrollTop = chat.scrollHeight;
  },

  sendChat() {
    const el = document.getElementById('mp-chat-input');
    if (!el || !el.value.trim()) return;
    MP.sendChat(el.value.trim());
    el.value = '';
  },

  addChat(msg) {
    this.chatMsgs.push(msg);
    if (this.chatMsgs.length > 50) this.chatMsgs.shift();
    if (this.tab === 'lobby') this.renderLobby();
  },

  showLobbyInvite(msg) {
    const old = document.getElementById('mp-lobby-invite');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'mp-lobby-invite';
    el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,15,0,0.97);border:2px solid var(--matrix-green);border-radius:14px;padding:16px 20px;z-index:9999;min-width:270px;font-family:Share Tech Mono,monospace;box-shadow:0 0 30px rgba(0,255,65,0.4);';
    el.innerHTML =
      '<div style="color:var(--matrix-green);font-size:13px;margin-bottom:4px;">📨 ПРИГЛАШЕНИЕ В ЛОББИ</div>' +
      '<div style="color:#44bb44;font-size:12px;margin-bottom:12px;">' + msg.hostNick + ' приглашает тебя</div>' +
      '<div style="display:flex;gap:8px;">' +
      '<button onclick="MP.joinLobby(\'' + msg.lobbyId + '\');document.getElementById(\'mp-lobby-invite\').remove();UI.switchTab(\'lobby\');" style="flex:1;background:linear-gradient(45deg,#001a00,#003300);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:8px;padding:8px;cursor:pointer;font-family:Share Tech Mono,monospace;font-size:12px;">✔ ПРИНЯТЬ</button>' +
      '<button onclick="MP.send({type:\'LOBBY_DECLINE\',lobbyId:\'' + msg.lobbyId + '\'});document.getElementById(\'mp-lobby-invite\').remove();" style="flex:1;background:rgba(40,0,0,0.7);border:1px solid rgba(255,60,60,0.4);color:#ff6666;border-radius:8px;padding:8px;cursor:pointer;font-family:Share Tech Mono,monospace;font-size:12px;">✖ ОТКЛОНИТЬ</button>' +
      '</div>';
    document.body.appendChild(el);
    setTimeout(() => { const e = document.getElementById('mp-lobby-invite'); if (e) e.remove(); }, 30000);
  },

  startKB(msg) {
    const myTeam = msg.teams && msg.teams[MP.playerId];
    const banner = document.createElement('div');
    banner.id = 'kb-banner';
    banner.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.97);border:3px solid ' + (myTeam === 'A' ? '#00ff41' : '#ff4444') + ';border-radius:18px;padding:26px 38px;z-index:99999;text-align:center;font-family:Share Tech Mono,monospace;min-width:260px;';
    const allies = (msg.players||[]).filter(p => msg.teams[p.id] === myTeam && p.id !== MP.playerId).map(p => p.nickname).join(', ') || 'только ты';
    banner.innerHTML =
      '<div style="font-size:12px;color:#888;margin-bottom:6px;">КБ ЗАПУСКАЕТСЯ</div>' +
      '<div style="font-size:30px;color:' + (myTeam === 'A' ? '#00ff41' : '#ff4444') + ';letter-spacing:4px;margin-bottom:8px;">КОМАНДА ' + (myTeam || '?') + '</div>' +
      '<div style="font-size:11px;color:#888;margin-bottom:4px;">Союзники: ' + allies + '</div>' +
      '<div id="kb-count" style="font-size:50px;color:#FFD700;margin-top:10px;">3</div>';
    document.body.appendChild(banner);

    let n = 3;
    const tick = setInterval(function() {
      n--;
      const el = document.getElementById('kb-count');
      if (el) el.textContent = n > 0 ? n : '⚔️';
      if (n <= 0) {
        clearInterval(tick);
        setTimeout(function() {
          const b = document.getElementById('kb-banner');
          if (b) b.remove();
          if (typeof showSection === 'function') showSection('battle-royale');
          function clickStart() {
            const btn = document.getElementById('br-start-btn');
            if (btn && btn.offsetParent !== null) btn.click();
            else setTimeout(clickStart, 300);
          }
          setTimeout(clickStart, 400);
        }, 500);
      }
    }, 1000);
  },

  switchTab(tab) {
    this.tab = tab;
    const fc = document.getElementById('mp-friends-content');
    const lc = document.getElementById('mp-lobby-content');
    if (fc) fc.style.display = tab === 'friends' ? 'block' : 'none';
    if (lc) lc.style.display = tab === 'lobby' ? 'block' : 'none';
    const fb = document.getElementById('mp-tab-f');
    const lb = document.getElementById('mp-tab-l');
    if (fb) { fb.style.borderBottomColor = tab === 'friends' ? 'var(--matrix-green)' : 'transparent'; fb.style.color = tab === 'friends' ? 'var(--matrix-green)' : '#44bb44'; }
    if (lb) { lb.style.borderBottomColor = tab === 'lobby' ? 'var(--matrix-green)' : 'transparent'; lb.style.color = tab === 'lobby' ? 'var(--matrix-green)' : '#44bb44'; }
    if (tab === 'friends') this.renderFriends();
    if (tab === 'lobby') this.renderLobby();
  },

  copyId() {
    const id = MP.playerId || localStorage.getItem('mp_id');
    if (!id) return;
    navigator.clipboard.writeText(id).catch(() => {});
    _notify('📋 ID скопирован!', id, 'unlock');
  },

  sendRequest() {
    const el = document.getElementById('mp-add-input');
    if (!el) return;
    const id = el.value.trim().toUpperCase();
    if (!id.match(/^AJ-[A-Z0-9]{4}-[A-Z0-9]{4}$/)) return _notify('❌ Неверный формат', 'AJ-XXXX-XXXX', 'trophies');
    MP.addFriend(id);
    el.value = '';
  },

  showGift(fid, fnick) {
    const old = document.getElementById('mp-gift-panel');
    if (old) { old.remove(); return; }
    const el = document.createElement('div');
    el.id = 'mp-gift-panel';
    el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,12,0,0.97);border:2px solid var(--matrix-green);border-radius:14px;padding:14px;z-index:9999;min-width:240px;font-family:Share Tech Mono,monospace;';
    const bal = window.gameData ? window.gameData.balance || 0 : 0;
    const cry = window.gameData ? window.gameData.crystals || 0 : 0;
    el.innerHTML =
      '<div style="color:var(--matrix-green);font-size:12px;margin-bottom:8px;">🎁 ПОДАРОК ДЛЯ ' + fnick + '</div>' +
      '<div style="font-size:10px;color:#44bb44;margin-bottom:10px;">У тебя: ' + bal + ' F-Bucks, ' + cry + ' кристаллов</div>' +
      '<div style="display:flex;flex-direction:column;gap:6px;">' +
      '<button onclick="MP.sendGift(\'' + fid + '\',\'money\',500);document.getElementById(\'mp-gift-panel\').remove();" style="background:rgba(0,25,0,0.8);border:1px solid rgba(255,215,0,0.5);color:#FFD700;border-radius:6px;padding:8px;cursor:pointer;font-family:Share Tech Mono,monospace;font-size:12px;">💰 500 F-Bucks</button>' +
      '<button onclick="MP.sendGift(\'' + fid + '\',\'money\',1000);document.getElementById(\'mp-gift-panel\').remove();" style="background:rgba(0,25,0,0.8);border:1px solid rgba(255,215,0,0.5);color:#FFD700;border-radius:6px;padding:8px;cursor:pointer;font-family:Share Tech Mono,monospace;font-size:12px;">💰 1000 F-Bucks</button>' +
      '<button onclick="MP.sendGift(\'' + fid + '\',\'crystals\',100);document.getElementById(\'mp-gift-panel\').remove();" style="background:rgba(0,15,25,0.8);border:1px solid rgba(0,200,255,0.5);color:#00ccff;border-radius:6px;padding:8px;cursor:pointer;font-family:Share Tech Mono,monospace;font-size:12px;">💎 100 кристаллов</button>' +
      '<button onclick="document.getElementById(\'mp-gift-panel\').remove();" style="background:rgba(30,0,0,0.7);border:1px solid rgba(255,60,60,0.4);color:#ff6666;border-radius:6px;padding:6px;cursor:pointer;font-family:Share Tech Mono,monospace;font-size:11px;">✖ ОТМЕНА</button>' +
      '</div>';
    document.body.appendChild(el);
  },

  async viewProfile(fid) {
    try {
      const res = await fetch(SERVER_HTTP + '/api/player/' + fid);
      const p = await res.json();
      const old = document.getElementById('mp-profile');
      if (old) old.remove();
      const el = document.createElement('div');
      el.id = 'mp-profile';
      el.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,10,0,0.98);border:2px solid var(--matrix-green);border-radius:16px;padding:24px;z-index:9999;min-width:250px;font-family:Share Tech Mono,monospace;box-shadow:0 0 40px rgba(0,255,65,0.3);text-align:center;';
      el.innerHTML =
        '<div style="font-size:36px;margin-bottom:8px;">👤</div>' +
        '<div style="font-size:17px;color:var(--matrix-green);letter-spacing:2px;">' + p.nickname + '</div>' +
        '<div style="font-size:10px;color:#44bb44;margin-top:3px;margin-bottom:10px;">' + p.id + '</div>' +
        '<div style="display:inline-block;padding:3px 10px;border-radius:12px;background:' + (p.online ? 'rgba(0,40,0,0.8)' : 'rgba(20,20,20,0.8)') + ';border:1px solid ' + (p.online ? 'var(--matrix-green)' : '#333') + ';color:' + (p.online ? 'var(--matrix-green)' : '#555') + ';font-size:11px;margin-bottom:14px;">' + (p.online ? '🟢 В сети' : '⚫ Не в сети') + '</div>' +
        '<div style="display:flex;gap:10px;justify-content:center;margin-bottom:16px;">' +
        '<div style="text-align:center;background:rgba(0,18,0,0.7);border:1px solid rgba(0,255,65,0.2);border-radius:8px;padding:8px 14px;"><div style="font-size:20px;color:#FFD700;">' + (p.stats && p.stats.wins || 0) + '</div><div style="font-size:9px;color:#44bb44;">ПОБЕД</div></div>' +
        '<div style="text-align:center;background:rgba(0,18,0,0.7);border:1px solid rgba(0,255,65,0.2);border-radius:8px;padding:8px 14px;"><div style="font-size:20px;color:var(--matrix-green);">' + (p.stats && p.stats.games || 0) + '</div><div style="font-size:9px;color:#44bb44;">ИГР</div></div>' +
        '</div>' +
        '<button onclick="document.getElementById(\'mp-profile\').remove();" style="width:100%;background:rgba(0,25,0,0.8);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:8px;padding:8px;cursor:pointer;font-family:Share Tech Mono,monospace;font-size:12px;">✖ ЗАКРЫТЬ</button>';
      document.body.appendChild(el);
    } catch(e) { _notify('❌ Ошибка', 'Не удалось загрузить', 'trophies'); }
  }
};

// ================================================================
//  INJECT FRIENDS SECTION INTO GAME
// ================================================================
function injectFriendsSection() {
  if (document.getElementById('mp-section')) return;

  // Добавляем секцию
  const sec = document.createElement('div');
  sec.id = 'mp-section';
  sec.className = 'characters-section';
  sec.style.cssText = 'display:none;position:fixed;inset:0;z-index:1000;flex-direction:column;background:rgba(0,8,0,0.98);';
  sec.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px 8px;border-bottom:1px solid rgba(0,255,65,0.2);">' +
    '<h2 style="font-family:Share Tech Mono,monospace;font-size:17px;color:var(--matrix-green);letter-spacing:3px;">👥 ДРУЗЬЯ</h2>' +
    '<button onclick="showSection(\'main\')" style="background:rgba(0,40,0,0.9);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:6px;padding:5px 12px;cursor:pointer;font-family:Share Tech Mono,monospace;">✕</button>' +
    '</div>' +
    '<div style="display:flex;border-bottom:1px solid rgba(0,255,65,0.12);">' +
    '<button id="mp-tab-f" onclick="UI.switchTab(\'friends\')" style="flex:1;padding:10px;background:rgba(0,35,0,0.7);border:none;border-bottom:2px solid var(--matrix-green);color:var(--matrix-green);font-family:Share Tech Mono,monospace;font-size:12px;cursor:pointer;">👥 ДРУЗЬЯ</button>' +
    '<button id="mp-tab-l" onclick="UI.switchTab(\'lobby\')" style="flex:1;padding:10px;background:rgba(0,12,0,0.5);border:none;border-bottom:2px solid transparent;color:#44bb44;font-family:Share Tech Mono,monospace;font-size:12px;cursor:pointer;">🏠 ЛОББИ</button>' +
    '</div>' +
    '<div style="overflow-y:auto;flex:1;padding:12px;">' +
    '<div id="mp-friends-content"></div>' +
    '<div id="mp-lobby-content" style="display:none;"></div>' +
    '</div>';
  document.body.appendChild(sec);

  // Патчим showSection
  const orig = window.showSection;
  window.showSection = function(name) {
    const s = document.getElementById('mp-section');
    if (name === 'friends') {
      document.querySelectorAll('.characters-section,.shop-section,.events-section,.trophy-road-section,.apple-pass-section').forEach(e => { e.classList.remove('active'); if (e !== s) e.style.display = ''; });
      const mm = document.getElementById('main-menu');
      if (mm) mm.style.display = 'none';
      s.style.display = 'flex';
      UI.switchTab(UI.tab);
      return;
    }
    if (s) s.style.display = 'none';
    if (orig) orig(name);
  };
}

// ================================================================
//  PATCH KБ BUTTON
// ================================================================
function patchKBButton() {
  const btn = document.getElementById('br-start-btn');
  if (!btn) { setTimeout(patchKBButton, 500); return; }

  btn.textContent = '▶ НАЙТИ БОЙ';
  btn.onclick = function() {
    if (MP.playerId) {
      MM.join();
    } else {
      // Нет подключения — обычный локальный запуск
      if (typeof startBattleRoyale === 'function') {
        const lobby = document.getElementById('br-lobby');
        if (lobby) lobby.style.display = 'none';
        startBattleRoyale();
      }
    }
  };
  console.log('[MP] КБ кнопка пропатчена');
}

// ================================================================
//  NOTIFY HELPER
// ================================================================
function _notify(title, desc, type) {
  if (typeof showNotification === 'function') showNotification(title, desc, type || 'unlock');
}

// ================================================================
//  INIT
// ================================================================
async function initMP() {
  injectFriendsSection();
  patchKBButton();

  // Показать ID в инфобаре
  function showIdBadge() {
    const id = MP.playerId || localStorage.getItem('mp_id');
    if (!id) { setTimeout(showIdBadge, 2000); return; }
    if (document.getElementById('mp-id-badge')) return;
    const bar = document.querySelector('.player-info-bar');
    if (!bar) { setTimeout(showIdBadge, 1000); return; }
    const b = document.createElement('span');
    b.id = 'mp-id-badge';
    b.style.cssText = 'font-size:11px;color:#44bb44;cursor:pointer;border:1px solid rgba(0,255,65,0.35);border-radius:4px;padding:2px 7px;margin-left:7px;white-space:nowrap;letter-spacing:1px;';
    b.textContent = id;
    b.title = 'Нажми для копирования';
    b.onclick = () => { navigator.clipboard.writeText(id).catch(()=>{}); _notify('📋 ID скопирован!', id, 'unlock'); };
    bar.appendChild(b);
  }

  // Попытка подключения
  async function tryAuth() {
    const nick = MP.getNick();
    if (!nick) { setTimeout(tryAuth, 800); return; }
    try {
      await MP.auth(nick);
      MP.connect();
      setTimeout(showIdBadge, 800);
    } catch(e) {
      console.warn('[MP] Auth failed:', e);
      setTimeout(tryAuth, 3000);
    }
  }

  tryAuth();
}

// Запуск
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(initMP, 1000));
} else {
  setTimeout(initMP, 1000);
}

// Глобальные алиасы для совместимости
window.AJ_SERVER = MP;
window.FriendsUI = { render: () => UI.renderFriends() };
window.LobbyUI = { render: () => UI.renderLobby() };
