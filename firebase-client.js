const firebaseConfig = window.NER_FIREBASE_CONFIG || {};
const vapidKey = window.NER_FIREBASE_VAPID_KEY || "";

function configured(config) {
  return Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);
}

function dispatch(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

async function registerToken(token) {
  const baseUrl = window.NER_APP_CONFIG?.apiBaseUrl || "http://127.0.0.1:8000";
  await fetch(`${baseUrl}/api/alerts/register-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      role: localStorage.getItem("ner:role") || "district_officer",
      district: localStorage.getItem("ner:district") || "Aizawl"
    })
  });
}

async function bootFirebase() {
  if (!configured(firebaseConfig)) {
    window.nerFirebase = {
      configured: false,
      signIn: async () => dispatch("ner:toast", { message: "Add Firebase web config in config.js first." }),
      signOut: async () => undefined,
      enableMessaging: async () => dispatch("ner:toast", { message: "Add Firebase web config and VAPID key first." }),
      getIdToken: async () => null
    };
    dispatch("ner:firebase-status", { configured: false });
    return;
  }

  const [{ initializeApp }, authModule, messagingModule] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js"),
    import("https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging.js")
  ]);

  const app = initializeApp(firebaseConfig);
  const auth = authModule.getAuth(app);
  const provider = new authModule.GoogleAuthProvider();

  window.nerFirebase = {
    configured: true,
    signIn: () => authModule.signInWithPopup(auth, provider),
    signOut: () => authModule.signOut(auth),
    getIdToken: async () => (auth.currentUser ? auth.currentUser.getIdToken() : null),
    enableMessaging: async () => {
      if (!vapidKey) {
        dispatch("ner:toast", { message: "Add NER_FIREBASE_VAPID_KEY in config.js first." });
        return null;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        dispatch("ner:toast", { message: "Notification permission was not granted." });
        return null;
      }
      const registration = await navigator.serviceWorker.register("firebase-messaging-sw.js");
      const messaging = messagingModule.getMessaging(app);
      const token = await messagingModule.getToken(messaging, {
        vapidKey,
        serviceWorkerRegistration: registration
      });
      await registerToken(token);
      dispatch("ner:fcm-token", { token });
      return token;
    }
  };

  authModule.onAuthStateChanged(auth, (user) => {
    dispatch("ner:auth", {
      user: user
        ? {
            uid: user.uid,
            name: user.displayName,
            email: user.email,
            photoURL: user.photoURL
          }
        : null
    });
  });

  dispatch("ner:firebase-status", { configured: true });
}

bootFirebase().catch((error) => {
  window.nerFirebase = {
    configured: false,
    signIn: async () => dispatch("ner:toast", { message: error.message }),
    signOut: async () => undefined,
    enableMessaging: async () => dispatch("ner:toast", { message: error.message }),
    getIdToken: async () => null
  };
  dispatch("ner:firebase-status", { configured: false, error: error.message });
});
