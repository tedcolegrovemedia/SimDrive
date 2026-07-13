// SimDrive — picker.js
// Leaflet map picker: location search, radius, area preview
// Loaded as a classic script by js/bootstrap.js; all app files share one global
// scope (the original single-file behaviour), with THREE/addons exposed as globals.

//----------------------------------------------------------------------------
// Map picker (Leaflet)
//----------------------------------------------------------------------------
let radiusMi = 0.5;
// Persist the last session so a page refresh resumes driving instead of dropping back to the map.
const SESSION_KEY = 'driveAround:session';
let restorePos = null, lastLat = 0, lastLon = 0, lastRMi = 0.3;
const map = L.map('map', { zoomControl: true, attributionControl: true })
  .setView([40.6093, -75.3735], 15); // default: Bethlehem, PA 18015 (Lehigh River + bridges nearby)
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© OpenStreetMap'
}).addTo(map);

let previewRect = null;
function updatePreview() {
  const c = map.getCenter();
  const half = MILE * 0.25;   // the starting tile — everything beyond it streams in as you drive
  const dLat = half / 111320;
  const dLon = half / (111320 * Math.cos(c.lat * Math.PI/180));
  const b = [[c.lat - dLat, c.lng - dLon], [c.lat + dLat, c.lng + dLon]];
  if (previewRect) previewRect.setBounds(b);
  else previewRect = L.rectangle(b, { color: '#ffd54a', weight: 2, fillOpacity: 0.08 }).addTo(map);
}
map.on('move', updatePreview);
map.whenReady(updatePreview);

document.getElementById('radGroup').addEventListener('click', e => {
  const el = e.target.closest('.rad'); if (!el) return;
  radiusMi = parseFloat(el.dataset.r);
  document.querySelectorAll('.rad').forEach(r => r.classList.remove('sel'));
  el.classList.add('sel');
  updatePreview();
});

const searchEl = document.getElementById('search');
searchEl.addEventListener('keydown', async e => {
  if (e.key !== 'Enter' || !searchEl.value.trim()) return;
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(searchEl.value.trim());
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const j = await r.json();
    if (j[0]) map.setView([parseFloat(j[0].lat), parseFloat(j[0].lon)], 15);
    else searchEl.placeholder = 'No match — try another search';
  } catch (err) { searchEl.placeholder = 'Search failed — check connection'; }
});

document.getElementById('go').addEventListener('click', () => {
  const c = map.getCenter();
  loadArea(c.lat, c.lng, radiusMi);
});

const geoBtn = document.getElementById('geoBtn');
geoBtn.addEventListener('click', () => {
  if (!navigator.geolocation) { geoBtn.textContent = 'Not supported'; return; }
  geoBtn.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    p => { map.setView([p.coords.latitude, p.coords.longitude], 15); geoBtn.textContent = '⌖ My location'; },
    () => { geoBtn.textContent = 'Location blocked'; setTimeout(() => geoBtn.textContent = '⌖ My location', 2500); },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});
