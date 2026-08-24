/*
 * ═══════════════════════════════════════════════════════════════════════════
 * The service worker. Deliberately, aggressively conservative.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ IT NEVER CACHES A PAGE. NOT ONE.                                          ║
 * ║                                                                           ║
 * ║ Every screen in this app is server-rendered per user and scoped by row-   ║
 * ║ level security: a chef's dashboard, a candidate's paper, another brand's  ║
 * ║ question bank. A cached HTML response is a document belonging to whoever  ║
 * ║ was signed in when it was stored, and a service worker cache is shared    ║
 * ║ across every session on the device — a shared phone in a kitchen is the   ║
 * ║ normal case here, not the exotic one.                                     ║
 * ║                                                                           ║
 * ║ So the only things that go in the cache are the ones that are identical   ║
 * ║ for everybody: content-hashed build assets, fonts, icons, and the offline ║
 * ║ page. Everything else goes to the network every time, and when the        ║
 * ║ network is not there the person is told so rather than shown a stale      ║
 * ║ answer they cannot tell is stale.                                         ║
 * ║                                                                           ║
 * ║ WHAT MUST NOT BE ADDED LATER: a "stale-while-revalidate" for navigations, ║
 * ║ however tempting the speed is. The failure it produces — one candidate    ║
 * ║ seeing another's exam — is not a performance regression.                  ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

/*
 * Bumping this name is how a deploy takes effect: the new worker precaches
 * under the new key and deletes every older one on activate. The date is part
 * of it so two deploys on the same day still differ.
 */
const CACHE = 'bookends-v1-2026-08-24'

/** Identical for every user, and needed before the network is gone. */
const PRECACHE = ['/offline.html', '/icons/icon-192.png', '/icons/icon-512.png', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  /*
   * No skipWaiting. A new worker taking over mid-session can reload the page
   * under somebody, and this app is used to sit timed exams — losing a
   * half-finished attempt to a deploy is not a trade worth making for a
   * slightly faster rollout. The update lands the next time the app is opened.
   */
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

/** Content-hashed by the build, so the URL changes whenever the bytes do. */
const isImmutable = (url) =>
  url.pathname.startsWith('/_next/static/') ||
  url.pathname.startsWith('/fonts/') ||
  url.pathname.startsWith('/icons/')

self.addEventListener('fetch', (event) => {
  const { request } = event

  /*
   * Anything that is not a plain GET is a Server Action, a sign-in, an import
   * commit — a thing that changes state. A service worker has no business
   * replaying or short-circuiting those, and `event.respondWith` is simply not
   * called so the browser handles it exactly as it would with no worker at all.
   */
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Supabase, fonts.googleapis, anything not ours: not our business.
  if (url.origin !== self.location.origin) return

  // Generated PDFs and CSV exports are per-user documents. Never stored.
  if (url.pathname.startsWith('/api/')) return

  /*
   * Build assets. Cache-first is safe ONLY because the filename contains a
   * hash of the contents — a changed file is a different URL, so a stale hit
   * is impossible rather than unlikely.
   */
  if (isImmutable(url)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone()
              caches.open(CACHE).then((cache) => cache.put(request, copy))
            }
            return response
          }),
      ),
    )
    return
  }

  /*
   * A page. Always the network — see the box at the top. The cache is consulted
   * only when the network fails, and only for the one page that belongs to
   * nobody: the offline notice.
   */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const offline = await caches.match('/offline.html')
        return (
          offline ??
          new Response('You are offline.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          })
        )
      }),
    )
  }

  // Everything else — data fetches, prefetches — is left entirely alone.
})
