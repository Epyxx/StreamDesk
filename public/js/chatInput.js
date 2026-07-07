// Macht aus dem Chat-Eingabefeld ein einfaches "Rich-Text"-Feld (contenteditable statt <input>),
// damit erkannte Emote-Codes wie im echten Twitch-Chat schon beim Tippen als Bild dargestellt
// werden, statt nur als Text. Der Inhalt bleibt dabei bewusst FLACH: direkte Kind-Textknoten und
// dazwischen einzelne <img class="input-emote" contenteditable="false"> - nie verschachtelt -
// damit sich der eigentliche Nachrichtentext jederzeit zuverlässig zurückgewinnen lässt (siehe
// getChatInputText). Enter erzeugt daher nie einen Zeilenumbruch (immer preventDefault).

// Letzte bekannte Cursor-Position IM Eingabefeld - wird gebraucht, weil ein Klick auf ein Emote im
// separaten Emote-Picker-Panel (oder im :such-Dropdown) dem Feld zuerst den Fokus entzieht; ohne
// diesen Merker wüsste insertEmoteChip() danach nicht mehr, WO eingefügt werden soll.
let lastSavedRange = null;

function saveCurrentRangeIfInsideInput() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (dom.chatInput.contains(range.commonAncestorContainer)) {
        lastSavedRange = range.cloneRange();
    }
}

function placeCursorAtEnd() {
    const range = document.createRange();
    range.selectNodeContents(dom.chatInput);
    range.collapse(false);
    return range;
}

// Liefert die aktuell nutzbare Einfüge-Position: die echte Browser-Selection, falls sie gerade im
// Eingabefeld liegt - sonst die zuletzt gemerkte Position, sonst als letzten Ausweg das Ende.
function getEditableRange() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (dom.chatInput.contains(range.commonAncestorContainer)) return range;
    }
    if (lastSavedRange && dom.chatInput.contains(lastSavedRange.commonAncestorContainer)) {
        return lastSavedRange.cloneRange();
    }
    return placeCursorAtEnd();
}

function setChatInputEnabled(enabled) {
    dom.chatInput.setAttribute('contenteditable', enabled ? 'true' : 'false');
}

// Baut den tatsächlichen Nachrichtentext aus dem gemischten Text-/Bild-Inhalt zusammen - für
// Emote-Bilder wird ihr hinterlegter Code eingesetzt (nicht der Alt-Text, falls der mal abweicht).
function getChatInputText() {
    let text = '';
    dom.chatInput.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
        else if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('input-emote')) text += node.dataset.code;
    });
    return text;
}

function clearChatInput() {
    dom.chatInput.innerHTML = '';
    lastSavedRange = null;
}

// Fügt einen Emote als Bild-Chip ein - entweder an einer explizit übergebenen Stelle (z.B. um ein
// per :suche gefundenes ":codeteil" zu ersetzen) oder an der aktuellen/zuletzt bekannten
// Cursor-Position. Direkt danach ein normales Leerzeichen einfügen, damit man nicht "im Bild"
// weitertippt und Twitch/IRC das nächste Wort sauber getrennt sieht.
function insertEmoteChip(code, url, replaceRange) {
    const range = replaceRange || getEditableRange();
    range.deleteContents();

    const img = document.createElement('img');
    img.className = 'input-emote';
    img.src = url; img.alt = code; img.title = code;
    img.dataset.code = code;
    img.setAttribute('contenteditable', 'false');
    range.insertNode(img);

    const space = document.createTextNode(' ');
    range.setStartAfter(img);
    range.collapse(true);
    range.insertNode(space);
    range.setStartAfter(space);
    range.collapse(true);

    dom.chatInput.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    lastSavedRange = range.cloneRange();

    closeEmoteSearchDropdown();
}

