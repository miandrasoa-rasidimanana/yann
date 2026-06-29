'use strict';

/* ── State ── */
const state = {
  screen: 'home',
  step: 0,
  hist: [],
  checks: {},
  geo: { status: 'idle', lat: null, lon: null, acc: null, addr: null },
  nearby: [],          // POI pour l'écran Aide
  nearbyStatus: 'idle' // idle | loading | ok | error
};

const QUESTIONS = [
  'La personne est-elle inconsciente ou ne répond pas ?',
  'Respire-t-elle difficilement, ou pas du tout ?',
  'Confusion, propos incohérents, convulsions ou vomissements ?',
  'Peau très chaude et sèche, ou température très élevée ?',
  'Son état s\'aggrave-t-il rapidement ?',
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
  if (state.screen === 'eval' && state.step > 0) {
    state.step--;
    renderEval();
    return;
  }
  const prev = state.hist.pop();
  if (!prev) return;
  state.screen = prev;
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
  } else {
    state.step++;
    renderEval();
  }
}

function startEval() {
  state.step = 0;
  go('eval');
}

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
let maps = { urgence: null, aide: null };

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

      // Reverse geocoding (Nominatim)
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${state.geo.lat}&lon=${state.geo.lon}&zoom=18`,
          { headers: { Accept: 'application/json' } }
        );
        const d = await r.json();
        state.geo.addr = d.display_name || null;
        renderGeoFor(target);
      } catch (_) {}

      // Chercher les POI uniquement en mode Aide
      if (target === 'aide') fetchNearby(state.geo.lat, state.geo.lon);
    },
    () => {
      state.geo.status = 'error';
      renderGeoFor(target);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

/* ── Overpass API : fontaines, restaurants, cafés ── */
async function fetchNearby(lat, lon) {
  state.nearbyStatus = 'loading';
  renderNearby();

  const radius = 800; // mètres
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
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
    });
    const json = await res.json();
    const elements = json.elements || [];

    // Calcul de distance + enrichissement
    state.nearby = elements
      .map(el => ({
        id: el.id,
        lat: el.lat,
        lon: el.lon,
        name: el.tags?.name || labelAmenity(el.tags?.amenity),
        amenity: el.tags?.amenity,
        dist: haversine(lat, lon, el.lat, el.lon),
      }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 8); // garder 8 pour les marqueurs, afficher 3 en liste

    state.nearbyStatus = 'ok';
  } catch (_) {
    state.nearbyStatus = 'error';
  }
  renderNearby();
  // Ajouter les marqueurs POI sur la carte Aide si elle est déjà prête
  addPoiMarkers();
}

function labelAmenity(type) {
  const labels = {
    drinking_water: 'Fontaine d\'eau',
    restaurant: 'Restaurant',
    cafe: 'Café',
    fast_food: 'Restauration rapide',
    bar: 'Bar',
  };
  return labels[type] || 'Point d\'intérêt';
}

function iconAmenity(type) {
  const icons = {
    drinking_water: '💧',
    restaurant: '🍽️',
    cafe: '☕',
    fast_food: '🥙',
    bar: '🍹',
  };
  return icons[type] || '📍';
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/* ── Marqueurs POI sur la carte Aide ── */
let poiMarkers = [];
let activeRouteLine = null;

function addPoiMarkers() {
  const map = maps.aide;
  if (!map || !state.nearby.length) return;

  // Nettoyer les anciens marqueurs
  poiMarkers.forEach(m => m.remove());
  poiMarkers = [];

  state.nearby.forEach((poi, index) => {
    const color = poi.amenity === 'drinking_water' ? '#0F8A5B' : '#7742FE';
    const icon = L.divIcon({
      className: 'poi-pin',
      html: `<span class="poi-pin__dot" style="background:${color}">${iconAmenity(poi.amenity)}</span>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    const marker = L.marker([poi.lat, poi.lon], { icon })
      .addTo(map)
      .bindPopup(`<strong>${poi.name}</strong><br>${poi.dist} m`)
      .on('click', () => showRoute(index));
    poiMarkers.push(marker);
  });
}

