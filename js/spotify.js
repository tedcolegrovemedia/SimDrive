// SimDrive — spotify.js
// Real music on the radio dial: a "SPOTIFY" station after the generative ones,
// played through Spotify's Web Playback SDK (the game tab becomes a Spotify
// Connect device named "Sim-Drive Radio"). Requires a Spotify PREMIUM account
// (SDK limitation) and a Client ID from https://developer.spotify.com/dashboard.
//
// Setup (one time):
//   1. developer.spotify.com/dashboard → Create app. Any name. Check "Web Playback SDK".
//   2. Add BOTH redirect URIs:  https://drive.tedcolegrove.ai/
//                               http://127.0.0.1:8090/        (or whatever local port)
//   3. Paste the app's Client ID below (or run
//      localStorage.sp_client_id='...' in devtools to test without a redeploy).
//
// Auth is Authorization-Code-with-PKCE in a POPUP, so the drive is never
// interrupted by a redirect: the popup bounces to Spotify and back to this same
// page, the early handler below stores the tokens and closes it, and the opener
// picks them up from localStorage. Tokens persist, so login happens once.
const SPOTIFY_CLIENT_ID = 'e4fc61a7fbe743d9a62fecdb4ede71e4';   // <-- paste your Client ID here

const SP_SCOPES = 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state user-library-read';
const spClientId = () => localStorage.getItem('sp_client_id') || SPOTIFY_CLIENT_ID;
const spRedirect = () => location.origin + location.pathname;
function spotifyAvailable() { return !!spClientId(); }

//----------------------------------------------------------------------------
// OAuth redirect landing: runs at load time, BEFORE the game boots. If we're
// the auth popup (?code= present), trade the code for tokens, stash them, and
// close ourselves — the opener is polling localStorage.
//----------------------------------------------------------------------------
(async () => {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return;
  history.replaceState({}, '', spRedirect());          // clean URL either way
  const fail = () => location.replace('/error/');      // any auth failure lands on the error page
  if (q.has('error')) return fail();
  try {
    const verifier = localStorage.getItem('sp_verifier');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: q.get('code'),
        redirect_uri: spRedirect(), client_id: spClientId(), code_verifier: verifier,
      }),
    });
    const t = await r.json();
    if (!t.access_token) return fail();
    spStoreTokens(t);
  } catch (e) { return fail(); }
  if (window.opener) { document.body.textContent = 'Connected — you can close this window.'; window.close(); }
})();

//----------------------------------------------------------------------------
// Tokens: stored in localStorage, refreshed silently via the PKCE refresh token.
//----------------------------------------------------------------------------
function spStoreTokens(t) {
  const old = JSON.parse(localStorage.getItem('sp_tokens') || '{}');
  localStorage.setItem('sp_tokens', JSON.stringify({
    access: t.access_token,
    refresh: t.refresh_token || old.refresh,             // refresh grant may omit it
    exp: Date.now() + (t.expires_in - 60) * 1000,
  }));
}

async function spToken() {
  const t = JSON.parse(localStorage.getItem('sp_tokens') || 'null');
  if (!t) return null;
  if (Date.now() < t.exp) return t.access;
  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: spClientId() }),
    });
    const nt = await r.json();
    if (!nt.access_token) throw new Error('refresh failed');
    spStoreTokens(nt);
    return nt.access_token;
  } catch (e) { localStorage.removeItem('sp_tokens'); return null; }
}

// PKCE: challenge = base64url(sha256(random verifier)). Needs a secure context
// (HTTPS or 127.0.0.1), which is also what the SDK and Spotify's URI rules need.
async function spAuthUrl() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let verifier = '';
  for (const b of crypto.getRandomValues(new Uint8Array(64))) verifier += chars[b % chars.length];
  localStorage.setItem('sp_verifier', verifier);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: spClientId(), response_type: 'code', redirect_uri: spRedirect(),
    scope: SP_SCOPES, code_challenge_method: 'S256', code_challenge: challenge,
  });
}

// Login in a popup (must be called from a user gesture or it gets blocked).
// Resolves when the popup has written tokens to localStorage.
function spAuthPopup() {
  return new Promise(async (resolve, reject) => {
    localStorage.removeItem('sp_tokens');
    const w = open(await spAuthUrl(), 'sp_auth', 'width=500,height=720');
    if (!w) return reject(new Error('popup blocked'));
    const timer = setInterval(() => {
      if (localStorage.getItem('sp_tokens')) { clearInterval(timer); resolve(); }
      else if (w.closed) { clearInterval(timer); reject(new Error('login cancelled')); }
    }, 400);
  });
}

