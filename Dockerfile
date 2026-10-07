# One image, two roles: the web app (default CMD) and the media-sync sidecar
# (override the command with /scripts/sync-media.sh). See docker-compose.yml.
FROM node:22.23.1-alpine

# yt-dlp needs ffmpeg to extract audio and a JS runtime (deno) to solve
# YouTube's player challenges; python3 is used by sync-media.sh to parse the list.
RUN apk add --no-cache python3 ffmpeg yt-dlp deno

COPY app /app
COPY scripts /scripts

# HOME/XDG/DENO_DIR point at /cache so yt-dlp and deno have a writable home that
# never looks like app state. Run with a user that owns the mounted volumes.
ENV DATA_DIR=/data \
    PORT=8080 \
    HOME=/cache \
    XDG_CACHE_HOME=/cache \
    DENO_DIR=/cache/deno

RUN mkdir -p /data /cache && chown -R node:node /data /cache
USER node
WORKDIR /app
VOLUME ["/data", "/cache"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
