// ========== STORAGE ==========
const storage = {
  get(k, f) {
    try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : f; } catch (e) { return f; }
  },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
  removeItem(k) { localStorage.removeItem(k); }
};

// ========== CONFIG ==========
const appConfig = window.NER_APP_CONFIG || {
  apiBaseUrl: "http://127.0.0.1:8000",
  defaultLocation: { name: "Aizawl", lat: 23.7271, lon: 92.7176 }
};

const DEFAULT_LOCATION = { name: "Aizawl", lat: 23.7271, lon: 92.7176 };

// ========== DISTRICT COORDINATES ==========
const districtCoordinates = {
  Mizoram: { lat: 23.7271, lon: 92.7176 },
  "Aizawl": { lat: 23.7271, lon: 92.7176 },
  Manipur: { lat: 24.8170, lon: 93.9368 },
  "Imphal East": { lat: 24.8170, lon: 93.9368 },
  Meghalaya: { lat: 25.5788, lon: 91.8933 },
  "East Khasi Hills": { lat: 25.5788, lon: 91.8933 },
  Assam: { lat: 26.1445, lon: 91.7362 },
  "Kamrup Metropolitan": { lat: 26.1445, lon: 91.7362 },
  Nagaland: { lat: 25.6751, lon: 94.1086 },
  Kohima: { lat: 25.6751, lon: 94.1086 },
  Tripura: { lat: 23.8315, lon: 91.2868 },
  "West Tripura": { lat: 23.8315, lon: 91.2868 },
  Arunachal: { lat: 27.5330, lon: 93.8330 },
  "Lower Subansiri": { lat: 27.5330, lon: 93.8330 },
  Sikkim: { lat: 27.5330, lon: 88.5122 },
  "Gangtok": { lat: 27.3389, lon: 88.6065 }
};

// ========== STATE ==========
const state = {
  view: (location.hash || "#dashboard").replace("#", "") || "dashboard",
  district: "Aizawl",
  emergency: storage.get("ner:emergency", false),
  offline: false,
  incidents: [],
  notifications: storage.get("ner:notifications", []),
  queuedReports: storage.get("ner:queuedReports", []),
  thresholds: storage.get("ner:thresholds", { moderate: 21, elevated: 41, high: 61, critical: 81, rainfall: 45, flood: 70 }),
  layers: storage.get("ner:layers", { incidents: true, flood: true, risk: true, weather: true }),
  weather: storage.get("ner:weather", {
    location: "Aizawl",
    temperature: 24,
    humidity: 86,
    rainfall: 58,
    wind: 18,
    rainProbability: 82,
    floodIndex: 71,
    warning: "Heavy rainfall likely",
    source: "demo",
    hourly: [],
    affectedRoads: ["Silchar to Aizawl", "Guwahati to Shillong", "Imphal to Moreh"]
  }),
  lastAIAnalysis: null,
  previousRiskScore: 0,
  autoRefreshTimer: null,
  userLocation: storage.get("ner:userLocation", null),
  backendOnline: false,
  user: null
};

let ws = null;
let wsReconnectTimer = null;
let leafletMap = null;
let incidentMarkers = {};
let userMarker = null;
let floodCircles = [];
let riskCircles = [];

// ========== DOM HELPERS ==========
function qs(selector, root) { return (root || document).querySelector(selector); }
function qsa(selector, root) { return [...(root || document).querySelectorAll(selector)]; }

// ========== API HELPERS ==========
async function apiGet(path) {
  const r = await fetch(`${appConfig.apiBaseUrl}${path}`);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(`${appConfig.apiBaseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text(); throw new Error(t || `${r.status} ${r.statusText}`); }
  return r.json();
}

async function apiPatch(path, body) {
  const r = await fetch(`${appConfig.apiBaseUrl}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text(); throw new Error(t || `${r.status} ${r.statusText}`); }
  return r.json();
}

// ========== UTILITY FUNCTIONS ==========
function clamp(v, mn, mx) { return Math.min(mx, Math.max(mn, v)); }

function escapeHtml(v) {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function classifyRisk(score) {
  if (score >= state.thresholds.critical) return "critical";
  if (score >= state.thresholds.high) return "high";
  if (score >= state.thresholds.elevated) return "elevated";
  if (score >= state.thresholds.moderate) return "moderate";
  return "low";
}

function riskLabel(score) {
  return { low: "Low", moderate: "Moderate", elevated: "Elevated", high: "High", critical: "Critical" }[classifyRisk(score)] || "Unknown";
}

function riskBadge(score) {
  return '<span class="risk-badge risk-' + classifyRisk(score) + '">' + riskLabel(score) + '</span>';
}

function computeRisk() {
  const w = state.weather;
  const active = state.incidents.filter(function (i) { return i.status !== "RESOLVED"; });
  const incidentRisk = clamp(active.length * 12, 0, 40);
  return clamp(Math.round(
    w.rainfall * 0.25 +
    w.floodIndex * 0.25 +
    (state.lastAIAnalysis?.score || 50) * 0.2 +
    incidentRisk * 0.15 +
    (state.emergency ? 8 : 0)
  ), 0, 100);
}

function riskFactors() {
  var w = state.weather;
  var active = state.incidents.filter(function (i) { return i.status !== "RESOLVED"; });
  return [
    { label: "Rainfall", value: clamp(w.rainfall, 0, 100), note: w.rainfall + "mm" },
    { label: "Flood Risk", value: clamp(w.floodIndex, 0, 100), note: "Hydrological model" },
    { label: "Wind Speed", value: clamp(w.wind * 1.5, 0, 100), note: w.wind + " km/h" },
    { label: "Active Incidents", value: clamp(active.length * 16, 0, 100), note: active.length + " active" },
    { label: "Humidity", value: clamp(w.humidity, 0, 100), note: w.humidity + "%" },
    { label: "Rain Probability", value: clamp(w.rainProbability, 0, 100), note: w.rainProbability + "%" }
  ];
}

function addNotification(title, message, severity, source) {
  var n = {
    id: Date.now(),
    title: title,
    message: message,
    severity: severity || "moderate",
    source: source || "System",
    time: new Date().toISOString(),
    read: false
  };
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
  storage.set("ner:weather", {
    location: state.weather.location,
    temperature: state.weather.temperature,
    humidity: state.weather.humidity,
    rainfall: state.weather.rainfall,
    wind: state.weather.wind,
    rainProbability: state.weather.rainProbability,
    floodIndex: state.weather.floodIndex,
    warning: state.weather.warning,
    source: state.weather.source,
    hourly: state.weather.hourly,
    affectedRoads: state.weather.affectedRoads
  });
  storage.set("ner:userLocation", state.userLocation);
}

function toast(msg, type) {
  var host = qs("#toastHost");
  if (!host) return;
  var n = document.createElement("div");
  n.className = "toast toast-" + (type || "success");
  n.innerHTML = '<div class="toast-title">' + escapeHtml(msg) + '</div>';
  host.appendChild(n);
  setTimeout(function () { n.remove(); }, 4000);
}

function districtLocation() {
  return districtCoordinates[state.district] || appConfig.defaultLocation || DEFAULT_LOCATION;
}

// ========== VIEW TITLES ==========
var viewTitles = {
  dashboard: "Dashboard",
  map: "Live Map",
  weather: "Weather",
  alerts: "Alerts",
  report: "Report",
  emergency: "Emergency",
  settings: "Settings"
};

// ========== NAVIGATION ==========
function setView(view) {
  if (!viewTitles[view]) view = "dashboard";
  state.view = view;
  saveState();
  if (location.hash !== "#" + view) {
    history.replaceState(null, "", "#" + view);
  }
  render();
  if (view === "map") {
    setTimeout(function () { initLeafletMap("dashboardMap"); }, 150);
  }
}

function attachNavHandlers() {
  qsa(".sidebar-nav-item").forEach(function (item) {
    item.addEventListener("click", function (e) {
      e.preventDefault();
      var view = this.getAttribute("data-view");
      if (view) setView(view);
    });
  });
}

// ========== AUTH ==========
function initApp() {
  var savedUser = storage.get("ner:user", null);
  if (savedUser) {
    state.user = savedUser;
    state.userLocation = storage.get("ner:userLocation", null);
    showApp();
    return true;
  }
  showLanding();
  return false;
}

function showSignIn() {
  var landing = qs("#landingPage");
  var signIn = qs("#signInPage");
  var appShell = qs("#appShell");
  if (landing) landing.classList.add("hidden");
  if (appShell) { appShell.classList.add("hidden"); appShell.classList.remove("visible"); }
  if (signIn) signIn.classList.add("visible");
}

function showApp() {
  var landing = qs("#landingPage");
  var signIn = qs("#signInPage");
  var appShell = qs("#appShell");
  if (landing) landing.classList.add("hidden");
  if (signIn) signIn.classList.remove("visible");
  if (appShell) { appShell.classList.remove("hidden"); appShell.classList.add("visible"); }
}

function showLanding() {
  var landing = qs("#landingPage");
  var signIn = qs("#signInPage");
  var appShell = qs("#appShell");
  if (appShell) { appShell.classList.remove("visible"); appShell.classList.add("hidden"); }
  if (signIn) signIn.classList.remove("visible");
  if (landing) landing.classList.remove("hidden");
}

function handleGoogleSignIn() {
  if (window.nerFirebase && window.nerFirebase.signIn) {
    window.nerFirebase.signIn().catch(function (err) {
      var msg = err.message || String(err);
      var errEl = qs("#googleLoginBtn");
      if (msg.indexOf("unauthorized-domain") !== -1) {
        toast("Firebase: add domain to authorized domains.", "warning");
      } else {
        toast("Sign-in error: " + msg, "warning");
      }
    });
  } else {
    var fakeUser = {
      email: "admin@ner-gov.in",
      name: "NER Admin",
      role: "district_officer",
      district: "Aizawl",
      photoURL: ""
    };
    state.user = fakeUser;
    storage.set("ner:user", fakeUser);
    onSignInSuccess(fakeUser);
  }
}

function onSignInSuccess(user) {
  state.user = user;
  storage.set("ner:user", user);
  showApp();
  render();
  refreshAllData();
  connectWebSocket();
  requestLocation();
  watchUserLocation();
  startAutoRefresh();
  toast("Welcome, " + (user.name || user.email) + "!");
}

function handleLogout() {
  state.user = null;
  storage.removeItem("ner:user");
  if (ws) { ws.close(); ws = null; }
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (state.autoRefreshTimer) { clearInterval(state.autoRefreshTimer); state.autoRefreshTimer = null; }
  if (leafletMap) { try { leafletMap.remove(); } catch (e) {} leafletMap = null; }
  incidentMarkers = {};
  userMarker = null;
  showLanding();
  toast("Logged out.");
}

// ========== LOCATION ==========
function requestLocation() {
  return new Promise(function (resolve) {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        var loc = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
        state.userLocation = loc;
        storage.set("ner:userLocation", loc);
        resolve(loc);
      },
      function () { resolve(null); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
    );
  });
}

function watchUserLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    function (pos) {
      state.userLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
      storage.set("ner:userLocation", state.userLocation);
      if (leafletMap) updateUserLocationMarker();
    },
    function () { },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

// ========== RENDER ==========
function render() {
  document.title = (viewTitles[state.view] || "Dashboard") + " — NER Logistics Intelligence";

  qsa(".sidebar-nav-item").forEach(function (item) {
    var v = item.getAttribute("data-view");
    if (v === state.view) item.classList.add("active");
    else item.classList.remove("active");
  });

  var topTitle = qs("#topbarTitle");
  if (topTitle) topTitle.textContent = viewTitles[state.view] || "Dashboard";

  updateUserUI();
  renderKpis();
  renderView();
  updateAlertBadge();
}

function updateUserUI() {
  var u = state.user;
  var nameEl = qs("#topbarUserName");
  var avatarEl = qs("#topbarUserAvatar");
  if (nameEl) nameEl.textContent = (u && (u.name || u.email)) || "User";
  if (avatarEl && u && u.photoURL) {
    avatarEl.src = u.photoURL;
    avatarEl.style.display = "inline-block";
  }
}

function updateAlertBadge() {
  var badge = qs("#alertBadge");
  if (badge) {
    var unread = state.notifications.filter(function (n) { return !n.read; }).length;
    badge.textContent = unread;
    badge.style.display = unread > 0 ? "inline-block" : "none";
  }
}

function renderKpis() {
  var score = computeRisk();
  var classification = classifyRisk(score);
  var active = state.incidents.filter(function (i) { return i.status !== "RESOLVED"; });
  var w = state.weather;
  var highRiskAreas = active.filter(function (i) {
    return i.severity === "Critical" || i.severity === "High";
  }).length;
  var blockedCorridors = active.filter(function (i) {
    return i.type && (i.type.indexOf("Road") !== -1 || i.type.indexOf("Bridge") !== -1 || i.type.indexOf("Block") !== -1);
  }).length;
  var weatherAlerts = (w.rainfall > state.thresholds.rainfall ? 1 : 0) + (w.floodIndex > state.thresholds.flood ? 1 : 0) + (w.wind > 50 ? 1 : 0);
  var reportsCount = state.incidents.length;

  var riskEl = qs("#kpiRiskLevel");
  var riskSub = qs("#kpiRiskSub");
  if (riskEl) { riskEl.textContent = score; riskEl.className = "kpi-card-value risk-" + classification; }
  if (riskSub) riskSub.textContent = riskLabel(score);

  var tempEl = qs("#kpiTemp");
  var tempSub = qs("#kpiTempSub");
  if (tempEl) tempEl.textContent = w.temperature + "\u00B0C";
  if (tempSub) tempSub.textContent = w.source === "open-meteo" ? "Live" : "Demo";

  var rainEl = qs("#kpiRain");
  var rainSub = qs("#kpiRainSub");
  if (rainEl) rainEl.textContent = w.rainfall + "mm";
  if (rainSub) rainSub.textContent = w.rainProbability + "% chance";

  var incEl = qs("#kpiIncidents");
  var incSub = qs("#kpiIncidentsSub");
  if (incEl) incEl.textContent = active.length;
  if (incSub) incSub.textContent = highRiskAreas + " high-risk";

  var floodEl = qs("#kpiFlood");
  var floodSub = qs("#kpiFloodSub");
  if (floodEl) floodEl.textContent = w.floodIndex;
  if (floodSub) floodSub.textContent = weatherAlerts + " alerts";

  var accEl = qs("#kpiAccess");
  var accSub = qs("#kpiAccessSub");
  if (accEl) accEl.textContent = blockedCorridors;
  if (accSub) accSub.textContent = blockedCorridors > 0 ? "blocked" : "all open";
}

function renderView() {
  var root = qs("#appViewRoot");
  if (!root) return;
  var views = {
    dashboard: renderDashboard,
    map: renderMapView,
    weather: renderWeather,
    alerts: renderAlerts,
    report: renderReport,
    emergency: renderEmergency,
    settings: renderSettings
  };
  var fn = views[state.view] || views.dashboard;
  root.innerHTML = fn();
  attachViewHandlers(root);
  if (state.view === "dashboard") {
    setTimeout(function () { initLeafletMap("dashboardMap"); }, 150);
  }
}

