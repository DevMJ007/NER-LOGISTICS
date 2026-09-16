# NER Logistics Intelligence

AI-assisted logistics intelligence and accessibility platform for India’s North Eastern Region.

This repo now contains:

- A fast browser frontend in `index.html`, `styles.css`, `app.js`
- Firebase Google login and FCM browser-alert wiring
- FastAPI backend with real integration points for Open-Meteo, Open-Meteo Flood, OSRM and Copernicus/Sentinel Hub
- Backend Firebase Admin hooks for token verification and push broadcasts
- PostGIS starter schema in `database/schema.sql`

## Run Locally

Open two PowerShell windows.

Frontend:

```powershell
.\run_frontend.ps1
```

Open:

```text
http://127.0.0.1:5500
```

Backend:

```powershell
Copy-Item backend\.env.example backend\.env
.\run_backend.ps1
```

API docs:

```text
http://127.0.0.1:8000/docs
```

## Add Firebase

Firebase web config goes in `config.js`. These are public browser values:

```js
window.NER_FIREBASE_CONFIG = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "...",
  measurementId: "..."
};

window.NER_FIREBASE_VAPID_KEY = "...";
```

Firebase Admin service-account values go in `backend/.env`:

```text
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
```

Keep the private key server-side only.

## Add Copernicus / Sentinel Hub

Put these in `backend/.env`:

```text
COPERNICUS_CLIENT_ID=
COPERNICUS_CLIENT_SECRET=
```

The backend uses OAuth client credentials, then searches Sentinel-1 GRD and Sentinel-2 L2A observations through the Sentinel Hub Catalog API.

## What Works

- Weather page calls FastAPI, which calls Open-Meteo
- Flood score calls FastAPI, which calls Open-Meteo Flood
- Route calculation calls FastAPI, which calls OSRM and ranks routes by risk
- Satellite card calls FastAPI, which calls Copernicus/Sentinel Hub if credentials exist
- Reports post to FastAPI and attach Firebase ID token when logged in
- FCM token registration works after Firebase config and VAPID key are added
- If backend or credentials are missing, the UI stays usable with demo fallback data

## Demo Flow

1. Start frontend and backend.
2. Add Firebase/Copernicus credentials if available.
3. Open Dashboard and check Admin for integration status.
4. Click `Run SIH Demo`.
5. Open Routes and click `Calculate Safest Route`.
6. Submit a Field Report.
7. Enable Emergency Mode.

## Important Limit

This is a working prototype, not a scientifically validated landslide/flood prediction model. It performs AI-assisted disruption and corridor risk assessment using weather, flood, satellite metadata, reports and route signals.
