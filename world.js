// world.js — Overlord's World view: the agent roster as a 3D hex-tile island.
//
// Renderer-only and additive. index.html builds a plain snapshot of state it
// already holds (agents, projects, worktrees, teams, PRs, Actions runs, peers)
// and calls World.sync(snapshot) after each render() while the view is on.
// Every interaction here calls back into an existing index.html function via
// the hooks passed to World.init — the world adds no commands of its own.
//
//   World.init(stageEl, hooks)  — build the scene inside #world-stage
//   World.sync(snapshot)        — diff by id: spawn, update, despawn (with effects)
//   World.dispose()             — tear everything down (view switched off)
//
// Requires window.THREE (three-bundle.js) to be loaded first.
(() => {
'use strict';
const W = {};

/* ────────────────────────── Vocabulary ────────────────────────── */
const STATUS = {
  active:     { label: 'Working',         css: '--w-working',  hex: 0x89b4fa, sym: '⚒', order: 1 },
  settling:   { label: 'Finishing',       css: '--w-working',  hex: 0x89b4fa, sym: '⚒', order: 1 },
  permission: { label: 'Needs approval',  css: '--w-perm',     hex: 0xf9e2af, sym: '⚡', order: 0 },
  question:   { label: 'Needs an answer', css: '--w-question', hex: 0xcba6f7, sym: '?',      order: 0 },
  resuming:   { label: 'Resuming',        css: '--w-resuming', hex: 0xcba6f7, sym: '↻', order: 2 },
  waiting:    { label: 'Done',            css: '--w-done',     hex: 0xa6e3a1, sym: '✓', order: 3 },
  idle:       { label: 'Idle',            css: '--w-idle',     hex: 0x7d8ca3, sym: '○', order: 4 },
  crashed:    { label: 'Crashed',         css: '--w-crashed',  hex: 0xf38ba8, sym: '✕', order: 5 },
};
const PR_STATE = { ready: { label: 'Ready to merge', hex: '#a6e3a1', color: 0xa6e3a1 }, open: { label: 'Open', hex: '#94e2d5', color: 0x94e2d5 }, behind: { label: 'Behind base', hex: '#f9e2af', color: 0xf9e2af }, changes: { label: 'Changes requested', hex: '#f38ba8', color: 0xf38ba8 }, conflict: { label: 'Conflicts', hex: '#f38ba8', color: 0xf38ba8 }, blocked: { label: 'Checks failing', hex: '#fab387', color: 0xfab387 } };
const RUN_STATE = { running: { label: 'Running', hex: '#f9e2af', color: 0xf9e2af }, success: { label: 'Passed', hex: '#a6e3a1', color: 0xa6e3a1 }, failure: { label: 'Failed', hex: '#f38ba8', color: 0xf38ba8 }, cancelled: { label: 'Cancelled', hex: '#7d8ca3', color: 0x7d8ca3 }, none: { label: 'No runs yet', hex: '#7d8ca3', color: 0x585b70 } };
const SITE_COLORS = [0xd6a545, 0x3fbfa6, 0x4f8fe0, 0xd05a92, 0xfab387, 0x94e2d5, 0xcba6f7, 0xa6e3a1];
const hexStr = c => '#' + c.toString(16).padStart(6, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PLAT = 2.4;           // plateau height every site sits on
const TILE = 2.6;           // hex tile radius
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ────────────────────────── Module state ────────────────────────── */
let THREE, stage, canvas, labelsEl, selEl, miniEl, toastEl, hooks = {};
let renderer, scene, camera, sun, raf = 0, ro = null, lastT = 0, alive = false;
const cam = { target: null, zoom: 2.0, yaw: 0, base: null, hover: false };
const sites = new Map(), units = new Map(), ships = new Map(), machines = new Map(), tents = new Map();
const order = { features: [], shops: [] };
const anchors = new Set(), tweens = new Set(), flags = [], cranes = [], beacons = [];
let selected = {}, hovered = null, snap = null, terrain = null, mats = null, card = null, cardFor = null, siteColorIdx = 0, lastSel, selSig = '';
const pickables = new Set(); // every hit mesh in the scene, kept in step with create/destroy
const colorFor = new Map(); // site key -> color (stable across syncs)

/* ────────────────────────── Small helpers ────────────────────────── */
const easeOutCubic = t => 1 - Math.pow(1 - t, 3), easeOutBack = t => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2), easeInCubic = t => t * t * t;
function tween(dur, fn, done, ease = easeOutCubic, delay = 0) {
  const tw = { t0: performance.now() + delay, dur: reduceMotion() ? 0 : dur, fn, done, ease };
  tweens.add(tw); return tw;
}
function runTweens(now) {
  for (const tw of tweens) {
    if (now < tw.t0) continue;
    const k = tw.dur <= 0 ? 1 : Math.min(1, (now - tw.t0) / tw.dur);
    tw.fn(tw.ease(k), k);
    if (k >= 1) { tweens.delete(tw); tw.done && tw.done(); }
  }
}
function mat(color, extra) { return new THREE.MeshStandardMaterial(Object.assign({ color, roughness: .88, metalness: .05, flatShading: true }, extra)); }
function box(w, h, d, m) { const me = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); me.castShadow = true; me.receiveShadow = true; return me; }
function hexPrism(R, h, m) { const me = new THREE.Mesh(new THREE.CylinderGeometry(R, R, h, 6), m); me.rotation.y = Math.PI / 6; me.castShadow = true; me.receiveShadow = true; return me; }
function hexEdge(R, y, color, opacity = .8) { const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(R, R, .02, 6)), new THREE.LineBasicMaterial({ color, transparent: true, opacity })); e.rotation.y = Math.PI / 6; e.position.y = y; return e; }
function disposeObj(o) { o.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) { const ms = Array.isArray(c.material) ? c.material : [c.material]; for (const m of ms) { if (m.map) m.map.dispose(); m.dispose(); } } }); if (o.parent) o.parent.remove(o); }
function label(cls, html, obj, color, dy = 0) { const el = document.createElement('div'); el.className = 'w-lab ' + cls; if (color) el.style.setProperty('--c', color); el.innerHTML = html; labelsEl.appendChild(el); const a = { el, obj, dy, html }; anchors.add(a); return a; }
function setLabel(a, html) { if (a.html !== html) { a.html = html; a.el.innerHTML = html; } }
function dropLabel(a) { if (!a) return; anchors.delete(a); a.el.remove(); }
let toastT = 0; function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 1600); }
function seeded(s) { return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
// Value noise for the terrain: cheap, deterministic, good enough for hills.
function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function noise(x, y) { const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy); return hash(ix, iy) * (1 - u) * (1 - v) + hash(ix + 1, iy) * u * (1 - v) + hash(ix, iy + 1) * (1 - u) * v + hash(ix + 1, iy + 1) * u * v; }
function fbm(x, y) { return (noise(x, y) * .55 + noise(x * 2.1, y * 2.1) * .3 + noise(x * 4.3, y * 4.3) * .15); }

/* ────────────────────────── Particles ────────────────────────── */
let puffs = null; // pooled sprites for spawn / despawn bursts
function initPuffs() {
  const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d');
  g.beginPath(); for (let k = 0; k < 6; k++) { const a = -Math.PI / 2 + k * Math.PI / 3; k ? g.lineTo(16 + 14 * Math.cos(a), 16 + 14 * Math.sin(a)) : g.moveTo(16 + 14 * Math.cos(a), 16 + 14 * Math.sin(a)); } g.closePath(); g.fillStyle = '#fff'; g.fill();
  const tex = new THREE.CanvasTexture(c);
  puffs = { pool: [], tex };
  for (let i = 0; i < 160; i++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false })); s.visible = false; scene.add(s); puffs.pool.push({ s, life: 0, ttl: 1, v: new THREE.Vector3() }); }
}
function burst(pos, color, n = 18, spread = 1.2, up = 3) {
  if (!puffs || !alive || reduceMotion()) return;
  let k = 0;
  for (const p of puffs.pool) { if (p.life > 0) continue; p.life = p.ttl = .6 + Math.random() * .5; p.s.visible = true; p.s.material.color.set(color); p.s.material.opacity = .9; p.s.scale.setScalar(.25 + Math.random() * .35); p.s.position.copy(pos).add(new THREE.Vector3((Math.random() - .5) * spread, Math.random() * .5, (Math.random() - .5) * spread)); p.v.set((Math.random() - .5) * 3, up * (.5 + Math.random()), (Math.random() - .5) * 3); if (++k >= n) break; }
}
function runPuffs(dt) { for (const p of puffs.pool) { if (p.life <= 0) continue; p.life -= dt; if (p.life <= 0) { p.s.visible = false; continue; } p.v.y -= 6 * dt; p.s.position.addScaledVector(p.v, dt); p.s.material.opacity = .9 * (p.life / p.ttl); } }

/* ────────────────────────── Scene setup ────────────────────────── */
W.init = function (stageEl, h) {
  THREE = window.THREE; if (!THREE) throw new Error('three-bundle.js must load before world.js');
  hooks = h || {}; stage = stageEl; alive = true;
  stage.innerHTML = '<canvas class="gl"></canvas><div id="world-labels"></div><canvas id="world-mini" width="400" height="232"></canvas><div id="world-sel" hidden></div><div id="world-toast"></div><div id="world-hint">drag / <kbd>WASD</kbd> pan &middot; wheel zoom &middot; <kbd>Q</kbd><kbd>E</kbd> rotate &middot; click select &middot; double-click terminal &middot; right-click menu</div>';
  canvas = stage.querySelector('canvas.gl'); labelsEl = stage.querySelector('#world-labels'); selEl = stage.querySelector('#world-sel'); miniEl = stage.querySelector('#world-mini'); toastEl = stage.querySelector('#world-toast');
  // The minimap can live in the roster column (below the usage bars) instead of over the stage.
  if (hooks.miniSlot) { hooks.miniSlot.innerHTML = '<div class="w-map-head"><span>Map</span><span id="world-mini-pos">0, 0</span></div>'; hooks.miniSlot.appendChild(miniEl); }
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene = new THREE.Scene(); scene.background = new THREE.Color(0x121a24); scene.fog = new THREE.Fog(0x121a24, 110, 220);
  camera = new THREE.PerspectiveCamera(40, 1, 0.5, 500);
  cam.target = new THREE.Vector3(0, PLAT, 0); cam.base = new THREE.Vector3(0, 27, 19);
  scene.add(new THREE.HemisphereLight(0xbcd6f0, 0x2a3b2c, 0.7));
  sun = new THREE.DirectionalLight(0xfff0d2, 1.6); sun.position.set(40, 70, 30); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -110, right: 110, top: 110, bottom: -110, near: 1, far: 220 }); sun.shadow.bias = -0.0006; scene.add(sun);
  mats = { stone: mat(0x9a9285), stoneDark: mat(0x7a746a), wood: mat(0x8a6a48), scaffold: mat(0xc39a55), dark: mat(0x2b2f36), skin: mat(0xf0d2b0), iron: mat(0xb9c2cc, { metalness: .5, roughness: .4 }), gold: mat(0xe1b453, { metalness: .6, roughness: .35 }), plot: mat(0x3c4a52), yard: mat(0x46565f), wall: mat(0x8c8579), canvas: mat(0xe0d6bf), water: new THREE.MeshStandardMaterial({ color: 0x2c86a8, roughness: .3, metalness: .05 }), window: new THREE.MeshStandardMaterial({ color: 0x2b2f36, emissive: 0xffb060, emissiveIntensity: 0, roughness: .6 }), torch: new THREE.MeshStandardMaterial({ color: 0xffb060, emissive: 0xff9a3c, emissiveIntensity: 0, transparent: true, opacity: 0 }) };
  initPuffs(); buildTerrain(); initLife();
  card = document.createElement('div'); card.className = 'w-lab w-card'; card.hidden = true; labelsEl.appendChild(card);
  bindInput();
  ro = new ResizeObserver(resize); ro.observe(stage); resize();
  lastT = performance.now(); raf = requestAnimationFrame(tick);
};
W.dispose = function () {
  alive = false; cancelAnimationFrame(raf); if (ro) ro.disconnect(); ro = null;
  for (const s of tweens) tweens.delete(s);
  sites.clear(); units.clear(); ships.clear(); machines.clear(); tents.clear(); anchors.clear(); pickables.clear(); lastSel = undefined; flags.length = 0; life.clouds.length = 0; life.birds.length = 0; life.flies.length = 0; life.torches.length = 0; life.chimneys.length = 0; life.fish = null; cranes.length = 0; beacons.length = 0; order.features.length = 0; order.shops.length = 0;
  if (scene) scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) { if (m.map) m.map.dispose(); m.dispose(); } } });
  if (renderer) renderer.dispose(); renderer = scene = camera = null; terrain = null; puffs = null; selected = {}; hovered = null; snap = null;
  if (stage) stage.innerHTML = ''; if (hooks.miniSlot) hooks.miniSlot.innerHTML = '';
};
function resize() { if (!renderer) return; const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }

