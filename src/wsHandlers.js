const { fetchHelix } = require('./helixClient');
const {
    loadChannelBadges, getEmotes, fetchUserEmotes,
    fetchActivePoll, createPollHelix, patchPollHelix,
    fetchActivePrediction, createPredictionHelix, patchPredictionHelix,
} = require('./twitchServices');
const { sendToClient } = require('./helpers');
const { log, logWarn, logError } = require('./logger');
const { startUserListInterval, refreshUserList, resolveIdentity } = require('./userRoster');

function startPollPredictionInterval(ws, cs, ch) {
    if (cs.pollPredictionIntervals[ch]) return;
    cs.pollPredictionIntervals[ch] = setInterval(() => {
        if (cs.tmiClient && cs.channels.has(ch)) refreshPollAndPrediction(ws, cs, ch);
    }, 8000); // kurzes Intervall, da Polls/Predictions zeitkritisch sind
}

// Fragt die aktuell laufende Umfrage/Prediction ab und schickt nur bei einer echten Änderung ein
// Update. Funktioniert mit dem Token des eingeloggten Users - klappt laut Twitch nur, wenn dieser
// der Broadcaster ODER Moderator des Channels ist; für reine Zuschauer gibt es dafür keine
// öffentliche API (Fehler werden dann einmalig geloggt, nicht bei jedem Intervall-Tick erneut).
async function refreshPollAndPrediction(ws, cs, ch) {
    const broadcasterId = cs.broadcasterIds[ch];
    if (!broadcasterId) return;

    try {
        const poll = await fetchActivePoll(cs.clientId, cs.oauthToken, broadcasterId);
        const normalized = (poll && poll.status === 'ACTIVE') ? poll : null;
        if (JSON.stringify(normalized) !== JSON.stringify(cs.activePolls[ch] || null)) {
            cs.activePolls[ch] = normalized;
            sendToClient(ws, { type: 'poll_update', channel: ch, poll: normalized });
        }
    } catch (e) {
        if (!cs.pollAccessLogged[ch]) {
            cs.pollAccessLogged[ch] = true;
            logWarn('POLL', `Kein Zugriff für #${ch} (${e.message}) - wird nicht erneut geloggt`);
        }
    }

    try {
        const prediction = await fetchActivePrediction(cs.clientId, cs.oauthToken, broadcasterId);
        const normalized = (prediction && (prediction.status === 'ACTIVE' || prediction.status === 'LOCKED')) ? prediction : null;
        if (JSON.stringify(normalized) !== JSON.stringify(cs.activePredictions[ch] || null)) {
            cs.activePredictions[ch] = normalized;
            sendToClient(ws, { type: 'prediction_update', channel: ch, prediction: normalized });
        }
    } catch (e) {
        if (!cs.predictionAccessLogged[ch]) {
            cs.predictionAccessLogged[ch] = true;
            logWarn('PREDICTION', `Kein Zugriff für #${ch} (${e.message}) - wird nicht erneut geloggt`);
        }
    }
}

function permissionErrorMessage(e, action) {
    if (e.status === 401 || e.status === 403) return `Keine Berechtigung zum ${action} in diesem Channel (nur Broadcaster/Mods mit erweiterten Rechten).`;
    return e.message;
}

async function handleCreatePoll(ws, cs, msg) {
    const ch = msg.channel.toLowerCase();
    const broadcasterId = cs.broadcasterIds[ch];
    if (!broadcasterId) { sendToClient(ws, { type: 'poll_result', success: false, error: 'Channel nicht bereit.' }); return; }
    try {
        const poll = await createPollHelix(cs.clientId, cs.oauthToken, broadcasterId, msg.title, msg.choices, msg.duration);
        cs.activePolls[ch] = poll;
        sendToClient(ws, { type: 'poll_update', channel: ch, poll });
        sendToClient(ws, { type: 'poll_result', success: true });
        log('POLL', `Erstellt in #${ch}: "${msg.title}" (${msg.choices.length} Optionen, ${msg.duration}s)`);
    } catch (e) {
        logError('POLL', `Erstellen in #${ch} fehlgeschlagen: ${e.message}`);
        sendToClient(ws, { type: 'poll_result', success: false, error: permissionErrorMessage(e, 'Erstellen von Umfragen') });
    }
}