// Kombinierte, doppelte-freie Liste aller im Channel nutzbaren Emotes (Twitch + FFZ/BTTV/7TV),
// jeweils mit Angabe der Quelle - Grundlage für :suche UND für die Auto-Erkennung beim Tippen.
function getFlatAvailableEmotes(channel) {
    if (!channel) return [];
    const groups = getAvailableEmoteGroups(channel);
    const flat = [];
    groups.forEach(g => g.items.forEach(it => flat.push({ ...it, source: g.label })));
    return dedupeEmotesByCode(flat);
}

function findEmoteByExactCode(word) {
    return getFlatAvailableEmotes(STATE.activeChannel).find(e => e.code === word) || null;
}

// Liefert Wortanfang/-ende (innerhalb desselben Textknotens) rund um die aktuelle Cursor-Position,
// begrenzt durch Leerzeichen. Emote-Bild-Chips sind eigene Knoten und damit automatisch eine harte
// Grenze - ein "Wort" kann sie nie überspannen.
function getCursorWordInfo() {
    const range = getEditableRange();
    if (!range || !range.collapsed) return null;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return null;
    const text = node.textContent;
    const offset = range.startOffset;
    let start = offset;
    while (start > 0 && !/\s/.test(text[start - 1])) start--;
    let end = offset;
    while (end < text.length && !/\s/.test(text[end])) end++;
    if (start === end) return null;
    return { node, start, end, word: text.slice(start, end) };
}

// Wird nach jedem eingegebenen Leerzeichen aufgerufen: prüft, ob das gerade abgeschlossene Wort
// (direkt vor dem neuen Leerzeichen) exakt einem verfügbaren Emote-Code entspricht, und wandelt
// es dann - wie im echten Twitch-Chat - automatisch in ein Bild um.
function handleAutoConvertOnSpace() {
    const range = getEditableRange();
    if (!range || !range.collapsed) return;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent;
    const offset = range.startOffset;
    if (offset === 0 || text[offset - 1] !== ' ') return;

    let wordEnd = offset - 1;
    let wordStart = wordEnd;
    while (wordStart > 0 && !/\s/.test(text[wordStart - 1])) wordStart--;
    if (wordStart === wordEnd) return;

    const word = text.slice(wordStart, wordEnd);
    const match = findEmoteByExactCode(word);
    if (!match) return;

    const replaceRange = document.createRange();
    replaceRange.setStart(node, wordStart);
    replaceRange.setEnd(node, offset);
    insertEmoteChip(match.code, match.url, replaceRange);
}

// ========== ":"-Emote-Suche ==========
function updateEmoteSearchDropdown() {
    const info = getCursorWordInfo();
    if (!info || !info.word.startsWith(':')) {
        closeEmoteSearchDropdown();
        return;
    }
    if (!STATE.emoteSearch.active) toggleEmotePicker(false); // beide Overlays nie gleichzeitig
    STATE.emoteSearch = { active: true, query: info.word.slice(1), matches: STATE.emoteSearch.matches, selectedIndex: 0 };
    renderEmoteSearchDropdown();
}

function renderEmoteSearchDropdown() {
    const channel = STATE.activeChannel;
    const q = STATE.emoteSearch.query.toLowerCase();
    let matches = getFlatAvailableEmotes(channel).filter(e => e.code.toLowerCase().includes(q));
    matches.sort((a, b) => {
        const aStarts = a.code.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.code.toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts !== bStarts ? aStarts - bStarts : a.code.localeCompare(b.code);
    });
    matches = matches.slice(0, 30);
    STATE.emoteSearch.matches = matches;
    if (STATE.emoteSearch.selectedIndex >= matches.length) STATE.emoteSearch.selectedIndex = 0;

    dom.emoteSearchDropdown.innerHTML = '';
    if (!matches.length) {
        dom.emoteSearchDropdown.innerHTML = '<div class="emote-search-empty">Keine Emotes gefunden.</div>';
    } else {
        matches.forEach((e, i) => {
            const item = document.createElement('div');
            item.className = 'emote-search-item' + (i === STATE.emoteSearch.selectedIndex ? ' selected' : '');
            const img = document.createElement('img'); img.src = e.url; img.alt = e.code; img.loading = 'lazy';
            const code = document.createElement('span'); code.textContent = e.code;
            const source = document.createElement('span'); source.className = 'emote-search-source'; source.textContent = e.source;
            item.appendChild(img); item.appendChild(code); item.appendChild(source);
            // mousedown (statt click) + preventDefault, damit das Eingabefeld NIE den Fokus/die
            // Selection verliert - sonst wüsste confirmEmoteSearchSelection() nicht mehr sicher,
            // welches ":wort" ersetzt werden soll.
            item.addEventListener('mousedown', ev => { ev.preventDefault(); confirmEmoteSearchSelection(i); });
            dom.emoteSearchDropdown.appendChild(item);
        });
    }
    dom.emoteSearchDropdown.classList.remove('hidden');
}

