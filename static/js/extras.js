/* Skywave - extra tools: plane coverage chart, airline names, downloads, antenna check, auto-calibration, settings backup. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc, icon = RS.icon;

  // ---------------------------------------------------------------- airline and country lookup
  const AIRLINES = {
    AAL: 'American Airlines', ACA: 'Air Canada', AFR: 'Air France', AIC: 'Air India', ANA: 'All Nippon Airways', ANZ: 'Air New Zealand',
    ASA: 'Alaska Airlines', AXM: 'AirAsia', AZA: 'ITA Airways', BAW: 'British Airways', CCA: 'Air China', CES: 'China Eastern',
    CPA: 'Cathay Pacific', CSN: 'China Southern', DAL: 'Delta', DLH: 'Lufthansa', EIN: 'Aer Lingus', ETD: 'Etihad', ETH: 'Ethiopian Airlines',
    EZY: 'easyJet', FDX: 'FedEx', FJI: 'Fiji Airways', GIA: 'Garuda Indonesia', IBE: 'Iberia', JAL: 'Japan Airlines', JBU: 'JetBlue', JST: 'Jetstar',
    KAL: 'Korean Air', KLM: 'KLM', LAN: 'LATAM', MAS: 'Malaysia Airlines', QFA: 'Qantas', QTR: 'Qatar Airways', RYR: 'Ryanair',
    SAA: 'South African Airways', SAS: 'SAS', SIA: 'Singapore Airlines', SWA: 'Southwest', SWR: 'Swiss', TAP: 'TAP Air Portugal', TGW: 'Scoot',
    THA: 'Thai Airways', THY: 'Turkish Airlines', UAE: 'Emirates', UAL: 'United', UPS: 'UPS Airlines', VIR: 'Virgin Atlantic',
    VOZ: 'Virgin Australia', WJA: 'WestJet', WZZ: 'Wizz Air',
  };
  RS.airline = cs => { const m = /^([A-Z]{3})\d/.exec(String(cs || '').trim()); return m ? (AIRLINES[m[1]] || '') : ''; };
  const RANGES = [[0x008000, 0x00FFFF, 'South Africa'], [0x0D0000, 0x0D7FFF, 'Mexico'], [0x300000, 0x33FFFF, 'Italy'], [0x340000, 0x37FFFF, 'Spain'],
    [0x380000, 0x3BFFFF, 'France'], [0x3C0000, 0x3FFFFF, 'Germany'], [0x400000, 0x43FFFF, 'United Kingdom'], [0x480000, 0x487FFF, 'Netherlands'],
    [0x4B0000, 0x4B7FFF, 'Switzerland'], [0x4B8000, 0x4BFFFF, 'Turkey'], [0x4CA000, 0x4CAFFF, 'Ireland'], [0x710000, 0x717FFF, 'South Korea'],
    [0x750000, 0x757FFF, 'Malaysia'], [0x768000, 0x76FFFF, 'Singapore'], [0x780000, 0x7BFFFF, 'China'], [0x7C0000, 0x7FFFFF, 'Australia'],
    [0x800000, 0x83FFFF, 'India'], [0x840000, 0x87FFFF, 'Japan'], [0x880000, 0x887FFF, 'Thailand'], [0x896000, 0x896FFF, 'United Arab Emirates'],
    [0x8A0000, 0x8A7FFF, 'Indonesia'], [0xA00000, 0xAFFFFF, 'United States'], [0xC00000, 0xC3FFFF, 'Canada'], [0xC80000, 0xC87FFF, 'New Zealand'],
    [0xE40000, 0xE7FFFF, 'Brazil']];
  RS.countryOf = icao => { const n = parseInt(icao, 16); const r = RANGES.find(x => n >= x[0] && n <= x[1]); return r ? r[2] : ''; };

  // ---------------------------------------------------------------- plane coverage chart + downloads
  const DIRN = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

  // ---------------------------------------------------------------- antenna check (live signal meter)
  const T = { vals: [], best: -99, on: false };
  function openTuner(startFreq) {
    RS.go('radio');
    const fm = (RS.region && RS.region.fm) || [87.5e6, 108e6];
    const top = RS.peaks.filter(p => p.mode === 'wfm' || (p.f >= fm[0] && p.f <= fm[1])).sort((a, b) => b.db - a.db)[0];
    const f0 = startFreq || (top && top.f) || RS.vfo() || (fm[0] + fm[1]) / 2;
    const box = RS.modal('<h3 style="margin:0 0 4px">Test my antenna</h3><p class="small muted" style="margin:0 0 10px">Tune to something you can receive, then change your antenna (rod length, angle, place) and watch the number. Higher is better. Wait about three seconds after each change.</p>' +
      '<div class="row" style="align-items:end"><label class="field grow">Frequency (MHz)<input type="text" id="at-f" inputmode="decimal" value="' + (f0 / 1e6).toFixed(3) + '"></label><button class="btn primary" data-act="at-go">Start</button></div>' +
      '<div class="row tight" style="margin:8px 0" id="at-presets"></div>' +
      '<div class="at-big"><span id="at-now">--</span><small> dB above the noise</small></div><div class="meter-lg"><i id="at-bar"></i><b id="at-peak"></b></div>' +
      '<canvas id="at-spark" class="spark"></canvas><div class="small" id="at-msg" aria-live="polite" style="margin-top:6px"></div>' +
      '<div class="small muted" id="at-best" style="margin-top:4px"></div><div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" data-act="at-reset">Reset best</button><button class="btn" data-act="closeModal">Done</button></div>', { onClose: () => { T.on = false; } });
    const pre = [['Strongest FM station', top && top.f]].concat([['Meteor weather satellite', 137.9e6], ['Space station', 145.8e6], ['Plane voice', 121.5e6]]).filter(x => x[1]);
    $('#at-presets').innerHTML = pre.map(x => '<button class="btn small ghost" data-act="at-pre" data-f="' + x[1] + '">' + esc(x[0]) + '</button>').join('');
    T.vals = []; T.best = -99; T.on = true;
    if (!RS.audio.on) { /* sound not needed */ }
    RS.act['at-go']();
  }
  RS.act['at-go'] = () => {
    const f = RS.parseFreq($('#at-f').value, 'm'); if (!f) { RS.toast('Type a frequency in MHz, e.g. 98.1', 'bad'); return; }
    T.vals = []; T.best = -99; T.on = true; T.f = f;
    RS.tune(f, { mode: 'auto', recenter: true });
    $('#at-msg').textContent = 'Listening on ' + (f / 1e6).toFixed(3) + ' MHz...';
  };
  RS.act['at-pre'] = b => { $('#at-f').value = (+b.dataset.f / 1e6).toFixed(3); RS.act['at-go'](); };
  RS.act['at-reset'] = () => { T.vals = []; T.best = -99; $('#at-best').textContent = ''; };
  RS.on('state', () => {
    if (!T.on || !$('#at-now')) return;
    const snr = RS.st.snr; if (snr == null) return;
    T.vals.push(snr); if (T.vals.length > 90) T.vals.shift();
    const recent = T.vals.slice(-6), avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (T.vals.length > 6) T.best = Math.max(T.best, avg);
    $('#at-now').textContent = avg.toFixed(0);
    $('#at-bar').style.width = Math.max(2, Math.min(100, avg / 50 * 100)) + '%';
    $('#at-peak').style.left = Math.max(0, Math.min(100, T.best / 50 * 100)) + '%';
    $('#at-best').textContent = T.best > -99 ? 'Best so far: ' + T.best.toFixed(0) + ' dB. Now: ' + (avg >= T.best - 1 ? 'at your best' : (T.best - avg).toFixed(0) + ' dB below your best') + '.' : '';
    const m = $('#at-msg');
    m.textContent = avg < 3 ? 'Almost nothing here. If you chose a satellite, it may simply not be overhead. For a test, pick the strongest FM station.' : avg < 12 ? 'A weak signal.' : avg < 25 ? 'A good signal.' : 'A strong signal.';
    const cv = $('#at-spark'), c = cv && RS.fit(cv); if (!c) return;
    const g = c.g; g.clearRect(0, 0, c.w, c.h); g.strokeStyle = RS.cssv('--teal') || '#0d6e7b'; g.lineWidth = 2; g.beginPath();
    T.vals.forEach((v, i) => { const x = i / 89 * c.w, y = c.h - Math.max(0, Math.min(1, v / 50)) * (c.h - 4) - 2; i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
  });
  RS.act['ant-test'] = () => openTuner();

  // ---------------------------------------------------------------- calibration + backup (Settings)
  function settingsHtml() {
    return '<div class="card adv-only" id="st-cal"><h3>Check my radio\'s accuracy ' + RS.hint('Cheap dongles have a clock that is a little off, so every station appears slightly away from where it should be. FM stations send a precise 19 kHz tone, so Skywave can measure how far off your dongle is and tell you the correction (in parts per million). Takes about 15 seconds. Press Find stations first on the Radio page.', 'cal') + '</h3><div class="sub">Uses the 19 kHz tone that FM stereo stations broadcast. Most useful with older dongles; a V4 is usually already accurate.</div>' +
      '<div class="row"><button class="btn primary" data-act="cal-go" id="cal-btn">Measure</button><span class="small muted" id="cal-text"></span></div><div id="cal-res"></div></div>' +
      '<div class="card" id="st-bk"><h3>Back up my settings</h3><div class="sub">Saves your location, favourites, scanner lists and satellite choices to one small file, so you can restore them after a rebuild or on another NAS.</div>' +
      '<div class="row"><a class="btn" href="/api/export/backup.json">Download my settings</a><label class="btn" style="cursor:pointer">Restore from a file<input type="file" id="bk-file" accept="application/json,.json" hidden></label></div><div class="small muted" id="bk-msg" style="margin-top:6px"></div></div>';
  }
  RS.act['cal-go'] = () => {
    const fm = (RS.region && RS.region.fm) || [87.5e6, 108e6];
    const st = RS.peaks.filter(p => p.f >= fm[0] && p.f <= fm[1]).sort((a, b) => b.db - a.db).slice(0, 5).map(p => p.f);
    if (!st.length) { $('#cal-text').textContent = 'Go to Radio and press Find stations first, so there are stations to measure.'; return; }
    $('#cal-btn').disabled = true; $('#cal-res').innerHTML = ''; $('#cal-text').textContent = 'Starting...';
    RS.send({ cmd: 'job', name: 'calibrate', params: { stations: st } });
  };
  RS.on('calibrate_progress', m => { const t = $('#cal-text'); if (t) t.textContent = m.text + ' (' + (m.i + 1) + ' of ' + m.n + ')'; });
  RS.on('calibrate_done', m => {
    const b = $('#cal-btn'); if (b) b.disabled = false; const t = $('#cal-text'); if (t) t.textContent = '';
    const el = $('#cal-res'); if (!el) return;
    el.innerHTML = '<div class="banner ' + (m.ok ? (m.confidence === 'low' ? 'warn' : 'good') : 'warn') + '" style="margin-top:12px"><div class="txt"><strong>' + (m.ok ? 'Suggested setting: ' + m.suggested + ' ppm' : 'No result') + '</strong>' + esc(m.text) + '<div class="small muted" style="margin-top:6px">' + (m.stations || []).map(s => (s.f / 1e6).toFixed(1) + ' MHz: ' + (s.ppm != null ? s.ppm + ' ppm' : 'no clear tone')).join(' &middot; ') + '</div></div>' +
      (m.ok ? '<button class="btn" data-act="cal-apply" data-ppm="' + m.suggested + '">Use ' + m.suggested + ' ppm</button>' : '') + '</div>';
  });
  RS.act['cal-apply'] = b => RS.api('config', { changes: { ppm: +b.dataset.ppm } }).then(() => { RS.toast('Saved. Stations should now sit exactly where the dial says.'); $('#cal-res').innerHTML = ''; });
  document.addEventListener('change', e => {
    if (e.target.id !== 'bk-file' || !e.target.files[0]) return;
    const rd = new FileReader();
    rd.onload = () => { let obj; try { obj = JSON.parse(rd.result); } catch (er) { $('#bk-msg').textContent = 'That is not a settings file.'; return; }
      RS.api('restore', obj).then(r => { $('#bk-msg').textContent = 'Restored: ' + (r.restored.join(', ') || 'nothing found') + '. Reloading...'; setTimeout(() => location.reload(), 1200); }).catch(er => { $('#bk-msg').textContent = er.message; }); };
    rd.readAsText(e.target.files[0]);
  });

  // ---------------------------------------------------------------- attach to pages
  function after(page, fn) {
    const P = RS.pages[page]; if (!P) return;
    const init = P.init;
    P.init = function () { if (init) init.apply(this, arguments); fn(document.getElementById('p-' + page)); };
  }
  // the range chart and the plane downloads live in the Planes page's Your receiver card (planes.js)
  // the scanner log download lives in the Scanner page's Recent activity card
  // the sensor readings download is in the Sensors page's footer
  after('settings', el => {
    const stack = el.querySelector('.stack'), box = document.createElement('div'); box.innerHTML = settingsHtml();
    const ref = stack && stack.querySelector('#st-antenna');
    if (stack) while (box.firstChild) stack.insertBefore(box.firstChild, ref || null);
  });
  // a "Test my antenna" button inside every antenna card
  document.addEventListener('toggle', e => {
    const d = e.target; if (!d.classList || !d.classList.contains('antenna') || !d.open || d.querySelector('[data-act="ant-test"]')) return;
    const b = document.createElement('div'); b.className = 'row tight'; b.style.margin = '8px 0'; b.innerHTML = '<button class="btn small primary" data-act="ant-test">Test my antenna live</button><span class="small muted">Shows how strong the signal is while you change the rods.</span>';
    const p = d.querySelector('p'); if (p) p.after(b);
  }, true);
})();
