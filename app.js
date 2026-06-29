'use strict';

/* ── State ── */
const state = {
  screen: 'home',
  step: 0,
  hist: [],
  checks: {},
  geo: { status: 'idle', lat: null, lon: null, acc: null, addr: null },
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
  if (screen === 'urgence') locateUser();
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
  locateUser();
}

function answerNo() {
  if (state.step >= QUESTIONS.length - 1) {
    state.hist.push(state.screen);
    state.screen = 'aide';
    render();
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

/* ── Geolocation ── */
let leafletMap = null;
let leafletMarker = null;

function locateUser() {
  if (!('geolocation' in navigator)) {
    state.geo.status = 'error';
    renderGeo();
    return;
  }
  state.geo.status = 'loading';
  renderGeo();
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      state.geo.lat = pos.coords.latitude;
      state.geo.lon = pos.coords.longitude;
      state.geo.acc = Math.round(pos.coords.accuracy);
      state.geo.status = 'ok';
      renderGeo();
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${state.geo.lat}&lon=${state.geo.lon}&zoom=18`,
          { headers: { Accept: 'application/json' } }
        );
        const d = await r.json();
        state.geo.addr = d.display_name || null;
        renderGeo();
      } catch (_) {}
    },
    () => {
      state.geo.status = 'error';
      renderGeo();
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function renderGeo() {
  const wrap = document.getElementById('geo-wrap');
  if (!wrap) return;

  if (state.geo.status === 'loading') {
    wrap.innerHTML = `<div class="geo-state"><span class="spinner"></span><p>Localisation en cours…</p></div>`;
    return;
  }
  if (state.geo.status === 'error') {
    wrap.innerHTML = `<div class="geo-state">
      <p>Position indisponible. Donnez votre adresse et des repères aux secours.</p>
      <button class="btn btn--primary btn--sm" onclick="locateUser()">Réessayer</button>
    </div>`;
    return;
  }
  if (state.geo.status === 'ok' && state.geo.lat) {
    const mapsUrl = `https://www.google.com/maps?q=${state.geo.lat},${state.geo.lon}`;
    wrap.innerHTML = `
      <div class="geo-card__map" id="leaflet-map"></div>
      <div class="geo-card__info">
        ${state.geo.addr ? `<p class="geo-card__addr">${state.geo.addr}</p>` : ''}
        <p class="geo-card__coords">${state.geo.lat.toFixed(5)}, ${state.geo.lon.toFixed(5)}${state.geo.acc ? ` · ± ${state.geo.acc} m` : ''}</p>
        <div class="geo-card__btns">
          <a class="btn btn--ghost btn--sm" href="${mapsUrl}" target="_blank" rel="noopener">Ouvrir dans Maps</a>
          <button class="btn btn--ghost btn--sm" onclick="locateUser()">Actualiser</button>
        </div>
      </div>`;
    initLeaflet();
    return;
  }
  wrap.innerHTML = `<div class="geo-state">
    <p>Activez la localisation pour transmettre votre position aux secours.</p>
    <button class="btn btn--primary btn--sm" onclick="locateUser()">Localiser</button>
  </div>`;
}

function initLeaflet() {
  if (typeof L === 'undefined') return;
  const el = document.getElementById('leaflet-map');
  if (!el) return;
  if (leafletMap) { leafletMap.remove(); leafletMap = null; }
  leafletMap = L.map(el, { zoomControl: true }).setView([state.geo.lat, state.geo.lon], 16);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
  }).addTo(leafletMap);
  const icon = L.divIcon({
    className: 'geo-pin',
    html: '<span class="geo-pin__dot"></span>',
    iconSize: [18, 18], iconAnchor: [9, 9],
  });
  leafletMarker = L.marker([state.geo.lat, state.geo.lon], { icon }).addTo(leafletMap);
  setTimeout(() => leafletMap && leafletMap.invalidateSize(), 80);
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
  if (state.screen === 'eval') renderEval();
  if (state.screen === 'urgence') renderGeo();
  window.scrollTo(0, 0);
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  render();
  // Register SW
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});