// ========== VIEW: DASHBOARD ==========
function renderDashboard() {
  var score = computeRisk();
  var w = state.weather;
  var analysis = state.lastAIAnalysis;
  var recentAlerts = state.notifications.slice(0, 5);
  var active = state.incidents.filter(function (i) { return i.status !== "RESOLVED"; });

  var alertsHtml = recentAlerts.length ? recentAlerts.map(function (a) {
    var severityClass = a.severity === "critical" ? "alert-critical" : a.severity === "high" ? "alert-warning" : "alert-success";
    var dotClass = a.severity === "critical" ? "dot-critical" : a.severity === "high" ? "dot-warning" : "dot-success";
    return '<li class="alert-item ' + severityClass + '">' +
      '<span class="alert-dot ' + dotClass + '"></span>' +
      '<div class="alert-text"><strong>' + escapeHtml(a.title) + '</strong><br><small>' + escapeHtml(a.message) + '</small></div>' +
      '<span class="alert-time">' + new Date(a.time).toLocaleTimeString() + '</span>' +
      '</li>';
  }).join("") : '<li class="alert-item"><div class="alert-text"><strong>No alerts yet</strong><br><small>AI is monitoring conditions.</small></div></li>';

  var factorsHtml = riskFactors().map(function (f) {
    return '<div style="margin-bottom:10px">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="font-size:0.82rem;font-weight:600">' + f.label + '</span><span style="font-size:0.78rem;color:var(--muted)">' + f.value + '/100</span></div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + f.value + '%"></div></div>' +
      '<small style="color:var(--muted);font-size:0.72rem">' + f.note + '</small></div>';
  }).join("");

  var roadsHtml = w.affectedRoads.map(function (r, i) {
    return '<li class="road-item"><div class="road-item-header"><h4>' + escapeHtml(r) + '</h4>' +
      '<span class="road-badge ' + (i === 0 ? "badge-closed" : i === 1 ? "badge-delayed" : "badge-open") + '">' +
      (i === 0 ? "Blocked" : i === 1 ? "Delayed" : "Open") + '</span></div>' +
      '<p>Weather impact: ' + (i === 0 ? "Heavy" : i === 1 ? "Moderate" : "Low") + '</p></li>';
  }).join("");

  var hourlyHtml = "";
  if (w.hourly && w.hourly.length) {
    hourlyHtml = '<div class="forecast-bars">' +
      w.hourly.slice(0, 8).map(function (h) {
        var barHeight = Math.max(10, Math.min(100, (h.rain || 0) * 2));
        return '<div style="text-align:center"><div class="forecast-bar" style="height:' + barHeight + 'px"></div><div style="font-size:0.68rem;margin-top:4px"><strong>' + (h.rain || 0) + '</strong><br>' + h.hour + ':00</div></div>';
      }).join("") +
      '</div>';
  } else {
    hourlyHtml = '<p style="color:var(--muted);text-align:center;padding:20px">No hourly data</p>';
  }

  var classification = classifyRisk(score);
  var dialAngle = score * 3.6;
  var dialColor = classification === "critical" ? "var(--danger)" : classification === "high" ? "var(--primary-dark)" : classification === "elevated" ? "var(--primary)" : classification === "moderate" ? "var(--warning)" : "var(--success)";

  return '<div class="dashboard-grid">' +
    '<div class="map-shell"><div id="dashboardMap" style="min-height:500px;width:100%"></div></div>' +
    '<div class="side-stack">' +
      '<div class="panel">' +
        '<div class="panel-header"><div><p class="eyebrow">AI Risk Engine</p><h3>Risk Assessment</h3></div>' + riskBadge(score) + '</div>' +
        '<div class="panel-body">' +
          '<div class="risk-dial">' +
            '<div class="dial-ring"><svg width="80" height="80"><circle cx="40" cy="40" r="34" fill="none" stroke="var(--border)" stroke-width="6"/>' +
            '<circle cx="40" cy="40" r="34" fill="none" stroke="' + dialColor + '" stroke-width="6" stroke-dasharray="' + (dialAngle / 100 * 213.6) + ' 213.6" stroke-linecap="round" transform="rotate(-90 40 40)"/></svg>' +
            '<div class="dial-core" style="flex-direction:column"><span style="font-size:0.68rem;color:var(--muted)">Score</span><strong style="font-size:1.1rem">' + score + '</strong></div></div>' +
            '<div><p style="font-size:0.82rem;color:var(--muted);line-height:1.5">' + (analysis ? analysis.recommendation : "Analyzing conditions...") + '</p>' +
            (analysis && analysis.rising ? '<p style="color:var(--danger);font-weight:700;font-size:0.78rem;margin-top:6px">\u2191 Risk increasing</p>' : '') +
            (analysis && analysis.falling ? '<p style="color:var(--success);font-weight:700;font-size:0.78rem;margin-top:6px">\u2193 Risk decreasing</p>' : '') +
            '</div></div>' +
          '<div style="margin-top:16px">' + factorsHtml + '</div>' +
        '</div></div>' +
      '<div class="panel">' +
        '<div class="panel-header"><div><p class="eyebrow">Notifications</p><h3>Recent Alerts</h3></div>' +
        '<button class="ghost-button" data-action="view-alerts" style="min-height:28px;padding:2px 8px;font-size:0.75rem">View All</button></div>' +
        '<div class="panel-body"><ul class="alert-list">' + alertsHtml + '</ul></div></div>' +
      '<div class="panel">' +
        '<div class="panel-header"><div><p class="eyebrow">Weather</p><h3>' + escapeHtml(w.location) + '</h3></div></div>' +
        '<div class="panel-body">' +
          '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px"><span style="font-size:2rem;font-weight:800">' + w.temperature + '\u00B0C</span><span style="font-size:0.82rem;color:var(--muted)">' + w.source + '</span></div>' +
          '<p style="font-size:0.82rem;color:var(--muted);margin-bottom:8px">' + escapeHtml(w.warning) + '</p>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">' +
          '<small>Rain: ' + w.rainfall + 'mm</small>' +
          '<small>Wind: ' + w.wind + ' km/h</small>' +
          '<small>Humidity: ' + w.humidity + '%</small>' +
          '<small>Flood: ' + w.floodIndex + '/100</small>' +
          '</div></div></div>' +
    '</div></div>' +
    '<div class="grid-3" style="margin-top:20px">' +
      '<div class="panel">' +
        '<div class="panel-header"><div><p class="eyebrow">Weather</p><h3>Forecast</h3></div></div>' +
        '<div class="panel-body">' + hourlyHtml + '</div></div>' +
      '<div class="panel">' +
        '<div class="panel-header"><div><p class="eyebrow">Risk Analysis</p><h3>Factors</h3></div></div>' +
        '<div class="panel-body">' + factorsHtml + '</div></div>' +
      '<div class="panel">' +
        '<div class="panel-header"><div><p class="eyebrow">Roads</p><h3>Affected Corridors</h3></div></div>' +
        '<div class="panel-body"><div class="road-list">' + roadsHtml + '</div></div></div>' +
    '</div>';
}

// ========== VIEW: MAP ==========
function renderMapView() {
  var layerChips = Object.keys(state.layers).map(function (k) {
    return '<button class="chip ' + (state.layers[k] ? "active" : "") + '" type="button" data-layer="' + k + '">' +
      k.charAt(0).toUpperCase() + k.slice(1) + '</button>';
  }).join("");

  return '<div class="section-header">' +
    '<div><h2>Live Disaster Map</h2><p style="color:var(--muted);font-size:0.85rem">Interactive GIS with real-time incident and risk overlays</p></div>' +
    '<div class="action-row">' +
      '<button class="ghost-button" type="button" data-action="center-me">My Location</button>' +
      '<button class="ghost-button" type="button" data-action="center-ner">Center NER</button>' +
      '<button class="ghost-button" type="button" data-action="refresh-map">Refresh</button>' +
    '</div></div>' +
    '<div style="margin-top:12px;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">' +
      '<div style="padding:10px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<input id="mapSearchInput" type="text" placeholder="Search locations, incidents..." autocomplete="off" style="flex:1;min-width:200px;padding:8px 14px;border:1.5px solid var(--border);border-radius:8px;font-size:0.84rem" />' +
        '<div class="layer-list" style="display:flex;gap:6px;flex-wrap:wrap">' + layerChips + '</div>' +
      '</div>' +
      '<div id="dashboardMap" style="height:600px"></div>' +
    '</div>';
}

// ========== VIEW: WEATHER ==========
function renderWeather() {
  var w = state.weather;
  var score = Math.max(w.rainfall, w.floodIndex);

  var stripCards = [
    { label: "Temperature", value: w.temperature + "\u00B0C", icon: "\uD83C\uDF21\uFE0F" },
    { label: "Humidity", value: w.humidity + "%", icon: "\uD83D\uDCA7" },
    { label: "Rainfall", value: w.rainfall + "mm", icon: "\uD83C\uDF27\uFE0F" },
    { label: "Wind", value: w.wind + " km/h", icon: "\uD83C\uDF2C\uFE0F" },
    { label: "Rain %", value: w.rainProbability + "%", icon: "\u2614" },
    { label: "Flood Index", value: w.floodIndex + "/100", icon: "\uD83C\uDF0A" }
  ];

  var stripHtml = stripCards.map(function (c) {
    return '<div class="weather-card" style="text-align:center;padding:16px">' +
      '<div style="font-size:1.4rem;margin-bottom:6px">' + c.icon + '</div>' +
      '<div style="font-size:0.78rem;color:var(--muted);margin-bottom:4px">' + c.label + '</div>' +
      '<div style="font-size:1.15rem;font-weight:700">' + c.value + '</div></div>';
  }).join("");

  var hourlyHtml = "";
  if (w.hourly && w.hourly.length) {
    hourlyHtml = '<div class="forecast-bars">' +
      w.hourly.slice(0, 8).map(function (h) {
        var barH = Math.max(10, Math.min(100, (h.rain || 0) * 2));
        return '<div style="text-align:center"><div class="forecast-bar" style="height:' + barH + 'px"></div><div style="font-size:0.68rem;margin-top:4px"><strong>' + (h.rain || 0) + '</strong><br>' + h.hour + ':00</div></div>';
      }).join("") + '</div>';
  } else {
    hourlyHtml = '<p style="color:var(--muted);text-align:center;padding:30px">No hourly forecast data</p>';
  }

  var roadsHtml = w.affectedRoads.map(function (r, i) {
    var severity = i === 0 ? "High" : i === 1 ? "Moderate" : "Low";
    return '<div class="road-item"><div class="road-item-header"><h4>' + escapeHtml(r) + '</h4>' +
      '<span class="road-badge ' + (i === 0 ? "badge-closed" : i === 1 ? "badge-delayed" : "badge-open") + '">' + severity + '</span></div>' +
      '<p>Weather impact: ' + (i === 0 ? "Heavy rainfall, possible flooding" : i === 1 ? "Moderate rain, reduced visibility" : "Light conditions") + '</p></div>';
  }).join("");

  return '<div class="section-header">' +
    '<div><h2>' + escapeHtml(w.location) + ' Weather</h2><p style="color:var(--muted);font-size:0.85rem">' + escapeHtml(w.warning) + ' \u2014 Source: ' + w.source + '</p></div>' +
    '<div>' + riskBadge(score) + '</div></div>' +
    '<div class="weather-strip" style="margin-top:16px">' + stripHtml + '</div>' +
    '<div class="grid-2" style="margin-top:20px">' +
      '<div class="panel"><div class="panel-header"><div><p class="eyebrow">Hourly</p><h3>Rainfall Forecast</h3></div></div>' +
        '<div class="panel-body">' + hourlyHtml + '</div></div>' +
      '<div class="panel"><div class="panel-header"><div><p class="eyebrow">Roads</p><h3>Weather Impact</h3></div></div>' +
        '<div class="panel-body"><div class="road-list">' + roadsHtml + '</div></div></div>' +
    '</div>';
}

