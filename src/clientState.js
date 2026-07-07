// Erzeugt den Zustand für eine einzelne WebSocket-Verbindung (ein Browser-Tab). Alles, was pro
// eingeloggtem User pro Channel gebraucht wird, lebt hier - nichts davon ist modulübergreifend
// global, damit mehrere gleichzeitige Verbindungen sich nicht gegenseitig beeinflussen.
function createClientState() {
    return {
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
        rosterBaselineReady: {},
        rosterAccessLogged: {},
        legacyFallbackLogged: {},
    };
}

// Überträgt einen zuvor gesicherten Zustand (siehe ws.on('close') in server.js) auf eine neue
// Verbindung desselben Users, z.B. nach einem Seiten-Reload - Timer-Handles (nameIntervals,
// timeoutTimers, pollPredictionIntervals) werden bewusst NICHT übernommen, da die alten Handles
// mit der geschlossenen Verbindung ungültig geworden sind; sie werden nach performLogin neu aufgesetzt.
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

module.exports = { createClientState, cloneStateForNewLogin };
