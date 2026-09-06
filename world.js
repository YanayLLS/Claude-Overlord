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
const SAND = 1.1, WATER = .55; // beach and sea level (the harbour sits on the beach, its ships on the water)
const SHIP_Y = WATER - SAND + .35; // a ship's group height inside the harbour: hull settles to the waterline
const TILE = 2.6;           // hex tile radius
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ────────────────────────── Module state ────────────────────────── */
let THREE, stage, canvas, labelsEl, selEl, miniEl, toastEl, hooks = {};
let renderer, scene, camera, sun, raf = 0, ro = null, lastT = 0, alive = false;
const cam = { target: null, zoom: 2.0, yaw: 0, base: null, hover: false };
const sites = new Map(), units = new Map(), ships = new Map(), machines = new Map(), tents = new Map(), raiders = new Map();
const order = { features: [], shops: [] };
const anchors = new Set(), tweens = new Set(), flags = [], cranes = [], beacons = [];
let selected = {}, hovered = null, hoveredRaid = null, snap = null, terrain = null, mats = null, card = null, cardFor = null, siteColorIdx = 0, lastSel, selSig = '';
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
  for (let i = 0; i < 360; i++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false })); s.visible = false; scene.add(s); puffs.pool.push({ s, life: 0, ttl: 1, v: new THREE.Vector3() }); }
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
  stage.innerHTML = '<canvas class="gl"></canvas><div id="world-labels"></div><canvas id="world-mini" width="400" height="232"></canvas><div id="world-sel" hidden></div><div id="world-toast"></div><div id="world-hint">drag / <kbd>WASD</kbd> pan &middot; wheel zoom &middot; <kbd>Q</kbd><kbd>E</kbd> rotate &middot; click select &middot; double-click terminal &middot; right-click menu &middot; <kbd>F</kbd> frame all</div>';
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
  sites.clear(); units.clear(); ships.clear(); machines.clear(); tents.clear(); raiders.clear(); anchors.clear(); fx.shots.length = 0; fx.rings.length = 0; fx.debris.length = 0; fx.flames.length = 0; fx.sieges.clear(); cam.shake = null; pickables.clear(); lastSel = undefined; flags.length = 0; life.clouds.length = 0; life.birds.length = 0; life.flies.length = 0; life.torches.length = 0; life.chimneys.length = 0; life.fires.length = 0; life.fish = null; life.rain = null; life.sky = null; life.stars = null; life.meteor = null; life.ship = null; life.gulls.length = 0; life.spot = null; life.medics.clear(); life.fountains.length = 0; life.lighthouse = null; life.orbits.length = 0; life.beams.length = 0; life.buoys.length = 0; prevAg.clear(); intents.clear(); awardsArmed = false; economy = null; cam.cine = false; cam.lastInput = null; cranes.length = 0; beacons.length = 0; order.features.length = 0; order.shops.length = 0;
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
  for (const s of siteList) { const edge = s.kind === 'portal'; rx = Math.max(rx, Math.abs(s.x) + s.R + (edge ? 2 : 16)); rz = Math.max(rz, Math.abs(s.z) + s.R + (edge ? 2 : 14)); }
  T.rx = rx; T.rz = rz;
  const grass = [new THREE.Color(0x6fae5a), new THREE.Color(0x7dba62), new THREE.Color(0x63a052)], forest = new THREE.Color(0x4f8f48), sand = new THREE.Color(0xd9c58f), rock = new THREE.Color(0x8d8a84), snow = new THREE.Color(0xd8dde0), ash = new THREE.Color(0x2f2b36), ashCol = new THREE.Color(0x1d1a22), crag = new THREE.Color(0x4a454f), plot = new THREE.Color(0x3c4a52), earth = new THREE.Color(0x6b5a44), deep = new THREE.Color(0x1f6f8c), water = new THREE.Color(0x2c86a8);
  for (const t of T.tiles) {
    const e = (t.x / rx) ** 2 + (t.z / rz) ** 2;
    let biome = 'hidden', th = 0;
    if (e < 1) { th = 1.2 + t.n * 1.6 + Math.max(0, .78 - e) * .6; biome = t.n2 > .62 && t.n > .45 ? 'forest' : 'grass'; if (t.n > .8) { biome = 'rock'; th += 1.4; } if (e > .86) { biome = 'sand'; th = Math.min(th, 1.1); } }
    else if (e < 1.35) { th = .55; biome = 'water'; }
    // Sites flatten the tiles under them into a plateau; a ring outside eases down.
    let site = null;
    for (const s of siteList) { const d = Math.hypot(t.x - s.x, t.z - s.z);
      if (s.kind === 'github') { // a sand yard west of the quay, a cove east of it that opens through a channel to the sea, headlands at the east corners
        const lx = t.x - s.x, lz = t.z - s.z, az = Math.abs(lz), R = s.R;
        if (d < R + TILE * .8) { site = s; const cove = lx > s.quay && (az < .45 * R || (d < R - 4.5 && lx <= .6 * R)); biome = cove ? 'bay' : 'sand'; th = cove ? WATER : SAND; break; }
        else if (lx > s.quay && az < .45 * R && biome !== 'hidden') { biome = 'bay'; th = WATER; break; }
        else if (d < R + TILE * 2.6 && biome !== 'hidden' && biome !== 'water') { th = Math.min(th, SAND + 1.3 * (d - R - TILE * .8) / (TILE * 1.8)); if (d < R + TILE * 1.6) biome = 'sand'; }
        continue; }
      if (s.kind === 'portal') { // scorched ground on the plateau, a raised rim of black crag around it
        if (d < s.R + TILE * .8) { site = s; biome = 'ash'; th = PLAT; break; }
        else if (d < s.R + TILE * 3 && biome !== 'hidden') { th = Math.max(th, PLAT + 1.5 - 2.8 * (d - s.R - TILE * .8) / (TILE * 2.2)); biome = d < s.R + TILE * 2.1 ? 'crag' : biome === 'water' ? 'sand' : biome; }
        continue; }
      if (d < s.R + TILE * .8) { site = s; biome = 'plot'; th = PLAT; break; } else if (d < s.R + TILE * 2.6 && biome !== 'hidden') { th = Math.max(th, PLAT - 1.2 * (d - s.R - TILE * .8) / (TILE * 1.8)); if (biome === 'water') { biome = 'sand'; } } }
    t.site = site; t.th = th; t.biome = biome;
    t.cap.copy(biome === 'plot' ? plot : biome === 'ash' ? ash : biome === 'crag' ? crag : biome === 'water' || biome === 'bay' ? water : biome === 'sand' ? sand : biome === 'rock' ? (th > 4 ? snow : rock) : biome === 'forest' ? forest : grass[Math.floor(t.n2 * 3) % 3]);
    t.col.copy(biome === 'water' || biome === 'bay' ? deep : biome === 'plot' ? plot : biome === 'ash' || biome === 'crag' ? ashCol : earth);
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
/* ────────────────────────── Economy: tiers and prices (cosmetic only) ────────────────────────── */
const TOWER_TIERS = ['Stone tower', 'Timber keep', 'Marble keep', 'Grand citadel', 'Crystal spire', 'Sky citadel'], HALL_TIERS = ['Hut', 'Hall', 'Guild house', 'Manufactory', 'Foundry', 'Arcology dome'], DOCK_TIERS = ['Pier', 'Harbour & lighthouse', 'Crane docks', 'Shipyard', 'Grand port'];
const TIER_COST = [0, 200, 600, 1500, 3500, 8000], DOCK_COST = [0, 400, 1200, 3000, 7000];
const DECOS = { fountain: { name: 'Fountain', cost: 150 }, statue: { name: 'Statue of the Overlord', cost: 300 }, lanterns: { name: 'Lanterns', cost: 120 }, gardens: { name: 'Gardens', cost: 100 } };
let economy = null; // the last snapshot's economy (coins, upgrades, deco)
const tierOf = key => Math.max(1, Math.min(6, (economy && economy.upgrades && economy.upgrades[key]) || 1));
const coins = () => (economy && economy.coins) || 0;
const TIER_TIME = [0, 120, 300, 600, 1200, 2400], DOCK_TIME = [0, 180, 480, 900, 1800], DECO_TIME = 60; // seconds of construction per tier
const buildOf = key => (economy && economy.builds && economy.builds[key]) || null;
function buildProgress(b) { const now = Date.now(), pct = Math.max(0, Math.min(1, (now - b.start) / (b.dur * 1000))), left = Math.max(0, Math.ceil((b.start + b.dur * 1000 - now) / 1000)); return { pct, left: Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') }; }
const buildHtml = b => { if (!b) return ''; const p = buildProgress(b); return `<span class="w-build">⚒ ${esc(b.name)} <i><b style="width:${Math.round(p.pct * 100)}%"></b></i>${p.left}</span>`; };
// A scaffold cage with a crane: the "under construction" look while a build timer runs.
function buildCage(parent, R, h, color) { const g = new THREE.Group(); parent.add(g); for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; const pole = new THREE.Mesh(new THREE.CylinderGeometry(.07, .07, h, 5), mats.scaffold); pole.position.set(Math.cos(a) * R, h / 2, Math.sin(a) * R); pole.castShadow = true; g.add(pole); } for (let y = 1.4; y < h; y += 1.6) g.add(hexEdge(R, y, 0xc39a55, .7)); const c = new THREE.Group(); c.position.set(R + .6, 0, -R * .4); const mast = new THREE.Mesh(new THREE.CylinderGeometry(.12, .12, h + 2, 6), mats.scaffold); mast.position.y = (h + 2) / 2; const jib = new THREE.Group(); jib.position.y = h + 2; const arm = box(R + 3, .18, .18, mats.scaffold); arm.position.x = (R + 3) / 2 - .8; const cable = new THREE.Mesh(new THREE.CylinderGeometry(.02, .02, 2.4, 4), mats.dark); cable.position.set(R + 1.2, -1.2, 0); const block = hexPrism(.35, .5, mat(color)); block.position.set(R + 1.2, -2.5, 0); jib.add(arm, cable, block); c.add(mast, jib); g.add(c); cranes.push({ jib, block, ph: Math.random() * 6, g: c }); for (let i = 0; i < 3; i++) { const fl = new THREE.Mesh(new THREE.PlaneGeometry(.6, .4), mat(color, { side: THREE.DoubleSide })); const a = i * 2.1; fl.position.set(Math.cos(a) * R, h + .3, Math.sin(a) * R); g.add(fl); flags.push(fl); } return g; }
function tower(parent, x, z, built, color, active, prev, tier = 1) {
  const g = new THREE.Group(); g.position.set(x, 0, z - (tier >= 4 ? .8 : 0)); parent.add(g);
  const FLOORS = [5, 6, 7, 9, 11, 13][tier - 1], FH = 1.5, R = [2.6, 2.9, 3.2, 3.6, 3.8, 4][tier - 1], n = Math.round(built * FLOORS), pn = prev == null ? n : Math.round(prev * FLOORS);
  const marble = mat(0xe8e4dc), marbleDark = mat(0xcfc9be), crystal = new THREE.MeshStandardMaterial({ color: 0x9fe3ff, emissive: 0x3fbfd6, emissiveIntensity: .4, transparent: true, opacity: .82, roughness: .2 }), sky = new THREE.MeshStandardMaterial({ color: 0xdff6ff, emissive: 0x7fe0ff, emissiveIntensity: .5, transparent: true, opacity: .85, roughness: .15 });
  const floorMat = i => tier === 1 ? (i % 2 ? mats.stone : mats.stoneDark) : tier === 2 ? (i % 2 ? mats.wood : mats.stone) : tier <= 4 ? (i % 2 ? marble : marbleDark) : tier === 5 ? (i < 5 ? marble : crystal) : (i < 4 ? marble : i < 9 ? crystal : sky);
  const trimMat = tier >= 2 ? mats.gold : mat(color), topY = FLOORS * FH;
  for (let i = 0; i < FLOORS; i++) {
    const y = i * FH;
    if (i < n) {
      const f = hexPrism(R, FH, floorMat(i)); f.position.y = y + FH / 2; g.add(f); const trim = hexPrism(R + .2, .18, trimMat); trim.position.y = y + FH; g.add(trim);
      for (const a of tier >= 4 ? [0, 2.094, 4.189] : [0]) { const win = box(.5, .6, .12, mats.window); win.position.set(Math.sin(a) * (R * .866 + .02), y + FH / 2, Math.cos(a) * (R * .866 + .02)); win.rotation.y = a; g.add(win); }
      if (tier >= 3 && i % 2 === 1) for (const sx of [-1, 1]) { const bn = new THREE.Mesh(new THREE.PlaneGeometry(.7, 1.1), mat(color, { side: THREE.DoubleSide })); bn.position.set(sx * (R * .5 + .05), y + FH / 2, R * .866 + .08); g.add(bn); }
      if (tier === 2 && i === 2) { const bal = hexPrism(R + .9, .2, mats.wood); bal.position.y = y; g.add(bal); for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; const post = box(.12, .8, .12, mats.wood); post.position.set(Math.cos(a) * (R + .8), y + .5, Math.sin(a) * (R + .8)); g.add(post); } }
      if (i >= pn) { const fl = [f, trim]; fl.forEach(o => { o.scale.set(.01, .01, .01); }); tween(500, k => fl.forEach(o => o.scale.setScalar(Math.max(.01, k))), null, easeOutBack, (i - pn) * 120); if (puffs) { const wp = new THREE.Vector3(); f.getWorldPosition(wp); setTimeout(() => burst(wp, hexStr(color), 14, 3, 2), (i - pn) * 120 + 60); } }
    } else {
      const e = hexEdge(R + .3, y + FH / 2, 0xc39a55); g.add(e); const e2 = hexEdge(R + .3, y + FH, 0xc39a55, .5); g.add(e2);
      if (i === n) for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; const pole = new THREE.Mesh(new THREE.CylinderGeometry(.06, .06, FH * (FLOORS - n), 5), mats.scaffold); pole.position.set(Math.cos(a) * (R + .3), y + FH * (FLOORS - n) / 2, Math.sin(a) * (R + .3)); pole.castShadow = true; g.add(pole); }
    }
  }
  // Side structures that come with the tier.
  const turret = (tx, tz, h, r, m, roofM) => { const t = hexPrism(r, h, m); t.position.set(tx, h / 2, tz); g.add(t); const rf = new THREE.Mesh(new THREE.ConeGeometry(r * 1.15, 1.2, 6), roofM); rf.position.set(tx, h + .6, tz); rf.rotation.y = Math.PI / 6; rf.castShadow = true; g.add(rf); const fl = new THREE.Mesh(new THREE.PlaneGeometry(.7, .45), mat(color, { side: THREE.DoubleSide })); fl.position.set(tx + .35, h + 1.5, tz); g.add(fl); flags.push(fl); const pole = new THREE.Mesh(new THREE.CylinderGeometry(.03, .03, 1.2, 4), mats.dark); pole.position.set(tx, h + 1.2, tz); g.add(pole); };
  if (tier === 3) for (const sx of [-1, 1]) turret(sx * (R + 1.3), .6, 6, 1.1, marbleDark, mats.gold);
  if (tier >= 4) { const WR = R + 2.6; for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3, a2 = (k + 1) * Math.PI / 3; const x1 = Math.cos(a) * WR, z1 = Math.sin(a) * WR, x2 = Math.cos(a2) * WR, z2 = Math.sin(a2) * WR; const w = box(Math.hypot(x2 - x1, z2 - z1) - 1.4, 1.4, .4, tier >= 5 ? marble : mats.wall); w.position.set((x1 + x2) / 2, .7, (z1 + z2) / 2); w.rotation.y = -Math.atan2(z2 - z1, x2 - x1); g.add(w); if (k % 2 === 0) turret(x1, z1, 3.2, .8, tier >= 5 ? marble : mats.wall, tier >= 5 ? crystal : mat(color)); } }
  if (n >= FLOORS) {
    const roof = new THREE.Mesh(new THREE.ConeGeometry(R * 1.05, tier >= 5 ? 4.5 : tier >= 4 ? 2.8 : 2, 6), tier >= 5 ? (tier >= 6 ? sky : crystal) : tier >= 2 ? mats.gold : mat(color)); roof.position.y = topY + (tier >= 5 ? 2.2 : tier >= 4 ? 1.4 : 1); roof.rotation.y = Math.PI / 6; roof.castShadow = true; g.add(roof);
    if (tier >= 3) { const fin = new THREE.Mesh(new THREE.SphereGeometry(.3, 8, 6), mats.gold); fin.position.y = topY + (tier >= 5 ? 4.6 : tier >= 4 ? 2.9 : 2.1); g.add(fin); }
    if (tier >= 5) { for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; const l = new THREE.Mesh(new THREE.SphereGeometry(.18, 8, 6), new THREE.MeshStandardMaterial({ color: 0xbff4ff, emissive: 0x7fe0ff, emissiveIntensity: 1.6 })); l.position.set(Math.cos(a) * (R + .5), topY - .4, Math.sin(a) * (R + .5)); g.add(l); beacons.push(l); }
      const ring = new THREE.Group(); ring.position.y = topY * .7; for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; const c = hexPrism(.35, .5, crystal); c.position.set(Math.cos(a) * (R + 1.8), 0, Math.sin(a) * (R + 1.8)); c.rotation.z = .5; ring.add(c); } g.add(ring); life.orbits.push({ g: ring, speed: .5, bob: .3, base: topY * .7 }); }
    if (tier >= 6) { const beam = new THREE.Mesh(new THREE.CylinderGeometry(.35, .9, 26, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0x9fe3ff, transparent: true, opacity: .16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })); beam.position.y = topY + 14; g.add(beam); life.beams.push(beam);
      for (const [h, r, sp] of [[topY * .45, R + 4.2, .22], [topY * .95, R + 3.2, -.3]]) { const orb = new THREE.Group(); orb.position.y = h; for (let k = 0; k < 3; k++) { const a = k * Math.PI * 2 / 3; const p = new THREE.Group(); p.position.set(Math.cos(a) * r, 0, Math.sin(a) * r); const plat = hexPrism(1.3, .3, marble); const tw = hexPrism(.5, 1.6, crystal); tw.position.y = .95; const lt = new THREE.Mesh(new THREE.SphereGeometry(.14, 8, 6), new THREE.MeshStandardMaterial({ color: 0xbff4ff, emissive: 0x7fe0ff, emissiveIntensity: 1.8 })); lt.position.y = 1.9; p.add(plat, tw, lt); beacons.push(lt); orb.add(p); } g.add(orb); life.orbits.push({ g: orb, speed: sp, bob: .6, base: h }); } }
  } else if (active) { const c = new THREE.Group(); c.position.set(R + .8, n * FH, -R); const mast = new THREE.Mesh(new THREE.CylinderGeometry(.12, .12, 5, 6), mats.scaffold); mast.position.y = 2.5; mast.castShadow = true; const jib = new THREE.Group(); jib.position.y = 5; const arm = box(5, .18, .18, mats.scaffold); arm.position.x = 1.6; const back = box(1.4, .18, .18, mats.scaffold); back.position.x = -1.1; const cable = new THREE.Mesh(new THREE.CylinderGeometry(.02, .02, 2.2, 4), mats.dark); cable.position.set(3.4, -1.1, 0); const block = hexPrism(.35, .5, mat(color)); block.position.set(3.4, -2.4, 0); jib.add(arm, back, cable, block); c.add(mast, jib); g.add(c); cranes.push({ jib, block, ph: Math.random() * 6, g }); }
  g.userData.topY = topY + (tier >= 5 ? 5.4 : tier >= 4 ? 3.6 : 2.6); return g;
}
function hall(parent, x, z, built, color, active, prev, tier = 1) {
  const g = new THREE.Group(); g.position.set(x, 0, z - (tier >= 5 ? .6 : 0)); parent.add(g);
  const marble = mat(0xe8e4dc), iron = mat(0x6b7280), crystal = new THREE.MeshStandardMaterial({ color: 0x9fe3ff, emissive: 0x3fbfd6, emissiveIntensity: .35, transparent: true, opacity: .45, roughness: .15, side: THREE.DoubleSide });
  const wallMat = [mats.stone, mats.wood, marble, iron, mat(0x4b5563), marble][tier - 1], trimMat = tier >= 2 ? mats.gold : mat(color);
  const R1 = [2.6, 3, 3.4, 3.8, 4.2, 4.6][tier - 1], H = [2.1, 2.6, 2.8, 3, 3.2, 2.6][tier - 1], stories = [1, 2, 3, 3, 4, 1][tier - 1];
  let top = 0, r = R1;
  for (let k = 0; k < stories; k++) { const h = k === 0 ? H : 1.6; const w = hexPrism(r, h, wallMat); w.position.y = top + h / 2; g.add(w); const tr = hexPrism(r + .15, .16, trimMat); tr.position.y = top + h; g.add(tr); if (k === 0) { const door = box(.9, 1.2, .1, mats.dark); door.position.set(0, .6, r * .866 + .02); g.add(door); } for (const sx of [-1, 1]) { const win = box(.5, .6, .12, mats.window); win.position.set(sx * r * .5, top + h / 2, r * .866 + .02); g.add(win); } top += h; r *= .72; }
  if (tier >= 3) { const bt = hexPrism(.8, top + 2.2, wallMat); bt.position.set(R1 * .7, (top + 2.2) / 2, -R1 * .5); g.add(bt); const bell = new THREE.Mesh(new THREE.ConeGeometry(1, 1.1, 6), trimMat); bell.position.set(R1 * .7, top + 2.8, -R1 * .5); bell.rotation.y = Math.PI / 6; g.add(bell); for (const sx of [-1, 1]) { const bn = new THREE.Mesh(new THREE.PlaneGeometry(.8, 1.4), mat(color, { side: THREE.DoubleSide })); bn.position.set(sx * R1 * .6, H * .6, R1 * .866 + .08); g.add(bn); } }
  const gearAt = (gx, gy, gz, gr) => { const gear = new THREE.Group(); gear.position.set(gx, gy, gz); gear.rotation.y = Math.PI / 2; const wheel = new THREE.Mesh(new THREE.CylinderGeometry(gr, gr, .25, 6), mats.iron); wheel.rotation.x = Math.PI / 2; gear.add(wheel); for (let k = 0; k < 6; k++) { const tooth = box(gr * .33, gr * .38, .24, mats.iron); const an = k * Math.PI / 3; tooth.position.set(Math.cos(an) * gr * 1.1, Math.sin(an) * gr * 1.1, 0); tooth.rotation.z = an; gear.add(tooth); } g.add(gear); cranes.push({ jib: gear, block: { position: { y: 0 } }, ph: 0, g, spin: true }); };
  const chimneyAt = (cx, cz, ch, glow) => { const c = new THREE.Mesh(new THREE.CylinderGeometry(.32, .42, ch, 6), mats.stoneDark); c.position.set(cx, top + ch / 2 - .3, cz); g.add(c); if (glow) { const em = new THREE.Mesh(new THREE.CylinderGeometry(.2, .2, .2, 6), new THREE.MeshStandardMaterial({ color: 0xff7a2a, emissive: 0xff7a2a, emissiveIntensity: 1.4 })); em.position.set(cx, top + ch - .3, cz); g.add(em); } const smoke = []; for (let k = 0; k < 4; k++) { const sm = new THREE.Mesh(new THREE.SphereGeometry(.16, 7, 6), new THREE.MeshStandardMaterial({ color: 0xcfd4da, transparent: true, opacity: .5 })); g.add(sm); smoke.push({ m: sm, ph: k / 4 }); } life.chimneys.push({ smoke, at: [cx, top + ch - .1, cz], g }); };
  if (tier === 4) { chimneyAt(-R1 * .55, -R1 * .5, 3.4, false); gearAt(R1 * .866 + .3, H * .55, 0, .9); }
  if (tier === 5) { chimneyAt(-R1 * .55, -R1 * .5, 4, true); chimneyAt(R1 * .2, -R1 * .6, 3.2, true); chimneyAt(-R1 * .1, R1 * .1, 2.6, false); gearAt(R1 * .866 + .3, H * .5, .8, 1); gearAt(R1 * .866 + .3, H * .5 + 1.9, -.9, .7); gearAt(-R1 * .866 - .3, H * .5, 0, .9); const furnace = box(1.6, 1, .12, new THREE.MeshStandardMaterial({ color: 0x2a1408, emissive: 0xff6a1a, emissiveIntensity: 1.6 })); furnace.position.set(1.6, .6, R1 * .866 + .02); g.add(furnace); life.beams.push(furnace); }
  if (tier === 6) { const core = hexPrism(1.2, 3.6, new THREE.MeshStandardMaterial({ color: 0xbff4ff, emissive: 0x7fe0ff, emissiveIntensity: 1.2, transparent: true, opacity: .9 })); core.position.y = H + 1.8; g.add(core); beacons.push(core); const dome = new THREE.Mesh(new THREE.SphereGeometry(R1 * 1.15, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2), crystal); dome.position.y = H; g.add(dome); const rib = hexEdge(R1 * 1.15, H, 0xd6a545, .8); g.add(rib); const orb = new THREE.Group(); orb.position.y = H + 3; for (let k = 0; k < 3; k++) { const a = k * Math.PI * 2 / 3; const d = new THREE.Mesh(new THREE.OctahedronGeometry(.32, 0), mats.gold); d.position.set(Math.cos(a) * (R1 * .8), 0, Math.sin(a) * (R1 * .8)); orb.add(d); } g.add(orb); life.orbits.push({ g: orb, speed: .9, bob: .4, base: H + 3 }); top = H + R1 * 1.15; }
  else if (active) { const cy = top + .8; const ch = new THREE.Mesh(new THREE.CylinderGeometry(.22, .26, 1.4, 6), mats.stoneDark); ch.position.set(-1.4, cy, -.8); g.add(ch); const smoke = []; for (let k = 0; k < 4; k++) { const sm = new THREE.Mesh(new THREE.SphereGeometry(.14, 7, 6), new THREE.MeshStandardMaterial({ color: 0xcfd4da, transparent: true, opacity: .55 })); g.add(sm); smoke.push({ m: sm, ph: k / 4 }); } life.chimneys.push({ smoke, at: [-1.4, cy + .7, -.8], g }); }
  if (tier < 6) {
    const roofR = r / .72 * 1.12, roofMat = tier >= 2 ? mats.gold : mat(color);
    if (built >= 1) { const roof = new THREE.Mesh(new THREE.ConeGeometry(roofR, 1.6, 6), roofMat); roof.position.y = top + .8; roof.rotation.y = Math.PI / 6; roof.castShadow = true; g.add(roof); if (prev != null && prev < 1) { roof.scale.setScalar(.01); tween(600, k => roof.scale.setScalar(Math.max(.01, k)), null, easeOutBack); const wp = new THREE.Vector3(); roof.getWorldPosition(wp); burst(wp, hexStr(color), 18, 3, 3); } }
    else { g.add(hexEdge(roofR, top + .8, 0xc39a55), hexEdge(roofR, top + 1.7, 0xc39a55, .5)); const part = new THREE.Mesh(new THREE.ConeGeometry(roofR, 1.6, 6), roofMat); part.scale.setScalar(Math.max(.01, built)); part.rotation.y = Math.PI / 6; part.position.y = top + .8 * built; part.castShadow = true; g.add(part);
      for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; const pole = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, top + 1.7, 5), mats.scaffold); pole.position.set(Math.cos(a) * roofR, (top + 1.7) / 2, Math.sin(a) * roofR); g.add(pole); }
      if (active) { const c = new THREE.Group(); c.position.set(R1 + .8, 0, -R1 + .2); const mast = new THREE.Mesh(new THREE.CylinderGeometry(.1, .1, top + 2.2, 6), mats.scaffold); mast.position.y = (top + 2.2) / 2; const jib = new THREE.Group(); jib.position.y = top + 2.2; const arm = box(3.6, .16, .16, mats.scaffold); arm.position.x = 1.2; const cable = new THREE.Mesh(new THREE.CylinderGeometry(.02, .02, 1.6, 4), mats.dark); cable.position.set(2.6, -.8, 0); const block = hexPrism(.3, .4, mat(color)); block.position.set(2.6, -1.8, 0); jib.add(arm, cable, block); c.add(mast, jib); g.add(c); cranes.push({ jib, block, ph: Math.random() * 6, g }); } }
  }
  g.userData.topY = top + 3.2; return g;
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
  if (s.github) { const lay = githubLayout(s); plan.push({ key: 'github', kind: 'github', x: sTotal / 2 + GAP + lay.R + 1, z: lay.R - 2, R: lay.R, lay }); }
  if (plan.length) plan.push({ key: 'treasury', kind: 'treasury', x: 0, z: 2.5, R: 7 }); // today's spend as a coin pile at the crossroads
  if (plan.length) plan.push({ key: 'plant', kind: 'plant', x: -17, z: 2.5, R: 7 }); // the power plant: session / week / per-model supply
  if (s.peers && s.peers.length) plan.push({ key: 'allies', kind: 'allies', x: -(sTotal / 2 + GAP + 13), z: 22, R: 13 });
  if (s.raidsOn) plan.push({ key: 'portal', kind: 'portal', x: -(Math.max(fTotal, sTotal) / 2 + GAP + 20), z: Math.min(-30, fRowZ - 12), R: 9 }); // the enemy's cave, on the far north-west crag
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
  const built = lotBuilt(spec.agents), active = spec.agents.some(a => a.status === 'active' || a.status === 'settling'), tier = spec.tier || 1, bld = buildOf(lot.site.key), key = `${spec.kind}|${built.toFixed(2)}|${active}|${spec.server}|${spec.status}|${tier}|${!!bld}`;
  if (lot.key === key) return; const prev = lot.built; lot.key = key; lot.built = built;
  if (lot.building) { for (let i = cranes.length - 1; i >= 0; i--) if (lot.building.getObjectById(cranes[i].g.id)) cranes.splice(i, 1); disposeObj(lot.building); for (let i = beacons.length - 1; i >= 0; i--) if (!beacons[i].parent) beacons.splice(i, 1); }
  const upgraded = lot.tier != null && tier !== lot.tier; lot.tier = tier;
  if (lot.beacon) { const bi = beacons.indexOf(lot.beacon); if (bi >= 0) beacons.splice(bi, 1); disposeObj(lot.beacon); lot.beacon = null; }
  lot.building = spec.kind === 'feature' ? tower(lot.g, 0, -3.4, built, spec.color, active, prev, tier) : hall(lot.g, 0, -3.4, built, spec.color, active, prev, tier);
  if (upgraded) { const wp = new THREE.Vector3(); lot.building.getWorldPosition(wp); wp.y += 3; fireworks(wp, 3); lot.building.scale.set(.01, .01, .01); tween(700, k => lot.building.scale.setScalar(Math.max(.01, k)), null, easeOutBack); }
  if (lot.cage) { for (let i = cranes.length - 1; i >= 0; i--) if (lot.cage.getObjectById(cranes[i].g.id)) cranes.splice(i, 1); for (let i = flags.length - 1; i >= 0; i--) if (lot.cage.getObjectById(flags[i].id)) flags.splice(i, 1); disposeObj(lot.cage); lot.cage = null; }
  if (bld) { const R = spec.kind === 'feature' ? [3.6, 3.9, 4.6, 6.8, 7.2, 8.4][tier - 1] : [3.4, 3.8, 4.4, 5, 5.6, 6.2][tier - 1]; lot.cage = buildCage(lot.g, R, Math.min(lot.building.userData.topY - 1.2, 16), spec.color); lot.cage.position.copy(lot.building.position); }
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
  } else if (p.kind === 'github') buildGithub(site, p);
  else if (p.kind === 'allies') buildAllies(site, p.R);
  else if (p.kind === 'plant') buildPlant(site, p.R);
  else if (p.kind === 'portal') buildPortal(site, p.R);
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
      const spec = { kind: p.kind, cwd: proj.cwd, title: proj.label, color: site.color, server: !!proj.serverUrl, port: proj.port, status: proj.status, agents, branch: proj.branch, tier: tierOf(site.key) };
      let lot = site.lots.get(proj.cwd);
      if (!lot) { lot = buildLot(site, pos[i][0], pos[i][1], R, spec); site.lots.set(proj.cwd, lot); if (p.kind === 'feature') banner(site.g, pos[i][0] + 6.5, .5, pos[i][1] - 5.5, site.color); else banner(site.g, 6.5, .5, -6.5, site.color); }
      else { lot.spec = spec; rebuildLotBuilding(lot, spec); }
      { const bld = buildOf(site.key); const base = `${esc(spec.title)}${spec.server ? '<i></i>' : ''}${spec.status === 'setup' ? ' <span style="color:var(--w-perm)">setting up…</span>' : spec.status === 'failed' ? ' <span style="color:var(--w-crashed)">setup failed</span>' : ''}`; setLabel(lot.el, base + buildHtml(bld)); }
      syncLotUnits(lot, agents, s);
    });
    for (const [cwd, lot] of site.lots) if (!seen.has(cwd)) { for (const u of lot.units.values()) destroyUnit(u); dropLabel(lot.el); disposeObj(lot.g); site.lots.delete(cwd); }
    if (site.anchor) { let tallest = 0; for (const lot of site.lots.values()) if (lot.building) tallest = Math.max(tallest, lot.building.userData.topY + lot.building.position.y); site.anchor.position.y = Math.max(9, tallest + 2.5); } // the banner clears the tallest tower
    if (site.el) { const all = repos.flatMap(r => s.agents.filter(a => a.cwd === r.cwd)); const built = repos.length ? repos.reduce((acc, r) => acc + (site.lots.get(r.cwd)?.built ?? 1), 0) / repos.length : 0;
      const tierName = (p.kind === 'feature' ? TOWER_TIERS : HALL_TIERS)[tierOf(site.key) - 1]; if (site.built != null && site.built < 1 && built >= 1) { const wp = new THREE.Vector3(); site.anchor.getWorldPosition(wp); fireworks(wp.setY(wp.y + 6), 6); } /* the feature's work is complete */ setLabel(site.el, `<div class="w-eyebrow">Feature</div><b>${esc(p.name)}</b><div class="w-prog"><i style="width:${Math.round(built * 100)}%"></i></div><span class="w-cnt">${all.length} unit${all.length === 1 ? '' : 's'} &middot; ${repos.length} repo${repos.length === 1 ? '' : 's'} &middot; ${Math.round(built * 100)}%</span>`); site.built = built; site.name = p.name; }
  } else if (p.kind === 'github') { if (site.R !== p.R || site.extra.lay.quay !== p.lay.quay || site.extra.lay.jettyL !== p.lay.jettyL || site.extra.lay.rows !== p.lay.rows || site.tier !== tierOf('github')) { const up = site.tier != null && site.tier !== tierOf('github'); destroySite(site); const ns = createSite(p); syncGithub(ns, s); if (up) { const wp = new THREE.Vector3(); ns.g.getWorldPosition(wp); wp.y += 8; fireworks(wp, 4); } return; } syncGithub(site, s); }
  else if (p.kind === 'treasury') syncTreasury(site, s);
  else if (p.kind === 'plant') syncPlant(site, s);
  else if (p.kind === 'allies') syncAllies(site, s);
  else if (p.kind === 'portal') syncPortal(site, s);
}