// ========== VIEW: ALERTS ==========
function renderAlerts() {
  var notifs = state.notifications;
  var listHtml = notifs.length ? notifs.map(function (n) {
    var sevColor = n.severity === "critical" ? "var(--danger)" : n.severity === "high" ? "var(--primary)" : n.severity === "moderate" ? "var(--warning)" : "var(--success)";
    var dotClass = n.severity === "critical" ? "dot-critical" : n.severity === "high" ? "dot-warning" : "dot-success";
    return '<div class="alert-item" style="border-left:4px solid ' + sevColor + ';margin-bottom:8px">' +
      '<span class="alert-dot ' + dotClass + '"></span>' +
      '<div style="flex:1"><div style="display:flex;justify-content:space-between;align-items:start;gap:8px">' +
        '<div><strong>' + escapeHtml(n.title) + '</strong><p style="margin:4px 0 0;font-size:0.82rem;color:var(--muted)">' + escapeHtml(n.message) + '</p>' +
        '<small style="color:#999">' + new Date(n.time).toLocaleString() + ' \u2014 ' + escapeHtml(n.source) + '</small></div>' +
        (n.read ? '' : '<span style="width:8px;height:8px;border-radius:50%;background:var(--primary);flex-shrink:0"></span>') +
      '</div></div></div>';
  }).join("") : '<div class="panel" style="padding:40px;text-align:center"><p style="color:var(--muted)">No notifications yet. AI is monitoring conditions.</p></div>';

  return '<div class="section-header">' +
    '<div><h2>Alerts & Notifications</h2><p style="color:var(--muted);font-size:0.85rem">' + notifs.length + ' notification' + (notifs.length !== 1 ? 's' : '') + '</p></div>' +
    '<div class="action-row">' +
      '<button class="ghost-button" type="button" data-action="mark-all-read">Mark All Read</button>' +
      '<button class="ghost-button" type="button" data-action="clear-alerts">Clear All</button>' +
    '</div></div>' +
    '<div style="margin-top:16px">' + listHtml + '</div>';
}

// ========== VIEW: REPORT ==========
function renderReport() {
  var pendingHtml = state.queuedReports.length ? state.queuedReports.map(function (r) {
    return '<div class="road-item"><div class="road-item-header"><h4>' + escapeHtml(r.type) + '</h4>' +
      '<span class="road-badge badge-delayed">Pending</span></div>' +
      '<p>' + escapeHtml(r.severity) + ' \u2014 ' + (r.createdAt || "queued") + '</p></div>';
  }).join("") : '<p style="color:var(--muted);padding:16px">No pending reports</p>';

  var recentHtml = state.incidents.slice(0, 8).map(function (i) {
    return '<div class="road-item"><div class="road-item-header"><h4>' + escapeHtml(i.type) + '</h4>' +
      '<span class="road-badge ' + (i.status === "RESOLVED" ? "badge-open" : i.severity === "Critical" ? "badge-closed" : "badge-delayed") + '">' + escapeHtml(i.status) + '</span></div>' +
      '<p>' + escapeHtml(i.severity) + (i.created_at ? ' \u2014 ' + new Date(i.created_at).toLocaleDateString() : '') + '</p></div>';
  }).join("");

  var locValue = state.userLocation
    ? state.userLocation.lat.toFixed(5) + ", " + state.userLocation.lon.toFixed(5)
    : "23.72710, 92.71760";

  return '<div class="section-header"><div><h2>Submit Field Report</h2><p style="color:var(--muted);font-size:0.85rem">Report floods, landslides, road damage. Reports feed the AI risk engine.</p></div></div>' +
    '<div class="grid-2" style="margin-top:16px">' +
      '<div class="form-card">' +
        '<form id="reportForm">' +
          '<div class="form-grid">' +
            '<div class="form-group"><label>Incident Type</label>' +
              '<select name="type" required><option value="Flood">Flood</option><option value="Landslide">Landslide</option><option value="Road Damage">Road Damage</option><option value="Bridge Damage">Bridge Damage</option><option value="Heavy Rainfall">Heavy Rainfall</option><option value="Road Blockage">Road Blockage</option><option value="Accident">Accident</option><option value="Other">Other</option></select></div>' +
            '<div class="form-group"><label>Severity</label>' +
              '<select name="severity" required><option value="Low">Low</option><option value="Medium" selected>Medium</option><option value="High">High</option><option value="Critical">Critical</option></select></div>' +
            '<div class="form-group form-full"><label>Location (Lat, Lon)</label>' +
              '<input name="location" type="text" value="' + locValue + '" required /></div>' +
            '<div class="form-group form-full"><label>Description</label>' +
              '<textarea name="description" placeholder="Describe what you see..." required></textarea></div>' +
          '</div>' +
          '<div class="action-row" style="margin-top:16px">' +
            '<button class="button" type="submit">Submit Report</button>' +
            '<button class="ghost-button" type="button" data-action="use-gps">Use My GPS</button>' +
            '<button class="ghost-button" type="button" data-action="toggle-offline">' + (state.offline ? "Go Online" : "Offline Mode") + '</button>' +
          '</div>' +
        '</form></div>' +
      '<div class="side-stack">' +
        '<div class="panel"><div class="panel-header"><div><p class="eyebrow">Queue</p><h3>' + state.queuedReports.length + ' Pending</h3></div>' +
          '<button class="ghost-button" type="button" data-action="sync-reports">Sync</button></div>' +
          '<div class="panel-body">' + pendingHtml + '</div></div>' +
        '<div class="panel"><div class="panel-header"><div><p class="eyebrow">Recent</p><h3>Incidents</h3></div></div>' +
          '<div class="panel-body"><div class="road-list">' + (recentHtml || '<p style="color:var(--muted)">No incidents yet</p>') + '</div></div></div>' +
      '</div></div>';
}

// ========== VIEW: EMERGENCY ==========
function renderEmergency() {
  var score = computeRisk();
  var active = state.incidents.filter(function (i) { return i.status !== "RESOLVED"; });
  var w = state.weather;

  var activeIncidentsHtml = active.slice(0, 5).map(function (i) {
    return '<div class="road-item"><div class="road-item-header"><h4>' + escapeHtml(i.type) + '</h4>' + riskBadge(i.risk_score || 0) + '</div>' +
      '<p>' + escapeHtml(i.severity) + ' \u2014 ' + escapeHtml(i.status) + '</p></div>';
  }).join("");

  return '<div class="emergency-hero ' + (state.emergency ? "active" : "") + '">' +
    '<div style="display:flex;justify-content:space-between;align-items:start;flex-wrap:wrap;gap:16px">' +
      '<div><h3 style="color:var(--danger);font-size:1.1rem;font-weight:700">' + (state.emergency ? "\u26A0 EMERGENCY MODE ACTIVE" : "Emergency Response Center") + '</h3>' +
      '<p style="color:var(--muted);font-size:0.85rem;margin-top:6px">' + (state.emergency ? "Emergency protocols are active. All systems in alert mode." : "Activate emergency mode to enable enhanced monitoring and alert broadcasting.") + '</p></div>' +
      '<div class="action-row">' +
        '<button class="' + (state.emergency ? "danger-button" : "button") + '" type="button" data-action="toggle-emergency">' + (state.emergency ? "Deactivate Emergency" : "Activate Emergency") + '</button>' +
        '<button class="ghost-button" type="button" data-action="broadcast-alert">Broadcast Alert</button>' +
      '</div></div></div>' +
    '<div class="grid-3" style="margin-top:20px">' +
      '<div class="panel"><div class="panel-header"><div><p class="eyebrow">Risk</p><h3>Current Level</h3></div></div>' +
        '<div class="panel-body" style="text-align:center;padding:24px">' +
          '<div style="font-size:3rem;font-weight:800">' + score + '</div>' +
          riskBadge(score) +
          '<p style="color:var(--muted);margin-top:8px;font-size:0.82rem">' + (state.lastAIAnalysis ? state.lastAIAnalysis.recommendation : "Analyzing...") + '</p>' +
        '</div></div>' +
      '<div class="panel"><div class="panel-header"><div><p class="eyebrow">Incidents</p><h3>Active (' + active.length + ')</h3></div></div>' +
        '<div class="panel-body"><div class="road-list">' +
        (activeIncidentsHtml || '<p style="color:var(--muted)">No active incidents</p>') +
        '</div></div></div>' +
      '<div class="panel"><div class="panel-header"><div><p class="eyebrow">Weather</p><h3>Conditions</h3></div></div>' +
        '<div class="panel-body" style="padding:20px">' +
          '<div style="font-size:1.8rem;font-weight:800">' + w.temperature + '\u00B0C</div>' +
          '<p style="color:var(--muted);font-size:0.85rem;margin:6px 0">' + w.rainfall + 'mm rain, ' + w.wind + ' km/h wind</p>' +
          '<p style="color:var(--muted);font-size:0.82rem">' + escapeHtml(w.warning) + '</p>' +
          '<div style="margin-top:12px">' + riskBadge(w.floodIndex) + '</div>' +
        '</div></div>' +
    '</div>';
}

