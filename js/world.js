// SimDrive — world.js
// world feature builders: trees, houses, sidewalks, road/sign helpers, signals, bridges
// Loaded as a classic script by js/bootstrap.js; all app files share one global
// scope (the original single-file behaviour), with THREE/addons exposed as globals.

const LEAF_COLS = [0x3f8a3c, 0x4f9a45, 0x357f37, 0x5aa14e, 0x6b8f3a];
function buildTrees(treePoints, treedPolys) {
  const pts = treePoints.slice();
  // scatter through wooded polygons on a jittered grid
  outer:
  for (const poly of treedPolys) {
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const p of poly) { if (p.x<minX)minX=p.x; if (p.x>maxX)maxX=p.x; if (p.z<minZ)minZ=p.z; if (p.z>maxZ)maxZ=p.z; }
    const step = 11;
    for (let x = minX; x < maxX; x += step) {
      for (let z = minZ; z < maxZ; z += step) {
        const jx = x + (Math.random()-0.5)*step, jz = z + (Math.random()-0.5)*step;
        if (pointInPoly(jx, jz, poly)) pts.push({ x: jx, z: jz });
        if (pts.length >= 3500) break outer;
      }
    }
  }
  if (!pts.length) return;
  const n = pts.length;
  const trunks = new THREE.InstancedMesh(_treeTrunkGeo, new THREE.MeshLambertMaterial({ color: 0x6b4a2b }), n);
  // plain material — per-instance colour comes from setColorAt (instanceColor), NOT vertexColors
  const leaves = new THREE.InstancedMesh(_treeLeafGeo, new THREE.MeshLambertMaterial(), n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0), s = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const p = pts[i], gy = terrain(p.x, p.z);
    const sc = 0.7 + Math.random() * 0.9;
    q.setFromAxisAngle(up, Math.random() * Math.PI * 2);
    s.set(sc, sc, sc);
    m.compose(new THREE.Vector3(p.x, gy + 1.2*sc, p.z), q, s); trunks.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(p.x, gy + (2.4 + 2.0)*sc, p.z), q, s); leaves.setMatrixAt(i, m);
    leaves.setColorAt(i, col.set(LEAF_COLS[(Math.random()*LEAF_COLS.length)|0]));
  }
  trunks.instanceMatrix.needsUpdate = true; leaves.instanceMatrix.needsUpdate = true;
  if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
  // never frustum-cull: an InstancedMesh culls against its origin, which would make
  // all the trees vanish whenever the map origin is off-screen.
  trunks.frustumCulled = false; leaves.frustumCulled = false;
  // foliage doesn't cast shadows — keeps the shadow pass cheap on old GPUs with thousands of trees
  worldGroup.add(trunks); worldGroup.add(leaves);
}

// Procedurally fill OSM "residential" zones with houses lining the streets, where OSM has no
// building mapped (common gap in US suburbs). Instanced box + hip-roof, facing the road.
const HOUSE_PAL = [0xcdbb9a, 0xc9a98f, 0xb7c0a8, 0xd2c4a0, 0xb09a86, 0xc2b59a, 0xa8b0b8, 0xbfb39a];
const ROOF_PAL = [0x5e5044, 0x73463c, 0x4f5a68, 0x554b42, 0x44524a, 0x6a5240];
const _houseBodyGeo = new THREE.BoxGeometry(1, 1, 1);
const _houseRoofGeo = new THREE.ConeGeometry(0.72, 1, 4);
function buildHouses(residentialPolys, buildingPolys, roadLines) {
  if (!residentialPolys.length || !roadLines.length) return;
  const CELL = 13, SET = 9.5, SPACING = 18;
  const occ = new Set(), ckey = (x, z) => Math.round(x/CELL) + '_' + Math.round(z/CELL);
  for (const b of buildingPolys) {                         // don't place over existing buildings
    let cx = 0, cz = 0; for (const p of b.pts) { cx += p.x; cz += p.z; }
    occ.add(ckey(cx/b.pts.length, cz/b.pts.length));
  }
  const inRes = (x, z) => { for (const poly of residentialPolys) if (pointInPoly(x, z, poly)) return true; return false; };
  const houses = [];
  for (const line of roadLines) {
    for (let i = 0; i < line.length - 1 && houses.length < 2600; i++) {
      const a = line[i], b = line[i+1], dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
      if (len < 5) continue;
      const ux = dx/len, uz = dz/len, px = -uz, pz = ux, ang = Math.atan2(uz, ux);
      for (let d = SPACING*0.5; d < len; d += SPACING) {
        for (const side of [1, -1]) {
          const hx = a.x + ux*d + px*side*SET, hz = a.z + uz*d + pz*side*SET, k = ckey(hx, hz);
          if (occ.has(k) || !inRes(hx, hz)) continue;
          occ.add(k); houses.push({ x: hx, z: hz, ang });
        }
      }
    }
  }
  if (!houses.length) return;
  const n = houses.length;
  const bodies = new THREE.InstancedMesh(_houseBodyGeo, new THREE.MeshLambertMaterial(), n);
  const roofs = new THREE.InstancedMesh(_houseRoofGeo, new THREE.MeshLambertMaterial(), n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), rq = new THREE.Quaternion();
  const pos = new THREE.Vector3(), scl = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const h = houses[i], gy = surfaceHeight(h.x, h.z);
    const w = 5.5 + Math.random()*2.5, dp = 5 + Math.random()*2.5, bh = 3.6 + Math.random()*2.4, rh = 1.9 + Math.random()*1.1;
    q.setFromAxisAngle(UP, -h.ang);
    pos.set(h.x, gy + bh/2, h.z); scl.set(w, bh, dp);
    m.compose(pos, q, scl); bodies.setMatrixAt(i, m);
    bodies.setColorAt(i, col.set(HOUSE_PAL[(Math.random()*HOUSE_PAL.length)|0]));
    rq.setFromAxisAngle(UP, -h.ang + Math.PI/4);          // align the 4-sided roof to the box
    pos.set(h.x, gy + bh + rh/2, h.z); scl.set(w, rh, dp);
    m.compose(pos, rq, scl); roofs.setMatrixAt(i, m);
    roofs.setColorAt(i, col.set(ROOF_PAL[(Math.random()*ROOF_PAL.length)|0]));
  }
  bodies.instanceMatrix.needsUpdate = roofs.instanceMatrix.needsUpdate = true;
  if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
  if (roofs.instanceColor) roofs.instanceColor.needsUpdate = true;
  bodies.castShadow = roofs.castShadow = true;
  bodies.frustumCulled = roofs.frustumCulled = false;
  worldGroup.add(bodies, roofs);
}