/* ────────────────────────── Units (agents) ────────────────────────── */
function makeUnitBody(u) {
  const { a, lot } = u, st = a.status, scale = u.scale, sc = STATUS[st].hex, p = {};
  const inner = new THREE.Group(); inner.scale.setScalar(scale); u.g.add(inner);
  const team = mat(lot.spec.color);
  p.legL = box(.22, .5, .24, mats.dark); p.legL.position.set(-.15, .25, 0); p.legR = box(.22, .5, .24, mats.dark); p.legR.position.set(.15, .25, 0);
  p.torso = box(.72, .8, .46, team); p.torso.position.y = .9; const belt = box(.74, .1, .48, mats.gold); belt.position.y = .55;
  p.head = box(.5, .48, .5, mats.skin); p.head.position.y = 1.56; const visor = box(.52, .12, .1, mats.dark); visor.position.set(0, .05, .24); p.head.add(visor);
  // Eyes glow in the status colour and blink; a crashed unit's eyes go crossed.
  p.eyes = []; p.eyeMat = new THREE.MeshStandardMaterial({ color: 0x0b1118, emissive: sc, emissiveIntensity: 1.4 });
  for (const ex of [-.12, .12]) { const e = box(.09, .07, .05, p.eyeMat); e.position.set(ex, .05, .3); if (st === 'crashed') { e.rotation.z = ex < 0 ? .8 : -.8; e.scale.set(1.6, .6, 1); } p.head.add(e); p.eyes.push(e); }
  // Rank insignia: stripes on the chest for turns served.
  const rk = rankOf(a.turns); for (let i = 0; i < rk.stripes; i++) { const sp = box(.3, .05, .03, mats.gold); sp.position.set(0, 1.2 - i * .09, .245); inner.add(sp); }
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
const RANKS = [[0, 'Recruit', 0], [3, 'Worker', 1], [10, 'Veteran', 2], [30, 'Master', 3], [100, 'Legend', 4]];
function rankOf(turns) { let r = RANKS[0]; for (const k of RANKS) if ((turns || 0) >= k[0]) r = k; return { name: r[1], stripes: r[2] }; }
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
const unitKey = a => `${a.status}|${a.model}|${a.title}|${a.looping}|${a.tool || ''}|${rankOf(a.turns).name}`;
function destroyUnit(u, quiet) {
  if (u.mini) u.lead?.crew?.delete(u.a.id); units.delete(u.a.id); u.lot.units.delete(u.a.id); dropLabel(u.pill); pickables.delete(u.hit); if (u.bench) { disposeObj(u.bench); u.bench = null; }
  if (hovered === u) hovered = null; if (selected.unit === u) { selected = {}; renderSel(); }
  const wp = new THREE.Vector3(); u.g.getWorldPosition(wp); if (!quiet) burst(wp, '#8a98ab', 16, 1.2, 2.5);
  if (!quiet && !u.mini && u.a.idleMin >= IDLE_CALL_MIN) give('closes', 3, 'tidied up ' + u.a.title.slice(0, 28));
  // A closed unit's work is banked: a gold orb arcs to the treasury and clinks in.
  const tre = !quiet && !u.mini && sites.get('treasury'); if (tre) { const orb = textSprite('◆', '#f9e2af', 'rgba(249,226,175,.4)', .7); orb.position.copy(wp); orb.position.y += 1.5; scene.add(orb); const from = orb.position.clone(), to = new THREE.Vector3(); tre.g.getWorldPosition(to); to.y += 2; tween(1300, k => { orb.position.lerpVectors(from, to, k); orb.position.y += Math.sin(k * Math.PI) * 7; }, () => { burst(to, '#f9e2af', 16, 1.5, 3); disposeObj(orb); }, easeInCubic); }
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

/* ────────────────────────── GitHub harbour: one row per repo — signboard, signal beacons (runs), jetty with ships (PRs) ────────────────────────── */
const byRepo = list => { const m = new Map(); for (const it of list) { if (!m.has(it.repo)) m.set(it.repo, []); m.get(it.repo).push(it); } return m; };
const ROW_GAP = 9, BEACON_GAP = 5.6, BERTH_GAP = 5.6;
const repoColor = repo => siteColor('repo:' + repo);
// The harbour's measurements: a sand yard on the west (signboards and beacons), a quay, then the cove with jetties opening east to the sea.
function githubLayout(s) {
  const pr = byRepo(s.prs || []), rn = byRepo(s.runs || []);
  const rows = new Set([...pr.keys(), ...rn.keys()]).size || 1;
  const runsMax = Math.max(0, ...[...rn.values()].map(l => l.length)), shipsMax = Math.max(0, ...[...pr.values()].map(l => l.length));
  const yardW = 7 + (runsMax ? runsMax * BEACON_GAP + 1 : 1), jettyL = shipsMax ? 4 + Math.ceil(shipsMax / 2) * BERTH_GAP : 6;
  const W = yardW + jettyL + 6, zMax = (rows - 1) * ROW_GAP / 2 + 7; // content width; the rows' half-extent plus the harbour sign
  const R = Math.min(90, Math.ceil(Math.max(22, Math.hypot(zMax + 10, W / 2) + 2)));
  const yardX0 = -W / 2 + 1, xa = yardX0 + 7, quay = yardX0 + yardW;
  return { R, yardX0, xa, quay, runsMax, shipsMax, jettyL, rows, zMax };
}
const GLYPH_FONT = '700 70px "Segoe UI Symbol", "Segoe UI", sans-serif';
function catMark() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
  x.fillStyle = '#f0f6fc'; x.beginPath(); x.arc(128, 128, 118, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#0d1117'; x.beginPath(); x.arc(128, 122, 62, 0, Math.PI * 2); x.fill();
  x.beginPath(); x.moveTo(78, 90); x.lineTo(72, 40); x.lineTo(112, 66); x.closePath(); x.fill(); x.beginPath(); x.moveTo(178, 90); x.lineTo(184, 40); x.lineTo(144, 66); x.closePath(); x.fill();
  x.fillStyle = '#f0f6fc'; x.beginPath(); x.ellipse(105, 118, 16, 12, 0, 0, Math.PI * 2); x.ellipse(151, 118, 16, 12, 0, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#0d1117'; x.beginPath(); x.roundRect(96, 178, 64, 44, 10); x.fill(); x.strokeStyle = '#0d1117'; x.lineWidth = 12; x.lineCap = 'round'; x.beginPath(); x.moveTo(96, 200); x.quadraticCurveTo(40, 200, 44, 150); x.stroke();
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true }));
}
function buildGithub(site, p) {
  const g = site.g, lay = p.lay, R = lay.R; site.color = 0xc9d1d9; site.tier = tierOf('github'); const dt = site.tier; site.extra.lay = lay;
  g.position.y = SAND; // the harbour sits at beach level, not on a plateau
  // An invisible hex at water level catches clicks on the harbour itself.
  const plat = hexPrism(R, .05, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })); plat.castShadow = plat.receiveShadow = false; plat.position.y = WATER - SAND + .02; g.add(plat); site.plat = plat; plat.userData.pick = { site };
  // Harbour sign: a tall post with the cat mark and the harbour's name, on the yard's north end.
  const sx = lay.yardX0 + 9, sz = -lay.zMax; site.extra.sign = { x: sx, z: sz };
  const post = new THREE.Mesh(new THREE.CylinderGeometry(.22, .28, 7, 6), mats.wood); post.position.set(sx, 3.5, sz); post.castShadow = true; g.add(post);
  const board = box(4.6, 2.2, .3, mat(0x161b22)); board.position.set(sx, 5.2, sz); g.add(board); const rim = box(4.9, 2.5, .2, mat(dt >= 2 ? 0xd6a545 : 0xc9d1d9)); rim.position.set(sx, 5.2, sz - .02); g.add(rim);
  const mark = catMark(); mark.scale.setScalar(2.4); mark.position.set(sx, 5.2, sz + .4); g.add(mark); site.extra.mark = mark; site.extra.markY = 5.2;
  const anchor = new THREE.Object3D(); anchor.position.set(sx, 8.4, sz); g.add(anchor); site.el = label('w-site w-big', '', anchor, '#c9d1d9');
  // Quay wall: a stone lip where the yard meets the water, the full height of the hex.
  const qh = 2 * Math.sqrt(Math.max(1, R * R - lay.quay * lay.quay)) - 5; const quayWall = box(1.2, 1.1, qh, mats.stoneDark); quayWall.position.set(lay.quay - .6, -.45, 0); g.add(quayWall);
  for (let k = -Math.floor(qh / 6); k <= Math.floor(qh / 6); k++) { const bol = new THREE.Mesh(new THREE.CylinderGeometry(.18, .2, .5, 6), mats.iron); bol.position.set(lay.quay - .8, .3, k * 6 + 3); g.add(bol); }
  const yardLabel = new THREE.Object3D(); yardLabel.position.set((lay.xa + lay.quay) / 2, 4.2, lay.zMax + 2); g.add(yardLabel); label('w-lot', 'Signal yard &middot; Actions', yardLabel, '#a78bfa');
  const coveLabel = new THREE.Object3D(); coveLabel.position.set(lay.quay + lay.jettyL / 2 + 2, 4.2, lay.zMax + 2); g.add(coveLabel); label('w-lot', 'Cove &middot; pull requests', coveLabel, '#3fbfd6');
  site.extra.rows = new Map();
  // Tier 2: a lighthouse on the north headland with a sweeping beam.
  if (dt >= 2) { const lh = new THREE.Group(); lh.position.set(.68 * R, 0, -.6 * R); const base = hexPrism(1.1, 1, mats.stone); base.position.y = .5; const tw = new THREE.Mesh(new THREE.CylinderGeometry(.55, .8, 6, 8), mat(0xe8e4dc)); tw.position.y = 4; tw.castShadow = true; const band = new THREE.Mesh(new THREE.CylinderGeometry(.62, .62, .8, 8), mat(0xe85d6c)); band.position.y = 3.2; const lamp = new THREE.Mesh(new THREE.CylinderGeometry(.6, .6, .9, 8), new THREE.MeshStandardMaterial({ color: 0xfff1c4, emissive: 0xffd27a, emissiveIntensity: 1.3, transparent: true, opacity: .9 })); lamp.position.y = 7.4; const cap = new THREE.Mesh(new THREE.ConeGeometry(.8, .8, 8), mat(0xe85d6c)); cap.position.y = 8.2; const beam = new THREE.Mesh(new THREE.CylinderGeometry(.05, 1.6, 22, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff1c4, transparent: true, opacity: .14, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })); beam.rotation.z = Math.PI / 2; beam.position.set(11, 7.4, 0); const pivot = new THREE.Group(); pivot.add(beam); lh.add(base, tw, band, lamp, cap, pivot); g.add(lh); life.lighthouse = pivot; }
  // Tier 3: cranes on the quay at both ends of the rows.
  if (dt >= 3) for (const sgn of [-1, 1]) { const c = new THREE.Group(); c.position.set(lay.quay - 2.2, 0, sgn * (lay.zMax + 4)); const mast = new THREE.Mesh(new THREE.CylinderGeometry(.16, .18, 8, 6), mats.gold); mast.position.y = 4; mast.castShadow = true; const jib = new THREE.Group(); jib.position.y = 8; const arm = box(8, .22, .22, mats.gold); arm.position.x = 2.6; const back = box(2.2, .22, .22, mats.gold); back.position.x = -1.8; const cable = new THREE.Mesh(new THREE.CylinderGeometry(.03, .03, 3.5, 4), mats.dark); cable.position.set(5.5, -1.75, 0); const block = box(.8, .8, .8, mats.wood); block.position.set(5.5, -3.8, 0); jib.add(arm, back, cable, block); c.add(mast, jib); g.add(c); cranes.push({ jib, block, ph: sgn, g: c }); }
  // Tier 4: a shipyard on the south yard — dry dock with a hull on the stocks, and a warehouse.
  if (dt >= 4) { const dd = new THREE.Group(); dd.position.set(lay.yardX0 + 5, 0, lay.zMax + 4); const basin = box(7, .6, 3.4, mats.stoneDark); basin.position.y = .3; const keel = box(4.6, 1.1, 1.8, mat(0x6b5a48, { transparent: true, opacity: .7 })); keel.position.y = 1.15; const ribs = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(5, 2.2, 2.2)), new THREE.LineBasicMaterial({ color: 0xc39a55 })); ribs.position.y = 1.5; dd.add(basin, keel, ribs); for (let k = 0; k < 4; k++) { const pp = new THREE.Mesh(new THREE.CylinderGeometry(.08, .08, 3, 5), mats.scaffold); pp.position.set(-2.4 + k * 1.6, 1.8, 1.4); dd.add(pp); } g.add(dd);
    const wh = new THREE.Group(); wh.position.set(lay.yardX0 + 5, 0, lay.zMax + 9); const body = box(5, 2.2, 3, mats.stone); body.position.y = 1.1; const roof = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 5.2, 3), mats.wood); roof.rotation.z = Math.PI / 2; roof.position.y = 3.15; roof.scale.set(1, 1, .6); const sign = box(2.4, .5, .08, mat(0xd6a545)); sign.position.set(0, 1.9, 1.55); wh.add(body, roof, sign); for (let k = 0; k < 3; k++) { const cr = box(.7, .7, .7, k % 2 ? mats.wood : mats.scaffold); cr.position.set(-1.6 + k * 1.2, .35, 2.4); wh.add(cr); } g.add(wh); }
  // Tier 5: breakwaters off both headlands, beacon buoys down the channel, and two heavy cranes.
  if (dt >= 5) { for (const sgn of [-1, 1]) { const bw = box(R * .42, 1.2, 1.4, mat(0x8c8579)); bw.position.set(.82 * R, WATER - SAND + .5, sgn * .36 * R); bw.rotation.y = sgn * .3; g.add(bw); }
    for (let k = 0; k < 4; k++) { const bx = .5 * R + k * .12 * R, bz = (k % 2 ? 1 : -1) * .22 * R; const buoy = new THREE.Mesh(new THREE.SphereGeometry(.35, 8, 6), mat(0xe85d6c)); buoy.position.set(bx, WATER - SAND + .3, bz); g.add(buoy); const lt = new THREE.Mesh(new THREE.SphereGeometry(.12, 8, 6), new THREE.MeshStandardMaterial({ color: 0xfff1c4, emissive: 0xffd27a, emissiveIntensity: 1.5 })); lt.position.set(bx, WATER - SAND + .75, bz); g.add(lt); beacons.push(lt); life.buoys.push(buoy); }
    for (const sgn of [-1, 1]) { const c = new THREE.Group(); c.position.set(lay.xa + 5, 0, sgn * (lay.zMax + 4)); const mast = new THREE.Mesh(new THREE.CylinderGeometry(.16, .18, 9, 6), mats.gold); mast.position.y = 4.5; const jib = new THREE.Group(); jib.position.y = 9; const arm = box(9, .22, .22, mats.gold); arm.position.x = 3; const cable = new THREE.Mesh(new THREE.CylinderGeometry(.03, .03, 4, 4), mats.dark); cable.position.set(6, -2, 0); const block = box(.9, .9, .9, mats.iron); block.position.set(6, -4.3, 0); jib.add(arm, cable, block); c.add(mast, jib); g.add(c); cranes.push({ jib, block, ph: sgn * 2, g: c }); } }
}
const rowZ = (i, n) => -(n - 1) * ROW_GAP / 2 + i * ROW_GAP;
// Ships moor on alternating sides of their repo's jetty; beacons zigzag along the yard so their cards never stack.
function shipSlot(site, row, j) { const lay = site.extra.lay; return { x: lay.quay + 3.6 + Math.floor(j / 2) * BERTH_GAP, z: row.z + (j % 2 ? 2.5 : -2.5), rot: 0 }; }
function beaconSlot(site, row, j) { const lay = site.extra.lay; return { x: lay.xa + 2.2 + j * BEACON_GAP, z: row.z + (j % 2 ? 1.5 : -1.5), rot: 0 }; }
// One row per repo: a signboard at the west end, a slab for its beacons, a jetty into the cove for its ships.
function syncRepoRows(site, repos, prRepos, runRepos) {
  const store = site.extra.rows, lay = site.extra.lay, seen = new Set();
  repos.forEach((repo, i) => {
    seen.add(repo); const z = rowZ(i, repos.length), col = repoColor(repo), hasRuns = runRepos.includes(repo), hasPrs = prRepos.includes(repo);
    let row = store.get(repo);
    if (!row) {
      row = { z, parts: [], jetty: null, slab: null, color: col }; const g = new THREE.Group(); g.position.set(0, 0, z); site.g.add(g); row.g = g;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(.12, .14, 2.6, 6), mats.wood); post.position.set(lay.yardX0 + 2.5, 1.3, 0); g.add(post);
      const board = box(3.4, 1.1, .16, mats.wood); board.position.set(lay.yardX0 + 2.5, 2.4, 0); g.add(board); const stripe = box(3.4, .22, .18, mat(col, { emissive: col, emissiveIntensity: .25 })); stripe.position.set(lay.yardX0 + 2.5, 3.05, 0); g.add(stripe);
      const lane = box(lay.quay - lay.yardX0 - 1, .08, .5, mat(col, { transparent: true, opacity: .45 })); lane.position.set((lay.quay + lay.yardX0 - 1) / 2, .05, 0); g.add(lane);
      const an = new THREE.Object3D(); an.position.set(lay.yardX0 + 2.5, 4.3, 0); g.add(an); row.an = an;
      row.el = label('w-obj w-repo w-row', esc(repo.split('/').pop()), an, hexStr(col)); store.set(repo, row);
      g.scale.set(.01, 1, 1); tween(600, k => g.scale.x = Math.max(.01, k));
    } else if (row.z !== z) { const fz = row.z; row.z = z; tween(700, k => row.g.position.z = fz + (z - fz) * k); }
    if (hasRuns && !row.slab) { const w = lay.runsMax * BEACON_GAP + 1; const slab = box(w, .14, 5.2, mat(0x8f8a7e)); slab.position.set(lay.xa + w / 2 - .5, .07, 0); row.g.add(slab); row.slab = slab; }
    else if (!hasRuns && row.slab) { disposeObj(row.slab); row.slab = null; }
    if (hasPrs && !row.jetty) { const jg = new THREE.Group(); jg.position.set(lay.quay, 0, 0); row.g.add(jg); const L = lay.jettyL; const deck = box(L, .3, 1.4, mats.wood); deck.position.set(L / 2, .05, 0); jg.add(deck); for (let k = 0; k <= Math.floor(L / 3.5); k++) for (const sd of [-1, 1]) { const pl = new THREE.Mesh(new THREE.CylinderGeometry(.12, .14, 1.8, 6), mats.wood); pl.position.set(1 + k * 3.5, -.7, sd * .75); jg.add(pl); } const lamp = new THREE.Mesh(new THREE.SphereGeometry(.16, 8, 6), new THREE.MeshStandardMaterial({ color: 0xfff1c4, emissive: 0xffd27a, emissiveIntensity: 1.4 })); const lp = new THREE.Mesh(new THREE.CylinderGeometry(.06, .06, 1.6, 5), mats.iron); lp.position.set(L - .6, .95, 0); lamp.position.set(L - .6, 1.85, 0); jg.add(lp, lamp); beacons.push(lamp); row.jetty = jg; jg.scale.set(.01, 1, 1); tween(600, k => jg.scale.x = Math.max(.01, k)); }
    else if (!hasPrs && row.jetty) { disposeObj(row.jetty); row.jetty = null; }
  });
  for (const [repo, row] of store) if (!seen.has(repo)) { store.delete(repo); dropLabel(row.el); disposeObj(row.g); }
}
const PR_GLYPH = pr => pr.state === 'ready' ? ['✓', '#a6e3a1'] : pr.state === 'changes' || pr.state === 'conflict' ? ['✗', '#f38ba8'] : pr.state === 'behind' ? ['⚓', '#f9e2af'] : pr.needsApproval ? ['!', '#f9e2af'] : pr.state === 'blocked' ? ['■', '#fab387'] : ['○', '#94e2d5'];
const RUN_GLYPH = run => run.state === 'running' ? ['⟳', '#f9e2af'] : run.state === 'success' ? ['✓', '#a6e3a1'] : run.state === 'failure' ? ['✗', '#f38ba8'] : run.state === 'cancelled' ? ['–', '#7d8ca3'] : ['○', '#7d8ca3'];
const shipKey = pr => `${pr.state}|${pr.checks}|${pr.behindBy}|${pr.commitCount}|${pr.needsApproval}`;
function makeShipBody(sh) {
  const pr = sh.pr, st = PR_STATE[pr.state] || PR_STATE.open, sg = new THREE.Group(); sh.g.add(sg); sh.body = sg; const rc = repoColor(pr.repo);
  const hull = box(4.2, 1, 1.9, mats.wood); hull.position.y = .5; const bow = new THREE.Mesh(new THREE.ConeGeometry(.95, 1.6, 4), mats.wood); bow.rotation.z = -Math.PI / 2; bow.position.set(2.9, .5, 0); bow.castShadow = true; const deck = box(4.4, .12, 2.1, mats.stoneDark); deck.position.y = 1.02; sg.add(hull, bow, deck);
  const stripe = box(4.3, .22, 1.96, mat(rc)); stripe.position.y = .82; sg.add(stripe); // the repo's colour along the hull
  const crates = Math.min(6, Math.ceil((pr.commitCount || 1) / 4)); for (let c = 0; c < crates; c++) { const cr = box(.55, .55, .55, c % 2 ? mats.wood : mats.scaffold); cr.position.set(-1.6 + (c % 3) * .7, 1.36 + Math.floor(c / 3) * .56, c < 3 ? .45 : -.45); sg.add(cr); }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(.07, .09, 4, 6), mats.dark); mast.position.set(.4, 3, 0); sg.add(mast);
  const sail = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 2.2), mat(st.color, { side: THREE.DoubleSide, emissive: st.color, emissiveIntensity: .1 })); sail.position.set(.4, 3.2, 0); sail.rotation.y = Math.PI / 2; sg.add(sail);
  const pc = pr.checks === 'pass' ? 0xa6e3a1 : pr.checks === 'fail' ? 0xf38ba8 : pr.checks === 'pending' ? 0xf9e2af : 0x7d8ca3; // pass | fail | pending | none, as the PR badge reports them
  const pennant = new THREE.Mesh(new THREE.PlaneGeometry(.9, .4), mat(pc, { side: THREE.DoubleSide })); pennant.position.set(.85, 4.9, 0); sg.add(pennant); flags.push(pennant); sh.pennant = pennant;
  if (pr.behindBy > 0) { const chain = new THREE.Mesh(new THREE.CylinderGeometry(.04, .04, 2.6, 4), mats.iron); chain.position.set(-2.6, .3, .6); chain.rotation.z = .6; sg.add(chain); }
  sh.smoke = null; if (pr.checks === 'fail' || pr.state === 'conflict') { sh.smoke = []; for (let k = 0; k < 4; k++) { const sm = new THREE.Mesh(new THREE.SphereGeometry(.16, 7, 6), new THREE.MeshStandardMaterial({ color: 0x4a3a3a, transparent: true, opacity: .7 })); sg.add(sm); sh.smoke.push({ m: sm, ph: k / 4 }); } }
  // Status flag at the masthead: readable from any distance.
  const [gl, gc] = PR_GLYPH(pr); const b = textSprite(gl, gc, 'rgba(8,12,18,.92)', .9); b.position.set(.4, 5.9, 0); sg.add(b); sh.bubble = b;
  // A ship that waits on the commander signals: a light column over the mast and ripples in the water.
  sh.beam = null; sh.ripples = null;
  const want = pr.needsApproval ? 0xf9e2af : pr.state === 'ready' && pr.mine ? 0xa6e3a1 : 0;
  if (want) {
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(.35, .9, 9, 12, 1, true), new THREE.MeshBasicMaterial({ color: want, transparent: true, opacity: .22, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })); beam.position.set(.4, 5.2, 0); sg.add(beam); sh.beam = beam;
    sh.ripples = []; for (let k = 0; k < 3; k++) { const r = new THREE.Mesh(new THREE.RingGeometry(2.4, 2.7, 40), new THREE.MeshBasicMaterial({ color: want, transparent: true, opacity: .5, depthWrite: false, side: THREE.DoubleSide })); r.rotation.x = -Math.PI / 2; r.position.y = .42; sg.add(r); sh.ripples.push({ m: r, ph: k / 3 }); }
    sh.signal = want;
  }
}
// Cards that read from afar: number and author on one line, the state in words underneath (hidden when zoomed out).
const prWords = pr => { const st = PR_STATE[pr.state] || PR_STATE.open; let w = pr.needsApproval ? 'Needs your review' : st.label; if (pr.checks === 'fail' && pr.state !== 'blocked') w += ' · checks failing'; else if (pr.checks === 'pending') w += ' · checks running'; if (pr.behindBy) w += ' · ' + pr.behindBy + ' behind'; return w; };
const shipLabel = pr => { const [gl] = PR_GLYPH(pr); return `<b>#${pr.number}</b><span class="w-who">@${esc(pr.author || "?")}</span><small>${gl} ${esc(prWords(pr))}</small>`; };
const runLabel = run => { const [gl] = RUN_GLYPH(run), st = RUN_STATE[run.state] || RUN_STATE.none; return `<b>${esc(run.name)}</b><span class="w-who">@${esc(run.actor || "?")}</span><small>${gl} ${st.label}${run.runNumber ? " · #" + run.runNumber : ""}</small>`; };
function syncGithub(site, s) {
  const seen = new Set(); const prs = s.prs || [], runs = s.runs || [];
  const prRepos = [...byRepo(prs).keys()], runRepos = [...byRepo(runs).keys()], repos = [...new Set([...prRepos, ...runRepos])].sort();
  syncRepoRows(site, repos, prRepos, runRepos);
  for (const [repo, list] of byRepo(prs)) list.sort((a, b) => a.number - b.number).forEach((pr, j) => {
    const row = site.extra.rows.get(repo), slot = shipSlot(site, row, j); seen.add(pr.key); let sh = ships.get(pr.key);
    if (!sh) {
      const g = new THREE.Group(); site.g.add(g); g.position.set(slot.x + 24, SHIP_Y, slot.z); g.rotation.y = slot.rot;
      sh = { pr, g, site, ph: Math.random() * 6, key: shipKey(pr), baseY: SHIP_Y, slot }; ships.set(pr.key, sh); makeShipBody(sh);
      const hit = new THREE.Mesh(new THREE.BoxGeometry(5, 5.4, 2.6), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })); hit.position.y = 2.4; hit.userData.pick = { pr, ship: sh }; g.add(hit); sh.hit = hit; pickables.add(hit);
      sh.el = label('w-obj w-gh', shipLabel(pr), g, (PR_STATE[pr.state] || PR_STATE.open).hex, 6.4);
      // Sail in from the open sea to the east.
      tween(1600, k => g.position.x = slot.x + 24 * (1 - k), () => { const wp = new THREE.Vector3(); g.getWorldPosition(wp); burst(wp, '#9fd8e8', 12, 2, 1.5); }, easeOutCubic);
    } else {
      sh.pr = pr; const nk = shipKey(pr);
      if (sh.key !== nk) { const pi = flags.indexOf(sh.pennant); if (pi >= 0) flags.splice(pi, 1); disposeObj(sh.body); sh.key = nk; makeShipBody(sh); sh.el.el.style.setProperty('--c', (PR_STATE[pr.state] || PR_STATE.open).hex); const wp = new THREE.Vector3(); sh.g.getWorldPosition(wp); wp.y += 3; burst(wp, (PR_STATE[pr.state] || PR_STATE.open).hex, 12, 1.5, 2); }
      if (sh.slot.x !== slot.x || sh.slot.z !== slot.z) { const f = { ...sh.slot }; sh.slot = slot; tween(900, k => { sh.g.position.x = f.x + (slot.x - f.x) * k; sh.g.position.z = f.z + (slot.z - f.z) * k; }); }
      setLabel(sh.el, shipLabel(pr));
    }
  });
  for (const [k, sh] of ships) if (!seen.has(k)) destroyShip(sh);
  const rseen = new Set();
  for (const [repo, list] of byRepo(runs)) list.forEach((run, j) => {
    const row = site.extra.rows.get(repo), slot = beaconSlot(site, row, j); rseen.add(run.key); let m = machines.get(run.key);
    if (!m) {
      const g = new THREE.Group(); site.g.add(g); g.position.set(slot.x, -6, slot.z); g.rotation.y = slot.rot;
      m = { run, g, site, ph: Math.random() * 6, key: run.state, slot }; machines.set(run.key, m); makeMachineBody(m);
      const hit = new THREE.Mesh(new THREE.BoxGeometry(3, 5.6, 3), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })); hit.position.y = 2.6; hit.userData.pick = { run, machine: m }; g.add(hit); m.hit = hit; pickables.add(hit);
      m.el = label('w-obj w-gh', runLabel(run), g, (RUN_STATE[run.state] || RUN_STATE.none).hex, j % 2 ? 6.8 : 5.8);
      tween(800, k => g.position.y = -6 + 6 * k, () => { const wp = new THREE.Vector3(); g.getWorldPosition(wp); burst(wp, '#cba6f7', 16, 2.5, 2); }, easeOutCubic);
    } else {
      m.run = run;
      if (m.key !== run.state) { disposeObj(m.body); m.key = run.state; makeMachineBody(m); m.el.el.style.setProperty('--c', (RUN_STATE[run.state] || RUN_STATE.none).hex); const wp = new THREE.Vector3(); m.g.getWorldPosition(wp); wp.y += 4; burst(wp, (RUN_STATE[run.state] || RUN_STATE.none).hex, 16, 1.5, 2.5); }
      if (m.slot.x !== slot.x || m.slot.z !== slot.z) { const f = { ...m.slot }; m.slot = slot; tween(700, k => { m.g.position.x = f.x + (slot.x - f.x) * k; m.g.position.z = f.z + (slot.z - f.z) * k; }); m.el.dy = j % 2 ? 6.8 : 5.8; }
      setLabel(m.el, runLabel(run));
    }
  });
  for (const [k, m] of machines) if (!rseen.has(k)) destroyMachine(m);
  const dbld = buildOf('github'), sg = site.extra.sign; if (dbld && !site.extra.cage) { site.extra.cage = buildCage(site.g, 3, 7.5, 0xd6a545); site.extra.cage.position.set(sg.x, 0, sg.z); } else if (!dbld && site.extra.cage) { for (let i = cranes.length - 1; i >= 0; i--) if (site.extra.cage.getObjectById(cranes[i].g.id)) cranes.splice(i, 1); disposeObj(site.extra.cage); site.extra.cage = null; }
  const live = runs.filter(r => r.state === 'running').length, ready = prs.filter(p => p.state === 'ready').length, waiting = prs.filter(p => p.needsApproval).length, failed = runs.filter(r => r.state === 'failure').length;
  setLabel(site.el, `<div class="w-eyebrow">GitHub harbour</div><b>Pull requests &amp; Actions</b><span class="w-cnt">${prs.length} PR${prs.length === 1 ? "" : "s"}${ready ? " · " + ready + " ready" : ""} · ${runs.length} run${runs.length === 1 ? "" : "s"}${live ? " · " + live + " live" : ""}</span>${dbld ? `<span class="w-cnt">${buildHtml(dbld)}</span>` : ""}${waiting ? `<span class="w-cnt w-alert">⚑ ${waiting} waiting for your review</span>` : ""}${failed ? `<span class="w-cnt w-alert w-bad">✗ ${failed} run${failed === 1 ? "" : "s"} failed</span>` : ""}`);
}
// A signal beacon per run: a brazier that burns while the run is live, a green lamp when it passed, red smoke when it failed.
function makeMachineBody(m) {
  const run = m.run, st = RUN_STATE[run.state] || RUN_STATE.none, mg = new THREE.Group(); m.g.add(mg); m.body = mg; const lit = run.state === 'success' || run.state === 'failure' || run.state === 'running';
  const base = hexPrism(1.15, .8, mats.stone); base.position.y = .4; const step = hexPrism(.8, .5, mats.stoneDark); step.position.y = 1.05; mg.add(base, step);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(.13, .18, 2.7, 6), mats.iron); pole.position.y = 2.6; pole.castShadow = true; mg.add(pole);
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(.78, .42, .7, 7), mats.dark); bowl.position.y = 4.1; mg.add(bowl);
  for (let k = 0; k < 3; k++) { const a = k * Math.PI * 2 / 3; const strut = new THREE.Mesh(new THREE.CylinderGeometry(.04, .04, 1.2, 4), mats.iron); strut.position.set(Math.cos(a) * .5, 3.5, Math.sin(a) * .5); strut.rotation.z = Math.cos(a) * .35; strut.rotation.x = -Math.sin(a) * .35; mg.add(strut); }
  m.lamp = new THREE.MeshStandardMaterial({ color: st.color, emissive: st.color, emissiveIntensity: lit ? 1.4 : .15, transparent: true, opacity: lit ? .95 : .5 });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(run.state === 'running' ? .3 : .5, 10, 8), m.lamp); lamp.position.y = 4.65; mg.add(lamp);
  m.fire = null; if (run.state === 'running') { const f = new THREE.Group(); f.position.y = 4.35; const outer = new THREE.Mesh(new THREE.ConeGeometry(.62, 1.7, 7), new THREE.MeshStandardMaterial({ color: 0xff7a2a, emissive: 0xff5a1a, emissiveIntensity: 1.6, transparent: true, opacity: .85 })); outer.position.y = .85; const inner = new THREE.Mesh(new THREE.ConeGeometry(.32, 1.1, 6), new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0xffd24a, emissiveIntensity: 2, transparent: true, opacity: .95 })); inner.position.y = .55; f.add(outer, inner); mg.add(f); m.fire = f; const glow = new THREE.Mesh(new THREE.RingGeometry(1.2, 2.2, 24), new THREE.MeshBasicMaterial({ color: 0xff9a3a, transparent: true, opacity: .18, depthWrite: false, side: THREE.DoubleSide })); glow.rotation.x = -Math.PI / 2; glow.position.y = .82; mg.add(glow); }
  const [gl, gc] = RUN_GLYPH(run); const flag = textSprite(gl, gc, 'rgba(8,12,18,.92)', .9); flag.position.set(0, 6.3, 0); mg.add(flag); m.flag = flag;
  if (run.state === 'success') banner(mg, 1.2, 0, -.9, st.color);
  m.smoke = null; if (run.state === 'running' || run.state === 'failure') { m.smoke = []; for (let k = 0; k < 5; k++) { const sm = new THREE.Mesh(new THREE.SphereGeometry(.18, 7, 6), new THREE.MeshStandardMaterial({ color: run.state === 'failure' ? 0x4a2a2a : 0x3a3f47, transparent: true, opacity: .7 })); mg.add(sm); m.smoke.push({ m: sm, ph: k / 5 }); } }
}
function destroyShip(sh, quiet) {
  ships.delete(sh.pr.key); dropLabel(sh.el); pickables.delete(sh.hit); const pi = flags.indexOf(sh.pennant); if (pi >= 0) flags.splice(pi, 1); if (selected.pr === sh.pr) { selected = {}; renderSel(); }
  const g = sh.g, x0 = g.position.x; if (quiet) { disposeObj(g); return; }
  const wp = new THREE.Vector3(); g.getWorldPosition(wp); burst(wp, '#9fd8e8', 14, 2, 1.5); fireworks(wp.clone().setY(wp.y + 9), 4); // a PR closed or merged: it sails out to sea
  tween(1800, k => { g.position.x = x0 + 30 * k; g.position.y = SHIP_Y - k * k * 1.2; }, () => disposeObj(g), easeInCubic);
}
function destroyMachine(m, quiet) {
  machines.delete(m.run.key); dropLabel(m.el); pickables.delete(m.hit); if (selected.run === m.run) { selected = {}; renderSel(); }
  const g = m.g; if (quiet) { disposeObj(g); return; }
  const wp = new THREE.Vector3(); g.getWorldPosition(wp); burst(wp, '#7d8ca3', 16, 2, 2);
  tween(700, k => { g.position.y = -6 * k; }, () => disposeObj(g), easeInCubic);
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
  // An online ally keeps a campfire going in front of the tent.
  if (t.peer.connected) { const logs = box(1.1, .18, .18, mats.wood); logs.position.set(0, .1, 3.3); logs.rotation.y = .5; tg.add(logs); const fire = new THREE.Mesh(new THREE.ConeGeometry(.35, .8, 6), new THREE.MeshStandardMaterial({ color: 0xff9a3c, emissive: 0xff6a1a, emissiveIntensity: 1.4, transparent: true, opacity: .9 })); fire.position.set(0, .5, 3.3); tg.add(fire); life.fires.push(fire); }
  const flap = box(.9, 1.2, .1, mats.dark); flap.position.set(0, .6, 2.05); tg.add(flap);
  banner(tg, 2.2, 0, -1.5, t.peer.connected ? 0x89b4fa : 0x555c66);
}
function destroyTent(t, quiet) { tents.delete(t.peer.name); dropLabel(t.el); pickables.delete(t.hit); if (selected.peer === t.peer) { selected = {}; renderSel(); } const g = t.g; if (quiet) { disposeObj(g); return; } tween(400, k => g.scale.setScalar(Math.max(.01, 1 - k)), () => disposeObj(g), easeInCubic); }

