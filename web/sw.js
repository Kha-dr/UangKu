const CACHE_VERSION = 'kasin-pwa-dev';
const SHARED_FILES_CACHE = 'shared-files';
const IS_LOCAL_DEV = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';

const PRECACHE_URLS = [
  './',
  './index.html',
  './privacy.html',
  './favicon.ico',
  './assets/css/style.css',
  './assets/img/logo.png',
  './js/app.js',
  './js/config.js',
  './js/utils.js',
  './js/webmcp.js',
  './js/voice.js',
  './js/db/schema.js',
  './js/db/worker.js',
  './js/db/client.js',
  './js/db/local-file.js',
  './js/models/transaksi.js',
  './js/models/rekening.js',
  './js/models/wishlist.js',
  './js/sync/gdrive.js',
  './js/sync/guard.js',
  './js/views/onboarding.js',
  './js/views/record.js',
  './js/views/transactions.js',
  './js/views/rekening.js',
  './js/views/wishlist.js',
  './js/views/analisis.js',
  './js/views/databases.js',
  './js/views/attachment.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch((error) => {
        console.error('Failed to precache:', error);
      })
      .finally(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch (err) {
          // Ignore if navigation preload is unsupported
        }
      }

      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_VERSION && cacheName !== SHARED_FILES_CACHE) {
            return caches.delete(cacheName);
          }
          return null;
        })
      );

      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never serve manifest.json from stale cache
  if (url.pathname.endsWith('/manifest.json') || url.pathname === 'manifest.json') {
    event.respondWith(fetch(request));
    return;
  }

  // Handle Web Share Target POSTs
  if (request.method === 'POST' && url.pathname.endsWith('pwa-share-handle')) {
    event.respondWith(
      (async () => {
        try {
          const formData = await request.formData();
          const file = formData.get('attachment');
          const title = formData.get('name') || '';
          const text = formData.get('description') || '';
          const link = formData.get('link') || '';

          const cache = await caches.open(SHARED_FILES_CACHE);

          if (file && file instanceof File && file.size > 0) {
            const fileResponse = new Response(file, {
              headers: {
                'Content-Type': file.type || 'application/octet-stream',
                'File-name': file.name || 'shared-file'
              }
            });
            await cache.put('./pwa-share-handle', fileResponse);
            return Response.redirect('./#/record', 303);
          }

          if (title || text || link) {
            const sharePayload = JSON.stringify({ title, text, url: link });
            const shareResponse = new Response(sharePayload, {
              headers: { 'Content-Type': 'application/json' }
            });
            await cache.put('./pwa-share-wishlist', shareResponse);
            return Response.redirect('./#/wishlist', 303);
          }
        } catch (error) {
          console.error('Share target handling failed:', error);
        }
        return Response.redirect('./#/record', 303);
      })()
    );
    return;
  }

  // Only cache GET requests
  if (request.method !== 'GET' || !url.protocol.startsWith('http')) {
    return;
  }

  // Navigation requests: network-first with cached index.html fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_VERSION);
        try {
          const preloadResponse = await event.preloadResponse;
          const networkResponse = preloadResponse || await fetch(request);
          if (networkResponse && networkResponse.ok) {
            cache.put('./index.html', networkResponse.clone());
          }
          return networkResponse;
        } catch (error) {
          const cachedIndex = await cache.match('./index.html') || await cache.match('./');
          return cachedIndex || Response.error();
        }
      })()
    );
    return;
  }

  // Same-origin static assets: network-first on localhost, cache-first with background refresh in production
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_VERSION);
        const cachedResponse = await cache.match(request);

        const networkFetch = fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
              const cacheControl = networkResponse.headers.get('Cache-Control') || '';
              if (!cacheControl.includes('no-store')) {
                cache.put(request, networkResponse.clone());
              }
            }
            return networkResponse;
          })
          .catch(() => null);

        if (IS_LOCAL_DEV) {
          const networkResponse = await networkFetch;
          return networkResponse || cachedResponse || Response.error();
        }

        if (cachedResponse) {
          event.waitUntil(networkFetch);
          return cachedResponse;
        }

        const networkResponse = await networkFetch;
        return networkResponse || Response.error();
      })()
    );
  }
});
