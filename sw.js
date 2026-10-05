// === Service Worker для приложения "Репетитор" ===
// Версия кеша — увеличивай при обновлениях (v1.0.0 → v1.0.1 → ...)
const CACHE_NAME = 'tutor-app-v1.1.3';

// Файлы для кеширования при первой загрузке
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// === Установка: кешируем основные файлы ===
self.addEventListener('install', (event) => {
  console.log('[SW] Установка...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Кеширую основные файлы');
        return cache.addAll(PRECACHE_URLS);
      })
      .then(() => self.skipWaiting())
  );
});

// === Активация: чистим старые кеши ===
self.addEventListener('activate', (event) => {
  console.log('[SW] Активация...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log('[SW] Удаляю старый кеш:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// === Fetch: Cache First, потом сеть ===
self.addEventListener('fetch', (event) => {
  const { request } = event;
  
  // Пропускаем не-GET запросы
  if (request.method !== 'GET') return;
  
  // Пропускаем внешние домены
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Отдаём из кеша, в фоне обновляем
        const fetchPromise = fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return networkResponse;
        }).catch(() => cachedResponse);
        
        return cachedResponse;
      }
      
      // Нет в кеше — идём в сеть
      return fetch(request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200) {
          return networkResponse;
        }
        const responseClone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(request, responseClone);
        });
        return networkResponse;
      }).catch(() => {
        // Офлайн-fallback
        if (request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('Офлайн-режим', { status: 503 });
      });
    })
  );
});

// === Обработка сообщений (для обновления по кнопке) ===
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
