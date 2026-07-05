function requestUserInfo(username, channel, userId) {
    STATE.pendingUserInfo = { username, channel, recentMessages:[] };
    const payload = { type:'get_user_info', username, channel };
    if (userId) payload.userId = userId;
    sendToServer(payload);
}
function showUserInfoPanel(data) {
    STATE.pendingUserInfo = { ...STATE.pendingUserInfo, ...data };
    try { renderUserInfoPanel(STATE.pendingUserInfo); } catch (e) { dom.panelBody.innerHTML = '<em>Fehler beim Laden der Benutzerdaten.</em>'; }
    dom.userInfoPanel.classList.add('open');
    const uname = data.username || '';
    dom.panelUsername.innerHTML = uname
        ? `<a href="https://twitch.tv/${encodeURIComponent(uname)}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none;">@${escapeHtml(uname)}</a>`
        : '@Unbekannt';
}
function renderUserInfoPanel(info) {
    const { username, channel, userId, accountCreated, followDuration, badges, subscription, recentMessages, profileImageUrl, accountType, description, viewCount, banStatus } = info;
    const badgeMap = STATE.badgeMap[channel] || { global:{}, channel:{} };
    const profileUrl = username ? `https://twitch.tv/${encodeURIComponent(username)}` : null;
    let html = '';
    if (profileImageUrl) html += `<div class="avatar-container"><img src="${profileImageUrl}" class="avatar-img" alt="Avatar"></div>`;
    html += '<div class="info-section"><h4>📋 Allgemein</h4>';
    html += `<div class="info-row"><span class="label">Username</span><span class="value">${profileUrl ? `<a href="${profileUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);">${escapeHtml(username)}</a>` : escapeHtml(username || '')}</span></div>`;
    html += `<div class="info-row"><span class="label">User-ID</span><span class="value">${userId||'Unbekannt'}</span></div>`;
    html += `<div class="info-row"><span class="label">Account-Typ</span><span class="value">${accountType||'Unbekannt'}</span></div>`;
    html += `<div class="info-row"><span class="label">Account erstellt</span><span class="value">${accountCreated||'Unbekannt'}</span></div>`;
    html += `<div class="info-row"><span class="label">Folgt seit</span><span class="value">${followDuration||'Unbekannt'}</span></div>`;
    if (banStatus?.banned) {
        const label = banStatus.permanent
            ? '🚫 Permanent gebannt'
            : `⏱ Gesperrt bis ${new Date(banStatus.expiresAt).toLocaleString('de-DE')}`;
        html += `<div class="info-row"><span class="label">Status</span><span class="value" style="color:var(--danger);font-weight:600;">${escapeHtml(label)}</span></div>`;
        if (banStatus.reason) html += `<div class="info-row"><span class="label">Grund</span><span class="value">${escapeHtml(banStatus.reason)}</span></div>`;
    }
    if (description) html += `<div class="info-row"><span class="label">Beschreibung</span><span class="value" style="word-break:break-word;max-width:250px;">${escapeHtml(description)}</span></div>`;
    if (viewCount != null) html += `<div class="info-row"><span class="label">Kanal-Aufrufe</span><span class="value">${viewCount.toLocaleString()}</span></div>`;
    html += '</div>';
    if (subscription) {
        html += '<div class="info-section"><h4>⭐ Abo</h4>';
        html += `<div class="info-row"><span class="label">Tier</span><span class="value">${subscription.tier||'Unbekannt'}</span></div>`;
        html += `<div class="info-row"><span class="label">Dauer</span><span class="value">${subscription.duration||'Unbekannt'}</span></div></div>`;
    }
    if (badges && badges.length) {
        html += '<div class="info-section"><h4>🏷 Badges</h4>';
        badges.forEach(b => {
            const url = badgeMap.global[b.name]?.[b.version] || badgeMap.channel[b.name]?.[b.version] || '';
            html += `<div class="info-row"><span class="label">${url?`<img src="${url}" style="height:16px;vertical-align:middle;">`:''} ${escapeHtml(b.name)}</span><span class="value">${escapeHtml(b.version||'')}</span></div>`;
        });
        html += '</div>';
    }
    const canModerate = !!STATE.canModerate[channel];
    if (recentMessages && recentMessages.length) {
        html += '<div class="info-section"><h4>💬 Letzte Nachrichten</h4><div class="user-msg-preview" style="background:var(--bg3);padding:6px 10px;border-radius:4px;max-height:150px;overflow-y:auto;">';
        recentMessages.forEach(m => {
            const time = new Date(m.timestamp).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
            const text = m.deleted ? `<s>${escapeHtml(m.message)}</s>` : renderMessageWithEmotes(m.message, m.emotes, channel);
            const delBtn = (canModerate && !m.deleted && m.id) ? `<span class="chat-delete-btn" title="Nachricht löschen" onclick="deleteMessage('${escapeHtml(m.id)}','${escapeHtml(channel)}')">🗑</span>` : '';
            html += `<div class="msg-preview-row" style="margin:2px 0;font-size:12px;"><span><span style="color:#888;">[${time}]</span> ${text}</span>${delBtn}</div>`;
        });
        html += '</div></div>';
    }
    if (canModerate) {
        html += '<div class="info-section"><h4>🛠 Mod-Aktionen</h4><div class="mod-actions">';
        html += `<button class="btn-outline btn-sm" onclick="executeModAction('${escapeHtml(username)}','${escapeHtml(channel)}','timeout',60)">⏱ 1min Timeout</button>`;
        html += `<button class="btn-outline btn-sm" onclick="executeModAction('${escapeHtml(username)}','${escapeHtml(channel)}','timeout',1800)">⏱ 30min Timeout</button>`;
        html += `<span style="display:inline-flex;align-items:center;gap:4px;">
            <input type="number" min="1" class="btn-sm" id="custom-timeout-minutes" placeholder="Min." style="width:56px;">
            <button class="btn-outline btn-sm" onclick="executeCustomTimeout('${escapeHtml(username)}','${escapeHtml(channel)}')">⏱ Individuell</button>
        </span>`;
        html += `<button class="btn-danger btn-sm" onclick="executeModAction('${escapeHtml(username)}','${escapeHtml(channel)}','ban',0)">🚫 Ban</button>`;
        html += `<button class="btn-outline btn-sm" onclick="executeModAction('${escapeHtml(username)}','${escapeHtml(channel)}','unban',0)">✅ Unban</button>`;
        html += '</div></div>';
    } else {
        html += '<div class="info-section"><em style="color:var(--text2);font-size:12px;">Keine Moderationsrechte in diesem Channel.</em></div>';
    }
    dom.panelBody.innerHTML = html;
}

