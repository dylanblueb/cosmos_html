#!/usr/bin/env node
// 今日宇宙切片：node tools/daily.js [YYYY-MM-DD]
// 与网页完全相同的模拟（种子 day-YYYY-MM-DD，默认参数，快进到当天的切片起点），输出 JSON。
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const code = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const sb = { console }; sb.globalThis = sb; vm.createContext(sb); vm.runInContext(code, sb);
const C = sb.Cosmos;
let date = process.argv[2];
if (!date) date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const seed = 'day-' + date;
const p = C.defaultParams();
const w = C.createWorld(p, seed);
const r = C.mulberry32(C.hashSeed(seed + '#slice'));
const start = 250 + Math.floor(r() * 1350);
for (let i = 0; i < start; i++) C.Sim.step(w, p);
const s = w.summary;
const major = w.events.filter(e => e.major);
let top = null;
for (const c of w.civs) if (c.alive && (!top || c.stars.size > top.stars.size)) top = c;
const LV = ['', '农业时代', '工业时代', '星际时代', '殖民时代', '星系时代', '星团时代', '跨星系时代', '神级文明'];
console.log(JSON.stringify({
  date, seed, sliceCycle: start,
  url: 'https://dylanblueb.github.io/cosmos_html/?seed=' + seed,
  stats: { alive: s.alive, extinct: s.dead, unborn: s.unborn, spacefaring: s.spacefaring, alliances: s.alliances,
    conflicts: s.conflicts, fleetsInFlight: s.fleets, starsOwned: s.owned, starsTotal: w.stars.length,
    civMatterPct: +(s.civRatio * 100).toFixed(1) },
  strongest: top ? { id: '#' + top.id, stars: top.stars.size, level: LV[top.level] } : null,
  headline: major.length ? major[major.length - 1].text : '宇宙还很安静',
  majorEvents: major.slice(-8).reverse().map(e => ({ cycle: e.t, text: e.text })),
  majorEventCount: major.length
}, null, 2));
