// SimDrive — build-world.js
// buildTileSteps(): assemble ONE half-mile tile of city from OSM data, as a
// generator so the scheduler can spread the work across frames (no drive hitch).
// Loaded as a classic script by js/bootstrap.js; all app files share one global
// scope (the original single-file behaviour), with THREE/addons exposed as globals.

const ROAD_WIDTH = { motorway:13, trunk:12, primary:10, secondary:8.5, tertiary:7.5,
  residential:6.5, living_street:6, unclassified:6.5, service:4.5, road:6.5,
  // ramps/connectors (incl. elevated freeway viaducts like PA 378's link to Main St) — without
  // these, whole interchange bridges vanish because `*_link` highways were dropped from DRIVABLE
  motorway_link:7, trunk_link:7, primary_link:6, secondary_link:5.5, tertiary_link:5 };
const DRIVABLE = new Set(Object.keys(ROAD_WIDTH));
// SimCity-2000-ish mix: tan, brown, sage, teal-blue, terracotta, cream, slate, olive, brick, cool grey
const BUILDING_PAL = [0xc9b79a,0xb89a78,0x9fb0a0,0x86a6b0,0xc6a488,0xd6c9ad,0x9aa9b8,0x97a08a,0xb29a96,0xaeb4ba];
const BUILDING_HEIGHT_SCALE = 3; // real Overture/OSM heights were rendering ~1/3 life-size; bring them up to true height

let worldReady = false;

// Full reset (New location): every tile, NPC and cross-tile registry goes.
function clearWorld() {
  worldReady = false;
  resetTiles();
  for (const n of NPCS) npcGroup.remove(n.mesh);
  NPCS = [];
  waterTexes.length = 0;
  signPosts = [];
  signals = []; signalSets = [];
  bridges = [];
  roadNodes = [];
  miniData = null;
  waterClampFn = null; renderedWaterFn = null;
  _terrCache.clear();          // heights are origin-relative; a new area invalidates them
}

// Clone a base canvas texture with a world-space repeat (metres per tile). ShapeGeometry
// UVs are in metres, so repeat = 1/m tiles the texture every m metres.
function tiledTex(base, m, worldMeters, owned) {
  const t = base.clone(); t.needsUpdate = true;
  const r = worldMeters ? worldMeters / m : 1 / m;   // PlaneGeometry UVs span 0..1 -> scale by world size
  t.repeat.set(r, r);
  if (owned) owned.push(t);
  return t;
}

//----------------------------------------------------------------------------
// Geometry clipping against the tile square. Linear features are smoothed on the
// FULL way geometry first (both neighbours have it, so they cut at identical
// points), then clipped; area features are Sutherland–Hodgman clipped.
//----------------------------------------------------------------------------
function clipPolyRect(poly, x0, z0, x1, z1) {
  let out = poly;
  const pass = (pts, inside, cut) => {
    const res = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const pin = inside(p), qin = inside(q);
      if (pin) res.push(p);
      if (pin !== qin) res.push(cut(p, q));
    }
    return res;
  };
  out = pass(out, p => p.x >= x0, (p, q) => ({ x: x0, z: p.z + (q.z - p.z) * (x0 - p.x) / (q.x - p.x) }));
  if (out.length < 3) return null;
  out = pass(out, p => p.x <= x1, (p, q) => ({ x: x1, z: p.z + (q.z - p.z) * (x1 - p.x) / (q.x - p.x) }));
  if (out.length < 3) return null;
  out = pass(out, p => p.z >= z0, (p, q) => ({ z: z0, x: p.x + (q.x - p.x) * (z0 - p.z) / (q.z - p.z) }));
  if (out.length < 3) return null;
  out = pass(out, p => p.z <= z1, (p, q) => ({ z: z1, x: p.x + (q.x - p.x) * (z1 - p.z) / (q.z - p.z) }));
  return out.length >= 3 ? out : null;
}

// Clip a polyline to the rect -> array of pieces (>= 2 pts each), cut exactly at
// the boundary (Liang–Barsky per segment, contiguous runs stitched).
function clipLineRect(pts, x0, z0, x1, z1) {
  const pieces = [];
  let cur = null;
  const push = (p) => { if (!cur) cur = [p]; else { const t = cur[cur.length - 1]; if (Math.abs(t.x - p.x) > 1e-6 || Math.abs(t.z - p.z) > 1e-6) cur.push(p); } };
  const flush = () => { if (cur && cur.length >= 2) pieces.push(cur); cur = null; };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dz, a.z - z0], [dz, z1 - a.z]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else       { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { flush(); continue; }
    const pa = t0 <= 0 ? a : { x: a.x + dx * t0, z: a.z + dz * t0 };
    const pb = t1 >= 1 ? b : { x: a.x + dx * t1, z: a.z + dz * t1 };
    if (t0 > 0) flush();               // segment enters the rect: start a fresh piece
    push(pa); push(pb);
    if (t1 < 1) flush();               // segment exits: close the piece at the boundary
  }
  flush();
  return pieces;
}