async function handleEndPoll(ws, cs, msg) {
    const ch = msg.channel.toLowerCase();
    const broadcasterId = cs.broadcasterIds[ch];
    const pollId = cs.activePolls[ch]?.id;
    if (!broadcasterId || !pollId) { sendToClient(ws, { type: 'poll_result', success: false, error: 'Keine laufende Umfrage.' }); return; }
    try {
        await patchPollHelix(cs.clientId, cs.oauthToken, broadcasterId, pollId, 'TERMINATED');
        cs.activePolls[ch] = null;
        sendToClient(ws, { type: 'poll_update', channel: ch, poll: null });
        sendToClient(ws, { type: 'poll_result', success: true });
        log('POLL', `Beendet in #${ch}`);
    } catch (e) {
        logError('POLL', `Beenden in #${ch} fehlgeschlagen: ${e.message}`);
        sendToClient(ws, { type: 'poll_result', success: false, error: permissionErrorMessage(e, 'Beenden von Umfragen') });
    }
}

async function handleCreatePrediction(ws, cs, msg) {
    const ch = msg.channel.toLowerCase();
    const broadcasterId = cs.broadcasterIds[ch];
    if (!broadcasterId) { sendToClient(ws, { type: 'prediction_result', success: false, error: 'Channel nicht bereit.' }); return; }
    try {
        const prediction = await createPredictionHelix(cs.clientId, cs.oauthToken, broadcasterId, msg.title, msg.outcomes, msg.predictionWindow);
        cs.activePredictions[ch] = prediction;
        sendToClient(ws, { type: 'prediction_update', channel: ch, prediction });
        sendToClient(ws, { type: 'prediction_result', success: true });
        log('PREDICTION', `Erstellt in #${ch}: "${msg.title}" (${msg.outcomes.length} Optionen, ${msg.predictionWindow}s)`);
    } catch (e) {
        logError('PREDICTION', `Erstellen in #${ch} fehlgeschlagen: ${e.message}`);
        sendToClient(ws, { type: 'prediction_result', success: false, error: permissionErrorMessage(e, 'Erstellen von Predictions') });
    }
}

async function handleResolvePrediction(ws, cs, msg) {
    const ch = msg.channel.toLowerCase();
    const broadcasterId = cs.broadcasterIds[ch];
    const predictionId = cs.activePredictions[ch]?.id;
    if (!broadcasterId || !predictionId) { sendToClient(ws, { type: 'prediction_result', success: false, error: 'Keine laufende Prediction.' }); return; }
    try {
        const prediction = await patchPredictionHelix(cs.clientId, cs.oauthToken, broadcasterId, predictionId, msg.status, msg.winningOutcomeId);
        cs.activePredictions[ch] = (msg.status === 'RESOLVED' || msg.status === 'CANCELED') ? null : prediction;
        sendToClient(ws, { type: 'prediction_update', channel: ch, prediction: cs.activePredictions[ch] });
        sendToClient(ws, { type: 'prediction_result', success: true });
        log('PREDICTION', `Status in #${ch} auf ${msg.status} gesetzt`);
    } catch (e) {
        logError('PREDICTION', `Status-Änderung in #${ch} fehlgeschlagen: ${e.message}`);
        sendToClient(ws, { type: 'prediction_result', success: false, error: permissionErrorMessage(e, 'Verwalten von Predictions') });
    }
}