/* ────────────────────────── Sync entry point ────────────────────────── */
W.sync = function (s) {
  if (!alive) return; snap = s; economy = s.economy || null;
  const plan = planSites(s), seen = new Set();
  for (const p of plan) { seen.add(p.key); let site = sites.get(p.key); if (!site) site = createSite(p); syncSite(site, p, s); }
  for (const p of plan) { const site = sites.get(p.key); if (site && (site.x !== p.x || site.z !== p.z)) { const fx = site.x, fz = site.z; site.x = p.x; site.z = p.z; tween(700, k => site.g.position.set(fx + (p.x - fx) * k, site.g.position.y, fz + (p.z - fz) * k)); } }
  for (const [k, site] of sites) if (!seen.has(k)) destroySite(site);
  syncRaids(s);
  layoutTerrain([...sites.values()].map(st => ({ x: st.x, z: st.z, R: st.R, kind: st.kind, quay: st.extra.lay ? st.extra.lay.quay : 0 })));
  // Until the commander pans or zooms, keep the whole settlement framed.
  if (!cam.userMoved && sites.size) frameAll();
  const crashed = s.agents.filter(a => a.status === 'crashed').length; life.weather = crashed >= 2 ? 'storm' : crashed === 1 ? 'overcast' : 'clear';
  // Selection follows the app's selected agent whenever that changes; a ship or machine picked here stays picked otherwise.
  if (s.selectedId !== lastSel) { lastSel = s.selectedId; const u = s.selectedId != null ? units.get(s.selectedId) : null; if (u) select({ unit: u }); else if (selected.unit) select({}); }
  else if (selected.unit) renderSel(); // stats may have changed
  // A selected ship, machine or tent points at the object from the latest snapshot; the bar re-renders when its facts
  // change (a button label set by a click, like "Updating…", therefore clears exactly when the PR list comes back).
  if (selected.pr) { const np = (s.prs || []).find(p => p.key === selected.pr.key); if (!np) select({}); else { const sig = np.actionsHtml + np.state + np.checks + np.behindBy + np.commitCount + np.reviewDecision; if (selected.pr !== np || sig !== selSig) { selected.pr = np; selSig = sig; renderSel(); } } }
  else if (selected.run) { const nr = (s.runs || []).find(r => r.key === selected.run.key); if (!nr) select({}); else { const sig = nr.actionsHtml + nr.state + nr.runNumber; if (selected.run !== nr || sig !== selSig) { selected.run = nr; selSig = sig; renderSel(); } } }
  else if (selected.peer) { const npr = (s.peers || []).find(p => p.name === selected.peer.name); if (!npr) select({}); else { const sig = String(npr.connected) + npr.agents; if (selected.peer !== npr || sig !== selSig) { selected.peer = npr; selSig = sig; renderSel(); } } }
  else if (selected.raid) { if (!raiders.has(selected.raid.task.id)) select({}); else { const sig = selected.raid.task.phase + selected.raid.task.priority + selected.raid.task.name + (selected.raid.lot ? selected.raid.lot.cwd : ''); if (sig !== selSig) { selSig = sig; renderSel(); } } }
  else if (selected.site && !sites.has(selected.site.key)) select({});
  else if (selected.site) renderSel(); // balance, build timers and upgrade buttons move with every sync
  detectAwards(s);
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
  if (selected.unit && !selected.unit.mini) { const u = selected.unit, t = performance.now() / 1000; u.ackAt = t; if (u.say) { disposeObj(u.say); u.say = null; } u.say = speechSprite(['Yes, commander!', 'Sir!', 'At your service.', 'Orders?'][Math.floor(Math.random() * 4)]); u.say.position.set(1.2, 3.4 * u.scale, 0); u.g.add(u.say); u.sayUntil = t + 1.6; u.nextSay = Math.max(u.nextSay || 0, t + 8); }
  for (const sh of ships.values()) sh.el.el.classList.toggle('sel', sh.pr === selected.pr);
  for (const m of machines.values()) m.el.el.classList.toggle('sel', m.run === selected.run);
  for (const t of tents.values()) t.el.el.classList.toggle('sel', t.peer === selected.peer);
  for (const rd of raiders.values()) rd.el.el.classList.toggle('sel', rd === selected.raid);
}
function bindInput() {
  const keys = new Set(); let drag = null;
  stage.addEventListener('contextmenu', e => e.preventDefault());
  stage.addEventListener('pointerenter', () => cam.hover = true); stage.addEventListener('pointerleave', () => { cam.hover = false; keys.clear(); });
  selEl.addEventListener('click', e => { const b = e.target.closest && e.target.closest('button.pr-approve'); if (!b || !selected.pr) return; const cl = b.classList, kind = cl.contains('pr-merge') ? 'merge' : cl.contains('pr-update') ? 'update' : (cl.contains('pr-mute') || cl.contains('pr-snooze') || cl.contains('pr-conflictbtn')) ? null : 'review'; if (kind && !b.disabled) intents.set(selected.pr.key, { kind, t: Date.now(), behind: selected.pr.behindBy || 0, number: selected.pr.number }); }, true);
  const touched = () => { cam.lastInput = performance.now() / 1000; if (cam.cine) { cam.cine = false; cam.userMoved = true; } };
  for (const ev of ['pointerdown', 'pointermove', 'wheel']) canvas.addEventListener(ev, touched, { passive: true });
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, moved: false, btn: e.button }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) { stage.classList.add('grabbing'); cam.userMoved = true; const k = .034 * cam.zoom, s = Math.sin(cam.yaw), c = Math.cos(cam.yaw); cam.target.x -= (dx * c + dy * s) * k; cam.target.z -= (dy * c - dx * s) * k; drag.x = e.clientX; drag.y = e.clientY; } return; }
    const r = pick(e); hovered = r.unit || null; canvas.style.cursor = Object.keys(r).length ? 'pointer' : 'default';
    const nr = r.raid || null; if (nr !== hoveredRaid) { if (hoveredRaid && hoveredRaid.el) hoveredRaid.el.el.classList.remove('hov'); hoveredRaid = nr; if (nr) nr.el.el.classList.add('hov'); }
  });
  canvas.addEventListener('pointerup', e => {
    const d = drag; drag = null; stage.classList.remove('grabbing'); if (!d || d.moved) return;
    const r = pick(e);
    if (d.btn === 2) { if (r.unit && !r.unit.mini) hooks.agentMenu && hooks.agentMenu(e, r.unit.a.id); return; }
    if (d.btn !== 0) return;
    if (r.unit) { if (r.unit.mini) { select({ unit: r.unit }); hooks.focusTeamMember && hooks.focusTeamMember(r.unit.a.teamName, r.unit.a.memberName, false); } else { select({ unit: r.unit }); hooks.selectAgent && hooks.selectAgent(r.unit.a.id); } }
    else if (r.pr) select({ pr: r.pr }); else if (r.run) select({ run: r.run }); else if (r.peer) select({ peer: r.peer }); else if (r.raid) select({ raid: r.raid }); else if (r.site) select({ site: r.site }); else select({});
  });
  canvas.addEventListener('dblclick', e => { const r = pick(e); if (r.unit && !r.unit.mini) { flyTo(r.unit.g); hooks.openAgent && hooks.openAgent(r.unit.a.id); } else if (r.pr) hooks.openPr && hooks.openPr(r.pr.url); else if (r.run) hooks.openRun && hooks.openRun(r.run.url); else if (r.peer) hooks.openChat && hooks.openChat(r.peer.name); else if (r.raid) hooks.openRaid && hooks.openRaid(r.raid.task.url); });
  canvas.addEventListener('wheel', e => { e.preventDefault(); if (e.ctrlKey) return; cam.userMoved = true; cam.zoom = Math.min(6.5, Math.max(.4, cam.zoom * (e.deltaY > 0 ? 1.1 : .91))); }, { passive: false });
  const onKey = e => { if (!cam.hover || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return; const k = e.key.toLowerCase(); touched(); if ('wasdqe'.includes(k) || k.startsWith('arrow')) { keys.add(k); cam.userMoved = true; } else if (k === 'f' || k === 'home') frameAll(true); };
  addEventListener('keydown', onKey); addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
  miniEl.addEventListener('pointerdown', e => { cam.userMoved = true; const r = miniEl.getBoundingClientRect(); cam.target.x = ((e.clientX - r.left) / r.width - .5) * terrain.rx * 2.3; cam.target.z = ((e.clientY - r.top) / r.height - .5) * terrain.rz * 2.3; });
  cam.keys = keys;
}
// The frame that shows every site; used at start, on F, and as the war-room orbit's anchor.
function frameBox() { let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity; for (const st of sites.values()) { minX = Math.min(minX, st.x - st.R); maxX = Math.max(maxX, st.x + st.R); minZ = Math.min(minZ, st.z - st.R); maxZ = Math.max(maxZ, st.z + st.R); } const span = Math.max(maxX - minX, (maxZ - minZ) * 1.6); return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 + 2, zoom: Math.min(6, Math.max(1.1, span / 34)) }; }
function frameAll(force) {
  if (!sites.size) return; if (force) { cam.userMoved = false; cam.cine = false; }
  const { cx, cz, zoom } = frameBox(), fx = cam.target.x, fz = cam.target.z, fzoom = cam.zoom, fyaw = cam.yaw;
  if (Math.abs(fx - cx) > .5 || Math.abs(fz - cz) > .5 || Math.abs(fzoom - zoom) > .05 || (force && Math.abs(fyaw) > .01)) tween(900, k => { if (cam.userMoved) return; cam.target.x = fx + (cx - fx) * k; cam.target.z = fz + (cz - fz) * k; cam.zoom = fzoom + (zoom - fzoom) * k; if (force) cam.yaw = fyaw * (1 - k); });
}
function updateCamera(dt) {
  const now = performance.now() / 1000; if (cam.lastInput == null) cam.lastInput = now;
  if (cam.cine) { const { cx, cz, zoom } = frameBox(); cam.yaw += dt * .05; cam.target.x += (cx - cam.target.x) * Math.min(1, .25 * dt); cam.target.z += (cz - cam.target.z) * Math.min(1, .25 * dt); cam.zoom += (zoom * .9 - cam.zoom) * Math.min(1, .25 * dt); }
  const keys = cam.keys, sp = 24 * dt * cam.zoom, s = Math.sin(cam.yaw), c = Math.cos(cam.yaw); let mx = 0, mz = 0;
  if (keys.has('w') || keys.has('arrowup')) mz -= 1; if (keys.has('s') || keys.has('arrowdown')) mz += 1; if (keys.has('a') || keys.has('arrowleft')) mx -= 1; if (keys.has('d') || keys.has('arrowright')) mx += 1;
  cam.target.x += (mx * c + mz * s) * sp; cam.target.z += (mz * c - mx * s) * sp;
  if (keys.has('q')) cam.yaw += dt * 1.4; if (keys.has('e')) cam.yaw -= dt * 1.4;
  const lim = terrain ? { x: terrain.rx * 1.1, z: terrain.rz * 1.1 } : { x: 60, z: 40 };
  cam.target.x = Math.max(-lim.x, Math.min(lim.x, cam.target.x)); cam.target.z = Math.max(-lim.z, Math.min(lim.z, cam.target.z)); cam.target.y = PLAT;
  const off = cam.base.clone().multiplyScalar(cam.zoom).applyAxisAngle(new THREE.Vector3(0, 1, 0), cam.yaw);
  camera.position.copy(cam.target).add(off); camera.lookAt(cam.target);
  if (cam.shake && now < cam.shake.until && !reduceMotion()) { const a = cam.shake.amp * Math.min(1, (cam.shake.until - now) * 2); camera.position.x += (Math.random() - .5) * a; camera.position.y += (Math.random() - .5) * a; camera.position.z += (Math.random() - .5) * a; }
  if (scene.fog) { const dist = off.length(); scene.fog.near = dist + 45; scene.fog.far = dist + 170; }
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
    if (s.kind === 'feature' || s.kind === 'workshop') h = `<div class="w-portrait" style="--c:${hexStr(s.color)}">${s.kind === 'feature' ? '&#x2691;' : '&#x2302;'}</div><div class="w-main" style="--c:${hexStr(s.color)};--sc:var(--dim)"><div class="w-crumb">${s.kind === 'feature' ? 'Feature &middot; <b>' + s.lots.size + ' repo' + (s.lots.size === 1 ? '' : 's') + '</b>' : 'Workshop &middot; <b>directory</b>'}</div><h2>${esc(s.kind === 'feature' ? s.name : first?.spec.title || '')}</h2><div class="w-act">${[...s.lots.values()].map(l => esc(l.spec.title) + (l.spec.server ? ' · :' + l.spec.port : '')).join(' · ')}</div></div><div class="w-orders">${ob('+', 'Agent', 'addAgent') + ob('&#x1F4C2;', 'Folder', 'folder') + upgradeBtn(s)}</div>`;
    else if (s.kind === 'treasury') { const sn = snap || {}, done = (sn.agents || []).filter(a => a.status === 'waiting').length; const fk = n => n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'M' : n + 'K'; h = `<div class="w-portrait" style="--c:#e1b453">$</div><div class="w-main" style="--c:#e1b453;--sc:var(--dim)"><div class="w-crumb">Treasury &middot; <b>today</b></div><h2>${esc(fmtMoney(sn.cost || 0))} spent</h2><div class="w-act">${(sn.agents || []).length} units afield &middot; ${done} done &middot; ${sn.turns || 0} turns served</div></div><div class="w-stats"><div class="w-stat"><span class="k">Tokens in</span><span class="v">${fk(Math.round((sn.tokIn || 0) / 1000))}</span></div><div class="w-stat"><span class="k">Tokens out</span><span class="v">${fk(Math.round((sn.tokOut || 0) / 1000))}</span></div><div class="w-stat"><span class="k">Balance</span><span class="v" style="color:var(--w-gold)">⬡ ${coins().toLocaleString()}</span></div><div class="w-stat"><span class="k">Title</span><span class="v">${esc(sn.title || 'Overseer')}</span></div></div><div class="w-orders w-shop">${shopButtons()}</div>`; }
    else if (s.kind === 'plant') { const u = (snap && snap.usage) || null, bars = (u && u.bars) || []; const ago = u && u.fetchedAt ? Math.round((Date.now() - u.fetchedAt) / 1000) : 0; const ageStr = !u || !u.fetchedAt ? '' : ago < 60 ? ago + 's ago' : Math.round(ago / 60) + 'm ago';
      h = `<div class="w-portrait" style="--c:${PLANT_HEX}">&#x26A1;</div><div class="w-main" style="--c:${PLANT_HEX};--sc:var(--dim)"><div class="w-crumb">Power plant &middot; <b>supply</b></div><h2>${bars.length ? bars.map(b => esc(b.label) + ' ' + b.pct.toFixed(1) + '%').join(' &middot; ') : 'No reading yet'}</h2><div class="w-act">${u && u.pace ? `<span class="w-pace ${u.pace.state}">${u.pace.label}</span> &middot; used ${u.pace.actual.toFixed(1)}% of the week, expected ${u.pace.expected.toFixed(1)}%` : 'Session, week and per-model caps as read from Claude'}${ageStr ? ' &middot; read ' + ageStr : ''}</div></div><div class="w-stats">${bars.map(b => `<div class="w-stat"><span class="k">${esc(b.label)}</span><span class="v" style="color:${usageTone(b.pct).css}">${b.pct.toFixed(1)}%</span><span class="k">${esc(fmtReset(b.reset, b.date))}</span></div>`).join('')}</div><div class="w-orders"><button class="w-btn" data-cmd="usage" title="Fetch the latest usage reading"><span class="g">&#x21bb;</span>Refresh</button></div>`; }
    else if (s.kind === 'github') h = `<div class="w-portrait" style="--c:#c9d1d9">GH</div><div class="w-main" style="--c:#c9d1d9;--sc:var(--dim)"><div class="w-crumb">GitHub harbour</div><h2>Pull requests &amp; Actions</h2><div class="w-act">${DOCK_TIERS[tierOf('github') - 1]} &middot; one row per repo: signal beacons are tracked runs, ships at the jetty are open PRs. Double-click one to open it on GitHub.</div></div><div class="w-orders">${upgradeBtn(s)}</div>`;
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
  } else if (selected.raid) {
    const rd = selected.raid, r = rd.task, tier = rd.tier, hex = RAID_HEX[r.priority] || RAID_HEX.none, base = rd.lot ? rd.lot.spec.title : rd.site ? (rd.site.kind === 'treasury' ? 'the Treasury' : rd.site.key) : '?';
    h = `<div class="w-portrait" style="--c:${hex}">&#x2620;</div><div class="w-main" style="--c:${hex};--sc:${hex}"><div class="w-crumb">${r.phase === 'fight' ? 'Under fire' : 'Raid'} &middot; <b>${tier.name}</b> &middot; ${esc(r.list.name)}${r.assignees.length ? ' &middot; ' + esc(r.assignees.join(', ')) : ''}</div><h2>${esc(r.name)}</h2><div class="w-act">${(r.priority === 'none' ? 'no' : r.priority).toUpperCase()} priority ${r.platforms.length ? '&middot; ' + esc(r.platforms.join(', ')) : '&middot; no platform'} &middot; ${rd.state === 'march' || rd.state === 'emerge' ? 'marching on' : 'besieging'} <b>${esc(base)}</b>${r.target ? '' : ' (no base mapped: picked at random)'} &middot; ${sinceStr(r.since)}</div></div>
      <div class="w-orders">${ob('&#x1F4DC;', 'Quest', 'quest') + ob('&#x2398;', 'Copy link', 'copyRaid') + ob('&#x2197;', 'ClickUp', 'openRaid')}</div>`;
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
    case 'openRaid': hooks.openRaid && hooks.openRaid(selected.raid.task.url); break;
    case 'quest': { const rd = selected.raid; if (rd && hooks.openQuest) hooks.openQuest(rd.task, rd.lot ? rd.lot.spec.title : rd.site && rd.site.kind === 'treasury' ? 'the Treasury' : ''); break; }
    case 'copyRaid': hooks.copyLink && hooks.copyLink(selected.raid.task.url); break;
    case 'upgrade': { const st = selected.site; if (!st) break; const up = upgradeInfo(st); if (!up || !hooks.spend) break; if (hooks.spend(up.cost, { upgrade: st.key, tier: up.next, label: up.name, dur: up.dur })) toast(`${up.name}: construction started — ${up.cost} ⬡`); break; }
    case 'usage': hooks.refreshUsage && hooks.refreshUsage(); toast('Reading the meters…'); break;
    default: if (cmd.startsWith('buy:')) { const id = cmd.slice(4), d = DECOS[id]; if (d && hooks.spend && hooks.spend(d.cost, { deco: id, label: d.name, dur: DECO_TIME })) toast(`${d.name}: construction started — ${d.cost} ⬡`); }
  }
}
function upgradeInfo(site) {
  const isDock = site.kind === 'github', names = isDock ? DOCK_TIERS : site.kind === 'feature' ? TOWER_TIERS : HALL_TIERS, costs = isDock ? DOCK_COST : TIER_COST, cur = tierOf(site.key);
  if (cur >= names.length) return null; return { next: cur + 1, name: names[cur], cost: costs[cur], curName: names[cur - 1], dur: (isDock ? DOCK_TIME : TIER_TIME)[cur] };
}
function upgradeBtn(site) { const b = buildOf(site.key); if (b) { const p = buildProgress(b); return `<button class="w-btn buy" disabled title="${esc(b.name)}: ${Math.round(p.pct * 100)}% built, ${p.left} to go"><span class="g">⚒ ${p.left}</span>Building…</button>`; } const up = upgradeInfo(site); if (!up) return `<button class="w-btn buy" disabled title="Top tier reached"><span class="g">⬡</span>Max</button>`; return `<button class="w-btn buy" data-cmd="upgrade" ${coins() < up.cost ? 'disabled' : ''} title="Upgrade to ${up.name} for ${up.cost} coins (you have ${coins()})"><span class="g">⬡ ${up.cost}</span>${up.name}</button>`; }
function shopButtons() {
  let h = ''; for (const [id, d] of Object.entries(DECOS)) { const owned = economy && economy.deco && economy.deco[id], bb = buildOf('deco:' + id); if (bb) { const p = buildProgress(bb); h += `<button class="w-btn buy" disabled title="${d.name}: ${p.left} to go"><span class="g">⚒ ${p.left}</span>Building…</button>`; continue; } h += owned ? `<button class="w-btn buy" disabled title="${d.name}: built"><span class="g">✓</span>${d.name}</button>` : `<button class="w-btn buy" data-cmd="buy:${id}" ${coins() < d.cost ? 'disabled' : ''} title="${d.name} for ${d.cost} coins"><span class="g">⬡ ${d.cost}</span>${d.name}</button>`; }
  return h;
}
// Decorations bought at the treasury.
function syncDecos(site) {
  const own = (economy && economy.deco) || {}; site.extra.decos = site.extra.decos || {};
  const add = (id, build) => { if (own[id] && !site.extra.decos[id]) { const g = new THREE.Group(); site.g.add(g); build(g); site.extra.decos[id] = g; g.scale.setScalar(.01); tween(700, k => g.scale.setScalar(Math.max(.01, k)), null, easeOutBack); } else if (!own[id] && site.extra.decos[id]) { disposeObj(site.extra.decos[id]); delete site.extra.decos[id]; } };
  add('fountain', g => { g.position.set(-4, .5, 1.5); const basin = hexPrism(1.5, .5, mat(0xe8e4dc)); basin.position.y = .25; const water = hexPrism(1.3, .1, mats.water); water.position.y = .52; const col = new THREE.Mesh(new THREE.CylinderGeometry(.18, .25, 1.4, 6), mat(0xe8e4dc)); col.position.y = 1.2; const bowl = hexPrism(.6, .12, mat(0xe8e4dc)); bowl.position.y = 1.9; g.add(basin, water, col, bowl); life.fountains.push(g); });
  add('statue', g => { g.position.set(4, .5, 1.5); const ped = hexPrism(1, .9, mat(0xe8e4dc)); ped.position.y = .45; const body = box(.8, .9, .5, mats.gold); body.position.y = 1.5; const head = box(.55, .5, .55, mats.gold); head.position.y = 2.25; const crown = new THREE.Mesh(new THREE.CylinderGeometry(.34, .3, .2, 6), mats.gold); crown.position.y = 2.6; const armL = box(.22, .8, .22, mats.gold); armL.position.set(-.55, 1.9, 0); armL.rotation.z = .5; const armR = box(.22, .8, .22, mats.gold); armR.position.set(.55, 2.1, 0); armR.rotation.z = -2.6; g.add(ped, body, head, crown, armL, armR); });
  add('lanterns', g => { for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3, r = site.R - 1; const pole = new THREE.Mesh(new THREE.CylinderGeometry(.05, .07, 2.2, 5), mats.dark); pole.position.set(Math.cos(a) * r, .5 + 1.1, Math.sin(a) * r); const l = new THREE.Mesh(new THREE.SphereGeometry(.2, 8, 6), mats.torch); l.position.set(Math.cos(a) * r, .5 + 2.35, Math.sin(a) * r); g.add(pole, l); life.torches.push(l); } });
  add('gardens', g => { for (let k = 0; k < 14; k++) { const a = k / 14 * Math.PI * 2, r = site.R - 2.2 + Math.sin(k * 3) * .4; const f = new THREE.Mesh(new THREE.SphereGeometry(.16 + Math.random() * .08, 6, 5), mat([0xf5c2e7, 0xf9e2af, 0xfab387, 0x94e2d5][k % 4])); f.position.set(Math.cos(a) * r, .5 + .16, Math.sin(a) * r); const leaf = new THREE.Mesh(new THREE.SphereGeometry(.24, 6, 5), mat(0x4f9645)); leaf.position.set(Math.cos(a) * r, .5, Math.sin(a) * r); leaf.scale.y = .5; g.add(leaf, f); } });
}
// ── Awards: read from transitions in the snapshot, never from spend. ──
const prevAg = new Map(), intents = new Map(), quickTimes = []; let awardsArmed = false;
const rankMult = turns => [1, 1, 1.5, 2, 3][rankOf(turns).stripes] || 1;
function give(kind, amount, text) { if (!hooks.award) return; setTimeout(() => hooks.award(kind, amount, text), 0); }
function detectAwards(s) {
  const now = s.now || Date.now();
  if (awardsArmed) {
    for (const a of s.agents) {
      const p = prevAg.get(a.id); if (!p) continue;
      if (a.turns > p.turns) give('turns', 2 * (a.turns - p.turns) * rankMult(a.turns), `${a.turns - p.turns} turn${a.turns - p.turns === 1 ? '' : 's'} by ${a.title.slice(0, 28)}`);
      const wasNeed = p.status === 'permission' || p.status === 'question', wasBusy = ['active', 'settling', 'permission', 'question'].includes(p.status);
      if (a.status === 'waiting' && wasBusy) give('jobs', 10, `${a.title.slice(0, 28)} finished the job`);
      if (wasNeed && !(a.status === 'permission' || a.status === 'question') && a.status !== 'crashed' && p.askAt && now - p.askAt <= 120000) { const cut = now - 3600000; while (quickTimes.length && quickTimes[0] < cut) quickTimes.shift(); if (quickTimes.length < 12) { quickTimes.push(now); give('quick', 5, 'quick answer for ' + a.title.slice(0, 28)); } }
      if ((p.status === 'crashed' || p.status === 'resuming') && (a.status === 'active' || a.status === 'waiting')) give('resumes', 10, a.title.slice(0, 28) + ' is back on its feet');
    }
    for (const [key, it] of intents) {
      const pr = (s.prs || []).find(p => p.key === key); if (now - it.t > 300000) { intents.delete(key); continue; }
      if (it.kind === 'merge' && !pr) { give('merges', 50, 'merged PR #' + it.number); intents.delete(key); }
      else if (it.kind === 'review' && (!pr || pr.reviewDecision === 'APPROVED')) { give('reviews', 25, 'reviewed PR #' + it.number); intents.delete(key); }
      else if (it.kind === 'update' && pr && it.behind > 0 && pr.behindBy === 0) { give('updates', 10, 'updated PR #' + it.number); intents.delete(key); }
    }
  }
  const seen = new Set();
  for (const a of s.agents) { seen.add(a.id); const p = prevAg.get(a.id), need = a.status === 'permission' || a.status === 'question'; prevAg.set(a.id, { turns: a.turns, status: a.status, askAt: need ? (p && p.askAt) || now : null }); }
  for (const id of [...prevAg.keys()]) if (!seen.has(id)) prevAg.delete(id);
  awardsArmed = true;
}
W.buildComplete = function (key, b) {
  if (!alive) return; const site = key.startsWith('deco:') ? sites.get('treasury') : sites.get(key); if (!site) return;
  const wp = new THREE.Vector3(); site.g.getWorldPosition(wp); wp.y += 8; fireworks(wp, 8); toast(`${b.name} complete!`);
  const an = label('w-done', esc(b.name) + ' complete!', site.g, '#f9e2af', 9); tween(3200, k => { an.dy = 9 + k * 3; an.el.style.opacity = String(k < .8 ? 1 : (1 - k) * 5); }, () => dropLabel(an));
  const t = performance.now() / 1000; for (const lot of site.lots.values()) for (const u of lot.units.values()) u.cheerUntil = t + 3;
};
W.coinsChanged = function (eco, text) {
  if (!alive) return; economy = eco; toast(text); renderSel();
  const st = sites.get('treasury'); if (st) { const an = label('w-award', esc(text), st.g, '#f9e2af', 4); tween(1600, k => { an.dy = 4 + k * 5; an.el.style.opacity = String(1 - k); }, () => dropLabel(an)); const wp = new THREE.Vector3(); st.g.getWorldPosition(wp); wp.y += 2; burst(wp, '#f9e2af', 14, 1.5, 3); }
  if (st) setLabel(st.el, `Treasury · ${esc(fmtMoney((snap && snap.cost) || 0))} today · ⬡ ${coins().toLocaleString()}`);
};

