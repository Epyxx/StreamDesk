function connectWebSocket() {
    const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
    STATE.ws = new WebSocket(wsUrl);
    STATE.ws.onopen = () => {
        STATE.connected = true;
        STATE.reconnectAttempts = 0;
        dom.statusIndicator.className = 'online';
        clientLog('WS', 'Verbunden');
        const auth = loadJSON(LS_KEYS.AUTH);
        if (auth && auth.token) sendToServer({ type: 'login_oauth', token: auth.token });
    };
    STATE.ws.onclose = () => {
        STATE.connected = false; STATE.loggedIn = false;
        dom.statusIndicator.className = 'offline'; dom.loginScreen.style.display = 'flex'; dom.app.style.display = 'none';
        dom.chatInput.disabled = true; dom.btnSend.disabled = true;
        clientWarn('WS', 'Verbindung getrennt');
        saveAllData(); // Speichern bei Verbindungsabbruch
        stopSaveInterval();
        scheduleReconnect();
    };
    STATE.ws.onmessage = event => { try { handleServerMessage(JSON.parse(event.data)); } catch(e) { clientError('WS', `Nachricht konnte nicht verarbeitet werden: ${e.message}`); } };
}
function scheduleReconnect() {
    STATE.reconnectAttempts = (STATE.reconnectAttempts || 0) + 1;
    const delay = Math.min(30000, 1000 * Math.pow(2, STATE.reconnectAttempts - 1));
    clientLog('WS', `Reconnect-Versuch ${STATE.reconnectAttempts} in ${Math.round(delay/1000)}s`);
    setTimeout(connectWebSocket, delay);
}
function sendToServer(data) { if (STATE.ws?.readyState === WebSocket.OPEN) STATE.ws.send(JSON.stringify(data)); }

// Regelmäßiges Speichern alle 30 Sekunden
function startSaveInterval() {
    if (STATE.saveInterval) return;
    STATE.saveInterval = setInterval(saveAllData, 30000);
}
function stopSaveInterval() {
    if (STATE.saveInterval) { clearInterval(STATE.saveInterval); STATE.saveInterval = null; }
}
function saveAllData() {
    // Speichere aktuelle User-Liste, Events, Nachrichten pro Channel
    for (const ch of STATE.channels.map(c => c.name)) {
        if (STATE.userLists[ch]) saveJSON(LS_KEYS.USERLIST(ch), STATE.userLists[ch]);
        if (STATE.channelEvents[ch]) saveJSON(LS_KEYS.EVENTS(ch), STATE.channelEvents[ch]);
        // Nachrichten werden schon einzeln beim Empfang gespeichert, aber wir speichern die aktuellen DIV-Inhalte nicht.
        // Stattdessen speichern wir die bereits im Cache liegenden Arrays (werden bei appendChatMessage aktualisiert).
    }
    saveChannelList();
    saveFilters();
    updateStorageInfo();
}

// ========== SPEICHER-ÜBERSICHT ==========
function getStorageUsageBytes() {
    let total = 0;
    Object.keys(localStorage).forEach(key => {
        if (!key.startsWith('streamdesk_')) return;
        total += new Blob([key, localStorage.getItem(key) || '']).size;
    });
    return total;
}
function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
function updateStorageInfo() {
    if (dom.storageInfo) dom.storageInfo.textContent = formatBytes(getStorageUsageBytes());
}
// Löscht nur Daten von Channels, die gerade NICHT geöffnet sind - offene/verbundene Channels
// bleiben unangetastet (deren Speicher wird stattdessen beim Verlassen automatisch geräumt).
function clearUnusedStorage() {
    const activeChannels = STATE.channels.map(c => c.name);
    const prefixes = ['streamdesk_messages_', 'streamdesk_events_', 'streamdesk_userlist_', 'streamdesk_usermsg_'];
    let removed = 0;
    Object.keys(localStorage).forEach(key => {
        const prefix = prefixes.find(p => key.startsWith(p));
        if (!prefix) return; // Auth/Channelliste/Filter/Version etc. nie anfassen
        const rest = key.slice(prefix.length); // "<channel>" bzw. "<channel>_<login>"
        const belongsToActiveChannel = activeChannels.some(ch => rest === ch || rest.startsWith(ch + '_'));
        if (!belongsToActiveChannel) { localStorage.removeItem(key); removed++; }
    });
    updateStorageInfo();
    clientLog('STORAGE', `Aufgeräumt: ${removed} Einträge entfernt`);
    showToast(removed > 0 ? `🧹 Speicher von ${removed} Einträgen nicht geöffneter Channels gelöscht.` : 'Kein ungenutzter Speicher gefunden.');
}

