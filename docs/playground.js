/* CHROMA playground: audio in, hands on, nothing else on screen. */
(function () {
"use strict";
const E = window.ChromaEngine, F = E.F, clamp = E.clamp;
const $ = function (id) { return document.getElementById(id); };

/* ---------- elements ---------- */
const glCv = $('gl'), handCv = $('hands'), hctx = handCv.getContext('2d');
const cam = $('cam'), hud = $('hud'), fileIn = $('file');
const renderer = E.makeRenderer(glCv, 1.0);

/* ---------- gesture state ---------- */
const G     = { pinch: 0, spread: 0, hueOff: 0, roll: 0, gain: 0 };
const aim   = { pinch: 0, spread: 0, hueOff: 0, roll: 0, gain: 0 };
const sceneId = 0;   // one base field; everything else is placed by hand
let hold = false, handsOn = false, landmarks = [];

/* Shapes the hands have placed. The base field runs without them. */
const MAXITEM = E.MAXITEM;
const items = [];
const itemA = new Float32Array(MAXITEM * 4), itemB = new Float32Array(MAXITEM * 4);
const TTL = { 0: Infinity, 1: 3.2, 2: 9.0 };        // orb persists, ring pops, shard fades
function addItem(type, x, y, size, strength) {
  if (items.length >= MAXITEM) items.shift();
  items.push({ type: type, x: x, y: y, size: size, str: strength,
               born: performance.now() / 1000,
               hue: (E.hueOf(F.chord.root) + G.hueOff) % 1 });
  countEl.textContent = items.length ? items.length : '';
}
function packItems(now) {
  let n = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const age = now - items[i].born;
    if (age > TTL[items[i].type]) { items.splice(i, 1); }
  }
  for (let i = 0; i < items.length && n < MAXITEM; i++, n++) {
    const it = items[i], age = now - it.born, o = n * 4;
    itemA[o] = it.x; itemA[o+1] = it.y; itemA[o+2] = it.size; itemA[o+3] = it.type;
    itemB[o] = age;   itemB[o+1] = it.hue; itemB[o+2] = it.str; itemB[o+3] = 0;
  }
  G.count = n; G.itemA = itemA; G.itemB = itemB;
  return n;
}
function clearItems() { items.length = 0; G.count = 0; countEl.textContent = ''; }
/* landmark space to the shader's centred, height normalised space */
function toField(lx, ly) {
  const asp = glCv.clientWidth / Math.max(1, glCv.clientHeight);
  return { x: ((1 - lx) - 0.5) * asp, y: (0.5 - ly) };
}

/* One Euro: low lag when the hand moves, no jitter when it holds still. */
function OneEuro(minCut, beta) {
  let xPrev = null, dxPrev = 0, tPrev = 0;
  const alpha = function (cut, dt) { const r = 2 * Math.PI * cut * dt; return r / (r + 1); };
  return function (x, t) {
    if (xPrev === null) { xPrev = x; tPrev = t; return x; }
    const dt = Math.max(1e-3, t - tPrev); tPrev = t;
    const dx = (x - xPrev) / dt;
    dxPrev = dxPrev + alpha(1.0, dt) * (dx - dxPrev);
    const cut = minCut + beta * Math.abs(dxPrev);
    xPrev = xPrev + alpha(cut, dt) * (x - xPrev);
    return xPrev;
  };
}
const filt = { pinch: OneEuro(1.2, 0.02), spread: OneEuro(1.2, 0.02),
               hueOff: OneEuro(0.8, 0.01), roll: OneEuro(1.0, 0.02), gain: OneEuro(1.2, 0.02) };

/* ---------- hud ---------- */
const dot = $('dot'), chordEl = $('chord'), bpmEl = $('bpm'), hintEl = $('hint'), countEl = $('count');
const tMic = $('tMic'), tHands = $('tHands'), tFile = $('tFile');
const tut = $('tut'), tutTop = $('tutTop');
E.hooks.onSource = function (label, kind) {
  tMic.setAttribute('aria-pressed', String(kind === 'mic'));
  tFile.setAttribute('aria-pressed', String(kind === 'file'));
  tMic.classList.remove('busy');
  if (kind === 'file') tFile.textContent = label.length > 14 ? label.slice(0, 12) + '..' : label;
};
E.hooks.onHint = function (msg) { hintEl.textContent = String(msg).replace(/<[^>]+>/g, ''); };

let idleTimer = 0;
function poke() {
  hud.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(function () { hud.classList.add('idle'); }, 2600);
}
['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach(function (ev) {
  addEventListener(ev, poke, { passive: true });
});

