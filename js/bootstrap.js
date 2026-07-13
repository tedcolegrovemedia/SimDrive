// SimDrive bootstrap. THREE and its addons are ESM-only, so we import them in this module,
// expose them as globals, then load the app's classic scripts IN ORDER. Classic scripts share
// one global lexical scope, which reproduces the original single-file behaviour with no
// state-plumbing between files.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
Object.assign(window, { THREE, mergeGeometries, RoundedBoxGeometry });

const FILES = [
  'js/data.js', 'js/picker.js', 'js/scene.js', 'js/tiles.js', 'js/world.js', 'js/vehicles.js',
  'js/build-world.js', 'js/minimap.js', 'js/loading-phrases.js', 'js/loading.js',
  'js/load-area.js', 'js/spotify.js', 'js/audio.js', 'js/main.js',
];
// Load app files with a UNIQUE query string per page load. Two cache layers were serving
// stale code: browsers heuristically cache plain <script src> for hours, AND Cloudflare's
// edge caches .js/.css independently of the origin — so deploys were live on the box while
// phones kept playing old builds. A never-before-seen URL misses every layer and always
// pulls fresh bytes from nginx. Falls back to a plain (cached) script tag if fetch fails,
// e.g. offline. NOTE: bootstrap.js itself IS edge-cached — bump its ?v in index.html when
// editing this file.
const BUST = '?ts=' + Date.now();
const classicTag = (src) => new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = src; s.async = false;
  s.onload = resolve;
  s.onerror = () => reject(new Error('Failed to load ' + src));
  document.body.appendChild(s);
});
try {   // fresh CSS the same way (swap in after fetch; the <link> copy shows until then)
  const css = await (await fetch('css/main.css' + BUST)).text();
  const style = document.createElement('style'); style.textContent = css;
  const link = document.querySelector('link[href*="main.css"]');
  if (link) link.replaceWith(style); else document.head.appendChild(style);
} catch (e) {}
// fetch all files in parallel (order preserved at execution time)
const bodies = await Promise.all(FILES.map(async (src) => {
  try {
    const r = await fetch(src + BUST);
    // surface the newest Last-Modified as the visible build stamp (shown in the Controls popover)
    const lm = Date.parse(r.headers.get('last-modified') || '');
    if (lm && (!window.__buildStamp || lm > window.__buildStamp)) window.__buildStamp = lm;
    return await r.text();
  } catch (e) { return null; }
}));
for (let i = 0; i < FILES.length; i++) {
  if (bodies[i] === null) { await classicTag(FILES[i]); continue; }
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = URL.createObjectURL(new Blob([bodies[i] + '\n//# sourceURL=' + FILES[i]], { type: 'text/javascript' }));
    s.async = false; s.onload = resolve; s.onerror = () => reject(new Error('Failed to run ' + FILES[i]));
    document.body.appendChild(s);
  });
}
