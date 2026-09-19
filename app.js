const storage = {
  get(k, f) { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : f; } catch(e) { return f; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
  removeItem(k) { localStorage.removeItem(k); }
};

const appConfig = window.NER_APP_CONFIG || { apiBaseUrl: "http://127.0.0.1:8000", defaultLocation: { name: "Aizawl", lat: 23.7271, lon: 92.7176 } };

const districtCoordinates = {
  Aizawl: { lat: 23.7271, lon: 92.7176 }, "Imphal East": { lat: 24.817, lon: 93.9368 },
  "East Khasi Hills": { lat: 25.5788, lon: 91.8933 }, "Kamrup Metropolitan": { lat: 26.1445, lon: 91.7362 },
  Kohima: { lat: 25.6751, lon: 94.1086 }, "West Tripura": { lat: 23.8315, lon: 91.2868 },
  "Lower Subansiri": { lat: 27.533, lon: 93.833 }
};

const liveData = {
  backendOnline: false, backendChecked: false, user: null, userLocation: null,
  integrations: {}, satellite: null, flood: null, lastError: null,
  dbIncidents: [], dashboardStats: {}
};

const state = {
  view: location.hash.replace("#", "") || "dashboard",
  district: "Aizawl",
  emergency: storage.get("ner:emergency", false),
  offline: false,
  incidents: [],
  notifications: storage.get("ner:notifications", []),
  queuedReports: storage.get("ner:queuedReports", []),
  thresholds: storage.get("ner:thresholds", { moderate: 21, elevated: 41, high: 61, critical: 81, rainfall: 45, flood: 70 }),
  layers: storage.get("ner:layers", { incidents: true, flood: true, risk: true, weather: true }),
  weather: { location: "Aizawl", temperature: 24, humidity: 86, rainfall: 58, wind: 18, rainProbability: 82, floodIndex: 71, warning: "Heavy rainfall likely", hourly: [], affectedRoads: ["Silchar to Aizawl", "Guwahati to Shillong", "Imphal to Moreh"], source: "demo" },
  lastAIAnalysis: null,
  previousRiskScore: 0,
  autoRefreshTimer: null
};

let ws = null, wsReconnectTimer = null;
let leafletMap = null, incidentMarkers = {}, userMarker = null;
let searchControl = null;

const viewTitles = {
  dashboard: "Disaster Monitor",
  map: "Live Map",
  weather: "Weather & Flood",
  alerts: "Notifications",
  report: "Report Incident",
  emergency: "Emergency"
};

function qs(s, r = document) { return r.querySelector(s); }
function qsa(s, r = document) { return [...r.querySelectorAll(s)]; }
function districtLocation() { return districtCoordinates[state.district] || appConfig.defaultLocation; }

async function apiGet(path) {
  const r = await fetch(`${appConfig.apiBaseUrl}${path}`);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(`${appConfig.apiBaseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { const t = await r.text(); throw new Error(t || `${r.status} ${r.statusText}`); }
  return r.json();
}

async function apiPatch(path, body) {
  const r = await fetch(`${appConfig.apiBaseUrl}${path}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { const t = await r.text(); throw new Error(t || `${r.status} ${r.statusText}`); }
  return r.json();
}

function clamp(v, mn, mx) { return Math.min(mx, Math.max(mn, v)); }
function escapeHtml(v) { return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function classifyRisk(score) {
  if (score >= state.thresholds.critical) return "critical";
  if (score >= state.thresholds.high) return "high";
  if (score >= state.thresholds.elevated) return "elevated";
  if (score >= state.thresholds.moderate) return "moderate";
  return "low";
}

function riskLabel(score) { return { low: "Low", moderate: "Moderate", elevated: "Elevated", high: "High", critical: "Critical" }[classifyRisk(score)]; }
function riskBadge(score) { return `<span class="risk-badge risk-${classifyRisk(score)}">${riskLabel(score)}</span>`; }

function computeRisk() {
  const satelliteRisk = Number(liveData.satellite?.risk_score || 54);
  const active = state.incidents.filter(i => i.status !== "RESOLVED");
  const incidentRisk = clamp(active.length * 12, 0, 40);
  return clamp(Math.round(
    state.weather.rainfall * 0.25 +
    state.weather.floodIndex * 0.25 +
    satelliteRisk * 0.2 +
    incidentRisk * 0.15 +
    (state.emergency ? 8 : 0)
  ), 0, 100);
}

function riskFactors() {
  const satelliteRisk = Number(liveData.satellite?.risk_score || 54);
  const active = state.incidents.filter(i => i.status !== "RESOLVED");
  return [
    { label: "Rainfall", value: clamp(state.weather.rainfall, 0, 100), note: `${state.weather.rainfall}mm - Open-Meteo` },
    { label: "Flood Risk", value: clamp(state.weather.floodIndex, 0, 100), note: "Hydrological model" },
    { label: "Satellite Analysis", value: satelliteRisk, note: liveData.satellite?.configured ? "Sentinel live" : "Sentinel estimate" },
    { label: "Active Incidents", value: clamp(active.length * 16, 0, 100), note: `${active.length} reported` },
    { label: "Wind Speed", value: clamp(state.weather.wind * 1.5, 0, 100), note: `${state.weather.wind} km/h` },
    { label: "Humidity", value: clamp(state.weather.humidity, 0, 100), note: `${state.weather.humidity}%` }
  ];
}

function addNotification(title, message, severity, source) {
  const n = { id: Date.now(), title, message, severity, source, time: new Date().toISOString(), read: false };
  state.notifications.unshift(n);
  if (state.notifications.length > 50) state.notifications = state.notifications.slice(0, 50);
  storage.set("ner:notifications", state.notifications);
  return n;
}

function saveState() {
  storage.set("ner:view", state.view);
  storage.set("ner:emergency", state.emergency);
  storage.set("ner:queuedReports", state.queuedReports);
  storage.set("ner:thresholds", state.thresholds);
  storage.set("ner:layers", state.layers);
  storage.set("ner:notifications", state.notifications);
}

function toast(msg) {
  const host = qs("#toastHost"); const n = document.createElement("div");
  n.className = "toast"; n.textContent = msg; host.appendChild(n);
  setTimeout(() => n.remove(), 4000);
}

function setView(view) {
  state.view = view; saveState();
  if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
  render();
  if (view === "map") setTimeout(initLeafletMap, 100);
}

// ========== LOCATION ==========
function requestLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
        liveData.userLocation = loc;
        storage.set("ner:userLocation", loc);
        resolve(loc);
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
    );
  });
}

function watchUserLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    (pos) => {
      liveData.userLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
      if (leafletMap) updateUserLocationMarker();
    },
    () => {},
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

// ========== AI RISK ANALYSIS ENGINE ==========
function runAIAnalysis() {
  const score = computeRisk();
  const classification = classifyRisk(score);
  const prev = state.previousRiskScore;
  const rising = score > prev + 5;
  const falling = score < prev - 5;

  const factors = riskFactors();
  const topFactors = [...factors].sort((a, b) => b.value - a.value).slice(0, 3);

  let recommendation = "";
  if (classification === "critical") {
    recommendation = "EVACUATE immediately. Severe flood/landslide risk. Avoid all travel in affected areas.";
  } else if (classification === "high") {
    recommendation = "Avoid non-essential travel. Monitor weather closely. Prepare emergency kit.";
  } else if (classification === "elevated") {
    recommendation = "Travel with caution. Check road conditions before departing. Stay informed.";
  } else if (classification === "moderate") {
    recommendation = "Normal activity with awareness. Keep emergency contacts handy.";
  } else {
    recommendation = "Conditions favorable. Standard precautions apply.";
  }

  const analysis = {
    score, classification, rising, falling, timestamp: new Date().toISOString(),
    topFactors: topFactors.map(f => `${f.label}: ${f.value}/100`),
    recommendation,
    weatherSummary: `${state.weather.temperature}C, ${state.weather.rainfall}mm rain, ${state.weather.wind}km/h wind`,
    floodSummary: `Flood index: ${state.weather.floodIndex}/100`,
    satelliteSummary: liveData.satellite?.summary || "Sentinel data pending"
  };

  state.lastAIAnalysis = analysis;
  state.previousRiskScore = score;

  if (rising && score >= state.thresholds.elevated) {
    addNotification(`Risk Rising: ${riskLabel(score)}`, `AI detected increasing risk (${prev} -> ${score}). ${recommendation}`, classification === "critical" ? "critical" : "high", "AI Engine");
    toast(`ALERT: Risk rising to ${riskLabel(score)}!`);
  }

  if (classification === "critical" && prev < state.thresholds.critical) {
    addNotification("CRITICAL: Immediate Danger", `Disaster risk score reached CRITICAL (${score}/100). ${recommendation}`, "critical", "AI Engine");
    toast("CRITICAL ALERT: Immediate danger!");
  }

  if (falling && prev >= state.thresholds.high && score < state.thresholds.high) {
    addNotification("Risk Decreasing", `Risk dropped from ${riskLabel(prev)} to ${riskLabel(score)}.`, "moderate", "AI Engine");
  }

  const w = state.weather;
  if (w.rainfall > 60 && w.floodIndex > 60) {
    const key = "heavy_rain_flood";
    if (!state.notifications.some(n => n._key === key && Date.now() - new Date(n.time).getTime() < 3600000)) {
      const n = addNotification("Heavy Rain + High Flood Risk", `Rainfall ${w.rainfall}mm + flood index ${w.floodIndex}. Flash flood possible.`, "high", "Weather AI");
      n._key = key;
    }
  }

  if (w.wind > 50) {
    const key = "high_wind";
    if (!state.notifications.some(n => n._key === key && Date.now() - new Date(n.time).getTime() < 3600000)) {
      const n = addNotification("High Wind Warning", `Wind ${w.wind} km/h. Structural damage risk.`, "high", "Weather AI");
      n._key = key;
    }
  }

  if (liveData.flood?.risk_level === "high" || liveData.flood?.risk_level === "critical") {
    const key = "flood_alert";
    if (!state.notifications.some(n => n._key === key && Date.now() - new Date(n.time).getTime() < 3600000)) {
      const n = addNotification("Flood Alert: River Levels Rising", `River discharge elevated. Risk: ${liveData.flood.risk_level}.`, liveData.flood.risk_level, "Flood AI");
      n._key = key;
    }
  }

  return analysis;
}

// ========== LOGIN ==========
function initLogin() {
  const loginScreen = qs("#loginScreen");
  const appShell = qs("#appShell");
  const landingPage = qs("#landingPage");
  const savedUser = storage.get("ner:user", null);

  if (savedUser) {
    liveData.user = savedUser;
    liveData.userLocation = storage.get("ner:userLocation", null);
    loginScreen.classList.remove("visible");
    loginScreen.classList.add("hidden");
    if (landingPage) { landingPage.classList.add("hidden"); }
    appShell.classList.remove("hidden");
    appShell.classList.add("visible");
    return true;
  }

  loginScreen.classList.remove("visible");
  loginScreen.classList.add("hidden");
  appShell.classList.add("hidden");
  if (landingPage) { landingPage.classList.remove("hidden"); }
  return false;
}

function showApp() {
  const landingPage = qs("#landingPage");
  qs("#loginScreen").classList.remove("visible");
  qs("#loginScreen").classList.add("hidden");
  if (landingPage) { landingPage.classList.add("hidden"); }
  qs("#appShell").classList.remove("hidden");
  qs("#appShell").classList.add("visible");
}

function showLogin() {
  const landingPage = qs("#landingPage");
  if (landingPage) { landingPage.classList.add("hidden"); }
  qs("#loginScreen").classList.add("visible");
  qs("#loginScreen").classList.remove("hidden");
  qs("#appShell").classList.add("hidden");
  qs("#appShell").classList.remove("visible");
}

function initLoginForm() {
  qs("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = qs("#loginEmail").value.trim().toLowerCase();
    const password = qs("#loginPassword").value;
    const errEl = qs("#loginError");

    if (!email || !password) { errEl.textContent = "Enter email and password."; return; }

    const name = email.split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    liveData.user = { email, name, role: "citizen", district: "Aizawl" };
    storage.set("ner:user", liveData.user);
    errEl.textContent = "";

    toast("Requesting location access...");
    const loc = await requestLocation();
    if (loc) {
      toast(`Location acquired: ${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`);
    } else {
      toast("Location not available. Using default area.");
    }

    showApp();
    render();
    refreshLiveData({ quiet: false });
    connectWebSocket();
    watchUserLocation();
    startAutoRefresh();
    toast(`Welcome, ${name}!`);
  });

  qs("#logoutButton").addEventListener("click", () => {
    liveData.user = null;
    storage.removeItem("ner:user");
    if (ws) ws.close();
    if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
    const landingPage = qs("#landingPage");
    const loginScreen = qs("#loginScreen");
    const appShell = qs("#appShell");
    loginScreen.classList.remove("visible");
    loginScreen.classList.add("hidden");
    appShell.classList.remove("visible");
    appShell.classList.add("hidden");
    if (landingPage) { landingPage.classList.remove("hidden"); }
    toast("Logged out.");
  });

  qs("#googleLoginBtn").addEventListener("click", async () => {
    if (window.nerFirebase?.signIn) {
      try { await window.nerFirebase.signIn(); }
      catch (err) {
        const msg = err.message || String(err);
        if (msg.includes("unauthorized-domain")) {
          qs("#loginError").textContent = "Firebase: add 127.0.0.1 to authorized domains in Firebase Console.";
        } else { qs("#loginError").textContent = msg; }
      }
    } else { qs("#loginError").textContent = "Firebase loading... try again in a moment."; }
  });
}