/* ---------- hands ---------- */
const TIPS = [8, 12, 16, 20], PIPS = [6, 10, 14, 18];
const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
               [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const d3 = function (a, b) { const x=a.x-b.x, y=a.y-b.y, z=(a.z||0)-(b.z||0); return Math.hypot(x,y,z); };

let landmarker = null, handTimer = 0;

let armed = false;
async function armInputs() {
  if (armed) return; armed = true;
  const A = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  const V = { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } };
  let stream = null, note = '';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: A, video: V });
  } catch (e) {
    try { stream = await navigator.mediaDevices.getUserMedia({ video: V }); note = 'no mic'; }
    catch (e2) {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: A }); note = 'no camera'; }
      catch (e3) { note = 'blocked'; }
    }
  }
  if (!stream) {
    tutTop.textContent = (window.self !== window.top)
      ? 'this frame blocks the camera. drag to draw instead'
      : 'camera and mic declined. drag to draw instead';
    tutTop.classList.add('done');
    tMic.disabled = true; tHands.disabled = true;
    return;
  }
  const aud = stream.getAudioTracks(), vid = stream.getVideoTracks();
  if (aud.length) { try { await E.useAudioStream(new MediaStream(aud)); } catch (e) {} }
  if (vid.length) { await startHands(new MediaStream(vid)); }
  tutTop.textContent = note ? note + '. reach into the screen' : 'reach into the screen';
  tutTop.classList.add('done');
}

async function startHands(stream) {
  if (landmarker) { handsOn = !handsOn; tHands.setAttribute('aria-pressed', String(handsOn)); if (!handsOn) landmarks = []; return; }
  tHands.classList.add('busy'); tHands.textContent = 'loading';
  try {
    const vision = await import('./vendor/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks('./vendor/wasm');
    landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: './vendor/hand_landmarker.task', delegate: 'GPU' },
      numHands: 2, runningMode: 'VIDEO'
    });
    cam.srcObject = stream || await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    await cam.play();
    handsOn = true;
    tHands.classList.remove('busy');
    tHands.textContent = 'hands';
    tHands.setAttribute('aria-pressed', 'true');
    handLoop();
  } catch (err) {
    landmarker = null;
    tHands.classList.remove('busy');
    tHands.textContent = 'no camera';
    tHands.disabled = true;
  }
}

function handLoop() {
  if (!landmarker) return;
  const step = function () {
    if (handsOn && cam.readyState >= 2) {
      let res = null;
      try { res = landmarker.detectForVideo(cam, performance.now()); } catch (e) {}
      landmarks = (res && res.landmarks) ? res.landmarks : [];
      readHands(landmarks, performance.now() / 1000);
    } else {
      landmarks = [];
    }
    handTimer = setTimeout(step, 33);   // its own 30fps budget, never the render loop's
  };
  step();
}

let wasPinched = false, wasOpen = false, lastPaint = 0, lastPaintPos = null, fistSince = 0;