/* ────────────────────────── Terrain: hex-tile island ────────────────────────── */
function buildTerrain() {
  const cols = 64, rows = 34, tiles = [];
  const capGeo = new THREE.CylinderGeometry(TILE * .97, TILE * .97, .3, 6); capGeo.translate(0, .15, 0);
  const colGeo = new THREE.CylinderGeometry(TILE * .97, TILE * .97, 1, 6); colGeo.translate(0, .5, 0);
  for (let i = -cols; i <= cols; i++) for (let j = -rows; j <= rows; j++) {
    const x = i * 1.5 * TILE, z = j * Math.sqrt(3) * TILE + (i & 1 ? Math.sqrt(3) / 2 * TILE : 0);
    const n = fbm(x * .035 + 7, z * .035 + 3), n2 = noise(x * .09, z * .09);
    tiles.push({ x, z, n, n2, h: 0, th: 0, biome: 'hidden', cap: new THREE.Color(), col: new THREE.Color(), delay: Math.random() * .25, treeIdx: -1 });
  }
  const caps = new THREE.InstancedMesh(capGeo, new THREE.MeshStandardMaterial({ roughness: .9, flatShading: true }), tiles.length);
  const colsM = new THREE.InstancedMesh(colGeo, new THREE.MeshStandardMaterial({ roughness: .95, flatShading: true }), tiles.length);
  caps.castShadow = caps.receiveShadow = true; colsM.receiveShadow = true; colsM.castShadow = true;
  caps.instanceMatrix.setUsage(THREE.DynamicDrawUsage); colsM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(colsM, caps);
  // Trees: round canopies on forest tiles. One instance per tile that can host one; hidden until its tile is forest.
  const canopyGeo = new THREE.IcosahedronGeometry(1.1, 0), trunkGeo = new THREE.CylinderGeometry(.14, .2, .9, 5); trunkGeo.translate(0, .45, 0);
  const canopies = new THREE.InstancedMesh(canopyGeo, new THREE.MeshStandardMaterial({ roughness: .9, flatShading: true }), tiles.length);
  const trunks = new THREE.InstancedMesh(trunkGeo, mats.wood, tiles.length); canopies.castShadow = true; trunks.castShadow = true;
  scene.add(trunks, canopies);
  terrain = { tiles, caps, cols: colsM, canopies, trunks, rx: 60, rz: 40, dirty: true, m: new THREE.Matrix4(), q: new THREE.Quaternion(), qy: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6), q0: new THREE.Quaternion(), s: new THREE.Vector3(), p: new THREE.Vector3(), hide: new THREE.Matrix4().makeScale(0, 0, 0), cForest: new THREE.Color(0x4f9645), cForestDeep: new THREE.Color(0x3f7d3a), cMeadow: new THREE.Color(0x6aa85a) };
  const rng = seeded(5); for (const t of tiles) { t.treeR = rng(); t.treeOx = (rng() - .5) * 1.6; t.treeOz = (rng() - .5) * 1.6; t.treeS = .8 + rng() * .7; }
  layoutTerrain([]);
}
// Give every tile a target height and colour from the island shape and the sites on it.
function layoutTerrain(siteList) {
  const T = terrain; let rx = 44, rz = 34;
  for (const s of siteList) { rx = Math.max(rx, Math.abs(s.x) + s.R + 16); rz = Math.max(rz, Math.abs(s.z) + s.R + 14); }
  T.rx = rx; T.rz = rz;
  const grass = [new THREE.Color(0x6fae5a), new THREE.Color(0x7dba62), new THREE.Color(0x63a052)], forest = new THREE.Color(0x4f8f48), sand = new THREE.Color(0xd9c58f), rock = new THREE.Color(0x8d8a84), snow = new THREE.Color(0xd8dde0), plot = new THREE.Color(0x3c4a52), earth = new THREE.Color(0x6b5a44), deep = new THREE.Color(0x1f6f8c), water = new THREE.Color(0x2c86a8);
  for (const t of T.tiles) {
    const e = (t.x / rx) ** 2 + (t.z / rz) ** 2;
    let biome = 'hidden', th = 0;
    if (e < 1) { th = 1.2 + t.n * 1.6 + Math.max(0, .78 - e) * .6; biome = t.n2 > .62 && t.n > .45 ? 'forest' : 'grass'; if (t.n > .8) { biome = 'rock'; th += 1.4; } if (e > .86) { biome = 'sand'; th = Math.min(th, 1.1); } }
    else if (e < 1.35) { th = .55; biome = 'water'; }
    // Sites flatten the tiles under them into a plateau; a ring outside eases down.
    let site = null;
    for (const s of siteList) { const d = Math.hypot(t.x - s.x, t.z - s.z); if (d < s.R + TILE * .8) { site = s; biome = 'plot'; th = PLAT; break; } else if (d < s.R + TILE * 2.6 && biome !== 'hidden') { th = Math.max(th, PLAT - 1.2 * (d - s.R - TILE * .8) / (TILE * 1.8)); if (biome === 'water') { biome = 'sand'; } } }
    t.site = site; t.th = th; t.biome = biome;
    t.cap.copy(biome === 'plot' ? plot : biome === 'water' ? water : biome === 'sand' ? sand : biome === 'rock' ? (th > 4 ? snow : rock) : biome === 'forest' ? forest : grass[Math.floor(t.n2 * 3) % 3]);
    t.col.copy(biome === 'water' ? deep : biome === 'plot' ? plot : earth);
    if (t.h === 0 && th > 0) t.h = .01; // new land rises from the sea floor
  }
  T.dirty = true; if (life.flies.length) pickFlyHomes();
}
function updateTerrain(dt) {
  const T = terrain; let any = false; const k = reduceMotion() ? 1 : Math.min(1, dt * 4.2);
  T.tiles.forEach((t, i) => {
    if (Math.abs(t.h - t.th) > .004) { t.h += (t.th - t.h) * k; any = true; } else if (t.h !== t.th) { t.h = t.th; any = true; }
    if (!any && !T.dirty) return;
    if (t.h <= .02 && t.th === 0) { T.caps.setMatrixAt(i, T.hide); T.cols.setMatrixAt(i, T.hide); T.canopies.setMatrixAt(i, T.hide); T.trunks.setMatrixAt(i, T.hide); return; }
    T.p.set(t.x, 0, t.z); T.s.set(1, Math.max(.01, t.h), 1); T.m.compose(T.p, T.qy, T.s); T.cols.setMatrixAt(i, T.m);
    T.p.set(t.x, t.h, t.z); T.s.set(1, 1, 1); T.m.compose(T.p, T.qy, T.s); T.caps.setMatrixAt(i, T.m);
    T.caps.setColorAt(i, t.cap); T.cols.setColorAt(i, t.col);
    const tree = t.biome === 'forest' && t.treeR < .85 || t.biome === 'grass' && t.treeR < .08;
    if (tree && Math.abs(t.h - t.th) < .05) { const s = t.treeS; T.p.set(t.x + t.treeOx, t.h + .3, t.z + t.treeOz); T.s.set(s, s, s); T.m.compose(T.p, T.q0, T.s); T.trunks.setMatrixAt(i, T.m); T.p.y += 1.35 * s; T.m.compose(T.p, T.q0, T.s); T.canopies.setMatrixAt(i, T.m); T.canopies.setColorAt(i, t.biome === 'forest' ? (t.n2 > .8 ? T.cForestDeep : T.cForest) : T.cMeadow); }
    else { T.canopies.setMatrixAt(i, T.hide); T.trunks.setMatrixAt(i, T.hide); }
  });
  if (any || T.dirty) { T.caps.instanceMatrix.needsUpdate = T.cols.instanceMatrix.needsUpdate = T.canopies.instanceMatrix.needsUpdate = T.trunks.instanceMatrix.needsUpdate = true; if (T.caps.instanceColor) T.caps.instanceColor.needsUpdate = true; if (T.cols.instanceColor) T.cols.instanceColor.needsUpdate = true; if (T.canopies.instanceColor) T.canopies.instanceColor.needsUpdate = true; T.dirty = false; }
}

/* ────────────────────────── Buildings ────────────────────────── */
function tower(parent, x, z, built, color, active, prev) {
  const g = new THREE.Group(); g.position.set(x, 0, z); parent.add(g);
  const FLOORS = 5, FH = 1.5, R = 2.6, n = Math.round(built * FLOORS), pn = prev == null ? n : Math.round(prev * FLOORS);
  for (let i = 0; i < FLOORS; i++) {
    const y = i * FH;
    if (i < n) { const f = hexPrism(R, FH, i % 2 ? mats.stone : mats.stoneDark); f.position.y = y + FH / 2; g.add(f); const trim = hexPrism(R + .2, .18, mat(color)); trim.position.y = y + FH; g.add(trim); const win = box(.5, .6, .12, mats.window); win.position.set(0, y + FH / 2, R * .866 + .02); g.add(win);
      if (i >= pn) { const fl = [f, trim, win]; fl.forEach(o => { o.scale.set(.01, .01, .01); }); tween(500, k => fl.forEach(o => o.scale.setScalar(Math.max(.01, k))), null, easeOutBack, (i - pn) * 120); if (puffs) { const wp = new THREE.Vector3(); f.getWorldPosition(wp); setTimeout(() => burst(wp, hexStr(color), 14, 3, 2), (i - pn) * 120 + 60); } } }
    else { const e = hexEdge(R + .3, y + FH / 2, 0xc39a55); g.add(e); const e2 = hexEdge(R + .3, y + FH, 0xc39a55, .5); g.add(e2);
      if (i === n) for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; const pole = new THREE.Mesh(new THREE.CylinderGeometry(.06, .06, FH * (FLOORS - n), 5), mats.scaffold); pole.position.set(Math.cos(a) * (R + .3), y + FH * (FLOORS - n) / 2, Math.sin(a) * (R + .3)); pole.castShadow = true; g.add(pole); } }
  }
  if (n >= FLOORS) { const roof = new THREE.Mesh(new THREE.ConeGeometry(R * 1.05, 2, 6), mat(color)); roof.position.y = FLOORS * FH + 1; roof.rotation.y = Math.PI / 6; roof.castShadow = true; g.add(roof); }
  else if (active) { const c = new THREE.Group(); c.position.set(R + .8, n * FH, -R); const mast = new THREE.Mesh(new THREE.CylinderGeometry(.12, .12, 5, 6), mats.scaffold); mast.position.y = 2.5; mast.castShadow = true; const jib = new THREE.Group(); jib.position.y = 5; const arm = box(5, .18, .18, mats.scaffold); arm.position.x = 1.6; const back = box(1.4, .18, .18, mats.scaffold); back.position.x = -1.1; const cable = new THREE.Mesh(new THREE.CylinderGeometry(.02, .02, 2.2, 4), mats.dark); cable.position.set(3.4, -1.1, 0); const block = hexPrism(.35, .5, mat(color)); block.position.set(3.4, -2.4, 0); jib.add(arm, back, cable, block); c.add(mast, jib); g.add(c); cranes.push({ jib, block, ph: Math.random() * 6, g }); }
  g.userData.topY = FLOORS * FH + 2.6; return g;
}
function hall(parent, x, z, built, color, active, prev) {
  const g = new THREE.Group(); g.position.set(x, 0, z); parent.add(g);
  const walls = hexPrism(2.6, 2.1, mats.stone); walls.position.y = 1.05; const door = box(.8, 1.1, .1, mats.dark); door.position.set(0, .55, 2.3); const trim = hexPrism(2.75, .16, mat(color)); trim.position.y = 2.1; g.add(walls, door, trim);
  const win = box(.5, .6, .12, mats.window); win.position.set(1.3, 1.1, 2.05); g.add(win); const win2 = box(.5, .6, .12, mats.window); win2.position.set(-1.3, 1.1, 2.05); g.add(win2);
  // A chimney smokes while there is work going on inside.
  if (active) { const ch = new THREE.Mesh(new THREE.CylinderGeometry(.22, .26, 1.4, 6), mats.stoneDark); ch.position.set(-1.4, 2.9, -.8); g.add(ch); const smoke = []; for (let k = 0; k < 4; k++) { const s = new THREE.Mesh(new THREE.SphereGeometry(.14, 7, 6), new THREE.MeshStandardMaterial({ color: 0xcfd4da, transparent: true, opacity: .55 })); g.add(s); smoke.push({ m: s, ph: k / 4 }); } life.chimneys.push({ smoke, at: [-1.4, 3.6, -.8], g }); }
  if (built >= 1) { const roof = new THREE.Mesh(new THREE.ConeGeometry(2.9, 1.6, 6), mat(color)); roof.position.y = 2.9; roof.rotation.y = Math.PI / 6; roof.castShadow = true; g.add(roof); if (prev != null && prev < 1) { roof.scale.setScalar(.01); tween(600, k => roof.scale.setScalar(Math.max(.01, k)), null, easeOutBack); const wp = new THREE.Vector3(); roof.getWorldPosition(wp); burst(wp, hexStr(color), 18, 3, 3); } }
  else { g.add(hexEdge(2.9, 2.9, 0xc39a55), hexEdge(2.9, 3.8, 0xc39a55, .5)); const part = new THREE.Mesh(new THREE.ConeGeometry(2.9, 1.6, 6), mat(color)); part.scale.setScalar(Math.max(.01, built)); part.rotation.y = Math.PI / 6; part.position.y = 2.1 + .8 * built; part.castShadow = true; g.add(part);
    for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; const pole = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, 3.8, 5), mats.scaffold); pole.position.set(Math.cos(a) * 2.9, 1.9, Math.sin(a) * 2.9); g.add(pole); }
    if (active) { const c = new THREE.Group(); c.position.set(3.4, 0, -2.4); const mast = new THREE.Mesh(new THREE.CylinderGeometry(.1, .1, 4.2, 6), mats.scaffold); mast.position.y = 2.1; const jib = new THREE.Group(); jib.position.y = 4.2; const arm = box(3.6, .16, .16, mats.scaffold); arm.position.x = 1.2; const cable = new THREE.Mesh(new THREE.CylinderGeometry(.02, .02, 1.6, 4), mats.dark); cable.position.set(2.6, -.8, 0); const block = hexPrism(.3, .4, mat(color)); block.position.set(2.6, -1.8, 0); jib.add(arm, cable, block); c.add(mast, jib); g.add(c); cranes.push({ jib, block, ph: Math.random() * 6, g }); } }
  g.userData.topY = 5.2; return g;
}
function banner(parent, x, y, z, color) {
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(.06, .08, 3.6, 6), mats.wood); pole.position.set(x, y + 1.8, z); pole.castShadow = true; parent.add(pole);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.5, .9), mat(color, { side: THREE.DoubleSide, emissive: color, emissiveIntensity: .12 })); flag.position.set(x + .78, y + 3.1, z); parent.add(flag); flags.push(flag);
}
function compoundWalls(g, R, color, gate) {
  const plat = hexPrism(R, .5, mats.plot); plat.position.y = .25; g.add(plat); g.add(hexEdge(R, .52, color, .6));
  const verts = []; for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; verts.push([Math.cos(a) * (R - .4), Math.sin(a) * (R - .4)]); }
  for (let k = 0; k < 6; k++) {
    const [x1, z1] = verts[k], [x2, z2] = verts[(k + 1) % 6]; const len = Math.hypot(x2 - x1, z2 - z1), ang = Math.atan2(z2 - z1, x2 - x1), front = Math.abs(z1 - z2) < .01 && z1 > 0;
    const segs = front && gate ? [[.25, (len - gate) / 2], [.75, (len - gate) / 2]] : [[.5, len]];
    for (const [t, l] of segs) { const w = box(l, 1.6, .5, mats.wall); w.position.set(x1 + (x2 - x1) * t, 1.3, z1 + (z2 - z1) * t); w.rotation.y = -ang; g.add(w); }
    const tw = new THREE.Mesh(new THREE.CylinderGeometry(.8, .9, 3, 6), mats.wall); tw.position.set(x1, 2, z1); tw.castShadow = true; g.add(tw);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 6), mat(color)); cap.position.set(x1, 4, z1); cap.castShadow = true; g.add(cap);
  }
  const fz = verts[1][1];
  if (gate) { for (const sx of [-1, 1]) { const post = box(.6, 4.2, .6, mats.wood); post.position.set(sx * gate / 2, 2.6, fz); g.add(post); const torch = new THREE.Mesh(new THREE.SphereGeometry(.28, 8, 6), mats.torch); torch.position.set(sx * gate / 2, 5.1, fz + .4); g.add(torch); life.torches.push(torch); } const beam = box(gate + .6, .4, .6, mats.wood); beam.position.set(0, 4.8, fz); g.add(beam); const cloth = new THREE.Mesh(new THREE.PlaneGeometry(gate - .6, 1.6), mat(color, { side: THREE.DoubleSide, emissive: color, emissiveIntensity: .15 })); cloth.position.set(0, 3.8, fz + .05); g.add(cloth); }
  const anchor = new THREE.Object3D(); anchor.position.set(0, 8.6, -fz); g.add(anchor); return { plat, anchor };
}
function textSprite(text, color, bg, size = .85) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  g.beginPath(); for (let k = 0; k < 6; k++) { const a = -Math.PI / 2 + k * Math.PI / 3; k ? g.lineTo(64 + 56 * Math.cos(a), 64 + 56 * Math.sin(a)) : g.moveTo(64 + 56 * Math.cos(a), 64 + 56 * Math.sin(a)); } g.closePath(); g.fillStyle = bg; g.fill(); g.lineWidth = 6; g.strokeStyle = color; g.stroke();
  g.fillStyle = color; g.font = '700 70px "Chakra Petch", "Segoe UI", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 64, 70);
  const tex = new THREE.CanvasTexture(c); const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })); s.scale.setScalar(size); s.renderOrder = 10; return s;
}

