function renderSidebar() {
    if (STATE.sidebarMode === 'users') renderUserList();
    else if (STATE.sidebarMode === 'poll') renderPollTab();
    else renderEventList();
}

function renderUserList() {
    const channel = STATE.activeChannel;
    const userList = STATE.userLists[channel];
    dom.sidebarContent.innerHTML = '';
    if (!STATE.canModerate[channel]) {
        const note = document.createElement('div');
        note.style.cssText = 'padding:8px 12px;font-size:11px;color:var(--text2);border-bottom:1px solid var(--border);';
        note.textContent = '⚠️ Keine Mod-Rechte in diesem Channel: Twitch verrät Mod-/VIP-Status hier nur über Chat-Badges. Wer schon geschrieben hat, ist korrekt einsortiert – wer nur mitliest, erscheint bis zur ersten Nachricht als „User".';
        dom.sidebarContent.appendChild(note);
    }
    if (!userList) { dom.userCount.textContent='0'; return; }
    let total = 0;
    const groups = [
        { label:'🎙 Broadcaster', items: userList.broadcaster ? [userList.broadcaster] : [], role:'broadcaster' },
        { label:'🛡 Mods', items: userList.mods || [], role:'mod' },
        { label:'💎 VIPs', items: userList.vips || [], role:'vip' },
        { label:'👤 User', items: userList.users || [], role:'user' }
    ];
    groups.forEach(g => {
        if (!g.items.length) return;
        g.items.sort((a,b) => (a.displayName||a.username).localeCompare(b.displayName||b.username));
        total += g.items.length;
        const groupDiv = document.createElement('div'); groupDiv.className = 'user-group';
        const header = document.createElement('div'); header.className = 'user-group-header';
        header.innerHTML = `<span>${g.label} (${g.items.length})</span><span class="collapse-icon">▼</span>`;
        header.onclick = () => { groupDiv.classList.toggle('collapsed'); };
        groupDiv.appendChild(header);
        const itemsDiv = document.createElement('div'); itemsDiv.className = 'user-items';
        g.items.forEach(user => {
            const item = document.createElement('div');
            const isSelf = (user.username === STATE.ownUsername);
            item.className = `user-item ${g.role}${user.isBot ? ' bot' : ''}${isSelf ? ' self' : ''}`;
            let tags = '';
            if (isSelf) tags += '<span class="tag tag-self">Du</span>';
            if (user.isBot) tags += '<span class="tag tag-bot">BOT</span>';
            if (user.isStaff) tags += '<span class="tag tag-staff">Staff</span>';
            if (user.isPartner) tags += '<span class="tag tag-partner">Partner</span>';
            if (user.subTier && user.subTier > 0) {
                const tierLabel = `Tier ${user.subTier}`;
                tags += `<span class="tag tag-sub">Sub (${tierLabel})</span>`;
            }
            if (user.timeoutUntil && user.timeoutUntil > Date.now()) {
                const until = new Date(user.timeoutUntil).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
                tags += `<span class="tag tag-timeout" title="Timeout bis ${until}">⏱ Timeout</span>`;
            }
            item.innerHTML = `<span class="username-text">${user.displayName || user.username}</span> ${tags}`;
            item.addEventListener('click', () => requestUserInfo(user.username, channel, user.userId));
            itemsDiv.appendChild(item);
        });
        groupDiv.appendChild(itemsDiv);
        dom.sidebarContent.appendChild(groupDiv);
    });
    dom.userCount.textContent = total;
}

