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
function canvasTex(size, draw) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  draw(cv.getContext('2d'));
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = ANISO; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// Several facade styles so buildings aren't all skinned the same. Walls are near-white so the
// per-building palette colour tints them; windows stay dark. cw/ch = metres per tile (UV scale).
const FACADES = [
  { cw: 3.4, ch: 3.6, tex: canvasTex(64, g => {                 // 0 office: regular glass grid
      g.fillStyle='#ece9e3'; g.fillRect(0,0,64,64);
      g.fillStyle='#36414e'; g.fillRect(9,8,46,48);
      g.fillStyle='#d8d4cc'; g.fillRect(9,8,46,3); g.fillRect(9,53,46,3); g.fillRect(9,8,3,48); g.fillRect(52,8,3,48); g.fillRect(30,8,4,48); g.fillRect(9,30,46,4); }) },
  { cw: 2.8, ch: 3.2, tex: canvasTex(64, g => {                 // 1 residential: small punched window + sill
      g.fillStyle='#ece9e3'; g.fillRect(0,0,64,64);
      g.fillStyle='#3b4654'; g.fillRect(18,12,28,32);
      g.fillStyle='#cfcabf'; g.fillRect(15,44,34,4);
      g.fillStyle='#ddd9d0'; g.fillRect(18,12,28,3); g.fillRect(31,12,2,32); g.fillRect(18,27,28,2); }) },
  { cw: 4.6, ch: 3.6, tex: canvasTex(64, g => {                 // 2 commercial: wide ribbon windows
      g.fillStyle='#ece9e3'; g.fillRect(0,0,64,64);
      g.fillStyle='#374250'; g.fillRect(6,16,52,30);
      g.fillStyle='#d4d0c7'; g.fillRect(6,16,52,3); g.fillRect(6,43,52,3); g.fillRect(6,30,52,2);
      for(let x=6;x<=58;x+=13) g.fillRect(x,16,2,30); }) },
  { cw: 4.2, ch: 4.4, tex: canvasTex(64, g => {                 // 3 industrial: small high panes, lots of wall
      g.fillStyle='#e7e4dd'; g.fillRect(0,0,64,64);
      g.fillStyle='#3a4450'; for(let x=8;x<56;x+=12) g.fillRect(x,10,8,12);
      g.fillStyle='#cdc8be'; g.fillRect(0,30,64,2); }) },
  { cw: 3.0, ch: 3.2, tex: canvasTex(64, g => {                 // 4 glass curtain wall: dark panes + thin grid
      g.fillStyle='#2c3742'; g.fillRect(0,0,64,64);
      g.fillStyle='#7e8a96'; for(let x=0;x<64;x+=16) g.fillRect(x,0,2,64); for(let y=0;y<64;y+=16) g.fillRect(0,y,64,2); }) },
  { cw: 3.2, ch: 3.4, tex: canvasTex(64, g => {                 // 5 brick/older: brick courses + small windows
      g.fillStyle='#e9e3d8'; g.fillRect(0,0,64,64);
      g.strokeStyle='rgba(120,95,80,0.22)'; g.lineWidth=1; for(let y=4;y<64;y+=6){ g.beginPath(); g.moveTo(0,y); g.lineTo(64,y); g.stroke(); }
      g.fillStyle='#3c4652'; g.fillRect(12,14,16,24); g.fillRect(38,14,16,24);
      g.fillStyle='#d6d1c7'; g.fillRect(12,14,16,3); g.fillRect(38,14,16,3); }) },
];
// Ground-floor storefront band (tiles horizontally only): big glass, a doorway, and a
// sign/awning strip on top. Near-white surround so the building's palette colour tints it.
const STOREFRONT = { cw: 3.8, tex: canvasTex(64, g => {
  g.fillStyle='#ded9cf'; g.fillRect(0,0,64,64);                    // masonry surround
  g.fillStyle='#8b5a43'; g.fillRect(0,4,64,11);                    // awning / sign band
  g.fillStyle='#f0ece4'; g.fillRect(0,15,64,2);
  g.fillStyle='#232a33'; g.fillRect(5,20,34,44);                   // display glass (to the ground)
  g.fillStyle='#aab4bd'; g.fillRect(5,20,34,2);                    // glass top reflection
  g.fillStyle='#5b636e'; g.fillRect(21,20,2,44);                   // mullion
  g.fillStyle='#463229'; g.fillRect(45,24,14,40);                  // recessed door
  g.fillStyle='#2c333c'; g.fillRect(48,30,8,26);                   // door glass
}) };
// Concrete sidewalk: light slab tone with panel-joint grooves. UVs run u=along-walk, v=across-walk,
// so a groove drawn along the texture's V axis (constant U) becomes a CROSS joint across the walk.
// We draw ONLY that (no U-axis line) → cross joints every panel, with NO continuous lengthwise line.
const concreteTex = canvasTex(128, g => {
  g.fillStyle='#c4c1b8'; g.fillRect(0,0,128,128);
  for(let i=0;i<700;i++){ const v=130+(Math.random()*44|0); g.fillStyle=`rgba(${v},${v-2},${v-8},0.18)`; g.fillRect(Math.random()*128|0, Math.random()*128|0, 2, 2); }
  g.fillStyle='#8f8c82'; g.fillRect(0,0,3,128);   // single cross-joint groove (spans the walk); tiles once per panel along the walk
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
let groundSize = 1, groundSeg = 1;
function surfaceHeight(x, z) {
  const cell = groundSize / groundSeg, half = groundSize / 2;
  let gi = Math.floor((x + half) / cell), gj = Math.floor((z + half) / cell);
  gi = Math.max(0, Math.min(groundSeg - 1, gi)); gj = Math.max(0, Math.min(groundSeg - 1, gj));
  const x0 = -half + gi*cell, z0 = -half + gj*cell;
  const h00 = terrain(x0, z0), h10 = terrain(x0 + cell, z0), h01 = terrain(x0, z0 + cell), h11 = terrain(x0 + cell, z0 + cell);
  // clamp to the cell so points past the world edge don't EXTRAPOLATE the planes into the sky
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

// Foliage: mapped trees + trees scattered through wooded areas, drawn as two
// InstancedMeshes (trunk + leaf cone) so thousands cost only two draw calls.
const _treeTrunkGeo = new THREE.CylinderGeometry(0.22, 0.32, 2.4, 5);
const _treeLeafGeo = new THREE.ConeGeometry(2.0, 4.6, 6);
