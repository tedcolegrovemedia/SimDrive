// SimDrive — audio.js
// Procedural sound, zero assets: an engine voice driven by speed/throttle, and a
// radio with generative "stock music" stations — every note is synthesized in Web
// Audio at schedule time. Loaded as a classic script by js/bootstrap.js; shares the
// global scope (audioCtx is declared in main.js, created here on the first gesture).

//----------------------------------------------------------------------------
// Context bootstrap: browsers only allow audio after a user gesture.
//----------------------------------------------------------------------------
function ensureAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    initEngine();
  } catch (e) {}
}
addEventListener('pointerdown', ensureAudio);
addEventListener('keydown', ensureAudio);

// 1s of white noise, shared by hats/snares/static/wind (created lazily per context)
let _noiseBuf = null;
function noiseBuf() {
  if (_noiseBuf && _noiseBuf.sampleRate === audioCtx.sampleRate) return _noiseBuf;
  _noiseBuf = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
  const d = _noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return _noiseBuf;
}

//----------------------------------------------------------------------------
// Engine: two detuned oscillators + sub through a lowpass, plus wind/road noise.
// Simulated gears — pitch climbs within a gear band and drops at the shift.
//----------------------------------------------------------------------------
let engine = null;
function initEngine() {
  if (engine || !audioCtx) return;
  const ctx = audioCtx;
  const out = ctx.createGain(); out.gain.value = 0; out.connect(ctx.destination);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300; lp.Q.value = 1.1; lp.connect(out);
  const mk = (type, vol, detune) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.detune.value = detune || 0; g.gain.value = vol;
    o.connect(g); g.connect(lp); o.start();
    return o;
  };
  const o1 = mk('sawtooth', 0.5, 0), o2 = mk('square', 0.28, 9), sub = mk('triangle', 0.55, 0);
  const wind = ctx.createBufferSource(); wind.buffer = noiseBuf(); wind.loop = true;
  const wf = ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 850; wf.Q.value = 0.4;
  const wg = ctx.createGain(); wg.gain.value = 0;
  wind.connect(wf); wf.connect(wg); wg.connect(ctx.destination); wind.start();
  engine = { out, lp, o1, o2, sub, wg };
}

const GEARS = [0, 12, 25, 40, 58, 80, 999];   // mph shift points
function updateEngineAudio() {
  if (!engine || !audioCtx) return;
  const t = audioCtx.currentTime;
  const driving = typeof worldReady !== 'undefined' && worldReady;
  const mph = driving ? Math.abs(player.speed) * 2.237 : 0;
  const throttle = driving && (keys['w'] || keys['arrowup'] || keys['s'] || keys['arrowdown']) ? 1 : 0;
  let g = 0; while (g < GEARS.length - 2 && mph >= GEARS[g + 1]) g++;
  const frac = Math.min(1, (mph - GEARS[g]) / (GEARS[g + 1] - GEARS[g]));
  const freq = 46 + 85 * frac + throttle * 6;                    // 46 Hz idle, revs up per gear
  engine.o1.frequency.setTargetAtTime(freq, t, 0.06);
  engine.o2.frequency.setTargetAtTime(freq * 1.5, t, 0.06);      // harmonic gives it "motor" body
  engine.sub.frequency.setTargetAtTime(freq / 2, t, 0.08);       // exhaust rumble
  engine.lp.frequency.setTargetAtTime(240 + frac * 850 + throttle * 450, t, 0.1);
  engine.out.gain.setTargetAtTime(driving ? 0.009 + 0.015 * frac + 0.009 * throttle : 0, t, 0.1);
  engine.wg.gain.setTargetAtTime(Math.min(0.018, mph * 0.00025), t, 0.2);  // wind/road past ~20 mph
}

