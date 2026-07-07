const crypto = require('crypto');
const tmi = require('tmi.js');
const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI } = require('./config');
const { log, logWarn, logError } = require('./logger');
const { fetchHelix, getAppAccessToken, validateToken } = require('./helixClient');
const { getBotList } = require('./twitchServices');
const { sendToClient } = require('./helpers');
const { cloneStateForNewLogin } = require('./clientState');
const { registerTmiEvents } = require('./tmiEvents');
const { startUserListInterval, rescheduleTimeoutTimers } = require('./userRoster');

// ========== PERSISTENTER USER-STATE ==========
const userStates = new Map(); // userId -> gesicherter Zustand
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

// Sichert den Zustand einer schließenden Verbindung, damit ein erneuter Login desselben Users
// (z.B. nach einem Seiten-Reload) nahtlos an gejointen Channels, User-Listen etc. anknüpfen kann.
function saveStateOnDisconnect(clientState) {
    if (!clientState.userId) return;
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

function handleStartOAuth(ws) {
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.set(state, { ws, createdAt: Date.now() });
    const scopes = ['chat:read','chat:edit','channel:moderate','moderation:read','channel:read:subscriptions','moderator:read:followers','moderator:read:chatters','channel:read:vips','channel:read:polls','channel:manage:polls','channel:read:predictions','channel:manage:predictions','user:read:emotes'];
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

    registerTmiEvents(ws, cs, tmiClient);

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

// Registriert die /callback-Route, die Twitch nach dem Login im OAuth-Popup aufruft.
// Regex statt fixem String, damit die Route unabhängig davon greift, ob ein davorgeschalteter
// Reverse-Proxy einen Unterverzeichnis-Präfix (z.B. /streamdesk) beim Weiterleiten abschneidet
// oder unverändert durchreicht (z.B. /streamdesk/callback) - entscheidend ist nur, dass
// TWITCH_REDIRECT_URI exakt der öffentlich erreichbaren URL entspricht, die auch in der
// Twitch-Developer-Console als OAuth Redirect URL hinterlegt ist.
function registerOAuthCallback(app) {
    app.get(/\/callback$/, async (req, res) => {
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
}

module.exports = {
    handleStartOAuth, handleOAuthLogin, performLogin,
    registerOAuthCallback, saveStateOnDisconnect,
};