/* ────────────────────────── Layout ────────────────────────── */
function keepOrder(arr, keys) { const set = new Set(keys); for (let i = arr.length - 1; i >= 0; i--) if (!set.has(arr[i])) arr.splice(i, 1); for (const k of keys) if (!arr.includes(k)) arr.push(k); }
// Lots inside a compound tile as a staggered column of flat-top hexes, centred on the compound, for any repo count.
const LOT_POS = n => { if (n <= 1) return [[0, 0]]; const zc = -(n - 1) * 4, out = []; for (let i = 0; i < n; i++) out.push([i % 2 ? 7.4 : -7.4, 3.8 - Math.floor(i / 2) * 16 - (i % 2) * 8 - zc]); return out; };
const COMPOUND_R = n => n <= 1 ? 14 : Math.max(19, Math.ceil(((n - 1) * 4 + 12.5) / .866));
const SLOTS = (() => { const s = []; const ring = (r, angs) => angs.forEach(a => s.push([Math.cos(a * Math.PI / 180) * r, Math.sin(a * Math.PI / 180) * r])); ring(6.6, [35, 90, 145]); ring(4.2, [20, 70, 110, 160]); ring(8.4, [30, 60, 90, 120, 150]); return s; })();
const slotAt = i => { const [x, z] = SLOTS[i % SLOTS.length], k = Math.floor(i / SLOTS.length); return [x + (k % 2 ? .9 : -.9) * k, z - .8 * k]; }; // beyond 12 units a lot doubles up with a small offset
function planSites(s) {
  const feats = new Map(), shops = [];
  for (const p of s.projects) { if (p.feature) { if (!feats.has(p.feature)) feats.set(p.feature, []); feats.get(p.feature).push(p); } else shops.push(p); }
  keepOrder(order.features, [...feats.keys()]); keepOrder(order.shops, shops.map(p => p.cwd));
  const plan = [], GAP = 6;
  const fR = order.features.map(f => COMPOUND_R(feats.get(f).length)), fTotal = fR.reduce((a, b) => a + 2 * b, 0) + Math.max(0, fR.length - 1) * GAP; let x = -fTotal / 2;
  const fRowZ = -(Math.max(14, ...fR) + 6);
  order.features.forEach((f, i) => { const R = fR[i]; plan.push({ key: 'f:' + f, kind: 'feature', name: f, repos: feats.get(f), x: x + R, z: fRowZ, R }); x += 2 * R + GAP; });
  const RW = 11, sTotal = order.shops.length * 2 * RW + Math.max(0, order.shops.length - 1) * 3; x = -sTotal / 2;
  for (const cwd of order.shops) { plan.push({ key: 'w:' + cwd, kind: 'workshop', project: shops.find(p => p.cwd === cwd), x: x + RW, z: 20, R: RW }); x += 2 * RW + 3; }
  if (s.github) { const R = githubRadius(s); plan.push({ key: 'github', kind: 'github', x: sTotal / 2 + GAP + R, z: R - 2, R }); }
  if (plan.length) plan.push({ key: 'treasury', kind: 'treasury', x: 0, z: 1.5, R: 4 }); // today's spend as a coin pile at the crossroads
  if (s.peers && s.peers.length) plan.push({ key: 'allies', kind: 'allies', x: -(sTotal / 2 + GAP + 13), z: 22, R: 13 });
  return plan;
}

/* ────────────────────────── Sites ────────────────────────── */
function siteColor(key) { if (!colorFor.has(key)) colorFor.set(key, SITE_COLORS[siteColorIdx++ % SITE_COLORS.length]); return colorFor.get(key); }
// How finished a lot's building looks: work in progress raises scaffolding and a crane, finished work
// completes the floors. A lot with nothing in flight (idle units, or none) stands complete.
function lotBuilt(agents) { const done = agents.filter(a => a.status === 'waiting').length, work = agents.filter(a => a.status === 'active' || a.status === 'settling' || a.status === 'permission' || a.status === 'question').length; if (!work && !done) return 1; return Math.max(.2, Math.min(1, (done + .5 * work) / (done + work))); }
function buildLot(site, lx, lz, R, spec) {
  const g = new THREE.Group(); g.position.set(lx, 0, lz); site.g.add(g);
  const yard = hexPrism(R - .8, .06, mats.yard); yard.position.y = .53; g.add(yard); g.add(hexEdge(R - .8, .57, spec.color, .35));
  const lot = { g, R, spec, cwd: spec.cwd, units: new Map(), building: null, built: null, beacon: null, el: null, site };
  lot.el = label('w-lot', esc(spec.title), null, hexStr(spec.color)); lot.el.obj = new THREE.Object3D(); lot.el.obj.position.set(0, 8, 0); g.add(lot.el.obj);
  rebuildLotBuilding(lot, spec);
  return lot;
}
function rebuildLotBuilding(lot, spec) {
  const built = lotBuilt(spec.agents), active = spec.agents.some(a => a.status === 'active' || a.status === 'settling'), key = `${spec.kind}|${built.toFixed(2)}|${active}|${spec.server}|${spec.status}`;
  if (lot.key === key) return; const prev = lot.built; lot.key = key; lot.built = built;
  if (lot.building) { for (let i = cranes.length - 1; i >= 0; i--) if (lot.building.getObjectById(cranes[i].g.id)) cranes.splice(i, 1); disposeObj(lot.building); }
  if (lot.beacon) { const bi = beacons.indexOf(lot.beacon); if (bi >= 0) beacons.splice(bi, 1); disposeObj(lot.beacon); lot.beacon = null; }
  lot.building = spec.kind === 'feature' ? tower(lot.g, 0, -3.4, built, spec.color, active, prev) : hall(lot.g, 0, -3.4, built, spec.color, active, prev);
  lot.el.obj.position.y = lot.building.userData.topY;
  if (spec.server) { const b = new THREE.Mesh(new THREE.SphereGeometry(.22, 10, 8), new THREE.MeshStandardMaterial({ color: 0xa6e3a1, emissive: 0xa6e3a1, emissiveIntensity: 1.6 })); b.position.set(3.6, 3.2, -3.4); lot.g.add(b); beacons.push(b); lot.beacon = b; const p = new THREE.Mesh(new THREE.CylinderGeometry(.04, .04, 2.4, 5), mats.dark); p.position.set(3.6, 2, -3.4); b.add(p); p.position.set(0, -1.2, 0); }
  if (spec.status === 'failed' && !lot.smoke) { /* setup failed: keep it visible via the label chip */ }
  setLabel(lot.el, `${esc(spec.title)}${spec.server ? '<i></i>' : ''}${spec.status === 'setup' ? ' <span style="color:var(--w-perm)">setting up…</span>' : spec.status === 'failed' ? ' <span style="color:var(--w-crashed)">setup failed</span>' : ''}`);
}
function createSite(p) {
  const g = new THREE.Group(); g.position.set(p.x, PLAT, p.z); scene.add(g);
  const site = { key: p.key, kind: p.kind, g, R: p.R, x: p.x, z: p.z, lots: new Map(), color: 0, el: null, plat: null, anchor: null, extra: {} };
  if (p.kind === 'feature') {
    site.color = siteColor(p.key); const { plat, anchor } = compoundWalls(g, p.R, site.color, 6); site.plat = plat; site.anchor = anchor; plat.userData.pick = { site };
    site.el = label('w-site', '', anchor, hexStr(site.color));
  } else if (p.kind === 'workshop') {
    site.color = siteColor(p.key); const plat = hexPrism(p.R, .5, mats.plot); plat.position.y = .25; g.add(plat); g.add(hexEdge(p.R, .52, site.color, .8)); site.plat = plat; plat.userData.pick = { site };
  } else if (p.kind === 'github') buildGithub(site, p.R);
  else if (p.kind === 'allies') buildAllies(site, p.R);
  else if (p.kind === 'treasury') { site.color = 0xe1b453; const plat = hexPrism(p.R, .5, mats.plot); plat.position.y = .25; g.add(plat); g.add(hexEdge(p.R, .52, 0xe1b453, .6)); site.plat = plat; plat.userData.pick = { site }; const an = new THREE.Object3D(); an.position.set(0, 4.2, 0); g.add(an); site.el = label('w-lot', 'Treasury', an, '#e1b453'); site.extra.coins = new THREE.Group(); g.add(site.extra.coins); site.extra.coinsN = -1; }
  // Spawn: rise from below with a dust burst.
  g.position.y = PLAT - 9; tween(900, k => { g.position.y = PLAT - 9 + 9 * k; }, () => burst(new THREE.Vector3(p.x, PLAT + .5, p.z), '#e6d7b8', 40, p.R * 1.2, 2), easeOutCubic, 250);
  sites.set(p.key, site); return site;
}
function destroySite(site) {
  sites.delete(site.key);
  for (const lot of site.lots.values()) { dropLabel(lot.el); for (const u of lot.units.values()) destroyUnit(u, true); }
  dropLabel(site.el); for (const sh of ships.values()) if (sh.site === site) destroyShip(sh, true); for (const m of machines.values()) if (m.site === site) destroyMachine(m, true); for (const t of tents.values()) if (t.site === site) destroyTent(t, true);
  for (const a of [...anchors]) if (a.obj && site.g.getObjectById(a.obj.id)) dropLabel(a);
  if (site.plat) site.plat.userData.pick = null; if (selected.site === site) { selected = {}; renderSel(); }
  for (let i = cranes.length - 1; i >= 0; i--) if (site.g.getObjectById(cranes[i].g.id)) cranes.splice(i, 1);
  burst(new THREE.Vector3(site.x, PLAT + .5, site.z), '#8a98ab', 40, site.R * 1.2, 3);
  const g = site.g, y0 = g.position.y; tween(800, k => { g.position.y = y0 - 12 * k; }, () => disposeObj(g), easeInCubic);
}
function syncSite(site, p, s) {
  if (site.x !== p.x || site.z !== p.z) { const fx = site.x, fz = site.z; site.x = p.x; site.z = p.z; tween(700, k => site.g.position.set(fx + (p.x - fx) * k, site.g.position.y, fz + (p.z - fz) * k)); }
  if (p.kind === 'feature' || p.kind === 'workshop') {
    const repos = p.kind === 'feature' ? p.repos : [p.project], pos = p.kind === 'feature' ? LOT_POS(repos.length) : [[0, 0]], R = p.kind === 'feature' ? 9.5 : p.R;
    const seen = new Set();
    repos.forEach((proj, i) => {
      seen.add(proj.cwd); const agents = s.agents.filter(a => a.cwd === proj.cwd);
      const spec = { kind: p.kind, cwd: proj.cwd, title: proj.label, color: site.color, server: !!proj.serverUrl, port: proj.port, status: proj.status, agents, branch: proj.branch };
      let lot = site.lots.get(proj.cwd);
      if (!lot) { lot = buildLot(site, pos[i][0], pos[i][1], R, spec); site.lots.set(proj.cwd, lot); if (p.kind === 'feature') banner(site.g, pos[i][0] + 6.5, .5, pos[i][1] - 5.5, site.color); else banner(site.g, 6.5, .5, -6.5, site.color); }
      else { lot.spec = spec; rebuildLotBuilding(lot, spec); }
      syncLotUnits(lot, agents, s);
    });
    for (const [cwd, lot] of site.lots) if (!seen.has(cwd)) { for (const u of lot.units.values()) destroyUnit(u); dropLabel(lot.el); disposeObj(lot.g); site.lots.delete(cwd); }
    if (site.el) { const all = repos.flatMap(r => s.agents.filter(a => a.cwd === r.cwd)); const built = repos.length ? repos.reduce((acc, r) => acc + (site.lots.get(r.cwd)?.built ?? 1), 0) / repos.length : 0;
      if (site.built != null && site.built < 1 && built >= 1) { const wp = new THREE.Vector3(); site.anchor.getWorldPosition(wp); fireworks(wp.setY(wp.y + 6), 6); } /* the feature's work is complete */ setLabel(site.el, `<div class="w-eyebrow">Feature</div><b>${esc(p.name)}</b><div class="w-prog"><i style="width:${Math.round(built * 100)}%"></i></div><span class="w-cnt">${all.length} unit${all.length === 1 ? '' : 's'} &middot; ${repos.length} repo${repos.length === 1 ? '' : 's'} &middot; ${Math.round(built * 100)}%</span>`); site.built = built; site.name = p.name; }
  } else if (p.kind === 'github') { if (site.R !== p.R) { destroySite(site); const ns = createSite(p); syncGithub(ns, s); return; } syncGithub(site, s); }
  else if (p.kind === 'treasury') syncTreasury(site, s);
  else if (p.kind === 'allies') syncAllies(site, s);
}