/* ────────────────────────── Animation ────────────────────────── */
function animateUnit(u, t, dt) {
  const { p: m, inner, a } = u, s = a.status, T = reduceMotion() ? 0 : t;
  m.armL.rotation.set(0, 0, 0); m.armR.rotation.set(0, 0, 0); inner.rotation.set(0, u.face, 0); inner.position.y = 0; inner.scale.setScalar(u.scale); m.head.rotation.set(0, 0, 0);
  u.g.position.y = .56 + (u.ackAt && t < u.ackAt + .6 ? Math.sin((t - u.ackAt) / .6 * Math.PI) * .38 : 0); // a hop when the commander clicks
  if (u.shootUntil && t < u.shootUntil) { m.armR.rotation.x = -1.6; m.armR.rotation.z = -.2; return; } // loosing a bolt at a raider
  if (u.carry) { u.carry.visible = !!(u.walk && !u.walk.back); if (!u.walk) { disposeObj(u.carry); u.carry = null; } }
  m.ring.material.opacity = u === selected.unit ? .95 : u === hovered ? .5 : 0; m.disc.scale.setScalar(1); m.disc.material.opacity = .32;
  if (m.think) { m.think.position.y = 2.6 * u.scale + Math.sin(T * 2.2 + u.phase) * .08; m.think.position.x = .35 * u.scale; }
  if (m.eyes && !reduceMotion()) { if (!u.blinkAt) u.blinkAt = t + 2 + Math.random() * 4; const bl = t > u.blinkAt && t < u.blinkAt + .12; for (const e of m.eyes) e.scale.y = s === 'crashed' ? .6 : bl ? .15 : 1; if (t > u.blinkAt + .12) u.blinkAt = t + 2.5 + Math.random() * 4; }
  if (a.ctxPct >= 80 && !u.mini && t > (u.heatAt || 0)) { u.heatAt = t + .5; const wp = new THREE.Vector3(); u.g.getWorldPosition(wp); wp.y += 1.9 * u.scale; burst(wp, '#f38ba8', 2, .3, 1.6); } // near the context limit: steaming
  // Crew keep formation: when the lead wanders, its teammates follow at their offsets.
  if (u.mini && u.lead && u.lead.g) { const L = u.lead, gx = L.g.position.x + (u.tx - L.tx), gz = L.g.position.z + (u.tz - L.tz), dx = gx - u.g.position.x, dz = gz - u.g.position.z, d = Math.hypot(dx, dz); if (d > .04) { const k = Math.min(1, 4 * dt); u.g.position.x += dx * k; u.g.position.z += dz * k; if (d > .3) { const sw = Math.sin(T * 11); m.legL.rotation.x = sw * .5; m.legR.rotation.x = -sw * .5; inner.rotation.y = Math.atan2(dx, dz); return; } } }
  switch (s) {
    case 'active': case 'settling': {
      // Every so often a working unit leaves its bench for a short errand across the lot, then comes back to hammer.
      if (!reduceMotion() && !u.mini) {
        // Hammer for a while, then carry a block to the building and place it on the scaffold.
        if (!u.walk) { if (!u.nextHaul) u.nextHaul = t + 3 + Math.random() * 5; else if (t > u.nextHaul) { const tx = Math.sign(u.tx || 1) * 1.6, tz = -.4, r = Math.hypot(tx - u.tx, tz - u.tz); u.walk = { fx: u.tx, fz: u.tz, tx, tz, t: 0, dur: Math.max(.7, r / 2.2), back: false, pause: 0, haul: true }; u.carry = hexPrism(.32, .34, mat(u.lot.spec.color)); u.carry.position.set(0, 1.42, .46); inner.add(u.carry); } }
        sayTick(u, t, () => workLine(a.tool), 35, 25);
        if (u.walk) {
          const w = u.walk;
          if (w.pause > 0) { w.pause -= dt; m.head.rotation.x = .25; m.armL.rotation.x = .2; m.armR.rotation.x = .2; }
          else {
            w.t += dt; const k = Math.min(1, w.t / w.dur), ax = w.back ? w.tx : w.fx, az = w.back ? w.tz : w.fz, bx = w.back ? w.fx : w.tx, bz = w.back ? w.fz : w.tz;
            u.g.position.x = ax + (bx - ax) * k; u.g.position.z = az + (bz - az) * k; inner.rotation.y = Math.atan2(bx - ax, bz - az);
            const st = Math.sin(T * 11); m.legL.rotation.x = st * .55; m.legR.rotation.x = -st * .55; m.armL.rotation.x = -st * .45; m.armR.rotation.x = st * .45; inner.position.y = Math.abs(st) * .05;
            if (k >= 1) { if (!w.back) { w.back = true; w.t = 0; w.pause = .8 + Math.random(); if (w.haul) placeBlock(u); } else { u.walk = null; u.g.position.set(u.tx, u.g.position.y, u.tz); u.nextHaul = t + 4 + Math.random() * 7; } }
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
      if (s === 'waiting') {
        // Done and waiting: at ease, looking around; after a minute it leans on the bench and kicks its heels.
        const lean = a.idleMin >= 1 && !u.mini; inner.scale.y = u.scale * (1 + Math.sin(T * 2 + u.phase) * .015); m.head.rotation.y = Math.sin(T * .6 + u.phase) * .6;
        if (lean) { inner.rotation.z = .12; m.armL.rotation.x = .2; m.armR.rotation.x = -.9; m.armR.rotation.z = -.5; m.legL.rotation.x = Math.max(0, Math.sin(T * 2.4 + u.phase)) * .6; m.legR.rotation.x = 0; }
        else { m.armL.rotation.x = .2; m.armR.rotation.x = .2; m.legL.rotation.x = 0; m.legR.rotation.x = 0; }
      }
      else {
        // Idle from the first minute: the unit sits down, dozes with drifting z's, and stretches now and then.
        const stretch = Math.sin(T * .3 + u.phase) > .9; inner.position.y = -.28 * u.scale; m.legL.rotation.x = -1.5; m.legR.rotation.x = -1.5;
        if (stretch) { m.armL.rotation.x = -2.9; m.armR.rotation.x = -2.9; m.head.rotation.x = -.3; }
        else { inner.rotation.z = Math.sin(T * .9 + u.phase) * .05; m.head.rotation.x = .42 + Math.sin(T * 1.2) * .04; m.armL.rotation.x = -.6; m.armR.rotation.x = -.6; }
        const f = ((T * .35 + u.phase) % 1 + 1) % 1; m.bubble.position.set(.35 + f * .3, 1.9 + f * .9, 0); m.bubble.material.opacity = 1 - f;
        if (a.idleMin >= 1 && !u.mini && t > (u.yawnAt || u.phase * 5)) { u.yawnAt = t + 20 + Math.random() * 20; const wp = new THREE.Vector3(); u.g.getWorldPosition(wp); wp.y += 1.6 * u.scale; burst(wp, '#cfd7e2', 3, .3, 1.2); }
      }
      break;
    case 'crashed': inner.rotation.z = -Math.PI / 2 + .1; inner.rotation.y = u.face + .6; inner.position.y = .38; m.armL.rotation.x = -.4; m.armR.rotation.x = .6; for (const sm of m.smoke) { const f = ((T * .3 + sm.ph) % 1 + 1) % 1; sm.m.position.set(.4 + Math.sin(f * 6 + sm.ph * 9) * .15 - f * .3, .4 + f * 1.8, .2 + Math.cos(f * 5) * .15); sm.m.scale.setScalar(.6 + f * 1.3); sm.m.material.opacity = .65 * (1 - f); } m.bubble.position.set(0, 1.6, 0); break;
    case 'resuming': inner.rotation.y = T * 3.2; inner.position.y = .12 + Math.abs(Math.sin(T * 4)) * .14; m.arc.rotation.z = -T * 2.4; m.bubble.material.rotation = -T * 2; break;
  }
}
const v3 = () => new THREE.Vector3();
function updateLabels() {
  const w = canvas.clientWidth, h = canvas.clientHeight, p = v3(); labelsEl.classList.toggle('far', cam.zoom > 2.4); labelsEl.classList.toggle('vfar', cam.zoom > 4.2); labelsEl.classList.toggle('near', cam.zoom < 1.05);
  const place = (el, v) => { if (v.z > 1) { el.style.opacity = 0; return; } el.style.opacity = 1; el.style.transform = `translate(${(v.x + 1) / 2 * w}px, ${(1 - v.y) / 2 * h}px) translate(-50%, -100%)`; };
  for (const a of anchors) { if (!a.obj) continue; a.obj.getWorldPosition(p); p.y += a.dy || 0; p.project(camera); place(a.el, p); }
  const u = selected.unit || hovered;
  if (u !== cardFor) { cardFor = u; card.hidden = !u; if (u) { const a = u.a, st = STATUS[a.status]; card.style.setProperty('--c', `var(${st.css})`); card.className = 'w-lab w-card' + (u === selected.unit ? ' sel' : ''); card.innerHTML = `<b>${esc(a.title)}</b><small>${st.sym} ${esc(activity(a))}</small>${u.mini ? '' : `<div class="w-meta"><span title="${a.turns || 0} turns served">${rankOf(a.turns).name}</span><span>ctx ${a.ctxPct}%</span><div class="w-bar ${ctxCls(a.ctxPct)}"><i style="width:${a.ctxPct}%"></i></div><span>${esc(a.model || '')}</span><span style="color:var(--w-gold)">${esc(a.costStr || '')}</span></div>`}`; } }
  else if (u && card.dataset.k !== u.key + a_ctx(u)) { /* cheap refresh when the same unit changes */ cardFor = null; }
  if (u) { u.g.getWorldPosition(p); p.y += (u.p.bubble ? 3.1 : 2.4) * u.scale; p.project(camera); place(card, p); u.pill.el.style.opacity = 0; card.dataset.k = u.key + a_ctx(u); }
}
const a_ctx = u => '|' + u.a.ctxPct + '|' + u.a.costStr + '|' + (u.a.verb || '');
function drawMinimap() {
  const mg = miniEl.getContext('2d'), Wm = miniEl.width, Hm = miniEl.height, rx = terrain.rx * 1.15, rz = terrain.rz * 1.15, X = x => (x / rx / 2 + .5) * Wm, Z = z => (z / rz / 2 + .5) * Hm, p = v3();
  mg.fillStyle = '#0d1a2a'; mg.fillRect(0, 0, Wm, Hm);
  mg.fillStyle = '#2b5b3e'; mg.beginPath(); mg.ellipse(Wm / 2, Hm / 2, Wm / 2 / 1.15, Hm / 2 / 1.15, 0, 0, Math.PI * 2); mg.fill();
  const hexPath = (cx, cy, r) => { mg.beginPath(); for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; k ? mg.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a)) : mg.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a)); } mg.closePath(); };
  for (const s of sites.values()) { hexPath(X(s.x), Z(s.z), s.R * Wm / rx / 2); mg.fillStyle = s.kind === 'github' ? 'rgba(27,75,94,.95)' : s.kind === 'plant' ? 'rgba(46,88,98,.95)' : s.kind === 'portal' ? 'rgba(58,28,74,.95)' : 'rgba(60,74,82,.95)'; mg.fill(); mg.strokeStyle = hexStr(s.color || 0xc9d1d9); mg.lineWidth = 1.5; mg.stroke(); }
  const dot = (o, hex, r, on) => { o.getWorldPosition(p); hexPath(X(p.x), Z(p.z), r); mg.fillStyle = hex; mg.fill(); if (on) { mg.strokeStyle = '#fff'; mg.lineWidth = 1.2; hexPath(X(p.x), Z(p.z), r + 2.5); mg.stroke(); } };
  for (const sh of ships.values()) dot(sh.g, (PR_STATE[sh.pr.state] || PR_STATE.open).hex, 3, sh.pr === selected.pr);
  for (const m of machines.values()) dot(m.g, (RUN_STATE[m.run.state] || RUN_STATE.none).hex, 3, m.run === selected.run);
  for (const u of units.values()) dot(u.g, hexStr(STATUS[u.a.status].hex), u.mini ? 1.6 : 3, u === selected.unit);
  for (const rd of raiders.values()) dot(rd.g, RAID_HEX[rd.task.priority] || RAID_HEX.none, rd.tier.scale >= 1.5 ? 4.5 : 3, rd === selected.raid);
  // Pings: anything that needs the commander pulses on the map.
  const tp = performance.now() / 1000, pulse = 4 + 3 * (.5 + .5 * Math.sin(tp * 5));
  for (const u of units.values()) { const a = u.a; if (u.mini) continue; const need = a.status === 'permission' || a.status === 'question' || a.status === 'crashed' || a.idleMin >= IDLE_CALL_MIN; if (!need) continue; u.g.getWorldPosition(p); hexPath(X(p.x), Z(p.z), pulse); mg.strokeStyle = a.status === 'crashed' ? '#f38ba8' : '#f9e2af'; mg.lineWidth = 1.5; mg.stroke(); }
  for (const sh of ships.values()) if (sh.pr.needsApproval) { sh.g.getWorldPosition(p); hexPath(X(p.x), Z(p.z), pulse); mg.strokeStyle = '#f9e2af'; mg.lineWidth = 1.5; mg.stroke(); }
  const vw = 30 * cam.zoom * (canvas.clientWidth / Math.max(1, canvas.clientHeight)) * .78 * Wm / rx / 2, vh = 22 * cam.zoom * Hm / rz / 2;
  mg.save(); mg.translate(X(cam.target.x), Z(cam.target.z)); mg.rotate(-cam.yaw); mg.strokeStyle = 'rgba(214,165,69,.9)'; mg.lineWidth = 1.5; mg.beginPath(); mg.moveTo(-vw / 2 * .8, -vh / 2); mg.lineTo(vw / 2 * .8, -vh / 2); mg.lineTo(vw / 2, vh / 2); mg.lineTo(-vw / 2, vh / 2); mg.closePath(); mg.stroke(); mg.restore();
}
function tick(now) {
  if (!alive) return; raf = requestAnimationFrame(tick);
  const dt = Math.min(.05, (now - lastT) / 1000); lastT = now; const t = now / 1000;
  runTweens(now); updateCamera(dt); updateTerrain(dt); runPuffs(dt); updateFx(now / 1000, dt);
  for (const u of units.values()) if (u.p) animateUnit(u, t, dt);
  for (const rd of raiders.values()) animateRaider(rd, t, dt);
  if (!reduceMotion()) {
    flags.forEach((f, i) => { f.rotation.y = Math.sin(t * 2.2 + i) * .18; }); for (const b of beacons) b.material.emissiveIntensity = 1 + (b.userData.nightBoost || 0) + Math.sin(t * 3) * .7;
    for (const c of cranes) { if (c.spin) { c.jib.rotation.z = t * 1.1; continue; } c.jib.rotation.y = Math.sin(t * .35 + c.ph) * .9; c.block.position.y = -2.4 + Math.sin(t * .7 + c.ph) * .5; }
    for (const sh of ships.values()) { sh.g.position.y = sh.baseY + Math.sin(t * 1.1 + sh.ph) * .08; sh.g.rotation.z = Math.sin(t * .8 + sh.ph) * .035 + (sh.pr.behindBy ? .1 : 0); if (sh.smoke) for (const sm of sh.smoke) { const f = ((t * .3 + sm.ph) % 1 + 1) % 1; sm.m.position.set(-1.5 + f * .4, 1.4 + f * 1.6, Math.sin(f * 7) * .2); sm.m.scale.setScalar(.6 + f * 1.2); sm.m.material.opacity = .6 * (1 - f); }
      if (sh.beam) { const k = .5 + .5 * Math.sin(t * 2.6 + sh.ph); sh.beam.material.opacity = .12 + k * .22; sh.beam.scale.set(1 + k * .25, 1, 1 + k * .25); sh.bubble.scale.setScalar(.9 + k * .35); sh.bubble.position.y = 5.9 + k * .3; for (const r of sh.ripples) { const f = ((t * .45 + r.ph) % 1 + 1) % 1; r.m.scale.setScalar(.6 + f * 1.6); r.m.material.opacity = .55 * (1 - f); } } }
    for (const m of machines.values()) { if (m.fire) { const k = .8 + .2 * Math.sin(t * 9 + m.ph) + .12 * Math.sin(t * 23 + m.ph * 3); m.fire.scale.set(k, .75 + k * .5, k); m.fire.rotation.y = t * 2.5; m.lamp.emissiveIntensity = 1 + Math.sin(t * 5 + m.ph) * .6; } if (m.smoke) for (const sm of m.smoke) { const f = ((t * (m.run.state === 'failure' ? .22 : .4) + sm.ph) % 1 + 1) % 1; sm.m.position.set(Math.sin(f * 6 + sm.ph * 9) * .25, 4.9 + f * 2.4, Math.cos(f * 5 + sm.ph * 7) * .2); sm.m.scale.setScalar(.5 + f * 1.4); sm.m.material.opacity = .65 * (1 - f); } }
    for (const s of sites.values()) if (s.extra.plant) { const P = s.extra.plant, load = .25 + P.load; P.core.material.emissiveIntensity = 1.2 + Math.sin(t * 3) * .5; P.core.scale.setScalar(1 + Math.sin(t * 3) * .06); P.turbine.rotation.z = t * (.6 + P.load * 2.4); for (const sm of P.steam) { const f = ((t * .28 * load + sm.ph) % 1 + 1) % 1; sm.m.position.set(-4.2 + Math.sin(f * 5 + sm.ph * 9) * .5, 5.2 + f * 3.2, -1.6 + Math.cos(f * 4 + sm.ph * 7) * .4); sm.m.scale.setScalar(.5 + f * 1.6); sm.m.material.opacity = .5 * (1 - f) * Math.min(1, .3 + P.load * 1.4); } }
    for (const s of sites.values()) if (s.extra.mark) s.extra.mark.position.y = s.extra.markY + Math.sin(t * 1.2) * .25;
    for (const s of sites.values()) if (s.extra.portal) animatePortal(s.extra.portal, t, s);
    for (const m of machines.values()) if (m.flag && m.run.state === 'running') m.flag.material.rotation = -t * 2;
  }
  updateLife(t, dt);
  renderer.render(scene, camera); updateLabels(); drawMinimap();
}

