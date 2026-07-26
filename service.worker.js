
// Cache do "esqueleto" do app. Estratégia: sempre tenta buscar a
// versão mais nova pela internet primeiro; só usa a cópia salva
// se estiver sem sinal. Isso evita ficar preso numa versão antiga
// depois de cada atualização. Os dados (produtos, estoque, dívidas,
// login) sempre vêm direto do Firebase — nunca do cache.

const CACHE_NAME = "leao-de-juda-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/firebase-config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  if (url.includes("firestore") || url.includes("firebase") || url.includes("googleapis")) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
