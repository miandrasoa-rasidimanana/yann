'use strict';

/* ── State ── */
const state = {
  screen: 'home',
  step: 0,
  hist: [],
  checks: {},
  geo: { status: 'idle', lat: null, lon: null, acc: null, addr: null },
  nearby: [],
  nearbyStatus: 'idle',
};

const QUESTIONS = [
  'La personne vous répond-elle ?',
  'Respire-t-elle difficilement ?',
  'Confusion, incohérence, vomissements ?',
  'Son état s\'aggrave t-il rapidement ?',
];

// Illustration associée à chaque question (null = pas d'image)
const QUESTION_ICONS = [
  'icones/inconsciente.svg',
  'icones/2.svg',
  'icones/3.svg',
  'icones/5.svg',
];

/* ── Navigation ── */
function go(screen) {
  if (screen === state.screen) return;
  state.hist.push(state.screen);
  state.screen = screen;
  render();
  if (screen === 'urgence') locateUser('urgence');
  if (screen === 'aide')    locateUser('aide');
}

function back() {
  if (state.screen === 'eval' && state.step > 0) { state.step--; renderEval(); return; }
  const prev = state.hist.pop();
  if (!prev) return;
  state.screen = prev;
  // Arrêter le suivi si on quitte l'écran aide
  if (prev !== 'aide') stopWatch();
  render();
}

/* ── Decision tree ── */
function answerYes() {
  state.hist.push(state.screen);
  state.screen = 'urgence';
  render();
  locateUser('urgence');
}

function answerNo() {
  if (state.step >= QUESTIONS.length - 1) {
    state.hist.push(state.screen);
    state.screen = 'aide';
    render();
    locateUser('aide');
    document.getElementById('popup-fin').classList.remove('hidden');
  } else {
    state.step++;
    renderEval();
  }
}

function closeFinPopup() {
  document.getElementById('popup-fin').classList.add('hidden');
}

function startEval() { state.step = 0; go('eval'); }

/* ── Checklist ── */
function toggle(id) {
  state.checks[id] = !state.checks[id];
  const el = document.querySelector(`[data-check="${id}"]`);
  if (!el) return;
  el.classList.toggle('checked', !!state.checks[id]);
  el.querySelector('.check-box').textContent = state.checks[id] ? '✓' : '';
}

/* ══════════════════════════════════════════════
   GÉOLOCALISATION
══════════════════════════════════════════════ */
let maps       = { urgence: null, aide: null };
let meMarker   = null;   // marqueur "vous" sur la carte aide (mis à jour par watchPosition)
let watchId    = null;   // navigator.geolocation.watchPosition handle

