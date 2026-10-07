'use strict';

// Baby's Favourites — client. Renders tiles from the shared backend list, plays
// them either as same-origin audio (the default: starts on the tap, survives the
// screen going off, gets lock-screen controls) or as an embedded YouTube video,
// and (in edit mode) adds/removes videos.

const grid = document.getElementById('grid');
const emptyEl = document.getElementById('empty');
const loadErrorEl = document.getElementById('loadError');
const editToggle = document.getElementById('editToggle');
const audioToggle = document.getElementById('audioToggle');
const autoplayToggle = document.getElementById('autoplayToggle');
const tabList = document.getElementById('tabList');
const addTabBtn = document.getElementById('addTabBtn');
const addTabForm = document.getElementById('addTabForm');
const addTabInput = document.getElementById('addTabInput');
const addBar = document.getElementById('addBar');
const addInput = document.getElementById('addInput');
const addMsg = document.getElementById('addMsg');
const player = document.getElementById('player');
const playerFrame = document.getElementById('playerFrame');
const playerClose = document.getElementById('playerClose');
const playerWatch = document.getElementById('playerWatch');
const playerYt = document.getElementById('playerYt');
const retryBtn = document.getElementById('retryBtn');
const audioEl = document.getElementById('audioEl');
const audioStage = document.getElementById('audioStage');
const audioArt = document.getElementById('audioArt');
const audioTitle = document.getElementById('audioTitle');
const audioSeek = document.getElementById('audioSeek');
const audioElapsed = document.getElementById('audioElapsed');
const audioDuration = document.getElementById('audioDuration');
const audioPrev = document.getElementById('audioPrev');
const audioNext = document.getElementById('audioNext');
const audioPlayPause = document.getElementById('audioPlayPause');
const audioMsg = document.getElementById('audioMsg');

// Default playback is a direct, privacy-enhanced YouTube embed (youtube-nocookie.com).
let videos = [];
let tabs = [];
let activeTabId = null;
let editing = false;

// ── Preferences ───────────────────────────────────────────────────────────────
// Both default on: audio-only is the mode that actually works on a locked
// iPhone, and rolling on to the next song is what you want from a favourites
// list. Kept in localStorage so the choice survives a reload.
const PREFS_KEY = 'babys-favourites:prefs';
const prefs = loadPrefs();

function loadPrefs() {
  const defaults = { audioOnly: true, autoplay: true };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return {
      audioOnly: typeof saved.audioOnly === 'boolean' ? saved.audioOnly : defaults.audioOnly,
      autoplay: typeof saved.autoplay === 'boolean' ? saved.autoplay : defaults.autoplay,
    };
  } catch {
    return defaults;
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private browsing — the toggles still work for this session */
  }
}

function renderPrefs() {
  audioToggle.setAttribute('aria-pressed', String(prefs.audioOnly));
  autoplayToggle.setAttribute('aria-pressed', String(prefs.autoplay));
}

