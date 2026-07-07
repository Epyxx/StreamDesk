function renderMessageElement(msg) {
    const line = document.createElement('div'); line.className = 'chat-line';
    if (msg.id) line.dataset.msgId = msg.id;
    if (msg.deleted) line.classList.add('deleted');
    const filterWords = STATE.filters[msg.channel] || [];
    if (!msg.deleted && filterWords.length && filterWords.some(w => w && msg.message.toLowerCase().includes(w.trim()))) line.classList.add('highlight');
    if (!msg.deleted && STATE.ownUsername && new RegExp(`@${escapeRegex(STATE.ownUsername)}`, 'i').test(msg.message)) line.classList.add('mention-highlight');

    const time = document.createElement('span'); time.className='chat-time';
    time.textContent = new Date(msg.timestamp).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
    line.appendChild(time);

    // Mod-Aktionen dauerhaft (nicht nur bei Hover) zwischen Zeitstempel und Badges anzeigen -
    // bei der eigenen Nachricht nie, da man sich ohnehin nicht selbst timeouten/bannen/die
    // eigene Nachricht per Mod-Rechten löschen kann (Twitch verbietet das serverseitig).
    const isOwnMessage = !!(msg.login && msg.login === STATE.ownUsername);
    if (!msg.deleted && !isOwnMessage && STATE.canModerate[msg.channel]) {
        const actions = document.createElement('span'); actions.className = 'msg-actions';
        if (msg.id) {
            const delBtn = document.createElement('span');
            delBtn.className = 'chat-delete-btn'; delBtn.dataset.action = 'delete'; delBtn.textContent = '🗑'; delBtn.title = 'Nachricht löschen';
            delBtn.addEventListener('click', e => { e.stopPropagation(); deleteMessage(msg.id, msg.channel); });
            actions.appendChild(delBtn);
        }
        const login = msg.login || msg.username;
        if (login) {
            const banBtn = document.createElement('span');
            banBtn.className = 'chat-delete-btn'; banBtn.dataset.action = 'ban'; banBtn.textContent = '🚫'; banBtn.title = `@${login} sperren`;
            banBtn.addEventListener('click', e => { e.stopPropagation(); quickBan(login, msg.channel); });
            actions.appendChild(banBtn);
        }
        if (actions.children.length) line.appendChild(actions);
    }

    if (msg.badges?.length && !msg.deleted) {
        const badgeMap = STATE.badgeMap[msg.channel] || { global:{}, channel:{} };
        const bs = document.createElement('span'); bs.className='chat-badges';
        msg.badges.forEach(b => {
            let url;
            if (b.name === 'subscriber') {
                url = (badgeMap.channel[b.name]?.[b.version]) || (badgeMap.global[b.name]?.[b.version]);
            } else {
                url = badgeMap.global[b.name]?.[b.version] || badgeMap.channel[b.name]?.[b.version];
            }
            if (url) { const img = document.createElement('img'); img.src=url; img.alt=b.name; img.title=b.name; img.className='badge'; bs.appendChild(img); }
        });
        line.appendChild(bs);
    }
    const userSpan = document.createElement('span'); userSpan.className = 'chat-username';
    userSpan.style.color = msg.color || '#ccc';
    userSpan.textContent = msg.username;
    userSpan.addEventListener('click', () => requestUserInfo(msg.login || msg.username, msg.channel, msg.userId));
    line.appendChild(userSpan);
    line.appendChild(document.createElement('span')).className='chat-colon'; line.lastChild.textContent=': ';
    const msgSpan = document.createElement('span'); msgSpan.className = 'chat-message';
    msgSpan.innerHTML = msg.deleted ? `<s>${escapeHtml(msg.message)}</s>` : renderMessageWithEmotes(msg.message, msg.emotes, msg.channel);
    if (!msg.deleted) msgSpan.querySelectorAll('.mention').forEach(m => m.addEventListener('click', () => { const u = m.dataset.username; if (u) requestUserInfo(u, msg.channel); }));
    line.appendChild(msgSpan);

    return line;
}

