# 🔐 StreamDesk

Browserbasiertes Twitch-Chat- und Moderations-Tool. StreamDesk verbindet sich per OAuth sicher
mit deinem Twitch-Account, zeigt den Chat mehrerer Channels gleichzeitig in Tabs an und bietet
Moderatoren direkten Zugriff auf Timeouts, Bans, Nachrichten-Löschung, Umfragen, Predictions und
detaillierte User-Infos.

📖 **Vollständige Dokumentation, Quellcode & Issues:** [github.com/Epyxx/StreamDesk](https://github.com/Epyxx/StreamDesk)

## Quick Start

```bash
docker run -d \
  --name streamdesk \
  --restart unless-stopped \
  -p 3000:3000 \
  -e TWITCH_CLIENT_ID=deine_client_id \
  -e TWITCH_CLIENT_SECRET=dein_client_secret \
  -e TWITCH_REDIRECT_URI=http://localhost:3000/callback \
  epyx/streamdesk:latest
```

Anschließend `http://localhost:3000` (bzw. die eigene Domain) im Browser öffnen und über
„Mit Twitch anmelden" einloggen.

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

## Umgebungsvariablen

| Variable | Pflicht | Beschreibung |
|---|---|---|
| `TWITCH_CLIENT_ID` | ✅ | Client-ID der registrierten Twitch-Anwendung |
| `TWITCH_CLIENT_SECRET` | ✅ | Zugehöriges Client-Secret |
| `TWITCH_REDIRECT_URI` | ✅ | Muss exakt der in der [Twitch Developer Console](https://dev.twitch.tv/console/apps) hinterlegten OAuth Redirect URL entsprechen |
| `PORT` | – | Interner Server-Port (Standard: `3000`) |

Eine Twitch-Anwendung lässt sich kostenlos unter [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)
registrieren – Details dazu in der [README auf GitHub](https://github.com/Epyxx/StreamDesk#-installation--setup).

## Tags

- `latest` – jeweils aktuellster Stand von `main`
- `X.Y.Z`, `X.Y` – versionierte Releases (Git-Tag `vX.Y.Z`)

Multi-Arch-Image für `linux/amd64` und `linux/arm64`.

## Hinweise

- Der Container ist zustandslos: Chat-/Event-Verlauf liegt im `localStorage` des Browsers, es wird
  **kein Volume** für persistente Daten benötigt.
- Beim Betrieb hinter einem Reverse Proxy (z.B. unter einem Unterverzeichnis) müssen sowohl
  normale HTTP-Requests als auch WebSocket-Upgrades weitergeleitet werden. Konkrete
  Apache-/nginx-Beispiele dafür stehen in der
  [GitHub-Dokumentation](https://github.com/Epyxx/StreamDesk#-docker).

## Sicherheitshinweise

- Login läuft ausschließlich über den offiziellen Twitch-OAuth-Flow – es werden nie Zugangsdaten
  manuell eingegeben oder gespeichert.
- `TWITCH_CLIENT_SECRET` niemals im Klartext in ein Image bauen – ausschließlich zur Laufzeit als
  Umgebungsvariable übergeben (siehe Beispiele oben).

## Lizenz

[MIT](https://github.com/Epyxx/StreamDesk/blob/main/LICENSE)

---

Entwickelt von [Epyx](https://github.com/Epyxx) · Quellcode: [github.com/Epyxx/StreamDesk](https://github.com/Epyxx/StreamDesk)