function renderEventList() {
    const channel = STATE.activeChannel;
    const events = STATE.channelEvents[channel] || [];
    dom.sidebarContent.innerHTML = '';
    if (events.length === 0) {
        dom.sidebarContent.innerHTML = '<div style="padding:10px;color:var(--text2);">Keine Events</div>';
        return;
    }
    events.slice().reverse().forEach(ev => {
        const div = document.createElement('div');
        div.style.padding = '4px 12px'; div.style.fontSize = '13px'; div.style.borderBottom = '1px solid var(--border)';
        const time = new Date(ev.timestamp).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
        let textHtml = ev.text || '';
        const sender = ev.sender, receiver = ev.receiver;
        if (sender) textHtml = textHtml.replace('{sender}', `<span class="clickable-user" data-username="${escapeHtml(sender)}">${escapeHtml(sender)}</span>`);
        if (receiver) textHtml = textHtml.replace('{receiver}', `<span class="clickable-user" data-username="${escapeHtml(receiver)}">${escapeHtml(receiver)}</span>`);
        if (ev.content != null) textHtml = textHtml.replace('{content}', renderMessageWithEmotes(ev.content, ev.emotes, channel));
        div.innerHTML = `<span style="color:#888;font-family:var(--font-mono);font-size:11px;">${time}</span> ${textHtml}`;
        div.querySelectorAll('.clickable-user, .mention').forEach(el => {
            const uname = el.dataset.username;
            if (uname) el.addEventListener('click', () => requestUserInfo(uname, channel));
        });
        dom.sidebarContent.appendChild(div);
    });
}

// Anzeige/Verwaltung von Polls & Predictions. Abstimmen/Wetten als Zuschauer ist absichtlich
// NICHT implementiert - dafür gibt es keine öffentliche Twitch-API, nur Twitchs eigene Clients
// können das. Ohne Mod-/Broadcaster-Rechte liefert der Server dazu grundsätzlich keine Daten.
function renderPollTab() {
    const channel = STATE.activeChannel;
    const canModerate = !!STATE.canModerate[channel];
    const poll = STATE.activePolls[channel];
    const prediction = STATE.activePredictions[channel];
    dom.sidebarContent.innerHTML = '';

    if (!poll && !prediction) {
        const empty = document.createElement('div');
        empty.className = 'poll-empty';
        empty.textContent = canModerate
            ? 'Keine laufende Umfrage/Prediction.'
            : 'Keine laufende Umfrage/Prediction sichtbar. Ohne Mod-Rechte liefert Twitch dafür grundsätzlich keine Daten (keine öffentliche Zuschauer-API für Polls/Predictions).';
        dom.sidebarContent.appendChild(empty);
        if (canModerate) {
            const actions = document.createElement('div');
            actions.style.cssText = 'padding:0 12px 12px;display:flex;gap:8px;flex-wrap:wrap;';
            const pollBtn = document.createElement('button');
            pollBtn.className = 'btn-outline btn-sm'; pollBtn.textContent = '📊 Umfrage erstellen';
            pollBtn.addEventListener('click', openPollModal);
            const predBtn = document.createElement('button');
            predBtn.className = 'btn-outline btn-sm'; predBtn.textContent = '🔮 Prediction erstellen';
            predBtn.addEventListener('click', openPredictionModal);
            actions.appendChild(pollBtn); actions.appendChild(predBtn);
            dom.sidebarContent.appendChild(actions);
        }
        return;
    }
    if (poll) dom.sidebarContent.appendChild(renderPollPanel(poll, canModerate));
    if (prediction) dom.sidebarContent.appendChild(renderPredictionPanel(prediction, canModerate));
}

function renderPollPanel(poll, canModerate) {
    const wrap = document.createElement('div'); wrap.className = 'poll-panel';
    const totalVotes = poll.choices.reduce((sum, c) => sum + (c.votes || 0) + (c.channel_points_votes || 0), 0);
    let html = `<h4>📊 ${escapeHtml(poll.title)}</h4>`;
    poll.choices.forEach(c => {
        const votes = (c.votes || 0) + (c.channel_points_votes || 0);
        const pct = totalVotes ? Math.round((votes / totalVotes) * 100) : 0;
        html += `<div class="poll-option">
            <div class="poll-option-label"><span>${escapeHtml(c.title)}</span><span>${votes} (${pct}%)</span></div>
            <div class="poll-option-bar-bg"><div class="poll-option-bar-fill" style="width:${pct}%;"></div></div>
        </div>`;
    });
    const remaining = Math.max(0, Math.round((new Date(poll.ends_at).getTime() - Date.now()) / 1000));
    html += `<div class="poll-meta">Endet in ${remaining}s · ${totalVotes} Stimmen insgesamt</div>`;
    wrap.innerHTML = html;
    if (canModerate) {
        const endBtn = document.createElement('button');
        endBtn.className = 'btn-outline btn-sm'; endBtn.style.marginTop = '10px'; endBtn.textContent = '⏹ Umfrage beenden';
        endBtn.addEventListener('click', () => sendToServer({ type: 'end_poll', channel: STATE.activeChannel }));
        wrap.appendChild(endBtn);
    }
    return wrap;
}

