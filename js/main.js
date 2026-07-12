// SimDrive — main.js
// entry point: input, driving physics, camera, gear, render loop, resume-on-refresh
// Loaded as a classic script by js/bootstrap.js; all app files share one global
// scope (the original single-file behaviour), with THREE/addons exposed as globals.

// Input
//----------------------------------------------------------------------------
const keys = {}; let chaseCam = false;
addEventListener('keydown', e => {
  if (!worldReady) return;
  const k = e.key.toLowerCase(); keys[k] = true;
  if (k === 'h') horn(); if (k === 'c') chaseCam = !chaseCam;
  if (k === 'r') cycleRadio();
  if (k === 'n') spotifyNext();
  if ([' ','arrowup','arrowdown','arrowleft','arrowright'].includes(k)) e.preventDefault();
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

// Touch driving controls: the on-screen buttons set the SAME `keys` flags the keyboard
// uses, so the physics code doesn't know or care which input is active. Pointer events
// (one pointer per button) give free multi-touch: steer with one thumb, gas with the other.
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;
function bindTouchBtn(id, key) {
  const el = document.getElementById(id);
  const on  = e => { e.preventDefault(); keys[key] = true; el.classList.add('on');
    try { el.setPointerCapture(e.pointerId); } catch (err) {} };   // capture keeps pointerup on this button if the thumb drifts
  const off = e => { e.preventDefault(); keys[key] = false; el.classList.remove('on'); };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off);
  el.addEventListener('contextmenu', e => e.preventDefault()); // no long-press menu mid-drive
}
bindTouchBtn('tLeft', 'a'); bindTouchBtn('tRight', 'd');
bindTouchBtn('tGas', 'w');  bindTouchBtn('tBrake', 's');
// Camera button mirrors the C key (the only way to switch views on a phone)
document.getElementById('camView').addEventListener('click', () => { chaseCam = !chaseCam; });
// Radio button mirrors the R key (the only way to change stations on a phone)
document.getElementById('radioBtn').addEventListener('click', () => cycleRadio());
// Next button mirrors the N key; spotify.js shows it only on the Spotify station
document.getElementById('nextBtn').addEventListener('click', () => spotifyNext());

// Build stamp in the Controls popover: newest Last-Modified among the loaded app files
// (set by bootstrap.js). Lets anyone confirm which deploy their device is actually running.
if (window.__buildStamp) {
  const d = new Date(window.__buildStamp);
  document.getElementById('buildStamp').innerHTML =
    '<span style="opacity:.55">build</span> <span>' + d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '</span>';
}

let audioCtx;
function horn() {
  try {
    audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), gn = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = 320; gn.gain.value = 0.06;
    o.connect(gn); gn.connect(audioCtx.destination); o.start();
    gn.gain.setValueAtTime(0.06, audioCtx.currentTime);
    gn.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.3);
    o.stop(audioCtx.currentTime + 0.32);
  } catch(e){}
}

//----------------------------------------------------------------------------
// Resize / loop
//----------------------------------------------------------------------------
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Portrait phones: a fixed 72° VERTICAL fov leaves a ~40° horizontal tunnel. Widen the
  // vertical fov so the horizontal view stays road-usable (capped so it doesn't fisheye).
  camera.fov = camera.aspect >= 1 ? 72
    : Math.min(100, 2 * Math.atan(Math.tan(36 * Math.PI/180) / camera.aspect) * 180/Math.PI);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
addEventListener('orientationchange', () => setTimeout(resize, 250)); // iOS reports stale sizes during rotation

const fpsEl = document.getElementById('fps');

function updatePlayer(dt) {
  const car = CARS[player.type];
  let throttle = 0, steer = 0;
  if (keys['w'] || keys['arrowup'])    throttle += 1;
  if (keys['s'] || keys['arrowdown'])  throttle -= 1;
  if (keys['a'] || keys['arrowleft'])  steer -= 1;
  if (keys['d'] || keys['arrowright']) steer += 1;
  const braking = keys[' '];

  if (throttle > 0) player.speed += car.accel * dt;
  else if (throttle < 0) player.speed -= car.accel * 0.7 * dt;
  const fric = braking ? 0.9 : 0.99;
  player.speed *= Math.pow(fric, dt);
  player.speed = Math.max(-car.top*0.4, Math.min(car.top, player.speed));
  if (Math.abs(player.speed) < 0.03) player.speed = 0;

  const steerRate = 0.035 * (player.speed >= 0 ? 1 : -1);
  player.ang += steer * steerRate * Math.min(1, Math.abs(player.speed)/8) * dt;
  player.steerVis += (steer - player.steerVis) * Math.min(1, 0.18 * dt);

  const vx = Math.cos(player.ang) * player.speed * 0.016 * dt;
  const vz = Math.sin(player.ang) * player.speed * 0.016 * dt;
  // solid = buildings/fence (grid) OR a crash wall (bridge rail / highway barrier) at our height
  const solid = (x, z) => blocked(x, z) || wallBlocked(x, z, player.y);
  let bumped = false;
  if (!solid(player.x + vx, player.z)) player.x += vx; else bumped = true;
  if (!solid(player.x, player.z + vz)) player.z += vz; else bumped = true;
  if (bumped) player.speed *= 0.5;

  // ---- vertical physics: hug the surface on slopes/ramps, but free-fall off real drops ----
  const surf = driveHeight(player.x, player.z, player.y);
  const drop = player.y - surf;
  // grounded while the surface is at/above us or only a small step below (the step scales with
  // speed so steep streets don't trigger phantom falls). A bigger gap = we drove off an edge.
  const stepDown = 0.5 + Math.hypot(vx, vz) * 0.8;
  if (drop <= stepDown) {
    player.y = surf; player.vy = 0;            // stick to the road/ground
  } else {
    player.vy -= GRAVITY * (dt / 60);          // airborne: accelerate downward
    player.y += player.vy * (dt / 60);
    if (player.y <= surf) { player.y = surf; player.vy = 0; }   // landed
  }
}