// ONE unified sidewalk for the whole road network, built from a signed distance field.
// sdf(cell) = distance to the nearest road EDGE (dist-to-centreline − half-width): <0 inside the
// carriageway, >0 outside. The sidewalk is the band sdf∈[0,W]. Rendering each grid cell CLIPPED to
// that band (cell edges linearly interpolated where sdf=0 or sdf=W) yields smooth edges and corners
// that round naturally (the euclidean offset of the road union) — with NO per-junction geometry, so
// nothing can spike, overlap or fragment. A short vertical curb face is dropped along the sdf=0 line.
function buildSidewalks(roads, gsz, waterYAt) {
  const W = 1.7, cell = 0.6, minX = -gsz/2, minZ = -gsz/2;
  const nx = Math.ceil(gsz/cell)+1, nz = Math.ceil(gsz/cell)+1;
  const sdf = new Float32Array(nx*nz).fill(1e9);
  for (const r of roads) {
    if (r.bridge || r.pts.length < 2) continue;
    const hw = r.w/2, reach = hw + W + cell;
    for (let i = 0; i < r.pts.length-1; i++) {
      const a = r.pts[i], b = r.pts[i+1], dx = b.x-a.x, dz = b.z-a.z, l2 = dx*dx+dz*dz || 1;
      const ix0 = Math.max(0, Math.floor((Math.min(a.x,b.x)-reach-minX)/cell)), ix1 = Math.min(nx-1, Math.ceil((Math.max(a.x,b.x)+reach-minX)/cell));
      const iz0 = Math.max(0, Math.floor((Math.min(a.z,b.z)-reach-minZ)/cell)), iz1 = Math.min(nz-1, Math.ceil((Math.max(a.z,b.z)+reach-minZ)/cell));
      for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
        const wx = minX+ix*cell, wz = minZ+iz*cell;
        let t = ((wx-a.x)*dx + (wz-a.z)*dz)/l2; if (t<0) t=0; else if (t>1) t=1;
        const px = a.x+dx*t, pz = a.z+dz*t, d = Math.hypot(wx-px, wz-pz) - hw, k = iz*nx+ix;
        if (d < sdf[k]) sdf[k] = d;
      }
    }
  }
  // For texture UVs that FOLLOW the walk (not a fixed world grid): bucket road segments with their
  // cumulative arc-length; per vertex, the nearest road gives u = distance ALONG it, v = distance
  // ACROSS it, so panel joints run with/across the sidewalk and curve with it.
  const PANEL = 1.5, sCell = 8, sgrid = new Map(), rsegs = [];
  for (const r of roads) {
    if (r.bridge || r.pts.length < 2) continue;
    const hw = r.w/2; let cum = 0;
    for (let i = 0; i < r.pts.length-1; i++) {
      const a = r.pts[i], b = r.pts[i+1], dx = b.x-a.x, dz = b.z-a.z, len = Math.hypot(dx,dz)||1e-6;
      const si = rsegs.push({ ax:a.x, az:a.z, dx, dz, l2:dx*dx+dz*dz||1, len, cum }) - 1; cum += len;
      const reach = hw + W + cell;
      const gx0 = Math.floor((Math.min(a.x,b.x)-reach-minX)/sCell), gx1 = Math.floor((Math.max(a.x,b.x)+reach-minX)/sCell);
      const gz0 = Math.floor((Math.min(a.z,b.z)-reach-minZ)/sCell), gz1 = Math.floor((Math.max(a.z,b.z)+reach-minZ)/sCell);
      for (let gz=gz0; gz<=gz1; gz++) for (let gx=gx0; gx<=gx1; gx++) { const kk=gx+'_'+gz; let arr=sgrid.get(kk); if(!arr){arr=[];sgrid.set(kk,arr);} arr.push(si); }
    }
  }
  const uvAt = (x,z) => {
    const arr = sgrid.get(Math.floor((x-minX)/sCell)+'_'+Math.floor((z-minZ)/sCell));
    let bd=1e18, bu=x, bv=z;
    if (arr) for (const si of arr) { const s=rsegs[si];
      let t=((x-s.ax)*s.dx+(z-s.az)*s.dz)/s.l2; if(t<0)t=0; else if(t>1)t=1;
      const px=s.ax+s.dx*t, pz=s.az+s.dz*t, dd=(x-px)*(x-px)+(z-pz)*(z-pz);
      if(dd<bd){ bd=dd; bu=s.cum+t*s.len; const cr=(x-s.ax)*s.dz-(z-s.az)*s.dx; bv=Math.sqrt(dd)*(cr<0?-1:1); }
    }
    return [bu/PANEL, bv/PANEL];
  };
  const top = [], topUV = [], curb = [];
  const yTop = (x,z) => { const s = surfaceHeight(x,z)+0.24, w = waterYAt(x,z); return w>-Infinity && w+0.45>s ? w+0.45 : s; };
  const clip = (poly, keepLo, val) => {            // Sutherland-Hodgman against the s=val line
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i+1)%poly.length];
      const pin = keepLo ? p.s >= val : p.s <= val, qin = keepLo ? q.s >= val : q.s <= val;
      if (pin) out.push(p);
      if (pin !== qin) { const f = (val-p.s)/(q.s-p.s); out.push({ x:p.x+(q.x-p.x)*f, z:p.z+(q.z-p.z)*f, s:val }); }
    }
    return out;
  };
  for (let iz = 0; iz < nz-1; iz++) for (let ix = 0; ix < nx-1; ix++) {
    const s00=sdf[iz*nx+ix], s10=sdf[iz*nx+ix+1], s11=sdf[(iz+1)*nx+ix+1], s01=sdf[(iz+1)*nx+ix];
    if (Math.min(s00,s10,s11,s01) > W || Math.max(s00,s10,s11,s01) < 0) continue;
    const x0 = minX+ix*cell, z0 = minZ+iz*cell, x1 = x0+cell, z1 = z0+cell;
    let poly = [{x:x0,z:z0,s:s00},{x:x1,z:z0,s:s10},{x:x1,z:z1,s:s11},{x:x0,z:z1,s:s01}];
    poly = clip(poly, true, 0); if (poly.length>=3) poly = clip(poly, false, W);
    if (poly.length < 3) continue;
    const puv = poly.map(p => uvAt(p.x, p.z));       // panel UVs follow the nearest road
    for (let m = 1; m < poly.length-1; m++) {        // concrete top (fan-triangulate the clipped cell)
      const A=poly[0], B=poly[m], C=poly[m+1], a=puv[0], b=puv[m], c=puv[m+1];
      top.push(A.x,yTop(A.x,A.z),A.z, B.x,yTop(B.x,B.z),B.z, C.x,yTop(C.x,C.z),C.z);
      topUV.push(a[0],a[1], b[0],b[1], c[0],c[1]);
    }
    for (let m = 0; m < poly.length; m++) {          // vertical curb face on edges lying on sdf=0
      const A=poly[m], B=poly[(m+1)%poly.length];
      if (Math.abs(A.s)<1e-3 && Math.abs(B.s)<1e-3) {
        const ya=yTop(A.x,A.z), yb=yTop(B.x,B.z);
        curb.push(A.x,ya,A.z, B.x,yb,B.z, B.x,yb-0.13,B.z,  A.x,ya,A.z, B.x,yb-0.13,B.z, A.x,ya-0.13,A.z);
      }
    }
  }
  if (top.length) { const m = texMesh(top, concreteTex, 0, 0xffffff, false, topUV); m.material.side = THREE.DoubleSide; worldGroup.add(m); }
  if (curb.length) { const m = flatMesh(curb, 0xa8a8a4, false); m.material.side = THREE.DoubleSide; worldGroup.add(m); }
}