/* ────────────────────────── Life: daylight, creatures, idle calls, celebrations, treasury ────────────────────────── */
const life = { clouds: [], birds: [], flies: [], fish: null, torches: [], chimneys: [], fires: [], flyHomes: [], dayK: 1, lastDay: -1, weather: 'clear', rain: null, sky: null, sunBase: 1.6, flashUntil: 0, stars: null, meteor: null, ship: null, gulls: [], spot: null, medics: new Map(), fountains: [], lighthouse: null, orbits: [], beams: [], buoys: [] };
const IDLE_CALL_MIN = 3; // minutes of nothing to do before a unit starts calling for orders
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
  // Stars on a far dome, only visible at night; a meteor now and then.
  { const N = 700, pos = new Float32Array(N * 3); for (let i = 0; i < N; i++) { const a = Math.random() * Math.PI * 2, e = .12 + Math.random() * 1.2, r = 190; pos[i * 3] = Math.cos(a) * Math.cos(e) * r; pos[i * 3 + 1] = Math.sin(e) * r; pos[i * 3 + 2] = Math.sin(a) * Math.cos(e) * r; } const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); life.stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xdfe8ff, size: 1.1, transparent: true, opacity: 0, depthWrite: false, fog: false })); scene.add(life.stars); }
  { const m = softSprite(128, 16, g => { const gr = g.createLinearGradient(0, 0, 128, 0); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(255,255,255,1)'); g.fillStyle = gr; g.fillRect(0, 5, 128, 6); }); m.scale.set(10, 1.2, 1); m.visible = false; m.material.fog = false; scene.add(m); life.meteor = { s: m, next: 20, t0: 0, from: null }; }
  // News airship: crosses the island every couple of minutes towing a headline.
  { const g = new THREE.Group(); const hull = new THREE.Mesh(new THREE.SphereGeometry(2.2, 12, 10), mat(0xd9cdb4)); hull.scale.set(2.4, 1, 1); hull.castShadow = true; const fin = box(1.2, 1.4, .1, mat(0xd6a545)); fin.position.set(-4.4, .2, 0); const fin2 = box(1.2, .1, 1.4, mat(0xd6a545)); fin2.position.set(-4.4, 0, 0); const gondola = box(1.6, .6, .8, mats.wood); gondola.position.set(.2, -2.4, 0); const rope1 = new THREE.Mesh(new THREE.CylinderGeometry(.02, .02, 2, 4), mats.dark); rope1.position.set(-.5, -1.4, 0); const rope2 = rope1.clone(); rope2.position.x = .9; g.add(hull, fin, fin2, gondola, rope1, rope2);
    const banner = softSprite(768, 96, gg => { gg.fillStyle = 'rgba(250,247,240,.95)'; gg.fillRect(0, 8, 768, 80); }); banner.scale.set(16, 2, 1); banner.position.set(-14, -.4, 0); g.add(banner); g.visible = false; scene.add(g); life.ship = { g, banner, wait: 40, x: 0, dir: 1, z: 0, text: '' }; }
  for (let i = 0; i < 3; i++) { const b = softSprite(64, 32, g => { g.strokeStyle = '#eef2f7'; g.lineWidth = 4; g.lineCap = 'round'; g.beginPath(); g.moveTo(6, 22); g.quadraticCurveTo(20, 8, 32, 20); g.quadraticCurveTo(44, 8, 58, 22); g.stroke(); }); b.scale.set(1.2, .6, 1); b.visible = false; scene.add(b); life.gulls.push({ s: b, ph: i * 2.1 }); }
  { const spot = new THREE.Mesh(new THREE.CylinderGeometry(.5, 1.6, 12, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xf9e2af, transparent: true, opacity: .1, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })); spot.visible = false; scene.add(spot); life.spot = spot; }
  // Rain for stormy weather (two or more crashed units): a sheet of drops around the camera target.
  { const N = 1400, pos = new Float32Array(N * 3); for (let i = 0; i < N; i++) { pos[i * 3] = (Math.random() - .5) * 130; pos[i * 3 + 1] = Math.random() * 40; pos[i * 3 + 2] = (Math.random() - .5) * 90; } const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xbfd8ff, size: .18, transparent: true, opacity: .55, depthWrite: false })); pts.visible = false; scene.add(pts); life.rain = { pts, pos }; }
  const fs = softSprite(64, 32, g => { g.fillStyle = '#9fd8e8'; g.beginPath(); g.ellipse(26, 16, 18, 8, 0, 0, Math.PI * 2); g.fill(); g.beginPath(); g.moveTo(44, 16); g.lineTo(60, 6); g.lineTo(60, 26); g.closePath(); g.fill(); }); fs.scale.set(1.4, .7, 1); fs.visible = false; scene.add(fs); life.fish.s = fs;
  const ring = new THREE.Mesh(new THREE.RingGeometry(.4, .55, 32), new THREE.MeshBasicMaterial({ color: 0xbfe9f5, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.visible = false; scene.add(ring); life.fish.ring = ring;
}
function pickFlyHomes() { const forest = terrain.tiles.filter(t => t.biome === 'forest' && t.th > 0); life.flyHomes = forest.length ? life.flies.map(() => forest[Math.floor(Math.random() * forest.length)]) : []; }
// Sun, sky and lights follow the wall clock: full day around noon, lamps and torches after dusk.
function updateDaylight() {
  const d = new Date(), h = d.getHours() + d.getMinutes() / 60; if (Math.abs(h - life.lastDay) < 1 / 60) return; life.lastDay = h;
  const ang = (h - 6) / 12 * Math.PI, dayK = Math.max(0, Math.min(1, (Math.sin(ang) + .12) / 1.12)); life.dayK = dayK;
  // Night is a blue hour, never black: this is a work surface first. Lamps, windows and torches still carry the mood.
  sun.intensity = 1.25 + .4 * dayK; sun.color.setHex(0xc9d6ff).lerp(new THREE.Color(0xfff0d2), dayK);
  sun.position.set(40 * Math.cos(ang) + 10, 34 + 40 * Math.max(0, Math.sin(ang)), 30);
  const sky = new THREE.Color(0x111a27).lerp(new THREE.Color(0x121a24), dayK); scene.background.copy(sky); scene.fog.color.copy(sky); life.sky = sky; life.sunBase = sun.intensity;
  scene.children.find(o => o.isHemisphereLight).intensity = .78 + .1 * dayK;
  const night = 1 - dayK; mats.window.emissiveIntensity = night * 1.3; mats.torch.emissiveIntensity = night * 1.6; mats.torch.opacity = night;
  for (const b of beacons) b.userData.nightBoost = night * .8;
}
function updateLife(t, dt) {
  updateDaylight(); const rx = terrain.rx + 30, night = 1 - life.dayK, gh = sites.get('github');
  // Weather follows the army's health: overcast with one unit down, a storm with two or more.
  const storm = life.weather === 'storm', overcast = life.weather === 'overcast';
  sun.intensity = life.sunBase * (storm ? .6 : overcast ? .8 : 1);
  for (const c of life.clouds) { c.s.position.x += c.v * (storm ? 2.5 : 1) * dt; if (c.s.position.x > rx) c.s.position.x = -rx; c.s.material.color.setHex(storm ? 0x5c6472 : overcast ? 0xaab2bf : 0xffffff); c.s.material.opacity = storm ? .85 : overcast ? .7 : .55; }
  if (life.rain) { life.rain.pts.visible = storm; if (storm && !reduceMotion()) { const p = life.rain.pos, cx = cam.target.x, cz = cam.target.z; for (let i = 0; i < p.length; i += 3) { p[i + 1] -= 34 * dt; if (p[i + 1] < 0) { p[i + 1] = 30 + Math.random() * 12; p[i] = cx + (Math.random() - .5) * 130; p[i + 2] = cz + (Math.random() - .5) * 90; } } life.rain.pts.geometry.attributes.position.needsUpdate = true;
      if (Math.random() < dt / 8) life.flashUntil = t + .09; } }
  if (life.sky) scene.background.copy(life.flashUntil > t ? new THREE.Color(0xaebfe0) : life.sky);
  if (life.stars) life.stars.material.opacity = Math.max(0, night - .15) * .9;
  const M = life.meteor; if (M && night > .5) { M.next -= dt; if (M.next <= 0 && !M.from) { M.from = new THREE.Vector3((Math.random() - .5) * 200, 60 + Math.random() * 30, (Math.random() - .5) * 120); M.t0 = t; M.s.visible = true; M.s.material.rotation = -.5; } if (M.from) { const k = (t - M.t0) / .9; if (k >= 1) { M.from = null; M.s.visible = false; M.next = 18 + Math.random() * 30; } else { M.s.position.set(M.from.x + k * 70, M.from.y - k * 32, M.from.z); M.s.material.opacity = Math.sin(k * Math.PI); } } }
  const A = life.ship; if (A) { if (!A.g.visible) { A.wait -= dt; if (A.wait <= 0) { A.dir = Math.random() < .5 ? 1 : -1; A.x = -A.dir * (rx + 20); A.z = (Math.random() - .5) * terrain.rz * 1.2; A.g.visible = true; setBanner(A, headline()); } }
    else { A.x += A.dir * 4.2 * dt; A.g.position.set(A.x, 27 + Math.sin(t * .4) * .8, A.z); A.g.rotation.y = A.dir > 0 ? 0 : Math.PI; if (Math.abs(A.x) > rx + 30) { A.g.visible = false; A.wait = 90 + Math.random() * 90; } } }
  if (gh) for (const gl of life.gulls) { gl.s.visible = night < .8; const cx = gh.x + (gh.extra.lay.quay + gh.R * .6) / 2, cz = gh.z; gl.s.position.set(cx + Math.cos(t * .5 + gl.ph) * 7, SAND + 9 + Math.sin(t * 1.4 + gl.ph) * 1.2, cz + Math.sin(t * .5 + gl.ph) * 6); gl.s.scale.set(1.2 * (Math.cos(t * .5 + gl.ph + Math.PI / 2) > 0 ? 1 : -1), .6 * (.5 + .5 * Math.abs(Math.sin(t * 10 + gl.ph))), 1); } else for (const gl of life.gulls) gl.s.visible = false;
  if (life.spot) { const u = selected.unit; life.spot.visible = !!u; if (u) { const wp = new THREE.Vector3(); u.g.getWorldPosition(wp); life.spot.position.set(wp.x, wp.y + 6, wp.z); life.spot.material.opacity = .08 + .04 * Math.sin(t * 3); } }
  updateMedics(t, dt);
  for (let i = life.orbits.length - 1; i >= 0; i--) { const o = life.orbits[i]; if (!o.g.parent) { life.orbits.splice(i, 1); continue; } o.g.rotation.y = t * o.speed; o.g.position.y = o.base + Math.sin(t * 1.3 + i) * o.bob; }
  for (let i = life.beams.length - 1; i >= 0; i--) { const b = life.beams[i]; if (!b.parent) { life.beams.splice(i, 1); continue; } const k = .5 + .5 * Math.sin(t * 2.4 + i); if (b.material.emissive) b.material.emissiveIntensity = 1.1 + k * .8; else { b.material.opacity = .1 + k * .12; b.scale.set(1 + k * .2, 1, 1 + k * .2); } }
  for (let i = life.buoys.length - 1; i >= 0; i--) { const b = life.buoys[i]; if (!b.parent) { life.buoys.splice(i, 1); continue; } b.position.y = .8 + Math.sin(t * 1.4 + i) * .1; }
  for (let i = life.fountains.length - 1; i >= 0; i--) { const f = life.fountains[i]; if (!f.parent) { life.fountains.splice(i, 1); continue; } if (t > (f.userData.next || 0)) { f.userData.next = t + .35; const wp = new THREE.Vector3(0, 2, 0); f.localToWorld(wp); burst(wp, '#bfe9f5', 3, .3, 2.2); } }
  if (life.lighthouse) { if (!life.lighthouse.parent || !life.lighthouse.parent.parent) life.lighthouse = null; else { life.lighthouse.rotation.y = t * .7; life.lighthouse.visible = night > .25; } }
  for (let i = life.fires.length - 1; i >= 0; i--) { const f = life.fires[i]; if (!f.parent) { life.fires.splice(i, 1); continue; } f.scale.set(1 + Math.sin(t * 17 + i) * .12, .8 + Math.sin(t * 13 + i * 2) * .25 + Math.sin(t * 29) * .08, 1); f.material.emissiveIntensity = 1.2 + Math.sin(t * 21 + i) * .4; }
  for (const f of life.birds) {
    if (f.wait) { f.t -= dt; if (f.t <= 0) { f.wait = false; f.dir = Math.random() < .5 ? 1 : -1; f.x = -f.dir * rx; f.z = (Math.random() - .5) * terrain.rz * 1.4; f.y = 13 + Math.random() * 5; f.birds.forEach(b => b.s.visible = true); } continue; }
    f.x += f.dir * 7 * dt; if (Math.abs(f.x) > rx) { f.wait = true; f.t = 25 + Math.random() * 40; f.birds.forEach(b => b.s.visible = false); continue; }
    for (const b of f.birds) { b.s.position.set(f.x + b.ox * f.dir, f.y + Math.sin(t * 1.3 + b.ph) * .6, f.z + b.oz); b.s.scale.set(1.6 * f.dir, .8 * (.55 + .45 * Math.abs(Math.sin(t * 9 + b.ph))), 1); }
  }
  if (life.flyHomes.length) for (let i = 0; i < life.flies.length; i++) { const fl = life.flies[i], home = life.flyHomes[i]; if (!home || night > .8) { fl.s.visible = false; continue; } fl.s.visible = true; fl.s.position.set(home.x + Math.sin(t * .9 + fl.ph) * 1.6 + Math.sin(t * 3.1 + fl.ph) * .3, home.h + 1.4 + Math.sin(t * 2.2 + fl.ph * 2) * .5, home.z + Math.cos(t * .7 + fl.ph) * 1.6); fl.s.scale.set(.5, .5 * (.5 + .5 * Math.abs(Math.sin(t * 14 + fl.ph))), 1); }
  const F = life.fish;
  if (F && gh) { F.next -= dt; if (F.next <= 0 && !F.from) { F.from = new THREE.Vector3(gh.x + gh.extra.lay.quay + 2 + Math.random() * Math.max(2, gh.R * .55 - gh.extra.lay.quay), WATER + .1, gh.z + (Math.random() - .5) * gh.R * .8); F.t0 = t; F.s.visible = true; F.ring.visible = true; F.ring.position.copy(F.from); F.ring.position.y += .02; }
    if (F.from) { const k = (t - F.t0) / 1.1; if (k >= 1) { F.from = null; F.s.visible = false; F.ring.visible = false; F.next = 4 + Math.random() * 7; } else { F.s.position.set(F.from.x + k * 2.2, F.from.y + Math.sin(k * Math.PI) * 2.2, F.from.z); F.s.scale.set(1.4 * (k < .5 ? 1 : -1), .7, 1); F.s.material.rotation = (k < .5 ? 1 : -1) * (.6 - k * 1.2); F.ring.scale.setScalar(1 + k * 4); F.ring.material.opacity = .6 * (1 - k); } } }
  for (let i = life.chimneys.length - 1; i >= 0; i--) { const c = life.chimneys[i]; if (!c.g.parent) { life.chimneys.splice(i, 1); continue; } for (const sm of c.smoke) { const f = ((t * .35 + sm.ph) % 1 + 1) % 1; sm.m.position.set(c.at[0] + Math.sin(f * 5 + sm.ph * 9) * .25, c.at[1] + f * 2.4, c.at[2]); sm.m.scale.setScalar(.5 + f * 1.6); sm.m.material.opacity = .5 * (1 - f); } }
  if (night > 0) for (const tr of life.torches) tr.material.emissiveIntensity = night * (1.2 + Math.sin(t * 13 + tr.position.x) * .4 + Math.sin(t * 7.3) * .2);
}
// A unit that has waited long enough waves, hops and calls out for orders.
function sayTick(u, t, line, every, jitter) { if (u.say && t > u.sayUntil) { disposeObj(u.say); u.say = null; } if (!u.say && t > (u.nextSay || u.phase * 3)) { u.say = speechSprite(line()); u.say.position.set(1.2, 3.4 * u.scale, 0); u.g.add(u.say); u.sayUntil = t + 3.2; u.nextSay = t + every + Math.random() * jitter; } if (u.say) u.say.position.y = 3.4 * u.scale + Math.sin(t * 2) * .06; }
const WORK_LINES = { Edit: ['Tightening this up…', 'One more edit…', 'Nearly readable.'], Write: ['Writing it down…', 'Fresh file coming up.'], Read: ['Reading the fine print…', 'Let me see…'], Bash: ['Running it…', 'Tests, tests, tests…', 'Fingers crossed.'], Grep: ['Where is it…', 'Grepping the haystack…'], Glob: ['Where is it…'], Task: ['Sending the crew…', 'Delegating.'], WebSearch: ['Asking the wider world…'], WebFetch: ['Fetching…'], '': ['Thinking…', 'On it, commander.', 'Almost there…', 'Hmm.'] };
function workLine(tool) { const k = Object.keys(WORK_LINES).find(k => k && tool && tool.startsWith(k)) || ''; const L = WORK_LINES[k]; return L[Math.floor(Math.random() * L.length)]; }
function placeBlock(u) { const lot = u.lot; if (!u.carry) return; const from = new THREE.Vector3(); u.carry.getWorldPosition(from); disposeObj(u.carry); u.carry = null; const b = hexPrism(.32, .34, mat(lot.spec.color)); scene.add(b); b.position.copy(from); const to = new THREE.Vector3(0, (lot.building ? lot.building.userData.topY : 5) - 2.6 + Math.random() * .6, -3.4); lot.g.localToWorld(to); tween(520, k => { b.position.lerpVectors(from, to, k); b.position.y += Math.sin(k * Math.PI) * 2.5; b.rotation.y = k * 6; }, () => { burst(to, hexStr(lot.spec.color), 8, .8, 2); disposeObj(b); }); }
function idleCall(u, t, T) {
  const { p: m, inner } = u; const wave = Math.sin(T * .45 + u.phase) > .2;
  if (wave) { m.armR.rotation.x = -2.7 + Math.sin(T * 9 + u.phase) * .45; m.armR.rotation.z = -.4; inner.position.y = Math.abs(Math.sin(T * 5 + u.phase)) * .18; }
  else { m.armL.rotation.x = .2; m.armR.rotation.x = .2; m.head.rotation.y = Math.sin(T * .8 + u.phase) * .7; }
  m.disc.material.opacity = .28 + (.5 + .5 * Math.sin(T * 3 + u.phase)) * .3;
  sayTick(u, t, () => PHRASES[Math.floor(Math.random() * PHRASES.length)], 14, 14);
}
// The airship's headline: whatever needs the commander most, else the treasury, else quiet.
function headline() {
  const s = snap || {}, ag = s.agents || [], pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const lines = [], work = ag.filter(a => a.status === 'active' || a.status === 'settling').length, need = ag.filter(a => a.status === 'permission' || a.status === 'question'), idle = ag.filter(a => a.idleMin >= IDLE_CALL_MIN), down = ag.filter(a => a.status === 'crashed');
  if (work) lines.push(work + ' unit' + (work === 1 ? '' : 's') + ' hard at work');
  if (need.length) lines.push(need[0].title.slice(0, 40) + ' needs you');
  if (idle.length) lines.push(idle[0].title.slice(0, 40) + ' idle ' + idle[0].idleMin + 'm');
  const wait = (s.prs || []).filter(p => p.needsApproval); if (wait.length) lines.push('PR #' + wait[0].number + ' waiting for your review');
  if (down.length) lines.push(down.length + ' unit' + (down.length === 1 ? '' : 's') + ' down, medics dispatched');
  if (s.cost) lines.push('Treasury: ' + fmtMoney(s.cost) + ' spent today');
  if (!lines.length) lines.push('All quiet on the island', 'Overlord News: nothing to report');
  return pick(lines);
}
function setBanner(A, text) {
  if (A.text === text) return; A.text = text;
  const c = document.createElement('canvas'); c.width = 768; c.height = 96; const g = c.getContext('2d');
  g.fillStyle = 'rgba(250,247,240,.95)'; g.fillRect(0, 8, 768, 80); g.fillStyle = '#0b1118'; g.font = '700 40px Bahnschrift, "Segoe UI", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text.toUpperCase(), 384, 48);
  A.banner.material.map.dispose(); A.banner.material.map = new THREE.CanvasTexture(c); A.banner.material.needsUpdate = true;
}
// Medics: one per lot with a unit down, running between the fallen until they resume or are closed.
function updateMedics(t, dt) {
  for (const site of sites.values()) for (const lot of site.lots.values()) {
    const fallen = [...lot.units.values()].filter(u => u.a.status === 'crashed' || u.a.status === 'resuming');
    let md = life.medics.get(lot);
    if (fallen.length && !md) {
      const g = new THREE.Group(); const body = box(.6, .7, .4, mat(0xf5f5f5)); body.position.y = .85; const cross = box(.28, .08, .05, mat(0xe85d6c)); cross.position.set(0, .9, .21); const cross2 = box(.08, .28, .05, mat(0xe85d6c)); cross2.position.set(0, .9, .21); const head = box(.42, .4, .42, mats.skin); head.position.y = 1.45; const cap = box(.46, .12, .46, mat(0xf5f5f5)); cap.position.y = 1.7; const legL = box(.18, .45, .2, mats.dark); legL.position.set(-.13, .22, 0); const legR = legL.clone(); legR.position.x = .13; const bag = box(.3, .24, .18, mat(0xe85d6c)); bag.position.set(.42, .7, 0);
      g.add(body, cross, cross2, head, cap, legL, legR, bag); g.position.set(0, .56, 2); g.scale.setScalar(.85); lot.g.add(g); md = { g, legL, legR, i: 0, treat: 0 }; life.medics.set(lot, md); const wp = new THREE.Vector3(); g.getWorldPosition(wp); burst(wp, '#f5f5f5', 10, .8, 2);
    }
    if (!md) continue;
    if (!fallen.length) { md.g.scale.multiplyScalar(1 - Math.min(1, dt * 3)); if (md.g.scale.x < .05) { disposeObj(md.g); life.medics.delete(lot); } continue; }
    const target = fallen[md.i % fallen.length], tx = target.g.position.x + 1.1, tz = target.g.position.z + .3, dx = tx - md.g.position.x, dz = tz - md.g.position.z, d = Math.hypot(dx, dz);
    if (d > .15) { const step = Math.min(d, 3.2 * dt); md.g.position.x += dx / d * step; md.g.position.z += dz / d * step; md.g.rotation.y = Math.atan2(dx, dz); const sw = Math.sin(t * 12); md.legL.rotation.x = sw * .6; md.legR.rotation.x = -sw * .6; md.treat = 0; }
    else { md.legL.rotation.x = 0; md.legR.rotation.x = 0; md.g.position.y = .56 + Math.abs(Math.sin(t * 6)) * .12; md.treat += dt; if (md.treat > 2.5 && Math.random() < dt) { const wp = new THREE.Vector3(); target.g.getWorldPosition(wp); wp.y += 1; burst(wp, '#a6e3a1', 4, .5, 1.5); } if (md.treat > 6) { md.i++; md.treat = 0; } }
  }
}
function confetti(pos) { for (const c of ['#f9e2af', '#a6e3a1', '#89b4fa', '#f5c2e7', '#fab387']) burst(pos, c, 8, 1.4, 4); }
function fireworks(pos, n) { for (let k = 0; k < n; k++) setTimeout(() => { if (!alive) return; const p = pos.clone().add(new THREE.Vector3((Math.random() - .5) * 8, Math.random() * 4, (Math.random() - .5) * 6)); burst(p, ['#f9e2af', '#a6e3a1', '#89b4fa', '#f5c2e7', '#fab387'][k % 5], 34, 2.5, 4); }, k * 380); }
/* ────────────────────────── Power plant: the usage caps as energy cells ────────────────────────── */
const PLANT_C = 0x89dceb, PLANT_HEX = '#89dceb';
const usageTone = pct => pct >= 90 ? { c: 0xf38ba8, css: 'var(--w-crashed)' } : pct >= 70 ? { c: 0xf9e2af, css: 'var(--w-perm)' } : { c: 0xa6e3a1, css: 'var(--w-done)' };
function fmtReset(ts, withDate) { if (!ts) return ''; if (ts - Date.now() <= 0) return 'resets now'; const d = new Date(ts), h = d.getHours(), h12 = h % 12 || 12, mi = d.getMinutes(), t = (mi ? h12 + ':' + String(mi).padStart(2, '0') : h12) + (h >= 12 ? 'pm' : 'am'); if (!withDate) return 'resets ' + t; const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; return 'resets ' + mo[d.getMonth()] + ' ' + d.getDate() + ', ' + t; }
function buildPlant(site, R) {
  const g = site.g; site.color = PLANT_C;
  const plat = hexPrism(R, .5, mats.plot); plat.position.y = .25; g.add(plat); g.add(hexEdge(R, .52, PLANT_C, .6)); site.plat = plat; plat.userData.pick = { site };
  // Reactor hall at the back: a dome over a glowing core, a cooling tower beside it that steams harder the more is used.
  const hall = box(5.2, 2.2, 3.2, mats.stone); hall.position.set(0, 1.6, -2.6); g.add(hall);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1.7, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xb9c2cc, { metalness: .4, roughness: .45 })); dome.position.set(0, 2.7, -2.6); dome.castShadow = true; g.add(dome);
  const core = new THREE.Mesh(new THREE.SphereGeometry(.55, 12, 10), new THREE.MeshStandardMaterial({ color: 0x89dceb, emissive: 0x89dceb, emissiveIntensity: 1.6, transparent: true, opacity: .9 })); core.position.set(0, 3.1, -2.6); g.add(core);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.5, 4.4, 12), mat(0xd8d3c8)); tower.position.set(-4.2, 2.7, -1.6); tower.castShadow = true; g.add(tower);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(1.1, .12, 6, 14), mats.stoneDark); lip.rotation.x = Math.PI / 2; lip.position.set(-4.2, 4.9, -1.6); g.add(lip);
  const steam = []; for (let k = 0; k < 6; k++) { const s = new THREE.Mesh(new THREE.SphereGeometry(.34, 7, 6), new THREE.MeshStandardMaterial({ color: 0xe8eef4, transparent: true, opacity: .55 })); s.position.set(-4.2, 5.2, -1.6); g.add(s); steam.push({ m: s, ph: k / 6 }); }
  // Turbine: a wheel on the east side that spins with the session load.
  const tg = new THREE.Group(); tg.position.set(4.2, 2.4, -1.6); const wheel = new THREE.Mesh(new THREE.TorusGeometry(1.1, .14, 6, 16), mats.iron); tg.add(wheel); for (let k = 0; k < 6; k++) { const bl = box(2, .16, .3, mats.iron); bl.rotation.z = k * Math.PI / 3; tg.add(bl); } g.add(tg); const post = new THREE.Mesh(new THREE.CylinderGeometry(.14, .18, 2.4, 6), mats.dark); post.position.set(4.2, 1.2, -1.6); g.add(post);
  // Pylons carry the supply out to the settlement.
  for (const sx of [-1, 1]) { const py = new THREE.Mesh(new THREE.CylinderGeometry(.06, .12, 5, 4), mats.iron); py.position.set(sx * (R - 1.2), 3, 3.5); g.add(py); const bar = box(1.4, .08, .08, mats.iron); bar.position.set(sx * (R - 1.2), 5.2, 3.5); g.add(bar); }
  site.extra.plant = { core, steam, turbine: tg, cells: [], cellsKey: '', load: 0 };
  const an = new THREE.Object3D(); an.position.set(0, 8.2, -1); g.add(an); site.el = label('w-plant', '', an, PLANT_HEX);
}
// One glass cell per cap, in a row along the front: the fill rises to the percentage in the cap's colour.
function plantCells(site, bars) {
  const P = site.extra.plant, key = bars.map(b => b.key).join('|'); if (P.cellsKey === key) return; P.cellsKey = key;
  for (const c of P.cells) disposeObj(c.g); P.cells = [];
  const n = bars.length, gap = Math.min(2.6, 9 / Math.max(1, n)); bars.forEach((b, i) => {
    const cg = new THREE.Group(); cg.position.set((i - (n - 1) / 2) * gap, .5, 1.4); site.g.add(cg);
    const base = hexPrism(.72, .3, mats.stoneDark); base.position.y = .15; cg.add(base);
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(.5, .5, 3.2, 12, 1, true), new THREE.MeshStandardMaterial({ color: 0xcfe9f2, transparent: true, opacity: .22, roughness: .2, metalness: .1, side: THREE.DoubleSide, depthWrite: false })); glass.position.y = 1.9; cg.add(glass);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(.58, .58, .18, 12), mats.iron); cap.position.y = 3.6; cg.add(cap);
    const fillMat = new THREE.MeshStandardMaterial({ color: 0xa6e3a1, emissive: 0xa6e3a1, emissiveIntensity: .9, transparent: true, opacity: .85 });
    const fill = new THREE.Mesh(new THREE.CylinderGeometry(.42, .42, 1, 12), fillMat); fill.position.y = .3; fill.scale.y = .01; cg.add(fill);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(.16, 8, 6), fillMat); bulb.position.y = 3.95; cg.add(bulb);
    P.cells.push({ g: cg, fill, fillMat, key: b.key, pct: 0 });
  });
}
function syncPlant(site, s) {
  const P = site.extra.plant, u = s.usage, bars = (u && u.bars) || [];
  plantCells(site, bars);
  bars.forEach((b, i) => { const c = P.cells[i]; if (!c) return; const tone = usageTone(b.pct); c.fillMat.color.setHex(tone.c); c.fillMat.emissive.setHex(tone.c); const target = Math.max(.01, Math.min(100, b.pct) / 100 * 3); if (Math.abs(c.pct - b.pct) > .05) { const from = c.fill.scale.y; c.pct = b.pct; tween(900, k => { c.fill.scale.y = from + (target - from) * k; c.fill.position.y = .3 + c.fill.scale.y / 2; }, null, easeOutCubic); } });
  P.load = bars.length ? Math.min(1, (bars[0].pct || 0) / 100) : 0;
  let h = `<div class="w-eyebrow">Power plant</div><b>Supply</b>`;
  if (!bars.length) h += `<div class="w-pbar w-pnone">No reading yet &middot; select the plant to fetch</div>`;
  for (const b of bars) { const tone = usageTone(b.pct); h += `<div class="w-pbar" style="--c:${tone.css}"><span>${esc(b.label)}</span><i><b style="width:${Math.min(100, b.pct).toFixed(1)}%"></b></i><em>${b.pct.toFixed(1)}%</em>${b.reset ? `<small>${esc(fmtReset(b.reset, b.date))}</small>` : ''}</div>`; }
  if (u && u.pace) h += `<span class="w-cnt w-pace ${u.pace.state}">${u.pace.label} &middot; used ${u.pace.actual.toFixed(1)}% &middot; expected ${u.pace.expected.toFixed(1)}%</span>`;
  setLabel(site.el, h);
}
function syncTreasury(site, s) {
  const n = Math.min(60, Math.round((s.cost || 0) * 6)); const decoBuilds = Object.entries((economy && economy.builds) || {}).filter(([k]) => k.startsWith('deco:')).map(([, b]) => buildHtml(b)).join('');
  setLabel(site.el, `Treasury · ${esc(fmtMoney(s.cost || 0))} today · ⬡ ${coins().toLocaleString()}${decoBuilds}`);
  syncDecos(site);
  if (n === site.extra.coinsN) return; const grew = site.extra.coinsN >= 0 && n > site.extra.coinsN; site.extra.coinsN = n;
  disposeObj(site.extra.coins); const g = new THREE.Group(); site.g.add(g); site.extra.coins = g;
  for (let i = 0; i < n; i++) { const pile = i % 5, level = Math.floor(i / 5); const a = pile * 1.257; const coin = new THREE.Mesh(new THREE.CylinderGeometry(.5, .5, .12, 6), mats.gold); coin.position.set(Math.cos(a) * 1.5 * (pile ? 1 : 0), .56 + level * .13, Math.sin(a) * 1.5 * (pile ? 1 : 0)); coin.rotation.y = i * .3; coin.castShadow = true; g.add(coin); }
  if (grew) { const wp = new THREE.Vector3(); site.g.getWorldPosition(wp); wp.y += 1.5; burst(wp, '#f9e2af', 10, 1.2, 3); }
}
function fmtMoney(c) { return c >= 1 ? '$' + c.toFixed(2) : '$' + c.toFixed(3); }

