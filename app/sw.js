'use strict';

// Baby's Favourites — service worker.
// Precache the app shell for offline launch. Never cache the API or YouTube;
// the video list and the videos themselves always come from the network.
// Bump CACHE_VERSION whenever a shell asset (html/css/js/icons) changes.

const CACHE_VERSION = 'v5';
const CACHE_NAME = `babys-favourites-${CACHE_VERSION}`;

const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Only ever handle our own origin. Let YouTube / oEmbed / thumbnails go straight
  // to the network (don't cache them).
  if (url.origin !== self.location.origin) return;

  // The video list must always be fresh — never serve it from cache.
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;

  // Audio must reach the network untouched: Safari drives media elements with
  // range requests, and a worker-mediated response breaks playback outright.
  if (url.pathname.startsWith('/media/')) return;

  // App shell: network-first, fall back to cache so updates land when online but
  // the app still launches offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html'))),
  );
});
