dom.btnSend.addEventListener('click', sendChatMessage);
function sendChatMessage() {
    const msg = getChatInputText().trim();
    if (!msg || !STATE.activeChannel) return;
    sendToServer({ type: 'send_message', channel: STATE.activeChannel, message: msg });
    clearChatInput();
}

dom.scrollToBottomBtn.addEventListener('click', () => { if (STATE.activeChannel) scrollToBottom(STATE.activeChannel, true); });

function toggleUserlistSidebar() {
    dom.sidebar.classList.toggle('collapsed');
    if (!dom.sidebar.classList.contains('collapsed')) renderSidebar();
}
// Eingabefeld wird bei JEDEM Öffnen geleert, nicht nur beim ersten Mal - sonst bliebe ein zuvor
// eingetippter (oder per Abbrechen verworfener) Channelname beim nächsten Öffnen stehen.
function openJoinChannelModal() {
    dom.inputChannelName.value = '';
    dom.modalJoin.style.display = 'flex';
    dom.inputChannelName.focus();
}
function confirmJoinChannel() {
    const n = dom.inputChannelName.value.trim().toLowerCase();
    if (!n) return;
    sendToServer({ type: 'join_channel', channel: n });
    dom.modalJoin.style.display = 'none';
}
function openFilterModal() {
    if (!STATE.activeChannel) { showToast('Kein Channel ausgewählt.'); return; }
    updateFilterModalChannel();
    dom.modalFilter.style.display = 'flex';
    dom.inputFilterWords.focus();
}
function closeActiveChannelTab() {
    if (!STATE.activeChannel) return;
    sendToServer({ type: 'leave_channel', channel: STATE.activeChannel });
}

dom.sidebarTabs.forEach(btn => {
    btn.addEventListener('click', () => {
        dom.sidebarTabs.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        STATE.sidebarMode = btn.dataset.tab;
        renderSidebar();
    });
});

// Bei Seite schließen/neuladen speichern
window.addEventListener('beforeunload', () => {
    saveAllData();
});