// ── Networking ────────────────────────────────────────────────────────────────
// If the Authelia session has expired the API returns an HTML redirect instead of
// JSON; detect that and reload so the user is sent through the login page again.
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    // Session likely expired → bounce through login.
    location.reload();
    throw new Error('session expired');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data && data.error ? data.error : 'request failed');
  return data;
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function thumbUrl(videoId) {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

function makeTile(v) {
  const tile = document.createElement('button');
  tile.className = 'tile';
  tile.type = 'button';
  tile.dataset.id = v.id;
  tile.dataset.videoId = v.videoId;

  const img = document.createElement('img');
  img.className = 'tile-thumb';
  img.loading = 'lazy';
  img.alt = v.title || 'Video';
  img.src = thumbUrl(v.videoId);
  // hqdefault always exists; if even that fails, fall back to a neutral tile.
  img.onerror = () => { img.style.visibility = 'hidden'; };

  // In audio mode a tile can only play once the sidecar has the file, so show an
  // hourglass rather than a play arrow that would do nothing.
  const pending = prefs.audioOnly && !v.hasAudio;
  const play = document.createElement('span');
  play.className = pending ? 'tile-play tile-play-pending' : 'tile-play';
  play.textContent = pending ? '⏳' : '▶';

  const title = document.createElement('span');
  title.className = 'tile-title';
  title.textContent = v.title || 'Tap to play';

  const remove = document.createElement('span');
  remove.className = 'tile-remove';
  remove.textContent = '✕';
  remove.title = 'Remove';
  remove.setAttribute('role', 'button');
  remove.dataset.remove = v.id;

  tile.append(img, play, title, remove);

  return tile;
}

function makeTabPill(t) {
  const pill = document.createElement('button');
  pill.className = 'tab-pill';
  pill.type = 'button';
  pill.dataset.tabId = t.id;
  pill.setAttribute('role', 'tab');
  pill.setAttribute('aria-selected', String(t.id === activeTabId));

  const label = document.createElement('span');
  label.className = 'tab-pill-label';
  label.textContent = t.name;
  pill.appendChild(label);

  // Only ever show a remove control on an empty tab, and never on the last tab —
  // the server enforces this too, but the UI simply doesn't offer the button
  // rather than showing it disabled.
  const isEmpty = !videos.some((v) => v.tabId === t.id);
  if (isEmpty && tabs.length > 1) {
    const remove = document.createElement('span');
    remove.className = 'tab-pill-remove';
    remove.textContent = '✕';
    remove.title = 'Remove tab';
    remove.setAttribute('role', 'button');
    remove.dataset.removeTab = t.id;
    pill.appendChild(remove);
  }

  return pill;
}

function renderTabs() {
  tabList.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const t of tabs) frag.appendChild(makeTabPill(t));
  tabList.appendChild(frag);
}

function render() {
  renderTabs();
  grid.innerHTML = '';
  loadErrorEl.hidden = true;
  const activeVideos = videos.filter((v) => v.tabId === activeTabId);
  if (activeVideos.length === 0) {
    emptyEl.hidden = false;
    grid.setAttribute('aria-busy', 'false');
    return;
  }
  emptyEl.hidden = true;
  const frag = document.createDocumentFragment();
  for (const v of activeVideos) frag.appendChild(makeTile(v));
  grid.appendChild(frag);
  grid.setAttribute('aria-busy', 'false');
}

function setActiveTab(id) {
  if (id === activeTabId) return;
  activeTabId = id;
  render();
}

async function load({ quiet = false } = {}) {
  if (!quiet) grid.setAttribute('aria-busy', 'true');
  try {
    [tabs, videos] = await Promise.all([api('GET', '/api/tabs'), api('GET', '/api/videos')]);
    if (!tabs.some((t) => t.id === activeTabId)) activeTabId = tabs[0] && tabs[0].id;
    render();
    syncQueue();
    // Newly added songs take a minute or two to come down; keep checking until
    // every one of them has audio, then leave the server alone.
    if (videos.some((v) => !v.hasAudio)) scheduleRefresh();
  } catch (err) {
    if (err.message === 'session expired') return;
    console.error(err);
    if (quiet) return; // a failed background poll shouldn't blow away the grid
    emptyEl.hidden = true;
    loadErrorEl.hidden = false;
    grid.setAttribute('aria-busy', 'false');
  }
}

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    load({ quiet: true });
  }, 15000);
}

// ── Player ────────────────────────────────────────────────────────────────────
let currentVideoId = null;

