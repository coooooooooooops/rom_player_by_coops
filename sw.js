/* ═══════════════════════════════════════════════════
   ROM Player by Coops — Service Worker
═══════════════════════════════════════════════════ */

const CACHE_VERSION = 'rp-20261011192612';

const PRECACHE = [
  '/manifest.json',
  '/icon-180.png?v=20260804044638',
  '/icon-192.png?v=20260804044638',
  '/icon-512.png?v=20260804044638',
  '/icon-192-maskable.png?v=20260808050544',
  '/icon-512-maskable.png?v=20260808050544',
  '/emulator-backbone.js?v=20261011192612',
  '/mod-engine.js?v=20261011192612',
  'https://cdn.emulatorjs.org/stable/data/loader.js',
  'https://cdn.emulatorjs.org/stable/data/emulator.js',
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
];

// Always hit the network for these — never serve stale
const NETWORK_FIRST = [
  'version.json',
  'index.html',
  '/',
];

const SKIP_CACHE_HOSTS = [
  'api.thegamesdb.net',
  '0.peerjs.com',
  'supabase.co',
  'dropboxapi.com',
  'dropbox.com',
  'api.twitch.tv',
  'api.igdb.com',
  'id.twitch.tv',
];

// EmulatorJS core/data files — cache-first for offline play, but never let
// a transient CDN hiccup or cache-write failure (e.g. storage quota) throw
// an unhandled rejection out of the SW. Previously these hosts fell through
// to the generic cacheFirst() below with no isolation, so any wobble here
// (including, once, a header misconfiguration that made the CDN
// unreachable entirely) could surface as "no games load" across every
// system rather than a normal failed fetch that loader.js already reports
// with a clear message.
const RESILIENT_CDN_HOSTS = [
  'cdn.emulatorjs.org',
  'cdn.jsdelivr.net',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      return Promise.allSettled(
        PRECACHE.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Precache failed:', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;
  if (SKIP_CACHE_HOSTS.some(h => url.hostname.includes(h))) return;

  if (RESILIENT_CDN_HOSTS.some(h => url.hostname.includes(h))) {
    event.respondWith(resilientCdn(event.request));
    return;
  }

  const isNetworkFirst =
    event.request.mode === 'navigate' ||
    NETWORK_FIRST.some(name => url.pathname.endsWith(name) || url.pathname === '/');

  if (isNetworkFirst) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Everything else — cache first
  event.respondWith(cacheFirst(event.request));
});

async function resilientCdn(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') {
    try {
      const cache = await caches.open(CACHE_VERSION);
      await cache.put(request, response.clone());
    } catch (cacheErr) {
      // Non-fatal — e.g. storage quota. Never let a caching problem take
      // down emulator boot; the response itself is still returned below.
      console.warn('[SW] CDN cache write failed (non-fatal):', request.url, cacheErr);
    }
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Offline fallback
    const cached =
      await caches.match(request) ||
      await caches.match('/index.html') ||
      await caches.match('/');
    if (cached) return cached;
    return new Response('Offline', { status: 503 });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    throw err;
  }
}

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
