/* Skywave - the Balloons page: weather balloons (radiosondes) found by scanning 400-406 MHz, on a map with their
   whole flight, the burst point and a rough landing guess. Laid out like Ships and Planes. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc;
  const Bl = RS.pages.sondes = {};
  Bl.list = []; Bl.warned = {}; Bl.sel = null; Bl.tap = {}; Bl.stopped = false; Bl.t0 = 0;
  const tracking = () => RS.st.tap === 'sonde';
  const dirs = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const compass = d => dirs[Math.round(d / 45) % 8];
  const imperial = () => RS.cfg.units === 'imperial';
  const height = m => m == null ? '-' : imperial() ? Math.round(m * 3.281).toLocaleString() + ' ft' : Math.round(m).toLocaleString() + ' m';
  const dist = km => km == null ? '-' : imperial() ? (km * 0.6214).toFixed(km < 10 ? 1 : 0) + ' mi' : km.toFixed(km < 10 ? 1 : 0) + ' km';
  const rate = v => v == null ? '-' : (Math.abs(v) < 0.5 ? 'level' : (v > 0 ? 'rising ' : 'falling ') + Math.abs(v).toFixed(1) + ' m/s');
  const mhz = f => (f / 1e6).toFixed(3) + ' MHz';
  const ago = s => s < 60 ? Math.round(s) + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago';
  const phase = b => b.age > 120 ? 'Signal lost' : b.burst ? (b.climb != null && b.climb < -1 ? 'Falling after burst' : 'Burst') : (b.climb != null && b.climb > 1 ? 'Climbing' : 'Drifting');

  Bl.init = () => {
    $('#p-sondes').innerHTML = `
    <div class="page-head"><h2>Weather balloons</h2><p>Weather services launch balloons every day that carry a small radio, a radiosonde, up to about 30 km. It reports its position, height and speed every second until it lands. Skywave searches the balloon band for them and draws the whole flight.</p></div>
    <div class="banner" id="bl-notice"><div class="txt"><strong>The radio is used for balloons while you are here</strong>It searches 400 to 406 MHz a slice at a time and stays on a balloon once it hears one. Go back to Radio, Scanner or Ham and it switches back automatically.</div></div>
    <div class="card" style="margin-bottom:14px"><div class="stat-row" id="bl-stats"></div><div class="small muted" id="bl-scan" style="margin-top:10px"></div></div>
    <div class="two-col" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)">
      <div class="stack"><div class="map" id="bl-map"></div>
        <div class="row"><label class="check"><input type="checkbox" id="bl-tiles"><span>Show map pictures <span class="muted" style="font-weight:400">(needs internet on this device)</span></span></label><button class="btn small" id="bl-fit" type="button">Show all balloons</button><button class="btn small" data-act="bl-home" type="button">Centre on me</button><button class="btn small" id="bl-go" type="button">Stop</button></div>
        <div class="glass sel-card hide" id="bl-sel"></div></div>
      <div class="card"><div class="card-head"><div><h3>Balloons heard</h3><div class="sub" id="bl-sub">Most recent first</div></div></div>
        <div class="plane-table-wrap"><table class="tbl"><thead><tr><th>Balloon</th><th>Height</th><th>Now</th><th>Distance</th></tr></thead><tbody id="bl-rows"></tbody></table></div>
        <div class="empty hide" id="bl-empty"><strong>No balloons yet</strong><span id="bl-empty-t">Searching. A balloon is on air for about two hours after launch.</span></div></div>
    </div>
    <div class="two-col" style="margin-top:14px">
      <div class="card"><h3>Know the frequency?</h3><div class="sub">If you know where your local launch site transmits, listening on just that channel finds the balloon sooner.</div>
        <div class="row" style="margin-top:10px"><label class="field grow">Frequency in MHz<input id="bl-f" inputmode="decimal" placeholder="for example 401.500"></label><button class="btn" data-act="bl-fixed" type="button">Listen here</button><button class="btn ghost" data-act="bl-scanall" type="button">Search the whole band</button></div></div>
      <div class="card"><h3>Getting a good signal</h3><ul class="tips">
        <li>A 70 cm antenna (around 17 cm per side) suits the 400 MHz balloon band better than the stock one.</li>
        <li>Height matters most: balloons are heard 200 km away when they are high, but near the ground only from a few kilometres.</li>
        <li>The landing guess assumes the balloon keeps falling and drifting as it is now. Winds change lower down, so treat it as a rough area, not a spot.</li></ul></div>
    </div>`;
    const mp = Bl.map = new RS.Map($('#bl-map'), { zoom: 8, draw, onPick: it => { Bl.sel = it ? it.serial : null; Bl.showSel(); mp.dirty = true; Bl.rows(); } });
    $('#bl-tiles').checked = mp.tiles; $('#bl-tiles').onchange = e => mp.setTiles(e.target.checked);
    $('#bl-fit').onclick = () => Bl.fitAll();
    $('#bl-go').onclick = () => { Bl.stopped = tracking(); RS.send({ cmd: 'tap', name: tracking() ? undefined : 'sonde' }); };
    RS.on('sondes', m => {
      (m.list || []).forEach(b => {          // a balloon coming down nearby: worth knowing about wherever you are in the app
        if (b.land && b.land.dist != null && b.land.dist < 25 && b.age < 60 && !Bl.warned[b.serial]) {
          Bl.warned[b.serial] = 1;
          const t = 'Balloon ' + b.serial + ' is coming down about ' + dist(b.land.dist) + ' from you' + (b.land.in_s > 60 ? ', in about ' + Math.round(b.land.in_s / 60) + ' min' : '') + '.';
          RS.toast(t, 'warn'); RS.notify && RS.notify('Balloon landing nearby', t);
        }
      });
      Bl.list = m.list || []; if (m.tap) Bl.tap = m.tap; if (!Bl.sel && Bl.list.length) Bl.sel = Bl.list[0].serial; if (RS.page === 'sondes') Bl.update(); });
    RS.on('dl_history', m => { if (m.sondes) { Bl.list = m.sondes; if (RS.page === 'sondes') Bl.update(); } });
    RS.on('tap_state', m => { RS.st.tap = m.name; if (m.name === 'sonde') Bl.tap = m; if (RS.page === 'sondes') Bl.update(); });
    RS.on('state', () => { if (RS.page === 'sondes') { Bl.goBtn(); Bl.autostart(); } });
    const loop = () => { if (RS.page === 'sondes') mp.loop(); requestAnimationFrame(loop); }; loop();
  };
  Bl.enter = () => {
    Bl.t0 = Date.now(); Bl.stopped = false;
    if (!Bl.centred) { Bl.map.setView(RS.cfg.lat, RS.cfg.lon, 8); Bl.centred = true; }
    RS.send({ cmd: 'dl_history' });
    Bl.autostart(); Bl.map.dirty = true; Bl.update();
  };
  Bl.autostart = () => {
    const now = Date.now();
    if (RS.page !== 'sondes' || !RS.connected || Bl.stopped || tracking() || RS.st.job !== 'listen' || now - (Bl.lastTry || 0) < 3000) return;
    Bl.lastTry = now; RS.send({ cmd: 'tap', name: 'sonde', freq: Bl.fixed || undefined });
  };
  Bl.leave = () => { if (tracking()) RS.send({ cmd: 'tap' }); };
  Bl.goBtn = () => { const b = $('#bl-go'); RS.setText(b, tracking() ? 'Stop' : 'Start searching'); };
  RS.act['bl-home'] = () => Bl.map.setView(RS.cfg.lat, RS.cfg.lon, 8);
  RS.act['bl-fixed'] = () => {
    const f = parseFloat(($('#bl-f').value || '').replace(',', '.')) * 1e6;
    if (!(f >= 400e6 && f <= 406e6)) { RS.toast('Balloons use 400 to 406 MHz. Type a frequency in that range, like 401.500.', 'bad'); return; }
    Bl.fixed = f; Bl.stopped = false; RS.send({ cmd: 'tap', name: 'sonde', freq: f });
  };
  RS.act['bl-scanall'] = () => { Bl.fixed = null; Bl.stopped = false; RS.send({ cmd: 'tap', name: 'sonde' }); };
  RS.act['bl-pick'] = b => { Bl.sel = b.dataset.id; const s = Bl.list.find(x => x.serial === Bl.sel); if (s && s.lat != null) Bl.map.setView(s.lat, s.lon); Bl.update(); };
  RS.act['bl-listen'] = b => { RS.go('radio'); RS.send({ cmd: 'tune', freq: parseFloat(b.dataset.f), mode: 'nfm' }); };
  RS.act['bl-forget'] = b => RS.confirm('Remove this balloon from the list?', 'Its track will be forgotten.', 'Remove', () => { RS.send({ cmd: 'sonde_forget', serial: b.dataset.id }); if (Bl.sel === b.dataset.id) Bl.sel = null; });

  function draw(g, w, h, tiles) {
    const mp = Bl.map, hp = mp.proj(RS.cfg.lat, RS.cfg.lon), kmpx = mp.kmPx();
    const ringKm = [10, 25, 50, 100, 200].find(k => k / kmpx > 70) || 200;
    g.lineWidth = 1; g.font = '12px Atkinson, sans-serif'; g.textAlign = 'left';
    for (let k = ringKm; k / kmpx < Math.max(w, h) * 1.2 && k <= ringKm * 6; k += ringKm) {
      g.strokeStyle = tiles ? '#00000033' : '#ffffff22'; g.beginPath(); g.arc(hp.x, hp.y, k / kmpx, 0, 7); g.stroke();
      g.fillStyle = tiles ? '#333' : '#9fb6bf'; g.fillText(k + ' km', hp.x + 5, hp.y - k / kmpx + 14);
    }
    g.fillStyle = '#0d6e7b'; g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.beginPath(); g.arc(hp.x, hp.y, 7, 0, 7); g.fill(); g.stroke();
    g.fillStyle = tiles ? '#000' : '#fff'; g.fillText('You', hp.x + 10, hp.y + 4);
    Bl.list.forEach(b => {
      if (b.lat == null) return;
      const sel = b.serial === Bl.sel, tr = b.track || [];
      // the flight: blue going up, orange coming down
      let top = -1, ti = 0; tr.forEach((p, i) => { if (p[2] > top) { top = p[2]; ti = i; } });
      g.lineWidth = sel ? 3 : 2;
      [[0, ti + 1, '#3aa3ff'], [ti, tr.length, '#ff8a3d']].forEach(([a, z, col]) => {
        if (z - a < 2) return; g.strokeStyle = col + (sel ? '' : 'aa'); g.beginPath();
        for (let i = a; i < z; i++) { const q = mp.proj(tr[i][0], tr[i][1]); i === a ? g.moveTo(q.x, q.y) : g.lineTo(q.x, q.y); } g.stroke();
      });
      if (b.burst && tr[ti]) { const q = mp.proj(tr[ti][0], tr[ti][1]); g.strokeStyle = '#ff8a3d'; g.lineWidth = 2; for (let k = 0; k < 4; k++) { const a = k * Math.PI / 4; g.beginPath(); g.moveTo(q.x - 7 * Math.cos(a), q.y - 7 * Math.sin(a)); g.lineTo(q.x + 7 * Math.cos(a), q.y + 7 * Math.sin(a)); g.stroke(); } }
      const p = mp.proj(b.lat, b.lon);
      if (b.land) {
        const L = mp.proj(b.land.lat, b.land.lon);
        g.setLineDash([5, 5]); g.strokeStyle = tiles ? '#c2410c' : '#ffb27a'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(L.x, L.y); g.stroke(); g.setLineDash([]);
        g.beginPath(); g.arc(L.x, L.y, 10, 0, 7); g.stroke(); g.beginPath(); g.moveTo(L.x - 14, L.y); g.lineTo(L.x + 14, L.y); g.moveTo(L.x, L.y - 14); g.lineTo(L.x, L.y + 14); g.stroke();
        mp.hit.push({ x: L.x, y: L.y, item: b });
      }
      // the balloon: a circle on a string, faded once the signal is lost
      g.globalAlpha = b.age > 120 ? 0.45 : 1;
      g.strokeStyle = tiles ? '#333' : '#ddd'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(p.x, p.y + 8); g.lineTo(p.x, p.y + 16); g.stroke();
      g.fillStyle = b.burst ? '#ff8a3d' : '#3aa3ff'; g.strokeStyle = sel ? '#fff' : '#000a'; g.lineWidth = sel ? 2.5 : 1.2;
      g.beginPath(); g.arc(p.x, p.y, sel ? 9 : 7.5, 0, 7); g.fill(); g.stroke();
      g.globalAlpha = 1;
      g.font = '700 12px "B612 Mono", monospace'; g.fillStyle = tiles ? '#102' : '#fff'; g.strokeStyle = tiles ? '#ffffffcc' : '#000a'; g.lineWidth = 3;
      const lbl = b.serial + ' ' + height(b.alt); g.strokeText(lbl, p.x + 13, p.y - 8); g.fillText(lbl, p.x + 13, p.y - 8);
      mp.hit.push({ x: p.x, y: p.y, item: b });
    });
  }
  Bl.fitAll = () => {
    const mp = Bl.map, pts = [[RS.cfg.lat, RS.cfg.lon]];
    Bl.list.forEach(b => { if (b.lat != null) pts.push([b.lat, b.lon]); if (b.land) pts.push([b.land.lat, b.land.lon]); });
    const la = pts.map(x => x[0]), lo = pts.map(x => x[1]);
    mp.setView((Math.min(...la) + Math.max(...la)) / 2, (Math.min(...lo) + Math.max(...lo)) / 2, 12);
    const w = mp.cv.clientWidth, h = mp.cv.clientHeight;
    for (let z = 12; z >= 2; z--) { mp.z = z; if (pts.every(q => { const p = mp.proj(q[0], q[1]); return p.x > 30 && p.x < w - 30 && p.y > 30 && p.y < h - 30; })) break; }
    mp.dirty = true;
  };
  Bl.update = () => {
    const L = Bl.list, live = L.filter(b => b.age < 120), hi = Math.max(-1, ...L.map(b => b.max_alt || -1)), near = L.filter(b => b.dist != null).map(b => b.dist);
    $('#bl-stats').innerHTML = '<div><b>' + L.length + '</b><span>balloons heard</span></div><div><b>' + live.length + '</b><span>on air now</span></div><div><b>' + (hi > 0 ? height(hi) : '-') + '</b><span>highest</span></div><div><b>' + (near.length ? dist(Math.min(...near)) : '-') + '</b><span>nearest</span></div>';
    const t = Bl.tap || {};
    $('#bl-scan').textContent = !tracking() ? 'Not listening.' : t.fixed ? 'Listening on ' + mhz(t.fixed) + '.' :
      t.scanning === false ? 'Locked on a balloon at ' + mhz((t.chans || []).filter(c => c.hits).map(c => c.f)[0] || RS.st.vfo) + '.' :
      t.window ? 'Searching ' + (t.window[0] / 1e6).toFixed(1) + ' to ' + (t.window[1] / 1e6).toFixed(1) + ' MHz' + ((t.chans || []).length ? ', checking ' + t.chans.length + ' signal' + (t.chans.length > 1 ? 's' : '') : '') + '.' : 'Searching.';
    Bl.goBtn(); Bl.rows(); Bl.showSel(); if (Bl.map) Bl.map.dirty = true;
    $('#bl-empty-t').textContent = !tracking() ? 'Searching is stopped. Press Start searching.' : (Date.now() - Bl.t0 > 90000 ? 'Nothing yet. Balloons are only on air for about two hours after each launch, so try again around launch time, and get the antenna as high as you can.' : 'Searching. A balloon is on air for about two hours after launch.');
  };
  Bl.rows = () => {
    const L = Bl.list;
    $('#bl-rows').innerHTML = L.map(b => '<tr class="click' + (b.serial === Bl.sel ? ' plane-sel' : '') + '" data-act="bl-pick" data-id="' + esc(b.serial) + '"><td><b>' + esc(b.serial) + '</b><div class="tiny muted">' + mhz(b.freq) + '</div></td><td>' + height(b.alt) + '</td><td>' + esc(phase(b)) + '</td><td>' + dist(b.dist) + '</td></tr>').join('');
    $('#bl-empty').classList.toggle('hide', L.length > 0);
    $('#bl-sub').textContent = L.length ? 'Most recent first' : '';
  };
  Bl.showSel = () => {
    const box = $('#bl-sel'), b = Bl.list.find(x => x.serial === Bl.sel);
    box.classList.toggle('hide', !b); if (!b) return;
    const land = b.land ? '<dt>Landing (rough)</dt><dd>' + (b.land.in_s > 60 ? 'in about ' + Math.round(b.land.in_s / 60) + ' min, ' : 'any moment, ') + (b.land.dist != null ? dist(b.land.dist) + ' from you' : '') + '</dd>' : '';
    box.innerHTML = '<h3 style="color:#fff">' + esc(b.serial) + ' <span class="mono" style="font-size:14px;font-weight:400;color:var(--glass-ink)">' + esc(b.type || 'RS41') + ' &middot; ' + mhz(b.freq) + '</span></h3>' +
      '<dl class="kv" style="grid-template-columns:auto 1fr;margin-top:8px"><dt>Status</dt><dd>' + esc(phase(b)) + ' (heard ' + ago(b.age) + ')</dd><dt>Height</dt><dd>' + height(b.alt) + (b.max_alt > 0 ? ', highest ' + height(b.max_alt) : '') + '</dd>' +
      '<dt>Moving</dt><dd>' + rate(b.climb) + (b.speed != null ? ', drifting ' + Math.round(b.speed * 3.6) + ' km/h ' + compass(b.heading || 0) : '') + '</dd>' +
      (b.dist != null ? '<dt>Where</dt><dd>' + dist(b.dist) + ' to the ' + compass(b.brg || 0) + '</dd>' : '') + land +
      (b.batt ? '<dt>Battery</dt><dd>' + b.batt.toFixed(1) + ' V</dd>' : '') + '<dt>Reports</dt><dd>' + b.frames + '</dd></dl>' +
      '<div class="row tight" style="margin-top:10px"><button class="btn small" data-act="bl-listen" data-f="' + b.freq + '" type="button">Listen</button><a class="btn small" href="/api/export/balloon-' + encodeURIComponent(b.serial) + '.gpx">Track (GPX)</a><a class="btn small" href="/api/export/balloon-' + encodeURIComponent(b.serial) + '.csv">Track (CSV)</a><button class="btn small ghost" data-act="bl-forget" data-id="' + esc(b.serial) + '" type="button">Remove</button></div>';
  };
})();
