// SimDrive — tiles.js
// Streaming world: fixed origin, global elevation store, per-tile fetch pipeline,
// budgeted background builds, ring/scene membership and LRU disposal.
// Loaded as a classic script by js/bootstrap.js; all app files share one global
// scope (the original single-file behaviour), with THREE/addons exposed as globals.

//----------------------------------------------------------------------------
// Tile grid: half-mile squares on a FIXED world origin (the lat/lon of the first
// load). Tile (0,0) is CENTRED on the origin so the spawn point isn't a 4-corner.
//----------------------------------------------------------------------------
const TILE = MILE * 0.5;               // tile edge (m)
const GROUND_SEGS = 90;                // ground-plane subdivisions per tile
const GCELL = TILE / GROUND_SEGS;      // global ground grid cell (~8.9 m); surfaceHeight uses this
const FETCH_MARGIN = 40;               // m of data overlap so boundary features exist in both tiles
const SCENE_RING = 1;                  // Chebyshev radius of tiles kept IN the scene (3x3)
const PREFETCH_REACH = TILE * 1.4;     // fetch starts ~60% of the way across the current tile
const MAX_BUILT_TILES = 24;            // LRU cap on kept-built tiles (scene + hidden cache)

let ORIGIN = null;                     // { lat0, lon0, mPerLat, mPerLon } — fixed per area
function setWorldOrigin(lat, lon) {
  ORIGIN = { lat0: lat, lon0: lon, mPerLat: 111320, mPerLon: 111320 * Math.cos(lat * Math.PI/180) };
}
const worldToLL = (x, z) => ({ lat: ORIGIN.lat0 - z / ORIGIN.mPerLat, lon: ORIGIN.lon0 + x / ORIGIN.mPerLon });
const tileOf = v => Math.floor(v / TILE + 0.5);
const tKey = (tx, tz) => tx + ',' + tz;
const tileBounds = (tx, tz) => ({
  x0: (tx - 0.5) * TILE, z0: (tz - 0.5) * TILE,
  x1: (tx + 0.5) * TILE, z1: (tz + 0.5) * TILE,
  cx: tx * TILE, cz: tz * TILE,
});

const tiles = new Map();               // key -> tile record
function tileAt(x, z) { return tiles.get(tKey(tileOf(x), tileOf(z))); }
function builtTileAt(x, z) { const t = tileAt(x, z); return t && t.state === 'built' ? t : null; }
function getOrCreateTile(tx, tz) {
  const k = tKey(tx, tz);
  let t = tiles.get(k);
  if (!t) {
    t = { tx, tz, key: k, state: 'queued', bounds: tileBounds(tx, tz),
          data: null, overture: null, group: null, inScene: false,
          bridges: [], signals: null, waterYAt: null, renderedWaterAt: null,
          grid: null, roadMask: null, gMinX: 0, gMinZ: 0, gW: 0, gH: 0,
          roadLines: [], waterTexes: [], ownedTex: [], lastTouch: 0, errAt: 0 };
    tiles.set(k, t);
  }
  return t;
}

//----------------------------------------------------------------------------
// Elevation: AWS Terrarium z14 tiles decoded into a global store, cached per-tile
// in IndexedDB. terrain() samples ANY world point through the fixed origin, so
// tiles built at different times always agree on heights.
//----------------------------------------------------------------------------
const ELEV_Z = 14, ELEV_N = Math.pow(2, ELEV_Z);
const _lon2gx = lon => (lon + 180) / 360 * ELEV_N * 256;                       // global pixel coords
const _lat2gy = lat => { const r = lat*Math.PI/180; return (1 - Math.asinh(Math.tan(r))/Math.PI)/2 * ELEV_N * 256; };
const elevTiles = new Map();           // "X_Y" -> Float32Array(65536) | 'missing'
const elevPending = new Map();         // "X_Y" -> Promise
let elev0 = 0, elevSeeded = false;

