/* CHROMA engine: audio capture, feature extraction and the WebGL renderer.
   Shared by the playground and the spec page. No DOM assumptions beyond a
   canvas; the host supplies hooks for source and error messages. */
(function (global) {
"use strict";
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
/* Bumped whenever the engine changes. Shown in the corner so there is never
   a question of whether a reload actually picked the new code up. */
const BUILD = 'b8';

const NOTE = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const clamp = (v,a,b) => v<a?a:v>b?b:v;

/* ---------------------------------------------------------------
   Feature bus. Exactly the contract printed in the spec above.
   Synthetic by default, real analysis once the mic is granted.
   --------------------------------------------------------------- */
const F = {
  bands: new Float32Array(6),
  chroma: new Float32Array(12),
  chord: { root: 9, quality: 'min', confidence: 0 },
  onset: 0, bpm: 112, beatPhase: 0,
  harmonic: 0, percussive: 0, rms: 0,
  /* separated drives: percussion split from sustained tone, then by range */
  kick: 0, snare: 0, hat: 0, bass: 0, melody: 0,
  /* beat clock: beat pulses once per beat, bar once every four */
  beat: 0, bar: 0, beatCount: 0, bpmLock: 0,
  /* live is true only once real samples have arrived, so the UI cannot lie */
  level: 0, live: false,
  /* what this particular track looks like: a stable seed and a layout choice,
     both derived from the sound itself since there is no metadata to ask */
  seed: new Float32Array(4), variant: 0, trackId: 0,
  /* which form each instrument is drawn as on this track, so the kick is a
     different object from one track to the next rather than the same ring */
  forms: new Int32Array(5),
  /* which of Klüver's form constants this track lives in: radial frequency,
     whole number angular winding, and how far towards a honeycomb it sits */
  cortW: 4.5, cortN: 0, cortHex: 0,
  source: 'synthetic'
};

/* Every hit becomes an object with a life of its own. Driving brightness from
   an envelope smears hits together; giving each one its own entry means each
   kick is actually expressed, and each instrument keeps its own shape. */
const MAXEV = 28;
const evA = new Float32Array(MAXEV * 4);      // x, y, size, form
const evB = new Float32Array(MAXEV * 4);      // age, hue, strength, instrument
const events = [];
const INST = ['kick','snare','hat','bass','melody'];
const REFRACT = { kick: 0.11, snare: 0.09, hat: 0.045, bass: 0.22, melody: 0.16 };
const LIFE    = { kick: 1.5,  snare: 1.1,  hat: 0.55,  bass: 2.6,  melody: 2.2 };
const prevLvl = { kick: 0, snare: 0, hat: 0, bass: 0, melody: 0 };
const lastFire = { kick: 0, snare: 0, hat: 0, bass: 0, melody: 0 };
let evClock = 0, evSpin = 0;

/* --- synthetic signal: a four bar loop so the page has something to show --- */
const PROG = [ [9,'min'], [5,'maj'], [0,'maj'], [7,'maj'] ];
const TRIADS = { maj:[0,4,7], min:[0,3,7] };
function synth(t){
  const beat = t * F.bpm / 60;
  F.beatPhase = beat % 1;
  const bar = ((Math.floor(beat / 4) % PROG.length) + PROG.length) % PROG.length;
  const [root, qual] = PROG[bar];

  const kick = Math.pow(1 - F.beatPhase, 6);
  const off  = Math.pow(1 - ((beat + 0.5) % 1), 9);
  const hat  = Math.pow(1 - ((beat * 2) % 1), 14);
  const swell = 0.5 + 0.5 * Math.sin(t * 0.31);

  F.bands[0] = clamp(kick * 0.95, 0, 1);
  F.bands[1] = clamp(kick * 0.55 + 0.28 + 0.14 * Math.sin(t * 1.7), 0, 1);
  F.bands[2] = clamp(0.24 + 0.2 * swell + off * 0.35, 0, 1);
  F.bands[3] = clamp(0.3 + 0.26 * Math.sin(t * 0.83 + 1.2) + off * 0.25, 0, 1);
  F.bands[4] = clamp(0.2 + 0.24 * swell + hat * 0.4, 0, 1);
  F.bands[5] = clamp(0.12 + hat * 0.7 + 0.1 * Math.sin(t * 2.3), 0, 1);

  F.chroma.fill(0);
  for (const iv of TRIADS[qual]) F.chroma[(root + iv) % 12] = 1;
  F.chroma[(root + 10) % 12] = 0.35 * swell;
  for (let i = 0; i < 12; i++) F.chroma[i] = clamp(F.chroma[i] * (0.72 + 0.28 * swell) + 0.05, 0, 1);

  F.chord.root = root; F.chord.quality = qual; F.chord.confidence = 0.9;
  F.onset = Math.max(kick, off, hat * 0.6);
  F.percussive = Math.max(kick, hat); F.harmonic = 0.4 + 0.3 * swell;
  F.rms = 0.35 + 0.2 * swell;
  F.kick = kick; F.snare = off; F.hat = hat;
  F.bass = clamp(0.35 + kick * 0.5, 0, 1); F.melody = 0.35 + 0.3 * swell;
  F.beat = Math.pow(1 - F.beatPhase, 3);
  F.beatCount = Math.floor(beat) % 4;
  F.bar = F.beatCount === 0 ? F.beat : 0;
  F.bpmLock = 1;
  spawnEvents(1 / 60);
  packEvents();
}

/* --- real analysis --- */
let analyser = null, freq = null, sr = 48000, prevMag = null;
const BAND_HZ = [[20,60],[60,150],[150,400],[400,1200],[1200,3500],[3500,12000]];
const env = new Float32Array(6);
const peak = new Float32Array(6).fill(0.02);
let stableChord = { root: 9, quality: 'min' };
let candRoot = -1, candQ = '', candSince = 0, chordClock = 0;
const CHORD_HOLD = 0.18;   // seconds a triad must keep winning before it commits

let audioCtx = null, fileSrc = null;
/* Hold the source node and the stream. A MediaStreamAudioSourceNode feeding
   only an analyser is not reachable from the destination, so without a
   reference it can be collected and the analyser goes quiet. */
let srcNode = null, srcStream = null, timeBuf = null;

function ensureCtx(){
  if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

/* A context created outside a user gesture starts suspended and stays there,
   and a suspended context feeds the analyser nothing but silence for ever.
   Retry on the next gesture rather than reporting a source that is not live. */
function resumeOnGesture(ctx){
  const evs = ['pointerdown','touchend','keydown','click'];
  const off = function(){ evs.forEach(function(e){ removeEventListener(e, kick, true); }); };
  const kick = function(){
    ctx.resume().then(function(){ if(ctx.state === 'running') off(); }, function(){});
  };
  evs.forEach(function(e){ addEventListener(e, kick, true); });
}

function dropSource(){
  if(fileSrc){ try { fileSrc.stop(); } catch(e){} fileSrc = null; }
  if(srcNode){ try { srcNode.disconnect(); } catch(e){} srcNode = null; }
  if(srcStream){ srcStream.getTracks().forEach(function(t){ try { t.stop(); } catch(e){} }); srcStream = null; }
}

function attachAnalyser(ctx, node, audible){
  sr = ctx.sampleRate;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.55;
  srcNode = node;                                  // keep it alive, see above
  node.connect(analyser);
  if(audible) analyser.connect(ctx.destination);   // never for a live input, that is a feedback loop
  freq = new Float32Array(analyser.frequencyBinCount);
  prevMag = new Float32Array(analyser.frequencyBinCount);
  timeBuf = new Float32Array(analyser.fftSize);
  peak.fill(0.02); env.fill(0); candRoot = -1; candQ = ''; chordClock = 0; candSince = 0;
  resetBeat(); resetSep(); resetTrack();
  F.live = false; F.level = 0; silentFor = 0;
}
const hooks = { onSource: function(){}, onHint: function(){} };
function setSource(label, kind){ F.source = kind; hooks.onSource(label, kind); }
function showHint(html){ hooks.onHint(html); }

async function playFile(file){
  try {
    const ctx = ensureCtx();
    await ctx.resume();
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    dropSource();
    fileSrc = ctx.createBufferSource();
    fileSrc.buffer = buf; fileSrc.loop = true;
    attachAnalyser(ctx, fileSrc, true);
    fileSrc.start();
    const name = file.name.length > 26 ? file.name.slice(0, 24) + '..' : file.name;
    setSource(name, 'file');
    if(ctx.state !== 'running') resumeOnGesture(ctx);
  } catch (err) {
    showHint('That file could not be decoded. Try a WAV, MP3, FLAC or M4A.');
  }
}

// The frame that hosts this page may withhold microphone permission, and
// the artifact runtime does exactly that. Find out before the user clicks.
function micBlocked(){
  if(!navigator.mediaDevices || !window.isSecureContext) return true;
  const pp = document.permissionsPolicy || document.featurePolicy;
  if(pp && typeof pp.allowsFeature === 'function'){
    try { return !pp.allowsFeature('microphone'); } catch(e){}
  }
  return false;   // unknown, let the click settle it
}

/* All live capture lands here: microphone, a loopback device such as VB-CABLE,
   or the system audio that comes back from a screen share. */
async function useAudioStream(stream, label, kind){
  const ctx = ensureCtx();
  await ctx.resume();
  dropSource();
  srcStream = stream;
  attachAnalyser(ctx, ctx.createMediaStreamSource(stream), false);
  setSource(label || 'Live microphone', kind || 'mic');
  /* Say so plainly rather than lighting the button and hoping. The watchdog
     in analyse() promotes this to live once samples actually arrive. */
  if(ctx.state !== 'running'){
    resumeOnGesture(ctx);
    showHint('Tap once to let the browser start audio.');
  }
  return true;
}

const A_CONS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

function captureFailed(err){
  const framed = window.self !== window.top;
  const name = err && err.name;
  if(name === 'NotFoundError') showHint('No audio input device found. Drop a file in instead.');
  else if(name === 'InsecureContext') showHint('Audio capture needs https or localhost.');
  else if(name === 'NotAllowedError' && framed) showHint('This page is in a frame that withholds audio access. Open it in its own tab.');
  else if(name === 'NotAllowedError') showHint('Permission was declined. Allow it in the address bar and press the button again.');
  else showHint('Could not open that audio source' + (name ? ' (' + name + ')' : '') + '.');
  return false;
}

async function enableMic(){
  try {
    if(!navigator.mediaDevices || !window.isSecureContext) throw { name: 'InsecureContext' };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: A_CONS });
    return await useAudioStream(stream, 'Microphone', 'mic');
  } catch (err) { return captureFailed(err); }
}

/* Windows can send one app to its own output device. Point Spotify at a
   virtual cable in the volume mixer and pick the cable here: what arrives is
   the music on its own, with no notifications or browser audio mixed in. */
async function useDevice(deviceId, label){
  try {
    if(!navigator.mediaDevices || !window.isSecureContext) throw { name: 'InsecureContext' };
    const audio = Object.assign({ deviceId: { exact: deviceId } }, A_CONS);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audio });
    return await useAudioStream(stream, label || 'Loopback', 'loop');
  } catch (err) { return captureFailed(err); }
}