/* ── Itinéraire OSRM (pied) ── */
async function showRoute(poiIndex) {
  const poi = state.nearby[poiIndex];
  const map = maps.aide;
  if (!poi || !map || !state.geo.lat) return;

  // Panneau chargement
  renderRoutePanel({ status: 'loading', poi });

  // Supprimer l'ancien tracé
  if (activeRouteLine) { activeRouteLine.remove(); activeRouteLine = null; }

  try {
    const url = `https://router.project-osrm.org/route/v1/foot/${state.geo.lon},${state.geo.lat};${poi.lon},${poi.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.code !== 'Ok' || !data.routes.length) throw new Error('no route');

    const route = data.routes[0];
    const coords = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    const distM  = Math.round(route.distance);
    const minWalk = Math.ceil(route.duration / 60);

    // Tracer la polyligne
    activeRouteLine = L.polyline(coords, {
      color: '#7742FE',
      weight: 5,
      opacity: 0.85,
      lineJoin: 'round',
    }).addTo(map);

    // Zoomer pour voir tout le tracé
    map.fitBounds(activeRouteLine.getBounds(), { padding: [24, 24] });

    renderRoutePanel({ status: 'ok', poi, distM, minWalk, poiIndex });
  } catch (_) {
    renderRoutePanel({ status: 'error', poi, poiIndex });
  }
}

function clearRoute() {
  if (activeRouteLine) { activeRouteLine.remove(); activeRouteLine = null; }
  const panel = document.getElementById('route-panel');
  if (panel) panel.innerHTML = '';
  // Recentrer sur la position actuelle
  if (maps.aide && state.geo.lat) {
    maps.aide.setView([state.geo.lat, state.geo.lon], 15);
  }
}

function renderRoutePanel({ status, poi, distM, minWalk, poiIndex }) {
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
        <button class="route-panel__close" onclick="clearRoute()" aria-label="Fermer">✕</button>
      </div>`;
    return;
  }

  const dist = distM >= 1000 ? (distM / 1000).toFixed(1) + ' km' : distM + ' m';
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${poi.lat},${poi.lon}&travelmode=walking`;

  panel.innerHTML = `
    <div class="route-panel">
      <div class="route-panel__icon">${iconAmenity(poi.amenity)}</div>
      <div class="route-panel__body">
        <div class="route-panel__name">${poi.name}</div>
        <div class="route-panel__meta">🚶 ${minWalk} min · ${dist}</div>
      </div>
      <a class="route-panel__maps" href="${mapsUrl}" target="_blank" rel="noopener" title="Ouvrir dans Maps">↗</a>
      <button class="route-panel__close" onclick="clearRoute()" aria-label="Fermer l'itinéraire">✕</button>
    </div>`;
}

/* ══════════════════════════════════════════════
   RENDU CARTE
══════════════════════════════════════════════ */
function renderGeoFor(target) {
  const wrapId = target === 'aide' ? 'geo-wrap-aide' : 'geo-wrap';
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;

  if (state.geo.status === 'loading') {
    wrap.innerHTML = `<div class="geo-state"><span class="spinner"></span><p>Localisation en cours…</p></div>`;
    return;
  }
  if (state.geo.status === 'error') {
    const btnFn = `locateUser('${target}')`;
    wrap.innerHTML = `<div class="geo-state">
      <p>Position indisponible. ${target === 'urgence' ? 'Donnez votre adresse et des repères aux secours.' : 'Activez la localisation pour afficher les points à proximité.'}</p>
      <button class="btn btn--${target === 'aide' ? 'green' : 'primary'} btn--sm" onclick="${btnFn}">Réessayer</button>
    </div>`;
    return;
  }
  if (state.geo.status === 'ok' && state.geo.lat) {
    const mapElId = `leaflet-map-${target}`;
    const mapsUrl = `https://www.google.com/maps?q=${state.geo.lat},${state.geo.lon}`;
    wrap.innerHTML = `
      <div class="geo-card__map" id="${mapElId}"></div>
      <div class="geo-card__info">
        ${state.geo.addr ? `<p class="geo-card__addr">${state.geo.addr}</p>` : ''}
        <p class="geo-card__coords">${state.geo.lat.toFixed(5)}, ${state.geo.lon.toFixed(5)}${state.geo.acc ? ` · ± ${state.geo.acc} m` : ''}</p>
        <div class="geo-card__btns">
          <a class="btn btn--ghost btn--sm" href="${mapsUrl}" target="_blank" rel="noopener">Ouvrir dans Maps</a>
          <button class="btn btn--ghost btn--sm" onclick="locateUser('${target}')">Actualiser</button>
        </div>
      </div>`;
    initLeafletFor(target);
    return;
  }
  const btnColor = target === 'aide' ? 'green' : 'primary';
  const btnLabel = target === 'aide' ? 'Voir les points à proximité' : 'Localiser';
  wrap.innerHTML = `<div class="geo-state">
    <p>${target === 'aide' ? 'Trouvez de l\'eau et des lieux frais à proximité.' : 'Activez la localisation pour transmettre votre position aux secours.'}</p>
    <button class="btn btn--${btnColor} btn--sm" onclick="locateUser('${target}')">${btnLabel}</button>
  </div>`;
}