function locateUser(target) {
  target = target || 'urgence';
  if (!('geolocation' in navigator)) {
    state.geo.status = 'error';
    renderGeoFor(target);
    return;
  }
  state.geo.status = 'loading';
  renderGeoFor(target);

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      state.geo.lat = pos.coords.latitude;
      state.geo.lon = pos.coords.longitude;
      state.geo.acc = Math.round(pos.coords.accuracy);
      state.geo.status = 'ok';
      renderGeoFor(target);

      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${state.geo.lat}&lon=${state.geo.lon}&zoom=18`,
          { headers: { Accept: 'application/json' } }
        );
        const d = await r.json();
        state.geo.addr = d.display_name || null;
        renderGeoFor(target);
      } catch (_) {}

      if (target === 'aide') fetchNearby(state.geo.lat, state.geo.lon);
    },
    () => { state.geo.status = 'error'; renderGeoFor(target); },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

/* ── watchPosition : suivi en temps réel pendant la marche ── */
function startWatch() {
  if (watchId !== null || !('geolocation' in navigator)) return;
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      // Mettre à jour le marqueur "vous" sur la carte
      if (meMarker) meMarker.setLatLng([lat, lon]);
      // Mettre à jour la distance restante dans le panneau
      if (activeRouteIndex !== null && state.nearby[activeRouteIndex]) {
        const poi = state.nearby[activeRouteIndex];
        const remaining = haversine(lat, lon, poi.lat, poi.lon);
        updateRemainingDist(remaining);
        // Destination atteinte (< 20 m)
        if (remaining < 20) onArrived();
      }
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 3000 }
  );
}

function stopWatch() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function updateRemainingDist(meters) {
  const el = document.getElementById('route-remaining');
  if (!el) return;
  const dist = meters >= 1000 ? (meters / 1000).toFixed(1) + ' km' : meters + ' m';
  const minLeft = Math.ceil(meters / 83); // ~5 km/h → 83 m/min
  el.textContent = `🚶 ~${minLeft} min restantes · ${dist}`;
}

function onArrived() {
  stopWatch();
  const panel = document.getElementById('route-panel');
  if (panel) {
    panel.innerHTML = `
      <div class="route-panel route-panel--arrived">
        <span class="route-panel__icon">✅</span>
        <div class="route-panel__body">
          <div class="route-panel__name">Vous êtes arrivé !</div>
          <div class="route-panel__meta">Destination atteinte.</div>
        </div>
        <button class="route-panel__close" onclick="clearRoute()" aria-label="Fermer">✕</button>
      </div>`;
  }
}

/* ══════════════════════════════════════════════
   POI — OVERPASS API
══════════════════════════════════════════════ */
async function fetchNearby(lat, lon) {
  state.nearbyStatus = 'loading';
  renderNearby();
  const radius = 800;
  const query = `
    [out:json][timeout:15];
    (
      node["amenity"="drinking_water"](around:${radius},${lat},${lon});
      node["amenity"="restaurant"](around:${radius},${lat},${lon});
      node["amenity"="cafe"](around:${radius},${lat},${lon});
      node["amenity"="fast_food"](around:${radius},${lat},${lon});
      node["amenity"="bar"](around:${radius},${lat},${lon});
    );
    out body;
  `;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', body: 'data=' + encodeURIComponent(query),
    });
    const json = await res.json();
    state.nearby = (json.elements || [])
      .map(el => ({
        id: el.id, lat: el.lat, lon: el.lon,
        name: el.tags?.name || labelAmenity(el.tags?.amenity),
        amenity: el.tags?.amenity,
        dist: haversine(lat, lon, el.lat, el.lon),
      }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 8);
    state.nearbyStatus = 'ok';
  } catch (_) {
    state.nearbyStatus = 'error';
  }
  renderNearby();
  addPoiMarkers();
}

function labelAmenity(type) {
  return { drinking_water: 'Fontaine d\'eau', restaurant: 'Restaurant', cafe: 'Café', fast_food: 'Restauration rapide', bar: 'Bar' }[type] || 'Point d\'intérêt';
}
function iconAmenity(type) {
  return { drinking_water: '💧', restaurant: '🍽️', cafe: '☕', fast_food: '🥙', bar: '🍹' }[type] || '📍';
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/* ── Marqueurs POI ── */
let poiMarkers = [];

function addPoiMarkers() {
  const map = maps.aide;
  if (!map || !state.nearby.length) return;
  poiMarkers.forEach(m => m.remove());
  poiMarkers = [];
  const yannIcon = L.icon({
    iconUrl: 'Yann_hipo_logo.svg',
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -20],
  });
  state.nearby.forEach((poi, index) => {
    const marker = L.marker([poi.lat, poi.lon], { icon: yannIcon })
      .addTo(map)
      .bindPopup(`<strong>${poi.name}</strong><br>${poi.dist} m`)
      .on('click', () => showRoute(index));
    poiMarkers.push(marker);
  });
}

/* ══════════════════════════════════════════════
   ITINÉRAIRE — OSRM + watchPosition
══════════════════════════════════════════════ */
let activeRouteLine  = null;
let activeRouteIndex = null;

async function showRoute(poiIndex) {
  const poi = state.nearby[poiIndex];
  const map = maps.aide;
  if (!poi || !map || !state.geo.lat) return;

  activeRouteIndex = poiIndex;
  renderRoutePanel({ status: 'loading', poi });
  if (activeRouteLine) { activeRouteLine.remove(); activeRouteLine = null; }

  try {
    const url = `https://router.project-osrm.org/route/v1/foot/${state.geo.lon},${state.geo.lat};${poi.lon},${poi.lat}?overview=full&geometries=geojson`;
    const data = await fetch(url).then(r => r.json());
    if (data.code !== 'Ok' || !data.routes.length) throw new Error();

    const route   = data.routes[0];
    const coords  = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    const distM   = Math.round(route.distance);
    const minWalk = Math.ceil(route.duration / 60);

    activeRouteLine = L.polyline(coords, {
      color: '#7742FE', weight: 5, opacity: 0.85, lineJoin: 'round',
    }).addTo(map);
    map.fitBounds(activeRouteLine.getBounds(), { padding: [24, 24] });

    renderRoutePanel({ status: 'ok', poi, distM, minWalk, poiIndex });
    startWatch(); // démarrer le suivi GPS en marchant
  } catch (_) {
    renderRoutePanel({ status: 'error', poi });
  }
}