/* ────────────────────────── ClickUp raids: the Dark Portal and the enemies it sends ────────────────────────── */
// Every ticket of the commander's that sits in a raid status is an enemy that emerges from the portal on the
// coastal crag and marches on the base of its platform. Priority sets the tier. A ticket moved into a fight
// status keeps its enemy, now under fire from the base; a ticket that leaves both statuses kills it.
const PORTAL_C = 0xb07cff, PORTAL_HEX = '#b07cff';
const RAID_TIERS = {
  low: { name: 'Gremlin', scale: .66, speed: 5.4, body: 0x5f9a3a, eyes: 0xffd23f, weight: 1, coins: 5, every: [3, 6], attacks: ['bite', 'pebble'] },
  normal: { name: 'Raider', scale: 1, speed: 3.4, body: 0x7d3f33, eyes: 0xff3b5c, weight: 2, coins: 10, every: [4, 8], attacks: ['smash', 'rock'] },
  high: { name: 'Ogre', scale: 1.6, speed: 2.6, body: 0x5b3a7a, eyes: 0xffa31a, weight: 4, coins: 25, every: [5, 9], attacks: ['fireball', 'roar'] },
  urgent: { name: 'Warlord', scale: 2.4, speed: 2.1, body: 0x1f1826, eyes: 0xff2d55, weight: 8, coins: 100, every: [6, 10], attacks: ['stomp', 'darkbolt'] },
  none: { name: 'Raider', scale: 1, speed: 3.4, body: 0x6b5a5a, eyes: 0xff3b5c, weight: 2, coins: 10, every: [4, 8], attacks: ['smash', 'rock'] } };
