/* planes.js - the Planes page.
   A status strip; the map (altitude-coloured planes and trails, labels, your reception range drawn as an outline,
   an altitude legend, the past hour on a replay bar); beside it one panel that is either the list (search, quick
   filters, sort) or the chosen plane (photo, registration, model and operator; its flight, route and progress; what
   its autopilot is set to; every reading; its altitude over the last few minutes; Follow and Show only this). The
   chosen plane's route is drawn on the map, with the path it has flown so far from the adsb.lol network. Below: your receiver (aircraft over the past hour,
   messages a second, farthest heard, the range chart) and listening to air traffic (air.js).
   Other pages use Pl.list, Pl.sel, Pl.isEmg, Pl.speaking, Pl.spoke, Pl.rows, Pl.update, Pl.alerts and Pl.airUi. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc, icon = RS.icon;
  const Pl = RS.pages.planes = {};
  Pl.list = []; Pl.live = []; Pl.stats = {}; Pl.sel = null; Pl.t0 = 0; Pl.filterBy = 'all'; Pl.spoke = {}; Pl.info = {}; Pl.trace = {}; Pl.replay = null;
  const opt = k => RS.store.get('pl_' + k, { trails: true, labels: true, outline: true }[k]);
  const setOpt = (k, v) => RS.store.set('pl_' + k, v);

  // ---------------------------------------------------------------- units and words
  const imp = () => (RS.cfg && RS.cfg.units) === 'imperial';
  const N = n => n == null ? '-' : Math.round(n).toLocaleString();
  const altTxt = a => a.alt == null ? '-' : a.alt <= 0 || /ground/i.test(a.cat || '') ? 'On the ground' : N(a.alt) + ' ft';
  const spd = kt => kt == null ? '-' : imp() ? N(kt * 1.151) + ' mph' : N(kt * 1.852) + ' km/h';
  const dist = km => km == null ? '-' : imp() ? (km * 0.6214 < 10 ? (km * 0.6214).toFixed(1) : N(km * 0.6214)) + ' mi' : (km < 10 ? km.toFixed(1) : N(km)) + ' km';
  const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const dirOf = b => DIRS[Math.round(((b % 360) + 360) % 360 / 45) % 8];
  const trend = a => { const p = phase(a); return p === 'climb' ? 'up' : p === 'descend' ? 'down' : ''; };
  const name = a => a.callsign || a.icao.toUpperCase();
  Pl.isEmg = a => (a.emg && a.emg > 0) || ['7500', '7600', '7700'].includes(a.squawk);
  Pl.speaking = id => Pl.spoke[id] && Date.now() - Pl.spoke[id].t < 45000;
  // the plane's maker and model: the type table's plain name, then the network's description, then the maker and
  // variant on record; the broadcast size class only when nothing better is known
  const modelOf = a => {
    const ac = (Pl.info[a.icao] || {}).aircraft || {};
    return RS.acType(ac.icao_type) || ac.description || [ac.manufacturer, ac.type].filter(Boolean).join(' ') || '';
  };
  const routeOf = a => { const r = (Pl.info[a.icao] || {}).route; return r && r.origin ? r : null; };   // a route may have only its takeoff airport
  const apCode = x => (x && (x.iata || x.icao)) || '';
  const typeLine = a => {
    const r = routeOf(a), bits = [];
    if (r) bits.push(r.destination ? apCode(r.origin) + ' to ' + apCode(r.destination) : 'From ' + apCode(r.origin));
    bits.push(modelOf(a) || (RS.airline && RS.airline(a.callsign)) || a.cat || (RS.countryOf && RS.countryOf(a.icao)) || 'Aircraft');
    return bits.join(' · ');
  };
  // great-circle distance (km) and points along the great circle, for routes and progress
  const RAD = Math.PI / 180;
  const gcKm = (la1, lo1, la2, lo2) => { const d = Math.sin((la2 - la1) * RAD / 2) ** 2 + Math.cos(la1 * RAD) * Math.cos(la2 * RAD) * Math.sin((lo2 - lo1) * RAD / 2) ** 2; return 12742 * Math.asin(Math.min(1, Math.sqrt(d))); };
  function gcPath(la1, lo1, la2, lo2, n) {
    const p1 = [la1 * RAD, lo1 * RAD], p2 = [la2 * RAD, lo2 * RAD], d = gcKm(la1, lo1, la2, lo2) / 6371, out = [];
    if (d < 1e-6) return [[la1, lo1], [la2, lo2]];
    for (let i = 0; i <= n; i++) {
      const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(p1[0]) * Math.cos(p1[1]) + B * Math.cos(p2[0]) * Math.cos(p2[1]), y = A * Math.cos(p1[0]) * Math.sin(p1[1]) + B * Math.cos(p2[0]) * Math.sin(p2[1]), z = A * Math.sin(p1[0]) + B * Math.sin(p2[0]);
      let lon = Math.atan2(y, x) / RAD; if (out.length) { const prev = out[out.length - 1][1]; while (lon - prev > 180) lon -= 360; while (lon - prev < -180) lon += 360; }
      out.push([Math.atan2(z, Math.hypot(x, y)) / RAD, lon]);
    }
    return out;
  }
  const hasLL = x => x && x.lat != null && x.lon != null;
  // how far along its route the plane is, and when it should arrive at its current ground speed
  function progress(a, r) {
    if (!r || a.lat == null || !hasLL(r.origin) || !hasLL(r.destination)) return null;
    const flown = gcKm(r.origin.lat, r.origin.lon, a.lat, a.lon), left = gcKm(a.lat, a.lon, r.destination.lat, r.destination.lon), total = gcKm(r.origin.lat, r.origin.lon, r.destination.lat, r.destination.lon);
    if (total < 20 || flown + left > total * 1.6) return null;          // too short to be useful, or the plane is nowhere near this route
    return { flown, left, pct: Math.max(0, Math.min(1, flown / (flown + left))), eta: arrival(a, left) };
  }
  // Arrival is worked out from the speed the plane cruises at, not its speed this second, which is far lower while it
  // climbs out or comes in to land. The cruise speed comes from the flight so far (the high-altitude part of the
  // network's track) when there is one, otherwise from a typical speed for the kind of aircraft. The last stretch is
  // flown more slowly, and the answer is rounded to 5 minutes so it doesn't jump about.
  const PROPS = /^(AT[4-7]|DH8|DHC|SF34|B190|PC12|C208|C30J|C130|JS[0-9]|D228|L410|SW4|BE[0-9]|P68|E110|E120|F50|AN2[46]|Y12|BN2|TBM)/;
  function cruiseKmh(a) {
    const t = (Pl.trace[a.icao] || {}).points || [], v = [];
    for (let i = 1; i < t.length; i++) {
      const p = t[i - 1], q = t[i], dt = q[0] - p[0];
      if (p[3] != null && q[3] != null && p[3] > 20000 && q[3] > 20000 && dt >= 30 && dt < 900) v.push(gcKm(p[1], p[2], q[1], q[2]) / dt * 3600);
    }
    if (v.length >= 5) { v.sort((x, y) => x - y); const m = v[v.length >> 1]; if (m > 250 && m < 1300) return m; }
    const ty = String(((Pl.info[a.icao] || {}).aircraft || {}).icao_type || '').toUpperCase();
    return PROPS.test(ty) ? 480 : /light|glider|rotor|ultra/i.test(a.cat || '') ? 220 : 820;
  }
  function arrival(a, left) {
    if (a.alt != null && a.alt <= 0) return null;                                      // still on the ground
    const v = cruiseKmh(a), last = Math.min(left, 120);                                // about the last 120 km at roughly half speed
    const ms = ((left - last) / v + last / (v * 0.55)) * 3600000, step = 300000;
    return Math.round((Date.now() + ms) / step) * step;
  }
  // Where the plane is in its flight. It changes only once the new state has held for a while, so a plane levelling
  // off for a moment during a climb doesn't make the page flicker between states.
  const PHASE_HOLD = 20000;
  function phase(a) {
    if (!Pl.phase || Object.keys(Pl.phase).length > 400) Pl.phase = {};
    const vr = a.vrate, alt = a.alt;
    let now = null;
    if (alt != null && alt <= 0) now = 'ground';
    else if (a.sel_alt != null && alt != null && Math.abs(a.sel_alt - alt) > 1500) now = a.sel_alt > alt ? 'climb' : 'descend';
    else if (vr != null && vr > 700) now = 'climb';
    else if (vr != null && vr < -700) now = 'descend';
    else if (vr != null && Math.abs(vr) < 300) now = alt != null && alt > 18000 ? 'cruise' : 'level';
    const m = Pl.phase[a.icao] || (Pl.phase[a.icao] = { p: now, cand: now, since: Date.now() });
    if (now == null || now === m.p) { m.cand = m.p; return m.p; }
    if (now !== m.cand) { m.cand = now; m.since = Date.now(); }
    if (m.p == null || Date.now() - m.since >= PHASE_HOLD) m.p = now;
    return m.p;
  }
  const countryName = cc => { if (!cc) return ''; try { return new Intl.DisplayNames([RS.lang || 'en', 'en'], { type: 'region' }).of(String(cc).toUpperCase()) || cc; } catch (e) { return cc; } };

  // altitude colours, a smooth scale from orange (low) through green and blue to purple (high); grey on the ground
  function altColor(alt, cat) {
    if (alt == null) return '#9aa3ad';
    if (alt <= 0 || /ground/i.test(cat || '')) return '#8a8f98';
    const k = Math.pow(Math.min(Math.max(alt, 0), 42000) / 42000, 0.75), h = 22 + k * 270;
    return 'hsl(' + Math.round(h) + ' 78% ' + (h > 200 && h < 260 ? 58 : 50) + '%)';
  }
  Pl.altColor = altColor;

  // ---------------------------------------------------------------- the page
  Pl.init = () => {
    $('#p-planes').innerHTML = `
    <div class="page-head"><h2>Planes</h2><p>Aircraft broadcast where they are every second. The radio picks that up and puts them on the map. A clear view of the sky helps.</p></div>
    <section class="pl-bar glass kx-static" aria-live="polite">
      <span class="sen-led" id="pl-led"></span>
      <div class="sen-bar-t"><b id="pl-st">Starting the plane tracker</b><small id="pl-st2">Radio sound is off here unless you listen to air traffic.</small></div>
      <button class="btn" type="button" data-act="pl-goair">${icon('sound')}<span>Listen to air traffic</span></button>
    </section>
    <div id="pl-alert"></div>
    <div class="pl-app">
      <div class="pl-mapwrap kx-static">
        <div class="map pl-map" id="pl-map"></div>
        <div class="pl-mtools" role="group" aria-label="Map">
          <button class="btn small" type="button" data-pl-opt="tiles" aria-pressed="false" title="Show the map underneath (needs internet on this device)">Map</button>
          <button class="btn small" type="button" data-pl-opt="trails" aria-pressed="true">Trails</button>
          <button class="btn small" type="button" data-pl-opt="labels" aria-pressed="true">Labels</button>
          <button class="btn small" type="button" data-pl-opt="outline" aria-pressed="true" title="How far your radio has heard planes, in every direction">Range</button>
          <button class="btn small" type="button" data-act="pl-fit">Fit all</button>
        </div>
        <div class="pl-legend" aria-hidden="true"><i></i><span>Ground</span><span>10,000</span><span>20,000</span><span>30,000</span><span>40,000 ft</span></div>
        <div class="pl-replay" id="pl-replay">
          <button class="btn small" type="button" data-act="pl-rp" id="pl-rp-b">${icon('clock')}<span>Past hour</span></button>
          <div class="pl-rp-ctl" id="pl-rp-ctl" hidden>
            <button class="btn small" type="button" data-act="pl-rp-play" id="pl-rp-play" aria-label="Play or pause">${icon('pause')}</button>
            <input type="range" id="pl-rp-pos" min="0" max="0" value="0" aria-label="Time in the replay">
            <span class="pl-rp-t" id="pl-rp-t"></span>
            <button class="btn small primary" type="button" data-act="pl-rp-live">Live</button>
          </div>
        </div>
      </div>
      <aside class="pl-side card kx-static" id="pl-side">
        <div id="pl-lv">
          <div class="pl-side-h"><h3>Aircraft</h3><span class="sub" id="pl-count"></span></div>
          <span class="locp-in pl-q">${icon('search')}<input type="search" id="pl-q" placeholder="Flight, airline, registration or type" autocomplete="off"></span>
          <div class="pl-filters" role="group" aria-label="Show">
            ${[['all', 'All'], ['near', 'Within 50 km'], ['low', 'Low'], ['big', 'Airliners'], ['light', 'Light and helicopters'], ['mil', 'Military'], ['said', 'Talking']].map(f => '<button type="button" class="chip" data-pl-f="' + f[0] + '" aria-pressed="' + (f[0] === 'all') + '">' + f[1] + '</button>').join('')}
          </div>
          <div class="pl-sort"><label for="pl-sortby">Sort</label><select id="pl-sortby"><option value="dist">Closest</option><option value="alt">Highest</option><option value="speed">Fastest</option><option value="new">Newest</option><option value="name">Flight</option></select></div>
          <div class="pl-list" id="pl-rows" data-stagger role="list"></div>
        </div>
        <div id="pl-dv" hidden></div>
      </aside>
    </div>
    <div class="pl-lower">
      <section class="card kx-static" id="pl-recv">
        <div class="card-head"><div><h3>Your receiver</h3><div class="sub">What the radio has picked up</div></div></div>
        <div class="pl-tiles" id="pl-stats"></div>
        <figure class="pl-fig"><figcaption>Aircraft heard over the past hour</figcaption><canvas id="pl-hour" aria-label="Aircraft over the past hour"></canvas></figure>
        <figure class="pl-fig pl-cover"><figcaption>How far you can hear, in each direction ${RS.hint ? RS.hint('For every direction, the farthest plane the radio has picked up. A short reach one way usually means a building, hill or wall is in the way.') : ''}</figcaption>
          <canvas id="pl-cover" aria-label="Farthest plane heard in each direction"></canvas></figure>
        <div class="row tight pl-dl"><a class="btn small ghost" href="/api/export/aircraft.csv">Download planes (CSV)</a><a class="btn small ghost" href="/api/export/aircraft.kml">Open in Google Earth (KML)</a><button class="btn small ghost" type="button" data-act="pl-cover-reset">Start the range chart again</button></div>
        <details class="more adv-only"><summary>Tracker settings</summary>
          <label class="field">Tuner gain for planes (dB) <span class="hint">Plane signals are weak; high gain is normal. 49.6 is the maximum.</span><div class="slider-row"><span class="end">0</span><input type="range" id="pl-gain" min="0" max="49.6" step="0.1"><span class="end" id="pl-gain-v"></span></div></label>
          <button class="btn small ghost" type="button" data-act="pl-clear">Forget the planes heard so far</button></details>
      </section>
      <section class="card kx-static" id="pl-air"></section>
    </div>`;
    const mp = Pl.map = new RS.Map($('#pl-map'), { zoom: 8, draw: drawMap, onPick: it => { pick(it ? it.icao : null, false); } });
    // map options
    RS.$$('[data-pl-opt]').forEach(b => {
      const k = b.dataset.plOpt, on = k === 'tiles' ? mp.tiles : !!opt(k);
      b.setAttribute('aria-pressed', String(on));
      b.onclick = () => { const v = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(v)); if (k === 'tiles') mp.setTiles(v); else setOpt(k, v); mp.dirty = true; };
    });
    RS.$$('[data-pl-f]').forEach(b => b.onclick = () => { Pl.filterBy = b.dataset.plF; RS.$$('[data-pl-f]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); Pl.rows(true); });
    $('#pl-q').oninput = () => Pl.rows(true);
    $('#pl-sortby').value = RS.store.get('pl_sort', 'dist');
    $('#pl-sortby').onchange = e => { RS.store.set('pl_sort', e.target.value); Pl.rows(true); };
    $('#pl-rp-pos').oninput = e => { Pl.replay.i = +e.target.value; Pl.replay.playing = false; playIcon(); showFrame(); };
    // hover: the map highlights the row and the row highlights the plane
    mp.cv.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      const r = mp.cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = 18; mp.hit.forEach(h => { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; best = h.item; } });
      const id = best ? best.icao : null; mp.cv.style.cursor = id ? 'pointer' : '';
      if (id !== Pl.hover) { Pl.hover = id; mp.dirty = true; hoverRows(); }
    });
    mp.cv.addEventListener('pointerleave', () => { if (Pl.hover) { Pl.hover = null; mp.dirty = true; hoverRows(); } });
    $('#pl-rows').addEventListener('pointerover', e => { const r = e.target.closest('.pl-row'); const id = r ? r.dataset.id : null; if (id !== Pl.hover) { Pl.hover = id; mp.dirty = true; } });
    $('#pl-rows').addEventListener('pointerleave', () => { Pl.hover = null; mp.dirty = true; });
    // data
    RS.on('aircraft', m => {
      Pl.live = m.list; RS.cover = m.cover || RS.cover;
      (m.list || []).forEach(a => { if (a.mil && !seenMil.has(a.icao)) { seenMil.add(a.icao); if (seenMil.size > 1 || RS.page === 'planes') milNote(a); } });
      if (Pl.replay) return;
      Pl.list = m.list; Pl.stats = m.stats; Pl.home = m.home;
      if (RS.page === 'planes') Pl.update();
    });
    const g = $('#pl-gain');
    RS.scale && RS.scale(g, { unit: 'dB', ticks: [0, 20, 40, 49.6], zones: [[0, 'Low', 'only for very strong, close signals'], [20, 'Medium', 'general use'], [38, 'High', 'normal for planes; weak signals']] });
    g.oninput = e => RS.setText($('#pl-gain-v'), e.target.value + ' dB');
    g.onchange = e => RS.api('config', { changes: { adsb_gain_db: parseFloat(e.target.value) } });
    RS.on('hello', () => { if (!Pl.centred && RS.page === 'planes') Pl.enter(); });
    RS.on('hello', () => { g.value = RS.cfg.adsb_gain_db; g._scaleUpd && g._scaleUpd(); RS.setText($('#pl-gain-v'), RS.cfg.adsb_gain_db + ' dB'); });
    window.addEventListener('resize', () => { if (RS.page === 'planes') { drawHour(); drawCover(); } });
    const loop = () => { if (RS.page === 'planes') { if (Pl.follow && !Pl.replay) followSel(); mp.loop(); } requestAnimationFrame(loop); }; loop();
    setInterval(() => { if (RS.page === 'planes') { loadHour(); } }, 60000);
    setInterval(() => {                                                    // "last heard" keeps moving; the flight so far refreshes
      if (RS.page !== 'planes' || !Pl.sel) return; detail();
      const a = Pl.list.find(x => x.icao === Pl.sel); if (a && !Pl.replay) { info(a).then(detail); loadTrace(a); }
    }, 5000);
  };
  Pl.enter = () => {
    Pl.t0 = Date.now(); const c = RS.cfg; Pl.home = Pl.home || [c.lat, c.lon];
    const a = Pl.sel && Pl.list.find(x => x.icao === Pl.sel);
    const known = Number.isFinite(+c.lat) && Number.isFinite(+c.lon) && c.lat != null;     // before the first hello the location isn't known yet
    if (!Pl.centred) { if (a && a.lat != null) { Pl.map.setView(a.lat, a.lon, 9); Pl.centred = true; } else if (known) { Pl.map.setView(+c.lat, +c.lon, 8); Pl.centred = true; } }
    Pl.map.dirty = true; Pl.update(); loadHour(); setTimeout(drawCover, 50);
    if (Pl.sel) show(true);
  };
  Pl.leave = () => { if (Pl.replay) RS.act['pl-rp-live'](); };

  // ---------------------------------------------------------------- the map
  function shape(g, a, s) {
    const c = a.cat || '';
    g.beginPath();
    if (/helicopter/i.test(c)) {
      g.ellipse(0, 1, 3.6 * s, 6 * s, 0, 0, 7); g.moveTo(0, 6 * s); g.lineTo(0, 12 * s);
      g.moveTo(-10 * s, -2 * s); g.lineTo(10 * s, 2 * s); g.moveTo(-2 * s, 10 * s); g.lineTo(2 * s, 14 * s);
      return 'rotor';
    }
    if (/light|small|glider|ultralight/i.test(c)) {            // straight wings, small body
      g.moveTo(0, -9 * s); g.lineTo(1.6 * s, -4 * s); g.lineTo(11 * s, -3 * s); g.lineTo(11 * s, -0.5 * s); g.lineTo(1.6 * s, 0); g.lineTo(1.2 * s, 7 * s);
      g.lineTo(4.5 * s, 8.5 * s); g.lineTo(4.5 * s, 10 * s); g.lineTo(-4.5 * s, 10 * s); g.lineTo(-4.5 * s, 8.5 * s); g.lineTo(-1.2 * s, 7 * s); g.lineTo(-1.6 * s, 0);
      g.lineTo(-11 * s, -0.5 * s); g.lineTo(-11 * s, -3 * s); g.lineTo(-1.6 * s, -4 * s); g.closePath(); return 'fill';
    }
    if (/ground/i.test(c)) { g.rect(-4 * s, -6 * s, 8 * s, 12 * s); return 'fill'; }
    const k = /large|heavy/i.test(c) ? 1.3 : 1;                 // swept wings; bigger for large airliners
    const q = s * k;
    g.moveTo(0, -12 * q); g.lineTo(2.2 * q, -4 * q); g.lineTo(12 * q, 3 * q); g.lineTo(12 * q, 5.5 * q); g.lineTo(2.2 * q, 2.5 * q); g.lineTo(1.8 * q, 8 * q); g.lineTo(5 * q, 10.5 * q);
    g.lineTo(5 * q, 12 * q); g.lineTo(0, 10.8 * q); g.lineTo(-5 * q, 12 * q); g.lineTo(-5 * q, 10.5 * q); g.lineTo(-1.8 * q, 8 * q); g.lineTo(-2.2 * q, 2.5 * q); g.lineTo(-12 * q, 5.5 * q);
    g.lineTo(-12 * q, 3 * q); g.lineTo(-2.2 * q, -4 * q); g.closePath(); return 'fill';
  }
  function drawMap(g, w, h, tiles) {
    const mp = Pl.map, home = Pl.home || [RS.cfg.lat, RS.cfg.lon], hp = mp.proj(home[0], home[1]), kmpx = mp.kmPx();
    const ink = tiles ? '#14202a' : (RS.cssv('--inst-ink') || '#e8eef2'), halo = tiles ? '#ffffffd0' : '#000000a0';
    const font = RS.cssv('--f-body') || 'sans-serif', mono = RS.cssv('--f-code') || 'monospace';
    // range rings
    const ringKm = [25, 50, 100, 200, 400].find(k => k / kmpx > 80) || 400;
    g.lineWidth = 1; g.font = '11px ' + font; g.textAlign = 'left';
    for (let k = ringKm; k / kmpx < Math.max(w, h) * 1.2 && k <= ringKm * 6; k += ringKm) {
      g.strokeStyle = tiles ? '#0000002a' : '#ffffff1f'; g.beginPath(); g.arc(hp.x, hp.y, k / kmpx, 0, 7); g.stroke();
      g.fillStyle = tiles ? '#334' : '#ffffff80'; g.fillText((imp() ? N(k * 0.6214) + ' mi' : k + ' km'), hp.x + 5, hp.y - k / kmpx + 13);
    }
    // how far the radio has heard, in each direction
    const cov = RS.cover || [];
    if (opt('outline') && cov.some(x => x > 0)) {
      // an arc at the farthest distance for every 10-degree direction that has heard a plane, joined to its neighbours;
      // directions with nothing yet are left open rather than pulled in to the middle
      g.setLineDash([5, 4]); g.strokeStyle = tiles ? '#d97706' : '#f5b04a'; g.lineWidth = 1.5;
      const P = (deg, r) => [hp.x + Math.sin(deg * Math.PI / 180) * r, hp.y - Math.cos(deg * Math.PI / 180) * r];
      for (let j = 0; j < 36; j++) {
        const km = cov[j] || 0; if (!km) continue; const r = km / kmpx;
        g.beginPath(); g.arc(hp.x, hp.y, r, (j * 10 - 90) * Math.PI / 180, ((j + 1) * 10 - 90) * Math.PI / 180); g.stroke();
        const nk = cov[(j + 1) % 36] || 0;
        if (nk) { const a1 = P((j + 1) * 10, r), a2 = P((j + 1) * 10, nk / kmpx); g.beginPath(); g.moveTo(a1[0], a1[1]); g.lineTo(a2[0], a2[1]); g.stroke(); }
      }
      g.setLineDash([]);
    }
    // you
    g.fillStyle = RS.cssv('--pri') || '#0d6e7b'; g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.beginPath(); g.arc(hp.x, hp.y, 6, 0, 7); g.fill(); g.stroke();
    const iso = Pl.isolate && Pl.sel, trails = opt('trails'), labels = opt('labels');
    drawRoute(g, mp, tiles, ink, halo, font);
    const order = Pl.list.slice().sort((a, b) => (a.icao === Pl.sel) - (b.icao === Pl.sel) || (a.alt || 0) - (b.alt || 0));
    order.forEach(a => {
      if (a.lat == null) return;
      const p = mp.proj(a.lat, a.lon), sel = a.icao === Pl.sel, hov = a.icao === Pl.hover, dim = iso && !sel;
      g.globalAlpha = dim ? 0.22 : 1;
      if ((trails || sel) && a.trail && a.trail.length > 1) {          // trail, coloured by the height it was at
        g.lineWidth = sel ? 3 : 2; g.lineCap = 'round';
        for (let i = 1; i < a.trail.length; i++) {
          const q0 = mp.proj(a.trail[i - 1][0], a.trail[i - 1][1]), q1 = mp.proj(a.trail[i][0], a.trail[i][1]);
          g.strokeStyle = altColor(a.trail[i][2] != null ? a.trail[i][2] : a.alt, a.cat); g.globalAlpha = (dim ? 0.15 : 0.35 + 0.55 * i / a.trail.length);
          g.beginPath(); g.moveTo(q0.x, q0.y); g.lineTo(q1.x, q1.y); g.stroke();
        }
        const l = a.trail[a.trail.length - 1], ql = mp.proj(l[0], l[1]); g.globalAlpha = dim ? 0.15 : 0.9; g.strokeStyle = altColor(a.alt, a.cat); g.beginPath(); g.moveTo(ql.x, ql.y); g.lineTo(p.x, p.y); g.stroke();
        g.globalAlpha = dim ? 0.22 : 1;
      }
      if (Pl.speaking(a.icao) || Pl.isEmg(a)) { const ph = (Date.now() % 1600) / 1600; g.strokeStyle = Pl.isEmg(a) ? '#e5484d' : '#1bb5c9'; g.lineWidth = 2.5; g.globalAlpha = (1 - ph) * (dim ? 0.3 : 1); g.beginPath(); g.arc(p.x, p.y, 14 + ph * 20, 0, 7); g.stroke(); g.globalAlpha = dim ? 0.22 : 1; mp.dirty = true; }
      if (sel || hov) { g.strokeStyle = sel ? (RS.cssv('--pri') || '#fff') : '#ffffffaa'; g.lineWidth = 2; g.beginPath(); g.arc(p.x, p.y, 17, 0, 7); g.stroke(); }
      g.save(); g.translate(p.x, p.y); g.rotate(((a.heading == null ? 0 : a.heading)) * Math.PI / 180);
      const kind = shape(g, a, sel ? 1.15 : 1);
      g.lineJoin = 'round';
      if (kind === 'rotor') { g.strokeStyle = altColor(a.alt, a.cat); g.lineWidth = 2.2; g.stroke(); }
      else { g.fillStyle = altColor(a.alt, a.cat); g.strokeStyle = tiles ? '#00000099' : '#000000b0'; g.lineWidth = 1.1; g.fill(); g.stroke(); }
      g.restore();
      if (a.callsign && !dim && (sel || hov || (labels && mp.z >= 7))) {
        const t1 = name(a), t2 = a.alt != null ? (a.alt <= 0 ? 'ground' : Math.round(a.alt / 100) * 100 >= 18000 ? 'FL' + Math.round(a.alt / 100) : N(a.alt) + ' ft') : '';
        g.font = '600 12px ' + mono; g.textAlign = 'left'; g.lineWidth = 3; g.strokeStyle = halo; g.fillStyle = ink;
        g.strokeText(t1, p.x + 14, p.y - 4); g.fillText(t1, p.x + 14, p.y - 4);
        if (t2) { g.font = '11px ' + mono; g.strokeText(t2, p.x + 14, p.y + 10); g.fillText(t2, p.x + 14, p.y + 10); }
      }
      g.globalAlpha = 1;
      mp.hit.push({ x: p.x, y: p.y, item: a });
    });
    // planes outside the view: an arrow at the edge, pointing at them
    const pad = 16;
    Pl.list.forEach(a => {
      if (a.lat == null || (iso && a.icao !== Pl.sel)) return; const p = mp.proj(a.lat, a.lon);
      if (p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h) return;
      const cx = w / 2, cy = h / 2, dx = p.x - cx, dy = p.y - cy, k = Math.min((cx - pad) / Math.abs(dx || 1e-9), (cy - pad) / Math.abs(dy || 1e-9)), ex = cx + dx * k, ey = cy + dy * k;
      g.save(); g.translate(ex, ey); g.rotate(Math.atan2(dy, dx) + Math.PI / 2); g.fillStyle = altColor(a.alt, a.cat); g.strokeStyle = '#000a'; g.lineWidth = 1.1;
      g.beginPath(); g.moveTo(0, -7); g.lineTo(5.5, 5.5); g.lineTo(-5.5, 5.5); g.closePath(); g.fill(); g.stroke(); g.restore();
      mp.hit.push({ x: ex, y: ey, item: a });
    });
  }
  // the chosen plane's journey: the path it has flown (from the adsb.lol network, beyond your receiver's range),
  // the great circle still to fly, and the two airports
  function drawRoute(g, mp, tiles, ink, halo, font) {
    const a = Pl.sel && Pl.list.find(x => x.icao === Pl.sel); if (!a || a.lat == null) return;
    const r = routeOf(a), tr = (Pl.trace[a.icao] || {}).points || [];
    g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
    if (tr.length > 1) {
      g.lineWidth = 2.5; g.globalAlpha = 0.6;
      for (let i = 1; i < tr.length; i++) {
        const q0 = mp.proj(tr[i - 1][1], tr[i - 1][2]), q1 = mp.proj(tr[i][1], tr[i][2]);
        g.strokeStyle = altColor(tr[i][3] != null ? tr[i][3] : a.alt); g.beginPath(); g.moveTo(q0.x, q0.y); g.lineTo(q1.x, q1.y); g.stroke();
      }
    }
    g.globalAlpha = 1;
    if (r) {
      const line = (la1, lo1, la2, lo2) => { const P = gcPath(la1, lo1, la2, lo2, 64); g.beginPath(); P.forEach((p, i) => { const q = mp.proj(p[0], p[1]); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); }); g.stroke(); };
      g.strokeStyle = tiles ? '#1f2937aa' : '#ffffffb0'; g.lineWidth = 1.6; g.setLineDash([6, 5]);
      if (hasLL(r.destination)) line(a.lat, a.lon, r.destination.lat, r.destination.lon);
      if (hasLL(r.origin) && tr.length < 2) { g.globalAlpha = 0.45; line(r.origin.lat, r.origin.lon, a.lat, a.lon); g.globalAlpha = 1; }
      g.setLineDash([]);
      [r.origin, ...(r.stops || []), r.destination].forEach((x, i, all) => {
        if (!hasLL(x)) return; const q = mp.proj(x.lat, x.lon), end = i === all.length - 1;
        g.fillStyle = end ? (RS.cssv('--pri') || '#0d6e7b') : (tiles ? '#475569' : '#cbd5e1'); g.strokeStyle = tiles ? '#fff' : '#000'; g.lineWidth = 2;
        g.beginPath(); g.arc(q.x, q.y, 5, 0, 7); g.fill(); g.stroke();
        g.font = '700 12px ' + font; g.textAlign = 'left'; g.lineWidth = 3; g.strokeStyle = halo; g.fillStyle = ink;
        g.strokeText(apCode(x), q.x + 9, q.y + 4); g.fillText(apCode(x), q.x + 9, q.y + 4);
      });
    }
    g.restore();
  }
  // a minute between asks while a plane is chosen: the network's track of its flight so far
  async function loadTrace(a) {
    const c = Pl.trace[a.icao]; if (c && Date.now() - c.t < 60000) return;
    Pl.trace[a.icao] = Object.assign(c || { points: [] }, { t: Date.now() });
    try { const r = await RS.api('planes/trace?icao=' + encodeURIComponent(a.icao)); Pl.trace[a.icao] = Object.assign(r, { t: Date.now() }); } catch (e) { }
    Pl.map.dirty = true; if (Pl.sel === a.icao) detail();
  }
  RS.act['pl-route-fit'] = () => {
    const a = Pl.list.find(x => x.icao === Pl.sel), r = a && routeOf(a); if (!a || !r) return;
    const pts = [r.origin, r.destination, ...(r.stops || [])].filter(hasLL).map(x => [x.lat, x.lon]).concat(a.lat != null ? [[a.lat, a.lon]] : []);
    Pl.follow = false; fitTo(pts);
  };
  function fitTo(pts) {
    const mp = Pl.map; if (!mp || !pts.length) return; const la = pts.map(x => x[0]), lo = pts.map(x => x[1]);
    mp.setView((Math.min(...la) + Math.max(...la)) / 2, (Math.min(...lo) + Math.max(...lo)) / 2, 12);
    const w = mp.cv.clientWidth, h = mp.cv.clientHeight;
    for (let z = 12; z >= 2; z--) { mp.z = z; if (pts.every(q => { const p = mp.proj(q[0], q[1]); return p.x > 30 && p.x < w - 30 && p.y > 30 && p.y < h - 30; })) break; }
    mp.dirty = true;
  }
  Pl.fitAll = () => {
    fitTo(Pl.list.filter(a => a.lat != null).map(a => [a.lat, a.lon]).concat([Pl.home || [RS.cfg.lat, RS.cfg.lon]]));
  };
  function followSel() {
    const a = Pl.list.find(x => x.icao === Pl.sel);
    if (!a || a.lat == null) return;
    const mp = Pl.map; if (Math.abs(mp.lat - a.lat) > 1e-5 || Math.abs(mp.lon - a.lon) > 1e-5) { mp.lat += (a.lat - mp.lat) * 0.2; mp.lon += (a.lon - mp.lon) * 0.2; mp.dirty = true; }
  }

  // ---------------------------------------------------------------- status strip and receiver
  function status() {
    const st = RS.st || {}, s = Pl.stats || {}, L = Pl.list, led = $('#pl-led'); if (!led) return;
    const pos = L.filter(a => a.lat != null).length;
    let t, t2, cls;
    if (Pl.replay) { t = 'Replaying the past hour'; t2 = 'Press Live to go back to now.'; cls = 'on'; }
    else if (!RS.connected) { t = 'Not connected'; t2 = 'Trying to reach Skywave.'; cls = 'off'; }
    else if (st.air && st.air.phase === 'listen') { t = 'Listening to air traffic'; t2 = 'The map pauses while the radio listens, then goes back to tracking.'; cls = 'live'; }
    else if (st.job !== 'adsb') { t = 'Starting the plane tracker'; t2 = 'Radio sound is off here unless you listen to air traffic.'; cls = 'wait'; }
    else if (!L.length) { t = 'Watching the sky'; t2 = Date.now() - Pl.t0 > 25000 ? 'Nothing yet. Check the antenna is connected, upright and near a window.' : 'Planes appear when there is a clear line to them. Give it a minute.'; cls = 'on'; }
    else { t = L.length + ' aircraft' + (pos < L.length ? ', ' + pos + ' on the map' : ''); t2 = (s.rate != null ? N(s.rate) + ' messages a second' : '') + (s.max_range_km ? ' · farthest heard ' + dist(s.max_range_km) : ''); cls = 'live'; }
    RS.setText($('#pl-st'), t); RS.setText($('#pl-st2'), t2);
    if (led.dataset.s !== cls) led.dataset.s = cls;
    const tiles = [[L.length, 'aircraft now'], [pos, 'on the map'], [s.rate != null ? N(s.rate) : '-', 'messages a second'], [s.max_range_km ? dist(s.max_range_km) : '-', 'farthest heard']];
    const h = tiles.map(x => '<div><b>' + x[0] + '</b><span>' + x[1] + '</span></div>').join('');
    const el = $('#pl-stats'); if (el && el._h !== h) { el._h = h; el.innerHTML = h; }
  }
  let hourFrames = [];
  async function loadHour() {
    try { const r = await fetch('/api/planes/history').then(x => x.json()); hourFrames = (r && r.frames) || []; } catch (e) { hourFrames = []; }
    drawHour();
  }
  function drawHour() {
    const cv = $('#pl-hour'); if (!cv) return; const c = RS.fit(cv); if (!c) return; const g = c.g, w = c.w, h = c.h; g.clearRect(0, 0, w, h);
    const now = Date.now() / 1000, t0 = now - 3600, F = hourFrames.filter(f => f[0] >= t0);
    const font = RS.cssv('--f-body') || 'sans-serif', muted = RS.cssv('--ink-3') || '#888', col = RS.cssv('--accent') || '#2a9d8f';
    g.font = '11px ' + font; g.fillStyle = muted;
    if (F.length < 2) { g.fillText('Fills in while Planes is open: a count every 10 seconds.', 0, h / 2); return; }
    const max = Math.max(4, ...F.map(f => f[1].length)), X = t => (t - t0) / 3600 * w, Y = v => h - 16 - v / max * (h - 28);
    g.strokeStyle = RS.cssv('--stroke') || '#8883'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, h - 15.5); g.lineTo(w, h - 15.5); g.stroke();
    [60, 45, 30, 15].forEach(m => g.fillText(m + ' min ago', X(now - m * 60) + 2, h - 3)); g.fillText('now', w - 22, h - 3);
    g.fillText(max + ' aircraft', 0, 10);
    g.beginPath(); F.forEach((f, i) => { const x = X(f[0]), y = Y(f[1].length); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.strokeStyle = col; g.lineWidth = 1.8; g.lineJoin = 'round'; g.stroke();
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, col + '33'); gr.addColorStop(1, col + '00');
    g.lineTo(X(F[F.length - 1][0]), h - 16); g.lineTo(X(F[0][0]), h - 16); g.closePath(); g.fillStyle = gr; g.fill();
  }
  function drawCover() {
    const cv = $('#pl-cover'); if (!cv) return; const c = RS.fit(cv); if (!c) return;
    const g = c.g, w = c.w, h = c.h, cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 18, cov = RS.cover || new Array(36).fill(0);
    const max = Math.max.apply(null, cov.concat([50])), top = [50, 100, 150, 200, 250, 300, 400, 500, 600].find(x => x >= max) || 600;
    const font = RS.cssv('--f-body') || 'sans-serif', muted = RS.cssv('--ink-3') || '#888', stroke = RS.cssv('--stroke') || '#8884', col = '#f5a524';
    g.clearRect(0, 0, w, h); g.lineWidth = 1; g.strokeStyle = stroke; g.font = '11px ' + font; g.fillStyle = muted; g.textAlign = 'left';
    [1, 2, 3].forEach(k => { g.beginPath(); g.arc(cx, cy, R * k / 3, 0, 7); g.stroke(); g.fillText(dist(top * k / 3), cx + 3, cy - R * k / 3 + 11); });
    g.beginPath();
    for (let i = 0; i <= 36; i++) { const j = i % 36, r = R * Math.min((cov[j] || 0) / top, 1), a = (j * 10 + 5 - 90) * Math.PI / 180; i ? g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r) : g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
    g.closePath(); g.fillStyle = col + '40'; g.fill(); g.strokeStyle = col; g.lineWidth = 1.6; g.stroke();
    g.fillStyle = RS.cssv('--ink') || '#000'; g.font = '600 12px ' + font; g.textAlign = 'center'; g.textBaseline = 'middle';
    [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]].forEach(d => g.fillText(d[0], cx + d[1] * (R + 10), cy + d[2] * (R + 10)));
    g.textBaseline = 'alphabetic';
  }
  RS.act['pl-cover-reset'] = () => RS.confirm('Start the range chart again?', 'It forgets the farthest planes heard so far.', 'Start again', () => { RS.send({ cmd: 'reset_cover' }); RS.cover = new Array(36).fill(0); drawCover(); Pl.map.dirty = true; });

  // ---------------------------------------------------------------- the list
  const ORDER = {
    dist: (a, b) => (a.dist_km == null) - (b.dist_km == null) || (a.dist_km || 0) - (b.dist_km || 0),
    alt: (a, b) => (b.alt || -1) - (a.alt || -1), speed: (a, b) => (b.speed || -1) - (a.speed || -1),
    new: (a, b) => (b.first || 0) - (a.first || 0), name: (a, b) => name(a).localeCompare(name(b)),
  };
  Pl.pass = a => {
    switch (Pl.filterBy) {
      case 'big': return /airliner|heavy/i.test(a.cat || '') || (a.speed != null && a.speed > 250 && (a.alt || 0) > 15000);
      case 'low': return a.alt != null && a.alt < 10000;
      case 'near': return a.dist_km != null && a.dist_km <= 50;
      case 'light': return /light|small|helicopter|glider|ultralight/i.test(a.cat || '');
      case 'said': return !!Pl.spoke[a.icao];
      case 'mil': return !!a.mil;
      default: return true;
    }
  };
  function matches(a, q) {
    if (!q) return true; const i = Pl.info[a.icao], ac = i && i.aircraft, r = i && i.route;
    return [a.callsign, a.icao, a.squawk, RS.airline && RS.airline(a.callsign), ac && ac.registration, ac && ac.type, ac && ac.icao_type, ac && ac.registered_owner,
      modelOf(a), r && r.flight, r && r.airline, ...(r && r.origin ? [r.origin.city, r.origin.iata, r.origin.name] : []),
      ...(r && r.destination ? [r.destination.city, r.destination.iata, r.destination.name] : [])].some(x => x && String(x).toLowerCase().includes(q));
  }
  function row(a) {
    const tr = trend(a), badges = (Pl.isEmg(a) ? '<em class="pl-b emg">Emergency</em>' : '') + (Pl.speaking(a.icao) ? '<em class="pl-b talk">Talking</em>' : '') + (a.mil ? '<em class="pl-b mil">Military?</em>' : '');
    return '<button class="pl-row' + (a.icao === Pl.sel ? ' on' : '') + (a.lat == null ? ' nopos' : '') + '" role="listitem" type="button" data-act="pl-pick" data-id="' + a.icao + '" style="--alt:' + altColor(a.alt, a.cat) + '">' +
      '<span class="pl-row-t"><b>' + esc(name(a)) + badges + '</b><small>' + esc(typeLine(a)) + '</small></span>' +
      '<span class="pl-row-a"><span>' + esc(altTxt(a)) + (tr ? '<i class="pl-tr ' + tr + '" aria-label="' + (tr === 'up' ? 'climbing' : 'descending') + '"></i>' : '') + '</span><small>' + esc(spd(a.speed)) + '</small></span>' +
      '<span class="pl-row-d">' + esc(dist(a.dist_km)) + '<small>' + (a.bearing != null ? esc(dirOf(a.bearing)) : a.lat == null ? 'no position yet' : '') + '</small></span></button>';
  }
  let rowsAt = 0;
  Pl.rows = force => {
    const el = $('#pl-rows'); if (!el) return;
    if (!force && performance.now() - rowsAt < 900) return; rowsAt = performance.now();
    const q = ($('#pl-q').value || '').trim().toLowerCase(), so = $('#pl-sortby').value || 'dist';
    const all = Pl.list, L = all.filter(Pl.pass).filter(a => matches(a, q)).sort(ORDER[so] || ORDER.dist);
    RS.setText($('#pl-count'), all.length ? (L.length === all.length ? String(all.length) : L.length + ' of ' + all.length) : '');
    const h = L.length ? L.slice(0, 80).map(row).join('')
      : '<div class="sen-empty"><b>' + (all.length ? 'Nothing matches' : Pl.replay ? 'No aircraft at this moment' : 'No planes yet') + '</b><span>' +
        (all.length ? 'Try another search or filter.' : RS.st.job !== 'adsb' && !Pl.replay ? 'Starting the plane tracker.' : Date.now() - Pl.t0 > 25000 ? 'Check the antenna is connected, upright and near a window. Planes only show up when there is a clear line to them.' : 'Give it a minute. Planes only show up when they are in line of sight.') + '</span></div>';
    if (el._h !== h) { el._h = h; el.innerHTML = h; hoverRows(); }
    queueInfo(L.slice(0, 12));
  };
  function hoverRows() { RS.$$('#pl-rows .pl-row').forEach(r => r.classList.toggle('hov', r.dataset.id === Pl.hover)); }

  // ---------------------------------------------------------------- details of the chosen plane
  async function info(a, force) {
    // asked again once the callsign arrives or changes: the route belongs to the callsign, not the aircraft
    const k = a.icao, c = Pl.info[k], cs = a.callsign || '';
    if (c && !force && c.cs === cs && (c.ok || Date.now() - c.t < 60000)) return c;
    // the chosen plane may also have its takeoff airport looked up, which settles a route the sources disagree on
    const where = (a.lat != null ? '&lat=' + a.lat.toFixed(3) + '&lon=' + a.lon.toFixed(3) : '') + (k === Pl.sel ? '&chosen=1' : '');
    try { const r = await RS.api('planes/info?icao=' + encodeURIComponent(k) + '&callsign=' + encodeURIComponent(cs) + where); Pl.info[k] = Object.assign(r, { t: Date.now(), cs }); }
    catch (e) { Pl.info[k] = { ok: false, t: Date.now(), cs }; }
    return Pl.info[k];
  }
  // a few list rows at a time get their type and route, one request every 2 seconds, while the page is open
  const want = []; let busy = false, offUntil = 0;
  function queueInfo(L) { L.forEach(a => { const c = Pl.info[a.icao]; if ((!c || c.cs !== (a.callsign || '')) && !want.includes(a)) want.push(a); }); pump(); }
  async function pump() {
    if (busy || !want.length || RS.page !== 'planes' || Date.now() < offUntil) return; busy = true;
    const a = want.shift(); const r = await info(a); if (r && r.ok === false) offUntil = Date.now() + 300000;
    setTimeout(() => { busy = false; Pl.rows(true); pump(); }, 2000);
  }
  function pick(id, centre) {
    Pl.sel = id; Pl.follow = false; Pl.isolate = false;
    if (id && centre) { const a = Pl.list.find(x => x.icao === id); if (a && a.lat != null) Pl.map.setView(a.lat, a.lon); }
    show(!!id); Pl.map.dirty = true; Pl.rows(true);
  }
  Pl.pick = pick;
  function show(on) {
    $('#pl-lv').hidden = on; $('#pl-dv').hidden = !on;
    if (on) { const a = Pl.list.find(x => x.icao === Pl.sel); if (a) { detail(); info(a).then(() => { detail(); Pl.map.dirty = true; }); if (!Pl.replay) loadTrace(a); } else if (!Pl.replay) { Pl.sel = null; $('#pl-lv').hidden = false; $('#pl-dv').hidden = true; } }
    if (on && window.innerWidth <= 900) $('#pl-side').scrollIntoView({ block: 'nearest', behavior: RS.motionOK && !RS.motionOK() ? 'auto' : 'smooth' });
  }
  Pl.showSel = () => { if (Pl.sel) detail(); };
  function detail() {
    const box = $('#pl-dv'), a = Pl.list.find(x => x.icao === Pl.sel); if (!box || box.hidden) return;
    if (!a) { box.innerHTML = '<button class="btn small ghost pl-back" type="button" data-act="pl-back">' + icon('left') + '<span>All aircraft</span></button><div class="sen-empty"><b>Out of range</b><span>' + esc(Pl.sel ? Pl.sel.toUpperCase() : '') + ' has not been heard for a while.</span></div>'; return; }
    const I = Pl.info[a.icao] || {}, ac = I.aircraft || {}, rt = I.route || null, r = routeOf(a), airline = (rt && rt.airline) || (RS.airline && RS.airline(a.callsign)) || '';
    const country = ac.registered_owner_country_name || countryName(ac.registered_owner_country_iso_name) || (RS.countryOf && RS.countryOf(a.icao)) || '';
    const model = modelOf(a);
    const vr = a.vrate == null ? '-' : Math.abs(a.vrate) < 100 ? '0 ft/min' : (a.vrate > 0 ? '+' : '−') + N(Math.abs(a.vrate)) + ' ft/min';
    const sq = a.squawk ? a.squawk + ({ 7500: ' (hijack)', 7600: ' (radio failure)', 7700: ' (emergency)', 1200: ' (VFR)', 7000: ' (VFR)' }[a.squawk] || '') : '-';
    const ago = s => s < 5 ? 'Just now' : s < 60 ? Math.round(s) + ' s ago' : Math.round(s / 60) + ' min ago';
    const hm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const compass = d => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((d % 360) + 360) % 360 / 45) % 8];
    // the journey: where from, where to, how far along, when it should land
    let journey = '';
    if (r) {
      // "T3" -> "Terminal 3", "T3/T4" -> "Terminal 3 or 4"; named terminals ("Domestic Terminal") as they are
      const term = t => !t ? '' : /^T\d+(\/T\d+)?$/.test(t) ? 'Terminal ' + t.replace(/^T/, '').replace('/T', ' or ') : t;
      const end = (x, cls) => '<div class="pl-ap' + cls + '"><b>' + esc(apCode(x)) + '</b><span>' + esc(x.city || x.name || '') + '</span>' +
        (x.terminal ? '<em class="pl-term">' + esc(term(x.terminal) + (x.gate ? ', gate ' + x.gate : '')) + '</em>' : '') +
        '<small>' + esc([x.name !== x.city ? x.name : '', countryName(x.country)].filter(Boolean).join(', ')) + '</small></div>';
      const pg = progress(a, r), stops = (r.stops || []).filter(Boolean), ph = phase(a), place = x => x.city || x.name || apCode(x);
      const to = r.destination, where = { climb: 'Climbing out of ' + place(r.origin), descend: to ? 'Descending into ' + place(to) : 'Descending',
        cruise: to ? 'Cruising to ' + place(to) : 'Cruising', level: to ? 'Flying level towards ' + place(to) : 'Flying level',
        ground: 'On the ground at ' + place(to && pg && pg.left < pg.flown ? to : r.origin) }[ph] || '';
      const unknown = '<div class="pl-ap to pl-ap-none"><b>?</b><span>Unknown</span><small>Not on record yet</small></div>';
      journey = '<section class="pl-jy" aria-label="Route">' +
        (r.kind ? '<p class="pl-jy-kind" data-kind="' + r.kind + '">' + (r.kind === 'domestic' ? 'Domestic flight' : 'International flight') + '</p>' : '') +
        '<div class="pl-jy-ends">' + end(r.origin, '') + '<i aria-hidden="true"></i>' + (to ? end(to, ' to') : unknown) + '</div>' +
        (where ? '<p class="pl-jy-ph" data-phase="' + ph + '">' + esc(where) + '</p>' : '') +
        (pg ? '<div class="pl-jy-bar" role="progressbar" aria-label="Distance flown" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(pg.pct * 100) + '" style="--p:' + pg.pct.toFixed(3) + '"><i></i></div>' +
          '<p class="pl-jy-t">' + esc(dist(pg.flown)) + ' flown · ' + esc(dist(pg.left)) + ' to go' + (pg.eta && pg.left > 5 ? ' · lands about <b>' + esc(hm(pg.eta)) + '</b>' : '') + '</p>' : '') +
        (stops.length ? '<p class="pl-jy-t">Stops at ' + esc(stops.map(x => (x.city || x.name) + ' (' + apCode(x) + ')').join(', ')) + '</p>' : '') +
        '<div class="row tight"><button class="btn small" type="button" data-act="pl-route-fit">' + icon('plane') + '<span>Show the whole route</span></button></div>' +
        '<small class="pl-src">' + (r.source === 'track' ? 'Takeoff airport from the adsb.lol network\'s track of this flight.' : 'Route from ' + esc(r.source || 'adsbdb') + ', checked against where the plane is. Routes are shared by volunteers and can be out of date; arrival is an estimate based on the plane\'s cruising speed.') +
          (r.origin.terminal || (to && to.terminal) ? ' A terminal with a gate is where the plane was seen parked (OpenStreetMap\'s airport maps); one without is where this airline normally goes.' : '') + '</small></section>';
    } else if (I.route && I.route.mismatch) {
      journey = '<p class="pl-note">Today\'s route for ' + esc(I.route.flight || a.callsign) + ' isn\'t on record with any of the route sources yet, and the network didn\'t see where it took off.</p>';
    } else if (a.callsign && I.ok && I.cs === a.callsign) {
      journey = '<p class="pl-note">No route on record for ' + esc(a.callsign) + '. Private, military, cargo and charter flights often have none.</p>';
    }
    const tiles = [['Altitude', altTxt(a) + (trend(a) ? (trend(a) === 'up' ? ' ↑' : ' ↓') : '')], ['Ground speed', spd(a.speed) + (a.speed != null ? '<small>' + N(a.speed) + ' kt</small>' : '')],
      ['Vertical speed', vr], ['Heading', a.heading != null ? N(a.heading) + '° ' + compass(a.heading) : '-'],
      ['From you', a.dist_km != null ? dist(a.dist_km) + '<small>to the ' + dirOf(a.bearing) + '</small>' : 'No position yet'], ['Squawk', sq]]
      .concat(a.ias != null ? [['Airspeed', N(a.ias) + ' kt<small>indicated</small>']] : a.tas != null ? [['Airspeed', N(a.tas) + ' kt<small>true</small>']] : []);
    const facts = [['Registration', ac.registration], ['Aircraft', model || a.cat], ['Variant', ac.type && ac.type !== model ? ac.type : ''], ['Built', ac.year],
      ['Operator', ac.registered_owner], ['Registered in', country], ['Address (ICAO)', a.icao.toUpperCase()], ['Messages', N(a.msgs)], ['Last heard', ago(a.age || 0)],
      ['First heard', a.first ? hm(a.first * 1000) : '-']].filter(x => x[1]);
    const photo = ac.url_photo || ac.url_photo_thumbnail, tr = (Pl.trace[a.icao] || {}).points || [];
    box.innerHTML = '<div class="pl-dv-top"><button class="btn small ghost pl-back" type="button" data-act="pl-back">' + icon('left') + '<span>All aircraft</span></button>' +
      '<span class="pl-dv-act"><button class="btn small' + (Pl.follow ? ' on' : '') + '" type="button" data-act="pl-follow" aria-pressed="' + !!Pl.follow + '">Follow</button>' +
      '<button class="btn small' + (Pl.isolate ? ' on' : '') + '" type="button" data-act="pl-iso" aria-pressed="' + !!Pl.isolate + '">Show only this</button></span></div>' +
      '<div class="pl-dv-h" style="--alt:' + altColor(a.alt, a.cat) + '"><h3>' + esc(name(a)) + (rt && rt.flight && rt.flight !== a.callsign ? ' <span class="pl-fno">' + esc(rt.flight) + '</span>' : '') + '</h3>' +
      '<span>' + esc([airline, model].filter(Boolean).join(' · ') || country || a.cat || 'Aircraft') + '</span>' +
      (Pl.isEmg(a) ? '<em class="pl-b emg">Emergency</em>' : '') + (Pl.speaking(a.icao) ? '<em class="pl-b talk">Talking now</em>' : '') + (a.mil ? '<em class="pl-b mil">Military?</em>' : '') + '</div>' +
      (photo ? '<figure class="pl-photo"><img src="' + esc(photo) + '" alt="' + esc((ac.registration || name(a)) + ', ' + (model || 'aircraft')) + '" referrerpolicy="no-referrer" loading="lazy"><figcaption>Photo: airport-data.com</figcaption></figure>' : '') +
      journey +
      '<div class="sen-kv pl-kv">' + tiles.map(x => '<div><dt>' + x[0] + '</dt><dd>' + x[1] + '</dd></div>').join('') + '</div>' +
      '<figure class="pl-fig pl-prof"><figcaption>Altitude over the last few minutes</figcaption><canvas id="pl-prof"></canvas></figure>' +
      '<dl class="sen-meta">' + facts.map(x => '<div><dt>' + x[0] + '</dt><dd>' + esc(x[1]) + '</dd></div>').join('') + '</dl>' +
      '<p class="pl-src">' + (tr.length > 1 ? 'The map shows the whole flight since takeoff (' + esc(hm(tr[0][0] * 1000)) + '), from tracks shared by the adsb.lol network.' : 'The map shows the part of the flight your radio has heard.') + '</p>' +
      (I.ok === false ? '<p class="pl-note">Registration, model, route and the flight so far need the internet on the computer running Skywave.</p>' : !I.aircraft && I.ok ? '<p class="pl-note">No registration or model on record for this aircraft.</p>' : '') +
      '<div class="row tight pl-out"><a class="btn small ghost" href="https://adsb.lol/?icao=' + a.icao.toLowerCase() + '" target="_blank" rel="noopener noreferrer">Open on adsb.lol</a></div>';
    const im = box.querySelector('.pl-photo img'); if (im) im.addEventListener('error', () => im.closest('figure').remove(), { once: true });
    profile(a);
  }
  function profile(a) {
    const cv = $('#pl-prof'); if (!cv) return; const c = RS.fit(cv); if (!c) return; const g = c.g, w = c.w, h = c.h; g.clearRect(0, 0, w, h);
    const P = (a.trail || []).map(p => p[2]).filter(v => v != null).concat(a.alt != null ? [a.alt] : []);
    const font = RS.cssv('--f-body') || 'sans-serif'; g.font = '11px ' + font; g.fillStyle = RS.cssv('--ink-3') || '#888';
    if (P.length < 2) { cv.closest('figure').hidden = true; return; } cv.closest('figure').hidden = false;
    let lo = Math.min(...P), hi = Math.max(...P); if (hi - lo < 1000) { lo = Math.max(0, lo - 500); hi += 500; }
    const X = i => i / (P.length - 1) * w, Y = v => h - 4 - (v - lo) / (hi - lo) * (h - 18);
    g.fillText(N(hi) + ' ft', 0, 10); g.fillText(N(lo) + ' ft', 0, h - 6);
    g.lineWidth = 2; g.lineJoin = 'round';
    for (let i = 1; i < P.length; i++) { g.strokeStyle = altColor(P[i]); g.beginPath(); g.moveTo(X(i - 1), Y(P[i - 1])); g.lineTo(X(i), Y(P[i])); g.stroke(); }
  }
  RS.act['pl-pick'] = b => pick(b.dataset.id, true);
  RS.act['pl-back'] = () => pick(null, false);
  RS.act['pl-follow'] = () => { Pl.follow = !Pl.follow; detail(); };
  RS.act['pl-iso'] = () => { Pl.isolate = !Pl.isolate; Pl.map.dirty = true; detail(); };
  RS.act['pl-fit'] = () => { Pl.follow = false; Pl.fitAll(); };
  RS.act['pl-home'] = () => Pl.map.setView(RS.cfg.lat, RS.cfg.lon, 8);
  RS.act['pl-goair'] = () => { const c = $('#pl-air'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  RS.act['pl-clear'] = () => { RS.send({ cmd: 'clear_aircraft' }); Pl.list = []; pick(null); Pl.update(); };

  // ---------------------------------------------------------------- update
  Pl.update = () => {
    status(); Pl.rows();
    if (Pl.sel && !$('#pl-dv').hidden) detail();
    if (Pl.alerts) Pl.alerts(); if (Pl.airUi) Pl.airUi();
    if (Pl.map) Pl.map.dirty = true;
    drawCover();
  };
  Pl.state = () => status();

  // ---------------------------------------------------------------- military: a note the first time each is seen
  const seenMil = new Set();
  function milNote(a) {
    const n = name(a) + (RS.countryOf && RS.countryOf(a.icao) ? ' (' + RS.countryOf(a.icao) + ')' : '');
    RS.toast('Possible military aircraft: ' + n + (a.dist_km != null ? ', ' + dist(a.dist_km) + ' away' : ''), 'warn');
    RS.notify && RS.notify('Military aircraft nearby', n);
  }

  // ---------------------------------------------------------------- the past hour, on the map
  const hm = t => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function playIcon() { const b = $('#pl-rp-play'); if (b) b.innerHTML = icon(Pl.replay && Pl.replay.playing ? 'pause' : 'play'); }
  function showFrame() {
    const r = Pl.replay; if (!r) return; const fr = r.frames[r.i]; if (!fr) return;
    const trails = {};
    for (let j = Math.max(0, r.i - 30); j <= r.i; j++) r.frames[j][1].forEach(p => { (trails[p[0]] || (trails[p[0]] = [])).push([p[2], p[3], p[4]]); });
    Pl.list = fr[1].map(p => ({ icao: p[0], callsign: p[1], lat: p[2], lon: p[3], alt: p[4], heading: p[5], mil: !!p[6], speed: null, trail: (trails[p[0]] || []).slice(0, -1),
      dist_km: RS.dist ? Math.round(RS.dist(RS.cfg.lat, RS.cfg.lon, p[2], p[3]).km * 10) / 10 : null }));
    $('#pl-rp-pos').value = r.i;
    RS.setText($('#pl-rp-t'), hm(fr[0]) + ' · ' + Pl.list.length + ' aircraft');
    status(); Pl.rows(true); if (Pl.sel && !$('#pl-dv').hidden) detail(); Pl.map.dirty = true;
  }
  function tick() {
    const r = Pl.replay; if (!r) return;
    if (r.playing) { r.i++; if (r.i >= r.frames.length) { r.i = r.frames.length - 1; r.playing = false; playIcon(); } showFrame(); }
    r.timer = setTimeout(tick, 250);
  }
  RS.act['pl-rp'] = async () => {
    const r = await fetch('/api/planes/history').then(x => x.json()).catch(() => null), frames = (r && r.frames) || [];
    if (frames.length < 2) { RS.toast('Nothing to replay yet. The tracker keeps a picture of the sky every 10 seconds while Planes is open.', 'bad'); return; }
    Pl.replay = { frames, i: 0, playing: true };
    $('#pl-rp-pos').max = frames.length - 1; $('#pl-rp-ctl').hidden = false; $('#pl-rp-b').hidden = true;
    $('#p-planes').classList.add('replaying'); playIcon(); showFrame(); tick();
  };
  RS.act['pl-rp-play'] = () => { const r = Pl.replay; if (!r) return; if (r.i >= r.frames.length - 1) r.i = 0; r.playing = !r.playing; playIcon(); };
  RS.act['pl-rp-live'] = () => {
    const r = Pl.replay; if (r && r.timer) clearTimeout(r.timer);
    Pl.replay = null; Pl.list = Pl.live || [];
    $('#pl-rp-ctl').hidden = true; $('#pl-rp-b').hidden = false; $('#p-planes').classList.remove('replaying');
    Pl.update();
  };
})();