document.addEventListener('DOMContentLoaded', () => {
    loadFilters();
    connectWebSocket();
    updateStorageInfo();

    dom.btnLoginOAuth.addEventListener('click', () => { dom.loginError.style.display = 'none'; sendToServer({ type: 'start_oauth' }); });

    $('#btn-logout').addEventListener('click', () => {
        clientLog('AUTH', 'Logout');
        sendToServer({ type: 'logout' });
        STATE.loggedIn = false; STATE.channels = []; STATE.activeChannel = null;
        STATE.userLists = {}; STATE.emotes = {}; STATE.filters = {}; STATE.unreadCounts = {}; STATE.badgeMap = {}; STATE.channelEvents = {}; STATE.canModerate = {};
        STATE.activePolls = {}; STATE.activePredictions = {};
        dom.loginScreen.style.display = 'flex'; dom.app.style.display = 'none';
        dom.tabBar.innerHTML = ''; dom.channelsContainer.innerHTML = ''; dom.sidebarContent.innerHTML = '';
        dom.userInfoPanel.classList.remove('open'); dom.sidebar.classList.add('collapsed');
        dom.statusIndicator.className = 'offline'; dom.connectedAs.textContent = '';
        setChatInputEnabled(false); dom.btnSend.disabled = true; dom.btnEmotePicker.disabled = true;
        toggleEmotePicker(false);
        localStorage.removeItem(LS_KEYS.AUTH);
        stopSaveInterval();
    });

    dom.btnClearStorage.addEventListener('click', clearUnusedStorage);
    $('#btn-userlist').addEventListener('click', toggleUserlistSidebar);
    $('#btn-join-channel').addEventListener('click', openJoinChannelModal);
    $('#btn-join-cancel').addEventListener('click', () => dom.modalJoin.style.display = 'none');
    $('#btn-join-confirm').addEventListener('click', confirmJoinChannel);
    dom.inputChannelName.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); confirmJoinChannel(); } });
    $('#btn-filter').addEventListener('click', openFilterModal);
    $('#btn-filter-cancel').addEventListener('click', () => dom.modalFilter.style.display='none');
    $('#btn-filter-save').addEventListener('click', () => { if(!STATE.activeChannel) return; const w=dom.inputFilterWords.value.split(',').map(w=>w.trim().toLowerCase()).filter(w=>w); STATE.filters[STATE.activeChannel]=w; saveFilters(); sendToServer({type:'update_filter', channel:STATE.activeChannel, words:w}); dom.modalFilter.style.display='none'; });
    $('#btn-close-panel').addEventListener('click', () => { dom.userInfoPanel.classList.remove('open'); STATE.pendingUserInfo=null; });

    $('#btn-poll-add-choice').addEventListener('click', () => {
        if (dom.pollChoices.children.length >= 5) { showToast('⚠️ Maximal 5 Optionen.'); return; }
        createOptionRow(dom.pollChoices, `Option ${dom.pollChoices.children.length + 1}`, true);
    });
    $('#btn-poll-cancel').addEventListener('click', () => dom.modalPoll.style.display = 'none');
    $('#btn-poll-create').addEventListener('click', () => {
        const title = dom.pollTitle.value.trim();
        const choices = [...dom.pollChoices.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
        const duration = parseInt(dom.pollDuration.value, 10) || 60;
        if (!STATE.activeChannel || !title || choices.length < 2) { showToast('⚠️ Titel und mindestens 2 Optionen angeben.'); return; }
        sendToServer({ type: 'create_poll', channel: STATE.activeChannel, title, choices, duration });
        dom.modalPoll.style.display = 'none';
    });

    $('#btn-prediction-add-outcome').addEventListener('click', () => {
        if (dom.predictionOutcomes.children.length >= 10) { showToast('⚠️ Maximal 10 Optionen.'); return; }
        createOptionRow(dom.predictionOutcomes, `Ergebnis ${dom.predictionOutcomes.children.length + 1}`, true);
    });
    $('#btn-prediction-cancel').addEventListener('click', () => dom.modalPrediction.style.display = 'none');
    $('#btn-prediction-create').addEventListener('click', () => {
        const title = dom.predictionTitle.value.trim();
        const outcomes = [...dom.predictionOutcomes.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
        const predictionWindow = parseInt(dom.predictionWindow.value, 10) || 120;
        if (!STATE.activeChannel || !title || outcomes.length < 2) { showToast('⚠️ Titel und mindestens 2 Ergebnisse angeben.'); return; }
        sendToServer({ type: 'create_prediction', channel: STATE.activeChannel, title, outcomes, predictionWindow });
        dom.modalPrediction.style.display = 'none';
    });

    document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', e => { if(e.target===o) o.style.display='none'; }));
    document.addEventListener('keydown', e => { if(e.key==='Escape') { dom.modalJoin.style.display='none'; dom.modalFilter.style.display='none'; dom.modalPoll.style.display='none'; dom.modalPrediction.style.display='none'; dom.userInfoPanel.classList.remove('open'); toggleEmotePicker(false); } });

    // Tastenkürzel für die wichtigsten Aktionen - bewusst mit Alt statt einzelner Buchstaben,
    // damit normales Tippen im Chat (inkl. der Buchstaben u/j/w/f) nicht versehentlich Aktionen
    // auslöst. AltGr (v.a. auf europäischen Tastaturen für Sonderzeichen wie @ oder €) meldet sich
    // in den meisten Browsern zusätzlich als ctrlKey=true - wird hier deshalb ausgeschlossen.
    document.addEventListener('keydown', e => {
        if (!e.altKey || e.ctrlKey || e.metaKey || !STATE.loggedIn) return;
        switch (e.key.toLowerCase()) {
            case 'u': e.preventDefault(); toggleUserlistSidebar(); break;
            case 'j': e.preventDefault(); openJoinChannelModal(); break;
            case 'w': e.preventDefault(); closeActiveChannelTab(); break;
            case 'f': e.preventDefault(); openFilterModal(); break;
        }
    });

    dom.btnEmotePicker.addEventListener('click', e => { e.stopPropagation(); toggleEmotePicker(); });
    dom.emotePickerSearchInput.addEventListener('input', renderEmotePicker);
    document.addEventListener('click', e => {
        if (!dom.emotePicker.classList.contains('hidden') && !dom.emotePicker.contains(e.target) && e.target !== dom.btnEmotePicker) {
            toggleEmotePicker(false);
        }
    });
});
