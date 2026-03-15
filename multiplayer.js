// ================================================================
//  APPLE JOURNEY — FRIENDS & LOBBY MODULE
//  Вставить в конец <body> игры (перед </body>)
//  Настройка: поменяй SERVER_URL на свой адрес Oracle Cloud
// ================================================================

const AJ_SERVER = {
  // ⚙️ ПОМЕНЯЙ НА СВОЙ IP когда задеплоишь на Oracle Cloud
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

  // ---------- AUTH ----------
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
    return data;
  },

  // ---------- WS CONNECT ----------
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
      this.emit('disconnected', {});
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = () => {
      this.ws.close();
    };
  },

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ ...msg, playerId: this.playerId }));
    }
  },

  // ---------- MESSAGE HANDLER ----------
  _handle(msg) {
    switch (msg.type) {

      case 'CONNECTED':
        this.emit('connected', msg);
        this.send({ type: 'LOBBY_GET' });
        this.loadFriends();
        break;

      case 'ERROR':
        showNotification('❌ Ошибка', msg.text, 'trophies');
        break;

      case 'FRIEND_ONLINE':
        this._updateFriendStatus(msg.friendId, true);
        showNotification('🟢 Онлайн', `${msg.nickname} вошёл в игру`, 'unlock');
        FriendsUI.render();
        break;

      case 'FRIEND_OFFLINE':
        this._updateFriendStatus(msg.friendId, false);
        FriendsUI.render();
        break;

      case 'FRIEND_REQUEST_IN':
        if (!this.friendRequests.find(r => r.id === msg.fromId)) {
          this.friendRequests.push({ id: msg.fromId, nickname: msg.fromNick });
        }
        showNotification('👥 Заявка в друзья', `${msg.fromNick} хочет добавить вас`, 'unlock');
        FriendsUI.render();
        break;

      case 'FRIEND_REQUESTS':
        this.friendRequests = msg.requests;
        FriendsUI.render();
        break;

      case 'FRIEND_REQUEST_SENT':
        showNotification('✅ Заявка отправлена', `Запрос отправлен: ${msg.targetNick}`, 'unlock');
        break;

      case 'FRIEND_ADDED':
        if (!this.friends.find(f => f.id === msg.friend.id)) {
          this.friends.push(msg.friend);
        }
        this.friendRequests = this.friendRequests.filter(r => r.id !== msg.friend.id);
        showNotification('🎉 Новый друг!', `${msg.friend.nickname} теперь ваш друг`, 'unlock');
        FriendsUI.render();
        break;

      case 'FRIEND_DECLINED':
        this.friendRequests = this.friendRequests.filter(r => r.id !== msg.fromId);
        FriendsUI.render();
        break;

      case 'LOBBY_CREATED':
        this.currentLobby = msg.lobby;
        LobbyUI.render();
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
        showNotification('📨 Приглашение отправлено', `${msg.friendNick} получил приглашение`, 'unlock');
        break;

      case 'LOBBY_INVITE_DECLINED':
        showNotification('❌ Отклонено', `${msg.byNick} отклонил приглашение`, 'trophies');
        break;

      case 'LOBBY_KB_START':
        this.currentLobby.status = 'kb';
        LobbyUI.startKB(msg);
        break;

      case 'LOBBY_CHAT_MSG':
        LobbyUI.addChat(msg);
        break;
    }
  },

  _updateFriendStatus(friendId, online) {
    const f = this.friends.find(x => x.id === friendId);
    if (f) f.online = online;
  },

  // ---------- API CALLS ----------
  async loadFriends() {
    if (!this.playerId) return;
    try {
      const res = await fetch(`${this.HTTP}/api/friends/${this.playerId}`);
      const data = await res.json();
      this.friends = data.friends || [];
      this.friendRequests = data.incoming || [];
      FriendsUI.render();
    } catch(e) {}
  },

  sendFriendRequest(targetId) {
    this.send({ type: 'FRIEND_REQUEST', targetId });
  },

  acceptFriend(fromId) {
    this.send({ type: 'FRIEND_ACCEPT', fromId });
  },

  declineFriend(fromId) {
    this.send({ type: 'FRIEND_DECLINE', fromId });
  },

  createLobby() {
    this.send({ type: 'LOBBY_CREATE' });
  },

  inviteToLobby(friendId) {
    this.send({ type: 'LOBBY_INVITE', friendId });
  },

  joinLobby(lobbyId) {
    this.send({ type: 'LOBBY_JOIN', lobbyId });
  },

  leaveLobby() {
    this.send({ type: 'LOBBY_LEAVE' });
    this.currentLobby = null;
    LobbyUI.render();
  },

  startKB() {
    this.send({ type: 'LOBBY_START_KB' });
  },

  sendChat(text) {
    this.send({ type: 'LOBBY_CHAT', text });
  },

  reportKBResult(won) {
    this.send({ type: 'KB_RESULT', won });
  }
};