function appendChatMessage(msg) {
    const div = getChannelDiv(msg.channel); if (!div) return;
    // Dedup über die eindeutige Twitch-Nachrichten-ID: verhindert doppelt angezeigte
    // Nachrichten, wenn z.B. durch einen Reconnect/Reload dieselbe Nachricht zweimal ankommt.
    if (!STATE.seenMessageIds[msg.channel]) STATE.seenMessageIds[msg.channel] = new Set();
    if (msg.id) {
        if (STATE.seenMessageIds[msg.channel].has(msg.id)) return;
        STATE.seenMessageIds[msg.channel].add(msg.id);
    }
    const line = renderMessageElement(msg);
    div.appendChild(line);
    if (STATE.autoScroll[msg.channel]) {
        div.scrollTop = div.scrollHeight; // Direkt setzen, kein requestAnimationFrame
    }
    if (msg.channel !== STATE.activeChannel) { STATE.unreadCounts[msg.channel] = (STATE.unreadCounts[msg.channel]||0)+1; renderTabs(); }
    // Alte Zeilen nur trimmen, wenn gerade unten mitgescrollt wird - sonst würde die
    // Leseposition eines Users, der gerade im Verlauf zurückscrollt, verschoben werden.
    if (STATE.autoScroll[msg.channel]) {
        while (div.children.length > 1000) div.firstChild.remove();
    }
    // Cache aktualisieren
    const messages = loadJSON(LS_KEYS.MESSAGES(msg.channel), []);
    messages.push(msg); if (messages.length > 1000) messages.shift();
    saveJSON(LS_KEYS.MESSAGES(msg.channel), messages);
    // Pro-User-Cache (100 Nachrichten/User/Channel) fürs User-Info-Panel, überlebt Reload/Neustart
    const loginKey = (msg.login || msg.username || '').toLowerCase();
    if (loginKey) {
        const userMsgs = loadJSON(LS_KEYS.USERMSG(msg.channel, loginKey), []);
        userMsgs.push(msg); if (userMsgs.length > 100) userMsgs.shift();
        saveJSON(LS_KEYS.USERMSG(msg.channel, loginKey), userMsgs);
    }
}

function appendChatEvent(msg) {
    const div = getChannelDiv(msg.channel); if (!div) return;
    const line = document.createElement('div');
    line.className = 'chat-event' + (msg.isAnnouncement ? ` announcement color-${msg.announcementColor || 'primary'}` : '');
    const time = new Date(msg.timestamp).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const timeSpan = document.createElement('span'); timeSpan.className = 'chat-time'; timeSpan.textContent = time;
    line.appendChild(timeSpan);

    let textHtml = msg.text || '';
    const sender = msg.sender;
    const receiver = msg.receiver;
    if (sender) textHtml = textHtml.replace('{sender}', `<span class="clickable-user" data-username="${escapeHtml(sender)}">${escapeHtml(sender)}</span>`);
    if (receiver) textHtml = textHtml.replace('{receiver}', `<span class="clickable-user" data-username="${escapeHtml(receiver)}">${escapeHtml(receiver)}</span>`);
    // "content" (Ankündigungstext, gelöschte Nachricht, Ban-/Timeout-Grund, Sub-/Cheer-
    // Nachricht) läuft durch dieselbe Pipeline wie normale Chatnachrichten, damit Links
    // klickbar sind und Emotes überall einheitlich dargestellt werden.
    if (msg.content != null) textHtml = textHtml.replace('{content}', renderMessageWithEmotes(msg.content, msg.emotes, msg.channel));
    const textSpan = document.createElement('span');
    textSpan.innerHTML = textHtml;
    textSpan.querySelectorAll('.clickable-user, .mention').forEach(el => {
        const uname = el.dataset.username;
        if (uname) el.addEventListener('click', () => requestUserInfo(uname, msg.channel));
    });
    line.appendChild(textSpan);

    div.appendChild(line);
    if (STATE.autoScroll[msg.channel]) {
        div.scrollTop = div.scrollHeight;
    }
    if (msg.channel !== STATE.activeChannel) { STATE.unreadCounts[msg.channel] = (STATE.unreadCounts[msg.channel]||0)+1; renderTabs(); }

    // Seit dem Settling-Fenster-Fix spammen Join/Part nicht mehr, daher jetzt auch im
    // Event-Log gespeichert statt (wie zuvor) komplett ausgeschlossen zu werden.
    if (!STATE.channelEvents[msg.channel]) STATE.channelEvents[msg.channel] = [];
    STATE.channelEvents[msg.channel].push(msg);
    if (STATE.channelEvents[msg.channel].length > 500) STATE.channelEvents[msg.channel].shift();
    saveJSON(LS_KEYS.EVENTS(msg.channel), STATE.channelEvents[msg.channel]);
    if (msg.channel === STATE.activeChannel && STATE.sidebarMode === 'events') renderSidebar();
}

