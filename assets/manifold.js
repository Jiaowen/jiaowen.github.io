/* =========================================================================
   Geodesic manifold hero — jiaowen.github.io
   A live Riemannian surface y = f(x,z): a drifting mixture of Gaussian
   bumps. The glowing curves are geodesics of the induced metric,
   integrated in real time from the geodesic equation. The cursor adds a
   moving potential well, so visitors literally bend the geometry the
   curves travel through. Hovering a publication morphs the landscape.
   ========================================================================= */
(function () {
'use strict';

var canvas = document.getElementById('manifold');
if (!canvas || typeof THREE === 'undefined') return;

var hero = document.getElementById('hero');
var hint = document.getElementById('heroHint');
var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var SMALL = window.innerWidth < 720;

/* ---------------- config ---------------- */
var R = 3.15;                             /* half-size of the (x,z) domain  */
var SURF_N = SMALL ? 56 : 88;             /* surface tessellation           */
var GRID_N = 20;                          /* coordinate-grid lines per axis */
var GRID_S = 64;                          /* samples along each grid line   */
var WALKERS = SMALL ? 5 : 7;              /* number of geodesics            */
var TRAIL = SMALL ? 100 : 150;            /* trail points per geodesic      */
var SPEED = 0.8, DT = 0.011, SUBSTEPS = 3;

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }

/* ---------------- renderer / scene ---------------- */
var renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
} catch (e) { canvas.style.display = 'none'; return; }
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputEncoding = THREE.sRGBEncoding;

var scene = new THREE.Scene();
var camera = new THREE.PerspectiveCamera(40, 2, 0.1, 60);

scene.add(new THREE.HemisphereLight(0xffffff, 0xdde7f2, 0.7));
var key = new THREE.DirectionalLight(0xffffff, 0.95); key.position.set(5, 9, 4);
var fill = new THREE.DirectionalLight(0xcfe0ff, 0.3); fill.position.set(-6, 4, -5);
scene.add(key, fill);

/* ---------------- the landscape f(x,z) ---------------- */
/* four drifting bumps; amplitudes and widths morph between modes */
var BUMPS = [
  { x0: -1.35, z0: -0.85, wx: 0.11, wz: 0.16, px: 0.0, pz: 2.1 },
  { x0:  1.5,  z0:  0.65, wx: 0.09, wz: 0.13, px: 1.7, pz: 4.2 },
  { x0: -0.25, z0:  1.55, wx: 0.13, wz: 0.10, px: 3.1, pz: 0.9 },
  { x0:  0.95, z0: -1.6,  wx: 0.10, wz: 0.14, px: 5.0, pz: 2.6 }
];
var MODES = {
  home: {
    amps: [1.1, 0.9, -0.7, 0.65], sigs: [1.05, 0.92, 0.85, 0.8], curv: 0,
    palette: ['#2e90fa', '#175cd3', '#7a5af8', '#16b1c8', '#6172f3', '#2e90fa', '#7a5af8']
  },
  lambda: {   /* λ-exponential family: sharper, peakier landscape */
    amps: [1.35, 1.1, -0.8, 0.8], sigs: [0.62, 0.58, 0.6, 0.52], curv: 0,
    palette: ['#0e9384', '#16b1c8', '#2ed3b7', '#099250', '#16b1c8', '#0e9384', '#2ed3b7']
  },
  ot: {       /* optimal transport: two hills, two wells — mass to move */
    amps: [1.3, -1.05, 0.95, -0.85], sigs: [0.95, 0.9, 0.85, 0.82], curv: 0,
    palette: ['#2e90fa', '#6172f3', '#7a5af8', '#9b8afb', '#175cd3', '#7a5af8', '#6172f3']
  },
  curvature: { /* logarithmic divergences: paint the curvature itself */
    amps: [1.35, 1.05, -0.95, 0.85], sigs: [0.85, 0.78, 0.8, 0.72], curv: 1,
    palette: ['#f79009', '#f04438', '#ef6820', '#f63d68', '#f79009', '#ef6820', '#f63d68']
  }
};
var cur = { amps: MODES.home.amps.slice(), sigs: MODES.home.sigs.slice(), curv: 0,
            palette: MODES.home.palette.map(function (c) { return new THREE.Color(c); }) };
