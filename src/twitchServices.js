const { fetchHelix, fetchAllPages } = require('./helixClient');
const { logWarn } = require('./logger');

const botListCache = { data: new Set(), lastFetch: 0, ttl: 3600000 };

async function getBotList() {
    const now = Date.now();
    if (botListCache.data.size > 0 && (now - botListCache.lastFetch) < botListCache.ttl) return [...botListCache.data];
    try {
        const res = await fetch('https://api.twitchinsights.net/v1/bots/all');
        const data = await res.json();
        const bots = data.bots || data || [];
        const botNames = new Set();
        bots.forEach(entry => {
            if (Array.isArray(entry) && entry.length >= 1) botNames.add(entry[0].toLowerCase());
            else if (typeof entry === 'string') botNames.add(entry.toLowerCase());
        });
        botListCache.data = botNames;
        botListCache.lastFetch = now;
        return [...botNames];
    } catch (e) {
        logWarn('BOTLIST', `Abruf fehlgeschlagen, nutze Cache weiter: ${e.message}`);
        return [...botListCache.data];
    }
}

// Liefert das aktuelle Bot-Namen-Set als Referenz (kein Kopieren nötig, wird nur gelesen).
function getBotNamesSet() { return botListCache.data; }

async function loadChannelBadges(clientId, appToken, broadcasterId) {
    const map = {};
    try {
        const data = await fetchHelix(`chat/badges?broadcaster_id=${broadcasterId}`, clientId, appToken);
        (data.data || []).forEach(set => {
            map[set.set_id] = {};
            set.versions.forEach(v => { map[set.set_id][v.id] = v.image_url_1x; });
        });
    } catch (e) { logWarn('BADGES', `Channel-Badges (${broadcasterId}) fehlgeschlagen: ${e.message}`); }
    return map;
}

// Offizielle Helix-Endpunkte statt der von Twitch nicht zuverlässig unterstützten
// wiederholten IRC-NAMES-Anfragen. Erfordern, dass der eingeloggte User Mod/Broadcaster ist.
async function fetchAllChatters(clientId, oauthToken, broadcasterId, moderatorId) {
    return fetchAllPages(
        `chat/chatters?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}`,
        clientId, oauthToken,
        u => ({ login: u.user_login.toLowerCase(), displayName: u.user_name, userId: u.user_id })
    );
}

async function fetchModerators(clientId, oauthToken, broadcasterId) {
    const logins = await fetchAllPages(`moderation/moderators?broadcaster_id=${broadcasterId}`, clientId, oauthToken, m => m.user_login.toLowerCase());
    return new Set(logins);
}

async function fetchVips(clientId, oauthToken, broadcasterId) {
    const logins = await fetchAllPages(`channels/vips?broadcaster_id=${broadcasterId}`, clientId, oauthToken, v => v.user_login.toLowerCase());
    return new Set(logins);
}

// Undokumentierter, unauthentifizierter Legacy-Endpunkt, den früher auch Twitch selbst für die
// öffentliche Chatterliste genutzt hat. Kein Ersatz für Helix, kann jederzeit wegfallen/leer sein -
// wird daher nur als bestmöglicher Zusatzversuch genutzt, wenn Helix mangels Mod-Rechten nicht geht.
async function fetchLegacyChatters(channel) {
    const res = await fetch(`https://tmi.twitch.tv/group/user/${channel}/chatters`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`Legacy-Chatters-Endpunkt (${res.status})`);
    const data = await res.json();
    if (!data.chatters) throw new Error('Legacy-Chatters-Endpunkt: unerwartetes Format');
    return data.chatters;
}