function fetchElevTile(X, Y) {
  const k = X + '_' + Y;
  if (elevTiles.has(k)) return Promise.resolve();
  if (elevPending.has(k)) return elevPending.get(k);
  const p = (async () => {
    const ck = 'elevT|' + ELEV_Z + '|' + k;
    let grid = await cacheGet(ck);
    if (!grid || grid.length !== 256 * 256) {
      grid = await new Promise(res => {
        const img = new Image(); img.crossOrigin = 'anonymous';
        const timer = setTimeout(() => res(null), 12000);   // a stalled tile can't hang a build
        img.onload = () => { clearTimeout(timer);
          try {
            const cv = document.createElement('canvas'); cv.width = cv.height = 256;
            const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
            const d = g.getImageData(0, 0, 256, 256).data, out = new Float32Array(256 * 256);
            for (let i = 0; i < 256 * 256; i++) { const o = i * 4; out[i] = (d[o]*256 + d[o+1] + d[o+2]/256) - 32768; }
            res(out);
          } catch (e) { res(null); } };
        img.onerror = () => { clearTimeout(timer); res(null); };
        img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ELEV_Z}/${X}/${Y}.png`;
      });
      if (grid) await cacheSet(ck, grid);
    }
    elevTiles.set(k, grid || 'missing');
    elevPending.delete(k);
  })();
  elevPending.set(k, p);
  return p;
}

// Ensure every z14 elevation tile covering the world-space rect is loaded.
async function ensureElevation(x0, z0, x1, z1) {
  const a = worldToLL(x0, z1), b = worldToLL(x1, z0);      // a = SW corner, b = NE corner
  const gx0 = Math.floor(_lon2gx(a.lon) / 256), gx1 = Math.floor(_lon2gx(b.lon) / 256);
  const gy0 = Math.floor(_lat2gy(b.lat) / 256), gy1 = Math.floor(_lat2gy(a.lat) / 256);
  const jobs = [];
  for (let Y = gy0; Y <= gy1; Y++) for (let X = gx0; X <= gx1; X++) jobs.push(fetchElevTile(X, Y));
  await Promise.all(jobs);
}

let _elvKey = '', _elvGrid = null;      // 1-slot memo: terrain() hits the same z14 tile repeatedly
function _elevPx(ix, iy) {
  const X = ix >> 8, Y = iy >> 8, k = X + '_' + Y;
  let g;
  if (k === _elvKey) g = _elvGrid;
  else { g = elevTiles.get(k); _elvKey = k; _elvGrid = g; }
  if (!g || g === 'missing') return NaN;
  return g[(iy & 255) * 256 + (ix & 255)];
}
function _elevRawAt(wx, wz) {
  const ll = worldToLL(wx, wz);
  const gx = _lon2gx(ll.lon), gy = _lat2gy(ll.lat);
  const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
  const a = _elevPx(ix, iy), b = _elevPx(ix + 1, iy), c = _elevPx(ix, iy + 1), d = _elevPx(ix + 1, iy + 1);
  return (a*(1-fx) + b*fx) * (1-fy) + (c*(1-fx) + d*fx) * fy;
}
function seedElev0() {
  if (elevSeeded) return;
  const e = _elevRawAt(0, 0);
  elev0 = (isFinite(e) && e > -1000) ? e : 0;
  elevSeeded = true;
}
// The global terrain sampler (assigned to `terrain` when an area starts).
function sampleTerrain(wx, wz) {
  if (!ORIGIN || !elevSeeded) return 0;
  const e = _elevRawAt(wx, wz);
  if (!isFinite(e)) return 0;
  const h = e - elev0;
  return (Math.abs(h) > 1500) ? 0 : h;   // same sanity clamp as the old per-area sampler
}

//----------------------------------------------------------------------------
// Per-tile data fetch: elevation + Overpass + Overture (all IndexedDB-cached).
//----------------------------------------------------------------------------
function overpassQuery(s, w, n, e) {
  const bbox = `${s},${w},${n},${e}`;
  return `[out:json][timeout:60];(` +
    `way["highway"](${bbox});` +
    `way["building"](${bbox});` +
    `way["building:part"](${bbox});` +
    `way["natural"~"water|wood|grassland|scrub"](${bbox});` +
    `way["water"](${bbox});` +
    `way["waterway"](${bbox});` +
    `way["leisure"~"park|garden|pitch|golf_course|playground|recreation_ground"](${bbox});` +
    `way["landuse"~"grass|forest|meadow|recreation_ground|village_green|cemetery|farmland|orchard|allotments"](${bbox});` +
    `way["landuse"="residential"](${bbox});` +
    `way["amenity"="parking"](${bbox});` +
    `node["natural"="tree"](${bbox});` +
    `node["highway"~"traffic_signals|stop"](${bbox});` +
    `relation["natural"="water"](${bbox});` +
    `relation["water"](${bbox});` +
    `relation["waterway"="riverbank"](${bbox});` +
    `relation["leisure"="park"](${bbox});` +
    `relation["landuse"~"grass|forest|meadow|cemetery|residential"](${bbox});` +
    `relation["amenity"="parking"](${bbox});` +
    `);out geom;`;
}

// DuckDB has one connection — serialize Overture queries so tiles can't interleave.
let _ovtChain = Promise.resolve();
function fetchOvertureQueued(s, w, n, e) {
  const p = _ovtChain.then(() => fetchOvertureBuildings(s, w, n, e));
  _ovtChain = p.catch(() => {});
  return p;
}

async function fetchTileData(t, status) {
  t.state = 'fetching';
  try {
    const b = t.bounds, m = FETCH_MARGIN;
    await ensureElevation(b.x0 - 250, b.z0 - 250, b.x1 + 250, b.z1 + 250);
    if (status) status('elev');
    const sw = worldToLL(b.x0 - m, b.z1 + m), ne = worldToLL(b.x1 + m, b.z0 - m);
    const s = sw.lat, w = sw.lon, n = ne.lat, e = ne.lon;
    const osmKey = `osm2|${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)}`;
    let data = await cacheGet(osmKey);
    if (!data) { data = await fetchOverpass(overpassQuery(s, w, n, e), status); await cacheSet(osmKey, data); }
    if (!data.elements) throw new Error('empty Overpass response');
    t.data = data;
    if (status) status('osm');
    try {   // Overture is best-effort: OSM footprints + procedural houses cover a miss
      const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('overture timeout')), ms))]);
      const ovt = await withTimeout(fetchOvertureQueued(s, w, n, e), 45000);
      t.overture = ovt.buildings;
    } catch (e2) { t.overture = null; }
    if (status) status('ovt');
    t.state = 'ready';
  } catch (err) {
    console.warn('tile fetch failed', t.key, err && err.message);
    t.state = 'error'; t.errAt = performance.now();      // retried by updateTiles after a cooldown
  }
}

//----------------------------------------------------------------------------
// Build scheduler: one tile builds at a time, its generator stepped inside a
// per-frame time budget so driving never freezes on a build.
//----------------------------------------------------------------------------
let activeBuild = null;                 // { tile, gen }
let _registriesDirty = false;

function _tileScore(t) {                // lower = build/fetch sooner (near + ahead of heading first)
  const dx = t.bounds.cx - player.x, dz = t.bounds.cz - player.z;
  const d = Math.hypot(dx, dz) || 1;
  const hd = Math.cos(player.ang) * dx / d + Math.sin(player.ang) * dz / d;   // 1 = dead ahead
  return d - hd * 300;
}
function pumpBuilds(budgetMs) {
  const t0 = performance.now();
  while (performance.now() - t0 < budgetMs) {
    if (!activeBuild) {
      let next = null, best = Infinity;
      for (const t of tiles.values()) if (t.state === 'ready') { const s = _tileScore(t); if (s < best) { best = s; next = t; } }
      if (!next) return;
      next.state = 'building';
      activeBuild = { tile: next, gen: buildTileSteps(next) };
    }
    try {
      const r = activeBuild.gen.next();
      if (r.done) {
        activeBuild.tile.state = 'built';
        activeBuild = null;
        _registriesDirty = true;
      }
    } catch (err) {
      console.error('tile build failed', activeBuild.tile.key, err);
      const t = activeBuild.tile; activeBuild = null;
      disposeTile(t);                                    // drop the partial group
      const nt = getOrCreateTile(t.tx, t.tz); nt.state = 'error'; nt.errAt = performance.now();
    }
  }
}

function disposeTile(t) {
  if (activeBuild && activeBuild.tile === t) activeBuild = null;
  if (t.group) {
    worldGroup.remove(t.group);
    t.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (Array.isArray(o.material)) o.material.forEach(mm => mm.dispose()); else o.material.dispose(); }
    });
  }
  for (const tx of t.ownedTex) tx.dispose();             // per-tile texture clones only (shared atlases live on)
  for (const wt of t.waterTexes) { const i = waterTexes.indexOf(wt); if (i >= 0) waterTexes.splice(i, 1); }
  tiles.delete(t.key);
}

//----------------------------------------------------------------------------
// Ring management: desired set from player position/heading, scene membership,
// error retry, LRU disposal.
//----------------------------------------------------------------------------
function updateTiles() {
  if (!ORIGIN) return;
  const px = player.x, pz = player.z;
  const ctx = tileOf(px), ctz = tileOf(pz);
  const now = performance.now();

  // desired = every tile whose square intersects player ± PREFETCH_REACH
  const tx0 = tileOf(px - PREFETCH_REACH), tx1 = tileOf(px + PREFETCH_REACH);
  const tz0 = tileOf(pz - PREFETCH_REACH), tz1 = tileOf(pz + PREFETCH_REACH);
  const desired = new Set();
  for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) {
    desired.add(tKey(tx, tz));
    const t = getOrCreateTile(tx, tz);
    t.lastTouch = now;
    if (t.state === 'error' && now - t.errAt > 30000) t.state = 'queued';   // retry
  }

  // kick fetches nearest-first (bounded concurrency; Overpass is a shared service)
  let busy = 0;
  for (const t of tiles.values()) if (t.state === 'fetching') busy++;
  if (busy < 2) {
    const queued = [...tiles.values()].filter(t => t.state === 'queued' && desired.has(t.key))
      .sort((a, b) => _tileScore(a) - _tileScore(b));
    for (const t of queued) { if (busy >= 2) break; fetchTileData(t, null); busy++; }
  }

  // scene membership: built tiles within the ring go in; everything else comes out
  for (const t of tiles.values()) {
    const inRing = Math.abs(t.tx - ctx) <= SCENE_RING && Math.abs(t.tz - ctz) <= SCENE_RING;
    const want = inRing && t.state === 'built' && t.group;
    if (want && !t.inScene) { worldGroup.add(t.group); t.inScene = true; _registriesDirty = true; }
    else if (!want && t.inScene) { worldGroup.remove(t.group); t.inScene = false; _registriesDirty = true; }
  }

  // LRU disposal beyond the cap (never the scene ring or anything mid-pipeline)
  const built = [...tiles.values()].filter(t => t.state === 'built' && !t.inScene);
  if (built.length + 9 > MAX_BUILT_TILES) {
    built.sort((a, b) => a.lastTouch - b.lastTouch || (_tileScore(b) - _tileScore(a)));
    let excess = built.length + 9 - MAX_BUILT_TILES;
    for (const t of built) { if (excess-- <= 0) break; if (!desired.has(t.key)) disposeTile(t); }
  }
  // forget queued/errored tiles that drifted out of the desired set
  for (const t of tiles.values())
    if (!desired.has(t.key) && (t.state === 'queued' || t.state === 'error')) tiles.delete(t.key);
}

// Rebuild the cross-tile registries (road graph, bridges, signals, water fns,
// minimap) from the tiles currently in the scene.
function refreshRegistries() {
  const live = [...tiles.values()].filter(t => t.state === 'built' && t.inScene);
  bridges = [].concat(...live.map(t => t.bridges));
  signalSets = live.map(t => t.signals).filter(Boolean);
  signals = [].concat(...signalSets.map(s => s.list));
  waterClampFn = (x, z) => { const t = builtTileAt(x, z); return (t && t.waterYAt) ? t.waterYAt(x, z) : -Infinity; };
  renderedWaterFn = (x, z) => { const t = builtTileAt(x, z); return (t && t.renderedWaterAt) ? t.renderedWaterAt(x, z) : false; };
  rebuildGraph(live);
  rebuildMinimap(live);
  spawnNPCs(Math.min(14, Math.max(4, Math.floor(roadNodes.length / 60))));  // top-up as the graph grows
}

// Called every frame from the render loop once the world is up.
let _pumpTick = 0;
function pumpTiles() {
  if (!ORIGIN || !worldReady) return;
  _pumpTick++;
  if (_pumpTick % 15 === 0) updateTiles();               // ~4x/sec is plenty for ring churn
  pumpBuilds(7);                                         // ≤7 ms of build work per frame
  if (_registriesDirty && (_pumpTick % 30 === 0 || !activeBuild)) {
    _registriesDirty = false;
    refreshRegistries();
  }
}

// Background variant for hidden tabs: timers fire ~1/s there, so each call does a
// full ring update and a bigger slice of build work (nobody's watching the frame rate).
function pumpTilesHidden() {
  if (!ORIGIN || !worldReady) return;
  updateTiles();
  pumpBuilds(120);
  if (_registriesDirty) { _registriesDirty = false; refreshRegistries(); }
}

// Full reset for "New location": drop every tile and the world origin.
function resetTiles() {
  activeBuild = null;
  for (const t of [...tiles.values()]) disposeTile(t);
  tiles.clear();
  elevSeeded = false; elev0 = 0;
  // elevation pixel tiles stay cached (they're keyed globally and tiny)
}