/* ────────────────────────── Units (agents) ────────────────────────── */
function makeUnitBody(u) {
  const { a, lot } = u, st = a.status, scale = u.scale, sc = STATUS[st].hex, p = {};
  const inner = new THREE.Group(); inner.scale.setScalar(scale); u.g.add(inner);
  const team = mat(lot.spec.color);
  p.legL = box(.22, .5, .24, mats.dark); p.legL.position.set(-.15, .25, 0); p.legR = box(.22, .5, .24, mats.dark); p.legR.position.set(.15, .25, 0);
  p.torso = box(.72, .8, .46, team); p.torso.position.y = .9; const belt = box(.74, .1, .48, mats.gold); belt.position.y = .55;
  p.head = box(.5, .48, .5, mats.skin); p.head.position.y = 1.56; const visor = box(.52, .12, .1, mats.dark); visor.position.set(0, .05, .24); p.head.add(visor);
  const shoulder = sx => { const piv = new THREE.Group(); piv.position.set(sx, 1.22, 0); const arm = box(.2, .62, .22, team); arm.position.y = -.3; const hand = box(.2, .14, .22, mats.skin); hand.position.y = -.66; piv.add(arm, hand); return piv; };
  p.armL = shoulder(-.47); p.armR = shoulder(.47);
  const model = a.model || 'sonnet';
  if (model === 'opus' || model === 'fable') { const crest = model === 'fable', cm = crest ? mat(0xf5c2e7, { metalness: .5, roughness: .35 }) : mats.gold; const cr = new THREE.Mesh(new THREE.CylinderGeometry(.3, .26, .2, 6), cm); cr.position.y = .36; p.head.add(cr); for (let i = 0; i < (crest ? 6 : 3); i++) { const sp = box(.08, crest ? .22 : .16, .08, cm); const an = i * (crest ? 1.047 : 2.09); sp.position.set(Math.cos(an) * .24, .5, Math.sin(an) * .24); p.head.add(sp); } }
  else if (model === 'haiku') { const bd = box(.54, .09, .54, mat(0xd05a5a)); bd.position.y = .18; p.head.add(bd); }
  else { const cp = box(.56, .16, .56, mat(0x2a3f66)); cp.position.y = .3; const brim = box(.3, .05, .3, mat(0x2a3f66)); brim.position.set(0, .24, .38); p.head.add(cp, brim); }
  inner.add(p.legL, p.legR, p.torso, belt, p.head, p.armL, p.armR);
  if (st === 'active' || st === 'settling') {
    const hammer = new THREE.Group(); hammer.position.y = -.7; const handle = box(.07, .55, .07, mats.wood); handle.position.set(0, -.05, .2); handle.rotation.x = Math.PI / 2; const head = box(.2, .16, .3, mats.iron); head.position.set(0, -.05, .48); hammer.add(handle, head); p.armR.add(hammer);
    p.sparks = []; const sm = new THREE.MeshBasicMaterial({ color: 0xffd36b }); for (let i = 0; i < 7; i++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(.06, .06, .06), sm); sp.visible = false; inner.add(sp); p.sparks.push({ m: sp, v: new THREE.Vector3(), life: 0 }); }
  }
  if (st === 'crashed') { p.smoke = []; for (let i = 0; i < 5; i++) { const sp = new THREE.Mesh(new THREE.SphereGeometry(.16, 7, 6), new THREE.MeshStandardMaterial({ color: 0x3a3f47, transparent: true, opacity: .7 })); inner.add(sp); p.smoke.push({ m: sp, ph: i / 5 }); } }
  p.disc = new THREE.Mesh(new THREE.CircleGeometry(.85 * scale, 6), new THREE.MeshBasicMaterial({ color: sc, transparent: true, opacity: .32, depthWrite: false })); p.disc.rotation.x = -Math.PI / 2; p.disc.rotation.z = Math.PI / 6; p.disc.position.y = .015; u.g.add(p.disc);
  p.ring = new THREE.Mesh(new THREE.RingGeometry(.92 * scale, 1.06 * scale, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })); p.ring.rotation.x = -Math.PI / 2; p.ring.rotation.z = Math.PI / 6; p.ring.position.y = .02; u.g.add(p.ring);
  if (st === 'resuming') { p.arc = new THREE.Mesh(new THREE.RingGeometry(.92, 1.06, 24, 1, 0, Math.PI * 1.25), new THREE.MeshBasicMaterial({ color: sc, transparent: true, opacity: .9, side: THREE.DoubleSide })); p.arc.rotation.x = -Math.PI / 2; p.arc.position.y = .025; u.g.add(p.arc); }
  const bub = { permission: ['!', '#f9e2af'], question: ['?', '#cba6f7'], waiting: ['✓', '#a6e3a1'], idle: ['z', '#7d8ca3'], crashed: ['✕', '#f38ba8'], resuming: ['↻', '#cba6f7'] }[st];
  if (bub) { p.bubble = textSprite(bub[0], bub[1], 'rgba(8,12,18,.92)'); p.bubble.position.y = 2.45 * scale; if (st === 'idle') p.bubble.scale.setScalar(.5); u.g.add(p.bubble); }
  // Working units think out loud: a cloud with the glyph of the tool they are using right now.
  if (st === 'active' || st === 'settling') { p.think = cloudSprite(toolGlyph(a.tool)); p.think.position.y = 2.6 * scale; u.g.add(p.think); }
  u.inner = inner; u.p = p;
}
const TOOL_GLYPH = { Edit: '✎', Write: '✎', MultiEdit: '✎', NotebookEdit: '✎', Read: '☰', Bash: '>_', PowerShell: '>_', Grep: '⌕', Glob: '⌕', Task: '⚑', Agent: '⚑', WebFetch: '⇣', WebSearch: '⇣', TodoWrite: '☑', LSP: '{}' };
function toolGlyph(name) { if (!name) return '…'; return TOOL_GLYPH[name] || TOOL_GLYPH[Object.keys(TOOL_GLYPH).find(k => name.startsWith(k)) || ''] || '⚙'; }
function cloudSprite(glyph) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  g.fillStyle = 'rgba(245,247,250,.96)'; g.beginPath(); g.ellipse(68, 50, 50, 36, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(30, 96, 9, 0, Math.PI * 2); g.fill(); g.beginPath(); g.arc(16, 114, 5, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#0b1118'; g.font = glyph.length > 1 ? '700 40px Consolas, monospace' : GLYPH_FONT.replace('70px', '52px'); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(glyph, 68, 54);
  const tex = new THREE.CanvasTexture(c); const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })); s.scale.set(1.15, 1.15, 1); s.renderOrder = 10; return s;
}
// The workbench stays at the unit's post while the unit wanders; it lives in the lot, not in the unit.
function ensureBench(u) {
  const want = u.a.status === 'active' || u.a.status === 'settling';
  if (want && !u.bench) { const b = new THREE.Group(); b.position.set(u.tx, .56, u.tz); b.rotation.y = u.face; const bench = box(1.3, .5, .6, mats.wood); bench.position.set(0, .25, .95); const anvil = box(.5, .22, .3, mats.iron); anvil.position.set(0, .61, .95); b.add(bench, anvil); b.scale.setScalar(u.scale); u.lot.g.add(b); u.bench = b; }
  else if (!want && u.bench) { disposeObj(u.bench); u.bench = null; }
}
function createUnit(a, lot, lx, lz, opts) {
  const g = new THREE.Group(); g.position.set(lx, .56, lz); lot.g.add(g);
  const u = { a, lot, g, scale: opts.scale || 1, phase: Math.random() * 6.28, mini: !!opts.mini, lead: opts.lead || null, key: null, tx: lx, tz: lz, face: opts.face ?? (.15 - Math.random() * .3) };
  const hit = new THREE.Mesh(new THREE.BoxGeometry(1.6 * u.scale, 2.3 * u.scale, 1.6 * u.scale), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })); hit.position.y = 1.1 * u.scale; g.add(hit); hit.userData.pick = { unit: u }; u.hit = hit; pickables.add(hit);
  makeUnitBody(u); u.key = unitKey(a); ensureBench(u);
  u.pill = label('w-pill', esc(a.title), g, null, (u.p.bubble || u.p.think ? 3.2 : 2.35) * u.scale);
  // Spawn: pop up out of the ground with a burst in the team colour.
  g.scale.setScalar(.01); tween(520, k => g.scale.setScalar(Math.max(.01, k)), null, easeOutBack, 80);
  const wp = new THREE.Vector3(); g.getWorldPosition(wp); setTimeout(() => burst(wp, hexStr(lot.spec.color), 16, 1.4, 3), 100);
  return u;
}
const unitKey = a => `${a.status}|${a.model}|${a.title}|${a.looping}|${a.tool || ''}`;
function destroyUnit(u, quiet) {
  if (u.mini) u.lead?.crew?.delete(u.a.id); units.delete(u.a.id); u.lot.units.delete(u.a.id); dropLabel(u.pill); pickables.delete(u.hit); if (u.bench) { disposeObj(u.bench); u.bench = null; }
  if (hovered === u) hovered = null; if (selected.unit === u) { selected = {}; renderSel(); }
  const wp = new THREE.Vector3(); u.g.getWorldPosition(wp); if (!quiet) burst(wp, '#8a98ab', 16, 1.2, 2.5);
  const g = u.g; tween(quiet ? 200 : 450, k => { g.scale.setScalar(Math.max(.01, 1 - k)); g.position.y = .56 - k * .8; }, () => disposeObj(g), easeInCubic);
}
function syncLotUnits(lot, agents, s) {
  const sorted = [...agents].sort((a, b) => STATUS[a.status].order - STATUS[b.status].order || a.id - b.id), seen = new Set();
  sorted.forEach((a, i) => {
    const [lx, lz] = slotAt(i); seen.add(a.id);
    let u = lot.units.get(a.id);
    if (!u) { u = createUnit(a, lot, lx, lz, {}); lot.units.set(a.id, u); units.set(a.id, u); }
    else {
      const nk = unitKey(a); u.a = a;
      if (u.key !== nk) { const wasStatus = u.key.split('|')[0]; disposeObj(u.inner); for (const k of ['disc', 'ring', 'arc', 'bubble', 'think']) if (u.p[k]) { disposeObj(u.p[k]); } u.walk = null; if (u.say) { disposeObj(u.say); u.say = null; } makeUnitBody(u); u.key = nk; ensureBench(u); u.pill.dy = (u.p.bubble || u.p.think ? 3.2 : 2.35) * u.scale; setLabel(u.pill, esc(a.title));
        if (wasStatus !== a.status) { const wp = new THREE.Vector3(); u.g.getWorldPosition(wp); wp.y += 1; burst(wp, hexStr(STATUS[a.status].hex), 14, 1, 2.5);
          // Finished a job: confetti and a victory jump.
          if (a.status === 'waiting' && ['active', 'settling', 'permission', 'question'].includes(wasStatus)) { confetti(wp); u.cheerUntil = performance.now() / 1000 + 3; } } }
      if (u.tx !== lx || u.tz !== lz) { const fx = u.tx, fz = u.tz; u.tx = lx; u.tz = lz; u.walk = null; tween(600, k => { u.g.position.set(fx + (lx - fx) * k, u.g.position.y, fz + (lz - fz) * k); if (u.bench) u.bench.position.set(u.g.position.x, .56, u.g.position.z); }); }
    }
    // Crew: a lead's team members stand behind it, smaller.
    const members = a.team ? a.team.members : [];
    u.crew = u.crew || new Map(); const mseen = new Set();
    members.forEach((m, k) => {
      const mid = a.id * 1000 + k + 1; mseen.add(mid); seen.add(mid);
      const ma = { id: mid, cwd: a.cwd, title: m.name, status: 'active', model: 'sonnet', ctxPct: 0, cost: 0, verb: m.task || m.agentType || '', teamName: a.team.name, memberName: m.name, isCrew: true };
      let cu = lot.units.get(mid);
      const mx = lx + (k % 2 ? 1.8 : -1.8) * (1 + Math.floor(k / 2) * .6), mz = lz - 1.7 - Math.floor(k / 2) * 1.4;
      if (!cu) { cu = createUnit(ma, lot, mx, mz, { scale: .7, mini: true, lead: u, face: k % 2 ? -.5 : .5 }); lot.units.set(mid, cu); units.set(mid, cu); u.crew.set(mid, cu); }
      else { cu.a = ma; setLabel(cu.pill, esc(m.name)); if (cu.tx !== mx || cu.tz !== mz) { const fx = cu.tx, fz = cu.tz; cu.tx = mx; cu.tz = mz; tween(600, q => cu.g.position.set(fx + (mx - fx) * q, cu.g.position.y, fz + (mz - fz) * q)); } }
    });
    for (const [mid, cu] of u.crew) if (!mseen.has(mid)) { destroyUnit(cu); u.crew.delete(mid); }
  });
  for (const [id, u] of lot.units) if (!seen.has(id)) destroyUnit(u);
}
function activity(a) {
  if ((a.status === 'waiting' || a.status === 'idle') && a.idleMin >= IDLE_CALL_MIN) return `${a.status === 'waiting' ? 'Done' : 'Idle'} for ${a.idleMin >= 60 ? Math.floor(a.idleMin / 60) + 'h ' + (a.idleMin % 60) + 'm' : a.idleMin + 'm'} · waiting for orders`;
  switch (a.status) {
    case 'permission': return 'Waiting for approval' + (a.verb ? ': ' + a.verb : '');
    case 'question': return 'Waiting for your answer';
    case 'crashed': return 'Crashed' + (a.crash ? ' ' + a.crash : '');
    case 'resuming': return 'Resuming' + (a.crash ? ' ' + a.crash : '');
    case 'idle': return 'Idle';
    case 'waiting': return 'Done';
    default: return a.verb || 'Working';
  }
}

/* ────────────────────────── GitHub quarter: docks (PRs) and proving grounds (Actions) ──────────────────────────
   Ships moor along one pier per repo, machines stand on one slab per repo, so a crowded quarter still reads by repo. */