// direction (unit vector) of the road nearest to (x,z)
function nearestRoadDir(x, z, lines) {
  let best = null, bd = Infinity;
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i+1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx*dx + dz*dz || 1;
      let t = ((x - a.x)*dx + (z - a.z)*dz) / l2; t = Math.max(0, Math.min(1, t));
      const cx = a.x + dx*t, cz = a.z + dz*t, d = (x-cx)*(x-cx) + (z-cz)*(z-cz);
      if (d < bd) { bd = d; const l = Math.sqrt(l2); best = [dx/l, dz/l]; }
    }
  }
  return best || [1, 0];
}
// Like nearestRoadDir, but also returns that road's half-width so signage can
// clear the carriageway no matter how wide the road is.
function nearestRoad(x, z, roads) {
  let bd = Infinity, dir = [1, 0], hw = 4;
  for (const r of roads) {
    const line = r.pts;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i+1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx*dx + dz*dz || 1;
      let t = ((x - a.x)*dx + (z - a.z)*dz) / l2; t = Math.max(0, Math.min(1, t));
      const cx = a.x + dx*t, cz = a.z + dz*t, d = (x-cx)*(x-cx) + (z-cz)*(z-cz);
      if (d < bd) { bd = d; const l = Math.sqrt(l2); dir = [dx/l, dz/l]; hw = r.w / 2; }
    }
  }
  return { dir, hw };
}
// Find the road nearest (x,z) (A) AND the nearest roughly-perpendicular cross road (B),
// so a signal can be planted on the actual intersection CORNER (off both roads), not in
// the carriageway. B is null when there's no real cross street (mid-block / T-stub).
function junctionAt(x, z, roads) {
  const measure = (line) => {
    let bd = Infinity, dir = [1, 0];
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i+1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx*dx + dz*dz || 1;
      let t = ((x - a.x)*dx + (z - a.z)*dz) / l2; t = Math.max(0, Math.min(1, t));
      const cx = a.x + dx*t, cz = a.z + dz*t, d = (x-cx)*(x-cx) + (z-cz)*(z-cz);
      if (d < bd) { bd = d; const l = Math.sqrt(l2); dir = [dx/l, dz/l]; }
    }
    return { dist: Math.sqrt(bd), dir };
  };
  const cand = roads.map(r => { const m = measure(r.pts); return { dist: m.dist, dir: m.dir, hw: r.w / 2 }; });
  let A = null, ad = Infinity;
  for (const c of cand) if (c.dist < ad) { ad = c.dist; A = c; }
  if (!A) return { A: { dir: [1, 0], hw: 4 }, B: null };
  let B = null, bd = Infinity;
  for (const c of cand) {
    if (c === A) continue;
    const dot = Math.abs(c.dir[0]*A.dir[0] + c.dir[1]*A.dir[1]);   // ~0 => perpendicular
    if (dot < 0.55 && c.dist < 16 && c.dist < bd) { bd = c.dist; B = c; }
  }
  return { A, B };
}
// Signed distance from (x,z) to the nearest road carriageway EDGE — the SAME field the
// sidewalks are built from (buildSidewalks). <0 inside a carriageway, >0 outside; the
// sidewalk band is [0, SIDEWALK_W]. Bridges have no sidewalk so they're skipped.
const SIDEWALK_W = 1.7;
function roadEdgeDist(x, z, roads) {
  let best = 1e9;
  for (const r of roads) {
    if (r.bridge || r.pts.length < 2) continue;
    const hw = r.w / 2;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i+1], dx = b.x-a.x, dz = b.z-a.z, l2 = dx*dx+dz*dz || 1;
      let t = ((x-a.x)*dx + (z-a.z)*dz)/l2; if (t<0) t=0; else if (t>1) t=1;
      const px = a.x+dx*t, pz = a.z+dz*t, d = Math.hypot(x-px, z-pz) - hw;
      if (d < best) best = d;
    }
  }
  return best;
}
// Snap a candidate point ONTO the sidewalk so a sign-pole can never land in the street.
// Walk along the gradient of roadEdgeDist toward the middle of the sidewalk band: if the
// point is inside/too close to a carriageway the gradient pushes it outward; if it's too
// far out it pulls back. Converges to the band [0, SIDEWALK_W] of the nearest road.
function snapToSidewalk(x, z, roads) {
  const target = SIDEWALK_W * 0.5, e = 0.3;
  for (let it = 0; it < 24; it++) {
    const d = roadEdgeDist(x, z, roads);
    if (d >= 0.3 && d <= SIDEWALK_W - 0.1) break;             // safely on the walk
    const gx = (roadEdgeDist(x+e,z,roads) - roadEdgeDist(x-e,z,roads)) / (2*e);
    const gz = (roadEdgeDist(x,z+e,roads) - roadEdgeDist(x,z-e,roads)) / (2*e);
    const gl = Math.hypot(gx, gz) || 1;
    let step = target - d; if (step > 2) step = 2; else if (step < -2) step = -2;
    x += (gx/gl) * step * 0.6; z += (gz/gl) * step * 0.6;     // damped, away-from-road is +grad
  }
  return { x, z };
}
// Shared registry of planted sign-pole footprints (traffic lights, stop signs, street-name
// blades). Builders run independently but all plant on intersection CORNERS, so a stop node
// and a street-name endpoint can resolve to the same corner and spawn on top of each other.
// Each builder reserves its spot; if it clashes with an already-planted pole it's stepped
// further back along its own approach direction (and re-snapped to the walk) until clear.
let signPosts = [];
function reserveSignSpot(x, z, adx, adz, roads, minGap = 2.4) {
  const al = Math.hypot(adx, adz) || 1; adx /= al; adz /= al;
  const g2 = minGap * minGap;
  for (let it = 0; it < 8; it++) {
    let clash = false;
    for (const s of signPosts) { const ddx = s.x - x, ddz = s.z - z; if (ddx*ddx + ddz*ddz < g2) { clash = true; break; } }
    if (!clash) break;
    x += adx * minGap; z += adz * minGap;                 // step further into the approach
    if (roads) { const sn = snapToSidewalk(x, z, roads); x = sn.x; z = sn.z; }
  }
  signPosts.push({ x, z });
  return { x, z };
}