//----------------------------------------------------------------------------
// Web API helper (with one silent token refresh baked into spToken).
//----------------------------------------------------------------------------
async function spApi(method, path, body) {
  const tok = await spToken();
  if (!tok) throw new Error('not connected');
  const r = await fetch('https://api.spotify.com/v1' + path, {
    method,
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { localStorage.removeItem('sp_tokens'); throw new Error('not connected'); }
  if (!r.ok && r.status !== 404) throw new Error('spotify ' + r.status);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

//----------------------------------------------------------------------------
// Player: lazy-load the SDK, register as a Connect device, transfer playback
// here. NOTE the SDK plays through its own DRM media element, so it can't run
// through the radioChain() dash-speaker filter — volume is matched instead.
//----------------------------------------------------------------------------
const sp = { player: null, deviceId: null, ready: null, tuned: false, lastTrack: null };

function spLoadSdk() {
  if (window.Spotify) return Promise.resolve();
  return new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = resolve;
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.onerror = () => reject(new Error('SDK load failed'));
    document.body.appendChild(s);
  });
}

function spInitPlayer() {
  if (sp.ready) return sp.ready;
  sp.ready = spLoadSdk().then(() => new Promise((resolve, reject) => {
    const player = new Spotify.Player({
      name: 'Sim-Drive Radio',
      getOAuthToken: (cb) => spToken().then((t) => t && cb(t)),
      volume: 0.4,                                       // sit with the engine, like the synth stations
    });
    player.addListener('ready', ({ device_id }) => { sp.deviceId = device_id; resolve(); });
    player.addListener('account_error', () => { spToast('Spotify Premium required'); reject(new Error('premium required')); });
    player.addListener('authentication_error', () => { localStorage.removeItem('sp_tokens'); reject(new Error('auth error')); });
    player.addListener('initialization_error', () => reject(new Error('init error')));
    player.addListener('player_state_changed', (st) => {
      if (!st || !sp.tuned) return;
      const tr = st.track_window.current_track;
      if (tr && tr.id !== sp.lastTrack) {                // toast on track change only
        sp.lastTrack = tr.id;
        spToast(tr.name + ' — ' + tr.artists.map((a) => a.name).join(', '));
      }
    });
    player.connect().then((ok) => { if (!ok) reject(new Error('connect failed')); });
    sp.player = player;
  }));
  sp.ready.catch(() => { sp.ready = null; });            // allow a retry after failure
  return sp.ready;
}

function spToast(text) {
  if (typeof showRadioToast === 'function') showRadioToast('📻 SPOTIFY — ' + text);
}

// Pull playback to this tab. Resumes whatever the account was last playing;
// if the account has nothing to resume, falls back to shuffling Liked Songs.
async function spStartPlayback() {
  await spApi('PUT', '/me/player', { device_ids: [sp.deviceId], play: true });
  await new Promise((r) => setTimeout(r, 1500));
  const st = await sp.player.getCurrentState();
  if (st && st.track_window.current_track && !st.paused) return;
  const liked = await spApi('GET', '/me/tracks?limit=50');
  const uris = ((liked && liked.items) || []).map((i) => i.track.uri);
  if (!uris.length) { spToast('nothing to play — like some songs first'); return; }
  for (let i = uris.length - 1; i > 0; i--) {            // shuffle
    const j = (Math.random() * (i + 1)) | 0; [uris[i], uris[j]] = [uris[j], uris[i]];
  }
  await spApi('PUT', '/me/player/play?device_id=' + sp.deviceId, { uris });
}

//----------------------------------------------------------------------------
// Dial hooks, called from cycleRadio() in audio.js.
//----------------------------------------------------------------------------
async function spotifyTune() {
  sp.tuned = true; sp.lastTrack = null;
  try {
    if (!(await spToken())) {
      spToast('connect in the popup…');
      await spAuthPopup();
      if (!sp.tuned) return;                             // user dialed away while logging in
    }
    spToast('tuning…');
    await spInitPlayer();
    if (!sp.tuned) return;
    await spStartPlayback();
  } catch (e) {
    if (sp.tuned) spToast((e && e.message) || 'unavailable');
  }
}

function spotifyDetune() {
  if (!sp.tuned) return;
  sp.tuned = false;
  if (sp.player) sp.player.pause().catch(() => {});
}