function renderPredictionPanel(prediction, canModerate) {
    const wrap = document.createElement('div'); wrap.className = 'poll-panel';
    const totalPoints = prediction.outcomes.reduce((sum, o) => sum + (o.channel_points || 0), 0);
    let html = `<h4>🔮 ${escapeHtml(prediction.title)} <span style="color:var(--text2);font-weight:400;">(${prediction.status === 'LOCKED' ? 'gesperrt' : 'läuft'})</span></h4>`;
    prediction.outcomes.forEach(o => {
        const points = o.channel_points || 0;
        const pct = totalPoints ? Math.round((points / totalPoints) * 100) : 0;
        html += `<div class="poll-option">
            <div class="poll-option-label"><span>${escapeHtml(o.title)}</span><span>${o.users || 0} Teiln. (${pct}%)</span></div>
            <div class="poll-option-bar-bg"><div class="poll-option-bar-fill prediction-option-bar-fill" style="width:${pct}%;"></div></div>
        </div>`;
    });
    wrap.innerHTML = html;
    if (canModerate) {
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;';
        if (prediction.status === 'ACTIVE') {
            const lockBtn = document.createElement('button');
            lockBtn.className = 'btn-outline btn-sm'; lockBtn.textContent = '🔒 Sperren';
            lockBtn.addEventListener('click', () => sendToServer({ type: 'resolve_prediction', channel: STATE.activeChannel, status: 'LOCKED' }));
            actions.appendChild(lockBtn);
        }
        prediction.outcomes.forEach(o => {
            const resolveBtn = document.createElement('button');
            resolveBtn.className = 'btn-primary btn-sm'; resolveBtn.textContent = `🏆 „${o.title}" gewinnt`;
            resolveBtn.addEventListener('click', () => sendToServer({ type: 'resolve_prediction', channel: STATE.activeChannel, status: 'RESOLVED', winningOutcomeId: o.id }));
            actions.appendChild(resolveBtn);
        });
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-danger btn-sm'; cancelBtn.textContent = '✕ Abbrechen';
        cancelBtn.addEventListener('click', () => sendToServer({ type: 'resolve_prediction', channel: STATE.activeChannel, status: 'CANCELED' }));
        actions.appendChild(cancelBtn);
        wrap.appendChild(actions);
    }
    return wrap;
}

function createOptionRow(container, placeholder, removable) {
    const row = document.createElement('div'); row.className = 'choice-row';
    const input = document.createElement('input'); input.type = 'text'; input.placeholder = placeholder; input.maxLength = 25;
    row.appendChild(input);
    if (removable) {
        const rm = document.createElement('span'); rm.className = 'choice-remove'; rm.textContent = '✕';
        rm.addEventListener('click', () => row.remove());
        row.appendChild(rm);
    }
    container.appendChild(row);
    return input;
}
function openPollModal() {
    dom.pollChoices.innerHTML = '';
    createOptionRow(dom.pollChoices, 'Option 1', false);
    createOptionRow(dom.pollChoices, 'Option 2', false);
    dom.pollTitle.value = ''; dom.pollDuration.value = 60;
    dom.modalPoll.style.display = 'flex';
    dom.pollTitle.focus();
}
function openPredictionModal() {
    dom.predictionOutcomes.innerHTML = '';
    createOptionRow(dom.predictionOutcomes, 'Ergebnis 1', false);
    createOptionRow(dom.predictionOutcomes, 'Ergebnis 2', false);
    dom.predictionTitle.value = ''; dom.predictionWindow.value = 120;
    dom.modalPrediction.style.display = 'flex';
    dom.predictionTitle.focus();
}
