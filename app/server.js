'use strict';

// Baby's Favourites — tiny zero-dependency static server + JSON video API.
// Node built-ins only (http, fs, path, crypto). Persists the list to a single
// JSON file on a volume so it is shared across every device.

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'videos.json');
const TABS_FILE = path.join(DATA_DIR, 'tabs.json');
// The curated starting set. videos.json/tabs.json are runtime state and are not
// in git; these two seeds are, and are copied into place on first boot so a
// fresh deploy comes up populated instead of empty.
const DATA_SEED = path.join(DATA_DIR, 'videos.default.json');
const TABS_SEED = path.join(DATA_DIR, 'tabs.default.json');
// Audio pulled down by the media-sync sidecar: <videoId>.m4a plus a slim
// <videoId>.json of title/duration/channel.
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const APP_DIR = __dirname; // static files live next to this script (/app)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ── Data store ────────────────────────────────────────────────────────────────
// Serialise all writes through a single promise chain, and write-temp-then-rename
// so a crash or two simultaneous edits can never leave a half-written file.
// videos.json and tabs.json each get their own chain since they're independent files.
let videosWriteChain = Promise.resolve();
let tabsWriteChain = Promise.resolve();

async function readVideos() {
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error('readVideos failed:', err.message);
    return [];
  }
}

function saveVideos(list) {
  videosWriteChain = videosWriteChain.then(async () => {
    const tmp = DATA_FILE + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(list, null, 2));
    await fsp.rename(tmp, DATA_FILE);
  });
  return videosWriteChain;
}

async function readTabs() {
  try {
    const raw = await fsp.readFile(TABS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error('readTabs failed:', err.message);
    return [];
  }
}

function saveTabs(list) {
  tabsWriteChain = tabsWriteChain.then(async () => {
    const tmp = TABS_FILE + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(list, null, 2));
    await fsp.rename(tmp, TABS_FILE);
  });
  return tabsWriteChain;
}

// ── YouTube URL parsing ───────────────────────────────────────────────────────
// Accepts watch?v=, youtu.be/, /shorts/, /embed/, or a bare 11-char id.
function parseVideoId(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  const ID = /^[A-Za-z0-9_-]{11}$/;
  if (ID.test(s)) return s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return ID.test(id) ? id : null;
  }
  if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    const v = u.searchParams.get('v');
    if (v && ID.test(v)) return v;
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.findIndex((p) => p === 'shorts' || p === 'embed' || p === 'v' || p === 'live');
    if (i !== -1 && parts[i + 1] && ID.test(parts[i + 1])) return parts[i + 1];
  }
  return null;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ── Static files ──────────────────────────────────────────────────────────────
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  // Resolve within APP_DIR and refuse anything that escapes it.
  const filePath = path.normalize(path.join(APP_DIR, rel));
  if (!filePath.startsWith(APP_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) throw Object.assign(new Error('is dir'), { code: 'ENOENT' });
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // index.html and the service worker must never be cached, so updates land
    // immediately. Everything else (icons/css/js) is fine to cache briefly.
    const base = path.basename(filePath);
    if (base === 'index.html' || base === 'sw.js' || base === 'manifest.webmanifest') {
      headers['Cache-Control'] = 'no-cache';
    } else {
      headers['Cache-Control'] = 'public, max-age=3600';
    }
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // SPA fallback: unknown non-API path → serve the app shell.
      if (req.method === 'GET' && !rel.startsWith('/api/')) {
        try {
          const html = await fsp.readFile(path.join(APP_DIR, 'index.html'));
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          res.end(html);
          return;
        } catch { /* fall through */ }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } else {
      console.error('serveStatic error:', err.message);
      res.writeHead(500);
      res.end('server error');
    }
  }
}

// ── Downloaded audio ──────────────────────────────────────────────────────────
// iOS is the whole reason this exists. A cross-origin YouTube iframe can't be
// started by a tap on our page and WebKit suspends it the moment the screen
// locks, so background playback is only possible from a same-origin <audio>
// element — which means we have to hold the audio ourselves.
//
// Scanning the directory on every /api/videos call would be wasteful, so the
// index is cached and only rebuilt when the directory's mtime moves (which it
// does whenever the sidecar adds or prunes a file).
let mediaCache = { mtimeMs: -1, byId: new Map() };