const RAID_HEX = { low: '#a6e3a1', normal: '#fab387', high: '#f38ba8', urgent: '#ff3b5c', none: '#b4befe' };
const PRI_ORDER = { urgent: 0, high: 1, normal: 2, none: 3, low: 4 }, RAID_CAP = 40, FLAME_CAP = 16;
const raidTier = r => RAID_TIERS[r.priority] || RAID_TIERS.none;
const hashStr = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; };
function sinceStr(ts) { if (!ts) return ''; const m = Math.max(0, Math.round((Date.now() - ts) / 60000)); if (m < 60) return 'here ' + m + 'm'; const h = Math.floor(m / 60); if (h < 24) return 'here ' + h + 'h ' + (m % 60) + 'm'; return 'here ' + Math.floor(h / 24) + 'd ' + (h % 24) + 'h'; }
// Battle effects: projectiles, shock rings, tumbling rubble, fires that burn out, camera shake, sieges on bases.
const fx = { shots: [], rings: [], debris: [], flames: [], sieges: new Set() };
function shockRing(pos, color, R = 4, dur = .7) { const m = new THREE.Mesh(new THREE.RingGeometry(.6, 1, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .7, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })); m.rotation.x = -Math.PI / 2; m.position.copy(pos); m.position.y += .1; scene.add(m); fx.rings.push({ m, t: 0, dur, R }); }
function shoot(from, to, o) {
  const geo = o.kind === 'rock' ? new THREE.DodecahedronGeometry(o.size || .3, 0) : new THREE.SphereGeometry(o.size || .25, 8, 6);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: o.color, emissive: o.glow ? o.color : 0x000000, emissiveIntensity: o.glow ? 2 : 0 })); m.position.copy(from); m.castShadow = true; scene.add(m);
  fx.shots.push({ m, from: from.clone(), to: to.clone(), t: 0, dur: o.dur || .8, arc: o.arc ?? 3, trail: o.trail || null, onHit: o.onHit, trailAt: 0 });
}
function debris(pos, color, n, up = 4) { for (let i = 0; i < n; i++) { const s = .12 + Math.random() * .16; const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mat(color)); m.position.copy(pos); m.castShadow = true; scene.add(m); fx.debris.push({ m, v: new THREE.Vector3((Math.random() - .5) * 6, up * (.6 + Math.random()), (Math.random() - .5) * 6), r: new THREE.Vector3(Math.random() * 9, Math.random() * 9, Math.random() * 9), life: 1 + Math.random() * .8 }); } }
function firePatch(pos, dur = 18, size = 1) {
  if (fx.flames.length >= FLAME_CAP) return;
  const g = new THREE.Group(); g.position.copy(pos); scene.add(g);
  const fire = new THREE.Mesh(new THREE.ConeGeometry(.45 * size, 1.3 * size, 6), new THREE.MeshStandardMaterial({ color: 0xff9a3c, emissive: 0xff5a1a, emissiveIntensity: 1.6, transparent: true, opacity: .92 })); fire.position.y = .65 * size; g.add(fire); life.fires.push(fire);
  const inner = new THREE.Mesh(new THREE.ConeGeometry(.22 * size, .85 * size, 6), new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0xffd24a, emissiveIntensity: 2, transparent: true, opacity: .95 })); inner.position.y = .45 * size; g.add(inner); life.fires.push(inner);
  const scorch = new THREE.Mesh(new THREE.CircleGeometry(1.1 * size, 12), new THREE.MeshBasicMaterial({ color: 0x0b0a0c, transparent: true, opacity: .55, depthWrite: false })); scorch.rotation.x = -Math.PI / 2; scorch.position.y = .05; g.add(scorch);
  const smoke = []; for (let k = 0; k < 4; k++) { const sm = new THREE.Mesh(new THREE.SphereGeometry(.2 * size, 7, 6), new THREE.MeshStandardMaterial({ color: 0x2a262c, transparent: true, opacity: .6 })); g.add(sm); smoke.push({ m: sm, ph: k / 4 }); }
  fx.flames.push({ g, smoke, life: dur, size });
}
function shake(amp, dur) { const now = performance.now() / 1000; cam.shake = { amp: Math.max(amp, cam.shake && cam.shake.until > now ? cam.shake.amp : 0), until: now + dur }; }
function updateFx(t, dt) {
  for (let i = fx.shots.length - 1; i >= 0; i--) { const s = fx.shots[i]; s.t += dt; const k = Math.min(1, s.t / s.dur); s.m.position.lerpVectors(s.from, s.to, k); s.m.position.y += Math.sin(k * Math.PI) * s.arc; s.m.rotation.x += dt * 9; s.m.rotation.y += dt * 7; if (s.trail && t > s.trailAt) { s.trailAt = t + .045; burst(s.m.position, s.trail, 1, .25, .5); } if (k >= 1) { fx.shots.splice(i, 1); const p = s.m.position.clone(); disposeObj(s.m); s.onHit && s.onHit(p); } }
  for (let i = fx.rings.length - 1; i >= 0; i--) { const r = fx.rings[i]; r.t += dt; const k = r.t / r.dur; if (k >= 1) { fx.rings.splice(i, 1); disposeObj(r.m); continue; } r.m.scale.setScalar(1 + k * r.R); r.m.material.opacity = .7 * (1 - k); }
  for (let i = fx.debris.length - 1; i >= 0; i--) { const d = fx.debris[i]; d.life -= dt; if (d.life <= 0) { fx.debris.splice(i, 1); disposeObj(d.m); continue; } d.v.y -= 14 * dt; d.m.position.addScaledVector(d.v, dt); d.m.rotation.x += d.r.x * dt; d.m.rotation.z += d.r.z * dt; const gy = groundY(d.m.position.x, d.m.position.z) - .45; if (d.m.position.y < gy) { d.m.position.y = gy; d.v.y *= -.3; d.v.x *= .6; d.v.z *= .6; } }
  for (let i = fx.flames.length - 1; i >= 0; i--) { const f = fx.flames[i]; f.life -= dt; if (f.life <= 0) { fx.flames.splice(i, 1); disposeObj(f.g); continue; } f.g.scale.setScalar(Math.max(.01, Math.min(1, f.life / 3))); for (const sm of f.smoke) { const q = ((t * .35 + sm.ph) % 1 + 1) % 1; sm.m.position.set(Math.sin(q * 6 + sm.ph * 9) * .3, .8 + q * 2.8, Math.cos(q * 5) * .3); sm.m.scale.setScalar(.5 + q * 1.6); sm.m.material.opacity = .55 * (1 - q); } }
  for (const host of fx.sieges) { const S = host.siege; if (!S || !S.g.parent) { fx.sieges.delete(host); continue; } for (const sm of S.smoke) { const q = ((t * sm.sp + sm.ph) % 1 + 1) % 1; sm.m.position.set(sm.at[0] + Math.sin(q * 5 + sm.ph * 9) * .35, sm.at[1] + q * 4, sm.at[2] + Math.cos(q * 4 + sm.ph * 7) * .3); sm.m.scale.setScalar(.5 + q * 2); sm.m.material.opacity = .6 * (1 - q); } if (S.embersAt < t) { S.embersAt = t + .5; const wp = new THREE.Vector3(S.at[0], S.at[1] + 1, S.at[2]); S.g.localToWorld(wp); burst(wp, '#ff9a3c', 2, 1.4, 2.2); } }
}
// A base under siege smokes, then burns, in proportion to the tiers attacking it.
function setSiege(host, w) {
  const level = w <= 0 ? 0 : Math.min(5, Math.ceil(w / 2)); if ((host.siege ? host.siege.level : 0) === level) return;
  if (host.siege) { disposeObj(host.siege.g); host.siege = null; }
  if (!level) return;
  const g = new THREE.Group(); host.g.add(g); const b = host.building, top = b ? b.userData.topY : 3.5, bx = b ? b.position.x : 0, bz = b ? b.position.z : 0, R = b ? 2.6 : 2.4, smoke = [];
  for (let k = 0; k < level + 1; k++) { const a = k * 2.4 + 1, h = top * (.3 + .55 * ((k % 3) / 2)); for (let q = 0; q < 4; q++) { const sm = new THREE.Mesh(new THREE.SphereGeometry(.22 + level * .05, 7, 6), new THREE.MeshStandardMaterial({ color: 0x2a262c, transparent: true, opacity: .6 })); g.add(sm); smoke.push({ m: sm, ph: q / 4, sp: .28 + Math.random() * .2, at: [bx + Math.cos(a) * R * .85, h, bz + Math.sin(a) * R * .85] }); } }
  if (level >= 2) for (let k = 0; k < level - 1; k++) { const a = k * 2.1 + .7, s = .8 + level * .12; const fire = new THREE.Mesh(new THREE.ConeGeometry(.42 * s, 1.3 * s, 6), new THREE.MeshStandardMaterial({ color: 0xff9a3c, emissive: 0xff5a1a, emissiveIntensity: 1.6, transparent: true, opacity: .9 })); fire.position.set(bx + Math.cos(a) * R * .95, top * (.28 + .38 * (k % 2)), bz + Math.sin(a) * R * .95); g.add(fire); life.fires.push(fire); }
  for (let k = 0; k < level + 1; k++) { const sc = new THREE.Mesh(new THREE.CircleGeometry(.8 + (k % 3) * .3, 10), new THREE.MeshBasicMaterial({ color: 0x0b0a0c, transparent: true, opacity: .5, depthWrite: false })); sc.rotation.x = -Math.PI / 2; const a = k * 1.9 + .4; sc.position.set(bx + Math.cos(a) * (R + 2.2), .6, bz + Math.sin(a) * (R + 2.2)); g.add(sc); }
  host.siege = { level, g, smoke, at: [bx, top * .5, bz], embersAt: 0 }; fx.sieges.add(host);
}
// The ClickUp sign over the cave: a stylised mark (an upward chevron and a smile in the brand's gradient) and the name.
function clickupSign() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256; const x = c.getContext('2d');
  x.lineCap = 'round'; x.lineJoin = 'round';
  const g1 = x.createLinearGradient(40, 0, 220, 0); g1.addColorStop(0, '#ff5fa0'); g1.addColorStop(.5, '#8d5cff'); g1.addColorStop(1, '#49ccf9');
  x.strokeStyle = g1; x.lineWidth = 34; x.beginPath(); x.moveTo(52, 132); x.lineTo(130, 46); x.lineTo(208, 132); x.stroke();
  const g2 = x.createLinearGradient(60, 0, 200, 0); g2.addColorStop(0, '#ff5fa0'); g2.addColorStop(1, '#49ccf9');
  x.strokeStyle = g2; x.lineWidth = 30; x.beginPath(); x.moveTo(72, 176); x.quadraticCurveTo(130, 232, 188, 176); x.stroke();
  x.fillStyle = '#ffffff'; x.font = '700 76px Bahnschrift, "Segoe UI", sans-serif'; x.textBaseline = 'middle'; x.fillText('ClickUp', 236, 128);
  const tex = new THREE.CanvasTexture(c); if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace; return tex;
}
function skullSprite(size) { const s = softSprite(64, 64, x => { x.fillStyle = '#efe7d6'; x.beginPath(); x.arc(32, 26, 20, 0, Math.PI * 2); x.fill(); x.fillRect(20, 40, 24, 14); x.fillStyle = '#120a14'; x.beginPath(); x.arc(24, 26, 6, 0, Math.PI * 2); x.arc(40, 26, 6, 0, Math.PI * 2); x.fill(); x.fillRect(29, 44, 2, 8); x.fillRect(34, 44, 2, 8); }); s.scale.setScalar(size); return s; }
function buildPortal(site, R) {
  const g = site.g; site.color = PORTAL_C;
  const plat = hexPrism(R, .5, mat(0x2a2731)); plat.position.y = .25; g.add(plat); g.add(hexEdge(R, .52, PORTAL_C, .7)); site.plat = plat; plat.userData.pick = { site };
  const pg = new THREE.Group(); pg.rotation.y = Math.atan2(-site.x, -site.z); g.add(pg); // the cave mouth faces the island's heart
  const rockM = mat(0x3a3542), rockD = mat(0x2c2833), rng = seeded(11);
  const block = box(8.6, 6.4, 4.2, rockD); block.position.set(0, 3.2, -3.2); pg.add(block);
  const peak = new THREE.Mesh(new THREE.ConeGeometry(3.2, 5.2, 5), rockM); peak.position.set(-.6, 8.8, -3.4); peak.castShadow = true; pg.add(peak);
  for (let k = 0; k < 11; k++) { const a = Math.PI + (k / 10 - .5) * Math.PI * 1.45, r = R * (.5 + rng() * .4), h = 3.5 + rng() * 6.5; const sp = new THREE.Mesh(new THREE.ConeGeometry(.9 + rng() * 1, h, 5), rng() > .5 ? rockM : rockD); sp.position.set(Math.cos(a) * r, h / 2 + .4, Math.sin(a) * r); sp.rotation.z = (rng() - .5) * .35; sp.castShadow = true; pg.add(sp); }
  for (const sx of [-1, 1]) { const pil = box(1.7, 5.6, 1.8, rockM); pil.position.set(sx * 3.1, 3.3, .2); pg.add(pil); const tooth = new THREE.Mesh(new THREE.ConeGeometry(.35, 1.1, 4), mat(0xe9e2d3)); tooth.position.set(sx * 2.05, 5.2, .8); tooth.rotation.z = sx * .35; tooth.rotation.x = Math.PI; pg.add(tooth); }
  const lintel = box(8.4, 1.5, 2, rockD); lintel.position.set(0, 6.1, .2); pg.add(lintel);
  const dark = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 5), new THREE.MeshBasicMaterial({ color: 0x050308 })); dark.position.set(0, 2.9, -.6); pg.add(dark);
  const ringM = new THREE.MeshStandardMaterial({ color: 0xb07cff, emissive: 0x8b5cf6, emissiveIntensity: 1.6 }), ring2M = new THREE.MeshStandardMaterial({ color: 0xff6fb5, emissive: 0xd946ef, emissiveIntensity: 1.4 });
  const r1 = new THREE.Mesh(new THREE.TorusGeometry(1.9, .16, 6, 28), ringM); r1.position.set(0, 3, .1); pg.add(r1);
  const r2 = new THREE.Mesh(new THREE.TorusGeometry(1.25, .12, 6, 24), ring2M); r2.position.set(0, 3, .3); pg.add(r2);
  const core = softSprite(128, 128, x => { const gr = x.createRadialGradient(64, 64, 4, 64, 64, 60); gr.addColorStop(0, 'rgba(255,255,255,.95)'); gr.addColorStop(.35, 'rgba(176,124,255,.85)'); gr.addColorStop(1, 'rgba(76,29,149,0)'); x.fillStyle = gr; x.beginPath(); x.arc(64, 64, 60, 0, Math.PI * 2); x.fill(); }, .7); core.scale.setScalar(3.4); core.position.set(0, 3, .2); core.material.depthWrite = false; pg.add(core);
  const glow = new THREE.Mesh(new THREE.RingGeometry(1.6, 4.6, 32), new THREE.MeshBasicMaterial({ color: 0x9b6dff, transparent: true, opacity: .16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })); glow.rotation.x = -Math.PI / 2; glow.position.set(0, .53, 2.2); pg.add(glow);
  // A column of unlight above the peak, bats, and a ground fog that drifts out of the mouth.
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(.3, 1.4, 30, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0x9b6dff, transparent: true, opacity: .12, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })); beam.position.set(0, 18, -1); pg.add(beam); life.beams.push(beam);
  const bats = []; for (let k = 0; k < 5; k++) { const b = softSprite(64, 32, x => { x.fillStyle = '#0d0912'; x.beginPath(); x.moveTo(4, 14); x.quadraticCurveTo(16, 2, 28, 14); x.lineTo(32, 10); x.lineTo(36, 14); x.quadraticCurveTo(48, 2, 60, 14); x.quadraticCurveTo(48, 20, 40, 18); x.lineTo(32, 26); x.lineTo(24, 18); x.quadraticCurveTo(16, 20, 4, 14); x.fill(); }); b.scale.set(1.3, .65, 1); pg.add(b); bats.push({ s: b, ph: k * 1.3, r: 4 + k, h: 7 + k * .8 }); }
  const fog = []; for (let k = 0; k < 6; k++) { const f = softSprite(64, 64, x => { const gr = x.createRadialGradient(32, 32, 2, 32, 32, 30); gr.addColorStop(0, 'rgba(150,110,220,.55)'); gr.addColorStop(1, 'rgba(150,110,220,0)'); x.fillStyle = gr; x.fillRect(0, 0, 64, 64); }, .8); f.scale.set(4, 1.6, 1); pg.add(f); fog.push({ s: f, ph: k / 6 }); }
  const embers = []; for (let k = 0; k < 12; k++) { const e = new THREE.Mesh(new THREE.SphereGeometry(.14, 6, 5), new THREE.MeshStandardMaterial({ color: 0xd8b4fe, emissive: 0xb07cff, emissiveIntensity: 1.6, transparent: true, opacity: .8 })); pg.add(e); embers.push({ m: e, ph: k / 12 }); }
  for (const sx of [-1, 1]) { const st = new THREE.Mesh(new THREE.CylinderGeometry(.5, .7, 1.1, 6), rockD); st.position.set(sx * 4.8, 1.05, 4.2); pg.add(st); const bowl = new THREE.Mesh(new THREE.CylinderGeometry(.7, .4, .5, 7), mats.dark); bowl.position.set(sx * 4.8, 1.85, 4.2); pg.add(bowl); const fire = new THREE.Mesh(new THREE.ConeGeometry(.5, 1.3, 6), new THREE.MeshStandardMaterial({ color: 0xc4a6ff, emissive: 0x7c3aed, emissiveIntensity: 1.5, transparent: true, opacity: .9 })); fire.position.set(sx * 4.8, 2.6, 4.2); pg.add(fire); life.fires.push(fire); }
  for (let k = 0; k < 8; k++) { const b = box(.9 + rng() * .5, .1, .12, mat(0xe9e2d3)); b.position.set((rng() - .5) * 11, .56, 2 + rng() * 5.5); b.rotation.y = rng() * 3; pg.add(b); }
  for (let k = 0; k < 3; k++) { const sk = skullSprite(.7); sk.position.set(-3.5 + k * 3.4, .9, 5.5 + (k % 2) * .8); pg.add(sk); }
  for (const sx of [-1, 1]) { const pole = new THREE.Mesh(new THREE.CylinderGeometry(.06, .09, 3.2, 5), mats.dark); pole.position.set(sx * 6.4, 2.1, 1.6); pole.rotation.z = sx * .12; pg.add(pole); const sk = skullSprite(.8); sk.position.set(sx * 6.5, 3.9, 1.6); pg.add(sk); }
  const board = box(5.4, 2.7, .3, mat(0x14101c)); board.position.set(0, 8.1, .9); pg.add(board); const rim = box(5.7, 3, .2, mat(PORTAL_C)); rim.position.set(0, 8.1, .8); pg.add(rim);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(5.1, 2.55), new THREE.MeshBasicMaterial({ map: clickupSign(), transparent: true })); face.position.set(0, 8.1, 1.07); pg.add(face);
  for (const sx of [-1, 1]) { const ch = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, 1.4, 4), mats.iron); ch.position.set(sx * 2.2, 7.1, .9); pg.add(ch); }
  const mouth = new THREE.Object3D(); mouth.position.set(0, .56, 3); pg.add(mouth);
  site.extra.portal = { rings: [r1, r2], core, glow, embers, bats, fog, load: 0, pulseAt: 0 }; site.extra.mouth = mouth;
  const an = new THREE.Object3D(); an.position.set(0, 13.2, -1); g.add(an); site.el = label('w-site w-big', '', an, PORTAL_HEX);
}
function animatePortal(P, t, site) {
  P.rings[0].rotation.z = t * 1.3; P.rings[1].rotation.z = -t * 2.2; P.rings[1].rotation.y = Math.sin(t * .8) * .35;
  P.core.material.opacity = .5 + Math.sin(t * 3.1) * .2; P.core.scale.setScalar(3.1 + Math.sin(t * 2.3) * .35); P.glow.material.opacity = .12 + Math.sin(t * 2) * .05 + Math.min(.2, P.load * .03);
  for (const e of P.embers) { const f = ((t * .22 + e.ph) % 1 + 1) % 1; e.m.position.set(Math.sin(f * 6 + e.ph * 9) * 1.5, .7 + f * 6, 1 + Math.cos(f * 5 + e.ph * 7) * .9); e.m.scale.setScalar(.4 + f * .7); e.m.material.opacity = .85 * (1 - f); }
  for (const b of P.bats) { const a = t * .9 + b.ph; b.s.position.set(Math.cos(a) * b.r, b.h + Math.sin(t * 2.1 + b.ph) * .8, -2 + Math.sin(a) * b.r * .6); b.s.scale.set(1.3 * (Math.cos(a + Math.PI / 2) > 0 ? 1 : -1), .65 * (.5 + .5 * Math.abs(Math.sin(t * 12 + b.ph))), 1); }
  for (const f of P.fog) { const q = ((t * .08 + f.ph) % 1 + 1) % 1; f.s.position.set(Math.sin(f.ph * 9) * 2.5 + Math.sin(t * .5 + f.ph * 6) * .5, .75 + q * .3, 2 + q * 9); f.s.material.opacity = .8 * Math.sin(q * Math.PI); }
  if (P.load && t > P.pulseAt) { P.pulseAt = t + 4 + Math.random() * 4; const wp = new THREE.Vector3(); site.extra.mouth.getWorldPosition(wp); shockRing(wp, 0x9b6dff, 6, 1.2); burst(wp, '#b07cff', 10, 2, 2.5); }
}
function syncPortal(site, s) {
  const list = s.raidsOn ? (s.raids || []) : [], n = list.length, fight = list.filter(r => r.phase === 'fight').length; site.extra.portal.load = n;
  setLabel(site.el, `<div class="w-eyebrow">ClickUp</div><b>Dark portal</b><span class="w-cnt">${n ? n + ' raid' + (n === 1 ? '' : 's') + ' afield' + (fight ? ' · ' + fight + ' under fire' : '') : 'all quiet'}</span>`);
}
// Ground height under a world point, from the nearest hex tile (a site plateau counts as its floor).
function groundY(x, z) { const T = terrain; if (!T) return PLAT; const NI = 64, NJ = 34; const i = Math.round(x / (1.5 * TILE)), zo = (i & 1) ? Math.sqrt(3) / 2 * TILE : 0, j = Math.round((z - zo) / (Math.sqrt(3) * TILE)); if (Math.abs(i) > NI || Math.abs(j) > NJ) return PLAT; const t = T.tiles[(i + NI) * (2 * NJ + 1) + (j + NJ)]; return t && t.th > 0 ? t.th + .56 : PLAT + .56; }
function allLots() { const out = []; for (const st of sites.values()) for (const lot of st.lots.values()) out.push(lot); return out; }
// Where a raid stands: at the foot of its base's plateau, on the side nearest the lot it is after (or a stable random side).
function raidTarget(r) {
  const lots = allLots(); let lot = null;
  if (r.target) lot = lots.find(l => l.cwd === r.target) || null;
  if (!lot && lots.length) lot = lots[hashStr(r.id) % lots.length];
  const site = lot ? lot.site : sites.get('treasury'); if (!site) return null;
  const h = hashStr(r.id + '|post'), jitter = ((h % 100) / 100 - .5) * 1.6;
  let a; if (lot && site.lots.size > 1) { const wp = new THREE.Vector3(); lot.building.getWorldPosition(wp); a = Math.atan2(wp.z - site.z, wp.x - site.x) + jitter; } else a = (h % 360) * Math.PI / 180;
  const rr = site.R + 2.2 + raidTier(r).scale * .9 + ((h >> 8) % 3) * .9, x = site.x + Math.cos(a) * rr, z = site.z + Math.sin(a) * rr;
  const aim = new THREE.Vector3(); if (lot && lot.building) { lot.building.getWorldPosition(aim); aim.y += Math.min(6, lot.building.userData.topY * .45); } else { aim.set(site.x, PLAT + 1.5, site.z); }
  return { lot, site, post: new THREE.Vector3(x, groundY(x, z), z), face: Math.atan2(site.x - x, site.z - z), aim };
}
// The card: priority - ticket - platform, then the small print.
function raidLabel(rd) {
  const r = rd.task, plat = r.platforms.length ? r.platforms.join(', ') : 'no platform', who = r.assignees.length ? r.assignees[0].split(' ')[0] : '';
  return `<b>${esc((r.priority === 'none' ? 'no' : r.priority).toUpperCase())}</b><span class="w-who"> - ${esc(r.name.length > 46 ? r.name.slice(0, 45) + '…' : r.name)} - ${esc(plat)}</span><small>${r.phase === 'fight' ? '&#x2694; under fire &middot; ' : ''}${esc(rd.tier.name)}${who ? ' &middot; ' + esc(who) : ''} &middot; ${esc(sinceStr(r.since))}</small>`;
}
function makeRaiderBody(rd) {
  const tier = rd.tier, sc = tier.scale, r = rd.task, pri = r.priority in RAID_TIERS ? r.priority : 'none', base = mat(tier.body), dark = mat(0x15111a), bone = mat(0xe9e2d3), accent = mat(rd.lot ? rd.lot.spec.color : 0xe1b453, { emissive: rd.lot ? rd.lot.spec.color : 0xe1b453, emissiveIntensity: .25 }), p = {};
  const inner = new THREE.Group(); inner.scale.setScalar(sc); rd.g.add(inner);
  p.eyeMat = new THREE.MeshStandardMaterial({ color: 0x1a0008, emissive: tier.eyes, emissiveIntensity: 2.2 }); p.eyes = [];
  const eyes = (head, w, y, z, tilt) => { for (const ex of [-1, 1]) { const e = box(w, w * .6, .05, p.eyeMat); e.position.set(ex * w * 1.3, y, z); e.rotation.z = ex * tilt; head.add(e); p.eyes.push(e); } };
  const teeth = (head, n, y, z, w) => { for (let k = 0; k < n; k++) { const tooth = new THREE.Mesh(new THREE.ConeGeometry(.045, .12, 4), bone); tooth.position.set((k - (n - 1) / 2) * w, y, z); tooth.rotation.x = Math.PI; head.add(tooth); } };
  const shoulder = (sx, y, len, w, m) => { const piv = new THREE.Group(); piv.position.set(sx, y, 0); const arm = box(w, len, w, m); arm.position.y = -len / 2; const hand = box(w * 1.05, w * .7, w * 1.05, m); hand.position.y = -len - w * .3; piv.add(arm, hand); piv.userData.len = len; return piv; };
  if (pri === 'low') {
    // Gremlin: a hunched imp with a huge head, bat ears, a whip tail and long clawed arms.
    p.legL = box(.2, .4, .22, dark); p.legL.position.set(-.16, .2, 0); p.legR = box(.2, .4, .22, dark); p.legR.position.set(.16, .2, 0);
    p.torso = box(.6, .6, .44, base); p.torso.position.y = .7; p.torso.rotation.x = .3; const tab = box(.34, .4, .05, accent); tab.position.set(0, .68, .27); tab.rotation.x = .3;
    p.head = box(.78, .62, .7, base); p.head.position.y = 1.32; eyes(p.head, .17, .08, .36, -.35); teeth(p.head, 5, -.2, .36, .11);
    for (const sx of [-1, 1]) { const ear = new THREE.Mesh(new THREE.ConeGeometry(.16, .7, 4), base); ear.position.set(sx * .5, .3, -.05); ear.rotation.z = -sx * 1.1; p.head.add(ear); }
    const tail = box(.08, .08, .9, base); tail.position.set(0, .45, -.55); tail.rotation.x = .5; inner.add(tail); p.tail = tail;
    p.armL = shoulder(-.4, 1, .8, .16, base); p.armR = shoulder(.4, 1, .8, .16, base);
    for (const arm of [p.armL, p.armR]) for (let k = 0; k < 3; k++) { const claw = new THREE.Mesh(new THREE.ConeGeometry(.035, .22, 4), bone); claw.position.set((k - 1) * .07, -.98, .08); claw.rotation.x = -Math.PI / 2; arm.add(claw); }
    inner.add(p.legL, p.legR, p.torso, tab, p.head, p.armL, p.armR);
  } else if (pri === 'high') {
    // Ogre: a hulking brute with a belly, tusks, fur on the shoulders, a bone club and a burning torch.
    p.legL = box(.34, .55, .36, dark); p.legL.position.set(-.26, .28, 0); p.legR = box(.34, .55, .36, dark); p.legR.position.set(.26, .28, 0);
    p.torso = box(1.25, .95, .75, base); p.torso.position.y = 1.02; const belly = new THREE.Mesh(new THREE.SphereGeometry(.5, 8, 6), mat(0x7b5a95)); belly.position.set(0, .82, .28); belly.scale.set(1.1, .8, .7);
    const tab = box(.5, .55, .06, accent); tab.position.set(0, 1.28, .4); const belt = box(1.3, .14, .8, mat(0x3a2a22)); belt.position.y = .58;
    for (const sx of [-1, 1]) { const fur = box(.62, .34, .7, mat(0x3b2b26)); fur.position.set(sx * .72, 1.55, 0); inner.add(fur); }
    for (let k = 0; k < 3; k++) { const sk = box(.14, .16, .12, bone); sk.position.set((k - 1) * .22, 1.45, .42); inner.add(sk); }
    p.head = box(.72, .62, .68, base); p.head.position.y = 1.85; eyes(p.head, .13, .06, .35, .2); const brow = box(.76, .12, .14, dark); brow.position.set(0, .2, .32); p.head.add(brow);
    for (const sx of [-1, 1]) { const tusk = new THREE.Mesh(new THREE.ConeGeometry(.07, .34, 4), bone); tusk.position.set(sx * .2, -.22, .36); tusk.rotation.z = -sx * .25; p.head.add(tusk); }
    for (const sx of [-1, 1]) { const horn = new THREE.Mesh(new THREE.ConeGeometry(.1, .5, 5), bone); horn.position.set(sx * .3, .38, 0); horn.rotation.z = -sx * .7; p.head.add(horn); }
    p.armL = shoulder(-.85, 1.42, .95, .3, base); p.armR = shoulder(.85, 1.42, .95, .3, base);
    const club = new THREE.Group(); club.position.y = -1; const handle = box(.1, 1, .1, bone); handle.position.set(0, .2, .2); const head = new THREE.Mesh(new THREE.SphereGeometry(.26, 6, 5), bone); head.position.set(0, .75, .2); club.add(handle, head); p.armL.add(club);
    const torch = new THREE.Group(); torch.position.y = -1; const th = box(.1, 1.1, .1, mats.wood); th.position.set(0, .35, .12); const fire = new THREE.Mesh(new THREE.ConeGeometry(.3, .9, 6), new THREE.MeshStandardMaterial({ color: 0xff9a3c, emissive: 0xff5a1a, emissiveIntensity: 1.6, transparent: true, opacity: .92 })); fire.position.set(0, 1.15, .12); torch.add(th, fire); p.armR.add(torch); life.fires.push(fire);
    inner.add(p.legL, p.legR, p.torso, belly, tab, belt, p.head, p.armL, p.armR);
  } else if (pri === 'urgent') {
    // Warlord: plate armour, a rune burning on the chest, a spiked crown, a cape, a double axe, and skulls that circle it.
    const plate = mat(0x4a4653, { metalness: .6, roughness: .35 });
    p.legL = box(.34, .6, .36, plate); p.legL.position.set(-.24, .3, 0); p.legR = box(.34, .6, .36, plate); p.legR.position.set(.24, .3, 0);
    p.torso = box(1.1, 1, .66, plate); p.torso.position.y = 1.1; const rune = box(.32, .42, .06, new THREE.MeshStandardMaterial({ color: 0xff2d55, emissive: 0xff2d55, emissiveIntensity: 2.2 })); rune.position.set(0, 1.18, .35); p.rune = rune;
    const tab = box(.56, .5, .05, accent); tab.position.set(0, .68, .35); const belt = box(1.14, .14, .7, dark); belt.position.y = .62;
    for (const sx of [-1, 1]) { const pad = box(.5, .28, .6, plate); pad.position.set(sx * .68, 1.62, 0); inner.add(pad); for (let k = 0; k < 3; k++) { const spk = new THREE.Mesh(new THREE.ConeGeometry(.07, .36, 4), bone); spk.position.set(sx * (.58 + k * .1), 1.9, -.2 + k * .2); spk.rotation.z = -sx * .3; inner.add(spk); } }
    p.head = box(.62, .58, .6, mat(0x2a2230)); p.head.position.y = 1.95; eyes(p.head, .16, .04, .31, .3); const visor = box(.66, .08, .1, plate); visor.position.set(0, .16, .3); p.head.add(visor);
    for (const sx of [-1, 1]) { const horn = new THREE.Mesh(new THREE.ConeGeometry(.12, .9, 5), bone); horn.position.set(sx * .3, .5, 0); horn.rotation.z = -sx * .5; p.head.add(horn); }
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(.34, .32, .16, 6), mats.iron); crown.position.y = .34; p.head.add(crown); for (let k = 0; k < 6; k++) { const spk = new THREE.Mesh(new THREE.ConeGeometry(.05, .3, 4), mats.iron); const an = k * 1.047; spk.position.set(Math.cos(an) * .3, .54, Math.sin(an) * .3); p.head.add(spk); }
    const cape = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.6), mat(0x6b0f24, { side: THREE.DoubleSide })); cape.position.set(0, .95, -.4); cape.rotation.x = .14; inner.add(cape); p.cape = cape;
    p.armL = shoulder(-.72, 1.5, .9, .28, plate); p.armR = shoulder(.72, 1.5, .9, .28, plate);
    const axe = new THREE.Group(); axe.position.y = -.95; const handle = box(.1, 2, .1, dark); handle.position.set(0, .4, .2); for (const sx of [-1, 1]) { const blade = box(.06, .9, .7, mats.iron); blade.position.set(sx * .3, 1.15, .2); axe.add(blade); } axe.add(handle); p.armR.add(axe);
    const orb = new THREE.Group(); for (let k = 0; k < 3; k++) { const sk = skullSprite(.5); const a = k * 2.094; sk.position.set(Math.cos(a) * 1.3, 0, Math.sin(a) * 1.3); orb.add(sk); } inner.add(orb); life.orbits.push({ g: orb, speed: 1.4, bob: .15, base: 2.3 });
    const aura = new THREE.Mesh(new THREE.RingGeometry(.9, 1.7, 32), new THREE.MeshBasicMaterial({ color: 0x8b1e3f, transparent: true, opacity: .3, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })); aura.rotation.x = -Math.PI / 2; aura.position.y = .03; inner.add(aura); p.aura = aura;
    p.smoke = []; for (let i = 0; i < 5; i++) { const sm = new THREE.Mesh(new THREE.SphereGeometry(.2, 7, 6), new THREE.MeshStandardMaterial({ color: 0x2b1a33, transparent: true, opacity: .6 })); inner.add(sm); p.smoke.push({ m: sm, ph: i / 5 }); }
    inner.add(p.legL, p.legR, p.torso, rune, tab, belt, p.head, p.armL, p.armR);
  } else {
    // Raider: horned helm, a spiked club, a round shield in the base's colour.
    p.legL = box(.26, .5, .28, dark); p.legL.position.set(-.18, .25, 0); p.legR = box(.26, .5, .28, dark); p.legR.position.set(.18, .25, 0);
    p.torso = box(.86, .82, .54, base); p.torso.position.y = .9; const strap = box(.16, .84, .58, dark); strap.position.set(-.2, .9, 0); strap.rotation.z = .3; const belt = box(.9, .1, .56, mat(0x3a2a22)); belt.position.y = .52;
    p.head = box(.56, .5, .54, mat(0x8f6b5c)); p.head.position.y = 1.58; eyes(p.head, .11, .02, .28, .25); teeth(p.head, 4, -.2, .28, .1);
    const helm = box(.64, .3, .62, mats.iron); helm.position.y = .28; p.head.add(helm); const nose = box(.1, .34, .06, mats.iron); nose.position.set(0, .02, .3); p.head.add(nose);
    for (const sx of [-1, 1]) { const horn = new THREE.Mesh(new THREE.ConeGeometry(.09, .5, 5), bone); horn.position.set(sx * .34, .34, 0); horn.rotation.z = -sx * .9; p.head.add(horn); }
    p.armL = shoulder(-.55, 1.22, .64, .24, base); p.armR = shoulder(.55, 1.22, .64, .24, base);
    const shield = hexPrism(.5, .08, accent); shield.rotation.x = Math.PI / 2; shield.position.set(-.18, -.4, .18); p.armL.add(shield); const rim = hexEdge(.5, 0, 0xb9c2cc, .9); rim.rotation.x = Math.PI / 2; rim.position.copy(shield.position); p.armL.add(rim);
    const club = new THREE.Group(); club.position.y = -.7; const handle = box(.09, .8, .09, mats.wood); handle.position.set(0, .15, .2); const head = new THREE.Mesh(new THREE.CylinderGeometry(.14, .2, .4, 6), mats.stoneDark); head.position.set(0, .68, .2); club.add(handle, head); for (let k = 0; k < 4; k++) { const spk = new THREE.Mesh(new THREE.ConeGeometry(.04, .16, 4), mats.iron); const an = k * 1.57; spk.position.set(Math.cos(an) * .2, .7, .2 + Math.sin(an) * .2); spk.rotation.z = -Math.cos(an) * 1.4; spk.rotation.x = Math.sin(an) * 1.4; club.add(spk); } p.armR.add(club);
    inner.add(p.legL, p.legR, p.torso, strap, belt, p.head, p.armL, p.armR);
  }
  p.disc = new THREE.Mesh(new THREE.CircleGeometry(.9 * sc, 6), new THREE.MeshBasicMaterial({ color: 0xff3b5c, transparent: true, opacity: .28, depthWrite: false })); p.disc.rotation.x = -Math.PI / 2; p.disc.rotation.z = Math.PI / 6; p.disc.position.y = .015; rd.g.add(p.disc);
  p.ring = new THREE.Mesh(new THREE.RingGeometry(.98 * sc, 1.12 * sc, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })); p.ring.rotation.x = -Math.PI / 2; p.ring.rotation.z = Math.PI / 6; p.ring.position.y = .02; rd.g.add(p.ring);
  rd.inner = inner; rd.p = p;
}
function raidHit(rd) { const sc = rd.tier.scale, hit = new THREE.Mesh(new THREE.BoxGeometry(1.7 * sc, 2.4 * sc, 1.7 * sc), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })); hit.position.y = 1.15 * sc; rd.g.add(hit); hit.userData.pick = { raid: rd }; rd.hit = hit; pickables.add(hit); }
function createRaider(r, target, portal) {
  const g = new THREE.Group(); scene.add(g);
  const from = new THREE.Vector3(); if (portal && portal.extra.mouth) portal.extra.mouth.getWorldPosition(from); else from.copy(target.post);
  g.position.copy(from); const tier = raidTier(r), sc = tier.scale;
  const rd = { task: r, tier, g, lot: target.lot, site: target.site, post: target.post, face: target.face, aim: target.aim, state: 'emerge', key: null, ph: Math.random() * 6, nextAtk: 0, nextShot: 0, hitUntil: 0, dustAt: 0 };
  raidHit(rd); makeRaiderBody(rd); rd.key = raidKey(r, target);
  rd.el = label('w-obj w-raid ' + r.priority + (r.phase === 'fight' ? ' fight' : ''), raidLabel(rd), g, RAID_HEX[r.priority] || RAID_HEX.none, 2.5 * sc + .4);
  g.scale.setScalar(.01); tween(900, k => g.scale.setScalar(Math.max(.01, k)), () => { rd.state = 'march'; }, easeOutBack, 120);
  const wp = from.clone(); wp.y += 1; setTimeout(() => { if (!alive) return; burst(wp, '#b07cff', 26, 1.8, 3); shockRing(wp, 0x9b6dff, 5, .9); life.flashUntil = performance.now() / 1000 + .07; }, 120);
  raiders.set(r.id, rd); return rd;
}
const raidKey = (r, tg) => r.priority + '|' + r.phase + '|' + (tg ? tg.site.key + '|' + (tg.lot ? tg.lot.cwd : '') : '');
function destroyRaider(rd, quiet) {
  raiders.delete(rd.task.id); dropLabel(rd.el); pickables.delete(rd.hit); if (selected.raid === rd) { selected = {}; renderSel(); } if (hoveredRaid === rd) hoveredRaid = null;
  const g = rd.g; if (quiet) { disposeObj(g); return; }
  const wp = new THREE.Vector3(); g.getWorldPosition(wp); wp.y += 1; burst(wp, RAID_HEX[rd.task.priority] || RAID_HEX.none, 16 + Math.round(rd.tier.scale * 10), 1.4 * rd.tier.scale, 3); burst(wp, '#ffffff', 8, 1, 3.5); shockRing(wp, 0xffffff, 3 + rd.tier.scale * 2, .8); debris(wp, 0x2b1a33, 3 + Math.round(rd.tier.scale * 3), 5); if (rd.tier.scale >= 1.5) shake(.25 * rd.tier.scale, .5);
  give('raids', rd.tier.coins, 'slew a ' + rd.tier.name.toLowerCase() + ' · ' + rd.task.name.slice(0, 26));
  const sk = skullSprite(1.1 * rd.tier.scale); sk.position.copy(wp); scene.add(sk); tween(1800, k => { sk.position.y = wp.y + k * 5; sk.material.opacity = 1 - k; }, () => disposeObj(sk));
  const y0 = g.position.y; tween(700, k => { g.rotation.z = -Math.PI / 2 * Math.min(1, k * 1.6); g.position.y = y0 - k * 1.2; if (k > .5) g.scale.setScalar(Math.max(.01, 1 - (k - .5) * 2)); }, () => disposeObj(g), easeInCubic);
}
function syncRaids(s) {
  const list = s.raidsOn ? (s.raids || []) : [], seen = new Set(), portal = sites.get('portal'), weights = new Map();
  const sorted = [...list].sort((a, b) => (PRI_ORDER[a.priority] ?? 3) - (PRI_ORDER[b.priority] ?? 3)).slice(0, RAID_CAP);
  for (const r of sorted) {
    const target = raidTarget(r); if (!target) continue; seen.add(r.id);
    const host = target.lot || target.site; weights.set(host, (weights.get(host) || 0) + raidTier(r).weight);
    let rd = raiders.get(r.id);
    if (!rd) { rd = createRaider(r, target, portal); continue; }
    const nk = raidKey(r, target), was = rd.task; rd.task = r;
    if (rd.key !== nk) {
      rd.key = nk; rd.lot = target.lot; rd.site = target.site;
      if (was.priority !== r.priority || (was.target || '') !== (r.target || '')) { disposeObj(rd.inner); disposeObj(rd.p.disc); disposeObj(rd.p.ring); rd.tier = raidTier(r); makeRaiderBody(rd); rd.el.dy = 2.5 * rd.tier.scale + .4; pickables.delete(rd.hit); disposeObj(rd.hit); raidHit(rd); }
      if (was.phase !== r.phase) { const wp = new THREE.Vector3(); rd.g.getWorldPosition(wp); wp.y += 1.5 * rd.tier.scale; burst(wp, r.phase === 'fight' ? '#89b4fa' : '#ff3b5c', 14, 1.2, 2.5); }
      rd.el.el.className = 'w-lab w-obj w-raid ' + r.priority + (r.phase === 'fight' ? ' fight' : '') + (rd === selected.raid ? ' sel' : '') + (rd === hoveredRaid ? ' hov' : ''); rd.el.el.style.setProperty('--c', RAID_HEX[r.priority] || RAID_HEX.none);
    }
    rd.aim = target.aim;
    if (rd.post.distanceTo(target.post) > .6) { rd.post = target.post; rd.face = target.face; if (rd.state === 'siege') rd.state = 'march'; }
    setLabel(rd.el, raidLabel(rd));
  }
  for (const [id, rd] of raiders) if (!seen.has(id)) destroyRaider(rd, !s.raidsOn);
  // Bases smoke and burn in proportion to what is standing at their walls.
  const hosts = new Set([...weights.keys(), ...fx.sieges]); for (const h of hosts) setSiege(h, weights.get(h) || 0);
}
// One attack, picked at random from the tier's repertoire.
function startAttack(rd, t) {
  const kind = rd.tier.attacks[Math.floor(Math.random() * rd.tier.attacks.length)], sc = rd.tier.scale;
  rd.atk = { kind, t0: t, dur: kind === 'bite' ? 1.1 : kind === 'stomp' ? 1.3 : 1, fired: false };
  if (kind === 'bite') { const dir = new THREE.Vector3(rd.aim.x - rd.g.position.x, 0, rd.aim.z - rd.g.position.z).normalize(); rd.atk.from = rd.g.position.clone(); rd.atk.to = rd.g.position.clone().addScaledVector(dir, 2.6); }
}
function fireAttack(rd, t) {
  const A = rd.atk, sc = rd.tier.scale, pos = rd.g.position.clone(); pos.y += 1.4 * sc; const aim = rd.aim.clone().add(new THREE.Vector3((Math.random() - .5) * 3, 0, (Math.random() - .5) * 3));
  const land = p => { const gy = groundY(p.x, p.z); return new THREE.Vector3(p.x, Math.max(gy - .5, p.y - 1.5), p.z); };
  switch (A.kind) {
    case 'pebble': shoot(pos, aim, { kind: 'rock', color: 0x8d8a84, size: .16, arc: 2.5, dur: .7, onHit: p => { burst(p, '#8a98ab', 6, .6, 1.6); debris(p, 0x8d8a84, 2, 2.5); } }); break;
    case 'rock': shoot(pos, aim, { kind: 'rock', color: 0x6f6a66, size: .34, arc: 3.5, dur: .9, onHit: p => { burst(p, '#8a98ab', 16, 1.2, 2.2); debris(p, 0x8d8a84, 6, 4); shockRing(land(p), 0xc9d1d9, 2.5, .5); shake(.08, .25); } }); break;
    case 'smash': { const p = rd.g.position.clone(); shockRing(p, 0xfab387, 3.5, .6); burst(p, '#c9b8a0', 16, 1.6 * sc, 2); debris(p, 0x8d8a84, 4, 3.5); shake(.08, .25); break; }
    case 'fireball': shoot(pos, aim, { color: 0xff7a2a, size: .38, glow: true, arc: 4, dur: 1, trail: '#ff9a3c', onHit: p => { burst(p, '#ff9a3c', 22, 1.6, 3); burst(p, '#ffd24a', 10, 1, 3.5); firePatch(land(p), 14 + Math.random() * 8, 1); shockRing(land(p), 0xff7a2a, 3, .5); shake(.12, .3); } }); break;
    case 'roar': { const p = rd.g.position.clone(); shockRing(p, 0xf38ba8, 7, 1); burst(p, '#f38ba8', 12, 2 * sc, 2); shake(.14, .5); break; }
    case 'stomp': { const p = rd.g.position.clone(); shockRing(p, 0xff2d55, 9, 1.1); burst(p, '#8a98ab', 30, 3 * sc, 3); debris(p, 0x3a3542, 10, 6); shake(.5, .7); life.flashUntil = t + .06; break; }
    case 'darkbolt': shoot(pos, aim, { color: 0xb07cff, size: .5, glow: true, arc: 5, dur: 1.1, trail: '#b07cff', onHit: p => { burst(p, '#b07cff', 34, 2.4, 3.5); burst(p, '#ff2d55', 12, 1.2, 4); firePatch(land(p), 20, 1.7); shockRing(land(p), 0x9b6dff, 6, .8); shake(.3, .5); life.flashUntil = performance.now() / 1000 + .08; } }); break;
  }
}
// The base fights back once the ticket is in development: its units, or the keep itself when nobody is home, shoot bolts.
function fightBack(rd, t) {
  rd.nextShot = t + 1.1 + Math.random() * 1.5; const lot = rd.lot; let from = new THREE.Vector3();
  const shooters = lot ? [...lot.units.values()].filter(u => !u.mini) : [];
  if (shooters.length) { const u = shooters[Math.floor(Math.random() * shooters.length)]; u.g.getWorldPosition(from); from.y += 1.7 * u.scale; u.shootUntil = t + .35; }
  else if (lot && lot.building) { from.set(0, lot.building.userData.topY - 1.2, -3.4); lot.g.localToWorld(from); }
  else if (rd.site) { from.set(rd.site.x, PLAT + 3, rd.site.z); }
  else return;
  const to = rd.g.position.clone(); to.y += 1.2 * rd.tier.scale; const sc = rd.tier.scale;
  shoot(from, to, { color: 0x89b4fa, size: .16, glow: true, arc: 1.5, dur: .45, trail: '#89b4fa', onHit: p => { burst(p, '#89b4fa', 10, .8, 2.2); burst(p, '#ffffff', 3, .3, 2.5); rd.hitUntil = performance.now() / 1000 + .35; if (Math.random() < .25) debris(p, 0x2b1a33, 2, 3); } });
}
function animateRaider(rd, t, dt) {
  const { p: m, inner, tier } = rd, T = reduceMotion() ? 0 : t, sc = tier.scale, hit = t < rd.hitUntil;
  m.ring.material.opacity = rd === selected.raid ? .95 : 0;
  { const k = 1.6 + Math.sin(T * 6 + rd.ph) * .6; m.eyeMat.emissiveIntensity = hit ? 4 : rd.task.phase === 'fight' ? k + .8 : k; m.eyeMat.emissive.setHex(hit ? 0xffffff : tier.eyes); }
  if (m.cape) m.cape.rotation.x = .14 + Math.sin(T * 2.2 + rd.ph) * .14;
  if (m.rune) m.rune.material.emissiveIntensity = 1.6 + Math.sin(T * 4 + rd.ph) * .9;
  if (m.aura) { m.aura.material.opacity = .22 + Math.sin(T * 3 + rd.ph) * .12; m.aura.rotation.z = T * .6; }
  if (m.tail) m.tail.rotation.y = Math.sin(T * 5 + rd.ph) * .5;
  if (m.smoke) for (const sm of m.smoke) { const f = ((T * .3 + sm.ph) % 1 + 1) % 1; sm.m.position.set(Math.sin(f * 6 + sm.ph * 9) * .7, .1 + f * 1.4, Math.cos(f * 5) * .6); sm.m.scale.setScalar(.6 + f * 1.4); sm.m.material.opacity = .5 * (1 - f); }
  inner.rotation.x = hit ? -.3 : 0; inner.rotation.z = 0;
  if (rd.state === 'emerge') { inner.rotation.y = rd.face; return; }
  if (rd.state === 'march') {
    const dx = rd.post.x - rd.g.position.x, dz = rd.post.z - rd.g.position.z, d = Math.hypot(dx, dz);
    if (d < .25 || reduceMotion()) { rd.g.position.set(rd.post.x, rd.post.y, rd.post.z); rd.state = 'siege'; rd.nextAtk = t + 1 + Math.random() * 2; const wp = rd.g.position.clone(); wp.y += .3; burst(wp, '#8a98ab', 8, 1.2 * sc, 1.5); if (sc >= 1.5) shake(.1 * sc, .3); return; }
    const step = Math.min(d, tier.speed * dt); rd.g.position.x += dx / d * step; rd.g.position.z += dz / d * step;
    const gy = groundY(rd.g.position.x, rd.g.position.z); rd.g.position.y += (gy - rd.g.position.y) * Math.min(1, dt * 6);
    inner.rotation.y = Math.atan2(dx, dz); const sw = Math.sin(T * (tier.speed * 3.2) + rd.ph); m.legL.rotation.x = sw * .6; m.legR.rotation.x = -sw * .6; m.armL.rotation.x = -sw * .5; m.armR.rotation.x = sw * .5 - .4; inner.position.y = Math.abs(sw) * .06 * sc;
    if (t > rd.dustAt) { rd.dustAt = t + .3; const wp = rd.g.position.clone(); wp.y += .1; burst(wp, '#c9b8a0', 2 + Math.round(sc), .6 * sc, 1); }
    return;
  }
  // Besieging: planted at the foot of the base, and every few seconds an attack from the tier's repertoire.
  inner.rotation.y = rd.face + Math.sin(T * .7 + rd.ph) * .1; m.legL.rotation.x = 0; m.legR.rotation.x = 0; inner.position.y = 0;
  if (rd.task.phase === 'fight' && t > rd.nextShot && !reduceMotion()) fightBack(rd, t);
  if (!rd.atk && t > rd.nextAtk && !reduceMotion()) { rd.nextAtk = t + tier.every[0] + Math.random() * (tier.every[1] - tier.every[0]); startAttack(rd, t); }
  const A = rd.atk;
  if (A) {
    const k = (t - A.t0) / A.dur; if (k >= 1) { rd.atk = null; rd.g.position.set(rd.post.x, rd.post.y, rd.post.z); }
    else if (A.kind === 'bite') { const q = Math.sin(k * Math.PI); rd.g.position.lerpVectors(A.from, A.to, q); inner.position.y = Math.abs(Math.sin(k * Math.PI * 4)) * .3 * sc; m.armL.rotation.x = -1.5 * q; m.armR.rotation.x = -1.5 * q; m.head.rotation.x = .4 * q; if (k > .45 && !A.fired) { A.fired = true; const p = rd.g.position.clone(); p.y += .8 * sc; burst(p, '#ffd36b', 8, .6, 2); shockRing(rd.g.position, 0xa6e3a1, 1.6, .4); } }
    else if (A.kind === 'stomp') { const q = k < .5 ? k * 2 : 1 - (k - .5) * 2; inner.position.y = q * 1.4 * sc; m.legL.rotation.x = -q; m.legR.rotation.x = -q; m.armL.rotation.x = -2.4 * q; m.armR.rotation.x = -2.4 * q; if (k > .5 && !A.fired) { A.fired = true; fireAttack(rd, t); } }
    else { const wind = Math.min(1, k * 2.2), swing = k > .45 ? Math.min(1, (k - .45) / .25) : 0; m.armR.rotation.x = -2.8 * wind + 3.6 * swing; m.armL.rotation.x = -.6 * wind + .3 * swing; inner.rotation.z = .12 * wind - .18 * swing; m.head.rotation.x = -.3 * wind + .4 * swing; inner.position.y = swing * .12 * sc; if (k > .45 && !A.fired) { A.fired = true; fireAttack(rd, t); } }
  } else {
    const roar = ((T * .4 + rd.ph) % 1) > .85; m.armR.rotation.x = roar ? -2.4 : -.9 + Math.sin(T * 2.4 + rd.ph) * .2; m.armL.rotation.x = roar ? -1.4 : .3; m.head.rotation.x = roar ? -.3 : 0; inner.position.y = roar ? .18 * sc : Math.abs(Math.sin(T * 1.6 + rd.ph)) * .03; inner.scale.setScalar(sc * (1 + Math.sin(T * 1.6 + rd.ph) * .012));
  }
  m.disc.material.opacity = .22 + (.5 + .5 * Math.sin(T * 3 + rd.ph)) * .16;
}