const byRepo = list => { const m = new Map(); for (const it of list) { if (!m.has(it.repo)) m.set(it.repo, []); m.get(it.repo).push(it); } return m; };
function quarterHalfRadius(s) {
  const pr = byRepo(s.prs || []), rn = byRepo(s.runs || []);
  const rows = Math.max(1, pr.size, rn.size), cols = Math.max(1, ...[...pr.values(), ...rn.values()].map(l => l.length));
  return Math.max(10.5, rows * 5 / 1.4 + 4, cols * 4.6 / 1.5 + 4);
}
function githubRadius(s) { return Math.min(70, Math.round(quarterHalfRadius(s) * 2 + 4)); }
const GLYPH_FONT = '700 70px "Segoe UI Symbol", "Segoe UI", sans-serif';
function buildGithub(site, GR) {
  const g = site.g; site.color = 0xc9d1d9;
  const plat = hexPrism(GR, .5, mat(0x22272e)); plat.position.y = .25; g.add(plat); g.add(hexEdge(GR, .52, 0xc9d1d9, .7)); site.plat = plat; plat.userData.pick = { site };
  const col = hexPrism(2.2, 7, mat(0x161b22)); col.position.set(0, 4, -(GR - 11)); g.add(col);
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
  x.fillStyle = '#f0f6fc'; x.beginPath(); x.arc(128, 128, 118, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#0d1117'; x.beginPath(); x.arc(128, 122, 62, 0, Math.PI * 2); x.fill();
  x.beginPath(); x.moveTo(78, 90); x.lineTo(72, 40); x.lineTo(112, 66); x.closePath(); x.fill(); x.beginPath(); x.moveTo(178, 90); x.lineTo(184, 40); x.lineTo(144, 66); x.closePath(); x.fill();
  x.fillStyle = '#f0f6fc'; x.beginPath(); x.ellipse(105, 118, 16, 12, 0, 0, Math.PI * 2); x.ellipse(151, 118, 16, 12, 0, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#0d1117'; x.beginPath(); x.roundRect(96, 178, 64, 44, 10); x.fill(); x.strokeStyle = '#0d1117'; x.lineWidth = 12; x.lineCap = 'round'; x.beginPath(); x.moveTo(96, 200); x.quadraticCurveTo(40, 200, 44, 150); x.stroke();
  const mark = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true })); mark.scale.setScalar(5.5); mark.position.set(0, 10.9, -(GR - 11)); g.add(mark); site.extra.mark = mark; site.extra.markY = 10.9;
  const anchor = new THREE.Object3D(); anchor.position.set(0, 14.6, -(GR - 11)); g.add(anchor); site.el = label('w-site w-big', '', anchor, '#c9d1d9');
  const hr = (GR - 4) / 2, cx = hr + 1; site.extra.hr = hr; site.extra.cx = cx;
  const pool = hexPrism(hr, .1, mats.water); pool.position.set(-cx, .5, 2); g.add(pool); const pe = hexEdge(hr, .58, 0x3fbfd6, .6); pe.position.set(-cx, .58, 2); g.add(pe);
  const da = new THREE.Object3D(); da.position.set(-cx, 5.1, 2 + hr * .866 + .5); g.add(da); label('w-lot', 'Docks &middot; pull requests', da, '#3fbfd6');
  const floor = hexPrism(hr, .08, mat(0x2b3238)); floor.position.set(cx, .52, 2); g.add(floor); const fe = hexEdge(hr, .58, 0xa78bfa, .6); fe.position.set(cx, .58, 2); g.add(fe);
  const pa = new THREE.Object3D(); pa.position.set(cx, 5.1, 2 + hr * .866 + .5); g.add(pa); label('w-lot', 'Proving grounds &middot; Actions', pa, '#a78bfa');
  site.extra.piers = new Map(); site.extra.slabs = new Map();
}
// Row i of a half (docks or grounds): its z inside the half, and the x of column j along it.
function rowZ(site, i, n) { return 2 - (n - 1) * 2.5 + i * 5; }
function shipSlot(site, i, j, nRows, nCols) { const hr = site.extra.hr, cx = site.extra.cx; return { x: -cx - hr * .55 + 3.2 + j * 4.6, z: rowZ(site, i, nRows), rot: 0 }; }
function machineSlot(site, i, j, nRows, nCols) { const hr = site.extra.hr, cx = site.extra.cx; return { x: cx - hr * .55 + 3 + j * 4.4, z: rowZ(site, i, nRows), rot: 0 }; }
// One pier per repo in the pool, one slab per repo on the grounds, each with the repo's name at its head.
function syncRepoRows(site, kind, repos) {
  const store = kind === 'pier' ? site.extra.piers : site.extra.slabs, hr = site.extra.hr, cx = site.extra.cx, seen = new Set();
  repos.forEach((repo, i) => {
    seen.add(repo); const z = rowZ(site, i, repos.length), x = kind === 'pier' ? -cx - hr * .55 : cx - hr * .55, len = hr * 1.25;
    let row = store.get(repo);
    if (!row) {
      const m = kind === 'pier' ? box(len, .3, 1.1, mats.wood) : box(len, .2, 3.2, mat(0x353d45)); m.position.set(x + len / 2 - 1, kind === 'pier' ? .65 : .6, z + (kind === 'pier' ? 1.6 : 0)); site.g.add(m);
      if (kind === 'pier') for (let k = 0; k < Math.floor(len / 4); k++) { const post = new THREE.Mesh(new THREE.CylinderGeometry(.12, .14, 1.2, 6), mats.wood); post.position.set(x + 1 + k * 4, .9, z + 2.1); m.parent.add(post); (row = row || { posts: [] }).posts.push(post); }
      row = Object.assign(row || { posts: [] }, { m, z }); const an = new THREE.Object3D(); an.position.set(x - 1.5, 3.4, z); site.g.add(an); row.an = an;
      row.el = label('w-obj w-repo', esc(repo.split('/').pop()), an, kind === 'pier' ? '#3fbfd6' : '#a78bfa'); store.set(repo, row);
      m.scale.set(.01, 1, 1); tween(600, k => m.scale.x = Math.max(.01, k));
    } else if (row.z !== z) { const fz = row.z; row.z = z; tween(700, k => { const nz = fz + (z - fz) * k; row.m.position.z = nz + (kind === 'pier' ? 1.6 : 0); row.an.position.z = nz; row.posts.forEach(p => p.position.z = nz + 2.1); }); }
  });
  for (const [repo, row] of store) if (!seen.has(repo)) { store.delete(repo); dropLabel(row.el); disposeObj(row.m); row.posts.forEach(p => disposeObj(p)); disposeObj(row.an); }
}
const PR_GLYPH = pr => pr.state === 'ready' ? ['✓', '#a6e3a1'] : pr.state === 'changes' || pr.state === 'conflict' ? ['✗', '#f38ba8'] : pr.state === 'behind' ? ['⚓', '#f9e2af'] : pr.needsApproval ? ['!', '#f9e2af'] : pr.state === 'blocked' ? ['■', '#fab387'] : ['○', '#94e2d5'];
const RUN_GLYPH = run => run.state === 'running' ? ['⟳', '#f9e2af'] : run.state === 'success' ? ['✓', '#a6e3a1'] : run.state === 'failure' ? ['✗', '#f38ba8'] : run.state === 'cancelled' ? ['–', '#7d8ca3'] : ['○', '#7d8ca3'];
const shipKey = pr => `${pr.state}|${pr.checks}|${pr.behindBy}|${pr.commitCount}|${pr.needsApproval}`;
function makeShipBody(sh) {
  const pr = sh.pr, st = PR_STATE[pr.state] || PR_STATE.open, sg = new THREE.Group(); sh.g.add(sg); sh.body = sg;
  const hull = box(4.2, 1, 1.9, mats.wood); hull.position.y = .5; const bow = new THREE.Mesh(new THREE.ConeGeometry(.95, 1.6, 4), mats.wood); bow.rotation.z = -Math.PI / 2; bow.position.set(2.9, .5, 0); bow.castShadow = true; const deck = box(4.4, .12, 2.1, mats.stoneDark); deck.position.y = 1.02; sg.add(hull, bow, deck);
  const crates = Math.min(6, Math.ceil((pr.commitCount || 1) / 4)); for (let c = 0; c < crates; c++) { const cr = box(.55, .55, .55, c % 2 ? mats.wood : mats.scaffold); cr.position.set(-1.6 + (c % 3) * .7, 1.36 + Math.floor(c / 3) * .56, c < 3 ? .45 : -.45); sg.add(cr); }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(.07, .09, 4, 6), mats.dark); mast.position.set(.4, 3, 0); sg.add(mast);
  const sail = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 2.2), mat(st.color, { side: THREE.DoubleSide, emissive: st.color, emissiveIntensity: .1 })); sail.position.set(.4, 3.2, 0); sail.rotation.y = Math.PI / 2; sg.add(sail);
  const pc = pr.checks === 'SUCCESS' ? 0xa6e3a1 : pr.checks === 'FAILURE' ? 0xf38ba8 : pr.checks === 'PENDING' ? 0xf9e2af : 0x7d8ca3;
  const pennant = new THREE.Mesh(new THREE.PlaneGeometry(.9, .4), mat(pc, { side: THREE.DoubleSide })); pennant.position.set(.85, 4.9, 0); sg.add(pennant); flags.push(pennant); sh.pennant = pennant;
  if (pr.behindBy > 0) { const chain = new THREE.Mesh(new THREE.CylinderGeometry(.04, .04, 2.6, 4), mats.iron); chain.position.set(-2.6, .3, .6); chain.rotation.z = .6; sg.add(chain); }
  sh.smoke = null; if (pr.checks === 'FAILURE' || pr.state === 'conflict') { sh.smoke = []; for (let k = 0; k < 4; k++) { const s = new THREE.Mesh(new THREE.SphereGeometry(.16, 7, 6), new THREE.MeshStandardMaterial({ color: 0x4a3a3a, transparent: true, opacity: .7 })); sg.add(s); sh.smoke.push({ m: s, ph: k / 4 }); } }
  // Status flag at the masthead: readable from any distance.
  const [gl, gc] = PR_GLYPH(pr); const b = textSprite(gl, gc, 'rgba(8,12,18,.92)', .9); b.position.set(.4, 5.9, 0); sg.add(b); sh.bubble = b;
  // A ship that waits on the commander signals: a light column over the mast and ripples in the water.
  sh.beam = null; sh.ripples = null;
  const want = pr.needsApproval ? 0xf9e2af : pr.state === 'ready' && pr.mine ? 0xa6e3a1 : 0;
  if (want) {
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(.35, .9, 9, 12, 1, true), new THREE.MeshBasicMaterial({ color: want, transparent: true, opacity: .22, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })); beam.position.set(.4, 5.2, 0); sg.add(beam); sh.beam = beam;
    sh.ripples = []; for (let k = 0; k < 3; k++) { const r = new THREE.Mesh(new THREE.RingGeometry(2.4, 2.7, 40), new THREE.MeshBasicMaterial({ color: want, transparent: true, opacity: .5, depthWrite: false, side: THREE.DoubleSide })); r.rotation.x = -Math.PI / 2; r.position.y = -.2; sg.add(r); sh.ripples.push({ m: r, ph: k / 3 }); }
    sh.signal = want;
  }
}
function syncGithub(site, s) {
  const seen = new Set(); const prs = s.prs || [], runs = s.runs || [];
  const prRepos = [...byRepo(prs).keys()].sort(), runRepos = [...byRepo(runs).keys()].sort();
  syncRepoRows(site, 'pier', prRepos); syncRepoRows(site, 'slab', runRepos);
  const shipLabel = pr => `#${pr.number}${pr.author ? ' <span class="w-who">@' + esc(pr.author) + '</span>' : ''}`;
  for (const [repo, list] of byRepo(prs)) list.sort((a, b) => a.number - b.number).forEach((pr, j) => {
    const i = prRepos.indexOf(repo), slot = shipSlot(site, i, j, prRepos.length, list.length); seen.add(pr.key); let sh = ships.get(pr.key);
    if (!sh) {
      const g = new THREE.Group(); site.g.add(g); g.position.set(slot.x - 16, .8, slot.z); g.rotation.y = slot.rot;
      sh = { pr, g, site, ph: Math.random() * 6, key: shipKey(pr), baseY: .8, slot }; ships.set(pr.key, sh); makeShipBody(sh);
      const hit = new THREE.Mesh(new THREE.BoxGeometry(5, 5.4, 2.6), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })); hit.position.y = 2.4; hit.userData.pick = { pr, ship: sh }; g.add(hit); sh.hit = hit; pickables.add(hit);
      sh.el = label('w-obj', shipLabel(pr), g, (PR_STATE[pr.state] || PR_STATE.open).hex, 6.4);
      // Sail in from the open water.
      tween(1400, k => g.position.x = slot.x - 16 + 16 * k, () => { const wp = new THREE.Vector3(); g.getWorldPosition(wp); burst(wp, '#9fd8e8', 12, 2, 1.5); });
    } else {
      sh.pr = pr; const nk = shipKey(pr);
      if (sh.key !== nk) { const pi = flags.indexOf(sh.pennant); if (pi >= 0) flags.splice(pi, 1); disposeObj(sh.body); sh.key = nk; makeShipBody(sh); sh.el.el.style.setProperty('--c', (PR_STATE[pr.state] || PR_STATE.open).hex); const wp = new THREE.Vector3(); sh.g.getWorldPosition(wp); wp.y += 3; burst(wp, (PR_STATE[pr.state] || PR_STATE.open).hex, 12, 1.5, 2); }
      if (sh.slot.x !== slot.x || sh.slot.z !== slot.z) { const f = { ...sh.slot }; sh.slot = slot; tween(900, k => { sh.g.position.x = f.x + (slot.x - f.x) * k; sh.g.position.z = f.z + (slot.z - f.z) * k; }); }
      setLabel(sh.el, shipLabel(pr));
    }
  });
  for (const [k, sh] of ships) if (!seen.has(k)) destroyShip(sh);
  const rseen = new Set();
  const runLabel = run => `${esc(run.name)}${run.runNumber ? ' #' + run.runNumber : ''}${run.actor ? ' <span class="w-who">@' + esc(run.actor) + '</span>' : ''}`;
  for (const [repo, list] of byRepo(runs)) list.forEach((run, j) => {
    const i = runRepos.indexOf(repo), slot = machineSlot(site, i, j, runRepos.length, list.length); rseen.add(run.key); let m = machines.get(run.key);
    if (!m) {
      const g = new THREE.Group(); site.g.add(g); g.position.set(slot.x, .56 - 6, slot.z); g.rotation.y = slot.rot;
      m = { run, g, site, ph: Math.random() * 6, key: run.state, slot }; machines.set(run.key, m); makeMachineBody(m);
      const hit = new THREE.Mesh(new THREE.BoxGeometry(4, 4.6, 3.2), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })); hit.position.y = 2.2; hit.userData.pick = { run, machine: m }; g.add(hit); m.hit = hit; pickables.add(hit);
      m.el = label('w-obj', runLabel(run), g, (RUN_STATE[run.state] || RUN_STATE.none).hex, 5.6);
      tween(800, k => g.position.y = .56 - 6 + 6 * k, () => { const wp = new THREE.Vector3(); g.getWorldPosition(wp); burst(wp, '#cba6f7', 16, 2.5, 2); }, easeOutCubic);
    } else {
      m.run = run;
      if (m.key !== run.state) { disposeObj(m.body); m.key = run.state; makeMachineBody(m); m.el.el.style.setProperty('--c', (RUN_STATE[run.state] || RUN_STATE.none).hex); const wp = new THREE.Vector3(); m.g.getWorldPosition(wp); wp.y += 3.5; burst(wp, (RUN_STATE[run.state] || RUN_STATE.none).hex, 16, 1.5, 2.5); }
      if (m.slot.x !== slot.x || m.slot.z !== slot.z) { const f = { ...m.slot }; m.slot = slot; tween(700, k => { m.g.position.x = f.x + (slot.x - f.x) * k; m.g.position.z = f.z + (slot.z - f.z) * k; }); }
      setLabel(m.el, runLabel(run));
    }
  });
  for (const [k, m] of machines) if (!rseen.has(k)) destroyMachine(m);
  const live = runs.filter(r => r.state === 'running').length, ready = prs.filter(p => p.state === 'ready').length, waiting = prs.filter(p => p.needsApproval).length, failed = runs.filter(r => r.state === 'failure').length;
  setLabel(site.el, `<div class="w-eyebrow">GitHub quarter</div><b>Pull requests &amp; Actions</b><span class="w-cnt">${prs.length} PR${prs.length === 1 ? '' : 's'}${ready ? ' · ' + ready + ' ready' : ''} · ${runs.length} run${runs.length === 1 ? '' : 's'}${live ? ' · ' + live + ' live' : ''}</span>${waiting ? `<span class="w-cnt w-alert">⚑ ${waiting} waiting for your review</span>` : ''}${failed ? `<span class="w-cnt w-alert w-bad">✗ ${failed} run${failed === 1 ? '' : 's'} failed</span>` : ''}`);
}
function makeMachineBody(m) {
  const run = m.run, st = RUN_STATE[run.state] || RUN_STATE.none, mg = new THREE.Group(); m.g.add(mg); m.body = mg;
  const base = hexPrism(1.8, 1.7, mats.stone); base.position.y = .85; const hearth = box(1.2, .8, .1, new THREE.MeshStandardMaterial({ color: 0x120a06, emissive: run.state === 'running' ? 0xff7a2a : 0x000000, emissiveIntensity: 1.4 })); hearth.position.set(0, .7, 1.5); mg.add(base, hearth);
  const chimney = new THREE.Mesh(new THREE.CylinderGeometry(.28, .34, 1.8, 6), mats.stoneDark); chimney.position.set(-1, 2.6, -.6); mg.add(chimney);
  const gear = new THREE.Group(); gear.position.set(.5, 2.9, 0); const wheel = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, .32, 6), mats.iron); wheel.rotation.x = Math.PI / 2; wheel.castShadow = true; gear.add(wheel);
  for (let k = 0; k < 6; k++) { const tooth = box(.34, .4, .3, mats.iron); const an = k * Math.PI / 3; tooth.position.set(Math.cos(an) * 1.15, Math.sin(an) * 1.15, 0); tooth.rotation.z = an; gear.add(tooth); }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(.3, .3, .5, 6), mats.gold); hub.rotation.x = Math.PI / 2; gear.add(hub); mg.add(gear); m.gear = gear;
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(.12, .12, 1.4, 6), mats.dark); axle.position.set(.5, 2.2, 0); mg.add(axle);
  m.lamp = new THREE.MeshStandardMaterial({ color: st.color, emissive: st.color, emissiveIntensity: run.state === 'none' ? .3 : 1.3 }); const lamp = new THREE.Mesh(new THREE.SphereGeometry(.3, 10, 8), m.lamp); lamp.position.set(-1, 3.9, -.6); mg.add(lamp);
  const [gl, gc] = RUN_GLYPH(run); const flag = textSprite(gl, gc, 'rgba(8,12,18,.92)', .9); flag.position.set(.5, 5, 0); mg.add(flag); m.flag = flag;
  if (run.state === 'success') banner(mg, 1.4, 0, -.9, st.color);
  m.smoke = null; if (run.state === 'running' || run.state === 'failure') { m.smoke = []; for (let k = 0; k < 5; k++) { const s = new THREE.Mesh(new THREE.SphereGeometry(.18, 7, 6), new THREE.MeshStandardMaterial({ color: run.state === 'failure' ? 0x4a2a2a : 0x3a3f47, transparent: true, opacity: .7 })); mg.add(s); m.smoke.push({ m: s, ph: k / 5 }); } }
}
function destroyShip(sh, quiet) {
  ships.delete(sh.pr.key); dropLabel(sh.el); pickables.delete(sh.hit); const pi = flags.indexOf(sh.pennant); if (pi >= 0) flags.splice(pi, 1); if (selected.pr === sh.pr) { selected = {}; renderSel(); }
  const g = sh.g, x0 = g.position.x; if (quiet) { disposeObj(g); return; }
  const wp = new THREE.Vector3(); g.getWorldPosition(wp); burst(wp, '#9fd8e8', 14, 2, 1.5); fireworks(wp.clone().setY(wp.y + 9), 4); // a PR closed or merged: send it off
  tween(1400, k => { g.position.x = x0 - 18 * k; g.position.y = .8 - k * k * 2.2; }, () => disposeObj(g), easeInCubic);
}
function destroyMachine(m, quiet) {
  machines.delete(m.run.key); dropLabel(m.el); pickables.delete(m.hit); if (selected.run === m.run) { selected = {}; renderSel(); }
  const g = m.g; if (quiet) { disposeObj(g); return; }
  const wp = new THREE.Vector3(); g.getWorldPosition(wp); burst(wp, '#7d8ca3', 16, 2, 2);
  tween(700, k => { g.position.y = .56 - 6 * k; }, () => disposeObj(g), easeInCubic);
}

/* ────────────────────────── Allied camp (peers) ────────────────────────── */
function buildAllies(site, AR) {
  const g = site.g; site.color = 0x89b4fa;
  const plat = hexPrism(AR, .5, mats.plot); plat.position.y = .25; g.add(plat); g.add(hexEdge(AR, .52, 0x89b4fa, .7)); site.plat = plat; plat.userData.pick = { site };
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(.12, .2, 9, 6), mats.dark); mast.position.set(0, 5, -6); g.add(mast);
  const sig = new THREE.Mesh(new THREE.SphereGeometry(.4, 10, 8), new THREE.MeshStandardMaterial({ color: 0x89b4fa, emissive: 0x89b4fa, emissiveIntensity: 1.4 })); sig.position.set(0, 9.7, -6); g.add(sig); beacons.push(sig);
  const anchor = new THREE.Object3D(); anchor.position.set(0, 12.3, -6); g.add(anchor); site.el = label('w-site', '', anchor, '#89b4fa');
}
function syncAllies(site, s) {
  const peers = s.peers || [], seen = new Set();
  peers.forEach((peer, i) => {
    seen.add(peer.name); let t = tents.get(peer.name); const x = (i - (peers.length - 1) / 2) * 6.2, z = 2;
    if (!t) {
      const tg = new THREE.Group(); tg.position.set(x, .56, z); site.g.add(tg); t = { peer, g: tg, site, key: null }; tents.set(peer.name, t); makeTentBody(t);
      const hit = new THREE.Mesh(new THREE.BoxGeometry(5, 3.5, 5), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })); hit.position.y = 1.5; hit.userData.pick = { peer, tent: t }; tg.add(hit); t.hit = hit; pickables.add(hit);
      t.el = label('w-obj', esc(peer.name), tg, peer.connected ? '#89b4fa' : '#7d8ca3', 4.4);
      tg.scale.setScalar(.01); tween(600, k => tg.scale.setScalar(Math.max(.01, k)), null, easeOutBack);
    } else { t.peer = peer; const nk = String(!!peer.connected); if (t.key !== nk) { disposeObj(t.body); makeTentBody(t); t.el.el.style.setProperty('--c', peer.connected ? '#89b4fa' : '#7d8ca3'); } if (t.g.position.x !== x) { const fx = t.g.position.x; tween(600, k => t.g.position.x = fx + (x - fx) * k); } }
  });
  for (const [k, t] of tents) if (!seen.has(k)) destroyTent(t);
  const on = peers.filter(p => p.connected).length, afield = peers.reduce((a, p) => a + (p.agents || 0), 0);
  setLabel(site.el, `<div class="w-eyebrow">Allied camp</div><b>Peers</b><span class="w-cnt">${on}/${peers.length} online${afield ? ' · ' + afield + ' units afield' : ''}</span>`);
}
function makeTentBody(t) {
  const tg = new THREE.Group(); t.g.add(tg); t.body = tg; t.key = String(!!t.peer.connected);
  const tent = new THREE.Mesh(new THREE.ConeGeometry(2.6, 2.6, 6), t.peer.connected ? mats.canvas : mat(0x6f6a60)); tent.position.y = 1.3; tent.rotation.y = Math.PI / 6; tent.castShadow = true; tg.add(tent);
  const flap = box(.9, 1.2, .1, mats.dark); flap.position.set(0, .6, 2.05); tg.add(flap);
  banner(tg, 2.2, 0, -1.5, t.peer.connected ? 0x89b4fa : 0x555c66);
}
function destroyTent(t, quiet) { tents.delete(t.peer.name); dropLabel(t.el); pickables.delete(t.hit); if (selected.peer === t.peer) { selected = {}; renderSel(); } const g = t.g; if (quiet) { disposeObj(g); return; } tween(400, k => g.scale.setScalar(Math.max(.01, 1 - k)), () => disposeObj(g), easeInCubic); }