async function mediaIndex() {
  let dirStat;
  try {
    dirStat = await fsp.stat(MEDIA_DIR);
  } catch {
    return new Map();
  }
  if (dirStat.mtimeMs === mediaCache.mtimeMs) return mediaCache.byId;

  const byId = new Map();
  let names;
  try {
    names = await fsp.readdir(MEDIA_DIR);
  } catch (err) {
    console.error('mediaIndex readdir failed:', err.message);
    return byId;
  }
  for (const name of names) {
    if (!name.endsWith('.m4a')) continue;
    const videoId = name.slice(0, -'.m4a'.length);
    let meta = {};
    try {
      meta = JSON.parse(await fsp.readFile(path.join(MEDIA_DIR, `${videoId}.json`), 'utf8'));
    } catch {
      /* audio without a sidecar still plays; it just has no title */
    }
    byId.set(videoId, {
      title: typeof meta.title === 'string' ? meta.title : null,
      duration: Number.isFinite(meta.duration) ? meta.duration : null,
      channel: typeof meta.channel === 'string' ? meta.channel : null,
    });
  }
  mediaCache = { mtimeMs: dirStat.mtimeMs, byId };
  return byId;
}

// Decorate the stored list with what the sidecar has fetched: a real title (the
// stored one is usually null), the duration, and whether audio is ready to play.
async function videosWithMedia() {
  const [list, index] = await Promise.all([readVideos(), mediaIndex()]);
  return list.map((v) => {
    const media = index.get(v.videoId);
    return {
      ...v,
      title: v.title || (media && media.title) || null,
      channel: (media && media.channel) || null,
      duration: (media && media.duration) || null,
      hasAudio: Boolean(media),
    };
  });
}

const MEDIA_PATH = /^\/media\/([A-Za-z0-9_-]{11})\.m4a$/;

async function serveMedia(req, res, videoId) {
  const filePath = path.join(MEDIA_DIR, `${videoId}.m4a`);
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return sendJson(res, 404, { error: 'not downloaded yet' });
  }

  const headers = {
    'Content-Type': 'audio/mp4',
    'Accept-Ranges': 'bytes',
    // Behind Authelia, so private; the file never changes once downloaded.
    'Cache-Control': 'private, max-age=604800',
  };

  // Safari opens every media element with a range request and refuses to play a
  // resource that answers 200 to one, so 206 support is mandatory, not an
  // optimisation.
  const match = /^bytes=(\d*)-(\d*)$/.exec((req.headers.range || '').trim());
  if (match) {
    let start;
    let end;
    if (match[1] === '') {
      // Suffix range ("last N bytes") — used to read the mp4 trailer.
      const wanted = match[2] === '' ? 0 : parseInt(match[2], 10);
      start = Math.max(0, stat.size - wanted);
      end = stat.size - 1;
    } else {
      start = parseInt(match[1], 10);
      end = match[2] === '' ? stat.size - 1 : Math.min(parseInt(match[2], 10), stat.size - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

// ── API ───────────────────────────────────────────────────────────────────────
async function handleApi(req, res, pathname) {
  // GET /api/tabs
  if (pathname === '/api/tabs' && req.method === 'GET') {
    return sendJson(res, 200, await readTabs());
  }

  // POST /api/tabs  { name }
  if (pathname === '/api/tabs' && req.method === 'POST') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req) || '{}');
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }
    const name = (typeof payload.name === 'string') ? payload.name.trim().slice(0, 30) : '';
    if (!name) return sendJson(res, 400, { error: 'Tab needs a name' });

    const tabs = await readTabs();
    const tab = { id: crypto.randomUUID(), name, addedAt: new Date().toISOString() };
    tabs.push(tab);
    await saveTabs(tabs);
    return sendJson(res, 201, tab);
  }

  // DELETE /api/tabs/:id — only allowed once empty, and never the last tab.
  const tm = pathname.match(/^\/api\/tabs\/([^/]+)$/);
  if (tm && req.method === 'DELETE') {
    const id = decodeURIComponent(tm[1]);
    const tabs = await readTabs();
    if (!tabs.some((t) => t.id === id)) return sendJson(res, 404, { error: 'not found' });
    if (tabs.length <= 1) return sendJson(res, 409, { error: 'Keep at least one tab' });

    const videos = await readVideos();
    if (videos.some((v) => v.tabId === id)) {
      return sendJson(res, 409, { error: 'Remove all videos from this tab first' });
    }
    await saveTabs(tabs.filter((t) => t.id !== id));
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/videos
  if (pathname === '/api/videos' && req.method === 'GET') {
    return sendJson(res, 200, await videosWithMedia());
  }

  // POST /api/videos  { url, title?, tabId? }
  if (pathname === '/api/videos' && req.method === 'POST') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req) || '{}');
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }
    const videoId = parseVideoId(payload.url);
    if (!videoId) return sendJson(res, 400, { error: 'Not a valid YouTube link' });

    const list = await readVideos();
    if (list.some((v) => v.videoId === videoId)) {
      return sendJson(res, 409, { error: 'That video is already in the list' });
    }
    const title = (typeof payload.title === 'string' && payload.title.trim())
      ? payload.title.trim().slice(0, 200)
      : null;
    // Fall back to the first tab if the caller didn't send a known tabId (e.g. a
    // browser tab still running stale cached app.js mid-deploy).
    const tabs = await readTabs();
    const tabId = (typeof payload.tabId === 'string' && tabs.some((t) => t.id === payload.tabId))
      ? payload.tabId
      : (tabs[0] && tabs[0].id);
    const item = {
      id: crypto.randomUUID(),
      videoId,
      title,
      addedAt: new Date().toISOString(),
      tabId,
    };
    list.push(item);
    await saveVideos(list);
    return sendJson(res, 201, item);
  }

  // DELETE /api/videos/:id
  const m = pathname.match(/^\/api\/videos\/([^/]+)$/);
  if (m && req.method === 'DELETE') {
    const id = decodeURIComponent(m[1]);
    const list = await readVideos();
    const next = list.filter((v) => v.id !== id);
    if (next.length === list.length) return sendJson(res, 404, { error: 'not found' });
    await saveVideos(next);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not found' });
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    // Match /media/ before the static handler so a missing file 404s instead of
    // falling through to the SPA shell (an <audio> element fed index.html just
    // fails with an opaque decode error).
    if (pathname.startsWith('/media/')) {
      const media = MEDIA_PATH.exec(pathname);
      if (media && (req.method === 'GET' || req.method === 'HEAD')) {
        return await serveMedia(req, res, media[1]);
      }
      return sendJson(res, 404, { error: 'not found' });
    }
    return await serveStatic(req, res, pathname);
  } catch (err) {
    console.error('request error:', err && err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('server error');
    }
  }
});