// ---- Live traffic signals ----
let signals = [], signalLamps = null, signalTime = 0;
const LAMP_ON = [0xff3b30, 0xffcc00, 0x2cd14a];  // red, amber, green (lit)
const LAMP_OFF = [0x401414, 0x40360f, 0x123a1c];  // dim lenses (unlit)
// state from group + time: 0 green, 1 amber, 2 red. Groups (road axes) alternate.
function signalState(group, tSec) {
  const GREEN = 7, AMBER = 2.5, HALF = GREEN + AMBER, FULL = 2*HALF;
  let local = (tSec - (group === 0 ? 0 : HALF)) % FULL; if (local < 0) local += FULL;
  return local < GREEN ? 0 : local < HALF ? 1 : 2;
}
function applySignalStates(force) {
  if (!signalLamps) return;
  const tSec = signalTime / 60; const col = new THREE.Color(); let changed = false;
  for (const s of signals) {
    const st = signalState(s.group, tSec);
    if (st === s.state && !force) continue;
    s.state = st; changed = true;
    const active = st === 2 ? 0 : st === 1 ? 1 : 2;   // which lens is lit
    for (let k = 0; k < 3; k++) signalLamps.setColorAt(s.base + k, col.set(k === active ? LAMP_ON[k] : LAMP_OFF[k]));
  }
  if ((changed || force) && signalLamps.instanceColor) signalLamps.instanceColor.needsUpdate = true;
}
function updateSignals(dt) { signalTime += dt; applySignalStates(false); }

