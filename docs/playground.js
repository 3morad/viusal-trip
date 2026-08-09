/* CHROMA playground: audio in, hands on, nothing else on screen. */
(function () {
"use strict";
const E = window.ChromaEngine, F = E.F, clamp = E.clamp;
const $ = function (id) { return document.getElementById(id); };

/* ---------- elements ---------- */
const glCv = $('gl'), handCv = $('hands'), hctx = handCv.getContext('2d');
const cam = $('cam'), gate = $('gate'), hud = $('hud'), fileIn = $('file');
const renderer = E.makeRenderer(glCv, 1.0);

/* ---------- gesture state ---------- */
const G     = { pinch: 0, spread: 0, hueOff: 0, roll: 0, gain: 0 };
const aim   = { pinch: 0, spread: 0, hueOff: 0, roll: 0, gain: 0 };
let sceneId = 0, hold = false, handsOn = false, landmarks = [];

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
const dot = $('dot'), chordEl = $('chord'), bpmEl = $('bpm'),
      srcEl = $('src'), gEl = $('gstate'), hintEl = $('hint');
const SCENES = ['trails', 'fractal', 'field'];
const sceneBox = $('scenes');
SCENES.forEach(function (name, i) {
  const b = document.createElement('button');
  b.className = 'sbtn'; b.type = 'button'; b.textContent = name;
  b.setAttribute('aria-pressed', String(i === 0));
  b.addEventListener('click', function () { setScene(i); });
  sceneBox.appendChild(b);
});
function setScene(i) {
  sceneId = ((i % 3) + 3) % 3;
  [].forEach.call(sceneBox.children, function (b, k) { b.setAttribute('aria-pressed', String(k === sceneId)); });
  renderer && renderer.alloc();
  poke();
}
E.hooks.onSource = function (label) { srcEl.textContent = label; };
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

let landmarker = null, handTimer = 0, poseHeld = 0, poseName = '', lockout = 0;

async function startHands() {
  if (landmarker) { handsOn = !handsOn; gEl.classList.toggle('off', !handsOn); return; }
  gEl.textContent = 'loading'; gEl.classList.remove('off');
  try {
    const vision = await import('./vendor/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks('./vendor/wasm');
    landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: './vendor/hand_landmarker.task', delegate: 'GPU' },
      numHands: 2, runningMode: 'VIDEO'
    });
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' }
    });
    cam.srcObject = stream;
    await cam.play();
    handsOn = true;
    gEl.textContent = 'hands on';
    handLoop();
  } catch (err) {
    landmarker = null;
    gEl.classList.add('off');
    gEl.textContent = 'no camera';
    hintEl.textContent = (window.self !== window.top)
      ? 'camera blocked in this frame'
      : 'camera unavailable';
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

function readHands(hands, t) {
  if (!hands.length) { aim.pinch = 0; aim.spread = 0; aim.gain = 0; gEl.textContent = handsOn ? 'reach in' : 'hands off'; return; }
  gEl.textContent = hands.length === 2 ? 'two hands' : 'one hand';
  const h = hands[0];
  const size = Math.max(1e-4, d3(h[0], h[9]));           // scale invariant: distance is not a control

  const pinchRaw = d3(h[4], h[8]) / size;                // thumb to index
  aim.pinch = clamp(1 - (pinchRaw - 0.18) / 1.05, 0, 1);

  let open = 0;
  for (let i = 0; i < 4; i++) open += d3(h[TIPS[i]], h[0]) > d3(h[PIPS[i]], h[0]) ? 1 : 0;
  const openness = open / 4;
  aim.gain = 1 - openness;                               // closing the hand holds the trails

  aim.hueOff = clamp(1 - h[0].y, 0, 1);                  // height in frame

  const rv = { x: h[17].x - h[5].x, y: h[17].y - h[5].y };
  aim.roll = clamp(Math.atan2(rv.y, rv.x) / Math.PI, -1, 1);

  aim.spread = hands.length === 2
    ? clamp(Math.hypot(hands[0][0].x - hands[1][0].x, hands[0][0].y - hands[1][0].y) * 1.4, 0, 1)
    : 0;

  // poses: held for 120ms, then locked out for 300ms
  const ext = TIPS.map(function (tip, i) { return d3(h[tip], h[0]) > d3(h[PIPS[i]], h[0]); });
  let pose = '';
  if (!ext[0] && !ext[1] && !ext[2] && !ext[3]) pose = 'fist';
  else if (ext[0] && ext[1] && !ext[2] && !ext[3]) pose = 'peace';
  else if (ext[0] && ext[1] && ext[2] && ext[3]) pose = 'palm';

  if (pose && pose === poseName) {
    if (t - poseHeld > 0.12 && t > lockout) { firePose(pose); lockout = t + 0.30; }
  } else { poseName = pose; poseHeld = t; }
}

function firePose(pose) {
  if (pose === 'peace') setScene(sceneId + 1);
  else if (pose === 'palm') { hold = false; renderer && renderer.alloc(); }
  else if (pose === 'fist') hold = true;
  poke();
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

/* ---------- pointer fallback, so it plays without a camera ---------- */
let dragging = false;
addEventListener('pointerdown', function (e) { if (e.target.tagName !== 'BUTTON') { dragging = true; onDrag(e); } });
addEventListener('pointerup', function () { dragging = false; if (!handsOn) { aim.pinch = 0; aim.gain = 0; } });
addEventListener('pointermove', function (e) { if (dragging) onDrag(e); });
function onDrag(e) {
  if (handsOn) return;
  aim.hueOff = clamp(e.clientX / innerWidth, 0, 1);
  aim.pinch  = clamp(1 - e.clientY / innerHeight, 0, 1);
  aim.gain   = aim.pinch * 0.6;
  aim.spread = clamp((e.clientX / innerWidth - 0.5) * 2, 0, 1);
}

/* ---------- keys ---------- */
addEventListener('keydown', function (e) {
  const k = e.key.toLowerCase();
  if (k === '1' || k === '2' || k === '3') setScene(+k - 1);
  else if (k === 'h') startHands();
  else if (k === 'f') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(function () {}); }
  else if (k === ' ') { e.preventDefault(); hold = !hold; }
});

/* ---------- boot ---------- */
function begin() {
  gate.classList.add('hide');
  hud.hidden = false;
  poke();
  setTimeout(function () { gate.remove(); }, 700);
}
$('pMic').addEventListener('click', async function () {
  const ok = await E.enableMic();
  if (!ok) srcEl.textContent = 'synthetic';
  begin();
});
$('pFile').addEventListener('click', function () { fileIn.click(); });
fileIn.addEventListener('change', function (e) { if (e.target.files[0]) { E.playFile(e.target.files[0]); begin(); } });
$('pDemo').addEventListener('click', function () { srcEl.textContent = 'synthetic'; begin(); });
if (E.micBlocked()) {
  $('pMic').disabled = true;
  $('pMic').textContent = 'Mic blocked here';
  $('pFile').classList.add('primary');
}
addEventListener('dragover', function (e) { e.preventDefault(); });
addEventListener('drop', function (e) {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) { E.playFile(f); if (!gate.classList.contains('hide')) begin(); }
});

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
