const SHELL = "echocrate-shell-v1";
const MEDIA = "echocrate-media-v1";
const APP_SHELL = ["/", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then((keys) => Promise.all(keys.filter((key) => ![SHELL, MEDIA].includes(key)).map((key) => caches.delete(key)))),
  ]));
});

function trackIdFrom(url) {
  return url.pathname.match(/^\/api\/tracks\/(\d+)\/audio$/)?.[1];
}

function rangeResponse(file, request) {
  const range = request.headers.get("range");
  if (!range) return new Response(file, { headers: { "content-type": "audio/mp4", "content-length": String(file.size), "accept-ranges": "bytes" } });
  const match = range.match(/bytes=(\d+)-(\d*)/);
  const start = Number(match?.[1] || 0);
  const end = match?.[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
  if (start >= file.size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${file.size}` } });
  const body = file.slice(start, end + 1);
  return new Response(body, {
    status: 206,
    headers: {
      "content-type": "audio/mp4",
      "content-length": String(body.size),
      "content-range": `bytes ${start}-${end}/${file.size}`,
      "accept-ranges": "bytes",
    },
  });
}

async function localMedia(request, trackId) {
  if (navigator.storage?.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(`track-${trackId}.media`);
      return rangeResponse(await handle.getFile(), request);
    } catch { /* not downloaded */ }
  }
  const cached = await (await caches.open(MEDIA)).match(`/api/tracks/${trackId}/audio`);
  if (!cached) return null;
  const file = await cached.blob();
  return rangeResponse(file, request);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const trackId = trackIdFrom(url);
  if (trackId) {
    event.respondWith((async () => (await localMedia(event.request, trackId)) || fetch(event.request))());
    return;
  }
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).then((response) => {
      const clone = response.clone();
      caches.open(SHELL).then((cache) => cache.put("/", clone));
      return response;
    }).catch(() => caches.match("/")));
    return;
  }
  if (url.origin === self.location.origin && event.request.method === "GET" && !url.pathname.startsWith("/api/")) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      const clone = response.clone();
      caches.open(SHELL).then((cache) => cache.put(event.request, clone));
      return response;
    })));
  }
});