function renderMessageWithEmotes(message, twitchEmotes, channel) {
    const tokens = [];
    // Links zuerst auf dem ROHEN Text erkennen (priority 0, gewinnt bei Überlappung) - sonst
    // zerreißt ein Emote-Code, der zufällig mitten in einer URL steckt (z.B. "gg" in
    // "discord.gg"), den Link in zwei kaputte Teile.
    const linkRegex = /https?:\/\/\S+/g;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(message)) !== null) {
        let url = linkMatch[0];
        const trailing = url.match(/[).,!?;:]+$/);
        if (trailing) url = url.slice(0, -trailing[0].length);
        if (!url) continue;
        tokens.push({ start: linkMatch.index, end: linkMatch.index + url.length, priority: 0, html: `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>` });
    }
    if (twitchEmotes) twitchEmotes.forEach(em => tokens.push({ start: em.start, end: em.end, priority: 1, html: `<img class="emote" src="https://static-cdn.jtvnw.net/emoticons/v2/${em.id}/default/dark/1.0" alt="${escapeHtml(em.name)}" title="${escapeHtml(em.name)}">` }));
    const chEmotes = STATE.emotes[channel];
    if (chEmotes) {
        const combined = [...(chEmotes.ffz||[]), ...(chEmotes.bttv||[]), ...(chEmotes.seventv||[])];
        combined.forEach(em => {
            const code = em.code;
            const regex = new RegExp(`(?<![a-zA-Z0-9_])${escapeRegex(code)}(?![a-zA-Z0-9_])`, 'g');
            let match;
            while ((match = regex.exec(message)) !== null) {
                tokens.push({ start: match.index, end: match.index + code.length, priority: 1, html: `<img class="emote" src="${em.url}" alt="${escapeHtml(em.name||em.code)}" title="${escapeHtml(em.name||em.code)}">` });
            }
        });
    }
    // Nach Position sortieren; bei Überlappung gewinnt die niedrigere priority (Link vor Emote)
    tokens.sort((a,b) => a.start - b.start || a.priority - b.priority);
    const filtered = [];
    let lastEnd = 0;
    for (const t of tokens) {
        if (t.start >= lastEnd) { filtered.push(t); lastEnd = t.end; }
    }
    const segments = [];
    let idx = 0;
    for (const t of filtered) {
        if (t.start > idx) segments.push(escapeHtml(message.substring(idx, t.start)));
        segments.push(t.html);
        idx = t.end;
    }
    if (idx < message.length) segments.push(escapeHtml(message.substring(idx)));
    let html = segments.join('');
    // \p{L}/\p{N} statt [a-zA-Z0-9_], damit auch Erwähnungen von Usern mit z.B.
    // japanischen/koreanischen Anzeigenamen als Mention erkannt werden.
    html = html.replace(/(^|\s)@([\p{L}\p{N}_]+)/gu, '$1<span class="mention" data-username="$2">@$2</span>');
    return html;
}
