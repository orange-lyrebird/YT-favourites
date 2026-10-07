#!/bin/sh
# Baby's Favourites — media sync sidecar.
#
# Keeps $DATA_DIR/media holding one AAC audio file per video in the list, so the
# app can play from its own origin. That is the only way iOS will (a) start
# playback from the tap on a tile and (b) keep playing once the screen is off —
# a cross-origin YouTube iframe can do neither.
#
# Deliberately a poll loop over videos.json rather than something the app calls:
# it is stateless, self-heals after a crash or a half-finished download, and the
# initial backfill and later additions go down the exact same path.

set -u

DATA_DIR="${DATA_DIR:-/data}"
MEDIA_DIR="$DATA_DIR/media"
LIST="$DATA_DIR/videos.json"
POLL_SECONDS="${POLL_SECONDS:-60}"
RETRY_SECONDS="${RETRY_SECONDS:-3600}"
# Lives inside media/ so the one gitignore rule covers it too.
HEARTBEAT="$MEDIA_DIR/.alive"

mkdir -p "$MEDIA_DIR" || exit 1

# Print one video id per line, oldest first. Exits non-zero if the list can't be
# read or parsed — the caller skips the whole cycle in that case, so a truncated
# read can never be mistaken for "nothing is wanted" and prune the library.
wanted_ids() {
  python3 - "$LIST" <<'PY'
import json, re, sys

with open(sys.argv[1]) as handle:
    items = json.load(handle)
if not isinstance(items, list):
    raise SystemExit(1)

valid = re.compile(r'^[A-Za-z0-9_-]{11}$')
ids = []
for item in items:
    video_id = item.get('videoId') if isinstance(item, dict) else None
    if isinstance(video_id, str) and valid.match(video_id) and video_id not in ids:
        ids.append(video_id)
print('\n'.join(ids))
PY
}

# A recent failure marker means "don't hammer this one again yet".
backing_off() {
  marker="$MEDIA_DIR/.fail-$1"
  [ -f "$marker" ] || return 1
  [ $(( $(date +%s) - $(stat -c %Y "$marker") )) -lt "$RETRY_SECONDS" ]
}

fetch() {
  video_id="$1"
  echo "fetching $video_id"
  # Format is pinned to AAC-in-mp4 because Safari cannot decode the opus/webm
  # streams a bare "bestaudio" would happily pick; --audio-format m4a then
  # guarantees the container even if the last-resort fallback matched something
  # else. The metadata sidecar is written in the same pass, so titles cost no
  # extra request — they feed both the tile captions and the lock-screen display.
  if yt-dlp \
      -f "ba[ext=m4a]/ba[acodec^=mp4a]/ba" \
      --extract-audio --audio-format m4a --audio-quality 0 \
      --no-playlist --no-progress --no-warnings --retries 3 \
      --print-to-file "%(.{id,title,duration,channel})#j" "$MEDIA_DIR/%(id)s.json" \
      -o "$MEDIA_DIR/%(id)s.%(ext)s" \
      -- "https://www.youtube.com/watch?v=$video_id"; then
    rm -f "$MEDIA_DIR/.fail-$video_id"
    echo "ok $video_id"
  else
    # Private, removed, region-locked, or the extractor is having a bad day.
    echo "failed $video_id — retrying in ${RETRY_SECONDS}s"
    rm -f "$MEDIA_DIR/$video_id.json"
    touch "$MEDIA_DIR/.fail-$video_id"
  fi
}

# Drop files for videos no longer in the list, so removing a song in the UI
# reclaims its disk instead of leaving orphans forever.
prune() {
  keep="$1"
  for path in "$MEDIA_DIR"/*.m4a "$MEDIA_DIR"/*.json "$MEDIA_DIR"/.fail-*; do
    [ -e "$path" ] || continue
    name="${path##*/}"
    case "$name" in
      .fail-*) video_id="${name#.fail-}" ;;
      *)       video_id="${name%.*}" ;;
    esac
    printf '%s\n' "$keep" | grep -qxF "$video_id" && continue
    echo "pruning $name"
    rm -f "$path"
  done
}

echo "media sync started — poll ${POLL_SECONDS}s, media dir $MEDIA_DIR"
while :; do
  touch "$HEARTBEAT"
  if ids=$(wanted_ids); then
    for id in $ids; do
      [ -f "$MEDIA_DIR/$id.m4a" ] && continue
      backing_off "$id" && continue
      fetch "$id"
      touch "$HEARTBEAT" # a long backfill must not look like a hung loop
    done
    prune "$ids"
  else
    echo "could not read $LIST — skipping this cycle"
  fi
  sleep "$POLL_SECONDS"
done