// ========== CHANNEL HANDLER ==========
async function handleJoinChannel(ws, cs, channel) {
    const ch = channel.replace('#', '').toLowerCase();
    if (ch === cs.username) cs.isModerator[ch] = true; // eigener Channel: immer volle Mod-Rechte
    if (!cs.channels.has(ch)) {
        log('CHANNEL', `Trete #${ch} bei`);
        await cs.tmiClient.join('#' + ch);
        cs.channels.add(ch);
        if (!cs.recentMessages[ch]) cs.recentMessages[ch] = [];
        if (!cs.filters.has(ch)) cs.filters.set(ch, []);
        startUserListInterval(ws, cs, ch);
        startPollPredictionInterval(ws, cs, ch);
        await new Promise(r => setTimeout(r, 1500));
        // Mehrere NAMES-Versuche kurz nacheinander statt nur einem: Twitch beantwortet die
        // manuelle Anfrage nicht immer zuverlässig, mit mehreren Versuchen steigt die Chance,
        // dass wenigstens einer durchkommt und Mod-/VIP-Präfixe liefert.
        [2000, 5000].forEach(delay => {
            setTimeout(() => {
                if (cs.tmiClient && cs.channels.has(ch)) cs.tmiClient.raw('NAMES #' + ch).catch(() => {});
            }, delay);
        });
    }

    // Roster-Baseline: Bis sie steht, gelten eingehende JOIN/PART-IRC-Events als "Vorstellung" der
    // schon anwesenden Chatter (Twitch schickt davon oft einen ganzen Schwall direkt nach dem
    // Verbinden) statt als echte Meldung - siehe tmiEvents.js. Gilt bei JEDEM (Neu-)Beitritt über
    // IRC, nicht nur beim allerersten Channel-Join dieser WS-Verbindung: Nach einem Reconnect baut
    // tmi.js eine komplett neue IRC-Verbindung auf, wodurch Twitch den Anwesenheits-Schwall erneut
    // schickt, unabhängig davon, ob der Channel serverseitig schon aus dem wiederhergestellten
    // Zustand bekannt war.
    //
    // Kombiniert bewusst zwei Signale, weil keins davon allein zuverlässig ist:
    // - eine Mindestwartezeit, da der IRC-Schwall bei größeren/aktiveren Channels länger dauern
    //   kann als der erste Roster-Abruf (der allein hätte die Baseline zu früh "bereit" gemeldet
    //   und dadurch noch mitten im Schwall eintreffende JOINs fälschlich als echt behandelt)
    // - das tatsächliche Ende des ersten Roster-Abrufs, da der bei langsamen Helix-Antworten
    //   wiederum länger als die Mindestwartezeit brauchen kann
    // Ein zusätzliches Sicherheitsnetz-Timeout verhindert, dass die Baseline für immer "nicht
    // bereit" bleibt, falls der Roster-Abruf nie durchläuft.
    if (!cs.rosterBaselineReady[ch]) {
        const minDelay = new Promise(resolve => setTimeout(resolve, 10000));
        const safetyTimeout = setTimeout(() => { cs.rosterBaselineReady[ch] = true; }, 20000);
        Promise.all([refreshUserList(ws, cs, ch).catch(() => {}), minDelay]).then(() => {
            clearTimeout(safetyTimeout);
            cs.rosterBaselineReady[ch] = true;
        });
    } else {
        // refreshUserList loggt Fehler bereits selbst und wirft nie erneut - der catch hier ist
        // nur ein Sicherheitsnetz, keine eigene Fehlermeldung nötig.
        refreshUserList(ws, cs, ch).catch(() => {});
    }

    let broadcasterId = cs.broadcasterIds[ch] || null;
    if (!broadcasterId) {
        try { const u = await fetchHelix(`users?login=${ch}`, cs.clientId, cs.appAccessToken); broadcasterId = u.data?.[0]?.id; } catch (e) { logWarn('CHANNEL', `Broadcaster-ID für #${ch} nicht ermittelbar: ${e.message}`); }
        if (broadcasterId) cs.broadcasterIds[ch] = broadcasterId;
    }
    if (broadcasterId) refreshPollAndPrediction(ws, cs, ch).catch(() => {});

    if (!cs.emoteCache) cs.emoteCache = {};
    if (!cs.emoteCache[ch]) {
        // FFZ/BTTV/7TV (channel + global) und die eigenen nutzbaren Twitch-Emotes parallel laden.
        // Letztere werden gebraucht, um Twitch-Emotes in SELBST gesendeten Nachrichten überhaupt
        // erkennen zu können (siehe tmiEvents.js) sowie für den Emote-Picker im Eingabefeld.
        const [thirdPartyEmotes, twitchUserEmotes] = await Promise.all([
            getEmotes(ch, cs.clientId, cs.appAccessToken, broadcasterId),
            broadcasterId
                ? fetchUserEmotes(cs.clientId, cs.oauthToken, cs.userId, broadcasterId).catch(e => {
                    // 401/403 hier bedeutet fast immer: der gespeicherte OAuth-Token stammt noch
                    // von vor der Einführung des Scopes user:read:emotes - der Token selbst wird
                    // beim erneuten Verbinden aus dem localStorage wiederverwendet und erhält
                    // NICHT automatisch neue Scopes. Nur ein bewusstes Aus- und wieder Einloggen
                    // (neuer OAuth-Consent) behebt das.
                    const hint = (e.status === 401 || e.status === 403)
                        ? ' - fehlender Scope "user:read:emotes"? Bitte einmal aus- und wieder einloggen, damit ein neuer Token mit diesem Scope ausgestellt wird.'
                        : '';
                    logWarn('EMOTES', `Eigene Twitch-Emotes für #${ch} fehlgeschlagen: ${e.message}${hint}`);
                    return [];
                })
                : Promise.resolve([]),
        ]);
        cs.emoteCache[ch] = { ...thirdPartyEmotes, twitch: twitchUserEmotes };
    }
    const emotes = cs.emoteCache[ch];

    if (broadcasterId && !cs.badgeCache.channels[broadcasterId]) {
        cs.badgeCache.channels[broadcasterId] = await loadChannelBadges(cs.clientId, cs.appAccessToken, broadcasterId);
    }

    const badgeMap = {
        global: cs.badgeCache.global,
        channel: broadcasterId ? cs.badgeCache.channels[broadcasterId] || {} : {},
    };

    log('CHANNEL', `#${ch} geladen (${cs.isModerator[ch] ? 'Mod-Rechte' : 'kein Mod'})`);
    sendToClient(ws, { type: 'channel_joined', channel: ch, emotes, badgeMap, broadcasterId });
}

