// SimDrive — minimap.js
// car-nav minimap (heading-up, rotates with the car)
// Loaded as a classic script by js/bootstrap.js; all app files share one global
// scope (the original single-file behaviour), with THREE/addons exposed as globals.

// ---- Minimap (car-nav style: heading-up, zoomed, rotates with the car) ----
let miniData = null;
function buildMinimap(roadLines, gsz) {
  const PX = 0.42, minX = -gsz/2, minZ = -gsz/2;
  const size = Math.round(Math.min(900, Math.max(320, gsz * PX)));
  const off = document.createElement('canvas'); off.width = off.height = size;
  const g = off.getContext('2d');
  g.fillStyle = '#0c1018'; g.fillRect(0, 0, size, size);
  g.strokeStyle = '#7c8aa0'; g.lineWidth = 2.4; g.lineJoin = 'round'; g.lineCap = 'round';
  for (const line of roadLines) {
    g.beginPath(); g.moveTo((line[0].x - minX)*PX, (line[0].z - minZ)*PX);
    for (let i = 1; i < line.length; i++) g.lineTo((line[i].x - minX)*PX, (line[i].z - minZ)*PX);
    g.stroke();
  }
  miniData = { off, PX, minX, minZ };
}
function drawMinimap() {
  if (!miniData) return;
  const V = 176, ctx2 = document.getElementById('mini').getContext('2d');
  const { off, PX, minX, minZ } = miniData;
  const zoomM = 300, scale = V / (zoomM * PX);            // metres shown across the dial
  const ox = (player.x - minX)*PX, oy = (player.z - minZ)*PX;
  ctx2.clearRect(0, 0, V, V);
  ctx2.save();
  ctx2.beginPath(); ctx2.arc(V/2, V/2, V/2, 0, Math.PI*2); ctx2.clip();
  ctx2.fillStyle = '#0c1018'; ctx2.fillRect(0, 0, V, V);
  ctx2.translate(V/2, V/2);
  ctx2.rotate(-Math.PI/2 - player.ang);                  // rotate world so the car's heading points up
  ctx2.scale(scale, scale);
  ctx2.translate(-ox, -oy);
  ctx2.drawImage(off, 0, 0);
  ctx2.fillStyle = '#e0454a';                            // NPC traffic dots
  const r = 3 / scale;
  for (const n of NPCS) ctx2.fillRect((n.x - minX)*PX - r, (n.z - minZ)*PX - r, r*2, r*2);
  ctx2.restore();
  // player marker — fixed at centre, always pointing up
  ctx2.fillStyle = '#ffd54a';
  ctx2.beginPath(); ctx2.moveTo(V/2, V/2 - 8); ctx2.lineTo(V/2 - 6, V/2 + 6); ctx2.lineTo(V/2 + 6, V/2 + 6); ctx2.closePath(); ctx2.fill();
}

//----------------------------------------------------------------------------
