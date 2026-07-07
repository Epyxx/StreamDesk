const $$ = (sel) => document.querySelectorAll(sel);
const LS_KEYS = {
    AUTH: 'streamdesk_auth', CHANNELS: 'streamdesk_channels', FILTERS: 'streamdesk_filters',
    MESSAGES: (ch) => `streamdesk_messages_${ch}`, EVENTS: (ch) => `streamdesk_events_${ch}`,
    USERLIST: (ch) => `streamdesk_userlist_${ch}`,
    USERMSG: (ch, login) => `streamdesk_usermsg_${ch}_${login}`, USERMSG_PREFIX: (ch) => `streamdesk_usermsg_${ch}_`,
    VERSION: 'streamdesk_version'
};
const APP_VERSION = '1.1';

// ========== LOGGING ==========
// Bewusst schlank: nur wichtige Lebenszyklus-Ereignisse (Verbindung, Login, Channel-Beitritt,
// Mod-Aktionen, Polls/Predictions, Fehler) - keine einzelnen Chatnachrichten, sonst läuft die
// Browser-Konsole bei aktiver Nutzung sofort über.
function timestamp() { return new Date().toLocaleTimeString('de-DE', { hour12: false }); }
function clientLog(category, message) { console.log(`[${timestamp()}] [${category}] ${message}`); }
function clientWarn(category, message) { console.warn(`[${timestamp()}] [${category}] ⚠️ ${message}`); }
function clientError(category, message) { console.error(`[${timestamp()}] [${category}] ❌ ${message}`); }

function loadJSON(key, fallback = null) { try { const data = localStorage.getItem(key); return data ? JSON.parse(data) : fallback; } catch (e) { return fallback; } }
function saveJSON(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { clientError('STORAGE', `localStorage voll? ${e.message}`); } }
saveJSON(LS_KEYS.VERSION, APP_VERSION);

const STATE = {
    ws: null, connected: false, loggedIn: false, channels: [], activeChannel: null,
    userLists: {}, emotes: {}, filters: {}, botList: new Set(), pendingUserInfo: null,
    unreadCounts: {}, badgeMap: {}, channelEvents: {}, autoScroll: {}, seenMessageIds: {}, canModerate: {},
    activePolls: {}, activePredictions: {},
    sidebarMode: 'users', ownUsername: '', oauthPopup: null, saveInterval: null, reconnectAttempts: 0
};

const $ = (sel) => document.querySelector(sel);
const dom = {
    app: $('#app'), loginScreen: $('#login-screen'), loginError: $('#login-error'), statusIndicator: $('#status-indicator'),
    connectedAs: $('#connected-as'), tabBar: $('#tab-bar'), channelsContainer: $('#channels-container'),
    sidebar: $('#sidebar'), sidebarContent: $('#sidebar-content'), userCount: $('#user-count'),
    scrollToBottomBtn: $('#scroll-to-bottom-btn'), userInfoPanel: $('#user-info-panel'), panelUsername: $('#panel-username'), panelBody: $('#panel-body'),
    chatInput: $('#chat-input'), btnSend: $('#btn-send'), modalJoin: $('#modal-join'), modalFilter: $('#modal-filter'),
    inputChannelName: $('#input-channel-name'), filterChannelName: $('#filter-channel-name'), inputFilterWords: $('#input-filter-words'),
    sidebarTabs: $$('#sidebar-tabs button'), btnLoginOAuth: $('#btn-login-oauth'),
    storageInfo: $('#storage-info'), btnClearStorage: $('#btn-clear-storage'),
    modalPoll: $('#modal-poll'), pollTitle: $('#poll-title'), pollChoices: $('#poll-choices'), pollDuration: $('#poll-duration'),
    modalPrediction: $('#modal-prediction'), predictionTitle: $('#prediction-title'), predictionOutcomes: $('#prediction-outcomes'), predictionWindow: $('#prediction-window'),
    btnEmotePicker: $('#btn-emote-picker'), emotePicker: $('#emote-picker'), emotePickerSearchInput: $('#emote-picker-search-input'), emotePickerContent: $('#emote-picker-content'),
};

function showToast(msg) { const t = document.createElement('div'); t.className='toast'; t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(),3000); }
function escapeHtml(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
