# 🔐 StreamDesk v1.2.1

A browser-based Twitch chat and moderation tool. StreamDesk securely connects to your Twitch
account via OAuth, shows chat from multiple channels at once in tabs, and gives moderators
direct access to timeouts, bans, message deletion, polls, predictions, and detailed user info –
all in a lightweight web interface with no client-side installation required.

🐙 by [Epyx](https://github.com/Epyxx)

[![Docker Pulls](https://img.shields.io/docker/pulls/epyx/streamdesk?logo=docker&label=pulls)](https://hub.docker.com/r/epyx/streamdesk)
[![Docker Image Version](https://img.shields.io/docker/v/epyx/streamdesk?logo=docker&label=latest)](https://hub.docker.com/r/epyx/streamdesk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## ✨ Features

- **Secure login** exclusively via Twitch OAuth (Authorization Code Flow) – credentials are
  never entered or stored manually
- **Multi-channel chat** with tabs, unread badges, and per-channel history
- **Live moderation**: timeout (with a custom duration), ban/unban, delete messages – directly
  from the chat or the user info panel, with persistent action buttons (not hidden behind hover)
  that are automatically hidden on your own messages, since Twitch doesn't allow self-moderation
- **User info panel** with account age, follow duration, subscription status, badges,
  ban/timeout status, the user's recent messages, and a direct link to their Twitch profile
- **Live role detection**: mods/VIPs/broadcaster are color-coded, mod promotions/demotions arrive
  in real time
- **Event log** for announcements, subs/resubs/gift subs, cheers, raids, bans/timeouts, deleted
  messages, and join/part events – with persistent per-channel history
- **Polls & predictions**: create, follow live, and manage them (broadcaster/mod)
- **Emote support**: native Twitch emotes (including your own subscriber emotes, correctly
  resolved across every channel you join) plus channel and global FFZ, BetterTTV, and 7TV emotes,
  with a built-in **emote picker** in the chat input showing every emote you can actually use in
  the current channel
- **Word filter** per channel to highlight specific terms
- **Bot detection** for known chat bots (e.g. Nightbot, StreamElements) in the user list
- **Local persistence**: messages, events, and user lists survive a reload (localStorage),
  including a storage usage display and manual cleanup
- **Automatic reconnect** for both the WebSocket and the Twitch IRC connection with exponential
  backoff
- **XSS-safe rendering**: all user-generated text (chat, announcements, sub/cheer messages,
  deleted messages) goes through the same escaping and link/emote detection pipeline

## 🖥️ Tech Stack

| Layer     | Technology |
|-----------|------------|
| Backend   | Node.js, Express, [`ws`](https://www.npmjs.com/package/ws), [`tmi.js`](https://www.npmjs.com/package/tmi.js) |
| Frontend  | Vanilla HTML/CSS/JavaScript (no frameworks, no build tools) |
| APIs      | Twitch Helix API, Twitch IRC (via tmi.js), FrankerFaceZ, BetterTTV, 7TV |

There are deliberately no frontend frameworks, bundlers, or build steps – the project runs
directly and is easy to follow.

## 📁 Project Structure

```
project/
├── server.js                # Entry point: Express/WebSocket server, wires up all modules
├── src/                      # Backend modules
│   ├── config.js             # Loads/validates environment variables (.env)
│   ├── logger.js             # Structured, timestamped server logging
│   ├── helpers.js            # Small shared helpers (sendToClient, emote parsing, colors)
│   ├── helixClient.js        # Generic wrapper around the Twitch Helix API (incl. pagination)
│   ├── twitchServices.js     # Bot list, badges, chatters/mods/vips, polls/predictions, emotes
│   ├── userRoster.js         # Builds/maintains mod/VIP/user lists, timeouts, sub tiers
│   ├── clientState.js        # Per-WebSocket-connection state object
│   ├── tmiEvents.js          # All tmi.js event handlers (messages, bans, subs, raids, ...)
│   ├── oauth.js              # OAuth flow, login, /callback route, state persistence
│   └── wsHandlers.js         # WebSocket message handlers (channel, mod actions, polls, ...)
└── public/                    # Frontend (served statically)
    ├── index.html             # Markup
    ├── css/
    │   └── style.css          # All styling
    └── js/
        ├── state.js           # Global state, DOM references, storage helpers
        ├── websocket.js       # WebSocket connection, reconnect, server message routing
        ├── channels.js        # Channel/tab management
        ├── chat.js            # Chat rendering, emote/link pipeline
        ├── sidebar.js         # User list, event log, poll/prediction display
        ├── userPanel.js       # User info panel, mod actions
        ├── emotePicker.js     # Emote picker for the chat input
        └── main.js            # Event wiring & bootstrap
```

## 🚀 Installation & Setup

### Requirements

- [Node.js](https://nodejs.org/) ≥ 18
- A Twitch account
- A registered Twitch application (see below)

### 1. Clone the repository & install dependencies

```bash
git clone https://github.com/Epyxx/StreamDesk.git
cd StreamDesk
npm install
```

### 2. Register a Twitch application

1. Open the [Twitch Developer Console](https://dev.twitch.tv/console/apps) and click
   **Register Your Application**.
2. Give it a name (e.g. `StreamDesk – Local Instance`).
3. Set the **OAuth Redirect URL** to:
   ```
   http://localhost:3000/callback
   ```
4. Category: `Application Integration` (or any category that fits).
5. After creating the app you get a **Client ID**; click **New Secret** to generate a
   **Client Secret**.

### 3. Configure environment variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

```env
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret
TWITCH_REDIRECT_URI=http://localhost:3000/callback
PORT=3000
```

> ⚠️ The `.env` file contains secrets and must never be committed
> (it's already excluded via `.gitignore`).

### 4. Hosting under a subdirectory (reverse proxy)

If StreamDesk is exposed through a reverse proxy (e.g. `https://example.com/streamdesk` instead
of `http://localhost:3000`), `TWITCH_REDIRECT_URI` **must** point exactly at the publicly
reachable callback URL:

```env
TWITCH_REDIRECT_URI=https://example.com/streamdesk/callback
```

This URL must **also be registered identically** as an OAuth Redirect URL in the
[Twitch Developer Console](https://dev.twitch.tv/console/apps) – Twitch redirects the browser
after login to exactly the address registered there (and configured here). If
`TWITCH_REDIRECT_URI` is left at `http://localhost:3000/callback` while the app is publicly
hosted elsewhere, the login redirect will incorrectly land on `localhost`.

The reverse proxy must also forward WebSocket upgrades (not just regular HTTP requests) for the
same path to the Node process, since the live connection (chat, events, ...) runs over
WebSocket.

### 5. Start the server

```bash
npm start
```

For development with automatic restarts on file changes:

```bash
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000) in your browser and log in via
**"Log in with Twitch"**.

## 🐳 Docker

📦 **Docker Hub:** [hub.docker.com/r/epyx/streamdesk](https://hub.docker.com/r/epyx/streamdesk)

StreamDesk is stateless on the server side (the actual chat/event history lives in the
browser's `localStorage`) – a container therefore needs **no volume** for persistent data, just
the three Twitch environment variables.

### Prebuilt image from Docker Hub

```bash
docker run -d \
  --name streamdesk \
  --restart unless-stopped \
  -p 3000:3000 \
  -e TWITCH_CLIENT_ID=your_client_id \
  -e TWITCH_CLIENT_SECRET=your_client_secret \
  -e TWITCH_REDIRECT_URI=https://example.com/streamdesk/callback \
  epyx/streamdesk:latest
```

Or with an `.env` file instead of individual `-e` flags:

```bash
docker run -d --name streamdesk --restart unless-stopped -p 3000:3000 --env-file .env epyx/streamdesk:latest
```

### Build it yourself

```bash
git clone https://github.com/Epyxx/StreamDesk.git
cd StreamDesk
docker build -t streamdesk .
docker run -d --name streamdesk --restart unless-stopped -p 3000:3000 --env-file .env streamdesk
```

### With Docker Compose

```bash
docker compose up -d --build
```

(`docker-compose.yml` is already in the repo – it builds locally from source by default; the
`image:` line inside it can be uncommented instead to use `epyx/streamdesk:latest` from Docker
Hub directly.)

### Reverse proxy in front of the container (subdirectory + WebSocket)

If the container – as described above – runs behind a reverse proxy under a subdirectory, that
proxy needs to forward both regular HTTP requests and WebSocket upgrades to
`http://<container-host>:3000/`. Two examples:

**Apache** (≥ 2.4.47, requires `a2enmod proxy proxy_http proxy_wstunnel headers`):

```apache
<Location /streamdesk/>
    ProxyPass http://127.0.0.1:3000/ upgrade=websocket
    ProxyPassReverse http://127.0.0.1:3000/
</Location>
```

**nginx**:

```nginx
location /streamdesk/ {
    proxy_pass http://127.0.0.1:3000/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

In both cases, set `TWITCH_REDIRECT_URI` (see above) to the exact public
`.../streamdesk/callback` URL and register the same value in the Twitch Developer Console.

### Automatic build & publish (for maintainers)

`.github/workflows/docker-publish.yml` automatically builds the image for `linux/amd64` and
`linux/arm64` on every push to `main` and on Git tags (`v*`), and publishes it as
`epyx/streamdesk` on Docker Hub. On pushes to `main`, it also keeps the Docker Hub repository's
short description and full overview page in sync with [`docker/README.md`](docker/README.md).
This requires two secrets to be configured once in the repository
(**Settings → Secrets and variables → Actions → New repository secret**):

| Secret | Value |
|---|---|
| `DOCKERHUB_USERNAME` | Docker Hub username (`epyx`) |
| `DOCKERHUB_TOKEN` | Docker Hub **access token** (not the account password) – create one at [hub.docker.com/settings/security](https://hub.docker.com/settings/security) |

## 🔑 Twitch Scopes Used

| Scope | Purpose |
|---|---|
| `chat:read`, `chat:edit` | Read and send chat messages |
| `channel:moderate`, `moderation:read` | Timeout/ban/delete messages |
| `channel:read:subscriptions` | Subscription info in the user info panel |
| `moderator:read:followers` | Follow duration in the user info panel |
| `moderator:read:chatters` | Current chatter list (mods/VIPs/users) |
| `channel:read:vips` | VIP list (broadcaster-only, see below) |
| `channel:read:polls`, `channel:manage:polls` | View/create/end polls |
| `channel:read:predictions`, `channel:manage:predictions` | View/manage predictions |
| `user:read:emotes` | Resolves your own usable Twitch emotes (subscriber emotes from every channel you're subscribed to, bit-tier and follower emotes) – used to correctly render emotes in your own sent messages (Twitch doesn't echo them back) and to populate the emote picker |

## ⚠️ Known Twitch API Limitations

These are **not bugs**, but limitations of the public Twitch API that this tool deliberately and
transparently works around:

- `moderation/moderators` and `channels/vips` can, per Twitch, **only be queried with the
  broadcaster's own token** – even a regular moderator gets denied here. In channels where you
  don't have mod rights, StreamDesk therefore falls back to the IRC NAMES list and the most
  recently seen chat badges.
- There is **no real-time IRC signal for VIP promotions** (unlike mods, which are detected
  instantly via `MODE +o/-o`) – a new VIP status only becomes visible with that user's next chat
  message or the next periodic roster refresh.
- There is **no public Twitch API** that lets viewers vote in polls/predictions – StreamDesk
  therefore deliberately only offers viewing and management, not a voting feature.

## 🛡️ Security

- Login runs exclusively through the official Twitch OAuth flow – StreamDesk never sees or
  stores your password.
- All user-generated text (chat messages, announcements, sub/cheer messages, deleted messages)
  is consistently escaped client-side before being inserted into the DOM; links and emotes are
  detected via a dedicated, token-based pipeline – never through direct HTML interpolation of
  user input.
- Credentials (`TWITCH_CLIENT_SECRET`, etc.) are managed exclusively server-side via environment
  variables and are never sent to the client.

## 📄 License

This project is licensed under the [MIT License](LICENSE).

## 🙏 Credits

- [tmi.js](https://github.com/tmijs/tmi.js) – Twitch IRC client
- [FrankerFaceZ](https://www.frankerfacez.com/), [BetterTTV](https://betterttv.com/),
  [7TV](https://7tv.app/) – third-party emotes
- Built by [Epyx](https://github.com/Epyxx)