//----------------------------------------------------------------------------
// The tile builder. Yields between (and inside) phases; the scheduler runs it
// under a per-frame time budget. The initial load runs it with rAF breathers.
//----------------------------------------------------------------------------
function* buildTileSteps(tile) {
  const data = tile.data, overture = tile.overture;
  const { x0, z0, x1, z1, cx, cz } = tile.bounds;
  const inTile = (x, z) => x >= x0 && x < x1 && z >= z0 && z < z1;
  const group = new THREE.Group();
  tile.group = group;
  tile.bridges = []; tile.roadLines = []; tile.waterTexes = []; tile.ownedTex = [];
  const mPerLat = ORIGIN.mPerLat, mPerLon = ORIGIN.mPerLon, lat0 = ORIGIN.lat0, lon0 = ORIGIN.lon0;
  const toXZ = (lat, lon) => ({ x: (lon - lon0) * mPerLon, z: -((lat - lat0) * mPerLat) });

  yield 'ground';
  // ---- ground: one subdivided plane per tile, vertices on the GLOBAL ground grid
  // (multiples of GCELL) so adjacent tiles share edge heights exactly ----
  {
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x7cab54, map: tiledTex(grassTex, 9, TILE, tile.ownedTex) });
    const gGeo = new THREE.PlaneGeometry(TILE, TILE, GROUND_SEGS, GROUND_SEGS);
    gGeo.rotateX(-Math.PI/2);
    const gp = gGeo.attributes.position;
    for (let i = 0; i < gp.count; i++) gp.setY(i, terrain(gp.getX(i) + cx, gp.getZ(i) + cz) - 0.15);
    gp.needsUpdate = true; gGeo.computeVertexNormals();
    const groundMesh = new THREE.Mesh(gGeo, groundMat);
    groundMesh.position.set(cx, 0, cz);
    groundMesh.receiveShadow = true; group.add(groundMesh);
  }

  yield 'sort';
  // ---- sort elements ----
  // Linear features keep FULL geometry (clipped later); area features are clipped
  // to the tile here; point features are kept only if they fall inside the tile.
  const roadPolys = [], buildingPolys = [], partPolys = [], waterPolys = [], waterLines = [], greenPolys = [], residentialPolys = [], parkingPolys = [];
  const treePoints = [], treedPolys = [], scrubPolys = [];
  const farmPolys = [], orchardPolys = [];
  const signalNodes = [], stopNodes = [];
  const collideWater = [];                      // UNCLIPPED water for collision (grid clamps anyway)
  const GREEN_LEISURE = /park|garden|pitch|golf_course|playground|recreation_ground/;
  const GREEN_LANDUSE = /grass|forest|meadow|recreation_ground|village_green|cemetery|farmland|orchard|allotments/;
  const GREEN_NATURAL = /wood|grassland|scrub/;
  const WATERWAY_W = { river: 16, canal: 9, stream: 4, ditch: 2.5, drain: 2.5 };
  const clipArea = poly => clipPolyRect(poly, x0, z0, x1, z1);

  // Stitch relation member ways (boundary segments) into closed rings.
  const eqPt = (p, q) => Math.abs(p.x - q.x) < 0.6 && Math.abs(p.z - q.z) < 0.6;
  function assembleRings(segs) {
    const rings = [], used = new Array(segs.length).fill(false);
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue; used[i] = true;
      let ring = segs[i].slice(), ext = true;
      while (ext) {
        ext = false;
        const head = ring[0], tail = ring[ring.length - 1];
        for (let j = 0; j < segs.length; j++) {
          if (used[j]) continue;
          const s = segs[j], a = s[0], b = s[s.length - 1];
          if (eqPt(tail, a)) { ring = ring.concat(s.slice(1)); }
          else if (eqPt(tail, b)) { ring = ring.concat(s.slice(0, -1).reverse()); }
          else if (eqPt(head, b)) { ring = s.slice(0, -1).concat(ring); }
          else if (eqPt(head, a)) { ring = s.slice(1).reverse().concat(ring); }
          else continue;
          used[j] = true; ext = true; break;
        }
      }
      if (ring.length >= 3) rings.push(ring);
    }
    return rings;
  }

  // Water/park multipolygon RELATIONS -> assembled rings classified by tags.
  for (const el of data.elements) {
    if (el.type !== 'relation' || !el.members) continue;
    const t = el.tags || {};
    const segs = el.members.filter(m => m.role === 'outer' && m.geometry && m.geometry.length >= 2)
      .map(m => m.geometry.map(g => toXZ(g.lat, g.lon)));
    if (!segs.length) continue;
    for (const ring of assembleRings(segs)) {
      const c = clipArea(ring);
      if (t.natural === 'water' || t.water || t.waterway === 'riverbank') { collideWater.push(ring); if (c) waterPolys.push(c); }
      else if (!c) continue;
      else if (t.amenity === 'parking') parkingPolys.push(c);
      else if (t.landuse === 'residential') residentialPolys.push(c);
      else { greenPolys.push(c); if (t.natural === 'wood' || t.landuse === 'forest') treedPolys.push(c); }
    }
  }

  let sortI = 0;
  for (const el of data.elements) {
    if (++sortI % 800 === 0) yield 'sort';
    if (el.type === 'node' && el.tags) {
      const p = toXZ(el.lat, el.lon);
      if (!inTile(p.x, p.z)) continue;                       // point features: strict tile ownership
      const ht = el.tags.highway;
      if (el.tags.natural === 'tree') treePoints.push(p);
      else if (ht === 'traffic_signals') signalNodes.push(p);
      else if (ht === 'stop') stopNodes.push(p);
      continue;
    }
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const pts = el.geometry.map(g => toXZ(g.lat, g.lon));
    const t = el.tags || {};
    if (t.highway && DRIVABLE.has(t.highway)) {
      if (t.tunnel && t.tunnel !== 'no') continue;
      if (t.service === 'parking_aisle') continue;
      roadPolys.push({ pts, w: ROAD_WIDTH[t.highway] || 6.5, bridge: !!(t.bridge && t.bridge !== 'no'), name: t.name });
    }
    else if (t.amenity === 'parking') { const c = clipArea(pts); if (c) parkingPolys.push(c); }
    else if (t['building:part'] && t['building:part'] !== 'no') partPolys.push({ pts, t });
    else if (t.building) buildingPolys.push({ pts, t });
    else if (t.natural === 'water' || t.water || t.waterway === 'riverbank') { collideWater.push(pts); const c = clipArea(pts); if (c) waterPolys.push(c); }
    else if (t.waterway && WATERWAY_W[t.waterway]) waterLines.push({ pts, w: WATERWAY_W[t.waterway] });
    else if (t.landuse === 'residential') { const c = clipArea(pts); if (c) residentialPolys.push(c); }
    else if (t.landuse === 'farmland') { const c = clipArea(pts); if (c) farmPolys.push(c); }
    else if (t.landuse === 'orchard') { const c = clipArea(pts); if (c) { greenPolys.push(c); orchardPolys.push(c); } }
    else if (GREEN_LEISURE.test(t.leisure || '') || GREEN_LANDUSE.test(t.landuse || '') || GREEN_NATURAL.test(t.natural || '')) {
      const c = clipArea(pts); if (!c) continue;
      greenPolys.push(c);
      if (t.natural === 'wood' || t.landuse === 'forest') treedPolys.push(c);
      else if (t.natural === 'scrub') scrubPolys.push(c);
    }
  }

  yield 'water';
  // Draped water-height grid for wide LINE waterways (rivers/canals), tile-local.
  const rvCell = 3, rvMinX = x0 - 12, rvMinZ = z0 - 12;
  const rvNx = Math.ceil((TILE + 24) / rvCell) + 1, rvNz = Math.ceil((TILE + 24) / rvCell) + 1;
  const rvGrid = new Float32Array(rvNx * rvNz).fill(-Infinity);
  for (const wl of waterLines) {
    if (wl.w < 8 || wl.pts.length < 2) continue;
    const hw = wl.w / 2 + 1, dd = densify(wl.pts, rvCell);
    for (const p of dd) {
      const cx0 = Math.max(0, ((p.x - hw - rvMinX) / rvCell) | 0), cx1 = Math.min(rvNx - 1, ((p.x + hw - rvMinX) / rvCell) | 0);
      const cz0 = Math.max(0, ((p.z - hw - rvMinZ) / rvCell) | 0), cz1 = Math.min(rvNz - 1, ((p.z + hw - rvMinZ) / rvCell) | 0);
      for (let czi = cz0; czi <= cz1; czi++) for (let cxi = cx0; cxi <= cx1; cxi++) {
        const wx = rvMinX + (cxi + 0.5) * rvCell, wz = rvMinZ + (czi + 0.5) * rvCell;
        if ((wx - p.x) ** 2 + (wz - p.z) ** 2 > hw * hw) continue;
        const wy = surfaceHeight(wx, wz) - 0.02;
        const idx = czi * rvNx + cxi; if (wy > rvGrid[idx]) rvGrid[idx] = wy;
      }
    }
  }
  const rvAt = (x, z) => { const cxi = ((x - rvMinX) / rvCell) | 0, czi = ((z - rvMinZ) / rvCell) | 0; if (cxi < 0 || czi < 0 || cxi >= rvNx || czi >= rvNz) return -Infinity; return rvGrid[czi * rvNx + cxi]; };

  // Flat water level for a (clipped) polygon: lowest terrain among its vertices.
  // Clipped pieces of a big sloping river can differ slightly per tile — accepted.
  const waterLevel = (poly) => {
    let lvl = Infinity;
    for (const p of poly) lvl = Math.min(lvl, terrain(p.x, p.z));
    return isFinite(lvl) ? lvl : 0;
  };

  // ---- green areas & water (filled shapes). flat=true keeps water level. ----
  function fillShapes(polys, color, yoff, flat, tex, texM) {
    const geos = [];
    for (const pts of polys) {
      if (pts.length < 3) continue;
      const shape = new THREE.Shape();
      shape.moveTo(pts[0].x, -pts[0].z);
      for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].z);
      const g = new THREE.ShapeGeometry(shape); g.rotateX(-Math.PI/2);
      const pa = g.attributes.position;
      if (flat) {
        const lvl = waterLevel(pts);
        for (let i = 0; i < pa.count; i++) pa.setY(i, lvl + yoff);
      } else {
        for (let i = 0; i < pa.count; i++) pa.setY(i, surfaceHeight(pa.getX(i), pa.getZ(i)) + yoff);
      }
      geos.push(g);
    }
    if (!geos.length) return;
    const merged = mergeGeometries(geos, false);
    const map = tex ? tiledTex(tex, texM, 0, tile.ownedTex) : null;
    const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, map }));
    mesh.receiveShadow = true; group.add(mesh);
    return mesh;
  }
  fillShapes(greenPolys, 0x7cb84f, 0.06, false, grassTex, 9);
  yield 'water';
  fillShapes(farmPolys, 0xc2b276, 0.05, false, cropTex, 14);
  fillShapes(parkingPolys, 0x5d6168, 0.13, false, asphaltTex, 7);
  const waterMesh = fillShapes(waterPolys, 0x3589cf, 0.1, true, waterTex, 16);
  if (waterMesh) { waterTexes.push(waterMesh.material.map); tile.waterTexes.push(waterMesh.material.map); }

  // rivers/streams mapped as lines -> draped blue ribbons, clipped to the tile
  const waterLinePos = [];
  for (const wl of waterLines)
    for (const piece of clipLineRect(wl.pts, x0, z0, x1, z1))
      ribbon(piece, wl.w / 2, waterLinePos, (x, z) => surfaceHeight(x, z) - 0.02);
  if (waterLinePos.length) {
    const t = waterTex.clone(); t.needsUpdate = true;
    const m = texMesh(waterLinePos, t, 1/16, 0x3589cf, false);
    waterTexes.push(t); tile.waterTexes.push(t); tile.ownedTex.push(t);
    group.add(m);
  }

  yield 'roads';
  // ---- roads: smooth the FULL ways (deterministic across tiles), deck pre-pass on
  // full geometry, then clip non-bridge ways to the tile. Bridge decks render whole
  // in their OWNER tile (midpoint) so the arc profile never splits mid-span. ----
  for (const r of roadPolys) r.pts = roundCorners(r.pts, 2);
  const roadPos = [], dashPos = [], bridgePos = [], roadLines = tile.roadLines;
  const emitDashes = (pts, yAt) => {
    let total = 0; const cum = [0];
    for (let i = 0; i < pts.length - 1; i++) { total += Math.hypot(pts[i+1].x-pts[i].x, pts[i+1].z-pts[i].z); cum.push(total); }
    if (total < 8) return;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i+1];
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
      const ux = dx/len, uz = dz/len, px = -uz*0.2, pz = ux*0.2;
      for (let d = 2; d < len - 2; d += 7) {
        const t1 = Math.min(d + 3, len - 1);
        const ax = a.x+ux*d, az = a.z+uz*d, bx = a.x+ux*t1, bz = a.z+uz*t1;
        const ya = yAt(ax, az, (cum[i]+d)/total), yb = yAt(bx, bz, (cum[i]+t1)/total);
        dashPos.push(
          ax+px, ya, az+pz,  bx-px, yb, bz-pz,  ax-px, ya, az-pz,
          ax+px, ya, az+pz,  bx+px, yb, bz+pz,  bx-px, yb, bz-pz
        );
      }
    }
  };
  const roadY = (x, z) => { const s = surfaceHeight(x, z) + 0.18, w = waterYAt(x, z); return w > -Infinity && w + 0.6 > s ? w + 0.6 : s; };

  // Water surface levels (matching fillShapes) so bridges can clear the water.
  const waterSurf = waterPolys.filter(p => p.length >= 3).map(poly => {
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const p of poly) { if (p.x<minX)minX=p.x; if (p.x>maxX)maxX=p.x; if (p.z<minZ)minZ=p.z; if (p.z>maxZ)maxZ=p.z; }
    return { y: waterLevel(poly) + 0.1, minX, maxX, minZ, maxZ, poly };
  });
  const waterYAt = (x, z) => { let best = rvAt(x, z);
    for (const w of waterSurf) if (x>=w.minX && x<=w.maxX && z>=w.minZ && z<=w.maxZ) best = Math.max(best, w.y);
    return best; };
  tile.waterYAt = waterYAt;
  const nearRenderedWater = (x, z) => {
    if (rvAt(x, z) > -Infinity) return true;
    for (const w of waterSurf) if (x>=w.minX && x<=w.maxX && z>=w.minZ && z<=w.maxZ && pointInPoly(x, z, w.poly)) return true;
    return false;
  };
  tile.renderedWaterAt = nearRenderedWater;

  // bridge joint/plateau bookkeeping over the FULL ways in this tile's data
  const ekey = (x, z) => Math.round(x) + '_' + Math.round(z);
  const endpointCount = new Map();
  for (const r of roadPolys) {
    if (!r.bridge || r.pts.length < 2) continue;
    for (const e of [r.pts[0], r.pts[r.pts.length-1]]) endpointCount.set(ekey(e.x, e.z), (endpointCount.get(ekey(e.x, e.z)) || 0) + 1);
  }
  const isJoint = (x, z) => (endpointCount.get(ekey(x, z)) || 0) >= 2;
  const uf = new Map();
  const ufFind = k => { while (uf.get(k) !== k) { uf.set(k, uf.get(uf.get(k))); k = uf.get(k); } return k; };
  const bridgeWays = roadPolys.filter(r => r.bridge && r.pts.length >= 2);
  for (const r of bridgeWays) {
    const ka = ekey(r.pts[0].x, r.pts[0].z), kb = ekey(r.pts[r.pts.length-1].x, r.pts[r.pts.length-1].z);
    if (!uf.has(ka)) uf.set(ka, ka);
    if (!uf.has(kb)) uf.set(kb, kb);
    uf.set(ufFind(ka), ufFind(kb));
  }
  const groupPlateau = new Map();
  for (const r of bridgeWays) {
    const dd = densify(r.pts, 3);
    let lowest = Infinity, spanLen = 0;
    for (let i = 0; i < dd.length; i++) { lowest = Math.min(lowest, terrain(dd[i].x, dd[i].z)); if (i > 0) spanLen += Math.hypot(dd[i].x - dd[i-1].x, dd[i].z - dd[i-1].z); }
    let waterY = -Infinity; for (const pt of dd) { const wy = waterYAt(pt.x, pt.z); if (wy > waterY) waterY = wy; }
    if (!(spanLen >= 11 || waterY > -Infinity)) continue;
    const clearance = Math.min(6, Math.max(spanLen >= 11 ? 3 : 1.5, spanLen * 0.06));
    const pl = Math.max(waterY, lowest) + clearance;
    const root = ufFind(ekey(r.pts[0].x, r.pts[0].z));
    groupPlateau.set(root, Math.max(groupPlateau.get(root) ?? -Infinity, pl));
  }
  const plateauFor = (x, z) => groupPlateau.get(ufFind(ekey(x, z)));

  yield 'roads';
  // deck pre-pass (full geometry; owner renders)
  for (const r of roadPolys) {
    if (!r.bridge || r.pts.length < 2) continue;
    const dd = densify(r.pts, 3);
    let lowest = Infinity, spanLen = 0;
    for (let i = 0; i < dd.length; i++) {
      lowest = Math.min(lowest, terrain(dd[i].x, dd[i].z));
      if (i > 0) spanLen += Math.hypot(dd[i].x - dd[i-1].x, dd[i].z - dd[i-1].z);
    }
    let waterY = -Infinity; for (const pt of dd) { const wy = waterYAt(pt.x, pt.z); if (wy > waterY) waterY = wy; }
    if (!(spanLen >= 11 || waterY > -Infinity)) { r._deck = { raised: false }; continue; }
    const a = r.pts[0], b = r.pts[r.pts.length-1];
    const clearance = Math.min(6, Math.max(spanLen >= 11 ? 3 : 1.5, spanLen * 0.06));
    const plateau = plateauFor(a.x, a.z) ?? (Math.max(waterY, lowest) + clearance);
    const eStart = isJoint(a.x, a.z) ? plateau : roadY(a.x, a.z) - 0.2;
    const eEnd   = isJoint(b.x, b.z) ? plateau : roadY(b.x, b.z) - 0.2;
    const deckFn = (x, z, frac) => { const base = eStart + (eEnd - eStart) * frac; return base + Math.max(0, plateau - base) * bridgeBump(frac) + 0.2; };
    r._deck = { raised: true, dd, eStart, eEnd, plateau, waterY, deckFn };
  }
  const streetLevelAt = (x, z) => {
    for (const r of roadPolys) {
      if (r.bridge || r.pts.length < 2) continue;
      const margin = r.w/2 + 1.9;
      for (let i = 0; i < r.pts.length-1; i++) {
        const a = r.pts[i], b = r.pts[i+1];
        const dx = b.x-a.x, dz = b.z-a.z, l2 = dx*dx + dz*dz;
        let t = l2 ? ((x-a.x)*dx + (z-a.z)*dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = a.x+dx*t, pz = a.z+dz*t;
        if (Math.hypot(x-px, z-pz) < margin) return roadY(px, pz);
      }
    }
    return -Infinity;
  };

  let roadI = 0;
  for (const r of roadPolys) {
    if (++roadI % 40 === 0) yield 'roads';
    const pts = r.pts, hw = r.w / 2;
    if (r.bridge) {
      // Owner-tile rendering: the tile containing the way's midpoint draws the WHOLE
      // deck (arc profile can't be split); neighbours skip it but still add its clipped
      // centreline to their road graph so traffic/graph stay connected.
      const mid = pts[(pts.length / 2) | 0];
      const owner = inTile(mid.x, mid.z);
      const dk = r._deck;
      for (const piece of clipLineRect(pts, x0, z0, x1, z1)) roadLines.push(piece);
      if (!owner) continue;
      if (dk && dk.raised) {
        ribbon(pts, hw, roadPos, dk.deckFn);
        if (r.w >= 7) emitDashes(pts, (x, z, f) => dk.deckFn(x, z, f) + 0.06);
        bridgeStructure(pts, hw, dk.deckFn, bridgePos, streetLevelAt);
        tile.bridges.push({ pts: dk.dd, hw, eStart: dk.eStart, eEnd: dk.eEnd, plateau: dk.plateau, waterY: dk.waterY });
      } else {
        ribbon(pts, hw, roadPos, roadY);
      }
    } else {
      for (const piece of clipLineRect(pts, x0, z0, x1, z1)) {
        roadLines.push(piece);
        ribbon(piece, hw, roadPos, roadY);
        if (r.w >= 7) emitDashes(piece, (x, z) => surfaceHeight(x, z) + 0.22);
      }
    }
  }

  yield 'parking';
  // parking-lot mask (roads must FLOW into lots, no curb across the entrance)
  const PKC = 1.2, pkW = Math.ceil(TILE / PKC) + 1, pkMinX = x0, pkMinZ = z0;
  const pkMask = new Uint8Array(pkW * pkW);
  for (const poly of parkingPolys) {
    if (poly.length < 3) continue;
    let zLo = 1e9, zHi = -1e9;
    for (const p of poly) { if (p.z < zLo) zLo = p.z; if (p.z > zHi) zHi = p.z; }
    const j0 = Math.max(0, Math.floor((zLo - pkMinZ) / PKC)), j1 = Math.min(pkW - 1, Math.ceil((zHi - pkMinZ) / PKC));
    for (let j = j0; j <= j1; j++) {
      const czl = pkMinZ + (j + 0.5) * PKC, xs = [];
      for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
        const a = poly[i], b = poly[k];
        if ((a.z > czl) !== (b.z > czl)) xs.push(a.x + (czl - a.z) * (b.x - a.x) / (b.z - a.z));
      }
      xs.sort((p, q) => p - q);
      for (let s = 0; s + 1 < xs.length; s += 2) {
        const i0 = Math.max(0, Math.floor((xs[s] - pkMinX) / PKC)), i1 = Math.min(pkW - 1, Math.floor((xs[s+1] - pkMinX) / PKC));
        for (let i = i0; i <= i1; i++) pkMask[j * pkW + i] = 1;
      }
    }
  }
  const inParking = (x, z) => {
    const i = Math.floor((x - pkMinX) / PKC), j = Math.floor((z - pkMinZ) / PKC);
    return i >= 0 && j >= 0 && i < pkW && j < pkW && pkMask[j * pkW + i] === 1;
  };

  yield 'sidewalks';
  yield* buildSidewalks(roadPolys, tile, waterYAt, inParking, group);
  if (roadPos.length) group.add(texMesh(roadPos, asphaltTex, 1/7, 0x484c55, false));
  if (dashPos.length) { const m = flatMesh(dashPos, 0xd9c25a, false); m.material.emissive = new THREE.Color(0x3a3318); group.add(m); }
  if (bridgePos.length) { const m = flatMesh(bridgePos, 0x8a8f98, true); m.material.side = THREE.DoubleSide; m.castShadow = true; group.add(m); }

  yield 'buildings';
  // ---- buildings: rendered by CENTROID ownership (each building belongs to exactly
  // one tile); collision below rasterizes ALL footprints in the data so a neighbour-
  // owned building's overhang still blocks the car. ----
  const BCELL = 40, bIndex = new Map();
  const bboxOf = (pp) => { let bx0=1e9,bx1=-1e9,bz0=1e9,bz1=-1e9;
    for (const p of pp) { if(p.x<bx0)bx0=p.x; if(p.x>bx1)bx1=p.x; if(p.z<bz0)bz0=p.z; if(p.z>bz1)bz1=p.z; }
    return { x0: bx0, x1: bx1, z0: bz0, z1: bz1 }; };
  buildingPolys.forEach((b) => { const bb = bboxOf(b.pts);
    for (let gz = Math.floor(bb.z0/BCELL); gz <= Math.floor(bb.z1/BCELL); gz++)
      for (let gx = Math.floor(bb.x0/BCELL); gx <= Math.floor(bb.x1/BCELL); gx++) {
        const k = gx+'_'+gz; let a = bIndex.get(k); if (!a) { a = []; bIndex.set(k, a); } a.push(b);
      } });
  const centroidOf = (pp) => { let sx=0,sz=0; for (const p of pp){sx+=p.x;sz+=p.z;} return { x:sx/pp.length, z:sz/pp.length }; };
  const containingBuilding = (x, z) => {
    const a = bIndex.get(Math.floor(x/BCELL)+'_'+Math.floor(z/BCELL));
    if (a) for (const b of a) if (pointInPoly(x, z, b.pts)) return b;
    return null;
  };

  for (const p of partPolys) {
    const c = centroidOf(p.pts);
    const parent = containingBuilding(c.x, c.z);
    if (parent) { parent.hasParts = true; p.parent = parent; }
  }
  const partOwners = buildingPolys.filter(b => b.hasParts);
  const orphanParts = partPolys.filter(p => !p.parent);

  // ownership test: a building (or multi-part landmark) renders in the tile that
  // contains its (parent's) centroid
  const owns = (pp) => { const c = centroidOf(pp); return inTile(c.x, c.z); };

  const renderB = [], collisionPolys = [];
  if (overture && overture.length) {
    let ovI = 0;
    for (const b of overture) {
      if (++ovI % 400 === 0) yield 'buildings';
      const pts = b.ll.map(([lo, la]) => toXZ(la, lo));
      if (pts.length < 3) continue;
      const c = centroidOf(pts);
      let skip = false;
      for (const o of partOwners) if (pointInPoly(c.x, c.z, o.pts)) { skip = true; break; }
      if (!skip) for (const p of orphanParts) if (pointInPoly(c.x, c.z, p.pts)) { skip = true; break; }
      if (skip) continue;
      const osm = containingBuilding(c.x, c.z);
      const t = osm ? { ...osm.t } : {};
      if (!parseFloat(t.height) && b.height) t.height = String(b.height);
      if (inTile(c.x, c.z)) renderB.push({ pts, t });
      else if (pts.some(p => inTile(p.x, p.z))) collisionPolys.push(pts);   // neighbour-owned overhang still collides
    }
  } else {
    for (const b of buildingPolys) if (!b.hasParts) {
      if (owns(b.pts)) renderB.push(b);
      else if (b.pts.some(p => inTile(p.x, p.z))) collisionPolys.push(b.pts);
    }
  }
  for (const o of partOwners) if (o.pts.some(p => inTile(p.x, p.z))) collisionPolys.push(o.pts);
  for (const p of partPolys) {
    const anchor = p.parent ? p.parent.pts : p.pts;
    if (owns(anchor)) renderB.push({ pts: p.pts, t: p.t, isPart: true, parent: p.parent });
  }

  const simplifyCorners = (pp) => {
    const out = [], n = pp.length;
    for (let i = 0; i < n; i++) {
      const p = pp[(i+n-1)%n], c = pp[i], q = pp[(i+1)%n];
      const ax=c.x-p.x, az=c.z-p.z, bx=q.x-c.x, bz=q.z-c.z;
      const la=Math.hypot(ax,az)||1e-9, lb=Math.hypot(bx,bz)||1e-9;
      if (Math.abs(ax*bz - az*bx)/(la*lb) > 0.15) out.push(c);
    }
    return out.length >= 3 ? out : pp;
  };
  const isConvexQuad = (q) => {
    if (q.length !== 4) return false;
    let sgn = 0;
    for (let i = 0; i < 4; i++) {
      const a=q[i], b=q[(i+1)%4], c=q[(i+2)%4];
      const cr = (b.x-a.x)*(c.z-b.z) - (b.z-a.z)*(c.x-b.x);
      if (Math.abs(cr) < 1e-6) continue;
      if (!sgn) sgn = Math.sign(cr); else if (Math.sign(cr) !== sgn) return false;
    }
    return true;
  };
  const cssColor = (s) => {
    if (!s) return null;
    s = String(s).trim().toLowerCase();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) return new THREE.Color(s);
    if (/^[0-9a-f]{6}$/.test(s)) return new THREE.Color('#' + s);
    if (THREE.Color.NAMES && THREE.Color.NAMES[s] !== undefined) return new THREE.Color(s);
    return null;
  };
  const RSHAPE = { gabled:'gabled', gambrel:'gabled', round:'gabled', saltbox:'gabled',
    hipped:'hipped', 'half-hipped':'hipped', mansard:'hipped',
    pyramidal:'pyramidal', cone:'pyramidal', conical:'pyramidal',
    spire:'spire', steeple:'spire', dome:'dome', onion:'dome' };

  const wallBuckets = FACADES.map(() => []); const roofGeos = [];
  const storePos = [], storeUV = [], storeCol = [];
  const detail = { pos: [], col: [] };
  const dTri = (tx1,ty1,tz1, tx2,ty2,tz2, tx3,ty3,tz3, c) => {
    detail.pos.push(tx1,ty1,tz1, tx2,ty2,tz2, tx3,ty3,tz3);
    detail.col.push(c.r,c.g,c.b, c.r,c.g,c.b, c.r,c.g,c.b);
  };
  const dQuad = (a, ya, b, yb, c, yc, d, yd, cc) => {
    dTri(a.x,ya,a.z, b.x,yb,b.z, c.x,yc,c.z, cc);
    dTri(a.x,ya,a.z, c.x,yc,c.z, d.x,yd,d.z, cc);
  };

  let bI = 0;
  for (const b of renderB) {
    if (++bI % 120 === 0) yield 'buildings';
    let pts = b.pts;
    if (pts.length > 2 && pts[0].x === pts[pts.length-1].x && pts[0].z === pts[pts.length-1].z) pts = pts.slice(0, -1);
    if (pts.length < 3) continue;
    const t = b.t || {};
    let h = parseFloat(t.height);
    if (!h && t['building:levels']) h = parseFloat(t['building:levels']) * 3.3;
    if (h && !isNaN(h)) h *= BUILDING_HEIGHT_SCALE;
    if (!h || isNaN(h)) h = 9 + (Math.abs((pts[0].x * 7 + pts[0].z * 13) | 0) % 5) * 3.3;
    let area2 = 0; for (let i = 0, j = pts.length-1; i < pts.length; j = i++) area2 += (pts[j].x + pts[i].x) * (pts[j].z - pts[i].z);
    const areaM2 = Math.abs(area2) / 2;
    if (!b.isPart) h = Math.max(h, Math.min(15, 5 + Math.sqrt(areaM2) * 0.2));
    h = Math.min(h, 600);
    let minH = parseFloat(t.min_height);
    if (!minH && t['building:min_level']) minH = parseFloat(t['building:min_level']) * 3.3;
    minH = (minH && !isNaN(minH)) ? minH * BUILDING_HEIGHT_SCALE : 0;
    if (minH >= h) minH = 0;

    const basePts = (b.isPart && b.parent) ? b.parent.pts : pts;
    let ground = Infinity;
    for (const p of basePts) ground = Math.min(ground, terrain(p.x, p.z));
    const yTop = ground + h;
    const yBot = minH > 0 ? ground + minH : ground - 3;

    const col = cssColor(t['building:colour']) ||
      new THREE.Color(BUILDING_PAL[Math.abs((pts[0].x*3 + pts[0].z*5)|0) % BUILDING_PAL.length]);
    const hash = Math.abs((pts[0].x*13.1 + pts[0].z*7.7) | 0);
    let vi;
    if (h > 50)      vi = (hash % 3 === 0) ? 4 : 0;
    else if (h > 26) vi = (hash % 4 === 0) ? 4 : 0;
    else if (h > 14) vi = [0, 2, 2, 5][hash % 4];
    else             vi = [1, 1, 5, 3][hash % 4];
    const CELL_W = FACADES[vi].cw, CELL_H = FACADES[vi].ch, FNC = FACADES[vi].n || 1;
    const ov = hash % FNC;

    const worship = t.amenity === 'place_of_worship' ||
      /^(church|chapel|cathedral|mosque|temple|synagogue|monastery)$/.test(t.building || '');

    const sq = simplifyCorners(pts);
    const quad = isConvexQuad(sq) ? sq : null;
    let rs = RSHAPE[(t['roof:shape'] || '').toLowerCase()] || '';
    if (!rs) {
      if (b.isPart) rs = 'flat';
      else if (worship && quad) rs = 'gabled';
      else if (quad && areaM2 < 320 && h < 40 && hash % 4) rs = 'gabled';
      else rs = 'flat';
    }
    if ((rs === 'gabled' || rs === 'hipped') && !quad) rs = 'flat';

    let spanS, spanL = 0;
    if (quad) {
      const e0 = Math.hypot(quad[1].x-quad[0].x, quad[1].z-quad[0].z);
      const e1 = Math.hypot(quad[2].x-quad[1].x, quad[2].z-quad[1].z);
      spanS = Math.min(e0, e1); spanL = Math.max(e0, e1);
    } else {
      const bb = bboxOf(pts); spanS = Math.min(bb.x1-bb.x0, bb.z1-bb.z0);
    }
    let roofH = parseFloat(t['roof:height']);
    if (!roofH && t['roof:levels']) roofH = parseFloat(t['roof:levels']) * 3.3;
    roofH = (roofH && !isNaN(roofH)) ? roofH * BUILDING_HEIGHT_SCALE : 0;
    if (!roofH) roofH = rs === 'spire' ? Math.min(Math.max(spanS * 1.5, 8), 40)
              : rs === 'dome' ? spanS * 0.5
              : Math.min(Math.max(spanS * 0.5, 2.5), 16);
    roofH = Math.min(roofH, h * (rs === 'spire' ? 0.65 : 0.55));
    const eaveY = rs === 'flat' ? yTop : yTop - roofH;

    const roofCol = cssColor(t['roof:colour']) ||
      (rs === 'flat' ? col.clone().multiplyScalar(0.82)
                     : new THREE.Color(ROOF_PAL[hash % ROOF_PAL.length]));

    const BAND = 5;
    const hasStore = !b.isPart && minH === 0 && (vi === 0 || vi === 2 || vi === 4 || vi === 5) &&
      (eaveY - ground) > BAND + 7 && areaM2 > 70;
    const bandTop = hasStore ? ground + BAND : yBot;

    const wp = [], wuv = [], wc = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], bb = pts[(i+1) % pts.length];
      const elen = Math.hypot(bb.x - a.x, bb.z - a.z); if (elen < 0.05) continue;
      const push = (px, py, pz, u, v) => { wp.push(px, py, pz); wuv.push(u, v); wc.push(col.r, col.g, col.b); };
      if (hasStore) {
        const SN = STOREFRONT.n || 1, os = (hash + i) % SN;
        const su1 = Math.max(1, Math.round(elen / STOREFRONT.cw));
        const pushS = (px, py, pz, u, v) => { storePos.push(px, py, pz); storeUV.push(u, v); storeCol.push(col.r, col.g, col.b); };
        const v0 = (yBot - (bandTop - BAND)) / BAND;
        pushS(a.x, yBot, a.z, os/SN, v0); pushS(bb.x, yBot, bb.z, (os+su1)/SN, v0); pushS(bb.x, bandTop, bb.z, (os+su1)/SN, 1);
        pushS(a.x, yBot, a.z, os/SN, v0); pushS(bb.x, bandTop, bb.z, (os+su1)/SN, 1); pushS(a.x, bandTop, a.z, os/SN, 1);
      }
      const ou = (hash + i * 3) % FNC;
      const u1 = Math.max(1, Math.round(elen / CELL_W)), v1 = Math.max(1, Math.round((eaveY - bandTop) / CELL_H));
      push(a.x, bandTop, a.z, ou/FNC, ov/FNC);   push(bb.x, bandTop, bb.z, (ou+u1)/FNC, ov/FNC);  push(bb.x, eaveY, bb.z, (ou+u1)/FNC, (ov+v1)/FNC);
      push(a.x, bandTop, a.z, ou/FNC, ov/FNC);   push(bb.x, eaveY, bb.z, (ou+u1)/FNC, (ov+v1)/FNC); push(a.x, eaveY, a.z, ou/FNC, (ov+v1)/FNC);
    }
    if (wp.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(wuv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(wc, 3));
      wallBuckets[vi].push(g);
    }

    if (rs === 'flat') {
      const shape = new THREE.Shape();
      shape.moveTo(pts[0].x, -pts[0].z);
      for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].z);
      const rg = new THREE.ShapeGeometry(shape); rg.rotateX(-Math.PI/2);
      const pa = rg.attributes.position.array; for (let i = 1; i < pa.length; i += 3) pa[i] = yTop;
      rg.deleteAttribute('uv'); rg.deleteAttribute('normal');
      const rn = rg.attributes.position.count, rc = new Float32Array(rn * 3);
      for (let i = 0; i < rn; i++) { rc[i*3] = roofCol.r; rc[i*3+1] = roofCol.g; rc[i*3+2] = roofCol.b; }
      rg.setAttribute('color', new THREE.BufferAttribute(rc, 3));
      roofGeos.push(rg.toNonIndexed());
      if (!b.isPart && h > 15 && areaM2 > 60) {
        const pc = col.clone().multiplyScalar(0.62);
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], q = pts[(i+1)%pts.length];
          dQuad(a, yTop, q, yTop, q, yTop + 1.0, a, yTop + 1.0, pc);
        }
      }
    } else if (rs === 'gabled' || rs === 'hipped') {
      const e0 = Math.hypot(quad[1].x-quad[0].x, quad[1].z-quad[0].z);
      const e1 = Math.hypot(quad[2].x-quad[1].x, quad[2].z-quad[1].z);
      const s0 = e0 <= e1 ? 0 : 1;
      const p0 = quad[s0], p1 = quad[(s0+1)%4], p2 = quad[(s0+2)%4], p3 = quad[(s0+3)%4];
      let m0 = { x:(p0.x+p1.x)/2, z:(p0.z+p1.z)/2 }, m1 = { x:(p2.x+p3.x)/2, z:(p2.z+p3.z)/2 };
      if (rs === 'hipped') {
        const rl = Math.hypot(m1.x-m0.x, m1.z-m0.z) || 1;
        const inset = Math.min(rl * 0.32, spanS * 0.5);
        const ux = (m1.x-m0.x)/rl, uz = (m1.z-m0.z)/rl;
        m0 = { x: m0.x + ux*inset, z: m0.z + uz*inset };
        m1 = { x: m1.x - ux*inset, z: m1.z - uz*inset };
      }
      dQuad(p1, eaveY, p2, eaveY, m1, yTop, m0, yTop, roofCol);
      dQuad(p3, eaveY, p0, eaveY, m0, yTop, m1, yTop, roofCol);
      const endCol = rs === 'gabled' ? col.clone().multiplyScalar(0.94) : roofCol;
      dTri(p0.x, eaveY, p0.z, p1.x, eaveY, p1.z, m0.x, yTop, m0.z, endCol);
      dTri(p2.x, eaveY, p2.z, p3.x, eaveY, p3.z, m1.x, yTop, m1.z, endCol);
      if (worship && !b.isPart && rs === 'gabled' && spanL > 12) {
        const rl = Math.hypot(m1.x-m0.x, m1.z-m0.z) || 1;
        const ux = (m1.x-m0.x)/rl, uz = (m1.z-m0.z)/rl, vx = -uz, vz = ux;
        const tw = Math.min(Math.max(spanS * 0.34, 2.4), 5.5);
        const ttx = m0.x + ux * (tw * 0.7), ttz = m0.z + uz * (tw * 0.7);
        const cr = [
          { x: ttx + (ux+vx)*tw/2, z: ttz + (uz+vz)*tw/2 }, { x: ttx + (ux-vx)*tw/2, z: ttz + (uz-vz)*tw/2 },
          { x: ttx - (ux+vx)*tw/2, z: ttz - (uz+vz)*tw/2 }, { x: ttx - (ux-vx)*tw/2, z: ttz - (uz-vz)*tw/2 },
        ];
        const towerTop = yTop + roofH * 0.5 + tw * 0.6;
        const wallC = col.clone().multiplyScalar(1.04), spireC = roofCol.clone().multiplyScalar(0.8);
        for (let i = 0; i < 4; i++) dQuad(cr[i], yBot, cr[(i+1)%4], yBot, cr[(i+1)%4], towerTop, cr[i], towerTop, wallC);
        for (let i = 0; i < 4; i++) dTri(cr[i].x, towerTop, cr[i].z, cr[(i+1)%4].x, towerTop, cr[(i+1)%4].z, ttx, towerTop + tw*2.1, ttz, spireC);
      }
    } else {
      const c = centroidOf(pts);
      if (rs === 'dome') {
        const midY = eaveY + roofH * 0.78;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], q = pts[(i+1)%pts.length];
          const ma = { x: a.x + (c.x-a.x)*0.45, z: a.z + (c.z-a.z)*0.45 };
          const mq = { x: q.x + (c.x-q.x)*0.45, z: q.z + (c.z-q.z)*0.45 };
          dQuad(a, eaveY, q, eaveY, mq, midY, ma, midY, roofCol);
          dTri(ma.x, midY, ma.z, mq.x, midY, mq.z, c.x, yTop, c.z, roofCol);
        }
      } else {
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], q = pts[(i+1)%pts.length];
          dTri(a.x, eaveY, a.z, q.x, eaveY, q.z, c.x, yTop, c.z, roofCol);
        }
      }
    }
    if (minH === 0) collisionPolys.push(pts);
  }
  yield 'buildings';
  wallBuckets.forEach((geos, vi) => {
    if (!geos.length) return;
    const merged = mergeGeometries(geos, false); merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ map: FACADES[vi].tex, vertexColors: true, side: THREE.DoubleSide }));
    mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh);
  });
  if (storePos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(storePos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(storeUV, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(storeCol, 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: STOREFRONT.tex, vertexColors: true, side: THREE.DoubleSide }));
    mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh);
  }
  if (detail.pos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(detail.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(detail.col, 3));
    roofGeos.push(g);
  }
  if (roofGeos.length) {
    const merged = mergeGeometries(roofGeos, false); merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh);
  }

  yield 'scatter';
  // ---- countryside scatter (clumped wild trees/bushes/rocks/flowers), tile-local.
  // Noise is seeded from the tile key so an LRU-evicted tile rebuilds the same. ----
  const wildBushPts = [], rockPts = [], flowerPts = [];
  {
    const nseed = Math.abs(Math.sin(tile.tx * 127.1 + tile.tz * 311.7) * 1000);
    const h2 = (i, j) => { const s = Math.sin(i*127.1 + j*311.7 + nseed) * 43758.5453; return s - Math.floor(s); };
    const vnoise = (x, z) => {
      const i = Math.floor(x), j = Math.floor(z), fx = x-i, fz = z-j;
      const a = h2(i,j), b = h2(i+1,j), c = h2(i,j+1), d = h2(i+1,j+1);
      const ux = fx*fx*(3-2*fx), uz = fz*fz*(3-2*fz);
      return a + (b-a)*ux + (c-a)*uz + (a-b-c+d)*ux*uz;
    };
    const RC = 12, roadSet = new Set(), rk = (x, z) => Math.round(x/RC) + '_' + Math.round(z/RC);
    for (const r of roadPolys) for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i+1], len = Math.hypot(b.x-a.x, b.z-a.z) || 1;
      for (let d = 0; d <= len; d += RC*0.7) {
        const x = a.x + (b.x-a.x)*d/len, z = a.z + (b.z-a.z)*d/len;
        for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++)
          roadSet.add(Math.round(x/RC+ox) + '_' + Math.round(z/RC+oz));
      }
    }
    const BC = 40, bMap = new Map();
    for (const b of renderB) {
      const bb = bboxOf(b.pts);
      for (let gz = Math.floor(bb.z0/BC); gz <= Math.floor(bb.z1/BC); gz++)
        for (let gx = Math.floor(bb.x0/BC); gx <= Math.floor(bb.x1/BC); gx++) {
          const k = gx + '_' + gz; let arr = bMap.get(k); if (!arr) { arr = []; bMap.set(k, arr); } arr.push(bb);
        }
    }
    const inBuilding = (x, z) => {
      const arr = bMap.get(Math.floor(x/BC) + '_' + Math.floor(z/BC));
      if (arr) for (const bb of arr) if (x >= bb.x0-1 && x <= bb.x1+1 && z >= bb.z0-1 && z <= bb.z1+1) return true;
      return false;
    };
    const avoid = [...residentialPolys, ...parkingPolys, ...farmPolys].map(p => ({ p, bb: bboxOf(p) }));
    const inAvoid = (x, z) => {
      for (const a of avoid) if (x >= a.bb.x0 && x <= a.bb.x1 && z >= a.bb.z0 && z <= a.bb.z1 && pointInPoly(x, z, a.p)) return true;
      return false;
    };
    const open = (x, z) => !roadSet.has(rk(x, z)) && !inBuilding(x, z) && !nearRenderedWater(x, z) && !inAvoid(x, z);

    const step = 13;
    let nT = 0, nB = 0, nR = 0, nF = 0;      // per-tile caps (1/6 of the old whole-world budget)
    for (let x = x0 + 8; x < x1 - 8; x += step) {
      for (let z = z0 + 8; z < z1 - 8; z += step) {
        const n = vnoise(x * 0.016, z * 0.016);
        if (n < 0.56) continue;
        if (Math.random() > (n - 0.56) * 3.2) continue;
        const jx = x + (Math.random()-0.5)*step, jz = z + (Math.random()-0.5)*step;
        if (!inTile(jx, jz) || !open(jx, jz)) continue;
        const r = Math.random();
        if (r < 0.50)      { if (nT++ < 500) treePoints.push({ x: jx, z: jz }); }
        else if (r < 0.82) { if (nB++ < 400) wildBushPts.push({ x: jx, z: jz }); }
        else if (r < 0.90) { if (nR++ < 110) rockPts.push({ x: jx, z: jz }); }
        else               { if (nF++ < 180) flowerPts.push({ x: jx, z: jz }); }
      }
    }
    let nO = 0;
    for (const poly of orchardPolys) {
      const bb = bboxOf(poly);
      for (let x = bb.x0 + 4; x < bb.x1 && nO < 300; x += 7.5)
        for (let z = bb.z0 + 4; z < bb.z1 && nO < 300; z += 7.5)
          if (pointInPoly(x, z, poly)) { treePoints.push({ x, z, sp: 0, sc: 0.5 + Math.random()*0.15 }); nO++; }
    }
  }

  yield 'houses';
  const yardBushPts = buildHouses(residentialPolys, renderB, roadPolys.map(r => r.pts), inTile, group) || [];
  yield 'trees';
  buildTrees(treePoints, treedPolys, scrubPolys, yardBushPts.concat(wildBushPts), group);
  buildCountryProps(rockPts, flowerPts, group);
  yield 'signs';
  tile.signals = buildTrafficLights(signalNodes, roadPolys, group);
  buildStopSigns(stopNodes, roadPolys, group);
  buildStreetSigns(roadPolys, inTile, group);

  yield 'grid';
  // ---- collision grid + road mask (tile-local arrays; blocked()/onRoad() dispatch
  // by tile). Collision rasterizes ALL footprints/water in the data, clamped to the
  // tile, so neighbour-owned geometry still blocks. ----
  tile.gMinX = x0; tile.gMinZ = z0;
  tile.gW = Math.ceil(TILE / gridCell); tile.gH = Math.ceil(TILE / gridCell);
  const grid = new Uint8Array(tile.gW * tile.gH);
  const gW = tile.gW, gH = tile.gH;
  function rasterize(polys) {
    for (const poly of polys) {
      if (poly.length < 3) continue;
      let minZ = 1e9, maxZ = -1e9;
      for (const p of poly) { if (p.z<minZ)minZ=p.z; if (p.z>maxZ)maxZ=p.z; }
      const cz0 = Math.max(0, ((minZ - z0)/gridCell)|0), cz1 = Math.min(gH-1, ((maxZ - z0)/gridCell)|0);
      const xs = [];
      for (let czi = cz0; czi <= cz1; czi++) {
        const wz = z0 + (czi+0.5)*gridCell;
        xs.length = 0;
        for (let i = 0, j = poly.length-1; i < poly.length; j = i++) {
          const a = poly[i], b = poly[j];
          if ((a.z > wz) !== (b.z > wz)) xs.push(a.x + (wz - a.z) / (b.z - a.z) * (b.x - a.x));
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const cx0 = Math.max(0, Math.ceil((xs[k] - x0)/gridCell - 0.5)), cx1 = Math.min(gW-1, Math.floor((xs[k+1] - x0)/gridCell - 0.5));
          for (let cxi = cx0; cxi <= cx1; cxi++) grid[czi*gW + cxi] = 1;
        }
      }
    }
  }
  rasterize(collisionPolys);
  yield 'grid';
  rasterize(collideWater.filter(p => p.length >= 3));

  const roadMask = new Uint8Array(gW * gH);
  function stampRoad(centerline, hw) {
    const r = hw + 2.0, r2 = r * r;
    const dd = densify(centerline, gridCell);
    for (let i = 0; i < dd.length - 1; i++) {
      const a = dd[i], b = dd[i+1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx*dx + dz*dz || 1;
      const cx0 = Math.max(0, ((Math.min(a.x,b.x) - r - x0)/gridCell)|0), cx1 = Math.min(gW-1, ((Math.max(a.x,b.x) + r - x0)/gridCell)|0);
      const cz0 = Math.max(0, ((Math.min(a.z,b.z) - r - z0)/gridCell)|0), cz1 = Math.min(gH-1, ((Math.max(a.z,b.z) + r - z0)/gridCell)|0);
      for (let czi = cz0; czi <= cz1; czi++) for (let cxi = cx0; cxi <= cx1; cxi++) {
        const wx = x0 + (cxi+0.5)*gridCell, wz = z0 + (czi+0.5)*gridCell;
        let t = ((wx-a.x)*dx + (wz-a.z)*dz)/l2; t = Math.max(0, Math.min(1, t));
        const px = a.x + dx*t, pz = a.z + dz*t, d2 = (wx-px)*(wx-px) + (wz-pz)*(wz-pz);
        if (d2 <= r2) roadMask[czi*gW + cxi] = 1;
      }
    }
  }
  for (const r of roadPolys) stampRoad(r.pts, r.w / 2);
  for (const poly of parkingPolys) {
    if (poly.length < 3) continue;
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const p of poly) { if (p.x<minX)minX=p.x; if (p.x>maxX)maxX=p.x; if (p.z<minZ)minZ=p.z; if (p.z>maxZ)maxZ=p.z; }
    const cx0 = Math.max(0, ((minX - x0)/gridCell)|0), cx1 = Math.min(gW-1, ((maxX - x0)/gridCell)|0);
    const cz0 = Math.max(0, ((minZ - z0)/gridCell)|0), cz1 = Math.min(gH-1, ((maxZ - z0)/gridCell)|0);
    for (let czi = cz0; czi <= cz1; czi++) for (let cxi = cx0; cxi <= cx1; cxi++) {
      const wx = x0 + (cxi+0.5)*gridCell, wz = z0 + (czi+0.5)*gridCell;
      if (pointInPoly(wx, wz, poly)) roadMask[czi*gW + cxi] = 1;
    }
  }

  // Carve bridges back out of the collision grid so decks stay drivable. A deck can
  // cross NEIGHBOUR tiles (owner-rendered), so carve every built tile it touches.
  const carve = (br) => {
    for (const p of br.pts) {
      const tt = tileAt(p.x, p.z);
      if (!tt || !tt.grid) { if (!inTile(p.x, p.z)) continue; }
      const g = (tt && tt.grid) ? tt : { grid, gMinX: x0, gMinZ: z0, gW, gH };
      if (!g.grid) continue;
      const r = br.hw + 2.5;
      const cx0 = Math.max(0, ((p.x - r - g.gMinX)/gridCell)|0), cx1 = Math.min(g.gW-1, ((p.x + r - g.gMinX)/gridCell)|0);
      const cz0 = Math.max(0, ((p.z - r - g.gMinZ)/gridCell)|0), cz1 = Math.min(g.gH-1, ((p.z + r - g.gMinZ)/gridCell)|0);
      for (let czi = cz0; czi <= cz1; czi++) for (let cxi = cx0; cxi <= cx1; cxi++) g.grid[czi*g.gW + cxi] = 0;
    }
  };
  tile.grid = grid; tile.roadMask = roadMask;
  for (const br of tile.bridges) carve(br);
  // ...and carve decks OWNED BY NEIGHBOURS that reach into this fresh grid
  for (const t of tiles.values()) {
    if (t === tile || t.state !== 'built') continue;
    for (const br of t.bridges) {
      if (br.pts.some(p => inTile(p.x, p.z))) carve(br);
    }
  }
}