// ========== VIEW: SETTINGS ==========
function renderSettings() {
  var u = state.user || {};
  var notifPrefs = state.thresholds;

  return '<div class="section-header"><div><h2>Settings</h2><p style="color:var(--muted);font-size:0.85rem">Manage your profile and preferences</p></div></div>' +
    '<div class="grid-2" style="margin-top:16px">' +
      '<div>' +
        '<div class="panel" style="margin-bottom:20px"><div class="panel-header"><div><p class="eyebrow">Profile</p><h3>Account</h3></div></div>' +
          '<div class="panel-body">' +
            '<div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">' +
              '<div style="width:48px;height:48px;border-radius:50%;background:var(--primary);color:#fff;display:grid;place-items:center;font-size:1.2rem;font-weight:700">' +
                (u.name ? u.name.charAt(0).toUpperCase() : "U") + '</div>' +
              '<div><strong style="font-size:0.95rem">' + escapeHtml(u.name || "User") + '</strong><br><small style="color:var(--muted)">' + escapeHtml(u.email || "") + '</small><br><small style="color:var(--primary);font-weight:600">' + escapeHtml(u.role || "citizen") + '</small></div>' +
            '</div>' +
            '<div style="padding-top:12px;border-top:1px solid var(--border)">' +
              '<div style="display:flex;justify-content:space-between;padding:8px 0"><span style="font-size:0.82rem">District</span><span style="font-size:0.82rem;font-weight:600">' + escapeHtml(u.district || "Aizawl") + '</span></div>' +
              '<div style="display:flex;justify-content:space-between;padding:8px 0"><span style="font-size:0.82rem">Status</span><span style="font-size:0.82rem;color:var(--success);font-weight:600">Active</span></div>' +
            '</div></div></div>' +

        '<div class="panel" style="margin-bottom:20px"><div class="panel-header"><div><p class="eyebrow">Alerts</p><h3>Notification Preferences</h3></div></div>' +
          '<div class="panel-body">' +
            '<div class="form-group" style="margin-bottom:12px"><label>Moderate Risk Threshold</label>' +
              '<input type="range" min="10" max="50" value="' + notifPrefs.moderate + '" data-setting="moderate" class="setting-range" />' +
              '<small style="color:var(--muted)">' + notifPrefs.moderate + '/100</small></div>' +
            '<div class="form-group" style="margin-bottom:12px"><label>High Risk Threshold</label>' +
              '<input type="range" min="40" max="80" value="' + notifPrefs.high + '" data-setting="high" class="setting-range" />' +
              '<small style="color:var(--muted)">' + notifPrefs.high + '/100</small></div>' +
            '<div class="form-group" style="margin-bottom:12px"><label>Critical Risk Threshold</label>' +
              '<input type="range" min="60" max="100" value="' + notifPrefs.critical + '" data-setting="critical" class="setting-range" />' +
              '<small style="color:var(--muted)">' + notifPrefs.critical + '/100</small></div>' +
            '<div class="form-group" style="margin-bottom:12px"><label>Rainfall Alert (mm)</label>' +
              '<input type="range" min="20" max="100" value="' + notifPrefs.rainfall + '" data-setting="rainfall" class="setting-range" />' +
              '<small style="color:var(--muted)">' + notifPrefs.rainfall + 'mm</small></div>' +
            '<div class="form-group"><label>Flood Index Alert</label>' +
              '<input type="range" min="30" max="100" value="' + notifPrefs.flood + '" data-setting="flood" class="setting-range" />' +
              '<small style="color:var(--muted)">' + notifPrefs.flood + '/100</small></div>' +
          '</div></div>' +

        '<div class="panel"><div class="panel-header"><div><p class="eyebrow">Display</p><h3>Map Preferences</h3></div></div>' +
          '<div class="panel-body">' +
            Object.keys(state.layers).map(function (k) {
              return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">' +
                '<span style="font-size:0.84rem;font-weight:500">' + k.charAt(0).toUpperCase() + k.slice(1) + ' Layer</span>' +
                '<button class="chip ' + (state.layers[k] ? "active" : "") + '" type="button" data-layer="' + k + '" data-action="toggle-layer">' + (state.layers[k] ? "On" : "Off") + '</button></div>';
            }).join("") +
          '</div></div>' +
      '</div>' +

      '<div>' +
        '<div class="panel" style="margin-bottom:20px"><div class="panel-header"><div><p class="eyebrow">System</p><h3>Backend Status</h3></div></div>' +
          '<div class="panel-body">' +
            '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)"><span style="font-size:0.82rem">API Server</span><span style="font-size:0.82rem;color:' + (state.backendOnline ? "var(--success)" : "var(--danger)") + ';font-weight:600">' + (state.backendOnline ? "Online" : "Offline") + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)"><span style="font-size:0.82rem">WebSocket</span><span style="font-size:0.82rem;color:' + (ws && ws.readyState === WebSocket.OPEN ? "var(--success)" : "var(--danger)") + ';font-weight:600">' + (ws && ws.readyState === WebSocket.OPEN ? "Connected" : "Disconnected") + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)"><span style="font-size:0.82rem">Weather Feed</span><span style="font-size:0.82rem;color:' + (state.weather.source === "open-meteo" ? "var(--success)" : "var(--warning)") + ';font-weight:600">' + (state.weather.source === "open-meteo" ? "Live" : "Demo") + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;padding:8px 0"><span style="font-size:0.82rem">Location</span><span style="font-size:0.82rem;font-weight:600">' + (state.userLocation ? "Acquired" : "Default") + '</span></div>' +
          '</div></div>' +

        '<div class="panel"><div class="panel-header"><div><p class="eyebrow">Account</p><h3>Actions</h3></div></div>' +
          '<div class="panel-body">' +
            '<p style="font-size:0.82rem;color:var(--muted);margin-bottom:16px">Sign out of your account. Your local data will be preserved.</p>' +
            '<button class="danger-button" type="button" data-action="logout" style="width:100%">Sign Out</button>' +
          '</div></div>' +
      '</div></div>';
}

// ========== ATTACH VIEW HANDLERS ==========
function attachViewHandlers(root) {
  qsa("[data-layer]", root).forEach(function (btn) {
    btn.addEventListener("click", function () {
      var layer = this.getAttribute("data-layer");
      if (layer && state.layers.hasOwnProperty(layer)) {
        state.layers[layer] = !state.layers[layer];
        saveState();
        if (leafletMap) updateMapMarkers();
        render();
      }
    });
  });

  qsa("[data-action]", root).forEach(function (btn) {
    btn.addEventListener("click", function () {
      var action = this.getAttribute("data-action");
      handleViewAction(action);
    });
  });

  var reportForm = qs("#reportForm", root);
  if (reportForm) {
    reportForm.addEventListener("submit", handleReportSubmit);
  }

  qsa(".setting-range", root).forEach(function (input) {
    input.addEventListener("input", function () {
      var key = this.getAttribute("data-setting");
      var val = parseInt(this.value, 10);
      if (key && state.thresholds.hasOwnProperty(key)) {
        state.thresholds[key] = val;
        saveState();
        var label = this.nextElementSibling;
        if (label) {
          if (key === "rainfall") label.textContent = val + "mm";
          else label.textContent = val + "/100";
        }
      }
    });
  });
}

