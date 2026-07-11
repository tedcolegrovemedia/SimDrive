// SimDrive bootstrap. THREE and its addons are ESM-only, so we import them in this module,
// expose them as globals, then load the app's classic scripts IN ORDER. Classic scripts share
// one global lexical scope, which reproduces the original single-file behaviour with no
// state-plumbing between files.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
Object.assign(window, { THREE, mergeGeometries, RoundedBoxGeometry });

const FILES = [
  'js/data.js', 'js/picker.js', 'js/scene.js', 'js/world.js', 'js/vehicles.js',
  'js/build-world.js', 'js/minimap.js', 'js/loading-phrases.js', 'js/loading.js',
  'js/load-area.js', 'js/main.js',
];
// Load app files with cache REVALIDATION (fetch no-cache -> 304 when unchanged, fresh bytes
// right after a deploy). Plain <script src> let browsers heuristically cache stale code for
// hours, so phones kept playing old builds. Falls back to a normal script tag if fetch fails
// (e.g. offline -> use whatever is cached).
const classicTag = (src) => new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = src; s.async = false;
  s.onload = resolve;
  s.onerror = () => reject(new Error('Failed to load ' + src));
  document.body.appendChild(s);
});
try {   // fresh CSS the same way (swap in after fetch; the <link> copy shows until then)
  const css = await (await fetch('css/main.css', { cache: 'no-cache' })).text();
  const style = document.createElement('style'); style.textContent = css;
  const link = document.querySelector('link[href*="main.css"]');
  if (link) link.replaceWith(style); else document.head.appendChild(style);
} catch (e) {}
for (const src of FILES) {
  try {
    const code = await (await fetch(src, { cache: 'no-cache' })).text();
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = URL.createObjectURL(new Blob([code + '\n//# sourceURL=' + src], { type: 'text/javascript' }));
      s.async = false; s.onload = resolve; s.onerror = () => reject(new Error('Failed to run ' + src));
      document.body.appendChild(s);
    });
  } catch (e) { await classicTag(src); }
}