var target = MODES.home;

var mouse = { x: 0, z: 0, tx: 0, tz: 0, amp: 0, tamp: 0 };
var MSIG = 0.55;

var bumpPos = BUMPS.map(function (b) { return { x: b.x0, z: b.z0 }; });
function updateBumps(t) {
  for (var i = 0; i < BUMPS.length; i++) {
    var b = BUMPS[i];
    bumpPos[i].x = b.x0 + 0.4 * Math.sin(b.wx * t + b.px);
    bumpPos[i].z = b.z0 + 0.4 * Math.sin(b.wz * t + b.pz);
  }
}

/* value + first/second derivatives, analytically (Gaussian mixture) */
var D = { f: 0, fx: 0, fz: 0, fxx: 0, fzz: 0, fxz: 0 };
function evalF(x, z, withSecond) {
  var f = 0, fx = 0, fz = 0, fxx = 0, fzz = 0, fxz = 0;
  for (var i = 0; i < BUMPS.length; i++) {
    var A = cur.amps[i], s2 = cur.sigs[i] * cur.sigs[i];
    var dx = x - bumpPos[i].x, dz = z - bumpPos[i].z;
    var e = A * Math.exp(-(dx * dx + dz * dz) / (2 * s2));
    f += e;
    fx += -dx / s2 * e;
    fz += -dz / s2 * e;
    if (withSecond) {
      fxx += (dx * dx / (s2 * s2) - 1 / s2) * e;
      fzz += (dz * dz / (s2 * s2) - 1 / s2) * e;
      fxz += (dx * dz / (s2 * s2)) * e;
    }
  }
  if (mouse.amp > 0.001) {
    var s2m = MSIG * MSIG;
    var mdx = x - mouse.x, mdz = z - mouse.z;
    var em = -mouse.amp * Math.exp(-(mdx * mdx + mdz * mdz) / (2 * s2m));
    f += em;
    fx += -mdx / s2m * em;
    fz += -mdz / s2m * em;
    if (withSecond) {
      fxx += (mdx * mdx / (s2m * s2m) - 1 / s2m) * em;
      fzz += (mdz * mdz / (s2m * s2m) - 1 / s2m) * em;
      fxz += (mdx * mdz / (s2m * s2m)) * em;
    }
  }
  D.f = f * 1.12; D.fx = fx * 1.12; D.fz = fz * 1.12;
  D.fxx = fxx * 1.12; D.fzz = fzz * 1.12; D.fxz = fxz * 1.12;
  return D;
}

/* ---------------- surface + coordinate grid ---------------- */
var group = new THREE.Group();
scene.add(group);

var surfGeo = new THREE.PlaneGeometry(2 * R, 2 * R, SURF_N, SURF_N);
surfGeo.rotateX(-Math.PI / 2);
var vCount = surfGeo.attributes.position.count;
surfGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vCount * 3).fill(1), 3));
var surfMat = new THREE.MeshStandardMaterial({
  color: 0xf7f9fd, roughness: 0.95, metalness: 0,
  transparent: true, opacity: 0.97, side: THREE.DoubleSide, vertexColors: true
});
var surface = new THREE.Mesh(surfGeo, surfMat);
group.add(surface);