function renderYoutubeEmbed(videoId) {
  const iframe = document.createElement('iframe');
  // rel=0 keeps "related videos" restricted to the same channel.
  iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0`;
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  iframe.allowFullscreen = true;
  playerFrame.innerHTML = '';
  playerFrame.appendChild(iframe);
}

// ── Audio mode ────────────────────────────────────────────────────────────────
// The shape of all of this is dictated by two WebKit rules: playback has to be
// kicked off inside the tap handler, and only a same-origin <audio> element
// keeps running once the screen is off. So there is exactly one audio element,
// reused for every track — once a tap has unlocked it, auto-advance and the
// lock-screen buttons can drive it without a fresh gesture.
let queue = [];
let queueIndex = -1;
let scrubbing = false;

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function currentTrack() {
  return queueIndex >= 0 ? queue[queueIndex] : null;
}

// Keep the open queue pointing at the freshly loaded objects, so a track whose
// download finished mid-session becomes playable without reopening the player.
function syncQueue() {
  if (queueIndex < 0) return;
  const playing = queue[queueIndex];
  if (!playing) return;
  const fresh = videos.filter((v) => v.tabId === playing.tabId);
  const index = fresh.findIndex((v) => v.videoId === playing.videoId);
  // The track was removed from the list while it was open — keep playing what we
  // have rather than stranding the transport on an index that no longer exists.
  if (index === -1) return;
  queue = fresh;
  queueIndex = index;
  audioNext.disabled = index >= queue.length - 1;
  const track = currentTrack();
  if (track.title) audioTitle.textContent = track.title;
  if (track.hasAudio && !audioEl.currentSrc) {
    // Ready now, but starting it here would be a play without a gesture — and
    // the element was never unlocked, since the first tap had nothing to play.
    audioMsg.textContent = 'Ready! Tap ▶ to start.';
  }
}

function updateMediaMetadata(track) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title || 'Favourite',
    artist: track.channel || "Ava's Favourites",
    artwork: [{ src: thumbUrl(track.videoId), sizes: '480x360', type: 'image/jpeg' }],
  });
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const duration = audioEl.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: audioEl.playbackRate || 1,
      position: Math.min(audioEl.currentTime, duration),
    });
  } catch {
    /* Safari throws if the values drift out of range mid-seek */
  }
}

function setPlayingUi(playing) {
  audioPlayPause.textContent = playing ? '⏸' : '▶';
  audioPlayPause.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }
}

function playTrack(index) {
  const track = queue[index];
  if (!track) return;
  queueIndex = index;
  currentVideoId = track.videoId;

  audioMsg.textContent = '';
  audioArt.src = thumbUrl(track.videoId);
  audioTitle.textContent = track.title || 'Loading…';
  audioSeek.value = 0;
  audioElapsed.textContent = '0:00';
  audioDuration.textContent = track.duration ? formatTime(track.duration) : '0:00';
  // Prev stays live even on the first track — it restarts what's playing.
  audioNext.disabled = index >= queue.length - 1;
  playerYt.href = `https://www.youtube.com/watch?v=${track.videoId}`;
  updateMediaMetadata(track);

  if (!track.hasAudio) {
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
    setPlayingUi(false);
    audioMsg.textContent = 'Still getting this one ready — tap “Watch the video” for now.';
    scheduleRefresh();
    return;
  }

  // Assigning src and calling play() in the same turn as the tap is what makes
  // this start without a second press.
  audioEl.src = `/media/${track.videoId}.m4a`;
  const started = audioEl.play();
  if (started && typeof started.catch === 'function') {
    started.catch((err) => {
      console.warn('playback blocked', err);
      setPlayingUi(false);
      audioMsg.textContent = 'Tap ▶ to start.';
    });
  }
}

function step(delta) {
  const next = queueIndex + delta;
  if (next < 0 || next >= queue.length) return;
  playTrack(next);
}

function stopAudio() {
  audioEl.pause();
  audioEl.removeAttribute('src');
  audioEl.load();
  queue = [];
  queueIndex = -1;
  setPlayingUi(false);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  }
}

// ── Opening / closing ─────────────────────────────────────────────────────────
function showAudioMode(videoId) {
  const inTab = videos.filter((v) => v.tabId === activeTabId);
  const index = inTab.findIndex((v) => v.videoId === videoId);
  playerFrame.hidden = true;
  playerFrame.innerHTML = '';
  audioStage.hidden = false;
  playerWatch.hidden = false;
  queue = inTab;
  playTrack(index === -1 ? 0 : index);
}

function showVideoMode(videoId) {
  stopAudio();
  currentVideoId = videoId;
  audioStage.hidden = true;
  playerWatch.hidden = true;
  playerFrame.hidden = false;
  playerYt.href = `https://www.youtube.com/watch?v=${videoId}`;
  renderYoutubeEmbed(videoId);
}