function clearRoute() {
  stopWatch();
  activeRouteIndex = null;
  if (activeRouteLine) { activeRouteLine.remove(); activeRouteLine = null; }
  const panel = document.getElementById('route-panel');
  if (panel) panel.innerHTML = '';
  if (maps.aide && state.geo.lat) maps.aide.setView([state.geo.lat, state.geo.lon], 15);
}

/* ── Deep link navigation native (iOS / Android / desktop) ── */
function launchNavigation(toLat, toLon) {
  const from = state.geo;
  const isIOS     = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isAndroid = /Android/.test(navigator.userAgent);

  if (isIOS) {
    // Apple Maps avec mode marche et origine pré-remplie
    window.location.href = `maps://?saddr=${from.lat},${from.lon}&daddr=${toLat},${toLon}&dirflg=w`;
    // Fallback Google Maps après 1.5s si Apple Maps ne s'ouvre pas
    setTimeout(() => {
      window.open(`https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lon}&destination=${toLat},${toLon}&travelmode=walking`);
    }, 1500);
  } else if (isAndroid) {
    // Intent Google Maps navigation directe
    window.location.href = `google.navigation:q=${toLat},${toLon}&mode=w`;
    setTimeout(() => {
      window.open(`https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lon}&destination=${toLat},${toLon}&travelmode=walking`);
    }, 1500);
  } else {
    // Desktop : Google Maps directions
    window.open(`https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lon}&destination=${toLat},${toLon}&travelmode=walking`);
  }
}

function renderRoutePanel({ status, poi, distM, minWalk }) {
  const panel = document.getElementById('route-panel');
  if (!panel) return;

  if (status === 'loading') {
    panel.innerHTML = `
      <div class="route-panel route-panel--loading">
        <span class="spinner spinner--sm"></span>
        <span>Calcul de l'itinéraire vers <strong>${poi.name}</strong>…</span>
      </div>`;
    return;
  }
  if (status === 'error') {
    panel.innerHTML = `
      <div class="route-panel route-panel--error">
        <span>Itinéraire indisponible.</span>
        <button class="route-panel__close" onclick="clearRoute()">✕</button>
      </div>`;
    return;
  }

  const dist = distM >= 1000 ? (distM / 1000).toFixed(1) + ' km' : distM + ' m';

  panel.innerHTML = `
    <div class="route-panel">
      <img class="route-panel__icon" src="Yann_hipo_logo.svg" alt="">
      <div class="route-panel__body">
        <div class="route-panel__name">${poi.name}</div>
        <div class="route-panel__meta" id="route-remaining">🚶 ${minWalk} min · ${dist}</div>
      </div>
      <button class="route-panel__launch" onclick="launchNavigation(${poi.lat},${poi.lon})" title="Lancer la navigation GPS">
        <span>▶</span><span class="route-panel__launch-lbl">Naviguer</span>
      </button>
      <button class="route-panel__close" onclick="clearRoute()" aria-label="Fermer">✕</button>
    </div>`;
}

