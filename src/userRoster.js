const { fetchHelix } = require('./helixClient');
const { fetchAllChatters, fetchModerators, fetchVips, fetchLegacyChatters, getBotNamesSet } = require('./twitchServices');
const { sendToClient } = require('./helpers');
const { log, logWarn, logError } = require('./logger');

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
    if (login === ch) return false; // der Broadcaster wird separat geführt, nie in mods/vips/users
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
        userList: prepareUserList(cs.userLists[ch], ch, cs.userBadges[ch], cs.userDisplay[ch], cs.userIdMap[ch], getBotNamesSet(), cs.userSubTier[ch], cs.userPartner[ch], cs.userStaff[ch], cs.userTimeouts[ch]),
        canModerate: !!cs.isModerator[ch],
    });
}

// Markiert einen User als (nicht mehr) getimeoutet und plant automatisch den Zeitpunkt ein, zu
// dem die Markierung wieder verschwinden soll - ohne dass dafür eine weitere Chat-Nachricht
// nötig ist. Ein Ban entfernt den User stattdessen komplett aus der Liste (siehe 'ban'-Handler in
// tmiEvents.js), da gebannte User den Chat sofort verlassen und ihn nicht erneut betreten können.
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

function startUserListInterval(ws, cs, ch) {
    if (cs.nameIntervals[ch]) return;
    cs.nameIntervals[ch] = setInterval(() => {
        if (cs.tmiClient && cs.channels.has(ch)) refreshUserList(ws, cs, ch);
    }, 60000);
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

module.exports = {
    parseNamesList, mergeUserList, setUserRole, buildUserObjects, prepareUserList, sendUserListUpdate,
    markUserTimedOut, rescheduleTimeoutTimers, getSubPlanText, getSubTierNumber, setUserSubTier,
    resolveIdentity, startUserListInterval, refreshUserList, applyLegacyChattersFallback,
};