function handleServerMessage(msg) {
    switch (msg.type) {
        case 'oauth_url': {
            const width = 500, height = 600;
            const left = (screen.width - width) / 2, top = (screen.height - height) / 2;
            STATE.oauthPopup = window.open(msg.url, 'twitch_oauth', `width=${width},height=${height},left=${left},top=${top}`);
            if (!STATE.oauthPopup) { clientWarn('AUTH', 'OAuth-Popup wurde blockiert'); showToast('Bitte Popups erlauben.'); }
            else clientLog('AUTH', 'OAuth-Fenster geöffnet');
            break;
        }
        case 'oauth_token':
            if (STATE.oauthPopup) STATE.oauthPopup.close();
            clientLog('AUTH', 'OAuth-Token erhalten');
            saveJSON(LS_KEYS.AUTH, { token: msg.token });
            sendToServer({ type: 'login_oauth', token: msg.token });
            break;
        case 'login_success':
            STATE.loggedIn = true;
            STATE.ownUsername = msg.username;
            dom.loginScreen.style.display = 'none';
            dom.app.style.display = 'flex';
            dom.connectedAs.textContent = `@${msg.username}`;
            dom.chatInput.disabled = false; dom.btnSend.disabled = false;
            clientLog('AUTH', `Eingeloggt als @${msg.username}`);
            loadSavedChannels();
            startSaveInterval(); // Starte regelmäßiges Speichern
            updateStorageInfo();
            break;
        case 'login_error':
            localStorage.removeItem(LS_KEYS.AUTH);
            dom.loginError.textContent = msg.error; dom.loginError.style.display = 'block';
            clientError('AUTH', `Login fehlgeschlagen: ${msg.error}`);
            break;
        case 'channel_joined': clientLog('CHANNEL', `#${msg.channel} geladen`); handleChannelJoined(msg); break;
        case 'channel_left': clientLog('CHANNEL', `#${msg.channel} verlassen`); handleChannelLeft(msg); break;
        case 'chat_message': appendChatMessage(msg); break;
        case 'chat_event': appendChatEvent(msg); break;
        case 'user_list_update': {
            STATE.userLists[msg.channel] = msg.userList;
            saveJSON(LS_KEYS.USERLIST(msg.channel), msg.userList);
            const canModerateChanged = STATE.canModerate[msg.channel] !== !!msg.canModerate;
            STATE.canModerate[msg.channel] = !!msg.canModerate;
            // Falls das Panel gerade für diesen Channel offen ist, Mod-Aktionen sofort ein-/ausblenden
            if (canModerateChanged && STATE.pendingUserInfo?.channel === msg.channel) renderUserInfoPanel(STATE.pendingUserInfo);
            if (msg.channel === STATE.activeChannel && STATE.sidebarMode === 'users') renderSidebar();
            break;
        }
        case 'user_info':
            // "username" ist hier immer der aufgelöste, echte Login (nie der Anzeigename) -
            // damit lässt sich der lokal gespeicherte Nachrichten-Cache zuverlässig finden.
            if (msg.username && msg.channel) {
                msg.recentMessages = loadJSON(LS_KEYS.USERMSG(msg.channel, msg.username.toLowerCase()), []);
            }
            showUserInfoPanel(msg);
            break;
        case 'message_deleted': markMessageDeleted(msg.channel, msg.messageId); break;
        case 'mod_result':
            if (msg.action === 'deletemessage') showToast(msg.success ? '✅ Nachricht gelöscht' : `❌ Fehler beim Löschen: ${msg.error}`);
            else showToast(msg.success ? `✅ ${msg.action} für @${msg.target} ausgeführt` : `❌ Fehler: ${msg.error}`);
            if (msg.success) clientLog('MOD', `${msg.action}${msg.target ? ` @${msg.target}` : ''} erfolgreich`);
            else clientError('MOD', `${msg.action} fehlgeschlagen: ${msg.error}`);
            break;
        case 'poll_update':
            STATE.activePolls[msg.channel] = msg.poll;
            if (msg.channel === STATE.activeChannel && STATE.sidebarMode === 'poll') renderSidebar();
            break;
        case 'prediction_update':
            STATE.activePredictions[msg.channel] = msg.prediction;
            if (msg.channel === STATE.activeChannel && STATE.sidebarMode === 'poll') renderSidebar();
            break;
        case 'poll_result':
            showToast(msg.success ? '✅ Umfrage aktualisiert' : `❌ ${msg.error}`);
            if (!msg.success) clientError('POLL', msg.error);
            break;
        case 'prediction_result':
            showToast(msg.success ? '✅ Prediction aktualisiert' : `❌ ${msg.error}`);
            if (!msg.success) clientError('PREDICTION', msg.error);
            break;
        case 'error': clientError('SERVER', msg.message); showToast(`⚠️ ${msg.message}`); break;
        case 'bot_list': msg.bots.forEach(b => STATE.botList.add(b)); break;
    }
}
