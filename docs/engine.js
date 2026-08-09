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
function ensureCtx(){
  if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function attachAnalyser(ctx, node, audible){
  sr = ctx.sampleRate;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.55;
  node.connect(analyser);
  if(audible) analyser.connect(ctx.destination);   // never for the mic, that is a feedback loop
  freq = new Float32Array(analyser.frequencyBinCount);
  prevMag = new Float32Array(analyser.frequencyBinCount);
  peak.fill(0.02); env.fill(0); candRoot = -1; candQ = ''; chordClock = 0; candSince = 0;
}
const hooks = { onSource: function(){}, onHint: function(){} };
function setSource(label, kind){ F.source = kind; hooks.onSource(label, kind); }
function showHint(html){ hooks.onHint(html); }

async function playFile(file){
  try {
    const ctx = ensureCtx();
    await ctx.resume();
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    if(fileSrc){ try { fileSrc.stop(); } catch(e){} }
    fileSrc = ctx.createBufferSource();
    fileSrc.buffer = buf; fileSrc.loop = true;
    attachAnalyser(ctx, fileSrc, true);
    fileSrc.start();
    const name = file.name.length > 26 ? file.name.slice(0, 24) + '..' : file.name;
    setSource(name, 'file');
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

async function enableMic(){
  try {
    if(!navigator.mediaDevices || !window.isSecureContext) throw { name: 'InsecureContext' };
    const stream = await navigator.mediaDevices.getUserMedia({
      // all three must be off, or the browser will clean the spectrum before we see it
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    const ctx = ensureCtx();
    await ctx.resume();
    attachAnalyser(ctx, ctx.createMediaStreamSource(stream), false);
    setSource('Live microphone', 'mic');
    return true;
  } catch (err) {
    const framed = window.self !== window.top;
    if(err && err.name === 'NotFoundError'){
      showHint('No audio input device found. Drop a file below instead.');
    } else if(err && err.name === 'InsecureContext'){
      showHint('Microphone capture needs https or localhost. Drop a file below instead.');
    } else if(framed){
      showHint('This page is embedded in a frame that withholds microphone access. Use the file picker below, or run the page outside the frame.');
    } else {
      showHint('Microphone permission was declined. Allow it in the address bar and press the button again, or drop a file below.');
    }
    return false;
  }
}

function analyse(dt){
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
    const norm = clamp(raw / (peak[b] + 1e-9), 0, 1);
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
  F.percussive = F.bands[0] * 0.6 + F.bands[5] * 0.4;
  F.harmonic = F.bands[2] * 0.5 + F.bands[3] * 0.5;
  F.rms = (F.bands[1] + F.bands[3]) * 0.5;
  F.beatPhase = (F.beatPhase + dt * F.bpm / 60) % 1;

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
#define MAXITEM 32
uniform int uCount;
uniform vec4 uItemA[MAXITEM];   // xy position, z size, w type
uniform vec4 uItemB[MAXITEM];   // x age seconds, y hue, z strength
float h21(vec2 p){ return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453); }
float nz(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<5;i++){ s+=a*nz(p); p*=2.03; a*=0.5; } return s; }
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
vec3 src0(vec2 p){
  float r = length(p), a = atan(p.y,p.x);
  float spokes = pow(abs(sin(a*5.0 + uT*0.25)), 26.0);
  float ring = exp(-pow((r - fract(uPhase)*0.95)*20.0, 2.0));
  float e = spokes*0.105*(0.25+uMid) + ring*(0.085+uBass*0.42);
  return pal(uHue + r*0.35 + uT*0.02)*e;
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
    float sc = 1.0 - 0.011 - uBass*0.012 - uPinch*0.020;
    float an = 0.0035 + uMid*0.009 + uRoll*0.030;
    vec2 q = mat2(cos(an),-sin(an),sin(an),cos(an)) * (p*sc);
    col = texture(uPrev, toUV(q)).rgb*(0.940 + uGain*0.048) + src0(fold(p)) + items(fold(p));
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
                 'uPinch','uSpread','uHueOff','uRoll','uGain','uCount','uItemA','uItemB'];
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
  gl.uniform1f(u.uBass, F.bands[0]*0.6 + F.bands[1]*0.4);
  gl.uniform1f(u.uMid, F.bands[3]);
  gl.uniform1f(u.uAir, F.bands[5]);
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
  enableMic: enableMic, playFile: playFile, micBlocked: micBlocked,
  limitFlash: limitFlash,
  makeRenderer: makeRenderer, sizeCanvas: sizeCanvas, MAXITEM: 32
};
})(window);