function moveEmoteSearchSelection(delta) {
    const search = STATE.emoteSearch;
    if (!search.matches.length) return;
    search.selectedIndex = (search.selectedIndex + delta + search.matches.length) % search.matches.length;
    [...dom.emoteSearchDropdown.querySelectorAll('.emote-search-item')].forEach((el, i) => {
        const isSelected = i === search.selectedIndex;
        el.classList.toggle('selected', isSelected);
        if (isSelected) el.scrollIntoView({ block: 'nearest' });
    });
}

function confirmEmoteSearchSelection(index) {
    const search = STATE.emoteSearch;
    if (!search.active || !search.matches.length) return;
    const chosen = search.matches[index !== undefined ? index : search.selectedIndex];
    if (!chosen) return;
    // Wortposition frisch ermitteln statt die beim letzten Tastendruck gespeicherte zu nehmen -
    // zwischen Dropdown-Aufbau und Auswahl kann sich durch weiteres Tippen minimal was verschoben haben.
    const info = getCursorWordInfo();
    if (!info || !info.word.startsWith(':')) { closeEmoteSearchDropdown(); return; }
    const replaceRange = document.createRange();
    replaceRange.setStart(info.node, info.start);
    replaceRange.setEnd(info.node, info.end);
    insertEmoteChip(chosen.code, chosen.url, replaceRange);
}

function closeEmoteSearchDropdown() {
    STATE.emoteSearch = { active: false, query: '', matches: [], selectedIndex: 0 };
    dom.emoteSearchDropdown.classList.add('hidden');
    dom.emoteSearchDropdown.innerHTML = '';
}

function handleChatInputKeydown(e) {
    if (STATE.emoteSearch.active) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveEmoteSearchSelection(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveEmoteSearchSelection(-1); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); confirmEmoteSearchSelection(); return; }
        if (e.key === 'Escape') { e.preventDefault(); closeEmoteSearchDropdown(); return; }
    }
    // Enter erzeugt in contenteditable sonst einen Zeilenumbruch - hier ist das Feld bewusst
    // einzeilig, Enter sendet stattdessen die Nachricht (wie beim alten <input>-Feld).
    if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); return; }
}

dom.chatInput.addEventListener('keydown', handleChatInputKeydown);
dom.chatInput.addEventListener('input', e => {
    if (e.inputType === 'insertText' && e.data === ' ') handleAutoConvertOnSpace();
    saveCurrentRangeIfInsideInput();
    updateEmoteSearchDropdown();
});
dom.chatInput.addEventListener('keyup', e => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
        saveCurrentRangeIfInsideInput();
        updateEmoteSearchDropdown();
    }
});
dom.chatInput.addEventListener('click', () => {
    saveCurrentRangeIfInsideInput();
    updateEmoteSearchDropdown();
});
dom.chatInput.addEventListener('blur', () => closeEmoteSearchDropdown());

// Einfügungen aus der Zwischenablage immer als reiner Text behandeln (nie als HTML) - erhält die
// flache Text-/Chip-Struktur, auf der getChatInputText() aufbaut.
dom.chatInput.addEventListener('paste', e => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (!text) return;
    const range = getEditableRange();
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    lastSavedRange = range.cloneRange();
});
