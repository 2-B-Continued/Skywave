/* Skywave: a different tuning dial, station strip and spectrum for every style.
   radio.js does the maths (frequency <-> pixel stays linear, so dragging, wheel, keys and taps behave the
   same everywhere) and hands the numbers here to be drawn. Styles without an entry here keep the original drawing in radio.js. */
(function () {
  'use strict';
  const RS = window.RS, TAU = Math.PI * 2;
  const DS = RS.DS = {};
  const rgba = (hex, a) => { const m = /^#?([0-9a-f]{6})/i.exec(hex || ''); if (!m) return hex; const n = parseInt(m[1], 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; };
  const lum = hex => { const m = /^#?([0-9a-f]{6})/i.exec(hex || ''); if (!m) return 0; const n = parseInt(m[1], 16); return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };
  RS.sk = () => document.documentElement.dataset.style || 'skywave';
  RS.dsCols = () => {
    const v = n => RS.cssv(n);
    const glass = v('--glass') || '#101820', ink = v('--glass-ink') || '#c8d4d8', sig = v('--amber') || '#ffb52e', acc = v('--teal') || '#6fd0dc';
    return { glass: glass, ink: ink, sig: sig, acc: acc, hot: v('--hot-c') || sig, dark: lum(glass) < 0.5, paper: v('--panel') || '#fff', text: v('--ink') || '#111' };
  };
  const label = (f, major) => {
    if (f < 2e6) return (f / 1e3).toFixed(major < 1e3 ? 1 : 0);
    const dec = major >= 1e6 ? 0 : major >= 1e5 ? 1 : major >= 1e4 ? 2 : major >= 1e3 ? 3 : 4; return (f / 1e6).toFixed(dec);
  };
  const stLabel = f => (f >= 1e6 ? (f / 1e6).toFixed(f % 1e5 === 0 ? 1 : 3) : (f / 1e3).toFixed(0));
  const ticks = (c, fn) => { for (let f = Math.ceil(c.lo / c.major) * c.major; f <= c.hi; f += c.major) fn(f, (f - c.lo) * c.pxHz); };
  const minors = (c, x, fn) => { for (let k = 1; k < c.minorN; k++) fn(x + k * c.major / c.minorN * c.pxHz, k); };

  /* ------------------------------------------------------------------ BENTO: solid blocks, a chunky knob, bar-graph meters */
  DS.bento = {
    dial(c) {
      const g = c.g, w = c.w, h = c.h, k = c.col, mid = w / 2, trackY = h - 34, S = 8;
      // a bar-graph of the live signal, one block per column, stacked squares
      if (c.live) {
        c.liveCols(S, (x, t) => { const n = Math.round(t * 6); for (let i = 0; i < n; i++) { g.fillStyle = rgba(k.sig, .25 + i * .1); g.fillRect(x, trackY - 12 - (i + 1) * 9, S - 1, 7); } });
      }
      // chunky ruler: alternating solid blocks, thick major notches
      ticks(c, (f, x) => {
        g.fillStyle = k.ink; g.fillRect(x - 2, trackY - 2, 4, 22);
        g.font = '700 12px "JetBrains Mono", monospace'; g.textAlign = 'left'; g.fillStyle = k.ink; g.fillText(label(f, c.major), x + 6, trackY + 28 > h - 4 ? h - 6 : trackY + 28);
        minors(c, x, (xm, i) => { g.fillStyle = rgba(k.ink, i % 2 ? .35 : .6); g.fillRect(xm - 1.5, trackY + (i % 2 ? 8 : 4), 3, i % 2 ? 8 : 12); });
      });
      // stations as stacks of squares
      let last = -99;
      c.mk.forEach(p => {
        const x = (p.f - c.lo) * c.pxHz, n = 1 + Math.round(Math.min(p.db, 40) / 40 * 4), col = p.kind === 'fav' ? k.sig : k.acc;
        for (let i = 0; i < n; i++) { g.fillStyle = col; g.fillRect(x - 5, trackY - 8 - (i + 1) * 11, 10, 9); }
        if (p.kind === 'fav') { g.fillStyle = k.glass; g.fillRect(x - 2, trackY - 8 - 11 + 3, 4, 4); }
        if (x - last > 56 && x > 20 && x < w - 20) { last = x; g.fillStyle = k.ink; g.font = '700 11px "JetBrains Mono", monospace'; g.textAlign = 'center'; g.fillText(stLabel(p.f), x, 11); }
      });
      // the knob: a solid square handle with a notch, sat on the track
      const bw = Math.max(S, c.bw);
      g.fillStyle = rgba(k.sig, .22); g.fillRect(mid - bw / 2, trackY - 4, bw, 28);
      g.fillStyle = k.sig; g.fillRect(mid - 11, 4, 22, h - 8);
      g.fillStyle = k.glass; g.fillRect(mid - 1.5, 10, 3, h - 20); g.fillRect(mid - 6, 10, 2, 8); g.fillRect(mid + 4, 10, 2, 8);
    },
    ov(c) {
      const g = c.g, w = c.w, h = c.h, k = c.col, S = 6;
      if (c.plan.length) c.plan.forEach((p, i) => { g.fillStyle = i % 2 ? rgba(k.acc, .5) : rgba(k.acc, .85); g.fillRect(p.x0, 8, Math.max(3, p.x1 - p.x0 - 2), h - 16); });
      else if (c.series) { for (let x = 0; x < w; x += S) { const s = c.series[Math.min(c.series.length - 1, Math.floor(x / w * c.series.length))]; const n = Math.round((s ? s.t : 0) * 4); for (let i = 0; i < n; i++) { g.fillStyle = k.acc; g.fillRect(x, h - 5 - (i + 1) * 7, S - 2, 5); } } }
      else c.hintText(g, k.ink);
      c.peaks.forEach(x => { g.fillStyle = k.sig; g.fillRect(x - 2, 0, 4, 4); });
      c.favs.forEach(x => { g.fillStyle = k.ink; g.fillRect(x - 3, 0, 6, 6); });
      g.strokeStyle = k.ink; g.lineWidth = 3; g.strokeRect(c.x0 + 1.5, 1.5, Math.max(8, c.x1 - c.x0 - 3), h - 3);
      g.fillStyle = k.sig; g.fillRect(c.xv - 4, 0, 8, h);
    },
    spec(c) {            // vertical bar columns
      const g = c.g, w = c.w, h = c.h, k = c.col, n = Math.max(24, Math.floor(w / 9)), bwid = w / n;
      for (let i = 0; i < n; i++) {
        let m = -999; const a = Math.floor(i / n * 1024), b = Math.floor((i + 1) / n * 1024); for (let j = a; j < b; j++) if (c.cur[j] > m) m = c.cur[j];
        const y = c.Y(m); g.fillStyle = rgba(c.D.trace, .85); g.fillRect(i * bwid + 1, y, bwid - 2, h - y);
        if (c.mx) { const mm = c.Y(Math.max.apply(null, Array.prototype.slice.call(c.mx, a, b))); g.fillStyle = '#ff6b6b'; g.fillRect(i * bwid + 1, mm, bwid - 2, 3); }
        if (c.pk) { const mm = c.Y(Math.max.apply(null, Array.prototype.slice.call(c.pk, a, b))); g.fillStyle = '#7ee0ff'; g.fillRect(i * bwid + 1, mm, bwid - 2, 3); }
      }
      if (c.D.grid) { g.fillStyle = rgba(k.ink, .5); for (let i = 1; i < 4; i++) for (let x = 0; x < w; x += 12) g.fillRect(x, h * i / 4, 4, 2); }
    },
  };

  /* ------------------------------------------------------------------ FOLIO: print. Hairlines, triangles, serif numerals */
  DS.folio = {
    dial(c) {
      const g = c.g, w = c.w, h = c.h, k = c.col, mid = w / 2, ruleY = 40;
      // no tint behind anything: a drafting sheet. Station names hang below the rule like footnotes
      if (c.live) { g.strokeStyle = rgba(k.ink, .55); g.lineWidth = 1; g.beginPath(); c.liveLine(g, h - 6, 46, true); g.stroke(); }
      g.strokeStyle = k.ink; g.lineWidth = 1; g.beginPath(); g.moveTo(0, ruleY + .5); g.lineTo(w, ruleY + .5); g.stroke();
      g.textAlign = 'left'; g.font = 'italic 14px "Instrument Serif", Georgia, serif';
      ticks(c, (f, x) => {
        g.strokeStyle = k.ink; g.lineWidth = 1; g.beginPath(); g.moveTo(x + .5, ruleY); g.lineTo(x + .5, ruleY - 20); g.stroke();
        g.fillStyle = k.ink; g.fillText(label(f, c.major), x + 4, ruleY - 9);
        minors(c, x, (xm, i) => { g.beginPath(); g.moveTo(Math.round(xm) + .5, ruleY); g.lineTo(Math.round(xm) + .5, ruleY - (i === Math.round(c.minorN / 2) ? 10 : 5)); g.stroke(); });
      });
      // stations: hollow diamond on the rule, name hung underneath, a dotted leader
      let last = -99;
      c.mk.forEach(p => {
        const x = Math.round((p.f - c.lo) * c.pxHz) + .5, len = 16 + Math.min(p.db, 40) * .7, col = p.kind === 'fav' ? k.sig : k.ink;
        g.strokeStyle = col; g.setLineDash([1, 3]); g.beginPath(); g.moveTo(x, ruleY + 5); g.lineTo(x, ruleY + 5 + len); g.stroke(); g.setLineDash([]);
        g.fillStyle = k.glass; g.beginPath(); g.moveTo(x, ruleY - 4); g.lineTo(x + 4, ruleY); g.lineTo(x, ruleY + 4); g.lineTo(x - 4, ruleY); g.closePath(); g.fill(); g.stroke();
        if (x - last > 54 && x > 18 && x < w - 18) { last = x; g.fillStyle = col; g.textAlign = 'center'; g.font = '13px "Instrument Serif", Georgia, serif'; g.fillText(stLabel(p.f) + (p.kind === 'fav' ? ' *' : ''), x, Math.min(h - 6, ruleY + 5 + len + 13)); g.textAlign = 'left'; g.font = 'italic 14px "Instrument Serif", Georgia, serif'; }
      });
      // channel: two bracket marks on the rule; pointer: a downward triangle plus a hairline
      const bw = Math.max(6, c.bw);
      g.strokeStyle = k.sig; g.lineWidth = 1; g.beginPath(); g.moveTo(mid - bw / 2, ruleY + 8); g.lineTo(mid - bw / 2, ruleY + 14); g.lineTo(mid + bw / 2, ruleY + 14); g.lineTo(mid + bw / 2, ruleY + 8); g.stroke();
      g.beginPath(); g.moveTo(mid + .5, ruleY + 14); g.lineTo(mid + .5, h); g.stroke();
      g.fillStyle = k.sig; g.beginPath(); g.moveTo(mid - 8, 2); g.lineTo(mid + 8, 2); g.lineTo(mid, 18); g.closePath(); g.fill();
    },
    ov(c) {
      const g = c.g, w = c.w, h = c.h, k = c.col;
      g.strokeStyle = k.ink; g.lineWidth = 1; g.beginPath(); g.moveTo(0, h - .5); g.lineTo(w, h - .5); g.stroke();
      for (let x = 0; x < w; x += w / 20) { g.beginPath(); g.moveTo(Math.round(x) + .5, h); g.lineTo(Math.round(x) + .5, h - 4); g.stroke(); }
      if (c.plan.length) { g.font = 'italic 12px "Instrument Serif", Georgia, serif'; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = k.ink; c.plan.forEach(p => { g.beginPath(); g.moveTo(p.x0 + .5, 4); g.lineTo(p.x0 + .5, h - 4); g.stroke(); if (p.x1 - p.x0 > 36) g.fillText(p.name, p.x0 + 4, 15, p.x1 - p.x0 - 6); }); }
      else if (c.series) { g.beginPath(); c.series.forEach((s, i) => { const y = h - 3 - s.t * (h - 8); i ? g.lineTo(s.x, y) : g.moveTo(s.x, y); }); g.stroke(); }
      else c.hintText(g, k.ink);
      c.peaks.forEach(x => { g.fillStyle = k.ink; g.beginPath(); g.moveTo(x - 3, 0); g.lineTo(x + 3, 0); g.lineTo(x, 6); g.closePath(); g.fill(); });
      c.favs.forEach(x => { g.fillStyle = k.sig; g.fillRect(x - 2, 0, 4, 4); });
      g.strokeStyle = k.sig; g.lineWidth = 1.5; const a = c.x0, b = Math.max(c.x0 + 8, c.x1);
      g.beginPath(); g.moveTo(a + 5, 1); g.lineTo(a, 1); g.lineTo(a, h - 1); g.lineTo(a + 5, h - 1); g.moveTo(b - 5, 1); g.lineTo(b, 1); g.lineTo(b, h - 1); g.lineTo(b - 5, h - 1); g.stroke();
      g.fillStyle = k.sig; g.beginPath(); g.moveTo(c.xv - 4, h); g.lineTo(c.xv + 4, h); g.lineTo(c.xv, h - 8); g.closePath(); g.fill();
    },
    spec(c) {            // single hairline, stepped, no fill; dotted graticule
      const g = c.g, w = c.w, h = c.h, k = c.col;
      if (c.D.grid) { g.strokeStyle = rgba(k.ink, .35); g.lineWidth = 1; g.setLineDash([1, 4]); for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, Math.round(h * i / 4) + .5); g.lineTo(w, Math.round(h * i / 4) + .5); g.stroke(); } for (let i = 1; i < 8; i++) { g.beginPath(); g.moveTo(Math.round(w * i / 8) + .5, 0); g.lineTo(Math.round(w * i / 8) + .5, h); g.stroke(); } g.setLineDash([]); }
      const path = arr => { g.beginPath(); for (let i = 0; i < 1024; i += 2) { const x = i / 1023 * w, y = c.Y(arr[i]); i ? (g.lineTo(x, g_y), g.lineTo(x, y)) : g.moveTo(x, y); var g_y = y; } };
      g.strokeStyle = k.ink; g.lineWidth = 1; path(c.cur); g.stroke();
      if (c.mx) { g.strokeStyle = k.sig; path(c.mx); g.stroke(); } if (c.pk) { g.setLineDash([3, 3]); g.strokeStyle = k.ink; path(c.pk); g.stroke(); g.setLineDash([]); }
    },
  };

  /* ------------------------------------------------------------------ DEPTH: the scale curves away at the edges, as if it wrapped
     around you; stations are beams of light rising from it and the needle is a lens */
  DS.depth = {
    dial(c) {
      const g = c.g, w = c.w, h = c.h, k = c.col, mid = w / 2, base = h - 10;
      const bow = x => { const u = (x - mid) / (w / 2); return u * u * 14; };           // y drops away from the centre
      if (c.live) { g.beginPath(); let st = false; c.liveLine(g, null, 46, false, (x, y) => { const yy = y - bow(x) * .6; st ? g.lineTo(x, yy) : g.moveTo(x, yy); st = true; }); g.strokeStyle = rgba(k.sig, .55); g.lineWidth = 1; g.stroke(); }
      // the curve itself, then radial ticks leaning toward the centre
      g.strokeStyle = rgba(k.ink, .6); g.lineWidth = 1; g.beginPath(); for (let x = 0; x <= w; x += 6) { const y = base - 34 + bow(x); x ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
      g.textAlign = 'center'; g.font = '500 11px "V Inter", Inter, sans-serif';
      ticks(c, (f, x) => {
        const y = base - 34 + bow(x), lean = (x - mid) / (w / 2) * 6;
        g.strokeStyle = k.ink; g.lineWidth = 1.2; g.beginPath(); g.moveTo(x, y); g.lineTo(x - lean, y + 12); g.stroke();
        g.fillStyle = rgba(k.ink, .9); g.fillText(label(f, c.major), x - lean * 1.6, y + 25);
        minors(c, x, xm => { const ym = base - 34 + bow(xm); g.strokeStyle = rgba(k.ink, .45); g.beginPath(); g.moveTo(xm, ym); g.lineTo(xm - (xm - mid) / (w / 2) * 3, ym + 5); g.stroke(); });
      });
      // stations: thin light beams rising from the curve with a plus at the top
      let last = -99;
      c.mk.forEach(p => {
        const x = (p.f - c.lo) * c.pxHz, y0 = base - 34 + bow(x), len = 18 + Math.min(p.db, 40) * 1.0, col = p.kind === 'fav' ? '#ffffff' : k.acc;
        const lg = g.createLinearGradient(0, y0, 0, y0 - len); lg.addColorStop(0, rgba(col, .9)); lg.addColorStop(1, rgba(col, 0)); g.strokeStyle = lg; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y0 - len); g.stroke();
        g.strokeStyle = col; g.lineWidth = 1; g.beginPath(); g.moveTo(x - 3, y0 - len * .55); g.lineTo(x + 3, y0 - len * .55); g.moveTo(x, y0 - len * .55 - 3); g.lineTo(x, y0 - len * .55 + 3); g.stroke();
        if (x - last > 60 && x > 22 && x < w - 22) { last = x; g.fillStyle = k.ink; g.font = '500 10px "V Inter", Inter, sans-serif'; g.fillText(stLabel(p.f), x, y0 - len - 5); g.font = '500 11px "V Inter", Inter, sans-serif'; }
      });
      // the lens: a vertical sweep of light plus a ring where it meets the curve; channel as a faint cone
      const cone = g.createLinearGradient(0, 0, 0, h); cone.addColorStop(0, rgba(k.sig, 0)); cone.addColorStop(1, rgba(k.sig, .22)); g.fillStyle = cone; g.fillRect(mid - Math.max(4, c.bw) / 2, 0, Math.max(4, c.bw), h);
      const nl = g.createLinearGradient(0, 0, 0, h); nl.addColorStop(0, rgba(k.sig, 0)); nl.addColorStop(.4, rgba(k.sig, 1)); nl.addColorStop(1, rgba(k.sig, .9)); g.fillStyle = nl; g.fillRect(mid - .75, 0, 1.5, h);
      g.shadowColor = k.sig; g.shadowBlur = 14; g.strokeStyle = k.sig; g.lineWidth = 1.5; g.beginPath(); g.arc(mid, base - 34, 7, 0, TAU); g.stroke(); g.shadowBlur = 0;
    },
    ov(c) {
      const g = c.g, w = c.w, h = c.h, k = c.col;
      if (c.plan.length) c.plan.forEach(p => { g.fillStyle = rgba(k.acc, .5); for (let x = p.x0; x < p.x1; x += 4) g.fillRect(x, h / 2 - 5, 1, 10); });
      else if (c.series) { c.series.forEach((s, i) => { if (i % 2) return; const t = s.t * (h - 6); const lg = g.createLinearGradient(0, h, 0, h - t); lg.addColorStop(0, rgba(k.acc, .15)); lg.addColorStop(1, rgba(k.acc, .9)); g.fillStyle = lg; g.fillRect(s.x, h - 2 - t, 1, t); }); }
      else c.hintText(g, k.ink);
      c.peaks.forEach(x => { g.strokeStyle = k.sig; g.lineWidth = 1; g.beginPath(); g.moveTo(x - 3, 3); g.lineTo(x + 3, 3); g.moveTo(x, 0); g.lineTo(x, 6); g.stroke(); });
      c.favs.forEach(x => { g.fillStyle = '#fff'; g.fillRect(x - 1, 0, 2, 7); });
      g.strokeStyle = k.ink; g.lineWidth = 1.5; const a = c.x0, b = Math.max(c.x0 + 10, c.x1), L = 6;
      [[a, 1, 1, 1], [b, 1, -1, 1], [a, h - 1, 1, -1], [b, h - 1, -1, -1]].forEach(q => { g.beginPath(); g.moveTo(q[0] + q[2] * L, q[1]); g.lineTo(q[0], q[1]); g.lineTo(q[0], q[1] + q[3] * L); g.stroke(); });
      g.strokeStyle = k.sig; g.lineWidth = 1.5; g.shadowColor = k.sig; g.shadowBlur = 8; g.beginPath(); g.moveTo(c.xv, 0); g.lineTo(c.xv, h); g.stroke(); g.shadowBlur = 0;
    },
    spec(c) {            // mirrored ribbon: the trace reflected about a centre line, glow, no fill below
      const g = c.g, w = c.w, h = c.h, k = c.col, mid = h / 2;
      g.strokeStyle = rgba(k.ink, .25); g.lineWidth = 1; g.beginPath(); g.moveTo(0, mid + .5); g.lineTo(w, mid + .5); g.stroke();
      const amp = arr => { const out = []; for (let i = 0; i < 1024; i += 2) out.push([i / 1023 * w, (h - c.Y(arr[i])) / h * mid]); return out; };
      const pts = amp(c.cur); g.beginPath(); pts.forEach((p, i) => { const y = mid - p[1]; i ? g.lineTo(p[0], y) : g.moveTo(p[0], y); }); for (let i = pts.length - 1; i >= 0; i--) g.lineTo(pts[i][0], mid + pts[i][1]); g.closePath();
      const lg = g.createLinearGradient(0, 0, 0, h); lg.addColorStop(0, rgba(c.D.trace, .0)); lg.addColorStop(.5, rgba(c.D.trace, .45)); lg.addColorStop(1, rgba(c.D.trace, 0)); g.fillStyle = lg; g.fill();
      g.shadowColor = c.D.trace; g.shadowBlur = 6; g.strokeStyle = c.D.trace; g.lineWidth = 1; g.beginPath(); pts.forEach((p, i) => { const y = mid - p[1]; i ? g.lineTo(p[0], y) : g.moveTo(p[0], y); }); g.stroke(); g.beginPath(); pts.forEach((p, i) => { const y = mid + p[1]; i ? g.lineTo(p[0], y) : g.moveTo(p[0], y); }); g.stroke(); g.shadowBlur = 0;
      if (c.mx) { g.strokeStyle = '#ff6b6b88'; g.beginPath(); amp(c.mx).forEach((p, i) => i ? g.lineTo(p[0], mid - p[1]) : g.moveTo(p[0], mid - p[1])); g.stroke(); }
    },
  };

  /* ------------------------------------------------------------------ SKYWAVE: flat glass. The whole band stays legible:
     one hairline scale, every tick and label at full strength, stations as small capsules, a clean needle. No spotlight. */
  DS.skywave = {
    dial(c) {
      const g = c.g, w = c.w, h = c.h, k = c.col, mid = w / 2, base = h - 30;
      const pill = (x, y, ww, hh) => { const r = hh / 2; g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + ww - r, y); g.arc(x + ww - r, y + r, r, -Math.PI / 2, Math.PI / 2); g.lineTo(x + r, y + hh); g.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5); g.closePath(); };
      if (c.live) { g.beginPath(); c.liveLine(g, base, 44); g.lineTo(c.liveEnd, base); g.closePath(); g.fillStyle = rgba(k.acc, .14); g.fill(); g.beginPath(); c.liveLine(g, base, 44); g.strokeStyle = rgba(k.acc, .55); g.lineWidth = 1; g.stroke(); }
      g.fillStyle = rgba(k.ink, .35); g.fillRect(0, base, w, 1);
      g.textAlign = 'center'; g.font = '500 12px "V Inter", Inter, sans-serif';
      ticks(c, (f, x) => {
        g.fillStyle = rgba(k.ink, .9); g.fillRect(Math.round(x), base, 1, 9);
        g.fillText(label(f, c.major), x, base + 23);
        minors(c, x, xm => { g.fillStyle = rgba(k.ink, .4); g.fillRect(Math.round(xm), base, 1, 4); });
      });
      let last = -99;
      c.mk.forEach(p => {
        const x = (p.f - c.lo) * c.pxHz, s = Math.min(p.db, 40) / 40, hh = 6 + s * 16, col = p.kind === 'fav' ? k.sig : k.acc;
        g.fillStyle = rgba(col, .85); pill(x - 2.5, base - 4 - hh, 5, hh); g.fill();
        if (x - last > 54 && x > 22 && x < w - 22) { last = x; g.fillStyle = rgba(k.ink, .95); g.font = '500 11px "V Inter", Inter, sans-serif'; g.fillText(stLabel(p.f), x, base - 10 - hh); g.font = '500 12px "V Inter", Inter, sans-serif'; }
      });
      const bw = Math.max(4, c.bw);
      g.fillStyle = rgba(k.sig, .14); g.fillRect(mid - bw / 2, 0, bw, base);
      g.fillStyle = k.sig; g.fillRect(mid - 1, 0, 2, base + 10);
      g.fillStyle = rgba(k.glass, .9); pill(mid - 9, 2, 18, 10); g.fill(); g.strokeStyle = k.sig; g.lineWidth = 1.5; pill(mid - 9, 2, 18, 10); g.stroke();
    },
    ov(c) {
      const g = c.g, w = c.w, h = c.h, k = c.col;
      g.fillStyle = rgba(k.ink, .2); g.fillRect(0, h - 1, w, 1);
      if (c.plan.length) c.plan.forEach((p, i) => { g.fillStyle = rgba(k.acc, i % 2 ? .3 : .45); g.fillRect(p.x0, h / 2 - 3, Math.max(2, p.x1 - p.x0 - 1), 6); });
      else if (c.series) { g.beginPath(); g.moveTo(0, h); c.series.forEach(s => g.lineTo(s.x, h - 3 - s.t * (h - 8))); g.lineTo(w, h); g.closePath(); g.fillStyle = rgba(k.acc, .25); g.fill(); g.strokeStyle = rgba(k.acc, .9); g.lineWidth = 1.2; g.beginPath(); c.series.forEach((s, i) => { const y = h - 3 - s.t * (h - 8); i ? g.lineTo(s.x, y) : g.moveTo(s.x, y); }); g.stroke(); }
      else c.hintText(g, k.ink);
      c.peaks.forEach(x => { g.fillStyle = k.acc; g.fillRect(x - 1, 0, 2, 6); });
      c.favs.forEach(x => { g.fillStyle = k.sig; g.fillRect(x - 1.5, 0, 3, 7); });
      g.fillStyle = rgba(k.sig, .16); g.fillRect(c.x0, 0, Math.max(4, c.x1 - c.x0), h);
      g.fillStyle = k.sig; g.fillRect(c.xv - 1, 0, 2, h);
    },
    spec(c) {
      const g = c.g, w = c.w, h = c.h, k = c.col;
      if (c.D.grid) { g.fillStyle = rgba(k.ink, .12); for (let i = 1; i < 4; i++) g.fillRect(0, Math.round(h * i / 4), w, 1); }
      const path = arr => { g.beginPath(); for (let i = 0; i < 1024; i += 2) { const x = i / 1023 * w, y = c.Y(arr[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); } };
      path(c.cur); g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fillStyle = rgba(c.D.trace, .18); g.fill();
      g.strokeStyle = c.D.trace; g.lineWidth = 1.4; g.lineJoin = 'round'; path(c.cur); g.stroke();
      if (c.mx) { g.strokeStyle = '#ff6b6b99'; g.lineWidth = 1; path(c.mx); g.stroke(); } if (c.pk) { g.strokeStyle = rgba(k.acc, .7); g.lineWidth = 1; path(c.pk); g.stroke(); }
    },
  };

  /* ------------------------------------------------------------------ TICKET: a slide-rule scale behind glass, a thick pointer and a flag */
  DS.ticket = {
    dial(c) {
      const g = c.g, w = c.w, h = c.h, k = c.col, mid = w / 2;
      g.fillStyle = rgba(k.ink, .08); g.fillRect(0, 0, w, h);
      // two long horizontal scales, ticks hanging from the upper and rising from the lower
      g.strokeStyle = rgba(k.ink, .7); g.lineWidth = 1; g.beginPath(); g.moveTo(0, 30.5); g.lineTo(w, 30.5); g.moveTo(0, h - 30.5); g.lineTo(w, h - 30.5); g.stroke();
      if (c.live) { g.beginPath(); c.liveLine(g, h - 31, 40); g.strokeStyle = rgba(k.sig, .6); g.stroke(); }
      g.textAlign = 'center'; g.font = '700 12px "B612 Mono", monospace';
      ticks(c, (f, x) => {
        g.strokeStyle = k.ink; g.lineWidth = 2; g.beginPath(); g.moveTo(x, 30); g.lineTo(x, 48); g.stroke(); g.fillStyle = k.ink; g.fillText(label(f, c.major), x, 62);
        minors(c, x, xm => { g.lineWidth = 1; g.strokeStyle = rgba(k.ink, .6); g.beginPath(); g.moveTo(xm, 30); g.lineTo(xm, 38); g.stroke(); });
      });
      let last = -99;
      c.mk.forEach(p => { const x = (p.f - c.lo) * c.pxHz; g.fillStyle = p.kind === 'fav' ? '#fff' : k.acc; g.beginPath(); g.moveTo(x - 4, h - 30); g.lineTo(x + 4, h - 30); g.lineTo(x, h - 40); g.closePath(); g.fill(); if (x - last > 50 && x > 18 && x < w - 18) { last = x; g.fillStyle = k.ink; g.font = '700 11px "B612 Mono", monospace'; g.fillText(stLabel(p.f), x, h - 14); g.font = '700 12px "B612 Mono", monospace'; } });
      const bw = Math.max(3, c.bw); g.fillStyle = rgba(k.sig, .2); g.fillRect(mid - bw / 2, 0, bw, h);
      g.fillStyle = k.sig; g.fillRect(mid - 2, 0, 4, h); g.fillRect(mid - 9, h - 8, 18, 8); g.fillRect(mid - 9, 0, 18, 6);
    },
  };
  /* ------------------------------------------------------------------ RELIEF: a soft groove, rounded ticks, a raised pill for the needle */
  DS.relief = {
    dial(c) {
      const g = c.g, w = c.w, h = c.h, k = c.col, mid = w / 2, y = h - 40;
      const pill = (x, yy, ww, hh) => { const r = Math.min(ww, hh) / 2; g.beginPath(); g.roundRect ? g.roundRect(x, yy, ww, hh, r) : g.rect(x, yy, ww, hh); };
      if (c.live) { g.beginPath(); c.liveLine(g, y - 8, 40); g.lineTo(c.liveEnd, y - 8); g.closePath(); g.fillStyle = rgba(k.acc, .12); g.fill(); }
      // the groove: a darker channel with a light lower lip
      g.fillStyle = rgba('#000000', .35); pill(0, y - 3, w, 8); g.fill();
      g.fillStyle = rgba(k.ink, .10); g.fillRect(0, y + 5, w, 1);
      g.textAlign = 'center'; g.font = '600 11.5px "V Inter", Inter, sans-serif';
      ticks(c, (f, x) => {
        g.fillStyle = rgba(k.ink, .85); pill(x - 2, y + 12, 4, 12); g.fill();
        g.fillText(label(f, c.major), x, y + 38);
        minors(c, x, xm => { g.fillStyle = rgba(k.ink, .35); g.beginPath(); g.arc(xm, y + 16, 1.6, 0, TAU); g.fill(); });
      });
      let last = -99;
      c.mk.forEach(p => {
        const x = (p.f - c.lo) * c.pxHz, s2 = Math.min(p.db, 40) / 40, r = 3 + s2 * 3, col = p.kind === 'fav' ? k.sig : k.acc;
        g.fillStyle = rgba(col, .25); g.beginPath(); g.arc(x, y - 20, r + 4, 0, TAU); g.fill();
        g.fillStyle = col; g.beginPath(); g.arc(x, y - 20, r, 0, TAU); g.fill();
        if (x - last > 54 && x > 22 && x < w - 22) { last = x; g.fillStyle = rgba(k.ink, .9); g.font = '600 11px "V Inter", Inter, sans-serif'; g.fillText(stLabel(p.f), x, y - 32 - r); g.font = '600 11.5px "V Inter", Inter, sans-serif'; }
      });
      const bw = Math.max(6, c.bw);
      g.fillStyle = rgba(k.sig, .14); pill(mid - bw / 2, 4, bw, y - 4); g.fill();
      // the needle: a raised pill with a soft shadow below and a highlight on its top edge
      g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 10; g.shadowOffsetY = 3;
      g.fillStyle = k.sig; pill(mid - 5, 6, 10, y + 4); g.fill();
      g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;
      g.fillStyle = 'rgba(255,255,255,.45)'; pill(mid - 3, 9, 6, 3); g.fill();
    },
  };

  /* ------------------------------------------------------------------ WALNUT: a backlit glass scale printed in two rows, a red needle */
  DS.walnut = {
    dial(c) {
      const g = c.g, w = c.w, h = c.h, k = c.col, mid = w / 2, top = 26, bot = h - 26;
      // the lamp behind the glass: warm in the middle, falling off to the ends
      const lamp = g.createLinearGradient(0, 0, w, 0); lamp.addColorStop(0, 'rgba(255,170,70,.04)'); lamp.addColorStop(.5, 'rgba(255,180,90,.16)'); lamp.addColorStop(1, 'rgba(255,170,70,.04)');
      g.fillStyle = lamp; g.fillRect(0, 0, w, h);
      const print = '#ffe8c4';
      g.strokeStyle = rgba(print, .75); g.lineWidth = 1; g.beginPath(); g.moveTo(0, top + .5); g.lineTo(w, top + .5); g.moveTo(0, bot + .5); g.lineTo(w, bot + .5); g.stroke();
      if (c.live) { g.beginPath(); c.liveLine(g, bot - 1, 40); g.strokeStyle = rgba(k.sig, .55); g.stroke(); }
      g.textAlign = 'center'; g.font = '600 12px "V Sans", sans-serif';
      ticks(c, (f, x) => {
        g.strokeStyle = print; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, top); g.lineTo(x, top + 14); g.moveTo(x, bot); g.lineTo(x, bot - 10); g.stroke();
        g.fillStyle = print; g.fillText(label(f, c.major), x, top + 30);
        minors(c, x, xm => { g.lineWidth = 1; g.strokeStyle = rgba(print, .55); g.beginPath(); g.moveTo(xm, top); g.lineTo(xm, top + 6); g.stroke(); });
      });
      let last = -99;
      c.mk.forEach(p => {
        const x = (p.f - c.lo) * c.pxHz; g.fillStyle = p.kind === 'fav' ? '#ffd27a' : rgba(print, .9); g.beginPath(); g.arc(x, bot - 16, p.kind === 'fav' ? 3.5 : 2.5, 0, TAU); g.fill();
        if (x - last > 54 && x > 20 && x < w - 20) { last = x; g.fillStyle = rgba(print, .8); g.font = '500 10.5px "V Sans", sans-serif'; g.fillText(stLabel(p.f), x, h - 8); g.font = '600 12px "V Sans", sans-serif'; }
      });
      // the needle: a thin red pointer that casts a shadow on the printed glass
      const bw = Math.max(3, c.bw); g.fillStyle = 'rgba(255,180,90,.12)'; g.fillRect(mid - bw / 2, 0, bw, h);
      g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(mid + 2, 4, 3, h - 8);
      g.fillStyle = '#e8402a'; g.fillRect(mid - 1.5, 2, 3, h - 4);
      g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(mid - 1.5, 2, 1, h - 4);
    },
  };

  /* ------------------------------------------------------------------ RIOT: ticks in three colours, stations as stars, a fat striped needle */
  DS.riot = {
    dial(c) {
      const g = c.g, w = c.w, h = c.h, k = c.col, mid = w / 2, y = h - 34, cols = [k.acc, k.sig, k.hot || k.acc];
      if (c.live) { g.beginPath(); c.liveLine(g, y, 44); g.lineTo(c.liveEnd, y); g.closePath(); g.fillStyle = rgba(k.hot || k.acc, .22); g.fill(); }
      g.fillStyle = k.ink; g.fillRect(0, y, w, 3);
      g.textAlign = 'center'; g.font = '800 12.5px "V Bricolage", sans-serif';
      let n = 0;
      ticks(c, (f, x) => {
        const col = cols[n++ % 3]; g.fillStyle = col; g.fillRect(x - 3, y - 6, 6, 18);
        g.fillStyle = k.ink; g.fillText(label(f, c.major), x, y + 30);
        minors(c, x, (xm, i) => { g.fillStyle = cols[(n + i) % 3]; g.beginPath(); g.arc(xm, y + 6, 2.4, 0, TAU); g.fill(); });
      });
      const star = (x, yy, r, col) => { g.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * .45 : r; g.lineTo(x + Math.cos(a) * rr, yy + Math.sin(a) * rr); } g.closePath(); g.fillStyle = col; g.fill(); };
      let last = -99, m = 0;
      c.mk.forEach(p => {
        const x = (p.f - c.lo) * c.pxHz, r = 5 + Math.min(p.db, 40) / 40 * 5;
        star(x, y - 22, r, p.kind === 'fav' ? k.sig : cols[m++ % 3]);
        if (x - last > 56 && x > 22 && x < w - 22) { last = x; g.fillStyle = k.ink; g.font = '800 11px "V Bricolage", sans-serif'; g.fillText(stLabel(p.f), x, y - 30 - r); g.font = '800 12.5px "V Bricolage", sans-serif'; }
      });
      const bw = Math.max(8, c.bw); g.fillStyle = rgba(k.sig, .2); g.fillRect(mid - bw / 2, 0, bw, h);
      // the needle: diagonal stripes in the accent and signal colours, outlined in ink
      g.save(); g.beginPath(); g.rect(mid - 6, 2, 12, h - 4); g.clip();
      for (let yy = -12; yy < h + 12; yy += 12) { g.fillStyle = (yy / 12) % 2 ? k.acc : k.sig; g.beginPath(); g.moveTo(mid - 8, yy); g.lineTo(mid + 8, yy - 8); g.lineTo(mid + 8, yy + 4); g.lineTo(mid - 8, yy + 12); g.closePath(); g.fill(); }
      g.restore(); g.strokeStyle = k.ink; g.lineWidth = 2; g.strokeRect(mid - 6, 2, 12, h - 4);
    },
  };

  // Brut borrows Bento's blocks. The band strip and spectrum: Relief and Walnut use the plain ones, Riot Bento's chunky bars
  DS.brut = DS.bento;
  DS.relief.ov = DS.walnut.ov = DS.skywave.ov; DS.relief.spec = DS.walnut.spec = DS.skywave.spec;
  DS.riot.ov = DS.bento.ov; DS.riot.spec = DS.bento.spec;
})();
