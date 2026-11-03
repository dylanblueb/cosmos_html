// Node harness: loads index.html's script with stubbed DOM/canvas, boots the UI,
// then runs the simulation headless and benchmarks it.
// Usage: node test/harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) throw new Error('no script');
const code = m[1];
fs.writeFileSync(path.join(__dirname, 'extracted.js'), code);

// ---------- stubs ----------
let ctxCalls = 0;
function makeCtx() {
  return new Proxy({}, {
    get(t, k) { if (k in t) return t[k]; return (...a) => { ctxCalls++; }; },
    set(t, k, v) { t[k] = v; return true; }
  });
}
function makeClassList() {
  const s = new Set();
  return { add: c => s.add(c), remove: c => s.delete(c), toggle: (c, f) => { if (f === undefined) f = !s.has(c); f ? s.add(c) : s.delete(c); return f; }, contains: c => s.has(c) };
}
const listeners = {};
function makeEl(id) {
  const ls = {};
  const el = {
    id, value: '', textContent: '', innerHTML: '', style: {}, tagName: 'DIV',
    classList: makeClassList(), clientWidth: 200, clientHeight: 60, width: 0, height: 0, _ls: ls,
    attrs: {},
    addEventListener(t, f) { (ls[t] = ls[t] || []).push(f); },
    dispatch(t, e) { (ls[t] || []).forEach(f => f(Object.assign({ type: t, preventDefault() {}, target: el }, e))); },
    getContext: () => makeCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    setPointerCapture() {}, removeAttribute(a) { delete el.attrs[a]; }, getAttribute(a) { return el.attrs[a] ?? null; }
  };
  return el;
}
const els = {};
const document = {
  readyState: 'complete',
  getElementById: id => (els[id] = els[id] || makeEl(id)),
  addEventListener: (t, f) => (listeners[t] = listeners[t] || []).push(f),
};
let rafCb = null;
const window = {
  document,
  location: { search: '?seed=harness', href: 'http://localhost/index.html?seed=harness' },
  history: { replaceState() {} },
  devicePixelRatio: 2,
  addEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  requestAnimationFrame: cb => { rafCb = cb; return 1; },
  ResizeObserver: class { observe() {} },
};
const sandbox = { window, document, URL, URLSearchParams, console, Math, performance };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'index.js' });
const C = window.Cosmos;
if (!C) throw new Error('Cosmos not exported');

// ---------- UI smoke test: run some frames through the real loop ----------
let t = 0;
els['start-btn'].dispatch('click');
for (let i = 0; i < 300; i++) { t += 16.7; rafCb(t); }
const uiWorld = C.App.world;
console.log('UI smoke: cycles after 300 frames @speed50 =', uiWorld.cycles, '(expect ~300*0.0167*60≈300)');
els['simulation-speed'].value = '100'; els['simulation-speed'].dispatch('input');
const c0 = uiWorld.cycles; for (let i = 0; i < 60; i++) { t += 16.7; rafCb(t); }
console.log('UI smoke: speed100 steps in 1s =', uiWorld.cycles - c0, '(expect ~120)');
els['start-btn'].dispatch('click'); // pause
const c1 = uiWorld.cycles; for (let i = 0; i < 30; i++) { t += 16.7; rafCb(t); }
console.log('UI smoke: paused advance =', uiWorld.cycles - c1, '(expect 0)');
els['step-btn'].dispatch('click');
console.log('UI smoke: single step advance =', C.App.world.cycles - c1, '(expect 1)');
els['universe-canvas'].dispatch('pointerdown', { pointerId: 1, clientX: 600, clientY: 400 });
els['universe-canvas'].dispatch('pointerup', { pointerId: 1, clientX: 600, clientY: 400 });
els['reset-btn'].dispatch('click');
console.log('UI smoke: reset cycles =', C.App.world.cycles, 'stats text alive =', els['alive-civs'].textContent);
document.getElementById('seed-input').value = 'harness';
els['reset-btn'].dispatch('click');

