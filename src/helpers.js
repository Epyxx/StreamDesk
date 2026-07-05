function sendToClient(ws, data) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data)); }

// Wandelt das Twitch-"emotes"-Tag (id -> Positionen) in die vom Client erwartete Liste um.
// Wird für reguläre Chatnachrichten UND für USERNOTICE-Texte (Ankündigungen, Sub-/Resub-/Cheer-
// Nachrichten) gebraucht, die genauso Twitch-Emotes enthalten können.
function parseTwitchEmoteTags(emotesTag, message) {
    const result = [];
    if (emotesTag) {
        Object.entries(emotesTag).forEach(([id, positions]) => {
            positions.forEach(pos => {
                const [s, e] = pos.split('-').map(Number);
                result.push({ id, start: s, end: e + 1, name: message.substring(s, e + 1) });
            });
        });
    }
    return result;
}

function getReadableColor(username) {
    const colors = [
        '#FF0000','#0000FF','#008000','#B22222','#FF7F50','#9ACD32','#FF4500','#2E8B57','#DAA520','#D2691E',
        '#5F9EA0','#1E90FF','#FF69B4','#8A2BE2','#00CED1','#FF1493','#00BFFF','#ADFF2F','#FF6347','#7B68EE'
    ];
    let hash = 0; for (let i=0; i<username.length; i++) hash = username.charCodeAt(i)+((hash<<5)-hash);
    const color = colors[Math.abs(hash)%colors.length];
    const r = parseInt(color.slice(1,3),16), g = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16);
    const brightness = (r*299 + g*587 + b*114)/1000;
    if (brightness < 50) return '#'+[r,g,b].map(c=>Math.min(255,c+80).toString(16).padStart(2,'0')).join('');
    return color;
}

module.exports = { sendToClient, parseTwitchEmoteTags, getReadableColor };
