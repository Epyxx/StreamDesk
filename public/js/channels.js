function loadSavedChannels() {
    const savedChannels = loadJSON(LS_KEYS.CHANNELS, []);
    savedChannels.forEach(ch => sendToServer({ type: 'join_channel', channel: ch }));
}
function saveChannelList() { saveJSON(LS_KEYS.CHANNELS, STATE.channels.map(c => c.name)); }
function loadFilters() {
    const saved = loadJSON(LS_KEYS.FILTERS, {});
    Object.entries(saved).forEach(([ch, words]) => { STATE.filters[ch] = words; });
}
function saveFilters() { saveJSON(LS_KEYS.FILTERS, STATE.filters); }

function getChannelDiv(ch) { return document.getElementById(`chat-${ch}`); }
function createChannelDiv(ch) {
    if (getChannelDiv(ch)) return;
    const d = document.createElement('div'); d.id = `chat-${ch}`; d.className = 'channel-chat hidden';
    dom.channelsContainer.appendChild(d);
    STATE.autoScroll[ch] = true;
    addScrollListener(ch);
}
function removeChannelDiv(ch) { const d = getChannelDiv(ch); if(d) d.remove(); delete STATE.autoScroll[ch]; }
function addScrollListener(channel) {
    const div = getChannelDiv(channel); if (!div) return;
    div.addEventListener('scroll', () => {
        const atBottom = div.scrollHeight - div.scrollTop - div.clientHeight < 50;
        STATE.autoScroll[channel] = atBottom;
        if (channel === STATE.activeChannel) updateScrollButton();
    });
}
function updateScrollButton() {
    if (!STATE.activeChannel) return;
    dom.scrollToBottomBtn.classList.toggle('visible', !STATE.autoScroll[STATE.activeChannel]);
}
function scrollToBottom(channel, smooth = false) {
    const div = getChannelDiv(channel);
    if (!div) return;
    STATE.autoScroll[channel] = true;
    if (smooth) div.scrollTo({ top: div.scrollHeight, behavior: 'smooth' });
    else div.scrollTop = div.scrollHeight;
    updateScrollButton();
}

function handleChannelJoined(msg) {
    const ch = msg.channel;
    if (msg.emotes) STATE.emotes[ch] = msg.emotes;
    if (msg.badgeMap) STATE.badgeMap[ch] = msg.badgeMap;
    if (msg.broadcasterId) STATE.broadcasterIds[ch] = msg.broadcasterId;

    if (!STATE.channels.find(c => c.name === ch)) {
        STATE.channels.push({ name: ch });
        createChannelDiv(ch);
        STATE.unreadCounts[ch] = 0;
        STATE.channelEvents[ch] = loadJSON(LS_KEYS.EVENTS(ch), []);
        // Der gespeicherte userList hat exakt dieselbe Form wie ein live empfangenes
        // user_list_update (broadcaster-Objekt + Arrays von User-Objekten für mods/vips/users) -
        // hier NICHT in Sets umwandeln, sonst liefert renderUserList() nur leere Gruppen.
        const savedUserList = loadJSON(LS_KEYS.USERLIST(ch));
        if (savedUserList) {
            STATE.userLists[ch] = savedUserList;
        }
        const div = getChannelDiv(ch);
        if (div) {
            const cachedMessages = loadJSON(LS_KEYS.MESSAGES(ch), []);
            STATE.seenMessageIds[ch] = new Set(cachedMessages.filter(m => m.id).map(m => m.id));
            cachedMessages.forEach(m => div.appendChild(renderMessageElement(m)));
            div.scrollTop = div.scrollHeight;
        }
        saveChannelList();
        updateStorageInfo();
    }
    switchTab(ch);
    renderSidebar();
}

function handleChannelLeft(msg) {
    const ch = msg.channel; const idx = STATE.channels.findIndex(c => c.name === ch);
    if (idx >= 0) STATE.channels.splice(idx, 1);
    removeChannelDiv(ch); delete STATE.userLists[ch]; delete STATE.emotes[ch]; delete STATE.filters[ch]; delete STATE.unreadCounts[ch]; delete STATE.badgeMap[ch]; delete STATE.channelEvents[ch]; delete STATE.seenMessageIds[ch]; delete STATE.canModerate[ch]; delete STATE.broadcasterIds[ch];
    delete STATE.activePolls[ch]; delete STATE.activePredictions[ch];
    // Channel-Speicher wird beim Verlassen (Tab schließen) vollständig geräumt
    localStorage.removeItem(LS_KEYS.MESSAGES(ch));
    localStorage.removeItem(LS_KEYS.EVENTS(ch));
    localStorage.removeItem(LS_KEYS.USERLIST(ch));
    const userMsgPrefix = LS_KEYS.USERMSG_PREFIX(ch);
    Object.keys(localStorage).filter(k => k.startsWith(userMsgPrefix)).forEach(k => localStorage.removeItem(k));
    if (STATE.activeChannel === ch) { STATE.activeChannel = STATE.channels.length ? STATE.channels[0].name : null; switchTab(STATE.activeChannel); }
    saveChannelList();
    renderTabs();
    updateStorageInfo();
}

function switchTab(channelName) {
    const name = channelName?.replace('#', '').toLowerCase();
    STATE.channels.forEach(c => { const d = getChannelDiv(c.name); if(d) d.classList.add('hidden'); });
    STATE.activeChannel = name;
    const active = getChannelDiv(name);
    if (active) { active.classList.remove('hidden'); active.scrollTop = active.scrollHeight; STATE.autoScroll[name] = true; }
    STATE.unreadCounts[name] = 0;
    renderTabs(); renderSidebar(); updateScrollButton(); updateFilterModalChannel();
    // Emote-Liste des Pickers ist channelspezifisch - beim Tab-Wechsel schließen statt mit
    // veraltetem Inhalt für den vorherigen Channel offen zu lassen.
    toggleEmotePicker(false);
}

function renderTabs() {
    dom.tabBar.innerHTML = '';
    STATE.channels.forEach(ch => {
        const unread = STATE.unreadCounts[ch.name] || 0;
        const tab = document.createElement('div');
        tab.className = 'tab' + (STATE.activeChannel === ch.name ? ' active' : '');
        tab.innerHTML = `<span>#${ch.name}</span>`;
        if (unread > 0) { const b = document.createElement('span'); b.className='unread-badge'; b.textContent=unread; b.style.display='inline-block'; tab.appendChild(b); }
        const close = document.createElement('span'); close.className='close-tab'; close.textContent='✕';
        close.title = ch.name === STATE.activeChannel ? 'Channel verlassen (Alt+W)' : 'Channel verlassen';
        close.onclick = e => { e.stopPropagation(); sendToServer({ type:'leave_channel', channel:ch.name }); };
        tab.appendChild(close);
        tab.onclick = () => switchTab(ch.name);
        dom.tabBar.appendChild(tab);
    });
}

function updateFilterModalChannel() { dom.filterChannelName.textContent = STATE.activeChannel ? `#${STATE.activeChannel}` : '-'; dom.inputFilterWords.value = (STATE.filters[STATE.activeChannel]||[]).join(', '); }