// Re-render the selection bar from the current facts (after a failed action, for instance).
W.refreshSel = function () { if (alive) renderSel(); };
// Roster hooks: the list on the left can highlight and fly to a unit.
W.hover = function (id) { if (!alive) return; hovered = id == null ? null : (units.get(id) || null); };
W.focus = function (id, zoom) { if (!alive) return; const u = units.get(id); if (!u) return; cam.userMoved = true; const p = new THREE.Vector3(); u.g.getWorldPosition(p); const fx = cam.target.x, fz = cam.target.z, fzoom = cam.zoom, tz = zoom || Math.min(cam.zoom, 1.1); tween(700, k => { cam.target.x = fx + (p.x - fx) * k; cam.target.z = fz + (p.z - fz) * k; cam.zoom = fzoom + (tz - fzoom) * k; }); };
W.devCam = function (zoom, key, yaw) { if (!alive) return null; cam.userMoved = true; cam.cine = false; cam.lastInput = performance.now() / 1000; if (zoom) cam.zoom = zoom; if (yaw != null) cam.yaw = yaw; const st = key && sites.get(key); if (st) { cam.target.x = st.x; cam.target.z = st.z; } return { zoom: cam.zoom, yaw: cam.yaw, x: cam.target.x, z: cam.target.z, R: st && st.R }; }; // test hook: place the camera exactly
W.focusKey = function (kind, key) { if (!alive) return; if (kind === 'site') { const st = sites.get(key); if (st) { cam.userMoved = true; flyTo(st.g); select({ site: st }); } return; } if (kind === 'raid') { const rd = raiders.get(key); if (rd) { cam.userMoved = true; flyTo(rd.g); select({ raid: rd }); } return; } if (kind === 'treasury') { const st = sites.get('treasury'); if (st) { cam.userMoved = true; flyTo(st.g); select({ site: st }); } return; } const o = kind === 'pr' ? ships.get(key) : kind === 'run' ? machines.get(key) : kind === 'peer' ? tents.get(key) : null; if (o) { cam.userMoved = true; flyTo(o.g); select(kind === 'pr' ? { pr: o.pr } : kind === 'run' ? { run: o.run } : { peer: o.peer }); } };

window.World = W;
})();