async function handleLeaveChannel(ws, cs, channel) {
    const ch = channel.replace('#', '').toLowerCase();
    if (cs.tmiClient && cs.channels.has(ch)) {
        await cs.tmiClient.part('#' + ch);
        cs.channels.delete(ch);
        log('CHANNEL', `#${ch} verlassen`);
        delete cs.recentMessages[ch]; delete cs.filters[ch]; delete cs.userLists[ch]; delete cs.userBadges[ch]; delete cs.userDisplay[ch]; delete cs.userIdMap[ch];
        delete cs.userSubTier[ch]; delete cs.userPartner[ch]; delete cs.userStaff[ch];
        delete cs.broadcasterIds[ch]; delete cs.chattersInitialized[ch]; delete cs.isModerator[ch];
        if (cs.emoteCache) delete cs.emoteCache[ch];
        if (cs.nameIntervals[ch]) { clearInterval(cs.nameIntervals[ch]); delete cs.nameIntervals[ch]; }
        if (cs.timeoutTimers[ch]) { Object.values(cs.timeoutTimers[ch]).forEach(clearTimeout); delete cs.timeoutTimers[ch]; }
        delete cs.userTimeouts[ch];
        if (cs.pollPredictionIntervals[ch]) { clearInterval(cs.pollPredictionIntervals[ch]); delete cs.pollPredictionIntervals[ch]; }
        delete cs.activePolls[ch]; delete cs.activePredictions[ch]; delete cs.pollAccessLogged[ch]; delete cs.predictionAccessLogged[ch];
        delete cs.rosterBaselineReady[ch]; delete cs.rosterAccessLogged[ch]; delete cs.legacyFallbackLogged[ch];
        sendToClient(ws, { type: 'channel_left', channel: ch });
    }
}

