// SimDrive — scene.js
// Three.js scene/camera/renderer/sky/sun, shared textures + geometry helpers
// Loaded as a classic script by js/bootstrap.js; all app files share one global
// scope (the original single-file behaviour), with THREE/addons exposed as globals.

//----------------------------------------------------------------------------
// Three.js scene (created once; world rebuilt per location)
//----------------------------------------------------------------------------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setClearColor(SKY);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 90, 560);

// ---- sunny gradient sky dome (zenith blue -> hazy horizon) ----
const skyDome = new THREE.Mesh(
  new THREE.SphereGeometry(1400, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { topCol: { value: new THREE.Color(SKY_TOP) }, horizonCol: { value: new THREE.Color(SKY) } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 topCol; uniform vec3 horizonCol; varying vec3 vDir;' +
      'void main(){ float h = clamp(normalize(vDir).y, 0.0, 1.0); float t = pow(h, 0.55); gl_FragColor = vec4(mix(horizonCol, topCol, t), 1.0); }'
  })
);
skyDome.renderOrder = -1;
scene.add(skyDome);   // stronger horizon haze: distant city fades into the sky

const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 1600);

scene.add(new THREE.HemisphereLight(0xccdcec, 0x6a7158, 0.95)); // brighter fill -> flatter, washed-out shading
const sun = new THREE.DirectionalLight(0xfff6e6, 0.8);            // softer sun -> lighter shadows (less harsh than realistic)
const SUN_OFF = new THREE.Vector3(120, 180, 70);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
const sc = sun.shadow.camera;
sc.near = 20; sc.far = 700; sc.left = -200; sc.right = 200; sc.top = 200; sc.bottom = -200;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 1.5; // prevents self-shadow acne on steep terrain slopes
scene.add(sun, sun.target);

const camLight = new THREE.PointLight(0xfff2e0, 6, 14, 2);
camLight.position.set(0, 0.2, -0.4);
camera.add(camLight);
scene.add(camera);

let worldGroup = new THREE.Group();
scene.add(worldGroup);