function openPlayer(videoId) {
  player.hidden = false;
  document.body.style.overflow = 'hidden';
  if (prefs.audioOnly) showAudioMode(videoId);
  else showVideoMode(videoId);
}

function closePlayer() {
  player.hidden = true;
  playerFrame.innerHTML = ''; // stop playback
  stopAudio();
  currentVideoId = null;
  document.body.style.overflow = '';
}

// ── Add / remove ────────────────────────────────────────────────────────────────
async function addVideo(e) {
  e.preventDefault();
  const url = addInput.value.trim();
  if (!url) return;
  addMsg.textContent = 'Adding…';
  addMsg.className = 'add-msg';
  try {
    const item = await api('POST', '/api/videos', { url, tabId: activeTabId });
    videos.push(item);
    render();
    addInput.value = '';
    addMsg.textContent = 'Added! 🎉';
    addMsg.className = 'add-msg ok';
  } catch (err) {
    if (err.message === 'session expired') return;
    addMsg.textContent = err.message || 'Could not add that link';
    addMsg.className = 'add-msg';
  }
}

async function removeVideo(id) {
  const v = videos.find((x) => x.id === id);
  const label = (v && v.title) ? `“${v.title}”` : 'this video';
  if (!confirm(`Remove ${label} from the list?`)) return;
  try {
    await api('DELETE', `/api/videos/${encodeURIComponent(id)}`);
    videos = videos.filter((x) => x.id !== id);
    render();
  } catch (err) {
    if (err.message === 'session expired') return;
    alert(err.message || 'Could not remove that video');
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function showAddTabForm(show) {
  addTabForm.hidden = !show;
  if (show) {
    addTabInput.value = '';
    setTimeout(() => addTabInput.focus(), 50);
  }
}

async function addTab(e) {
  e.preventDefault();
  const name = addTabInput.value.trim();
  if (!name) return;
  try {
    const tab = await api('POST', '/api/tabs', { name });
    tabs.push(tab);
    activeTabId = tab.id;
    showAddTabForm(false);
    render();
  } catch (err) {
    if (err.message === 'session expired') return;
    alert(err.message || 'Could not add that tab');
  }
}

async function removeTab(id) {
  const t = tabs.find((x) => x.id === id);
  const label = t ? `“${t.name}”` : 'this tab';
  if (!confirm(`Remove the ${label} tab?`)) return;
  try {
    await api('DELETE', `/api/tabs/${encodeURIComponent(id)}`);
    tabs = tabs.filter((x) => x.id !== id);
    if (activeTabId === id) activeTabId = tabs[0] && tabs[0].id;
    render();
  } catch (err) {
    if (err.message === 'session expired') return;
    alert(err.message || 'Could not remove that tab');
  }
}

// ── Edit mode ─────────────────────────────────────────────────────────────────
function setEditing(on) {
  editing = on;
  document.body.classList.toggle('editing', on);
  editToggle.setAttribute('aria-pressed', String(on));
  editToggle.querySelector('.edit-label').textContent = on ? 'Done' : 'Edit';
  addBar.hidden = !on;
  addMsg.textContent = '';
  if (on) setTimeout(() => addInput.focus(), 50);
  if (!on) showAddTabForm(false);
}

// ── Events ────────────────────────────────────────────────────────────────────
grid.addEventListener('click', (e) => {
  const removeBtn = e.target.closest('[data-remove]');
  if (removeBtn) {
    e.stopPropagation();
    removeVideo(removeBtn.dataset.remove);
    return;
  }
  const tile = e.target.closest('.tile');
  if (tile) openPlayer(tile.dataset.videoId);
});

tabList.addEventListener('click', (e) => {
  const removeBtn = e.target.closest('[data-remove-tab]');
  if (removeBtn) {
    e.stopPropagation();
    removeTab(removeBtn.dataset.removeTab);
    return;
  }
  const pill = e.target.closest('.tab-pill');
  if (pill) setActiveTab(pill.dataset.tabId);
});

addTabBtn.addEventListener('click', () => showAddTabForm(addTabForm.hidden));
addTabForm.addEventListener('submit', addTab);

editToggle.addEventListener('click', () => setEditing(!editing));
addBar.addEventListener('submit', addVideo);
playerClose.addEventListener('click', closePlayer);
playerWatch.addEventListener('click', () => {
  // One-off peek at the video without giving up audio mode as the default.
  if (currentVideoId) showVideoMode(currentVideoId);
});

audioToggle.addEventListener('click', () => {
  prefs.audioOnly = !prefs.audioOnly;
  savePrefs();
  renderPrefs();
  render();
  if (!player.hidden && currentVideoId) openPlayer(currentVideoId);
});

autoplayToggle.addEventListener('click', () => {
  prefs.autoplay = !prefs.autoplay;
  savePrefs();
  renderPrefs();
});

// ── Audio transport ───────────────────────────────────────────────────────────
audioPlayPause.addEventListener('click', () => {
  if (!currentTrack()) return;
  // No source yet means the download landed after we opened the player; this tap
  // is the gesture that gets to start it.
  if (!audioEl.currentSrc) {
    playTrack(queueIndex);
    return;
  }
  if (audioEl.paused) audioEl.play().catch(() => { /* surfaced by the error handler */ });
  else audioEl.pause();
});

audioNext.addEventListener('click', () => step(1));
audioPrev.addEventListener('click', () => {
  // Same as every other music player: back up to the start first, then jump.
  if (audioEl.currentTime > 3) {
    audioEl.currentTime = 0;
    return;
  }
  step(-1);
});

audioSeek.addEventListener('pointerdown', () => { scrubbing = true; });
audioSeek.addEventListener('input', () => {
  const duration = audioEl.duration;
  if (Number.isFinite(duration) && duration > 0) {
    audioElapsed.textContent = formatTime((audioSeek.value / 1000) * duration);
  }
});
function commitSeek() {
  const duration = audioEl.duration;
  if (Number.isFinite(duration) && duration > 0) {
    audioEl.currentTime = (audioSeek.value / 1000) * duration;
  }
  scrubbing = false;
}
audioSeek.addEventListener('change', commitSeek);
audioSeek.addEventListener('pointerup', commitSeek);

audioEl.addEventListener('play', () => setPlayingUi(true));
audioEl.addEventListener('pause', () => setPlayingUi(false));
audioEl.addEventListener('loadedmetadata', () => {
  audioDuration.textContent = formatTime(audioEl.duration);
  updatePositionState();
});
audioEl.addEventListener('timeupdate', () => {
  audioElapsed.textContent = formatTime(audioEl.currentTime);
  if (!scrubbing) {
    const duration = audioEl.duration;
    audioSeek.value = (Number.isFinite(duration) && duration > 0)
      ? Math.round((audioEl.currentTime / duration) * 1000)
      : 0;
  }
  updatePositionState();
});
audioEl.addEventListener('ended', () => {
  if (prefs.autoplay && queueIndex < queue.length - 1) {
    step(1);
    return;
  }
  audioMsg.textContent = prefs.autoplay ? 'That was the last one 💤' : '';
});
audioEl.addEventListener('error', () => {
  // Clearing the source on close fires this too; ignore that case.
  if (!audioEl.currentSrc) return;
  audioMsg.textContent = 'Could not play that one — try “Watch the video”.';
});

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const handle = (action, fn) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      /* iOS doesn't offer every action; skip the ones it rejects */
    }
  };
  handle('play', () => audioEl.play().catch(() => {}));
  handle('pause', () => audioEl.pause());
  handle('previoustrack', () => step(-1));
  handle('nexttrack', () => step(1));
  handle('seekto', (details) => {
    if (!Number.isFinite(details.seekTime)) return;
    if (details.fastSeek && typeof audioEl.fastSeek === 'function') audioEl.fastSeek(details.seekTime);
    else audioEl.currentTime = details.seekTime;
    updatePositionState();
  });
}
player.addEventListener('click', (e) => { if (e.target === player) closePlayer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !player.hidden) closePlayer(); });
if (retryBtn) retryBtn.addEventListener('click', load);

// ── Boot ──────────────────────────────────────────────────────────────────────
setEditing(false); // always start locked so a toddler can't delete by accident
renderPrefs();
load();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW failed', err));
  });
}