/* coordinate grid as clean line segments (no triangle diagonals) */
var gridGeo = (function () {
  var pts = [];
  var i, j;
  for (i = 0; i <= GRID_N; i++) {
    for (j = 0; j < GRID_S; j++) { pts.push(0, 0, 0, 0, 0, 0); }
  }
  for (i = 0; i <= GRID_N; i++) {
    for (j = 0; j < GRID_S; j++) { pts.push(0, 0, 0, 0, 0, 0); }
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
})();
var gridLines = new THREE.LineSegments(gridGeo,
  new THREE.LineBasicMaterial({ color: 0xb3c6de, transparent: true, opacity: 0.65 }));
group.add(gridLines);

var CURV_NEG = new THREE.Color(0x6172f3), CURV_POS = new THREE.Color(0xf04438);
var WHITE = new THREE.Color(0xffffff);
var tmpC = new THREE.Color();
/* pastel gradient: valleys blush blue, peaks near-white, a lavender drift
   across the far side; the cursor soaks a deeper blue into the surface */
var TINT_LO = new THREE.Color(0xc3d9f5);   /* valleys        */
var TINT_HI = new THREE.Color(0xffffff);   /* peaks          */
var TINT_LAV = new THREE.Color(0xddd1f6);  /* lavender drift */
var HOVER_INK = new THREE.Color(0x5f92e0); /* cursor ink     */

function updateSurface() {
  var pos = surfGeo.attributes.position;
  var col = surfGeo.attributes.color;
  var needSecond = cur.curv > 0.01;
  var inkOn = mouse.amp > 0.01;
  var inkS2 = 2 * 0.95 * 0.95;
  for (var i = 0; i < pos.count; i++) {
    var x = pos.getX(i), z = pos.getZ(i);
    var d = evalF(x, z, needSecond);
    pos.setY(i, d.f);

    /* height-graded pastel base */
    var h = clamp((d.f + 1.3) / 2.6, 0, 1);
    tmpC.copy(TINT_LO).lerp(TINT_HI, h);
    tmpC.lerp(TINT_LAV, clamp((z / R + 1) * 0.5, 0, 1) * 0.55);

    /* the cursor darkens the surface around it, like ink soaking in */
    if (inkOn) {
      var mdx = x - mouse.x, mdz = z - mouse.z;
      var w = Math.exp(-(mdx * mdx + mdz * mdz) / inkS2);
      tmpC.lerp(HOVER_INK, 0.42 * w * mouse.amp);
    }

    /* curvature mode blends its own coloring on top */
    if (needSecond) {
      var denom = 1 + d.fx * d.fx + d.fz * d.fz;
      var K = (d.fxx * d.fzz - d.fxz * d.fxz) / (denom * denom);
      var t = clamp(K * 2.2, -1, 1);
      tmpC.lerp(t < 0 ? CURV_NEG : CURV_POS, Math.abs(t) * cur.curv * 0.85);
    }
    col.setXYZ(i, tmpC.r, tmpC.g, tmpC.b);
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  surfGeo.computeVertexNormals();

  /* grid lines follow the surface */
  var gp = gridGeo.attributes.position;
  var k = 0, li, s;
  for (li = 0; li <= GRID_N; li++) {
    var gx = -R + (2 * R) * li / GRID_N;
    for (s = 0; s < GRID_S; s++) {
      var z0 = -R + (2 * R) * s / GRID_S;
      var z1 = -R + (2 * R) * (s + 1) / GRID_S;
      gp.setXYZ(k++, gx, evalF(gx, z0, false).f + 0.012, z0);
      gp.setXYZ(k++, gx, evalF(gx, z1, false).f + 0.012, z1);
    }
  }
  for (li = 0; li <= GRID_N; li++) {
    var gz = -R + (2 * R) * li / GRID_N;
    for (s = 0; s < GRID_S; s++) {
      var x0 = -R + (2 * R) * s / GRID_S;
      var x1 = -R + (2 * R) * (s + 1) / GRID_S;
      gp.setXYZ(k++, x0, evalF(x0, gz, false).f + 0.012, gz);
      gp.setXYZ(k++, x1, evalF(x1, gz, false).f + 0.012, gz);
    }
  }
  gp.needsUpdate = true;
}

/* ---------------- geodesics ---------------- */
function dotTexture() {
  var cv = document.createElement('canvas'); cv.width = cv.height = 64;
  var x = cv.getContext('2d');
  var g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  var tex = new THREE.CanvasTexture(cv); tex.minFilter = THREE.LinearFilter;
  return tex;
}
var DOT = dotTexture();

var walkers = [];
function respawn(w) {
  var edge = Math.floor(Math.random() * 4);
  var u = (Math.random() * 2 - 1) * (R * 0.85);
  if (edge === 0) { w.x = -R + 0.05; w.z = u; }
  else if (edge === 1) { w.x = R - 0.05; w.z = u; }
  else if (edge === 2) { w.x = u; w.z = -R + 0.05; }
  else { w.x = u; w.z = R - 0.05; }
  /* aim inward with some spread */
  var ang = Math.atan2(-w.z, -w.x) + (Math.random() - 0.5) * 1.1;
  w.vx = Math.cos(ang); w.vz = Math.sin(ang);
  var d = evalF(w.x, w.z, false);
  for (var i = 0; i < TRAIL; i++) w.trail[i * 3] = w.x, w.trail[i * 3 + 1] = d.f + 0.03, w.trail[i * 3 + 2] = w.z;
  w.geo.attributes.position.needsUpdate = true;
}
for (var wi = 0; wi < WALKERS; wi++) {
  var trail = new Float32Array(TRAIL * 3);
  var cols = new Float32Array(TRAIL * 3);
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(trail, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  var line = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
  group.add(line);
  var head = new THREE.Sprite(new THREE.SpriteMaterial({ map: DOT, color: 0x2e90fa, transparent: true, opacity: 0.9, depthWrite: false }));
  head.scale.set(0.16, 0.16, 1);
  group.add(head);
  var w = { x: 0, z: 0, vx: 1, vz: 0, trail: trail, cols: cols, geo: geo, line: line, head: head, i: wi };
  respawn(w);
  /* scatter initial progress so they don't respawn in sync */
  w.x = (Math.random() * 2 - 1) * R * 0.8;
  w.z = (Math.random() * 2 - 1) * R * 0.8;
  walkers.push(w);
}

function stepWalker(w) {
  for (var s = 0; s < SUBSTEPS; s++) {
    var d = evalF(w.x, w.z, true);
    var denom = 1 + d.fx * d.fx + d.fz * d.fz;
    var H = d.fxx * w.vx * w.vx + 2 * d.fxz * w.vx * w.vz + d.fzz * w.vz * w.vz;
    /* geodesic equation for a graph surface y = f(x,z) */
    var ax = -H * d.fx / denom;
    var az = -H * d.fz / denom;
    w.vx += ax * DT * SPEED; w.vz += az * DT * SPEED;
    var n = Math.hypot(w.vx, w.vz) || 1;
    w.vx /= n; w.vz /= n;
    w.x += w.vx * DT * SPEED; w.z += w.vz * DT * SPEED;
    if (Math.abs(w.x) > R || Math.abs(w.z) > R) { respawn(w); return; }
    /* shift trail by one and append the new head */
    var tr = w.trail;
    tr.copyWithin(0, 3);
    var y = evalF(w.x, w.z, false).f + 0.03;
    tr[(TRAIL - 1) * 3] = w.x; tr[(TRAIL - 1) * 3 + 1] = y; tr[(TRAIL - 1) * 3 + 2] = w.z;
  }
  w.geo.attributes.position.needsUpdate = true;
  w.head.position.set(w.trail[(TRAIL - 1) * 3], w.trail[(TRAIL - 1) * 3 + 1] + 0.02, w.trail[(TRAIL - 1) * 3 + 2]);
}

function paintTrails() {
  for (var k = 0; k < walkers.length; k++) {
    var w = walkers[k];
    var base = cur.palette[k % cur.palette.length];
    for (var i = 0; i < TRAIL; i++) {
      var t = i / (TRAIL - 1);                 /* 0 = tail, 1 = head */
      tmpC.copy(WHITE).lerp(base, 0.22 + 0.78 * Math.pow(t, 1.6));
      w.cols[i * 3] = tmpC.r; w.cols[i * 3 + 1] = tmpC.g; w.cols[i * 3 + 2] = tmpC.b;
    }
    w.geo.attributes.color.needsUpdate = true;
    w.head.material.color.copy(base);
  }
}

/* ---------------- modes / interaction ---------------- */
function setMode(name) { target = MODES[name] || MODES.home; }
document.querySelectorAll('[data-mode]').forEach(function (el) {
  el.addEventListener('mouseenter', function () { setMode(el.getAttribute('data-mode')); });
  el.addEventListener('mouseleave', function () { setMode('home'); });
});

var ray = new THREE.Raycaster();
var ndc = new THREE.Vector2();
var ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
var hit = new THREE.Vector3();
var parallax = { x: 0, y: 0 };
var interacted = false;

function onPointer(ev) {
  var r = canvas.getBoundingClientRect();
  var nx = ((ev.clientX - r.left) / r.width) * 2 - 1;
  var ny = -((ev.clientY - r.top) / r.height) * 2 + 1;
  ndc.set(nx, ny);
  parallax.x = nx; parallax.y = ny;
  ray.setFromCamera(ndc, camera);
  if (ray.ray.intersectPlane(ground, hit)) {
    /* undo the group offset so the well lands under the cursor */
    mouse.tx = clamp(hit.x - group.position.x, -R, R);
    mouse.tz = clamp(hit.z, -R, R);
    mouse.tamp = 0.95;
    if (!interacted && hint) { interacted = true; setTimeout(function () { hint.classList.remove('shown'); }, 2600); }
  }
}
if (!REDUCED) {
  hero.addEventListener('pointermove', onPointer);
  hero.addEventListener('pointerdown', onPointer);
  hero.addEventListener('pointerleave', function () { mouse.tamp = 0; parallax.x = 0; parallax.y = 0; });
}

/* ---------------- layout / loop ---------------- */
function layout() {
  var w = hero.clientWidth, h = hero.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  /* keep the surface right of the intro text on wide screens */
  group.position.x = w > 900 ? 1.6 : 0.2;
}
window.addEventListener('resize', layout);
layout();

var t0 = performance.now();
function frame(now) {
  var t = (now - t0) / 1000;

  /* ease all mode parameters */
  for (var i = 0; i < 4; i++) {
    cur.amps[i] = lerp(cur.amps[i], target.amps[i], 0.05);
    cur.sigs[i] = lerp(cur.sigs[i], target.sigs[i], 0.05);
  }
  cur.curv = lerp(cur.curv, target.curv, 0.05);
  for (var p = 0; p < cur.palette.length; p++) {
    tmpC.set(target.palette[p]);
    cur.palette[p].lerp(tmpC, 0.05);
  }
  mouse.x = lerp(mouse.x, mouse.tx, 0.18);
  mouse.z = lerp(mouse.z, mouse.tz, 0.18);
  mouse.amp = lerp(mouse.amp, mouse.tamp, 0.07);

  updateBumps(t);
  updateSurface();
  for (var k = 0; k < walkers.length; k++) stepWalker(walkers[k]);
  paintTrails();

  /* slow breathing orbit + cursor parallax */
  group.rotation.y = 0.10 * Math.sin(t * 0.09);
  camera.position.set(
    0.6 + parallax.x * 0.55,
    4.6 + parallax.y * 0.45 + 0.12 * Math.sin(t * 0.23),
    8.0
  );
  camera.lookAt(-0.4, -0.5, 0);   /* aim low so the manifold rides high in frame */

  renderer.render(scene, camera);
  if (!REDUCED) requestAnimationFrame(frame);
}

if (hint && !REDUCED) setTimeout(function () { if (!interacted) hint.classList.add('shown'); }, 2500);

/* reduced motion: render a single, calm frame */
updateBumps(0);
updateSurface();
paintTrails();
requestAnimationFrame(frame);

})();
