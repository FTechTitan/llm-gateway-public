// Service worker del panel: abre rápido (pantalla guardada) y muestra las notificaciones push.
// Los datos (/admin, /rest, /auth) nunca se guardan: siempre van a la red.
const CACHE = 'panel-v13';
const BASE = ['/panel/', '/panel/reglas.js', '/panel/suscripciones.js', '/panel/llaves.js', '/panel/avisos.js', '/panel/proveedores.js', '/panel/filtros.js', '/panel/manifest.webmanifest',
  '/panel/iconos/icono-192.png', '/panel/iconos/insignia-96.png'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Red primero para la pantalla del panel; si no hay red, la copia guardada.
self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || url.origin !== location.origin) return;
  if (!url.pathname.startsWith('/panel/') || url.pathname === '/panel/config.js') return;
  ev.respondWith(fetch(ev.request)
    .then((r) => { if (r.ok) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(ev.request, copia)); } return r; })
    .catch(() => caches.match(ev.request).then((r) => r || caches.match('/panel/'))));
});

self.addEventListener('push', (ev) => {
  let m = {};
  try { m = ev.data ? ev.data.json() : {}; } catch { m = { titulo: 'llm-gateway', cuerpo: ev.data?.text() || '' }; }
  ev.waitUntil(self.registration.showNotification(m.titulo || 'llm-gateway', {
    body: m.cuerpo || '',
    icon: '/panel/iconos/icono-192.png',
    badge: '/panel/iconos/insignia-96.png',
    tag: m.etiqueta || undefined,
    renotify: Boolean(m.etiqueta),
    requireInteraction: Boolean(m.urgente),
    data: { url: m.url || '/panel/' },
  }));
});

self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  const destino = new URL(ev.notification.data?.url || '/panel/', location.origin).href;
  ev.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
    const abierta = ventanas.find((v) => v.url.startsWith(location.origin + '/panel/'));
    if (abierta) { abierta.navigate(destino); return abierta.focus(); }
    return self.clients.openWindow(destino);
  }));
});
