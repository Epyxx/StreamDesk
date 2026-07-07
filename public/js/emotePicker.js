// Fasst alle im aktiven Channel tatsächlich benutzbaren Emotes zusammen: die eigenen (server-
// seitig per Helix "Get User Emotes" geladenen) Twitch-Emotes sowie channel- und global-weite
// 7TV-/BetterTTV-/FrankerFaceZ-Emotes (siehe STATE.emotes, befüllt in channels.js).
function getAvailableEmoteGroups(channel) {
    const chEmotes = STATE.emotes[channel] || {};
    const groups = [];
    if (chEmotes.twitch?.length) {
        groups.push({ label: 'Twitch', items: chEmotes.twitch.map(e => ({ code: e.name, url: `https://static-cdn.jtvnw.net/emoticons/v2/${e.id}/default/dark/1.0` })) });
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
            item.addEventListener('click', () => insertEmoteIntoInput(it.code));
            grid.appendChild(item);
        });
        dom.emotePickerContent.appendChild(grid);
    });

    if (totalShown === 0) {
        dom.emotePickerContent.innerHTML = `<div class="emote-picker-empty">${filter ? 'Keine Emotes gefunden.' : 'Keine Emotes für diesen Channel verfügbar.'}</div>`;
    }
}

// Fügt den Emote-Code an der aktuellen Cursor-Position ein (statt ihn immer nur anzuhängen),
// inkl. automatischer Leerzeichen zur Abgrenzung von umliegendem Text.
function insertEmoteIntoInput(code) {
    const input = dom.chatInput;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const needsLeadingSpace = before.length > 0 && !before.endsWith(' ');
    const needsTrailingSpace = after.length > 0 && !after.startsWith(' ');
    const insertion = `${needsLeadingSpace ? ' ' : ''}${code}${needsTrailingSpace ? ' ' : ''} `;
    input.value = before + insertion + after;
    const cursorPos = (before + insertion).length;
    input.focus();
    input.setSelectionRange(cursorPos, cursorPos);
}

function toggleEmotePicker(forceOpen) {
    const shouldOpen = forceOpen !== undefined ? forceOpen : dom.emotePicker.classList.contains('hidden');
    if (shouldOpen) {
        dom.emotePicker.classList.remove('hidden');
        dom.emotePickerSearchInput.value = '';
        renderEmotePicker();
        dom.emotePickerSearchInput.focus();
    } else {
        dom.emotePicker.classList.add('hidden');
    }
}