function handleViewAction(action) {
  switch (action) {
    case "view-alerts":
      setView("alerts");
      break;
    case "center-me":
      if (state.userLocation && leafletMap) {
        leafletMap.setView([state.userLocation.lat, state.userLocation.lon], 12);
      } else {
        toast("Location not available", "warning");
      }
      break;
    case "center-ner":
      if (leafletMap) {
        var loc = districtLocation();
        leafletMap.setView([loc.lat, loc.lon], 7);
      }
      break;
    case "refresh-map":
      if (leafletMap) updateMapMarkers();
      toast("Map refreshed");
      break;
    case "mark-all-read":
      state.notifications.forEach(function (n) { n.read = true; });
      storage.set("ner:notifications", state.notifications);
      updateAlertBadge();
      render();
      toast("All marked as read");
      break;
    case "clear-alerts":
      state.notifications = [];
      storage.set("ner:notifications", []);
      updateAlertBadge();
      render();
      toast("Alerts cleared");
      break;
    case "use-gps":
      fillLocationFromGPS();
      break;
    case "toggle-offline":
      state.offline = !state.offline;
      toast(state.offline ? "Offline mode enabled" : "Online mode restored");
      render();
      break;
    case "sync-reports":
      syncReports();
      break;
    case "toggle-emergency":
      state.emergency = !state.emergency;
      saveState();
      toast(state.emergency ? "Emergency mode ACTIVATED" : "Emergency mode deactivated", state.emergency ? "danger" : "success");
      render();
      break;
    case "broadcast-alert":
      broadcastAlert();
      break;
    case "logout":
      handleLogout();
      break;
  }
}

// ========== MAP INITIALIZATION ==========
function initLeafletMap(containerId) {
  var container = qs("#" + containerId);
  if (!container) return;
  if (leafletMap) {
    try { leafletMap.remove(); } catch (e) { }
    leafletMap = null;
    incidentMarkers = {};
    userMarker = null;
    floodCircles = [];
    riskCircles = [];
  }

  var userLoc = state.userLocation;
  var center = userLoc ? [userLoc.lat, userLoc.lon] : [districtLocation().lat, districtLocation().lon];
  var zoom = userLoc ? 11 : 7;

  leafletMap = L.map(containerId, { zoomControl: true }).setView(center, zoom);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18
  }).addTo(leafletMap);

  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: '&copy; Esri',
    maxZoom: 18,
    opacity: 0.3
  }).addTo(leafletMap);

  if (state.userLocation) updateUserLocationMarker();

  var searchBox = qs("#mapSearchInput");
  if (searchBox) {
    searchBox.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        var query = searchBox.value.trim();
        if (!query) return;
        toast("Searching...");
        fetch("https://nominatim.openstreetmap.org/search?format=json&q=" + encodeURIComponent(query) + "&limit=5")
          .then(function (r) { return r.json(); })
          .then(function (results) {
            if (results.length > 0) {
              var lat = parseFloat(results[0].lat);
              var lon = parseFloat(results[0].lon);
              leafletMap.setView([lat, lon], 13);
              L.marker([lat, lon]).addTo(leafletMap).bindPopup("<strong>" + results[0].display_name + "</strong>").openPopup();
              toast("Found: " + results[0].display_name.split(",")[0]);
            } else {
              toast("Place not found", "warning");
            }
          })
          .catch(function () { toast("Search failed", "warning"); });
      }
    });
  }

  updateMapMarkers();
  setTimeout(function () { if (leafletMap) leafletMap.invalidateSize(); }, 200);
}

function updateUserLocationMarker() {
  if (!leafletMap || !state.userLocation) return;
  var lat = state.userLocation.lat;
  var lon = state.userLocation.lon;

  if (userMarker) leafletMap.removeLayer(userMarker);

  var icon = L.divIcon({
    className: "",
    html: '<div style="width:20px;height:20px;border-radius:50%;background:#3b82f6;border:3px solid #fff;box-shadow:0 0 12px rgba(59,130,246,0.6);animation:pulse 2s infinite"></div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });

  userMarker = L.marker([lat, lon], { icon: icon }).addTo(leafletMap);
  userMarker.bindPopup("<strong>You are here</strong>");
}

function updateMapMarkers() {
  if (!leafletMap) return;

  Object.values(incidentMarkers).forEach(function (m) { leafletMap.removeLayer(m); });
  incidentMarkers = {};
  floodCircles.forEach(function (c) { leafletMap.removeLayer(c); });
  floodCircles = [];
  riskCircles.forEach(function (c) { leafletMap.removeLayer(c); });
  riskCircles = [];

  if (state.layers.incidents) {
    state.incidents.filter(function (i) { return i.status !== "RESOLVED"; }).forEach(function (inc) {
      var lat = inc.lat || (inc.location && inc.location.lat) || 23.727;
      var lon = inc.lon || (inc.location && inc.location.lon) || 92.717;
      var sevColor = {
        Critical: "#D92D20",
        High: "#F97316",
        Medium: "#F59E0B",
        Moderate: "#F59E0B",
        Low: "#2E8B57"
      }[inc.severity] || "#F97316";

      var icon = L.divIcon({
        className: "",
        html: '<div style="width:30px;height:30px;border-radius:50%;background:' + sevColor + ';border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:grid;place-items:center;color:#fff;font-size:13px;font-weight:900">!</div>',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });

      var marker = L.marker([lat, lon], { icon: icon }).addTo(leafletMap);
      marker.bindPopup(
        '<div style="min-width:180px">' +
        '<strong>' + escapeHtml(inc.type) + '</strong> ' + riskBadge(inc.risk_score || 0) +
        '<br><small style="color:#666">' + escapeHtml(inc.severity) + ' | ' + escapeHtml(inc.status) + '</small>' +
        '<br><small>' + escapeHtml(inc.description || "") + '</small>' +
        '</div>'
      );
      incidentMarkers[inc.id || inc.type] = marker;
    });
  }

  if (state.layers.flood) {
    var floodAreas = [
      { lat: 24.0, lon: 92.5, r: 40000 },
      { lat: 25.5, lon: 91.8, r: 30000 },
      { lat: 23.7, lon: 92.7, r: 25000 }
    ];
    floodAreas.forEach(function (a) {
      var c = L.circle([a.lat, a.lon], {
        radius: a.r,
        color: "#3b82f6",
        fillColor: "#3b82f6",
        fillOpacity: 0.08,
        weight: 1,
        dashArray: "5 5"
      }).addTo(leafletMap);
      floodCircles.push(c);
    });
  }

  if (state.layers.risk) {
    var riskAreas = [
      { lat: 24.5, lon: 93.0, r: 35000, color: "#D92D20" },
      { lat: 23.9, lon: 92.0, r: 28000, color: "#F59E0B" }
    ];
    riskAreas.forEach(function (a) {
      var c = L.circle([a.lat, a.lon], {
        radius: a.r,
        color: a.color,
        fillColor: a.color,
        fillOpacity: 0.06,
        weight: 1,
        dashArray: "5 5"
      }).addTo(leafletMap);
      riskCircles.push(c);
    });
  }
}

// ========== WEATHER DATA ==========
function refreshWeather(lat, lon) {
  return apiGet("/api/weather?lat=" + lat + "&lon=" + lon)
    .then(function (w) {
      if (w.source === "open-meteo") {
        state.weather.source = "open-meteo";
        state.weather.location = w.location || state.district;
        state.weather.temperature = Math.round(Number(w.temperature ?? state.weather.temperature));
        state.weather.humidity = Math.round(Number(w.humidity ?? state.weather.humidity));
        state.weather.rainfall = Math.round(Number(w.rainfall ?? state.weather.rainfall));
        state.weather.wind = Math.round(Number(w.wind_speed ?? w.wind ?? state.weather.wind));
        state.weather.rainProbability = Math.round(Number(w.precipitation_probability ?? state.weather.rainProbability));
        state.weather.warning = w.warning || state.weather.warning;
        if (w.hourly && w.hourly.length) {
          state.weather.hourly = w.hourly.map(function (h) {
            return { hour: String(h.hour).padStart(2, "0"), rain: Math.round(Number(h.rain || 0)) };
          });
        }
      }
      storage.set("ner:weather", state.weather);
    })
    .catch(function () { });
}

// ========== FLOOD DATA ==========
function refreshFlood(lat, lon) {
  return apiGet("/api/flood?lat=" + lat + "&lon=" + lon)
    .then(function (f) {
      if (f.source === "open-meteo-flood" || f.risk_score !== undefined) {
        state.weather.floodIndex = Math.round(Number(f.risk_score ?? state.weather.floodIndex));
      }
    })
    .catch(function () { });
}

// ========== INCIDENTS ==========
function refreshIncidents() {
  return apiGet("/api/incidents")
    .then(function (data) {
      state.incidents = (data.items || []).map(function (i) { return Object.assign({}, i); });
    })
    .catch(function () { });
}

// ========== FIELD REPORTS ==========
function handleReportSubmit(e) {
  e.preventDefault();
  var form = e.currentTarget;
  var formData = new FormData(form);
  var locationStr = formData.get("location") || "23.72710, 92.71760";
  var parts = locationStr.split(",").map(Number);
  var lat = parts[0] || 23.7271;
  var lon = parts[1] || 92.7176;
  var item = {
    type: formData.get("type"),
    severity: formData.get("severity"),
    description: formData.get("description"),
    lat: lat,
    lon: lon,
    location: { lat: lat, lon: lon },
    district: state.district
  };

  if (state.offline) {
    state.queuedReports.unshift(Object.assign({}, item, { location: lat + ", " + lon, createdAt: new Date().toLocaleTimeString() }));
    storage.set("ner:queuedReports", state.queuedReports);
    toast("Saved locally (offline mode)", "warning");
    form.reset();
    render();
    return;
  }

  apiPost("/api/reports", item)
    .then(function (resp) {
      state.incidents.unshift(Object.assign({}, item, {
        id: resp.id,
        status: "REPORTED",
        risk_score: resp.risk ? resp.risk.score : 0,
        created_at: resp.created_at
      }));
      addNotification(
        "Report: " + item.type,
        item.severity + ". Risk: " + (resp.risk ? resp.risk.classification : "analyzing"),
        item.severity ? item.severity.toLowerCase() : "moderate",
        "Citizen Report"
      );
      toast("Report submitted. Risk: " + (resp.risk ? resp.risk.classification : "analyzing"));
      form.reset();
      render();
    })
    .catch(function (err) {
      state.queuedReports.unshift(Object.assign({}, item, { location: lat + ", " + lon, createdAt: new Date().toLocaleTimeString() }));
      storage.set("ner:queuedReports", state.queuedReports);
      toast("Saved locally: " + err.message, "warning");
      form.reset();
      render();
    });
}

function syncReports() {
  if (!state.queuedReports.length) { toast("Nothing to sync"); return; }
  var synced = 0;
  var total = state.queuedReports.length;

  function syncNext() {
    if (synced >= total) {
      state.queuedReports = [];
      state.offline = false;
      storage.set("ner:queuedReports", []);
      toast(synced + " of " + total + " synced");
      render();
      return;
    }
    var item = state.queuedReports[synced];
    var parts = (item.location || "23.7271, 92.7176").split(",").map(Number);
    var payload = Object.assign({}, item, { location: { lat: parts[0], lon: parts[1] } });

    apiPost("/api/reports", payload)
      .then(function () { synced++; syncNext(); })
      .catch(function () { synced++; syncNext(); });
  }
  syncNext();
}

function fillLocationFromGPS() {
  var input = qs('input[name="location"]');
  if (!input) return;
  if (state.userLocation) {
    input.value = state.userLocation.lat.toFixed(5) + ", " + state.userLocation.lon.toFixed(5);
    toast("GPS location set");
  } else if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      function (p) {
        input.value = p.coords.latitude.toFixed(5) + ", " + p.coords.longitude.toFixed(5);
        toast("GPS location set");
      },
      function () { input.value = "23.72710, 92.71760"; toast("Using default location", "warning"); },
      { timeout: 5000 }
    );
  } else {
    input.value = "23.72710, 92.71760";
    toast("Geolocation not available", "warning");
  }
}