//----------------------------------------------------------------------------
// Radio: generative stations on a 16th-note lookahead scheduler. Each station is
// a step(t, i) callback that schedules the notes for 16th-step i at time t, into
// a shared "speaker" chain (band-limited like a dash radio).
//----------------------------------------------------------------------------
const nf = m => 440 * Math.pow(2, (m - 69) / 12);   // MIDI note -> Hz

function tone(dest, t, { f, dur, type = 'sine', vol = 0.1, glide = 0 }) {
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.03);
}
function hit(dest, t, { dur, vol, fq, type = 'highpass' }) {   // filtered-noise percussion
  const s = audioCtx.createBufferSource(); s.buffer = noiseBuf(); s.loop = true;
  const f = audioCtx.createBiquadFilter(); f.type = type; f.frequency.value = fq;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f); f.connect(g); g.connect(dest); s.start(t); s.stop(t + dur + 0.03);
}

// --- Station 1: synthwave. Am F C G, driving bass, 16th arps. ---
const SW_CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G (MIDI)
const synthwave = { name: '105.3 THE DRIVE — synthwave', bpm: 112, step(dest, t, i) {
  const bar = (i >> 4) % 4, ch = SW_CHORDS[bar], sixteenth = i % 16;
  if (sixteenth % 4 === 0) tone(dest, t, { f: 55, glide: 32, dur: 0.18, type: 'sine', vol: 0.34 });   // kick
  if (sixteenth % 4 === 2) hit(dest, t, { dur: 0.05, vol: 0.07, fq: 6500 });                          // offbeat hat
  if (sixteenth % 2 === 0) tone(dest, t, { f: nf(ch[0] - 12), dur: 0.22, type: 'sawtooth', vol: 0.075 }); // 8th bass
  const arp = [0, 1, 2, 1][sixteenth % 4] , oct = (sixteenth % 8) < 4 ? 0 : 12;
  tone(dest, t, { f: nf(ch[arp] + 12 + oct), dur: 0.12, type: 'square', vol: 0.03 });                 // 16th arp
  if (sixteenth === 0) for (const m of ch) tone(dest, t, { f: nf(m), dur: 1.7, type: 'sawtooth', vol: 0.018 }); // pad
} };

// --- Station 2: lofi. Dm7 G7 Cmaj7 Am7, lazy keys, swung ride, vinyl crackle. ---
const LF_CHORDS = [[50, 53, 57, 60], [43, 47, 50, 53], [48, 52, 55, 59], [45, 48, 52, 55]];
const lofi = { name: '94.7 SMOOTH — lofi', bpm: 82, step(dest, t, i) {
  const bar = (i >> 4) % 4, ch = LF_CHORDS[bar], sixteenth = i % 16;
  const swing = (sixteenth % 2) ? 0.045 : 0;                       // push the off-16ths late
  if (sixteenth === 0 || sixteenth === 8)                          // soft strummed keys, beats 1 & 3
    ch.forEach((m, k) => tone(dest, t + swing + k * 0.02, { f: nf(m + 12), dur: 1.1, type: 'triangle', vol: 0.05 }));
  if (sixteenth % 4 === 0) {                                       // walking-ish bass on quarters
    const pick = ch[[0, 2, 1, 2][(sixteenth >> 2)] % ch.length];
    tone(dest, t, { f: nf(pick - 12), dur: 0.5, type: 'sine', vol: 0.11 });
  }
  if (sixteenth % 2 === 0) hit(dest, t + swing, { dur: 0.07, vol: 0.028, fq: 8000 });   // swung ride
  if (Math.random() < 0.3) hit(dest, t + Math.random() * 0.1, { dur: 0.015, vol: 0.02, fq: 3000, type: 'bandpass' }); // crackle
} };

