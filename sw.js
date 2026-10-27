// Service worker: يجعل التطبيق قابلاً للتثبيت ويفتح هيكل الصفحة حتى بدون إنترنت. لا تُخزَّن أي بيانات عملاء هنا
const CACHE = "biosyn-shell-v2";
const SHELL = ["./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];
const LIBS = ["https://cdn.jsdelivr.net/", "https://cdnjs.cloudflare.com/"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  if (r.mode === "navigate") { e.respondWith(fetch(r).then((res) => { if (res.ok) { const cp = res.clone(); caches.open(CACHE).then((c) => c.put("./index.html", cp)); } return res; }).catch(() => caches.match("./index.html"))); return; }
  const u = r.url;
  if (LIBS.some((p) => u.startsWith(p))) { e.respondWith(caches.match(r).then((hit) => hit || fetch(r).then((res) => { if (res.ok) { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(r, cp)); } return res; }))); return; }
  if (new URL(u).origin === self.location.origin && /\.(png|webmanifest)$/.test(u)) e.respondWith(caches.match(r).then((hit) => hit || fetch(r)));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => { for (const c of cs) { if ("focus" in c) return c.focus(); } return self.clients.openWindow("./"); }));
});