async function handleSendMessage(ws, cs, msg) {
    const ch = msg.channel.replace('#', '').toLowerCase();
    if (!cs.tmiClient || !cs.channels.has(ch)) { sendToClient(ws, { type: 'error', message: 'Channel nicht gejoint.' }); return; }
    try { await cs.tmiClient.say('#' + ch, msg.message); } catch (e) { sendToClient(ws, { type: 'error', message: e.message }); }
}

// getUserInfo mit userId-Unterstützung
async function handleGetUserInfo(ws, cs, msg) {
    const { username, channel, userId } = msg;
    try {
        let user;
        // Bei Klicks auf @Erwähnungen im Chattext ist "username" der rohe, evtl. aus
        // Sonderzeichen bestehende Anzeigename - über die bekannte Roster-Zuordnung des
        // Channels auf den echten Login/userId auflösen, bevor Helix gefragt wird.
        const resolved = !userId ? resolveIdentity(cs, channel, username) : null;
        const effectiveUserId = userId || resolved?.userId;
        const effectiveLogin = resolved?.login || username;
        if (effectiveUserId) {
            const userData = await fetchHelix(`users?id=${effectiveUserId}`, cs.clientId, cs.appAccessToken);
            user = userData.data?.[0];
        } else if (effectiveLogin) {
            const userData = await fetchHelix(`users?login=${encodeURIComponent(effectiveLogin)}`, cs.clientId, cs.appAccessToken);
            user = userData.data?.[0];
        } else {
            sendToClient(ws, { type: 'user_info', username, channel, error: 'Kein Benutzer angegeben' });
            return;
        }

        if (!user) { sendToClient(ws, { type: 'user_info', username, channel, error: 'User nicht gefunden' }); return; }
        const accountCreated = new Date(user.created_at).toLocaleDateString('de-DE', { year: 'numeric', month: 'long', day: 'numeric' });
        const profileImageUrl = user.profile_image_url;
        const broadcasterType = user.broadcaster_type;
        const description = user.description;
        const viewCount = user.view_count;
        let accountType = 'Normal';
        if (broadcasterType === 'partner') accountType = 'Partner';
        else if (broadcasterType === 'affiliate') accountType = 'Affiliate';

        let followDuration = 'Unbekannt';
        let subscription = null;
        let banStatus = null;
        if (channel) {
            try {
                const chData = await fetchHelix(`users?login=${channel}`, cs.clientId, cs.appAccessToken);
                const broadcasterId = chData.data?.[0]?.id;
                if (broadcasterId) {
                    try {
                        const followData = await fetchHelix(`channels/followers?broadcaster_id=${broadcasterId}&user_id=${user.id}`, cs.clientId, cs.oauthToken);
                        if (followData.data?.[0]) {
                            const followedAt = new Date(followData.data[0].followed_at);
                            const days = Math.floor((Date.now() - followedAt.getTime()) / 86400000);
                            followDuration = `${followedAt.toLocaleDateString('de-DE')} (${days} Tage)`;
                        } else followDuration = 'Folgt nicht';
                    } catch (e) { followDuration = e.message.includes('401') ? 'Keine Berechtigung' : 'Fehler beim Abrufen'; }

                    try {
                        const subData = await fetchHelix(`subscriptions/user?broadcaster_id=${broadcasterId}&user_id=${user.id}`, cs.clientId, cs.oauthToken);
                        if (subData.data?.[0]) {
                            subscription = { tier: subData.data[0].tier, duration: subData.data[0].cumulative_months ? `${subData.data[0].cumulative_months} Monate` : 'Unbekannt' };
                        }
                    } catch (e) {}

                    // Ob der User im Channel aktuell gesperrt (Ban oder Timeout) ist - erfordert
                    // Mod-Rechte im Channel, daher bei fehlender Berechtigung einfach weglassen.
                    try {
                        const banData = await fetchHelix(`moderation/banned?broadcaster_id=${broadcasterId}&user_id=${user.id}`, cs.clientId, cs.oauthToken);
                        const b = banData.data?.[0];
                        banStatus = b
                            ? { banned: true, permanent: !b.expires_at, expiresAt: b.expires_at || null, reason: b.reason || '' }
                            : { banned: false };
                    } catch (e) {}
                }
            } catch (e) {}
        }

        // Badges aus userBadges holen
        let badges = [];
        const chLower = channel?.toLowerCase();
        if (chLower) {
            const badgeSet = cs.userBadges?.[chLower]?.get(user.login.toLowerCase());
            if (badgeSet) badges = [...badgeSet].map(b => ({ name: b, version: '1' }));
            else {
                const ulist = cs.userLists?.[chLower];
                if (ulist) {
                    const nameLower = user.login.toLowerCase();
                    if (nameLower === chLower) badges.push({ name: 'broadcaster', version: '1' });
                    else if (ulist.mods?.has(nameLower)) badges.push({ name: 'moderator', version: '1' });
                    else if (ulist.vips?.has(nameLower)) badges.push({ name: 'vip', version: '1' });
                }
            }
        }

        sendToClient(ws, {
            type: 'user_info',
            username: user.login, // Login-Name (ohne Sonderzeichen-Probleme)
            channel,
            userId: user.id,
            accountCreated,
            followDuration,
            badges,
            subscription,
            profileImageUrl,
            accountType,
            description,
            viewCount: viewCount || null,
            banStatus,
        });
    } catch (e) { logError('USERINFO', `Abruf für ${username || userId} fehlgeschlagen: ${e.message}`); sendToClient(ws, { type: 'user_info', username, channel, error: e.message }); }
}