// Shared window-facade texture (tiles across building walls via UVs).
const ANISO = Math.min(4, renderer.capabilities.getMaxAnisotropy());
function canvasTex(size, draw, height) {
  const cv = document.createElement('canvas'); cv.width = size; cv.height = height || size;
  draw(cv.getContext('2d'));
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = ANISO; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// Facade atlases: each style is a 4x4 grid of 64px window cells with per-cell character
// (lit rooms, blinds, curtains, AC units, pane-tint jitter) so the tiling repeats every
// FOUR windows instead of every one — that per-window sameness was what read as "generic".
// Walls stay near-white so the per-building palette colour tints them; windows stay dark.
// cw/ch = metres per CELL (one window); n = cells per texture side (UVs divide by n).
const FN = 4;
function _wallBase(g, tone) {          // wall colour + masonry speckle + faint weather streaks
  g.fillStyle = tone; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) { const v = 200 + (Math.random()*40|0);
    g.fillStyle = `rgba(${v},${v-3},${v-10},0.15)`; g.fillRect(Math.random()*256|0, Math.random()*256|0, 2, 2); }
  for (let i = 0; i < 9; i++) { const x = Math.random()*256|0;
    g.fillStyle = `rgba(70,65,58,${0.03 + Math.random()*0.05})`; g.fillRect(x, 0, 2 + Math.random()*5, 256); }
}
// One glass pane with its own character; the frame/mullions are drawn OVER it by the caller.
function _pane(g, x, y, w, h, opts = {}) {
  const r = Math.random(), base = 52 + (Math.random()*16|0);       // slate tint jitter
  g.fillStyle = `rgb(${base-12},${base-4},${base+8})`; g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(165,180,195,0.25)'; g.fillRect(x, y, w, Math.max(2, h*0.18|0)); // sky reflection
  if (r < 0.08) {                                                  // lit interior (dim, warm)
    g.fillStyle = '#caa267'; g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(120,85,45,0.45)'; g.fillRect(x, y + (h*0.55|0), w, h - (h*0.55|0));
  } else if (r < 0.26) {                                           // blinds partway down
    const bh = (h * (0.25 + Math.random()*0.5)) | 0;
    g.fillStyle = '#cfc9bb'; g.fillRect(x, y, w, bh);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    for (let yy = y + 3; yy < y + bh; yy += 3) g.fillRect(x, yy, w, 1);
  } else if (r < 0.34 && opts.curtains) {                          // curtains at the edges
    const cw2 = Math.max(3, w*0.22|0);
    g.fillStyle = '#ded8cb'; g.fillRect(x, y, cw2, h); g.fillRect(x + w - cw2, y, cw2, h);
  }
}
function _cells(g, cell) { for (let cy = 0; cy < FN; cy++) for (let cx = 0; cx < FN; cx++) cell(g, cx*64, cy*64); }
const FACADES = [
  { cw: 3.4, ch: 3.6, n: FN, tex: canvasTex(256, g => {           // 0 office: regular glass grid
      _wallBase(g, '#ece9e3');
      _cells(g, (g, ox, oy) => {
        _pane(g, ox+9, oy+8, 46, 48);
        g.fillStyle='#d8d4cc'; g.fillRect(ox+9,oy+8,46,3); g.fillRect(ox+9,oy+53,46,3); g.fillRect(ox+9,oy+8,3,48); g.fillRect(ox+52,oy+8,3,48); g.fillRect(ox+30,oy+8,4,48); g.fillRect(ox+9,oy+30,46,4);
      }); }) },
  { cw: 2.8, ch: 3.2, n: FN, tex: canvasTex(256, g => {           // 1 residential: punched window + sill
      _wallBase(g, '#ece9e3');
      _cells(g, (g, ox, oy) => {
        _pane(g, ox+18, oy+12, 28, 32, { curtains: true });
        g.fillStyle='#ddd9d0'; g.fillRect(ox+18,oy+12,28,3); g.fillRect(ox+31,oy+12,2,32); g.fillRect(ox+18,oy+27,28,2);
        g.fillStyle='#cfcabf'; g.fillRect(ox+15,oy+44,34,4);
        if (Math.random() < 0.16) {                                // window AC unit below the sill
          g.fillStyle='#b4b2aa'; g.fillRect(ox+25,oy+40,14,9);
          g.fillStyle='#8e8c85'; g.fillRect(ox+25,oy+40,14,2);
        }
      }); }) },
  { cw: 4.6, ch: 3.6, n: FN, tex: canvasTex(256, g => {           // 2 commercial: wide ribbon windows
      _wallBase(g, '#ece9e3');
      _cells(g, (g, ox, oy) => {
        for (let x = 6; x < 58; x += 13) _pane(g, ox+x, oy+16, Math.min(13, 58-x), 30);
        g.fillStyle='#d4d0c7'; g.fillRect(ox+6,oy+16,52,3); g.fillRect(ox+6,oy+43,52,3); g.fillRect(ox+6,oy+30,52,2);
        for (let x = 6; x <= 58; x += 13) g.fillRect(ox+x,oy+16,2,30);
      }); }) },
  { cw: 4.2, ch: 4.4, n: FN, tex: canvasTex(256, g => {           // 3 industrial: small high panes, lots of wall
      _wallBase(g, '#e7e4dd');
      g.fillStyle='rgba(150,100,60,0.05)';                         // faint rust wash
      for (let i = 0; i < 6; i++) g.fillRect(Math.random()*256|0, 0, 4 + Math.random()*8, 256);
      _cells(g, (g, ox, oy) => {
        for (let x = 8; x < 56; x += 12) {
          const v = 46 + (Math.random()*18|0);
          g.fillStyle = `rgb(${v-8},${v},${v+8})`; g.fillRect(ox+x, oy+10, 8, 12);
          g.fillStyle = 'rgba(170,185,195,0.3)'; g.fillRect(ox+x, oy+10, 8, 3);
        }
        g.fillStyle='#cdc8be'; g.fillRect(ox,oy+30,64,2);
      }); }) },
  { cw: 3.0, ch: 3.2, n: FN, tex: canvasTex(256, g => {           // 4 glass curtain wall
      g.fillStyle='#2c3742'; g.fillRect(0,0,256,256);
      _cells(g, (g, ox, oy) => {
        for (let px = 0; px < 64; px += 16) for (let py = 0; py < 64; py += 16) {
          const r = Math.random(), v = 40 + (Math.random()*22|0);
          g.fillStyle = r < 0.04 ? '#c7a065' : `rgb(${v-8},${v},${v+12})`;  // rare lit pane
          g.fillRect(ox+px, oy+py, 16, 16);
          g.fillStyle = 'rgba(150,170,190,0.18)'; g.fillRect(ox+px, oy+py, 16, 5); // sky at pane top
        }
        g.fillStyle='#7e8a96';
        for (let x = 0; x < 64; x += 16) g.fillRect(ox+x, oy, 2, 64);
        for (let y = 0; y < 64; y += 16) g.fillRect(ox, oy+y, 64, 2);
      }); }) },
  { cw: 3.2, ch: 3.4, n: FN, tex: canvasTex(256, g => {           // 5 brick/older: courses + small windows
      _wallBase(g, '#e9e3d8');
      g.strokeStyle='rgba(120,95,80,0.22)'; g.lineWidth=1;
      for (let y = 4; y < 256; y += 6) { g.beginPath(); g.moveTo(0,y); g.lineTo(256,y); g.stroke(); }
      for (let i = 0; i < 40; i++) {                               // odd discoloured bricks
        g.fillStyle = `rgba(${150+(Math.random()*40|0)},110,85,0.10)`;
        g.fillRect(Math.random()*256|0, (Math.random()*42|0)*6+5, 5+Math.random()*6, 5);
      }
      _cells(g, (g, ox, oy) => {
        _pane(g, ox+12, oy+14, 16, 24, { curtains: true }); _pane(g, ox+38, oy+14, 16, 24, { curtains: true });
        g.fillStyle='#d6d1c7'; g.fillRect(ox+12,oy+14,16,3); g.fillRect(ox+38,oy+14,16,3);
        g.fillStyle='#cfcabf'; g.fillRect(ox+11,oy+38,18,3); g.fillRect(ox+37,oy+38,18,3);   // sills
      }); }) },
];
// Ground-floor storefront band (tiles horizontally only): 4 shopfront variants side by side —
// different awning colours (some striped), door left or right, a hint of merchandise — so a
// commercial block reads as a row of different shops, not one repeated storefront.
const AWNING_COLS = ['#8b5a43', '#7a4a4a', '#3f6b52', '#4a5a7a', '#8a4a3a', '#6b5a3f'];
const STOREFRONT = { cw: 3.8, n: FN, tex: canvasTex(256, g => {
  for (let cx = 0; cx < FN; cx++) {
    const ox = cx * 64, flip = Math.random() < 0.5;
    g.fillStyle='#ded9cf'; g.fillRect(ox,0,64,64);                 // masonry surround
    const ac = AWNING_COLS[(Math.random()*AWNING_COLS.length)|0];
    g.fillStyle=ac; g.fillRect(ox,4,64,11);                        // awning / sign band
    if (Math.random() < 0.4) { g.fillStyle='rgba(255,255,255,0.35)'; for (let x = 0; x < 64; x += 12) g.fillRect(ox+x,4,6,11); }
    g.fillStyle='#f0ece4'; g.fillRect(ox,15,64,2);
    const gx = flip ? ox+25 : ox+5, dx = flip ? ox+5 : ox+45;      // glass + door swap sides
    g.fillStyle='#232a33'; g.fillRect(gx,20,34,44);                // display glass (to the ground)
    g.fillStyle='#aab4bd'; g.fillRect(gx,20,34,2);                 // glass top reflection
    g.fillStyle='rgba(190,175,140,0.35)';                          // merchandise silhouettes
    g.fillRect(gx+4,44,8,20); g.fillRect(gx+16,50,9,14);
    g.fillStyle='#5b636e'; g.fillRect(gx+16,20,2,44);              // mullion
    g.fillStyle='#463229'; g.fillRect(dx,24,14,40);                // recessed door
    g.fillStyle='#2c333c'; g.fillRect(dx+3,30,8,26);               // door glass
  }
}, 64) };
// Concrete sidewalk: light slab tone with panel-joint grooves. UVs run u=along-walk, v=across-walk,
// so a groove drawn along the texture's V axis (constant U) becomes a CROSS joint across the walk.
// We draw ONLY that (no U-axis line) → cross joints every panel, with NO continuous lengthwise line.
const concreteTex = canvasTex(128, g => {
  g.fillStyle='#c4c1b8'; g.fillRect(0,0,128,128);
  for(let i=0;i<700;i++){ const v=130+(Math.random()*44|0); g.fillStyle=`rgba(${v},${v-2},${v-8},0.18)`; g.fillRect(Math.random()*128|0, Math.random()*128|0, 2, 2); }
  g.fillStyle='#8f8c82'; g.fillRect(0,0,3,128);   // single cross-joint groove (spans the walk); tiles once per panel along the walk
});
// Grass: soft tone-on-tone patches + blade speckle, drawn in light neutrals so the
// material colour tints it (same trick as the facades) — ground and parks share it.
const grassTex = canvasTex(128, g => {
  g.fillStyle = '#d9d9d0'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 26; i++) {                               // mottled patches
    g.fillStyle = Math.random() < 0.5 ? 'rgba(90,105,60,0.07)' : 'rgba(242,246,228,0.08)';
    g.beginPath();
    g.ellipse(Math.random()*128, Math.random()*128, 10 + Math.random()*22, 8 + Math.random()*16, Math.random()*3, 0, 7);
    g.fill();
  }
  for (let i = 0; i < 1400; i++) {                             // blade speckle
    const v = 190 + (Math.random()*55|0);
    g.fillStyle = `rgba(${v-8},${v},${v-30},0.5)`;
    g.fillRect(Math.random()*128|0, Math.random()*128|0, 1, 2);
  }
});
// Asphalt: aggregate speckle, darker repair patches, a few hairline cracks.
const asphaltTex = canvasTex(128, g => {
  g.fillStyle = '#d4d4d6'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 1600; i++) { const v = 175 + (Math.random()*70|0);
    g.fillStyle = `rgba(${v},${v},${v+4},0.35)`; g.fillRect(Math.random()*128|0, Math.random()*128|0, 1, 1); }
  for (let i = 0; i < 5; i++) {
    g.fillStyle = `rgba(30,32,38,${0.05 + Math.random()*0.05})`;
    g.fillRect(Math.random()*128|0, Math.random()*128|0, 20 + Math.random()*40, 14 + Math.random()*30);
  }
  g.strokeStyle = 'rgba(40,42,48,0.25)'; g.lineWidth = 1;
  for (let i = 0; i < 3; i++) { g.beginPath();
    let x = Math.random()*128, y = Math.random()*128; g.moveTo(x, y);
    for (let s = 0; s < 5; s++) { x += Math.random()*22 - 11; y += Math.random()*22 - 11; g.lineTo(x, y); }
    g.stroke(); }
});
// Farmland: directional crop rows + stubble speckle, drawn light so the material
// colour tints it wheat-tan. Fields read as worked land instead of more lawn.
const cropTex = canvasTex(128, g => {
  g.fillStyle = '#dcd6c0'; g.fillRect(0, 0, 128, 128);
  for (let x = 0; x < 128; x += 8) {                           // crop rows
    g.fillStyle = 'rgba(95,85,45,0.16)'; g.fillRect(x, 0, 3, 128);
    g.fillStyle = 'rgba(245,240,220,0.10)'; g.fillRect(x + 4, 0, 2, 128);
  }
  for (let i = 0; i < 700; i++) { const v = 195 + (Math.random()*45|0);
    g.fillStyle = `rgba(${v},${v-6},${v-40},0.35)`; g.fillRect(Math.random()*128|0, Math.random()*128|0, 1, 2); }
});
// Countryside props: low-poly boulders and tiny flower blobs for the wild scatter.
const _rockGeo = new THREE.IcosahedronGeometry(1, 0).scale(1, 0.62, 1);
const _flowerGeo = new THREE.IcosahedronGeometry(1, 0);
// Water: faint ripple bands. Every texture instance used on water registers in
// waterTexes; the render loop scrolls their offsets so rivers/lakes visibly drift.
const waterTexes = [];
const waterTex = canvasTex(128, g => {
  g.fillStyle = '#dfe3e6'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 22; i++) {                               // light ripple crests
    g.strokeStyle = `rgba(255,255,255,${0.10 + Math.random()*0.15})`; g.lineWidth = 1 + Math.random()*1.5;
    const y = Math.random()*128, ph = Math.random()*6; g.beginPath();
    for (let x = 0; x <= 128; x += 8) g.lineTo(x, y + Math.sin(x/17 + ph)*2.5);
    g.stroke();
  }
  for (let i = 0; i < 12; i++) {                               // darker troughs
    g.strokeStyle = 'rgba(60,85,110,0.10)'; g.lineWidth = 1 + Math.random()*2;
    const y = Math.random()*128, ph = Math.random()*6; g.beginPath();
    for (let x = 0; x <= 128; x += 8) g.lineTo(x, y + Math.sin(x/14 + ph)*3);
    g.stroke();
  }
});
// Like flatMesh but textured. UVs are either supplied (uvArr) or planar-projected from world XZ.
function texMesh(posArr, tex, uvScale, color, cast, uvArr) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  let uv;
  if (uvArr) uv = new Float32Array(uvArr);
  else { uv = new Float32Array(posArr.length / 3 * 2);
    for (let i = 0, j = 0; i < posArr.length; i += 3, j += 2) { uv[j] = posArr[i] * uvScale; uv[j+1] = posArr[i+2] * uvScale; } }
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex, color: color || 0xffffff }));
  m.receiveShadow = true; if (cast) m.castShadow = true;
  return m;
}

