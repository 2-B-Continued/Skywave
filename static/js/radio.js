/* Skywave - the tuning dial, signal view and the Radio page. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc;

  RS.BANDS = [
    { id: 'fm', name: 'FM Radio', lo: 87.5e6, hi: 108e6, mode: 'wfm', span: 3e6 },
    { id: 'am', name: 'AM Radio', lo: 531e3, hi: 1701e3, mode: 'am', span: 150e3 },
    { id: 'air', name: 'Aircraft', lo: 118e6, hi: 137e6, mode: 'am', span: 1.5e6 },
    { id: 'marine', name: 'Marine', lo: 156e6, hi: 162.6e6, mode: 'nfm', span: 600e3 },
    { id: 'sw', name: 'Shortwave', lo: 2.3e6, hi: 26.1e6, mode: 'am', span: 300e3 },
    { id: 'all', name: 'Anywhere', lo: 0.5e6, hi: 1.7e9, mode: null, span: 2e6, log: true },
  ];

  // the bands follow the region: FM and AM edges (Japan's FM is 76 to 95 MHz, the Americas tune AM in 10 kHz steps to
  // 1700 kHz), and the walkie-talkie band (UHF CB, PMR446, FRS / GMRS, CB 245...); regions without one have no button
  function walkieBand() {
    const R = RS.region || {}, fm = RS.BANDS.find(b => b.id === 'fm'), am = RS.BANDS.find(b => b.id === 'am');
    if (R.fm) { fm.lo = R.fm[0]; fm.hi = R.fm[1]; }
    if (R.am) { am.lo = R.am[0]; am.hi = R.am[1] + R.am[2]; }
    const w = R.walkie, i = RS.BANDS.findIndex(b => b.id === 'cb');
    if (i >= 0) RS.BANDS.splice(i, 1);
    if (w) RS.BANDS.splice(RS.BANDS.findIndex(b => b.id === 'sw'), 0, { id: 'cb', name: w.name, lo: w.lo, hi: w.hi, mode: w.mode, span: w.span });
  }
  walkieBand();

  // ---------------------------------------------------------------- sweep results (shared with Explore)
  RS.on('sweep', m => {
    const bin = atob(m.db), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const e = { start: m.start, stop: m.stop, res: m.res, n: m.n, u8: u8, done: m.done, hop: m.hop, hops: m.hops, purpose: m.purpose, t: Date.now() };
    const i = RS.sweeps.findIndex(s => s.start === m.start && s.stop === m.stop);
    if (i >= 0) RS.sweeps[i] = e; else RS.sweeps.push(e);
    if (RS.sweeps.length > 12) RS.sweeps.shift();
    RS.sweepNow = m.done ? null : e;
    if (m.done && m.peaks) {
      RS.peaks = RS.peaks.filter(p => p.f < m.start - m.res || p.f > m.stop + m.res).concat(m.peaks.map(p => Object.assign({ t: Date.now() }, p)));
      RS.store.set('peaks', RS.peaks);
      RS.toast(m.peaks.length ? 'Found ' + m.peaks.length + ' signal' + (m.peaks.length === 1 ? '' : 's') + '.' : 'Nothing found. Check the antenna is connected and try again.');
    }
    RS.fire('sweepdata', e);
  });
  RS.sweepFor = (lo, hi) => { for (let i = RS.sweeps.length - 1; i >= 0; i--) { const s = RS.sweeps[i]; if (s.start <= lo + s.res * 2 && s.stop >= hi - s.res * 2) return s; } return null; };
  RS.findStations = (lo, hi, mode, label) => {
    RS.send({ cmd: 'sweep', start: lo, stop: hi, mode: mode, thr: RS.store.get('thr', 10), purpose: 'find', return_to: RS.vfo() });
    RS.toast('Looking for ' + (label || 'stations') + '. Sound pauses for a few seconds.');
  };

  // ---------------------------------------------------------------- the Dial
  function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }

  RS.Dial = function (o) {
    const d = this;
    d.cv = o.canvas; d.ov = o.overview; d.bands = o.bands; d.band = o.bands[0]; d.span = d.band.span; d.step = null; d.onBand = o.onBand || function () { };
    d.drag = null; d.dirty = true; d.autoSnap = true; d.hint = o.hint;
    d.lastIn = {};
    d.cv.tabIndex = 0;
    d.cv.setAttribute('role', 'slider'); d.cv.setAttribute('aria-label', 'Tuning dial. Drag left or right, or use the arrow keys.');
    const send = RS.throttle(f => RS.tune(f), 90);
    d.shown = () => d.drag ? d.drag.f : RS.vfo();
    d.stepHz = () => d.step || RS.stepFor(RS.curMode(), d.shown());
    d.clamp = f => { const b = d.band; return Math.min(Math.max(f, b.lo), b.hi); };
    d.setTo = (f, final) => {
      f = d.clamp(RS.snap(f, RS.curMode() && d.band.id !== 'all' ? d.band.mode || RS.curMode() : RS.modeFor(f), d.step));
      if (d.drag) d.drag.f = f;
      if (final) { RS.tune(f); d.lastIn[d.band.id] = f; } else send(f);
      d.dirty = true;
    };
    d.nudge = (n) => { const f = d.shown(); const s = d.stepHz(); d.setTo(f + n * s, true); };
    d.zoom = k => { d.span = Math.min(Math.max(d.span * k, 20e3), 60e6); d.dirty = true; };
    d.setBand = (id, jump) => {
      const b = d.bands.find(x => x.id === id) || d.bands[0];
      d.band = b; d.span = b.span; d.step = null;
      const f = RS.vfo();
      if (jump !== false && (f < b.lo || f > b.hi)) {
        const pk = RS.peaks.filter(p => p.f >= b.lo && p.f <= b.hi)[0];
        const fav = RS.favs.filter(p => p.f >= b.lo && p.f <= b.hi)[0];
        const t = d.lastIn[id] || (fav && fav.f) || (pk && pk.f) || (b.log ? 100.1e6 : (b.lo + b.hi) / 2);
        RS.tune(RS.snap(d.clamp(t), b.mode || RS.modeFor(t), null), b.mode ? { mode: b.mode } : {});
      } else if (b.mode && RS.autoMode && RS.curMode() !== b.mode && f >= b.lo && f <= b.hi) RS.setMode(b.mode);
      d.dirty = true; d.onBand(b);
    };
    d.sync = () => {            // keep the highlighted band in step with the frequency (e.g. after choosing a favourite)
      const f = RS.vfo();
      if (d.band.id !== 'all' && (f < d.band.lo || f > d.band.hi)) {
        const b = d.bands.find(x => x.id !== 'all' && f >= x.lo && f <= x.hi) || d.bands.find(x => x.id === 'all');
        if (b) { d.band = b; d.span = b.span; d.step = null; d.onBand(b); }
      }
    };
    // --- ruler geometry
    d.xOf = (f, w) => (f - (d.shown() - d.span / 2)) * (w / d.span);
    d.fOf = (x, w) => d.shown() - d.span / 2 + x * d.span / w;
    // --- input
    const cv = d.cv;
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      d.drag = { x0: e.clientX, f0: RS.vfo(), f: RS.vfo(), moved: false, t0: performance.now(), x: e.clientX };
    });
    cv.addEventListener('pointermove', e => {
      if (!d.drag) return;
      const dx = e.clientX - d.drag.x0;
      if (Math.abs(dx) > 4) d.drag.moved = true;
      if (d.drag.moved) d.setTo(d.drag.f0 - dx * d.span / cv.clientWidth, false);
    });
    const up = e => {
      if (!d.drag) return;
      const dr = d.drag;
      if (!dr.moved) {         // a tap: jump to that point (or the nearest found station)
        const r = cv.getBoundingClientRect(), x = e.clientX - r.left;
        let f = d.fOf(x, r.width);
        const near = d.markers().filter(p => Math.abs(d.xOf(p.f, r.width) - x) < 14).sort((a, b) => Math.abs(a.f - f) - Math.abs(b.f - f))[0];
        if (near) f = near.f;
        d.drag = null; d.setTo(f, true);
      } else { const f = dr.f; d.drag = null; d.setTo(f, true); }
    };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', () => { d.drag = null; });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) d.zoom(e.deltaY > 0 ? 1.25 : 0.8);
      else d.nudge((e.deltaY + e.deltaX) > 0 ? 1 : -1);
    }, { passive: false });
    cv.addEventListener('keydown', e => {
      const k = e.key, m = e.shiftKey ? 10 : 1;
      if (k === 'ArrowRight' || k === 'ArrowUp') { d.nudge(m); e.preventDefault(); }
      else if (k === 'ArrowLeft' || k === 'ArrowDown') { d.nudge(-m); e.preventDefault(); }
      else if (k === 'PageUp') { d.nudge(10); e.preventDefault(); }
      else if (k === 'PageDown') { d.nudge(-10); e.preventDefault(); }
      else if (k === '+' || k === '=') d.zoom(0.8);
      else if (k === '-') d.zoom(1.25);
    });
    // overview strip
    const ovx = (e) => { const r = d.ov.getBoundingClientRect(); const t = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1), b = d.band; return b.log ? b.lo * Math.pow(b.hi / b.lo, t) : b.lo + t * (b.hi - b.lo); };
    let ovDown = false;
    d.ov.addEventListener('pointerdown', e => { ovDown = true; d.ov.setPointerCapture(e.pointerId); d.setTo(ovx(e), false); });
    d.ov.addEventListener('pointermove', e => { if (ovDown) d.setTo(ovx(e), false); });
    d.ov.addEventListener('pointerup', e => { if (ovDown) { ovDown = false; d.setTo(ovx(e), true); } });

    // stations (found by a sweep, plus favourites) that fall in view
    d.markers = () => {
      const lo = d.shown() - d.span / 2, hi = d.shown() + d.span / 2, out = [];
      RS.peaks.forEach(p => { if (p.f >= lo && p.f <= hi) out.push({ f: p.f, db: p.db, kind: 'peak' }); });
      RS.favs.forEach(p => { if (p.f >= lo && p.f <= hi) out.push({ f: p.f, db: 30, kind: 'fav', name: p.name }); });
      return out;
    };

    // --- drawing
    d.draw = () => {
      const c = RS.fit(d.cv); if (!c) return;
      const g = c.g, w = c.w, h = c.h, vfo = d.shown(), pxHz = w / d.span, lo = vfo - d.span / 2, hi = vfo + d.span / 2;
      g.clearRect(0, 0, w, h);
      const SD = RS.DS && RS.DS[RS.sk()];
      if (SD && SD.dial) {
        const L = RS.live, fresh = L && performance.now() - L.t < 1500, major = niceStep((w < 560 ? 76 : 110) / pxHz), col = RS.dsCols();
        const pt = (i) => { const f = L.center + (i - 512) * (L.fs / 1024), db = L.bins[i] / 2.2 - 110; return { x: (f - lo) * pxHz, t: Math.min(Math.max((db - L.floor) / 50, 0), 1) }; };
        const cx = {
          g, w, h, lo, hi, pxHz, vfo, major, col, live: fresh, d,
          minorN: (major / Math.pow(10, Math.floor(Math.log10(major))) === 2) ? 4 : 5,
          mk: d.markers().sort((a, b) => a.f - b.f), bw: Math.max(3, (RS.st.bw || 12000) * pxHz),
          liveEnd: fresh ? Math.min(w, (L.center + L.fs / 2 - lo) * pxHz) : 0,
          liveLine: (gg, base, amp, _u, cb) => { base = base == null ? 80 : base; let st = false; for (let i = 0; i < 1024; i++) { const q = pt(i); if (q.x < -2 || q.x > w + 2) continue; const y = base - q.t * amp; if (cb) cb(q.x, y); else { st ? gg.lineTo(q.x, y) : gg.moveTo(q.x, base); if (!st) gg.lineTo(q.x, y); st = true; } } },
          liveCols: (S, cb) => { const bwd = L.fs / 1024; for (let x = 0; x < w; x += S) { const i = Math.round((lo + (x + S / 2) / pxHz - (L.center - L.fs / 2)) / bwd); if (i < 0 || i > 1023) continue; cb(x, pt(i).t); } },
        };
        SD.dial(cx);
        d.cv.setAttribute('aria-valuetext', RS.fmt(vfo, RS.curMode()));
        return;
      }
      const amber = '#ffb52e', ink = '#b9ccd4', dim = '#58727f';
      // band plan strip
      g.font = '12px Atkinson, sans-serif'; g.textBaseline = 'middle';
      RS.bandplan.forEach(b => {
        if (b.b < lo || b.a > hi) return;
        const x0 = Math.max(0, (b.a - lo) * pxHz), x1 = Math.min(w, (b.b - lo) * pxHz);
        g.fillStyle = '#ffffff10'; g.fillRect(x0, 0, Math.max(1, x1 - x0 - 1), 15);
        if (x1 - x0 > 46) { g.fillStyle = '#8fb0bd'; g.textAlign = 'left'; g.fillText(b.name, x0 + 5, 8, x1 - x0 - 8); }
      });
      // live signal picture behind the ruler
      const L = RS.live;
      if (L && performance.now() - L.t < 1500) {
        const bw = L.fs / 1024; g.beginPath(); let started = false;
        for (let i = 0; i < 1024; i++) {
          const f = L.center + (i - 512) * bw, x = (f - lo) * pxHz;
          if (x < -2 || x > w + 2) continue;
          const db = L.bins[i] / 2.2 - 110, t = Math.min(Math.max((db - L.floor) / 50, 0), 1), y = 80 - t * 42;
          if (!started) { g.moveTo(x, 80); started = true; }
          g.lineTo(x, y);
        }
        if (started) { g.lineTo(Math.min(w, (L.center + L.fs / 2 - lo) * pxHz), 80); g.closePath(); g.fillStyle = '#ffb52e30'; g.fill(); g.strokeStyle = '#ffb52e99'; g.lineWidth = 1; g.stroke(); }
      }
      // found stations and favourites
      const mk = d.markers().sort((a, b) => a.f - b.f);
      let lastLab = -99;
      mk.forEach(p => {
        const x = (p.f - lo) * pxHz, len = 10 + Math.min(p.db, 40) * 0.9;
        g.strokeStyle = p.kind === 'fav' ? '#ffffff' : '#6fd0dc'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(x, 22); g.lineTo(x, 22 + len); g.stroke();
        g.fillStyle = p.kind === 'fav' ? '#fff' : '#6fd0dc'; g.beginPath(); g.arc(x, 22, 3.5, 0, 7); g.fill();
        if (x - lastLab > 44 && x > 18 && x < w - 18) {
          lastLab = x; g.fillStyle = '#e6f0f3'; g.textAlign = 'center'; g.font = '700 12px "B612 Mono", monospace';
          g.fillText((p.f >= 1e6 ? (p.f / 1e6).toFixed(p.f % 1e5 === 0 ? 1 : 3) : (p.f / 1e3).toFixed(0)), x, 14 + 26 + len + 2 > 96 ? 96 : 22 + len + 12);
        }
      });
      // ruler ticks
      const major = niceStep((w < 560 ? 76 : 110) / pxHz), minorN = (major / Math.pow(10, Math.floor(Math.log10(major))) === 2) ? 4 : 5;
      g.textAlign = 'center'; g.font = '12px "B612 Mono", monospace';
      for (let f = Math.ceil(lo / major) * major; f <= hi; f += major) {
        const x = (f - lo) * pxHz;
        g.strokeStyle = ink; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, h - 24); g.lineTo(x, h); g.stroke();
        g.fillStyle = ink;
        let t;
        if (f < 2e6) t = (f / 1e3).toFixed(major < 1e3 ? 1 : 0);
        else { const dec = major >= 1e6 ? 0 : major >= 1e5 ? 1 : major >= 1e4 ? 2 : major >= 1e3 ? 3 : 4; t = (f / 1e6).toFixed(dec); }
        g.fillText(t, x, h - 30);
        for (let k = 1; k < minorN; k++) { const xm = x + k * major / minorN * pxHz; g.strokeStyle = dim; g.lineWidth = 1; g.beginPath(); g.moveTo(xm, h - 12); g.lineTo(xm, h); g.stroke(); }
      }
      // tuned channel width and the needle
      const bwPx = Math.max(3, (RS.st.bw || 12000) * pxHz);
      g.fillStyle = '#ffb52e22'; g.fillRect(w / 2 - bwPx / 2, 0, bwPx, h);
      g.strokeStyle = amber; g.lineWidth = 2; g.shadowColor = amber; g.shadowBlur = 8;
      g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke(); g.shadowBlur = 0;
      d.cv.setAttribute('aria-valuetext', RS.fmt(vfo, RS.curMode()));
    };
    d.drawOverview = () => {
      const c = RS.fit(d.ov); if (!c) return;
      const g = c.g, w = c.w, H = c.h, b = d.band, lin = !b.log, h = lin ? H - 17 : H;     // linear bands get a frequency scale along the bottom edge
      g.clearRect(0, 0, w, H);
      const SD = RS.DS && RS.DS[RS.sk()];
      if (SD && SD.ov) {
        const xf = f => b.log ? Math.log(f / b.lo) / Math.log(b.hi / b.lo) * w : (f - b.lo) / (b.hi - b.lo) * w, col = RS.dsCols(), v = d.shown();
        const cx = { g, w, h, b, xf, col, plan: [], series: null, peaks: [], favs: [], xv: Math.min(Math.max(xf(v), 0), w),
          x0: xf(Math.max(b.lo, v - d.span / 2)), x1: xf(Math.min(b.hi, v + d.span / 2)),
          hintText: (gg, ink) => { if (d.hint === '' || RS.peaks.some(p => p.f >= b.lo && p.f <= b.hi)) return; gg.fillStyle = ink; gg.font = '12px sans-serif'; gg.textAlign = 'center'; gg.textBaseline = 'middle'; gg.fillText(d.hint || 'Press "Find stations" to map this band', w / 2, h / 2); } };
        if (b.log) RS.bandplan.forEach(bp => { if (bp.b < b.lo || bp.a > b.hi) return; cx.plan.push({ x0: xf(Math.max(bp.a, b.lo)), x1: xf(Math.min(bp.b, b.hi)), name: bp.name }); });
        else {
          const sw = RS.sweepFor(b.lo, b.hi);
          if (sw) {
            const vals = []; for (let i = 0; i < sw.n; i++) if (sw.u8[i]) vals.push(sw.u8[i] / 2.2 - 110);
            vals.sort((a, z) => a - z); const floor = vals.length ? vals[Math.floor(vals.length * 0.3)] : -90; cx.series = [];
            for (let i = 0; i < sw.n; i++) { const f = sw.start + i * sw.res; if (f < b.lo || f > b.hi) continue; const vv = sw.u8[i] ? sw.u8[i] / 2.2 - 110 : floor; cx.series.push({ x: xf(f), t: Math.min(Math.max((vv - floor) / 45, 0), 1) }); }
          }
          RS.peaks.forEach(p => { if (p.f >= b.lo && p.f <= b.hi) cx.peaks.push(xf(p.f)); });
        }
        RS.favs.forEach(p => { if (p.f >= b.lo && p.f <= b.hi) cx.favs.push(xf(p.f)); });
        SD.ov(cx); if (lin) d.ovScale(g, w, H, h, b, cx.col.ink); return;
      }
      g.fillStyle = '#ffffff0d'; g.fillRect(0, 0, w, h);
      const xf = f => b.log ? Math.log(f / b.lo) / Math.log(b.hi / b.lo) * w : (f - b.lo) / (b.hi - b.lo) * w;
      if (b.log) {
        g.font = '11px Atkinson, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left';
        const pal = ['#2b6577', '#3b7f6a', '#7a6a2c', '#5c5a8a', '#2b6577'];
        RS.bandplan.forEach((bp, i) => {
          if (bp.b < b.lo || bp.a > b.hi) return;
          const x0 = xf(Math.max(bp.a, b.lo)), x1 = xf(Math.min(bp.b, b.hi));
          g.fillStyle = pal[i % pal.length] + 'cc'; g.fillRect(x0, 6, Math.max(2, x1 - x0), h - 12);
          if (x1 - x0 > 40) { g.fillStyle = '#e6f0f3'; g.fillText(bp.name, x0 + 3, h / 2, x1 - x0 - 4); }
        });
        // log scale ruler labels
        g.fillStyle = '#8fb0bd'; g.textAlign = 'center';
        [1e6, 10e6, 100e6, 1e9].forEach(f => { const x = xf(f); g.fillRect(x, 0, 1, 5); g.fillText(RS.fmt(f).replace('.0000', '').replace(/\.000/, '').replace(/\.0 /, ' '), Math.min(Math.max(x, 24), w - 24), h - 4); });
      } else {
        const sw = RS.sweepFor(b.lo, b.hi);
        if (sw) {
          let s = []; for (let i = 0; i < sw.n; i++) if (sw.u8[i]) s.push(sw.u8[i] / 2.2 - 110);
          const sorted = s.slice().sort((a, z) => a - z), floor = sorted.length ? sorted[Math.floor(sorted.length * 0.3)] : -90;
          g.beginPath(); g.moveTo(0, h);
          for (let i = 0; i < sw.n; i++) {
            const f = sw.start + i * sw.res; if (f < b.lo || f > b.hi) continue;
            const v = sw.u8[i] ? sw.u8[i] / 2.2 - 110 : floor, t = Math.min(Math.max((v - floor) / 45, 0), 1);
            g.lineTo(xf(f), h - 2 - t * (h - 6));
          }
          g.lineTo(w, h); g.closePath(); g.fillStyle = '#6fd0dc55'; g.fill();
        } else {
          g.fillStyle = '#8fb0bd'; g.font = '12px Atkinson, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
          if (d.hint !== '' && !RS.peaks.some(p => p.f >= b.lo && p.f <= b.hi)) g.fillText(d.hint || 'Press "Find stations" to map this band', w / 2, h / 2);
        }
        RS.peaks.forEach(p => { if (p.f >= b.lo && p.f <= b.hi) { g.fillStyle = '#6fd0dc'; g.fillRect(xf(p.f) - 1, 4, 2, h - 8); } });
      }
      RS.favs.forEach(p => { if (p.f >= b.lo && p.f <= b.hi) { g.fillStyle = '#fff'; g.beginPath(); g.arc(xf(p.f), 5, 3, 0, 7); g.fill(); } });
      // what the dial is showing, and the tuned point
      const v = d.shown();
      const x0 = xf(Math.max(b.lo, v - d.span / 2)), x1 = xf(Math.min(b.hi, v + d.span / 2));
      g.strokeStyle = '#ffffff66'; g.lineWidth = 1; g.strokeRect(x0 + .5, 1.5, Math.max(3, x1 - x0), h - 3);
      g.fillStyle = '#ffb52e'; g.fillRect(Math.min(Math.max(xf(v), 0), w - 2) - 1, 0, 3, h);
      if (lin) d.ovScale(g, w, H, h, b, '#8fb0bd');
    };
    // the whole band as a labelled scale, so it is clear where every mark on the strip sits
    d.ovScale = (g, w, H, h, b, ink) => {
      const span = b.hi - b.lo, major = niceStep(span / Math.max(2, Math.floor(w / 72))), sk = RS.sk();
      const font = { lumen: '500 10.5px Inter, sans-serif', bento: '700 10.5px "JetBrains Mono", monospace', folio: 'italic 13px "Instrument Serif", Georgia, serif', aurora: '500 10px "Geist Mono", monospace', skywave: '500 11px "Lumen Inter", Inter, sans-serif', classic: '11px Atkinson, sans-serif' }[sk] || '11px "B612 Mono", monospace';
      g.save(); g.fillStyle = ink; g.globalAlpha = .45; g.fillRect(0, h, w, 1); g.globalAlpha = 1; g.font = font; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      for (let f = Math.ceil(b.lo / major) * major; f <= b.hi + 1; f += major) {
        const x = (f - b.lo) / span * w, dec = major >= 1e6 ? 0 : major >= 1e5 ? 1 : major >= 1e4 ? 2 : major >= 1e3 ? 3 : 4;
        g.globalAlpha = .7; g.fillRect(Math.round(x), h, 1, 4); g.globalAlpha = .9;
        g.fillText(f < 2e6 ? (f / 1e3).toFixed(major < 1e3 ? 1 : 0) : (f / 1e6).toFixed(dec), Math.min(Math.max(x, 16), w - 16), H - 2);
      }
      // found stations: their frequency printed on the strip at the same x as the mark
      let last = -99; g.globalAlpha = 1; g.fillStyle = ink; g.textBaseline = 'alphabetic';
      RS.peaks.filter(p => p.f >= b.lo && p.f <= b.hi).sort((a, z) => a.f - z.f).forEach(p => { const x = (p.f - b.lo) / span * w; if (x - last < 38 || x < 16 || x > w - 16) return; last = x; g.fillText((p.f / 1e6).toFixed(1), x, h - 3); });
      g.restore();
    };
    d.render = () => { if (d.dirty) { d.draw(); d.drawOverview(); d.dirty = false; } };
    RS.on('spec', () => { d.dirty = true; });
    RS.on('state', () => { d.dirty = true; });
    RS.on('local', () => { d.dirty = true; });
    RS.on('sweepdata', () => { d.dirty = true; });
    RS.on('theme', () => { d.dirty = true; });
    RS.on('favourites', () => { d.dirty = true; });
    window.addEventListener('resize', () => { d.dirty = true; });
  };

  // ---------------------------------------------------------------- spectrum + waterfall
  RS.Scope = function (spec, water, info) {
    const s = this; s.spec = spec; s.water = water; s.info = info;
    water.width = 1024; water.height = 190;
    const wg = water.getContext('2d'); wg.fillStyle = '#091419'; wg.fillRect(0, 0, 1024, 190);
    const row = wg.createImageData(1024, 1);
    // colour maps (stops from low signal to high signal)
    const MAPS = RS.COLORMAPS = {
      classic: { name: 'Classic', st: [[6, 20, 26], [10, 52, 76], [24, 110, 138], [255, 181, 46], [255, 246, 220]] },
      viridis: { name: 'Viridis', st: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]] },
      inferno: { name: 'Inferno', st: [[0, 0, 4], [87, 16, 110], [188, 55, 84], [249, 142, 9], [252, 255, 164]] },
      magma: { name: 'Magma', st: [[0, 0, 4], [81, 18, 124], [183, 55, 121], [252, 137, 97], [252, 253, 191]] },
      plasma: { name: 'Plasma', st: [[13, 8, 135], [126, 3, 168], [204, 71, 120], [248, 149, 64], [240, 249, 33]] },
      turbo: { name: 'Turbo', st: [[48, 18, 59], [70, 130, 250], [30, 220, 150], [240, 210, 40], [122, 4, 3]] },
      ice: { name: 'Ice', st: [[2, 6, 20], [14, 50, 110], [60, 140, 200], [170, 220, 245], [255, 255, 255]] },
      grey: { name: 'Greyscale', st: [[0, 0, 0], [64, 64, 64], [128, 128, 128], [192, 192, 192], [255, 255, 255]] },
      sdr: { name: 'Blue-red', st: [[0, 0, 40], [0, 0, 220], [0, 220, 220], [250, 250, 0], [220, 0, 0]] },
    };
    const luts = {};
    function lutFor(name) {
      if (luts[name]) return luts[name];
      const st = (MAPS[name] || MAPS.classic).st, L = new Uint8Array(256 * 3);
      for (let k = 0; k < 256; k++) { const p = k / 255 * 4, i = Math.min(3, Math.floor(p)), f = p - i, a = st[i], b = st[i + 1]; for (let c = 0; c < 3; c++) L[k * 3 + c] = a[c] + (b[c] - a[c]) * f; }
      return (luts[name] = L);
    }
    RS.disp = Object.assign({ cmap: 'classic', auto: true, min: -100, max: -30, peak: false, maxhold: false, smooth: 0, wfms: 90, fill: true, grid: true, trace: '#ffb52e', markers: true }, RS.store.get('disp', {}));
    RS.markers = RS.store.get('markers', []); RS.meas = {};
    RS.setDisp = patch => { Object.assign(RS.disp, patch); RS.store.set('disp', RS.disp); RS.fire('disp'); };
    RS.setMarkers = m => { RS.markers = m.slice(0, 6); RS.store.set('markers', RS.markers); RS.fire('disp'); };
    s.paused = false; s.last = 0; s.sm = null; s.pk = null; s.mx = null; s.hdr = '';
    RS.on('disp', () => { s.pk = null; s.mx = null; });
    (RS._scopes = RS._scopes || []).push(s);
    RS.act['scope-reset-hold'] = () => RS._scopes.forEach(x => { x.pk = null; x.mx = null; x.mn = null; x.av = null; });
    const dbAt = (L, i) => L.bins[i] / 2.2 - 110;
    function measure(L, arr) {
      let pi = 0; for (let i = 1; i < 1024; i++) if (arr[i] > arr[pi]) pi = i;
      let off = 0; if (pi > 0 && pi < 1023) { const a = arr[pi - 1], b = arr[pi], c = arr[pi + 1], d = a - 2 * b + c; if (d !== 0) off = 0.5 * (a - c) / d; }
      const binHz = L.fs / 1024, f0 = L.center - L.fs / 2;
      const m = { peakF: f0 + (pi + off + 0.5) * binHz, peakDb: arr[pi], floor: L.floor, binHz: binHz };
      const bw = RS.st.bw || 12000, vf = RS.vfo(), lo = Math.max(0, Math.round((vf - bw / 2 - f0) / binHz)), hi = Math.min(1023, Math.round((vf + bw / 2 - f0) / binHz));
      if (hi > lo) { let p = 0; for (let i = lo; i <= hi; i++) p += Math.pow(10, arr[i] / 10); m.chanDb = 10 * Math.log10(p); }
      // occupied bandwidth (99% of the power within +-250 kHz of the strongest bin)
      const span = Math.min(512, Math.round(250e3 / binHz)), a0 = Math.max(0, pi - span), a1 = Math.min(1023, pi + span); let tot = 0; const nf = Math.pow(10, L.floor / 10);
      for (let i = a0; i <= a1; i++) tot += Math.max(0, Math.pow(10, arr[i] / 10) - nf);
      if (tot > 0) { let l = pi, r = pi, acc = Math.max(0, Math.pow(10, arr[pi] / 10) - nf); while (acc < 0.99 * tot && (l > a0 || r < a1)) { const pl = l > a0 ? Math.max(0, Math.pow(10, arr[l - 1] / 10) - nf) : -1, pr = r < a1 ? Math.max(0, Math.pow(10, arr[r + 1] / 10) - nf) : -1; if (pl >= pr) { l--; acc += pl; } else { r++; acc += pr; } } m.obw = (r - l + 1) * binHz; }
      return m;
    }
    s.frame = L => {
      if (s.paused || !s.spec.offsetParent) return;
      const D = RS.disp, now = performance.now(); if (now - s.last < Math.min(D.wfms, 90)) return; s.last = now;
      const cur = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) cur[i] = dbAt(L, i);
      if (D.smooth > 0) { if (!s.sm) s.sm = Float32Array.from(cur); for (let i = 0; i < 1024; i++) cur[i] = s.sm[i] = D.smooth * s.sm[i] + (1 - D.smooth) * cur[i]; } else s.sm = null;
      if (D.peak || D.maxhold) {
        if (!s.pk) s.pk = Float32Array.from(cur); if (!s.mx) s.mx = Float32Array.from(cur);
        for (let i = 0; i < 1024; i++) { s.pk[i] = Math.max(cur[i], s.pk[i] - 0.15); s.mx[i] = Math.max(cur[i], s.mx[i]); }
      }
      if (D.minhold) { if (!s.mn) s.mn = Float32Array.from(cur); for (let i = 0; i < 1024; i++) s.mn[i] = Math.min(cur[i], s.mn[i]); }
      if (D.avgtrace) { if (!s.av) s.av = Float32Array.from(cur); const k = 1 / Math.max(2, D.avgn || 20); for (let i = 0; i < 1024; i++) s.av[i] += k * (cur[i] - s.av[i]); }
      const lo = D.auto ? L.floor - 6 : D.min, rng = D.auto ? 56 : Math.max(10, D.max - D.min);
      // waterfall row (rate follows the waterfall speed setting)
      if (now - (s.lastW || 0) >= D.wfms - 5) {
        s.lastW = now;
        const lut = lutFor(D.cmap), wl = D.auto ? L.floor - 4 : D.min, wr = D.auto ? 46 : Math.max(10, D.max - D.min);
        wg.drawImage(water, 0, 0, 1024, 189, 0, 1, 1024, 189);
        for (let i = 0; i < 1024; i++) { const t = Math.pow(Math.min(Math.max((cur[i] - wl) / wr, 0), 1), D.gamma || 1), k = Math.round(t * 255) * 3, o = i * 4; row.data[o] = lut[k]; row.data[o + 1] = lut[k + 1]; row.data[o + 2] = lut[k + 2]; row.data[o + 3] = 255; }
        wg.putImageData(row, 0, 0);
      }
      // spectrum
      const c = RS.fit(s.spec); if (!c) return;
      const g = c.g, w = c.w, h = c.h, Y = db => h - 2 - Math.min(Math.max((db - lo) / rng, 0), 1) * (h - 8);
      g.clearRect(0, 0, w, h);
      const SD = RS.DS && RS.DS[RS.sk()];
      const SDs = !!(SD && SD.spec);
      if (SDs) {
        SD.spec({ g, w, h, Y, cur, D, lo, rng, col: RS.dsCols(), mx: D.maxhold ? s.mx : null, pk: D.peak ? s.pk : null });
        const tx = (RS.vfo() - (L.center - L.fs / 2)) / L.fs * w, tb = (RS.st.bw || 12000) / L.fs * w, ck = RS.dsCols();
        if (tx > 0 && tx < w) { g.fillStyle = ck.sig + '33'; g.fillRect(tx - tb / 2, 0, Math.max(2, tb), h); g.fillStyle = ck.sig; g.fillRect(tx - 1, 0, 2, h); }
      } else
      if (D.grid) {
        g.strokeStyle = '#ffffff12'; g.lineWidth = 1; g.fillStyle = '#8fb0bd88'; g.font = '10px sans-serif'; g.textAlign = 'left';
        for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, h * i / 4); g.lineTo(w, h * i / 4); g.stroke(); if (!D.auto || RS.adv) g.fillText(Math.round(lo + rng * (1 - i / 4) + ((RS.lab && RS.lab.ref_db) || 0)) + ((RS.lab && RS.lab.ref_db) ? ' dBm' : ' dB'), 3, h * i / 4 - 2); }
        for (let i = 1; i < 8; i++) { g.beginPath(); g.moveTo(w * i / 8, 0); g.lineTo(w * i / 8, h); g.stroke(); }
      }
      const trace = (arr, style, fill) => { g.beginPath(); g.moveTo(0, h); for (let i = 0; i < 1024; i++) g.lineTo(i / 1023 * w, Y(arr[i])); if (fill) { g.lineTo(w, h); g.closePath(); g.fillStyle = fill; g.fill(); } g.strokeStyle = style; g.lineWidth = fill ? 1.2 : 1; if (!fill) { g.beginPath(); for (let i = 0; i < 1024; i++) i ? g.lineTo(i / 1023 * w, Y(arr[i])) : g.moveTo(0, Y(arr[0])); } g.stroke(); };
      if (!SDs && D.maxhold && s.mx) trace(s.mx, '#ff6b6baa');
      if (!SDs && D.peak && s.pk) trace(s.pk, '#7ee0ffcc');
      if (!SDs && D.minhold && s.mn) trace(s.mn, '#9be37daa');
      if (!SDs && D.avgtrace && s.av) trace(s.av, '#d0a8ffdd');
      if (!SDs) trace(cur, D.trace, D.fill ? D.trace + '2a' : null);
      // tuned marker
      const x = (RS.vfo() - (L.center - L.fs / 2)) / L.fs * w, bw = (RS.st.bw || 12000) / L.fs * w;
      if (!SDs && x > 0 && x < w) { g.fillStyle = '#ffffff22'; g.fillRect(x - bw / 2, 0, Math.max(2, bw), h); g.fillStyle = '#fff'; g.fillRect(x - 1, 0, 2, h); }
      // markers
      if (D.markers && RS.markers.length) {
        g.font = '700 11px sans-serif'; g.textAlign = 'left';
        RS.markers.forEach((m, k) => { const xm = (m - (L.center - L.fs / 2)) / L.fs * w; if (xm < 0 || xm > w) return; const bi = Math.min(1023, Math.max(0, Math.round((m - (L.center - L.fs / 2)) / L.fs * 1023)));
          g.strokeStyle = '#7ee0ff'; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(xm, 0); g.lineTo(xm, h); g.stroke(); g.setLineDash([]);
          g.fillStyle = '#7ee0ff'; g.fillText('M' + (k + 1) + ' ' + cur[bi].toFixed(0) + ' dB', Math.min(xm + 4, w - 70), 12 + k * 12); });
      }
      const mm = measure(L, cur); mm.nfftRes = L.fs / ((RS.lab && RS.lab.nfft) || 4096); RS.meas = mm;
      if (now - (s.lastM || 0) > 400) { s.lastM = now; RS.fire('meas', mm); }
      if (s.info) s.info.textContent = RS.fmt(L.center - L.fs / 2) + '  to  ' + RS.fmt(L.center + L.fs / 2) + '   |   signal ' + (L.snr > 0 ? '+' : '') + L.snr.toFixed(0) + ' dB above the noise' + (RS.adv ? '   |   peak ' + RS.fmt(mm.peakF) + ' at ' + mm.peakDb.toFixed(1) + ' dB' : '');
    };
    const click = e => {
      const L = RS.live; if (!L) return;
      const r = e.currentTarget.getBoundingClientRect(), t = (e.clientX - r.left) / r.width;
      if (e.shiftKey && RS.adv) { RS.setMarkers(RS.markers.concat([L.center - L.fs / 2 + t * L.fs])); return; }
      RS.tune(RS.snap(L.center - L.fs / 2 + t * L.fs, RS.curMode(), RS.adv ? null : 5e3));
    };
    spec.addEventListener('click', click); water.addEventListener('click', click);
  };

  // ---------------------------------------------------------------- the Radio page
  function parseFreq(txt, unit) {
    const m = String(txt).trim().toLowerCase().replace(',', '.').match(/^([\d.]+)\s*(k|m|g|khz|mhz|ghz)?$/);
    if (!m) return null;
    let n = parseFloat(m[1]); if (!isFinite(n)) return null;
    const u = m[2] ? m[2][0] : unit;
    return u === 'k' ? n * 1e3 : u === 'g' ? n * 1e9 : n * 1e6;
  }
  RS.parseFreq = parseFreq;

  // ================================================================ the Radio page
  // A stage (cover, station, song, signal, listen and seek), a tuning ribbon with the stations written on its scale,
  // and a map of the whole band. Under it: your stations as presets; one card that switches between stations here,
  // recently played and songs heard; about this station (from RDS); sound and tuning; the signal picture.
  // The Dial and Scope above stay for Home, Scanner and Lab; this page has its own tuner.
  const P = RS.pages.radio = {};
  let tuner, scope;
  const RECENT = 'rd_recent', SONGS = 'rd_songs';
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'off';
  P.tab = RS.store.get('rd_tab', 'here');

  // ---------------------------------------------------------------- the tuner: band, ribbon and band map
  function Tuner(cv, ov) {
    const t = this;
    t.cv = cv; t.ov = ov; t.band = RS.BANDS[0]; t.wide = () => innerWidth > 900 ? 2 : 1; t.span = t.band.span * t.wide(); t.step = null; t.drag = null; t.glide = null; t.dirty = true; t.hits = []; t.lastIn = RS.store.get('rd_lastin', {});
    cv.tabIndex = 0; cv.setAttribute('role', 'slider'); cv.setAttribute('aria-label', 'Tuning. Drag left or right, or use the arrow keys.');
    const send = RS.throttle(f => RS.tune(f), 90);
    t.shown = () => t.drag ? t.drag.f : t.glide ? t.glide.f : t.back ? t.back.f : RS.vfo();
    t.mode = f => t.band.id !== 'all' && t.band.mode ? t.band.mode : RS.modeFor(f);
    t.stepHz = () => t.step || RS.stepFor(RS.curMode(), t.shown());
    t.clamp = f => Math.min(Math.max(f, t.band.lo), t.band.hi);
    t.setTo = (f, final) => {
      f = t.clamp(f);
      if (final) { f = t.clamp(RS.snap(f, t.mode(f), t.step)); RS.tune(f); t.lastIn[t.band.id] = f; RS.store.set('rd_lastin', t.lastIn); }
      else send(t.clamp(RS.snap(f, t.mode(f), t.step)));
      if (t.drag) t.drag.f = f; t.dirty = true;
    };
    t.nudge = n => { t.glide = null; t.setTo(t.shown() + n * t.stepHz(), true); };
    t.zoom = k => { t.span = Math.min(Math.max(t.span * k, 20e3), 60e6); t.dirty = true; };
    t.setBand = (id, jump) => {
      const b = RS.BANDS.find(x => x.id === id) || RS.BANDS[0], f = RS.vfo();
      t.band = b; t.span = b.span * t.wide(); t.step = null; t.glide = null;
      if (jump !== false && (f < b.lo || f > b.hi)) {
        const fav = RS.favs.find(p => p.f >= b.lo && p.f <= b.hi), pk = RS.peaks.find(p => p.f >= b.lo && p.f <= b.hi);
        const to = t.lastIn[id] || (fav && fav.f) || (pk && pk.f) || (b.log ? 100.1e6 : (b.lo + b.hi) / 2);
        RS.tune(RS.snap(t.clamp(to), b.mode || RS.modeFor(to), null), b.mode ? { mode: b.mode } : {});
      } else if (b.mode && RS.autoMode && RS.curMode() !== b.mode && f >= b.lo && f <= b.hi) RS.setMode(b.mode);
      t.dirty = true; P.state(); P.stations();
    };
    t.sync = () => {       // keep the band in step with the frequency (after a preset, a search result, another page)
      const f = RS.vfo();
      if (t.band.id !== 'all' && (f < t.band.lo || f > t.band.hi)) {
        const b = RS.BANDS.find(x => x.id !== 'all' && f >= x.lo && f <= x.hi) || RS.BANDS.find(x => x.id === 'all');
        if (b && b !== t.band) { t.band = b; t.span = b.span * t.wide(); t.step = null; }
      }
    };
    t.markers = () => {
      const v = t.shown(), lo = v - t.span / 2, hi = v + t.span / 2, out = [], seen = [];
      RS.favs.forEach(p => { if (p.f >= lo && p.f <= hi) { out.push({ f: p.f, fav: true, name: p.name || RS.nameFor(p.f) }); seen.push(p.f); } });
      RS.peaks.forEach(p => { if (p.f >= lo && p.f <= hi && !seen.some(s => Math.abs(s - p.f) < 5e3)) out.push({ f: p.f, db: p.db, name: RS.nameFor(p.f) }); });
      return out.sort((a, z) => a.f - z.f);
    };

    // input: drag one-to-one, flick to glide (slowing like a free-spinning knob), tap a station or a point to tune
    const xs = [];
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId); t.glide = null; xs.length = 0;
      t.drag = { x0: e.clientX, f0: t.shown(), f: t.shown(), moved: false }; xs.push([e.clientX, e.timeStamp]);
    });
    cv.addEventListener('pointermove', e => {
      if (!t.drag) return;
      const dx = e.clientX - t.drag.x0; if (Math.abs(dx) > 4) t.drag.moved = true;
      xs.push([e.clientX, e.timeStamp]); if (xs.length > 6) xs.shift();
      if (t.drag.moved) {
        const raw = t.drag.f0 - dx * t.span / cv.clientWidth;
        t.drag.f = RS.feel ? RS.feel.rubber(raw, t.band.lo, t.band.hi) : t.clamp(raw);     // past an end: a fifth of the pull
        send(t.clamp(RS.snap(t.clamp(raw), t.mode(t.clamp(raw)), t.step))); t.dirty = true;
      }
    });
    cv.addEventListener('pointerup', e => {
      const dr = t.drag; if (!dr) return; t.drag = null;
      if (!dr.moved) {
        const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        const hit = t.hits.find(h => x >= h.x0 - 4 && x <= h.x1 + 4 && y >= h.y0 - 4 && y <= h.y1 + 4);
        const f = hit ? hit.f : t.shown() + (x - r.width / 2) * t.span / r.width;
        if (hit) RS.tune(hit.f, hit.mode ? { mode: hit.mode } : {}); else t.setTo(f, true);
        return;
      }
      const a = xs[0], z = xs[xs.length - 1], dt = z && a ? z[1] - a[1] : 0, v = dt > 0 ? (z[0] - a[0]) / dt : 0;   // px per ms
      if (!reduce() && Math.abs(v) > 0.35 && e.timeStamp - z[1] < 80) t.glide = { f: dr.f, v: -v * t.span / cv.clientWidth, last: performance.now() };
      else if (dr.f < t.band.lo || dr.f > t.band.hi) { t.back = { a: dr.f, b: t.clamp(dr.f), f: dr.f, t0: performance.now() }; t.setTo(t.back.b, true); }
      else t.setTo(dr.f, true);
    });
    cv.addEventListener('pointercancel', () => { t.drag = null; });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) t.zoom(e.deltaY > 0 ? 1.25 : 0.8); else t.nudge((e.deltaY + e.deltaX) > 0 ? 1 : -1);
    }, { passive: false });
    cv.addEventListener('keydown', e => {
      const k = e.key, m = e.shiftKey ? 10 : 1;
      if (k === 'ArrowRight' || k === 'ArrowUp') { t.nudge(m); e.preventDefault(); }
      else if (k === 'ArrowLeft' || k === 'ArrowDown') { t.nudge(-m); e.preventDefault(); }
      else if (k === 'PageUp') { t.nudge(10); e.preventDefault(); } else if (k === 'PageDown') { t.nudge(-10); e.preventDefault(); }
      else if (k === '+' || k === '=') t.zoom(0.8); else if (k === '-') t.zoom(1.25);
    });
    t.step$ = now => {           // one frame of a glide, or of springing back from past an end
      if (t.back) { const k = Math.min(1, (now - t.back.t0) / 300), e = 1 - Math.pow(1 - k, 3); t.back.f = t.back.a + (t.back.b - t.back.a) * e; t.dirty = true; if (k >= 1) t.back = null; }
      const g = t.glide; if (!g) return;
      const dt = Math.min(48, now - g.last); g.last = now;
      g.f = t.clamp(g.f + g.v * dt); g.v *= Math.exp(-dt / 325);
      const pxv = Math.abs(g.v) * cv.clientWidth / t.span;
      if (pxv < 0.03 || g.f <= t.band.lo || g.f >= t.band.hi) { t.glide = null; t.setTo(g.f, true); } else send(RS.snap(g.f, t.mode(g.f), t.step));
      t.dirty = true;
    };
    // the band map: drag or tap anywhere along the band
    const ovf = e => { const r = ov.getBoundingClientRect(), k = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1), b = t.band; return b.log ? b.lo * Math.pow(b.hi / b.lo, k) : b.lo + k * (b.hi - b.lo); };
    let ovDown = false;
    ov.addEventListener('pointerdown', e => { ovDown = true; t.glide = null; ov.setPointerCapture(e.pointerId); t.setTo(ovf(e), false); t.drag = { f: ovf(e), x0: 0, f0: 0, moved: true, ov: true }; });
    ov.addEventListener('pointermove', e => { if (ovDown) { t.drag.f = t.clamp(ovf(e)); t.setTo(t.drag.f, false); } });
    ov.addEventListener('pointerup', e => { if (ovDown) { ovDown = false; t.drag = null; t.setTo(ovf(e), true); } });
    ov.addEventListener('pointercancel', () => { ovDown = false; t.drag = null; });

    // colours and type come from the style, read off the canvas so the instrument surface's own ink applies
    let C = null, Ct = 0;
    t.cols = () => {
      if (C && performance.now() - Ct < 1000) return C;
      const s = getComputedStyle(cv), g = n => s.getPropertyValue(n).trim();
      C = { ink: g('--inst-ink') || s.color, sig: g('--sig') || g('--pri'), pri: g('--pri'), num: g('--f-num') || 'monospace', body: g('--f-body') || 'sans-serif', r: Math.min(10, parseFloat(g('--r-ctl')) || 8) };
      Ct = performance.now(); return C;
    };
    RS.on('theme', () => { C = null; t.dirty = true; });
    const fmtTick = (f, major) => f < 2e6 ? (f / 1e3).toFixed(major < 1e3 ? 1 : 0) : (f / 1e6).toFixed(major >= 1e6 ? 0 : major >= 1e5 ? 1 : major >= 1e4 ? 2 : major >= 1e3 ? 3 : 4);
    const shortF = f => f >= 1e6 ? (f / 1e6).toFixed(f % 1e5 === 0 ? 1 : f % 1e4 === 0 ? 2 : 3) : (f / 1e3).toFixed(0);
    const rr = (g, x, y, w, h, r) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); };

    t.draw = () => {
      const c = RS.fit(cv); if (!c) return;
      const g = c.g, w = c.w, h = c.h, k = t.cols(), v = t.shown(), px = w / t.span, lo = v - t.span / 2, base = h - 26, cur = RS.vfo();
      g.clearRect(0, 0, w, h);
      g.save(); g.strokeStyle = k.ink; g.fillStyle = k.ink;
      // the live signal, rising from the scale
      const L = RS.live;
      if (L && performance.now() - L.t < 1500) {
        const bw = L.fs / 1024; let on = false; g.beginPath();
        for (let i = 0; i < 1024; i++) {
          const x = (L.center + (i - 512) * bw - lo) * px; if (x < -2 || x > w + 2) continue;
          const q = Math.min(Math.max((L.bins[i] / 2.2 - 110 - L.floor) / 50, 0), 1), y = base - 2 - q * (base - 54);
          if (!on) { g.moveTo(x, base); on = true; } g.lineTo(x, y);
        }
        if (on) {
          g.lineTo(Math.min(w, (L.center + L.fs / 2 - lo) * px), base); g.closePath();
          g.globalAlpha = .14; g.fillStyle = k.sig; g.fill(); g.globalAlpha = .55; g.strokeStyle = k.sig; g.lineWidth = 1; g.stroke(); g.globalAlpha = 1;
        }
      }
      // the scale
      const major = niceStep((w < 560 ? 70 : 96) / px), minorN = (major / Math.pow(10, Math.floor(Math.log10(major))) === 2) ? 4 : 5;
      g.fillStyle = k.ink; g.strokeStyle = k.ink; g.lineWidth = 1;
      g.globalAlpha = .28; g.fillRect(0, base, w, 1);
      g.font = '500 12px ' + k.num; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      for (let f = Math.ceil(lo / major) * major; f <= lo + t.span; f += major) {
        const x = Math.round((f - lo) * px) + .5;
        g.globalAlpha = .7; g.fillRect(x - .5, base - 12, 1, 12);
        g.globalAlpha = .75; g.fillText(fmtTick(f, major), x, h - 6);
        g.globalAlpha = .3; for (let m = 1; m < minorN; m++) g.fillRect(Math.round(x + m * major / minorN * px) - .5, base - 6, 1, 6);
      }
      g.globalAlpha = 1;
      // the tuned channel and the needle
      const bwp = Math.max(3, (RS.st.bw || 12000) * px);
      g.globalAlpha = .1; g.fillStyle = k.sig; g.fillRect(w / 2 - bwp / 2, 0, bwp, base); g.globalAlpha = 1;
      g.fillStyle = k.sig; g.fillRect(Math.round(w / 2) - 1, 0, 2, h - 20);
      g.beginPath(); g.moveTo(w / 2 - 6, base + 7); g.lineTo(w / 2 + 6, base + 7); g.lineTo(w / 2, base + 1); g.closePath(); g.fill();
      // stations on the scale, written on it like the glass of an old receiver: two rows, never overlapping
      t.hits = [];
      const rows = [-99, -99], ph = 22, ys = [4, 30];
      g.font = '500 12.5px ' + k.body; g.textBaseline = 'middle';
      t.markers().forEach(p => {
        const x = (p.f - lo) * px, on = Math.abs(p.f - cur) < 5e3, lab = p.name ? p.name : shortF(p.f);
        const tw = Math.min(g.measureText(lab).width, 120), pw = tw + 18;
        let row = rows.findIndex(r => x - pw / 2 > r + 6);
        g.globalAlpha = on ? .9 : .35; g.fillRect(Math.round(x) - .5, row < 0 ? base - 18 : ys[row] + ph, 1, row < 0 ? 18 : base - ys[row] - ph);
        if (row < 0) { g.globalAlpha = 1; return; }
        const x0 = Math.min(Math.max(x - pw / 2, 2), w - pw - 2); rows[row] = x0 + pw;
        rr(g, x0 + .5, ys[row] + .5, pw - 1, ph - 1, k.r);
        if (on) { g.globalAlpha = 1; g.fillStyle = k.sig; g.fill(); g.fillStyle = k.ink; }
        else if (p.fav) { g.globalAlpha = .16; g.fill(); g.globalAlpha = .9; }
        else { g.globalAlpha = .4; g.stroke(); g.globalAlpha = .85; }
        g.save(); if (on) { g.globalCompositeOperation = 'destination-out'; } g.textAlign = 'center';
        g.fillText(lab, x0 + pw / 2, ys[row] + ph / 2 + .5, 120); g.restore();
        g.globalAlpha = 1; g.fillStyle = k.ink;
        t.hits.push({ x0, x1: x0 + pw, y0: ys[row], y1: ys[row] + ph, f: p.f });
      });
      // soft edges, so the scale reads as continuing beyond the window
      g.globalCompositeOperation = 'destination-out';
      const fade = Math.min(48, w * .08);
      let gr = g.createLinearGradient(0, 0, fade, 0); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, fade, h);
      gr = g.createLinearGradient(w - fade, 0, w, 0); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)'); g.fillStyle = gr; g.fillRect(w - fade, 0, fade, h);
      g.restore();
      cv.setAttribute('aria-valuetext', RS.fmt(v, RS.curMode()));
    };
    t.drawMap = () => {
      const c = RS.fit(ov); if (!c) return;
      const g = c.g, w = c.w, H = c.h, b = t.band, k = t.cols(), h = b.log ? H : H - 16, v = t.shown();
      const xf = f => b.log ? Math.log(f / b.lo) / Math.log(b.hi / b.lo) * w : (f - b.lo) / (b.hi - b.lo) * w;
      g.clearRect(0, 0, w, H); g.save(); g.fillStyle = k.ink; g.strokeStyle = k.ink;
      g.globalAlpha = .07; rr(g, 0, 0, w, h, Math.min(k.r, 6)); g.fill(); g.globalAlpha = 1;
      if (b.log) {
        g.font = '500 11px ' + k.body; g.textBaseline = 'middle'; g.textAlign = 'left';
        RS.bandplan.forEach((bp, i) => {
          if (bp.b < b.lo || bp.a > b.hi) return; const x0 = xf(Math.max(bp.a, b.lo)), x1 = xf(Math.min(bp.b, b.hi));
          g.globalAlpha = i % 2 ? .1 : .18; g.fillRect(x0, 4, Math.max(2, x1 - x0 - 1), h - 8);
          if (x1 - x0 > 44) { g.globalAlpha = .8; g.fillText(bp.name, x0 + 4, h / 2, x1 - x0 - 6); }
        });
      } else {
        const sw = RS.sweepFor(b.lo, b.hi);
        if (sw) {
          const vals = []; for (let i = 0; i < sw.n; i++) if (sw.u8[i]) vals.push(sw.u8[i] / 2.2 - 110);
          vals.sort((a, z) => a - z); const floor = vals.length ? vals[Math.floor(vals.length * .3)] : -90;
          g.beginPath(); g.moveTo(0, h);
          for (let i = 0; i < sw.n; i++) { const f = sw.start + i * sw.res; if (f < b.lo || f > b.hi) continue; const q = Math.min(Math.max(((sw.u8[i] ? sw.u8[i] / 2.2 - 110 : floor) - floor) / 45, 0), 1); g.lineTo(xf(f), h - 2 - q * (h - 6)); }
          g.lineTo(w, h); g.closePath(); g.globalAlpha = .22; g.fill(); g.globalAlpha = 1;
        } else if (!RS.peaks.some(p => p.f >= b.lo && p.f <= b.hi)) {
          g.globalAlpha = .7; g.font = '12px ' + k.body; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('Find stations to map this band', w / 2, h / 2); g.globalAlpha = 1;
        }
        g.globalAlpha = .6; RS.peaks.forEach(p => { if (p.f >= b.lo && p.f <= b.hi) g.fillRect(Math.round(xf(p.f)) - 1, h * .35, 2, h * .65 - 2); }); g.globalAlpha = 1;
        // scale under the strip
        const span = b.hi - b.lo, major = niceStep(span / Math.max(2, Math.floor(w / 64)));
        g.font = '500 10.5px ' + k.num; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.globalAlpha = .6;
        for (let f = Math.ceil(b.lo / major) * major; f <= b.hi + 1; f += major) { const x = xf(f); g.fillRect(Math.round(x), h, 1, 3); g.fillText(fmtTick(f, major), Math.min(Math.max(x, 14), w - 14), H - 1); }
        g.globalAlpha = 1;
      }
      RS.favs.forEach(p => { if (p.f >= b.lo && p.f <= b.hi) { g.beginPath(); g.arc(xf(p.f), 6, 2.5, 0, 7); g.fill(); } });
      const x0 = xf(Math.max(b.lo, v - t.span / 2)), x1 = xf(Math.min(b.hi, v + t.span / 2));
      g.globalAlpha = .45; g.lineWidth = 1; rr(g, x0 + .5, .5, Math.max(4, x1 - x0) - 1, h - 1, 4); g.stroke(); g.globalAlpha = 1;
      g.fillStyle = k.sig; g.fillRect(Math.round(Math.min(Math.max(xf(v), 1), w - 1)) - 1, 0, 2, h);
      g.restore();
    };
    t.render = now => { t.step$(now); if (t.dirty) { t.dirty = false; t.draw(); t.drawMap(); } };
    ['spec', 'state', 'local', 'sweepdata', 'favourites', 'peaks'].forEach(ev => RS.on(ev, () => { t.dirty = true; }));
    window.addEventListener('resize', () => { t.dirty = true; });
  }

  // ---------------------------------------------------------------- page
  P.init = () => {
    const root = $('#p-radio');
    root.innerHTML = `
    <div class="page-head"><h2>Radio</h2></div>
    <div class="seg rdx-bands" id="rd-bands" role="group" aria-label="Band"></div>
    <div id="rd-cta" class="cta hide rdx-cta"><div class="txt"><b>Nothing found in this band yet.</b> Find stations searches it in a few seconds and writes every station it hears onto the tuner.</div><button class="btn primary" data-act="rd-find">${RS.icon('search')}<span>Find stations</span></button></div>
    <section class="glass rdx-stage" id="rd-stage" aria-label="Now playing">
      <div class="rdx-now">
        <figure class="rdx-cover" id="rd-np"><div class="np-art"><span class="rdx-mono" id="rd-mono" aria-hidden="true"></span><img id="rd-art" class="art-radio" alt="" width="320" height="320" decoding="async"></div>
          <figcaption><b id="rd-np-t"></b><span id="rd-np-a"></span><small id="rd-np-al"></small></figcaption></figure>
        <div class="rd-main rdx-main">
          <h3 class="rdx-name" id="rd-name"></h3>
          <p class="rdx-song" id="rd-song"></p>
          <div class="rdx-meta">
            <div class="rdx-freq" id="rd-freq"></div>
            <span class="rdx-str" id="rd-str" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span class="rdx-strl" id="rd-strl">No signal</span>
            <span class="rdx-tags" id="rd-tags"></span>
            <button class="chip small rd-morse" id="rd-morse" data-act="rd-morse" aria-pressed="false">Morse</button>
          </div>
        </div>
        <div class="rdx-play" role="group" aria-label="Listen and tune">
          <button class="btn rdx-seek" data-act="rd-seek" data-dir="-1" aria-label="Previous station" title="Previous station">${RS.icon('seekl')}</button>
          <button class="btn primary rdx-listen" id="rd-listen" data-act="rd-listen" aria-pressed="false"><span class="rdx-listen-i">${RS.icon('sound')}</span><span class="rdx-listen-l">Listen</span></button>
          <button class="btn rdx-seek" data-act="rd-seek" data-dir="1" aria-label="Next station" title="Next station">${RS.icon('seekr')}</button>
        </div>
      </div>
      <div class="rdx-tuner">
        <button class="btn rdx-nudge" data-act="rd-nudge" data-n="-1" aria-label="Tune down one step" title="Down one step">${RS.icon('left')}</button>
        <canvas class="rdx-ribbon" id="rd-cv"></canvas>
        <button class="btn rdx-nudge" data-act="rd-nudge" data-n="1" aria-label="Tune up one step" title="Up one step">${RS.icon('right')}</button>
      </div>
      <div class="rdx-mapbar">
        <canvas class="rdx-map" id="rd-ov" aria-label="The whole band. Tap or drag to move along it."></canvas>
        <div class="rdx-mapacts"><span class="rdx-zoom adv-only"><button class="btn small" data-act="rd-zoom" data-k="0.5" aria-label="Zoom in" title="Zoom in">${RS.icon('plus')}</button><button class="btn small" data-act="rd-zoom" data-k="2" aria-label="Zoom out" title="Zoom out">${RS.icon('minus')}</button></span>
          <button class="btn small" data-act="rd-find" title="Search this band for stations">${RS.icon('search')}<span>Find stations</span></button></div>
      </div>
      <div class="scan-progress hide" id="rd-prog"><i></i></div>
      <div class="rdx-acts">
        <button class="btn small" id="rd-star" data-act="rd-fav" aria-pressed="false">${RS.icon('star')}<span>Save</span></button>
        <button class="btn small" id="rd-sleep" data-act="rd-sleep" aria-pressed="${!!sleepAt}" title="Fade the sound out after a while">${RS.icon('clock')}<span>${sleepLabel()}</span></button>
        <button class="btn small" data-act="timer-here" title="Record this station at a set time">${RS.icon('rec')}<span>Schedule</span></button>
        <span class="rdx-help adv-only">Drag or flick the scale &middot; wheel steps &middot; <span class="kbd">Ctrl</span>+wheel zooms &middot; <span class="kbd">&larr;</span><span class="kbd">&rarr;</span> step, <span class="kbd">Shift</span> for 10</span>
      </div>
    </section>

    <section class="rdp-presets kx-static" aria-label="Your stations">
      <div class="rdp-h"><h3>Your stations</h3><span class="sub" id="rd-fav-n"></span></div>
      <div class="rdp-strip" id="rd-favs"></div>
    </section>

    <div class="rdp-grid">
      <section class="card kx-static rdp-lists">
        <div class="seg rdp-tabs" role="tablist" aria-label="Lists">
          <button type="button" role="tab" data-rd-tab="here">Stations here</button>
          <button type="button" role="tab" data-rd-tab="recent">Recently played</button>
          <button type="button" role="tab" data-rd-tab="songs">Songs heard</button>
        </div>
        <div class="sub rdp-tab-sub" id="rd-tab-sub"></div>
        <div class="rdp-list" id="rd-list" role="tabpanel"></div>
      </section>
      <div class="rdp-side">
        <section class="card kx-static rdp-info"><h3>About this station</h3><div class="sub" id="rd-info-sub"></div><dl class="sen-meta rdp-kv" id="rd-info"></dl><div id="rd-af"></div></section>
        <section class="card kx-static rdp-tune"><h3>Sound and tuning</h3>
          <label class="check"><input type="checkbox" id="rd-sqon"><span>Quiet between stations ${RS.hint('Radios hiss when nothing is being sent. This switches the sound off until a real signal arrives. Good for two-way radio and aircraft; for music stations leave it off.', 'sq')}</span></label>
          <label class="field rdp-sq">How strong a signal must be before you hear it <input type="range" id="rd-sq" min="2" max="30" step="1" value="8"></label>
          <div class="adv-only rdp-adv">
            <label class="field">Radio type <span class="hint">Auto picks the right type for the frequency.</span><div class="seg" id="rd-modes" role="group"></div></label>
            <label class="check"><input type="checkbox" id="rd-auto"><span>Pick the radio type automatically</span></label>
            <label class="field">Filter width <span class="hint" id="rd-bw-l"></span><input type="range" id="rd-bw" min="2000" max="200000" step="500"></label>
            <label class="field">Tuning step<select id="rd-step"><option value="">Automatic</option><option value="1000">1 kHz</option><option value="5000">5 kHz</option><option value="9000">9 kHz (AM radio)</option><option value="12500">12.5 kHz</option><option value="25000">25 kHz</option><option value="50000">50 kHz</option><option value="100000">100 kHz (FM radio)</option><option value="1000000">1 MHz</option></select></label>
            <label class="field">Search sensitivity <span class="hint">How far above the background noise a signal must stand to count as a station.</span><input type="range" id="rd-thr" min="5" max="20" step="1"></label>
          </div>
        </section>
      </div>
    </div>

    <details class="card more kx-static" id="rd-scope-wrap"><summary>Signal picture (spectrum and waterfall) ${RS.hint('A live picture of the radio waves around the tuned frequency. Bright vertical streaks in the waterfall are signals. Tap the picture to tune.', 'sc')}</summary>
      <div class="glass scope"><canvas class="spec" id="rd-spec"></canvas><canvas class="water" id="rd-water"></canvas><div class="scope-bar"><span id="rd-scope-info">Waiting for the radio...</span><button class="btn small" data-act="rd-pause"><span>Pause</span></button></div></div></details>`;
    tuner = new Tuner($('#rd-cv'), $('#rd-ov'));
    P.dial = tuner;
    scope = new RS.Scope($('#rd-spec'), $('#rd-water'), $('#rd-scope-info'));
    RS.on('spec', L => { if (RS.page === 'radio') scope.frame(L); });
    $('#rd-scope-wrap').open = RS.store.get('rd_scope', !!RS.adv);
    $('#rd-scope-wrap').addEventListener('toggle', e => RS.store.set('rd_scope', e.target.open));
    const bandChips = () => { walkieBand(); $('#rd-bands').innerHTML = RS.BANDS.map(b => '<button type="button" data-act="rd-band" data-id="' + b.id + '" aria-pressed="false">' + b.name + '</button>').join(''); if (tuner.band.id === 'cb' && !RS.BANDS.includes(tuner.band)) tuner.band = RS.BANDS[0]; };
    bandChips(); RS.on('region', bandChips); RS.on('hello', bandChips);
    $('#rd-modes').innerHTML = Object.keys(RS.MODES).map(k => '<button data-act="rd-mode" data-m="' + k + '" class="' + (RS.MODES[k].adv ? 'adv-only' : '') + '" aria-pressed="false" title="' + RS.MODES[k].long + '"><span class="m-e">' + RS.MODES[k].name + '</span><span class="m-a">' + RS.TECH[k] + '</span></button>').join('');
    RS.$$('[data-rd-tab]').forEach(b => b.onclick = () => { P.tab = b.dataset.rdTab; RS.store.set('rd_tab', P.tab); P.lists(true); });
    RS.editFreq($('#rd-freq'), RS.goFreq);
    $('#rd-auto').checked = RS.autoMode;
    $('#rd-auto').onchange = e => { RS.autoMode = e.target.checked; RS.store.set('automode', RS.autoMode); };
    $('#rd-bw').onchange = e => RS.setMode(RS.curMode(), parseFloat(e.target.value));
    $('#rd-bw').oninput = e => { RS.setText($('#rd-bw-l'), (e.target.value / 1000).toFixed(1) + ' kHz'); };
    $('#rd-step').onchange = e => { tuner.step = e.target.value ? parseFloat(e.target.value) : null; };
    RS.scale($('#rd-thr'), { unit: 'dB', ticks: [5, 10, 15, 20], zones: [[5, 'Sensitive', 'finds faint stations, some may be false'], [9, 'Balanced', 'a good everyday setting'], [14, 'Strict', 'only clear stations; fewer false finds']] });
    RS.scale($('#rd-sq'), { unit: 'dB', ticks: [2, 10, 20, 30], zones: [[2, 'Open', 'opens on faint signals, some hiss'], [8, 'Typical', 'good for most two-way radio'], [15, 'Firm', 'only clearly strong signals'], [23, 'Strongest', 'only very strong, close signals']] });
    $('#rd-thr').value = RS.store.get('thr', 10); $('#rd-thr')._scaleUpd(); $('#rd-thr').onchange = e => RS.store.set('thr', parseFloat(e.target.value));
    const setSq = () => { const on = $('#rd-sqon').checked; $('#rd-sq').closest('.rdp-sq').classList.toggle('off', !on); RS.send({ cmd: 'squelch', db: on ? parseFloat($('#rd-sq').value) : 0 }); RS.store.set('sq', on ? parseFloat($('#rd-sq').value) : 0); };
    $('#rd-sqon').onchange = setSq; $('#rd-sq').onchange = setSq;
    RS.on('hello', () => { const q = RS.store.get('sq', 0); if (q && RS.st.squelch !== q) RS.send({ cmd: 'squelch', db: q }); $('#rd-sqon').checked = q > 0; $('#rd-sq').closest('.rdp-sq').classList.toggle('off', !(q > 0)); if (q > 0) { $('#rd-sq').value = q; $('#rd-sq')._scaleUpd(); } });
    RS.on('peaks', () => P.stations());
    RS.on('favourites', () => { P.stations(); P.state(); });
    RS.on('sweepdata', e => { P.progress(e); P.stations(); });
    RS.on('art', () => { songHeard(); P.state(); });
    RS.on('audio', listenUi);
    setInterval(recentTick, 5000);
    setInterval(() => { if (RS.page === 'radio') { sleepUi(); if (P.tab !== 'here') P.lists(); } }, 15000);
    let lastR = 0;      // phones draw the tuner about 30 times a second while it moves: smooth, and it leaves the processor free for the sound
    const loop = now => { if (RS.page === 'radio' && (!RS.isTouch || tuner.drag || tuner.glide || now - lastR > 66)) { lastR = now; tuner.render(now); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    listenUi();
  };
  P.enter = () => { tuner.sync(); tuner.dirty = true; P.state(); P.stations(); listenUi(); };
  P.leave = () => { if (tuner) tuner.glide = null; };
  P.progress = e => {
    const p = $('#rd-prog'); if (!p) return;
    const on = RS.st.job === 'sweep' && !e.done;
    p.classList.toggle('hide', !on); p.firstChild.style.width = Math.round((e.hop / Math.max(e.hops, 1)) * 100) + '%';
  };
  function morseUi() {
    const b = $('#rd-morse'); if (!b) return;
    const m = (RS.st && RS.st.morse) || {}, narrow = RS.curMode && RS.curMode() !== 'wfm';
    b.classList.toggle('hide', !narrow && !m.forced);
    b.setAttribute('aria-pressed', m.forced ? 'true' : 'false');
    RS.setText(b, m.on ? 'Morse: listening' : 'Morse');
    b.title = m.on ? (m.forced ? 'Listening for Morse on this channel (you turned it on). Press to stop.' : 'Listening for Morse automatically here. Decoded text appears in the caption strip.')
      : 'Turn any Morse code on this channel into text. It appears in the caption strip.';
  }
  RS.on('state', morseUi); RS.on('local', morseUi);
  RS.act['rd-morse'] = () => { const m = (RS.st && RS.st.morse) || {}; RS.send({ cmd: 'morse', on: !m.forced }); if (!m.forced) RS.toast('Listening for Morse here. Text appears in the caption strip at the bottom as it is decoded.'); };

  // ---------------------------------------------------------------- listen
  function listenUi() {
    const b = $('#rd-listen'); if (!b || !RS.audio) return;
    const on = !!RS.audio.on;
    if (b.getAttribute('aria-pressed') !== String(on)) {
      b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on);
      const slot = b.querySelector('.rdx-listen-i'), svg = RS.icon(on ? 'stop' : 'sound');
      if (RS.feel && slot.firstElementChild) RS.feel.icon(slot, svg); else slot.innerHTML = svg;
    }
    RS.setText(b.querySelector('.rdx-listen-l'), on ? 'Stop' : 'Listen');
  }
  RS.act['rd-listen'] = () => { if (RS.audio.on) RS.audio.stop(); else RS.audio.start(); setTimeout(listenUi, 50); };

  // ---------------------------------------------------------------- the stage
  const stationName = (f, m) => {
    const st = RS.st, rd = (m === 'wfm' && st.rds && st.rds.ps && Math.abs((st.vfo || 0) - f) < 50e3) ? st.rds : null;
    return (rd && rd.ps ? rd.ps.trim() : '') || RS.nameFor(f) || '';
  };
  P.state = () => {
    if (RS.page !== 'radio' || !tuner) return;
    tuner.sync();
    const f = RS.vfo(), m = RS.curMode(), st = RS.st, parts = RS.freqParts(f, m);
    { const fe = $('#rd-freq'), fh = RS.fmtHtml(parts); if (!fe.classList.contains('editing') && fe._h !== fh) { fe._h = fh; fe.innerHTML = fh; } }
    const rd = (m === 'wfm' && st.rds && (st.rds.ps || st.rds.pty)) ? st.rds : null, nm = stationName(f, m);
    const found = RS.peaks.some(p => Math.abs(p.f - f) < 60e3);
    RS.setText($('#rd-name'), nm || (found ? 'Station at ' + parts.n : RS.bandName(f) || RS.fmt(f, m)));
    const c = RS.art && RS.art.cur;
    const song = c && c.title ? c.title + (c.artist ? ' — ' + c.artist : '') : rd && rd.rt ? rd.rt : rd && rd.pty_name && rd.pty ? rd.pty_name : RS.MODES[m] ? RS.MODES[m].long : '';
    RS.setText($('#rd-song'), song + (st.job === 'sweep' ? ' · searching...' : ''));
    RS.setText($('#rd-mono'), parts.n);
    const live = RS.live, snr = (RS.st.job === 'listen' && live && performance.now() - live.t < 1500) ? live.snr : (st.snr || 0), n = RS.bars(snr);
    RS.$$('#rd-str i').forEach((el, i) => el.classList.toggle('on', i < n));
    RS.setText($('#rd-strl'), n === 0 ? 'No signal' : n < 2 ? 'Weak' : n < 4 ? 'Good' : 'Strong');
    const tags = [m === 'wfm' && st.stereo ? 'Stereo' : '', rd && rd.ta ? 'Traffic news on air' : ''].filter(Boolean).map(x => '<span>' + esc(x) + '</span>').join('');
    const te = $('#rd-tags'); if (te._h !== tags) { te._h = tags; te.innerHTML = tags; }
    RS.$$('#rd-bands button').forEach(c => { const v = String(c.dataset.id === tuner.band.id); if (c.getAttribute('aria-pressed') !== v) { c.setAttribute('aria-pressed', v); if (v === 'true') { const r = c.parentNode; if (r.scrollWidth > r.clientWidth) r.scrollTo({ left: c.offsetLeft - 14, behavior: reduce() ? 'auto' : 'smooth' }); } } });
    RS.$$('#rd-modes button').forEach(c => { const v = String(c.dataset.m === m); if (c.getAttribute('aria-pressed') !== v) c.setAttribute('aria-pressed', v); });
    const fav = RS.isFav(f), sb = $('#rd-star');
    if (sb.getAttribute('aria-pressed') !== String(fav)) { sb.setAttribute('aria-pressed', fav); sb.classList.toggle('on', fav); RS.setText(sb.querySelector(':scope > span:not([aria-hidden])'), fav ? 'Saved' : 'Save'); }
    const bwEl = $('#rd-bw'); if (document.activeElement !== bwEl) { bwEl.value = st.bw || 12000; RS.setText($('#rd-bw-l'), ((st.bw || 12000) / 1000).toFixed(1) + ' kHz'); }
    const inBand = RS.peaks.filter(p => p.f >= tuner.band.lo && p.f <= tuner.band.hi).length;
    $('#rd-cta').classList.toggle('hide', inBand > 0 || st.job === 'sweep' || tuner.band.id === 'all' || !RS.connected);
    tuner.dirty = true;
    details(f, m, snr);
  };

  // ---------------------------------------------------------------- about this station
  let lastInfo = '';
  function details(f, m, snr) {
    const el = $('#rd-info'); if (!el) return;
    const st = RS.st, rd = m === 'wfm' && st.rds && (st.rds.ps || st.rds.pty != null) ? st.rds : null, rows = [];
    const id = RS.identify ? RS.identify(f, st.sig) : null;
    rows.push(['Frequency', RS.fmt(f, m)]);
    const nm = stationName(f, m); if (nm) rows.push(['Station', nm]);
    if (rd && rd.pty_name && rd.pty) rows.push(['Programme', rd.pty_name]);
    if (rd && rd.ms) rows.push(['On air now', rd.ms === 'music' ? 'Music' : 'Talk']);
    if (rd && rd.tp) rows.push(['Traffic news', rd.ta ? 'On air now' : 'Carries traffic reports']);
    rows.push(['Sound', m === 'wfm' ? (st.stereo ? 'FM stereo' : 'FM mono') : (RS.MODES[m] ? RS.MODES[m].long : m)]);
    rows.push(['Signal', snr > 0 ? Math.round(snr) + ' dB above the noise' : 'No signal']);
    if (id && id.name && !nm) rows.push(['Probably', id.name]);
    if (rd && rd.pi_hex) rows.push(['Station code (RDS)', rd.pi_hex, 'adv']);
    const h = rows.map(r => '<div' + (r[2] ? ' class="adv-only"' : '') + '><dt>' + r[0] + '</dt><dd>' + esc(r[1]) + '</dd></div>').join('');
    if (h !== lastInfo) { lastInfo = h; el.innerHTML = h; }
    RS.setText($('#rd-info-sub'), rd ? 'From the station\'s RDS data' : m === 'wfm' ? 'No RDS data from this station yet' : 'What the radio can tell');
    const af = (rd && rd.af || []).filter(x => Math.abs(x - f) > 50e3);
    const ah = af.length ? '<div class="rdp-af"><span>Also on</span>' + af.map(x => '<button class="chip small" type="button" data-act="rd-pick" data-f="' + x + '" data-mode="wfm" title="The same programme from another transmitter. Try it if the signal here is weak.">' + (x / 1e6).toFixed(1) + '</button>').join('') + '<small>Same programme from other transmitters. Try one if this signal is weak.</small></div>' : '';
    const ae = $('#rd-af'); if (ae._h !== ah) { ae._h = ah; ae.innerHTML = ah; }
  }

  // ---------------------------------------------------------------- presets, and the lists
  P.stations = () => { presets(); P.lists(); };
  function presets() {
    const fw = $('#rd-favs'); if (!fw) return;
    const cur = RS.vfo();
    RS.setText($('#rd-fav-n'), RS.favs.length ? String(RS.favs.length) : '');
    const h = RS.favs.map(x => '<div class="rdp-preset' + (Math.abs(x.f - cur) < 5e3 ? ' on' : '') + '" data-k="' + x.f + '"><button type="button" class="rdp-preset-b" data-act="rd-pick" data-f="' + x.f + '" data-mode="' + esc(x.mode) + '" aria-current="' + (Math.abs(x.f - cur) < 5e3) + '">' +
      '<b>' + esc(RS.fmt(x.f, x.mode).replace(/ (MHz|kHz)$/, '')) + '<small>' + (x.f >= 1e6 ? 'MHz' : 'kHz') + '</small></b><span>' + esc(x.name || RS.bandName(x.f) || '') + '</span></button>' +
      '<button type="button" class="rdp-x" data-act="rd-unfav" data-f="' + x.f + '" aria-label="Remove ' + esc(x.name || RS.fmt(x.f)) + ' from your stations" title="Remove">' + RS.icon('minus') + '</button></div>').join('') +
      (RS.isFav(cur) ? '' : '<button type="button" class="rdp-preset rdp-add" data-k="add" data-act="rd-fav">' + RS.icon('plus') + '<span>Save ' + esc(stationName(cur, RS.curMode()) || RS.fmt(cur, RS.curMode())) + '</span></button>');
    if (fw._h === h) return;
    const first = fw._h == null; fw._h = h;
    if (first || !RS.feel) fw.innerHTML = h; else RS.feel.flip(fw, c => c.dataset.k, () => { fw.innerHTML = h; });
    // just saved: the station flies from the Save button to its new place in the strip
    if (P._fly && Date.now() - P._fly.t < 4000) {
      const near = RS.favs.reduce((a, x) => !a || Math.abs(x.f - P._fly.f) < Math.abs(a.f - P._fly.f) ? x : a, null);
      const to = near && Math.abs(near.f - P._fly.f) < 5e3 ? fw.querySelector('.rdp-preset[data-k="' + near.f + '"]') : null, from = P._fly.el; P._fly = null;
      if (to && RS.feel) { to.scrollIntoView({ block: 'nearest', inline: 'nearest' }); to.style.visibility = 'hidden'; RS.feel.arc(from, to, { label: P._flyL, done: () => { to.style.visibility = ''; } }); }
    }
  }
  function row(f, mode, title, sub, right, extra) {
    const cur = Math.abs(f - RS.vfo()) < 5e3;
    return '<button type="button" class="rdp-row' + (cur ? ' on' : '') + '" data-act="rd-pick" data-f="' + f + '" data-mode="' + esc(mode || '') + '"' + (cur ? ' aria-current="true"' : '') + '>' + (extra || '') +
      '<span class="rdp-row-t"><b>' + esc(title) + '</b><small>' + esc(sub) + '</small></span><span class="rdp-row-r">' + right + '</span></button>';
  }
  const ago = t => { const s = Date.now() / 1000 - t; return s < 90 ? 'Just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(t * 1000).toLocaleDateString([], { day: 'numeric', month: 'short' }); };
  P.lists = force => {
    const el = $('#rd-list'); if (!el || !tuner) return;
    RS.$$('[data-rd-tab]').forEach(b => { const v = String(b.dataset.rdTab === P.tab); if (b.getAttribute('aria-selected') !== v) { b.setAttribute('aria-selected', v); b.setAttribute('aria-pressed', v); } });
    let h = '', sub = '';
    if (P.tab === 'recent') {
      const L = RS.store.get(RECENT, []);
      sub = 'Stations you listened to for a while';
      h = L.length ? L.map(x => row(x.f, x.mode, x.name || RS.fmt(x.f, x.mode), (x.name ? RS.fmt(x.f, x.mode) + ' · ' : '') + (RS.bandName(x.f) || ''), '<small>' + ago(x.t) + '</small>')).join('')
        : '<div class="sen-empty"><b>Nothing yet</b><span>Stations you listen to for half a minute or more show up here.</span></div>';
    } else if (P.tab === 'songs') {
      const L = RS.store.get(SONGS, []);
      sub = 'Songs the stations named, newest first';
      h = L.length ? L.map((x, i) => '<div class="rdp-song">' + (x.url ? '<img src="' + esc(x.url) + '" alt="" width="44" height="44" loading="lazy">' : '<i class="rdp-song-ph" aria-hidden="true"></i>') +
        '<span class="rdp-row-t"><b>' + esc(x.title) + '</b><small>' + esc(x.artist) + (x.station ? ' · ' + esc(x.station) : '') + ' · ' + ago(x.t) + '</small></span>' +
        (x.track || (x.artist && x.title) ? '<button class="btn small ghost" type="button" data-act="rd-song" data-i="' + i + '">Open in</button>' : '') + '</div>').join('') +
        '<div class="rdp-foot"><button class="btn small ghost" type="button" data-act="rd-songs-clear">Clear the list</button></div>'
        : '<div class="sen-empty"><b>No songs yet</b><span>When an FM station sends the song title, it is kept here with its cover, so you can find it later.</span></div>';
    } else {
      const b = tuner.band;
      let list = RS.peaks.filter(p => p.f >= b.lo && p.f <= b.hi);
      if (b.id === 'all') list = RS.peaks.slice().sort((a, z) => z.db - a.db).slice(0, 40).sort((a, z) => a.f - z.f);
      sub = b.id === 'all' ? 'Strongest signals found so far, in any band' : 'Found when the ' + b.name + ' band was last searched';
      h = list.length ? list.map(p => row(p.f, p.mode, RS.nameFor(p.f) || RS.fmt(p.f, p.mode), RS.nameFor(p.f) ? RS.fmt(p.f, p.mode) : (p.band || 'Signal'),
        '<span class="rdp-bars" title="Signal ' + Math.round(p.db || 0) + ' dB">' + [1, 2, 3, 4].map(k => '<i' + (RS.bars(p.db || 0) >= k ? ' class="on"' : '') + '></i>').join('') + '</span>' + (RS.isFav(p.f) ? RS.icon('star') : ''))).join('')
        : '<div class="sen-empty"><b>Nothing found in this band yet</b><span>Press <b>Find stations</b> to search it. It takes a few seconds, and you can search again whenever you move the antenna.</span></div>';
    }
    RS.setText($('#rd-tab-sub'), sub);
    if (el._h !== h || force) {
      el._h = h;
      if (force && RS.feel) RS.feel.swap(el, h, { rows: '.rdp-row, .rdp-song, .sen-empty' }); else el.innerHTML = h;
    }
    if (RS.feel) RS.feel.mark(el, el.querySelector('.rdp-row.on'));
  };
  RS.act['rd-song'] = b => { const s = RS.store.get(SONGS, [])[+b.dataset.i]; if (s && RS.art && RS.art.openIn) RS.art.openIn(s); };
  RS.act['rd-songs-clear'] = () => RS.confirm('Clear the song list?', 'The songs heard so far are forgotten on this device.', 'Clear', () => { RS.store.set(SONGS, []); P.lists(true); });

  // song history: each new song the cover lookup recognises (one entry per song per station; most recent first)
  function songHeard() {
    const c = RS.art && RS.art.cur; if (!c || !c.title) return;
    const L = RS.store.get(SONGS, []), f = RS.vfo(), station = stationName(f, 'wfm') || RS.fmt(f, 'wfm');
    if (L[0] && L[0].title === c.title && L[0].artist === c.artist) return;
    const keep = L.filter(x => !(x.title === c.title && x.artist === c.artist && Date.now() / 1000 - x.t < 3600));
    keep.unshift({ t: Math.round(Date.now() / 1000), title: c.title, artist: c.artist, album: c.album || '', url: c.url || '', track: c.track || null, station, f });
    RS.store.set(SONGS, keep.slice(0, 60));
    if (RS.page === 'radio' && P.tab === 'songs') P.lists(true);
  }
  // recently played: a station you stayed on for 30 seconds with the sound on
  let stay = { f: 0, since: 0 };
  function recentTick() {
    if (!RS.audio || !RS.audio.on || RS.st.job !== 'listen' || RS.st.scan) { stay.f = 0; return; }
    const f = RS.vfo(), m = RS.curMode();
    if (Math.abs(f - stay.f) > 5e3) { stay = { f, since: Date.now() }; return; }
    if (Date.now() - stay.since < 30000) return;
    const L = RS.store.get(RECENT, []), name = stationName(f, m);
    if (L[0] && Math.abs(L[0].f - f) < 5e3) { if (name && L[0].name !== name) { L[0].name = name; RS.store.set(RECENT, L); } L[0].t = Math.round(Date.now() / 1000); RS.store.set(RECENT, L); return; }
    const keep = L.filter(x => Math.abs(x.f - f) >= 5e3);
    keep.unshift({ f, mode: m, name, t: Math.round(Date.now() / 1000) });
    RS.store.set(RECENT, keep.slice(0, 20));
    if (RS.page === 'radio' && P.tab === 'recent') P.lists(true);
  }

  // ---------------------------------------------------------------- sleep timer
  let sleepAt = 0, sleepT = null;
  // the label comes from one place, so a rebuilt button still shows the time left
  function sleepLabel() { return sleepAt ? 'Sleep ' + Math.max(0, Math.ceil((sleepAt - Date.now()) / 60000)) + ' min' : 'Sleep'; }
  function sleepUi() {
    const b = $('#rd-sleep'); if (!b) return;
    RS.setText(b.querySelector(':scope > span:not([aria-hidden])'), sleepLabel());
    b.classList.toggle('on', !!sleepAt); b.setAttribute('aria-pressed', String(!!sleepAt));
  }
  function setSleep(min) {
    clearTimeout(sleepT); sleepAt = 0;
    if (min > 0) {
      sleepAt = Date.now() + min * 60000;
      sleepT = setTimeout(() => {           // fade out over 20 seconds, then stop
        const v0 = RS.audio.vol, t0 = Date.now();
        const step = () => { const k = Math.min(1, (Date.now() - t0) / 20000); if (RS.audio.setVol) RS.audio.setVol(v0 * (1 - k)); if (k < 1 && sleepAt) setTimeout(step, 250); else { if (sleepAt) RS.audio.stop(); if (RS.audio.setVol) RS.audio.setVol(v0); sleepAt = 0; sleepUi(); } };
        step();
      }, Math.max(0, min * 60000 - 20000));
      if (!RS.audio.on) RS.audio.start();
      RS.toast('The sound will fade out and stop in ' + min + ' minutes.');
    } else RS.toast('Sleep timer off.');
    sleepUi();
  }
  RS.act['rd-sleep'] = () => {
    const opts = [15, 30, 45, 60, 90, 120];
    RS.modal('<h3>Sleep timer</h3><p class="sub" style="margin:0 0 12px">The sound fades out and stops after this long.' + (sleepAt ? ' It stops in about ' + Math.ceil((sleepAt - Date.now()) / 60000) + ' minutes now.' : '') + '</p>' +
      '<div class="locp-res">' + opts.map(m => '<button class="locp-row" type="button" data-act="rd-sleep-set" data-m="' + m + '"><span class="locp-t"><b>' + (m < 60 ? m + ' minutes' : m === 60 ? '1 hour' : (m / 60) + ' hours') + '</b></span></button>').join('') +
      (sleepAt ? '<button class="locp-row" type="button" data-act="rd-sleep-set" data-m="0"><span class="locp-t"><b>Turn the timer off</b></span></button>' : '') + '</div>');
  };
  RS.act['rd-sleep-set'] = b => { RS.closeModal(); setSleep(+b.dataset.m); if (RS.feel && +b.dataset.m) setTimeout(() => RS.feel.pulse($('#rd-sleep')), 220); };

  RS.on('local', () => { if (RS.page === 'radio') { P.state(); } });
  RS.on('state', () => { if (RS.page === 'radio') { presets(); if (P.tab === 'here') P.lists(); } });

  RS.act['rd-band'] = b => tuner.setBand(b.dataset.id);
  RS.act['rd-nudge'] = b => tuner.nudge(parseInt(b.dataset.n));
  RS.act['rd-zoom'] = b => tuner.zoom(parseFloat(b.dataset.k));
  RS.act['rd-seek'] = b => { RS.send({ cmd: 'seek', dir: parseInt(b.dataset.dir) }); RS.toast('Searching for the next station...'); };
  RS.act['rd-pick'] = b => { RS.tune(parseFloat(b.dataset.f), b.dataset.mode ? { mode: b.dataset.mode } : {}); };
  RS.act['rd-fav'] = b => {
    const f = RS.vfo(), m = RS.curMode(), nm = stationName(f, m);
    if (!RS.isFav(f)) { P._fly = { f, el: b && b.isConnected ? b : $('#rd-star'), t: Date.now() }; P._flyL = nm || RS.fmt(f, m); }
    RS.toggleFav(f, m, nm || undefined);
  };
  RS.act['rd-unfav'] = b => RS.toggleFav(parseFloat(b.dataset.f));
  RS.act['rd-mode'] = b => { RS.autoMode = false; RS.store.set('automode', false); $('#rd-auto').checked = false; RS.setMode(b.dataset.m); };
  RS.act['rd-pause'] = b => { scope.paused = !scope.paused; RS.setText(b.querySelector(':scope > span:not([aria-hidden])') || b, scope.paused ? 'Resume' : 'Pause'); };
  RS.act['rd-find'] = () => {
    const b = tuner.band;
    if (b.id === 'all') { const v = RS.vfo(); RS.findStations(Math.max(v - 5e6, 0.5e6), v + 5e6, RS.curMode(), 'signals near ' + RS.fmt(v)); }
    else RS.findStations(b.lo, b.hi, b.mode, b.name + ' stations');
  };
  // Click the big frequency to type an exact one: "100.3", "7074 k", "1.09 g". Enter tunes, Escape cancels.
  RS.editFreq = (el, apply) => {
    el.classList.add('editable'); el.tabIndex = 0; el.setAttribute('role', 'button'); el.title = 'Click to type a frequency';
    el.setAttribute('aria-label', 'Frequency. Press Enter to type a new one.');
    const start = () => {
      if (el.classList.contains('editing')) return;
      const cur = RS.vfo(), unit = cur < 2e6 ? 'k' : 'm';
      el.classList.add('editing');
      el.innerHTML = '<input class="freq-edit" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="Type a frequency, then press Enter" value="' + (unit === 'k' ? (cur / 1e3).toFixed(1).replace(/\.0$/, '') : (cur / 1e6).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')) + '"><small>' + (unit === 'k' ? 'kHz' : 'MHz') + '</small>';
      const inp = el.querySelector('input'); inp.focus(); inp.select();
      let done = false;
      const end = ok => {
        if (done) return; done = true;
        const txt = inp.value; el.classList.remove('editing'); el.innerHTML = RS.fmtHtml(RS.freqParts(RS.vfo(), RS.curMode()));
        if (!ok || !txt.trim()) return;
        const f = parseFreq(txt, unit);
        if (!f || f < 0.1e6 || f > 1.75e9) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); setTimeout(() => el.classList.remove('shake'), 400); RS.toast('That is not a frequency the radio can reach (about 0.5 MHz to 1.7 GHz). Try something like 100.0 or 7074 k.', 'bad'); return; }
        apply(f);
      };
      inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); end(true); } else if (e.key === 'Escape') { e.preventDefault(); end(false); } });
      inp.addEventListener('blur', () => end(true));
      inp.addEventListener('click', e => e.stopPropagation());
    };
    el.addEventListener('click', start);
    el.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); start(); } });
  };
  RS.goFreq = f => {
    if (tuner && tuner.band.id !== 'all' && (f < tuner.band.lo || f > tuner.band.hi)) { const nb = RS.BANDS.find(x => x.id !== 'all' && f >= x.lo && f <= x.hi) || RS.BANDS[RS.BANDS.length - 1]; tuner.setBand(nb.id, false); }
    RS.tune(f, { recenter: true });
    RS.toast('Tuned to ' + RS.fmt(f) + '.');
  };
})();
