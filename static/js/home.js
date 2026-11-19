/* home.js - the Home page.
   What a glance at the receiver should answer: what am I hearing, what is coming up, what is around me, and where do I
   go next. So: one panel for what the radio is doing now (station, song, signal, listen, your stations, go to a
   frequency); "Next up", every timed thing in order (satellite passes, scheduled recordings) with one button each;
   "Around you", one tile per thing the radio has picked up (planes with a small radar, satellites overhead, ships,
   sensors, the scanner, the newest weather picture, recordings), which you can hide and reorder; then every section in
   one list, and getting started. Prefs (which tiles, in what order) are kept on the server so every device agrees. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc, icon = n => (RS.icon ? RS.icon(n) : '');
  const Home = RS.pages.home = {};

  // ---------------------------------------------------------------- preferences kept on the server (shared by every device)
  let saveT = 0;
  RS.setPref = (key, val) => {
    RS.prefs = RS.prefs || {}; RS.prefs[key] = val;
    clearTimeout(saveT); saveT = setTimeout(() => RS.api('prefs', { prefs: RS.prefs }).catch(() => { }), 250);
  };
  RS.on('prefs', m => { if (JSON.stringify(m.prefs) !== JSON.stringify(RS.prefs)) { RS.prefs = m.prefs || {}; RS.fire('prefs-applied'); if (RS.page === 'home') Home.draw(true); } });

  // ---------------------------------------------------------------- data
  const D = { passes: null, passT: 0, sky: null, skyT: 0, files: null, dec: null, fileT: 0, ships: [] };
  async function loadPasses(force) {
    if (!force && Date.now() - D.passT < 300000) return; D.passT = Date.now();
    try { D.passes = await RS.api('space/passes?hours=24&min_el=15'); } catch (e) { D.passes = { passes: [] }; }
    Home.soon();
  }
  async function loadSky() {
    if (Date.now() - D.skyT < 20000) return; D.skyT = Date.now();
    try { D.sky = (await RS.api('space/aim')).sky || []; } catch (e) { D.sky = []; }
    Home.soon();
  }
  async function loadFiles() {
    if (Date.now() - D.fileT < 60000) return; D.fileT = Date.now();
    try { const [r, d] = await Promise.all([RS.api('recordings'), RS.api('decodes')]); D.files = r; D.dec = d.items || []; } catch (e) { D.files = D.files || { files: [] }; D.dec = D.dec || []; }
    Home.soon();
  }
  RS.on('ais', m => { D.ships = m.vessels || []; Home.soon(); });
  const now = () => Date.now() / 1000;
  const hm = t => new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = t => { const d = new Date(t * 1000), n = new Date(); if (d.toDateString() === n.toDateString()) return 'Today'; if (new Date(n.getTime() + 864e5).toDateString() === d.toDateString()) return 'Tomorrow'; return d.toLocaleDateString([], { weekday: 'long' }); };
  const until = t => { const m = Math.round((t - now()) / 60); return m <= 0 ? 'now' : m < 60 ? 'in ' + m + ' min' : 'in ' + Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : ''); };
  const planes = () => (RS.pages.planes && RS.pages.planes.list) || [];
  const job = () => (RS.st && RS.st.job) || 'listen';
  const snr = () => { const L = RS.live, st = RS.st || {}; return job() === 'listen' && L && performance.now() - L.t < 1500 ? L.snr : (st.snr || 0); };

  // ---------------------------------------------------------------- tiles ("around you")
  const TILES = {
    planes: { name: 'Planes', page: 'planes', ico: 'plane', wide: true },
    sky: { name: 'Satellites overhead', page: 'space', ico: 'space' },
    ships: { name: 'Ships', page: 'ships', ico: 'ship' },
    sensors: { name: 'Sensors', page: 'sensors', ico: 'sensor' },
    scanner: { name: 'Scanner', page: 'scanner', ico: 'scan' },
    picture: { name: 'Weather picture', page: 'library', ico: 'space' },
    recordings: { name: 'Recordings', page: 'library', ico: 'tape' },
    captions: { name: 'Captions', page: 'radio', ico: 'msg' },
  };
  const DEFAULT = ['planes', 'sky', 'sensors', 'scanner', 'ships', 'picture', 'recordings'];
  const tiles = () => { const t = RS.prefs && RS.prefs.home_tiles; return Array.isArray(t) ? t.filter(x => TILES[x]) : DEFAULT.slice(); };
  const big = (v, u) => '<b class="ho-big">' + esc(String(v)) + (u ? '<small>' + esc(u) + '</small>' : '') + '</b>';
  const quiet = t => '<p class="ho-quiet">' + esc(t) + '</p>';
  function tileBody(id) {
    if (id === 'planes') {
      const L = planes(), on = job() === 'adsb', st = (RS.pages.planes && RS.pages.planes.stats) || {};
      const near = L.filter(a => a.dist_km != null).sort((a, b) => a.dist_km - b.dist_km)[0], emg = L.filter(a => RS.pages.planes.isEmg(a)).length;
      return '<div class="ho-radar"><canvas class="ho-radar-cv" aria-hidden="true"></canvas><div class="ho-radar-t">' + (on || L.length ? big(L.length, L.length === 1 ? 'aircraft' : 'aircraft') +
        (emg ? '<span class="ho-flag">' + emg + ' squawking emergency</span>' : '') +
        (near ? '<p>Nearest: <button type="button" class="ho-link" data-act="ho-plane" data-id="' + esc(near.icao) + '">' + esc(near.callsign || near.icao.toUpperCase()) + '</button>, ' + esc(RS.fmtDist(near.dist_km)) + (near.alt != null ? ' at ' + Math.round(near.alt).toLocaleString() + ' ft' : '') + '</p>' : quiet(on ? 'Listening for aircraft...' : '')) +
        (st.max_range_km ? quiet('Furthest heard ' + RS.fmtDist(st.max_range_km)) : '')
        : quiet('Not tracking. The radio does one job at a time, so tracking pauses the sound.')) +
        '<div class="ho-tile-acts">' + (on ? '<button class="btn small" data-act="ho-planes-stop">Stop tracking</button>' : '<button class="btn small" data-act="ho-planes-start">' + icon('plane') + '<span>Track planes here</span></button>') + '</div></div></div>';
    }
    if (id === 'sky') {
      if (D.sky == null) return quiet('Looking...');
      const up = D.sky.filter(x => x.up).sort((a, b) => b.el - a.el);
      return up.length ? big(up.length, 'above you') + '<ul class="ho-mini">' + up.slice(0, 3).map(x => '<li><b>' + esc(x.short) + '</b><span>' + Math.round(x.el) + '° high</span></li>').join('') + '</ul>'
        : quiet(D.sky.length ? 'None of the tracked satellites is above the horizon right now.' : 'Needs orbit data (Space page).');
    }
    if (id === 'ships') {
      const L = D.ships || [];
      return L.length ? big(L.length, L.length === 1 ? 'ship heard' : 'ships heard') + quiet('Latest: ' + (L[0].name || L[0].callsign || L[0].mmsi)) : quiet('None heard yet. Open Ships to start listening.');
    }
    if (id === 'sensors') {
      const L = Object.values(RS.sensors || {}).filter(s => !s.hidden).sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0) || (b.seen || 0) - (a.seen || 0));
      const tc = s => s.temperature_C != null ? +s.temperature_C : s.temperature_F != null ? (s.temperature_F - 32) / 1.8 : null;
      const t = L.find(s => tc(s) != null);
      if (!L.length) return quiet('Nothing heard yet. Open Sensors and press Listen.');
      return (t ? '<b class="ho-big">' + esc(RS.temp(tc(t))) + '</b>' + quiet((t.name || String(t.model || 'Sensor').replace(/[_-]/g, ' ')) + (t.humidity != null ? ', ' + Math.round(t.humidity) + '% humidity' : '') + ', ' + RS.ago(t.seen))
        : big(L.length, 'sensors')) + (L.length > 1 ? quiet(L.length + ' sensors heard') : '');
    }
    if (id === 'scanner') {
      const L = RS.scanLog || [], run = RS.st && RS.st.scan;
      if (!L.length) return quiet(run ? 'Scanning. Nothing heard yet.' : 'Nothing heard yet. Open the Scanner and press Start.');
      const e = L[0];
      return '<b class="ho-big sm">' + esc(e.label || RS.fmt(e.f)) + '</b>' + quiet((e.label ? RS.fmt(e.f) + ', ' : '') + RS.ago(e.t || e.end || now()) + (run ? '. Scanning now.' : ''));
    }
    if (id === 'picture') {
      if (D.dec == null) return quiet('Looking...');
      const x = D.dec.find(d => d.ok && (d.images || []).length);
      if (!x) return quiet('No pictures yet. Record a Meteor pass on the Space page.');
      const url = '/dec/' + encodeURIComponent(x.id) + '/' + x.images[0].file;
      return '<img class="ho-pic" src="' + url + '" alt="Weather picture from ' + esc(x.sat_name || x.sat || 'a satellite') + '" loading="lazy">' + quiet((x.sat_name || x.sat || '') + (x.t0 ? ', ' + day(x.t0).toLowerCase() + ' ' + hm(x.t0) : ''));
    }
    if (id === 'recordings') {
      if (!D.files) return quiet('Looking...');
      const L = D.files.files || [];
      return big(L.length, L.length === 1 ? 'recording' : 'recordings') + quiet(D.files.free_gb != null ? D.files.free_gb + ' GB free' : '');
    }
    if (id === 'captions') {
      const L = RS.captionLog || [];
      return L.length ? '<p class="ho-quote">' + esc(L[L.length - 1].text.slice(0, 140)) + '</p>' + quiet(RS.clock(L[L.length - 1].t)) : quiet('Turn on captions (CC in the sound bar) while listening to a spoken channel.');
    }
    return '';
  }
  function drawRadar(el) {
    const cv = el.querySelector('.ho-radar-cv'); if (!cv) return; const c = RS.fit(cv); if (!c) return;
    const g = c.g, w = c.w, h = c.h, cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 4, s = getComputedStyle(cv), ink = s.color, sig = RS.cssv('--sig') || ink;
    g.clearRect(0, 0, w, h); g.strokeStyle = ink; g.lineWidth = 1;
    g.globalAlpha = .18; [1, .66, .33].forEach(k => { g.beginPath(); g.arc(cx, cy, R * k, 0, 7); g.stroke(); });
    g.globalAlpha = 1;
    const la = RS.cfg && RS.cfg.lat, lo = RS.cfg && RS.cfg.lon; if (la == null) return;
    const kx = Math.cos(la * Math.PI / 180), P = planes().filter(a => a.lat != null).map(a => ({ a, x: (a.lon - lo) * kx * 111.3, y: (a.lat - la) * 111.3 }));
    const range = Math.max(40, ...P.map(p => Math.hypot(p.x, p.y))) * 1.1;
    P.forEach(p => {
      const x = cx + p.x / range * R, y = cy - p.y / range * R;
      g.save(); g.translate(x, y); g.rotate((p.a.heading || 0) * Math.PI / 180); g.fillStyle = RS.pages.planes.isEmg(p.a) ? (RS.cssv('--bad') || '#c33') : ink;
      g.beginPath(); g.moveTo(0, -5); g.lineTo(3.5, 4); g.lineTo(0, 2.5); g.lineTo(-3.5, 4); g.closePath(); g.fill(); g.restore();
    });
    g.fillStyle = sig; g.beginPath(); g.arc(cx, cy, 3, 0, 7); g.fill();
  }

  // ---------------------------------------------------------------- next up: every timed thing, in order
  function agenda() {
    const out = [], t = now(), Sp = RS.pages.space || {};
    ((D.passes && D.passes.passes) || []).filter(p => p.los > t).slice(0, 12).forEach(p => {
      const q = Sp.quality ? Sp.quality(p) : { n: 3, w: '' }; if (q.n < 2) return;
      const pl = Sp.plan ? Sp.plan(p) : null, rec = pl && Sp.scheduled && Sp.scheduled(p, pl.kind);
      out.push({ t: p.aos, end: p.los, kind: 'pass', p, q, pl, rec, title: p.short + ' passes over', sub: Math.round(p.max_el) + '° high' + (q.w ? ', ' + q.w.toLowerCase() + ' chances' : '') });
    });
    ((RS.space && RS.space.schedule) || []).forEach(s => { if (s.end > t && !out.some(o => o.rec && o.rec.id === s.id)) out.push({ t: s.aos || s.start, end: s.end, kind: 'sched', s, title: 'Recording ' + String(s.label || s.sat).replace(/ (Today|Tomorrow|[A-Z][a-z]{2,8}) .*$/, ''), sub: RS.fmt(s.freq) }); });
    (RS.timers || []).forEach(x => { if ((x.start + (x.secs || x.duration || 0)) > t) out.push({ t: x.start, kind: 'timer', x, title: 'Timed recording: ' + (x.label || RS.fmt(x.freq)), sub: RS.fmt(x.freq) }); });
    return out.sort((a, b) => a.t - b.t).slice(0, 5);
  }

  // ---------------------------------------------------------------- page
  Home.init = () => {
    $('#p-home').innerHTML = `
    <div class="ho-top"><p class="ho-state"><i class="dot" id="ho-dot"></i><span id="ho-state">Connecting</span></p></div>
    <section class="glass ho-now" id="ho-now" aria-label="Now">
      <div class="ho-now-main">
        <figure class="ho-cover" id="ho-np"><div class="np-art"><span class="ho-mono" id="ho-mono" aria-hidden="true"></span><img id="ho-art" class="art-home" alt="" width="200" height="200" decoding="async"></div></figure>
        <div class="ho-now-t">
          <h2 class="ho-title" id="ho-title" data-keep-case>Home</h2>
          <p class="ho-song" id="ho-song"></p>
          <p class="ho-meta"><span id="ho-freq"></span><span class="ho-bars" id="ho-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span id="ho-sig"></span></p>
        </div>
        <div class="ho-now-acts" id="ho-acts"></div>
      </div>
      <div class="ho-now-foot">
        <div class="ho-stations" id="ho-stations" aria-label="Your stations"></div>
        <form class="ho-go" id="ho-go" autocomplete="off"><label class="sr-only" for="ho-go-in">Go to a frequency</label><input id="ho-go-in" inputmode="decimal" placeholder="Go to 98.5, 7074 k, 1.09 g"><button class="btn" type="submit" aria-label="Tune">${icon('right')}</button></form>
      </div>
    </section>

    <section class="ho-sec kx-static" aria-labelledby="ho-next-h">
      <div class="ho-sec-h"><h3 id="ho-next-h">Next up</h3><button class="btn small ghost" data-act="go" data-page="space">All passes</button></div>
      <div class="ho-agenda" id="ho-agenda"></div>
    </section>

    <section class="ho-sec kx-static" aria-labelledby="ho-around-h">
      <div class="ho-sec-h"><h3 id="ho-around-h">Around you</h3><button class="btn small ghost" data-act="ho-custom">Choose tiles</button></div>
      <div class="ho-tiles" id="ho-tiles"></div>
    </section>

    <section class="ho-sec kx-static" aria-labelledby="ho-all-h">
      <div class="ho-sec-h"><h3 id="ho-all-h">Everything Skywave does</h3></div>
      <nav class="ho-dir" aria-labelledby="ho-all-h">${[
        ['radio', 'radio', 'Radio', 'FM, AM and anything else on the air'],
        ['scanner', 'scan', 'Scanner', 'Stops on channels when someone talks'],
        ['planes', 'plane', 'Planes', 'Aircraft overhead on a live map'],
        ['ships', 'ship', 'Ships', 'Vessels nearby, from their AIS beacons'],
        ['space', 'space', 'Space', 'Satellite passes, voices and weather pictures'],
        ['ham', 'ham', 'Ham radio', 'Amateur bands, APRS and signal reports'],
        ['sensors', 'sensor', 'Sensors', 'Weather stations and meters nearby'],
        ['explore', 'explore', 'Explore', 'Sweep any range and see what is there'],
        ['lab', 'lab', 'Lab', 'Measure, decode and compare signals'],
        ['library', 'tape', 'Library', 'Recordings, pictures and transcripts'],
        ['settings', 'gear', 'Settings', 'Your radio, location, look and sound']].map(a => `<button class="ho-dir-i" data-act="go" data-page="${a[0]}">${icon(a[1])}<span><b>${a[2]}</b><small>${a[3]}</small></span></button>`).join('')}</nav>
    </section>

    <details class="card kx-static ho-start" id="ho-start"><summary>Getting started</summary>
      <div class="ho-start-g">
        <div><h4>One job at a time</h4><p>The dongle listens, tracks planes, reads sensors or records a satellite, one at a time. Skywave switches for you when you change section. Easy keeps the controls simple; Advanced shows modes, filters and measurements.</p></div>
        <div><h4>The antenna</h4><p>Extend it fully, put it high near a window and away from computers and chargers. Settings has an antenna guide with lengths for each band.</p></div>
        <div><h4>Scanning</h4><p>Many public-service networks are digital or encrypted and sound like bursts of noise. Analogue channels you are allowed to hear can go in the Scanner's lists. Check your local rules.</p></div>
        <div><h4>Satellites</h4><p>Weather pictures need a Meteor pass above about 30&deg; and a clear view of the sky. The space station is often heard on 145.800 MHz FM.</p></div>
        <div><h4>Captions</h4><p>CC writes down what is said on spoken channels, not music stations. Weak or noisy audio is harder to follow. Morse is decoded on its own on CW channels.</p></div>
        <div><h4>If something is off</h4><p>Settings, Check my radio, tests the dongle on eight frequencies and says in plain words what it found.</p></div>
      </div></details>`;
    $('#ho-go').addEventListener('submit', e => {
      e.preventDefault(); const v = $('#ho-go-in').value, f = RS.parseFreq(v, 'm');
      if (!f || !isFinite(f) || f < 0.1e6 || f > 1.75e9) { RS.toast('That is not a frequency the radio can tune. Try 98.5 or 7074 k.', 'bad'); return; }
      $('#ho-go-in').value = ''; RS.go('radio'); RS.tune(f, { recenter: true });
    });
    ['favourites', 'audio', 'art', 'sensor', 'scan_end', 'aircraft', 'schedule', 'timers', 'caption', 'local'].forEach(ev => RS.on(ev, () => Home.soon()));
    RS.on('hello', () => { if (RS.page === 'home') { loadPasses(true); Home.draw(true); } });
    setInterval(() => { if (RS.page === 'home' && !document.hidden) { loadSky(); loadPasses(); Home.soon(); } }, 15000);
  };
  Home.enter = () => { Home._enter = true; loadPasses(); loadSky(); loadFiles(); Home.draw(true); };
  Home.state = () => Home.soon();
  Home.leave = () => { };
  let pend = 0;
  Home.soon = () => { if (RS.page !== 'home' || pend) return; pend = setTimeout(() => { pend = 0; Home.draw(); }, 300); };
  const put = (el, h) => { if (el && el._h !== h) { el._h = h; el.innerHTML = h; } };

  Home.draw = force => {
    if (RS.page !== 'home' || !$('#ho-now')) return;
    if (force) ['#ho-tiles', '#ho-agenda', '#ho-acts', '#ho-stations'].forEach(s => { const e = $(s); if (e) e._h = null; });
    now$(); next$(); tiles$();
  };

  // what the radio is doing now
  function now$() {
    const st = RS.st || {}, j = job(), f = RS.vfo(), m = RS.curMode(), dev = st.device || {};
    let tone = 'good', state = RS.audio && RS.audio.on ? 'Listening' : 'Ready';
    if (!RS.connected) { tone = 'warn'; state = 'Reaching your receiver'; }
    else if (st.error) { tone = 'bad'; state = 'The radio is not responding'; }
    else if (j === 'adsb') state = 'Tracking aircraft'; else if (j === 'ais') state = 'Tracking ships'; else if (j === 'record') state = 'Recording a satellite'; else if (st.scan) state = 'Scanning';
    if (RS.connected && !st.error) state += RS.sim ? ' · practice mode, signals are simulated' : dev.name ? ' · ' + dev.name : '';
    const dot = $('#ho-dot'); if (dot) dot.className = 'dot ' + tone;
    RS.setText($('#ho-state'), state);
    const rd = m === 'wfm' && st.rds && st.rds.ps ? st.rds : null, nm = (rd && rd.ps.trim()) || RS.nameFor(f) || '';
    const c = RS.art && RS.art.cur, parts = RS.freqParts(f, m);
    let title, song;
    if (j === 'adsb') { title = planes().length + ' aircraft in range'; song = 'The radio is on 1090 MHz, listening to plane transponders.'; }
    else if (j === 'ais') { title = (D.ships.length || 'No') + ' ship' + (D.ships.length === 1 ? '' : 's') + ' heard'; song = 'The radio is listening to ship beacons on the marine band.'; }
    else if (j === 'record') { title = 'Recording'; song = 'The radio is busy until the recording ends.'; }
    else { title = nm || (f ? parts.n + ' ' + parts.u : 'Receiver ready'); song = c && c.title ? c.title + (c.artist ? ' — ' + c.artist : '') : rd && rd.rt ? rd.rt : RS.bandName(f) || ''; }
    RS.setText($('#ho-title'), title); RS.setText($('#ho-song'), song);
    RS.setText($('#ho-mono'), j === 'adsb' ? '1090' : parts.n);
    RS.setText($('#ho-freq'), j === 'listen' && nm ? parts.n + ' ' + parts.u : '');
    const n = j === 'listen' ? RS.bars(snr()) : 0;
    RS.$$('#ho-bars i').forEach((e, i) => e.classList.toggle('on', i < n));
    $('#ho-bars').classList.toggle('hide', j !== 'listen');
    RS.setText($('#ho-sig'), j !== 'listen' ? '' : n === 0 ? 'No signal' : n < 2 ? 'Weak signal' : n < 4 ? 'Good signal' : 'Strong signal');
    const on = !!(RS.audio && RS.audio.on);
    put($('#ho-acts'), j === 'listen' || j === 'record'
      ? '<button class="btn primary ho-listen" data-act="ho-listen" aria-pressed="false"><span class="ho-li">' + icon('sound') + '</span><span class="ho-ll">Listen</span></button><button class="btn" data-act="go" data-page="radio">' + icon('radio') + '<span>Open the radio</span></button>'
      : '<button class="btn primary" data-act="ho-back">' + icon('radio') + '<span>Back to the radio</span></button><button class="btn" data-act="go" data-page="' + (j === 'adsb' ? 'planes' : j === 'ais' ? 'ships' : 'space') + '">Open the map</button>');
    const lb = $('#ho-acts .ho-listen');
    if (lb && lb.getAttribute('aria-pressed') !== String(on)) {
      const slot = lb.querySelector('.ho-li'), svg = icon(on ? 'stop' : 'sound'), fresh = !lb._set; lb._set = true;
      lb.setAttribute('aria-pressed', String(on));
      if (RS.feel && !fresh) RS.feel.icon(slot, svg); else slot.innerHTML = svg;
      RS.setText(lb.querySelector('.ho-ll'), on ? 'Stop' : 'Listen');
    }
    const favs = RS.favs || [];
    put($('#ho-stations'), favs.length ? favs.slice(0, 10).map(x => { const cur = Math.abs(x.f - f) < 5e3 && j === 'listen';
      return '<button class="ho-st' + (cur ? ' on' : '') + '" data-act="ho-tune" data-f="' + x.f + '" data-m="' + esc(x.mode || '') + '"' + (cur ? ' aria-current="true"' : '') + '><b>' + esc(x.name || RS.fmt(x.f, x.mode)) + '</b><small>' + esc(RS.fmt(x.f, x.mode)) + '</small></button>'; }).join('')
      : '<p class="ho-hint">Stations you save on the Radio page show up here, one tap away.</p>');
  }
  // next up
  function next$() {
    const L = agenda(), el = $('#ho-agenda');
    const h = L.length ? L.map(x => {
      const live = x.t <= now() && (x.end || 0) > now();
      let act = '';
      if (x.kind === 'pass' && x.pl) act = live ? '<button class="btn small primary" data-act="ho-pass-listen" data-sat="' + esc(x.p.sat) + '">' + icon('sound') + '<span>Listen</span></button>'
        : x.rec ? '<button class="btn small on" data-act="sp-unsched" data-id="' + esc(x.rec.id) + '" title="Cancel this recording">' + icon('check') + '<span>Will record</span></button>'
        : '<button class="btn small" data-act="ho-pass-rec" data-k="' + esc(RS.pages.space.key(x.p)) + '">' + icon('rec') + '<span>Record</span></button>';
      return '<div class="ho-ag' + (live ? ' live' : '') + '"><span class="ho-ag-t"><b>' + (live ? 'Now' : esc(hm(x.t))) + '</b><small>' + (live ? 'happening' : esc(day(x.t))) + '</small></span>' +
        '<span class="ho-ag-n"><b>' + esc(x.title) + '</b><small>' + esc((live ? '' : until(x.t) + ' · ') + x.sub) + '</small></span>' + act + '</div>';
    }).join('') : '<p class="ho-hint">' + (D.passes == null ? 'Looking ahead...' : RS.cfg && (RS.cfg.lat || RS.cfg.lon) ? 'Nothing timed in the next day. Satellite passes and scheduled recordings show up here.' : 'Set your location in Settings to see satellite passes here.') + '</p>';
    put(el, h);
  }
  // around you
  function tiles$() {
    const el = $('#ho-tiles'), T = tiles();
    if (T.includes('sky')) loadSky(); if (T.includes('picture') || T.includes('recordings')) loadFiles();
    const h = T.map(id => { const t = TILES[id]; return '<article class="ho-tile' + (t.wide ? ' wide' : '') + '" data-id="' + id + '"><button class="ho-tile-h" data-act="go" data-page="' + t.page + '">' + icon(t.ico) + '<span>' + esc(t.name) + '</span>' + icon('right') + '</button><div class="ho-tile-b">' + tileBody(id) + '</div></article>'; }).join('')
      || '<p class="ho-hint">No tiles chosen. Choose tiles to see what the radio picks up around you.</p>';
    if (el._h !== h) {
      const order = T.join(','), moved = el._order != null && el._order !== order; el._order = order; el._h = h;
      if (moved && RS.feel) RS.feel.flip(el, c => c.dataset.id, () => { el.innerHTML = h; });
      else { el.innerHTML = h; if (Home._enter && RS.feel) { Home._enter = false; RS.feel.stagger(el.children); } }
    }
    const pl = el.querySelector('.ho-tile[data-id="planes"]'); if (pl) drawRadar(pl);
  }

  // ---------------------------------------------------------------- actions
  RS.act['ho-listen'] = () => { if (RS.audio.on) RS.audio.stop(); else RS.audio.start(); setTimeout(() => Home.draw(), 60); };
  RS.act['ho-back'] = () => { Home.keepPlanes = false; RS.send({ cmd: 'job', name: 'listen' }); };
  RS.act['ho-tune'] = b => { RS.tune(+b.dataset.f, b.dataset.m ? { mode: b.dataset.m, recenter: true } : { recenter: true }); if (!RS.audio.on) RS.audio.start(); };
  RS.act['ho-planes-start'] = () => { Home.keepPlanes = true; RS.send({ cmd: 'job', name: 'adsb' }); RS.toast('Tracking planes. The radio sound pauses while it does.'); };
  RS.act['ho-planes-stop'] = () => { Home.keepPlanes = false; RS.send({ cmd: 'job', name: 'listen' }); };
  RS.on('page', n => { if (n !== 'home') Home.keepPlanes = false; });
  RS.act['ho-plane'] = b => { const pl = RS.pages.planes; Home.keepPlanes = false; RS.go('planes'); if (pl.pick) pl.pick(b.dataset.id); else pl.sel = b.dataset.id; };
  RS.act['ho-pass-rec'] = b => {
    const Sp = RS.pages.space, p = ((D.passes && D.passes.passes) || []).find(x => Sp.key(x) === b.dataset.k), pl = p && Sp.plan(p); if (!pl) return;
    const f = pl.c.freqs[pl.fi];
    RS.api('space/schedule', { sat: p.sat, aos: p.aos, los: p.los, freq: f.f, kind: pl.kind, mode: f.mode, bw: f.bw, max_el: p.max_el, label: p.short + ' ' + day(p.aos) + ' ' + hm(p.aos) })
      .then(async () => { RS.toast('Will record ' + p.short + ' ' + until(p.aos) + '. Leave Skywave running.'); await loadPasses(true); Home.draw();
        const nb = document.querySelector('#ho-agenda [data-act="sp-unsched"]'); if (nb && RS.feel) RS.feel.pulse(nb); }).catch(e => RS.toast(e.message, 'bad'));
  };
  RS.act['ho-pass-listen'] = b => {
    const c = (RS.catalog || []).find(x => x.id === b.dataset.sat), i = c ? (c.freqs || []).findIndex(f => f.kind !== 'digital') : -1;
    if (i >= 0 && RS.act['sp-listen']) RS.act['sp-listen']({ dataset: { sat: c.id, i: String(i) } });
  };
  RS.act['ho-custom'] = () => {
    const draw = () => { const on = tiles(), all = on.concat(Object.keys(TILES).filter(k => !on.includes(k)));
      return all.map(id => { const i = on.indexOf(id); return '<div class="ho-opt' + (i < 0 ? ' off' : '') + '" data-id="' + id + '"><label class="switch"><input type="checkbox" data-act="ho-opt" data-id="' + id + '"' + (i >= 0 ? ' checked' : '') + ' aria-label="Show ' + esc(TILES[id].name) + '"><i></i></label><b>' + esc(TILES[id].name) + '</b>' +
        (i >= 0 ? '<span class="ho-opt-m"><button class="btn small" data-act="ho-move" data-id="' + id + '" data-d="-1" aria-label="Move ' + esc(TILES[id].name) + ' earlier"' + (i === 0 ? ' disabled' : '') + '>' + icon('left') + '</button><button class="btn small" data-act="ho-move" data-id="' + id + '" data-d="1" aria-label="Move ' + esc(TILES[id].name) + ' later"' + (i === on.length - 1 ? ' disabled' : '') + '>' + icon('right') + '</button></span>' : '') + '</div>'; }).join(''); };
    Home._opt = draw;
    RS.modal('<h3>Around you</h3><p class="sub" style="margin:0 0 12px">Choose which tiles Home shows, and their order. Every device you use sees the same.</p><div class="ho-opts" id="ho-opts">' + draw() + '</div><div class="row" style="justify-content:space-between;margin-top:14px"><button class="btn ghost" data-act="ho-reset">Back to the usual tiles</button><button class="btn primary" data-act="ho-done">Done</button></div>');
  };
  const saveTiles = L => {
    RS.setPref('home_tiles', L); const o = $('#ho-opts');
    if (o) { const h = Home._opt(); if (RS.feel) RS.feel.flip(o, c => c.dataset.id, () => { o.innerHTML = h; }); else o.innerHTML = h; }
    const t = $('#ho-tiles'); if (t) t._h = null; Home.draw();
    // keep the keyboard on the button you used
    if (F_KEEP.id) { const b = o && o.querySelector('[data-act="' + F_KEEP.act + '"][data-id="' + F_KEEP.id + '"]' + (F_KEEP.d ? '[data-d="' + F_KEEP.d + '"]' : '')); if (b && !b.disabled) b.focus(); }
  };
  const F_KEEP = {};
  document.addEventListener('pointerdown', e => { const b = e.target.closest('#ho-opts [data-act]'); if (b) Object.assign(F_KEEP, { act: b.dataset.act, id: b.dataset.id, d: b.dataset.d }); }, true);
  document.addEventListener('keydown', e => { const b = e.target.closest && e.target.closest('#ho-opts [data-act]'); if (b) Object.assign(F_KEEP, { act: b.dataset.act, id: b.dataset.id, d: b.dataset.d }); }, true);
  RS.act['ho-opt'] = b => { const L = tiles(), i = L.indexOf(b.dataset.id); if (i >= 0) L.splice(i, 1); else L.push(b.dataset.id); saveTiles(L); };
  RS.act['ho-move'] = b => { const L = tiles(), i = L.indexOf(b.dataset.id), j = i + +b.dataset.d; if (i < 0 || j < 0 || j >= L.length) return; [L[i], L[j]] = [L[j], L[i]]; saveTiles(L); };
  RS.act['ho-reset'] = () => saveTiles(DEFAULT.slice());
  RS.act['ho-done'] = () => RS.closeModal();
})();