async function handleModAction(ws, cs, msg) {
    const ch = msg.channel.toLowerCase();
    if (!cs.tmiClient) { sendToClient(ws, { type:'mod_result', success:false, error:'Nicht verbunden' }); return; }
    try {
        switch (msg.action) {
            case 'timeout': await cs.tmiClient.timeout(ch, msg.target, msg.duration||600); break;
            case 'ban': await cs.tmiClient.ban(ch, msg.target); break;
            case 'unban': await cs.tmiClient.unban(ch, msg.target); break;
            case 'deletemessage': await cs.tmiClient.deletemessage(ch, msg.messageId); break;
        }
        sendToClient(ws, { type:'mod_result', success:true, action:msg.action, target:msg.target });
        log('MOD', `${msg.action} in #${ch}${msg.target ? ` gegen @${msg.target}` : ''} (@${cs.username})`);
    } catch (e) {
        logError('MOD', `${msg.action} in #${ch} fehlgeschlagen: ${e.message}`);
        sendToClient(ws, { type:'mod_result', success:false, error:e.message });
    }
}

function handleLogout(ws, cs) {
    if (cs.tmiClient) { try { cs.tmiClient.disconnect(); } catch (e) {} }
    Object.values(cs.nameIntervals).forEach(clearInterval);
    cs.nameIntervals = {};
    Object.values(cs.timeoutTimers).forEach(timers => Object.values(timers).forEach(clearTimeout));
    cs.timeoutTimers = {}; cs.userTimeouts = {};
    Object.values(cs.pollPredictionIntervals).forEach(clearInterval);
    cs.pollPredictionIntervals = {}; cs.activePolls = {}; cs.activePredictions = {}; cs.pollAccessLogged = {}; cs.predictionAccessLogged = {};
    cs.rosterBaselineReady = {}; cs.rosterAccessLogged = {}; cs.legacyFallbackLogged = {};
    cs.tmiClient = null; cs.channels.clear(); cs.filters.clear(); cs.recentMessages = {};
    cs.userLists = {}; cs.userBadges = {}; cs.userDisplay = {}; cs.userIdMap = {}; cs.userSubTier = {}; cs.userPartner = {}; cs.userStaff = {}; cs.emoteCache = {};
    cs.broadcasterIds = {}; cs.chattersInitialized = {}; cs.isModerator = {};
}

module.exports = {
    handleCreatePoll, handleEndPoll, handleCreatePrediction, handleResolvePrediction,
    handleJoinChannel, handleLeaveChannel, handleSendMessage, handleGetUserInfo, handleModAction, handleLogout,
};
