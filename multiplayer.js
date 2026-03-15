// ================================================================
//  APPLE JOURNEY — FRIENDS & LOBBY MODULE v2
// ================================================================

const AJ_SERVER = {
  URL: window.location.hostname === 'localhost'
    ? 'ws://localhost:3000'
    : 'wss://apple-journey-server.onrender.com',
  HTTP: window.location.hostname === 'localhost'
    ? 'http://localhost:3000'
    : 'https://apple-journey-server.onrender.com',

  ws: null,
  playerId: null,
  nickname: null,
  deviceToken: null,
  friends: [],
  friendRequests: [],
  currentLobby: null,
  reconnectTimer: null,
  connected: false,
  _callbacks: {},

  on(event, cb) { this._callbacks[event] = cb; },
  emit(event, data) { if (this._callbacks[event]) this._callbacks[event](data); },

  // Получить ник из всех возможных мест в игре
  getNick() {
    // 1. Из сохранённого localStorage игры
    try {
      const saved = localStorage.getItem('appleRebirthGame');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.username && parsed.username.length >= 2) return parsed.username;
        if (parsed.playerNickname && parsed.playerNickname.length >= 2) return parsed.playerNickname;
      }
    } catch(e) {}
    // 2. Из gameData если уже загружено
    if (window.gameData?.username && window.gameData.username.length >= 2) return window.gameData.username;
    if (window.gameData?.playerNickname && window.gameData.playerNickname.length >= 2) return window.gameData.playerNickname;
    // 3. Из нашего localStorage
    const saved = localStorage.getItem('aj_nickname');
    if (saved && saved.length >= 2 && saved !== 'Игрок') return saved;
    return null;
  },

  async auth(nickname) {
    const token = localStorage.getItem('aj_device_token') || null;
    const res = await fetch(`${this.HTTP}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname, deviceToken: token })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    this.playerId = data.playerId;
    this.nickname = data.nickname;
    this.deviceToken = data.deviceToken;
    localStorage.setItem('aj_device_token', data.deviceToken);
    localStorage.setItem('aj_player_id', data.playerId);
    localStorage.setItem('aj_nickname', data.nickname);
    return data;
  },

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (!this.playerId) return;

    this.ws = new WebSocket(this.URL);

    this.ws.onopen = () => {
      this.connected = true;
      clearTimeout(this.reconnectTimer);
      this.send({ type: 'CONNECT', playerId: this.playerId });
    };

    this.ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._handle(msg);
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = () => { this.ws.close(); };
  },

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ ...msg, playerId: this.playerId }));
    }
  },

  _handle(msg) {
    switch (msg.type) {
      case 'CONNECTED':
        this.emit('connected', msg);
        this.send({ type: 'LOBBY_GET' });
        this.loadFriends();
        break;
      case 'ERROR':
        if (typeof showNotification === 'function')
          showNotification('❌ Ошибка', msg.text, 'trophies');
        break;
      case 'FRIEND_ONLINE':
        this._updateFriendStatus(msg.friendId, true);
        if (typeof showNotification === 'function')
          showNotification('🟢 Онлайн', `${msg.nickname} вошёл в игру`, 'unlock');
        FriendsUI.render();
        break;
      case 'FRIEND_OFFLINE':
        this._updateFriendStatus(msg.friendId, false);
        FriendsUI.render();
        break;
      case 'FRIEND_REQUEST_IN':
        if (!this.friendRequests.find(r => r.id === msg.fromId))
          this.friendRequests.push({ id: msg.fromId, nickname: msg.fromNick });
        if (typeof showNotification === 'function')
          showNotification('👥 Заявка в друзья', `${msg.fromNick} хочет добавить вас`, 'unlock');
        FriendsUI.render();
        break;
      case 'FRIEND_REQUESTS':
        this.friendRequests = msg.requests;
        FriendsUI.render();
        break;
      case 'FRIEND_REQUEST_SENT':
        if (typeof showNotification === 'function')
          showNotification('✅ Заявка отправлена', `Запрос отправлен: ${msg.targetNick}`, 'unlock');
        break;
      case 'FRIEND_ADDED': {
        // Перезагружаем список друзей с сервера чтобы получить актуальные данные
        this.friendRequests = this.friendRequests.filter(r => r.id !== msg.friend?.id);
        if (typeof showNotification === 'function')
          showNotification('🎉 Новый друг!', `${msg.friend?.nickname || 'Игрок'} теперь ваш друг`, 'unlock');
        // Reload friends from server to get fresh data
        await this.loadFriends();
        break;
      }
      case 'FRIEND_DECLINED':
        this.friendRequests = this.friendRequests.filter(r => r.id !== msg.fromId);
        FriendsUI.render();
        break;
      case 'LOBBY_CREATED':
        this.currentLobby = msg.lobby;
        LobbyUI.render();
        if (typeof showNotification === 'function')
          showNotification('🏠 Лобби создано', `ID: ${msg.lobbyId}`, 'unlock');
        break;
      case 'LOBBY_UPDATED':
        this.currentLobby = msg.lobby;
        LobbyUI.render();
        break;
      case 'LOBBY_DATA':
        this.currentLobby = msg.lobby;
        LobbyUI.render();
        break;
      case 'LOBBY_LEFT':
        this.currentLobby = null;
        LobbyUI.render();
        break;
      case 'LOBBY_INVITE_IN':
        LobbyUI.showInvite(msg);
        break;
      case 'LOBBY_INVITE_SENT':
        if (typeof showNotification === 'function')
          showNotification('📨 Приглашение отправлено', `${msg.friendNick} получил приглашение`, 'unlock');
        break;
      case 'LOBBY_INVITE_DECLINED':
        if (typeof showNotification === 'function')
          showNotification('❌ Отклонено', `${msg.byNick} отклонил приглашение`, 'trophies');
        break;
      case 'LOBBY_KB_START':
        this.currentLobby.status = 'kb';
        LobbyUI.startKB(msg);
        break;
      case 'LOBBY_CHAT_MSG':
        LobbyUI.addChat(msg);
        break;
      case 'GIFT_RECEIVED':
        if (typeof showNotification === 'function')
          showNotification('🎁 Подарок!', `${msg.fromNick} прислал: ${msg.desc}`, 'unlock');
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
      case 'TRADE_REQUEST':
        TradeUI.showRequest(msg);
        break;
      case 'TRADE_ACCEPTED':
        if (typeof showNotification === 'function')
          showNotification('🔄 Обмен принят!', msg.desc || 'Обмен завершён', 'unlock');
        break;
      case 'TRADE_DECLINED':
        if (typeof showNotification === 'function')
          showNotification('❌ Обмен отклонён', `${msg.byNick} отклонил обмен`, 'trophies');
        break;
      case 'CLICKBATTLE_INVITE':
        ClickBattle.showInvite(msg);
        break;
      case 'CLICKBATTLE_START':
        ClickBattle.start(msg);
        break;
      case 'CLICKBATTLE_UPDATE':
        ClickBattle.update(msg);
        break;
      case 'CLICKBATTLE_END':
        ClickBattle.end(msg);
        break;
    }
  },

  _updateFriendStatus(friendId, online) {
    const f = this.friends.find(x => x.id === friendId);
    if (f) f.online = online;
  },

  async loadFriends() {
    if (!this.playerId) return;
    try {
      const res = await fetch(`${this.HTTP}/api/friends/${this.playerId}`);
      const data = await res.json();
      this.friends = (data.friends || []).map(f => ({
        ...f,
        nickname: f.nickname || f.nick || '???',
        online: f.online || false
      }));
      this.friendRequests = (data.incoming || []).map(r => ({
        ...r,
        nickname: r.nickname || r.nick || '???'
      }));
      FriendsUI.render();
    } catch(e) { console.warn('loadFriends error:', e); }
  },

  sendFriendRequest(targetId) { this.send({ type: 'FRIEND_REQUEST', targetId }); },
  acceptFriend(fromId) { this.send({ type: 'FRIEND_ACCEPT', fromId }); },
  declineFriend(fromId) { this.send({ type: 'FRIEND_DECLINE', fromId }); },
  createLobby() { this.send({ type: 'LOBBY_CREATE' }); },
  inviteToLobby(friendId) { this.send({ type: 'LOBBY_INVITE', friendId }); },
  joinLobby(lobbyId) { this.send({ type: 'LOBBY_JOIN', lobbyId }); },
  leaveLobby() { this.send({ type: 'LOBBY_LEAVE' }); this.currentLobby = null; LobbyUI.render(); },
  startKB() { this.send({ type: 'LOBBY_START_KB' }); },
  sendChat(text) { this.send({ type: 'LOBBY_CHAT', text }); },
  reportKBResult(won) { this.send({ type: 'KB_RESULT', won }); },

  // Подарок другу
  sendGift(friendId, type, amount) {
    const friend = this.friends.find(f => f.id === friendId);
    if (!friend) return;
    if (type === 'money') {
      if (!window.gameData || window.gameData.balance < amount) {
        if (typeof showNotification === 'function')
          showNotification('❌ Недостаточно F-Bucks', '', 'trophies');
        return;
      }
      window.gameData.balance -= amount;
      if (typeof saveGameData === 'function') saveGameData();
      if (typeof updateUI === 'function') updateUI();
    }
    if (type === 'crystals') {
      if (!window.gameData || window.gameData.crystals < amount) {
        if (typeof showNotification === 'function')
          showNotification('❌ Недостаточно кристаллов', '', 'trophies');
        return;
      }
      window.gameData.crystals -= amount;
      if (typeof saveGameData === 'function') saveGameData();
      if (typeof updateUI === 'function') updateUI();
    }
    this.send({ type: 'SEND_GIFT', targetId: friendId, giftType: type, amount });
    if (typeof showNotification === 'function')
      showNotification('🎁 Подарок отправлен!', `${friend.nickname} получит подарок`, 'unlock');
  },

  // Предложить обмен
  sendTradeOffer(friendId, offer) {
    this.send({ type: 'TRADE_OFFER', targetId: friendId, offer });
  },

  // Вызов на клик-батл
  challengeClickBattle(friendId) {
    const friend = this.friends.find(f => f.id === friendId);
    if (!friend || !friend.online) {
      if (typeof showNotification === 'function')
        showNotification('❌ Друг не в сети', '', 'trophies');
      return;
    }
    this.send({ type: 'CLICKBATTLE_CHALLENGE', targetId: friendId });
    if (typeof showNotification === 'function')
      showNotification('⚡ Вызов отправлен!', `${friend.nickname} получил вызов на клик-батл`, 'unlock');
  }
};

// ================================================================
//  CLICK BATTLE — соревнование кто больше кликнет за 30 сек
// ================================================================
const ClickBattle = {
  active: false,
  myScore: 0,
  oppScore: 0,
  oppNick: '',
  timer: null,
  timeLeft: 30,

  showInvite(msg) {
    const existing = document.getElementById('cb-invite-popup');
    if (existing) existing.remove();
    const popup = document.createElement('div');
    popup.id = 'cb-invite-popup';
    popup.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,20,0,0.97);border:2px solid #FFD700;border-radius:14px;padding:16px 20px;z-index:9999;box-shadow:0 0 30px rgba(255,215,0,0.4);min-width:280px;font-family:'Share Tech Mono',monospace;`;
    popup.innerHTML = `
      <div style="color:#FFD700;font-size:14px;margin-bottom:4px;">⚡ ВЫЗОВ НА КЛИК-БАТЛ!</div>
      <div style="color:#44bb44;font-size:12px;margin-bottom:12px;">${msg.fromNick} вызывает тебя! Кто больше кликнет за 30 сек?</div>
      <div style="display:flex;gap:8px;">
        <button onclick="AJ_SERVER.send({type:'CLICKBATTLE_ACCEPT',targetId:'${msg.fromId}'});document.getElementById('cb-invite-popup')?.remove();"
          style="flex:1;background:linear-gradient(45deg,#001a00,#FFD700);border:1px solid #FFD700;color:#000;border-radius:8px;padding:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:12px;font-weight:bold;">
          ⚡ ПРИНЯТЬ
        </button>
        <button onclick="document.getElementById('cb-invite-popup')?.remove();"
          style="flex:1;background:rgba(40,0,0,0.7);border:1px solid rgba(255,60,60,0.4);color:#ff6666;border-radius:8px;padding:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:12px;">
          ✖ ОТКЛОНИТЬ
        </button>
      </div>`;
    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), 20000);
  },

  start(msg) {
    this.active = true;
    this.myScore = 0;
    this.oppScore = msg.oppScore || 0;
    this.oppNick = msg.oppNick || 'Соперник';
    this.timeLeft = 30;

    const overlay = document.createElement('div');
    overlay.id = 'cb-overlay';
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.95);z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:'Share Tech Mono',monospace;`;
    overlay.innerHTML = `
      <div style="font-size:20px;color:#FFD700;letter-spacing:3px;margin-bottom:8px;">⚡ КЛИК-БАТЛ!</div>
      <div style="display:flex;gap:40px;margin-bottom:20px;">
        <div style="text-align:center;">
          <div style="color:var(--matrix-green);font-size:13px;">ТЫ</div>
          <div id="cb-my-score" style="font-size:48px;color:var(--matrix-green);">0</div>
        </div>
        <div style="text-align:center;">
          <div style="color:#ff4444;font-size:13px;">${this.oppNick}</div>
          <div id="cb-opp-score" style="font-size:48px;color:#ff4444;">0</div>
        </div>
      </div>
      <div id="cb-timer" style="font-size:28px;color:#FFD700;margin-bottom:20px;">30</div>
      <button id="cb-click-btn" style="width:180px;height:180px;border-radius:50%;background:linear-gradient(45deg,#001a00,#00ff41);border:4px solid var(--matrix-green);color:#000;font-size:40px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-weight:bold;box-shadow:0 0 40px rgba(0,255,65,0.6);transition:transform 0.05s;">
        🍎
      </button>
      <div style="color:#44bb44;font-size:11px;margin-top:12px;">ЖМИ КАК МОЖНО БЫСТРЕЕ!</div>
    `;
    document.body.appendChild(overlay);

    const btn = document.getElementById('cb-click-btn');
    btn.addEventListener('click', () => {
      if (!this.active) return;
      this.myScore++;
      document.getElementById('cb-my-score').textContent = this.myScore;
      btn.style.transform = 'scale(0.93)';
      setTimeout(() => { btn.style.transform = 'scale(1)'; }, 50);
      AJ_SERVER.send({ type: 'CLICKBATTLE_CLICK', score: this.myScore });
    });
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      btn.click();
    }, { passive: false });

    this.timer = setInterval(() => {
      this.timeLeft--;
      const timerEl = document.getElementById('cb-timer');
      if (timerEl) timerEl.textContent = this.timeLeft;
      if (this.timeLeft <= 0) {
        clearInterval(this.timer);
        AJ_SERVER.send({ type: 'CLICKBATTLE_DONE', score: this.myScore });
      }
    }, 1000);
  },

  update(msg) {
    const el = document.getElementById('cb-opp-score');
    if (el) el.textContent = msg.oppScore;
    this.oppScore = msg.oppScore;
  },

  end(msg) {
    this.active = false;
    clearInterval(this.timer);
    const overlay = document.getElementById('cb-overlay');
    if (overlay) {
      const won = msg.winnerId === AJ_SERVER.playerId;
      const reward = won ? 500 : 100;
      overlay.innerHTML = `
        <div style="text-align:center;font-family:'Share Tech Mono',monospace;">
          <div style="font-size:36px;margin-bottom:12px;">${won ? '🏆' : '😔'}</div>
          <div style="font-size:22px;color:${won?'#FFD700':'#ff4444'};letter-spacing:3px;margin-bottom:8px;">${won ? 'ПОБЕДА!' : 'ПОРАЖЕНИЕ'}</div>
          <div style="color:var(--matrix-green);margin-bottom:6px;">Ты: ${msg.myScore} кликов</div>
          <div style="color:#ff4444;margin-bottom:16px;">${this.oppNick}: ${msg.oppScore} кликов</div>
          <div style="color:#FFD700;margin-bottom:20px;">+${reward} F-Bucks</div>
          <button onclick="document.getElementById('cb-overlay').remove()" style="background:linear-gradient(45deg,#001a00,#003300);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:8px;padding:10px 24px;cursor:pointer;font-family:'Share Tech Mono',monospace;">
            ЗАКРЫТЬ
          </button>
        </div>`;
      if (won && window.gameData) {
        window.gameData.balance = (window.gameData.balance||0) + reward;
        if (typeof saveGameData === 'function') saveGameData();
        if (typeof updateUI === 'function') updateUI();
      }
    }
  }
};

// ================================================================
//  TRADE UI — обмен скинами/персонажами
// ================================================================
const TradeUI = {
  showRequest(msg) {
    const existing = document.getElementById('trade-popup');
    if (existing) existing.remove();
    const popup = document.createElement('div');
    popup.id = 'trade-popup';
    popup.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,20,0,0.97);border:2px solid #00ffff;border-radius:14px;padding:16px 20px;z-index:9999;min-width:280px;font-family:'Share Tech Mono',monospace;`;
    popup.innerHTML = `
      <div style="color:#00ffff;font-size:14px;margin-bottom:6px;">🔄 ПРЕДЛОЖЕНИЕ ОБМЕНА</div>
      <div style="color:#44bb44;font-size:12px;margin-bottom:4px;">От: ${msg.fromNick}</div>
      <div style="color:var(--matrix-green);font-size:12px;margin-bottom:12px;">Предлагает: ${msg.offer?.desc || 'предмет'}</div>
      <div style="display:flex;gap:8px;">
        <button onclick="AJ_SERVER.send({type:'TRADE_ACCEPT',fromId:'${msg.fromId}'});document.getElementById('trade-popup')?.remove();"
          style="flex:1;background:linear-gradient(45deg,#001a00,#003300);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:8px;padding:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:12px;">
          ✔ ПРИНЯТЬ
        </button>
        <button onclick="AJ_SERVER.send({type:'TRADE_DECLINE',fromId:'${msg.fromId}'});document.getElementById('trade-popup')?.remove();"
          style="flex:1;background:rgba(40,0,0,0.7);border:1px solid rgba(255,60,60,0.4);color:#ff6666;border-radius:8px;padding:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:12px;">
          ✖ ОТКЛОНИТЬ
        </button>
      </div>`;
    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), 30000);
  }
};

