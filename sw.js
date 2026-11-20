// sw.js — NutriTürk Service Worker (Güncel Sürüm)
// Amaç: App Shell, MD3 ikonları, Roboto fontları ve statik varlıkları
// güvenle önbelleğe alıp sonraki girişlerde anında ve çevrimdışı sunmak.

const CACHE_VERSION = 'v3';
const FONT_CACHE = `nutriturk-fonts-${CACHE_VERSION}`;
const STATIC_CACHE = `nutriturk-static-${CACHE_VERSION}`;

// Uygulama kabuğu (App Shell) — her biri ayrı denenir, opsiyonel dosya yoksa kurulum bozulmaz
const APP_SHELL_URLS = [
  './',
  './index.html',
  './nutriturk-logo.png',
  './icons/manifest.json',
  './filistin.jpg'
];

// Harici statik kütüphane
const EXTERNAL_STATIC_URLS = [
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'
];

// Font CSS dosyaları
const FONT_CSS_URLS = [
  'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap',
  'https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block'
];

// Güvenli tekil cache yardımcısı (404 veya ağ hatasında kurulumu bozmaz)
async function safeCacheUrl(cache, url, fetchOptions = {}) {
  try {
    const res = await fetch(url, fetchOptions);
    if (res && res.ok) {
      await cache.put(url, res);
      return true;
    }
  } catch (_) {}
  return false;
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    // 1) App Shell + harici JS kütüphanesini önbelleğe al
    const staticCache = await caches.open(STATIC_CACHE);
    await Promise.all([
      ...APP_SHELL_URLS.map((u) => safeCacheUrl(staticCache, u)),
      ...EXTERNAL_STATIC_URLS.map((u) => safeCacheUrl(staticCache, u, { mode: 'cors' }))
    ]);

    // 2) Font CSS'lerini ve içlerindeki gerçek .woff2 font dosyalarını önden ısıt
    const fontCache = await caches.open(FONT_CACHE);
    await Promise.all(
      FONT_CSS_URLS.map(async (cssUrl) => {
        try {
          const res = await fetch(cssUrl, { mode: 'cors' });
          if (!res || !res.ok) return;
          await fontCache.put(cssUrl, res.clone());
          const cssText = await res.text();
          const fontUrls = [...cssText.matchAll(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/g)].map((m) => m[1]);
          await Promise.all(
            [...new Set(fontUrls)].map((fUrl) => safeCacheUrl(fontCache, fUrl, { mode: 'cors' }))
          );
        } catch (_) {}
      })
    );
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== FONT_CACHE && k !== STATIC_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Sadece GET ve http(s) isteklerini yönet (POST API çağrılarına dokunma)
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;

  const url = new URL(req.url);

  // 1) Canlı arama, fiyat ve adres API'lerini cache'leme (her zaman doğrudan ağ)
  if (
    url.hostname.includes('api.marketfiyati.org.tr') ||
    url.hostname.includes('openfoodfacts.org') && !url.hostname.startsWith('static.') ||
    url.hostname.includes('nominatim.openstreetmap.org') ||
    url.hostname.includes('bigdatacloud.net')
  ) {
    return;
  }

  // 2) Google Fonts (Roboto + Material Symbols): Cache-First
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.ok) await cache.put(req, res.clone());
        return res;
      } catch (err) {
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  // 3) Boykot listeleri (.txt): Network-First (güncel kalsın, offline'da cache'ten gelsin)
  if (url.hostname === 'raw.githubusercontent.com' && url.pathname.endsWith('.txt')) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      try {
        const res = await fetch(req);
        if (res && res.ok) await cache.put(req, res.clone());
        return res;
      } catch (_) {
        const cached = await cache.match(req);
        if (cached) return cached;
        throw new Error('Offline and not cached');
      }
    })());
    return;
  }

  // 4) Sayfa gezinme istekleri (HTML açılışı): Network-First + App Shell offline yedeği
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      try {
        const res = await fetch(req);
        if (res && res.ok) await cache.put(req, res.clone());
        return res;
      } catch (_) {
        return (
          (await cache.match(req)) ||
          (await cache.match('./index.html')) ||
          (await cache.match('./'))
        );
      }
    })());
    return;
  }

  // 5) Aynı domain statik dosyalar & CDN ikon/SVG varlıkları: Stale-While-Revalidate
  const isSameOrigin = url.origin === self.location.origin;
  const isTrustedStaticCdn =
    url.hostname === 'unpkg.com' ||
    url.hostname === 'raw.githubusercontent.com' ||
    url.hostname === 'static.openfoodfacts.org';

  if (isSameOrigin || isTrustedStaticCdn) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then(async (res) => {
          if (res && (res.ok || res.type === 'opaque')) {
            await cache.put(req, res.clone());
          }
          return res;
        })
        .catch(() => null);

      return cached || (await networkFetch);
    })());
  }
});
