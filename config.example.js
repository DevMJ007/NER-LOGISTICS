const nerConfigRoot = typeof window !== "undefined" ? window : self;

nerConfigRoot.NER_APP_CONFIG = {
  apiBaseUrl: "http://127.0.0.1:8000",
  defaultLocation: {
    name: "Aizawl",
    lat: 23.7271,
    lon: 92.7176
  }
};

nerConfigRoot.NER_FIREBASE_CONFIG = {
  apiKey: "YOUR_FIREBASE_WEB_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_WEB_APP_ID",
  measurementId: "OPTIONAL_MEASUREMENT_ID"
};

nerConfigRoot.NER_FIREBASE_VAPID_KEY = "YOUR_FIREBASE_WEB_PUSH_CERTIFICATE_KEY_PAIR";

if (typeof self !== "undefined") {
  self.NER_FIREBASE_CONFIG = nerConfigRoot.NER_FIREBASE_CONFIG;
  self.NER_FIREBASE_VAPID_KEY = nerConfigRoot.NER_FIREBASE_VAPID_KEY;
}