// ---------- determinism ----------
function runWorld(params, seed, steps) {
  const w = C.createWorld(params, seed);
  for (let i = 0; i < steps; i++) C.Sim.step(w, params);
  return w;
}
{
  const p = C.defaultParams();
  const a = runWorld(p, 'abc', 500), b = runWorld(p, 'abc', 500);
  const sig = w => w.civs.map(c => c.resources.toFixed(6) + c.alive).join('|') + w.env;
  console.log('determinism same seed:', sig(a) === sig(b) ? 'OK' : 'FAIL');
}

// ---------- validation + benchmark ----------
function check(w, mode) {
  for (const c of w.civs) {
    for (const k of ['x', 'y', 'resources', 'size', 'level', 'peakResources']) {
      if (!Number.isFinite(c[k])) throw new Error(`NaN/Inf in civ ${c.id}.${k}`);
    }
    if (c.alive && (c.allies.has(c.id) || c.enemies.has(c.id))) throw new Error('self relation');
    for (const id of c.allies) { const o = w.civs[id]; if (!o.alive || !o.allies.has(c.id)) throw new Error('asymmetric/dead ally'); }
    for (const id of c.enemies) { const o = w.civs[id]; if (!o.alive || !o.enemies.has(c.id)) throw new Error('asymmetric/dead enemy'); }
    if (mode === 'conserved' && c.resources < -1e-9) throw new Error('negative resources ' + c.resources);
  }
  if (!Number.isFinite(w.env)) throw new Error('env NaN');
  if (mode === 'conserved') {
    const tot = w.summary.totalMatter;
    if (Math.abs(tot - C.CONFIG.TOTAL_MATTER) > 1e-6 * C.CONFIG.TOTAL_MATTER) throw new Error('matter not conserved: ' + tot);
  }
}

const STEPS = 2000;
const rows = [];
const renderCtx = makeEl('bench-canvas');
C.Render.init(renderCtx); C.Render.resize(1200, 800, 2);

function bench(label, n, mode, seeds, overrides = {}) {
  for (const seed of seeds) {
    const p = Object.assign(C.defaultParams(), { initialCivs: n, mode }, overrides);
    const w = C.createWorld(p, seed);
    const t0 = performance.now();
    for (let i = 0; i < STEPS; i++) {
      C.Sim.step(w, p);
      if (i % 100 === 0) check(w, mode);
    }
    const dt = performance.now() - t0;
    check(w, mode);
    const r0 = performance.now();
    for (let i = 0; i < 200; i++) C.Render.draw(w, p, 0);
    const rdt = (performance.now() - r0) / 200;
    const s = w.summary;
    rows.push({ label, n, mode, seed, msPerStep: +(dt / STEPS).toFixed(4), renderMsJS: +rdt.toFixed(4),
      alive: s.alive, dead: s.dead, alliances: s.alliances, conflicts: s.conflicts,
      civMatterPct: +(s.civRatio * 100).toFixed(1), total: +s.totalMatter.toFixed(3) });
  }
}
const seeds = ['1', '42', 'cosmos', '20261103'];
// warm-up
bench('warmup', 20, 'conserved', ['w']); rows.length = 0;
bench('default', 20, 'conserved', seeds);
bench('default', 20, 'legacy', seeds);
bench('max slider', 50, 'conserved', seeds, { detectionRange: 300, aggression: 1, cooperation: 1, growthRate: 3 });
bench('max slider', 50, 'legacy', seeds, { detectionRange: 300, aggression: 1, cooperation: 1, growthRate: 3 });
bench('max slider, default behaviour params', 50, 'conserved', seeds);
// stress beyond UI range (API only) to show spatial grid scaling
bench('stress (API only)', 500, 'conserved', ['1', '42'], { detectionRange: 50 });
bench('stress (API only)', 2000, 'conserved', ['1'], { detectionRange: 50 });
console.table(rows);
console.log('All checks passed: no exceptions, no NaN, relations symmetric, matter conserved (conserved mode).');
