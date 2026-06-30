// SimDrive — loading.js
// loading-screen controller: progress bar easing + shuffle-bag flavour text
// Loaded as a classic script by js/bootstrap.js; all app files share one global
// scope (the original single-file behaviour), with THREE/addons exposed as globals.

// Load flow (Overpass)
//----------------------------------------------------------------------------
const startEl = document.getElementById('start'), loadingEl = document.getElementById('loading');
const loadMsg = document.getElementById('loadMsg'), loadSub = document.getElementById('loadSub');
const loadErr = document.getElementById('loadErr'), backBtn = document.getElementById('backBtn'), spinEl = document.getElementById('spin');

// ---- Maxis-style loading: cycling flavour text + a progress bar ----
// Phrases lifted from the classic SimCity / The Sims loading screens. The bar EASES toward
// milestone targets set during loadArea(); the flavour line rotates on a timer. Caveat: the
// final buildWorld() pass is synchronous, so the main thread (and thus rAF/timers/CSS anim)
// freezes for its duration — the bar parks at its build-phase target and the last phrase sits
// until the build returns and stopLoadingFX(true) snaps it to 100%.
const loadBar = document.getElementById("loadBar"), loadFill = document.getElementById("loadFill");
let _fxRAF = 0, _fxPhraseTimer = 0, _fxVis = 0, _fxTarget = 0;
let _fxDeck = [], _fxDeckPos = 0;   // shuffle-bag: deal all phrases in a shuffled order, reshuffle when spent
function _fxStep() {
  _fxVis += (_fxTarget - _fxVis) * 0.08;                 // glide the visible fill toward the target
  loadFill.style.width = (Math.min(_fxVis, 1) * 100).toFixed(1) + "%";
  _fxRAF = requestAnimationFrame(_fxStep);
}
function loadProgress(frac) { _fxTarget = Math.max(_fxTarget, Math.min(1, frac)); }  // monotonic milestones
// Jump the VISIBLE fill straight to frac (no easing). Used right before the synchronous build:
// the easing rAF is about to freeze for the whole build, so we must paint the build-phase
// position immediately or the bar stays stuck wherever the ease happened to be.
function loadProgressSnap(frac) { _fxTarget = Math.max(_fxTarget, frac); _fxVis = Math.max(_fxVis, frac); loadFill.style.width = (Math.min(_fxVis, 1) * 100).toFixed(1) + '%'; }
// Draw the next phrase from a shuffle bag so none repeats until all 408 have shown (and the
// same phrase never lands twice in a row across reshuffles). Fisher-Yates on first/exhausted draw.
function _fxNextPhrase() {
  if (_fxDeckPos >= _fxDeck.length) {
    const last = _fxDeck.length ? _fxDeck[_fxDeck.length - 1] : -1;   // phrase just shown
    _fxDeck = MAXIS_PHRASES.map((_, i) => i);
    for (let i = _fxDeck.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = _fxDeck[i]; _fxDeck[i] = _fxDeck[j]; _fxDeck[j] = t; }
    if (_fxDeck.length > 1 && _fxDeck[0] === last) { _fxDeck[0] = _fxDeck[1]; _fxDeck[1] = last; }  // no repeat across the reshuffle seam
    _fxDeckPos = 0;
  }
  loadMsg.textContent = MAXIS_PHRASES[_fxDeck[_fxDeckPos++]] + "…";
}
function startLoadingFX() {
  _fxVis = 0; _fxTarget = 0.06; loadFill.style.width = "0%"; loadBar.style.display = "";
  _fxNextPhrase();
  clearInterval(_fxPhraseTimer); _fxPhraseTimer = setInterval(_fxNextPhrase, 1400);
  cancelAnimationFrame(_fxRAF); _fxStep();
}
function stopLoadingFX(complete) {
  clearInterval(_fxPhraseTimer); _fxPhraseTimer = 0;
  cancelAnimationFrame(_fxRAF); _fxRAF = 0;
  if (complete) { _fxTarget = 1; _fxVis = 1; loadFill.style.width = "100%"; }
  else loadBar.style.display = "none";
}

