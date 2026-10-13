# YT-Favourites ("Baby's Favourites")

A tiny, self-hosted YouTube playlist app for little kids: big tiles, tabs, no
recommendations, no ads. Add a video by URL and it appears for every device.

Why a sidecar? iOS only lets a tap start playback from your *own* origin and
suspends cross-origin YouTube iframes when the screen locks. So a second
container downloads the audio (AAC, via yt-dlp) for each video in the list and
the app plays it from its own origin — it keeps playing with the screen off and
shows lock-screen controls. "Watch the video" still opens the normal embed.

- Zero-dependency Node server (built-ins only) + vanilla JS PWA
- State is two JSON files in `/data` (`videos.json`, `tabs.json`)
- One image, two roles: the app (default) and the media sync (`/scripts/sync-media.sh`)

## Quick start

```sh
mkdir -p data cache && sudo chown 1000:1000 data cache
curl -O https://raw.githubusercontent.com/orange-lyrebird/YT-favourites/main/docker-compose.yml
docker compose up -d
```

Open http://localhost:8080. Image: `ghcr.io/orange-lyrebird/yt-favourites`
(linux/amd64 and linux/arm64). Pin a version tag rather than `latest`.

## Configuration

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `DATA_DIR` | `/data` | both | where the lists and `media/` live |
| `PORT` | `8080` | app | listen port |
| `APP_TITLE` | `YT favourites` | app | name shown in the header, browser tab, home-screen icon and lock screen |
| `POLL_SECONDS` | `60` | sync | how often to look for new videos |
| `RETRY_SECONDS` | `3600` | sync | back-off after a failed download |

To pre-populate a fresh install, put `videos.default.json` / `tabs.default.json`
in the data directory before first start; they are copied into place if the live
files don't exist.

## Security notes

- **There is no authentication.** Anyone who can reach the port can add and
  delete videos. Run it on a private network or behind a reverse proxy that
  authenticates.
- The sync container downloads media from YouTube with yt-dlp. Make sure that is
  acceptable under YouTube's terms and your local law; this is meant for personal use.

## Development

```sh
DATA_DIR=./data node app/server.js
```

## License

MIT