// ========== POLLS & PREDICTIONS ==========
// Werden mit dem Token des eingeloggten Users (Broadcaster ODER Moderator) versucht - Twitch
// selbst entscheidet über den Statuscode, ob das erlaubt ist. Stimmabgabe/Wetten durch Zuschauer
// ist NICHT über eine öffentliche Twitch-API möglich (nur über Twitchs eigene Clients), daher
// gibt es hier bewusst keine Vote-Funktion, nur Anzeige + Verwaltung.
async function fetchActivePoll(clientId, oauthToken, broadcasterId) {
    const data = await fetchHelix(`polls?broadcaster_id=${broadcasterId}&first=1`, clientId, oauthToken);
    return data.data?.[0] || null;
}
async function createPollHelix(clientId, oauthToken, broadcasterId, title, choices, duration) {
    const data = await fetchHelix('polls', clientId, oauthToken, {
        method: 'POST',
        body: { broadcaster_id: broadcasterId, title, choices: choices.map(c => ({ title: c })), duration },
    });
    return data.data?.[0];
}
async function patchPollHelix(clientId, oauthToken, broadcasterId, id, status) {
    const data = await fetchHelix('polls', clientId, oauthToken, {
        method: 'PATCH',
        body: { broadcaster_id: broadcasterId, id, status },
    });
    return data.data?.[0];
}
async function fetchActivePrediction(clientId, oauthToken, broadcasterId) {
    const data = await fetchHelix(`predictions?broadcaster_id=${broadcasterId}&first=1`, clientId, oauthToken);
    return data.data?.[0] || null;
}
async function createPredictionHelix(clientId, oauthToken, broadcasterId, title, outcomes, predictionWindow) {
    const data = await fetchHelix('predictions', clientId, oauthToken, {
        method: 'POST',
        body: { broadcaster_id: broadcasterId, title, outcomes: outcomes.map(o => ({ title: o })), prediction_window: predictionWindow },
    });
    return data.data?.[0];
}
async function patchPredictionHelix(clientId, oauthToken, broadcasterId, id, status, winningOutcomeId) {
    const body = { broadcaster_id: broadcasterId, id, status };
    if (winningOutcomeId) body.winning_outcome_id = winningOutcomeId;
    const data = await fetchHelix('predictions', clientId, oauthToken, { method: 'PATCH', body });
    return data.data?.[0];
}

async function getEmotes(channel, clientId, appAccessToken) {
    const emotes = { ffz: [], bttv: [], seventv: [] };
    try {
        // FFZ
        try {
            const ffzRes = await fetch(`https://api.frankerfacez.com/v1/room/${channel}`);
            if (ffzRes.ok) {
                const ffzData = await ffzRes.json();
                const sets = [];
                if (ffzData.room?.set) sets.push(ffzData.room.set);
                if (ffzData.room?.sets) sets.push(...Object.keys(ffzData.room.sets));
                if (ffzData.sets) sets.forEach(setId => {
                    const set = ffzData.sets[setId];
                    if (set?.emoticons) set.emoticons.forEach(e => {
                        emotes.ffz.push({
                            code: e.name,
                            url: e.urls?.['1'] || e.urls?.['2'] || `https://cdn.frankerfacez.com/emoticon/${e.id}/1`,
                            name: e.name
                        });
                    });
                });
            }
        } catch (e) {}

        // BTTV
        try {
            const userData = await fetchHelix(`users?login=${channel}`, clientId, appAccessToken);
            const userId = userData.data?.[0]?.id;
            if (userId) {
                const bttvRes = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${userId}`);
                if (bttvRes.ok) {
                    const bttvData = await bttvRes.json();
                    (bttvData.channelEmotes || []).forEach(e => emotes.bttv.push({ code: e.code, url: `https://cdn.betterttv.net/emote/${e.id}/1x`, name: e.code }));
                    (bttvData.sharedEmotes || []).forEach(e => emotes.bttv.push({ code: e.code, url: `https://cdn.betterttv.net/emote/${e.id}/1x`, name: e.code }));
                }
            }
        } catch (e) {}

        // 7TV
        try {
            const userData2 = await fetchHelix(`users?login=${channel}`, clientId, appAccessToken);
            const userId2 = userData2.data?.[0]?.id;
            if (userId2) {
                const stvRes = await fetch(`https://7tv.io/v3/users/twitch/${userId2}`);
                if (stvRes.ok) {
                    const stvData = await stvRes.json();
                    const emoteSet = stvData.emote_set?.emotes || [];
                    emoteSet.forEach(e => {
                        const hostUrl = e.data?.host?.url;
                        const fileName = e.data?.host?.files?.[0]?.name;
                        let url;
                        if (hostUrl && fileName) url = `${hostUrl}/${fileName}`;
                        else if (hostUrl) url = `${hostUrl}/${e.id}/1x.webp`;
                        else url = `https://cdn.7tv.app/emote/${e.id}/1x.webp`;
                        emotes.seventv.push({ code: e.name, url, name: e.name });
                    });
                }
            }
        } catch (e) {}
    } catch (e) {
        logWarn('EMOTES', `Abruf für #${channel} fehlgeschlagen: ${e.message}`);
    }
    return emotes;
}

module.exports = {
    getBotList, getBotNamesSet, loadChannelBadges,
    fetchAllChatters, fetchModerators, fetchVips, fetchLegacyChatters,
    fetchActivePoll, createPollHelix, patchPollHelix,
    fetchActivePrediction, createPredictionHelix, patchPredictionHelix,
    getEmotes,
};
