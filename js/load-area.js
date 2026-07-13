// SimDrive — load-area.js
// loadArea() orchestration for the STREAMING world: set the fixed origin, build the
// centre tile on the loading screen, start driving, and let tiles.js stream the rest.
// Also: Overpass fetch (shared with background tile loads), start-driving, top buttons.
// Loaded as a classic script by js/bootstrap.js; all app files share one global
// scope (the original single-file behaviour), with THREE/addons exposed as globals.

// Overpass is a free shared service that's often busy. Try several mirrors,
// with one retry each, so a single overloaded server doesn't fail the load.
// `status(msg)` (optional) reports progress — the loading screen passes a UI
// updater; background tile fetches pass nothing.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const OVERPASS_TIMEOUT = 22000; // give up on a stalled server and try the next one
async function fetchOverpass(q, status) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
      const url = OVERPASS_ENDPOINTS[i];
      if (status) status(`Querying map server ${i + 1}/${OVERPASS_ENDPOINTS.length}${attempt ? ' (retry)' : ''}…`);
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

// Loading-bar milestones per build phase (the generator yields phase labels).
const PHASE_PROGRESS = { ground: 0.72, sort: 0.74, water: 0.77, roads: 0.82, parking: 0.86,
  sidewalks: 0.88, buildings: 0.92, scatter: 0.95, houses: 0.955, trees: 0.96, signs: 0.97, grid: 0.985 };
const PHASE_TEXT = { ground: 'Laying terrain', roads: 'Paving streets', sidewalks: 'Pouring sidewalks',
  buildings: 'Raising buildings', trees: 'Planting trees', grid: 'Painting curbs' };

async function loadArea(lat, lon, rMi) {
  lastLat = lat; lastLon = lon; lastRMi = rMi;   // remember for the resume-on-refresh save
  startEl.style.display = 'none';
  loadingEl.style.display = 'flex';
  loadErr.style.display = 'none'; backBtn.style.display = 'none'; spinEl.style.display = '';
  startLoadingFX();                 // cycling Maxis flavour text + progress bar
  loadSub.textContent = 'Starting at your spot — the rest of the world streams in as you drive.';

  try {
    clearWorld();
    setWorldOrigin(lat, lon);
    terrain = sampleTerrain;

    // elevation for the centre tile + seed the height reference at the origin
    await ensureElevation(-TILE, -TILE, TILE, TILE);
    seedElev0();
    loadProgress(0.15);

    // fetch + build the FIRST tile with the loading screen up; neighbours stream in
    // the background once driving starts. On a refresh-resume that's the tile the
    // player was parked on (which may not be the origin tile).
    const t0 = performance.now();
    const hasResume = restorePos && isFinite(restorePos.x) && isFinite(restorePos.z);
    const center = hasResume ? getOrCreateTile(tileOf(restorePos.x), tileOf(restorePos.z))
                             : getOrCreateTile(0, 0);
    await fetchTileData(center, (stage) => {
      if (stage === 'elev') loadProgress(0.2);
      else if (stage === 'osm') loadProgress(0.45);
      else if (stage === 'ovt') loadProgress(0.7);
      else loadSub.textContent = stage;                       // Overpass mirror progress text
    });
    if (center.state === 'error') throw new Error('Could not fetch map data for this spot.');
    if (!center.data.elements.length) throw new Error('No map data found here — try a more built-up area.');
    loadSub.textContent = `${center.data.elements.length} map features` +
      (center.overture && center.overture.length ? ` · ${center.overture.length} detailed buildings` : '');

    // run the build generator with rAF breathers so the bar keeps animating
    center.state = 'building';
    const gen = buildTileSteps(center);
    let step = 0;
    for (let r = gen.next(); !r.done; r = gen.next()) {
      if (PHASE_PROGRESS[r.value]) loadProgress(PHASE_PROGRESS[r.value]);
      if (PHASE_TEXT[r.value]) loadSub.textContent = PHASE_TEXT[r.value] + '…';
      // breathe so the progress bar animates — raced with a timeout because rAF
      // never fires in a hidden tab (loading must finish even in the background)
      if (++step % 3 === 0) await new Promise(res => { const t = setTimeout(res, 40); requestAnimationFrame(() => { clearTimeout(t); res(); }); });
    }
    center.state = 'built';
    worldGroup.add(center.group); center.inScene = true;
    console.log(`centre tile: ${(performance.now() - t0).toFixed(0)} ms (${center.data.elements.length} features)`);

    refreshRegistries();     // graph + minimap + signals from the one live tile

    // ---- spawn: resume the saved position on refresh (if it's on the built tile),
    // else the nearest road node to the origin ----
    if (hasResume && builtTileAt(restorePos.x, restorePos.z)) {
      player.x = restorePos.x; player.z = restorePos.z; player.ang = restorePos.ang || 0;
    } else {
      const ax = hasResume ? restorePos.x : 0, az = hasResume ? restorePos.z : 0;
      let best = null, bd = 1e18;
      for (const nd of roadNodes) { const d = (nd.x-ax)*(nd.x-ax) + (nd.z-az)*(nd.z-az); if (d < bd) { bd = d; best = nd; } }
      if (best) {
        player.x = best.x; player.z = best.z;
        const nb = best.nb[0]; player.ang = nb ? Math.atan2(nb.z - best.z, nb.x - best.x) : 0;
      } else { player.x = 0; player.z = 0; player.ang = 0; }
    }
    restorePos = null;
    player.speed = 0; player.vy = 0;
    player.y = driveHeight(player.x, player.z);   // seed the resting level (deck if spawned on a bridge)

    worldReady = true;
    window.__dbg = { player, get bridges() { return bridges; }, driveHeight, surfaceHeight, terrain, tiles, TILE };
    stopLoadingFX(true);              // snap the bar to 100%, stop the phrase cycler
    startDriving();
    updateTiles();                    // kick the neighbour fetches immediately
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
  clearWorld();
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
