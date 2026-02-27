// Minimal Service Worker for Local Push Notifications & App Badging
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
    if (event.data) {
        try {
            const data = event.data.json();
            const options = {
                body: data.body,
                icon: data.icon || '/icon.png',
                vibrate: [200, 100, 200],
                data: data.url
            };
            event.waitUntil(
                self.registration.showNotification(data.title, options)
            );
        } catch (e) {
            console.error("Push Event Error:", e);
        }
    }
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    // Clear Badge if Supported
    if (navigator.clearAppBadge) {
        navigator.clearAppBadge();
    }
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
            if (clientList.length > 0) {
                // Focus the first matching window/tab
                const client = clientList.find(c => c.focused) || clientList[0];
                return client.focus();
            }
            // Open a new window if the app is entirely closed
            return clients.openWindow('/');
        })
    );
});
