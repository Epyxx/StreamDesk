# 🔐 StreamDesk v1.0

Ein browserbasiertes Twitch-Chat- und Moderations-Tool. StreamDesk verbindet sich per OAuth
sicher mit deinem Twitch-Account, zeigt den Chat mehrerer Channels gleichzeitig in Tabs an und
bietet Moderatoren direkten Zugriff auf Timeouts, Bans, Nachrichten-Löschung, Umfragen,
Predictions und detaillierte User-Infos – alles in einem schlanken Web-Interface ohne
zusätzliche Installation auf Zuschauerseite.

🐙 by [Epyx](https://github.com/Epyx)

---

## ✨ Features

- **Sicherer Login** ausschließlich über Twitch-OAuth (Authorization Code Flow) – es werden
  niemals Zugangsdaten manuell eingegeben oder gespeichert
- **Multi-Channel-Chat** mit Tabs, Lese-Badges für ungelesene Nachrichten und pro-Channel-Verlauf
- **Live-Moderation**: Timeout (inkl. individueller Dauer), Ban/Unban, Nachrichten löschen –
  direkt aus dem Chat oder dem User-Info-Panel
- **User-Info-Panel** mit Account-Alter, Follow-Dauer, Abo-Status, Badges, Ban-/Timeout-Status,
  letzten Nachrichten des Users und einem direkten Link zum Twitch-Profil
- **Live-Rollen-Erkennung**: Mods/VIPs/Broadcaster werden farblich unterschieden, Beförderungen/
  Degradierungen (Mod) kommen in Echtzeit an
- **Event-Log** für Ankündigungen, Subs/Resubs/Gift-Subs, Cheers, Raids, Bans/Timeouts, gelöschte
  Nachrichten sowie Join/Part-Events – inkl. persistenter Historie pro Channel
- **Umfragen & Predictions**: erstellen, live mitverfolgen und verwalten (Broadcaster/Mod)
- **Emote-Unterstützung**: native Twitch-Emotes sowie FFZ, BetterTTV und 7TV
- **Wortfilter** pro Channel zur farblichen Hervorhebung bestimmter Begriffe
- **Bot-Erkennung** bekannter Chat-Bots (z.B. Nightbot, StreamElements) in der User-Liste
- **Lokale Persistenz**: Nachrichten, Events und User-Listen bleiben nach einem Reload erhalten
  (localStorage), inkl. Speicher-Anzeige und manueller Aufräum-Funktion
- **Automatischer Reconnect** von WebSocket und Twitch-IRC-Verbindung mit exponentiellem Backoff
- **XSS-sichere Darstellung**: sämtlicher Nutzer-generierter Text (Chat, Ankündigungen,
  Sub-/Cheer-Nachrichten, gelöschte Nachrichten) läuft durch dieselbe escaping- und
  Link-/Emote-Erkennungs-Pipeline

## 🖥️ Tech-Stack

| Bereich   | Technologie |
|-----------|-------------|
| Backend   | Node.js, Express, [`ws`](https://www.npmjs.com/package/ws), [`tmi.js`](https://www.npmjs.com/package/tmi.js) |
| Frontend  | Vanilla HTML/CSS/JavaScript (keine Frameworks, keine Build-Tools) |
| APIs      | Twitch Helix API, Twitch IRC (via tmi.js), FrankerFaceZ, BetterTTV, 7TV |

Es gibt bewusst keine Frontend-Frameworks, Bundler oder Build-Schritte – das Projekt lässt sich
direkt ausführen und ist leicht nachvollziehbar.

## 📁 Projektstruktur

```
project/
├── server.js                # Einstiegspunkt: Express/WebSocket-Server, verdrahtet alle Module
├── src/                      # Backend-Module
│   ├── config.js             # Lädt/prüft Umgebungsvariablen (.env)
│   ├── logger.js             # Strukturiertes, zeitgestempeltes Server-Logging
│   ├── helpers.js            # Kleine geteilte Helfer (sendToClient, Emote-Parsing, Farben)
│   ├── helixClient.js        # Generischer Wrapper um die Twitch-Helix-API (inkl. Pagination)
│   ├── twitchServices.js     # Bot-Liste, Badges, Chatters/Mods/VIPs, Polls/Predictions, Emotes
│   ├── userRoster.js         # Aufbau/Pflege der Mod-/VIP-/User-Listen, Timeouts, Sub-Tiers
│   ├── clientState.js        # Zustands-Objekt pro WebSocket-Verbindung
│   ├── tmiEvents.js          # Alle tmi.js-Event-Handler (Nachrichten, Bans, Subs, Raids, ...)
│   ├── oauth.js              # OAuth-Flow, Login, /callback-Route, State-Persistenz
│   └── wsHandlers.js         # WebSocket-Nachrichten-Handler (Channel, Mod-Aktionen, Polls, ...)
└── public/                    # Frontend (statisch ausgeliefert)
    ├── index.html             # Markup
    ├── css/
    │   └── style.css          # Gesamtes Styling
    └── js/
        ├── state.js           # Globaler State, DOM-Referenzen, Storage-Helfer
        ├── websocket.js       # WebSocket-Verbindung, Reconnect, Server-Nachrichten-Routing
        ├── channels.js        # Channel-/Tab-Verwaltung
        ├── chat.js            # Chat-Rendering, Emote-/Link-Pipeline
        ├── sidebar.js         # User-Liste, Event-Log, Poll-/Prediction-Anzeige
        ├── userPanel.js       # User-Info-Panel, Mod-Aktionen
        └── main.js            # Event-Wiring & Bootstrap
```

## 🚀 Installation & Setup

### Voraussetzungen

- [Node.js](https://nodejs.org/) ≥ 18
- Ein Twitch-Account
- Eine registrierte Twitch-Anwendung (siehe unten)

### 1. Repository klonen & Abhängigkeiten installieren

```bash
git clone https://github.com/Epyx/streamdesk.git
cd streamdesk
npm install
```

### 2. Twitch-Anwendung registrieren

1. Öffne die [Twitch Developer Console](https://dev.twitch.tv/console/apps) und klicke auf
   **Register Your Application**.
2. Vergib einen Namen (z.B. `StreamDesk – Lokale Instanz`).
3. Trage als **OAuth Redirect URL** ein:
   ```
   http://localhost:3000/callback
   ```
4. Kategorie: `Application Integration` (oder eine passende Kategorie deiner Wahl).
5. Nach dem Erstellen erhältst du eine **Client-ID**; über **New Secret** generierst du ein
   **Client-Secret**.

### 3. Umgebungsvariablen konfigurieren

Kopiere `.env.example` zu `.env` und trage deine Zugangsdaten ein:

```bash
cp .env.example .env
```

```env
TWITCH_CLIENT_ID=deine_client_id
TWITCH_CLIENT_SECRET=dein_client_secret
TWITCH_REDIRECT_URI=http://localhost:3000/callback
PORT=3000
```

> ⚠️ Die `.env`-Datei enthält geheime Zugangsdaten und darf niemals committet werden
> (sie ist bereits über `.gitignore` ausgeschlossen).

### 4. Server starten

```bash
npm start
```

Für Entwicklung mit automatischem Neustart bei Dateiänderungen:

```bash
npm run dev
```

Anschließend die Anwendung unter [http://localhost:3000](http://localhost:3000) öffnen und über
**„Mit Twitch anmelden"** einloggen.

## 🔑 Verwendete Twitch-Scopes

| Scope | Zweck |
|---|---|
| `chat:read`, `chat:edit` | Chat lesen und schreiben |
| `channel:moderate`, `moderation:read` | Timeout/Ban/Nachrichten löschen |
| `channel:read:subscriptions` | Abo-Informationen im User-Info-Panel |
| `moderator:read:followers` | Follow-Dauer im User-Info-Panel |
| `moderator:read:chatters` | Aktuelle Chatter-Liste (Mods/VIPs/User) |
| `channel:read:vips` | VIP-Liste (nur als Broadcaster nutzbar, siehe unten) |
| `channel:read:polls`, `channel:manage:polls` | Umfragen anzeigen/erstellen/beenden |
| `channel:read:predictions`, `channel:manage:predictions` | Predictions anzeigen/verwalten |

## ⚠️ Bekannte Einschränkungen der Twitch-API

Diese Punkte sind **keine Bugs**, sondern Grenzen der öffentlichen Twitch-API, mit denen das
Tool bewusst und transparent umgeht:

- `moderation/moderators` und `channels/vips` lassen sich laut Twitch **ausschließlich mit dem
  Token des Broadcasters** abfragen – selbst ein regulärer Moderator bekommt hier eine
  Berechtigungs-Absage. In fremden Channels ohne eigene Mod-Rechte fällt StreamDesk daher auf die
  IRC-NAMES-Liste und zuletzt gesehene Chat-Badges zurück.
- Für VIP-Beförderungen gibt es **kein Echtzeit-IRC-Signal** (anders als bei Mods, die per
  `MODE +o/-o` sofort erkannt werden) – ein neuer VIP-Status wird erst mit der nächsten
  Chat-Nachricht des Users oder dem nächsten periodischen Roster-Abgleich sichtbar.
- Es existiert **keine öffentliche Twitch-API**, über die Zuschauer bei Umfragen/Predictions
  abstimmen können – StreamDesk bietet daher bewusst nur Anzeige und Verwaltung, keine
  Abstimm-Funktion.

## 🛡️ Sicherheit

- Login ausschließlich über den offiziellen Twitch-OAuth-Flow – StreamDesk sieht oder speichert
  niemals dein Passwort.
- Sämtlicher nutzergenerierter Text (Chatnachrichten, Ankündigungen, Sub-/Cheer-Nachrichten,
  gelöschte Nachrichten) wird clientseitig konsequent escaped, bevor er ins DOM eingefügt wird;
  Links und Emotes werden über eine dedizierte, token-basierte Pipeline erkannt – nie über
  direkte HTML-Interpolation von Nutzereingaben.
- Zugangsdaten (`TWITCH_CLIENT_SECRET` etc.) werden ausschließlich serverseitig über
  Umgebungsvariablen verwaltet und niemals an den Client übertragen.

## 📄 Lizenz

Dieses Projekt steht unter der [MIT-Lizenz](LICENSE).

## 🙏 Credits

- [tmi.js](https://github.com/tmijs/tmi.js) – Twitch-IRC-Client
- [FrankerFaceZ](https://www.frankerfacez.com/), [BetterTTV](https://betterttv.com/),
  [7TV](https://7tv.app/) – Drittanbieter-Emotes
- Entwickelt von [Epyx](https://github.com/Epyx)
