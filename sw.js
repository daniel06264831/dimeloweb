self.addEventListener('push', function(event) {
	let data = {};
	try { data = event.data ? event.data.json() : {}; } catch(e){ data = {}; }
	const title = data.title || 'Notificación';
	const options = {
		body: data.body || '',
		icon: data.icon || '/favicon.ico',
		badge: data.badge || '/favicon.ico',
		data: { url: data.url || '/', tag: data.tag || null },
		tag: data.tag || undefined,
		renotify: !!data.renotify
	};
	event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
	event.notification.close();
	const url = (event.notification && event.notification.data && event.notification.data.url) || '/';
	event.waitUntil(
		clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
			for (let client of windowClients) {
				if (client.url && 'focus' in client) {
					client.postMessage({ type: 'navigate', url });
					return client.focus();
				}
			}
			if (clients.openWindow) return clients.openWindow(url);
		})
	);
});