// ================================================================
//  FRIENDS UI
// ================================================================
const FriendsUI = {
  render() {
    const container = document.getElementById('friends-content');
    if (!container) return;

    const friends = AJ_SERVER.friends;
    const requests = AJ_SERVER.friendRequests;

    container.innerHTML = `
      <!-- Мой ID -->
      <div style="background:rgba(0,40,0,0.7);border:1px solid var(--matrix-green);border-radius:10px;padding:12px 16px;margin-bottom:14px;">
        <div style="font-size:11px;color:#44bb44;letter-spacing:1px;margin-bottom:4px;">МОЙ ID</div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:18px;color:var(--matrix-green);letter-spacing:2px;font-weight:bold;">${AJ_SERVER.playerId || '—'}</span>
          <button onclick="FriendsUI.copyId()" style="background:rgba(0,60,0,0.8);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:'Share Tech Mono',monospace;">📋 КОПИРОВАТЬ</button>
        </div>
        <div style="font-size:10px;color:#44bb44;margin-top:4px;">Дай этот ID другу, чтобы он добавил тебя</div>
      </div>

      <!-- Добавить друга -->
      <div style="background:rgba(0,20,0,0.7);border:1px solid rgba(0,255,65,0.3);border-radius:10px;padding:12px;margin-bottom:14px;">
        <div style="font-size:11px;color:#44bb44;letter-spacing:1px;margin-bottom:8px;">ДОБАВИТЬ ДРУГА ПО ID</div>
        <div style="display:flex;gap:8px;">
          <input id="friend-id-input" type="text" placeholder="AJ-XXXX-XXXX" maxlength="12"
            style="flex:1;background:rgba(0,30,0,0.8);border:1px solid var(--matrix-green);border-radius:6px;color:var(--matrix-green);font-family:'Share Tech Mono',monospace;font-size:13px;padding:6px 10px;outline:none;letter-spacing:1px;"
            oninput="this.value=this.value.toUpperCase()"
          />
          <button onclick="FriendsUI.sendRequest()" style="background:linear-gradient(45deg,#001a00,#003300);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:'Share Tech Mono',monospace;white-space:nowrap;">➕ ДОБАВИТЬ</button>
        </div>
      </div>

      <!-- Входящие заявки -->
      ${requests.length > 0 ? `
      <div style="margin-bottom:14px;">
        <div style="font-size:11px;color:#FFD700;letter-spacing:1px;margin-bottom:6px;">ВХОДЯЩИЕ ЗАЯВКИ (${requests.length})</div>
        ${requests.map(r => `
          <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(20,15,0,0.8);border:1px solid rgba(255,215,0,0.3);border-radius:8px;padding:8px 12px;margin-bottom:6px;">
            <span style="color:#FFD700;font-size:13px;">${r.nickname}</span>
            <div style="display:flex;gap:6px;">
              <button onclick="AJ_SERVER.acceptFriend('${r.id}')" style="background:rgba(0,60,0,0.8);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer;">✔ ПРИНЯТЬ</button>
              <button onclick="AJ_SERVER.declineFriend('${r.id}')" style="background:rgba(40,0,0,0.8);border:1px solid rgba(255,60,60,0.5);color:#ff6666;border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer;">✖</button>
            </div>
          </div>
        `).join('')}
      </div>` : ''}

      <!-- Список друзей -->
      <div style="font-size:11px;color:#44bb44;letter-spacing:1px;margin-bottom:8px;">ДРУЗЬЯ (${friends.length})</div>
      ${friends.length === 0
        ? `<div style="text-align:center;color:rgba(0,255,65,0.3);padding:24px;font-size:13px;">Нет друзей. Добавь по ID!</div>`
        : friends.map(f => `
          <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(0,15,0,0.8);border:1px solid rgba(0,255,65,0.2);border-radius:8px;padding:10px 12px;margin-bottom:6px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="width:8px;height:8px;border-radius:50%;background:${f.online?'#00ff41':'#333'};flex-shrink:0;box-shadow:${f.online?'0 0 6px #00ff41':'none'};"></span>
              <div>
                <div style="color:var(--matrix-green);font-size:13px;">${f.nickname}</div>
                <div style="color:#44bb44;font-size:10px;">${f.online?'🟢 В сети':'⚫ Не в сети'}</div>
              </div>
            </div>
            <div style="display:flex;gap:6px;">
              ${f.online && AJ_SERVER.currentLobby && AJ_SERVER.currentLobby.host === AJ_SERVER.playerId
                ? `<button onclick="AJ_SERVER.inviteToLobby('${f.id}')" style="background:rgba(0,40,0,0.8);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer;">📨 ПРИГЛАСИТЬ</button>`
                : ''}
            </div>
          </div>
        `).join('')}
    `;
  },

  copyId() {
    navigator.clipboard.writeText(AJ_SERVER.playerId || '').then(() => {
      showNotification('📋 Скопировано!', `ID: ${AJ_SERVER.playerId}`, 'unlock');
    });
  },

  sendRequest() {
    const input = document.getElementById('friend-id-input');
    if (!input) return;
    const id = input.value.trim().toUpperCase();
    if (!id.match(/^AJ-[A-Z0-9]{4}-[A-Z0-9]{4}$/)) {
      showNotification('❌ Неверный формат', 'ID должен быть в формате AJ-XXXX-XXXX', 'trophies');
      return;
    }
    AJ_SERVER.sendFriendRequest(id);
    input.value = '';
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
        </div>
      `;
      return;
    }

    const isHost = lobby.host === AJ_SERVER.playerId;
    const players = lobby.players || [];
    const names = lobby.playerNames || {};
    const canStart = isHost && players.length >= 1;

    container.innerHTML = `
      <!-- Лобби хедер -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div>
          <div style="font-size:11px;color:#44bb44;letter-spacing:1px;">ЛОББИ</div>
          <div style="font-size:16px;color:var(--matrix-green);letter-spacing:2px;">${lobby.id} ${isHost?'👑':''}</div>
        </div>
        <button onclick="AJ_SERVER.leaveLobby()" style="background:rgba(40,0,0,0.7);border:1px solid rgba(255,60,60,0.5);color:#ff6666;border-radius:6px;padding:6px 12px;font-size:11px;cursor:pointer;font-family:'Share Tech Mono',monospace;">
          🚪 ВЫЙТИ
        </button>
      </div>

      <!-- Слоты игроков -->
      <div style="margin-bottom:14px;">
        <div style="font-size:11px;color:#44bb44;margin-bottom:6px;">ИГРОКИ (${players.length}/4)</div>
        ${[0,1,2,3].map(i => {
          const pid = players[i];
          if (pid) {
            const nick = names[pid] || '???';
            const isMe = pid === AJ_SERVER.playerId;
            const isLobbyHost = pid === lobby.host;
            return `
              <div style="display:flex;align-items:center;gap:8px;background:rgba(0,20,0,0.8);border:1px solid rgba(0,255,65,0.3);border-radius:8px;padding:8px 12px;margin-bottom:4px;">
                <span style="color:var(--matrix-green);font-size:14px;">${isLobbyHost?'👑':''} ${nick} ${isMe?'(ты)':''}</span>
              </div>`;
          } else {
            return `<div style="background:rgba(0,10,0,0.5);border:1px dashed rgba(0,255,65,0.15);border-radius:8px;padding:8px 12px;margin-bottom:4px;color:rgba(0,255,65,0.25);font-size:12px;">— слот ${i+1} свободен</div>`;
          }
        }).join('')}
      </div>

      <!-- Пригласить друга -->
      ${isHost && AJ_SERVER.friends.filter(f=>f.online).length > 0 ? `
      <div style="margin-bottom:14px;">
        <div style="font-size:11px;color:#44bb44;margin-bottom:6px;">ПРИГЛАСИТЬ ДРУГА</div>
        ${AJ_SERVER.friends.filter(f=>f.online).map(f=>`
          <button onclick="AJ_SERVER.inviteToLobby('${f.id}')" style="background:rgba(0,30,0,0.8);border:1px solid rgba(0,255,65,0.4);color:var(--matrix-green);border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:'Share Tech Mono',monospace;margin-bottom:4px;width:100%;text-align:left;">
            📨 ${f.nickname}
          </button>
        `).join('')}
      </div>` : ''}

      <!-- КБ Кнопка -->
      ${lobby.status === 'waiting' ? `
      <button onclick="${canStart ? 'AJ_SERVER.startKB()' : ''}"
        style="width:100%;padding:14px;background:${canStart?'linear-gradient(45deg,#001a00,#00ff41)':'rgba(0,20,0,0.5)'};border:2px solid ${canStart?'var(--matrix-green)':'rgba(0,255,65,0.2)'};color:${canStart?'#000':'rgba(0,255,65,0.3)'};border-radius:10px;font-family:'Share Tech Mono',monospace;font-size:14px;font-weight:bold;letter-spacing:2px;cursor:${canStart?'pointer':'not-allowed'};margin-bottom:12px;">
        ⚔️ НАЧАТЬ КБ ${!isHost?'(только хост)':''}
      </button>` : `
      <div style="text-align:center;color:#FFD700;font-size:13px;padding:8px;border:1px solid rgba(255,215,0,0.3);border-radius:8px;margin-bottom:12px;">⚔️ КБ МАТЧ ИДЁТ...</div>
      `}

      <!-- Чат лобби -->
      <div style="border:1px solid rgba(0,255,65,0.2);border-radius:8px;overflow:hidden;">
        <div id="lobby-chat-msgs" style="height:80px;overflow-y:auto;padding:6px 10px;font-size:11px;color:#44bb44;">
          ${this.chatMessages.slice(-20).map(m=>`<div><span style="color:var(--matrix-green);">${m.fromNick}:</span> ${m.text}</div>`).join('')}
        </div>
        <div style="display:flex;border-top:1px solid rgba(0,255,65,0.15);">
          <input id="lobby-chat-input" type="text" placeholder="Сообщение..." maxlength="100"
            style="flex:1;background:rgba(0,10,0,0.8);border:none;color:var(--matrix-green);font-family:'Share Tech Mono',monospace;font-size:12px;padding:6px 10px;outline:none;"
            onkeypress="if(event.key==='Enter'){LobbyUI.sendChat();}"
          />
          <button onclick="LobbyUI.sendChat()" style="background:rgba(0,40,0,0.8);border:none;color:var(--matrix-green);padding:6px 12px;cursor:pointer;font-size:12px;">➤</button>
        </div>
      </div>
    `;

    // Скролл чата вниз
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
    this.render();
  },

  showInvite(msg) {
    // Создаём попап приглашения
    const existing = document.getElementById('lobby-invite-popup');
    if (existing) existing.remove();

    const popup = document.createElement('div');
    popup.id = 'lobby-invite-popup';
    popup.style.cssText = `
      position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
      background:rgba(0,20,0,0.97);border:2px solid var(--matrix-green);
      border-radius:14px;padding:16px 20px;z-index:9999;
      box-shadow:0 0 30px rgba(0,255,65,0.4);min-width:280px;
      font-family:'Share Tech Mono',monospace;
      animation:modalSlideIn 0.3s cubic-bezier(0.22,1,0.36,1);
    `;
    popup.innerHTML = `
      <div style="color:var(--matrix-green);font-size:14px;margin-bottom:4px;">📨 ПРИГЛАШЕНИЕ В ЛОББИ</div>
      <div style="color:#44bb44;font-size:12px;margin-bottom:12px;">${msg.hostNick} приглашает тебя в КБ</div>
      <div style="display:flex;gap:8px;">
        <button onclick="AJ_SERVER.joinLobby('${msg.lobbyId}');document.getElementById('lobby-invite-popup')?.remove();"
          style="flex:1;background:linear-gradient(45deg,#001a00,#003300);border:1px solid var(--matrix-green);color:var(--matrix-green);border-radius:8px;padding:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:12px;">
          ✔ ПРИНЯТЬ
        </button>
        <button onclick="AJ_SERVER.send({type:'LOBBY_DECLINE',lobbyId:'${msg.lobbyId}'});document.getElementById('lobby-invite-popup')?.remove();"
          style="flex:1;background:rgba(40,0,0,0.7);border:1px solid rgba(255,60,60,0.4);color:#ff6666;border-radius:8px;padding:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:12px;">
          ✖ ОТКЛОНИТЬ
        </button>
      </div>
    `;
    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), 30000); // авто-закрытие через 30 сек
  },

  startKB(msg) {
    // Запускаем КБ режим с данными матча
    const myTeam = msg.teams[AJ_SERVER.playerId];
    const friendsInMatch = msg.players.filter(p => p.id !== AJ_SERVER.playerId);

    showNotification(
      `⚔️ КБ НАЧАЛСЯ! Команда ${myTeam}`,
      `Против: ${friendsInMatch.map(p=>p.nickname).join(', ')||'боты'}`,
      'unlock'
    );

    // Сохраняем данные матча для КБ режима
    window._kbLobbyMatch = msg;

    // Переходим в КБ
    showSection('battle-royale');

    // Дополнительно показываем баннер команды
    setTimeout(() => {
      const banner = document.createElement('div');
      banner.style.cssText = `
        position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
        background:rgba(0,0,0,0.95);border:3px solid ${myTeam==='A'?'#00ff41':'#ff4444'};
        border-radius:18px;padding:24px 36px;z-index:99999;text-align:center;
        font-family:'Share Tech Mono',monospace;
        animation:modalSlideIn 0.4s cubic-bezier(0.22,1,0.36,1);
      `;
      banner.innerHTML = `
        <div style="font-size:28px;color:${myTeam==='A'?'var(--matrix-green)':'#ff4444'};letter-spacing:4px;margin-bottom:8px;">КОМАНДА ${myTeam}</div>
        <div style="font-size:13px;color:#888;margin-bottom:4px;">Союзники: ${msg.players.filter(p=>msg.teams[p.id]===myTeam&&p.id!==AJ_SERVER.playerId).map(p=>p.nickname).join(', ')||'только ты'}</div>
        <div style="font-size:13px;color:#888;">Враги: ${msg.players.filter(p=>msg.teams[p.id]!==myTeam).map(p=>p.nickname).join(', ')||'боты'}</div>
      `;
      document.body.appendChild(banner);
      setTimeout(() => banner.remove(), 3000);
    }, 300);
  }
};

// ================================================================
//  FRIENDS SECTION — DOM INJECTION
// ================================================================
function injectFriendsSection() {
  // Добавляем вкладку "Друзья" в навигацию
  const navBtns = document.querySelector('.nav-buttons') ||
                  document.querySelector('.bottom-nav') ||
                  document.querySelector('[class*="nav"]');

  // Ищем существующую кнопку-навигацию по атрибутам onclick
  const existingBtns = document.querySelectorAll('button[onclick*="showSection"]');
  let navContainer = existingBtns.length > 0 ? existingBtns[0].parentElement : null;

  if (navContainer) {
    const friendsBtn = document.createElement('button');
    friendsBtn.id = 'friends-nav-btn';
    friendsBtn.className = existingBtns[0]?.className || 'menu-btn';
    friendsBtn.setAttribute('onclick', "showSection('friends')");
    friendsBtn.innerHTML = '👥 ДРУЗЬЯ';
    navContainer.appendChild(friendsBtn);
  }

  // Создаём секцию друзей
  const friendsSection = document.createElement('div');
  friendsSection.id = 'friends-section';
  friendsSection.className = 'characters-section'; // используем те же стили
  friendsSection.style.cssText = 'display:none;';
  friendsSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px 8px;border-bottom:1px solid rgba(0,255,65,0.2);">
      <h2 style="font-family:'Share Tech Mono',monospace;font-size:18px;color:var(--matrix-green);letter-spacing:3px;">👥 ДРУЗЬЯ</h2>
      <button class="close-section-btn" onclick="showSection('main')">✕</button>
    </div>

    <!-- Tabs: Друзья / Лобби -->
    <div style="display:flex;gap:0;border-bottom:1px solid rgba(0,255,65,0.15);">
      <button id="tab-friends-btn" onclick="FriendsUI._tab('friends')"
        style="flex:1;padding:10px;background:rgba(0,40,0,0.7);border:none;border-bottom:2px solid var(--matrix-green);color:var(--matrix-green);font-family:'Share Tech Mono',monospace;font-size:12px;cursor:pointer;letter-spacing:1px;">
        👥 СПИСОК ДРУЗЕЙ
      </button>
      <button id="tab-lobby-btn" onclick="FriendsUI._tab('lobby')"
        style="flex:1;padding:10px;background:rgba(0,15,0,0.5);border:none;border-bottom:2px solid transparent;color:#44bb44;font-family:'Share Tech Mono',monospace;font-size:12px;cursor:pointer;letter-spacing:1px;">
        🏠 ЛОББИ
      </button>
    </div>

    <div style="overflow-y:auto;height:calc(100% - 100px);padding:14px;">
      <div id="friends-content"></div>
      <div id="lobby-content" style="display:none;"></div>
    </div>
  `;
  document.body.appendChild(friendsSection);

  // Tab switcher
  FriendsUI._tab = function(tab) {
    document.getElementById('friends-content').style.display = tab === 'friends' ? 'block' : 'none';
    document.getElementById('lobby-content').style.display = tab === 'lobby' ? 'block' : 'none';
    document.getElementById('tab-friends-btn').style.borderBottomColor = tab === 'friends' ? 'var(--matrix-green)' : 'transparent';
    document.getElementById('tab-friends-btn').style.background = tab === 'friends' ? 'rgba(0,40,0,0.7)' : 'rgba(0,15,0,0.5)';
    document.getElementById('tab-friends-btn').style.color = tab === 'friends' ? 'var(--matrix-green)' : '#44bb44';
    document.getElementById('tab-lobby-btn').style.borderBottomColor = tab === 'lobby' ? 'var(--matrix-green)' : 'transparent';
    document.getElementById('tab-lobby-btn').style.background = tab === 'lobby' ? 'rgba(0,40,0,0.7)' : 'rgba(0,15,0,0.5)';
    document.getElementById('tab-lobby-btn').style.color = tab === 'lobby' ? 'var(--matrix-green)' : '#44bb44';
    if (tab === 'lobby') LobbyUI.render();
    if (tab === 'friends') FriendsUI.render();
  };

  // Расширяем showSection для секции friends
  const _origShowSection = window.showSection;
  window.showSection = function(section, ...args) {
    const friendsSec = document.getElementById('friends-section');
    if (friendsSec) {
      if (section === 'friends') {
        // Скрываем всё, показываем friends
        document.querySelectorAll('.characters-section,.shop-section,.events-section,.trophy-road-section,.apple-pass-section,[id$="-section"]').forEach(el => {
          if (el !== friendsSec) el.classList.remove('active'), el.style.display = '';
        });
        const mainMenu = document.getElementById('main-menu');
        if (mainMenu) mainMenu.style.display = 'none';
        friendsSec.classList.add('active');
        friendsSec.style.display = 'flex';
        friendsSec.style.flexDirection = 'column';
        FriendsUI.render();
        LobbyUI.render();
        return;
      } else {
        friendsSec.classList.remove('active');
        friendsSec.style.display = 'none';
      }
    }
    if (_origShowSection) _origShowSection(section, ...args);
  };
}

// ================================================================
//  INIT — запускается после загрузки игры
// ================================================================
async function initMultiplayer() {
  // Восстановить сессию если был игрок
  const savedId   = localStorage.getItem('aj_player_id');
  const savedToken = localStorage.getItem('aj_device_token');

  if (savedId && savedToken && window.gameData?.playerNickname) {
    try {
      await AJ_SERVER.auth(window.gameData.playerNickname || 'Игрок');
      AJ_SERVER.connect();
    } catch(e) {
      console.warn('Мультиплеер: не удалось подключиться к серверу', e);
    }
  }

  injectFriendsSection();

  // Хук: когда игрок вводит никнейм — регистрируем на сервере
  const origNickConfirm = document.getElementById('nickname-confirm-btn');
  if (origNickConfirm) {
    origNickConfirm.addEventListener('click', async () => {
      setTimeout(async () => {
        const nick = window.gameData?.playerNickname;
        if (nick && !AJ_SERVER.playerId) {
          try {
            await AJ_SERVER.auth(nick);
            AJ_SERVER.connect();
            // Показываем ID игроку
            setTimeout(() => {
              showNotification('🆔 Ваш ID', `${AJ_SERVER.playerId} (нажмите для копирования)`, 'unlock');
            }, 500);
          } catch(e) {}
        }
      }, 800);
    }, { once: true });
  }

  // Показать ID в инфо-баре если уже есть
  if (savedId) {
    setTimeout(() => {
      const infoBar = document.querySelector('.player-info-bar');
      if (infoBar) {
        const idBadge = document.createElement('span');
        idBadge.style.cssText = 'font-size:10px;color:#44bb44;cursor:pointer;border:1px solid rgba(0,255,65,0.3);border-radius:4px;padding:1px 5px;';
        idBadge.title = 'Нажмите для копирования ID';
        idBadge.textContent = savedId;
        idBadge.onclick = () => {
          navigator.clipboard.writeText(savedId);
          showNotification('📋 Скопировано!', savedId, 'unlock');
        };
        infoBar.appendChild(idBadge);
      }
    }, 1000);
  }
}

// Запуск
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(initMultiplayer, 1500));
} else {
  setTimeout(initMultiplayer, 1500);
}
