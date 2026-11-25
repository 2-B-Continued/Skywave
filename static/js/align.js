/* align.js - satellite alignment: where to point an antenna, as a compass bearing and an angle up from the horizon. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc, Sp = RS.pages.space;
  const R = Math.PI / 180, RE = 6378.137, GEO = 42164.17;
  const A = RS.align = { mode: 'leo', sat: '', lon: 0, sky: [], timer: 0 };

  // ---- geometry (pure functions, also used by the tests)
  A.geo = (lat, lon, satLon) => {
    const la = lat * R, lo = lon * R, sl = satLon * R;
    const o = [RE * Math.cos(la) * Math.cos(lo), RE * Math.cos(la) * Math.sin(lo), RE * Math.sin(la)];
    const s = [GEO * Math.cos(sl), GEO * Math.sin(sl), 0];
    const d = [s[0] - o[0], s[1] - o[1], s[2] - o[2]];
    const e = [-Math.sin(lo), Math.cos(lo), 0], n = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)], u = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const E = dot(d, e), N = dot(d, n), U = dot(d, u), r = Math.hypot(E, N, U);
    const el = Math.asin(U / r) / R, az = (Math.atan2(E, N) / R + 360) % 360;
    let dl = ((satLon - lon + 540) % 360) - 180;                           // LNB skew (polarisation rotation)
    const skew = Math.abs(lat) < 0.01 ? 0 : Math.atan(Math.sin(dl * R) / Math.tan(lat * R)) / R;
    return { az, el, skew, up: el > 0, range_km: r };
  };

  const f1 = x => (x == null || isNaN(x) ? '-' : x.toFixed(1) + '°');
  function target() {
    if (A.mode === 'geo') {
      const lat = RS.cfg && RS.cfg.lat, lon = RS.cfg && RS.cfg.lon;
      if (lat == null || lon == null) return null;
      const g = A.geo(lat, lon, A.lon); return { name: 'Geostationary satellite at ' + A.lon + '° E', az: g.az, el: g.el, up: g.up, skew: g.skew, fixed: true };
    }
    const s = A.sky.find(x => x.id === A.sat); return s ? { name: s.short, az: s.az, el: s.el, up: s.up, range: s.range_km } : null;
  }
  function build() {
    const host = $('#sp-aim-slot') || $('#p-space'); if (!host || $('#aim-card')) return;
    const card = document.createElement('div'); card.className = 'spx-aim-card'; card.id = 'aim-card';
    card.innerHTML = `<div class="card-head hide"><div><h3>Aim your antenna</h3><div class="sub">Where to point, live. For a dish or a Yagi on a satellite; geostationary TV and data satellites do not move.</div></div></div>
      <div class="row" style="flex-wrap:wrap;gap:12px;align-items:end">
        <label class="field">Target<select id="aim-mode"><option value="leo">Passing satellite</option><option value="geo">Fixed satellite (by longitude)</option></select></label>
        <label class="field" id="aim-satw">Satellite<select id="aim-sat"></select></label>
        <label class="field hide" id="aim-lonw">Satellite longitude (°E, west is negative)<input id="aim-lon" inputmode="decimal" value="0"></label>
      </div>
      <div class="aim-grid">
        <canvas id="aim-cv" class="sky" aria-label="Aiming chart"></canvas>
        <div id="aim-out"></div>
      </div>`;
    host.appendChild(card);
    $('#aim-mode').onchange = e => { A.mode = e.target.value; $('#aim-satw').classList.toggle('hide', A.mode !== 'leo'); $('#aim-lonw').classList.toggle('hide', A.mode !== 'geo'); draw(); };
    $('#aim-sat').onchange = e => { A.sat = e.target.value; draw(); };
    $('#aim-lon').oninput = e => { const v = parseFloat(e.target.value); if (isFinite(v) && v >= -180 && v <= 180) { A.lon = v; draw(); } };
  }
  async function poll() {
    if (RS.page !== 'space') return;
    try { const r = await RS.api('space/aim'); A.sky = r.sky || []; fillSats(); draw(); } catch (e) { }
  }
  function fillSats() {
    const sel = $('#aim-sat'); if (!sel) return;
    const rows = A.sky.slice().sort((a, b) => (b.up - a.up) || (b.el - a.el));
    const sig = rows.map(r => r.id + (r.up ? '+' : '-')).join();
    if (sel._sig !== sig) {
      sel._sig = sig; sel.innerHTML = !rows.length ? '<option value="">No satellite data yet</option>' : rows.map(r => '<option value="' + esc(r.id) + '">' + esc(r.short) + (r.up ? ' (above the horizon)' : ' (below the horizon)') + '</option>').join('');
      if (!rows.some(r => r.id === A.sat)) A.sat = rows.length ? rows[0].id : '';
      sel.value = A.sat;
    }
  }
  function draw() {
    const out = $('#aim-out'), cv = $('#aim-cv'); if (!out || !cv) return;
    const t = target();
    if (!t) { out.innerHTML = '<div class="muted">' + (A.mode === 'geo' ? 'Set your location in Settings first.' : 'No satellite data yet. Use "Check for new satellite data" below.') + '</div>'; plot(cv, null); return; }
    let h = '<div class="aim-big"><div><span>Compass bearing</span><b>' + f1(t.az) + '</b></div><div><span>Up from the horizon</span><b>' + f1(t.el) + '</b></div></div>';
    h += '<div class="small muted">' + esc(t.name) + (t.up ? '' : ' - below the horizon, so it cannot be received from here right now') + (t.skew != null ? '. LNB skew ' + f1(t.skew) : '') + '</div>';
    h += '<div class="small muted">The bearing is from true north. A magnetic compass points a few degrees away from it in most places.</div>';
    out.innerHTML = h; plot(cv, t);
  }
  function plot(cv, t) {
    const w = cv.clientWidth || 300, dpr = window.devicePixelRatio || 1; if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = w * dpr; cv.style.height = w + 'px'; }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, w);
    const cs = getComputedStyle(document.body), ink = cs.getPropertyValue('--ink-2') || '#889', amber = cs.getPropertyValue('--amber').trim() || '#e8a21a';
    const c = w / 2, r = w / 2 - 22;
    g.strokeStyle = ink.trim() || '#889'; g.fillStyle = g.strokeStyle; g.globalAlpha = .55; g.lineWidth = 1;
    [0, 30, 60].forEach(el => { g.beginPath(); g.arc(c, c, r * (90 - el) / 90, 0, 7); g.stroke(); });
    g.beginPath(); g.moveTo(c, c - r); g.lineTo(c, c + r); g.moveTo(c - r, c); g.lineTo(c + r, c); g.stroke(); g.globalAlpha = 1;
    g.font = '12px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
    [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([l, a]) => g.fillText(l, c + (r + 12) * Math.sin(a * R), c - (r + 12) * Math.cos(a * R)));
    const pos = (az, el) => [c + r * (90 - Math.max(el, 0)) / 90 * Math.sin(az * R), c - r * (90 - Math.max(el, 0)) / 90 * Math.cos(az * R)];
    if (t) { const p = pos(t.az, t.el); g.globalAlpha = t.up ? 1 : .4; g.fillStyle = amber; g.beginPath(); g.arc(p[0], p[1], 9, 0, 7); g.fill(); g.globalAlpha = 1; }
  }
  const init = Sp.init, enter = Sp.enter;
  Sp.init = function () { init.apply(this, arguments); build(); };
  Sp.enter = function () { enter.apply(this, arguments); build(); poll(); clearInterval(A.timer); A.timer = setInterval(poll, 1500); };
  window.addEventListener('resize', draw);
})();