/* ══════════════════════════════════════════════
   RENDU CARTE
══════════════════════════════════════════════ */
function renderGeoFor(target) {
  const wrap = document.getElementById(target === 'aide' ? 'geo-wrap-aide' : 'geo-wrap');
  if (!wrap) return;

  // Urgence : adresse seule, sans carte
  if (target === 'urgence') {
    if (state.geo.status === 'loading') {
      wrap.innerHTML = '<div class="urg-addr-inner urg-addr-loading"><span class="spinner spinner--sm"></span><span>Localisation en cours…</span></div>';
      return;
    }
    if (state.geo.status === 'error') {
      wrap.innerHTML = `<div class="urg-addr-inner">
        <div class="urg-addr-chip">Localisation</div>
        <div class="urg-addr-row">
          <span class="urg-addr-pin">&#9888;</span>
          <div>
            <div class="urg-addr-label">Position indisponible</div>
            <div class="urg-addr-text">Donnez votre adresse et des repères aux secours</div>
          </div>
        </div>
        <button class="btn btn--primary btn--sm" onclick="locateUser('urgence')">Réessayer</button>
      </div>`;
      return;
    }
    if (state.geo.status === 'ok' && state.geo.lat) {
      const addrLine = state.geo.addr || (state.geo.lat.toFixed(5) + ', ' + state.geo.lon.toFixed(5));
      wrap.innerHTML = `<div class="urg-addr-inner">
        <div class="urg-addr-chip">Localisation</div>
        <div class="urg-addr-row">
          <span class="urg-addr-pin">&#128205;</span>
          <div>
            <div class="urg-addr-label">Votre adresse en temps réel</div>
            <div class="urg-addr-text">${addrLine}</div>
          </div>
        </div>
      </div>`;
      return;
    }
    wrap.innerHTML = '<div class="urg-addr-inner urg-addr-loading"><span class="spinner spinner--sm"></span><span>Détection en cours…</span></div>';
    return;
  }

  // Aide : carte Leaflet + liste POI
  if (state.geo.status === 'loading') {
    wrap.innerHTML = '<div class="geo-state"><span class="spinner"></span><p>Localisation en cours…</p></div>';
    return;
  }
  if (state.geo.status === 'error') {
    wrap.innerHTML = `<div class="geo-state">
      <p>Activez la localisation pour afficher les points à proximité.</p>
      <button class="btn btn--green btn--sm" onclick="locateUser('aide')">Réessayer</button>
    </div>`;
    return;
  }
  if (state.geo.status === 'ok' && state.geo.lat) {
    wrap.innerHTML = '<div class="geo-card__map" id="leaflet-map-aide"></div>';
    initLeafletFor('aide');
    return;
  }
  wrap.innerHTML = `<div class="geo-state">
    <p>Trouvez de l'eau et des lieux frais à proximité.</p>
    <button class="btn btn--green btn--sm" onclick="locateUser('aide')">Voir les points à proximité</button>
  </div>`;
}
function initLeafletFor(target) {
  if (typeof L === 'undefined') return;
  const el = document.getElementById(`leaflet-map-${target}`);
  if (!el) return;
  if (maps[target]) { maps[target].remove(); maps[target] = null; }

  maps[target] = L.map(el, { zoomControl: true }).setView([state.geo.lat, state.geo.lon], 15);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap',
  }).addTo(maps[target]);

  // Marqueur "vous êtes ici" — pulsant sur la carte aide
  const isPulse = target === 'aide';
  const meIcon = L.divIcon({
    className: isPulse ? 'me-pin' : 'geo-pin',
    html: isPulse ? '<span class="me-pin__dot"></span>' : '<span class="geo-pin__dot"></span>',
    iconSize: [22, 22], iconAnchor: [11, 11],
  });
  const marker = L.marker([state.geo.lat, state.geo.lon], { icon: meIcon })
    .addTo(maps[target])
    .bindPopup('Vous êtes ici');

  // Garder la référence du marqueur "moi" pour le mettre à jour avec watchPosition
  if (target === 'aide') meMarker = marker;

  setTimeout(() => maps[target] && maps[target].invalidateSize(), 80);
  if (target === 'aide' && state.nearby.length) addPoiMarkers();
}