function updateCamera() {
  const dx = Math.cos(player.ang), dz = Math.sin(player.ang);
  const gy = player.y;                               // height owned by updatePlayer's vertical physics
  playerCar.position.set(player.x, gy, player.z); playerCar.rotation.y = -player.ang; playerCar.visible = chaseCam;
  if (interior) { interior.visible = !chaseCam; interior.userData.spin.rotation.z = -player.steerVis * 0.9; }
  if (chaseCam) {
    const ahead = driveHeight(player.x + dx*6, player.z + dz*6, gy);
    camera.position.set(player.x - dx*11, gy + 6.5, player.z - dz*11);
    camera.lookAt(player.x + dx*6, ahead + 1.6, player.z + dz*6);
  } else {
    const lx = Math.cos(player.ang - Math.PI/2), lz = Math.sin(player.ang - Math.PI/2);
    const ahead = driveHeight(player.x + dx*20, player.z + dz*20, gy);
    camera.position.set(player.x + dx*0.4 + lx*0.5, gy + 2.55, player.z + dz*0.4 + lz*0.5);
    camera.lookAt(player.x + dx*20, ahead + 1.7, player.z + dz*20);
  }
  sun.position.set(player.x + SUN_OFF.x, SUN_OFF.y, player.z + SUN_OFF.z);
  sun.target.position.set(player.x, 0, player.z); sun.target.updateMatrixWorld();
}

// Gear readout: highlight R while reversing, D otherwise (cached so the DOM only changes on a shift).
const gearEl = document.getElementById('gear'); let gearState = '';
function updateGear() {
  const g = player.speed < -0.05 ? 'R' : 'D';
  if (g === gearState) return; gearState = g;
  gearEl.innerHTML = g === 'R' ? 'P <b>R</b> N D' : 'P R N <b>D</b>';
}

let last = performance.now(), fpsAcc = 0, fpsCount = 0, miniTick = 0;
function loop(now) {
  let dt = (now - last) / 16.6667; last = now;
  if (dt > 4) dt = 4; if (dt <= 0) dt = 1;
  updateAudio();   // engine follows speed/throttle; radio scheduler runs even in the picker
  if (worldReady) {
    updateSignals(dt); updatePlayer(dt); updateNPCs(dt); updateCamera(); updateGear();
    skyDome.position.copy(camera.position);   // sky stays centred on the camera
    const wt = now * 0.001;                    // drift the water ripple texture — cheap "alive" motion
    for (const t of waterTexes) t.offset.set((wt * 0.014) % 1, (wt * 0.008) % 1);
    renderer.render(scene, camera);
    const mph = Math.round(Math.abs(player.speed) * 2.237);
    drawSpeedGauge(mph, '#' + CARS[player.type].body.toString(16).padStart(6, '0')); // 2D speedometer
    miniTick = (miniTick + 1) % 3; if (miniTick === 0) drawMinimap(); // 2D minimap
    fpsAcc += dt; fpsCount++;
    if (fpsCount >= 30) { fpsEl.textContent = Math.round(60 / (fpsAcc/fpsCount)) + ' fps'; fpsAcc = 0; fpsCount = 0; }
    if ((saveTick = (saveTick + 1) % 90) === 0) saveSession(); // persist position ~1.5s for resume-on-refresh
  }
  requestAnimationFrame(loop);
}
let saveTick = 0;
// Save where we are (area + position) so a refresh resumes here instead of the map picker.
function saveSession() {
  if (!worldReady) return;
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ lat: lastLat, lon: lastLon, rMi: lastRMi, x: player.x, z: player.z, ang: player.ang })); } catch (e) {}
}
addEventListener('beforeunload', saveSession);
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSession(); });

resize();
requestAnimationFrame(loop);

window.__loadArea = loadArea;   // debug: load an exact lat/lon/radius
// ---- resume the last session on load: skip the picker and rebuild that area at the saved spot ----
try {
  const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  if (saved && isFinite(saved.lat) && isFinite(saved.lon)) {
    startEl.style.display = 'none';                 // hide picker immediately (no flash)
    restorePos = { x: saved.x, z: saved.z, ang: saved.ang };
    loadArea(saved.lat, saved.lon, saved.rMi || 0.3);
  } else {
    warmDuck();   // no saved session -> picker is showing; warm the engine while the user chooses
  }
} catch (e) { warmDuck(); }