/* ────────────────────────── Sync entry point ────────────────────────── */
W.sync = function (s) {
  if (!alive) return; snap = s;
  const plan = planSites(s), seen = new Set();
  for (const p of plan) { seen.add(p.key); let site = sites.get(p.key); if (!site) site = createSite(p); syncSite(site, p, s); }
  for (const p of plan) { const site = sites.get(p.key); if (site && (site.x !== p.x || site.z !== p.z)) { const fx = site.x, fz = site.z; site.x = p.x; site.z = p.z; tween(700, k => site.g.position.set(fx + (p.x - fx) * k, site.g.position.y, fz + (p.z - fz) * k)); } }
  for (const [k, site] of sites) if (!seen.has(k)) destroySite(site);
  layoutTerrain([...sites.values()].map(st => ({ x: st.x, z: st.z, R: st.R })));
  // Until the commander pans or zooms, keep the whole settlement framed.
  if (!cam.userMoved && sites.size) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const st of sites.values()) { minX = Math.min(minX, st.x - st.R); maxX = Math.max(maxX, st.x + st.R); minZ = Math.min(minZ, st.z - st.R); maxZ = Math.max(maxZ, st.z + st.R); }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2 + 2, span = Math.max(maxX - minX, (maxZ - minZ) * 1.6), zoom = Math.min(3, Math.max(1.1, span / 34));
    const fx = cam.target.x, fz = cam.target.z, fzoom = cam.zoom; if (Math.abs(fx - cx) > .5 || Math.abs(fz - cz) > .5 || Math.abs(fzoom - zoom) > .05) tween(900, k => { if (cam.userMoved) return; cam.target.x = fx + (cx - fx) * k; cam.target.z = fz + (cz - fz) * k; cam.zoom = fzoom + (zoom - fzoom) * k; });
  }
  // Selection follows the app's selected agent whenever that changes; a ship or machine picked here stays picked otherwise.
  if (s.selectedId !== lastSel) { lastSel = s.selectedId; const u = s.selectedId != null ? units.get(s.selectedId) : null; if (u) select({ unit: u }); else if (selected.unit) select({}); }
  else if (selected.unit) renderSel(); // stats may have changed
  // A selected ship, machine or tent points at the object from the latest snapshot; the bar re-renders when its facts
  // change (a button label set by a click, like "Updating…", therefore clears exactly when the PR list comes back).
  if (selected.pr) { const np = (s.prs || []).find(p => p.key === selected.pr.key); if (!np) select({}); else { const sig = np.actionsHtml + np.state + np.checks + np.behindBy + np.commitCount + np.reviewDecision; if (selected.pr !== np || sig !== selSig) { selected.pr = np; selSig = sig; renderSel(); } } }
  else if (selected.run) { const nr = (s.runs || []).find(r => r.key === selected.run.key); if (!nr) select({}); else { const sig = nr.actionsHtml + nr.state + nr.runNumber; if (selected.run !== nr || sig !== selSig) { selected.run = nr; selSig = sig; renderSel(); } } }
  else if (selected.peer) { const npr = (s.peers || []).find(p => p.name === selected.peer.name); if (!npr) select({}); else { const sig = String(npr.connected) + npr.agents; if (selected.peer !== npr || sig !== selSig) { selected.peer = npr; selSig = sig; renderSel(); } } }
  else if (selected.site && !sites.has(selected.site.key)) select({});
};

/* ────────────────────────── Selection & input ────────────────────────── */
const raycaster = () => new THREE.Raycaster();
function pick(ev) {
  const r = canvas.getBoundingClientRect(), ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  const rc = raycaster(); rc.setFromCamera(ndc, camera);
  const a = rc.intersectObjects([...pickables])[0]; if (a) return a.object.userData.pick;
  const b = rc.intersectObjects([...sites.values()].map(s => s.plat).filter(Boolean))[0]; if (b) return b.object.userData.pick; return {};
}
function flyTo(obj) { const p = new THREE.Vector3(); obj.getWorldPosition(p); cam.target.copy(p); }
function select(what) {
  selected = what || {}; selSig = ''; renderSel();
  for (const sh of ships.values()) sh.el.el.classList.toggle('sel', sh.pr === selected.pr);
  for (const m of machines.values()) m.el.el.classList.toggle('sel', m.run === selected.run);
  for (const t of tents.values()) t.el.el.classList.toggle('sel', t.peer === selected.peer);
}
function bindInput() {
  const keys = new Set(); let drag = null;
  stage.addEventListener('contextmenu', e => e.preventDefault());
  stage.addEventListener('pointerenter', () => cam.hover = true); stage.addEventListener('pointerleave', () => { cam.hover = false; keys.clear(); });
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, moved: false, btn: e.button }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) { stage.classList.add('grabbing'); cam.userMoved = true; const k = .034 * cam.zoom, s = Math.sin(cam.yaw), c = Math.cos(cam.yaw); cam.target.x -= (dx * c + dy * s) * k; cam.target.z -= (dy * c - dx * s) * k; drag.x = e.clientX; drag.y = e.clientY; } return; }
    const r = pick(e); hovered = r.unit || null; canvas.style.cursor = Object.keys(r).length ? 'pointer' : 'default';
  });
  canvas.addEventListener('pointerup', e => {
    const d = drag; drag = null; stage.classList.remove('grabbing'); if (!d || d.moved) return;
    const r = pick(e);
    if (d.btn === 2) { if (r.unit && !r.unit.mini) hooks.agentMenu && hooks.agentMenu(e, r.unit.a.id); return; }
    if (d.btn !== 0) return;
    if (r.unit) { if (r.unit.mini) { select({ unit: r.unit }); hooks.focusTeamMember && hooks.focusTeamMember(r.unit.a.teamName, r.unit.a.memberName, false); } else { select({ unit: r.unit }); hooks.selectAgent && hooks.selectAgent(r.unit.a.id); } }
    else if (r.pr) select({ pr: r.pr }); else if (r.run) select({ run: r.run }); else if (r.peer) select({ peer: r.peer }); else if (r.site) select({ site: r.site }); else select({});
  });
  canvas.addEventListener('dblclick', e => { const r = pick(e); if (r.unit && !r.unit.mini) { flyTo(r.unit.g); hooks.openAgent && hooks.openAgent(r.unit.a.id); } else if (r.pr) hooks.openPr && hooks.openPr(r.pr.url); else if (r.run) hooks.openRun && hooks.openRun(r.run.url); else if (r.peer) hooks.openChat && hooks.openChat(r.peer.name); });
  canvas.addEventListener('wheel', e => { e.preventDefault(); if (e.ctrlKey) return; cam.userMoved = true; cam.zoom = Math.min(3.2, Math.max(.4, cam.zoom * (e.deltaY > 0 ? 1.1 : .91))); }, { passive: false });
  const onKey = e => { if (!cam.hover || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return; const k = e.key.toLowerCase(); if ('wasdqe'.includes(k) || k.startsWith('arrow')) { keys.add(k); cam.userMoved = true; } };
  addEventListener('keydown', onKey); addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
  miniEl.addEventListener('pointerdown', e => { cam.userMoved = true; const r = miniEl.getBoundingClientRect(); cam.target.x = ((e.clientX - r.left) / r.width - .5) * terrain.rx * 2.3; cam.target.z = ((e.clientY - r.top) / r.height - .5) * terrain.rz * 2.3; });
  cam.keys = keys;
}
function updateCamera(dt) {
  const keys = cam.keys, sp = 24 * dt * cam.zoom, s = Math.sin(cam.yaw), c = Math.cos(cam.yaw); let mx = 0, mz = 0;
  if (keys.has('w') || keys.has('arrowup')) mz -= 1; if (keys.has('s') || keys.has('arrowdown')) mz += 1; if (keys.has('a') || keys.has('arrowleft')) mx -= 1; if (keys.has('d') || keys.has('arrowright')) mx += 1;
  cam.target.x += (mx * c + mz * s) * sp; cam.target.z += (mz * c - mx * s) * sp;
  if (keys.has('q')) cam.yaw += dt * 1.4; if (keys.has('e')) cam.yaw -= dt * 1.4;
  const lim = terrain ? { x: terrain.rx * 1.1, z: terrain.rz * 1.1 } : { x: 60, z: 40 };
  cam.target.x = Math.max(-lim.x, Math.min(lim.x, cam.target.x)); cam.target.z = Math.max(-lim.z, Math.min(lim.z, cam.target.z)); cam.target.y = PLAT;
  const off = cam.base.clone().multiplyScalar(cam.zoom).applyAxisAngle(new THREE.Vector3(0, 1, 0), cam.yaw);
  camera.position.copy(cam.target).add(off); camera.lookAt(cam.target);
  const pos = hooks.miniSlot && hooks.miniSlot.querySelector('#world-mini-pos'); if (pos) { const txt = `${Math.round(cam.target.x)}, ${Math.round(cam.target.z)}`; if (pos.textContent !== txt) pos.textContent = txt; }
}

/* ────────────────────────── Selection bar ────────────────────────── */
const ob = (g, label, cmd, o = {}) => `<button class="w-btn${o.cls ? ' ' + o.cls : ''}" ${o.off ? 'disabled' : ''} data-cmd="${cmd}"><span class="g">${g}</span>${label}</button>`;
const ctxCls = c => c >= 80 ? 'danger' : c >= 60 ? 'warn' : '';
function renderSel() {
  let h = '';
  if (selected.unit) {
    const u = selected.unit, a = u.a, st = STATUS[a.status], spec = u.lot.spec, crumb = spec.kind === 'feature' ? `Feature <b>${esc(u.lot.site.name || '')}</b> &middot; ${esc(spec.title)}` : `Workshop <b>${esc(spec.title)}</b>${spec.branch ? ' &middot; ' + esc(spec.branch) : ''}`;
    if (u.mini) h = `<div class="w-portrait" style="--c:${hexStr(spec.color)}">S</div><div class="w-main" style="--c:${hexStr(spec.color)};--sc:var(--w-working)"><div class="w-crumb">${crumb} &middot; crew of ${esc(u.lead.a.title)}</div><h2>${esc(a.title)}</h2><div class="w-act">⚒ ${esc(a.verb || 'Working')}</div></div><div class="w-orders">${ob('&#x25A3;', 'Terminal', 'crewTerm')}</div>`;
    else h = `<div class="w-portrait" style="--c:${hexStr(spec.color)}">${(a.model || 's')[0].toUpperCase()}</div>
      <div class="w-main" style="--c:${hexStr(spec.color)};--sc:var(${st.css})"><div class="w-crumb">${crumb}${a.team ? ' &middot; leads ' + a.team.members.length + (a.team.total ? ' (' + a.team.done + '/' + a.team.total + ' tasks)' : '') : ''}</div><h2>${esc(a.title)}</h2><div class="w-act">${st.sym} ${esc(activity(a))}${a.currentFileName ? ' · ' + esc(a.currentFileName) : ''}${a.looping ? ' · looping' : ''}</div></div>
      <div class="w-stats"><div class="w-stat"><span class="k">Context ${a.ctxPct}%</span><div class="w-bar ${ctxCls(a.ctxPct)}"><i style="width:${a.ctxPct}%"></i></div></div><div class="w-stat"><span class="k">Model</span><span class="v">${esc(a.model || '?')}</span></div><div class="w-stat"><span class="k">Cost</span><span class="v" style="color:var(--w-gold)">${esc(a.costStr || '')}</span></div></div>
      <div class="w-orders">${ob('&#x25A3;', 'Terminal', 'term') + ob('&#x2699;', 'Model', 'model') + ob('&#x25B2;', 'Effort', 'effort') + (a.looping ? ob('&#x25A0;', 'Stop loop', 'stoploop', { cls: 'danger' }) : '') + ob('&#x2715;', 'Close', 'close', { cls: 'danger' }) + ob('&#x22EF;', 'More', 'menu')}</div>`;
  } else if (selected.site) {
    const s = selected.site, first = [...s.lots.values()][0];
    if (s.kind === 'feature' || s.kind === 'workshop') h = `<div class="w-portrait" style="--c:${hexStr(s.color)}">${s.kind === 'feature' ? '&#x2691;' : '&#x2302;'}</div><div class="w-main" style="--c:${hexStr(s.color)};--sc:var(--dim)"><div class="w-crumb">${s.kind === 'feature' ? 'Feature &middot; <b>' + s.lots.size + ' repo' + (s.lots.size === 1 ? '' : 's') + '</b>' : 'Workshop &middot; <b>directory</b>'}</div><h2>${esc(s.kind === 'feature' ? s.name : first?.spec.title || '')}</h2><div class="w-act">${[...s.lots.values()].map(l => esc(l.spec.title) + (l.spec.server ? ' · :' + l.spec.port : '')).join(' · ')}</div></div><div class="w-orders">${ob('+', 'Agent', 'addAgent') + ob('&#x1F4C2;', 'Folder', 'folder')}</div>`;
    else if (s.kind === 'github') h = `<div class="w-portrait" style="--c:#c9d1d9">GH</div><div class="w-main" style="--c:#c9d1d9;--sc:var(--dim)"><div class="w-crumb">GitHub quarter</div><h2>Pull requests &amp; Actions</h2><div class="w-act">Ships are open PRs, machines are tracked workflow runs. Double-click one to open it on GitHub.</div></div>`;
    else h = `<div class="w-portrait" style="--c:#89b4fa">&#x21C4;</div><div class="w-main" style="--c:#89b4fa;--sc:var(--dim)"><div class="w-crumb">Allied camp</div><h2>Peers</h2><div class="w-act">Tents are paired Overlords on your LAN. Double-click one to chat.</div></div>`;
  } else if (selected.pr) {
    const pr = selected.pr, st = PR_STATE[pr.state] || PR_STATE.open;
    h = `<div class="w-portrait" style="--c:${st.hex}">&#x2693;</div><div class="w-main" style="--c:#3fbfd6;--sc:${st.hex}"><div class="w-crumb">GitHub quarter &middot; <b>pull request</b> &middot; ${esc(pr.repo)}${pr.author ? ' &middot; by ' + esc(pr.author) : ''}</div><h2>#${pr.number} ${esc(pr.title)}</h2><div class="w-act">${st.label}${pr.headRef ? ' · ' + esc(pr.headRef) + ' → ' + esc(pr.baseRef) : ''}${pr.needsApproval ? ' · waiting for your review' : ''}</div></div>
      <div class="w-stats"><div class="w-stat"><span class="k">Checks</span><span class="v">${esc((pr.checks || '?').toLowerCase())}</span></div><div class="w-stat"><span class="k">Commits</span><span class="v">${pr.commitCount || 0}</span></div><div class="w-stat"><span class="k">Behind</span><span class="v" style="${pr.behindBy ? 'color:var(--w-perm)' : ''}">${pr.behindBy || 0}</span></div><div class="w-stat"><span class="k">Review</span><span class="v">${pr.reviewDecision === 'APPROVED' ? '✓ ' + (pr.approvedBy || []).length : pr.reviewDecision === 'CHANGES_REQUESTED' ? '✗ ' + (pr.changesBy || []).length : '<em>none</em>'}</span></div></div>
      <div class="w-orders w-orders-html">${pr.actionsHtml || ''}${ob('&#x2197;', 'GitHub', 'openPr')}</div>`;
  } else if (selected.run) {
    const r = selected.run, st = RUN_STATE[r.state] || RUN_STATE.none;
    h = `<div class="w-portrait" style="--c:${st.hex}">&#x2699;</div><div class="w-main" style="--c:#a78bfa;--sc:${st.hex}"><div class="w-crumb">GitHub quarter &middot; <b>workflow run</b> &middot; ${esc(r.repo)}${r.runNumber ? ' &middot; #' + r.runNumber : ''}</div><h2>${esc(r.name)}</h2><div class="w-act">${st.label}${r.branch ? ' · ⑂ ' + esc(r.branch) : ''}${r.title ? ' · ' + esc(r.title) : ''}</div></div>
      <div class="w-stats"><div class="w-stat"><span class="k">By</span><span class="v">${r.actor ? '@' + esc(r.actor) : '<em>?</em>'}</span></div><div class="w-stat"><span class="k">Started</span><span class="v">${r.startedAt ? esc(new Date(r.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : '<em>?</em>'}</span></div></div>
      <div class="w-orders w-orders-html">${r.actionsHtml || ob('&#x2197;', 'Open run', 'openRun', { off: !r.url })}</div>`;
  } else if (selected.peer) {
    const p = selected.peer;
    h = `<div class="w-portrait" style="--c:${p.connected ? 'var(--w-working)' : 'var(--w-idle)'}">&#x21C4;</div><div class="w-main" style="--c:var(--w-working);--sc:var(--dim)"><div class="w-crumb">Allied camp &middot; <b>peer Overlord</b> &middot; ${p.connected ? 'online' : 'offline'}</div><h2>${esc(p.name)}</h2><div class="w-act">${p.agents ? p.agents + ' unit' + (p.agents === 1 ? '' : 's') + ' afield' : 'no units reported'}${p.host ? ' · ' + esc(p.host) + ':' + p.port : ''}</div></div><div class="w-orders">${ob('&#x1F5E8;', 'Chat', 'chat')}</div>`;
  }
  selEl.hidden = !h; selEl.innerHTML = h ? h + '<button class="w-close" title="Deselect">&times;</button>' : '';
  if (!h) return;
  selEl.querySelector('.w-close').onclick = () => select({});
  selEl.querySelectorAll('[data-cmd]').forEach(b => b.onclick = ev => command(b.dataset.cmd, ev));
}
function command(cmd, ev) {
  const u = selected.unit, a = u && u.a, id = a && a.id;
  switch (cmd) {
    case 'term': hooks.openAgent && hooks.openAgent(id); break;
    case 'crewTerm': hooks.focusTeamMember && hooks.focusTeamMember(a.teamName, a.memberName, false); break;
    case 'model': hooks.showModelMenu && hooks.showModelMenu(ev, id); break;
    case 'effort': hooks.showEffortMenu && hooks.showEffortMenu(ev, id); break;
    case 'stoploop': hooks.stopLoop && hooks.stopLoop(id); break;
    case 'close': hooks.closeAgent && hooks.closeAgent(id); break;
    case 'menu': hooks.agentMenu && hooks.agentMenu(ev, id); break;
    case 'addAgent': { const cwd = [...selected.site.lots.values()][0]?.cwd; if (cwd && hooks.addAgent) hooks.addAgent(cwd); break; }
    case 'folder': { const cwd = [...selected.site.lots.values()][0]?.cwd; if (cwd && hooks.openFolder) hooks.openFolder(cwd); break; }
    case 'openPr': hooks.openPr && hooks.openPr(selected.pr.url); break;
    case 'openRun': hooks.openRun && hooks.openRun(selected.run.url); break;
    case 'chat': hooks.openChat && hooks.openChat(selected.peer.name); break;
  }
}

