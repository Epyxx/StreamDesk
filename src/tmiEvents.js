const { fetchHelix } = require('./helixClient');
const { sendToClient, parseTwitchEmoteTags, findEmotesInText, getReadableColor } = require('./helpers');
const { log, logWarn } = require('./logger');
const {
    parseNamesList, mergeUserList, setUserRole, sendUserListUpdate, markUserTimedOut,
    getSubPlanText, getSubTierNumber, setUserSubTier,
} = require('./userRoster');

// Registriert alle tmi.js-Event-Handler für eine Verbindung. Wird einmal pro Login (in
// performLogin, oauth.js) auf dem frisch erzeugten tmi.Client aufgerufen.
function registerTmiEvents(ws, cs, tmiClient) {
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
        // tags.emotes ist bei selbst gesendeten Nachrichten praktisch immer leer (siehe Kommentar
        // oben) - stattdessen wird der Text gegen die beim Channel-Beitritt geladene Liste der
        // dem eingeloggten User tatsächlich verfügbaren Twitch-Emotes abgeglichen (siehe
        // findEmotesInText in helpers.js und fetchUserEmotes in twitchServices.js).
        const twitchEmotes = self
            ? findEmotesInText(message, cs.emoteCache?.[ch]?.twitch)
            : parseTwitchEmoteTags(tags.emotes, message);

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

    // Join/Part als Live-Event. Twitch schickt beim frischen Verbinden oft einen Schwall JOIN-
    // Events für alle bereits anwesenden Chatter (keine echten Neuzugänge, nur die "Vorstellung"
    // der aktuellen Runde) - tmi.js unterscheidet das nicht. Bis die erste Roster-Momentaufnahme
    // vorliegt (cs.rosterBaselineReady, siehe handleJoinChannel in wsHandlers.js) wird die
    // Userliste zwar aktualisiert, aber keine Chat-/Event-Meldung dafür angezeigt.
    tmiClient.on('join', (channel, username, self) => {
        if (self) return;
        const ch = channel.replace('#', '');
        const lower = username.toLowerCase();
        const isBaselineReady = !!cs.rosterBaselineReady[ch];

        const ulist = cs.userLists[ch];
        if (ulist && lower !== ch && !ulist.mods.has(lower) && !ulist.vips.has(lower) && !ulist.users.has(lower)) {
            ulist.users.add(lower);
            sendUserListUpdate(ws, cs, ch);
        }

        if (isBaselineReady) {
            sendToClient(ws, { type: 'chat_event', channel: ch, text: `→ {sender} ist dem Chat beigetreten`, sender: username, timestamp: Date.now(), isJoinPart: true });
        }
    });

    tmiClient.on('part', (channel, username, self) => {
        if (self) return;
        const ch = channel.replace('#', '');
        const lower = username.toLowerCase();
        const isBaselineReady = !!cs.rosterBaselineReady[ch];

        const ulist = cs.userLists[ch];
        if (ulist) {
            ulist.mods.delete(lower); ulist.vips.delete(lower); ulist.users.delete(lower);
            sendUserListUpdate(ws, cs, ch);
        }

        if (isBaselineReady) {
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
}

module.exports = { registerTmiEvents };