// ================================================================
//  FRIENDS UI
// ================================================================
const FriendsUI = {
  _activeTab: 'friends',

  render() {
    const container = document.getElementById('friends-content');
    if (!container || this._activeTab !== 'friends') return;

    const friends = AJ_SERVER.friends;
    const requests = AJ_SERVER.friendRequests;

    container.innerHTML = `
      <div style="background:rgba(0,40,0,0.7);border:1px solid var(--matrix-green);border-radius:10px;padding:12px 16px;margin-bottom:14px;">
        <div style="font-size:11px;color:#44bb44;letter-spacing:1px;margin-bottom:4px;">МОЙ ID</div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:16px;color:var(--matrix-green);letter-spacing:2px;font-weight:bold;">${AJ_SERVER.playerId || '—'}</span>
          <button onclick="FriendsUI.copyId()" style="background:rgba(0,60,0,0.8);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:'Share Tech Mono',monospace;">📋 КОПИРОВАТЬ</button>
        </div>
        <div style="font-size:10px;color:#44bb44;margin-top:4px;">Ник: <span style="color:var(--matrix-green);">${AJ_SERVER.nickname || '—'}</span></div>
      </div>

      <div style="background:rgba(0,20,0,0.7);border:1px solid rgba(0,255,65,0.3);border-radius:10px;padding:12px;margin-bottom:14px;">
        <div style="font-size:11px;color:#44bb44;letter-spacing:1px;margin-bottom:8px;">ДОБАВИТЬ ДРУГА ПО ID</div>
        <div style="display:flex;gap:8px;">
          <input id="friend-id-input" type="text" placeholder="AJ-XXXX-XXXX" maxlength="12"
            style="flex:1;background:rgba(0,30,0,0.8);border:1px solid var(--matrix-green);border-radius:6px;color:var(--matrix-green);font-family:'Share Tech Mono',monospace;font-size:13px;padding:6px 10px;outline:none;"
            oninput="this.value=this.value.toUpperCase()"
          />
          <button onclick="FriendsUI.sendRequest()" style="background:linear-gradient(45deg,#001a00,#003300);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:'Share Tech Mono',monospace;">➕</button>
        </div>
      </div>

      ${requests.length > 0 ? `
      <div style="margin-bottom:14px;">
        <div style="font-size:11px;color:#FFD700;letter-spacing:1px;margin-bottom:6px;">ВХОДЯЩИЕ ЗАЯВКИ (${requests.length})</div>
        ${requests.map(r => `
          <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(20,15,0,0.8);border:1px solid rgba(255,215,0,0.3);border-radius:8px;padding:8px 12px;margin-bottom:6px;">
            <span style="color:#FFD700;font-size:13px;">${r.nickname}</span>
            <div style="display:flex;gap:6px;">
              <button onclick="AJ_SERVER.acceptFriend('${r.id}')" style="background:rgba(0,60,0,0.8);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer;">✔</button>
              <button onclick="AJ_SERVER.declineFriend('${r.id}')" style="background:rgba(40,0,0,0.8);border:1px solid rgba(255,60,60,0.5);color:#ff6666;border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer;">✖</button>
            </div>
          </div>`).join('')}
      </div>` : ''}

      <div style="font-size:11px;color:#44bb44;letter-spacing:1px;margin-bottom:8px;">ДРУЗЬЯ (${friends.length})</div>
      ${friends.length === 0
        ? `<div style="text-align:center;color:rgba(0,255,65,0.3);padding:24px;font-size:13px;">Нет друзей. Добавь по ID!</div>`
        : friends.map(f => `
          <div style="background:rgba(0,15,0,0.8);border:1px solid rgba(0,255,65,0.2);border-radius:8px;padding:10px 12px;margin-bottom:8px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="width:8px;height:8px;border-radius:50%;background:${f.online?'#00ff41':'#333'};flex-shrink:0;box-shadow:${f.online?'0 0 6px #00ff41':'none'};"></span>
                <div>
                  <div style="color:var(--matrix-green);font-size:13px;">${f.nickname||f.nick||'???'}</div>
                  <div style="color:#44bb44;font-size:10px;">${f.online?'🟢 В сети':'⚫ Не в сети'} • ${f.id}</div>
                </div>
              </div>
            </div>
            ${f.online ? `
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              ${AJ_SERVER.currentLobby && AJ_SERVER.currentLobby.host === AJ_SERVER.playerId
                ? `<button onclick="AJ_SERVER.inviteToLobby('${f.id}')" style="background:rgba(0,40,0,0.8);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:5px;padding:4px 8px;font-size:10px;cursor:pointer;font-family:'Share Tech Mono',monospace;">📨 В ЛОББИ</button>`
                : ''}
              <button onclick="FriendsUI.showGiftPanel('${f.id}','${f.nickname}')" style="background:rgba(0,30,0,0.8);border:1px solid rgba(0,255,65,0.4);color:var(--matrix-green);border-radius:5px;padding:4px 8px;font-size:10px;cursor:pointer;font-family:'Share Tech Mono',monospace;">🎁 ПОДАРОК</button>
              <button onclick="AJ_SERVER.challengeClickBattle('${f.id}')" style="background:rgba(20,15,0,0.8);border:1px solid rgba(255,215,0,0.4);color:#FFD700;border-radius:5px;padding:4px 8px;font-size:10px;cursor:pointer;font-family:'Share Tech Mono',monospace;">⚡ КЛИК-БАТЛ</button>
              <button onclick="FriendsUI.viewProfile('${f.id}')" style="background:rgba(0,20,30,0.8);border:1px solid rgba(0,200,255,0.4);color:#00ccff;border-radius:5px;padding:4px 8px;font-size:10px;cursor:pointer;font-family:'Share Tech Mono',monospace;">👤 ПРОФИЛЬ</button>
            </div>` : `
            <div style="display:flex;gap:6px;">
              <button onclick="FriendsUI.viewProfile('${f.id}')" style="background:rgba(0,20,30,0.8);border:1px solid rgba(0,200,255,0.4);color:#00ccff;border-radius:5px;padding:4px 8px;font-size:10px;cursor:pointer;font-family:'Share Tech Mono',monospace;">👤 ПРОФИЛЬ</button>
            </div>`}
          </div>`).join('')}
    `;
  },

  copyId() {
    navigator.clipboard.writeText(AJ_SERVER.playerId || '').catch(()=>{});
    if (typeof showNotification === 'function')
      showNotification('📋 Скопировано!', `ID: ${AJ_SERVER.playerId}`, 'unlock');
  },

  sendRequest() {
    const input = document.getElementById('friend-id-input');
    if (!input) return;
    const id = input.value.trim().toUpperCase();
    if (!id.match(/^AJ-[A-Z0-9]{4}-[A-Z0-9]{4}$/)) {
      if (typeof showNotification === 'function')
        showNotification('❌ Неверный формат', 'ID должен быть AJ-XXXX-XXXX', 'trophies');
      return;
    }
    AJ_SERVER.sendFriendRequest(id);
    input.value = '';
  },

  showGiftPanel(friendId, friendNick) {
    const existing = document.getElementById('gift-panel');
    if (existing) { existing.remove(); return; }
    const panel = document.createElement('div');
    panel.id = 'gift-panel';
    panel.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,15,0,0.98);border:2px solid var(--matrix-green);border-radius:14px;padding:16px;z-index:9999;min-width:260px;font-family:'Share Tech Mono',monospace;`;
    const bal = window.gameData?.balance || 0;
    const cry = window.gameData?.crystals || 0;
    panel.innerHTML = `
      <div style="color:var(--matrix-green);font-size:13px;margin-bottom:10px;">🎁 ПОДАРОК ДЛЯ ${friendNick}</div>
      <div style="font-size:11px;color:#44bb44;margin-bottom:8px;">У тебя: ${bal} F-Bucks, ${cry} кристаллов</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <button onclick="AJ_SERVER.sendGift('${friendId}','money',500);document.getElementById('gift-panel')?.remove();"
          style="background:rgba(0,30,0,0.8);border:1px solid rgba(255,215,0,0.5);color:#FFD700;border-radius:6px;padding:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:12px;">
          💰 500 F-Bucks
        </button>
        <button onclick="AJ_SERVER.sendGift('${friendId}','money',1000);document.getElementById('gift-panel')?.remove();"
          style="background:rgba(0,30,0,0.8);border:1px solid rgba(255,215,0,0.5);color:#FFD700;border-radius:6px;padding:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:12px;">
          💰 1000 F-Bucks
        </button>
        <button onclick="AJ_SERVER.sendGift('${friendId}','crystals',100);document.getElementById('gift-panel')?.remove();"
          style="background:rgba(0,20,30,0.8);border:1px solid rgba(0,200,255,0.5);color:#00ccff;border-radius:6px;padding:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:12px;">
          💎 100 кристаллов
        </button>
        <button onclick="document.getElementById('gift-panel')?.remove();"
          style="background:rgba(30,0,0,0.8);border:1px solid rgba(255,60,60,0.4);color:#ff6666;border-radius:6px;padding:6px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:11px;">
          ✖ ОТМЕНА
        </button>
      </div>`;
    document.body.appendChild(panel);
  },

  async viewProfile(friendId) {
    try {
      const res = await fetch(`${AJ_SERVER.HTTP}/api/player/${friendId}`);
      const p = await res.json();
      const existing = document.getElementById('profile-popup');
      if (existing) existing.remove();
      const popup = document.createElement('div');
      popup.id = 'profile-popup';
      popup.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,12,0,0.98);border:2px solid var(--matrix-green);border-radius:16px;padding:24px;z-index:9999;min-width:260px;font-family:'Share Tech Mono',monospace;box-shadow:0 0 40px rgba(0,255,65,0.3);`;
      popup.innerHTML = `
        <div style="text-align:center;margin-bottom:16px;">
          <div style="font-size:40px;margin-bottom:8px;">👤</div>
          <div style="font-size:18px;color:var(--matrix-green);letter-spacing:2px;">${p.nickname}</div>
          <div style="font-size:11px;color:#44bb44;margin-top:4px;">${p.id}</div>
          <div style="margin-top:6px;padding:3px 10px;border-radius:12px;display:inline-block;background:${p.online?'rgba(0,40,0,0.8)':'rgba(20,20,20,0.8)'};border:1px solid ${p.online?'var(--matrix-green)':'#333'};color:${p.online?'var(--matrix-green)':'#555'};font-size:11px;">${p.online?'🟢 В сети':'⚫ Не в сети'}</div>
        </div>
        <div style="display:flex;gap:12px;justify-content:center;margin-bottom:16px;">
          <div style="text-align:center;background:rgba(0,20,0,0.7);border:1px solid rgba(0,255,65,0.2);border-radius:8px;padding:8px 16px;">
            <div style="font-size:20px;color:#FFD700;">${p.stats?.wins||0}</div>
            <div style="font-size:10px;color:#44bb44;">ПОБЕД</div>
          </div>
          <div style="text-align:center;background:rgba(0,20,0,0.7);border:1px solid rgba(0,255,65,0.2);border-radius:8px;padding:8px 16px;">
            <div style="font-size:20px;color:var(--matrix-green);">${p.stats?.games||0}</div>
            <div style="font-size:10px;color:#44bb44;">ИГР</div>
          </div>
          <div style="text-align:center;background:rgba(0,20,0,0.7);border:1px solid rgba(0,255,65,0.2);border-radius:8px;padding:8px 16px;">
            <div style="font-size:20px;color:#00ccff;">${p.friendsCount||0}</div>
            <div style="font-size:10px;color:#44bb44;">ДРУЗЕЙ</div>
          </div>
        </div>
        <button onclick="document.getElementById('profile-popup')?.remove();" style="width:100%;background:rgba(0,30,0,0.8);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:8px;padding:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:12px;">
          ✖ ЗАКРЫТЬ
        </button>`;
      document.body.appendChild(popup);
    } catch(e) {
      if (typeof showNotification === 'function')
        showNotification('❌ Ошибка', 'Не удалось загрузить профиль', 'trophies');
    }
  },

  _tab(tab) {
    this._activeTab = tab;
    const fc = document.getElementById('friends-content');
    const lc = document.getElementById('lobby-content');
    if (fc) fc.style.display = tab === 'friends' ? 'block' : 'none';
    if (lc) lc.style.display = tab === 'lobby' ? 'block' : 'none';
    const fb = document.getElementById('tab-friends-btn');
    const lb = document.getElementById('tab-lobby-btn');
    if (fb) { fb.style.borderBottomColor = tab==='friends'?'var(--matrix-green)':'transparent'; fb.style.color = tab==='friends'?'var(--matrix-green)':'#44bb44'; fb.style.background = tab==='friends'?'rgba(0,40,0,0.7)':'rgba(0,15,0,0.5)'; }
    if (lb) { lb.style.borderBottomColor = tab==='lobby'?'var(--matrix-green)':'transparent'; lb.style.color = tab==='lobby'?'var(--matrix-green)':'#44bb44'; lb.style.background = tab==='lobby'?'rgba(0,40,0,0.7)':'rgba(0,15,0,0.5)'; }
    if (tab === 'lobby') LobbyUI.render();
    if (tab === 'friends') this.render();
  }
};