/* ────────────────────────── Animation ────────────────────────── */
function animateUnit(u, t, dt) {
  const { p: m, inner, a } = u, s = a.status, T = reduceMotion() ? 0 : t;
  m.armL.rotation.set(0, 0, 0); m.armR.rotation.set(0, 0, 0); inner.rotation.set(0, u.face, 0); inner.position.y = 0; inner.scale.setScalar(u.scale); m.head.rotation.set(0, 0, 0);
  m.ring.material.opacity = u === selected.unit ? .95 : u === hovered ? .5 : 0; m.disc.scale.setScalar(1); m.disc.material.opacity = .32;
  if (m.think) { m.think.position.y = 2.6 * u.scale + Math.sin(T * 2.2 + u.phase) * .08; m.think.position.x = .35 * u.scale; }
  switch (s) {
    case 'active': case 'settling': {
      // Every so often a working unit leaves its bench for a short errand across the lot, then comes back to hammer.
      if (!reduceMotion() && !u.mini) {
        if (!u.walk && Math.random() < dt / 9) { const lim = u.lot.R - 1.8; let ang = Math.random() * Math.PI * 2, r = 2 + Math.random() * 2.5, tx = u.tx + Math.cos(ang) * r, tz = u.tz + Math.sin(ang) * r; if (Math.hypot(tx, tz) > lim) { r *= .4; tx = u.tx + Math.cos(ang) * r; tz = u.tz + Math.sin(ang) * r; } u.walk = { fx: u.tx, fz: u.tz, tx, tz, t: 0, dur: Math.max(.6, r / 2), back: false, pause: 0 }; }
        if (u.walk) {
          const w = u.walk;
          if (w.pause > 0) { w.pause -= dt; m.head.rotation.x = .25; m.armL.rotation.x = .2; m.armR.rotation.x = .2; }
          else {
            w.t += dt; const k = Math.min(1, w.t / w.dur), ax = w.back ? w.tx : w.fx, az = w.back ? w.tz : w.fz, bx = w.back ? w.fx : w.tx, bz = w.back ? w.fz : w.tz;
            u.g.position.x = ax + (bx - ax) * k; u.g.position.z = az + (bz - az) * k; inner.rotation.y = Math.atan2(bx - ax, bz - az);
            const st = Math.sin(T * 11); m.legL.rotation.x = st * .55; m.legR.rotation.x = -st * .55; m.armL.rotation.x = -st * .45; m.armR.rotation.x = st * .45; inner.position.y = Math.abs(st) * .05;
            if (k >= 1) { if (!w.back) { w.back = true; w.t = 0; w.pause = .8 + Math.random(); } else { u.walk = null; u.g.position.set(u.tx, u.g.position.y, u.tz); } }
          }
          break;
        }
      }
      m.legL.rotation.x = 0; m.legR.rotation.x = 0;
      const sp = s === 'active' ? 9 : 4, ph = Math.sin(T * sp + u.phase); m.armR.rotation.x = -1.2 + ph * .8; m.armL.rotation.x = .35; inner.position.y = Math.max(0, -ph) * .03;
      if (m.sparks && !reduceMotion()) { if (ph > .97 && !u.sparked) { u.sparked = true; for (const k of m.sparks) { k.life = .35 + Math.random() * .2; k.m.position.set((Math.random() - .5) * .3, .75, .95); k.v.set((Math.random() - .5) * 3, 2 + Math.random() * 2, (Math.random() - .5) * 3); } } if (ph < 0) u.sparked = false; for (const k of m.sparks) { if (k.life <= 0) { k.m.visible = false; continue; } k.life -= dt; k.m.visible = true; k.v.y -= 12 * dt; k.m.position.addScaledVector(k.v, dt); } } break; }
    case 'permission': case 'question': m.armR.rotation.x = -2.9 + Math.sin(T * 7 + u.phase) * .18; m.armR.rotation.z = -.35; inner.position.y = Math.abs(Math.sin(T * 5 + u.phase)) * .12; m.bubble.position.y = 2.55 * u.scale + Math.sin(T * 3 + u.phase) * .1; { const k = .5 + .5 * Math.sin(T * 4 + u.phase); m.disc.scale.setScalar(1 + k * .4); m.disc.material.opacity = .25 + k * .35; } break;
    case 'waiting': case 'idle':
      if (u.cheerUntil && t < u.cheerUntil) { m.armL.rotation.x = -3; m.armR.rotation.x = -3; inner.position.y = Math.abs(Math.sin(T * 6)) * .35; inner.rotation.y = u.face + Math.sin(T * 3) * .3; break; }
      if (a.idleMin >= IDLE_CALL_MIN && !u.mini) { idleCall(u, t, T); break; }
      if (s === 'waiting') { inner.scale.y = u.scale * (1 + Math.sin(T * 2 + u.phase) * .015); m.armL.rotation.x = .2; m.armR.rotation.x = .2; m.head.rotation.y = Math.sin(T * .6 + u.phase) * .6; m.legL.rotation.x = 0; m.legR.rotation.x = 0; }
      else { inner.rotation.z = Math.sin(T * .9 + u.phase) * .06; m.head.rotation.x = .38 + Math.sin(T * 1.2) * .04; m.armL.rotation.x = .25; m.armR.rotation.x = .25; const f = ((T * .35 + u.phase) % 1 + 1) % 1; m.bubble.position.set(.35 + f * .3, 2.1 + f * .9, 0); m.bubble.material.opacity = 1 - f; }
      break;
    case 'crashed': inner.rotation.z = -Math.PI / 2 + .1; inner.rotation.y = u.face + .6; inner.position.y = .38; m.armL.rotation.x = -.4; m.armR.rotation.x = .6; for (const sm of m.smoke) { const f = ((T * .3 + sm.ph) % 1 + 1) % 1; sm.m.position.set(.4 + Math.sin(f * 6 + sm.ph * 9) * .15 - f * .3, .4 + f * 1.8, .2 + Math.cos(f * 5) * .15); sm.m.scale.setScalar(.6 + f * 1.3); sm.m.material.opacity = .65 * (1 - f); } m.bubble.position.set(0, 1.6, 0); break;
    case 'resuming': inner.rotation.y = T * 3.2; inner.position.y = .12 + Math.abs(Math.sin(T * 4)) * .14; m.arc.rotation.z = -T * 2.4; m.bubble.material.rotation = -T * 2; break;
  }
}
const v3 = () => new THREE.Vector3();
function updateLabels() {
  const w = canvas.clientWidth, h = canvas.clientHeight, p = v3(); labelsEl.classList.toggle('far', cam.zoom > 2.4); labelsEl.classList.toggle('near', cam.zoom < 1.05);
  const place = (el, v) => { if (v.z > 1) { el.style.opacity = 0; return; } el.style.opacity = 1; el.style.transform = `translate(${(v.x + 1) / 2 * w}px, ${(1 - v.y) / 2 * h}px) translate(-50%, -100%)`; };
  for (const a of anchors) { if (!a.obj) continue; a.obj.getWorldPosition(p); p.y += a.dy || 0; p.project(camera); place(a.el, p); }
  const u = selected.unit || hovered;
  if (u !== cardFor) { cardFor = u; card.hidden = !u; if (u) { const a = u.a, st = STATUS[a.status]; card.style.setProperty('--c', `var(${st.css})`); card.className = 'w-lab w-card' + (u === selected.unit ? ' sel' : ''); card.innerHTML = `<b>${esc(a.title)}</b><small>${st.sym} ${esc(activity(a))}</small>${u.mini ? '' : `<div class="w-meta"><span>ctx ${a.ctxPct}%</span><div class="w-bar ${ctxCls(a.ctxPct)}"><i style="width:${a.ctxPct}%"></i></div><span>${esc(a.model || '')}</span><span style="color:var(--w-gold)">${esc(a.costStr || '')}</span></div>`}`; } }
  else if (u && card.dataset.k !== u.key + a_ctx(u)) { /* cheap refresh when the same unit changes */ cardFor = null; }
  if (u) { u.g.getWorldPosition(p); p.y += (u.p.bubble ? 3.1 : 2.4) * u.scale; p.project(camera); place(card, p); u.pill.el.style.opacity = 0; card.dataset.k = u.key + a_ctx(u); }
}
const a_ctx = u => '|' + u.a.ctxPct + '|' + u.a.costStr + '|' + (u.a.verb || '');
function drawMinimap() {
  const mg = miniEl.getContext('2d'), Wm = miniEl.width, Hm = miniEl.height, rx = terrain.rx * 1.15, rz = terrain.rz * 1.15, X = x => (x / rx / 2 + .5) * Wm, Z = z => (z / rz / 2 + .5) * Hm, p = v3();
  mg.fillStyle = '#0d1a2a'; mg.fillRect(0, 0, Wm, Hm);
  mg.fillStyle = '#2b5b3e'; mg.beginPath(); mg.ellipse(Wm / 2, Hm / 2, Wm / 2 / 1.15, Hm / 2 / 1.15, 0, 0, Math.PI * 2); mg.fill();
  const hexPath = (cx, cy, r) => { mg.beginPath(); for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; k ? mg.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a)) : mg.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a)); } mg.closePath(); };
  for (const s of sites.values()) { hexPath(X(s.x), Z(s.z), s.R * Wm / rx / 2); mg.fillStyle = 'rgba(60,74,82,.95)'; mg.fill(); mg.strokeStyle = hexStr(s.color || 0xc9d1d9); mg.lineWidth = 1.5; mg.stroke(); }
  const dot = (o, hex, r, on) => { o.getWorldPosition(p); hexPath(X(p.x), Z(p.z), r); mg.fillStyle = hex; mg.fill(); if (on) { mg.strokeStyle = '#fff'; mg.lineWidth = 1.2; hexPath(X(p.x), Z(p.z), r + 2.5); mg.stroke(); } };
  for (const sh of ships.values()) dot(sh.g, (PR_STATE[sh.pr.state] || PR_STATE.open).hex, 3, sh.pr === selected.pr);
  for (const m of machines.values()) dot(m.g, (RUN_STATE[m.run.state] || RUN_STATE.none).hex, 3, m.run === selected.run);
  for (const u of units.values()) dot(u.g, hexStr(STATUS[u.a.status].hex), u.mini ? 1.6 : 3, u === selected.unit);
  const vw = 30 * cam.zoom * (canvas.clientWidth / Math.max(1, canvas.clientHeight)) * .78 * Wm / rx / 2, vh = 22 * cam.zoom * Hm / rz / 2;
  mg.save(); mg.translate(X(cam.target.x), Z(cam.target.z)); mg.rotate(-cam.yaw); mg.strokeStyle = 'rgba(214,165,69,.9)'; mg.lineWidth = 1.5; mg.beginPath(); mg.moveTo(-vw / 2 * .8, -vh / 2); mg.lineTo(vw / 2 * .8, -vh / 2); mg.lineTo(vw / 2, vh / 2); mg.lineTo(-vw / 2, vh / 2); mg.closePath(); mg.stroke(); mg.restore();
}
function tick(now) {
  if (!alive) return; raf = requestAnimationFrame(tick);
  const dt = Math.min(.05, (now - lastT) / 1000); lastT = now; const t = now / 1000;
  runTweens(now); updateCamera(dt); updateTerrain(dt); runPuffs(dt);
  for (const u of units.values()) if (u.p) animateUnit(u, t, dt);
  if (!reduceMotion()) {
    flags.forEach((f, i) => { f.rotation.y = Math.sin(t * 2.2 + i) * .18; }); for (const b of beacons) b.material.emissiveIntensity = 1 + (b.userData.nightBoost || 0) + Math.sin(t * 3) * .7;
    for (const c of cranes) { c.jib.rotation.y = Math.sin(t * .35 + c.ph) * .9; c.block.position.y = -2.4 + Math.sin(t * .7 + c.ph) * .5; }
    for (const sh of ships.values()) { sh.g.position.y = sh.baseY + Math.sin(t * 1.1 + sh.ph) * .08; sh.g.rotation.z = Math.sin(t * .8 + sh.ph) * .035 + (sh.pr.behindBy ? .1 : 0); if (sh.smoke) for (const sm of sh.smoke) { const f = ((t * .3 + sm.ph) % 1 + 1) % 1; sm.m.position.set(-1.5 + f * .4, 1.4 + f * 1.6, Math.sin(f * 7) * .2); sm.m.scale.setScalar(.6 + f * 1.2); sm.m.material.opacity = .6 * (1 - f); }
      if (sh.beam) { const k = .5 + .5 * Math.sin(t * 2.6 + sh.ph); sh.beam.material.opacity = .12 + k * .22; sh.beam.scale.set(1 + k * .25, 1, 1 + k * .25); sh.bubble.scale.setScalar(.9 + k * .35); sh.bubble.position.y = 5.9 + k * .3; for (const r of sh.ripples) { const f = ((t * .45 + r.ph) % 1 + 1) % 1; r.m.scale.setScalar(.6 + f * 1.6); r.m.material.opacity = .55 * (1 - f); } } }
    for (const m of machines.values()) { if (m.run.state === 'running') { m.gear.rotation.z = t * 1.6 + m.ph; m.lamp.emissiveIntensity = 1 + Math.sin(t * 5 + m.ph) * .6; } if (m.smoke) for (const sm of m.smoke) { const f = ((t * (m.run.state === 'failure' ? .22 : .4) + sm.ph) % 1 + 1) % 1; sm.m.position.set(-1 + Math.sin(f * 6 + sm.ph * 9) * .2, 3.5 + f * 2.2, -.6); sm.m.scale.setScalar(.5 + f * 1.4); sm.m.material.opacity = .65 * (1 - f); } }
    for (const s of sites.values()) if (s.extra.mark) s.extra.mark.position.y = s.extra.markY + Math.sin(t * 1.2) * .25;
    for (const m of machines.values()) if (m.flag && m.run.state === 'running') m.flag.material.rotation = -t * 2;
  }
  updateLife(t, dt);
  renderer.render(scene, camera); updateLabels(); drawMinimap();
}