function readHands(hands, t) {
  if (!hands.length) {
    aim.gain = 0; aim.spread = 0;
    wasPinched = false; wasOpen = false; lastPaintPos = null; fistSince = 0;
    return;
  }
  const h = hands[0];
  const size = Math.max(1e-4, d3(h[0], h[9]));        // scale invariant: distance is not a control
  const ext = TIPS.map(function (tip, i) { return d3(h[tip], h[0]) > d3(h[PIPS[i]], h[0]); });
  const nExt = ext.reduce(function (a, b) { return a + (b ? 1 : 0); }, 0);

  aim.hueOff = clamp(1 - h[0].y, 0, 1);
  const rv = { x: h[17].x - h[5].x, y: h[17].y - h[5].y };
  aim.roll = clamp(Math.atan2(rv.y, rv.x) / Math.PI, -1, 1);
  aim.gain = clamp(1 - nExt / 4, 0, 1);

  // two hands apart add mirror symmetry to whatever is already there
  aim.spread = hands.length === 2
    ? clamp(Math.hypot(hands[0][0].x - hands[1][0].x, hands[0][0].y - hands[1][0].y) * 1.4, 0, 1)
    : aim.spread * 0.94;

  // PINCH: drop an orb where thumb and finger meet
  const pinched = d3(h[4], h[8]) / size < 0.42;
  if (pinched && !wasPinched) {
    const f = toField((h[4].x + h[8].x) / 2, (h[4].y + h[8].y) / 2);
    addItem(0, f.x, f.y, 0.045 + Math.random() * 0.03, 1.0);
  }
  wasPinched = pinched;

  // POINT: one finger out draws a trail of shards
  if (ext[0] && !ext[1] && !ext[2] && !ext[3]) {
    const f = toField(h[8].x, h[8].y);
    const moved = !lastPaintPos || Math.hypot(f.x - lastPaintPos.x, f.y - lastPaintPos.y) > 0.03;
    if (t - lastPaint > 0.055 && moved) {
      addItem(2, f.x, f.y, 0.05, 0.85);
      lastPaint = t; lastPaintPos = f;
    }
  } else { lastPaintPos = null; }

  // OPEN PALM: push a ring out from the middle of your hand
  const open = nExt === 4;
  if (open && !wasOpen) {
    const f = toField(h[9].x, h[9].y);
    addItem(1, f.x, f.y, 0.05, 1.2);
  }
  wasOpen = open;

  // FIST: hold it closed to wipe the scene back to the base
  if (nExt === 0) {
    if (!fistSince) fistSince = t;
    else if (t - fistSince > 0.7) { clearItems(); fistSince = t + 1e6; }
  } else fistSince = 0;
}

function drawHands() {
  const w = handCv.clientWidth, h = handCv.clientHeight, dpr = Math.min(devicePixelRatio || 1, 2);
  if (handCv.width !== (w * dpr | 0)) { handCv.width = w * dpr; handCv.height = h * dpr; }
  hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  hctx.clearRect(0, 0, w, h);
  if (!handsOn || !landmarks.length) return;
  const hue = (E.hueOf(F.chord.root) + G.hueOff) % 1;
  hctx.strokeStyle = 'hsla(' + (hue * 360) + ',80%,66%,.55)';
  hctx.fillStyle = 'hsla(' + (hue * 360) + ',85%,74%,.9)';
  hctx.shadowColor = 'hsla(' + (hue * 360) + ',90%,60%,.9)';
  hctx.shadowBlur = 14; hctx.lineWidth = 1.6; hctx.lineCap = 'round';
  landmarks.forEach(function (pts) {
    const X = function (p) { return (1 - p.x) * w; }, Y = function (p) { return p.y * h; }; // mirrored
    hctx.beginPath();
    BONES.forEach(function (b) { hctx.moveTo(X(pts[b[0]]), Y(pts[b[0]])); hctx.lineTo(X(pts[b[1]]), Y(pts[b[1]])); });
    hctx.stroke();
    pts.forEach(function (p, i) {
      hctx.beginPath();
      hctx.arc(X(p), Y(p), i === 4 || i === 8 ? 4.5 : 2.4, 0, 6.2832);
      hctx.fill();
    });
  });
  hctx.shadowBlur = 0;
}

