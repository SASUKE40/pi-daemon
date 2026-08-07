const CACHE = "pi-daemon-assets-v3";
const APP_ASSETS = [
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/badge-96.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || (!url.pathname.startsWith("/assets/") && !APP_ASSETS.includes(url.pathname))) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) await cache.put(event.request, response.clone());
    return response;
  }));
});

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    payload = undefined;
  }
  const title = typeof payload?.title === "string" ? payload.title : "Pi session update";
  const body = typeof payload?.body === "string" ? payload.body : "Open Pi Daemon to review the result.";
  const data = payload?.data && typeof payload.data === "object" ? payload.data : { url: "/" };
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: typeof payload?.icon === "string" ? payload.icon : "/icon-192.png",
    badge: typeof payload?.badge === "string" ? payload.badge : "/badge-96.png",
    tag: typeof payload?.tag === "string" ? payload.tag : "pi-session-update",
    data,
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data && typeof event.notification.data === "object" ? event.notification.data : {};
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
  const requestedUrl = typeof data.url === "string" ? data.url : "/";
  const targetUrl = new URL(requestedUrl, self.location.origin);
  if (targetUrl.origin !== self.location.origin) targetUrl.href = self.location.origin;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      if (sessionId) existing.postMessage({ type: "open-session", sessionId });
      await existing.focus();
      return;
    }
    await self.clients.openWindow(targetUrl.href);
  })());
});
