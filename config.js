const nerConfigRoot = typeof window !== "undefined" ? window : self;

const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";

nerConfigRoot.NER_APP_CONFIG = {
  apiBaseUrl: isLocal ? "http://127.0.0.1:8000" : location.origin,
  defaultLocation: {
    name: "Aizawl",
    lat: 23.7271,
    lon: 92.7176
  }
};

nerConfigRoot.NER_FIREBASE_CONFIG = {
  apiKey: "AIzaSyCtDM_lyky0zi4OHPbMUY8igDTnYER2sfY",
  authDomain: "ner-logistics-intelligence.firebaseapp.com",
  projectId: "ner-logistics-intelligence",
  storageBucket: "ner-logistics-intelligence.firebasestorage.app",
  messagingSenderId: "1062792596707",
  appId: "1:1062792596707:web:f0192e411ea14607c0c9d6",
  measurementId: "G-N4GW3G6L7X"
};

nerConfigRoot.NER_FIREBASE_VAPID_KEY = "";

if (typeof self !== "undefined") {
  self.NER_FIREBASE_CONFIG = nerConfigRoot.NER_FIREBASE_CONFIG;
  self.NER_FIREBASE_VAPID_KEY = nerConfigRoot.NER_FIREBASE_VAPID_KEY;
}
