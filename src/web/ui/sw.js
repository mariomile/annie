// Annie's service worker: the console opens from the home screen and without network shows its
// shell. Only the shell is kept (page, script, style, fonts, icons): never /api, never anything a
// person wrote or received. Network first, so a new version is used as soon as it is online.
const CACHE = "annie-shell-v1";
const SHELL = ["/", "/app.js", "/app.css", "/icon.svg", "/manifest.webmanifest", "/fonts/geist-latin.woff2", "/fonts/geist-mono-latin.woff2"];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(SHELL))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	const navigation = request.mode === "navigate";
	if (!navigation && !SHELL.includes(url.pathname)) return;
	event.respondWith(
		fetch(request)
			.then((response) => {
				if (response.ok && !navigation) {
					const copy = response.clone();
					void caches.open(CACHE).then((cache) => cache.put(request, copy));
				}
				return response;
			})
			// Offline: the page from the shell (it says it is offline), the files as last seen.
			.catch(() => caches.match(navigation ? "/" : request).then((hit) => hit ?? Response.error())),
	);
});
