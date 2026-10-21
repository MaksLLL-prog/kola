// Service worker Kolo: push-уведомления и быстрая загрузка (кэш оболочки приложения).
const CACHE = 'kolo-v10';
const SHELL = ['/', '/style.css', '/app.js', '/extras.js', '/icon-192.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).catch(() => {}));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Оболочка (страница, стили, скрипт): отдаём из кэша сразу и обновляем его в фоне — приложение открывается мгновенно.
// Загруженные картинки не меняются (имя — случайное), поэтому кэшируем их навсегда. API никогда не кэшируем.
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const isShell = req.mode === 'navigate' || SHELL.includes(url.pathname);
  if (isShell) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE), key = req.mode === 'navigate' ? '/' : req;
      const hit = await cache.match(key);
      const fresh = fetch(req).then((r) => { if (r.ok) cache.put(key, r.clone()); return r; }).catch(() => null);
      return hit || (await fresh) || Response.error();
    })());
  } else if (url.pathname.startsWith('/uploads/')) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE), hit = await cache.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) cache.put(req, r.clone());
      return r;
    })());
  }
});

// Входящее push-сообщение. Если Kolo сейчас открыт и виден — всплывашка не нужна, приложение покажет событие само.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Kolo', body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((c) => c.visibilityState === 'visible')) return;
    await self.registration.showNotification(d.title || 'Kolo', {
      body: d.body || '', icon: d.icon || '/icon-192.png', badge: '/icon-192.png',
      tag: d.tag, renotify: !!d.tag, data: { url: d.url || '#/' },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '#/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      const w = wins.find((c) => c.visibilityState === 'visible') || wins[0];
      await w.focus();
      w.postMessage({ goto: url });
    } else await self.clients.openWindow('/' + url);
  })());
});