// ========== LEAFLET MAP ==========
function initLeafletMap() {
  const container = qs("#leafletMap");
  if (!container) return;
  if (leafletMap) { try { leafletMap.remove(); } catch(e) {} leafletMap = null; }

  const userLoc = liveData.userLocation;
  const center = userLoc ? [userLoc.lat, userLoc.lon] : [districtLocation().lat, districtLocation().lon];
  const zoom = userLoc ? 12 : 8;

  leafletMap = L.map("leafletMap", { zoomControl: true }).setView(center, zoom);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; OpenStreetMap contributors', maxZoom: 18
  }).addTo(leafletMap);

  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: '&copy; Esri', maxZoom: 18, opacity: 0.3
  }).addTo(leafletMap);

  if (userLoc) updateUserLocationMarker();

  const searchBox = qs("#mapSearchInput");
  if (searchBox) {
    searchBox.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const query = searchBox.value.trim();
        if (!query) return;
        toast("Searching...");
        try {
          const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`);
          const results = await r.json();
          if (results.length > 0) {
            const lat = parseFloat(results[0].lat);
            const lon = parseFloat(results[0].lon);
            leafletMap.setView([lat, lon], 13);
            L.marker([lat, lon]).addTo(leafletMap).bindPopup(`<strong>${results[0].display_name}</strong>`).openPopup();
            toast(`Found: ${results[0].display_name.split(",")[0]}`);
          } else {
            toast("Place not found.");
          }
        } catch (err) { toast("Search failed."); }
      }
    });
  }

  updateMapMarkers();
  setTimeout(() => leafletMap.invalidateSize(), 200);
}

function updateUserLocationMarker() {
  if (!leafletMap || !liveData.userLocation) return;
  const { lat, lon } = liveData.userLocation;

  if (userMarker) leafletMap.removeLayer(userMarker);

  const icon = L.divIcon({
    className: "",
    html: `<div style="width:20px;height:20px;border-radius:50%;background:#3b82f6;border:3px solid #fff;box-shadow:0 0 12px rgba(59,130,246,0.6);animation:pulse 2s infinite"></div>`,
    iconSize: [20, 20], iconAnchor: [10, 10]
  });

  userMarker = L.marker([lat, lon], { icon }).addTo(leafletMap);
  userMarker.bindPopup("<strong>You are here</strong>");
}

function updateMapMarkers() {
  if (!leafletMap) return;

  Object.values(incidentMarkers).forEach(m => leafletMap.removeLayer(m));
  incidentMarkers = {};

  if (state.layers.incidents) {
    state.incidents.filter(i => i.status !== "RESOLVED").forEach(inc => {
      const lat = inc.lat || inc.location?.lat || 23.727;
      const lon = inc.lon || inc.location?.lon || 92.717;
      const sevColor = { Critical: "#b54535", High: "#c97855", Medium: "#d89b45", Moderate: "#d89b45", Low: "#7b7a4f" }[inc.severity] || "#c97855";
      const icon = L.divIcon({
        className: "",
        html: `<div style="width:30px;height:30px;border-radius:50%;background:${sevColor};border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:grid;place-items:center;color:#fff;font-size:13px;font-weight:900">!</div>`,
        iconSize: [30, 30], iconAnchor: [15, 15]
      });
      const marker = L.marker([lat, lon], { icon }).addTo(leafletMap);
      marker.bindPopup(`<div style="min-width:180px"><strong>${inc.type}</strong> ${riskBadge(inc.risk_score || 0)}<br><small>${inc.severity} | ${inc.status}</small><br><small>${inc.description || ""}</small></div>`);
      incidentMarkers[inc.id || inc.type] = marker;
    });
  }

  if (state.layers.flood) {
    const floodAreas = [
      { lat: 24.0, lon: 92.5, r: 40000 }, { lat: 25.5, lon: 91.8, r: 30000 }, { lat: 23.7, lon: 92.7, r: 25000 }
    ];
    floodAreas.forEach(a => {
      L.circle([a.lat, a.lon], { radius: a.r, color: "#3b82f6", fillColor: "#3b82f6", fillOpacity: 0.08, weight: 1, dashArray: "5 5" }).addTo(leafletMap);
    });
  }

  if (state.layers.risk) {
    const riskAreas = [
      { lat: 24.5, lon: 93.0, r: 35000, color: "#ef4444" }, { lat: 23.9, lon: 92.0, r: 28000, color: "#f59e0b" }
    ];
    riskAreas.forEach(a => {
      L.circle([a.lat, a.lon], { radius: a.r, color: a.color, fillColor: a.color, fillOpacity: 0.06, weight: 1, dashArray: "5 5" }).addTo(leafletMap);
    });
  }
}

// ========== WEBSOCKET ==========
function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const wsUrl = appConfig.apiBaseUrl.replace("http", "ws") + "/ws";
  try {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => { console.log("WS connected"); updateSystemHealth(); };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "incident_created" || msg.type === "incident_updated") {
          const d = msg.data;
          const idx = state.incidents.findIndex(i => i.id === d.id);
          if (idx >= 0) state.incidents[idx] = { ...state.incidents[idx], ...d };
          else state.incidents.unshift(d);
          addNotification(`Incident: ${d.type || d.id}`, d.description || "New incident", d.severity || "medium", "Citizen Report");
          toast(`New incident: ${d.type || d.id}`);
          if (leafletMap) updateMapMarkers();
          render();
        } else if (msg.type === "alert") {
          addNotification(`Alert: ${msg.data.title}`, msg.data.message, msg.data.severity || "high", "System");
          toast(`ALERT: ${msg.data.title}`);
          render();
        }
      } catch(e) {}
    };
    ws.onclose = () => { wsReconnectTimer = setTimeout(connectWebSocket, 5000); updateSystemHealth(); };
    ws.onerror = () => {};
  } catch(e) {}
}

// ========== AUTO REFRESH ==========
function startAutoRefresh() {
  if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = setInterval(() => {
    if (!state.offline && liveData.user) {
      refreshLiveData({ quiet: true });
    }
  }, 300000);
}

// ========== KPI / DASHBOARD ==========
function kpis() {
  const score = computeRisk();
  const active = state.incidents.filter(i => i.status !== "RESOLVED");
  const unread = state.notifications.filter(n => !n.read).length;
  return [
    { label: "Risk Score", value: score, detail: riskLabel(score), highlight: classifyRisk(score) },
    { label: "Temperature", value: `${state.weather.temperature}C`, detail: state.weather.source === "open-meteo" ? "LIVE" : "Demo" },
    { label: "Rainfall", value: `${state.weather.rainfall}mm`, detail: `${state.weather.rainProbability}% chance` },
    { label: "Flood Index", value: state.weather.floodIndex, detail: "River discharge" },
    { label: "Active Incidents", value: active.length, detail: "Reports" },
    { label: "Alerts", value: unread, detail: `${state.notifications.length} total` }
  ];
}

function renderKpis() {
  qs("#kpiGrid").innerHTML = kpis().map(m => `
    <article class="metric-card interactive-card ${m.highlight ? 'risk-' + m.highlight : ''}">
      <span>${m.label}</span><strong>${m.value}</strong><small>${m.detail}</small>
    </article>`).join("");
}

function renderRiskPanel() {
  const score = computeRisk();
  const analysis = state.lastAIAnalysis;
  return `
    <section class="panel">
      <header class="panel-header"><div><p class="eyebrow">AI Risk Engine</p><h2>Disaster Risk</h2></div>${riskBadge(score)}</header>
      <div class="panel-body">
        <div class="risk-dial" style="--risk-angle:${score * 3.6}deg">
          <div class="dial-ring"><div class="dial-core"><span>Score</span><strong>${score}</strong></div></div>
          <p class="muted">${analysis?.recommendation || "Analyzing..."}</p>
        </div>
        <ul class="risk-list" style="margin-top:14px">
          ${riskFactors().map(f => `
            <li class="risk-row">
              <header><strong>${f.label}</strong><small>${f.value}/100</small></header>
              <div class="bar-track"><div class="bar-fill" style="width:${f.value}%"></div></div>
              <small class="muted">${f.note}</small>
            </li>`).join("")}
        </ul>
      </div>
    </section>`;
}

function renderAlertsPanel() {
  const recent = state.notifications.slice(0, 5);
  return `
    <section class="panel">
      <header class="panel-header"><div><p class="eyebrow">Notifications</p><h2>Recent Alerts</h2></div>
        <button class="ghost-button" type="button" data-action="view-alerts" style="min-height:28px;padding:2px 8px;font-size:0.75rem">View All</button></header>
      <div class="panel-body"><ul class="alert-list">
        ${recent.length ? recent.map(a => `
          <li class="alert-item ${a.severity === 'critical' ? 'critical' : ''}">
            <strong>${a.title}</strong>
            <small>${a.message}</small>
            <small style="color:#999">${new Date(a.time).toLocaleString()}</small>
          </li>`).join("") : '<li class="alert-item"><strong>No alerts yet</strong><small>AI is monitoring conditions.</small></li>'}
      </ul></div>
    </section>`;
}

// ========== VIEWS ==========
function renderDashboard() {
  return `
    <div class="dashboard-grid">
      <div style="position:relative">
        <div id="leafletMap" style="min-height:500px;border-radius:var(--radius);border:1px solid var(--border)"></div>
      </div>
      <aside class="side-stack">${renderRiskPanel()}${renderAlertsPanel()}</aside>
    </div>
    <section class="grid-3" style="margin-top:16px">
      <article class="panel">
        <header class="panel-header"><div><p class="eyebrow">Weather</p><h2>${state.weather.location}</h2></div></header>
        <div class="panel-body">
          <p style="font-size:2rem;font-weight:800;margin:0">${state.weather.temperature}C</p>
          <p class="muted">${state.weather.warning}</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
            <small>Rain: ${state.weather.rainfall}mm</small>
            <small>Wind: ${state.weather.wind}km/h</small>
            <small>Humidity: ${state.weather.humidity}%</small>
            <small>Flood: ${state.weather.floodIndex}/100</small>
          </div>
        </div>
      </article>
      <article class="panel">
        <header class="panel-header"><div><p class="eyebrow">Satellite</p><h2>Intelligence</h2></div></header>
        <div class="panel-body">
          <p class="muted">${liveData.satellite?.summary || "Sentinel imagery analysis pending."}</p>
          <div class="notice" style="margin-top:8px"><strong>Anomaly: ${Number(liveData.satellite?.risk_score || 54)}/100</strong>
            <p class="muted" style="margin:4px 0 0">${liveData.satellite?.configured ? "Copernicus connected." : "Using estimated data."}</p></div>
        </div>
      </article>
      <article class="panel">
        <header class="panel-header"><div><p class="eyebrow">AI Analysis</p><h2>Status</h2></div></header>
        <div class="panel-body">
          <p class="muted">${state.lastAIAnalysis?.recommendation || "Waiting for data..."}</p>
          ${state.lastAIAnalysis?.rising ? '<p style="color:var(--danger);font-weight:700;margin-top:8px">TREND: Risk increasing</p>' : ''}
          ${state.lastAIAnalysis?.falling ? '<p style="color:var(--olive);font-weight:700;margin-top:8px">TREND: Risk decreasing</p>' : ''}
          <p class="muted" style="margin-top:8px;font-size:0.75rem">Top factors: ${state.lastAIAnalysis?.topFactors?.join(", ") || "Analyzing..."}</p>
        </div>
      </article>
    </section>`;
}

function renderMapView() {
  return `
    <section class="section-header">
      <div><p class="eyebrow">Real-time GIS</p><h2>Disaster Map</h2>
        <p>Your location shown as blue dot. Search any place below.</p></div>
      <div class="action-row">
        <button class="ghost-button" type="button" data-action="center-me">My Location</button>
        <button class="ghost-button" type="button" data-action="center-map">Center NER</button>
        <button class="ghost-button" type="button" data-action="refresh-map">Refresh</button>
      </div>
    </section>
    <div style="margin-top:12px;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">
      <div style="padding:8px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <input id="mapSearchInput" type="text" placeholder="Search any place..." style="flex:1;min-width:200px;border:1px solid var(--border);border-radius:var(--radius);padding:8px 12px;font-size:0.9rem" />
        <div class="layer-list">
          ${Object.keys(state.layers).map(k => `<button class="chip ${state.layers[k] ? "active" : ""}" type="button" data-layer="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join("")}
        </div>
      </div>
      <div id="leafletMap" style="height:600px"></div>
    </div>`;
}

function renderWeather() {
  const w = state.weather;
  return `
    <section class="panel">
      <header class="panel-header">
        <div><p class="eyebrow">${w.source === "open-meteo" ? "LIVE from Open-Meteo" : "Weather data"}</p>
          <h2>${w.location} Weather</h2><p>${w.warning}</p></div>
        ${riskBadge(Math.max(w.rainfall, w.floodIndex))}
      </header>
      <div class="panel-body"><div class="weather-strip">
        <article class="weather-card"><span class="muted">Temperature</span><strong>${w.temperature}C</strong></article>
        <article class="weather-card"><span class="muted">Humidity</span><strong>${w.humidity}%</strong></article>
        <article class="weather-card"><span class="muted">Rainfall</span><strong>${w.rainfall}mm</strong></article>
        <article class="weather-card"><span class="muted">Wind</span><strong>${w.wind}km/h</strong></article>
        <article class="weather-card"><span class="muted">Rain %</span><strong>${w.rainProbability}%</strong></article>
        <article class="weather-card"><span class="muted">Flood</span><strong>${w.floodIndex}</strong></article>
      </div></div>
    </section>
    <section class="grid-2" style="margin-top:16px">
      <article class="panel">
        <header class="panel-header"><div><p class="eyebrow">Hourly</p><h2>Rainfall Forecast</h2></div></header>
        <div class="panel-body"><div class="forecast-bars">
          ${w.hourly.length ? w.hourly.map(h => `<div class="forecast-bar"><span style="height:${Math.max(20, h.rain * 2)}px"></span><strong>${h.rain}</strong><small>${h.hour}:00</small></div>`).join("") : '<p class="muted">No hourly data.</p>'}
        </div></div>
      </article>
      <article class="panel">
        <header class="panel-header"><div><p class="eyebrow">Roads</p><h2>Weather Impact</h2></div></header>
        <div class="panel-body"><ul class="road-list">
          ${w.affectedRoads.map((r, i) => `<li class="road-item"><header><strong>${r}</strong>${riskBadge(58 + i * 8)}</header></li>`).join("")}
        </ul></div>
      </article>
    </section>`;
}

function renderAlerts() {
  return `
    <section class="section-header">
      <div><p class="eyebrow">Notifications</p><h2>All Alerts</h2>
        <p>AI-generated notifications from real-time data analysis.</p></div>
      <div class="action-row">
        <button class="ghost-button" type="button" data-action="mark-all-read">Mark All Read</button>
        <button class="ghost-button" type="button" data-action="clear-alerts">Clear All</button>
      </div>
    </section>
    <div style="margin-top:16px">
      ${state.notifications.length ? state.notifications.map(n => `
        <article class="alert-item ${n.severity === 'critical' ? 'critical' : ''}" style="margin-bottom:8px;padding:14px;border-left:4px solid ${n.severity === 'critical' ? 'var(--danger)' : n.severity === 'high' ? 'var(--amber)' : 'var(--olive)'}">
          <div style="display:flex;justify-content:space-between;align-items:start;gap:12px">
            <div>
              <strong>${n.title}</strong>
              <p style="margin:4px 0 0;color:var(--muted);font-size:0.85rem">${n.message}</p>
              <small style="color:#999">${new Date(n.time).toLocaleString()} - ${n.source}</small>
            </div>
            ${riskBadge(n.severity === 'critical' ? 90 : n.severity === 'high' ? 70 : n.severity === 'moderate' ? 40 : 20)}
          </div>
        </article>`).join("") : '<div class="panel" style="padding:40px;text-align:center"><p class="muted">No notifications. AI is monitoring.</p></div>'}
    </div>`;
}

function renderReport() {
  return `
    <section class="grid-2">
      <form class="form-card" id="reportForm">
        <p class="eyebrow">Citizen Report</p><h2>Report an Incident</h2>
        <p class="muted" style="margin-bottom:14px">Report floods, landslides, road damage. Your report feeds the AI risk engine.</p>
        <div class="form-grid">
          <label>Type <select class="form-control" name="type" required>
            <option>Flood</option><option>Landslide</option><option>Road Damage</option><option>Bridge Damage</option>
            <option>Heavy Rainfall</option><option>Road Blockage</option><option>Accident</option><option>Other</option></select></label>
          <label>Severity <select class="form-control" name="severity" required>
            <option>Medium</option><option>Low</option><option>High</option><option>Critical</option></select></label>
          <label class="full-span">Location <input class="form-control" name="location" value="${liveData.userLocation ? liveData.userLocation.lat.toFixed(5) + ', ' + liveData.userLocation.lon.toFixed(5) : '23.727, 92.717'}" required /></label>
          <label class="full-span">Description <textarea name="description" placeholder="Describe what you see..." required></textarea></label>
        </div>
        <div class="action-row" style="margin-top:14px">
          <button class="button" type="submit">Submit Report</button>
          <button class="ghost-button" type="button" data-action="use-location">Use My GPS</button>
          <button class="ghost-button" type="button" data-action="offline">${state.offline ? "Go Online" : "Offline Mode"}</button>
        </div>
      </form>
      <aside class="side-stack">
        <section class="panel">
          <header class="panel-header"><div><p class="eyebrow">Queue</p><h2>${state.queuedReports.length} pending</h2></div>
            <button class="ghost-button" type="button" data-action="sync">Sync</button></header>
          <div class="panel-body">${state.queuedReports.length
            ? `<ul class="timeline">${state.queuedReports.map(i => `<li class="timeline-item"><strong>${i.type}</strong><small>${i.severity} - ${i.createdAt}</small></li>`).join("")}</ul>`
            : `<p class="muted">No pending reports.</p>`}</div>
        </section>
        <section class="panel">
          <header class="panel-header"><div><p class="eyebrow">Recent</p><h2>Incidents</h2></div></header>
          <div class="panel-body"><ul class="timeline">
            ${state.incidents.slice(0, 8).map(i => `
              <li class="timeline-item"><strong>${i.type}</strong>
                <small>${i.severity} | ${i.status} | ${i.created_at ? new Date(i.created_at).toLocaleDateString() : ""}</small>
              </li>`).join("") || '<li class="timeline-item"><small>No incidents yet.</small></li>'}
          </ul></div>
        </section>
      </aside>
    </section>`;
}

function renderEmergency() {
  const score = computeRisk();
  return `
    <section class="emergency-hero ${state.emergency ? "active" : ""}">
      <p class="eyebrow">Emergency Mode</p>
      <h2>${state.emergency ? "EMERGENCY ACTIVE" : "Emergency Ready"}</h2>
      <p class="muted">${state.emergency ? "Emergency protocols active." : "Activate for emergency protocols."}</p>
      <div class="action-row">
        <button class="${state.emergency ? "danger-button" : "button"}" type="button" data-action="emergency">
          ${state.emergency ? "Deactivate" : "Activate Emergency"}</button>
        <button class="ghost-button" type="button" data-action="send-alert">Broadcast Alert</button>
      </div>
    </section>
    <section class="grid-3" style="margin-top:16px">
      <article class="panel"><header class="panel-header"><div><p class="eyebrow">Risk</p><h2>Current Level</h2></div></header>
        <div class="panel-body" style="text-align:center">
          <p style="font-size:3rem;font-weight:800;margin:0">${score}</p>
          ${riskBadge(score)}
          <p class="muted" style="margin-top:8px">${state.lastAIAnalysis?.recommendation || ""}</p>
        </div>
      </article>
      <article class="panel"><header class="panel-header"><div><p class="eyebrow">Incidents</p><h2>Active</h2></div></header>
        <div class="panel-body"><ul class="road-list">
          ${state.incidents.filter(i => i.status !== "RESOLVED").slice(0, 5).map(i => `
            <li class="road-item"><header><strong>${i.type}</strong>${riskBadge(i.risk_score || 0)}</header><small>${i.severity} - ${i.status}</small></li>`).join("") || '<li class="road-item"><small>No active incidents.</small></li>'}
        </ul></div>
      </article>
      <article class="panel"><header class="panel-header"><div><p class="eyebrow">Weather</p><h2>Conditions</h2></div></header>
        <div class="panel-body">
          <p style="font-size:1.5rem;font-weight:800;margin:0">${state.weather.temperature}C</p>
          <p class="muted">${state.weather.rainfall}mm rain, ${state.weather.wind}km/h wind</p>
          <p class="muted" style="margin-top:4px">${state.weather.warning}</p>
        </div>
      </article>
    </section>`;
}

function renderView() {
  const root = qs("#viewRoot");
  const views = { dashboard: renderDashboard, map: renderMapView, weather: renderWeather, alerts: renderAlerts, report: renderReport, emergency: renderEmergency };
  root.innerHTML = (views[state.view] || views.dashboard)();
  attachViewHandlers(root);
  if (state.view === "dashboard" || state.view === "map") setTimeout(() => { initLeafletMap(); updateMapMarkers(); }, 100);
}

// ========== HANDLERS ==========
function attachViewHandlers(root) {
  qsa("[data-layer]", root).forEach(b => b.addEventListener("click", () => { state.layers[b.dataset.layer] = !state.layers[b.dataset.layer]; saveState(); if (leafletMap) updateMapMarkers(); render(); }));

  qsa("[data-action]", root).forEach(b => b.addEventListener("click", () => {
    const a = b.dataset.action;
    if (a === "emergency") toggleEmergency();
    if (a === "send-alert") sendAlertToBackend();
    if (a === "offline") { state.offline = !state.offline; toast(state.offline ? "Offline mode" : "Online"); render(); }
    if (a === "sync") syncReports();
    if (a === "use-location") fillLocation();
    if (a === "view-alerts") setView("alerts");
    if (a === "mark-all-read") { state.notifications.forEach(n => n.read = true); storage.set("ner:notifications", state.notifications); toast("All read."); render(); }
    if (a === "clear-alerts") { state.notifications = []; storage.set("ner:notifications", []); toast("Cleared."); render(); }
    if (a === "center-me") {
      if (liveData.userLocation && leafletMap) {
        leafletMap.setView([liveData.userLocation.lat, liveData.userLocation.lon], 13);
      } else { toast("Location not available."); }
    }
    if (a === "center-map" && leafletMap) { const loc = districtLocation(); leafletMap.setView([loc.lat, loc.lon], 8); }
    if (a === "refresh-map" && leafletMap) { updateMapMarkers(); toast("Map refreshed."); }
  }));

  const form = qs("#reportForm", root);
  if (form) form.addEventListener("submit", handleReportSubmit);
}

async function handleReportSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const data = new FormData(form);
  const [lat, lon] = (data.get("location") || "23.727, 92.717").split(",").map(Number);
  const item = { type: data.get("type"), severity: data.get("severity"), description: data.get("description"), location: { lat, lon }, district: state.district };

  if (state.offline) {
    state.queuedReports.unshift({ ...item, location: `${lat}, ${lon}`, createdAt: new Date().toLocaleTimeString() });
    toast("Saved locally.");
  } else {
    try {
      const resp = await apiPost("/api/reports", item);
      state.incidents.unshift({ ...item, id: resp.id, status: "REPORTED", risk_score: resp.risk?.score || 0, lat, lon, created_at: resp.created_at });
      addNotification(`Report: ${item.type}`, `${item.severity}. Risk: ${resp.risk?.classification || "analyzing"}`, item.severity?.toLowerCase(), "Citizen Report");
      toast(`Report submitted. Risk: ${resp.risk?.classification}`);
    } catch (err) {
      state.queuedReports.unshift({ ...item, location: `${lat}, ${lon}`, createdAt: new Date().toLocaleTimeString() });
      toast(`Saved locally: ${err.message}`);
    }
  }
  form.reset(); saveState(); render();
}

async function syncReports() {
  if (!state.queuedReports.length) { toast("Nothing to sync."); return; }
  let synced = 0;
  for (const item of state.queuedReports) {
    try { const [lat, lon] = (item.location || "23.727, 92.717").split(",").map(Number); await apiPost("/api/reports", { ...item, location: { lat, lon } }); synced++; } catch(e) {}
  }
  state.queuedReports = []; state.offline = false; saveState(); toast(`${synced} synced.`); render();
}

function fillLocation() {
  const input = qs('input[name="location"]');
  if (liveData.userLocation) {
    input.value = `${liveData.userLocation.lat.toFixed(5)}, ${liveData.userLocation.lon.toFixed(5)}`;
    toast("GPS location set.");
  } else if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(p => { input.value = `${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)}`; toast("GPS location set."); }, () => { input.value = "23.727, 92.717"; }, { timeout: 5000 });
  } else { input.value = "23.727, 92.717"; }
}

function toggleEmergency() { state.emergency = !state.emergency; saveState(); toast(state.emergency ? "Emergency ON" : "Emergency OFF"); render(); }

async function sendAlertToBackend() {
  const score = computeRisk();
  try {
    const resp = await apiPost("/api/alerts/broadcast", { title: "NER Alert", message: `Risk: ${riskLabel(score)} (${score}/100). ${state.lastAIAnalysis?.recommendation || ""}`, severity: riskLabel(score).toUpperCase() });
    addNotification("Alert Broadcast", `Risk ${riskLabel(score)} broadcast.`, classifyRisk(score), "System");
    toast(resp.sent ? `Sent to ${resp.sent}` : "Alert broadcast.");
  } catch (err) { toast(err.message); }
}

async function refreshLiveData({ quiet = false } = {}) {
  liveData.backendChecked = true;
  try {
    const loc = liveData.userLocation || districtLocation();
    const [health, w, f, sat, inc] = await Promise.all([
      apiGet("/api/health"), apiGet(`/api/weather?lat=${loc.lat}&lon=${loc.lon}`), apiGet(`/api/flood?lat=${loc.lat}&lon=${loc.lon}`),
      apiGet(`/api/satellite/latest?lat=${loc.lat}&lon=${loc.lon}&days=30`), apiGet("/api/incidents")
    ]);
    liveData.backendOnline = true; liveData.integrations = health.integrations || {};
    liveData.satellite = sat;
    state.incidents = (inc.items || []).map(i => ({ ...i }));

    if (w.source === "open-meteo") {
      state.weather.source = "open-meteo";
      state.weather.temperature = Math.round(Number(w.temperature ?? state.weather.temperature));
      state.weather.humidity = Math.round(Number(w.humidity ?? state.weather.humidity));
      state.weather.rainfall = Math.round(Number(w.rainfall ?? state.weather.rainfall));
      state.weather.wind = Math.round(Number(w.wind_speed ?? state.weather.wind));
      state.weather.rainProbability = Math.round(Number(w.precipitation_probability ?? state.weather.rainProbability));
      state.weather.warning = w.warning || state.weather.warning;
      if (w.hourly?.length) state.weather.hourly = w.hourly.map(h => ({ hour: String(h.hour).padStart(2, "0"), rain: Math.round(Number(h.rain || 0)) }));
    }
    if (f.source === "open-meteo-flood") { liveData.flood = f; state.weather.floodIndex = Math.round(Number(f.risk_score || state.weather.floodIndex)); }

    runAIAnalysis();
    if (!quiet) toast("Live data loaded.");
  } catch (err) { liveData.backendOnline = false; liveData.lastError = err.message; if (!quiet) toast("Backend offline: " + err.message); }
  updateSystemHealth(); render();
}

function updateSystemHealth() {
  const t = qs("#systemHealthTitle"), x = qs("#systemHealthText");
  if (!t || !x) return;
  if (!liveData.backendChecked) { t.textContent = "Checking"; x.textContent = "..."; return; }
  if (!liveData.backendOnline) { t.textContent = "Offline"; x.textContent = "Using cached data."; return; }
  const e = Object.entries(liveData.integrations).filter(([, v]) => v).map(([k]) => k.replaceAll("_", " "));
  t.textContent = "Online"; x.textContent = e.length ? `Live: ${e.join(", ")}` : "Connected.";
}

function updateAuthPanel() {
  const u = liveData.user;
  qs("#authUser").textContent = u?.name || u?.email || "Citizen";
  qs("#loginButton").classList.toggle("is-hidden", Boolean(u));
  qs("#logoutButton").classList.toggle("is-hidden", !u);
}

function render() {
  qs("#pageTitle").textContent = viewTitles[state.view] || "Disaster Monitor";
  qs("#liveStatus").textContent = state.emergency ? "Emergency" : liveData.backendOnline ? "Online" : state.offline ? "Offline" : "Connecting...";
  qs("#liveStatus").classList.toggle("emergency", state.emergency);
  qsa(".nav-item").forEach(i => i.classList.toggle("active", i.dataset.view === state.view));
  updateSystemHealth(); updateAuthPanel(); renderKpis(); renderView();
}

function init() {
  window.addEventListener("ner:auth", e => {
    const fbUser = e.detail.user;
    if (fbUser) {
      liveData.user = { email: fbUser.email, name: fbUser.name || fbUser.email, role: "citizen", district: "Aizawl" };
      storage.set("ner:user", liveData.user);
      showApp(); render(); refreshLiveData({}); connectWebSocket();
      watchUserLocation(); startAutoRefresh();
      toast("Signed in with Google.");
    }
  });
  window.addEventListener("ner:toast", e => { if (e.detail?.message) toast(e.detail.message); });

  const loggedIn = initLogin();
  initLoginForm();

  function attachNavHandlers() {
    qsa(".nav-item").forEach(i => i.addEventListener("click", () => setView(i.dataset.view)));
  }
  attachNavHandlers();
  window.addEventListener("hashchange", () => { const n = location.hash.replace("#", ""); if (n && n !== state.view) setView(n); });
  qs("#loginButton").addEventListener("click", () => showLogin());
  qs("#notifyButton").addEventListener("click", () => {
    if ("Notification" in window && Notification.permission === "default") { Notification.requestPermission(); toast("Permission requested."); }
    else toast("Enable notifications in browser settings.");
  });

  render();
  refreshLiveData({ quiet: true });
  connectWebSocket();
  watchUserLocation();
  startAutoRefresh();
}

init();

// ========== LANDING PAGE HELPERS ==========
function showLpLogin() {
  document.getElementById("loginScreen").classList.add("visible");
  document.getElementById("landingPage").classList.add("hidden");
}

// ========== DISASTER CANVAS ANIMATION ==========
(function() {
  var canvas = document.getElementById("disasterCanvas");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");
  var W, H;
  function resize() { W = canvas.width = canvas.offsetWidth; H = canvas.height = canvas.offsetHeight; }
  resize();
  window.addEventListener("resize", resize);

  var raindrops = [];
  var lightningBolts = [];
  var waves = [];
  var clouds = [];
  var particles = [];

  for (var i = 0; i < 120; i++) {
    raindrops.push({ x: Math.random() * 2000, y: Math.random() * 1200, len: 10 + Math.random() * 20, speed: 4 + Math.random() * 6, opacity: 0.15 + Math.random() * 0.35 });
  }
  for (var i = 0; i < 6; i++) {
    clouds.push({ x: Math.random() * 2000, y: 30 + Math.random() * 120, w: 100 + Math.random() * 200, h: 40 + Math.random() * 40, speed: 0.2 + Math.random() * 0.3, opacity: 0.3 + Math.random() * 0.4 });
  }
  for (var i = 0; i < 40; i++) {
    particles.push({ x: Math.random() * 2000, y: Math.random() * 1200, vx: (Math.random() - 0.5) * 1.5, vy: (Math.random() - 0.5) * 1.5, r: 1 + Math.random() * 2, opacity: 0.2 + Math.random() * 0.5, color: Math.random() > 0.7 ? "#ff771c" : Math.random() > 0.5 ? "#4A90D9" : "#2E8B57" });
  }

  var lastLightning = 0;
  var flashOpacity = 0;

  function drawCloud(c) {
    ctx.beginPath();
    ctx.fillStyle = "rgba(180,190,210," + c.opacity + ")";
    ctx.ellipse(c.x, c.y, c.w / 2, c.h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(c.x - c.w * 0.25, c.y + 5, c.w * 0.3, c.h * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(c.x + c.w * 0.25, c.y + 3, c.w * 0.35, c.h * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawLightning(x1, y1, x2, y2, depth) {
    if (depth <= 0) return;
    var midX = (x1 + x2) / 2 + (Math.random() - 0.5) * 60;
    var midY = (y1 + y2) / 2 + (Math.random() - 0.5) * 20;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(midX, midY);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = "rgba(255,255,200," + (0.6 + depth * 0.1) + ")";
    ctx.lineWidth = depth * 0.8;
    ctx.stroke();
    if (Math.random() > 0.5) drawLightning(midX, midY, midX + (Math.random() - 0.5) * 80, midY + 40 + Math.random() * 60, depth - 1);
    if (Math.random() > 0.6) drawLightning(midX, midY, midX + (Math.random() - 0.5) * 60, midY + 30 + Math.random() * 50, depth - 1);
  }

  function drawWave(t) {
    for (var w = 0; w < 3; w++) {
      ctx.beginPath();
      var baseY = H * 0.75 + w * 18;
      ctx.moveTo(0, baseY);
      for (var x = 0; x <= W; x += 4) {
        var y = baseY + Math.sin(x * 0.008 + t * 0.001 + w * 1.2) * (12 + w * 6) + Math.sin(x * 0.003 + t * 0.0005) * 8;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
      ctx.closePath();
      var alpha = 0.08 + w * 0.04;
      ctx.fillStyle = "rgba(74,144,217," + alpha + ")";
      ctx.fill();
    }
  }

  function frame(t) {
    ctx.clearRect(0, 0, W, H);

    // Background gradient
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#1a1a2e");
    grad.addColorStop(0.5, "#16213e");
    grad.addColorStop(1, "#0f3460");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Particles
    particles.forEach(function(p) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = W;
      if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H;
      if (p.y > H) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color.replace(")", "," + p.opacity + ")").replace("rgb", "rgba");
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.opacity;
      ctx.fill();
      ctx.globalAlpha = 1;
    });

    // Clouds
    clouds.forEach(function(c) {
      c.x += c.speed;
      if (c.x > W + 200) c.x = -200;
      drawCloud(c);
    });

    // Rain
    ctx.strokeStyle = "rgba(180,200,230,0.4)";
    ctx.lineWidth = 1;
    raindrops.forEach(function(r) {
      ctx.globalAlpha = r.opacity;
      ctx.beginPath();
      ctx.moveTo(r.x, r.y);
      ctx.lineTo(r.x - 2, r.y + r.len);
      ctx.stroke();
      r.y += r.speed;
      r.x -= 0.5;
      if (r.y > H) { r.y = -r.len; r.x = Math.random() * (W + 200); }
    });
    ctx.globalAlpha = 1;

    // Lightning
    if (t - lastLightning > 4000 + Math.random() * 8000) {
      lastLightning = t;
      var lx = W * 0.3 + Math.random() * W * 0.4;
      lightningBolts.push({ x: lx, y: 0, endX: lx + (Math.random() - 0.5) * 100, endY: H * 0.5 + Math.random() * H * 0.3, depth: 4 + Math.floor(Math.random() * 2), born: t });
      flashOpacity = 0.15;
    }
    lightningBolts.forEach(function(b) {
      drawLightning(b.x, b.y, b.endX, b.endY, b.depth);
    });
    lightningBolts = lightningBolts.filter(function(b) { return t - b.born < 200; });

    if (flashOpacity > 0) {
      ctx.fillStyle = "rgba(255,255,255," + flashOpacity + ")";
      ctx.fillRect(0, 0, W, H);
      flashOpacity -= 0.005;
    }

    // Waves (flood)
    drawWave(t);

    // Mountain silhouettes
    ctx.beginPath();
    ctx.moveTo(0, H * 0.65);
    ctx.lineTo(W * 0.15, H * 0.4);
    ctx.lineTo(W * 0.3, H * 0.55);
    ctx.lineTo(W * 0.45, H * 0.35);
    ctx.lineTo(W * 0.6, H * 0.5);
    ctx.lineTo(W * 0.75, H * 0.38);
    ctx.lineTo(W * 0.9, H * 0.52);
    ctx.lineTo(W, H * 0.45);
    ctx.lineTo(W, H * 0.7);
    ctx.lineTo(0, H * 0.7);
    ctx.closePath();
    ctx.fillStyle = "rgba(15,20,35,0.5)";
    ctx.fill();

    // Risk pulse rings
    var pulseR = 30 + Math.sin(t * 0.002) * 15;
    ctx.beginPath();
    ctx.arc(W * 0.5, H * 0.45, pulseR, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,119,28,0.3)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(W * 0.5, H * 0.45, pulseR + 20, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,119,28,0.15)";
    ctx.stroke();

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Counter animation
  window.addEventListener("scroll", function() {
    document.querySelectorAll(".lp-stat-num[data-target]").forEach(function(el) {
      if (el.dataset.animated) return;
      var rect = el.getBoundingClientRect();
      if (rect.top > window.innerHeight || rect.bottom < 0) return;
      el.dataset.animated = "1";
      var target = parseInt(el.dataset.target, 10);
      var start = 0;
      var duration = 1200;
      var startTime = null;
      function step(ts) {
        if (!startTime) startTime = ts;
        var p = Math.min((ts - startTime) / duration, 1);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.floor(eased * target);
        if (p < 1) requestAnimationFrame(step);
        else el.textContent = target;
      }
      requestAnimationFrame(step);
    });
  }, { passive: true });
})();
