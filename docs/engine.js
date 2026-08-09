/* CHROMA engine: audio capture, feature extraction and the WebGL renderer.
   Shared by the playground and the spec page. No DOM assumptions beyond a
   canvas; the host supplies hooks for source and error messages. */
(function (global) {
"use strict";
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  source: 'synthetic'
};

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
  resetBeat(); resetSep();
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

/* Fallback when no cable is installed. Chrome only offers system audio next
   to a tab or the whole screen, and only on Windows; a window share hands
   back everything the machine is playing, not just that window. */
async function useSystemAudio(){
  try {
    if(!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw { name: 'Unsupported' };
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 },        // required, and kept as cheap as it goes
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include', selfBrowserSurface: 'exclude'
    });
    if(!stream.getAudioTracks().length){
      stream.getTracks().forEach(function(t){ t.stop(); });
      showHint('That share had no audio. Pick a tab or the whole screen and tick "Share system audio".');
      return false;
    }
    return await useAudioStream(stream, 'System audio', 'system');
  } catch (err) { return captureFailed(err); }
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

function analyse(dt){
  /* Watch the waveform, not the button. A suspended context or a muted
     device both look identical from the outside: no samples. Say which. */
  analyser.getFloatTimeDomainData(timeBuf);
  let pk = 0;
  for (let i = 0; i < timeBuf.length; i++){ const v = timeBuf[i] < 0 ? -timeBuf[i] : timeBuf[i]; if (v > pk) pk = v; }
  F.level += (pk - F.level) * (pk > F.level ? 0.5 : 0.05);
  gate = clamp((F.level - 0.004) / 0.021, 0, 1);
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
vec3 elemKick(float r){
  float rad = fract(uPhase)*1.25;
  float w = 0.028 + 0.055*uKick;
  float ring = exp(-pow((r - rad)/w, 2.0)) * (1.0 - fract(uPhase)*0.65);
  float core = exp(-r*r/(0.009 + uKick*0.030));
  float k = uKick*uKick;
  return pal(uHue) * (ring*k*0.180 + core*k*0.225);
}

// BASS: a slow heavy mass underneath everything, swelling with the low end
vec3 elemBass(vec2 p){
  float t = uT*0.05;
  vec2 q = vec2(fbm3(p*0.75 + t), fbm3(p*0.75 + vec2(3.1,1.7) - t));
  float m = fbm3(p*1.05 + q*(1.0 + uBass*2.4));
  float body = smoothstep(0.66 - uBass*0.34, 0.98, m);
  return pal(uHue + 0.08) * body * (0.0022 + uBass*0.051);
}

// SNARE: shards that crack outward from the middle when the backbeat lands
vec3 elemSnare(float r, float a){
  float seed = floor(uT*2.0);
  float n = 6.0 + floor(h21(vec2(seed, 3.0))*6.0);
  float blades = pow(abs(sin(a*n + h21(vec2(seed, 9.0))*6.28318)), 30.0);
  float s = uSnare*uSnare;
  return pal(uHue + 0.5) * blades * s * exp(-r*0.9) * 0.162;
}

// HATS: fine grit twinkling out towards the rim. The cell grid has to stay
// small or the feedback zoom drags each one into a visible block.
vec3 elemHat(vec2 p, float r){
  vec2 g = floor(p*185.0);
  float spark = step(0.9955 - uAir*0.0075, h21(g + floor(uT*26.0)));
  return pal(uHue + 0.62) * spark * uAir * smoothstep(0.12, 0.8, r) * 0.128;
}

// MELODY: ribbons that drift and take their colour from the chord
vec3 elemMelody(vec2 p){
  float t = uT*0.03;
  vec2 w = vec2(fbm3(p*1.45 + t), fbm3(p*1.45 + vec2(5.2,2.8) - t));
  float f = fbm3(p*1.15 + w*1.7);
  float lines = pow(0.5 + 0.5*sin(f*20.0 - uT*0.5), 10.0);
  return pal(uHue + 0.28 + f*0.14) * lines * (0.0022 + uMid*0.065);
}

vec3 src0(vec2 p){
  float r = length(p), a = atan(p.y, p.x);
  return elemBass(p) + elemMelody(p) + elemKick(r) + elemSnare(r, a) + elemHat(p, r);
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
    /* A constant zoom drags every shape into the same radial streaks, which
       is what made all five elements read as one thing. Keep the drift small
       and let the kick supply the pull, so the tunnel is an event, not a look. */
    float sc = 1.0 - 0.0035 - uBass*0.005 - uPinch*0.020 - uKick*0.019;
    float an = 0.0012 + uMid*0.004 + uRoll*0.030 + uBar*0.010;
    vec2 q = mat2(cos(an),-sin(an),sin(an),cos(an)) * (p*sc);
    /* Feedback is a gain, not a fade: at 0.92 anything steady is multiplied
       about twelvefold before it settles, which is what buried every shape
       under a white core. Shorter trail, and the sources are scaled to suit. */
    col = texture(uPrev, toUV(q)).rgb*(0.893 + uGain*0.045) + src0(fold(p)) + items(fold(p));
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
                 'uBeat','uBar','uKick','uSnare'];
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
  gl.uniform1f(u.uHue, hueOf(F.chord.root) + (F.chord.quality === 'min' ? 0.045 : 0));
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
  F: F, NOTE: NOTE, TRIADS: TRIADS, hueOf: hueOf, clamp: clamp, REDUCE: REDUCE,
  hooks: hooks,
  synth: synth,
  analyse: function (dt) { if (analyser) { analyse(dt); return true; } return false; },
  hasInput: function () { return !!analyser; },
  enableMic: enableMic, useAudioStream: useAudioStream, playFile: playFile, micBlocked: micBlocked,
  useDevice: useDevice, listInputs: listInputs, useSystemAudio: useSystemAudio,
  limitFlash: limitFlash,
  makeRenderer: makeRenderer, sizeCanvas: sizeCanvas, MAXITEM: 32
};
})(window);
