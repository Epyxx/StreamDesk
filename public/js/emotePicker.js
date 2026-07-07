// Emote-Typen, die an einem konkreten Channel hängen (Sub-/Bit-Tier-/Follower-/Channelpoints-
// Emotes) - siehe CHANNEL_SPECIFIC_EMOTE_TYPES in src/twitchServices.js (muss synchron bleiben).
const TWITCH_CHANNEL_EMOTE_TYPES = new Set(['subscriptions', 'bitstier', 'follower', 'channelpoints', 'rewards']);

// Fasst alle im aktiven Channel tatsächlich benutzbaren Emotes zusammen: die eigenen (server-
// seitig per Helix "Get User Emotes" geladenen) Twitch-Emotes - aufgeteilt in "Twitch: Global"
// und je einer Gruppe pro Channel, aus dem eigene Sub-/Bit-Tier-/Follower-Emotes stammen - sowie
// channel- und global-weite 7TV-/BetterTTV-/FrankerFaceZ-Emotes (siehe STATE.emotes, befüllt in
// channels.js).
function getAvailableEmoteGroups(channel) {
    const chEmotes = STATE.emotes[channel] || {};
    const groups = [];

    if (chEmotes.twitch?.length) {
        const globalItems = [];
        const byOwner = new Map(); // ownerId -> { label, items }
        chEmotes.twitch.forEach(e => {
            const item = { code: e.name, url: `https://static-cdn.jtvnw.net/emoticons/v2/${e.id}/default/dark/1.0` };
            if (TWITCH_CHANNEL_EMOTE_TYPES.has(e.type) && e.ownerId) {
                if (!byOwner.has(e.ownerId)) byOwner.set(e.ownerId, { label: e.ownerName || `Channel ${e.ownerId}`, items: [] });
                byOwner.get(e.ownerId).items.push(item);
            } else {
                globalItems.push(item);
            }
        });
        if (globalItems.length) groups.push({ label: 'Twitch: Global', items: globalItems });
        // Eigene Emotes des aktuell aktiven Channels zuerst, Rest alphabetisch - am
        // wahrscheinlichsten gerade relevant.
        const channelGroups = [...byOwner.entries()].sort(([ownerIdA], [ownerIdB]) => {
            const aIsCurrent = ownerIdA === STATE.broadcasterIds[channel];
            const bIsCurrent = ownerIdB === STATE.broadcasterIds[channel];
            if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;
            return byOwner.get(ownerIdA).label.localeCompare(byOwner.get(ownerIdB).label);
        });
        channelGroups.forEach(([, g]) => groups.push({ label: `Twitch: ${g.label}`, items: g.items }));
    }

    if (chEmotes.seventv?.length) groups.push({ label: '7TV', items: chEmotes.seventv.map(e => ({ code: e.code || e.name, url: e.url })) });
    if (chEmotes.bttv?.length) groups.push({ label: 'BetterTTV', items: chEmotes.bttv.map(e => ({ code: e.code || e.name, url: e.url })) });
    if (chEmotes.ffz?.length) groups.push({ label: 'FrankerFaceZ', items: chEmotes.ffz.map(e => ({ code: e.code || e.name, url: e.url })) });
    return groups;
}

function dedupeEmotesByCode(items) {
    const seen = new Set();
    return items.filter(it => { if (!it.code || seen.has(it.code)) return false; seen.add(it.code); return true; });
}

function renderEmotePicker() {
    const channel = STATE.activeChannel;
    const filter = (dom.emotePickerSearchInput.value || '').trim().toLowerCase();
    dom.emotePickerContent.innerHTML = '';
    if (!channel) { dom.emotePickerContent.innerHTML = '<div class="emote-picker-empty">Kein Channel ausgewählt.</div>'; return; }

    const groups = getAvailableEmoteGroups(channel);
    let totalShown = 0;
    groups.forEach(g => {
        const items = dedupeEmotesByCode(g.items).filter(it => !filter || it.code.toLowerCase().includes(filter));
        if (!items.length) return;
        totalShown += items.length;

        const label = document.createElement('div'); label.className = 'emote-picker-group-label'; label.textContent = `${g.label} (${items.length})`;
        dom.emotePickerContent.appendChild(label);

        const grid = document.createElement('div'); grid.className = 'emote-picker-grid';
        items.forEach(it => {
            const item = document.createElement('div'); item.className = 'emote-picker-item'; item.title = it.code;
            const img = document.createElement('img'); img.src = it.url; img.alt = it.code; img.loading = 'lazy';
            item.appendChild(img);
            item.addEventListener('click', () => insertEmoteChip(it.code, it.url));
            grid.appendChild(item);
        });
        dom.emotePickerContent.appendChild(grid);
    });

    if (totalShown === 0) {
        dom.emotePickerContent.innerHTML = `<div class="emote-picker-empty">${filter ? 'Keine Emotes gefunden.' : 'Keine Emotes für diesen Channel verfügbar.'}</div>`;
    }
}

function toggleEmotePicker(forceOpen) {
    const shouldOpen = forceOpen !== undefined ? forceOpen : dom.emotePicker.classList.contains('hidden');
    if (shouldOpen) {
        closeEmoteSearchDropdown(); // beide Overlays direkt über dem Eingabefeld - nie gleichzeitig
        dom.emotePicker.classList.remove('hidden');
        dom.emotePickerSearchInput.value = '';
        renderEmotePicker();
        dom.emotePickerSearchInput.focus();
    } else {
        dom.emotePicker.classList.add('hidden');
    }
}