/* Labels stay blank until the user has granted audio once, so ask first. */
async function listInputs(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  let devs = await navigator.mediaDevices.enumerateDevices();
  if(!devs.some(function(d){ return d.kind === 'audioinput' && d.label; })){
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: A_CONS });
      probe.getTracks().forEach(function(t){ t.stop(); });
      devs = await navigator.mediaDevices.enumerateDevices();
    } catch (err) { return []; }
  }
  return devs.filter(function(d){ return d.kind === 'audioinput'; })
             .map(function(d){ return { id: d.deviceId, label: d.label || 'Input' }; });
}

/* Sharing a tab hands back that tab's audio and nothing else, on every
   platform. That is the one route to the music on its own that costs the
   listener nothing: no driver, no routing, no install. Whole screen capture
   is kept for desktop players, but it picks up every other sound too. */
async function captureDisplay(tabOnly){
  try {
    if(!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw { name: 'Unsupported' };
    const opts = {
      video: { frameRate: 1 },        // required by the API, kept as cheap as it goes
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      selfBrowserSurface: 'exclude',  // no hall of mirrors
      suppressLocalAudioPlayback: false
    };
    if(tabOnly){
      // steer the picker at tabs: everything else here drags the rest of the machine in
      opts.video.displaySurface = 'browser';
      opts.monitorTypeSurfaces = 'exclude';
      opts.systemAudio = 'exclude';
    } else {
      opts.systemAudio = 'include';
    }
    const stream = await navigator.mediaDevices.getDisplayMedia(opts);
    if(!stream.getAudioTracks().length){
      stream.getTracks().forEach(function(t){ t.stop(); });
      showHint(tabOnly
        ? 'That tab shared no audio. Pick the tab the music is in and tick "Also share tab audio".'
        : 'That share had no audio. Tick "Also share system audio" in the dialog.');
      return false;
    }
    // DRM material hands back a track that only ever carries silence
    if(tabOnly) watchForSilentCapture();
    return await useAudioStream(stream, tabOnly ? 'Tab audio' : 'System audio', 'system');
  } catch (err) { return captureFailed(err); }
}
function useSystemAudio(){ return captureDisplay(false); }
function useTabAudio(){ return captureDisplay(true); }

/* Spotify's web player is encrypted, and an encrypted tab shares a track that
   stays at digital zero rather than failing, so say so instead of leaving the
   picture dead with no explanation. */
function watchForSilentCapture(){
  const started = performance.now();
  const check = setInterval(function(){
    if(!analyser || F.source !== 'system'){ clearInterval(check); return; }
    if(F.live){ clearInterval(check); return; }
    if(performance.now() - started > 6000){
      clearInterval(check);
      showHint('That tab is sending silence. Encrypted players such as Spotify cannot be captured; try YouTube, SoundCloud or a file.');
    }
  }, 500);
}

/* ---------------------------------------------------------------
   Beat tracking. Spectral flux builds an onset envelope at a fixed
   rate; autocorrelation over that envelope gives the period, a comb
   over the same envelope gives the phase, and a free running clock
   is nudged towards both so the beat never jumps.
   --------------------------------------------------------------- */
const OSR = 86.13, OHOP = 1 / OSR;          // ~11.6 ms per hop
const OLEN = 512;                            // about six seconds of history
const onsetEnv = new Float32Array(OLEN);
const BPM_MIN = 70, BPM_MAX = 180;
const LAG_MIN = Math.floor(60 * OSR / BPM_MAX), LAG_MAX = Math.ceil(60 * OSR / BPM_MIN);
const acf = new Float32Array(LAG_MAX - LAG_MIN + 1);
let onsetHead = 0, hopAcc = 0, hopTime = 0, hopsSinceTempo = 0, silentFor = 0;
/* Every level here is measured against a moving peak, which is an auto gain:
   left alone it stretches near silence up to full scale. One absolute gate,
   derived from the raw waveform, holds all of them shut when nothing plays. */
let gate = 0;
/* The smoothed level takes well over a second to fall, so it cannot see the
   gap between two tracks. Gap detection reads the raw frame peak, which drops
   the moment the audio stops. */
let rawPk = 0;

function resetBeat(){
  onsetEnv.fill(0); onsetHead = 0; hopAcc = 0; hopTime = 0; hopsSinceTempo = 0;
  F.bpm = 112; F.bpmLock = 0; F.beatPhase = 0; F.beat = 0; F.bar = 0; F.beatCount = 0;
}
const envAt = function(i){ return onsetEnv[((onsetHead - 1 - i) % OLEN + OLEN) % OLEN]; }; // 0 = newest

function estimateTempo(){
  let mean = 0;
  for(let i = 0; i < OLEN; i++) mean += onsetEnv[i];
  mean /= OLEN;
  if(mean < 1e-7) return;                    // nothing has come in yet

  /* Score each period by the mean onset energy landing on its pulses, with
     the phase chosen to suit. Plain autocorrelation peaks just as hard on
     subdivisions; taking the mean rather than the sum does not, because a
     subdivision has to put half its pulses on the weak offbeats. */
  let bestLag = 0, bestOff = 0, best = -1e9, sum = 0, cnt = 0;
  for(let lag = LAG_MIN; lag <= LAG_MAX; lag++){
    let lBest = -1e9, lOff = 0;
    for(let off = 0; off < lag; off++){
      let s = 0, k = 0;
      for(; off + k * lag < OLEN; k++) s += envAt(off + k * lag) - mean;
      s /= k;
      if(s > lBest){ lBest = s; lOff = off; }
    }
    // a log normal prior around 125 settles what is left: mostly double time
    lBest *= Math.exp(-0.5 * Math.pow(Math.log2((60 * OSR / lag) / 125) / 0.55, 2));
    acf[lag - LAG_MIN] = lBest;
    sum += Math.abs(lBest); cnt++;
    if(lBest > best){ best = lBest; bestLag = lag; bestOff = lOff; }
  }
  if(!bestLag || best <= 0) return;

  const conf = clamp(best / (sum / cnt + 1e-12) / 3, 0, 1);
  F.bpmLock += (conf - F.bpmLock) * 0.25;

  /* Whole hop lags quantise tempo coarsely: near 130 bpm one hop is worth
     three. Fit a parabola through the peak to land between them. */
  let refined = bestLag;
  const k = bestLag - LAG_MIN;
  if(k > 0 && k < acf.length - 1){
    const den = acf[k-1] - 2 * acf[k] + acf[k+1];
    if(den !== 0) refined += clamp(0.5 * (acf[k-1] - acf[k+1]) / den, -0.5, 0.5);
  }

  // ease onto the new tempo; a hard set makes the visuals stutter
  const bpm = 60 * OSR / refined;
  F.bpm += (bpm - F.bpm) * (0.10 + 0.35 * conf);

  // the winning phase came back with the period: that beat landed bestOff
  // hops ago, so this is how far through the current beat we are now
  const target = (bestOff / bestLag) % 1;
  let d = target - F.beatPhase;
  if(d > 0.5) d -= 1; else if(d < -0.5) d += 1;
  F.beatPhase = (F.beatPhase + d * 0.18 * conf + 1) % 1;
}

function pushOnset(flux, dt){
  hopAcc = Math.max(hopAcc, flux);           // peak hold inside the hop
  hopTime += dt;
  while(hopTime >= OHOP){
    hopTime -= OHOP;
    onsetEnv[onsetHead] = hopAcc;
    onsetHead = (onsetHead + 1) % OLEN;
    hopAcc = 0;
    if(++hopsSinceTempo >= 16){ hopsSinceTempo = 0; estimateTempo(); }
  }
}

function runBeatClock(dt){
  const prev = F.beatPhase;
  F.beatPhase = (F.beatPhase + dt * F.bpm / 60) % 1;
  if(F.beatPhase < prev){                    // wrapped, so a beat just landed
    F.beat = 1;
    F.beatCount = (F.beatCount + 1) % 4;
    if(F.beatCount === 0) F.bar = 1;
  } else {
    F.beat = Math.max(0, F.beat - dt * 5);
    F.bar  = Math.max(0, F.bar  - dt * 2.5);
  }
}

/* ---------------------------------------------------------------
   Percussion split from sustained tone. Median over time on a log
   band grid holds what is steady; median across neighbouring bands
   holds what is broadband and brief. Soft masks split the energy,
   then each range drives its own control.
   --------------------------------------------------------------- */
const NB = 48, HIST = 9;
const bandMag = new Float32Array(NB), harmB = new Float32Array(NB), percB = new Float32Array(NB);
const hist = []; for(let i = 0; i < HIST; i++) hist.push(new Float32Array(NB));
const edgeLo = new Int32Array(NB), edgeHi = new Int32Array(NB), edgeHz = new Float32Array(NB);
const scratch = new Float32Array(HIST);
let histHead = 0, edgesFor = 0;
const SEP = ['kick','snare','hat','bass','melody'];
const sEnv = {}, sPeak = {}, sFloor = {};
function resetSep(){
  for(const k of SEP){ sEnv[k] = 0; sPeak[k] = 1e-6; sFloor[k] = 0; F[k] = 0; }
  for(let i = 0; i < HIST; i++) hist[i].fill(0);
  histHead = 0; edgesFor = 0;
}
function median(a, n){
  for(let i = 1; i < n; i++){ const v = a[i]; let j = i - 1;
    while(j >= 0 && a[j] > v){ a[j+1] = a[j]; j--; } a[j+1] = v; }
  return a[n >> 1];
}
function buildEdges(hzPerBin, n){
  const lo = 30, hi = Math.min(16000, hzPerBin * (n - 1));
  for(let b = 0; b < NB; b++){
    const f0 = lo * Math.pow(hi / lo, b / NB), f1 = lo * Math.pow(hi / lo, (b + 1) / NB);
    edgeLo[b] = Math.max(1, Math.floor(f0 / hzPerBin));
    edgeHi[b] = Math.max(edgeLo[b], Math.min(n - 1, Math.ceil(f1 / hzPerBin)));
    edgeHz[b] = f0;
  }
  edgesFor = hzPerBin;
}
function separate(mag, n, hzPerBin, dt){
  if(edgesFor !== hzPerBin) buildEdges(hzPerBin, n);
  for(let b = 0; b < NB; b++){
    let s = 0; for(let i = edgeLo[b]; i <= edgeHi[b]; i++) s += mag[i];
    bandMag[b] = s / (edgeHi[b] - edgeLo[b] + 1);
  }
  hist[histHead].set(bandMag);
  histHead = (histHead + 1) % HIST;

  for(let b = 0; b < NB; b++){
    for(let h = 0; h < HIST; h++) scratch[h] = hist[h][b];
    const hm = median(scratch, HIST);                 // steady over time = tonal
    const w = [], lo = Math.max(0, b - 2), hi = Math.min(NB - 1, b + 2);
    for(let i = lo; i <= hi; i++) w.push(bandMag[i]);
    const pm = median(Float32Array.from(w), w.length); // spread over bands = a hit
    const h2 = hm * hm, p2 = pm * pm, tot = h2 + p2 + 1e-18;
    harmB[b] = bandMag[b] * (h2 / tot);
    percB[b] = bandMag[b] * (p2 / tot);
  }

  const grab = function(arr, f0, f1){
    let s = 0, c = 0;
    for(let b = 0; b < NB; b++) if(edgeHz[b] >= f0 && edgeHz[b] < f1){ s += arr[b]; c++; }
    return c ? s / c : 0;
  };
  const raw = {
    kick:   grab(percB, 30, 120),
    snare:  grab(percB, 150, 900) * 0.6 + grab(percB, 2000, 6000) * 0.4,
    hat:    grab(percB, 6000, 16000),
    bass:   grab(harmB, 30, 250),
    melody: grab(harmB, 250, 2500)
  };
  /* Scaling each element against its own peak alone is an auto gain that
     runs away: with nothing playing it lifts the noise to full scale and
     every meter reads high. So measure each one between its own quiet
     baseline and its own peak, and hold the whole thing shut below an
     absolute level, because silence has no dynamics to stretch. */
  for(const k of SEP){
    const r = raw[k];
    // the floor drops to a new quiet quickly and creeps back up slowly
    sFloor[k] += (r - sFloor[k]) * (1 - Math.exp(-dt / (r < sFloor[k] ? 0.3 : 6)));
    sPeak[k] = Math.max(r, sPeak[k] - (sPeak[k] - sFloor[k]) * dt * 0.14);
    const span = sPeak[k] - sFloor[k];
    const norm = span > 1e-9 ? clamp((r - sFloor[k]) / span, 0, 1) * gate : 0;
    const a = norm > sEnv[k] ? 1 - Math.exp(-dt / 0.004) : 1 - Math.exp(-dt / 0.13);
    sEnv[k] += (norm - sEnv[k]) * a;
    F[k] = sEnv[k];
  }
}

/* ---------------------------------------------------------------
   Per track identity. There is no metadata to ask for, so the track
   has to identify itself from its own sound: a gap, or a lasting
   change in spectral character, means a new one. The average of what
   played becomes a stable seed, so the same track always draws the
   same way and a different one does not.
   --------------------------------------------------------------- */
const FP_N = 18;                                   // 12 chroma, then 6 bands
const fpSlow = new Float32Array(FP_N);             // what is playing now
const fpCur = new Float32Array(FP_N);              // what this track sounded like
let fpQuiet = 0, fpAge = 0, fpDrift = 0, fpHave = false;

/* Tracks already seen, with the look each was given. Matching a new profile
   against these by similarity is what makes a track keep its look: quantising
   features into buckets never survived the profile landing a hair either side
   of an edge, and a tolerance is exactly what that needs. */
/* Measured: the same track twice lands at 0.992 or above, two different tracks
   at 0.980 or below. The threshold sits in that gap. Getting it wrong is soft
   either way — a miss gives a track a fresh look, a false match has two tracks
   share one — so there is no need to be cleverer than this. */
const KNOWN_KEY = 'chroma.tracks.v1', KNOWN_MAX = 150, KNOWN_NEAR = 0.986;
let known = [];
try { known = JSON.parse(localStorage.getItem(KNOWN_KEY)) || []; } catch (e) { known = []; }
function rememberTrack(){
  try {
    known = known.slice(-KNOWN_MAX);
    localStorage.setItem(KNOWN_KEY, JSON.stringify(known));
  } catch (e) {}                          // private mode, or the quota is full
}
function similarity(a, b){
  let d = 0, na = 0, nb = 0;
  for(let i = 0; i < FP_N; i++){ d += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return d / (Math.sqrt(na*nb) + 1e-9);
}

function resetTrack(){
  fpSlow.fill(0); fpCur.fill(0);
  fpQuiet = 0; fpAge = 0; fpDrift = 0; fpHave = false;
  F.seed[0] = 0.5; F.seed[1] = 0.5; F.seed[2] = 0.5; F.seed[3] = 0.5;
  F.variant = 0; F.trackId = 0;
  // a spread of forms up front, so it never opens with everything on one shape
  F.forms[0] = 1; F.forms[1] = 2; F.forms[2] = 7; F.forms[3] = 4; F.forms[4] = 5;
  events.length = 0; F.evCount = 0;
}

/* Stable hash, so a track that comes back gets the look it had before. The
   running average never settles on exactly the same numbers twice, so the
   profile is normalised for loudness and quantised hard before hashing, and
   the tempo estimate is kept out of it: it wobbles a couple of bpm between
   plays, which was enough to land the same track on a different look. */
function commitTrack(){
  fpCur.set(fpSlow);
  // normalise for loudness, so the same track played quieter still matches
  let pk = 0;
  for(let i = 0; i < FP_N; i++) if(fpCur[i] > pk) pk = fpCur[i];
  if(pk > 1e-6) for(let i = 0; i < FP_N; i++) fpCur[i] /= pk;

  F.trackId++;
  fpAge = 0; fpDrift = 0; fpHave = true;

  // heard before? then it keeps the look it already had
  let best = -1, at = -1;
  for(let i = 0; i < known.length; i++){
    const s = similarity(fpCur, known[i].p);
    if(s > best){ best = s; at = i; }
  }
  if(at >= 0 && best > KNOWN_NEAR){
    const k = known[at];
    F.seed.set(k.seed);
    F.variant = k.variant;
    // entries written before forms existed fall through to a fresh deal
    if(k.forms && k.forms.length === 5 && typeof k.cortW === 'number'){
      F.forms.set(k.forms);
      F.cortW = k.cortW; F.cortN = k.cortN; F.cortHex = k.cortHex;
      return;
    }
  }

  /* Four coarse descriptors, not eighteen fine ones. Hashing the full profile
     was far too brittle: a single band landing one level either side of a
     boundary changed everything, so the same track came back looking new. */
  /* Take the strongest pitch class only when it actually wins. On material
     with no clear tonality the top two swap constantly, and that alone was
     enough to send the same track to a different look on the next play. */
  let pc = 0, chSum = 0;
  for(let i = 1; i < 12; i++) if(fpCur[i] > fpCur[pc]) pc = i;
  let second = 0;
  for(let i = 0; i < 12; i++){ chSum += fpCur[i]; if(i !== pc && fpCur[i] > second) second = fpCur[i]; }
  if(fpCur[pc] - second < 0.15 * (fpCur[pc] + 1e-6)) pc = 12;    // no clear key

  // how concentrated the pitch content is: tonal music against noisy
  const sorted = Array.prototype.slice.call(fpCur, 0, 12).sort(function(a, b){ return b - a; });
  const tonal = clamp(Math.floor(3 * (sorted[0] + sorted[1] + sorted[2]) / (chSum + 1e-6)), 0, 2);

  const lo = fpCur[12] + fpCur[13], mid = fpCur[14] + fpCur[15], hi = fpCur[16] + fpCur[17];
  const tot = lo + mid + hi + 1e-6;
  const tilt = clamp(Math.floor(4 * hi / tot), 0, 3);            // bright or heavy
  const body = clamp(Math.floor(4 * mid / tot), 0, 3);           // how full the middle is

  /* Tempo is deliberately not in here. It is the least reliable of the four,
     and a track sitting near a bucket edge flipped the whole look between
     plays. It still shapes the seed below, where a couple of bpm cost nothing. */
  const code = ((pc * 4 + tilt) * 4 + body) * 3 + tonal;
  const h1 = Math.imul(code ^ 0x9e3779b9, 2654435761) >>> 0;
  const h2 = Math.imul(code + 0x85ebca6b, 2246822519) >>> 0;
  const frac = function(n){ return ((n >>> 9) & 0xffff) / 65535; };

  F.seed[0] = frac(h1);                                    // stable, arbitrary
  F.seed[1] = clamp(hi / (hi + lo + 1e-6), 0, 1);          // bright against heavy
  F.seed[2] = clamp((F.bpm - 70) / 110, 0, 1);             // slow against fast
  F.seed[3] = frac(h2);
  F.variant = h1 % 4;
  /* Deal each instrument a form. Spreading the picks apart keeps two
     instruments off the same shape, which is what made tracks look alike. */
  for(let i = 0; i < 5; i++) F.forms[i] = (((h1 >>> (i * 3)) + i * 3) % 8) | 0;

  /* Put the track in one of Klüver's four. Zero winding is a tunnel, no
     radial frequency is a funnel of rays, both together is a spiral, and a
     share of the tracks get the honeycomb instead. */
  const pick = h2 % 4;
  F.cortN = (h1 % 7) | 0;
  F.cortW = 2.0 + F.seed[1] * 7.0;
  if(pick === 0){ F.cortN = 0; }                       // tunnel
  else if(pick === 1){ F.cortW = 0.0; F.cortN = 3 + (h1 % 6); }   // rays
  F.cortHex = pick === 3 ? 1 : 0;                      // honeycomb

  known.push({ p: Array.prototype.slice.call(fpCur), seed: Array.from(F.seed),
               variant: F.variant, forms: Array.from(F.forms),
               cortW: F.cortW, cortN: F.cortN, cortHex: F.cortHex });
  rememberTrack();
}

function trackWatch(dt){
  if(rawPk < 0.006){                     // a real gap, read from the raw peak
    fpQuiet += dt;
    // start the next track clean, or the one just gone bleeds into its profile
    if(fpQuiet > 0.7 && fpHave){ fpHave = false; fpSlow.fill(0); fpAge = 0; }
    return;
  }
  if(gate < 0.35) return;                // too quiet to learn anything from
  fpQuiet = 0;
  fpAge += dt;

  const k = 1 - Math.exp(-dt / 2.2);     // a couple of seconds of character
  for(let i = 0; i < 12; i++) fpSlow[i] += (F.chroma[i] - fpSlow[i]) * k;
  for(let i = 0; i < 6; i++) fpSlow[12+i] += (F.bands[i] - fpSlow[12+i]) * k;

  // wait for the average to settle before committing, or the seed depends on
  // how far in the reading was taken rather than on the track
  if(!fpHave){
    if(fpAge > 4) commitTrack();
    return;
  }

  // crossfaded tracks leave no gap, so also watch for the character changing
  let dot = 0, na = 0, nb = 0;
  for(let i = 0; i < FP_N; i++){ dot += fpSlow[i]*fpCur[i]; na += fpSlow[i]*fpSlow[i]; nb += fpCur[i]*fpCur[i]; }
  const far = 1 - dot / (Math.sqrt(na*nb) + 1e-9);
  fpDrift += (far > 0.34 ? dt : -dt * 1.5);
  fpDrift = clamp(fpDrift, 0, 6);
  if(fpDrift > 3.5 && fpAge > 20) commitTrack();
}

/* A hit fires when its level jumps, not when it is merely loud, with a short
   refusal after each one so a single kick does not become five. */
function spawnEvents(dt){
  evClock += dt;
  evSpin += dt * (0.3 + F.seed[2] * 0.8);
  for(let i = 0; i < 5; i++){
    const k = INST[i], v = F[k], rise = v - prevLvl[k];
    prevLvl[k] = v;
    if(v < 0.28 || rise < 0.09) continue;
    if(evClock - lastFire[k] < REFRACT[k]) continue;
    lastFire[k] = evClock;
    addEvent(i, k, v);
  }
  for(let i = events.length - 1; i >= 0; i--)
    if(evClock - events[i].born > LIFE[INST[events[i].inst]]) events.splice(i, 1);
}

/* Each instrument keeps to its own part of the frame, so you can tell them
   apart even once they have melted together. */
function addEvent(idx, k, str){
  const s = F.seed, ang = evSpin * 0.6 + Math.random() * 6.28318;
  let x, y, size;
  if(k === 'kick'){
    x = (Math.random() - 0.5) * 0.12; y = (Math.random() - 0.5) * 0.12;
    size = 0.055 + str * 0.055;
  } else if(k === 'bass'){
    x = (Math.random() - 0.5) * 1.25; y = -0.16 - Math.random() * 0.26;
    size = 0.15 + str * 0.15;
  } else if(k === 'snare'){
    x = ((events.length & 1) ? 1 : -1) * (0.20 + Math.random() * 0.36);
    y = (Math.random() - 0.5) * 0.52;
    size = 0.075 + str * 0.075;
  } else if(k === 'hat'){
    const r = 0.40 + Math.random() * 0.24;
    x = Math.cos(ang) * r * 1.45; y = Math.sin(ang) * r;
    size = 0.020 + str * 0.024;
  } else {
    const r = 0.15 + Math.random() * 0.32;
    x = Math.cos(evSpin * 0.7 + s[3] * 6.28) * r * 1.5;
    y = Math.sin(evSpin * 1.1 + s[3] * 6.28) * r;
    size = 0.095 + str * 0.10;
  }
  if(events.length >= MAXEV) events.shift();
  events.push({ x: x, y: y, size: size, form: F.forms[idx], born: evClock,
                hue: (hueOf(F.chord.root) + s[0] * 0.42 + idx * 0.13) % 1,
                str: str, inst: idx });
}

function packEvents(){
  let n = 0;
  for(let i = 0; i < events.length && n < MAXEV; i++, n++){
    const e = events[i], o = n * 4;
    evA[o] = e.x; evA[o+1] = e.y; evA[o+2] = e.size; evA[o+3] = e.form;
    evB[o] = clamp((evClock - e.born) / LIFE[INST[e.inst]], 0, 1);   // life, already normalised
    evB[o+1] = e.hue; evB[o+2] = e.str; evB[o+3] = e.inst;
  }
  F.evCount = n;
}

function analyse(dt){
  /* Watch the waveform, not the button. A suspended context or a muted
     device both look identical from the outside: no samples. Say which. */
  analyser.getFloatTimeDomainData(timeBuf);
  let pk = 0;
  for (let i = 0; i < timeBuf.length; i++){ const v = timeBuf[i] < 0 ? -timeBuf[i] : timeBuf[i]; if (v > pk) pk = v; }
  F.level += (pk - F.level) * (pk > F.level ? 0.5 : 0.05);
  gate = clamp((F.level - 0.004) / 0.021, 0, 1);
  rawPk = pk;
  if (pk > 0.0015){
    silentFor = 0;
    if (!F.live){ F.live = true; showHint(''); }
  } else {
    silentFor += dt;
    if (F.live && silentFor > 2) F.live = false;
    if (!F.live && silentFor > 1.5){
      showHint(audioCtx && audioCtx.state !== 'running'
        ? 'Audio is paused. Tap once to start it.'
        : 'Connected, but hearing silence. Check that the source is playing.');
    }
  }

  analyser.getFloatFrequencyData(freq);
  const n = freq.length, hzPerBin = sr / 2 / n;
  const mag = new Float32Array(n);
  for (let i = 0; i < n; i++) mag[i] = Math.pow(10, freq[i] / 20);

  for (let b = 0; b < 6; b++){
    const lo = Math.max(1, Math.floor(BAND_HZ[b][0] / hzPerBin));
    const hi = Math.min(n - 1, Math.ceil(BAND_HZ[b][1] / hzPerBin));
    let s = 0; for (let i = lo; i <= hi; i++) s += mag[i];
    const raw = s / Math.max(1, hi - lo + 1);
    peak[b] = Math.max(raw, peak[b] * 0.9995);
    const norm = clamp(raw / (peak[b] + 1e-9), 0, 1) * gate;
    // 5ms attack, 180ms release
    const k = norm > env[b] ? 1 - Math.exp(-dt / 0.005) : 1 - Math.exp(-dt / 0.18);
    env[b] += (norm - env[b]) * k;
    F.bands[b] = env[b];
  }

  // chroma over C3..C7 only; below that the 4096 window cannot resolve pitch
  const ch = new Float32Array(12);
  const loBin = Math.floor(130.8 / hzPerBin), hiBin = Math.min(n - 1, Math.ceil(2093 / hzPerBin));
  for (let i = loBin; i <= hiBin; i++){
    const f = i * hzPerBin;
    const pc = ((Math.round(12 * Math.log2(f / 440)) % 12) + 21) % 12;
    ch[pc] += mag[i];
  }
  let mx = 0; for (let i = 0; i < 12; i++) mx = Math.max(mx, ch[i]);
  for (let i = 0; i < 12; i++) F.chroma[i] = mx > 0 ? ch[i] / mx : 0;

  // spectral flux for onset
  let flux = 0;
  for (let i = 0; i < n; i++){ const d = mag[i] - prevMag[i]; if (d > 0) flux += d; prevMag[i] = mag[i]; }
  F.onset = clamp(flux / (mx * 40 + 1e-6), 0, 1);

  separate(mag, n, hzPerBin, dt);
  F.percussive = Math.max(F.kick, F.snare, F.hat);
  F.harmonic = Math.max(F.bass, F.melody);
  F.rms = (F.bands[1] + F.bands[3]) * 0.5;

  pushOnset(flux, dt);
  runBeatClock(dt);
  trackWatch(dt);
  spawnEvents(dt);
  packEvents();

  // 24 triad templates, cosine similarity, then four frames of agreement
  let best = -1, bestRoot = 0, bestQ = 'maj';
  for (const q of ['maj','min']){
    for (let r = 0; r < 12; r++){
      let dot = 0, tn = 0;
      for (const iv of TRIADS[q]){ dot += F.chroma[(r + iv) % 12]; tn += 1; }
      let cn = 0; for (let i = 0; i < 12; i++) cn += F.chroma[i] * F.chroma[i];
      const sim = dot / (Math.sqrt(tn) * Math.sqrt(cn) + 1e-9);
      if (sim > best){ best = sim; bestRoot = r; bestQ = q; }
    }
  }
  chordClock += dt;
  if (bestRoot !== candRoot || bestQ !== candQ){
    candRoot = bestRoot; candQ = bestQ; candSince = chordClock;
  } else if (chordClock - candSince >= CHORD_HOLD){
    stableChord = { root: candRoot, quality: candQ };
  }
  F.chord.root = stableChord.root; F.chord.quality = stableChord.quality; F.chord.confidence = best;
}

/* --- flash limiter: caps large luminance swings at 3 per second --- */
const flash = { prev: 0, hits: [] };
function limitFlash(v, now){
  const d = Math.abs(v - flash.prev);
  if (d > 0.22){
    flash.hits.push(now);
    while (flash.hits.length && now - flash.hits[0] > 1000) flash.hits.shift();
    if (flash.hits.length > 3) v = flash.prev + Math.sign(v - flash.prev) * 0.08;
  }
  flash.prev = v;
  return v;
}

/* --- circle of fifths gives the hue --- */
const hueOf = pc => (((pc * 7) % 12) / 12);

/* ---------------------------------------------------------------
   WebGL2. Hero runs one shader. The scene stage runs the real
   ping pong architecture described in the spec: a sim pass that
   reads the previous frame, then a present pass.
   --------------------------------------------------------------- */
const VERT = `#version 300 es
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position = vec4(p*2.0-1.0,0.0,1.0); }`;

const COMMON = `
precision highp float;
uniform vec2 uRes; uniform float uT,uBass,uMid,uAir,uPhase,uHue,uBright;
uniform float uPinch,uSpread,uHueOff,uRoll,uGain;
uniform float uBeat,uBar,uKick,uSnare;
uniform vec4 uSeed; uniform int uVariant;
uniform float uCortW, uCortN, uCortHex, uCortAmp;
#define MAXITEM 32
uniform int uCount;
uniform vec4 uItemA[MAXITEM];   // xy position, z size, w type
uniform vec4 uItemB[MAXITEM];   // x age seconds, y hue, z strength
float h21(vec2 p){ return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453); }
float nz(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<5;i++){ s+=a*nz(p); p*=2.03; a*=0.5; } return s; }
float fbm3(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<3;i++){ s+=a*nz(p); p*=2.03; a*=0.5; } return s; }
vec3 pal(float t){ return 0.5+0.5*cos(6.28318*(t+uHueOff+vec3(0.0,0.33,0.67))); }
vec2 toUV(vec2 p){ return vec2(p.x*uRes.y/uRes.x, p.y)+0.5; }
/* Everything the hands put into the scene. The base field is what runs
   without them; each item is placed, then lives on its own. */
vec3 items(vec2 p){
  vec3 acc = vec3(0.0);
  for(int i = 0; i < MAXITEM; i++){
    if(i >= uCount) break;
    vec4 a = uItemA[i], b = uItemB[i];
    float d = length(p - a.xy);
    float age = b.x, hue = b.y, str = b.z, sz = max(a.z, 0.004);
    float e = 0.0;
    if(a.w < 0.5){
      // orb: breathes with the low end
      float r = sz*(1.0 + uBass*0.55);
      e = exp(-(d*d)/(r*r)) * (0.55 + uBass*1.5);
    } else if(a.w < 1.5){
      // ring: expands from where the palm opened, then thins out
      float rad = age*0.55;
      e = exp(-pow((d - rad)/max(sz*0.5, 0.006), 2.0)) * exp(-age*0.75) * (0.6 + uMid);
    } else {
      // shard: a radial sliver, drawn by a finger
      float ang = atan(p.y - a.xy.y, p.x - a.xy.x);
      float w = 0.5 + 0.5*cos((ang - hue*6.28318)*6.0);
      e = pow(w, 22.0) * exp(-d*d/(sz*sz*9.0)) * (0.5 + uAir*1.3);
    }
    acc += pal(hue + d*0.30) * e * str;
  }
  return acc*0.085;
}
/* ---- the cortical field ------------------------------------------------
   Klüver catalogued four shapes that recur across mescaline, LSD and
   psilocybin: tunnels, spirals, lattices and cobwebs. Ermentrout and Cowan
   showed why. The map from retina to V1 is logarithmic, x = ln r and
   y = theta, so plain stripes of cortical activity are seen as rings when
   they run one way, as rays when they run the other, and as spirals in
   between; a hexagonal cortical pattern is seen as a honeycomb.

   So this does not imitate those pictures, it draws them the way the cortex
   is thought to make them. One wave, cos(w*ln r + n*theta), covers all of
   them: n = 0 is a tunnel, w = 0 is a funnel of rays, both together spiral.
   n has to stay a whole number or the pattern tears where theta wraps. */
float cortex(vec2 p, float phase){
  float r = max(length(p), 1e-3);
  float th = atan(p.y, p.x);
  float lr = log(r);
  float w = cos(uCortW*lr + uCortN*th - phase);
  if(uCortHex > 0.01){
    // two more waves turned away from the first: stripes become a honeycomb
    float m = max(1.0, floor(uCortN*0.5) + 3.0);
    float b2 = -0.5*uCortW*lr + m*th - phase*0.8;
    float b3 = -0.5*uCortW*lr - m*th - phase*0.8;
    w = mix(w, (w + cos(b2) + cos(b3))*0.333, uCortHex);
  }
  return w;
}

/* ---- the form library -------------------------------------------------
   Eight ways a hit can be drawn. Each track hands its instruments a
   different set, so the kick is a ring on one track and a rosette on the
   next, rather than the same shape wearing a new colour. */
#define MAXEV 28
uniform int uEvCount;
uniform vec4 uEvA[MAXEV];   // xy position, z size, w form
uniform vec4 uEvB[MAXEV];   // x life 0..1, y hue, z strength, w instrument

float smax(float a, float b, float k){
  float h = clamp(0.5 + 0.5*(b - a)/k, 0.0, 1.0);
  return mix(a, b, h) + k*h*(1.0 - h);
}
float formOf(int f, vec2 q, float sz, float t, float str){
  float d = length(q), a = atan(q.y, q.x);
  float fade = (1.0 - t)*(1.0 - t);
  float e = 0.0;
  if(f == 0){                       // ring: races out and thins
    float r = sz + t*0.60;
    e = exp(-pow((d - r)/(sz*0.5 + 0.010), 2.0));
  } else if(f == 1){                // blob: swells, then sinks
    float r = sz*(1.0 + t*0.85);
    e = exp(-(d*d)/(r*r));
  } else if(f == 2){                // shard: one narrow blade
    e = pow(abs(cos(a*0.5)), 26.0) * exp(-d*d/(sz*sz*9.0));
  } else if(f == 3){                // rosette: petals opening
    float petal = pow(abs(cos(a*3.0 + t*2.0)), 5.0);
    e = petal * exp(-pow((d - sz*(0.6 + t*1.5))/(sz*0.85), 2.0));
  } else if(f == 4){                // lattice: a patch of cells
    vec2 g = fract(q/(sz*0.75)) - 0.5;
    float cell = 1.0 - smoothstep(0.16, 0.40, length(g));
    e = cell * exp(-d*d/(sz*sz*7.0));
  } else if(f == 5){                // filament: a thin drawn arc
    float arc = abs(d - sz*(0.8 + t*1.1));
    e = exp(-pow(arc/(sz*0.16 + 0.004), 2.0)) * (0.45 + 0.55*cos(a*2.0 + t*4.0));
  } else if(f == 6){                // burst: spokes thrown outward
    float sp = pow(abs(sin(a*5.0 + str*3.0)), 16.0);
    e = sp * exp(-d/(sz*(1.5 + t*4.0)));
  } else {                          // bubble: hollow, with a bright rim
    float r = sz*(1.0 + t*1.2);
    e = exp(-pow((d - r)/(r*0.30), 2.0))*0.85 + exp(-(d*d)/(r*r))*0.20;
  }
  return max(e, 0.0) * fade;
}

/* Every live hit, warped by one shared field so neighbours flow into each
   other, then unioned smoothly so overlaps swell instead of stacking. */
vec3 drawEvents(vec2 p){
  vec2 w = vec2(fbm3(p*1.5 + uT*0.05), fbm3(p*1.5 + vec2(4.1,2.3) - uT*0.05)) - 0.5;
  vec2 pw = p + w*(0.055 + uBass*0.075);
  vec3 col = vec3(0.0);
  float field = 0.0;
  for(int i = 0; i < MAXEV; i++){
    if(i >= uEvCount) break;
    vec4 A = uEvA[i], B = uEvB[i];
    float e = formOf(int(A.w), pw - A.xy, max(A.z, 0.008), B.x, B.z);
    col += pal(B.y + e*0.18) * e * B.z;
    field = smax(field, e, 0.32);          // this is the melt
  }
  // where several forms overlap the union blooms, so they read as one body
  col += pal(uHue + 0.15) * pow(clamp(field, 0.0, 1.0), 2.2) * 0.22;
  return col * 0.115;
}

vec2 fold(vec2 p){
  if(uSpread < 0.02) return p;
  float seg = 2.0 + floor(uSpread*7.0);
  float r = length(p), a = atan(p.y,p.x) + uRoll*3.14159;
  a = abs(mod(a, 6.28318/seg) - 3.14159/seg);
  return vec2(cos(a), sin(a))*r;
}
`;

const SIM_FS = `#version 300 es
${COMMON}
uniform sampler2D uPrev; uniform int uScene;
out vec4 O;

vec2 curl(vec2 p){
  float e = 0.03, s = 1.4, tt = uT*0.04;
  float a = fbm(p*s+tt+vec2(0.0,e)), b = fbm(p*s+tt-vec2(0.0,e));
  float c = fbm(p*s+tt+vec2(e,0.0)), d = fbm(p*s+tt-vec2(e,0.0));
  return vec2(a-b, -(c-d))/(2.0*e);
}
/* ---- one shape per element ----------------------------------------------
   Each part of the kit gets its own geometry, its own motion and its own
   place on the palette, so you can pick out the kick from the hats without
   being told which is which. They are summed, not blended. */

// KICK: a shockwave fired on the beat, racing out and thinning as it goes
vec3 elemKick(float r, float a){
  // the track decides whether the wave goes out round or cornered
  float sides = 3.0 + floor(uSeed.w*5.0);
  float rr = r * (1.0 + uSeed.w*0.16*cos(a*sides));
  float rad = fract(uPhase)*1.25;
  float w = 0.028 + 0.055*uKick;
  float ring = exp(-pow((rr - rad)/w, 2.0)) * (1.0 - fract(uPhase)*0.65);
  float core = exp(-r*r/(0.009 + uKick*0.030));
  float k = uKick*uKick;
  return pal(uHue) * (ring*k*0.180 + core*k*0.225);
}

// BASS: a slow heavy mass underneath everything, swelling with the low end
vec3 elemBass(vec2 p){
  float t = uT*0.05;
  float sc = 0.55 + uSeed.y*1.05;          // fine grained or broad, per track
  vec2 q = vec2(fbm3(p*sc + t), fbm3(p*sc + vec2(3.1,1.7) - t));
  float m = fbm3(p*(sc*1.4) + q*(1.0 + uBass*2.4));
  float body = smoothstep(0.66 - uBass*0.34, 0.98, m);
  return pal(uHue + 0.08) * body * (0.0022 + uBass*0.051);
}

// SNARE: shards that crack outward from the middle when the backbeat lands
vec3 elemSnare(float r, float a){
  float sd = floor(uT*2.0);
  float n = 4.0 + floor(uSeed.x*9.0) + floor(h21(vec2(sd, 3.0))*4.0);
  float blades = pow(abs(sin(a*n + h21(vec2(sd, 9.0))*6.28318)), 30.0);
  float s = uSnare*uSnare;
  return pal(uHue + 0.5) * blades * s * exp(-r*0.9) * 0.162;
}

// HATS: fine grit twinkling out towards the rim. The cell grid has to stay
// small or the feedback zoom drags each one into a visible block.
vec3 elemHat(vec2 p, float r){
  vec2 g = floor(p*(140.0 + uSeed.z*120.0));
  float spark = step(0.9962 - uAir*(0.0055 + uSeed.y*0.0055), h21(g + floor(uT*26.0)));
  return pal(uHue + 0.62) * spark * uAir * smoothstep(0.12, 0.8, r) * 0.128;
}

// MELODY: ribbons that drift and take their colour from the chord
vec3 elemMelody(vec2 p){
  float t = uT*0.03;
  vec2 w = vec2(fbm3(p*1.45 + t), fbm3(p*1.45 + vec2(5.2,2.8) - t));
  float f = fbm3(p*1.15 + w*1.7);
  float lines = pow(0.5 + 0.5*sin(f*(12.0 + uSeed.z*24.0) - uT*0.5), 10.0);
  return pal(uHue + 0.28 + f*0.14) * lines * (0.0022 + uMid*0.065);
}

vec3 src0(vec2 p){
  float r = length(p), a = atan(p.y, p.x);
  /* the cortical bed underneath, the sustained parts over it, then every
     individual hit on top, so nothing that happens in the track is silent */
  float c = cortex(p, uT*0.22 + uPhase*3.14159);
  float ridge = pow(max(c, 0.0), 3.0);              // keep the crests, drop the troughs
  vec3 bed = pal(uHue + c*0.10 + r*0.12) * ridge * uCortAmp * 0.055;
  return bed + elemBass(p)*0.6 + elemMelody(p)*0.5 + elemHat(p, r)*0.7 + drawEvents(p);
}

/* How the previous frame is moved before the new one is added. A constant
   pull toward the middle is what turned every shape into the same radial
   streaks, so it is now one option of four rather than the whole look, and
   the track picks which. The pulse stays in all of them: the kick supplies
   the movement instead of a fixed drift. */
vec2 flow(vec2 p){
  float rot = uRoll*0.030;
  if(uVariant == 1){                       // turning: a slow carousel, no pull in
    float a = 0.0125 + uBar*0.030 + uMid*0.008 + rot;
    return mat2(cos(a),-sin(a),sin(a),cos(a)) * p;
  }
  if(uVariant == 2){                       // rising, like smoke lifting off the beat
    float a = 0.0010 + rot;
    vec2 q = mat2(cos(a),-sin(a),sin(a),cos(a)) * p;
    return q + vec2(sin(uT*0.06 + uSeed.w*6.28318)*0.0045, -0.0090 - uKick*0.022);
  }
  if(uVariant == 3){                       // pumping: hard out on the kick, back between
    float s = 1.0 - 0.0010 - uKick*0.055 + sin(uPhase*6.28318)*0.019;
    float a = 0.0012 + uBar*0.010 + rot;
    return mat2(cos(a),-sin(a),sin(a),cos(a)) * (p*s);
  }
  // 0: nearly still, so each shape holds its place and stays readable
  float a = 0.0006 + uMid*0.002 + uBar*0.007 + rot;
  return mat2(cos(a),-sin(a),sin(a),cos(a)) * (p*(1.0 - 0.0003 - uKick*0.004));
}
vec3 srcHero(vec2 p){
  float t = uT*0.045;
  vec2 q = vec2(fbm(p*1.10+t), fbm(p*1.10+vec2(4.1,2.3)-t));
  vec2 w = vec2(fbm(p*1.70 + q*(1.4+uBass*1.8) + t), fbm(p*1.70 + q*1.6 + vec2(7.7,1.9) - t));
  float f = fbm(p*1.35 + w*2.1);
  float contour = pow(0.5+0.5*sin(f*26.0 - uT*0.55), 6.0);
  float r = length(p), a = atan(p.y, p.x);
  float spokes = pow(abs(sin(a*3.0 + uT*0.11 + f*2.2)), 12.0)*exp(-r*0.85);
  float ring = exp(-pow((r - fract(uPhase)*1.3)*5.0, 2.0))*(0.05 + uBass*0.28);
  return pal(uHue + f*0.40 + r*0.12)*(contour*0.155*(0.5+uMid) + spokes*0.095*(0.3+uAir) + ring);
}
vec3 src2(vec2 p){
  vec3 c = vec3(0.0);
  for(int i=0;i<9;i++){
    float fi = float(i);
    vec2 o = vec2(sin(uT*0.21+fi*2.13)*0.78, cos(uT*0.17+fi*1.71)*0.48);
    float d = length(p-o);
    c += pal(uHue + fi*0.06)*exp(-d*d*1100.0)*(0.55+uAir*1.4);
  }
  return c;
}
float mapSDF(vec3 p){
  float a = uT*0.055 + uRoll*1.2;
  p.xz = mat2(cos(a),-sin(a),sin(a),cos(a))*p.xz;
  float scale = 1.0;
  for(int i=0;i<7;i++){
    p = -1.0 + 2.0*fract(0.5*p + 0.5);
    float r2 = dot(p,p);
    float k = (1.12 + uBass*0.26 + uPinch*0.30)/max(r2, 0.06);
    p *= k; scale *= k;
  }
  return 0.25*abs(p.y)/scale;
}
vec3 march(vec2 uvp){
  vec3 ro = vec3(0.62 + 0.18*sin(uT*0.043), 0.44 + 0.12*cos(uT*0.037), -1.15 - uT*0.045);
  vec3 rd = normalize(vec3(fold(uvp)*1.55, 1.0));
  float t = 0.02, g = 0.0;
  for(int i=0;i<70;i++){
    float d = mapSDF(ro + rd*t);
    g += 0.011/(0.042 + abs(d));
    if(d < 0.0008 || t > 4.2) break;
    t += clamp(d*0.62, 0.0022, 0.055);
  }
  return pal(uHue + t*0.10 + g*0.016)*g*g*(0.0044 + uBass*0.0052);
}
void main(){
  vec2 uv = gl_FragCoord.xy/uRes;
  vec2 p = (gl_FragCoord.xy - 0.5*uRes)/uRes.y;
  vec3 col;
  if(uScene == 1){
    col = march(p) + items(fold(p))*2.4;
  } else if(uScene == 0){
    /* Feedback is a gain, not a fade: at 0.92 anything steady is multiplied
       about twelvefold before it settles, which is what buried every shape
       under a white core. Shorter trail, and the sources are scaled to suit. */
    col = texture(uPrev, toUV(flow(p))).rgb*(0.893 + uGain*0.045) + src0(fold(p)) + items(fold(p));
  } else if(uScene == 2){
    vec2 q = p - curl(p)*0.0045*(1.0 + uBass*1.6 + uPinch*3.0);
    col = texture(uPrev, toUV(q)).rgb*(0.950 + uGain*0.040) + src2(fold(p)) + items(fold(p));
  } else {
    float sc = 1.0 - 0.0055 - uBass*0.006;
    float an = 0.0016 + uMid*0.0035;
    vec2 q = mat2(cos(an),-sin(an),sin(an),cos(an)) * (p*sc);
    col = texture(uPrev, toUV(q)).rgb*0.955 + srcHero(p);
  }
  O = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const PRESENT_FS = `#version 300 es
${COMMON}
uniform sampler2D uSrc;
out vec4 O;
void main(){
  vec2 uv = gl_FragCoord.xy/uRes;
  vec2 p = (gl_FragCoord.xy - 0.5*uRes)/uRes.y;
  vec3 c = texture(uSrc, uv).rgb;
  c *= 0.55 + uBright*0.62;
  c *= 1.0 - 0.52*pow(clamp(length(p)*0.62,0.0,1.0), 2.0);
  c += (h21(gl_FragCoord.xy + uT)-0.5)*0.022;
  O = vec4(max(c,0.0), 1.0);
}`;

function compile(gl, src, type){
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){ console.warn(gl.getShaderInfoLog(s)); return null; }
  return s;
}
function program(gl, fs){
  const v = compile(gl, VERT, gl.VERTEX_SHADER), f = compile(gl, fs, gl.FRAGMENT_SHADER);
  if(!v || !f) return null;
  const p = gl.createProgram();
  gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
  if(!gl.getProgramParameter(p, gl.LINK_STATUS)){ console.warn(gl.getProgramInfoLog(p)); return null; }
  return p;
}
function uniforms(gl, p){
  const names = ['uRes','uT','uBass','uMid','uAir','uPhase','uHue','uBright','uPrev','uScene','uSrc',
                 'uPinch','uSpread','uHueOff','uRoll','uGain','uCount','uItemA','uItemB',
                 'uBeat','uBar','uKick','uSnare','uSeed','uVariant',
                 'uEvCount','uEvA','uEvB',
                 'uCortW','uCortN','uCortHex','uCortAmp'];
  const u = {}; for(const n of names) u[n] = gl.getUniformLocation(p, n);
  return u;
}
const NEUTRAL = { pinch:0, spread:0, hueOff:0, roll:0, gain:0, count:0 };
function setCommon(gl, u, w, h, t, bright, g){
  g = g || NEUTRAL;
  gl.uniform1f(u.uPinch,  g.pinch  || 0);
  gl.uniform1f(u.uSpread, g.spread || 0);
  gl.uniform1f(u.uHueOff, g.hueOff || 0);
  gl.uniform1f(u.uRoll,   g.roll   || 0);
  gl.uniform1f(u.uGain,   g.gain   || 0);
  const n = g.count | 0;
  gl.uniform1i(u.uCount, n);
  if (n > 0) { gl.uniform4fv(u.uItemA, g.itemA); gl.uniform4fv(u.uItemB, g.itemB); }
  gl.uniform2f(u.uRes, w, h);
  gl.uniform1f(u.uT, t);
  /* the separated drives, so each part of the kit moves its own thing */
  gl.uniform1f(u.uBass, Math.max(F.bass, F.kick * 0.8));
  gl.uniform1f(u.uMid, F.melody);
  gl.uniform1f(u.uAir, F.hat);
  gl.uniform1f(u.uKick, F.kick);
  gl.uniform1f(u.uSnare, F.snare);
  gl.uniform1f(u.uBeat, F.beat);
  gl.uniform1f(u.uBar, F.bar);
  gl.uniform1f(u.uPhase, F.beatPhase);
  gl.uniform4fv(u.uSeed, F.seed);
  gl.uniform1i(u.uVariant, F.variant | 0);
  const ev = F.evCount | 0;
  gl.uniform1i(u.uEvCount, ev);
  if (ev > 0) { gl.uniform4fv(u.uEvA, evA); gl.uniform4fv(u.uEvB, evB); }
  /* Which form constant this track sits in. The winding has to be a whole
     number, and the bass bends the spiral pitch so the shape itself moves
     with the music rather than only its brightness. */
  gl.uniform1f(u.uCortW, F.cortW + F.bass * 1.6);
  gl.uniform1f(u.uCortN, F.cortN);
  gl.uniform1f(u.uCortHex, F.cortHex);
  gl.uniform1f(u.uCortAmp, 0.25 + F.melody * 0.55 + F.bass * 0.35);
  // the chord still moves the hue within a track; the seed sets where it sits
  gl.uniform1f(u.uHue, hueOf(F.chord.root) + (F.chord.quality === 'min' ? 0.045 : 0)
                       + F.seed[0] * 0.42);
  gl.uniform1f(u.uBright, bright);
}
const MAX_DIM = 3072;
function sizeCanvas(c, maxDpr){
  const dpr = Math.min(devicePixelRatio || 1, maxDpr);
  const w = Math.min(MAX_DIM, Math.max(1, Math.round(c.clientWidth * dpr)));
  const h = Math.min(MAX_DIM, Math.max(1, Math.round(c.clientHeight * dpr)));
  if(c.width !== w || c.height !== h){ c.width = w; c.height = h; return true; }
  return false;
}

function makeTarget(gl, w, h){
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { t, f };
}

/* --- one renderer, used twice. Both canvases run the same two pass
   ping pong the spec describes; only the scene id differs. --- */
function makeRenderer(canvas, dprCap){
  const gl = canvas.getContext('webgl2', { antialias:false, alpha:false, powerPreference:'high-performance' });
  if(!gl) return null;
  const simP = program(gl, SIM_FS), preP = program(gl, PRESENT_FS);
  if(!simP || !preP) return null;
  const simU = uniforms(gl, simP), preU = uniforms(gl, preP);
  let fbs = [], texs = [], flip = 0;
  function alloc(){
    for(const t of texs) gl.deleteTexture(t);
    for(const f of fbs) gl.deleteFramebuffer(f);
    texs = []; fbs = [];
    for(let i = 0; i < 2; i++){
      const r = makeTarget(gl, canvas.width, canvas.height);
      texs.push(r.t); fbs.push(r.f);
    }
  }
  function draw(t, bright, scene, g){
    if(sizeCanvas(canvas, dprCap) || !fbs.length) alloc();
    const w = canvas.width, h = canvas.height, src = flip, dst = 1 - flip;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbs[dst]);
    gl.viewport(0, 0, w, h);
    gl.useProgram(simP);
    setCommon(gl, simU, w, h, t, bright, g);
    gl.uniform1i(simU.uScene, scene);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texs[src]);
    gl.uniform1i(simU.uPrev, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(preP);
    setCommon(gl, preU, w, h, t, bright, g);
    gl.bindTexture(gl.TEXTURE_2D, texs[dst]);
    gl.uniform1i(preU.uSrc, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    flip = dst;
  }
  return { alloc, draw };
}

global.ChromaEngine = {
  F: F, NOTE: NOTE, TRIADS: TRIADS, hueOf: hueOf, clamp: clamp, REDUCE: REDUCE, BUILD: BUILD,
  hooks: hooks,
  synth: synth,
  analyse: function (dt) { if (analyser) { analyse(dt); return true; } return false; },
  hasInput: function () { return !!analyser; },
  enableMic: enableMic, useAudioStream: useAudioStream, playFile: playFile, micBlocked: micBlocked,
  useDevice: useDevice, listInputs: listInputs,
  useSystemAudio: useSystemAudio, useTabAudio: useTabAudio,
  knownTracks: function(){ return known; },
  forgetTracks: function(){ known = []; rememberTrack(); },
  limitFlash: limitFlash,
  makeRenderer: makeRenderer, sizeCanvas: sizeCanvas, MAXITEM: 32
};
})(window);