// Traffic lights: roadside pole + mast arm OUT over the street, 3-lens head facing traffic.
function buildTrafficLights(nodes, roads) {
  signals = []; signalLamps = null;
  if (!nodes.length) return;
  const n = Math.min(nodes.length, 150);
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x2f333a });
  const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.16, 6.4, 6), poleMat, n);
  const arms  = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.16, 0.16), poleMat, n);   // +X length, scaled
  const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 1.5, 0.5), new THREE.MeshLambertMaterial({ color: 0x15171b }), n);
  const lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshBasicMaterial(), n*3);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0), ONE = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < n; i++) {
    const p = nodes[i], J = junctionAt(p.x, p.z, roads), A = J.A;
    const dx = A.dir[0], dz = A.dir[1], hw = A.hw;
    const px = -dz, pz = dx;                               // perpendicular to road A (toward its curb)
    const ux = dx, uz = dz;                               // along road A
    // Plant the pole on the intersection CORNER: offset off road A to the side AND back
    // along road A past the cross road's curb, so it clears BOTH carriageways. With no
    // cross road it falls back to a simple roadside pole.
    const MARGIN = 2.2;
    const back = J.B ? (J.B.hw + MARGIN) : 0;             // step clear of the cross road
    const OFF = hw + MARGIN;                              // pole off road A, onto the corner
    const HEADOFF = Math.max(1.6, hw - 0.6);              // head hangs just inside road A's near curb
    const ARM = OFF - HEADOFF;                            // short mast arm over the near lane edge only
    const bx = p.x + px*OFF + ux*back, bz = p.z + pz*OFF + uz*back, gy = terrain(bx, bz);
    signPosts.push({ x: bx, z: bz });                      // reserve so later signs steer clear
    m.makeTranslation(bx, gy + 3.2, bz); poles.setMatrixAt(i, m);
    q.setFromAxisAngle(UP, Math.atan2(pz, -px));           // arm crosses the road (perpendicular)
    pos.set(bx - px*ARM/2, gy + 6.2, bz - pz*ARM/2); scl.set(ARM, 1, 1);
    m.compose(pos, q, scl); arms.setMatrixAt(i, m);
    // head over road A's near lane, at the corner; lens face turned ALONG the road toward oncoming traffic
    const hx = p.x + px*HEADOFF + ux*back, hz = p.z + pz*HEADOFF + uz*back, hy = gy + 5.3;
    q.setFromAxisAngle(UP, Math.atan2(dx, dz));
    pos.set(hx, hy, hz); m.compose(pos, q, ONE); heads.setMatrixAt(i, m);
    const fx = dx*0.3, fz = dz*0.3, base = i*3;            // lenses on the road-facing face, stacked R/A/G
    m.makeTranslation(hx + fx, hy + 0.46, hz + fz); lamps.setMatrixAt(base + 0, m);
    m.makeTranslation(hx + fx, hy,        hz + fz); lamps.setMatrixAt(base + 1, m);
    m.makeTranslation(hx + fx, hy - 0.46, hz + fz); lamps.setMatrixAt(base + 2, m);
    const group = Math.abs(dx) >= Math.abs(dz) ? 0 : 1;   // cross streets alternate
    signals.push({ x: p.x, z: p.z, dir: [dx, dz], group, base, state: -1 });
  }
  poles.instanceMatrix.needsUpdate = arms.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = lamps.instanceMatrix.needsUpdate = true;
  poles.frustumCulled = arms.frustumCulled = heads.frustumCulled = lamps.frustumCulled = false;
  worldGroup.add(poles, arms, heads, lamps);
  signalLamps = lamps; signalTime = 0; applySignalStates(true);
}

function makeSignTexture(draw) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 256;
  draw(cv.getContext('2d'));
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// Stop signs: pole BEHIND the sign; STOP on the front face only (facing traffic),
// plain grey back (no mirrored text). Offset to the roadside.
function buildStopSigns(nodes, roads) {
  if (!nodes.length) return;
  const n = Math.min(nodes.length, 150);
  const octPath = g => { g.beginPath(); for (let i = 0; i < 8; i++) { const a = Math.PI/8 + i*Math.PI/4, x = 128 + Math.cos(a)*118, y = 128 + Math.sin(a)*118; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.closePath(); };
  const frontTex = makeSignTexture(g => {
    g.clearRect(0, 0, 256, 256); octPath(g);
    g.fillStyle = '#c12026'; g.fill(); g.lineWidth = 9; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = '#fff'; g.font = 'bold 58px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('STOP', 128, 132);
  });
  const backTex = makeSignTexture(g => {
    g.clearRect(0, 0, 256, 256); octPath(g); g.fillStyle = '#8c8c8c'; g.fill(); g.lineWidth = 8; g.strokeStyle = '#6f6f6f'; g.stroke();
  });
  const plateGeo = new THREE.PlaneGeometry(0.95, 0.95);
  // alphaTest (not transparent blending) -> the octagon writes depth in the OPAQUE pass, so the
  // pole behind it is occluded by normal depth testing and never z-fights/bleeds through the face.
  const signMat = new THREE.MeshLambertMaterial({ map: frontTex, alphaTest: 0.5, side: THREE.FrontSide });
  const backMat = new THREE.MeshLambertMaterial({ map: backTex,  alphaTest: 0.5, side: THREE.FrontSide });
  const poles  = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 2.8, 6), new THREE.MeshLambertMaterial({ color: 0x9a9a9a }), n);
  const fronts = new THREE.InstancedMesh(plateGeo, signMat, n);
  const backs  = new THREE.InstancedMesh(plateGeo, backMat, n); // plain grey back (no letters) — the pole-side face
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), ONE = new THREE.Vector3(1,1,1), UP = new THREE.Vector3(0,1,0);
  for (let i = 0; i < n; i++) {
    const p = nodes[i], J = junctionAt(p.x, p.z, roads), A = J.A, dx = A.dir[0], dz = A.dir[1], hw = A.hw;
    const px = -dz, pz = dx, ux = dx, uz = dz;             // perpendicular + along road A
    // Plant on the approach CORNER: off road A to the side, AND back along road A AWAY from
    // the intersection centre. The stop node sits at the stop line, so we must step toward
    // the approach (away from the nearest real junction) or the sign lands in the carriageway.
    const MARGIN = 1.8, OFF = hw + MARGIN;
    let backSign = 1, cd = Infinity, center = null;
    for (const nd of roadNodes) { if (nd.nb.length < 3) continue; const d = (nd.x-p.x)*(nd.x-p.x)+(nd.z-p.z)*(nd.z-p.z); if (d < cd) { cd = d; center = nd; } }
    if (center && cd < 900) backSign = ((p.x-center.x)*ux + (p.z-center.z)*uz) >= 0 ? 1 : -1;
    const back = J.B ? (J.B.hw + MARGIN) * backSign : 0;
    // Snap the corner candidate ONTO the sidewalk band so the pole can never sit in the
    // carriageway (e.g. when the side offset crosses the cross-street, as it used to).
    const snapped = snapToSidewalk(p.x + px*OFF + ux*back, p.z + pz*OFF + uz*back, roads);
    // nudge clear of any pole already planted on this corner (steps back along the approach)
    const spot = reserveSignSpot(snapped.x, snapped.z, ux*backSign, uz*backSign, roads);
    const sx = spot.x, sz = spot.z, gy = terrain(sx, sz);
    m.makeTranslation(sx - dx*0.22, gy + 1.4, sz - dz*0.22); poles.setMatrixAt(i, m); // pole tucked well behind both faces
    q.setFromAxisAngle(UP, Math.atan2(dx, dz));            // front faces +road dir
    pos.set(sx + dx*0.07, gy + 2.5, sz + dz*0.07); m.compose(pos, q, ONE); fronts.setMatrixAt(i, m);
    q.setFromAxisAngle(UP, Math.atan2(-dx, -dz));          // grey back faces the other way
    pos.set(sx - dx*0.07, gy + 2.5, sz - dz*0.07); m.compose(pos, q, ONE); backs.setMatrixAt(i, m);
  }
  poles.instanceMatrix.needsUpdate = fronts.instanceMatrix.needsUpdate = backs.instanceMatrix.needsUpdate = true;
  poles.frustumCulled = fronts.frustumCulled = backs.frustumCulled = false;
  worldGroup.add(poles, fronts, backs);
}

