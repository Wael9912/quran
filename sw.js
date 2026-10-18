// Browser build only: qr/build_web.py copies this to the site root (a service worker only controls
// pages under its own folder) and fills in CDN_TAG. It makes the installed app open offline:
//  · the page, static/ and web.json: network first (a new publish shows at once), the cache when offline;
//    fetched on install too, as on a first visit they load before this controls the page
//  · files named by their content (?v=<hash>, model-<hash>/, wheels/) and the pinned CDN files of
//    Pyodide and transformers.js: cache first, they never change under the same URL
// The worker (static/worker.js) is started only once this controls the page, so its fetches pass here
// on the very first visit too. Old copies are dropped whenever a new web.json arrives.
const CDN_TAG = 'c20f656084';             // hash of the CDN URLs in worker.js: new versions, new cache
const SHELL = 'qr-shell', FILES = 'qr-files', CDN = 'qr-cdn-' + CDN_TAG;
const BASE = new URL('./', self.location).href;

self.addEventListener('install', (e) => e.waitUntil((async () => {
  try {
    const m = await (await fetch(new URL('web.json', BASE), { cache: 'no-cache' })).json();
    const c = await caches.open(SHELL);
    await Promise.all(['', ...m.shell].map(async (f) => {
      const u = new URL(f, BASE).href, res = await fetch(u, { cache: 'no-cache' });
      if (res.ok) await c.put(u, res);
    }));
  } catch (err) { console.warn('precache:', err); }   // offline: the next visit fills it
  await self.skipWaiting();
})()));
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  // transformers.js's own copy of the model (worker.js turns it off: this file caches the model)
  for (const k of await caches.keys()) {
    if ((k.startsWith('qr-cdn-') && k !== CDN) || k === 'transformers-cache') await caches.delete(k);
  }
  await self.clients.claim();
})()));

const fixed = (u) => u.searchParams.has('v') || /\/(model-[0-9a-f]+|wheels)\//.test(u.pathname);

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin === self.location.origin) {
    if (!r.url.startsWith(BASE)) return;
    if (fixed(u)) e.respondWith(cacheFirst(FILES, r));
    else if (u.pathname.endsWith('/web.json')) e.respondWith(networkFirst(new URL('web.json', BASE).href, r, prune));
    else e.respondWith(networkFirst(r.mode === 'navigate' ? BASE : u.origin + u.pathname, r));
  } else if (u.hostname === 'cdn.jsdelivr.net') e.respondWith(cacheFirst(CDN, r));
});

async function cacheFirst(name, r) {
  const c = await caches.open(name);
  const hit = await c.match(r);
  if (hit) return hit;
  const res = await fetch(r);
  if (res.ok) await c.put(r, res.clone());
  return res;
}

// online: the network (after 8 s the cached copy answers instead, the network still refreshes it)
async function networkFirst(key, r, then) {
  const c = await caches.open(SHELL);
  const net = fetch(r, r.mode === 'navigate' ? undefined : { cache: 'no-cache' }).then(async (res) => {
    if (res.ok) { await c.put(key, res.clone()); if (then) await then(res.clone()); }
    return res;
  });
  net.catch(() => {});   // answered from the cache below
  const slow = new Promise((ok) => setTimeout(ok, 8000)).then(() => c.match(key));
  try {
    return (await Promise.race([net, slow.then((hit) => hit || net)]));
  } catch (err) {
    const hit = await c.match(key);
    if (hit) return hit;
    throw err;
  }
}

// a new web.json lists the files of the published version: drop cached files it no longer names
async function prune(res) {
  const m = await res.json();
  const keep = new Set([...m.py, ...m.data].map((f) => new URL(`${f}?v=${m.hash[f]}`, BASE).href));
  for (const w of m.wheels) keep.add(new URL(`wheels/${w}`, BASE).href);
  const c = await caches.open(FILES);
  for (const k of await c.keys()) {
    const p = k.url.slice(BASE.length);
    if (p.startsWith('model-') ? !p.startsWith(m.model + '/') : !keep.has(k.url)) await c.delete(k);
  }
  const shell = new Set(['', 'web.json', ...m.shell].map((f) => new URL(f, BASE).href));
  const s = await caches.open(SHELL);
  for (const k of await s.keys()) if (!shell.has(k.url)) await s.delete(k);
}
