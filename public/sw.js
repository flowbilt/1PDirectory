// Network first, cache as fallback. Keeps the display up if the building's internet drops,
// including after a reboot. Only same-origin GET requests are handled.
const CACHE = "directory-v2";
const SHELL = ["/", "/index.html", "/display.css", "/display.js", "/fonts/InstrumentSans-Regular.ttf", "/fonts/InstrumentSans-Bold.ttf", "/fonts/Lora-Bold.ttf"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const cacheable = SHELL.includes(url.pathname) || ["/api/directory", "/api/weather", "/api/news"].includes(url.pathname);
  if (!cacheable || e.request.headers.has("x-admin-password")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(e.request, { ignoreSearch: url.pathname === "/" || url.pathname === "/index.html" });
        if (!hit) return Response.error();
        // Mark it so the page can show the "Reconnecting" note.
        const headers = new Headers(hit.headers);
        headers.set("X-Served-From", "offline-cache");
        return new Response(await hit.blob(), { status: hit.status, headers });
      })
  );
});