// Green street-name signs (one per unique road name, capped), oriented along the road.
function buildStreetSigns(roadPolys) {
  const seen = new Set(); let count = 0; const cap = 60;
  const poleGeo = new THREE.CylinderGeometry(0.05, 0.05, 3.3, 6), poleMat = new THREE.MeshLambertMaterial({ color: 0x8a8a8a });
  const plateGeo = new THREE.PlaneGeometry(3.0, 3.0);
  for (const r of roadPolys) {
    if (count >= cap) break;
    if (!r.name || r.bridge || r.pts.length < 2 || seen.has(r.name)) continue;
    seen.add(r.name);
    // Plant the blade on an intersection CORNER (a road endpoint), never mid-block. Use the same
    // corner placement as the stop signs / traffic lights: off road r to the side AND stepped back
    // into the approach past the cross street, so the pole lands on the sidewalk, not the asphalt.
    const last = r.pts.length - 1;
    const ends = [
      { p: r.pts[0],    nx: r.pts[1].x - r.pts[0].x,        nz: r.pts[1].z - r.pts[0].z },        // into the road from start
      { p: r.pts[last], nx: r.pts[last-1].x - r.pts[last].x, nz: r.pts[last-1].z - r.pts[last].z }, // into the road from end
    ];
    let pick = null;
    for (const e of ends) { const J = junctionAt(e.p.x, e.p.z, roadPolys); if (J.B) { pick = { e, J }; break; } if (!pick) pick = { e, J }; }
    const ep = pick.e, J = pick.J;
    let dx = ep.nx, dz = ep.nz; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; // along road, INTO it (away from the junction)
    const px = -dz, pz = dx;                                // perpendicular, toward the curb
    const side = (r.w || 6)/2 + 1.6;                        // just past road r's curb
    const backDist = (J.B ? J.B.hw : 0) + 2.2;             // step into the approach, clear of the cross street
    const snapped = snapToSidewalk(ep.p.x + px*side + dx*backDist, ep.p.z + pz*side + dz*backDist, roadPolys);
    // nudge clear of stop signs / traffic-light poles already on this corner (steps into the approach)
    const spot = reserveSignSpot(snapped.x, snapped.z, dx, dz, roadPolys);
    const polex = spot.x, polez = spot.z, gy = terrain(polex, polez);
    // mount the blade so the POLE sits at its left edge (not through the middle)
    const bx = polex + dx*1.35, bz = polez + dz*1.35;
    // auto-fit font so the full name has padding and never touches the sides
    const tex = makeSignTexture(g => {
      g.clearRect(0,0,256,256);
      g.fillStyle = '#1c7a3f'; g.fillRect(0,88,256,80);
      g.strokeStyle = '#fff'; g.lineWidth = 5; g.strokeRect(8,95,240,66);
      const name = r.name.length > 26 ? r.name.slice(0,25) + '…' : r.name;
      let fs = 38; g.font = `bold ${fs}px sans-serif`;
      while (g.measureText(name).width > 208 && fs > 13) { fs -= 2; g.font = `bold ${fs}px sans-serif`; }
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(name, 128, 129);
    });
    // two single-sided plates (one flipped 180°) -> name reads correctly from BOTH sides, no mirror needed.
    // alphaTest (opaque pass) so the pole behind the blade edge is occluded cleanly (no see-through).
    const ang = -Math.atan2(dz, dx), nx = -dz, nz = dx;    // plate normal (faces across the road)
    const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.FrontSide });
    const pole = new THREE.Mesh(poleGeo, poleMat); pole.position.set(polex, gy + 1.65, polez);
    const front = new THREE.Mesh(plateGeo, mat);
    front.position.set(bx + nx*0.06, gy + 2.8, bz + nz*0.06); front.rotation.y = ang;
    const back = new THREE.Mesh(plateGeo, mat);
    back.position.set(bx - nx*0.06, gy + 2.8, bz - nz*0.06); back.rotation.y = ang + Math.PI;
    worldGroup.add(pole, front, back);
    count++;
  }
}
// bridge decks, so the car can drive over them rather than dip to the water below
let bridges = [];
// water clamp (set in buildWorld = waterYAt): keeps the CAR riding on the water surface
// instead of sinking to the riverbed terrain below it. The road MESH is already clamped
// above water (roadY), but the car's height comes from driveHeight — without this the car
// followed raw terrain down into the creek and ended up submerged under the floating road.
let waterClampFn = null;
let renderedWaterFn = null;   // true VISIBLE-water test (river ribbon + lake polygon); for the bridge deck floor
// deck arch profile: smoothly 0 at the ends -> 1 across the middle plateau (smoothstep, no kinks)
function bridgeBump(t) { const r = Math.max(0, Math.min(1, Math.min(t, 1 - t) / 0.3)); return r*r*(3 - 2*r); }
// Height of whatever the car is resting on at (x,z). `curY` (the car's CURRENT height) lets the
// function disambiguate a bridge deck from the ground beneath it: pass it and you stay on the level
// you're already on, so you can drive UNDER a span (stay low) instead of being yanked onto the deck.
// Omit curY (NPCs, spawn, look-ahead probes) and it defaults to the deck when over a span.
function driveHeight(x, z, curY) {
  let ground = surfaceHeight(x, z);
  // never let the car sink below the water surface (it rides just under the road top,
  // matching roadY's water clamp) — bridges below override this with their higher deck
  if (waterClampFn) { const w = waterClampFn(x, z); if (w > -Infinity && w + 0.42 > ground) ground = w + 0.42; }
  let deck = -Infinity;
  for (const br of bridges) {
    const pts = br.pts; let bd = Infinity, bt = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x, az = pts[i].z, dx = pts[i+1].x - ax, dz = pts[i+1].z - az;
      const l2 = dx*dx + dz*dz || 1;
      let t = ((x - ax)*dx + (z - az)*dz) / l2; t = Math.max(0, Math.min(1, t));
      const cx = ax + dx*t, cz = az + dz*t, d = Math.hypot(x - cx, z - cz);
      if (d < bd) { bd = d; bt = (i + t) / (pts.length - 1); }
    }
    if (bd < br.hw + 1.5) {
      const base = br.eStart + (br.eEnd - br.eStart) * bt;
      const dk = base + Math.max(0, br.plateau - base) * bridgeBump(bt) + 0.15;
      if (dk > deck) deck = dk;
    }
  }
  if (deck <= ground) return ground;                 // no span overhead (or its ends meet the road)
  if (curY == null) return deck;                     // no height context: ride the deck
  // Near a bridge END the deck has ramped down to road level (deck ≈ ground): it IS the road
  // there, so snap onto it. Without this the approach—where deck barely clears the ground—tips
  // the midpoint test toward `ground`, and as the deck then arches up over the water the car
  // stays latched to the dropping terrain and sinks through the deck. Only where there's real
  // clearance (a genuine under-pass) do we keep whichever level the car is already on.
  if (deck - ground < 1.5) return deck;              // on/at the ramp: the deck is the road
  return (curY >= (ground + deck) * 0.5) ? deck : ground;
}

