// Generischer Wrapper um die Twitch-Helix-API. Wirft bei Fehlern einen Error mit .status, damit
// aufrufender Code zwischen "keine Berechtigung" (401/403) und anderen Fehlern unterscheiden kann.
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

// Blättert automatisch durch paginierte Helix-Listenendpunkte (moderators/vips/chatters).
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

module.exports = { fetchHelix, fetchAllPages, getAppAccessToken, validateToken };