// Copy a tracked seed into place, but only when the live file is absent. Returns
// true if it seeded. Never overwrites live state, so this is safe on every boot.
async function seedIfMissing(liveFile, seedFile) {
  try {
    await fsp.access(liveFile);
    return false; // live file exists — leave it alone
  } catch { /* missing, fall through and try the seed */ }
  try {
    const seed = await fsp.readFile(seedFile, 'utf8');
    JSON.parse(seed); // refuse to install a seed that isn't valid JSON
    await fsp.writeFile(liveFile, seed);
    console.log(`seeded ${path.basename(liveFile)} from ${path.basename(seedFile)}`);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`seeding ${path.basename(liveFile)} failed:`, err.message);
    return false;
  }
}

// Make sure the data dir + file exist so the very first read/write is clean, and
// that every video has a tabId (self-healing migration, safe to run on every boot).
(async () => {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.mkdir(MEDIA_DIR, { recursive: true });

    // Tabs first: the seeded videos carry tabIds that reference the seeded tabs,
    // so generating a fresh tab before installing them would orphan every video.
    await seedIfMissing(TABS_FILE, TABS_SEED);
    await seedIfMissing(DATA_FILE, DATA_SEED);

    try {
      await fsp.access(DATA_FILE);
    } catch {
      await fsp.writeFile(DATA_FILE, '[]\n');
    }

    let tabs = await readTabs();
    if (tabs.length === 0) {
      const defaultTab = { id: crypto.randomUUID(), name: 'Nursery Rhymes', addedAt: new Date().toISOString() };
      tabs = [defaultTab];
      await saveTabs(tabs);
      console.log('created default tab "Nursery Rhymes"');
    }

    const videos = await readVideos();
    let changed = false;
    for (const v of videos) {
      if (!v.tabId) {
        v.tabId = tabs[0].id;
        changed = true;
      }
    }
    if (changed) {
      await saveVideos(videos);
      console.log('backfilled tabId on existing videos');
    }
  } catch (err) {
    console.error('could not prepare data dir:', err.message);
  }
  server.listen(PORT, () => console.log(`baby's-favourites listening on :${PORT}`));
})();
