const CACHE = 'rivu-shell-v4';

const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/')
  ) {
    return;
  }

  // Always check the network first for pages.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();

            caches.open(CACHE).then(cache =>
              cache.put('/', copy)
            );
          }

          return response;
        })
        .catch(() =>
          caches.match('/').then(cached =>
            cached || caches.match(request)
          )
        )
    );

    return;
  }

  // Cache-first strategy for static assets.
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();

          caches.open(CACHE).then(cache =>
            cache.put(request, copy)
          );
        }

        return response;
      });
    })
  );
});


// Receive Web Push messages even when the RiVu page is not open.
self.addEventListener('push', event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      body: event.data
        ? event.data.text()
        : 'You have a new message.'
    };
  }

  const title = data.title || 'A message from RiVu ♡';

  const options = {
    body: data.body || 'You have a new message.',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    tag: data.tag || 'rivu-message',
    renotify: true,
    data: {
      url: data.url || '/?open=chat'
    },
    vibrate: [100, 50, 100]
  };

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    // Don't show a system notification if RiVu is already visible.
    if (windows.some(client => client.visibilityState === 'visible')) {
      return;
    }

    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const targetUrl = new URL(
    event.notification.data?.url || '/?open=chat',
    self.location.origin
  ).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        client.postMessage({ type: 'RIVU_OPEN_CHAT' });
        return;
      }
    }

    await self.clients.openWindow(targetUrl);
  })());
});