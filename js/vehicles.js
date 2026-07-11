// SimDrive — vehicles.js
// player + NPC cars, dashboard gauges, collision grid, crash walls, road graph, traffic
// Loaded as a classic script by js/bootstrap.js; all app files share one global
// scope (the original single-file behaviour), with THREE/addons exposed as globals.


//----------------------------------------------------------------------------
// Cars
//----------------------------------------------------------------------------
const CARS = [
  { name: 'Coupe', body: 0xe0454a, trim: 0x1b1c20, accel: 0.5, top: 26, grip: 0.86 },
  { name: 'Van',   body: 0x4a90d0, trim: 0x39414e, accel: 0.34, top: 20, grip: 0.90 },
  { name: 'Sport', body: 0xffd54a, trim: 0x2a1416, accel: 0.7, top: 33, grip: 0.80 },
  { name: 'Truck', body: 0x3aa05a, trim: 0x3a2c1c, accel: 0.3, top: 18, grip: 0.93 },
  { name: 'Taxi',  body: 0xf0a000, trim: 0x222024, accel: 0.46, top: 25, grip: 0.87 },
];

// Shared geometries so 12+ NPC cars stay cheap.
const _wheelGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.32, 14);
const _carBodyGeo = new RoundedBoxGeometry(4.6, 0.95, 2.0, 3, 0.34);
const _carLowerGeo = new RoundedBoxGeometry(4.3, 0.55, 2.05, 2, 0.26);
const _carGlassGeo = new RoundedBoxGeometry(2.45, 0.72, 1.74, 2, 0.3);
const _carRoofGeo = new RoundedBoxGeometry(2.05, 0.22, 1.62, 2, 0.16);
const _carNoseGeo = new RoundedBoxGeometry(1.0, 0.5, 1.9, 2, 0.22);
const _hlGeo = new RoundedBoxGeometry(0.18, 0.24, 0.4, 1, 0.07);
const _wheelMat = new THREE.MeshLambertMaterial({ color: 0x121214 });
const _glassMat = new THREE.MeshLambertMaterial({ color: 0x1b2a36 });
const _hlMat = new THREE.MeshLambertMaterial({ color: 0xfff4d6, emissive: 0x4a3c10 });
const _tlMat = new THREE.MeshLambertMaterial({ color: 0xcc2222, emissive: 0x3a0808 });

function makeCarMesh(color) {
  const grp = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color });
  // lower sill (slightly inset, darker) + main body
  const lower = new THREE.Mesh(_carLowerGeo, new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.6) }));
  lower.position.y = 0.5;
  const body = new THREE.Mesh(_carBodyGeo, bodyMat); body.position.y = 0.78;
  const nose = new THREE.Mesh(_carNoseGeo, bodyMat); nose.position.set(1.85, 0.66, 0);  // sloped hood/nose
  const glass = new THREE.Mesh(_carGlassGeo, _glassMat); glass.position.set(-0.18, 1.4, 0);
  const roof = new THREE.Mesh(_carRoofGeo, bodyMat); roof.position.set(-0.3, 1.74, 0);
  grp.add(lower, body, nose, glass, roof);
  // wheels
  for (const [wx, wz] of [[1.45, 0.98], [1.45, -0.98], [-1.5, 0.98], [-1.5, -0.98]]) {
    const w = new THREE.Mesh(_wheelGeo, _wheelMat); w.rotation.x = Math.PI/2; w.position.set(wx, 0.4, wz); grp.add(w);
  }
  // head/tail lights
  for (const z of [0.6, -0.6]) {
    const h = new THREE.Mesh(_hlGeo, _hlMat); h.position.set(2.32, 0.72, z); grp.add(h);
    const t = new THREE.Mesh(_hlGeo, _tlMat); t.position.set(-2.32, 0.82, z); grp.add(t);
  }
  grp.traverse(o => { o.castShadow = true; });
  grp.userData.bodyMat = bodyMat;
  return grp;
}