function broadcastAlert() {
  var score = computeRisk();
  var classification = classifyRisk(score);
  apiPost("/api/alerts/broadcast", {
    title: "NER Alert Broadcast",
    message: "Risk: " + riskLabel(score) + " (" + score + "/100). " + (state.lastAIAnalysis ? state.lastAIAnalysis.recommendation : ""),
    severity: classification.toUpperCase()
  })
    .then(function (resp) {
      addNotification("Alert Broadcast", "Risk " + riskLabel(score) + " broadcast.", classification, "System");
      toast(resp.sent ? "Sent to " + resp.sent + " recipients" : "Alert broadcast sent");
    })
    .catch(function (err) {
      toast("Broadcast failed: " + err.message, "warning");
    });
}

// ========== WEBSOCKET ==========
function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  var wsUrl = appConfig.apiBaseUrl.replace("http", "ws") + "/ws";
  try {
    ws = new WebSocket(wsUrl);
    ws.onopen = function () {
      console.log("WebSocket connected");
      updateSidebarHealth(true);
    };
    ws.onmessage = function (event) {
      try {
        var msg = JSON.parse(event.data);
        if (msg.type === "incident_created") {
          var inc = msg.data;
          state.incidents.unshift(inc);
          addNotification("Incident: " + (inc.type || inc.id), inc.description || "New incident reported", inc.severity || "medium", "Citizen Report");
          toast("New incident: " + (inc.type || inc.id));
          if (leafletMap) updateMapMarkers();
          render();
        } else if (msg.type === "incident_updated") {
          var upd = msg.data;
          var idx = state.incidents.findIndex(function (i) { return i.id === upd.id; });
          if (idx >= 0) state.incidents[idx] = Object.assign({}, state.incidents[idx], upd);
          else state.incidents.unshift(upd);
          addNotification("Incident Updated", upd.type + " status: " + upd.status, upd.severity || "moderate", "System");
          if (leafletMap) updateMapMarkers();
          render();
        } else if (msg.type === "alert") {
          var alertData = msg.data;
          addNotification("Alert: " + alertData.title, alertData.message, alertData.severity || "high", "System");
          toast("ALERT: " + alertData.title, "danger");
          render();
        } else if (msg.type === "weather_update") {
          var wData = msg.data;
          if (wData.temperature !== undefined) state.weather.temperature = Math.round(Number(wData.temperature));
          if (wData.rainfall !== undefined) state.weather.rainfall = Math.round(Number(wData.rainfall));
          if (wData.wind !== undefined) state.weather.wind = Math.round(Number(wData.wind));
          if (wData.humidity !== undefined) state.weather.humidity = Math.round(Number(wData.humidity));
          render();
        }
      } catch (e) { }
    };
    ws.onclose = function () {
      console.log("WebSocket disconnected");
      updateSidebarHealth(false);
      wsReconnectTimer = setTimeout(connectWebSocket, 5000);
    };
    ws.onerror = function () { };
  } catch (e) { }
}

function updateSidebarHealth(connected) {
  var wsHealth = qs("#healthWs");
  if (wsHealth) {
    wsHealth.textContent = connected ? "Connected" : "Disconnected";
    var dot = wsHealth.previousElementSibling;
    if (dot) {
      dot.className = "sidebar-health-dot " + (connected ? "healthy" : "");
    }
  }
}

// ========== REFRESH ALL DATA ==========
function refreshAllData() {
  var loc = state.userLocation || districtLocation();

  apiGet("/api/health")
    .then(function (health) {
      state.backendOnline = true;
      var apiHealth = qs("#healthApi");
      if (apiHealth) { apiHealth.textContent = "Online"; }
    })
    .catch(function () {
      state.backendOnline = false;
      var apiHealth = qs("#healthApi");
      if (apiHealth) { apiHealth.textContent = "Offline"; }
    });

  refreshWeather(loc.lat, loc.lon).then(function () {
    var wHealth = qs("#healthWeather");
    if (wHealth) wHealth.textContent = state.weather.source === "open-meteo" ? "Live" : "Demo";
    runAIAnalysis();
    render();
  });

  refreshFlood(loc.lat, loc.lon).then(function () { render(); });

  apiGet("/api/satellite/latest?lat=" + loc.lat + "&lon=" + loc.lon + "&days=30")
    .then(function (sat) {
      var satHealth = qs("#healthSat");
      if (satHealth) satHealth.textContent = "Synced";
    })
    .catch(function () { });

  refreshIncidents().then(function () {
    runAIAnalysis();
    render();
  });
}

