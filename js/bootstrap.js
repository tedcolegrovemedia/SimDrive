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
for (const src of FILES) {
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = false;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.body.appendChild(s);
  });
}
