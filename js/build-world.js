// SimDrive — build-world.js
// buildWorld(): assemble the whole city from OSM data for a chosen area
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

function clearWorld() {
  worldGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  scene.remove(worldGroup);
  worldGroup = new THREE.Group(); scene.add(worldGroup);
  for (const n of NPCS) {} // meshes were in worldGroup, already removed
  NPCS = [];
}

function buildWorld(data, lat0, lon0, radiusMi, heightAt, overture, playMi) {
  clearWorld();
  terrain = heightAt || (() => 0);
  bridges = [];
  wallSegs = null;                         // rebuild bridge rails + highway barriers for this area
  const mPerLat = 111320, mPerLon = 111320 * Math.cos(lat0 * Math.PI/180);
  const toXZ = (lat, lon) => ({ x: (lon - lon0) * mPerLon, z: -((lat - lat0) * mPerLat) });
  const half = radiusMi * MILE;          // RENDER extent — real map data covers the play area + a skirt
  // The player is fenced into the chosen square (playMi), but we render the REAL surrounding
  // streets/buildings out to `half` so the edge looks genuine and just fades into the haze.
  // The skirt (half − playHalf) is wider than the fog distance, so the true data edge is never seen.
  const playHalf = (playMi || radiusMi) * MILE;
  fenceHalf = playHalf;

  // ---- ground (subdivided + displaced by the terrain heightfield) ----
  const gsz = half * 2 + 200;
  const groundMat = new THREE.MeshLambertMaterial({ color: 0x6f9b4a }); // grass green base; OSM parks draw a brighter green on top
  const segs = Math.min(256, Math.max(80, Math.round(gsz / 9)));
  groundSize = gsz; groundSeg = segs;            // so surfaceHeight() matches this mesh exactly
  const gGeo = new THREE.PlaneGeometry(gsz, gsz, segs, segs);
  gGeo.rotateX(-Math.PI/2);
  const gp = gGeo.attributes.position;
  for (let i = 0; i < gp.count; i++) gp.setY(i, terrain(gp.getX(i), gp.getZ(i)) - 0.15);
  gp.needsUpdate = true; gGeo.computeVertexNormals();
  const groundMesh = new THREE.Mesh(gGeo, groundMat);
  groundMesh.receiveShadow = true; worldGroup.add(groundMesh);

  // ---- sort elements ----
  const roadPolys = [], buildingPolys = [], waterPolys = [], waterLines = [], greenPolys = [], residentialPolys = [], parkingPolys = [];
  const treePoints = [], treedPolys = []; // mapped trees + wooded areas to scatter foliage in
  const signalNodes = [], stopNodes = [];  // traffic lights & stop signs
  const GREEN_LEISURE = /park|garden|pitch|golf_course|playground|recreation_ground/;
  const GREEN_LANDUSE = /grass|forest|meadow|recreation_ground|village_green|cemetery|farmland|orchard|allotments/;
  const GREEN_NATURAL = /wood|grassland|scrub/;
  const WATERWAY_W = { river: 16, canal: 9, stream: 4, ditch: 2.5, drain: 2.5 };  // realistic widths: 34 m "river" overshot real creeks (Monocacy) and spilled past bridge decks

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
      if (t.natural === 'water' || t.water || t.waterway === 'riverbank') waterPolys.push(ring);
      else if (t.amenity === 'parking') parkingPolys.push(ring);
      else if (t.landuse === 'residential') residentialPolys.push(ring);
      else { greenPolys.push(ring); if (t.natural === 'wood' || t.landuse === 'forest') treedPolys.push(ring); }
    }
  }

  for (const el of data.elements) {
    if (el.type === 'node' && el.tags) {
      const ht = el.tags.highway;
      if (el.tags.natural === 'tree') treePoints.push(toXZ(el.lat, el.lon));
      else if (ht === 'traffic_signals') signalNodes.push(toXZ(el.lat, el.lon));
      else if (ht === 'stop') stopNodes.push(toXZ(el.lat, el.lon));
      continue;
    }
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const pts = el.geometry.map(g => toXZ(g.lat, g.lon));
    const t = el.tags || {};
    if (t.highway && DRIVABLE.has(t.highway)) {
      if (t.tunnel && t.tunnel !== 'no') continue; // don't paint tunnels on the surface
      if (t.service === 'parking_aisle') continue; // these are covered by the paved parking lot below — don't draw a road tangle
      roadPolys.push({ pts, w: ROAD_WIDTH[t.highway] || 6.5, bridge: !!(t.bridge && t.bridge !== 'no'), name: t.name });
    }
    else if (t.amenity === 'parking') parkingPolys.push(pts);
    else if (t.building) buildingPolys.push({ pts, t });
    else if (t.natural === 'water' || t.water || t.waterway === 'riverbank') waterPolys.push(pts);
    else if (t.waterway && WATERWAY_W[t.waterway]) waterLines.push({ pts, w: WATERWAY_W[t.waterway] });
    else if (t.landuse === 'residential') residentialPolys.push(pts);
    else if (GREEN_LEISURE.test(t.leisure || '') || GREEN_LANDUSE.test(t.landuse || '') || GREEN_NATURAL.test(t.natural || '')) {
      greenPolys.push(pts);
      if (t.natural === 'wood' || t.natural === 'scrub' || t.landuse === 'forest') treedPolys.push(pts);
    }
  }

  // Overture buildings (richer + real heights) replace the sparse OSM footprints when available.
  if (overture && overture.length) {
    buildingPolys.length = 0;
    for (const b of overture) {
      const pts = b.ll.map(([lo, la]) => toXZ(la, lo));
      buildingPolys.push({ pts, t: { height: b.height ? String(b.height) : '' } });
    }
  }

  // Wide waterways (rivers/canals) are mapped as LINES in OSM and render as broad DRAPED ribbons
  // (visible water following the channel). They are invisible to the polygon clearance system, so
  // bridges/roads/the car weren't lifted above them. We can't just give them a single FLAT level:
  // a descending river either sinks below ground (no water) or, where a crossing sits above the
  // river's low point, the draped ribbon rises over a flat-based deck (bridge submerged). So build
  // a DRAPED water-height grid that mirrors the ribbon (surfaceHeight-0.02) and feed it into
  // waterYAt — clearance then tracks the SAME level the ribbon is drawn at, everywhere. O(1)
  // lookup, so it's cheap for the per-cell sidewalk pass and the per-frame car height.
  const rvCell = 3, rvMinX = -gsz/2, rvMinZ = -gsz/2;
  const rvNx = Math.ceil(gsz / rvCell) + 1, rvNz = Math.ceil(gsz / rvCell) + 1;
  const rvGrid = new Float32Array(rvNx * rvNz).fill(-Infinity);
  for (const wl of waterLines) {
    if (wl.w < 8 || wl.pts.length < 2) continue;          // only wide rivers/canals get clearance
    const hw = wl.w / 2 + 1, dd = densify(wl.pts, rvCell);
    for (const p of dd) {
      const cx0 = Math.max(0, ((p.x - hw - rvMinX) / rvCell) | 0), cx1 = Math.min(rvNx - 1, ((p.x + hw - rvMinX) / rvCell) | 0);
      const cz0 = Math.max(0, ((p.z - hw - rvMinZ) / rvCell) | 0), cz1 = Math.min(rvNz - 1, ((p.z + hw - rvMinZ) / rvCell) | 0);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
        const wx = rvMinX + (cx + 0.5) * rvCell, wz = rvMinZ + (cz + 0.5) * rvCell;
        if ((wx - p.x) ** 2 + (wz - p.z) ** 2 > hw * hw) continue;
        const wy = surfaceHeight(wx, wz) - 0.02;           // matches the draped ribbon at this spot
        const idx = cz * rvNx + cx; if (wy > rvGrid[idx]) rvGrid[idx] = wy;
      }
    }
  }
  const rvAt = (x, z) => { const cx = ((x - rvMinX) / rvCell) | 0, cz = ((z - rvMinZ) / rvCell) | 0; if (cx < 0 || cz < 0 || cx >= rvNx || cz >= rvNz) return -Infinity; return rvGrid[cz * rvNx + cx]; };

  // Flat water surface level for a polygon. Large rivers/lakes extend many km OFF the
  // loaded map; their distant (much lower) vertices would drag a single global-min level
  // far below the local water — sinking the river underground here and leaving bridges
  // floating high over where the water should be (and, where the polygon interior dips
  // below its in-area vertices, the inverse: water drawn ABOVE the local road). So derive
  // the level from only the vertices INSIDE the loaded world (fall back to all of them if
  // none are in-bounds).
  const wbound = gsz / 2 + 100;
  const waterLevel = (poly) => {
    let lvl = Infinity, any = false;
    for (const p of poly) if (Math.abs(p.x) <= wbound && Math.abs(p.z) <= wbound) { lvl = Math.min(lvl, terrain(p.x, p.z)); any = true; }
    if (!any) for (const p of poly) lvl = Math.min(lvl, terrain(p.x, p.z));
    return lvl;
  };

  // ---- green areas & water (filled shapes). flat=true keeps water level. ----
  function fillShapes(polys, color, yoff, flat) {
    const geos = [];
    for (const pts of polys) {
      if (pts.length < 3) continue;
      // shape Z is negated to cancel the mirror introduced by rotateX below
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
    const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
    mesh.receiveShadow = true; worldGroup.add(mesh);
  }
  fillShapes(greenPolys, 0x6fa942, 0.06, false);    // brighter SimCity green grass/parks/woods
  fillShapes(parkingPolys, 0x55585f, 0.13, false);  // parking lots: flat asphalt, a touch lighter than the streets
  fillShapes(waterPolys, 0x2f7fc0, 0.1, true);      // lakes/rivers: flat, bright, sits in the basin

  // rivers/streams mapped as lines -> draped blue ribbons (VISIBLE water, follows the channel)
  const waterLinePos = [];
  for (const wl of waterLines) ribbon(wl.pts, wl.w / 2, waterLinePos, (x, z) => surfaceHeight(x, z) - 0.02);
  if (waterLinePos.length) worldGroup.add(flatMesh(waterLinePos, 0x2f7fc0, false));

  // ---- sidewalks + roads + lane markings + bridges ----
  // Round sharp bends in every road so turns are smooth curves (no jagged miter spikes),
  // and the ribbon/sidewalk/mask/graph all build from the same smoothed centreline.
  for (const r of roadPolys) r.pts = roundCorners(r.pts, 2);
  const roadPos = [], dashPos = [], bridgePos = [], roadLines = [];
  // Roads/sidewalks never sink below the water surface — where the DEM dips below the
  // water near a shore, the road rides just over it instead of being drawn submerged.
  // (waterYAt is defined just below; these closures only run later, in the road loop.)
  const roadY = (x, z) => { const s = surfaceHeight(x, z) + 0.18, w = waterYAt(x, z); return w > -Infinity && w + 0.6 > s ? w + 0.6 : s; };
  // (sidewalks are built below, after the road loop, as one unified SDF band — see buildSidewalks)

  // Water surface levels (matching fillShapes) so bridges can be lifted to clear the water.
  const waterSurf = waterPolys.filter(p => p.length >= 3).map(poly => {
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const p of poly) { if (p.x<minX)minX=p.x; if (p.x>maxX)maxX=p.x; if (p.z<minZ)minZ=p.z; if (p.z>maxZ)maxZ=p.z; }
    return { y: waterLevel(poly) + 0.1, minX, maxX, minZ, maxZ, poly };
  });
  // Lenient (bbox) test: the water mesh is drawn FLAT across the whole poly, so a bridge
  // crossing anywhere over that body must clear its surface even if a point sits just off
  // the polygon edge. Strict point-in-poly missed river crossings and left decks submerged.
  const waterYAt = (x, z) => { let best = rvAt(x, z);   // wide rivers (draped grid) + lakes (flat polys)
    for (const w of waterSurf) if (x>=w.minX && x<=w.maxX && z>=w.minZ && z<=w.maxZ) best = Math.max(best, w.y);
    return best; };
  waterClampFn = waterYAt;   // so driveHeight keeps the car on the water surface, not the riverbed

  // True test for VISIBLE water at a point (the river ribbon + the actual lake polygon shape) —
  // NOT the lenient bbox waterYAt (a big off-map river's bbox covers the whole map, so waterYAt is
  // never -Infinity and can't locate a shoreline).
  const nearRenderedWater = (x, z) => {
    if (rvAt(x, z) > -Infinity) return true;
    for (const w of waterSurf) if (x>=w.minX && x<=w.maxX && z>=w.minZ && z<=w.maxZ && pointInPoly(x, z, w.poly)) return true;
    return false;
  };
  renderedWaterFn = nearRenderedWater;   // expose to driveHeight's location-aware deck floor
  // Extend a TRUE bridge end outward (along its own direction) until it's past the water + a few
  // metres, so the ramp lands on DRY GROUND instead of ending mid-river. OSM bridge ways often stop
  // right at the bank while the (wide) water ribbon spills past, leaving the ramp in the water.
  const extendBridgeEnd = (bpts, atStart) => {
    const p0 = atStart ? bpts[0] : bpts[bpts.length - 1];
    const p1 = atStart ? bpts[1] : bpts[bpts.length - 2];
    let dx = p0.x - p1.x, dz = p0.z - p1.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    let ext = 3;
    for (let dd = 2; dd <= 26; dd += 2) { ext = dd; if (!nearRenderedWater(p0.x + dx * dd, p0.z + dz * dd)) { ext = dd + 3; break; } }
    return { x: p0.x + dx * ext, z: p0.z + dz * ext };
  };

  // pre-pass: count shared endpoints among bridge ways. An endpoint shared by 2+ bridge ways
  // is an internal JOINT (deck stays elevated); an endpoint used by only one is a TRUE END
  // (deck must ramp down to meet the normal road, so the bridge doesn't float).
  const ekey = (x, z) => Math.round(x) + '_' + Math.round(z);
  const endpointCount = new Map();
  for (const r of roadPolys) {
    if (!r.bridge || r.pts.length < 2) continue;
    for (const e of [r.pts[0], r.pts[r.pts.length-1]]) endpointCount.set(ekey(e.x, e.z), (endpointCount.get(ekey(e.x, e.z)) || 0) + 1);
  }
  const isJoint = (x, z) => (endpointCount.get(ekey(x, z)) || 0) >= 2;
  // A multi-span viaduct (e.g. the Hill to Hill Bridge) is several OSM bridge ways joined end to
  // end. Each way used to compute its OWN plateau from its local terrain, so adjacent spans met at
  // a shared joint at DIFFERENT heights -> a stepped/disconnected deck. Group connected bridge ways
  // (union-find over shared endpoints) and give the whole structure ONE plateau, so the deck runs
  // continuously and only ramps down to street level at the group's TRUE ends.
  const uf = new Map();
  const ufFind = k => { while (uf.get(k) !== k) { uf.set(k, uf.get(uf.get(k))); k = uf.get(k); } return k; };
  const bridgeWays = roadPolys.filter(r => r.bridge && r.pts.length >= 2);
  for (const r of bridgeWays) {
    const ka = ekey(r.pts[0].x, r.pts[0].z), kb = ekey(r.pts[r.pts.length-1].x, r.pts[r.pts.length-1].z);
    if (!uf.has(ka)) uf.set(ka, ka);
    if (!uf.has(kb)) uf.set(kb, kb);
    uf.set(ufFind(ka), ufFind(kb));
  }
  const groupPlateau = new Map();   // group root -> shared deck plateau
  for (const r of bridgeWays) {
    const dd = densify(r.pts, 3);
    let lowest = Infinity, spanLen = 0;
    for (let i = 0; i < dd.length; i++) { lowest = Math.min(lowest, terrain(dd[i].x, dd[i].z)); if (i > 0) spanLen += Math.hypot(dd[i].x - dd[i-1].x, dd[i].z - dd[i-1].z); }
    let waterY = -Infinity; for (const pt of dd) { const wy = waterYAt(pt.x, pt.z); if (wy > waterY) waterY = wy; }
    if (!(spanLen >= 11 || waterY > -Infinity)) continue;   // this way won't be a raised deck
    const clearance = Math.min(6, Math.max(spanLen >= 11 ? 3 : 1.5, spanLen * 0.06));
    const pl = Math.max(waterY, lowest) + clearance;
    const root = ufFind(ekey(r.pts[0].x, r.pts[0].z));
    groupPlateau.set(root, Math.max(groupPlateau.get(root) ?? -Infinity, pl));
  }
  const plateauFor = (x, z) => groupPlateau.get(ufFind(ekey(x, z)));
  // Is a point on a normal (non-bridge) road surface? Used so bridge supports below don't
  // land in the middle of a cross-street. Distance from the point to each road centreline
  // vs that road's half-width plus the pillar footprint (~1.2 m) and a little slack.
  const distToSeg = (px, pz, ax, az, bx, bz) => {
    const dx = bx-ax, dz = bz-az, l2 = dx*dx + dz*dz;
    let t = l2 ? ((px-ax)*dx + (pz-az)*dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax+dx*t), pz - (az+dz*t));
  };
  const onStreet = (x, z) => {
    for (const r of roadPolys) {
      if (r.bridge || r.pts.length < 2) continue;
      const margin = r.w/2 + 1.7;
      for (let i = 0; i < r.pts.length-1; i++)
        if (distToSeg(x, z, r.pts[i].x, r.pts[i].z, r.pts[i+1].x, r.pts[i+1].z) < margin) return true;
    }
    return false;
  };
  for (const r of roadPolys) {
    const pts = r.pts; roadLines.push(pts); const hw = r.w / 2;
    if (r.bridge) {
      const dd = densify(pts, 3);                          // finer -> smoother ramps
      const a = pts[0], b = pts[pts.length-1];
      let lowest = Infinity, spanLen = 0;
      for (let i = 0; i < dd.length; i++) {
        lowest = Math.min(lowest, terrain(dd[i].x, dd[i].z));
        if (i > 0) spanLen += Math.hypot(dd[i].x - dd[i-1].x, dd[i].z - dd[i-1].z);
      }
      let waterY = -Infinity; for (const pt of dd) { const wy = waterYAt(pt.x, pt.z); if (wy > waterY) waterY = wy; }
      // Build a raised deck for any real-length span OR ANY crossing over water — so even a
      // SHORT tagged bridge over a narrow creek arcs clearly above the water (and is added to
      // bridges[] so the car RIDES the deck). The old `spanLen >= 11`-only gate left creek
      // bridges flat at water level.
      if (spanLen >= 11 || waterY > -Infinity) {
        // gentle clearance for short creek spans, full clearance for real bridges
        const clearance = Math.min(6, Math.max(spanLen >= 11 ? 3 : 1.5, spanLen * 0.06));
        // shared plateau for the whole connected structure (falls back to this way's own value)
        const plateau = plateauFor(a.x, a.z) ?? (Math.max(waterY, lowest) + clearance);   // deck top across the middle
        // Deck ENDS exactly match the approach-road surface (roadY) at the bridge endpoints, so
        // the deck joins the street with NO step; the smooth arc lifts the middle to clear the
        // water. roadY itself never sits below water, so the whole arc (>= its ends) clears the
        // river — no per-point "floor" needed (that floor stepped the deck at the shoreline and
        // lifted dry ramp ends off the road). `-0.2` cancels deckFn's deck-thickness offset so
        // the deck TOP lands on the road surface, not 0.2 m above it.
        const eStart = isJoint(a.x, a.z) ? plateau : roadY(a.x, a.z) - 0.2;
        const eEnd   = isJoint(b.x, b.z) ? plateau : roadY(b.x, b.z) - 0.2;
        const deckFn = (x, z, frac) => { const base = eStart + (eEnd - eStart) * frac; return base + Math.max(0, plateau - base) * bridgeBump(frac) + 0.2; };
        ribbon(pts, hw, roadPos, deckFn);
        bridgeStructure(pts, hw, deckFn, bridgePos, onStreet);
        bridges.push({ pts: dd, hw, eStart, eEnd, plateau, waterY });
      } else {
        ribbon(pts, hw, roadPos, roadY);
      }
    } else {
      ribbon(pts, hw, roadPos, roadY);             // asphalt
      if (r.w >= 7) {                              // dashed centre line on bigger streets
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i+1];
          let dx = b.x - a.x, dz = b.z - a.z; const len = Math.hypot(dx, dz) || 1;
          const ux = dx/len, uz = dz/len, px = -uz*0.2, pz = ux*0.2;
          for (let d = 2; d < len - 2; d += 7) {
            const t1 = Math.min(d + 3, len - 1);
            const ax = a.x+ux*d, az = a.z+uz*d, bx = a.x+ux*t1, bz = a.z+uz*t1;
            const ya = surfaceHeight(ax, az) + 0.22, yb = surfaceHeight(bx, bz) + 0.22;
            dashPos.push(
              ax+px, ya, az+pz,  bx-px, yb, bz-pz,  ax-px, ya, az-pz,
              ax+px, ya, az+pz,  bx+px, yb, bz+pz,  bx-px, yb, bz-pz
            );
          }
        }
      }
    }
  }
  buildSidewalks(roadPolys, gsz, waterYAt); // ONE unified band offset from the whole road network
  if (roadPos.length) worldGroup.add(flatMesh(roadPos, 0x40434b, false));
  if (dashPos.length) { const m = flatMesh(dashPos, 0xd9c25a, false); m.material.emissive = new THREE.Color(0x3a3318); worldGroup.add(m); }
  if (bridgePos.length) { const m = flatMesh(bridgePos, 0x8a8f98, true); m.material.side = THREE.DoubleSide; m.castShadow = true; worldGroup.add(m); }
  buildGraph(roadLines);

  // ---- buildings (real footprints -> window-tiled walls + flat roofs) ----
  const wallBuckets = FACADES.map(() => []); const roofGeos = [], collisionPolys = [];
  for (const b of buildingPolys) {
    let pts = b.pts;
    if (pts.length > 2 && pts[0].x === pts[pts.length-1].x && pts[0].z === pts[pts.length-1].z) pts = pts.slice(0, -1);
    if (pts.length < 3) continue;
    let h = parseFloat(b.t.height);
    if (!h && b.t['building:levels']) h = parseFloat(b.t['building:levels']) * 3.3;
    // Real Overture/OSM heights were rendering ~1/3 of life-size; scale the data-derived
    // heights up so buildings read at their true height (fallback below is already game-tuned).
    if (h && !isNaN(h)) h *= BUILDING_HEIGHT_SCALE;
    if (!h || isNaN(h)) h = 9 + (Math.abs((pts[0].x * 7 + pts[0].z * 13) | 0) % 5) * 3.3;
    // Some Overture/OSM heights are far too low for the footprint (pancake buildings).
    // Floor the height by footprint size — a big downtown footprint is never 1 storey.
    let area2 = 0; for (let i = 0, j = pts.length-1; i < pts.length; j = i++) area2 += (pts[j].x + pts[i].x) * (pts[j].z - pts[i].z);
    const minH = Math.min(15, 5 + Math.sqrt(Math.abs(area2) / 2) * 0.2);
    h = Math.min(Math.max(h, minH), 600);
    const col = new THREE.Color(BUILDING_PAL[Math.abs((pts[0].x*3 + pts[0].z*5)|0) % BUILDING_PAL.length]);
    // pick a facade style by building size (+ a stable hash) so they're not all skinned alike
    const hash = Math.abs((pts[0].x*13.1 + pts[0].z*7.7) | 0);
    let vi;
    if (h > 50)      vi = (hash % 3 === 0) ? 4 : 0;          // very tall: some glass towers, mostly office
    else if (h > 26) vi = (hash % 4 === 0) ? 4 : 0;          // tall: office, occasional glass
    else if (h > 14) vi = [0, 2, 2, 5][hash % 4];            // mid: office / commercial / brick
    else             vi = [1, 1, 5, 3][hash % 4];            // low: residential / brick / industrial
    const CELL_W = FACADES[vi].cw, CELL_H = FACADES[vi].ch;

    // base on the terrain: use the lowest footprint corner, then embed a few metres
    // so the building doesn't float on the downhill side of a slope.
    let baseY = Infinity;
    for (const p of pts) baseY = Math.min(baseY, terrain(p.x, p.z));
    baseY -= 3;
    const yBot = baseY, yTop = baseY + h;

    // walls: one quad per footprint edge, UVs tiling the window texture
    const wp = [], wuv = [], wc = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], bb = pts[(i+1) % pts.length];
      const elen = Math.hypot(bb.x - a.x, bb.z - a.z); if (elen < 0.05) continue;
      // whole number of window columns per edge & floors up -> no clipped/partial windows,
      // rows line up across faces and the top edge lands on a full floor
      const u1 = Math.max(1, Math.round(elen / CELL_W)), v1 = Math.max(1, Math.round((yTop - yBot) / CELL_H));
      const push = (px, py, pz, u, v) => { wp.push(px, py, pz); wuv.push(u, v); wc.push(col.r, col.g, col.b); };
      push(a.x, yBot, a.z, 0, 0);   push(bb.x, yBot, bb.z, u1, 0);  push(bb.x, yTop, bb.z, u1, v1);
      push(a.x, yBot, a.z, 0, 0);   push(bb.x, yTop, bb.z, u1, v1); push(a.x, yTop, a.z, 0, v1);
    }
    if (wp.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(wuv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(wc, 3));
      wallBuckets[vi].push(g);
    }

    // roof: triangulated footprint at height h (shape Z negated to cancel rotateX mirror)
    const shape = new THREE.Shape();
    shape.moveTo(pts[0].x, -pts[0].z);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].z);
    const rg = new THREE.ShapeGeometry(shape); rg.rotateX(-Math.PI/2);
    const pa = rg.attributes.position.array; for (let i = 1; i < pa.length; i += 3) pa[i] = yTop;
    if (rg.attributes.uv) rg.deleteAttribute('uv');
    const rn = rg.attributes.position.count, rc = new Float32Array(rn * 3), rcol = col.clone().multiplyScalar(0.82);
    for (let i = 0; i < rn; i++) { rc[i*3] = rcol.r; rc[i*3+1] = rcol.g; rc[i*3+2] = rcol.b; }
    rg.setAttribute('color', new THREE.BufferAttribute(rc, 3));
    roofGeos.push(rg);
    collisionPolys.push(pts);
  }
  wallBuckets.forEach((geos, vi) => {
    if (!geos.length) return;
    const merged = mergeGeometries(geos, false); merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ map: FACADES[vi].tex, vertexColors: true, side: THREE.DoubleSide }));
    mesh.castShadow = true; mesh.receiveShadow = true; worldGroup.add(mesh);
  });
  if (roofGeos.length) {
    const merged = mergeGeometries(roofGeos, false); merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    mesh.castShadow = true; mesh.receiveShadow = true; worldGroup.add(mesh);
  }

  buildHouses(residentialPolys, buildingPolys, roadLines);
  buildTrees(treePoints, treedPolys);
  signPosts = [];                       // reset the shared sign-pole footprint registry
  buildTrafficLights(signalNodes, roadPolys);
  buildStopSigns(stopNodes, roadPolys);
  buildStreetSigns(roadPolys);

  // ---- collision grid ----
  gridMinX = -gsz/2; gridMinZ = -gsz/2;
  gridW = Math.ceil(gsz / gridCell); gridH = Math.ceil(gsz / gridCell);
  grid = new Uint8Array(gridW * gridH);
  function rasterize(polys) {
    for (const poly of polys) {
      let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (const p of poly) { if (p.x<minX)minX=p.x; if (p.x>maxX)maxX=p.x; if (p.z<minZ)minZ=p.z; if (p.z>maxZ)maxZ=p.z; }
      const cx0 = Math.max(0, ((minX - gridMinX)/gridCell)|0), cx1 = Math.min(gridW-1, ((maxX - gridMinX)/gridCell)|0);
      const cz0 = Math.max(0, ((minZ - gridMinZ)/gridCell)|0), cz1 = Math.min(gridH-1, ((maxZ - gridMinZ)/gridCell)|0);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
        const wx = gridMinX + (cx+0.5)*gridCell, wz = gridMinZ + (cz+0.5)*gridCell;
        if (pointInPoly(wx, wz, poly)) grid[cz*gridW + cx] = 1;
      }
    }
  }
  rasterize(collisionPolys);
  rasterize(waterPolys.filter(p => p.length >= 3));

  // ---- road mask: mark the drivable pavement so the car can be kept on the road ----
  roadMask = new Uint8Array(gridW * gridH);
  function stampRoad(centerline, hw) {
    const r = hw + 2.0, r2 = r * r;                 // road half-width + a little shoulder
    const dd = densify(centerline, gridCell);
    for (let i = 0; i < dd.length - 1; i++) {
      const a = dd[i], b = dd[i+1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx*dx + dz*dz || 1;
      const cx0 = Math.max(0, ((Math.min(a.x,b.x) - r - gridMinX)/gridCell)|0), cx1 = Math.min(gridW-1, ((Math.max(a.x,b.x) + r - gridMinX)/gridCell)|0);
      const cz0 = Math.max(0, ((Math.min(a.z,b.z) - r - gridMinZ)/gridCell)|0), cz1 = Math.min(gridH-1, ((Math.max(a.z,b.z) + r - gridMinZ)/gridCell)|0);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
        const wx = gridMinX + (cx+0.5)*gridCell, wz = gridMinZ + (cz+0.5)*gridCell;
        let t = ((wx-a.x)*dx + (wz-a.z)*dz)/l2; t = Math.max(0, Math.min(1, t));
        const px = a.x + dx*t, pz = a.z + dz*t, d2 = (wx-px)*(wx-px) + (wz-pz)*(wz-pz);
        if (d2 <= r2) roadMask[cz*gridW + cx] = 1;
      }
    }
  }
  for (const r of roadPolys) stampRoad(r.pts, r.w / 2);
  // parking lots are drivable pavement too: mark every cell inside the lot polygon
  for (const poly of parkingPolys) {
    if (poly.length < 3) continue;
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const p of poly) { if (p.x<minX)minX=p.x; if (p.x>maxX)maxX=p.x; if (p.z<minZ)minZ=p.z; if (p.z>maxZ)maxZ=p.z; }
    const cx0 = Math.max(0, ((minX - gridMinX)/gridCell)|0), cx1 = Math.min(gridW-1, ((maxX - gridMinX)/gridCell)|0);
    const cz0 = Math.max(0, ((minZ - gridMinZ)/gridCell)|0), cz1 = Math.min(gridH-1, ((maxZ - gridMinZ)/gridCell)|0);
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      const wx = gridMinX + (cx+0.5)*gridCell, wz = gridMinZ + (cz+0.5)*gridCell;
      if (pointInPoly(wx, wz, poly)) roadMask[cz*gridW + cx] = 1;
    }
  }

  // Carve bridges back out of the collision grid so you can drive over the water/valley
  // they span (otherwise the water cells underneath block you mid-bridge).
  for (const br of bridges) {
    for (const p of br.pts) {
      const r = br.hw + 2.5;
      const cx0 = Math.max(0, ((p.x - r - gridMinX)/gridCell)|0), cx1 = Math.min(gridW-1, ((p.x + r - gridMinX)/gridCell)|0);
      const cz0 = Math.max(0, ((p.z - r - gridMinZ)/gridCell)|0), cz1 = Math.min(gridH-1, ((p.z + r - gridMinZ)/gridCell)|0);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) grid[cz*gridW + cx] = 0;
    }
  }

  // ---- highway barriers: wall the edges of big divided highways so you must use exits ----
  // Each edge segment gets a jersey barrier UNLESS a connecting road (ramp / cross-street)
  // reaches the edge there — those openings are the on/off ramps. We detect a connection by
  // sampling roadMask just BEYOND the highway's own shoulder: pavement there = a real exit.
  const BARRIER_MIN_W = 11;                   // motorway(13) + trunk(12); arterials stay open
  const BARRIER_H = 0.85, barrierPos = [];
  for (const r of roadPolys) {
    if (r.bridge || r.w < BARRIER_MIN_W) continue;   // bridges get rails instead
    const hw = r.w / 2, dd = densify(r.pts, 4);
    if (dd.length < 2) continue;
    const { Lx, Lz, Rx, Rz } = offsets(dd, hw + 0.5);   // barrier line just outside the paint
    for (const [Ex, Ez] of [[Lx, Lz], [Rx, Rz]]) {
      for (let i = 0; i < dd.length - 1; i++) {
        const mx = (Ex[i] + Ex[i+1]) / 2, mz = (Ez[i] + Ez[i+1]) / 2;     // edge-segment midpoint
        let ox = mx - (dd[i].x + dd[i+1].x) / 2, oz = mz - (dd[i].z + dd[i+1].z) / 2; // outward from centerline
        const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
        if (onRoad(mx + ox*3.0, mz + oz*3.0)) continue;  // a road leads out here -> leave the gap (exit)
        const ay = terrain(Ex[i], Ez[i]) + 0.1, by = terrain(Ex[i+1], Ez[i+1]) + 0.1;
        barrierPos.push(
          Ex[i],ay,Ez[i], Ex[i+1],by,Ez[i+1], Ex[i+1],by+BARRIER_H,Ez[i+1],
          Ex[i],ay,Ez[i], Ex[i+1],by+BARRIER_H,Ez[i+1], Ex[i],ay+BARRIER_H,Ez[i]);
        addWallSeg(Ex[i],Ez[i], Ex[i+1],Ez[i+1], Math.min(ay,by), BARRIER_H + 1.5);
      }
    }
  }
  if (barrierPos.length) { const m = flatMesh(barrierPos, 0xb8b4a8, true); m.material.side = THREE.DoubleSide; worldGroup.add(m); }

  // ---- spawn: resume the saved position on a refresh, else nearest road node to center ----
  if (restorePos && isFinite(restorePos.x) && Math.abs(restorePos.x) < gsz/2 && Math.abs(restorePos.z) < gsz/2) {
    player.x = restorePos.x; player.z = restorePos.z; player.ang = restorePos.ang || 0;
    restorePos = null;
  } else {
    let best = null, bd = 1e18;
    for (const nd of roadNodes) { const d = nd.x*nd.x + nd.z*nd.z; if (d < bd) { bd = d; best = nd; } }
    if (best) {
      player.x = best.x; player.z = best.z;
      const nb = best.nb[0]; player.ang = nb ? Math.atan2(nb.z - best.z, nb.x - best.x) : 0;
    } else { player.x = 0; player.z = 0; player.ang = 0; }
  }
  player.speed = 0; player.vy = 0;
  player.y = driveHeight(player.x, player.z);   // seed the resting level (deck if spawned on a bridge)

  spawnNPCs(Math.min(14, Math.max(4, Math.floor(roadNodes.length / 60))));

  buildMinimap(roadLines, gsz);

  worldReady = true;
  window.__dbg = { player, bridges, driveHeight, surfaceHeight, terrain, waterSurf, waterYAt, roadPolys, waterLines, parkingPolys, gsz };
}