// ========== AI RISK ANALYSIS ENGINE ==========
function runAIAnalysis() {
  var score = computeRisk();
  var classification = classifyRisk(score);
  var prev = state.previousRiskScore;
  var rising = score > prev + 5;
  var falling = score < prev - 5;

  var factors = riskFactors();
  var topFactors = factors.slice().sort(function (a, b) { return b.value - a.value; }).slice(0, 3);

  var recommendation = "";
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

  var analysis = {
    score: score,
    classification: classification,
    rising: rising,
    falling: falling,
    timestamp: new Date().toISOString(),
    topFactors: topFactors.map(function (f) { return f.label + ": " + f.value + "/100"; }),
    recommendation: recommendation,
    weatherSummary: state.weather.temperature + "C, " + state.weather.rainfall + "mm rain, " + state.weather.wind + "km/h wind",
    floodSummary: "Flood index: " + state.weather.floodIndex + "/100"
  };

  state.lastAIAnalysis = analysis;
  state.previousRiskScore = score;

  if (rising && score >= state.thresholds.elevated) {
    addNotification("Risk Rising: " + riskLabel(score), "AI detected increasing risk (" + prev + " -> " + score + "). " + recommendation, classification === "critical" ? "critical" : "high", "AI Engine");
    toast("ALERT: Risk rising to " + riskLabel(score) + "!", "danger");
  }

  if (classification === "critical" && prev < state.thresholds.critical) {
    addNotification("CRITICAL: Immediate Danger", "Disaster risk score reached CRITICAL (" + score + "/100). " + recommendation, "critical", "AI Engine");
    toast("CRITICAL ALERT: Immediate danger!", "danger");
  }

  if (falling && prev >= state.thresholds.high && score < state.thresholds.high) {
    addNotification("Risk Decreasing", "Risk dropped from " + riskLabel(prev) + " to " + riskLabel(score) + ".", "moderate", "AI Engine");
  }

  var w = state.weather;
  if (w.rainfall > state.thresholds.rainfall && w.floodIndex > state.thresholds.flood) {
    var key = "heavy_rain_flood";
    if (!state.notifications.some(function (n) { return n._key === key && Date.now() - new Date(n.time).getTime() < 3600000; })) {
      var notif = addNotification("Heavy Rain + High Flood Risk", "Rainfall " + w.rainfall + "mm + flood index " + w.floodIndex + ". Flash flood possible.", "high", "Weather AI");
      notif._key = key;
    }
  }

  if (w.wind > 50) {
    var windKey = "high_wind";
    if (!state.notifications.some(function (n) { return n._key === windKey && Date.now() - new Date(n.time).getTime() < 3600000; })) {
      var windNotif = addNotification("High Wind Warning", "Wind " + w.wind + " km/h. Structural damage risk.", "high", "Weather AI");
      windNotif._key = windKey;
    }
  }
}

// ========== AUTO REFRESH ==========
function startAutoRefresh() {
  if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = setInterval(function () {
    if (!state.offline && state.user) {
      refreshAllData();
    }
  }, 300000);
}

// ========== GLOBAL SEARCH ==========
function handleGlobalSearch(query) {
  if (!query || query.length < 2) return;
  var q = query.toLowerCase();

  var matchedIncidents = state.incidents.filter(function (i) {
    return (i.type && i.type.toLowerCase().indexOf(q) !== -1) ||
      (i.description && i.description.toLowerCase().indexOf(q) !== -1) ||
      (i.severity && i.severity.toLowerCase().indexOf(q) !== -1);
  });

  var matchedDistricts = Object.keys(districtCoordinates).filter(function (d) {
    return d.toLowerCase().indexOf(q) !== -1;
  });

  if (matchedIncidents.length > 0) {
    toast("Found " + matchedIncidents.length + " incident(s)");
  } else if (matchedDistricts.length > 0) {
    state.district = matchedDistricts[0];
    var loc = districtCoordinates[matchedDistricts[0]];
    if (leafletMap && loc) leafletMap.setView([loc.lat, loc.lon], 10);
    toast("Navigating to " + matchedDistricts[0]);
  } else {
    toast("No results for: " + query, "warning");
  }
}

// ========== LANDING PAGE CANVAS ==========
function initDisasterCanvas() {
  var canvas = qs("#disasterCanvas");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");
  var W, H;

  function resize() {
    W = canvas.width = canvas.offsetWidth;
    H = canvas.height = canvas.offsetHeight;
  }

  resize();
  window.addEventListener("resize", resize);

  var raindrops = [];
  var clouds = [];
  var particles = [];

  for (var i = 0; i < 120; i++) {
    raindrops.push({
      x: Math.random() * 2000,
      y: Math.random() * 1200,
      len: 10 + Math.random() * 20,
      speed: 4 + Math.random() * 6,
      opacity: 0.15 + Math.random() * 0.35
    });
  }

  for (var i = 0; i < 6; i++) {
    clouds.push({
      x: Math.random() * 2000,
      y: 30 + Math.random() * 120,
      w: 100 + Math.random() * 200,
      h: 40 + Math.random() * 40,
      speed: 0.2 + Math.random() * 0.3,
      opacity: 0.3 + Math.random() * 0.4
    });
  }

  for (var i = 0; i < 40; i++) {
    particles.push({
      x: Math.random() * 2000,
      y: Math.random() * 1200,
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 1.5,
      r: 1 + Math.random() * 2,
      opacity: 0.2 + Math.random() * 0.5,
      color: Math.random() > 0.7 ? "rgba(255,119,28," : Math.random() > 0.5 ? "rgba(74,144,217," : "rgba(46,139,87,"
    });
  }

  var lightningBolts = [];
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

    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#1a1a2e");
    grad.addColorStop(0.5, "#16213e");
    grad.addColorStop(1, "#0f3460");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    particles.forEach(function (p) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = W;
      if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H;
      if (p.y > H) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.globalAlpha = p.opacity;
      ctx.fillStyle = p.color + p.opacity + ")";
      ctx.fill();
      ctx.globalAlpha = 1;
    });

    clouds.forEach(function (c) {
      c.x += c.speed;
      if (c.x > W + 200) c.x = -200;
      drawCloud(c);
    });

    ctx.strokeStyle = "rgba(180,200,230,0.4)";
    ctx.lineWidth = 1;
    raindrops.forEach(function (r) {
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

    if (t - lastLightning > 4000 + Math.random() * 8000) {
      lastLightning = t;
      var lx = W * 0.3 + Math.random() * W * 0.4;
      lightningBolts.push({
        x: lx,
        y: 0,
        endX: lx + (Math.random() - 0.5) * 100,
        endY: H * 0.5 + Math.random() * H * 0.3,
        depth: 4 + Math.floor(Math.random() * 2),
        born: t
      });
      flashOpacity = 0.15;
    }
    lightningBolts.forEach(function (b) {
      drawLightning(b.x, b.y, b.endX, b.endY, b.depth);
    });
    lightningBolts = lightningBolts.filter(function (b) { return t - b.born < 200; });

    if (flashOpacity > 0) {
      ctx.fillStyle = "rgba(255,255,255," + flashOpacity + ")";
      ctx.fillRect(0, 0, W, H);
      flashOpacity -= 0.005;
    }

    drawWave(t);

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
}

// ========== COUNTER ANIMATION ==========
function initCounterAnimation() {
  window.addEventListener("scroll", function () {
    qsa(".lp-stat-num[data-target]").forEach(function (el) {
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
}

// ========== INIT ==========
function init() {
  window.addEventListener("ner:auth", function (e) {
    var fbUser = e.detail && e.detail.user;
    if (fbUser) {
      var user = {
        uid: fbUser.uid,
        email: fbUser.email,
        name: fbUser.name || fbUser.displayName || fbUser.email,
        role: "district_officer",
        district: "Aizawl",
        photoURL: fbUser.photoURL || ""
      };
      onSignInSuccess(user);
    }
  });

  window.addEventListener("ner:toast", function (e) {
    if (e.detail && e.detail.message) toast(e.detail.message);
  });

  initDisasterCanvas();
  initCounterAnimation();

  var googleBtn = qs("#googleLoginBtn");
  if (googleBtn) {
    googleBtn.addEventListener("click", function () {
      handleGoogleSignIn();
    });
  }

  var signInBackLink = qs(".signin-back-home");
  if (signInBackLink) {
    signInBackLink.addEventListener("click", function (e) {
      e.preventDefault();
      showLanding();
    });
  }

  var topbarLogout = qs("#topbarLogoutBtn");
  if (topbarLogout) {
    topbarLogout.addEventListener("click", function () {
      handleLogout();
    });
  }

  var topbarSearch = qs("#topbarSearch");
  if (topbarSearch) {
    topbarSearch.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        handleGlobalSearch(this.value);
      }
    });
  }

  var topbarEnableAlerts = qs("#topbarEnableAlerts");
  if (topbarEnableAlerts) {
    topbarEnableAlerts.addEventListener("click", function () {
      if ("Notification" in window) {
        Notification.requestPermission().then(function (perm) {
          if (perm === "granted") {
            toast("Browser notifications enabled");
          } else {
            toast("Notifications permission denied", "warning");
          }
        });
      }
    });
  }

  attachNavHandlers();

  window.addEventListener("hashchange", function () {
    var n = (location.hash || "#dashboard").replace("#", "");
    if (n && n !== state.view && viewTitles[n]) {
      setView(n);
    }
  });

  var isLoggedIn = initApp();

  if (isLoggedIn) {
    render();
    refreshAllData();
    connectWebSocket();
    watchUserLocation();
    startAutoRefresh();
  }

  window.addEventListener("keydown", function (e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
    var keyMap = { d: "dashboard", m: "map", w: "weather", a: "alerts", r: "report", e: "emergency" };
    var view = keyMap[e.key.toLowerCase()];
    if (view) {
      e.preventDefault();
      setView(view);
    }
  });
}

init();
