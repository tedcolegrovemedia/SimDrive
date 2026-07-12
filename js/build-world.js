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
  waterTexes.length = 0;   // old water-texture clones die with the world; stop animating them
}

// Clone a base canvas texture with a world-space repeat (metres per tile). ShapeGeometry
// UVs are in metres, so repeat = 1/m tiles the texture every m metres.
function tiledTex(base, m, worldMeters) {
  const t = base.clone(); t.needsUpdate = true;
  const r = worldMeters ? worldMeters / m : 1 / m;   // PlaneGeometry UVs span 0..1 -> scale by world size
  t.repeat.set(r, r);
  return t;
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
  // grass green base tints the near-white grass texture; OSM parks draw a brighter green on top
  const groundMat = new THREE.MeshLambertMaterial({ color: 0x7cab54, map: tiledTex(grassTex, 9, gsz) });
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
  const roadPolys = [], buildingPolys = [], partPolys = [], waterPolys = [], waterLines = [], greenPolys = [], residentialPolys = [], parkingPolys = [];
  const treePoints = [], treedPolys = [], scrubPolys = []; // mapped trees + wooded areas (trees) + scrub (bushes)
  const farmPolys = [], orchardPolys = [];  // farmland -> crop-row fields; orchards -> planted tree grids
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
    // Simple-3D building parts (checked BEFORE t.building: a part is not its own building):
    // towers/steeples/wings with their own height + roof shape — these replace the parent
    // outline so landmark buildings render as multiple masses instead of one box.
    else if (t['building:part'] && t['building:part'] !== 'no') partPolys.push({ pts, t });
    else if (t.building) buildingPolys.push({ pts, t });
    else if (t.natural === 'water' || t.water || t.waterway === 'riverbank') waterPolys.push(pts);
    else if (t.waterway && WATERWAY_W[t.waterway]) waterLines.push({ pts, w: WATERWAY_W[t.waterway] });
    else if (t.landuse === 'residential') residentialPolys.push(pts);
    else if (t.landuse === 'farmland') farmPolys.push(pts);                       // crop rows, not lawn
    else if (t.landuse === 'orchard') { greenPolys.push(pts); orchardPolys.push(pts); } // planted tree grid
    else if (GREEN_LEISURE.test(t.leisure || '') || GREEN_LANDUSE.test(t.landuse || '') || GREEN_NATURAL.test(t.natural || '')) {
      greenPolys.push(pts);
      if (t.natural === 'wood' || t.landuse === 'forest') treedPolys.push(pts);
      else if (t.natural === 'scrub') scrubPolys.push(pts);   // scrub = bushes, not full trees
    }
  }

  // (Overture footprints are merged with the OSM tags in the buildings section below.)

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
  function fillShapes(polys, color, yoff, flat, tex, texM) {
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
    // ShapeGeometry UVs equal the shape's metre coordinates, so a 1/texM repeat tiles every texM metres
    const map = tex ? tiledTex(tex, texM) : null;
    const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, map }));
    mesh.receiveShadow = true; worldGroup.add(mesh);
    return mesh;
  }
  fillShapes(greenPolys, 0x7cb84f, 0.06, false, grassTex, 9);     // brighter SimCity green grass/parks/woods
  fillShapes(farmPolys, 0xc2b276, 0.05, false, cropTex, 14);      // wheat-tan worked fields with crop rows
  fillShapes(parkingPolys, 0x5d6168, 0.13, false, asphaltTex, 7); // parking lots: flat asphalt, a touch lighter than the streets
  const waterMesh = fillShapes(waterPolys, 0x3589cf, 0.1, true, waterTex, 16); // lakes/rivers: flat, bright, sits in the basin
  if (waterMesh) waterTexes.push(waterMesh.material.map);         // render loop scrolls it — water drifts

  // rivers/streams mapped as lines -> draped blue ribbons (VISIBLE water, follows the channel)
  const waterLinePos = [];
  for (const wl of waterLines) ribbon(wl.pts, wl.w / 2, waterLinePos, (x, z) => surfaceHeight(x, z) - 0.02);
  if (waterLinePos.length) {
    const t = waterTex.clone(); t.needsUpdate = true;   // own instance so offset animates independently
    const m = texMesh(waterLinePos, t, 1/16, 0x3589cf, false);  // texMesh UVs already scale to metres/16
    waterTexes.push(t);
    worldGroup.add(m);
  }

  // ---- sidewalks + roads + lane markings + bridges ----
  // Round sharp bends in every road so turns are smooth curves (no jagged miter spikes),
  // and the ribbon/sidewalk/mask/graph all build from the same smoothed centreline.
  for (const r of roadPolys) r.pts = roundCorners(r.pts, 2);
  const roadPos = [], dashPos = [], bridgePos = [], roadLines = [];
  // Dashed centre line along a polyline; yAt(x, z, fracAlongLine) gives the surface height
  // (surfaceHeight for streets, deckFn for bridge decks — decks without dashes read as voids).
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
  // ---- deck pre-pass: compute EVERY bridge deck's profile before any structure is built.
  // A bridge rail must open exactly where another pavement continues at deck level past
  // the edge (ramp merges, fork gores, parallel carriageways). The old approach — a radius
  // around junction nodes — opened far too much (whole interchange edges went railless)
  // and too little (long gores kept walls across ramps). With all decks known up front,
  // each rail segment can simply ask "is there other road surface at my height here?".
  const deckList = [];
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
    // cumulative arc length along the way -> frac for deckFn at any centreline point
    const cum = [0]; let total = 0;
    for (let i = 0; i < r.pts.length - 1; i++) { total += Math.hypot(r.pts[i+1].x-r.pts[i].x, r.pts[i+1].z-r.pts[i].z); cum.push(total); }
    let x0=1e9,x1=-1e9,z0=1e9,z1=-1e9;
    for (const p of r.pts) { if(p.x<x0)x0=p.x; if(p.x>x1)x1=p.x; if(p.z<z0)z0=p.z; if(p.z>z1)z1=p.z; }
    const entry = { raised: true, pts: r.pts, hw: r.w/2, dd, cum, total: total || 1,
                    eStart, eEnd, plateau, waterY, deckFn, bb: { x0, x1, z0, z1 } };
    deckList.push(entry); r._deck = entry;
  }
  // Highest OTHER deck surface covering (x,z), else -Infinity.
  const otherDeckAt = (x, z, exclude) => {
    let best = -Infinity;
    for (const d of deckList) {
      if (d === exclude) continue;
      const reach = d.hw + 1.9;
      if (x < d.bb.x0-reach || x > d.bb.x1+reach || z < d.bb.z0-reach || z > d.bb.z1+reach) continue;
      for (let i = 0; i < d.pts.length - 1; i++) {
        const a = d.pts[i], b = d.pts[i+1];
        const dx = b.x-a.x, dz = b.z-a.z, l2 = dx*dx + dz*dz;
        let t = l2 ? ((x-a.x)*dx + (z-a.z)*dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = a.x+dx*t, pz = a.z+dz*t;
        if (Math.hypot(x-px, z-pz) < reach) {
          const frac = (d.cum[i] + Math.sqrt(l2)*t) / d.total;
          best = Math.max(best, d.deckFn(px, pz, frac));
          break;
        }
      }
    }
    return best;
  };

  // Street level at a point: road-surface height of the nearest NON-BRIDGE road whose
  // pavement covers (x,z), else -Infinity. "Is on a street" = result > -Infinity; bridge
  // rails also compare the deck height against it to stay open at at-grade crossings.
  const streetLevelAt = (x, z) => {
    for (const r of roadPolys) {
      if (r.bridge || r.pts.length < 2) continue;
      const margin = r.w/2 + 1.9;
      for (let i = 0; i < r.pts.length-1; i++) {
        const a = r.pts[i], b = r.pts[i+1];
        const dx = b.x-a.x, dz = b.z-a.z, l2 = dx*dx + dz*dz;
        let t = l2 ? ((x-a.x)*dx + (z-a.z)*dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = a.x+dx*t, pz = a.z+dz*t;
        // roadY, not raw surfaceHeight: streets near water ride the water-clamped level
        // (River St sits 3+ m above the dipped creek-bank DEM)
        if (Math.hypot(x-px, z-pz) < margin) return roadY(px, pz);
      }
    }
    return -Infinity;
  };
  for (const r of roadPolys) {
    const pts = r.pts; roadLines.push(pts); const hw = r.w / 2;
    if (r.bridge) {
      // Deck profile (or "not raised") was computed in the pre-pass above; raised decks
      // exist for any real-length span OR ANY crossing over water — so even a SHORT tagged
      // bridge over a narrow creek arcs clearly above the water (and is added to bridges[]
      // so the car RIDES the deck). Deck ENDS exactly match the approach-road surface at
      // the endpoints (no step); the smooth arc lifts the middle to the shared plateau.
      const dk = r._deck;
      if (dk && dk.raised) {
        ribbon(pts, hw, roadPos, dk.deckFn);
        if (r.w >= 7) emitDashes(pts, (x, z, f) => dk.deckFn(x, z, f) + 0.06);  // decks get centre lines too
        bridgeStructure(pts, hw, dk.deckFn, bridgePos, streetLevelAt, (x, z) => otherDeckAt(x, z, dk));
        bridges.push({ pts: dk.dd, hw, eStart: dk.eStart, eEnd: dk.eEnd, plateau: dk.plateau, waterY: dk.waterY });
      } else {
        ribbon(pts, hw, roadPos, roadY);
      }
    } else {
      ribbon(pts, hw, roadPos, roadY);             // asphalt
      if (r.w >= 7) emitDashes(pts, (x, z) => surfaceHeight(x, z) + 0.22);  // centre line on bigger streets
    }
  }
  // Where a road ends in (or crosses) a parking lot, it must FLOW into the pavement —
  // the sidewalk band otherwise wraps the road tip and caps the lot entrance with a curb.
  // Scanline-rasterize the lot polygons into a coarse mask (cell-centre, even-odd rule).
  const PKC = 1.2, pkW = Math.ceil(gsz / PKC), pkMin = -gsz / 2;
  const pkMask = new Uint8Array(pkW * pkW);
  for (const poly of parkingPolys) {
    if (poly.length < 3) continue;
    let zLo = 1e9, zHi = -1e9;
    for (const p of poly) { if (p.z < zLo) zLo = p.z; if (p.z > zHi) zHi = p.z; }
    const j0 = Math.max(0, Math.floor((zLo - pkMin) / PKC)), j1 = Math.min(pkW - 1, Math.ceil((zHi - pkMin) / PKC));
    for (let j = j0; j <= j1; j++) {
      const cz = pkMin + (j + 0.5) * PKC, xs = [];
      for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
        const a = poly[i], b = poly[k];
        if ((a.z > cz) !== (b.z > cz)) xs.push(a.x + (cz - a.z) * (b.x - a.x) / (b.z - a.z));
      }
      xs.sort((p, q) => p - q);
      for (let s = 0; s + 1 < xs.length; s += 2) {
        const i0 = Math.max(0, Math.floor((xs[s] - pkMin) / PKC)), i1 = Math.min(pkW - 1, Math.floor((xs[s+1] - pkMin) / PKC));
        for (let i = i0; i <= i1; i++) pkMask[j * pkW + i] = 1;
      }
    }
  }
  const inParking = (x, z) => {
    const i = Math.floor((x - pkMin) / PKC), j = Math.floor((z - pkMin) / PKC);
    return i >= 0 && j >= 0 && i < pkW && j < pkW && pkMask[j * pkW + i] === 1;
  };
  buildSidewalks(roadPolys, gsz, waterYAt, inParking); // ONE unified band offset from the whole road network
  if (roadPos.length) worldGroup.add(texMesh(roadPos, asphaltTex, 1/7, 0x484c55, false)); // speckled asphalt, planar UVs
  if (dashPos.length) { const m = flatMesh(dashPos, 0xd9c25a, false); m.material.emissive = new THREE.Color(0x3a3318); worldGroup.add(m); }
  if (bridgePos.length) { const m = flatMesh(bridgePos, 0x8a8f98, true); m.material.side = THREE.DoubleSide; m.castShadow = true; worldGroup.add(m); }
  buildGraph(roadLines);

  // ---- buildings (real footprints -> window-tiled walls + SHAPED roofs) ----
  // Detail pass: OSM roof tags (roof:shape/height/colour), building:colour, Simple-3D
  // building:parts (church towers, stepped masses), plus procedural storefront ground
  // floors, parapets and steeples. Overture stays the base footprint/height source when
  // available; each Overture footprint ADOPTS the tags of the OSM building it sits inside,
  // so the roof/colour detail survives the footprint swap.

  // Coarse spatial index over OSM building footprints for centroid-containment lookups
  // (part -> parent assignment, Overture -> OSM tag adoption).
  const BCELL = 40, bIndex = new Map();
  const bboxOf = (pp) => { let x0=1e9,x1=-1e9,z0=1e9,z1=-1e9;
    for (const p of pp) { if(p.x<x0)x0=p.x; if(p.x>x1)x1=p.x; if(p.z<z0)z0=p.z; if(p.z>z1)z1=p.z; }
    return { x0, x1, z0, z1 }; };
  buildingPolys.forEach((b) => { const bb = bboxOf(b.pts);
    for (let gz = Math.floor(bb.z0/BCELL); gz <= Math.floor(bb.z1/BCELL); gz++)
      for (let gx = Math.floor(bb.x0/BCELL); gx <= Math.floor(bb.x1/BCELL); gx++) {
        const k = gx+'_'+gz; let a = bIndex.get(k); if (!a) { a = []; bIndex.set(k, a); } a.push(b);
      } });
  const centroidOf = (pp) => { let cx=0,cz=0; for (const p of pp){cx+=p.x;cz+=p.z;} return { x:cx/pp.length, z:cz/pp.length }; };
  const containingBuilding = (x, z) => {
    const a = bIndex.get(Math.floor(x/BCELL)+'_'+Math.floor(z/BCELL));
    if (a) for (const b of a) if (pointInPoly(x, z, b.pts)) return b;
    return null;
  };

  // Assign each part to its parent outline: the parent stops rendering (its parts ARE the
  // building, per the Simple-3D scheme) but keeps its footprint for collision; parts share
  // the parent's ground level so stacked masses line up on a slope.
  for (const p of partPolys) {
    const c = centroidOf(p.pts);
    const parent = containingBuilding(c.x, c.z);
    if (parent) { parent.hasParts = true; p.parent = parent; }
  }
  const partOwners = buildingPolys.filter(b => b.hasParts);
  const orphanParts = partPolys.filter(p => !p.parent);

  // Final render list. With Overture: Overture mass + adopted OSM tags, EXCEPT where OSM
  // parts give a better multi-mass model of the same building (drop the Overture blob there).
  const renderB = [], collisionPolys = [];
  if (overture && overture.length) {
    for (const b of overture) {
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
      renderB.push({ pts, t });
    }
  } else {
    for (const b of buildingPolys) if (!b.hasParts) renderB.push(b);
  }
  for (const o of partOwners) collisionPolys.push(o.pts);   // outline blocks driving; parts render
  for (const p of partPolys) renderB.push({ pts: p.pts, t: p.t, isPart: true, parent: p.parent });

  // --- footprint helpers for shaped roofs ---
  // Drop near-collinear vertices so a rectangle mapped with extra nodes still reads as a quad.
  const simplifyCorners = (pp) => {
    const out = [], n = pp.length;
    for (let i = 0; i < n; i++) {
      const p = pp[(i+n-1)%n], c = pp[i], q = pp[(i+1)%n];
      const ax=c.x-p.x, az=c.z-p.z, bx=q.x-c.x, bz=q.z-c.z;
      const la=Math.hypot(ax,az)||1e-9, lb=Math.hypot(bx,bz)||1e-9;
      if (Math.abs(ax*bz - az*bx)/(la*lb) > 0.15) out.push(c);   // keep corners bent > ~9°
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
  const cssColor = (s) => {              // roof:colour / building:colour -> THREE.Color (hex or CSS name)
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
  const detail = { pos: [], col: [] };   // untextured coloured tris: roofs/gables/parapets/steeples
  const dTri = (x1,y1,z1, x2,y2,z2, x3,y3,z3, c) => {
    detail.pos.push(x1,y1,z1, x2,y2,z2, x3,y3,z3);
    detail.col.push(c.r,c.g,c.b, c.r,c.g,c.b, c.r,c.g,c.b);
  };
  const dQuad = (a, ya, b, yb, c, yc, d, yd, cc) => {
    dTri(a.x,ya,a.z, b.x,yb,b.z, c.x,yc,c.z, cc);
    dTri(a.x,ya,a.z, c.x,yc,c.z, d.x,yd,d.z, cc);
  };

  for (const b of renderB) {
    let pts = b.pts;
    if (pts.length > 2 && pts[0].x === pts[pts.length-1].x && pts[0].z === pts[pts.length-1].z) pts = pts.slice(0, -1);
    if (pts.length < 3) continue;
    const t = b.t || {};
    let h = parseFloat(t.height);
    if (!h && t['building:levels']) h = parseFloat(t['building:levels']) * 3.3;
    // Real Overture/OSM heights were rendering ~1/3 of life-size; scale the data-derived
    // heights up so buildings read at their true height (fallback below is already game-tuned).
    if (h && !isNaN(h)) h *= BUILDING_HEIGHT_SCALE;
    if (!h || isNaN(h)) h = 9 + (Math.abs((pts[0].x * 7 + pts[0].z * 13) | 0) % 5) * 3.3;
    let area2 = 0; for (let i = 0, j = pts.length-1; i < pts.length; j = i++) area2 += (pts[j].x + pts[i].x) * (pts[j].z - pts[i].z);
    const areaM2 = Math.abs(area2) / 2;
    // Some Overture/OSM heights are far too low for the footprint (pancake buildings).
    // Floor the height by footprint size — but NOT for parts (porches/plinths ARE low).
    if (!b.isPart) h = Math.max(h, Math.min(15, 5 + Math.sqrt(areaM2) * 0.2));
    h = Math.min(h, 600);
    let minH = parseFloat(t.min_height);
    if (!minH && t['building:min_level']) minH = parseFloat(t['building:min_level']) * 3.3;
    minH = (minH && !isNaN(minH)) ? minH * BUILDING_HEIGHT_SCALE : 0;
    if (minH >= h) minH = 0;

    // ground level: lowest terrain corner of the PARENT outline for parts (stacked masses
    // must share one base). Ground-level walls embed 3 m so slopes don't show gaps;
    // elevated parts (min_height) start exactly where the mass below them ends.
    const basePts = (b.isPart && b.parent) ? b.parent.pts : pts;
    let ground = Infinity;
    for (const p of basePts) ground = Math.min(ground, terrain(p.x, p.z));
    const yTop = ground + h;
    const yBot = minH > 0 ? ground + minH : ground - 3;

    const col = cssColor(t['building:colour']) ||
      new THREE.Color(BUILDING_PAL[Math.abs((pts[0].x*3 + pts[0].z*5)|0) % BUILDING_PAL.length]);
    // pick a facade style by building size (+ a stable hash) so they're not all skinned alike
    const hash = Math.abs((pts[0].x*13.1 + pts[0].z*7.7) | 0);
    let vi;
    if (h > 50)      vi = (hash % 3 === 0) ? 4 : 0;          // very tall: some glass towers, mostly office
    else if (h > 26) vi = (hash % 4 === 0) ? 4 : 0;          // tall: office, occasional glass
    else if (h > 14) vi = [0, 2, 2, 5][hash % 4];            // mid: office / commercial / brick
    else             vi = [1, 1, 5, 3][hash % 4];            // low: residential / brick / industrial
    const CELL_W = FACADES[vi].cw, CELL_H = FACADES[vi].ch, FNC = FACADES[vi].n || 1;
    const ov = hash % FNC;              // atlas row offset: same per building so floors line up across faces

    const worship = t.amenity === 'place_of_worship' ||
      /^(church|chapel|cathedral|mosque|temple|synagogue|monastery)$/.test(t.building || '');

    // roof shape: tagged, else default small quads to pitched roofs (row houses/shops)
    const sq = simplifyCorners(pts);
    const quad = isConvexQuad(sq) ? sq : null;
    let rs = RSHAPE[(t['roof:shape'] || '').toLowerCase()] || '';
    if (!rs) {
      if (b.isPart) rs = 'flat';                             // untagged parts: plain masses
      else if (worship && quad) rs = 'gabled';
      else if (quad && areaM2 < 320 && h < 40 && hash % 4) rs = 'gabled';
      else rs = 'flat';
    }
    if ((rs === 'gabled' || rs === 'hipped') && !quad) rs = 'flat';  // a clean ridge needs a clean quad

    // roof height: tagged, else pitch from the short span (~45°); spires run tall
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
    const eaveY = rs === 'flat' ? yTop : yTop - roofH;       // walls stop at the eave

    const roofCol = cssColor(t['roof:colour']) ||
      (rs === 'flat' ? col.clone().multiplyScalar(0.82)
                     : new THREE.Color(ROOF_PAL[hash % ROOF_PAL.length]));

    // procedural storefront ground floor on street-scale commercial/office buildings
    const BAND = 5;
    const hasStore = !b.isPart && minH === 0 && (vi === 0 || vi === 2 || vi === 4 || vi === 5) &&
      (eaveY - ground) > BAND + 7 && areaM2 > 70;
    const bandTop = hasStore ? ground + BAND : yBot;

    // walls: one quad per footprint edge, UVs tiling the window texture
    const wp = [], wuv = [], wc = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], bb = pts[(i+1) % pts.length];
      const elen = Math.hypot(bb.x - a.x, bb.z - a.z); if (elen < 0.05) continue;
      const push = (px, py, pz, u, v) => { wp.push(px, py, pz); wuv.push(u, v); wc.push(col.r, col.g, col.b); };
      if (hasStore) {   // storefront band: own texture bucket, v=1 lands exactly at bandTop
        const SN = STOREFRONT.n || 1, os = (hash + i) % SN;   // start each edge at a different shopfront
        const su1 = Math.max(1, Math.round(elen / STOREFRONT.cw));
        const pushS = (px, py, pz, u, v) => { storePos.push(px, py, pz); storeUV.push(u, v); storeCol.push(col.r, col.g, col.b); };
        const v0 = (yBot - (bandTop - BAND)) / BAND;         // below-grade lip repeats out of sight
        pushS(a.x, yBot, a.z, os/SN, v0); pushS(bb.x, yBot, bb.z, (os+su1)/SN, v0); pushS(bb.x, bandTop, bb.z, (os+su1)/SN, 1);
        pushS(a.x, yBot, a.z, os/SN, v0); pushS(bb.x, bandTop, bb.z, (os+su1)/SN, 1); pushS(a.x, bandTop, a.z, os/SN, 1);
      }
      // whole number of window columns per edge & floors up -> no clipped/partial windows,
      // rows line up across faces and the top edge lands on a full floor. UVs land on atlas
      // cell boundaries (u,v are cellIndex/FNC); ou varies per edge, ov per building.
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

    // ---- roof geometry by shape ----
    if (rs === 'flat') {
      // triangulated footprint at yTop (shape Z negated to cancel rotateX mirror)
      const shape = new THREE.Shape();
      shape.moveTo(pts[0].x, -pts[0].z);
      for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].z);
      const rg = new THREE.ShapeGeometry(shape); rg.rotateX(-Math.PI/2);
      const pa = rg.attributes.position.array; for (let i = 1; i < pa.length; i += 3) pa[i] = yTop;
      rg.deleteAttribute('uv'); rg.deleteAttribute('normal');   // merge needs matching attributes
      const rn = rg.attributes.position.count, rc = new Float32Array(rn * 3);
      for (let i = 0; i < rn; i++) { rc[i*3] = roofCol.r; rc[i*3+1] = roofCol.g; rc[i*3+2] = roofCol.b; }
      rg.setAttribute('color', new THREE.BufferAttribute(rc, 3));
      roofGeos.push(rg.toNonIndexed());   // the detail stream below is non-indexed; merge needs all-or-none
      // parapet lip: a darker band above the roofline breaks the sheared-off-box look
      if (!b.isPart && h > 15 && areaM2 > 60) {
        const pc = col.clone().multiplyScalar(0.62);
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], q = pts[(i+1)%pts.length];
          dQuad(a, yTop, q, yTop, q, yTop + 1.0, a, yTop + 1.0, pc);
        }
      }
    } else if (rs === 'gabled' || rs === 'hipped') {
      // ridge runs between the midpoints of the two SHORT edges of the quad
      const e0 = Math.hypot(quad[1].x-quad[0].x, quad[1].z-quad[0].z);
      const e1 = Math.hypot(quad[2].x-quad[1].x, quad[2].z-quad[1].z);
      const s0 = e0 <= e1 ? 0 : 1;
      const p0 = quad[s0], p1 = quad[(s0+1)%4], p2 = quad[(s0+2)%4], p3 = quad[(s0+3)%4];
      let m0 = { x:(p0.x+p1.x)/2, z:(p0.z+p1.z)/2 }, m1 = { x:(p2.x+p3.x)/2, z:(p2.z+p3.z)/2 };
      if (rs === 'hipped') {                                  // pull the ridge ends in -> sloped hips
        const rl = Math.hypot(m1.x-m0.x, m1.z-m0.z) || 1;
        const inset = Math.min(rl * 0.32, spanS * 0.5);
        const ux = (m1.x-m0.x)/rl, uz = (m1.z-m0.z)/rl;
        m0 = { x: m0.x + ux*inset, z: m0.z + uz*inset };
        m1 = { x: m1.x - ux*inset, z: m1.z - uz*inset };
      }
      dQuad(p1, eaveY, p2, eaveY, m1, yTop, m0, yTop, roofCol);   // two roof planes
      dQuad(p3, eaveY, p0, eaveY, m0, yTop, m1, yTop, roofCol);
      const endCol = rs === 'gabled' ? col.clone().multiplyScalar(0.94) : roofCol; // wall-toned gable ends / roof-toned hips
      dTri(p0.x, eaveY, p0.z, p1.x, eaveY, p1.z, m0.x, yTop, m0.z, endCol);
      dTri(p2.x, eaveY, p2.z, p3.x, eaveY, p3.z, m1.x, yTop, m1.z, endCol);
      // churches mapped WITHOUT 3D parts still get a modest tower + spire over one gable end
      if (worship && !b.isPart && rs === 'gabled' && spanL > 12) {
        const rl = Math.hypot(m1.x-m0.x, m1.z-m0.z) || 1;
        const ux = (m1.x-m0.x)/rl, uz = (m1.z-m0.z)/rl, vx = -uz, vz = ux;
        const tw = Math.min(Math.max(spanS * 0.34, 2.4), 5.5);
        const cx = m0.x + ux * (tw * 0.7), cz = m0.z + uz * (tw * 0.7);
        const cr = [
          { x: cx + (ux+vx)*tw/2, z: cz + (uz+vz)*tw/2 }, { x: cx + (ux-vx)*tw/2, z: cz + (uz-vz)*tw/2 },
          { x: cx - (ux+vx)*tw/2, z: cz - (uz+vz)*tw/2 }, { x: cx - (ux-vx)*tw/2, z: cz - (uz-vz)*tw/2 },
        ];
        const towerTop = yTop + roofH * 0.5 + tw * 0.6;
        const wallC = col.clone().multiplyScalar(1.04), spireC = roofCol.clone().multiplyScalar(0.8);
        for (let i = 0; i < 4; i++) dQuad(cr[i], yBot, cr[(i+1)%4], yBot, cr[(i+1)%4], towerTop, cr[i], towerTop, wallC);
        for (let i = 0; i < 4; i++) dTri(cr[i].x, towerTop, cr[i].z, cr[(i+1)%4].x, towerTop, cr[(i+1)%4].z, cx, towerTop + tw*2.1, cz, spireC);
      }
    } else {
      // pyramidal / spire / dome: fan from the eave ring to a peak at the centroid
      const c = centroidOf(pts);
      if (rs === 'dome') {                                    // intermediate ring bulges the profile
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
    if (minH === 0) collisionPolys.push(pts);   // elevated parts don't block the street below
  }
  wallBuckets.forEach((geos, vi) => {
    if (!geos.length) return;
    const merged = mergeGeometries(geos, false); merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ map: FACADES[vi].tex, vertexColors: true, side: THREE.DoubleSide }));
    mesh.castShadow = true; mesh.receiveShadow = true; worldGroup.add(mesh);
  });
  if (storePos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(storePos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(storeUV, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(storeCol, 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: STOREFRONT.tex, vertexColors: true, side: THREE.DoubleSide }));
    mesh.castShadow = true; mesh.receiveShadow = true; worldGroup.add(mesh);
  }
  if (detail.pos.length) {                     // shaped roofs/gables/parapets/steeples
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(detail.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(detail.col, 3));
    roofGeos.push(g);
  }
  if (roofGeos.length) {
    const merged = mergeGeometries(roofGeos, false); merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    mesh.castShadow = true; mesh.receiveShadow = true; worldGroup.add(mesh);
  }

  // ---- countryside scatter: the open land between/beyond the streets was a bare
  // grass plane. Fill it with noise-CLUMPED wild trees, bushes, rocks and wildflower
  // patches (clumps read as natural copses; uniform scatter reads as static). Keeps
  // clear of roads, buildings, water, residential blocks (yards have their own
  // plantings), parking and farmland. Orchards get regular planted grids instead.
  const wildBushPts = [], rockPts = [], flowerPts = [];
  {
    // value noise for clumping (smoothstep-blended random lattice, ~feature size 1/scale)
    const nseed = Math.random() * 1000;
    const h2 = (i, j) => { const s = Math.sin(i*127.1 + j*311.7 + nseed) * 43758.5453; return s - Math.floor(s); };
    const vnoise = (x, z) => {
      const i = Math.floor(x), j = Math.floor(z), fx = x-i, fz = z-j;
      const a = h2(i,j), b = h2(i+1,j), c = h2(i,j+1), d = h2(i+1,j+1);
      const ux = fx*fx*(3-2*fx), uz = fz*fz*(3-2*fz);
      return a + (b-a)*ux + (c-a)*uz + (a-b-c+d)*ux*uz;
    };
    // stay off the road network: mark cells around sampled centreline points
    const RC = 12, roadSet = new Set(), rk = (x, z) => Math.round(x/RC) + '_' + Math.round(z/RC);
    for (const line of roadLines) for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i+1], len = Math.hypot(b.x-a.x, b.z-a.z) || 1;
      for (let d = 0; d <= len; d += RC*0.7) {
        const x = a.x + (b.x-a.x)*d/len, z = a.z + (b.z-a.z)*d/len;
        for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++)
          roadSet.add(Math.round(x/RC+ox) + '_' + Math.round(z/RC+oz));
      }
    }
    // coarse bbox index over every rendered footprint (OSM + Overture)
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

    const lim = half - 15, step = 13;
    let nT = 0, nB = 0, nR = 0, nF = 0;   // caps: trees/bushes/rocks/flower patches
    for (let x = -lim; x < lim; x += step) {
      for (let z = -lim; z < lim; z += step) {
        const n = vnoise(x * 0.016, z * 0.016);            // ~60 m clumps
        if (n < 0.56) continue;                            // only inside clumps
        if (Math.random() > (n - 0.56) * 3.2) continue;    // denser toward clump cores
        const jx = x + (Math.random()-0.5)*step, jz = z + (Math.random()-0.5)*step;
        if (!open(jx, jz)) continue;
        const r = Math.random();
        if (r < 0.50)      { if (nT++ < 1600) treePoints.push({ x: jx, z: jz }); }
        else if (r < 0.82) { if (nB++ < 1300) wildBushPts.push({ x: jx, z: jz }); }
        else if (r < 0.90) { if (nR++ < 350)  rockPts.push({ x: jx, z: jz }); }
        else               { if (nF++ < 600)  flowerPts.push({ x: jx, z: jz }); }
      }
    }
    // orchards: rows of small uniform trees on a planted grid (reads as agriculture)
    let nO = 0;
    for (const poly of orchardPolys) {
      const bb = bboxOf(poly);
      for (let x = bb.x0 + 4; x < bb.x1 && nO < 800; x += 7.5)
        for (let z = bb.z0 + 4; z < bb.z1 && nO < 800; z += 7.5)
          if (pointInPoly(x, z, poly)) { treePoints.push({ x, z, sp: 0, sc: 0.5 + Math.random()*0.15 }); nO++; }
    }
  }

  const yardBushPts = buildHouses(residentialPolys, renderB, roadLines) || [];
  buildTrees(treePoints, treedPolys, scrubPolys, yardBushPts.concat(wildBushPts));
  buildCountryProps(rockPts, flowerPts);
  signPosts = [];                       // reset the shared sign-pole footprint registry
  buildTrafficLights(signalNodes, roadPolys);
  buildStopSigns(stopNodes, roadPolys);
  buildStreetSigns(roadPolys);

  // ---- collision grid ----
  gridMinX = -gsz/2; gridMinZ = -gsz/2;
  gridW = Math.ceil(gsz / gridCell); gridH = Math.ceil(gsz / gridCell);
  grid = new Uint8Array(gridW * gridH);
  function rasterize(polys) {
    // Scanline fill: per grid ROW, find the polygon's edge crossings once and fill the spans
    // between them — O(rows·verts + cells) instead of pointInPoly per cell, which took 2+
    // MINUTES for map-spanning polygons like the Lehigh River. Same result (cell-center,
    // even-odd rule), >100x faster.
    for (const poly of polys) {
      if (poly.length < 3) continue;
      let minZ = 1e9, maxZ = -1e9;
      for (const p of poly) { if (p.z<minZ)minZ=p.z; if (p.z>maxZ)maxZ=p.z; }
      const cz0 = Math.max(0, ((minZ - gridMinZ)/gridCell)|0), cz1 = Math.min(gridH-1, ((maxZ - gridMinZ)/gridCell)|0);
      const xs = [];
      for (let cz = cz0; cz <= cz1; cz++) {
        const wz = gridMinZ + (cz+0.5)*gridCell;
        xs.length = 0;
        for (let i = 0, j = poly.length-1; i < poly.length; j = i++) {
          const a = poly[i], b = poly[j];
          if ((a.z > wz) !== (b.z > wz)) xs.push(a.x + (wz - a.z) / (b.z - a.z) * (b.x - a.x));
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const cx0 = Math.max(0, Math.ceil((xs[k] - gridMinX)/gridCell - 0.5)), cx1 = Math.min(gridW-1, Math.floor((xs[k+1] - gridMinX)/gridCell - 0.5));
          for (let cx = cx0; cx <= cx1; cx++) grid[cz*gridW + cx] = 1;
        }
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
