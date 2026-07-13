# Sim-Drive

Drive real-world streets in 3D, in the browser. Pick a place on the map and Sim-Drive pulls
the actual streets, buildings, water, parks, traffic signals and terrain from OpenStreetMap /
Overture / AWS elevation tiles and assembles a drivable city — with moving traffic, bridges,
a car-nav minimap, and a Maxis-style loading screen.

**The world streams as you drive.** The map is an endless grid of half-mile tiles on a fixed
world origin (`js/tiles.js`): the starting tile builds on the loading screen, then a ring of
tiles around the car is fetched and built in the background — time-sliced through a generator
so driving never hitches — with prefetch biased toward your heading. Tiles that fall behind
are kept in an LRU cache (instant re-add when you drive back) and disposed past a cap; all
data (OSM, Overture, elevation) is IndexedDB-cached so revisiting never re-downloads. The
unbuilt frontier is an invisible wall that opens as tiles land.

## Run

It's a static site — **no build step is required to run it.** Serve the folder with any static
web server (HTML / CSS / JS / PHP hosts all work):

```sh
python3 -m http.server 8123
# then open http://localhost:8123
```

ES modules and `fetch()` require `http://` (not opening the file directly).

## Project structure

```
index.html              markup + importmap + bootstrap entry
css/main.css            compiled stylesheet (generated from scss/)
scss/                   source styles — partials + main.scss
js/
  bootstrap.js          (ES module) loads THREE, then the classic scripts in order
  data.js               OpenStreetMap / Overture data layer + IndexedDB caches
  picker.js             Leaflet location picker (search, start-tile preview)
  scene.js              Three.js scene/camera/renderer + shared textures & geometry
  tiles.js              streaming tile manager: origin, elevation store, fetch pipeline,
                        budgeted background builds, scene ring + LRU disposal
  world.js              trees, houses, sidewalks, signs, traffic signals, bridges
  vehicles.js           player + NPC cars, dashboard gauges, collision, traffic
  build-world.js        buildTileSteps() — assembles ONE tile of city from OSM data
  minimap.js            heading-up car-nav minimap (redrawn from live tiles)
  loading-phrases.js    Maxis-style loading flavour text
  loading.js            loading-screen controller (progress bar + flavour text)
  load-area.js          Overpass fetch + loadArea() orchestration (first tile, spawn)
  main.js               input, driving physics, camera, render loop, resume
```

## Styles

Edit the SCSS partials in `scss/`, then compile to `css/main.css`:

```sh
npm install            # one-time: installs dart-sass (dev dependency only)
npm run build:css      # compile once
npm run watch:css      # recompile on change
```

The compiled `css/main.css` is committed so the site runs without a build step.

## Architecture note

THREE and its addons are ES modules, so `js/bootstrap.js` imports them, exposes them as
globals, and then loads the rest of the app as ordered **classic scripts** that share a single
global scope. This keeps the code organised across files without having to thread shared engine
state (`scene`, `terrain`, `signals`, `NPCS`, …) through a module import graph.

## Data sources

- **OpenStreetMap** (Overpass API) — streets, buildings, water, parks, traffic signals
- **Overture Maps** — detailed building footprints + heights (read in-browser via DuckDB-WASM)
- **AWS Terrarium** elevation tiles — real terrain
- **Leaflet** + OSM tiles — the map picker

## Controls

`W` `A` `S` `D` / arrows — drive · `Space` — brake · `H` — horn · `C` — camera
