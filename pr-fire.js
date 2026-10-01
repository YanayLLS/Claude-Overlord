// PR heat fire: a canvas particle system drawn over the window while a teammate's PR waits for approval.
// Stage 0 is off; 1-2 sparks, 3-4 embers over glowing coals, 5-7 flames off the PR foot, 8-10 a blaze across
// the window's bottom with smoke. The loop runs only while something is lit; going to 0 lets the particles burn out.
(function () {
  // Per stage: spawn rates per second per 100px of emitter width, flame height h (px, or a fraction of the window when < 1).
  const STAGES = [
    null,
    { spark: 2.5, ember: 0, flame: 0, h: 0, smoke: 0, glow: 0.10 },
    { spark: 6, ember: 1.2, flame: 0, h: 0, smoke: 0, glow: 0.18 },
    { spark: 5, ember: 5, flame: 30, h: 10, smoke: 0, glow: 0.35 },
    { spark: 8, ember: 8, flame: 50, h: 20, smoke: 0, glow: 0.45 },
    { spark: 10, ember: 8, flame: 90, h: 55, smoke: 0, glow: 0.55 },
    { spark: 14, ember: 10, flame: 120, h: 95, smoke: 0.6, glow: 0.65 },
    { spark: 18, ember: 12, flame: 150, h: 150, smoke: 1.2, glow: 0.75 },
    { spark: 7, ember: 4, flame: 45, h: 0.30, smoke: 1.2, glow: 0.8 },
    { spark: 9, ember: 5, flame: 55, h: 0.52, smoke: 1.5, glow: 0.9 },
    { spark: 12, ember: 6, flame: 65, h: 0.80, smoke: 1.8, glow: 1 },
  ];
  const MAX = 2600; // ponytail: hard particle cap keeps stage 10 on a wide window affordable
  let cv, ctx, stage = 0, rect = null, parts = [], last = 0, raf = 0, acc = { spark: 0, ember: 0, flame: 0, smoke: 0 };

  // Flame colour ramp by age: white-yellow core → orange → red → nothing. Pre-rendered so a particle is one drawImage.
  const RAMP = 32, flameSprites = [], S = 64;
  function sprite(r, g, b, soft) {
    const c = document.createElement('canvas'); c.width = c.height = S;
    const x = c.getContext('2d'), gr = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, `rgba(${r},${g},${b},1)`); gr.addColorStop(soft, `rgba(${r},${g},${b},.45)`); gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
    x.fillStyle = gr; x.fillRect(0, 0, S, S); return c;
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  function rampColor(t) {
    const stops = [[0, 255, 250, 225], [0.18, 255, 214, 110], [0.42, 255, 130, 30], [0.7, 225, 45, 18], [1, 90, 10, 10]];
    let i = 0; while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
    const [t0, ...a] = stops[i], [t1, ...b] = stops[i + 1], k = (t - t0) / (t1 - t0);
    return a.map((v, j) => Math.round(lerp(v, b[j], k)));
  }
  let emberSprite, smokeSprite;
  function init() {
    cv = document.createElement('canvas'); cv.id = 'pr-fire-canvas';
    (document.getElementById('pr-fire') || document.body).prepend(cv);
    ctx = cv.getContext('2d');
    for (let i = 0; i < RAMP; i++) flameSprites.push(sprite(...rampColor(i / (RAMP - 1)), 0.35));
    emberSprite = sprite(255, 120, 40, 0.18); smokeSprite = sprite(40, 30, 30, 0.5);
    addEventListener('resize', size); size();
  }
  function size() {
    const d = Math.min(devicePixelRatio || 1, 1.5);
    cv.width = innerWidth * d; cv.height = innerHeight * d; ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  // Where the fire comes from: the PR foot's top edge up to stage 7, the whole window bottom from 8.
  function emitter() {
    if (stage >= 8 || !rect) return { x0: 0, x1: innerWidth, y: innerHeight + 6, h: STAGES[stage].h * innerHeight };
    return { x0: rect.left, x1: rect.right, y: rect.top + 2, h: STAGES[stage].h };
  }
  const rnd = (a, b) => a + Math.random() * (b - a);
  function spawn(type, e) {
    if (parts.length >= MAX) return;
    const x = rnd(e.x0, e.x1), p = { type, x, y: e.y, t: 0, seed: Math.random() * 1000 };
    if (type === 'spark') {
      const fast = 1 + Math.min(stage, 8) / 6;
      Object.assign(p, { y: e.y - e.h * rnd(0, 0.6), vx: rnd(-25, 25), vy: -rnd(70, 190) * fast, life: rnd(0.7, 1.6), w: rnd(1, 2) });
    } else if (type === 'ember') {
      Object.assign(p, { y: e.y - e.h * rnd(0, 0.4), vx: rnd(-12, 12), vy: -rnd(18, 55), life: rnd(2, 4.2), r: rnd(1.6, 3.6), fl: rnd(4, 11) });
    } else if (type === 'flame') {
      const life = Math.min(1.6, 0.4 + e.h / 420) * rnd(0.7, 1.15);
      // Tongues: hot spots drift along the fuel line and burn taller, so the top edge is ragged instead of a flat wall.
      const now = performance.now() / 1000, hot = 0.5 + 0.5 * Math.sin(x * 0.021 + now * 1.3) * Math.sin(x * 0.0067 - now * 0.8 + 2);
      // Edges of the foot taper off instead of ending in a cut.
      const edge = stage >= 8 ? 1 : Math.max(0.15, Math.min(1, (x - e.x0) / 50, (e.x1 - x) / 50));
      Object.assign(p, { vx: rnd(-8, 8), vy: -(e.h / life) * (0.45 + 1.1 * hot) * edge * rnd(0.85, 1.15), life, s: Math.max(6, Math.min(e.h * (e.h < 200 ? 0.42 : 0.3), 110)) * (0.6 + 0.6 * hot) * (0.5 + edge / 2) * rnd(0.8, 1.2) });
    } else {
      Object.assign(p, { y: e.y - e.h * rnd(0.55, 0.95), vx: rnd(-10, 10), vy: -rnd(25, 50), life: rnd(2.5, 4), s: Math.max(30, e.h * 0.25) });
    }
    parts.push(p);
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    const time = now / 1000;
    if (stage) {
      const st = STAGES[stage], e = emitter(), per = (e.x1 - e.x0) / 100;
      for (const k of ['spark', 'ember', 'flame', 'smoke']) {
        acc[k] += st[k] * per * dt;
        while (acc[k] >= 1) { acc[k]--; spawn(k, e); }
      }
    }
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    // Glow on the source: the foot's top edge (or the window's floor) burns before anything rises from it.
    if (stage) {
      const st = STAGES[stage], e = emitter(), gh = Math.max(14, e.h * 0.7) + 10;
      const flick = 0.85 + 0.15 * Math.sin(time * 9) * Math.sin(time * 3.7);
      const g = ctx.createLinearGradient(0, e.y, 0, e.y - gh);
      g.addColorStop(0, `rgba(255,110,30,${st.glow * 0.75 * flick})`); g.addColorStop(0.35, `rgba(255,60,20,${st.glow * 0.3 * flick})`); g.addColorStop(1, 'rgba(255,40,20,0)');
      ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; ctx.fillRect(e.x0, e.y - gh, e.x1 - e.x0, gh);
      if (stage >= 3) { // coals: a bright seam right on the edge
        const c = ctx.createLinearGradient(0, e.y, 0, e.y - 5);
        c.addColorStop(0, `rgba(255,200,90,${0.55 * flick})`); c.addColorStop(1, 'rgba(255,90,20,0)');
        ctx.fillStyle = c; ctx.fillRect(e.x0, e.y - 5, e.x1 - e.x0, 5);
      }
    }
    // Smoke first, normally blended, so the flames burn in front of it.
    ctx.globalCompositeOperation = 'source-over';
    const alive = [];
    for (const p of parts) {
      p.t += dt / p.life; if (p.t >= 1) continue; alive.push(p);
      if (p.type !== 'smoke') continue;
      p.x += (p.vx + Math.sin(time * 0.8 + p.seed) * 14) * dt; p.y += p.vy * dt;
      const s = p.s * (1 + p.t * 1.6);
      ctx.globalAlpha = 0.28 * Math.sin(Math.PI * p.t);
      ctx.drawImage(smokeSprite, p.x - s / 2, p.y - s / 2, s, s);
    }
    parts = alive;
    ctx.globalCompositeOperation = 'lighter';
    for (const p of parts) {
      if (p.type === 'flame') {
        // Turbulence grows with height: steady at the base, licking at the tips.
        const sway = Math.sin(time * 4.3 + p.seed) * 0.6 + Math.sin(time * 9.1 + p.seed * 1.7) * 0.4;
        p.x += sway * 60 * p.t * dt; p.y += p.vy * dt; p.vy *= 1 - 0.25 * dt;
        // Shrinks as it rises and stretches upward: overlapping, additively blended, they read as tongues.
        const s = p.s * (1 - p.t) + 1, w = s * 0.75, hgt = s * 1.6;
        ctx.globalAlpha = 0.32 * (1 - p.t * 0.4);
        ctx.drawImage(flameSprites[Math.min(RAMP - 1, (p.t * RAMP) | 0)], p.x - w / 2, p.y - hgt * 0.6, w, hgt);
      } else if (p.type === 'ember') {
        p.vx += Math.sin(time * 2 + p.seed) * 30 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
        const a = (1 - p.t) * (0.55 + 0.45 * Math.sin(time * p.fl + p.seed)), r = p.r * 4;
        ctx.globalAlpha = Math.max(0, a);
        ctx.drawImage(emberSprite, p.x - r, p.y - r, r * 2, r * 2);
        ctx.fillStyle = `rgba(255,${200 - p.t * 120 | 0},120,${Math.max(0, a)})`;
        ctx.fillRect(p.x - p.r / 3, p.y - p.r / 3, p.r / 1.5, p.r / 1.5);
      } else if (p.type === 'spark') {
        p.vx += Math.sin(time * 6 + p.seed) * 140 * dt; p.vy *= 1 - 0.9 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        // Trail is a fixed slice of velocity (not of frame time), so it stays a short streak at any frame rate.
        ctx.globalAlpha = Math.min(1, (1 - p.t) * 1.4);
        ctx.strokeStyle = `rgb(255,${235 - p.t * 120 | 0},${170 - p.t * 140 | 0})`; ctx.lineWidth = p.w; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.lineTo(p.x, p.y); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (stage || parts.length) raf = requestAnimationFrame(frame); else last = 0;
  }

  window.PrFire = {
    // footRect: the PR foot's bounding rect, where stages 1-7 burn from.
    set(s, footRect) {
      if (!cv) init();
      stage = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : s | 0; rect = footRect || rect; // reduced motion: the red foot is enough
      if (!stage) acc = { spark: 0, ember: 0, flame: 0, smoke: 0 };
      if ((stage || parts.length) && !raf) raf = requestAnimationFrame(frame);
    },
  };
})();