// player position in WORLD METERS (x east, z south); speed in m/s scaled by dt-frames
// vy = vertical velocity (m/s) for the gravity/fall model; 0 while grounded.
const player = { x: 0, z: 0, y: 0, vy: 0, ang: 0, speed: 0, type: 0, steerVis: 0 };
const GRAVITY = 26;                          // m/s² — arcade-ish, snappy fall off ledges/bridge ends

// --- 2D dash HUD: speedometer canvas (the minimap canvas draws separately) ---
const speedCanvas = document.getElementById('speedHud');
const speedCtx = speedCanvas.getContext('2d');
function drawSpeedGauge(mph, accent) {
  // Round instrument dial: bezel, tick scale, swept value arc + needle, digital readout.
  const g = speedCtx, S = 200, cx = S/2, cy = S/2, R = 84, MAX = 100;
  const A0 = Math.PI*0.75, SWEEP = Math.PI*1.5;          // 135° start, 270° sweep (gap at bottom)
  const hot = mph > 60;
  g.clearRect(0, 0, S, S);
  // bezel + dial face
  g.beginPath(); g.arc(cx, cy, 95, 0, 7); g.fillStyle = '#15181e'; g.fill();
  g.beginPath(); g.arc(cx, cy, 88, 0, 7); g.fillStyle = '#0a0d12'; g.fill();
  g.lineWidth = 3; g.strokeStyle = '#22272f'; g.beginPath(); g.arc(cx, cy, 90, 0, 7); g.stroke();
  // tick scale
  for (let s = 0; s <= MAX; s += 10) {
    const a = A0 + SWEEP*(s/MAX), ca = Math.cos(a), sa = Math.sin(a), major = s % 20 === 0;
    g.strokeStyle = s > 60 ? 'rgba(255,90,74,.85)' : 'rgba(185,208,240,.55)';
    g.lineWidth = major ? 3 : 1.5;
    g.beginPath(); g.moveTo(cx+ca*(R-1), cy+sa*(R-1)); g.lineTo(cx+ca*(R-(major?13:8)), cy+sa*(R-(major?13:8))); g.stroke();
    if (major) { g.fillStyle = '#7f93ad'; g.font = 'bold 12px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(s), cx+ca*(R-27), cy+sa*(R-27)); }
  }
  // swept value arc
  const frac = Math.max(0, Math.min(1, mph/MAX)), va = A0 + SWEEP*frac;
  g.lineCap = 'round'; g.lineWidth = 6; g.strokeStyle = hot ? '#ff5a4a' : accent;
  g.beginPath(); g.arc(cx, cy, R+7, A0, va); g.stroke();
  // needle + hub
  g.strokeStyle = hot ? '#ff8a7a' : '#dce9ff'; g.lineWidth = 3.5;
  g.beginPath(); g.moveTo(cx-Math.cos(va)*13, cy-Math.sin(va)*13); g.lineTo(cx+Math.cos(va)*(R-16), cy+Math.sin(va)*(R-16)); g.stroke();
  g.beginPath(); g.arc(cx, cy, 6, 0, 7); g.fillStyle = '#dce9ff'; g.fill();
  // digital readout (in the open bottom of the dial)
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.fillStyle = hot ? '#ff8a7a' : '#eaf2ff'; g.font = 'bold 40px sans-serif'; g.fillText(String(mph), cx, cy+46);
  g.fillStyle = '#6f8aa6'; g.font = 'bold 11px sans-serif'; g.fillText('MPH', cx, cy+62);
}

function makeInterior(car) {
  const g = new THREE.Group();
  const trim   = new THREE.MeshLambertMaterial({ color: car.trim, emissive: 0x16181c });
  const trimHi = new THREE.MeshLambertMaterial({ color: new THREE.Color(car.trim).multiplyScalar(1.5).addScalar(0.04), emissive: 0x141518 });
  const accent = new THREE.MeshLambertMaterial({ color: car.body, emissive: new THREE.Color(car.body).multiplyScalar(0.16) });
  const bezel = new THREE.MeshLambertMaterial({ color: 0x0c0d10, emissive: 0x070809 });

  // --- dashboard surface + accent line + distant hood ---
  const dash = new THREE.Mesh(new RoundedBoxGeometry(6.6, 0.95, 1.2, 2, 0.22), trim);
  dash.position.set(0, -0.95, -1.45); dash.rotation.x = 0.26;
  const strip = new THREE.Mesh(new RoundedBoxGeometry(5.8, 0.07, 0.05, 1, 0.03), accent);
  strip.position.set(0, -0.5, -1.04);
  const hood = new THREE.Mesh(new RoundedBoxGeometry(4.6, 0.3, 1.7, 2, 0.14), accent);
  hood.position.set(0, -1.5, -2.7);

  // --- driver speedometer cluster (upper-left, thin bezel, clear of the wheel) ---
  const cBezel = new THREE.Mesh(new RoundedBoxGeometry(1.34, 0.76, 0.1, 2, 0.08), bezel);
  cBezel.position.set(-1.0, -0.26, -1.06); cBezel.rotation.x = 0.24;
  const cluster = new THREE.Mesh(new THREE.PlaneGeometry(1.18, 0.62), new THREE.MeshBasicMaterial({ map: speedTex }));
  cluster.position.set(-1.0, -0.26, -1.0); cluster.rotation.x = 0.24;

  // --- centre console map (centre-right, bigger, fully visible) ---
  const mBezel = new THREE.Mesh(new RoundedBoxGeometry(1.2, 1.02, 0.1, 2, 0.08), bezel);
  mBezel.position.set(0.6, -0.32, -1.06); mBezel.rotation.x = 0.16;
  const mapScreen = new THREE.Mesh(new THREE.PlaneGeometry(1.04, 0.86), new THREE.MeshBasicMaterial({ map: mapTex }));
  mapScreen.position.set(0.6, -0.32, -1.0); mapScreen.rotation.x = 0.16;

  // --- steering wheel (low, below the cluster so it never clips the screen) ---
  const wheel = new THREE.Group(), spin = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.06, 10, 28), trimHi);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.09, 16), trim); hub.rotation.x = Math.PI/2;
  const badge = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.11, 12), accent); badge.rotation.x = Math.PI/2;
  spin.add(rim, hub, badge);
  for (const a of [Math.PI*1.5, Math.PI*0.83, Math.PI*0.17]) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.07, 0.045), trimHi);
    s.position.set(Math.cos(a)*0.26, Math.sin(a)*0.26, 0); s.rotation.z = a; spin.add(s);
  }
  wheel.add(spin); wheel.position.set(-1.0, -1.0, -0.84); wheel.rotation.x = -0.72;

  // --- windshield frame: A-pillars, roof header, mirror ---
  const pillarGeo = new RoundedBoxGeometry(0.2, 3.4, 0.2, 1, 0.08);
  const pL = new THREE.Mesh(pillarGeo, trim); pL.position.set(-2.4, 0.6, -1.55); pL.rotation.z = 0.24;
  const pR = new THREE.Mesh(pillarGeo, trim); pR.position.set(2.4, 0.6, -1.55); pR.rotation.z = -0.24;
  const roof = new THREE.Mesh(new RoundedBoxGeometry(5.4, 0.32, 1.05, 2, 0.14), trim); roof.position.set(0, 1.75, -1.55);
  const mirror = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.2, 0.1, 1, 0.06), bezel); mirror.position.set(0, 1.35, -1.35);

  // shrink ONLY the dash/screens/wheel into a small strip at the bottom; the windshield frame
  // stays full-size at the edges (scaling it too would pull the pillars/roof in and obstruct).
  const dashGroup = new THREE.Group();
  dashGroup.add(dash, strip, hood, cBezel, cluster, mBezel, mapScreen, wheel);
  dashGroup.scale.setScalar(0.5);
  dashGroup.position.set(0, -0.2, -0.08);
  g.add(dashGroup, pL, pR, roof, mirror);
  g.traverse(o => { o.castShadow = false; o.receiveShadow = false; });
  g.userData.spin = spin;
  return g;
}