// ================================================================
//  LOBBY UI
// ================================================================
const LobbyUI = {
  chatMessages: [],

  render() {
    const container = document.getElementById('lobby-content');
    if (!container) return;

    const lobby = AJ_SERVER.currentLobby;

    if (!lobby) {
      container.innerHTML = `
        <div style="text-align:center;padding:20px;">
          <div style="color:rgba(0,255,65,0.4);font-size:13px;margin-bottom:16px;">Вы не в лобби</div>
          <button onclick="AJ_SERVER.createLobby()" style="background:linear-gradient(45deg,#001a00,#00ff41);border:2px solid var(--matrix-green);color:#000;border-radius:10px;padding:12px 28px;font-size:14px;font-weight:bold;cursor:pointer;font-family:'Share Tech Mono',monospace;letter-spacing:2px;">
            ➕ СОЗДАТЬ ЛОББИ
          </button>
        </div>`;
      return;
    }

    const isHost = lobby.host === AJ_SERVER.playerId;
    const players = lobby.players || [];
    const names = lobby.playerNames || {};
    const canStart = isHost && players.length >= 1;
    const onlineFriends = AJ_SERVER.friends.filter(f => f.online && !players.includes(f.id));

    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div>
          <div style="font-size:11px;color:#44bb44;">ЛОББИ ${isHost?'👑':''}</div>
          <div style="font-size:15px;color:var(--matrix-green);">${lobby.id}</div>
        </div>
        <button onclick="AJ_SERVER.leaveLobby()" style="background:rgba(40,0,0,0.7);border:1px solid rgba(255,60,60,0.5);color:#ff6666;border-radius:6px;padding:6px 12px;font-size:11px;cursor:pointer;font-family:'Share Tech Mono',monospace;">🚪 ВЫЙТИ</button>
      </div>

      <div style="margin-bottom:12px;">
        <div style="font-size:11px;color:#44bb44;margin-bottom:6px;">ИГРОКИ (${players.length}/4)</div>
        ${[0,1,2,3].map(i => {
          const pid = players[i];
          if (pid) {
            const nick = names[pid] || '???';
            const isMe = pid === AJ_SERVER.playerId;
            const isLobbyHost = pid === lobby.host;
            return `<div style="display:flex;align-items:center;gap:8px;background:rgba(0,25,0,0.8);border:1px solid rgba(0,255,65,0.3);border-radius:8px;padding:8px 12px;margin-bottom:4px;">
              <span style="color:var(--matrix-green);">${isLobbyHost?'👑':''} ${nick}${isMe?' (ты)':''}</span>
            </div>`;
          }
          return `<div style="background:rgba(0,10,0,0.5);border:1px dashed rgba(0,255,65,0.15);border-radius:8px;padding:8px 12px;margin-bottom:4px;color:rgba(0,255,65,0.25);font-size:12px;">— слот ${i+1} свободен</div>`;
        }).join('')}
      </div>

      ${isHost && onlineFriends.length > 0 ? `
      <div style="margin-bottom:12px;">
        <div style="font-size:11px;color:#44bb44;margin-bottom:6px;">ПРИГЛАСИТЬ ДРУГА</div>
        ${onlineFriends.map(f=>`
          <button onclick="AJ_SERVER.inviteToLobby('${f.id}')" style="background:rgba(0,30,0,0.8);border:1px solid rgba(0,255,65,0.4);color:var(--matrix-green);border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:'Share Tech Mono',monospace;margin-bottom:4px;width:100%;text-align:left;">
            📨 ${f.nickname}
          </button>`).join('')}
      </div>` : ''}

      ${lobby.status === 'waiting' ? `
      <button onclick="${canStart?'AJ_SERVER.startKB()':''}"
        style="width:100%;padding:14px;background:${canStart?'linear-gradient(45deg,#001a00,#00ff41)':'rgba(0,20,0,0.5)'};border:2px solid ${canStart?'var(--matrix-green)':'rgba(0,255,65,0.2)'};color:${canStart?'#000':'rgba(0,255,65,0.3)'};border-radius:10px;font-family:'Share Tech Mono',monospace;font-size:14px;font-weight:bold;cursor:${canStart?'pointer':'not-allowed'};margin-bottom:12px;">
        ⚔️ НАЧАТЬ КБ ${!isHost?'(только хост)':''}
      </button>` : `
      <div style="text-align:center;color:#FFD700;font-size:13px;padding:8px;border:1px solid rgba(255,215,0,0.3);border-radius:8px;margin-bottom:12px;">⚔️ КБ ИДЁТ...</div>`}

      <div style="border:1px solid rgba(0,255,65,0.2);border-radius:8px;overflow:hidden;">
        <div id="lobby-chat-msgs" style="height:80px;overflow-y:auto;padding:6px 10px;font-size:11px;color:#44bb44;">
          ${this.chatMessages.slice(-20).map(m=>`<div><span style="color:var(--matrix-green);">${m.fromNick}:</span> ${m.text}</div>`).join('')}
        </div>
        <div style="display:flex;border-top:1px solid rgba(0,255,65,0.15);">
          <input id="lobby-chat-input" type="text" placeholder="Сообщение..." maxlength="100"
            style="flex:1;background:rgba(0,10,0,0.8);border:none;color:var(--matrix-green);font-family:'Share Tech Mono',monospace;font-size:12px;padding:6px 10px;outline:none;"
            onkeypress="if(event.key==='Enter'){LobbyUI.sendChat();}"/>
          <button onclick="LobbyUI.sendChat()" style="background:rgba(0,40,0,0.8);border:none;color:var(--matrix-green);padding:6px 12px;cursor:pointer;">➤</button>
        </div>
      </div>`;

    const chatEl = document.getElementById('lobby-chat-msgs');
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
  },

  sendChat() {
    const input = document.getElementById('lobby-chat-input');
    if (!input || !input.value.trim()) return;
    AJ_SERVER.sendChat(input.value.trim());
    input.value = '';
  },

  addChat(msg) {
    this.chatMessages.push(msg);
    if (this.chatMessages.length > 50) this.chatMessages.shift();
    if (FriendsUI._activeTab === 'lobby') this.render();
  },

  showInvite(msg) {
    const existing = document.getElementById('lobby-invite-popup');
    if (existing) existing.remove();
    const popup = document.createElement('div');
    popup.id = 'lobby-invite-popup';
    popup.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,20,0,0.97);border:2px solid var(--matrix-green);border-radius:14px;padding:16px 20px;z-index:9999;box-shadow:0 0 30px rgba(0,255,65,0.4);min-width:280px;font-family:'Share Tech Mono',monospace;`;
    popup.innerHTML = `
      <div style="color:var(--matrix-green);font-size:14px;margin-bottom:4px;">📨 ПРИГЛАШЕНИЕ В ЛОББИ</div>
      <div style="color:#44bb44;font-size:12px;margin-bottom:12px;">${msg.hostNick} приглашает тебя в КБ</div>
      <div style="display:flex;gap:8px;">
        <button onclick="AJ_SERVER.joinLobby('${msg.lobbyId}');document.getElementById('lobby-invite-popup')?.remove();FriendsUI._tab('lobby');"
          style="flex:1;background:linear-gradient(45deg,#001a00,#003300);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:8px;padding:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:12px;">✔ ПРИНЯТЬ</button>
        <button onclick="AJ_SERVER.send({type:'LOBBY_DECLINE',lobbyId:'${msg.lobbyId}'});document.getElementById('lobby-invite-popup')?.remove();"
          style="flex:1;background:rgba(40,0,0,0.7);border:1px solid rgba(255,60,60,0.4);color:#ff6666;border-radius:8px;padding:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:12px;">✖ ОТКЛОНИТЬ</button>
      </div>`;
    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), 30000);
  },

  startKB(msg) {
    const myTeam = msg.teams[AJ_SERVER.playerId];
    window._kbLobbyMatch = msg;

    // Баннер с обратным отсчётом
    const banner = document.createElement('div');
    banner.id = 'kb-team-banner';
    banner.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.97);border:3px solid ' + (myTeam==='A'?'#00ff41':'#ff4444') + ';border-radius:18px;padding:24px 36px;z-index:99999;text-align:center;font-family:Share Tech Mono,monospace;min-width:260px;';
    const allies = msg.players.filter(p=>msg.teams[p.id]===myTeam&&p.id!==AJ_SERVER.playerId).map(p=>p.nickname).join(', ')||'только ты';
    const enemies = msg.players.filter(p=>msg.teams[p.id]!==myTeam).map(p=>p.nickname).join(', ')||'боты';
    banner.innerHTML = '<div style="font-size:13px;color:#888;margin-bottom:6px;">КБ ЗАПУСКАЕТСЯ</div>' +
      '<div style="font-size:32px;color:' + (myTeam==='A'?'var(--matrix-green)':'#ff4444') + ';letter-spacing:4px;margin-bottom:10px;">КОМАНДА ' + myTeam + '</div>' +
      '<div style="font-size:12px;color:#888;margin-bottom:4px;">Союзники: ' + allies + '</div>' +
      '<div style="font-size:12px;color:#888;">Враги: ' + enemies + '</div>' +
      '<div id="kb-countdown" style="font-size:48px;color:#FFD700;margin-top:14px;">3</div>';
    document.body.appendChild(banner);

    let count = 3;
    const tick = setInterval(function() {
      count--;
      const el = document.getElementById('kb-countdown');
      if (el) el.textContent = count > 0 ? count : '⚔️';
      if (count <= 0) {
        clearInterval(tick);
        setTimeout(function() {
          const b = document.getElementById('kb-team-banner');
          if (b) b.remove();
          if (typeof showSection === 'function') showSection('battle-royale');
          function autoClick() {
            const btn = document.getElementById('br-start-btn');
            if (btn && btn.offsetParent !== null) {
              btn.click();
            } else {
              setTimeout(autoClick, 300);
            }
          }
          setTimeout(autoClick, 500);
        }, 600);
      }
    }, 1000);
  }
};

