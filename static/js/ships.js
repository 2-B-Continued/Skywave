/* Skywave - the Ships page: vessels heard on AIS, on a map and in a list, laid out like the Planes page. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc;
  const Sh = RS.pages.ships = {};
  Sh.list = []; Sh.frames = 0; Sh.sel = null; Sh.t0 = 0; Sh.trails = {}; Sh.filterBy = 'all'; Sh.stopped = false;
  const KN = 1.852;
  const COL = { Cargo: '#2f8f5b', Tanker: '#d6452f', Passenger: '#1a74c9', 'High-speed craft': '#e08a12', 'Special craft': '#8a5bc2', Other: '#6f7f88' };
  const colorOf = v => COL[v.kind] || '#16a5b8';
  const name = v => v.name || v.callsign || ('MMSI ' + v.mmsi);
  const moving = v => v.sog != null && v.sog >= 0.5;
  const dirs = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const compass = d => dirs[Math.round(d / 45) % 8];
  const home = () => [RS.cfg.lat, RS.cfg.lon];
  const km = v => v.lat == null ? null : RS.dist(RS.cfg.lat, RS.cfg.lon, v.lat, v.lon).km;
  const tracking = () => RS.st.tap === 'ais';

  Sh.init = () => {
    $('#p-ships').innerHTML = `
    <div class="page-head"><h2>Ships</h2><p>Vessels broadcast who they are and where they are every few seconds (AIS). The radio picks that up and shows them on a map. It works best near water, with the antenna up high and outdoors.</p></div>
    <div class="banner" id="sh-notice"><div class="txt"><strong>The radio is used for ships while you are here</strong>It listens on the two marine AIS channels (161.975 and 162.025 MHz), switching every few seconds, so a few reports are missed. Go back to Radio, Scanner or Ham and it switches back automatically.</div></div>
    <div class="card" style="margin-bottom:14px"><div class="stat-row" id="sh-stats"></div></div>
    <div class="two-col" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)">
      <div class="stack"><div class="map" id="sh-map"></div>
        <div class="row"><label class="check"><input type="checkbox" id="sh-tiles"><span>Show map pictures <span class="muted" style="font-weight:400">(needs internet on this device)</span></span></label><label class="check"><input type="checkbox" id="sh-trails" checked><span>Show trails</span></label><button class="btn small" id="sh-fit" type="button">Show all ships</button><button class="btn small" data-act="sh-home" type="button">Centre on me</button><button class="btn small" id="sh-go" type="button">Stop</button></div>
        <div class="glass sel-card hide" id="sh-sel"></div></div>
      <div class="card"><div class="card-head"><div><h3>Ships heard</h3><div class="sub" id="sh-sub">Closest first</div></div><select id="sh-filter" aria-label="Which ships to show"><option value="all">Show all</option><option value="moving">Moving</option><option value="still">Moored or stopped</option><option value="Cargo">Cargo</option><option value="Tanker">Tankers</option><option value="Passenger">Passenger</option></select></div>
        <div class="plane-table-wrap"><table class="tbl"><thead><tr><th>Vessel</th><th>Kind</th><th>Speed</th><th>Distance</th></tr></thead><tbody id="sh-rows"></tbody></table></div>
        <div class="empty hide" id="sh-empty"><strong>No ships yet</strong><span id="sh-empty-t">Give it a minute. Ships only show up when they are in line of sight.</span></div></div>
    </div>`;
    const mp = Sh.map = new RS.Map($('#sh-map'), { zoom: 9, draw: draw, onPick: it => { Sh.sel = it ? it.mmsi : null; Sh.showSel(); Sh.map.dirty = true; Sh.rows(); } });
    $('#sh-filter').onchange = e => { Sh.filterBy = e.target.value; Sh.update(); };
    $('#sh-tiles').checked = mp.tiles; $('#sh-tiles').onchange = e => mp.setTiles(e.target.checked);
    $('#sh-trails').onchange = () => { mp.dirty = true; };
    $('#sh-fit').onclick = () => Sh.fitAll();
    $('#sh-go').onclick = () => { Sh.stopped = tracking(); RS.send({ cmd: 'tap', name: tracking() ? undefined : 'ais' }); };
    RS.on('ais', m => {
      Sh.list = m.vessels || []; Sh.frames = m.frames || 0;
      Sh.list.forEach(v => { if (v.lat == null) return; const t = Sh.trails[v.mmsi] || (Sh.trails[v.mmsi] = []), l = t[t.length - 1]; if (!l || l[0] !== v.lat || l[1] !== v.lon) { t.push([v.lat, v.lon]); if (t.length > 40) t.shift(); } });
      if (RS.page === 'ships') Sh.update();
    });
    RS.on('tap_state', m => { RS.st.tap = m.name; if (RS.page === 'ships') Sh.update(); });
    RS.on('state', () => { if (RS.page === 'ships') { Sh.goBtn(); Sh.autostart(); } });
    const loop = () => { if (RS.page === 'ships') mp.loop(); requestAnimationFrame(loop); }; loop();
  };
  Sh.enter = () => {
    Sh.t0 = Date.now(); Sh.stopped = false;
    if (!Sh.centred) { Sh.map.setView(RS.cfg.lat, RS.cfg.lon, 9); Sh.centred = true; }
    Sh.autostart();
    Sh.map.dirty = true; Sh.update();
  };
  // Start listening for ships whenever this page is open and the radio is free (also covers opening the page before the radio has connected)
  Sh.autostart = () => {
    const now = Date.now();
    if (RS.page !== 'ships' || !RS.connected || Sh.stopped || tracking() || RS.st.job !== 'listen' || now - (Sh.lastTry || 0) < 3000) return;
    Sh.lastTry = now; RS.send({ cmd: 'tap', name: 'ais' });
  };
  Sh.leave = () => { if (tracking()) RS.send({ cmd: 'tap' }); };
  Sh.goBtn = () => { const b = $('#sh-go'); RS.setText(b, tracking() ? 'Stop' : 'Start listening'); };

  function draw(g, w, h, tiles) {
    const mp = Sh.map, hm = home(), hp = mp.proj(hm[0], hm[1]), kmpx = mp.kmPx();
    const ringKm = [5, 10, 25, 50, 100, 200].find(k => k / kmpx > 70) || 200;
    g.lineWidth = 1; g.font = '12px Atkinson, sans-serif'; g.textAlign = 'left';
    for (let k = ringKm; k / kmpx < Math.max(w, h) * 1.2 && k <= ringKm * 6; k += ringKm) {
      g.strokeStyle = tiles ? '#00000033' : '#ffffff22'; g.beginPath(); g.arc(hp.x, hp.y, k / kmpx, 0, 7); g.stroke();
      g.fillStyle = tiles ? '#333' : '#9fb6bf'; g.fillText(k + ' km', hp.x + 5, hp.y - k / kmpx + 14);
    }
    g.fillStyle = '#0d6e7b'; g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.beginPath(); g.arc(hp.x, hp.y, 7, 0, 7); g.fill(); g.stroke();
    g.fillStyle = tiles ? '#000' : '#fff'; g.fillText('You', hp.x + 10, hp.y + 4);
    const trails = $('#sh-trails').checked, pad = 16;
    Sh.list.forEach(v => {
      if (v.lat == null) return;
      const p = mp.proj(v.lat, v.lon), col = colorOf(v), sel = v.mmsi === Sh.sel, inView = p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h;
      if (!inView) {          // off the edge of the map: an arrow shows which way it is
        const cx = w / 2, cy = h / 2, dx = p.x - cx, dy = p.y - cy, k = Math.min((cx - pad) / Math.abs(dx || 1e-9), (cy - pad) / Math.abs(dy || 1e-9)), ex = cx + dx * k, ey = cy + dy * k;
        g.save(); g.translate(ex, ey); g.rotate(Math.atan2(dy, dx) + Math.PI / 2); g.fillStyle = col; g.strokeStyle = '#000a'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(0, -8); g.lineTo(6, 6); g.lineTo(-6, 6); g.closePath(); g.fill(); g.stroke(); g.restore();
        mp.hit.push({ x: ex, y: ey, item: v }); return;
      }
      const t = Sh.trails[v.mmsi];
      if (trails && t && t.length > 1) { g.strokeStyle = col + 'aa'; g.lineWidth = 2; g.beginPath(); t.forEach((q, i) => { const r = mp.proj(q[0], q[1]); i ? g.lineTo(r.x, r.y) : g.moveTo(r.x, r.y); }); g.lineTo(p.x, p.y); g.stroke(); }
      const hd = v.heading != null && v.heading < 360 ? v.heading : v.cog;
      g.save(); g.translate(p.x, p.y); const s = sel ? 1.35 : 1; g.scale(s, s);
      g.fillStyle = col; g.strokeStyle = sel ? '#fff' : '#000000aa'; g.lineWidth = sel ? 2 : 1.2;
      if (moving(v) && hd != null) { g.rotate(hd * Math.PI / 180); g.beginPath(); g.moveTo(0, -11); g.lineTo(5, -3); g.lineTo(5, 8); g.lineTo(-5, 8); g.lineTo(-5, -3); g.closePath(); }
      else { g.beginPath(); g.arc(0, 0, 6, 0, 7); }
      g.stroke(); g.fill(); g.restore();
      if (v.name && (sel || mp.z >= 10)) { g.font = '700 12px "B612 Mono", monospace'; g.fillStyle = tiles ? '#102' : '#fff'; g.strokeStyle = tiles ? '#ffffffcc' : '#000a'; g.lineWidth = 3; g.textAlign = 'left'; g.strokeText(v.name, p.x + 12, p.y - 8); g.fillText(v.name, p.x + 12, p.y - 8); }
      mp.hit.push({ x: p.x, y: p.y, item: v });
    });
    const nopos = Sh.list.filter(v => v.lat == null);
    if (nopos.length) {
      const txt = 'Position not received yet (' + nopos.length + '): ' + nopos.slice(0, 4).map(name).join(', ') + (nopos.length > 4 ? ' +' + (nopos.length - 4) : '');
      g.textAlign = 'left'; g.font = '12px Atkinson, sans-serif'; const tw = Math.min(w - 16, g.measureText(txt).width + 16);
      g.fillStyle = tiles ? '#ffffffd9' : '#000000a6'; g.fillRect(8, h - 32, tw, 24); g.fillStyle = tiles ? '#102' : '#fff'; g.fillText(txt, 16, h - 15);
    }
  }
  Sh.fitAll = () => {
    const mp = Sh.map, pts = Sh.list.filter(v => v.lat != null).map(v => [v.lat, v.lon]).concat([home()]);
    const la = pts.map(x => x[0]), lo = pts.map(x => x[1]);
    mp.setView((Math.min(...la) + Math.max(...la)) / 2, (Math.min(...lo) + Math.max(...lo)) / 2, 12);
    const w = mp.cv.clientWidth, h = mp.cv.clientHeight;
    for (let z = 12; z >= 2; z--) { mp.z = z; if (pts.every(q => { const p = mp.proj(q[0], q[1]); return p.x > 30 && p.x < w - 30 && p.y > 30 && p.y < h - 30; })) break; }
    mp.dirty = true;
  };
  Sh.pass = v => {
    const f = Sh.filterBy;
    if (f === 'moving') return moving(v);
    if (f === 'still') return v.sog != null && !moving(v);
    if (f === 'all') return true;
    return v.kind === f;
  };
  Sh.update = () => {
    const L = Sh.list, pos = L.filter(v => v.lat != null), far = Math.max(0, ...pos.map(km));
    $('#sh-stats').innerHTML = '<div><b>' + L.length + '</b><span>ships heard</span></div><div><b>' + pos.length + '</b><span>with a position</span></div><div><b>' + L.filter(moving).length + '</b><span>moving</span></div><div><b>' + (pos.length ? Math.round(far) + ' km' : '-') + '</b><span>farthest</span></div><div><b>' + Sh.frames + '</b><span>reports decoded</span></div>';
    Sh.goBtn(); Sh.rows(); Sh.showSel(); if (Sh.map) Sh.map.dirty = true;
    $('#sh-empty-t').textContent = !tracking() ? 'Listening is stopped. Press Start listening.' : (Date.now() - Sh.t0 > 25000 ? 'Still nothing. Ships only show up when there is a clear line to them, so try an outdoor spot near the water, antenna as high as you can.' : 'Give it a minute. Ships only show up when they are in line of sight.');
  };
  Sh.rows = () => {
    const all = Sh.list.slice().sort((a, b) => (km(a) == null) - (km(b) == null) || (km(a) || 0) - (km(b) || 0)), L = all.filter(Sh.pass);
    $('#sh-sub').textContent = Sh.filterBy === 'all' ? 'Closest first' : L.length + ' of ' + all.length + ' shown';
    $('#sh-rows').innerHTML = L.slice(0, 80).map(v => { const d = km(v); return '<tr class="click' + (v.mmsi === Sh.sel ? ' plane-sel' : '') + '" data-act="sh-pick" data-id="' + v.mmsi + '"><td><b>' + esc(name(v)) + '</b></td><td>' + esc(v.kind || '-') + '</td><td>' + (v.sog != null ? (v.sog * KN).toFixed(0) + ' km/h' : '-') + '</td><td>' + (d != null ? Math.round(d) + ' km' : '-') + '</td></tr>'; }).join('');
    $('#sh-empty').classList.toggle('hide', all.length > 0);
  };
  Sh.showSel = () => {
    const box = $('#sh-sel'), v = Sh.list.find(x => x.mmsi === Sh.sel);
    box.classList.toggle('hide', !v); if (!v) return;
    const d = v.lat != null ? RS.dist(RS.cfg.lat, RS.cfg.lon, v.lat, v.lon) : null, hd = v.heading != null && v.heading < 360 ? v.heading : v.cog;
    const row = (k, x) => x == null || x === '' ? '' : '<dt>' + k + '</dt><dd>' + x + '</dd>';
    box.innerHTML = '<h3 style="color:#fff">' + esc(name(v)) + ' <span class="mono" style="font-size:14px;font-weight:400;color:var(--glass-ink)">' + v.mmsi + '</span></h3><dl class="kv" style="grid-template-columns:auto 1fr;margin-top:8px">' +
      row('Kind', esc(v.kind || '')) + row('Call sign', esc(v.callsign || '')) + row('Heading to', esc(v.dest || '')) +
      row('Speed', v.sog != null ? (v.sog * KN).toFixed(1) + ' km/h (' + v.sog.toFixed(1) + ' knots)' : '') +
      row('Course', hd != null ? Math.round(hd) + '&deg; ' + compass(hd) : '') +
      row('From you', d ? Math.round(d.km * 10) / 10 + ' km ' + compass(d.brg) : '') +
      row('Position', v.lat != null ? Math.abs(v.lat).toFixed(4) + (v.lat < 0 ? 'S ' : 'N ') + Math.abs(v.lon).toFixed(4) + (v.lon < 0 ? 'W' : 'E') : 'not received yet') +
      row('Last heard', v.age + ' s ago') + '</dl>';
  };
  RS.act['sh-pick'] = b => { Sh.sel = +b.dataset.id; const v = Sh.list.find(x => x.mmsi === Sh.sel); if (v && v.lat != null) Sh.map.setView(v.lat, v.lon); Sh.update(); };
  RS.act['sh-home'] = () => Sh.map.setView(RS.cfg.lat, RS.cfg.lon, 9);
})();
