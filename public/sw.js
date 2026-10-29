// Network first, cache as fallback. Keeps the display up if the building's internet drops,
// including after a reboot. Only same-origin GET requests are handled.
// v5 (DP-11, round E1a): the shared screen code and the layout page; a layout's own fonts are kept as they're first used.
// v6 (E1b): a layout's pictures (/img/), kept once fetched.
// v7 (DP-12, E2a): the menu format (public/menu-format.mjs), which the layout format loads.
const CACHE = "directory-v7";
const SHELL = ["/", "/index.html", "/display.css", "/display.js", "/screen-core.js", "/vendor/qrcode.js",
  "/board.html", "/board.css", "/board.js", "/layout-format.mjs", "/menu-format.mjs",
  "/fonts/InstrumentSans-Regular.ttf", "/fonts/InstrumentSans-Bold.ttf", "/fonts/Lora-Bold.ttf"];

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
  const cacheable = SHELL.includes(url.pathname) || url.pathname.startsWith("/fonts/") || url.pathname.startsWith("/img/") || ["/api/screen", "/api/weather", "/api/news"].includes(url.pathname);
  if (!cacheable || e.request.headers.has("x-admin-password")) return;
  // Pictures (E1b): a picture's address never changes, so the kept copy is used first and the network only once
  if (url.pathname.startsWith("/img/")) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
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
        const hit = await caches.match(e.request, { ignoreSearch: ["/", "/index.html", "/board.html"].includes(url.pathname) });
        if (!hit) return Response.error();
        // Mark it so the page can show the "Reconnecting" note.
        const headers = new Headers(hit.headers);
        headers.set("X-Served-From", "offline-cache");
        return new Response(await hit.blob(), { status: hit.status, headers });
      })
  );
});