// ================================================================
//  INJECT FRIENDS SECTION
// ================================================================
function injectFriendsSection() {
  if (document.getElementById('friends-section')) return;

  const friendsSection = document.createElement('div');
  friendsSection.id = 'friends-section';
  friendsSection.className = 'characters-section';
  friendsSection.style.cssText = 'display:none;position:fixed;inset:0;z-index:1000;flex-direction:column;background:rgba(0,10,0,0.98);';
  friendsSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px 8px;border-bottom:1px solid rgba(0,255,65,0.2);">
      <h2 style="font-family:'Share Tech Mono',monospace;font-size:18px;color:var(--matrix-green);letter-spacing:3px;">👥 ДРУЗЬЯ</h2>
      <button style="background:rgba(0,50,0,0.9);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:6px;padding:6px 12px;cursor:pointer;font-family:'Share Tech Mono',monospace;" onclick="showSection('main')">✕</button>
    </div>
    <div style="display:flex;border-bottom:1px solid rgba(0,255,65,0.15);">
      <button id="tab-friends-btn" onclick="FriendsUI._tab('friends')"
        style="flex:1;padding:10px;background:rgba(0,40,0,0.7);border:none;border-bottom:2px solid var(--matrix-green);color:var(--matrix-green);font-family:'Share Tech Mono',monospace;font-size:12px;cursor:pointer;">
        👥 ДРУЗЬЯ
      </button>
      <button id="tab-lobby-btn" onclick="FriendsUI._tab('lobby')"
        style="flex:1;padding:10px;background:rgba(0,15,0,0.5);border:none;border-bottom:2px solid transparent;color:#44bb44;font-family:'Share Tech Mono',monospace;font-size:12px;cursor:pointer;">
        🏠 ЛОББИ
      </button>
    </div>
    <div style="overflow-y:auto;flex:1;padding:14px;">
      <div id="friends-content"></div>
      <div id="lobby-content" style="display:none;"></div>
    </div>`;
  document.body.appendChild(friendsSection);

  const origShowSection = window.showSection;
  window.showSection = function(section, ...args) {
    const fs = document.getElementById('friends-section');
    if (section === 'friends') {
      document.querySelectorAll('.characters-section,.shop-section,.events-section,.trophy-road-section,.apple-pass-section').forEach(el => {
        el.classList.remove('active');
        if (el !== fs) el.style.display = '';
      });
      const mm = document.getElementById('main-menu');
      if (mm) mm.style.display = 'none';
      fs.style.display = 'flex';
      FriendsUI._activeTab = 'friends';
      FriendsUI.render();
      LobbyUI.render();
      return;
    } else {
      if (fs) fs.style.display = 'none';
    }
    if (origShowSection) origShowSection(section, ...args);
  };
}

// ================================================================
//  INIT
// ================================================================
async function initMultiplayer() {
  injectFriendsSection();

  let authAttempts = 0;

  async function tryConnect() {
    authAttempts++;
    const nick = AJ_SERVER.getNick();
    console.log('[MP] tryConnect attempt', authAttempts, 'nick:', nick);

    if (!nick) {
      if (authAttempts < 30) setTimeout(tryConnect, 1000);
      return;
    }

    try {
      const result = await AJ_SERVER.auth(nick);
      console.log('[MP] Auth OK:', result.playerId, result.nickname);
      localStorage.setItem('aj_nickname', result.nickname);
      AJ_SERVER.connect();

      setTimeout(() => {
        showIdInBar();
        if (typeof showNotification === 'function')
          showNotification('🆔 Ваш ID', AJ_SERVER.playerId, 'unlock');
        FriendsUI.render();
      }, 1000);
    } catch(e) {
      console.warn('[MP] Auth error:', e);
      if (authAttempts < 10) setTimeout(tryConnect, 3000);
    }
  }

  function showIdInBar() {
    const id = AJ_SERVER.playerId || localStorage.getItem('aj_player_id');
    if (!id) { setTimeout(showIdInBar, 2000); return; }
    const infoBar = document.querySelector('.player-info-bar');
    if (!infoBar) { setTimeout(showIdInBar, 1000); return; }
    // Удалить старый если есть
    const old = document.getElementById('aj-id-badge');
    if (old) old.remove();
    const badge = document.createElement('span');
    badge.id = 'aj-id-badge';
    badge.style.cssText = 'font-size:10px;color:#44bb44;cursor:pointer;border:1px solid rgba(0,255,65,0.3);border-radius:4px;padding:2px 7px;margin-left:6px;white-space:nowrap;letter-spacing:1px;';
    badge.textContent = id;
    badge.title = 'Нажми для копирования';
    badge.onclick = () => {
      navigator.clipboard.writeText(id).catch(()=>{});
      if (typeof showNotification === 'function')
        showNotification('📋 ID скопирован!', id, 'unlock');
    };
    infoBar.appendChild(badge);
  }

  // Хук на кнопку подтверждения ника
  function hookNickBtn() {
    const btn = document.getElementById('nickname-confirm-btn');
    if (!btn) { setTimeout(hookNickBtn, 300); return; }
    btn.addEventListener('click', () => {
      authAttempts = 0; // сброс счётчика
      setTimeout(tryConnect, 800);
    });
    console.log('[MP] Nick button hooked');
  }
  hookNickBtn();

  // Попробовать сразу если ник уже есть
  setTimeout(tryConnect, 1000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(initMultiplayer, 1500));
} else {
  setTimeout(initMultiplayer, 1500);
}

// ================================================================
//  BR MULTIPLAYER PATCH — реальный мультиплеер в КБ
//  Подключается к игровому циклу и синхронизирует позиции
// ================================================================
const BRMultiplayer = {
  active: false,
  roomId: null,
  myTeam: null,
  remotePlayers: {}, // playerId -> state
  remoteProjectiles: [], // снаряды от других игроков
  syncInterval: null,
  lastSent: 0,

  // Запустить когда сервер дал сигнал старта КБ
  init(msg) {
    this.active = true;
    this.roomId = msg.roomId || msg.lobbyId;
    this.myTeam = msg.teams[AJ_SERVER.playerId];
    this.remotePlayers = {};
    this.remoteProjectiles = [];

    // Инициализируем удалённых игроков
    msg.players.forEach(p => {
      if (p.id !== AJ_SERVER.playerId) {
        this.remotePlayers[p.id] = {
          id: p.id,
          nick: p.nickname,
          team: p.team,
          charIcon: p.charIcon || '🍎',
          x: 800, y: 600,
          hp: 1000, maxHp: 1000,
          alive: true,
          superCharge: 0,
          emojiId: null
        };
      }
    });

    // Отправляем состояние каждые 50мс
    this.syncInterval = setInterval(() => this.sendState(), 50);

    // Патчим игровой цикл
    this.patchGameLoop();

    console.log('[BRMulti] Инициализирован, комната:', this.roomId);
  },

  stop() {
    this.active = false;
    if (this.syncInterval) clearInterval(this.syncInterval);
    this.syncInterval = null;
    this.remotePlayers = {};
    this.remoteProjectiles = [];
  },

  // Отправить свою позицию на сервер
  sendState() {
    if (!this.active || !window.brGame) return;
    const player = window.brGame.fighters?.[0];
    if (!player) return;
    AJ_SERVER.send({
      type: 'GAME_STATE',
      x: Math.round(player.x),
      y: Math.round(player.y),
      hp: player.hp,
      maxHp: player.maxHp,
      alive: player.alive,
      charIcon: player.charIcon,
      superCharge: window.brGame.superCharge || 0,
      emojiId: player.emojiId || null
    });
  },

  // Когда стреляем — отправить снаряд на сервер
  sendProjectile(owner, angle, atk) {
    if (!this.active) return;
    AJ_SERVER.send({
      type: 'GAME_PROJECTILE',
      proj: {
        x: Math.round(owner.x),
        y: Math.round(owner.y),
        angle,
        atkShape: atk.shape,
        atkColor: atk.color,
        atkR: atk.r,
        atkW: atk.w,
        atkH: atk.h,
        atkLen: atk.len,
        atkThick: atk.thick,
        atkSpd: atk.spd,
        dmgMin: atk.dmgMin,
        dmgMax: atk.dmgMax,
        atkEmoji: atk.emoji,
        ownerId: AJ_SERVER.playerId
      }
    });
  },

  // Когда попадаем в удалённого игрока — отправить хит
  sendHit(targetId, damage) {
    if (!this.active) return;
    AJ_SERVER.send({ type: 'GAME_HIT', targetId, damage });
  },

  // Обновить состояние удалённого игрока
  onRoomState(msg) {
    Object.entries(msg.states).forEach(([pid, state]) => {
      if (pid === AJ_SERVER.playerId) return;
      if (this.remotePlayers[pid]) {
        Object.assign(this.remotePlayers[pid], state);
      }
    });
  },

  // Получить входящий снаряд от другого игрока
  onRemoteProjectile(msg) {
    const proj = msg.proj;
    if (!proj || !window.brGame) return;
    const now = performance.now();
    // Конвертируем в формат локального снаряда
    const localProj = {
      x: proj.x, y: proj.y,
      angle: proj.angle,
      vx: proj.atkSpd ? Math.cos(proj.angle) * proj.atkSpd : 0,
      vy: proj.atkSpd ? Math.sin(proj.angle) * proj.atkSpd : 0,
      atk: {
        shape: proj.atkShape || 'circle',
        color: proj.atkColor || '#ff4444',
        r: proj.atkR || 9,
        w: proj.atkW, h: proj.atkH,
        len: proj.atkLen, thick: proj.atkThick,
        spd: proj.atkSpd || 6,
        dmgMin: proj.dmgMin || 30,
        dmgMax: proj.dmgMax || 55,
        emoji: proj.atkEmoji || '🍎'
      },
      owner: { id: proj.ownerId, isPlayer: false, isTeamer: false, critChance: 0.1, dmgMultiplier: 1,
               nick: proj.ownerNick || '???', isRemote: true },
      born: now,
      life: 2000,
      hit: new Set(),
      isRemote: true,
      remoteOwnerId: proj.ownerId
    };

    if (window.brGame.projectiles) {
      window.brGame.projectiles.push(localProj);
    }
  },

  // Нас убили удалённым игроком
  onRemoteKilled(msg) {
    if (!window.brGame) return;
    const player = window.brGame.fighters?.[0];
    if (player && player.alive) {
      player.hp = 0;
      player.alive = false;
      if (typeof showNotification === 'function')
        showNotification('💀 ВЫ ПОГИБЛИ', `Убит: ${msg.byNick}`, 'trophies');
    }
  },

  // Получили урон от удалённого игрока
  onRemoteDamage(msg) {
    if (!window.brGame) return;
    const player = window.brGame.fighters?.[0];
    if (player && player.alive) {
      player.hp = Math.max(0, msg.newHp);
      if (player.hp <= 0) player.alive = false;
    }
  },

  // Патч игрового цикла — добавляем рендер удалённых игроков
  patchGameLoop() {
    // Ждём пока brGame инициализируется
    const waitForGame = setInterval(() => {
      if (!window.brGame || !window.brGame.ctx) return;
      clearInterval(waitForGame);

      // Патчим spawnProjectile чтобы отправлять снаряды на сервер
      const origSpawn = window.spawnProjectile;
      if (origSpawn) {
        window.spawnProjectile = (owner, angle, atk) => {
          origSpawn(owner, angle, atk);
          // Если это игрок — отправляем на сервер
          if (owner.isPlayer && BRMultiplayer.active) {
            BRMultiplayer.sendProjectile(owner, angle, atk);
          }
        };
      }

      // Патчим applyBRDamage чтобы проверять удалённых игроков
      const origDamage = window.applyBRDamage;
      if (origDamage) {
        window.applyBRDamage = (attacker, target, damage) => {
          // Если цель — удалённый игрок
          if (target.isRemote && target.id && BRMultiplayer.active) {
            BRMultiplayer.sendHit(target.id, damage);
            return;
          }
          origDamage(attacker, target, damage);
        };
      }

      // Инжектируем удалённых игроков в fighters для рендера
      this.injectRemoteFighters();

      console.log('[BRMulti] Игровой цикл пропатчен');
    }, 200);
  },

  // Добавляем удалённых игроков в массив fighters
  injectRemoteFighters() {
    const waitForFighters = setInterval(() => {
      if (!window.brGame || !window.brGame.fighters) return;
      clearInterval(waitForFighters);

      Object.values(this.remotePlayers).forEach(rp => {
        // Проверяем не добавлен ли уже
        if (window.brGame.fighters.find(f => f.remoteId === rp.id)) return;

        const remoteFighter = {
          id: 100 + window.brGame.fighters.length,
          remoteId: rp.id,
          isPlayer: false,
          isRemote: true,
          nick: rp.nick,
          charIcon: rp.charIcon || '🍎',
          x: rp.x || 800, y: rp.y || 600,
          hp: rp.hp || 1000, maxHp: rp.maxHp || 1000,
          alive: true,
          team: rp.team,
          isFriend: true,
          isTeamer: rp.team === this.myTeam, // союзники не атакуют друг друга
          teamerTarget: null,
          radius: 20,
          atk: { shape:'circle', color:'#00ff41', r:9, spd:6, dmgMin:30, dmgMax:55, cd:700, emoji:'🍎' },
          lastAtk: 0, stunUntil: 0,
          aggression: 0.8, dodgeChance: 0.1, critChance: 0.15,
          dmgMultiplier: 1, powerCubes: 0,
          inBush: false, bushTimer: 0,
          emojiId: null, emojiTimer: 0,
          targetId: -1, aiTimer: 0,
          wanderAngle: Math.random() * Math.PI * 2,
          // Флаг что это управляется сервером а не ИИ
          noAI: true,
          remoteRef: rp
        };

        window.brGame.fighters.push(remoteFighter);
        console.log('[BRMulti] Добавлен удалённый игрок:', rp.nick);
      });

      // Каждый кадр обновляем позиции удалённых fighters из remoteRef
      this.startRemoteSync();
    }, 300);
  },

  // Синхронизируем позиции удалённых fighters каждый кадр
  startRemoteSync() {
    const sync = () => {
      if (!this.active) return;
      if (window.brGame && window.brGame.fighters) {
        window.brGame.fighters.forEach(f => {
          if (!f.isRemote || !f.remoteRef) return;
          const rp = f.remoteRef;
          // Плавное движение к реальной позиции
          f.x += (rp.x - f.x) * 0.3;
          f.y += (rp.y - f.y) * 0.3;
          f.hp = rp.hp;
          f.maxHp = rp.maxHp;
          f.alive = rp.alive;
          f.emojiId = rp.emojiId;
        });
      }
      requestAnimationFrame(sync);
    };
    requestAnimationFrame(sync);
  }
};

// Обработка сообщений от сервера для BRMultiplayer
const _origHandle = AJ_SERVER._handle.bind(AJ_SERVER);
AJ_SERVER._handle = function(msg) {
  switch(msg.type) {
    case 'ROOM_STATE':
      BRMultiplayer.onRoomState(msg);
      break;
    case 'REMOTE_PROJECTILE':
      BRMultiplayer.onRemoteProjectile(msg);
      break;
    case 'REMOTE_KILLED':
      BRMultiplayer.onRemoteKilled(msg);
      break;
    case 'REMOTE_DAMAGE':
      BRMultiplayer.onRemoteDamage(msg);
      break;
    case 'REMOTE_PLAYER_DIED': {
      if (window.brGame && window.brGame.fighters) {
        const f = window.brGame.fighters.find(x => x.remoteId === msg.playerId);
        if (f) { f.alive = false; f.hp = 0; }
      }
      if (typeof showNotification === 'function' && msg.playerId !== AJ_SERVER.playerId)
        showNotification('💀 ' + msg.nick, `Убит: ${msg.killerNick||'???'}`, 'trophies');
      break;
    }
    case 'LOBBY_KB_START':
      // Инициализируем мультиплеер
      BRMultiplayer.init(msg);
      LobbyUI.startKB(msg);
      break;
    default:
      _origHandle(msg);
  }
};

// Остановить мультиплеер когда выходим из КБ
const _origExitBR = window.exitBR;
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => {
    setTimeout(() => {
      const origExit = window.exitBR;
      if (origExit) {
        window.exitBR = function() {
          BRMultiplayer.stop();
          origExit();
        };
      }
    }, 2000);
  });
}
