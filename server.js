require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const tmi = require('tmi.js');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const REDIRECT_URI = process.env.TWITCH_REDIRECT_URI;

// ========== LOGGING ==========
// Bewusst schlank gehalten: nur wichtige Lebenszyklus-Ereignisse (Verbindung, Login, Channel-
// Beitritt, Mod-Aktionen, Polls/Predictions, Fehler) - keine einzelnen Chatnachrichten o.ä.,
// sonst läuft das Log bei aktiver Nutzung sofort über.
function timestamp() { return new Date().toLocaleTimeString('de-DE', { hour12: false }); }
function log(category, message) { console.log(`[${timestamp()}] [${category}] ${message}`); }
function logWarn(category, message) { console.warn(`[${timestamp()}] [${category}] ⚠️ ${message}`); }
function logError(category, message) { console.error(`[${timestamp()}] [${category}] ❌ ${message}`); }

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    logError('SERVER', 'TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET und TWITCH_REDIRECT_URI müssen in der .env-Datei gesetzt sein.');
    process.exit(1);
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const botListCache = { data: new Set(), lastFetch: 0, ttl: 3600000 };

// ========== HELFER ==========
// Wandelt das Twitch-"emotes"-Tag (id -> Positionen) in die vom Client erwartete Liste um.
// Wird für reguläre Chatnachrichten UND für USERNOTICE-Texte (Ankündigungen, Sub-/Resub-/Cheer-
// Nachrichten) gebraucht, die genauso Twitch-Emotes enthalten können.
function parseTwitchEmoteTags(emotesTag, message) {
    const result = [];
    if (emotesTag) {
        Object.entries(emotesTag).forEach(([id, positions]) => {
            positions.forEach(pos => {
                const [s, e] = pos.split('-').map(Number);
                result.push({ id, start: s, end: e + 1, name: message.substring(s, e + 1) });
            });
        });
    }
    return result;
}