function initLeafletFor(target) {
  if (typeof L === 'undefined') return;
  const mapElId = `leaflet-map-${target}`;
  const el = document.getElementById(mapElId);
  if (!el) return;

  if (maps[target]) { maps[target].remove(); maps[target] = null; }

  maps[target] = L.map(el, { zoomControl: true }).setView([state.geo.lat, state.geo.lon], 15);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
  }).addTo(maps[target]);

  // Marqueur position actuelle
  const meIcon = L.divIcon({
    className: 'geo-pin',
    html: '<span class="geo-pin__dot"></span>',
    iconSize: [18, 18], iconAnchor: [9, 9],
  });
  L.marker([state.geo.lat, state.geo.lon], { icon: meIcon })
    .addTo(maps[target])
    .bindPopup('Vous êtes ici');

  setTimeout(() => maps[target] && maps[target].invalidateSize(), 80);

  // Si les POI sont déjà chargés, les ajouter tout de suite
  if (target === 'aide' && state.nearby.length) addPoiMarkers();
}

/* ── Liste des POI (3 premiers) ── */
function renderNearby() {
  const el = document.getElementById('nearby-list');
  if (!el) return;

  if (state.nearbyStatus === 'loading') {
    el.innerHTML = `<div class="nearby-loading"><span class="spinner spinner--sm"></span><span>Recherche des points à proximité…</span></div>`;
    return;
  }
  if (state.nearbyStatus === 'error') {
    el.innerHTML = `<p class="nearby-empty">Impossible de récupérer les points à proximité. Vérifiez votre connexion.</p>`;
    return;
  }
  if (!state.nearby.length) {
    el.innerHTML = `<p class="nearby-empty">Aucun point trouvé dans un rayon de 800 m.</p>`;
    return;
  }

  const top3 = state.nearby.slice(0, 3);
  el.innerHTML = top3.map((poi, index) => {
    const dist = poi.dist >= 1000
      ? (poi.dist / 1000).toFixed(1) + ' km'
      : poi.dist + ' m';
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
    navigator.clipboard.writeText(text).then(() => alert('Message copié dans le presse-papiers !')).catch(() => alert(text));
  }
}

/* ── Render helpers ── */
function renderEval() {
  const pct = ((state.step + 1) / QUESTIONS.length * 100).toFixed(0);
  const fill = document.getElementById('prog-fill');
  const lbl  = document.getElementById('prog-label');
  const qtxt = document.getElementById('question-text');
  if (fill)  fill.style.width = pct + '%';
  if (lbl)   lbl.textContent = `Question ${state.step + 1} / ${QUESTIONS.length}`;
  if (qtxt)  qtxt.textContent = QUESTIONS[state.step];
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
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});