// Continuous road ribbon with mitred joints (no gaps/jaggies at bends),
// draped over the terrain. Appends triangles to `out` (front face up).
// Subdivide a polyline so no segment is longer than maxLen (roads hug the hills).
function densify(pts, maxLen) {
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i+1], d = Math.hypot(b.x - a.x, b.z - a.z);
    const k = Math.max(1, Math.ceil(d / maxLen));
    for (let j = 1; j <= k; j++) out.push({ x: a.x + (b.x - a.x)*j/k, z: a.z + (b.z - a.z)*j/k });
  }
  return out;
}

// Chaikin corner-cutting: rounds sharp bends in a polyline into smooth curves while
// keeping the endpoints fixed (so roads still meet exactly at junctions). Collinear
// runs are left straight, so grid streets stay straight.
function roundCorners(pts, iters) {
  if (pts.length < 3) return pts;
  let p = pts;
  for (let it = 0; it < iters; it++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i+1];
      out.push({ x: a.x*0.75 + b.x*0.25, z: a.z*0.75 + b.z*0.25 });
      out.push({ x: a.x*0.25 + b.x*0.75, z: a.z*0.25 + b.z*0.75 });
    }
    out.push(p[p.length-1]);
    p = out;
  }
  return p;
}

// Left/right edge points of a ribbon of half-width hw (mitred at joints).
function offsets(pts, hw) {
  const n = pts.length;
  const seg = [];
  for (let i = 0; i < n - 1; i++) {
    let dx = pts[i+1].x - pts[i].x, dz = pts[i+1].z - pts[i].z; const l = Math.hypot(dx, dz) || 1;
    seg.push([dx/l, dz/l]);
  }
  const Lx = [], Lz = [], Rx = [], Rz = [];
  for (let i = 0; i < n; i++) {
    let tx, tz;
    if (i === 0) { tx = seg[0][0]; tz = seg[0][1]; }
    else if (i === n-1) { tx = seg[n-2][0]; tz = seg[n-2][1]; }
    else { tx = seg[i-1][0] + seg[i][0]; tz = seg[i-1][1] + seg[i][1]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l; }
    let mx = -tz, mz = tx, scale = hw;
    // Cap the miter by a small ABSOLUTE extension (not a multiple of the width) so a sharp
    // corner bevels by ~0.8 m instead of spiking a long flap out into a merge/intersection.
    if (i > 0 && i < n-1) { const cos = mx*(-seg[i-1][1]) + mz*(seg[i-1][0]); scale = Math.min(hw / Math.max(0.4, Math.abs(cos)), hw + 0.8); }
    Lx.push(pts[i].x + mx*scale); Lz.push(pts[i].z + mz*scale);
    Rx.push(pts[i].x - mx*scale); Rz.push(pts[i].z - mz*scale);
  }
  return { Lx, Lz, Rx, Rz };
}