function executeModAction(username, channel, action, duration) {
    sendToServer({ type:'mod_action', channel, target:username, action, duration });
    showToast(`🛠 ${action} für @${username} ausgeführt...`);
}
function executeCustomTimeout(username, channel) {
    const input = document.getElementById('custom-timeout-minutes');
    const minutes = parseInt(input?.value, 10);
    if (!minutes || minutes <= 0) { showToast('⚠️ Bitte eine gültige Minutenanzahl eingeben.'); return; }
    executeModAction(username, channel, 'timeout', minutes * 60);
}
function deleteMessage(messageId, channel) {
    if (!messageId) { showToast('⚠️ Nachricht kann nicht gelöscht werden (keine ID).'); return; }
    sendToServer({ type:'mod_action', action:'deletemessage', channel, messageId });
}
function quickBan(username, channel) {
    // Schneller Ban-Klick mitten im Chat ist fehlerträchtiger als der bewusste Klick im
    // User-Panel - deshalb hier zur Sicherheit eine Bestätigung.
    if (!confirm(`@${username} in #${channel} sperren?`)) return;
    executeModAction(username, channel, 'ban', 0);
}
function markMessageDeleted(channel, messageId) {
    if (!messageId) return;
    const div = getChannelDiv(channel);
    const line = div?.querySelector(`[data-msg-id="${CSS.escape(messageId)}"]`);
    if (line && !line.classList.contains('deleted')) {
        line.classList.add('deleted');
        const msgSpan = line.querySelector('.chat-message');
        if (msgSpan) msgSpan.innerHTML = `<s>${msgSpan.innerHTML}</s>`;
        line.querySelector('.chat-delete-btn[data-action="delete"]')?.remove();
    }
    const messages = loadJSON(LS_KEYS.MESSAGES(channel), []);
    const idx = messages.findIndex(m => m.id === messageId);
    if (idx !== -1 && !messages[idx].deleted) {
        messages[idx].deleted = true;
        saveJSON(LS_KEYS.MESSAGES(channel), messages);
    }
    if (STATE.pendingUserInfo?.channel === channel && STATE.pendingUserInfo.recentMessages) {
        const rm = STATE.pendingUserInfo.recentMessages.find(m => m.id === messageId);
        if (rm && !rm.deleted) {
            rm.deleted = true;
            renderUserInfoPanel(STATE.pendingUserInfo);
            const loginKey = STATE.pendingUserInfo.username?.toLowerCase();
            if (loginKey) {
                const userMsgs = loadJSON(LS_KEYS.USERMSG(channel, loginKey), []);
                const uidx = userMsgs.findIndex(m => m.id === messageId);
                if (uidx !== -1) { userMsgs[uidx].deleted = true; saveJSON(LS_KEYS.USERMSG(channel, loginKey), userMsgs); }
            }
        }
    }
}