let interior = null;
const playerCar = makeCarMesh(CARS[0].body);
scene.add(playerCar);
function setCar(i) {            // 2D HUD now — no 3D cockpit to build
  player.type = i;
  playerCar.userData.bodyMat.color.set(CARS[i].body);
}
setCar(0);

//----------------------------------------------------------------------------
// Collision grid (rasterized building/water footprints)
//----------------------------------------------------------------------------
let grid = null, gridCell = 2.5, gridMinX = 0, gridMinZ = 0, gridW = 0, gridH = 0;
let roadMask = null;                       // 1 = drivable pavement (roads + bridges)
let fenceHalf = Infinity;                  // invisible square wall: |x|,|z| can't exceed this
function blocked(wx, wz) {
  if (Math.abs(wx) > fenceHalf || Math.abs(wz) > fenceHalf) return true; // map edge
  if (!grid) return false;
  const cx = ((wx - gridMinX) / gridCell) | 0;
  const cz = ((wz - gridMinZ) / gridCell) | 0;
  if (cx < 0 || cz < 0 || cx >= gridW || cz >= gridH) return false;
  return grid[cz * gridW + cx] === 1;
}
// Is this spot on the paved road surface? Used to drag the car when it leaves the road.
function onRoad(wx, wz) {
  if (!roadMask) return true;
  const cx = ((wx - gridMinX) / gridCell) | 0;
  const cz = ((wz - gridMinZ) / gridCell) | 0;
  if (cx < 0 || cz < 0 || cx >= gridW || cz >= gridH) return false;
  return roadMask[cz * gridW + cx] === 1;
}
// ---- height-aware crash walls: bridge rails + highway barriers ----
// Thin wall SEGMENTS the car can't cross, bucketed in a spatial hash for cheap per-frame
// lookup. Each guards a vertical band [y, y+h] so a wall on the deck above doesn't block a
// road passing underneath (and vice-versa).
let wallSegs = null;
const WALL_BUCKET = 8, CAR_HALF = 1.05, CAR_HALF2 = CAR_HALF * CAR_HALF;
function addWallSeg(ax, az, bx, bz, y, h) {
  if (!wallSegs) wallSegs = new Map();
  const seg = { ax, az, bx, bz, y, h };
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / WALL_BUCKET));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, k = (((ax + (bx-ax)*t) / WALL_BUCKET) | 0) + ',' + (((az + (bz-az)*t) / WALL_BUCKET) | 0);
    let arr = wallSegs.get(k); if (!arr) { arr = []; wallSegs.set(k, arr); }
    if (arr[arr.length - 1] !== seg) arr.push(seg);
  }
}
function wallBlocked(x, z, y) {
  if (!wallSegs) return false;
  const bx = (x / WALL_BUCKET) | 0, bz = (z / WALL_BUCKET) | 0;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const arr = wallSegs.get((bx + dx) + ',' + (bz + dz)); if (!arr) continue;
    for (const s of arr) {
      // Wrong height band -> this wall doesn't apply. The band starts only 0.5 below the
      // deck: any deeper caught roads passing UNDER low ramps (River St under Hill-to-Hill)
      // and walled them shut; a car ON the deck sits exactly at s.y, so 0.5 is plenty.
      if (y < s.y - 0.5 || y > s.y + s.h) continue;
      const ex = s.bx - s.ax, ez = s.bz - s.az, l2 = ex*ex + ez*ez || 1;
      let t = ((x - s.ax)*ex + (z - s.az)*ez) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = s.ax + ex*t, pz = s.az + ez*t;
      if ((x - px)**2 + (z - pz)**2 < CAR_HALF2) return true;
    }
  }
  return false;
}
function pointInPoly(px, pz, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z, xj = poly[j].x, zj = poly[j].z;
    if (((zi > pz) !== (zj > pz)) && (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}

//----------------------------------------------------------------------------
// Road graph (for spawn + NPC traffic)
//----------------------------------------------------------------------------
let roadNodes = [];
function buildGraph(roadPolys) {
  const nodeMap = new Map();
  const key = (x, z) => Math.round(x) + '_' + Math.round(z);
  function node(x, z) { const k = key(x, z); let n = nodeMap.get(k); if (!n) { n = { x, z, nb: [] }; nodeMap.set(k, n); } return n; }
  for (const poly of roadPolys) {
    for (let i = 0; i < poly.length - 1; i++) {
      const a = node(poly[i].x, poly[i].z), b = node(poly[i+1].x, poly[i+1].z);
      if (a !== b) { if (!a.nb.includes(b)) a.nb.push(b); if (!b.nb.includes(a)) b.nb.push(a); }
    }
  }
  roadNodes = [...nodeMap.values()].filter(n => n.nb.length > 0);
}

//----------------------------------------------------------------------------
// NPC traffic
//----------------------------------------------------------------------------
let NPCS = [];
function spawnNPCs(count) {
  NPCS = [];
  if (roadNodes.length < 2) return;
  for (let i = 0; i < count; i++) {
    const from = roadNodes[(Math.random() * roadNodes.length) | 0];
    if (!from.nb.length) continue;
    const to = from.nb[(Math.random() * from.nb.length) | 0];
    const col = CARS[(Math.random() * CARS.length) | 0].body;
    const mesh = makeCarMesh(col); worldGroup.add(mesh);
    NPCS.push({ x: from.x, z: from.z, from, to, ang: Math.atan2(to.z - from.z, to.x - from.x),
      speed: 7 + Math.random() * 6, mesh });
  }
}
// Is there a RED signal ahead on this car's road within stopping range? returns distance or -1.
function redSignalAhead(nx, nz, hx, hz) {
  for (const s of signals) {
    if (s.state !== 2) continue;                          // only reds
    const vx = s.x - nx, vz = s.z - nz, ahead = vx*hx + vz*hz;
    if (ahead <= 0 || ahead > 9) continue;                // must be in front, close
    if (Math.abs(-vx*hz + vz*hx) > 4) continue;           // must be on our lane
    if (Math.abs(hx*s.dir[0] + hz*s.dir[1]) < 0.55) continue; // must control our road axis
    return ahead;
  }
  return -1;
}
function updateNPCs(dt) {
  const step = dt; // frames
  for (const n of NPCS) {
    const dx = n.to.x - n.x, dz = n.to.z - n.z;
    const dist = Math.hypot(dx, dz);
    let move = n.speed * 0.016 * step * 60 / 60; // ~ m per frame-unit
    const hx = dx / (dist || 1), hz = dz / (dist || 1);
    // stop at red lights
    const red = redSignalAhead(n.x, n.z, hx, hz);
    if (red >= 0 && red < 6.5) move = 0;
    n.ang = Math.atan2(dz, dx);
    if (move === 0) {
      // hold at the line
    } else if (dist < Math.max(1.5, move)) {
      // arrived: pick next node (avoid immediate U-turn when possible)
      const opts = n.to.nb.filter(x => x !== n.from);
      const next = (opts.length ? opts : n.to.nb)[(Math.random() * (opts.length ? opts.length : n.to.nb.length)) | 0];
      n.from = n.to; n.to = next || n.from;
      n.x = n.from.x; n.z = n.from.z;
      n.ang = Math.atan2(n.to.z - n.from.z, n.to.x - n.from.x);
    } else {
      n.x += hx * move; n.z += hz * move;
    }
    // keep to the right of the centre line so traffic flows with direction (drive on the right)
    const ox = -Math.sin(n.ang) * 2.1, oz = Math.cos(n.ang) * 2.1;
    const px = n.x + ox, pz = n.z + oz;
    n.mesh.position.set(px, driveHeight(px, pz), pz);
    n.mesh.rotation.y = -n.ang;
  }
}

//----------------------------------------------------------------------------
// World builder
//----------------------------------------------------------------------------