/* ---------- pointer places the same shapes, for when there is no camera ---------- */
let dragging = false, dragged = false, lastPtr = null, lastPtrT = 0;
function ptrField(e) {
  const asp = glCv.clientWidth / Math.max(1, glCv.clientHeight);
  return { x: (e.clientX / innerWidth - 0.5) * asp, y: 0.5 - e.clientY / innerHeight };
}
addEventListener('pointerdown', function (e) {
  if (e.target.closest('button')) return;
  dragging = true; dragged = false; lastPtr = ptrField(e);
});
addEventListener('pointermove', function (e) {
  if (!dragging || handsOn) return;
  const f = ptrField(e), t = performance.now() / 1000;
  aim.hueOff = clamp(e.clientX / innerWidth, 0, 1);
  if (t - lastPtrT > 0.055 && (!lastPtr || Math.hypot(f.x - lastPtr.x, f.y - lastPtr.y) > 0.03)) {
    addItem(2, f.x, f.y, 0.05, 0.85);
    lastPtr = f; lastPtrT = t; dragged = true;
  }
});
addEventListener('pointerup', function (e) {
  if (dragging && !dragged && !handsOn && !e.target.closest('button')) {
    const f = ptrField(e);
    addItem(0, f.x, f.y, 0.05, 1.0);
  }
  dragging = false;
});

/* ---------- keys ---------- */
addEventListener('keydown', function (e) {
  const k = e.key.toLowerCase();
  if (k === 'h') armInputs();
  else if (k === 'f') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(function () {}); }
  else if (k === ' ') { e.preventDefault(); hold = !hold; }
  else if (k === 'm') tMic.click();
  else if (k === 'c') clearItems();
  else if (k === 'z') { items.pop(); countEl.textContent = items.length || ''; }
});

/* ---------- boot: it is already running. Inputs are opt in. ---------- */
tMic.addEventListener('click', function () { armInputs(); });
tFile.addEventListener('click', function () { fileIn.click(); });
fileIn.addEventListener('change', function (e) { if (e.target.files[0]) E.playFile(e.target.files[0]); });
tHands.addEventListener('click', function () { armInputs(); });
if (E.micBlocked()) { tMic.disabled = true; tMic.textContent = 'no mic'; }

addEventListener('dragover', function (e) { e.preventDefault(); });
addEventListener('drop', function (e) {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) E.playFile(f);
});

['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) {
  addEventListener(ev, armInputs, { once: false, passive: true });
});
setTimeout(function () { tut.classList.add('gone'); }, 60000);
setTimeout(function () { tut.remove(); }, 62000);

/* ---------- loop ---------- */
let t0 = performance.now(), last = t0;
function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const t = Math.max(0, (now - t0) / 1000);
  if (!E.analyse(dt)) E.synth(t);

  const ts = now / 1000;
  G.pinch  = filt.pinch(aim.pinch, ts);
  G.spread = filt.spread(aim.spread, ts);
  G.hueOff = filt.hueOff(aim.hueOff, ts);
  G.roll   = filt.roll(aim.roll, ts);
  G.gain   = hold ? 1 : filt.gain(aim.gain, ts);

  packItems(now / 1000);

  const drive = F.bands[0] * 0.55 + F.bands[1] * 0.30 + F.rms * 0.15;
  const bright = E.limitFlash(clamp(drive, 0, 1), now);
  if (renderer) renderer.draw(t, bright, sceneId, G);
  drawHands();

  const hue = E.hueOf(F.chord.root) * 360;
  chordEl.textContent = E.NOTE[F.chord.root] + (F.chord.quality === 'min' ? 'm' : '');
  dot.style.background = 'hsl(' + hue + ',70%,58%)';
  dot.style.color = 'hsl(' + hue + ',70%,58%)';
  bpmEl.textContent = Math.round(F.bpm);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
})();