/* ── Liste des POI ── */
function renderNearby() {
  const el = document.getElementById('nearby-list');
  if (!el) return;

  if (state.nearbyStatus === 'loading') {
    el.innerHTML = `<div class="nearby-loading"><span class="spinner spinner--sm"></span><span>Recherche des points à proximité…</span></div>`;
    return;
  }
  if (state.nearbyStatus === 'error') {
    el.innerHTML = `<p class="nearby-empty">Impossible de récupérer les points à proximité.</p>`;
    return;
  }
  if (!state.nearby.length) {
    el.innerHTML = `<p class="nearby-empty">Aucun point trouvé dans un rayon de 800 m.</p>`;
    return;
  }

  el.innerHTML = state.nearby.slice(0, 3).map((poi, index) => {
    const dist = poi.dist >= 1000 ? (poi.dist / 1000).toFixed(1) + ' km' : poi.dist + ' m';
    return `
      <button class="nearby-item" onclick="showRoute(${index})" aria-label="Itinéraire vers ${poi.name}, à ${dist}">
        <span class="nearby-icon">${iconAmenity(poi.amenity)}</span>
        <span class="nearby-body">
          <span class="nearby-name">${poi.name}</span>
          <span class="nearby-dist">${dist}</span>
        </span>
        <span class="nearby-arrow">›</span>
      </button>`;
  }).join('');
}

/* ── Share ── */
function shareHelp() {
  let text = 'Une personne a besoin d\'aide ici. Pouvez-vous venir m\'aider, apporter de l\'eau, ou appeler les secours (112) ?';
  if (state.geo.lat) {
    text += `\nPosition : https://www.google.com/maps?q=${state.geo.lat},${state.geo.lon}`;
    if (state.geo.addr) text += `\n${state.geo.addr}`;
  }
  if (navigator.share) {
    navigator.share({ title: 'YANN — Demande d\'aide', text }).catch(() => {});
  } else {
    navigator.clipboard.writeText(text).then(() => alert('Message copié !')).catch(() => alert(text));
  }
}

/* ── Filtres "Comment agir ?" ── */
function filterAgir(btn, cat) {
  document.querySelectorAll('.agir-chip').forEach(c => c.classList.remove('agir-chip--active'));
  btn.classList.add('agir-chip--active');
  document.querySelectorAll('.agir-card').forEach(card => {
    const show = cat === 'tous' || card.dataset.cat === cat;
    card.classList.toggle('agir-card--hidden', !show);
  });
}

/* ── Render ── */
function renderEval() {
  const qtxt = document.getElementById('question-text');
  const qimg = document.getElementById('question-img');

  if (qtxt) qtxt.textContent = QUESTIONS[state.step];

  if (qimg) {
    const icon = QUESTION_ICONS[state.step];
    if (icon) {
      qimg.src = icon;
      qimg.classList.remove('eval-img--hidden');
    } else {
      qimg.classList.add('eval-img--hidden');
    }
  }
}

function render() {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + state.screen);
  if (el) el.classList.add('active');
  if (state.screen === 'eval')    renderEval();
  if (state.screen === 'urgence') renderGeoFor('urgence');
  if (state.screen === 'aide')    { renderGeoFor('aide'); renderNearby(); }
  window.scrollTo(0, 0);
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
});
