// 도겸 수면 — 저장된 사본으로 먼저 열고 뒤에서 새 파일로 캐시를 바꿔 둔다 (다른 웹앱과 같은 틀, 2026-09-30)
// ⚠ index.html이 부르는 파일을 바꾸면 CACHE 버전과 OWN 목록을 같이 고친다.
const CACHE = 'dsleep-v20260930b';
const OWN = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./css/style.css?v=20260930a",
  "./js/sleep.js?v=20260930a",
  "./js/app.js?v=20260930a"
];
const CDN = [
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js"
];
// ⚠ 넓히지 말 것 — 로그인·DB 응답이 캐시되면 옛 데이터가 되살아난다
const CDN_HOSTS = ["www.gstatic.com"];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(cache => Promise.all([
    ...OWN.map(u => cache.add(new Request(u, { cache: 'reload' }))),
    ...CDN.map(u => cache.add(u).catch(() => {})),
  ])));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    // 이 앱 캐시만 지운다 — github.io 한 출처를 여러 웹앱이 나눠 쓴다
    .then(keys => Promise.all(keys.filter(k => k.startsWith('dsleep-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url; try { url = new URL(req.url); } catch { return; }
  const own = url.origin === self.location.origin && req.url.startsWith(self.registration.scope);
  if (!own && !CDN_HOSTS.includes(url.hostname)) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(req);
    const fresh = (own ? fetch(req.url, { cache: 'no-cache' }) : fetch(req)).then(res => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    });
    if (cached) { e.waitUntil(fresh.catch(() => {})); return cached; }
    return fresh.catch(() => req.destination === 'document' ? cache.match('./index.html') : Response.error());
  }));
});
