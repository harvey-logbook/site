// Keeps a copy of the app on this device so it opens offline. Each release
// gets its own cache; a new release waits until the page asks it to take over.
const VERSION = 'bc719112fa47';
const CACHE = 'logbook-' + VERSION;
const FILES = [
  "index.html",
  "app.css",
  "config.js",
  "manifest.webmanifest",
  "js/synccore.js",
  "js/platform.js",
  "js/engine.js",
  "js/logparse.js",
  "js/dayplan.js",
  "js/localai.js",
  "js/app.js",
  "fonts/barlow-400.woff2",
  "fonts/barlow-500.woff2",
  "fonts/barlow-600.woff2",
  "fonts/barlow-condensed-500.woff2",
  "fonts/barlow-condensed-600.woff2",
  "fonts/barlow-condensed-700.woff2",
  "fonts/ibm-plex-mono-400.woff2",
  "fonts/ibm-plex-mono-500.woff2",
  "icons/icon.svg",
  "icons/favicon-32.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png"
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('logbook-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google sign-in and APIs go straight to the network
  const base = new URL(self.registration.scope).pathname;
  const rel = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : null;
  if (rel === 'config.js') {
    // the Google client ID can change without a new release, so fetch it fresh when online
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('config.js', copy)); }
      return res;
    }).catch(() => caches.match('config.js', { cacheName: CACHE }).then((r) => r || Response.error())));
    return;
  }
  if (req.mode === 'navigate' && (rel === '' || rel === 'index.html')) {
    e.respondWith(caches.match('index.html', { cacheName: CACHE }).then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true, cacheName: CACHE }).then((r) => r || fetch(req)));
});