// --- Station 3: classical-ish. Alberti arpeggios + slow pentatonic melody. ---
const CL_CHORDS = [[48, 52, 55], [43, 47, 50], [45, 48, 52], [41, 45, 48]]; // C G Am F
const PENTA = [60, 62, 64, 67, 69, 72];
let _clMel = 2;
const classical = { name: '89.1 CLASSICAL', bpm: 96, step(dest, t, i) {
  const bar = (i >> 4) % 4, ch = CL_CHORDS[bar], sixteenth = i % 16;
  if (sixteenth % 2 === 0) {                                       // Alberti bass: low-high-mid-high
    const m = ch[[0, 2, 1, 2][(sixteenth >> 1) % 4]];
    tone(dest, t, { f: nf(m), dur: 0.3, type: 'triangle', vol: 0.055 });
  }
  if (sixteenth % 8 === 0) {                                       // melody: gentle random walk
    _clMel = Math.max(0, Math.min(PENTA.length - 1, _clMel + ((Math.random() * 3) | 0) - 1));
    tone(dest, t, { f: nf(PENTA[_clMel] + 12), dur: 1.0, type: 'sine', vol: 0.075 });
  }
} };

// --- Station 4: AM talk. Formant-filtered noise bursts patterned like speech. ---
const talk = { name: 'AM 570 TALK', bpm: 120, step(dest, t, i) {
  if ((i >> 5) % 3 === 2 && i % 32 < 10) return;                   // pauses between "sentences"
  if (Math.random() < 0.72) {                                      // syllable burst
    const f = audioCtx.createBiquadFilter(); f.type = 'bandpass';
    f.frequency.value = 280 + Math.random() * 900; f.Q.value = 4;
    const s = audioCtx.createBufferSource(); s.buffer = noiseBuf(); s.loop = true;
    const g = audioCtx.createGain(), dur = 0.06 + Math.random() * 0.09;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(dest); s.start(t); s.stop(t + dur + 0.02);
  }
  if (i % 64 === 0) tone(dest, t, { f: 60, dur: 0.5, type: 'sine', vol: 0.012 });  // mains hum
} };

const STATIONS = [synthwave, lofi, classical, talk];
const radio = { on: false, idx: 0, nextT: 0, step: 0, chain: null };

function radioChain() {              // dash-speaker character: band-limited + gentle level
  if (radio.chain) return radio.chain;
  const ctx = audioCtx;
  const g = ctx.createGain(); g.gain.value = 0.5;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 130;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4800;
  g.connect(hp); hp.connect(lp); lp.connect(ctx.destination);
  radio.chain = g;
  return g;
}

function radioStatic() {             // tuning blip between stations
  hit(radioChain(), audioCtx.currentTime, { dur: 0.22, vol: 0.1, fq: 3000, type: 'bandpass' });
}

function cycleRadio() {
  ensureAudio(); if (!audioCtx) return;
  if (!radio.on) { radio.on = true; radio.idx = 0; }
  else if (radio.idx < STATIONS.length - 1) radio.idx++;
  else radio.on = false;
  radio.nextT = audioCtx.currentTime + 0.25; radio.step = 0;
  radioStatic();
  showRadioToast(radio.on ? '📻 ' + STATIONS[radio.idx].name : '📻 radio off');
}

let _toastTimer = null;
function showRadioToast(text) {
  const el = document.getElementById('radioToast'); if (!el) return;
  el.textContent = text; el.classList.remove('hidden');
  clearTimeout(_toastTimer); _toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function updateRadio() {
  if (!radio.on || !audioCtx) return;
  const st = STATIONS[radio.idx], spb16 = 60 / st.bpm / 4, dest = radioChain();
  if (radio.nextT < audioCtx.currentTime - 0.5) radio.nextT = audioCtx.currentTime; // tab was asleep
  while (radio.nextT < audioCtx.currentTime + 0.15) {              // ~150 ms lookahead
    st.step(dest, radio.nextT, radio.step);
    radio.nextT += spb16; radio.step++;
  }
}

// Called from the render loop in main.js.
function updateAudio() {
  if (!audioCtx) return;
  updateEngineAudio();
  updateRadio();
}