// Build a mesh from a raw position array (normals computed -> follows terrain slope).
function flatMesh(posArr, color, cast) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color }));
  m.receiveShadow = true; if (cast) m.castShadow = true;
  return m;
}

// terrain height sampler (set per-area; flat by default)
let terrain = () => 0;

// The GROUND MESH renders flat triangles between its grid vertices, which can rise above the
// smooth terrain() DEM on curves. Roads/sidewalks/etc. must ride on the MESH surface (linear
// interp over the same grid) + an offset, so the ground can never poke through them.
// The grid is GLOBAL: cells sit at multiples of GCELL (tiles.js), and every tile's ground
// plane puts its vertices on that same lattice — so this matches the mesh in every tile.
// terrain() memoized at lattice points: tile builds hit the same ~8k corners millions of
// times (sidewalk SDF, ribbons, scatter), and Mercator sampling is trig-heavy. Cleared on
// a new area (clearWorld) — heights depend on the world origin.
let _terrCache = new Map();
function _terrAt(gi, gj) {
  const k = gi * 131072 + gj;              // unique while |gj| < 65536 (~26,000 km — plenty)
  let v = _terrCache.get(k);
  if (v === undefined) {
    if (_terrCache.size > 400000) _terrCache.clear();   // roaming cap (~3 MB per 100k entries)
    v = terrain(gi * GCELL, gj * GCELL);
    _terrCache.set(k, v);
  }
  return v;
}
function surfaceHeight(x, z) {
  const cell = GCELL;
  const gi = Math.floor(x / cell), gj = Math.floor(z / cell);
  const x0 = gi*cell, z0 = gj*cell;
  const h00 = _terrAt(gi, gj), h10 = _terrAt(gi+1, gj), h01 = _terrAt(gi, gj+1), h11 = _terrAt(gi+1, gj+1);
  const fx = Math.max(0, Math.min(1, (x - x0) / cell)), fz = Math.max(0, Math.min(1, (z - z0) / cell));
  // Planar interpolation for whichever triangle the point falls in, for BOTH diagonal splits;
  // take the higher. This keeps the road/sidewalk surface from ever dipping below the
  // flat-shaded ground mesh (which let the tan ground poke through as "brown" on the street).
  const dMain = (fz <= fx) ? h00 + (h10-h00)*fx + (h11-h10)*fz
                           : h00 + (h01-h00)*fz + (h11-h01)*fx;
  const dAnti = (fx + fz <= 1) ? h00 + (h10-h00)*fx + (h01-h00)*fz
                               : h11 + (h10-h11)*(1-fz) + (h01-h11)*(1-fx);
  return Math.max(dMain, dAnti);
}

