// SimDrive — load-area.js
// elevation + Overpass fetch, loadArea() orchestration, start-driving, top buttons
// Loaded as a classic script by js/bootstrap.js; all app files share one global
// scope (the original single-file behaviour), with THREE/addons exposed as globals.

// Fetch real terrain from AWS Terrarium elevation tiles -> returns heightAt(worldX, worldZ).
// Falls back to flat ground on any failure (CORS, missing tiles, etc).
const EXAG = 1.0; // real elevation (1.0) — exaggeration deepened river valleys & made bridges/ramps extreme
async function fetchElevation(lat0, lon0, half) {
  const flat = () => 0;
  try {
    const mPerLat = 111320, mPerLon = 111320 * Math.cos(lat0 * Math.PI/180);
    const dLat = half/mPerLat, dLon = half/mPerLon;
    const Z = 14, n2 = Math.pow(2, Z);
    const lon2tx = lon => (lon + 180)/360 * n2;
    const lat2ty = lat => { const r = lat*Math.PI/180; return (1 - Math.asinh(Math.tan(r))/Math.PI)/2 * n2; };
    const txMin = Math.floor(lon2tx(lon0 - dLon)), txMax = Math.floor(lon2tx(lon0 + dLon));
    const tyMin = Math.floor(lat2ty(lat0 + dLat)), tyMax = Math.floor(lat2ty(lat0 - dLat));
    const cols = txMax - txMin + 1, rows = tyMax - tyMin + 1;
    if (cols * rows > 25 || cols < 1 || rows < 1) return flat;
    const W = cols*256, H = rows*256;
    // Decoded elevation grid (metres, row-major Float32), cached in IndexedDB keyed by tile
    // range — same pattern as the OSM/Overture caches — so revisiting an area never re-fetches
    // or re-decodes the Terrarium PNG tiles. The grid depends only on the tiles; the world
    // origin (elev0 + projection below) is recomputed per call from lat0/lon0.
    const gridKey = `elev|${Z}|${txMin},${tyMin},${txMax},${tyMax}`;
    let grid = await cacheGet(gridKey);
    if (!grid || grid.length !== W*H) {
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const g = cv.getContext('2d', { willReadFrequently: true });
      await Promise.all(Array.from({ length: cols*rows }, (_, i) => {
        const cx = i % cols, cy = (i / cols) | 0;
        return new Promise(res => {
          const img = new Image(); img.crossOrigin = 'anonymous';
          const done = () => { clearTimeout(t); res(); };
          const t = setTimeout(done, 10000); // don't let a stalled tile hang the build
          img.onload = () => { try { g.drawImage(img, cx*256, cy*256); } catch(e){} done(); };
          img.onerror = done;
          img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${txMin+cx}/${tyMin+cy}.png`;
        });
      }));
      const rgba = g.getImageData(0, 0, W, H).data;
      grid = new Float32Array(W*H);
      for (let p = 0; p < W*H; p++) { const o = p*4; grid[p] = (rgba[o]*256 + rgba[o+1] + rgba[o+2]/256) - 32768; }
      await cacheSet(gridKey, grid);
      console.log('elevation: fetched + cached', gridKey, `${W}x${H}`);
    } else { console.log('elevation: cache hit', gridKey); }
    const elevAt = (gx, gy) => {
      gx = Math.max(0, Math.min(W-1, gx)); gy = Math.max(0, Math.min(H-1, gy));
      const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(W-1, x0+1), y1 = Math.min(H-1, y0+1);
      const fx = gx-x0, fy = gy-y0;
      const e = (x, y) => grid[y*W+x];
      const a = e(x0,y0), b = e(x1,y0), c = e(x0,y1), d = e(x1,y1);
      return (a*(1-fx)+b*fx)*(1-fy) + (c*(1-fx)+d*fx)*fy;
    };
    const toGlobal = (wx, wz) => {
      const lat = lat0 + (-wz)/mPerLat, lon = lon0 + wx/mPerLon;
      return { gx: lon2tx(lon)*256 - txMin*256, gy: lat2ty(lat)*256 - tyMin*256 };
    };
    const c0 = toGlobal(0, 0), elev0 = elevAt(c0.gx, c0.gy);
    if (!isFinite(elev0) || elev0 < -1000) return flat;
    return (wx, wz) => { const p = toGlobal(wx, wz); const h = (elevAt(p.gx, p.gy) - elev0) * EXAG;
      return (!isFinite(h) || Math.abs(h) > 1500) ? 0 : h; };
  } catch (e) { return () => 0; }
}

// Overpass is a free shared service that's often busy. Try several mirrors,
// with one retry each, so a single overloaded server doesn't fail the load.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const OVERPASS_TIMEOUT = 22000; // give up on a stalled server and try the next one
async function fetchOverpass(q) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
      const url = OVERPASS_ENDPOINTS[i];
      loadSub.textContent = `Querying map server ${i + 1}/${OVERPASS_ENDPOINTS.length}${attempt ? ' (retry)' : ''}…`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), OVERPASS_TIMEOUT);
      try {
        const r = await fetch(url, {
          method: 'POST', body: 'data=' + encodeURIComponent(q),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: ctrl.signal
        });
        if (r.status === 429 || r.status === 504) throw new Error('server busy (' + r.status + ')');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const text = await r.text();               // body read is also covered by the abort signal
        clearTimeout(timer);
        let data; try { data = JSON.parse(text); } catch (e) { throw new Error('server busy (non-JSON response)'); }
        return data;
      } catch (e) {
        clearTimeout(timer);
        lastErr = (e && e.name === 'AbortError') ? new Error('timed out') : e;
      }
    }
    if (attempt === 0) await new Promise(res => setTimeout(res, 1500)); // brief backoff before retrying
  }
  throw new Error('All map servers are busy right now (' + (lastErr && lastErr.message) + '). Wait a moment and try again.');
}

async function loadArea(lat, lon, rMi) {
  lastLat = lat; lastLon = lon; lastRMi = rMi;   // remember for the resume-on-refresh save
  startEl.style.display = 'none';
  loadingEl.style.display = 'flex';
  loadErr.style.display = 'none'; backBtn.style.display = 'none'; spinEl.style.display = '';
  startLoadingFX();                 // cycling Maxis flavour text + progress bar
  loadSub.textContent = `${rMi} mile area + surroundings — dense cities take longer.`;

  // Render the REAL map for a skirt beyond the play area so the edge is genuine streets
  // fading into haze (no fake skyline). The player is fenced into rMi; the skirt is wider
  // than the fog distance, so the true data edge is never visible. See buildWorld().
  const SKIRT_MI = 0.5;
  const renderMi = rMi + SKIRT_MI;
  const half = renderMi * MILE;
  const dLat = half / 111320, dLon = half / (111320 * Math.cos(lat * Math.PI/180));
  const s = lat - dLat, w = lon - dLon, nth = lat + dLat, e = lon + dLon;
  const bbox = `${s},${w},${nth},${e}`;
  const q = `[out:json][timeout:90];(` +
    `way["highway"](${bbox});` +
    `way["building"](${bbox});` +
    `way["building:part"](${bbox});` + // Simple-3D-Buildings parts: towers/steeples/wings with own heights+roofs
    `way["natural"~"water|wood|grassland|scrub"](${bbox});` +
    `way["water"](${bbox});` +
    `way["waterway"](${bbox});` +
    `way["leisure"~"park|garden|pitch|golf_course|playground|recreation_ground"](${bbox});` +
    `way["landuse"~"grass|forest|meadow|recreation_ground|village_green|cemetery|farmland|orchard|allotments"](${bbox});` +
    `way["landuse"="residential"](${bbox});` + // residential zones -> fill with houses where OSM has none
    `way["amenity"="parking"](${bbox});` +   // parking lots -> paved asphalt surface
    `node["natural"="tree"](${bbox});` +     // individually-mapped trees -> foliage
    `node["highway"~"traffic_signals|stop"](${bbox});` + // traffic lights & stop signs
    // big rivers/lakes & many parks are multipolygon relations, not ways:
    `relation["natural"="water"](${bbox});` +
    `relation["water"](${bbox});` +
    `relation["waterway"="riverbank"](${bbox});` +
    `relation["leisure"="park"](${bbox});` +
    `relation["landuse"~"grass|forest|meadow|cemetery|residential"](${bbox});` +
    `relation["amenity"="parking"](${bbox});` +
    `);out geom;`;

  try {
    const elevPromise = fetchElevation(lat, lon, half); // runs alongside Overpass
    // Overpass result is cached per-area so revisiting an area never re-downloads it.
    // v2: query now also fetches building:part ways (3D roof detail) — old cache entries lack them
    const osmKey = `osm2|${s.toFixed(4)},${w.toFixed(4)},${nth.toFixed(4)},${e.toFixed(4)}`;
    let data = await cacheGet(osmKey);
    if (!data) { data = await fetchOverpass(q); await cacheSet(osmKey, data); }
    if (!data.elements || !data.elements.length) throw new Error('No map data found here — try a more built-up area.');
    loadProgress(0.4);                // map data in hand

    // Overture buildings: detailed footprints + real heights, cached in IndexedDB.
    // Wrapped in a timeout so a slow/stalled DuckDB load can't hang the build — we
    // just fall back to OSM footprints + procedural houses.
    let overture = null;
    try {
      loadProgress(0.45);             // fetching detailed buildings
      loadSub.textContent = 'Overture Maps — the first new area also fetches the reader engine.';
      const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('overture timeout')), ms))]);
      const ovt = await withTimeout(fetchOvertureBuildings(s, w, nth, e), 45000);
      overture = ovt.buildings;
    } catch (e2) { console.warn('Overture unavailable, using OSM buildings:', e2); overture = null; }

    loadProgressSnap(0.8);            // snap to 80% NOW — the build freeze is about to halt easing
    loadSub.textContent = `${data.elements.length} map features` + (overture && overture.length ? ` · ${overture.length} detailed buildings` : '');
    const heightAt = await elevPromise;
    await new Promise(res => setTimeout(res, 30)); // let UI paint

    const tBuild = performance.now();
    buildWorld(data, lat, lon, renderMi, heightAt, overture, rMi);
    console.log(`buildWorld: ${(performance.now() - tBuild).toFixed(0)} ms (${data.elements.length} features)`);
    stopLoadingFX(true);              // snap the bar to 100%, stop the phrase cycler
    startDriving();
  } catch (err) {
    stopLoadingFX(false);            // halt the cycler so the error message isn't overwritten
    spinEl.style.display = 'none';
    loadMsg.textContent = 'Could not load this area';
    loadSub.textContent = '';
    loadErr.style.display = ''; loadErr.textContent = String(err.message || err) +
      '  (Overpass may be busy — wait a moment and retry, or pick a smaller radius.)';
    backBtn.style.display = '';
  }
}
backBtn.addEventListener('click', () => { loadingEl.style.display = 'none'; startEl.style.display = 'flex'; map.invalidateSize(); warmDuck(); });
document.getElementById('newLoc').addEventListener('click', () => {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {} // deliberately picking a new area -> refresh shows the picker
  worldReady = false;
  ['topbtns','fps','dashboard','touch'].forEach(id => document.getElementById(id).style.display = 'none');
  document.getElementById('help').classList.add('hidden');
  startEl.style.display = 'flex'; map.invalidateSize(); updatePreview(); warmDuck();
});
// Controls button toggles the keybindings popover (next to New location); the FPS readout
// rides along with it — shown only while the popover is open.
document.getElementById('controls').addEventListener('click', () => {
  const open = document.getElementById('help').classList.toggle('hidden') === false;
  document.getElementById('fps').style.display = open ? 'block' : 'none';
});

function startDriving() {
  loadingEl.style.display = 'none';
  document.getElementById('topbtns').style.display = 'flex';
  document.getElementById('fps').style.display = 'none';     // FPS hidden until Controls is opened
  document.getElementById('help').classList.add('hidden');   // popover starts closed
  document.getElementById('dashboard').style.display = 'flex';
  // on-screen driving buttons for touch devices (IS_TOUCH defined in main.js)
  document.getElementById('touch').style.display = IS_TOUCH ? 'block' : 'none';
  resize();
  saveSession(); // persist the area immediately so a refresh resumes even before the first periodic save
}

//----------------------------------------------------------------------------
