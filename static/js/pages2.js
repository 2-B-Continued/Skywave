/* Skywave - Space, Ham, Sensors, Explore, Library and Settings pages. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc, icon = RS.icon;
  const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const compass = d => DIRS[Math.round(((d % 360) + 360) % 360 / 45) % 8];
  RS.dist = (la1, lo1, la2, lo2) => {
    const R = 6371, r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
    const km = 2 * R * Math.asin(Math.sqrt(a));
    const y = Math.sin(dLo) * Math.cos(la2 * r), x = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos(dLo);
    return { km: km, brg: (Math.atan2(y, x) / r + 360) % 360 };
  };
  const when = t => { const d = new Date(t * 1000), n = new Date(), same = d.toDateString() === n.toDateString(), tm = new Date(n.getTime() + 864e5).toDateString() === d.toDateString(); return (same ? 'Today' : tm ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })) + ' ' + RS.clock(t); };
  const inMin = t => { const m = Math.round((t - Date.now() / 1000) / 60); return m <= 0 ? 'now' : m < 60 ? 'in ' + m + ' min' : 'in ' + Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };

  // SPACE: see space.js

  // ================================================================ HAM
  const Hm = RS.pages.ham = {};
  const HB = [
    { id: 'h2', name: '2 m (VHF)', lo: 144e6, hi: 146e6, mode: 'nfm', span: 800e3 },
    { id: 'h70', name: '70 cm (UHF)', lo: 430e6, hi: 440e6, mode: 'nfm', span: 2e6 },
    { id: 'h6', name: '6 m', lo: 50e6, hi: 54e6, mode: 'nfm', span: 800e3 },
    { id: 'h10', name: '10 m', lo: 28e6, hi: 29.7e6, mode: 'usb', span: 200e3, hf: 1 },
    { id: 'h20', name: '20 m', lo: 14e6, hi: 14.35e6, mode: 'usb', span: 100e3, hf: 1 },
    { id: 'h40', name: '40 m', lo: 7e6, hi: 7.3e6, mode: 'lsb', span: 100e3, hf: 1 },
    { id: 'h80', name: '80 m', lo: 3.5e6, hi: 3.9e6, mode: 'lsb', span: 100e3, hf: 1 },
    { id: 'h160', name: '160 m', lo: 1.8e6, hi: 2e6, mode: 'lsb', span: 60e3, hf: 1 },
  ];
  // 2 m and 70 cm follow the region's band plan (144 to 146 or 148 MHz; 420 or 430 to 440 or 450 MHz)
  function hamBands() { const R = RS.region || {}; if (R.ham_2m) { HB[0].lo = R.ham_2m[0]; HB[0].hi = R.ham_2m[1]; } if (R.ham_70) { HB[1].lo = R.ham_70[0]; HB[1].hi = R.ham_70[1]; } }
  hamBands(); RS.on('hello', hamBands);
  let hdial, hscope;
  Hm.init = () => {
    $('#p-ham').innerHTML = `
    <div class="page-head"><h2>Amateur radio</h2><p>Hams are licensed hobbyists who talk to each other by radio. Anyone can <b>listen</b>. Transmitting needs a licence, and this app only receives.</p></div>
    <div class="glass dial-card">
      <div class="band-chips" id="hm-bands" role="group" aria-label="Choose a ham band"></div>
      <div class="readout"><div><div class="freq" id="hm-freq">--<small>MHz</small></div><div class="station-name" id="hm-name">&nbsp;</div><div class="station-sub" id="hm-sub">&nbsp;</div></div>
        <div style="min-width:220px"><div class="station-sub">Signal strength <span id="hm-s" class="mini-readout"></span></div><div class="smeter" style="margin-top:6px"><i id="hm-smeter"></i></div><div class="station-sub tiny" style="margin-top:4px">S-meter is approximate. 9 = a very strong signal.</div></div></div>
      <canvas class="dial" id="hm-cv"></canvas><canvas class="overview" id="hm-ov"></canvas>
      <div class="tune-controls"><button class="btn" data-act="hm-nudge" data-n="-10" aria-label="Down ten steps">${icon('left')}${icon('left')}</button><button class="btn" data-act="hm-nudge" data-n="-1" aria-label="Down one step">${icon('left')}</button><button class="btn" data-act="hm-nudge" data-n="1" aria-label="Up one step">${icon('right')}</button><button class="btn" data-act="hm-nudge" data-n="10" aria-label="Up ten steps">${icon('right')}${icon('right')}</button><span class="grow"></span>
        <div class="seg" id="hm-modes" role="group" aria-label="Mode"></div><button class="btn" id="hm-star" data-act="hm-fav">&#9734; Save</button><button class="btn" data-act="timer-here" title="Record this channel at a set time">Schedule</button></div>
      <div class="dial-help" id="hm-hf" style="display:none">Short-wave bands (below 30 MHz) need a V4 or direct-sampling mode, and a long wire antenna. Expect weak, noisy results with the stock antenna.</div>
    </div>
    <div class="two-col" style="margin-top:14px">
      <div class="card"><div class="card-head"><div><h3>APRS: position reports ${RS.hint('APRS is a network where hams send short position and weather reports on a regional frequency (144.390 MHz in North America, 144.800 in Europe, 145.175 in Australia and New Zealand). Your region choice in Settings picks the right one. Switch it on and the radio decodes them, then plots them on the map. Reports arrive in bursts, sometimes minutes apart.', 'ap')}</h3><div class="sub">Local hams, weather stations and the space station.</div></div>
        <button class="btn" id="hm-aprs" data-act="hm-aprs" aria-pressed="false">Start decoding</button></div>
        <div class="map" id="hm-map" style="height:300px;margin-bottom:12px"></div>
        <div class="apr-list" id="hm-list"></div></div>
      <div class="stack">
        <div class="card"><h3>Quick channels</h3><div class="sub">Handy places to start on 2 m.</div><div class="station-grid" id="hm-mem"></div></div>
        <div class="card"><h3>What is on each band?</h3><ul class="small" style="margin:6px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:5px">
          <li><b>2 m and 70 cm:</b> local chat, repeaters, APRS. Mostly FM. Needs no special antenna to try.</li>
          <li><b>6 m and 10 m:</b> local to worldwide, depending on the sun. Voice is usually USB.</li>
          <li><b>20 m:</b> the busiest worldwide band during the day (USB).</li>
          <li><b>40 m, 80 m, 160 m:</b> regional chat and nets, best at night (LSB).</li>
          <li class="muted">Band edges follow your region's plan where known, but check your national band plan before relying on a spot.</li></ul></div>
      </div>
    </div>
    <details class="card more" style="margin-top:14px;padding:12px 18px"><summary>Show the signal picture</summary>
      <div class="glass scope"><canvas class="spec" id="hm-spec"></canvas><canvas class="water" id="hm-water"></canvas><div class="scope-bar"><span id="hm-scope-info">Waiting for the radio...</span></div></div></details>`;
    hdial = new RS.Dial({ canvas: $('#hm-cv'), overview: $('#hm-ov'), bands: HB, hint: '', onBand: () => Hm.state() });
    hscope = new RS.Scope($('#hm-spec'), $('#hm-water'), $('#hm-scope-info'));
    RS.on('spec', L => { if (RS.page === 'ham') hscope.frame(L); });
    RS.editFreq($('#hm-freq'), f => RS.tune(f, { recenter: true }));
    $('#hm-bands').innerHTML = HB.map(b => '<button class="chip" data-act="hm-band" data-id="' + b.id + '" aria-pressed="false">' + b.name + '</button>').join('');
    $('#hm-modes').innerHTML = ['nfm', 'usb', 'lsb', 'cw', 'am'].map(k => '<button data-act="hm-mode" data-m="' + k + '" aria-pressed="false" title="' + RS.MODES[k].long + '">' + RS.MODES[k].name + '</button>').join('');
    Hm.map = new RS.Map($('#hm-map'), { zoom: 7, draw: drawAprs, onPick: it => { Hm.sel = it && it.from; Hm.list(); Hm.map.dirty = true; } });
    RS.on('aprs', () => { Hm.list(); if (Hm.map) Hm.map.dirty = true; });
    RS.on('favourites', () => Hm.state());
    const loop = () => { if (RS.page === 'ham') { hdial.render(); Hm.map.loop(); } requestAnimationFrame(loop); }; loop();
  };
  Hm.enter = () => {
    const f = RS.vfo(); if (!HB.some(b => f >= b.lo && f <= b.hi)) { hdial.setBand('h2', true); }
    hdial.sync(); hdial.dirty = true; Hm.map.setView(RS.cfg.lat, RS.cfg.lon, 7); Hm.state(); Hm.list(); Hm.mem();
  };
  Hm.state = () => {
    if (RS.page !== 'ham' || !hdial) return;
    const f = RS.vfo(), m = RS.curMode(), p = RS.freqParts(f, m);
    if (hdial.band.id !== 'all') { const b = HB.find(x => f >= x.lo && f <= x.hi); if (b && b !== hdial.band) { hdial.band = b; hdial.span = b.span; } }
    { const fe = $('#hm-freq'), fh = RS.fmtHtml(p); if (!fe.classList.contains('editing') && fe._h !== fh) { fe._h = fh; fe.innerHTML = fh; } }
    $('#hm-name').textContent = RS.nameFor(f) || RS.bandName(f) || ' ';
    $('#hm-sub').textContent = RS.MODES[m] ? RS.MODES[m].long : m;
    RS.$$('#hm-bands .chip').forEach(c => c.setAttribute('aria-pressed', c.dataset.id === hdial.band.id ? 'true' : 'false'));
    RS.$$('#hm-modes button').forEach(c => c.setAttribute('aria-pressed', c.dataset.m === m ? 'true' : 'false'));
    const live = RS.live, snr = live && performance.now() - live.t < 1500 ? live.snr : (RS.st.snr || 0);
    const s = Math.max(0, Math.min(9, Math.round(snr / 4)));
    $('#hm-s').textContent = snr > 36 ? 'S9+' + Math.round((snr - 36) / 5) * 5 : 'S' + s;
    $('#hm-smeter').style.width = Math.max(2, Math.min(100, snr / 50 * 100)) + '%';
    const fav = RS.isFav(f); RS.setText($('#hm-star'), fav ? '\u2605 Saved' : '\u2606 Save'); $('#hm-star').classList.toggle('on', fav);
    $('#hm-hf').style.display = f < 30e6 ? 'block' : 'none';
    const ap = $('#hm-aprs'); RS.setText(ap, RS.st.aprs ? 'Stop decoding' : 'Start decoding'); ap.classList.toggle('on', !!RS.st.aprs); ap.setAttribute('aria-pressed', !!RS.st.aprs);
    hdial.dirty = true;
  };
  RS.on('local', () => { if (RS.page === 'ham') Hm.state(); });
  Hm.mem = () => {
    const ch = (RS.banks.find(b => b.id === 'ham_vhf') || { channels: [] }).channels.concat(RS.favs.filter(f => HB.some(b => f.f >= b.lo && f.f <= b.hi)).map(f => ({ f: f.f, label: f.name, mode: f.mode })));
    const seen = new Set(); $('#hm-mem').innerHTML = ch.filter(c => !seen.has(c.f) && seen.add(c.f)).map(c => '<button class="station" data-act="rd-pick" data-f="' + c.f + '" data-mode="' + c.mode + '"><b>' + RS.fmt(c.f, c.mode) + '</b><span class="nm">' + esc(c.label) + '</span></button>').join('');
  };
  function aprsByCall() { const m = new Map(); RS.aprs.forEach(p => { if (!m.has(p.from)) m.set(p.from, p); }); return Array.from(m.values()); }
  function drawAprs(g, w, h, tiles) {
    const mp = Hm.map, home = mp.proj(RS.cfg.lat, RS.cfg.lon);
    g.fillStyle = '#0d6e7b'; g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.beginPath(); g.arc(home.x, home.y, 7, 0, 7); g.fill(); g.stroke();
    g.font = '700 12px "B612 Mono", monospace';
    aprsByCall().forEach(p => {
      if (p.lat == null) return; const q = mp.proj(p.lat, p.lon), sel = p.from === Hm.sel;
      g.fillStyle = sel ? '#ffb52e' : '#d6452f'; g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(q.x, q.y, sel ? 8 : 6, 0, 7); g.fill(); g.stroke();
      g.fillStyle = tiles ? '#102' : '#fff'; g.strokeStyle = tiles ? '#ffffffcc' : '#000a'; g.lineWidth = 3; g.textAlign = 'left'; g.strokeText(p.from, q.x + 10, q.y - 8); g.fillText(p.from, q.x + 10, q.y - 8);
      mp.hit.push({ x: q.x, y: q.y, item: p });
    });
  }
  Hm.list = () => {
    const el = $('#hm-list'); if (!el) return;
    const L = aprsByCall();
    el.innerHTML = L.length ? L.slice(0, 40).map(p => {
      let where = '';
      if (p.lat != null) { const d = RS.dist(RS.cfg.lat, RS.cfg.lon, p.lat, p.lon); where = Math.round(d.km) + ' km ' + compass(d.brg); }
      const what = p.message ? 'Message: ' + p.message : p.status ? p.status : p.comment ? p.comment : p.format || 'position';
      return '<div class="ap-row"><div class="row sp-between nowrap"><b>' + esc(p.from) + '</b><span class="small muted">' + RS.ago(p.t) + '</span></div><div class="small">' + esc(what) + '</div>' + (where ? '<div class="small muted">' + where + (p.altitude ? '' : '') + '</div>' : '') + '</div>';
    }).join('') : '<div class="empty"><strong>' + (RS.st.aprs ? 'Listening...' : 'No reports yet') + '</strong>' + (RS.st.aprs ? 'Reports can take a few minutes to arrive. A 2 m antenna helps a lot.' : 'Press "Start decoding" to tune to 145.175 MHz and listen for APRS.') + '</div>';
  };
  RS.act['hm-band'] = b => { hdial.setBand(b.dataset.id); Hm.state(); };
  RS.act['hm-nudge'] = b => hdial.nudge(parseInt(b.dataset.n));
  RS.act['hm-mode'] = b => { RS.autoMode = false; RS.store.set('automode', false); RS.setMode(b.dataset.m); };
  RS.act['hm-fav'] = () => RS.toggleFav(RS.vfo(), RS.curMode());
  RS.act['hm-aprs'] = () => {
    if (RS.st.aprs) { RS.send({ cmd: 'aprs', on: false }); return; }
    const f = (RS.region && RS.region.aprs) || 144.8e6;          // the APRS frequency of the chosen region
    RS.tune(f, { mode: 'nfm', bw: 16000, recenter: true }); RS.send({ cmd: 'aprs', on: true });
    hdial.setBand('h2', false); RS.toast('Tuned to ' + (f / 1e6).toFixed(3) + ' MHz and decoding APRS.');
  };

  // SENSORS: see sensors.js (it also holds the spectrum survey shown on Explore)

  // ================================================================ EXPLORE
  const Ex = RS.pages.explore = {};
  Ex.cur = null;
  Ex.init = () => {
    $('#p-explore').innerHTML = `
    <div class="page-head"><h2>Explore</h2><p>Sweep any part of the radio spectrum and see where the activity is. Good for finding things you did not know were there.</p></div>
    <div class="card" style="margin-bottom:14px"><h3>Pick somewhere to look</h3><div class="sub">Each sweep takes from a few seconds to a minute. Sound pauses while it works.</div><div class="band-chips" id="ex-chips"></div>
      <div class="adv-only"><div class="row" style="align-items:end"><label class="field">From (MHz)<input type="text" id="ex-a" value="88" inputmode="decimal" style="width:130px"></label><label class="field">To (MHz)<input type="text" id="ex-b" value="108" inputmode="decimal" style="width:130px"></label><button class="btn primary" data-act="ex-custom">${icon('search')}Sweep this range</button><span class="small muted" id="ex-est"></span></div></div></div>
    <div class="card" style="margin-bottom:14px"><div class="card-head"><div><h3 id="ex-title">Results</h3><div class="sub" id="ex-sub">Choose a band above to begin.</div></div></div>
      <div class="progress hide" id="ex-prog" style="margin-bottom:10px"><i></i></div>
      <div class="glass" style="padding:10px"><canvas class="sweep-chart" id="ex-chart" aria-label="Signal strength across the swept range. Tap to tune."></canvas></div>
      <div class="tiny muted" style="margin-top:6px">Higher peaks are stronger signals. Tap the chart to listen to that frequency.</div></div>
    <div class="card"><div class="card-head"><div><h3>Signals found</h3><div class="sub" id="ex-psub"></div></div><label class="field" style="width:220px"><span class="sr-only">Filter</span><input type="search" id="ex-q" placeholder="Filter, e.g. air or 146"></label></div>
      <div class="scroll-x"><table class="tbl"><thead><tr><th>Frequency</th><th>Strength</th><th>What is usually here</th><th></th></tr></thead><tbody id="ex-rows"></tbody></table></div><div class="empty hide" id="ex-empty"><strong>Nothing yet</strong>Run a sweep to fill this list.</div></div>
    <div class="card" style="margin-top:14px"><h3>What is on this frequency?</h3><div class="row"><input type="text" id="ex-w" placeholder="e.g. 156.8" inputmode="decimal" style="max-width:200px"><button class="btn" data-act="ex-what">Look up</button><span id="ex-what" class="small"></span></div></div>`;
    Ex.chips = () => {                                       // rebuilt when the region changes
    const R = RS.region || {}, fm = R.fm || [87.5e6, 108e6], am = R.am || [531e3, 1602e3, 9e3], h2 = R.ham_2m || [144e6, 146e6], w = R.walkie, s0 = (R.ism || [433.92e6])[0];
    const chips = [['FM radio', fm[0], fm[1], 'wfm'], ['AM radio', am[0], am[1] + am[2], 'am'], ['Aircraft', 118e6, 137e6, 'am'], ['Marine', 156e6, 162.6e6, 'nfm'], ['Ham 2 m', h2[0], h2[1], 'nfm']]
      .concat(w ? [[w.name, w.lo, w.hi, 'nfm']] : [], [['Weather satellites', 137e6, 138e6, 'nfm'], ['Sensors ' + Math.round(s0 / 1e6), s0 - 1e6, s0 + 1e6, 'nfm']]);
    $('#ex-chips').innerHTML = chips.map((c, i) => '<button class="chip" data-act="ex-band" data-i="' + i + '" aria-pressed="false">' + c[0] + '</button>').join('');
    Ex.chipsData = chips;
    };
    Ex.chips(); RS.on('hello', () => Ex.chips());
    RS.on('sweepdata', e => { if (RS.page === 'explore') Ex.update(e); });
    $('#ex-q').oninput = () => Ex.rows();
    ['#ex-a', '#ex-b'].forEach(s => $(s).oninput = Ex.est);
    $('#ex-chart').addEventListener('click', ev => {
      const s = Ex.cur; if (!s) return; const r = ev.currentTarget.getBoundingClientRect(), f = s.start + (ev.clientX - r.left) / r.width * (s.stop - s.start);
      RS.go('radio'); RS.tune(RS.snap(f, RS.modeFor(f)), { recenter: true }); RS.toast('Tuned to ' + RS.fmt(f) + '.');
    });
    window.addEventListener('resize', () => Ex.chart());
  };
  Ex.enter = () => { Ex.cur = Ex.cur || RS.sweeps[RS.sweeps.length - 1] || null; Ex.update(Ex.cur); Ex.est(); };
  Ex.est = () => { const a = RS.parseFreq($('#ex-a').value, 'm'), b = RS.parseFreq($('#ex-b').value, 'm'); if (a && b && b > a) { const hops = Math.ceil((b - a) / (0.78 * (RS.cfg.sample_rate || 2.4e6))); $('#ex-est').textContent = 'About ' + (hops < 2 ? 'a few seconds' : RS.dur(hops * 0.8)); } else $('#ex-est').textContent = ''; };
  Ex.update = e => {
    if (e) Ex.cur = e;
    const sw = RS.sweepNow, prog = $('#ex-prog');
    prog.classList.toggle('hide', !sw); if (sw) prog.firstChild.style.width = Math.round(sw.hop / Math.max(sw.hops, 1) * 100) + '%';
    const s = Ex.cur;
    $('#ex-title').textContent = s ? 'Sweep: ' + RS.fmt(s.start) + ' to ' + RS.fmt(s.stop) : 'Results';
    $('#ex-sub').textContent = s ? (sw ? 'Searching... ' + sw.hop + ' of ' + sw.hops + ' steps' : 'Done ' + RS.ago(s.t / 1000)) : 'Choose a band above to begin.';
    Ex.marks();
    Ex.chart(); Ex.rows();
  };
  // light up the chip for the range being swept (or last swept)
  Ex.marks = () => {
    const t = RS.sweepNow || Ex.cur, near = (a, b) => Math.abs(a - b) < 2000;
    RS.$$('#ex-chips .chip').forEach(el => { const c = Ex.chipsData[+el.dataset.i]; const on = Ex.pick === +el.dataset.i || (t && t.start != null && near(t.start, c[1]) && near(t.stop, c[2])); el.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  };
  Ex.chart = () => {
    const cv = $('#ex-chart'), c = RS.fit(cv), s = Ex.cur; if (!c) return;
    const g = c.g, w = c.w, h = c.h; g.clearRect(0, 0, w, h);
    if (!s) { g.fillStyle = '#9fb6bf'; g.font = '15px Atkinson, sans-serif'; g.textAlign = 'center'; g.fillText('No sweep yet', w / 2, h / 2); return; }
    const vals = []; for (let i = 0; i < s.n; i++) if (s.u8[i]) vals.push(s.u8[i] / 2.2 - 110);
    const srt = vals.slice().sort((a, b) => a - b), floor = srt.length ? srt[Math.floor(srt.length * 0.3)] : -90;
    g.strokeStyle = '#ffffff14'; g.lineWidth = 1; for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, h * i / 4); g.lineTo(w, h * i / 4); g.stroke(); }
    g.beginPath(); g.moveTo(0, h - 18);
    const step = Math.max(1, Math.floor(s.n / (w * 2)));
    for (let i = 0; i < s.n; i += step) { let m = -200; for (let k = 0; k < step && i + k < s.n; k++) if (s.u8[i + k]) m = Math.max(m, s.u8[i + k] / 2.2 - 110); const v = m < -150 ? floor : m, t = Math.min(Math.max((v - floor) / 50, 0), 1); g.lineTo(i / (s.n - 1) * w, h - 18 - t * (h - 30)); }
    g.lineTo(w, h - 18); g.closePath(); g.fillStyle = '#ffb52e33'; g.fill(); g.strokeStyle = '#ffb52e'; g.lineWidth = 1.3; g.stroke();
    RS.peaks.forEach(p => { if (p.f >= s.start && p.f <= s.stop) { const x = (p.f - s.start) / (s.stop - s.start) * w; g.fillStyle = '#6fd0dc'; g.beginPath(); g.arc(x, 8, 3.5, 0, 7); g.fill(); } });
    g.fillStyle = '#9fb6bf'; g.font = '12px "B612 Mono", monospace'; g.textAlign = 'center';
    for (let i = 0; i <= 5; i++) { const f = s.start + (s.stop - s.start) * i / 5, x = Math.min(Math.max(i / 5 * w, 30), w - 30); g.fillText(RS.fmt(f).replace(/\.0+ /, ' '), x, h - 4); }
  };
  Ex.rows = () => {
    const s = Ex.cur, q = ($('#ex-q').value || '').trim().toLowerCase();
    let L = s ? RS.peaks.filter(p => p.f >= s.start - s.res && p.f <= s.stop + s.res) : [];
    if (q) L = L.filter(p => (p.band || '').toLowerCase().includes(q) || RS.fmt(p.f).toLowerCase().includes(q));
    L.sort((a, b) => b.db - a.db);
    $('#ex-psub').textContent = L.length ? L.length + ' signals, strongest first' : '';
    $('#ex-rows').innerHTML = L.slice(0, 120).map(p => '<tr><td class="num"><b>' + RS.fmt(p.f, p.mode) + '</b></td><td><span class="bars station" style="min-height:0;border:0;padding:0;display:inline-flex"><span class="bars">' + [10, 18, 26, 34].map(t => '<i class="' + (p.db > t ? 'on' : '') + '"></i>').join('') + '</span></span> <span class="small muted">+' + Math.round(p.db) + ' dB</span></td><td>' + esc(RS.nameFor(p.f) || p.band || '-') + '</td><td class="nowrap"><button class="btn small" data-act="ex-listen" data-f="' + p.f + '" data-mode="' + (p.mode || '') + '">' + icon('sound') + 'Listen</button> <button class="btn small ghost" data-act="ex-fav" data-f="' + p.f + '" data-mode="' + (p.mode || '') + '" aria-label="Save to favourites">' + (RS.isFav(p.f) ? '&#9733;' : '&#9734;') + '</button></td></tr>').join('');
    $('#ex-empty').classList.toggle('hide', L.length > 0);
  };
  RS.act['ex-band'] = b => { Ex.pick = +b.dataset.i; Ex.marks(); const c = Ex.chipsData[+b.dataset.i]; RS.send({ cmd: 'sweep', start: c[1], stop: c[2], mode: c[3], thr: RS.store.get('thr', 10), purpose: 'explore', return_to: RS.vfo() }); RS.sweepNow = { hop: 0, hops: 1 }; Ex.update(); };
  RS.act['ex-custom'] = () => {
    Ex.pick = null;
    const a = RS.parseFreq($('#ex-a').value, 'm'), b = RS.parseFreq($('#ex-b').value, 'm');
    if (!a || !b || b <= a || a < 0.5e6 || b > 1.75e9) { RS.toast('Enter a start and end between 0.5 and 1700 MHz, with the end above the start.', 'bad'); return; }
    RS.send({ cmd: 'sweep', start: a, stop: b, mode: RS.modeFor((a + b) / 2), thr: RS.store.get('thr', 10), purpose: 'explore', return_to: RS.vfo() }); RS.sweepNow = { hop: 0, hops: 1 }; Ex.update();
  };
  RS.act['ex-listen'] = b => { if (!RS.audio.on) RS.audio.start(); RS.go('radio'); RS.tune(parseFloat(b.dataset.f), { mode: b.dataset.mode || undefined, recenter: true }); };
  RS.act['ex-fav'] = b => { RS.toggleFav(parseFloat(b.dataset.f), b.dataset.mode || undefined); setTimeout(Ex.rows, 50); };
  RS.act['ex-what'] = () => { const f = RS.parseFreq($('#ex-w').value, 'm'), el = $('#ex-what'); if (!f) { el.textContent = 'Type a frequency in MHz.'; return; } el.innerHTML = '<b>' + RS.fmt(f) + '</b>: ' + esc(RS.bandName(f) || 'not in the built-in band list') + ' (' + (RS.MODES[RS.modeFor(f)] || {}).long + ')'; };

  // ================================================================ LIBRARY (recordings)
  const Lb = RS.pages.library = {};
  Lb.dec = []; Lb.live = {};
  Lb.init = () => {
    $('#p-library').innerHTML = `
    <div class="page-head"><h2>Library</h2><p>Everything you have recorded, and the weather pictures made from satellite passes.</p></div>
    <div class="card" style="margin-bottom:14px"><div class="card-head"><div><h3>Pictures from space ${RS.hint('When a Meteor weather satellite flies over, Skywave records its radio signal and turns it into cloud pictures, one per colour of light the satellite sees, plus a PDF report you can print or share. Go to Space, find a Meteor pass, and press Record this pass. Pictures sent by the space station (slow-scan TV, during special events) are found in sound recordings: use Look for a picture next to a recording below.', 'wp')}</h3><div class="sub" id="lb-dsub"></div></div></div><div id="lb-dec"></div></div>
    <div class="card" style="margin-bottom:14px"><div class="card-head"><div><h3>Timed recordings ${RS.hint('Pick any frequency, a start time and how long. The radio tunes there by itself and records the sound, or just writes down what is said, even with the page closed. You can repeat it every day.', 'lb-timers')}</h3><div class="sub">Record any channel at a set time.</div></div><button class="btn primary" data-act="timer-new">Schedule a recording</button></div><div id="lb-timers"></div></div>
    <div class="card" style="margin-bottom:14px"><div class="card-head"><div><h3>Transcripts ${RS.hint('Plain text of what was said on a spoken channel, made by speech-to-text. It is not always right, especially with weak signals. Turn captions on with the CC button at the bottom, or schedule a text-only recording.', 'lb-tx')}</h3><div class="sub" id="lb-tx-sub"></div></div></div><div id="lb-tx"></div></div>
    <div class="card"><div class="card-head"><div><h3>Recordings</h3><div class="sub" id="lb-sub"></div></div><button class="btn" data-act="lb-reload">Refresh</button></div><div id="lb-list"></div></div>`;
    RS.on('recording', () => { if (RS.page === 'library') setTimeout(Lb.load, 400); });
    RS.on('record_done', () => { if (RS.page === 'library') Lb.load(); });
    RS.on('decode_progress', m => { Lb.live[m.id] = m; if (RS.page === 'library') Lb.decList(); });
    RS.on('decode_done', m => { delete Lb.live[m.id]; if (RS.page === 'library') Lb.load(); if (m.ok) RS.toast('Weather pictures are ready. Open the Library to see them.'); else if (m.error) RS.toast(m.error, 'bad'); });
  };
  Lb.timers = () => {
    const l = $('#lb-timers'); if (!l) return; const sa = (RS.st && RS.st.job === 'listen');
    l.innerHTML = RS.timers.length ? RS.timers.map(t => '<div class="rec-row"><div><b>' + RS.esc(t.label || RS.fmt(t.freq, t.mode)) + '</b><div class="small muted">' + RS.timerWhen(t) + ' for ' + RS.timerDur(t.duration) + ' - ' + RS.fmt(t.freq, t.mode) + ' - ' + ({ sound: 'sound', text: 'transcript only', both: 'sound and transcript' }[t.what]) + ({ none: '', daily: ' - every day', weekdays: ' - weekdays', weekly: ' - every week' }[t.repeat] || '') + (t.last_run === t.start ? ' - <b>recording now</b>' : '') + '</div></div><button class="btn small" data-act="timer-del" data-id="' + t.id + '">' + (t.last_run === t.start ? 'Stop' : 'Cancel') + '</button></div>').join('') : '<div class="muted small">Nothing scheduled. Use the button to record a channel at a set time.</div>';
    void sa;
  };
  Lb.transcripts = async () => {
    const l = $('#lb-tx'); if (!l) return;
    try {
      const r = await RS.api('transcripts'); const fs = (r && r.files) || [];
      $('#lb-tx-sub').textContent = fs.length ? fs.length + ' transcript' + (fs.length > 1 ? 's' : '') : '';
      l.innerHTML = fs.length ? fs.map(f => '<div class="rec-row"><div><b>' + RS.esc(f.name.replace(/\.txt$/, '')) + '</b><div class="small muted">' + f.lines + ' lines - ' + RS.mb(f.size) + '<br>' + RS.esc(f.preview) + '</div></div><div class="row tight"><button class="btn small" data-act="tx-view" data-f="' + RS.esc(f.name) + '">Read</button><a class="btn small" href="/txt/' + encodeURIComponent(f.name) + '?download=1">Download</a><button class="btn small" data-act="tx-del" data-f="' + RS.esc(f.name) + '">Delete</button></div></div>').join('') : '<div class="muted small">No transcripts yet. Press the CC button at the bottom while listening to a spoken channel (UHF CB, aircraft, marine, ham), and tick "Also save as a text file".</div>';
    } catch (e) { l.textContent = ''; }
  };
  Lb.enter = () => { Lb.load(); Lb.timers(); Lb.transcripts(); };
  Lb.load = async () => {
    try {
      const [r, d] = await Promise.all([RS.api('recordings'), RS.api('decodes')]);
      Lb.files = r.files; Lb.dec = d.items; Lb.dstatus = d.status;
      $('#lb-sub').textContent = r.files.length + ' file' + (r.files.length === 1 ? '' : 's') + (r.free_gb != null ? ' - ' + r.free_gb + ' GB free' : '');
      Lb.decList();
      const decoded = new Set(Lb.dec.map(x => x.rec));
      $('#lb-list').innerHTML = r.files.length ? r.files.map((f, i) => {
        const nice = f.name.replace(/_iq\.wav$|\.wav$|\.mp3$/, '').replace(/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)_/, '$1-$2-$3 $4:$5 - ').replace(/_/g, ' ');
        const wx = f.iq && f.decode === 'lrpt', can = Lb.dstatus && Lb.dstatus.available;
        return '<div class="rec-row" data-name="' + esc(f.name) + '"><div><b>' + esc(nice) + '</b><div class="small muted">' + RS.mb(f.size) + ' &middot; ' + RS.ago(f.t) + (f.iq ? ' &middot; <span class="badge">Raw radio data</span>' : '') + (wx ? ' &middot; <span class="badge good">Weather satellite</span>' : '') + '</div></div><div class="row tight">' +
          (f.iq ? '' : '<button class="btn small" data-act="lb-play" data-i="' + i + '">' + icon('play') + 'Play</button>') +
          (wx && can ? '<button class="btn small primary" data-act="lb-decode" data-i="' + i + '">' + (decoded.has(f.name.replace(/\.wav$/, '')) || Lb.dec.some(x => x.rec === f.name) ? 'Make pictures again' : 'Make weather pictures') + '</button>' : '') +
          (f.iq && !wx && can ? '<button class="btn small adv-only" data-act="lb-decode" data-force="1" data-i="' + i + '">Try as weather satellite</button>' : '') +
          (!f.iq && Lb.dstatus && Lb.dstatus.sstv ? '<button class="btn small' + (/iss|sstv/i.test(f.name) ? '' : ' adv-only') + '" data-act="lb-decode" data-i="' + i + '">Look for a picture (SSTV)</button>' : '') +
          '<a class="btn small" href="/rec/' + encodeURIComponent(f.name) + '?download=1">Download</a><button class="btn small ghost danger" data-act="lb-del" data-i="' + i + '">Delete</button></div></div>';
      }).join('') : '<div class="empty"><strong>No recordings yet</strong></div>';
      Lb.mark();
    } catch (e) { RS.toast(e.message, 'bad'); }
  };
  Lb.decList = () => {
    const el = $('#lb-dec'); if (!el) return;
    const st = Lb.dstatus || {}, items = Lb.dec.filter(x => !Lb.live[x.id]).concat(Object.values(Lb.live));
    $('#lb-dsub').textContent = items.length ? items.length + ' pass' + (items.length === 1 ? '' : 'es') : '';
    let h = '';
    if (st.available === false) h += '<div class="banner warn"><div class="txt"><strong>The picture decoder is not installed</strong>Missing: ' + esc((st.missing || []).join(', ')) + '. Rebuild the project from the latest files to add it. Your recordings can still be opened in SatDump on a computer.</div></div>';
    h += items.length ? items.map(x => {
      if (x.state) return '<div class="rec-row"><div><b>' + esc(x.id.replace(/_iq$/, '').replace(/_/g, ' ')) + '</b><div class="small muted">' + esc(x.text) + '</div><div class="progress" style="margin-top:6px"><i style="width:' + Math.round(x.pct || 0) + '%"></i></div></div></div>';
      const when = x.t0 ? new Date(x.t0 * 1000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : x.id;
      const comp = (x.images || [])[0];
      if (!x.ok) return '<div class="rec-row"><div><b>' + esc(x.sat_name || x.sat || x.rec) + ' &middot; ' + esc(when) + '</b><div class="small" style="color:var(--bad)">' + esc(x.error || 'Could not be decoded.') + '</div></div><div class="row tight"><button class="btn small ghost danger" data-act="dec-del" data-id="' + esc(x.id) + '">Remove</button></div></div>';
      return '<div class="rec-row wx"><div class="row" style="flex-wrap:nowrap;align-items:center;gap:14px">' + (comp ? '<a href="/dec/' + encodeURIComponent(x.id) + '/' + comp.file + '" data-act="dec-view" data-id="' + esc(x.id) + '"><img class="wx-thumb" alt="Weather picture" src="/dec/' + encodeURIComponent(x.id) + '/' + comp.thumb + '"></a>' : '') +
        '<div><b>' + esc(x.kind === 'sstv' ? 'Slow-scan TV' : (x.sat_name || x.sat)) + '</b><div class="small muted">' + esc(when) + (x.max_el ? ' &middot; peaked at ' + Math.round(x.max_el) + '&deg;' : '') + ' &middot; ' + (x.images || []).length + ' picture' + ((x.images || []).length === 1 ? '' : 's') + '</div></div></div>' +
        '<div class="row tight"><button class="btn small primary" data-act="dec-view" data-id="' + esc(x.id) + '">View</button>' + (x.report ? '<a class="btn small" href="/dec/' + encodeURIComponent(x.id) + '/report.pdf?download=1">PDF report</a>' : '<button class="btn small" data-act="dec-pdf" data-id="' + esc(x.id) + '">Make PDF</button>') + '<button class="btn small ghost danger" data-act="dec-del" data-id="' + esc(x.id) + '">Delete</button></div></div>';
    }).join('') : '<div class="empty"><strong>No pictures yet</strong>Go to Space, find a Meteor pass above 30&deg;, and press Record this pass. The pictures appear here a few minutes after the pass ends.</div>';
    el.innerHTML = h;
  };
  RS.act['lb-decode'] = async b => {
    const f = Lb.files[+b.dataset.i];
    try { await RS.api('decode', { file: f.name, force: !!b.dataset.force }); RS.toast('Working on it. This can take a few minutes.'); Lb.load(); } catch (e) { RS.toast(e.message, 'bad'); }
  };
  RS.act['dec-del'] = b => RS.confirm('Delete these pictures?', 'The recording itself is kept, so you can make them again.', 'Delete', () => RS.api('decodes/delete', { id: b.dataset.id }).then(Lb.load).catch(e => RS.toast(e.message, 'bad')));
  RS.act['dec-pdf'] = b => RS.api('decodes/report', { id: b.dataset.id }).then(Lb.load).catch(e => RS.toast(e.message, 'bad'));
  RS.act['dec-view'] = (b, ev) => {
    if (ev && ev.preventDefault) ev.preventDefault();
    const x = Lb.dec.find(y => y.id === b.dataset.id); if (!x) return;
    const u = f => '/dec/' + encodeURIComponent(x.id) + '/' + f, comp = x.images.find(i => i.composite), chans = x.images.filter(i => !i.composite);
    RS.modal('<h3 style="margin:0 0 4px">' + esc(x.kind === 'sstv' ? 'Slow-scan TV pictures' : (x.sat_name || x.sat)) + '</h3><div class="small muted" style="margin-bottom:10px">' + (x.t0 ? new Date(x.t0 * 1000).toLocaleString() : '') + (x.rotated ? ' &middot; turned so north is at the top' : '') + (x.method ? ' &middot; ' + esc(x.method) : '') + '</div>' +
      (x.kind === 'sstv' ? x.images.map(i => '<div class="small muted" style="margin:8px 0 4px">' + esc(i.title) + ' &middot; ' + esc(i.about) + '</div><div class="wx-full"><img alt="' + esc(i.title) + '" src="' + u(i.file) + '"></div>').join('') : comp ? '<div class="wx-full"><img alt="Weather picture" src="' + u(comp.file) + '"></div>' : '') +
      (x.kind !== 'sstv' && chans.length ? '<h4 style="margin:14px 0 6px">Single channels</h4><div class="wx-chans">' + chans.map(c => '<figure><a href="' + u(c.file) + '" target="_blank"><img alt="' + esc(c.title) + '" src="' + u(c.thumb) + '"></a><figcaption><b>' + esc(c.title) + '</b><br>' + esc(c.band) + '<br><span class="muted">' + esc(c.about) + '</span></figcaption></figure>').join('') + '</div>' : '') +
      '<div class="row" style="margin-top:14px;justify-content:flex-end">' + (x.report ? '<a class="btn primary" href="' + u('report.pdf') + '?download=1">Download PDF report</a>' : '') + '<button class="btn" data-act="closeModal">Close</button></div>');
  };
  RS.act['lb-reload'] = () => Lb.load();
  RS.act['lb-play'] = b => {
    const f = Lb.files[+b.dataset.i];
    if (RS.player.isCur(f.name)) RS.player.toggle(); else RS.player.play({ name: f.name, title: RS.player.nice(f.name) });
  };
  Lb.mark = () => RS.$$('#lb-list .rec-row[data-name]').forEach(r => {
    const cur = RS.player.isCur(r.dataset.name), on = cur && RS.player.playing(), b = r.querySelector('[data-act="lb-play"]');
    r.classList.toggle('sel', cur);
    if (b) b.innerHTML = RS.icon(on ? 'pause' : 'play') + (on ? 'Pause' : 'Play');
  });
  RS.on('player', Lb.mark);
  RS.act['lb-del'] = b => { const f = Lb.files[+b.dataset.i]; RS.confirm('Delete this recording?', f.name, 'Delete', () => RS.api('recordings/delete', { file: f.name }).then(Lb.load)); };

  // ================================================================ SETTINGS (+ help)
  const COVER = [
    ['Radio: FM, AM, SSB, CW and more', 'Built in', 'ok', 'Radio page. FM stations show their name and what is playing (RDS)'],
    ['Aircraft (ADS-B) and air-traffic voice', 'Built in', 'ok', 'Planes page'],
    ['Ships (AIS)', 'Built in', 'ok', 'Ships page. Two channels, shared by the one radio, so some reports are missed'],
    ['Weather radio (NOAA)', 'Built in', 'ok', 'Presets in Scanner for the US and Canada'],
    ['Amateur radio (APRS, Morse)', 'Built in', 'ok', 'Ham page. Morse is decoded into captions wherever it is used'],
    ['Weather satellite pictures (Meteor)', 'meteor_demod', 'tool', 'Space page. NOAA APT satellites were switched off in 2025'],
    ['Slow-scan TV from the space station', 'Built in', 'ok', 'Space page, when the station sends pictures'],
    ['Sensors and tyre pressure', 'rtl_433', 'ok', 'Sensors page'],
    ['US utility meters (ERT / R900)', 'rtlamr', 'tool', 'Sensors page, "US utility meters". Private-code meters cannot be read'],
  ];
  // 2 m and 70 cm follow the region's band plan (144 to 146 or 148 MHz; 420 or 430 to 440 or 450 MHz)
  function hamBands() { const R = RS.region || {}; if (R.ham_2m) { HB[0].lo = R.ham_2m[0]; HB[0].hi = R.ham_2m[1]; } if (R.ham_70) { HB[1].lo = R.ham_70[0]; HB[1].hi = R.ham_70[1]; } }
  hamBands(); RS.on('hello', hamBands);
  const St = RS.pages.settings = {};
  St.init = () => {
    $('#p-settings').innerHTML = `
    <div class="page-head"><h2>Settings and help</h2><p>Check your radio, set your language, region and location, and find answers.</p></div>
    <div class="stack">
    <div class="card" id="st-health"><div class="card-head"><div><h3>Check my radio</h3><div class="sub">Tests the radio on 8 frequencies and tells you in plain English whether it is healthy. Takes about 20 seconds.</div></div><button class="btn primary" data-act="st-health" id="st-hbtn">Check my radio</button></div>
      <div class="progress hide" id="st-hprog"><i></i></div><div class="small muted hide" id="st-htext" style="margin-top:6px"></div><div id="st-hrep"></div></div>

    <div class="card" id="st-loc"></div>

    <div class="card"><h3>Radio and reception</h3><div class="sub">Defaults suit most people. Change these only if something sounds wrong.</div>
      <div class="col">
        <label class="field"><span>Tuner gain ${RS.hint('Gain is like volume for the antenna signal. Too low and weak stations vanish; too high and strong ones distort or you hear strange extra stations. If FM sounds crackly or you hear many stations at once, lower it.', 'gn')}</span>
          <div class="row"><label class="check"><input type="checkbox" id="st-gauto"><span>Choose automatically</span></label></div>
          <div class="slider-row"><span class="end">Quiet</span><input type="range" id="st-gain" min="0" max="49.6" step="0.1"><span class="end" id="st-gain-v"></span></div></label>
        <label class="field adv-only">Frequency correction (ppm) <span class="hint">Cheap dongles drift slightly. Usually 0 on a V4, which has a precise clock.</span><input type="number" id="st-ppm" step="1" min="-200" max="200"></label>
        <label class="field adv-only">Low frequencies (below 24 MHz) <span class="hint">V4 handles this natively. Older dongles use "direct sampling" (poorer quality).</span><select id="st-hf"><option value="auto">Automatic</option><option value="direct">Always use direct sampling</option><option value="off">Off (use the tuner)</option></select></label>
        <label class="field adv-only">Sample rate <span class="hint">Higher shows more of the band at once. Lower it if your network or computer struggles.</span><select id="st-fs"></select></label>
        <label class="field adv-only">FM de-emphasis <span class="hint">50 µs in most of the world, 75 µs in the Americas (and South Korea). If FM music sounds dull or harsh, try the other.</span><select id="st-de"><option value="50">50 µs (Australia)</option><option value="75">75 µs (Americas)</option></select></label>
        <label class="check adv-only"><input type="checkbox" id="st-bias"><span>Power the antenna (bias tee, 4.5 V). Only for active antennas or LNAs.</span></label>
      </div></div>

    <div class="card"><h3>Recording and captions</h3><div class="sub">How sound recordings are saved, and whether spoken channels get live text captions.</div>
      <div class="field"><label for="st-afmt">Save recorded sound as</label><select id="st-afmt"><option value="mp3">MP3 (small files, recommended)</option><option value="wav">WAV (big files, perfect quality)</option></select>
        <div class="small muted">A WAV uses about 5.5 MB a minute. An MP3 at the default setting uses about 0.35 MB a minute, around 15 times less. Raw radio data for weather satellites is always saved as a WAV file, because that is the format the picture decoder reads.</div></div>
      <div class="field adv-only"><label for="st-kbps">MP3 quality</label><select id="st-kbps"><option value="32">32 kbps (smallest, speech only)</option><option value="48">48 kbps (good for speech)</option><option value="96">96 kbps (better)</option><option value="160">160 kbps (best)</option></select></div>
      <label class="check"><input type="checkbox" id="st-caps"><span>Allow live captions on spoken channels (walkie-talkies, aircraft, marine, ham, services)</span></label>
      <label class="check"><input type="checkbox" id="st-capsave"><span>Save captions as text files (in Library) whenever captions are on</span></label>
      <div class="field adv-only"><label for="st-capmodel">Caption accuracy</label><select id="st-capmodel"><option value="tiny.en">Fastest (tiny)</option><option value="base.en">Balanced (base)</option><option value="small.en">Most accurate (small, slow on a NAS)</option></select></div>
      <div class="small muted" id="st-cap-st" style="margin-top:6px"></div>
      <label class="check" style="margin-top:10px"><input type="checkbox" id="st-sync"><span>Refresh satellite orbits and frequencies from the internet at least once a day</span></label><div class="small muted" id="st-sync-st"></div></div>

    <div class="card"><h3>Weather satellite pictures</h3><div class="sub">When a recorded Meteor pass finishes, Skywave can turn it into pictures and a PDF report by itself. This uses a lot of the NAS for a few minutes.</div>
      <label class="check"><input type="checkbox" id="st-autodec"><span>Make weather pictures automatically after each recorded pass</span></label><div class="small muted" id="st-dec-st" style="margin-top:6px"></div></div>

    <div class="card" id="st-art"></div>
    <div class="card" id="st-sound"></div>
    <div class="card" id="st-themes"></div>
    <div class="card" id="st-motion"></div>

    <div class="card"><h3>Help</h3>
      <details class="help-q"><summary>I only hear hiss or static</summary><div>Static is normal where there is no station. Try these in order: (1) Press <b>Find stations</b> on the Radio page and pick one from the list; (2) fully extend and screw in the antenna and move it near a window; (3) run <b>Check my radio</b> above; (4) if gain is on Automatic, try a fixed middle value; (5) check the volume on the bar at the bottom.</div></details>
      <details class="help-q"><summary>Everything is quiet, even loud stations</summary><div>Press <b>Start sound</b> at the bottom. If the button already says "Sound on", check your device volume and that the page is not muted. On phones, flip the ring/silent switch.</div></details>
      <details class="help-q"><summary>It says no radio found</summary><div>The container cannot see the dongle. Unplug it, wait five seconds, and plug it into a different USB port (a USB 3 port directly on the computer works best, not a hub). Make sure the container runs in privileged mode with /dev/bus/usb shared, as in the supplied compose file. Then press <b>Try again</b>.</div></details>
      <details class="help-q"><summary>The radio check says the tuner is faulty</summary><div>If it says the tuner failed to lock on most frequencies, the dongle itself is faulty or a low-quality copy. Send the report from "Check my radio" to the seller and ask for a replacement. A genuine RTL-SDR Blog V4 shows "RTLSDRBlog" and an R828D tuner in the report.</div></details>
      <details class="help-q"><summary>Can I listen to police, fire and ambulance?</summary><div>Most emergency services now use digital or encrypted radio, which an RTL-SDR cannot decode. Some analogue channels remain (for example some rural, marine or local ones). Listening rules differ by state and country, so check yours. Add channels you may monitor to "My services list" in the Scanner.</div></details>
      <details class="help-q"><summary>Why can I not listen and track planes at once?</summary><div>One dongle can only tune to one place at a time. Planes use 1090 MHz and the radio uses other frequencies. A second dongle would let you do both, but this version uses one.</div></details>
      <details class="help-q"><summary>Which antenna should I use?</summary><div>See the Antenna guide on this page: it gives the rod length and shape for every part of the app. In short: vertical rods for ground signals, a flat V for weather satellites, a 1090 MHz antenna for planes, and a long wire for shortwave.</div></details>
      <details class="help-q"><summary>How do I get weather satellite pictures?</summary><div>Go to Space, find a Meteor pass that climbs above 30 degrees, and press <b>Record this pass</b>. After the pass, Skywave makes the pictures itself; open the Library to see them and download a PDF report. You need an antenna that can see the sky: see the Antenna guide on this page for the right setup.</div></details>
    </div>

    <div class="card"><h3>What is covered</h3><div class="sub">What Skywave can receive and decode, and what each one needs.</div>
      <div class="tablewrap"><table class="tbl" id="st-cover"><thead><tr><th>Signal</th><th>Needs</th><th>Status</th><th>Where and notes</th></tr></thead><tbody></tbody></table></div></div>
    <div class="card"><div class="card-head"><div><h3>About and maintenance</h3><div class="sub" id="st-about"></div></div><div class="row tight"><button class="btn" data-act="reset">Restart the radio</button><button class="btn" data-act="st-diag">Show technical details</button></div></div>
      <div id="st-sec" class="small"></div><div id="st-diag"></div></div>
    </div>`;
    const fs = $('#st-fs'); fs.innerHTML = '';
    RS.on('hello', () => St.fill()); RS.on('config', () => St.fill());
    $('#st-afmt').onchange = e => RS.api('config', { changes: { audio_format: e.target.value } });
    $('#st-kbps').onchange = e => RS.api('config', { changes: { mp3_kbps: +e.target.value } });
    $('#st-caps').onchange = e => RS.api('config', { changes: { captions: e.target.checked } });
    $('#st-capsave').onchange = e => RS.api('config', { changes: { caption_save: e.target.checked } });
    $('#st-capmodel').onchange = e => RS.api('config', { changes: { caption_model: e.target.value } });
    $('#st-sync').onchange = e => RS.api('config', { changes: { daily_sync: e.target.checked } });
    $('#st-autodec').onchange = e => RS.api('config', { changes: { auto_decode: e.target.checked } });
    $('#st-gauto').onchange = e => { RS.api('config', { changes: { gain_auto: e.target.checked } }); St.gainUi(); };
    RS.scale($('#st-gain'), { unit: 'dB', ticks: [0, 20, 40, 49.6], zones: [[0, 'Low', 'strong local signals, avoids overload'], [20, 'Medium', 'a good starting point'], [38, 'High', 'weak and distant signals; may overload'] ] });
    $('#st-gain').oninput = e => { $('#st-gain-v').textContent = e.target.value + ' dB'; };
    $('#st-gain').onchange = e => RS.api('config', { changes: { gain_db: parseFloat(e.target.value) } });
    $('#st-ppm').onchange = e => RS.api('config', { changes: { ppm: parseFloat(e.target.value) || 0 } });
    $('#st-hf').onchange = e => RS.api('config', { changes: { hf_mode: e.target.value } });
    $('#st-fs').onchange = e => RS.api('config', { changes: { sample_rate: parseInt(e.target.value) } });
    $('#st-de').onchange = e => RS.api('config', { changes: { deemph_us: parseFloat(e.target.value) } });
    $('#st-bias').onchange = e => { if (e.target.checked && !confirm('Only turn this on if your antenna or amplifier needs power from the dongle. It can damage some antennas. Continue?')) { e.target.checked = false; return; } RS.api('config', { changes: { bias_t: e.target.checked } }); };
    RS.on('health_progress', m => { const p = $('#st-hprog'); p.classList.remove('hide'); p.firstChild.style.width = Math.round(m.i / m.n * 100) + '%'; const t = $('#st-htext'); t.classList.remove('hide'); t.textContent = m.text; $('#st-hbtn').disabled = true; });
    RS.on('health_done', m => { $('#st-hprog').classList.add('hide'); $('#st-htext').classList.add('hide'); $('#st-hbtn').disabled = false; St.report(m.report); });
    RS.on('theme', () => St.theme());
  };
  St.enter = () => { St.fill(); St.theme(); RS.mountLocationCard($('#st-loc')); RS.mountThemes($('#st-themes')); RS.mountMotion && RS.mountMotion($('#st-motion')); RS.mountArt($('#st-art')); RS.mountSound($('#st-sound')); };
  St.gainUi = () => { const a = $('#st-gauto').checked; $('#st-gain').disabled = a; };
  St.fill = () => {
    const c = RS.cfg; if (!c || c.lat == null || RS.page !== 'settings') return;
    $('#st-gauto').checked = !!c.gain_auto; $('#st-gain').value = c.gain_db; $('#st-gain')._scaleUpd && $('#st-gain')._scaleUpd(); $('#st-gain-v').textContent = c.gain_db + ' dB'; St.gainUi();
    $('#st-ppm').value = c.ppm; $('#st-hf').value = c.hf_mode; $('#st-de').value = String(c.deemph_us); $('#st-bias').checked = !!c.bias_t;
    const fs = $('#st-fs'); if (!fs.children.length) fs.innerHTML = (RS.samples.length ? RS.samples : [2400000, 1920000, 1200000, 960000]).map(x => '<option value="' + x + '">' + (x / 1e6).toFixed(2) + ' MHz</option>').join(''); fs.value = c.sample_rate;
    $('#st-afmt').value = c.audio_format || 'mp3'; $('#st-kbps').value = String(c.mp3_kbps || 48); $('#st-caps').checked = c.captions !== false; $('#st-capsave').checked = !!c.caption_save; $('#st-capmodel').value = c.caption_model || 'base.en';
    const cs = RS.captionStatus || {}; $('#st-cap-st').textContent = cs.available ? 'Caption engine ready (' + (cs.engine || '') + ').' : 'Caption engine not installed' + (cs.reason ? ' (' + cs.reason + ')' : '') + '. Captions need the faster-whisper add-on that the Docker build installs.';
    $('#st-sync').checked = c.daily_sync !== false; const sy = RS.space && RS.space.sync || {}; $('#st-sync-st').textContent = sy.t ? 'Last refreshed ' + RS.ago(sy.t) + (sy.ok ? '.' : ' (it failed: ' + (sy.msg || 'no connection') + ').') : 'Not refreshed yet.';
    $('#st-autodec').checked = c.auto_decode !== false; const ds = RS.decoder || {}; $('#st-dec-st').textContent = ds.available ? 'The picture decoder is installed.' : 'The picture decoder is not installed' + (ds.missing && ds.missing.length ? ' (missing: ' + ds.missing.join(', ') + ')' : '') + '. Rebuild the project from the latest files.';
    $('#st-cover tbody').innerHTML = COVER.map(r => '<tr><td><b>' + esc(r[0]) + '</b></td><td>' + esc(r[1]) + '</td><td><span class="pill ' + r[2] + '">' + (r[2] === 'ok' ? 'Works' : 'Needs tool') + '</span></td><td>' + esc(r[3]) + '</td></tr>').join('');
    $('#st-about').textContent = 'Skywave ' + RS.version + (RS.sim ? ' (practice mode)' : '');
    $('#st-sec').innerHTML = c.auth_enabled ? '<span class="badge good">Password protection is on</span>' : '<span class="badge warn">No password set</span> <span class="muted">Anyone on your network can open this page. To add one, set AUTH_USER and AUTH_PASS in the compose file and restart the container.</span>';
  };
  St.theme = () => { if (1) return;  const t = RS.store.get('theme', null) || ''; RS.$$('#st-theme button').forEach(b => b.setAttribute('aria-pressed', b.dataset.t === t ? 'true' : 'false')); };
  St.report = r => {
    const lv = r.level === 'good' ? 'good' : r.level === 'bad' ? 'bad' : r.level === 'ok' ? 'warn' : '';
    let h = '<div class="banner ' + lv + '" style="margin-top:14px"><div class="txt"><strong>' + esc(r.verdict) + '</strong>' + (r.details || []).map(d => '<div>' + esc(d) + '</div>').join('') + '</div></div>';
    if (r.results && r.results.length) h += '<div class="scroll-x"><table class="tbl" style="margin-top:8px"><thead><tr><th>Tested</th><th>Frequency</th><th>Tuner locked?</th><th>Noise</th></tr></thead><tbody>' + r.results.map(x => '<tr><td>' + esc(x.label) + '</td><td class="num">' + RS.fmt(x.f) + '</td><td>' + (x.pll_fail ? '<span class="chk bad">' + icon('minus') + '</span> failed ' + x.pll_fail + 'x' : '<span class="chk good">' + icon('check') + '</span> yes') + '</td><td class="num">' + x.floor + ' dB</td></tr>').join('') + '</tbody></table></div>';
    h += '<div class="row" style="margin-top:10px"><button class="btn small" data-act="st-copyrep">Copy this report</button><span class="tiny muted">' + esc(r.time) + '</span></div>';
    St.lastReport = r; $('#st-hrep').innerHTML = h;
  };
  RS.act['st-health'] = () => { $('#st-hrep').innerHTML = ''; RS.send({ cmd: 'job', name: 'health' }); const t = $('#st-htext'); t.classList.remove('hide'); t.textContent = 'Starting...'; };
  RS.act['st-copyrep'] = () => {
    const r = St.lastReport; if (!r) return;
    const txt = ['Skywave radio check ' + r.time, r.verdict, ''].concat(r.details || [], [''], (r.results || []).map(x => x.label + ' ' + RS.fmt(x.f) + ': lock failures ' + x.pll_fail + ', noise ' + x.floor + ' dB'), ['', JSON.stringify(r.usb || [])]).join('\n');
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => RS.toast('Copied. Paste it into an email to the seller.'), () => { RS.modal('<h2>Copy this report</h2><textarea style="min-height:240px" readonly>' + esc(txt) + '</textarea><div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" data-act="closeModal">Done</button></div>'); });
  };
  RS.act['st-diag'] = async () => {
    const out = $('#st-diag'); out.innerHTML = '<div class="skel-wrap" aria-busy="true" aria-label="Loading"><i class="skel" style="width:70%"></i><i class="skel" style="width:52%"></i><i class="skel" style="width:61%"></i></div>';
    try {
      const [d, l] = await Promise.all([RS.api('diag'), RS.api('log')]);
      const usb = (d.usb || []).map(u => (u.manufacturer || '?') + ' ' + (u.product || '?') + ' (serial ' + (u.serial || 'none') + ')').join('; ') || 'none seen';
      out.innerHTML = '<dl class="kv" style="margin-top:10px"><dt>USB dongles</dt><dd>' + esc(usb) + '</dd><dt>TV driver loaded</dt><dd>' + (d.kernel_driver ? 'Yes (can interfere)' : 'No') + '</dd><dt>Current job</dt><dd>' + esc(d.job) + '</dd><dt>Uptime</dt><dd>' + RS.dur(d.uptime_s) + '</dd><dt>Browsers connected</dt><dd>' + d.clients + '</dd></dl><pre class="tech">' + esc((l.lines || []).slice(0, 60).map(x => new Date(x.t * 1000).toLocaleTimeString() + '  ' + x.level + '  ' + x.text).join('\n') + (d.rtl_tcp_output && d.rtl_tcp_output.length ? '\n\n-- radio driver output --\n' + d.rtl_tcp_output.join('\n') : '')) + '</pre>';
    } catch (e) { out.innerHTML = '<p class="muted">Could not load: ' + esc(e.message) + '</p>'; }
  };
})();