// Foliage: mapped trees + trees scattered through wooded areas, drawn as a handful of
// InstancedMeshes (one trunk mesh + one canopy mesh per species) so thousands of trees
// cost only a few draw calls. Canopies get baked vertex colours (darker toward the
// base) that MULTIPLY with the per-instance green — depth without any lighting cost.
const _treeTrunkGeo = new THREE.CylinderGeometry(0.22, 0.32, 2.4, 5);
function _shadeCanopy(geo, yMin, yMax) {
  const pos = geo.getAttribute('position'), col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, Math.min(1, (pos.getY(i) - yMin) / (yMax - yMin)));
    col[i*3] = col[i*3+1] = col[i*3+2] = 0.7 + 0.3 * t;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}
// conifer: two stacked cones; spans y -1.7..3.2
const _coniferGeo = _shadeCanopy(mergeGeometries([
  new THREE.ConeGeometry(2.0, 3.4, 6),
  new THREE.ConeGeometry(1.45, 2.6, 6).translate(0, 1.9, 0),
], false), -1.7, 3.2);
// deciduous: lumpy canopy from overlapping icosahedron blobs; spans y -1.9..2.9
const _deciduousGeo = _shadeCanopy(mergeGeometries([
  new THREE.IcosahedronGeometry(1.9, 0),
  new THREE.IcosahedronGeometry(1.35, 0).translate(1.1, 0.9, 0.2),
  new THREE.IcosahedronGeometry(1.25, 0).translate(-1.0, 1.0, -0.4),
  new THREE.IcosahedronGeometry(1.1, 0).translate(0.1, 1.7, 0.9),
], false), -1.9, 2.9);
// columnar (poplar/juniper): one stretched blob, used sparingly; spans y -2.6..2.6
const _columnarGeo = _shadeCanopy(new THREE.IcosahedronGeometry(1.0, 0).scale(1.05, 2.6, 1.05), -2.6, 2.6);
// bush: squashed blob for scrub, hedges-to-be and front yards
const _bushGeo = _shadeCanopy(new THREE.IcosahedronGeometry(1.0, 0).scale(1.3, 0.75, 1.3), -0.75, 0.75);
// fake blob shadow: real shadows are off for foliage (too many casters), so a flat dark
// disc under each tree grounds it instead of letting it float
const _blobShadowGeo = new THREE.CircleGeometry(1, 10).rotateX(-Math.PI/2);