/* ────────────────────────── Life: daylight, creatures, idle calls, celebrations, treasury ────────────────────────── */
const life = { clouds: [], birds: [], flies: [], fish: null, torches: [], chimneys: [], flyHomes: [], dayK: 1, lastDay: -1 };
const IDLE_CALL_MIN = 5;
const PHRASES = ['Standing by, commander.', 'Anything else?', 'Ready for orders!', 'All quiet here.', 'Shall I keep going?', 'Awaiting instructions…', 'Free for a new task.', 'Done. What next?', 'Idle hands, commander.'];
function softSprite(w, h, draw, opacity = 1) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d')); const tex = new THREE.CanvasTexture(c); return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity, depthWrite: false })); }
function speechSprite(text) {
  const s = softSprite(320, 80, g => { g.fillStyle = 'rgba(250,247,240,.97)'; g.beginPath(); g.roundRect(6, 6, 308, 56, 14); g.fill(); g.beginPath(); g.moveTo(40, 62); g.lineTo(52, 78); g.lineTo(64, 62); g.fill(); g.fillStyle = '#0b1118'; g.font = '600 24px "Segoe UI", system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 160, 34); });
  s.scale.set(3.6, .9, 1); s.material.depthTest = false; s.renderOrder = 12; return s;
}
function initLife() {
  const cloud = () => softSprite(256, 128, g => { for (const [x, y, r] of [[80, 70, 50], [130, 55, 60], [180, 72, 48], [110, 85, 40], [160, 88, 42]]) { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); } }, .55);
  for (let i = 0; i < 7; i++) { const c = cloud(); c.scale.set(16 + Math.random() * 10, 8 + Math.random() * 4, 1); c.position.set((Math.random() - .5) * 220, 30 + Math.random() * 8, (Math.random() - .5) * 140); scene.add(c); life.clouds.push({ s: c, v: .5 + Math.random() * .5 }); }
  const bird = () => softSprite(64, 32, g => { g.strokeStyle = '#1b2430'; g.lineWidth = 4; g.lineCap = 'round'; g.beginPath(); g.moveTo(6, 22); g.quadraticCurveTo(20, 6, 32, 20); g.quadraticCurveTo(44, 6, 58, 22); g.stroke(); });
  for (let f = 0; f < 2; f++) { const flock = { birds: [], t: 8 + f * 25, dir: 1, z: 0, y: 15, wait: true }; for (let i = 0; i < 5; i++) { const b = bird(); b.scale.set(1.6, .8, 1); b.visible = false; scene.add(b); flock.birds.push({ s: b, ox: (i - 2) * 1.6, oz: Math.abs(i - 2) * 1.3, ph: Math.random() * 6 }); } life.birds.push(flock); }
  for (let i = 0; i < 14; i++) { const col = ['#f9e2af', '#f5c2e7', '#94e2d5', '#fab387'][i % 4]; const s = softSprite(32, 32, g => { g.fillStyle = col; g.beginPath(); g.ellipse(10, 16, 8, 6, .4, 0, Math.PI * 2); g.fill(); g.beginPath(); g.ellipse(22, 16, 8, 6, -.4, 0, Math.PI * 2); g.fill(); }); s.scale.set(.5, .5, 1); s.visible = false; scene.add(s); life.flies.push({ s, ph: Math.random() * 6, home: null }); }
  life.fish = { next: 6, s: null, t0: 0, from: null, ring: null };
  const fs = softSprite(64, 32, g => { g.fillStyle = '#9fd8e8'; g.beginPath(); g.ellipse(26, 16, 18, 8, 0, 0, Math.PI * 2); g.fill(); g.beginPath(); g.moveTo(44, 16); g.lineTo(60, 6); g.lineTo(60, 26); g.closePath(); g.fill(); }); fs.scale.set(1.4, .7, 1); fs.visible = false; scene.add(fs); life.fish.s = fs;
  const ring = new THREE.Mesh(new THREE.RingGeometry(.4, .55, 32), new THREE.MeshBasicMaterial({ color: 0xbfe9f5, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.visible = false; scene.add(ring); life.fish.ring = ring;
}
function pickFlyHomes() { const forest = terrain.tiles.filter(t => t.biome === 'forest' && t.th > 0); life.flyHomes = forest.length ? life.flies.map(() => forest[Math.floor(Math.random() * forest.length)]) : []; }
// Sun, sky and lights follow the wall clock: full day around noon, lamps and torches after dusk.
function updateDaylight() {
  const d = new Date(), h = d.getHours() + d.getMinutes() / 60; if (Math.abs(h - life.lastDay) < 1 / 60) return; life.lastDay = h;
  const ang = (h - 6) / 12 * Math.PI, dayK = Math.max(0, Math.min(1, (Math.sin(ang) + .12) / 1.12)); life.dayK = dayK;
  sun.intensity = .22 + 1.4 * dayK; sun.color.setHex(0x8fa8ff).lerp(new THREE.Color(0xfff0d2), dayK);
  sun.position.set(40 * Math.cos(ang) + 10, 18 + 56 * Math.max(0, Math.sin(ang)), 30);
  const sky = new THREE.Color(0x05080e).lerp(new THREE.Color(0x121a24), dayK); scene.background.copy(sky); scene.fog.color.copy(sky);
  scene.children.find(o => o.isHemisphereLight).intensity = .22 + .5 * dayK;
  const night = 1 - dayK; mats.window.emissiveIntensity = night * 1.3; mats.torch.emissiveIntensity = night * 1.6; mats.torch.opacity = night;
  for (const b of beacons) b.userData.nightBoost = night * .8;
}
function updateLife(t, dt) {
  updateDaylight(); const rx = terrain.rx + 30, night = 1 - life.dayK;
  for (const c of life.clouds) { c.s.position.x += c.v * dt; if (c.s.position.x > rx) c.s.position.x = -rx; }
  for (const f of life.birds) {
    if (f.wait) { f.t -= dt; if (f.t <= 0) { f.wait = false; f.dir = Math.random() < .5 ? 1 : -1; f.x = -f.dir * rx; f.z = (Math.random() - .5) * terrain.rz * 1.4; f.y = 13 + Math.random() * 5; f.birds.forEach(b => b.s.visible = true); } continue; }
    f.x += f.dir * 7 * dt; if (Math.abs(f.x) > rx) { f.wait = true; f.t = 25 + Math.random() * 40; f.birds.forEach(b => b.s.visible = false); continue; }
    for (const b of f.birds) { b.s.position.set(f.x + b.ox * f.dir, f.y + Math.sin(t * 1.3 + b.ph) * .6, f.z + b.oz); b.s.scale.set(1.6 * f.dir, .8 * (.55 + .45 * Math.abs(Math.sin(t * 9 + b.ph))), 1); }
  }
  if (life.flyHomes.length) for (let i = 0; i < life.flies.length; i++) { const fl = life.flies[i], home = life.flyHomes[i]; if (!home || night > .8) { fl.s.visible = false; continue; } fl.s.visible = true; fl.s.position.set(home.x + Math.sin(t * .9 + fl.ph) * 1.6 + Math.sin(t * 3.1 + fl.ph) * .3, home.h + 1.4 + Math.sin(t * 2.2 + fl.ph * 2) * .5, home.z + Math.cos(t * .7 + fl.ph) * 1.6); fl.s.scale.set(.5, .5 * (.5 + .5 * Math.abs(Math.sin(t * 14 + fl.ph))), 1); }
  const gh = sites.get('github'); const F = life.fish;
  if (F && gh) { F.next -= dt; if (F.next <= 0 && !F.from) { F.from = new THREE.Vector3(gh.x - gh.extra.cx + (Math.random() - .5) * gh.extra.hr, PLAT + .6, gh.z + 2 + (Math.random() - .5) * gh.extra.hr * .9); F.t0 = t; F.s.visible = true; F.ring.visible = true; F.ring.position.copy(F.from); F.ring.position.y += .02; }
    if (F.from) { const k = (t - F.t0) / 1.1; if (k >= 1) { F.from = null; F.s.visible = false; F.ring.visible = false; F.next = 4 + Math.random() * 7; } else { F.s.position.set(F.from.x + k * 2.2, F.from.y + Math.sin(k * Math.PI) * 2.2, F.from.z); F.s.scale.set(1.4 * (k < .5 ? 1 : -1), .7, 1); F.s.material.rotation = (k < .5 ? 1 : -1) * (.6 - k * 1.2); F.ring.scale.setScalar(1 + k * 4); F.ring.material.opacity = .6 * (1 - k); } } }
  for (let i = life.chimneys.length - 1; i >= 0; i--) { const c = life.chimneys[i]; if (!c.g.parent) { life.chimneys.splice(i, 1); continue; } for (const sm of c.smoke) { const f = ((t * .35 + sm.ph) % 1 + 1) % 1; sm.m.position.set(c.at[0] + Math.sin(f * 5 + sm.ph * 9) * .25, c.at[1] + f * 2.4, c.at[2]); sm.m.scale.setScalar(.5 + f * 1.6); sm.m.material.opacity = .5 * (1 - f); } }
  if (night > 0) for (const tr of life.torches) tr.material.emissiveIntensity = night * (1.2 + Math.sin(t * 13 + tr.position.x) * .4 + Math.sin(t * 7.3) * .2);
}
// A unit that has waited long enough waves, hops and calls out for orders.
function idleCall(u, t, T) {
  const { p: m, inner } = u; const wave = Math.sin(T * .45 + u.phase) > .2;
  if (wave) { m.armR.rotation.x = -2.7 + Math.sin(T * 9 + u.phase) * .45; m.armR.rotation.z = -.4; inner.position.y = Math.abs(Math.sin(T * 5 + u.phase)) * .18; }
  else { m.armL.rotation.x = .2; m.armR.rotation.x = .2; m.head.rotation.y = Math.sin(T * .8 + u.phase) * .7; }
  m.disc.material.opacity = .28 + (.5 + .5 * Math.sin(T * 3 + u.phase)) * .3;
  if (u.say && t > u.sayUntil) { disposeObj(u.say); u.say = null; }
  if (!u.say && t > (u.nextSay || u.phase * 3)) { u.say = speechSprite(PHRASES[Math.floor(Math.random() * PHRASES.length)]); u.say.position.set(1.2, 3.4 * u.scale, 0); u.g.add(u.say); u.sayUntil = t + 3.5; u.nextSay = t + 14 + Math.random() * 14; }
  if (u.say) u.say.position.y = 3.4 * u.scale + Math.sin(t * 2) * .06;
}
function confetti(pos) { for (const c of ['#f9e2af', '#a6e3a1', '#89b4fa', '#f5c2e7', '#fab387']) burst(pos, c, 8, 1.4, 4); }
function fireworks(pos, n) { for (let k = 0; k < n; k++) setTimeout(() => { if (!alive) return; const p = pos.clone().add(new THREE.Vector3((Math.random() - .5) * 8, Math.random() * 4, (Math.random() - .5) * 6)); burst(p, ['#f9e2af', '#a6e3a1', '#89b4fa', '#f5c2e7', '#fab387'][k % 5], 34, 2.5, 4); }, k * 380); }
function syncTreasury(site, s) {
  const n = Math.min(60, Math.round((s.cost || 0) * 6)); setLabel(site.el, `Treasury · ${esc(fmtMoney(s.cost || 0))} today`);
  if (n === site.extra.coinsN) return; const grew = site.extra.coinsN >= 0 && n > site.extra.coinsN; site.extra.coinsN = n;
  disposeObj(site.extra.coins); const g = new THREE.Group(); site.g.add(g); site.extra.coins = g;
  for (let i = 0; i < n; i++) { const pile = i % 5, level = Math.floor(i / 5); const a = pile * 1.257; const coin = new THREE.Mesh(new THREE.CylinderGeometry(.5, .5, .12, 6), mats.gold); coin.position.set(Math.cos(a) * 1.5 * (pile ? 1 : 0), .56 + level * .13, Math.sin(a) * 1.5 * (pile ? 1 : 0)); coin.rotation.y = i * .3; coin.castShadow = true; g.add(coin); }
  if (grew) { const wp = new THREE.Vector3(); site.g.getWorldPosition(wp); wp.y += 1.5; burst(wp, '#f9e2af', 10, 1.2, 3); }
}
function fmtMoney(c) { return c >= 1 ? '$' + c.toFixed(2) : '$' + c.toFixed(3); }

// Re-render the selection bar from the current facts (after a failed action, for instance).
W.refreshSel = function () { if (alive) renderSel(); };
// Roster hooks: the list on the left can highlight and fly to a unit.
W.hover = function (id) { if (!alive) return; hovered = id == null ? null : (units.get(id) || null); };
W.focus = function (id, zoom) { if (!alive) return; const u = units.get(id); if (!u) return; cam.userMoved = true; const p = new THREE.Vector3(); u.g.getWorldPosition(p); const fx = cam.target.x, fz = cam.target.z, fzoom = cam.zoom, tz = zoom || Math.min(cam.zoom, 1.1); tween(700, k => { cam.target.x = fx + (p.x - fx) * k; cam.target.z = fz + (p.z - fz) * k; cam.zoom = fzoom + (tz - fzoom) * k; }); };
W.focusKey = function (kind, key) { if (!alive) return; const o = kind === 'pr' ? ships.get(key) : kind === 'run' ? machines.get(key) : kind === 'peer' ? tents.get(key) : null; if (o) { cam.userMoved = true; flyTo(o.g); select(kind === 'pr' ? { pr: o.pr } : kind === 'run' ? { run: o.run } : { peer: o.peer }); } };

window.World = W;
})();