async function fetchHelix(endpoint, clientId, accessToken, options = {}) {
    const res = await fetch(`https://api.twitch.tv/helix/${endpoint}`, {
        method: options.method || 'GET',
        headers: {
            'Client-ID': clientId,
            'Authorization': `Bearer ${accessToken}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text();
        const err = new Error(`Helix API Fehler (${res.status}): ${text}`);
        err.status = res.status;
        throw err;
    }
    if (res.status === 204) return null;
    return res.json();
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

async function getAppAccessToken(clientId, clientSecret) {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
    });
    const data = await res.json();
    if (!data.access_token) throw new Error('Konnte App Access Token nicht erhalten: ' + JSON.stringify(data));
    return data.access_token;
}

async function validateToken(oauthToken) {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { 'Authorization': `Bearer ${oauthToken}` } });
    if (!res.ok) throw new Error('Token ungültig');
    return res.json();
}

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
async function fetchAllPages(endpoint, clientId, accessToken, mapFn) {
    const results = [];
    let cursor = null;
    do {
        const sep = endpoint.includes('?') ? '&' : '?';
        const url = `${endpoint}${sep}first=100${cursor ? `&after=${cursor}` : ''}`;
        const data = await fetchHelix(url, clientId, accessToken);
        (data.data || []).forEach(item => results.push(mapFn(item)));
        cursor = data.pagination?.cursor || null;
    } while (cursor);
    return results;
}

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

function parseNamesList(names, channelName) {
    const broadcaster = channelName.toLowerCase();
    const mods = new Set();
    const vips = new Set();
    const users = new Set();
    names.forEach(name => {
        let cleanName = name.replace(/^[@+]/, '').toLowerCase();
        if (cleanName === broadcaster) return;
        if (name.startsWith('@')) mods.add(cleanName);
        else if (name.startsWith('+')) vips.add(cleanName);
        else users.add(cleanName);
    });
    return { broadcaster, mods, vips, users };
}

// Fügt eine (potenziell unvollständige) Roster-Momentaufnahme in die bestehende Liste ein,
// statt sie zu ersetzen - wichtig für alle Quellen, die ohne Mod-Rechte nur einen Teil der
// tatsächlichen Chatter liefern (NAMES, Legacy-Fallback). Ein neuer, höherwertiger Rollen-Fund
// (mod/vip) überschreibt eine schwächere alte Einstufung; ein reines Fehlen in der neuen Liste
// entfernt niemanden.
function mergeUserList(cs, ch, incoming) {
    if (!cs.userLists[ch]) cs.userLists[ch] = { broadcaster: ch, mods: new Set(), vips: new Set(), users: new Set() };
    const ulist = cs.userLists[ch];
    incoming.mods.forEach(u => { ulist.mods.add(u); ulist.vips.delete(u); ulist.users.delete(u); });
    incoming.vips.forEach(u => { if (!ulist.mods.has(u)) { ulist.vips.add(u); ulist.users.delete(u); } });
    incoming.users.forEach(u => { if (!ulist.mods.has(u) && !ulist.vips.has(u)) ulist.users.add(u); });
}

// Ordnet einen Login genau einer Rolle zu (verschiebt ihn zwischen mods/vips/users, falls er
// bereits anders einsortiert war) - Grundlage dafür, dass Beförderungen/Degradierungen per Chat-
// Badge oder Live-Event auch bei bereits bekannten Usern ankommen, statt nur beim Ersteintrag.
function setUserRole(cs, ch, login, role) {
    if (login === ch) return; // der Broadcaster wird separat geführt, nie in mods/vips/users
    if (!cs.userLists[ch]) cs.userLists[ch] = { broadcaster: ch, mods: new Set(), vips: new Set(), users: new Set() };
    const ulist = cs.userLists[ch];
    const current = ulist.mods.has(login) ? 'mod' : ulist.vips.has(login) ? 'vip' : ulist.users.has(login) ? 'user' : null;
    if (current === role) return false;
    ulist.mods.delete(login); ulist.vips.delete(login); ulist.users.delete(login);
    if (role === 'mod') ulist.mods.add(login);
    else if (role === 'vip') ulist.vips.add(login);
    else ulist.users.add(login);
    return true;
}

// Erweiterte User-Objekte mit userId
function buildUserObjects(roleSet, role, userBadgesMap, userDisplayMap, userIdMap, botNames, userSubTierMap, userPartnerMap, userStaffMap, userTimeoutMap) {
    return [...roleSet].map(username => {
        const badges = userBadgesMap?.get(username) || new Set();
        const isBot = botNames.has(username);
        const isPartner = badges.has('partner') || (userPartnerMap?.get(username) || false);
        const isStaff = badges.has('staff') || (userStaffMap?.get(username) || false);
        const subTier = userSubTierMap?.get(username) || 0;
        const displayName = userDisplayMap?.get(username) || username;
        const userId = userIdMap?.get(username) || '';
        const rawExpiry = userTimeoutMap?.get(username);
        const timeoutUntil = (rawExpiry && rawExpiry > Date.now()) ? rawExpiry : null;
        return { username, displayName, userId, role, isBot, isPartner, isStaff, subTier, timeoutUntil };
    });
}

function prepareUserList(userList, channel, userBadgesMap, userDisplayMap, userIdMap, botNames, userSubTierMap, userPartnerMap, userStaffMap, userTimeoutMap) {
    const broadcasterObj = {
        username: userList.broadcaster,
        displayName: userDisplayMap?.get(userList.broadcaster) || userList.broadcaster,
        userId: userIdMap?.get(userList.broadcaster) || '',
        role: 'broadcaster',
        isBot: botNames.has(userList.broadcaster),
        isPartner: (userBadgesMap?.get(userList.broadcaster) || new Set()).has('partner') || (userPartnerMap?.get(userList.broadcaster) || false),
        isStaff: (userBadgesMap?.get(userList.broadcaster) || new Set()).has('staff') || (userStaffMap?.get(userList.broadcaster) || false),
        subTier: 0,
        timeoutUntil: null, // der Broadcaster kann nicht getimeoutet werden
    };
    const mods = buildUserObjects(userList.mods, 'mod', userBadgesMap, userDisplayMap, userIdMap, botNames, userSubTierMap, userPartnerMap, userStaffMap, userTimeoutMap);
    const vips = buildUserObjects(userList.vips, 'vip', userBadgesMap, userDisplayMap, userIdMap, botNames, userSubTierMap, userPartnerMap, userStaffMap, userTimeoutMap);
    const users = buildUserObjects(userList.users, 'user', userBadgesMap, userDisplayMap, userIdMap, botNames, userSubTierMap, userPartnerMap, userStaffMap, userTimeoutMap);
    return { broadcaster: broadcasterObj, mods, vips, users };
}

// Bündelt den userList-Aufbau + den "canModerate"-Status (ob der eingeloggte User in diesem
// Channel überhaupt Mod-Rechte hat), damit der Client Mod-Buttons nur zeigt, wenn sie auch
// funktionieren würden.
function sendUserListUpdate(ws, cs, ch) {
    if (!cs.userLists[ch]) return;
    sendToClient(ws, {
        type: 'user_list_update',
        channel: ch,
        userList: prepareUserList(cs.userLists[ch], ch, cs.userBadges[ch], cs.userDisplay[ch], cs.userIdMap[ch], botListCache.data, cs.userSubTier[ch], cs.userPartner[ch], cs.userStaff[ch], cs.userTimeouts[ch]),
        canModerate: !!cs.isModerator[ch],
    });
}

// Markiert einen User als (nicht mehr) getimeoutet und plant automatisch den Zeitpunkt ein, zu
// dem die Markierung wieder verschwinden soll - ohne dass dafür eine weitere Chat-Nachricht
// nötig ist. Ein Ban entfernt den User stattdessen komplett aus der Liste (siehe 'ban'-Handler),
// da gebannte User den Chat sofort verlassen und ihn nicht erneut betreten können.
function markUserTimedOut(ws, cs, ch, login, durationSeconds) {
    if (!cs.userTimeouts[ch]) cs.userTimeouts[ch] = new Map();
    if (!cs.timeoutTimers[ch]) cs.timeoutTimers[ch] = {};
    if (cs.timeoutTimers[ch][login]) { clearTimeout(cs.timeoutTimers[ch][login]); delete cs.timeoutTimers[ch][login]; }
    if (durationSeconds > 0) {
        cs.userTimeouts[ch].set(login, Date.now() + durationSeconds * 1000);
        cs.timeoutTimers[ch][login] = setTimeout(() => {
            cs.userTimeouts[ch]?.delete(login);
            delete cs.timeoutTimers[ch]?.[login];
            sendUserListUpdate(ws, cs, ch);
        }, durationSeconds * 1000);
    } else {
        cs.userTimeouts[ch].delete(login);
    }
    sendUserListUpdate(ws, cs, ch);
}

// Löst einen Namen (bekannter Login ODER Anzeigename, z.B. aus einer @Erwähnung) auf den
// tatsächlichen Twitch-Login + userId auf, damit Mod-Aktionen/User-Infos nie den (ggf.
// abweichenden, z.B. japanischen) Anzeigenamen statt des echten Logins verwenden.
function resolveIdentity(cs, channel, name) {
    if (!channel || !name) return null;
    const ch = channel.toLowerCase();
    const nameLower = name.toLowerCase();
    if (cs.userIdMap[ch]?.has(nameLower) || cs.userDisplay[ch]?.has(nameLower)) {
        return { login: nameLower, userId: cs.userIdMap[ch]?.get(nameLower) || null };
    }
    const displayMap = cs.userDisplay[ch];
    if (displayMap) {
        for (const [login, display] of displayMap) {
            if (display && display.toLowerCase() === nameLower) {
                return { login, userId: cs.userIdMap[ch]?.get(login) || null };
            }
        }
    }
    return null;
}

// ========== PERSISTENTER USER-STATE ==========
const userStates = new Map(); // userId -> gesicherter Zustand

function cloneStateForNewLogin(oldState, newClientState) {
    if (!oldState) return;
    newClientState.channels = oldState.channels ? new Set(oldState.channels) : new Set();
    newClientState.filters = oldState.filters ? new Map(oldState.filters) : new Map();
    newClientState.recentMessages = oldState.recentMessages || {};
    newClientState.badgeCache = oldState.badgeCache || { global: {}, channels: {} };
    newClientState.userLists = oldState.userLists || {};
    newClientState.userBadges = oldState.userBadges || {};
    newClientState.userDisplay = oldState.userDisplay || {};
    newClientState.userIdMap = oldState.userIdMap || {};
    newClientState.userSubTier = oldState.userSubTier || {};
    newClientState.userPartner = oldState.userPartner || {};
    newClientState.userStaff = oldState.userStaff || {};
    newClientState.broadcasterIds = oldState.broadcasterIds || {};
    newClientState.chattersInitialized = oldState.chattersInitialized || {};
    newClientState.isModerator = oldState.isModerator || {};
    // Timer-Handles können nicht übernommen werden - die Timeout-Daten selbst schon, die
    // zugehörigen Ablauf-Timer werden nach dem Verbindungsaufbau neu aufgesetzt.
    newClientState.userTimeouts = oldState.userTimeouts || {};
    newClientState.timeoutTimers = {};
}

const clients = new Map();
const oauthStates = new Map(); // state -> { ws, createdAt }
const OAUTH_STATE_TTL = 10 * 60 * 1000; // 10 Minuten
const USER_STATE_TTL = 24 * 60 * 60 * 1000; // 24 Stunden

setInterval(() => {
    const now = Date.now();
    for (const [state, entry] of oauthStates) {
        if (now - entry.createdAt > OAUTH_STATE_TTL) oauthStates.delete(state);
    }
    for (const [userId, entry] of userStates) {
        if (now - entry.savedAt > USER_STATE_TTL) userStates.delete(userId);
    }
}, 15 * 60 * 1000).unref();

app.get('/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Fehlende Parameter.');
    const entry = oauthStates.get(state);
    const ws = entry?.ws;
    if (!ws || ws.readyState !== ws.OPEN) {
        oauthStates.delete(state);
        return res.status(400).send('Ungültiger Status oder Verbindung geschlossen.');
    }
    try {
        const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code,
                grant_type: 'authorization_code', redirect_uri: REDIRECT_URI,
            }),
        });
        const tokenData = await tokenRes.json();
        if (tokenData.access_token) {
            sendToClient(ws, { type: 'oauth_token', token: tokenData.access_token });
            res.send('<html><body><script>window.close();</script>Login erfolgreich – Fenster kann geschlossen werden.</body></html>');
        } else {
            logError('AUTH', `OAuth-Token-Austausch fehlgeschlagen: ${JSON.stringify(tokenData)}`);
            res.status(400).send('Token-Austausch fehlgeschlagen: ' + JSON.stringify(tokenData));
        }
    } catch (e) {
        logError('AUTH', `OAuth-Token-Austausch fehlgeschlagen: ${e.message}`);
        res.status(500).send('Fehler beim Token-Austausch: ' + e.message);
    } finally {
        oauthStates.delete(state);
    }
});

wss.on('connection', (ws) => {
    log('WS', `Neue Verbindung (${clients.size + 1} aktiv)`);
    const clientState = {
        tmiClient: null,
        oauthToken: null,
        clientId: null,
        clientSecret: null,
        appAccessToken: null,
        userId: null,
        username: null,
        channels: new Set(),
        filters: new Map(),
        recentMessages: {},
        badgeCache: { global: {}, channels: {} },
        userLists: {},
        userBadges: {},
        userDisplay: {},
        userIdMap: {},
        userSubTier: {},
        userPartner: {},
        userStaff: {},
        nameIntervals: {},
        broadcasterIds: {},
        chattersInitialized: {},
        isModerator: {},
        userTimeouts: {},
        timeoutTimers: {},
        emoteCache: {},
        activePolls: {},
        activePredictions: {},
        pollPredictionIntervals: {},
        pollAccessLogged: {},
        predictionAccessLogged: {},
        joinSettling: {},
        rosterAccessLogged: {},
        legacyFallbackLogged: {},
    };
    clients.set(ws, clientState);

    ws.on('message', async (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        try {
            switch (msg.type) {
                case 'login_oauth': await handleOAuthLogin(ws, clientState, msg.token); break;
                case 'start_oauth': handleStartOAuth(ws); break;
                case 'get_mod_channels': sendToClient(ws, { type: 'mod_channels', channels: [] }); break;
                case 'join_channel': await handleJoinChannel(ws, clientState, msg.channel); break;
                case 'leave_channel': await handleLeaveChannel(ws, clientState, msg.channel); break;
                case 'send_message': await handleSendMessage(ws, clientState, msg); break;
                case 'get_user_info': await handleGetUserInfo(ws, clientState, msg); break;
                case 'mod_action': await handleModAction(ws, clientState, msg); break;
                case 'create_poll': await handleCreatePoll(ws, clientState, msg); break;
                case 'end_poll': await handleEndPoll(ws, clientState, msg); break;
                case 'create_prediction': await handleCreatePrediction(ws, clientState, msg); break;
                case 'resolve_prediction': await handleResolvePrediction(ws, clientState, msg); break;
                case 'update_filter': clientState.filters.set(msg.channel.toLowerCase(), msg.words || []); break;
                case 'logout': handleLogout(ws, clientState); break;
            }
        } catch (e) {
            logError('WS', `Fehler bei "${msg?.type}": ${e.message}`);
            sendToClient(ws, { type: 'error', message: e.message });
        }
    });

    ws.on('close', () => {
        if (clientState.userId) {
            const stateCopy = {
                channels: new Set(clientState.channels),
                filters: new Map(clientState.filters),
                recentMessages: { ...clientState.recentMessages },
                badgeCache: clientState.badgeCache,
                userLists: clientState.userLists,
                userBadges: clientState.userBadges,
                userDisplay: clientState.userDisplay,
                userIdMap: clientState.userIdMap,
                userSubTier: clientState.userSubTier,
                userPartner: clientState.userPartner,
                userStaff: clientState.userStaff,
                broadcasterIds: clientState.broadcasterIds,
                chattersInitialized: clientState.chattersInitialized,
                isModerator: clientState.isModerator,
                userTimeouts: clientState.userTimeouts,
                savedAt: Date.now(),
            };
            userStates.set(clientState.userId, stateCopy);
        }
        handleLogout(ws, clientState);
        clients.delete(ws);
        log('WS', `Verbindung geschlossen${clientState.username ? ` (@${clientState.username})` : ''} (${clients.size} aktiv)`);
    });
});

function sendToClient(ws, data) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data)); }

function handleStartOAuth(ws) {
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.set(state, { ws, createdAt: Date.now() });
    const scopes = ['chat:read','chat:edit','channel:moderate','moderation:read','channel:read:subscriptions','moderator:read:followers','moderator:read:chatters','channel:read:vips','channel:read:polls','channel:manage:polls','channel:read:predictions','channel:manage:predictions'];
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scopes.join(' '))}&state=${state}`;
    sendToClient(ws, { type: 'oauth_url', url });
}

async function handleOAuthLogin(ws, cs, token) {
    try {
        await performLogin(ws, cs, token);
    } catch (e) {
        logError('AUTH', `Login fehlgeschlagen: ${e.message}`);
        sendToClient(ws, { type: 'login_error', error: e.message });
    }
}

function getSubPlanText(plan) {
    if (plan === '1000') return 'Tier 1';
    if (plan === '2000') return 'Tier 2';
    if (plan === '3000') return 'Tier 3';
    return plan || 'Prime';
}

function getSubTierNumber(plan) {
    if (plan === '3000') return 3;
    if (plan === '2000') return 2;
    return 1; // '1000' oder Prime
}

function setUserSubTier(cs, ch, login, tier) {
    if (!cs.userSubTier[ch]) cs.userSubTier[ch] = new Map();
    cs.userSubTier[ch].set(login, tier);
}

async function performLogin(ws, cs, oauthToken) {
    const cleanToken = oauthToken.replace(/^oauth:/, '');
    cs.oauthToken = cleanToken;
    cs.clientId = CLIENT_ID;
    cs.clientSecret = CLIENT_SECRET;

    const validation = await validateToken(cleanToken);
    cs.userId = validation.user_id;
    cs.username = validation.login;
    log('AUTH', `Login erfolgreich: @${cs.username} (${cs.userId})`);

    // Vorherigen State wiederherstellen, falls vorhanden
    const oldState = userStates.get(cs.userId);
    if (oldState) {
        cloneStateForNewLogin(oldState, cs);
        userStates.delete(cs.userId);
    }

    cs.appAccessToken = await getAppAccessToken(cs.clientId, cs.clientSecret);

    // Globale Badges laden
    cs.badgeCache.global = {};
    try {
        const globalBadgeData = await fetchHelix('chat/badges/global', cs.clientId, cs.appAccessToken);
        (globalBadgeData.data || []).forEach(set => {
            cs.badgeCache.global[set.set_id] = {};
            set.versions.forEach(v => { cs.badgeCache.global[set.set_id][v.id] = v.image_url_1x; });
        });
    } catch (e) { logWarn('BADGES', `Globale Badges fehlgeschlagen: ${e.message}`); }

    // tmi.js Client mit membership Capability
    const tmiClient = new tmi.Client({
        options: { clientId: cs.clientId, capabilities: ['twitch.tv/tags','twitch.tv/commands','twitch.tv/membership'] },
        connection: { reconnect: true, secure: true },
        identity: { username: cs.username, password: 'oauth:' + cleanToken },
        channels: [...cs.channels], // bereits gespeicherte Channels direkt joinen
    });
    cs.tmiClient = tmiClient;

    // Nachrichten
    tmiClient.on('message', (channel, tags, message, self) => {
        const ch = channel.replace('#', '');
        const timestamp = Date.now();

        // Für selbst gesendete Nachrichten baut tmi.js dieses Event lokal aus dem zwischen-
        // gespeicherten USERSTATE zusammen (Twitch echot PRIVMSGs nicht zurück) - das enthält
        // i.d.R. weder Login-Name noch User-ID, beides kennen wir aber ohnehin schon aus cs.
        if (self) {
            tags.username = cs.username;
            tags['user-id'] = cs.userId;
            tags['display-name'] = tags['display-name'] || cs.username;
        }

        if (!cs.recentMessages[ch]) cs.recentMessages[ch] = [];
        const twitchEmotes = parseTwitchEmoteTags(tags.emotes, message);

        const badges = [];
        if (tags.badges) Object.entries(tags.badges).forEach(([name, version]) => badges.push({ name, version }));

        const userId = tags['user-id'];
        const displayName = tags['display-name'] || tags.username;
        // Immer den echten (ASCII-)Login als Schlüssel verwenden, NICHT den Anzeigenamen -
        // der kann z.B. bei japanischen/koreanischen Namen völlig anders aussehen als der Login.
        const usernameLower = tags.username.toLowerCase();

        cs.recentMessages[ch].push({
            username: displayName, login: usernameLower, message, timestamp, userId,
            emotes: twitchEmotes, badges, color: tags.color || getReadableColor(tags.username),
        });
        if (cs.recentMessages[ch].length > 200) cs.recentMessages[ch].shift();

        if (!cs.userLists[ch]) cs.userLists[ch] = { broadcaster: ch, mods: new Set(), vips: new Set(), users: new Set() };
        if (!cs.userBadges[ch]) cs.userBadges[ch] = new Map();
        if (!cs.userDisplay[ch]) cs.userDisplay[ch] = new Map();
        if (!cs.userIdMap[ch]) cs.userIdMap[ch] = new Map();
        if (!cs.userSubTier[ch]) cs.userSubTier[ch] = new Map();
        if (!cs.userPartner[ch]) cs.userPartner[ch] = new Map();
        if (!cs.userStaff[ch]) cs.userStaff[ch] = new Map();

        cs.userBadges[ch].set(usernameLower, new Set(badges.map(b => b.name)));
        cs.userDisplay[ch].set(usernameLower, displayName);
        cs.userIdMap[ch].set(usernameLower, userId);

        const subBadge = badges.find(b => b.name === 'subscriber');
        if (subBadge) {
            const version = subBadge.version;
            let tier = 1;
            if (version === '3002') tier = 2;
            else if (version === '3003') tier = 3;
            cs.userSubTier[ch].set(usernameLower, tier);
        }
        cs.userPartner[ch].set(usernameLower, badges.some(b => b.name === 'partner'));
        cs.userStaff[ch].set(usernameLower, badges.some(b => b.name === 'staff'));

        const isMod = badges.some(b => b.name === 'moderator' || b.name === 'lead_moderator');
        const isVip = badges.some(b => b.name === 'vip');
        // setUserRole ordnet auch bereits bekannte User neu ein - so kommt eine frische
        // Mod-/VIP-Ernennung (an ihrem aktualisierten Badge erkennbar) unmittelbar mit der
        // nächsten Nachricht dieses Users in der Liste an, statt für immer auf "user" zu bleiben.
        if (setUserRole(cs, ch, usernameLower, isMod ? 'mod' : isVip ? 'vip' : 'user')) {
            sendUserListUpdate(ws, cs, ch);
        }

        sendToClient(ws, {
            type: 'chat_message',
            id: tags.id,
            channel: ch,
            username: displayName,
            login: usernameLower,
            userId,
            color: tags.color || getReadableColor(tags.username),
            badges,
            message,
            emotes: twitchEmotes,
            timestamp
        });
    });

    // Gelöschte Nachrichten (egal ob durch uns, einen anderen Mod oder Automod gelöscht).
    // "content" wird bewusst UNESCAPED an den Client geschickt: renderMessageWithEmotes() dort
    // escaped/linkifiziert/emote-ifiziert denselben Text wie bei normalen Chatnachrichten
    // (einheitliche Darstellung + weiterhin XSS-sicher, da dort clientseitig alles außer
    // erkannten Link-/Emote-Tokens durch escapeHtml() läuft).
    tmiClient.on('messagedeleted', (channel, username, deletedMessage, userstate) => {
        const ch = channel.replace('#', '');
        sendToClient(ws, { type: 'chat_event', channel: ch, text: `🗑️ Nachricht von {sender} wurde gelöscht: "{content}"`, sender: username, content: deletedMessage, timestamp: Date.now() });
        sendToClient(ws, { type: 'message_deleted', channel: ch, messageId: userstate['target-msg-id'] });
    });

    // Ban / Timeout
    // Ein Ban entfernt den User sofort und dauerhaft aus dem Chat (er kann den Channel nicht
    // erneut betreten) - deshalb genügt das Entfernen aus der Liste, ein Tag wäre hier nie sichtbar.
    tmiClient.on('ban', (channel, username, reason, userstate) => {
        const ch = channel.replace('#', '');
        const lower = username.toLowerCase();
        const ulist = cs.userLists[ch];
        if (ulist) {
            ulist.mods.delete(lower); ulist.vips.delete(lower); ulist.users.delete(lower);
        }
        // Ein eventuell noch laufender Timeout ist mit dem Ban hinfällig
        if (cs.timeoutTimers[ch]?.[lower]) { clearTimeout(cs.timeoutTimers[ch][lower]); delete cs.timeoutTimers[ch][lower]; }
        cs.userTimeouts[ch]?.delete(lower);
        sendUserListUpdate(ws, cs, ch);
        sendToClient(ws, { type: 'chat_event', channel: ch, text: `🚫 {receiver} wurde gebannt${reason ? ` (Grund: {content})` : ''}`, receiver: username, content: reason || undefined, timestamp: Date.now() });
    });

    // Ein Timeout entfernt den User NICHT aus dem Chat (er bleibt anwesend, kann nur nicht
    // schreiben) - er bleibt daher in der Liste, wird aber bis zum Ablauf mit einem Tag markiert.
    tmiClient.on('timeout', (channel, username, reason, duration, userstate) => {
        const ch = channel.replace('#', '');
        const lower = username.toLowerCase();
        markUserTimedOut(ws, cs, ch, lower, duration || 0);
        const mins = Math.floor((duration || 0) / 60);
        sendToClient(ws, { type: 'chat_event', channel: ch, text: `⏱️ {receiver} erhielt einen Timeout (${mins} min)${reason ? ` Grund: {content}` : ''}`, receiver: username, content: reason || undefined, timestamp: Date.now() });
    });

    // Announcement
    // WICHTIG: tmi.js emittiert USERNOTICE-Typen ohne eigenes Event (z.B. "announcement") als
    // `usernotice(msgid, channel, tags, message)` - NICHT (channel, tags, message)! Mit der
    // falschen Parameterreihenfolge landet die Channel-ID im "tags"-Parameter und
    // tags['msg-id'] ist dadurch immer undefined, weshalb Ankündigungen nie erkannt wurden.
    tmiClient.on('usernotice', (msgid, channel, tags, message) => {
        if (msgid === 'announcement') {
            const ch = channel.replace('#', '');
            const color = (tags['msg-param-color'] || 'primary').toLowerCase();
            sendToClient(ws, { type: 'chat_event', channel: ch, text: `📢 {sender} kündigt an: {content}`, sender: tags['display-name'], content: message, emotes: parseTwitchEmoteTags(tags.emotes, message), timestamp: Date.now(), isAnnouncement: true, announcementColor: color });
        }
    });

    // Subs, Resubs, Gift, Cheer, Raid – mit userId. Die vom User geschriebene Sub-/Resub-/Cheer-
    // Nachricht (inkl. evtl. enthaltener Twitch-Emotes) wird mitgeschickt statt verworfen.
    tmiClient.on('subscription', (channel, username, method, msg, userstate) => {
        const ch = channel.replace('#', '');
        const tierText = getSubPlanText(userstate['msg-param-sub-plan']);
        // Sub-Tier sofort in der User-Liste hinterlegen, statt erst auf die nächste Chatnachricht
        // (mit aktualisiertem Subscriber-Badge) dieses Users zu warten.
        setUserSubTier(cs, ch, username.toLowerCase(), getSubTierNumber(userstate['msg-param-sub-plan']));
        sendUserListUpdate(ws, cs, ch);
        const text = `🎉 {sender} hat ${tierText} subscribed!` + (msg ? ' {content}' : '');
        sendToClient(ws, { type: 'chat_event', channel: ch, text, sender: username, content: msg || undefined, emotes: msg ? parseTwitchEmoteTags(userstate.emotes, msg) : undefined, timestamp: Date.now() });
    });
    tmiClient.on('resub', (channel, username, months, msg, userstate, methods) => {
        const ch = channel.replace('#', '');
        const cumulative = userstate['msg-param-cumulative-months'] || months || 0;
        setUserSubTier(cs, ch, username.toLowerCase(), getSubTierNumber(userstate['msg-param-sub-plan']));
        sendUserListUpdate(ws, cs, ch);
        const text = `🎉 {sender} hat ${cumulative} Monate resubscribed!` + (msg ? ' {content}' : '');
        sendToClient(ws, { type: 'chat_event', channel: ch, text, sender: username, content: msg || undefined, emotes: msg ? parseTwitchEmoteTags(userstate.emotes, msg) : undefined, timestamp: Date.now() });
    });
    tmiClient.on('subgift', (channel, username, streakMonths, recipient, methods, userstate) => {
        const ch = channel.replace('#', '');
        // Beim Gifting bekommt der EMPFÄNGER den Sub-Status, nicht der Schenkende.
        if (recipient) setUserSubTier(cs, ch, recipient.toLowerCase(), getSubTierNumber(methods?.plan));
        sendUserListUpdate(ws, cs, ch);
        sendToClient(ws, { type: 'chat_event', channel: ch, text: `🎁 {sender} hat {receiver} einen Sub geschenkt!`, sender: username, receiver: recipient, timestamp: Date.now() });
    });
    tmiClient.on('submysterygift', (channel, username, numbOfSubs, methods, userstate) => {
        const ch = channel.replace('#', '');
        sendToClient(ws, { type: 'chat_event', channel: ch, text: `🎁 {sender} hat ${numbOfSubs} zufällige Subs verschenkt!`, sender: username, timestamp: Date.now() });
    });
    tmiClient.on('cheer', (channel, userstate, message) => {
        const ch = channel.replace('#', '');
        const text = `✨ {sender} hat ${userstate.bits} Bits gecheered!` + (message ? ' {content}' : '');
        sendToClient(ws, { type: 'chat_event', channel: ch, text, sender: userstate['display-name'], content: message || undefined, emotes: message ? parseTwitchEmoteTags(userstate.emotes, message) : undefined, timestamp: Date.now() });
    });
    // tmi.js emittiert für einen Raid intern "raided", nicht "raid" - mit dem falschen
    // Event-Namen ist dieser Handler bisher nie ausgeführt worden.
    tmiClient.on('raided', (channel, username, viewers) => {
        const ch = channel.replace('#', '');
        sendToClient(ws, { type: 'chat_event', channel: ch, text: `🚀 {sender} raidet mit ${viewers} Zuschauern!`, sender: username, timestamp: Date.now() });
    });

    // Join/Part als Live-Event (nicht persistent). Twitch schickt beim frischen Verbinden oft
    // einen Schwall JOIN-Events für alle bereits anwesenden Chatter (keine echten Neuzugänge,
    // nur die "Vorstellung" der aktuellen Runde) - tmi.js unterscheidet das nicht. Während des
    // kurzen "Settling"-Fensters direkt nach dem Beitritt (siehe handleJoinChannel) wird die
    // Userliste zwar aktualisiert, aber keine Chat-/Event-Meldung dafür angezeigt.
    tmiClient.on('join', (channel, username, self) => {
        if (self) return;
        const ch = channel.replace('#', '');
        const lower = username.toLowerCase();
        const isSettling = cs.joinSettling[ch] && Date.now() < cs.joinSettling[ch];

        const ulist = cs.userLists[ch];
        if (ulist && lower !== ch && !ulist.mods.has(lower) && !ulist.vips.has(lower) && !ulist.users.has(lower)) {
            ulist.users.add(lower);
            sendUserListUpdate(ws, cs, ch);
        }

        if (!isSettling) {
            sendToClient(ws, { type: 'chat_event', channel: ch, text: `→ {sender} ist dem Chat beigetreten`, sender: username, timestamp: Date.now(), isJoinPart: true });
        }
    });

    tmiClient.on('part', (channel, username, self) => {
        if (self) return;
        const ch = channel.replace('#', '');
        const lower = username.toLowerCase();
        const isSettling = cs.joinSettling[ch] && Date.now() < cs.joinSettling[ch];

        const ulist = cs.userLists[ch];
        if (ulist) {
            ulist.mods.delete(lower); ulist.vips.delete(lower); ulist.users.delete(lower);
            sendUserListUpdate(ws, cs, ch);
        }

        if (!isSettling) {
            sendToClient(ws, { type: 'chat_event', channel: ch, text: `← {sender} hat den Chat verlassen`, sender: username, timestamp: Date.now(), isJoinPart: true });
        }
    });

    // Twitch sendet Mod-Ernennung/-Entzug in Echtzeit als klassisches IRC-MODE (+o/-o) an ALLE
    // verbundenen Clients - unabhängig von eigenen Mod-Rechten. Das ist der einzige verlässliche
    // Live-Signal-Weg dafür (für VIP gibt es kein IRC-Äquivalent, siehe unmod unten).
    tmiClient.on('mod', (channel, username) => {
        const ch = channel.replace('#', '');
        const lower = username.toLowerCase();
        if (!cs.userBadges[ch]) cs.userBadges[ch] = new Map();
        const badges = cs.userBadges[ch].get(lower) || new Set();
        badges.add('moderator');
        cs.userBadges[ch].set(lower, badges);
        if (setUserRole(cs, ch, lower, 'mod')) sendUserListUpdate(ws, cs, ch);
    });
    tmiClient.on('unmod', (channel, username) => {
        const ch = channel.replace('#', '');
        const lower = username.toLowerCase();
        const badges = cs.userBadges[ch]?.get(lower);
        badges?.delete('moderator');
        // VIP-Status lässt sich hier nicht live erkennen (kein IRC-Signal dafür) - falls das
        // zuletzt gesehene Chat-Badge noch "vip" zeigt, zumindest darauf zurückfallen.
        if (setUserRole(cs, ch, lower, badges?.has('vip') ? 'vip' : 'user')) sendUserListUpdate(ws, cs, ch);
    });

    // NAMES-Event mit userId-Erfassung
    tmiClient.on('names', async (channel, names) => {
        const ch = channel.replace('#', '');
        const userList = parseNamesList(names, ch);
        // In die bestehende Liste EINMISCHEN statt sie zu ersetzen: eine spätere NAMES-Antwort
        // kann (v.a. ohne Mod-Rechte) unvollständiger sein als das, was wir bereits aus dem
        // Chatverlauf gelernt haben - das darf nicht verloren gehen.
        mergeUserList(cs, ch, userList);

        if (!cs.userDisplay[ch]) cs.userDisplay[ch] = new Map();
        if (!cs.userIdMap[ch]) cs.userIdMap[ch] = new Map();
        if (!cs.userPartner[ch]) cs.userPartner[ch] = new Map();
        if (!cs.userStaff[ch]) cs.userStaff[ch] = new Map();

        // Nur bisher unbekannte Logins per Helix nachladen, statt bei jedem NAMES-Refresh alle erneut abzufragen
        const allLower = [...userList.mods, ...userList.vips, ...userList.users].filter(u => !cs.userDisplay[ch].has(u));
        if (allLower.length > 0) {
            for (let i = 0; i < allLower.length; i += 100) {
                const batch = allLower.slice(i, i + 100);
                try {
                    const usersData = await fetchHelix(`users?login=${batch.join('&login=')}`, cs.clientId, cs.appAccessToken);
                    (usersData.data || []).forEach(u => {
                        const lower = u.login.toLowerCase();
                        cs.userDisplay[ch].set(lower, u.display_name);
                        cs.userIdMap[ch].set(lower, u.id);
                        cs.userPartner[ch].set(lower, u.broadcaster_type === 'partner');
                        // Staff könnte man aus badges setzen, hier nicht
                    });
                } catch (e) {}
            }
            if (!cs.userDisplay[ch].has(userList.broadcaster)) {
                try {
                    const bc = await fetchHelix(`users?login=${userList.broadcaster}`, cs.clientId, cs.appAccessToken);
                    if (bc.data?.[0]) {
                        const u = bc.data[0];
                        const lower = u.login.toLowerCase();
                        cs.userDisplay[ch].set(lower, u.display_name);
                        cs.userIdMap[ch].set(lower, u.id);
                        cs.userPartner[ch].set(lower, u.broadcaster_type === 'partner');
                    }
                } catch (e) {}
            }
        }

        // IRC-@-Präfix ist ein früher, verlässlicher Hinweis auf eigene Mod-Rechte (schneller als
        // der erste Helix-Roundtrip) - wird nur positiv gesetzt, ein Fehlen ist kein Gegenbeweis.
        if (ch === cs.username || userList.mods.has(cs.username)) cs.isModerator[ch] = true;

        sendUserListUpdate(ws, cs, ch);
    });

    tmiClient.on('connected', () => log('TWITCH', `IRC verbunden (@${cs.username})`));
    tmiClient.on('disconnected', (reason) => logWarn('TWITCH', `IRC-Verbindung getrennt (@${cs.username}): ${reason || 'unbekannter Grund'} - tmi.js versucht automatisch, neu zu verbinden`));

    await tmiClient.connect();
    sendToClient(ws, { type: 'login_success', username: cs.username, userId: cs.userId });
    sendToClient(ws, { type: 'bot_list', bots: await getBotList() });

    // Channel-Intervall starten: Twitch beantwortet wiederholte IRC-NAMES-Anfragen nicht
    // zuverlässig, daher wird die Roster-Liste stattdessen periodisch über Helix aktualisiert.
    for (const ch of cs.channels) {
        startUserListInterval(ws, cs, ch);
        rescheduleTimeoutTimers(ws, cs, ch);
    }
}

// Nach einem Reconnect sind alte Timeout-Timer (setTimeout-Handles) verloren, die Ablaufzeiten
// selbst aber übernommen worden - hier für die verbleibende Restzeit neu aufsetzen, sonst
// verschwindet der Timeout-Tag nie wieder.
function rescheduleTimeoutTimers(ws, cs, ch) {
    const timeouts = cs.userTimeouts[ch];
    if (!timeouts) return;
    for (const [login, expiresAt] of [...timeouts]) {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) { timeouts.delete(login); continue; }
        if (!cs.timeoutTimers[ch]) cs.timeoutTimers[ch] = {};
        cs.timeoutTimers[ch][login] = setTimeout(() => {
            cs.userTimeouts[ch]?.delete(login);
            delete cs.timeoutTimers[ch]?.[login];
            sendUserListUpdate(ws, cs, ch);
        }, remaining);
    }
}

function startUserListInterval(ws, cs, ch) {
    if (cs.nameIntervals[ch]) return;
    cs.nameIntervals[ch] = setInterval(() => {
        if (cs.tmiClient && cs.channels.has(ch)) refreshUserList(ws, cs, ch);
    }, 60000);
}

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

// Aktualisiert Mods/VIPs/Chatter über offizielle Helix-Endpunkte und meldet Beitritte/Verlassen
// als chat_event, sobald sich die Chatter-Liste gegenüber dem letzten Abruf verändert hat.
//
// Twitch-Einschränkungen, mit denen hier bewusst umgegangen wird:
// - chat/chatters funktioniert nur, wenn der eingeloggte User im Ziel-Channel Mod (oder der
//   Broadcaster) ist (Scope moderator:read:chatters).
// - moderation/moderators und channels/vips funktionieren NUR mit dem Token des Broadcasters
//   selbst - nicht einmal mit dem eines "normalen" Moderators (Twitch-Limitierung, kein Bug hier).
//   Sie werden daher nur abgefragt, wenn der eingeloggte User der Broadcaster des Channels ist.
// - Ist man weder Mod noch Broadcaster, bleibt nur das, was auch ein normaler (nicht
//   eingeloggter) Zuschauer bekommt: die IRC-NAMES-Liste beim Join/Refresh sowie die Rollen, die
//   sich aus den Chat-Badges bereits gesehener Chatter ableiten lassen.
async function refreshUserList(ws, cs, ch) {
    if (!cs.tmiClient || !cs.channels.has(ch)) return;
    try {
        let broadcasterId = cs.broadcasterIds[ch];
        if (!broadcasterId) {
            const u = await fetchHelix(`users?login=${ch}`, cs.clientId, cs.appAccessToken);
            broadcasterId = u.data?.[0]?.id;
            if (broadcasterId) cs.broadcasterIds[ch] = broadcasterId;
        }
        if (!broadcasterId) return;

        const isBroadcaster = broadcasterId === cs.userId;
        if (isBroadcaster) cs.isModerator[ch] = true;

        let chatters = null;
        try {
            chatters = await fetchAllChatters(cs.clientId, cs.oauthToken, broadcasterId, cs.userId);
            cs.isModerator[ch] = true;
            if (cs.rosterAccessLogged[ch]) { cs.rosterAccessLogged[ch] = false; log('ROSTER', `Chatters-Zugriff für #${ch} jetzt vorhanden`); }
        } catch (e) {
            // Nur bei einer klaren Berechtigungsabsage auf "kein Mod" schließen, nicht bei z.B.
            // einem kurzen Netzwerkfehler - sonst flackern die Mod-Buttons unnötig weg.
            if ((e.status === 401 || e.status === 403) && !isBroadcaster) cs.isModerator[ch] = false;
            // Läuft alle 60s erneut - nur beim ERSTEN Fehlschlag loggen, sonst läuft das Log voll.
            if (!cs.rosterAccessLogged[ch]) {
                cs.rosterAccessLogged[ch] = true;
                logWarn('ROSTER', `Kein Chatters-Zugriff für #${ch} (${e.message}) - nutze NAMES/Chat-Badges als Fallback (wird nicht erneut geloggt)`);
            }
        }

        // moderation/moderators + channels/vips lassen sich laut Twitch NUR mit dem Token des
        // Broadcasters selbst abfragen - für alle anderen (auch echte Mods!) immer ein Fehler.
        let mods = null, vips = null;
        if (isBroadcaster) {
            [mods, vips] = await Promise.all([
                fetchModerators(cs.clientId, cs.oauthToken, broadcasterId).catch(e => { logWarn('ROSTER', `Moderatoren-Abruf für #${ch} fehlgeschlagen: ${e.message}`); return null; }),
                fetchVips(cs.clientId, cs.oauthToken, broadcasterId).catch(e => { logWarn('ROSTER', `VIP-Abruf für #${ch} fehlgeschlagen: ${e.message}`); return null; }),
            ]);
        }

        if (!chatters) {
            // Kein Mod-/Broadcaster-Zugriff auf diesen Channel - bestenfalls per IRC-NAMES
            // (genau das, was auch ein normaler Zuschauer bekäme) und dem undokumentierten
            // Legacy-Endpunkt etwas Frisches holen; ansonsten bleibt die aus dem Chatverlauf
            // gelernte Liste bestehen. canModerate trotzdem propagieren.
            cs.tmiClient.raw('NAMES #' + ch).catch(() => {});
            await applyLegacyChattersFallback(ws, cs, ch);
            sendUserListUpdate(ws, cs, ch);
            return;
        }

        if (!cs.userDisplay[ch]) cs.userDisplay[ch] = new Map();
        if (!cs.userIdMap[ch]) cs.userIdMap[ch] = new Map();

        const wasInitialized = !!cs.chattersInitialized[ch];
        const oldList = cs.userLists[ch];
        const oldLogins = new Set(oldList ? [...oldList.mods, ...oldList.vips, ...oldList.users] : []);

        const newMods = new Set(), newVips = new Set(), newUsers = new Set();
        chatters.forEach(c => {
            if (c.login === ch) return;
            cs.userDisplay[ch].set(c.login, c.displayName);
            cs.userIdMap[ch].set(c.login, c.userId);
            let role = 'user';
            if (mods || vips) {
                if (mods?.has(c.login)) role = 'mod';
                else if (vips?.has(c.login)) role = 'vip';
            } else {
                // Ohne Broadcaster-Zugriff auf moderation/moderators + channels/vips: Rolle aus den
                // zuletzt im Chat gesehenen Badges dieses Users ableiten (funktioniert für jeden,
                // der schon mal geschrieben hat) UND aus der bereits bekannten Liste (z.B. per
                // @-Präfix aus dem IRC-NAMES-Event erkannt) - sonst würde dieser Abruf frisch
                // geladene Chatter, die noch nichts geschrieben haben, immer auf "user" zurücksetzen.
                const badgeSet = cs.userBadges[ch]?.get(c.login);
                if (badgeSet?.has('moderator') || badgeSet?.has('lead_moderator')) role = 'mod';
                else if (badgeSet?.has('vip')) role = 'vip';
                else if (oldList?.mods.has(c.login)) role = 'mod';
                else if (oldList?.vips.has(c.login)) role = 'vip';
            }
            if (role === 'mod') newMods.add(c.login);
            else if (role === 'vip') newVips.add(c.login);
            else newUsers.add(c.login);
        });

        cs.userLists[ch] = { broadcaster: ch, mods: newMods, vips: newVips, users: newUsers };

        // Join/Part-Meldungen nur nach dem allerersten Abruf erzeugen, sonst würde beim ersten
        // Mal die komplette aktuelle Chatterliste als "beigetreten" gemeldet werden.
        if (wasInitialized) {
            const newLogins = new Set([...newMods, ...newVips, ...newUsers]);
            for (const login of newLogins) {
                if (!oldLogins.has(login)) {
                    const name = cs.userDisplay[ch].get(login) || login;
                    sendToClient(ws, { type: 'chat_event', channel: ch, text: `→ {sender} ist dem Chat beigetreten`, sender: name, timestamp: Date.now(), isJoinPart: true });
                }
            }
            for (const login of oldLogins) {
                if (!newLogins.has(login)) {
                    const name = cs.userDisplay[ch].get(login) || login;
                    sendToClient(ws, { type: 'chat_event', channel: ch, text: `← {sender} hat den Chat verlassen`, sender: name, timestamp: Date.now(), isJoinPart: true });
                }
            }
        }
        cs.chattersInitialized[ch] = true;

        sendUserListUpdate(ws, cs, ch);
    } catch (e) {
        logError('ROSTER', `User-Listen-Refresh für #${ch} fehlgeschlagen: ${e.message}`);
    }
}

// Bestmöglicher Zusatzversuch über den undokumentierten tmi.twitch.tv-Chatters-Endpunkt, den
// früher auch Twitchs eigene Webseite für die öffentliche Zuschauerliste genutzt hat. Kann
// jederzeit leer bleiben oder ganz wegfallen - Fehler werden daher bewusst nur geloggt, nie geworfen.
async function applyLegacyChattersFallback(ws, cs, ch) {
    try {
        const chatters = await fetchLegacyChatters(ch);
        if (!cs.userDisplay[ch]) cs.userDisplay[ch] = new Map();
        const mods = new Set((chatters.moderators || []).map(u => u.toLowerCase()));
        const vips = new Set((chatters.vips || []).map(u => u.toLowerCase()));
        const all = new Set([
            ...(chatters.broadcaster || []), ...mods, ...vips,
            ...(chatters.viewers || []), ...(chatters.staff || []), ...(chatters.admins || []), ...(chatters.global_mods || []),
        ].map(u => u.toLowerCase()));
        all.delete(ch);

        const incomingMods = new Set(), incomingVips = new Set(), incomingUsers = new Set();
        all.forEach(login => {
            if (mods.has(login)) incomingMods.add(login);
            else if (vips.has(login)) incomingVips.add(login);
            else incomingUsers.add(login);
        });
        if (incomingMods.size || incomingVips.size || incomingUsers.size) {
            mergeUserList(cs, ch, { mods: incomingMods, vips: incomingVips, users: incomingUsers });
        }
    } catch (e) {
        // Läuft alle 60s erneut, solange kein Chatters-Zugriff besteht - nur einmal pro Channel loggen.
        if (!cs.legacyFallbackLogged[ch]) {
            cs.legacyFallbackLogged[ch] = true;
            logWarn('ROSTER', `Legacy-Chatters-Fallback für #${ch} fehlgeschlagen: ${e.message} (wird nicht erneut geloggt)`);
        }
    }
}

// ========== CHANNEL HANDLER ==========
async function handleJoinChannel(ws, cs, channel) {
    const ch = channel.replace('#', '').toLowerCase();
    if (ch === cs.username) cs.isModerator[ch] = true; // eigener Channel: immer volle Mod-Rechte
    if (!cs.channels.has(ch)) {
        log('CHANNEL', `Trete #${ch} bei`);
        // Während dieses Fensters gelten eingehende JOIN/PART-Events als "Vorstellung" der schon
        // anwesenden Chatter (Twitch schickt davon oft einen ganzen Schwall direkt nach dem
        // Verbinden) - nur die Liste wird aktualisiert, keine Chat-/Event-Meldung dafür.
        cs.joinSettling[ch] = Date.now() + 6000;
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
    // refreshUserList/refreshPollAndPrediction loggen Fehler bereits selbst und werfen nie
    // erneut - der catch hier ist nur ein Sicherheitsnetz, keine eigene Fehlermeldung nötig.
    refreshUserList(ws, cs, ch).catch(() => {});

    if (!cs.emoteCache) cs.emoteCache = {};
    if (!cs.emoteCache[ch]) cs.emoteCache[ch] = await getEmotes(ch, cs.clientId, cs.appAccessToken);
    const emotes = cs.emoteCache[ch];
    let broadcasterId = null;
    try { const u = await fetchHelix(`users?login=${ch}`, cs.clientId, cs.appAccessToken); broadcasterId = u.data?.[0]?.id; } catch (e) { logWarn('CHANNEL', `Broadcaster-ID für #${ch} nicht ermittelbar: ${e.message}`); }
    if (broadcasterId) cs.broadcasterIds[ch] = broadcasterId;
    if (broadcasterId) refreshPollAndPrediction(ws, cs, ch).catch(() => {});

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
        delete cs.joinSettling[ch]; delete cs.rosterAccessLogged[ch]; delete cs.legacyFallbackLogged[ch];
        sendToClient(ws, { type: 'channel_left', channel: ch });
    }
}

async function handleSendMessage(ws, cs, msg) {
    const ch = msg.channel.replace('#', '').toLowerCase();
    if (!cs.tmiClient || !cs.channels.has(ch)) { sendToClient(ws, { type: 'error', message: 'Channel nicht gejoint.' }); return; }
    try { await cs.tmiClient.say('#' + ch, msg.message); } catch (e) { sendToClient(ws, { type: 'error', message: e.message }); }
}

// getUserInfo jetzt mit userId-Unterstützung
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
    cs.joinSettling = {}; cs.rosterAccessLogged = {}; cs.legacyFallbackLogged = {};
    cs.tmiClient = null; cs.channels.clear(); cs.filters.clear(); cs.recentMessages = {};
    cs.userLists = {}; cs.userBadges = {}; cs.userDisplay = {}; cs.userIdMap = {}; cs.userSubTier = {}; cs.userPartner = {}; cs.userStaff = {}; cs.emoteCache = {};
    cs.broadcasterIds = {}; cs.chattersInitialized = {}; cs.isModerator = {};
}

function getReadableColor(username) {
    const colors = [
        '#FF0000','#0000FF','#008000','#B22222','#FF7F50','#9ACD32','#FF4500','#2E8B57','#DAA520','#D2691E',
        '#5F9EA0','#1E90FF','#FF69B4','#8A2BE2','#00CED1','#FF1493','#00BFFF','#ADFF2F','#FF6347','#7B68EE'
    ];
    let hash = 0; for (let i=0; i<username.length; i++) hash = username.charCodeAt(i)+((hash<<5)-hash);
    const color = colors[Math.abs(hash)%colors.length];
    const r = parseInt(color.slice(1,3),16), g = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16);
    const brightness = (r*299 + g*587 + b*114)/1000;
    if (brightness < 50) return '#'+[r,g,b].map(c=>Math.min(255,c+80).toString(16).padStart(2,'0')).join('');
    return color;
}

app.get('/favicon.ico', (req, res) => res.status(204).end());
server.listen(PORT, () => log('SERVER', `🚀 StreamDesk v1.0 läuft auf http://localhost:${PORT}`));