const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const { PORT, CLIENT_ID, CLIENT_SECRET, REDIRECT_URI } = require('./src/config');
const { log, logError } = require('./src/logger');
const { sendToClient } = require('./src/helpers');
const { createClientState } = require('./src/clientState');
const { handleStartOAuth, handleOAuthLogin, registerOAuthCallback, saveStateOnDisconnect } = require('./src/oauth');
const {
    handleJoinChannel, handleLeaveChannel, handleSendMessage, handleGetUserInfo, handleModAction, handleLogout,
    handleCreatePoll, handleEndPoll, handleCreatePrediction, handleResolvePrediction,
} = require('./src/wsHandlers');

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    logError('SERVER', 'TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET und TWITCH_REDIRECT_URI müssen in der .env-Datei gesetzt sein.');
    process.exit(1);
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/favicon.ico', (req, res) => res.status(204).end());
registerOAuthCallback(app);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Map();

wss.on('connection', (ws) => {
    log('WS', `Neue Verbindung (${clients.size + 1} aktiv)`);
    const clientState = createClientState();
    clients.set(ws, clientState);

    ws.on('message', async (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        try {
            switch (msg.type) {
                case 'login_oauth': await handleOAuthLogin(ws, clientState, msg.token); break;
                case 'start_oauth': handleStartOAuth(ws); break;
                case 'get_mod_channels': sendToClient(ws, { type: 'mod_channels', channels: [] }); break;
                case 'join_channel': await handleJoinChannel(ws, clientState, msg.channel); break;
                case 'leave_channel': await handleLeaveChannel(ws, clientState, msg.channel); break;
                case 'send_message': await handleSendMessage(ws, clientState, msg); break;
                case 'get_user_info': await handleGetUserInfo(ws, clientState, msg); break;
                case 'mod_action': await handleModAction(ws, clientState, msg); break;
                case 'create_poll': await handleCreatePoll(ws, clientState, msg); break;
                case 'end_poll': await handleEndPoll(ws, clientState, msg); break;
                case 'create_prediction': await handleCreatePrediction(ws, clientState, msg); break;
                case 'resolve_prediction': await handleResolvePrediction(ws, clientState, msg); break;
                case 'update_filter': clientState.filters.set(msg.channel.toLowerCase(), msg.words || []); break;
                case 'logout': handleLogout(ws, clientState); break;
            }
        } catch (e) {
            logError('WS', `Fehler bei "${msg?.type}": ${e.message}`);
            sendToClient(ws, { type: 'error', message: e.message });
        }
    });

    ws.on('close', () => {
        saveStateOnDisconnect(clientState);
        handleLogout(ws, clientState);
        clients.delete(ws);
        log('WS', `Verbindung geschlossen${clientState.username ? ` (@${clientState.username})` : ''} (${clients.size} aktiv)`);
    });
});

server.listen(PORT, () => log('SERVER', `🚀 StreamDesk v1.2 läuft auf http://localhost:${PORT}`));
