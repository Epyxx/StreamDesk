# 🔐 StreamDesk

A browser-based Twitch chat and moderation tool. StreamDesk securely connects to your Twitch
account via OAuth, shows chat from multiple channels at once in tabs, and gives moderators
direct access to timeouts, bans, message deletion, polls, predictions, and detailed user info.

📖 **Full documentation, source code & issues:** [github.com/Epyxx/StreamDesk](https://github.com/Epyxx/StreamDesk)

## Quick Start

```bash
docker run -d \
  --name streamdesk \
  --restart unless-stopped \
  -p 3000:3000 \
  -e TWITCH_CLIENT_ID=your_client_id \
  -e TWITCH_CLIENT_SECRET=your_client_secret \
  -e TWITCH_REDIRECT_URI=http://localhost:3000/callback \
  epyx/streamdesk:latest
```

Then open `http://localhost:3000` (or your own domain) in a browser and log in via
"Log in with Twitch".

## Docker Compose

```yaml
services:
  streamdesk:
    image: epyx/streamdesk:latest
    container_name: streamdesk
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file:
      - .env
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TWITCH_CLIENT_ID` | ✅ | Client ID of your registered Twitch application |
| `TWITCH_CLIENT_SECRET` | ✅ | Matching client secret |
| `TWITCH_REDIRECT_URI` | ✅ | Must exactly match the OAuth Redirect URL registered in the [Twitch Developer Console](https://dev.twitch.tv/console/apps) |
| `PORT` | – | Internal server port (default: `3000`) |

You can register a Twitch application for free at
[dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) – details in the
[README on GitHub](https://github.com/Epyxx/StreamDesk#-installation--setup).

## Tags

- `latest` – always the current state of `main`
- `X.Y.Z`, `X.Y` – versioned releases (Git tag `vX.Y.Z`)

Multi-arch image for `linux/amd64` and `linux/arm64`.

## Notes

- The container is stateless: chat/event history lives in the browser's `localStorage`, so
  **no volume** is needed for persistent data.
- When running behind a reverse proxy (e.g. under a subdirectory), both regular HTTP requests
  and WebSocket upgrades need to be forwarded. See the
  [GitHub documentation](https://github.com/Epyxx/StreamDesk#-docker) for concrete Apache/nginx
  examples.

## Security Notes

- Login runs exclusively through the official Twitch OAuth flow – credentials are never entered
  or stored manually.
- Never bake `TWITCH_CLIENT_SECRET` into an image – always pass it as an environment variable at
  runtime (see examples above).

## License

[MIT](https://github.com/Epyxx/StreamDesk/blob/main/LICENSE)

---

Built by [Epyx](https://github.com/Epyxx) · Source: [github.com/Epyxx/StreamDesk](https://github.com/Epyxx/StreamDesk)