// Continuous ribbon, densified & draped. Height comes from yFn(cx, cz, frac)
// sampled at the CENTRELINE per station -> road stays flat across its width
// (no banking/tearing) while following the road profile along its length.
function ribbon(rawPts, hw, out, yFn) {
  const pts = densify(rawPts, 6);
  const n = pts.length; if (n < 2) return;
  const { Lx, Lz, Rx, Rz } = offsets(pts, hw);
  // sample height at EACH edge (not the centreline) so the surface hugs cross-slopes and the
  // ground can't poke over the uphill edge. (For bridges yFn ignores x,z and uses frac -> stays flat.)
  const yL = [], yR = [];
  for (let i = 0; i < n; i++) {
    const frac = i / (n - 1);
    yL.push(yFn(Lx[i], Lz[i], frac));
    yR.push(yFn(Rx[i], Rz[i], frac));
  }
  for (let i = 0; i < n-1; i++) {
    out.push(
      Lx[i],yL[i],Lz[i],  Rx[i+1],yR[i+1],Rz[i+1],  Rx[i],yR[i],Rz[i],
      Lx[i],yL[i],Lz[i],  Lx[i+1],yL[i+1],Lz[i+1],  Rx[i+1],yR[i+1],Rz[i+1]
    );
  }
}

// Bridge structure: parapets, slab underside, and support pillars to the ground.
// onStreet(x,z) (optional) reports whether a point sits on a non-bridge road surface, so
// supports can be slid off cross-streets they'd otherwise land in the middle of.
function bridgeStructure(rawPts, hw, deckFn, out, onStreet) {
  const pts = densify(rawPts, 3);                          // match the deck so the fascia follows it smoothly
  const n = pts.length; if (n < 2) return;
  const RAIL_H = 0.95;
  const { Lx, Lz, Rx, Rz } = offsets(pts, hw + 0.35);
  const deck = [], und = [];
  for (let i = 0; i < n; i++) { const d = deckFn(pts[i].x, pts[i].z, i/(n-1)); deck.push(d); und.push(d - 0.6); }
  const quad = (ax,ay,az, bx,by,bz, cx,cy,cz, dx,dy,dz) =>
    out.push(ax,ay,az, bx,by,bz, cx,cy,cz,  ax,ay,az, cx,cy,cz, dx,dy,dz);
  for (let i = 0; i < n-1; i++) {
    // underside slab
    quad(Lx[i],und[i],Lz[i], Rx[i],und[i],Rz[i], Rx[i+1],und[i+1],Rz[i+1], Lx[i+1],und[i+1],Lz[i+1]);
    // solid slab sides: underside up to the DECK level only (no thin railing wall above,
    // which read as stray blades) -> a clean solid deck with visible thickness
    quad(Lx[i],und[i],Lz[i], Lx[i+1],und[i+1],Lz[i+1], Lx[i+1],deck[i+1],Lz[i+1], Lx[i],deck[i],Lz[i]);
    quad(Rx[i],und[i],Rz[i], Rx[i+1],und[i+1],Rz[i+1], Rx[i+1],deck[i+1],Rz[i+1], Rx[i],deck[i],Rz[i]);
    // parapet RAILS along both edges (visible wall) + crash-wall segments so the car can't
    // drive off the side and fall — guarding the deck's height band only (under-roads pass free)
    quad(Lx[i],deck[i],Lz[i], Lx[i+1],deck[i+1],Lz[i+1], Lx[i+1],deck[i+1]+RAIL_H,Lz[i+1], Lx[i],deck[i]+RAIL_H,Lz[i]);
    quad(Rx[i],deck[i],Rz[i], Rx[i+1],deck[i+1],Rz[i+1], Rx[i+1],deck[i+1]+RAIL_H,Rz[i+1], Rx[i],deck[i]+RAIL_H,Rz[i]);
    addWallSeg(Lx[i],Lz[i], Lx[i+1],Lz[i+1], deck[i], RAIL_H + 1.5);
    addWallSeg(Rx[i],Rz[i], Rx[i+1],Rz[i+1], deck[i], RAIL_H + 1.5);
  }
  // support pillars every ~36 m, where the deck is well above the ground
  for (let i = 6; i < n-6; i += 6) {
    // Keep supports out of the middle of cross-streets the bridge passes over: if the
    // default sample lands on pavement, slide along the span to the nearest clear point;
    // if the whole stretch is over road, skip the pillar rather than block the street.
    let bi = i;
    if (onStreet && onStreet(pts[bi].x, pts[bi].z)) {
      let found = -1;
      for (let d = 1; d <= 5 && found < 0; d++) {
        if (i-d >= 1   && !onStreet(pts[i-d].x, pts[i-d].z)) found = i-d;
        else if (i+d <= n-2 && !onStreet(pts[i+d].x, pts[i+d].z)) found = i+d;
      }
      if (found < 0) continue;
      bi = found;
    }
    const cx = pts[bi].x, cz = pts[bi].z, gy = terrain(cx, cz), topY = und[bi];
    if (topY - gy < 3) continue;
    const s = 1.2;
    const corners = [[cx-s,cz-s],[cx+s,cz-s],[cx+s,cz+s],[cx-s,cz+s]];
    for (let k = 0; k < 4; k++) {
      const a = corners[k], b = corners[(k+1)%4];
      quad(a[0],gy,a[1], b[0],gy,b[1], b[0],topY,b[1], a[0],topY,a[1]);
    }
  }
}
