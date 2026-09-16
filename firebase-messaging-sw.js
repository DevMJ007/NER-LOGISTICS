importScripts("config.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js");

if (self.NER_FIREBASE_CONFIG && self.NER_FIREBASE_CONFIG.apiKey) {
  firebase.initializeApp(self.NER_FIREBASE_CONFIG);
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    const title = payload.notification?.title || "NER Logistics Alert";
    const options = {
      body: payload.notification?.body || "New logistics intelligence alert.",
      data: payload.data || {}
    };
    self.registration.showNotification(title, options);
  });
}
