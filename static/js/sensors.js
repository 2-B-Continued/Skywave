/* sensors.js - the Sensors page, and the spectrum survey shown on Explore.
   Layout: a status strip (what the radio listens on, for how long, how much it heard, and the band), "Your sensors" as
   cards with a big reading and a 24-hour line, "Nearby" as one list with search, type and sort, and two folded lines
   for passing cars' tyre sensors and for hidden sensors. Tapping a sensor opens its sheet: every reading, 24-hour
   charts, a name, and Mine / Hide / Forget. The server remembers names, yours, hidden and history (sensorstore.py). */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc, icon = RS.icon;
  const Se = RS.pages.sensors = {};

  // ---------------------------------------------------------------- bands (from the decoder's documented ISM bands)
  const BANDS = [
    { id: '433', f: [433.92e6], name: '433.92 MHz', what: 'Most wireless thermometers, weather stations, doorbells and remotes.' },
    { id: '433-868', f: [433.92e6, 868.3e6], name: '433.92 and 868 MHz', what: 'Both, switching every minute. Newer weather stations and smoke alarms use 868 MHz.' },
    { id: '433-915', f: [433.92e6, 915e6], name: '433.92 and 915 MHz', what: 'Both, switching every minute. Some weather stations and soil sensors use 915 MHz.' },
    { id: '433-920', f: [433.92e6, 920e6], name: '433.92 and 920 MHz', what: 'Both, switching every minute. Newer devices use 920 to 925 MHz.' },
    { id: '868', f: [868.3e6], name: '868 MHz', what: 'Weather stations, smoke alarms and home automation.' },
    { id: '865', f: [865e6], name: '865 MHz', what: 'Newer sensors and meters using 865 to 867 MHz.' },
    { id: '915', f: [915e6], name: '915 MHz', what: 'Weather stations, soil sensors and meters.' },
    { id: '920', f: [920e6], name: '920 MHz', what: 'Newer sensors and meters using 920 to 928 MHz.' },
    { id: '315', f: [315e6], name: '315 MHz', what: 'Car keys, tyre sensors and some alarms.' },
    { id: '345', f: [345e6], name: '345 MHz', what: 'Honeywell and similar home-security sensors.' },
    { id: 'amr', f: [912.6e6], tool: 'rtlamr', name: 'Utility meters (ERT)', what: 'Electricity, gas and water meters that use ERT radio (rtlamr).' },
  ];
  // the bands recommended for the region: those its sensors use (regions.py "ism"), plus ERT meters and 345 MHz where
  // they are sold (the US and Canada)
  const near = (a, b) => Math.abs(a - b) < 6e6;
  function rec() {
    const R = RS.region || {}, ism = R.ism || [433.92e6], id = R.id || 'intl';
    const r = BANDS.filter(b => b.f.every(f => ism.some(x => near(f, x))) && b.id !== 'amr' && b.id !== '345').map(b => b.id);
    const at = k => { const b = BANDS.find(x => x.id === k); return ism.findIndex(x => near(b.f[0], x)); };
    r.sort((x, y) => at(x) - at(y));                         // in the order the region lists them
    if (id === 'us' || id === 'ca') r.push('345', 'amr');
    return r.length ? r : ['433'];
  }
  // a band picked by the person wins; otherwise the region's main one (315 MHz in Japan, 433.92 MHz in most places)
  const band = () => BANDS.find(b => b.id === RS.store.get('sensor_band', null)) || BANDS.find(b => b.id === rec()[0]) || BANDS[0];
  function applyBand() {
    const b = band();
    RS.sensorFreq = b.f[0]; RS.sensorFreqs = b.f.length > 1 ? b.f : null; RS.sensorTool = b.tool || 'rtl_433';
  }
  applyBand(); RS.on('hello', applyBand);
  const start = () => RS.send({ cmd: 'job', name: 'ism', params: { freq: RS.sensorFreq, freqs: RS.sensorFreqs || undefined, tool: RS.sensorTool } });

  // ---------------------------------------------------------------- kinds of sensor
  const has = (s, ...k) => k.some(x => s[x] != null);
  const KINDS = [
    { id: 'weather', name: 'Weather station', test: (s, m) => has(s, 'wind_avg_km_h', 'wind_avg_m_s', 'wind_max_km_h', 'wind_max_m_s', 'wind_dir_deg', 'rain_mm', 'rain_in', 'uv', 'uvi', 'light_lux', 'pressure_hPa') || /weather|5n1|atlas|bresser|ambient|davis|wgr|ws[0-9]{3,4}|wh(1080|24|65|40|57)/i.test(m) },
    { id: 'power', name: 'Energy monitor', test: (s, m) => has(s, 'power_W', 'power0_W', 'power_kW', 'energy_kWh', 'total_kWh', 'current_A', 'current0_A', 'voltage_V') || /efergy|currentcost|owl|cm1|emontx|watt|kwh/i.test(m) },
    { id: 'meter', name: 'Utility meter', test: (s, m) => has(s, 'consumption', 'gas_m3', 'water_m3', 'volume_m3', 'consumption_data') || /rtlamr|ert-|scm|r900|itron|neptune|badger|kamstrup|meter/i.test(m) },
    { id: 'tpms', name: 'Tyre sensor', test: (s, m) => /tpms/i.test(String(s.type || '')) || (has(s, 'pressure_PSI', 'pressure_kPa', 'pressure_bar') && !has(s, 'humidity')) || /tpms|tire|tyre|schrader|jansite|pmv|pacific/i.test(m) },
    { id: 'security', name: 'Alarm sensor', test: (s, m) => has(s, 'alarm', 'tamper', 'smoke', 'motion', 'contact_open', 'reed_open', 'event') || /honeywell|interlogix|visonic|smoke|alarm|pir|motion|contact|door|window|secur|dsc|wds|fire/i.test(m) },
    { id: 'remote', name: 'Remote or doorbell', test: (s, m) => has(s, 'button', 'cmd', 'tri_state') || /remote|bell|switch|chime|byron|friedland|blind|gate|garage|dimmer|socket|plug/i.test(m) },
    { id: 'soil', name: 'Soil, pool or leak', test: (s, m) => has(s, 'moisture', 'water_leak', 'leak', 'depth_cm') || /soil|moisture|pool|leak|flood|tank/i.test(m) },
    { id: 'temp', name: 'Thermometer', test: s => has(s, 'temperature_C', 'temperature_F', 'humidity') },
    { id: 'other', name: 'Other device', test: () => true },
  ];
  const kindOf = s => { const m = String(s.model || ''); for (const k of KINDS) if (k.test(s, m)) return k; return KINDS[KINDS.length - 1]; };

  // ---------------------------------------------------------------- readings, in the units chosen in Settings
  const imp = () => (RS.cfg && RS.cfg.units) === 'imperial';
  const num = (v, d) => String(+(+v).toFixed(d));                 // 21.0 -> 21, 868.30 -> 868.3
  const tempC = s => s.temperature_C != null ? +s.temperature_C : s.temperature_F != null ? (s.temperature_F - 32) / 1.8 : null;
  const T = c => imp() ? num(c * 1.8 + 32, 1) + '°F' : num(c, 1) + '°C';
  const speed = ms => imp() ? num(ms * 2.237, 1) + ' mph' : num(ms * 3.6, 1) + ' km/h';
  const ms = (s, a, b) => s[a] != null ? +s[a] : s[b] != null ? s[b] / 3.6 : null;
  const compass = d => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((+d % 360) + 360) % 360 / 45) % 8];
  // [label, value text] for everything worth showing, most important first
  function readings(s) {
    const out = [], t = tempC(s);
    if (t != null) out.push(['Temperature', T(t), 'temperature_C']);
    if (s.humidity != null) out.push(['Humidity', num(s.humidity, 0) + '%', 'humidity']);
    const wa = ms(s, 'wind_avg_m_s', 'wind_avg_km_h'), wm = ms(s, 'wind_max_m_s', 'wind_max_km_h');
    if (wa != null) out.push(['Wind', speed(wa) + (s.wind_dir_deg != null ? ' from ' + compass(s.wind_dir_deg) : ''), s.wind_avg_m_s != null ? 'wind_avg_m_s' : 'wind_avg_km_h']);
    if (wm != null) out.push(['Gusts', speed(wm), s.wind_max_m_s != null ? 'wind_max_m_s' : 'wind_max_km_h']);
    if (s.rain_mm != null) out.push(['Rain (total)', imp() ? num(s.rain_mm / 25.4, 2) + ' in' : num(s.rain_mm, 1) + ' mm', 'rain_mm']);
    else if (s.rain_in != null) out.push(['Rain (total)', imp() ? num(s.rain_in, 2) + ' in' : num(s.rain_in * 25.4, 1) + ' mm', 'rain_in']);
    if (s.pressure_hPa != null) out.push(['Air pressure', num(s.pressure_hPa, 0) + ' hPa', 'pressure_hPa']);
    if (s.uvi != null) out.push(['UV index', num(s.uvi, 1), 'uvi']);
    if (s.light_lux != null) out.push(['Light', Math.round(s.light_lux).toLocaleString() + ' lux', 'light_lux']);
    if (s.power_W != null) out.push(['Power', Math.round(s.power_W).toLocaleString() + ' W', 'power_W']);
    if (s.power_kW != null) out.push(['Power', num(s.power_kW, 2) + ' kW', 'power_kW']);
    if (s.current_A != null) out.push(['Current', num(s.current_A, 1) + ' A']);
    if (s.energy_kWh != null) out.push(['Energy used', num(s.energy_kWh, 1) + ' kWh', 'energy_kWh']);
    if (s.pressure_PSI != null) out.push(['Tyre pressure', imp() ? num(s.pressure_PSI, 1) + ' psi' : num(s.pressure_PSI * 6.895, 0) + ' kPa']);
    if (s.pressure_kPa != null) out.push(['Tyre pressure', imp() ? num(s.pressure_kPa / 6.895, 1) + ' psi' : num(s.pressure_kPa, 0) + ' kPa']);
    if (s.moisture != null) out.push(['Moisture', num(s.moisture, 0) + '%', 'moisture']);
    if (s.depth_cm != null) out.push(['Depth', num(s.depth_cm, 0) + ' cm', 'depth_cm']);
    if (s.consumption != null) out.push(['Meter reading', String(s.consumption)]);
    ['alarm', 'tamper', 'smoke', 'motion', 'contact_open', 'reed_open'].forEach(k => { if (s[k] != null) out.push([k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()), s[k] === 1 || s[k] === true ? 'Yes' : s[k] === 0 || s[k] === false ? 'No' : String(s[k])]); });
    if (s.event != null) out.push(['Event', String(s.event)]);
    if (s.button != null || s.cmd != null) out.push(['Button', String(s.button != null ? s.button : s.cmd)]);
    return out;
  }
  const lowBat = s => s.battery_ok === 0 || s.battery_ok === false;
  const label = s => s.name || String(s.model || 'Sensor').replace(/[_-]+/g, ' ');
  const sub = s => kindOf(s).name + (s.channel != null ? ' · channel ' + s.channel : '') + (s.id != null && s.id !== '' ? ' · ID ' + s.id : '');
  const age = s => Date.now() / 1000 - (s.seen || 0);
  const fresh = s => age(s) < 300 ? 'live' : age(s) < 3600 ? 'ok' : 'stale';
  const heard = s => { const a = age(s); return a < 10 ? 'Just now' : RS.ago(s.seen).replace(/^./, c => c.toUpperCase()); };
  const bars = s => { const r = s.rssi != null ? +s.rssi : s.snr != null ? +s.snr - 30 : null; if (r == null) return ''; const n = r > -6 ? 4 : r > -11 ? 3 : r > -16 ? 2 : 1;
    return '<span class="sen-sig" title="Signal ' + num(r, 1) + ' dB">' + [1, 2, 3, 4].map(i => '<i' + (i <= n ? ' class="on"' : '') + '></i>').join('') + '</span>'; };

  // ---------------------------------------------------------------- the page
  Se.init = () => {
    $('#p-sensors').innerHTML = `
    <div class="page-head"><h2>Sensors</h2><p>Weather stations, thermometers, energy monitors and doorbells send their readings by radio. Skywave listens and decodes them; it never transmits.</p></div>
    <section class="sen-bar glass kx-static" id="se-bar" aria-live="polite">
      <span class="sen-led" id="se-led"></span>
      <div class="sen-bar-t"><b id="se-st">Starting the decoder</b><small id="se-st2">Radio sound is off on this page while the radio listens for sensors.</small></div>
      <button class="btn sen-band" data-act="se-band" type="button"><span id="se-band-l">433.92 MHz</span>${icon('down')}</button>
    </section>
    <section class="sen-sec" id="se-mine-sec">
      <div class="sen-h"><h3>Your sensors</h3><span class="sub" id="se-mine-n"></span></div>
      <div class="sen-cards" id="se-mine" data-stagger></div>
    </section>
    <section class="sen-sec card kx-static" id="se-near-sec">
      <div class="sen-h"><div><h3>Nearby</h3><span class="sub" id="se-near-n"></span></div>
        <div class="sen-tools"><span class="locp-in sen-q">${icon('search')}<input type="search" id="se-q" placeholder="Search" autocomplete="off"></span>
          <select id="se-kind" aria-label="Type"><option value="">All types</option></select>
          <select id="se-sort" aria-label="Sort"><option value="seen">Latest first</option><option value="count">Heard most</option><option value="sig">Strongest</option><option value="name">By name</option></select></div></div>
      <div class="sen-list" id="se-list" data-stagger role="list"></div>
      <details class="sen-fold" id="se-cars"><summary><span id="se-cars-t">Passing cars</span></summary><p class="sen-fold-p">Cars send tyre pressures as they drive past, each wheel with its own ID. They are kept out of the list above.</p><div class="sen-list" id="se-cars-l" data-stagger></div></details>
      <details class="sen-fold" id="se-hid"><summary><span id="se-hid-t">Hidden</span></summary><div class="sen-list" id="se-hid-l" data-stagger></div></details>
      <div class="sen-foot"><a class="btn small ghost" href="/api/export/sensors.csv">Download all readings (CSV)</a><button class="btn small ghost" type="button" data-act="se-tidy">Forget sensors not heard today</button></div>
    </section>`;
    const ks = $('#se-kind'); KINDS.forEach(k => { const o = document.createElement('option'); o.value = k.id; o.textContent = k.name + 's'; ks.appendChild(o); });
    ks.value = RS.store.get('sensor_kind', ''); $('#se-sort').value = RS.store.get('sensor_sort', 'seen');
    $('#se-q').oninput = () => draw(true);
    ks.onchange = () => { RS.store.set('sensor_kind', ks.value); draw(true); };
    $('#se-sort').onchange = e => { RS.store.set('sensor_sort', e.target.value); draw(true); };
    let tq = null;
    RS.on('sensor', m => { if (RS.page !== 'sensors') return; if (sheetKey === m.key) sheet(true); clearTimeout(tq); tq = setTimeout(() => draw(), 120); });
    RS.on('sensors_forgot', () => draw(true));
    RS.on('config', () => { if (RS.page === 'sensors') draw(true); });
    setInterval(() => { if (RS.page === 'sensors') { status(); draw(); } }, 5000);    // "heard 2 min ago" keeps moving
  };
  Se.enter = () => { draw(true); status(); };
  Se.state = () => status();

  function status() {
    const st = RS.st || {}, im = st.ism, b = band(), led = $('#se-led'); if (!led) return;
    RS.setText($('#se-band-l'), b.name);
    const L = Object.values(RS.sensors || {}), last = L.reduce((m, s) => Math.max(m, s.seen || 0), 0);
    let t, t2, cls;
    if (!RS.connected) { t = 'Not connected'; t2 = 'Trying to reach Skywave.'; cls = 'off'; }
    else if (st.error) { t = 'No radio found'; t2 = 'See the message at the top of the page.'; cls = 'bad'; }
    else if (st.job !== 'ism' || !im) { t = 'Starting the decoder'; t2 = 'Radio sound is off on this page while the radio listens for sensors.'; cls = 'wait'; }
    else {
      const f = im.freqs && im.freqs.length > 1 ? im.freqs.map(x => num(x / 1e6, 2)).join(' and ') + ' MHz' : num(im.freq / 1e6, 2) + ' MHz';
      t = 'Listening on ' + f;
      t2 = 'For ' + RS.dur(Math.max(1, Date.now() / 1000 - im.t0)).replace(/ 0 s$/, '') + ' · ' + (im.n || 0).toLocaleString() + ' message' + (im.n === 1 ? '' : 's') +
        (last ? ' · last ' + (Date.now() / 1000 - last < 5 ? 'just now' : RS.ago(last)) : ' · most sensors send every 30 to 60 seconds');
      cls = last && Date.now() / 1000 - last < 90 ? 'live' : 'on';
    }
    RS.setText($('#se-st'), t); RS.setText($('#se-st2'), t2);
    if (led.dataset.s !== cls) led.dataset.s = cls;
  }

  // ---------------------------------------------------------------- drawing (only what changed)
  function card(s) {
    const r = readings(s), main = r[0], rest = r.slice(1, 4), k = kindOf(s);
    return '<button class="sen-card ' + fresh(s) + '" type="button" data-act="se-open" data-key="' + esc(s.key) + '">' +
      '<span class="sen-card-h"><b>' + esc(label(s)) + '</b><i class="sen-dot" title="' + esc(heard(s)) + '"></i></span>' +
      '<span class="sen-card-k">' + esc(k.name) + '</span>' +
      '<span class="sen-big">' + (main ? esc(main[1]) : '<span class="sen-none">' + esc(heard(s)) + '</span>') + '</span>' +
      '<span class="sen-card-r">' + rest.map(x => '<span><small>' + esc(x[0]) + '</small>' + esc(x[1]) + '</span>').join('') + '</span>' +
      '<canvas class="sen-spark" data-key="' + esc(s.key) + '" data-f="' + esc(main && main[2] || '') + '" aria-hidden="true"></canvas>' +
      '<span class="sen-card-f"><span>' + esc(heard(s)) + '</span>' + (lowBat(s) ? '<span class="sen-bat">Battery low</span>' : '') + bars(s) + '</span></button>';
  }
  function row(s, opts) {
    const r = readings(s), main = r[0];
    return '<div class="sen-row ' + fresh(s) + '" role="listitem"><button class="sen-row-b" type="button" data-act="se-open" data-key="' + esc(s.key) + '">' +
      '<i class="sen-k sen-k-' + kindOf(s).id + '" aria-hidden="true"></i>' +
      '<span class="sen-row-t"><b>' + esc(label(s)) + '</b><small>' + esc(sub(s)) + '</small></span>' +
      '<span class="sen-row-v">' + (main ? esc(/^(Button|Event|Meter reading)$/.test(main[0]) ? main[0] + ' ' + main[1] : main[1]) : '') + (lowBat(s) ? '<small class="sen-bat">Battery low</small>' : '') + '</span>' +
      '<span class="sen-row-s"><span>' + esc(heard(s)) + '</span>' + bars(s) + '</span></button>' +
      (opts === 'hidden' ? '<button class="btn small ghost" type="button" data-act="se-unhide" data-key="' + esc(s.key) + '">Show</button>'
        : opts === 'car' ? '' : '<button class="btn small ghost sen-mine" type="button" data-act="se-mine" data-key="' + esc(s.key) + '" title="Keep this sensor at the top, with its history">' + icon('star') + '<span>Mine</span></button>') +
      '</div>';
  }
  const set = (el, h) => { if (el && el._h !== h) { el._h = h; el.innerHTML = h; return true; } return false; };
  let lastDraw = 0;
  function draw(force) {
    if (RS.page !== 'sensors' || !$('#se-list')) return;
    if (!force && performance.now() - lastDraw < 400) return; lastDraw = performance.now();
    const all = Object.values(RS.sensors || {});
    const mine = all.filter(s => s.mine).sort((a, b) => label(a).localeCompare(label(b)));
    const hidden = all.filter(s => s.hidden && !s.mine);
    const cars = all.filter(s => !s.mine && !s.hidden && kindOf(s).id === 'tpms').sort((a, b) => b.seen - a.seen);
    let near = all.filter(s => !s.mine && !s.hidden && kindOf(s).id !== 'tpms');
    const q = ($('#se-q').value || '').trim().toLowerCase(), kf = $('#se-kind').value, so = $('#se-sort').value;
    if (q) near = near.filter(s => (label(s) + ' ' + s.model + ' ' + s.id).toLowerCase().includes(q));
    if (kf) near = near.filter(s => kindOf(s).id === kf);
    const sig = s => s.rssi != null ? +s.rssi : -99;
    near.sort(so === 'count' ? (a, b) => b.count - a.count : so === 'sig' ? (a, b) => sig(b) - sig(a) : so === 'name' ? (a, b) => label(a).localeCompare(label(b)) : (a, b) => b.seen - a.seen);
    // yours
    $('#se-mine-sec').classList.toggle('none', !mine.length && !all.length);
    const mh = mine.length ? mine.map(card).join('')
      : (all.length ? '<div class="sen-hint">' + icon('star') + '<span><b>Mark your own sensors</b><span>Press <b>Mine</b> on a sensor below to keep it here with a name and its last 24 hours.</span></span></div>' : '');
    if (set($('#se-mine'), mh)) sparks();
    // nearby
    const total = all.filter(s => !s.mine && !s.hidden && kindOf(s).id !== 'tpms').length;
    RS.setText($('#se-near-n'), total ? (near.length === total ? total + ' sensor' + (total === 1 ? '' : 's') : near.length + ' of ' + total) : '');
    set($('#se-list'), near.length ? near.map(s => row(s)).join('')
      : '<div class="sen-empty"><b>' + (total ? 'Nothing matches' : 'Listening for sensors') + '</b><span>' + (total ? 'Try another search or type.' : 'Most sensors send every 30 to 60 seconds, so give it a minute. If nothing turns up, try another band with the button above.') + '</span></div>');
    // folded
    RS.setText($('#se-cars-t'), 'Passing cars: ' + cars.length + ' tyre sensor' + (cars.length === 1 ? '' : 's'));
    $('#se-cars').hidden = !cars.length;
    if ($('#se-cars').open) set($('#se-cars-l'), cars.slice(0, 60).map(s => row(s, 'car')).join(''));
    RS.setText($('#se-hid-t'), 'Hidden: ' + hidden.length);
    $('#se-hid').hidden = !hidden.length;
    if ($('#se-hid').open) set($('#se-hid-l'), hidden.map(s => row(s, 'hidden')).join(''));
  }
  document.addEventListener('toggle', e => { if (e.target && (e.target.id === 'se-cars' || e.target.id === 'se-hid')) draw(true); }, true);

  // ---------------------------------------------------------------- history: sparklines on the cards, charts in the sheet
  const histCache = {};
  async function hist(key) {
    const c = histCache[key]; if (c && Date.now() - c.t < 60000) return c.h;
    try { const r = await RS.api('sensor_history?key=' + encodeURIComponent(key)); histCache[key] = { t: Date.now(), h: r.hist || {} }; return r.hist || {}; } catch (e) { return {}; }
  }
  const conv = (f, v) => /temperature_C/.test(f) && imp() ? v * 1.8 + 32 : /_m_s$/.test(f) ? (imp() ? v * 2.237 : v * 3.6) : /_km_h$/.test(f) && imp() ? v / 1.609 : v;
  function line(cv, pts, f, opt) {
    const c = RS.fit(cv); if (!c) return; const g = c.g, w = c.w, h = c.h; g.clearRect(0, 0, w, h);
    if (!pts || pts.length < 2) { if (opt && opt.empty) { g.fillStyle = RS.cssv('--ink-3') || '#888'; g.font = '12px ' + (RS.cssv('--f-body') || 'sans-serif'); g.fillText('History starts after a few readings', 0, h / 2 + 4); } return; }
    const now = Date.now() / 1000, t0 = now - 86400, V = pts.map(p => conv(f, p[1]));
    let lo = Math.min(...V), hi = Math.max(...V); if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
    const pad = opt && opt.axis ? 18 : 3, X = t => (t - t0) / 86400 * w, Y = v => h - pad - (v - lo) / (hi - lo) * (h - pad - 4);
    const col = RS.cssv('--accent') || RS.cssv('--teal') || '#2a9d8f';
    if (opt && opt.axis) {
      g.strokeStyle = (RS.cssv('--stroke') || '#8884'); g.lineWidth = 1; g.beginPath(); g.moveTo(0, h - pad + .5); g.lineTo(w, h - pad + .5); g.stroke();
      g.fillStyle = RS.cssv('--ink-3') || '#888'; g.font = '11px ' + (RS.cssv('--f-body') || 'sans-serif');
      [24, 18, 12, 6].forEach(hr => { const x = X(now - hr * 3600); g.fillText(hr + ' h ago', Math.max(0, x - 14), h - 4); });
      g.fillText('now', w - 24, h - 4);
    }
    g.beginPath(); pts.forEach((p, i) => { const x = X(p[0]), y = Y(V[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.strokeStyle = col; g.lineWidth = 1.6; g.lineJoin = 'round'; g.stroke();
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, col + '33'); gr.addColorStop(1, col + '00');
    g.lineTo(X(pts[pts.length - 1][0]), h - pad); g.lineTo(X(pts[0][0]), h - pad); g.closePath(); g.fillStyle = gr; g.fill();
  }
  async function sparks() {
    for (const cv of RS.$$('#se-mine .sen-spark')) { const f = cv.dataset.f; if (!f) continue; const H = await hist(cv.dataset.key); line(cv, H[f], f); }
  }
  window.addEventListener('resize', () => { if (RS.page === 'sensors') sparks(); });

  // ---------------------------------------------------------------- one sensor's sheet
  let sheetKey = null;
  async function sheet(refresh) {
    const s = RS.sensors[sheetKey]; if (!s) { RS.closeModal(); return; }
    const r = readings(s), known = new Set(['key', 'model', 'id', 'channel', 'count', 'seen', 'first', 'name', 'mine', 'hidden', 'rssi', 'snr', 'noise', 'freq', 'battery_ok', 'type', 'mic']);
    const shownF = new Set(r.map(x => x[2]).filter(Boolean));
    const extra = Object.keys(s).filter(k => !known.has(k) && !r.some(x => x[2] === k) && !/^(temperature_|humidity|wind_|rain_|pressure_|uv|light_|power|current_|energy|moisture|depth|consumption|alarm|tamper|smoke|motion|contact_open|reed_open|event|button|cmd)/.test(k));
    const body = '<div class="sen-sheet"><div class="sen-sh-h"><label class="sr-only" for="se-name">Name</label><input id="se-name" class="sen-name" maxlength="40" value="' + esc(s.name || '') + '" placeholder="' + esc(String(s.model || 'Sensor').replace(/[_-]+/g, ' ')) + '"><small>' + esc(sub(s)) + '</small></div>' +
      '<div class="sen-sh-act"><button class="btn small' + (s.mine ? ' on' : '') + '" type="button" data-act="se-mine" data-key="' + esc(s.key) + '" aria-pressed="' + !!s.mine + '">' + icon('star') + '<span>' + (s.mine ? 'Mine' : 'This is mine') + '</span></button>' +
      '<button class="btn small" type="button" data-act="' + (s.hidden ? 'se-unhide' : 'se-hide') + '" data-key="' + esc(s.key) + '">' + (s.hidden ? 'Show again' : 'Hide') + '</button>' +
      '<button class="btn small ghost danger" type="button" data-act="se-forget" data-key="' + esc(s.key) + '">Forget</button></div>' +
      (r.length ? '<dl class="sen-kv">' + r.map(x => '<div><dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd></div>').join('') + '</dl>' : '') +
      '<div id="se-charts" class="sen-charts"></div>' +
      '<dl class="sen-meta"><div><dt>Last heard</dt><dd>' + esc(heard(s)) + ' (' + RS.clock(s.seen) + ')</dd></div><div><dt>First heard</dt><dd>' + (s.first ? esc(new Date(s.first * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })) : '-') + '</dd></div>' +
      '<div><dt>Messages</dt><dd>' + (s.count || 0).toLocaleString() + '</dd></div>' + (s.battery_ok != null ? '<div><dt>Battery</dt><dd>' + (lowBat(s) ? 'Low, replace soon' : 'OK') + '</dd></div>' : '') +
      (s.rssi != null ? '<div><dt>Signal</dt><dd>' + num(s.rssi, 1) + ' dB' + (s.snr != null ? ', ' + num(s.snr, 0) + ' dB above the noise' : '') + '</dd></div>' : '') + '</dl>' +
      (extra.length ? '<details class="sen-raw adv-only"><summary>Everything the decoder sent</summary><dl class="sen-meta">' + extra.map(k => '<div><dt>' + esc(k.replace(/_/g, ' ')) + '</dt><dd>' + esc(s[k]) + '</dd></div>').join('') + '</dl></details>' : '') + '</div>';
    let dlg = document.querySelector('.modal.sen-modal');
    if (refresh && !dlg) { sheetKey = null; return; }         // closed meanwhile: a new reading must not reopen it
    if (!dlg || !refresh) { dlg = RS.modal(body); if (dlg) { dlg.classList.add('sen-modal'); if (document.activeElement && document.activeElement.id === 'se-name') document.activeElement.blur(); } }
    else {                                                        // a new reading while the sheet is open: refresh the numbers, keep the name being typed
      const nm = $('#se-name'), typing = document.activeElement === nm, v = nm && nm.value;
      dlg.innerHTML = body; if (typing) { const n2 = $('#se-name'); n2.value = v; n2.focus(); }
    }
    const nm = $('#se-name');
    nm.onchange = () => RS.api('sensors/set', { key: s.key, name: nm.value });
    nm.onkeydown = e => { if (RS.isEnter(e)) { e.preventDefault(); nm.blur(); } };
    const H = await hist(s.key), box = $('#se-charts'); if (!box) return;
    const fs = r.filter(x => x[2] && H[x[2]] && H[x[2]].length > 1);
    box.innerHTML = fs.length ? fs.map(x => '<figure><figcaption>' + esc(x[0]) + ', last 24 hours</figcaption><canvas data-f="' + x[2] + '"></canvas></figure>').join('')
      : (s.count >= 3 && kindOf(s).id !== 'tpms' && r.some(x => x[2]) ? '<p class="sen-none">The 24-hour history fills in as readings arrive (one point every 5 minutes).</p>' : '');
    box.querySelectorAll('canvas').forEach(cv => line(cv, H[cv.dataset.f], cv.dataset.f, { axis: true }));
  }
  RS.act['se-open'] = b => { sheetKey = b.dataset.key; sheet(false); };
  const setS = (key, ch) => RS.api('sensors/set', Object.assign({ key }, ch)).then(r => { if (r && r.sensor) { RS.sensors[key] = Object.assign(RS.sensors[key] || {}, r.sensor); draw(true); if (sheetKey === key && document.querySelector('.sen-modal')) sheet(true); } });
  RS.act['se-mine'] = b => { const s = RS.sensors[b.dataset.key]; if (s) { setS(s.key, { mine: !s.mine }); if (!s.mine) RS.toast((s.name || label(s)) + ' is now in Your sensors.'); } };
  RS.act['se-hide'] = b => { setS(b.dataset.key, { hidden: true }); RS.closeModal(); RS.toast('Hidden. Find it under Hidden at the bottom of the list.'); };
  RS.act['se-unhide'] = b => setS(b.dataset.key, { hidden: false });
  RS.act['se-forget'] = b => { const k = b.dataset.key; RS.api('sensors/forget', { key: k }).then(() => { delete RS.sensors[k]; RS.closeModal(); draw(true); }); };
  RS.act['se-tidy'] = () => {
    const old = Object.values(RS.sensors).filter(s => !s.mine && !s.name && age(s) > 86400).map(s => s.key);
    if (!old.length) { RS.toast('Every sensor in the list was heard today.'); return; }
    RS.confirm('Forget ' + old.length + ' sensor' + (old.length === 1 ? '' : 's') + '?', 'These have not been heard for over a day. Your sensors and named ones are kept.', 'Forget', () =>
      RS.api('sensors/forget', { keys: old }).then(() => { old.forEach(k => delete RS.sensors[k]); draw(true); }));
  };
  RS.on('sensors_forgot', m => { (m.keys || []).forEach(k => delete RS.sensors[k]); });

  // ---------------------------------------------------------------- band picker
  RS.act['se-band'] = () => {
    const rid = (RS.region && RS.region.id) || 'intl', recd = rec(), cur = band().id;
    const L = BANDS.filter(b => b.tool !== 'rtlamr' || (RS.tools || {}).rtlamr);
    const row = b => '<button class="locp-row" type="button" role="option" aria-selected="' + (b.id === cur) + '" data-act="se-band-pick" data-id="' + b.id + '"><span class="locp-t"><b>' + esc(b.name) + '</b><small>' + esc(b.what) + '</small></span>' + (b.id === cur ? icon('check') : '') + '</button>';
    const a = L.filter(b => recd.includes(b.id)), o = L.filter(b => !recd.includes(b.id));
    RS.modal('<h3>Which band?</h3><p class="sub" style="margin:0 0 12px">Sensors are made for one band. If yours does not show up, its label or manual says which.</p>' +
      (a.length && rid !== 'intl' ? '<div class="sen-lbl">For your region</div><div class="locp-res">' + a.map(row).join('') + '</div><div class="sen-lbl">Others</div><div class="locp-res">' + o.map(row).join('') + '</div>'
        : '<div class="locp-res">' + L.map(row).join('') + '</div>'));
    const d = document.querySelector('#modal-root .modal'); if (d) d.classList.add('sen-modal');
  };
  RS.act['se-band-pick'] = b => { RS.store.set('sensor_band', b.dataset.id); applyBand(); RS.closeModal(); start(); status(); };

  // ================================================================ the spectrum survey, on Explore
  const Ex = RS.pages.explore;
  const SV = { on: false, sig: [], passes: 0, lock: null };
  Ex.svy = SV;
  const GUESS = [[26.9, 27.5, 'CB radio (27 MHz)'], [40.6, 40.8, 'Remote controls (40 MHz)'], [87.5, 108, 'FM radio'], [108, 118, 'Aircraft navigation'], [118, 137, 'Aircraft voice'], [137, 138, 'Weather satellites'],
    [148, 174, 'Two-way radio, marine'], [303, 316, 'Remotes, garage doors, car keys'], [335, 350, 'Remotes, alarms'], [430, 436, 'Wireless sensors, remotes (433 MHz)'], [450, 470, 'Business two-way radio'], [476, 478, 'UHF CB'], [520, 694, 'Digital TV'],
    [703, 803, 'Mobile network (700 MHz band)'], [803, 960, 'Mobile network or 915 MHz devices'], [915, 928, 'Smart meters, LoRa, RFID (915 MHz)'], [1085, 1095, 'Aircraft transponders (ADS-B)'], [1164, 1300, 'Satellite navigation, radar'], [1559, 1610, 'GPS'], [1700, 1770, 'Mobile network (1800 MHz band)']];
  const guess = r => { const m = r.f / 1e6; let g = ''; for (const x of GUESS) if (m >= x[0] && m <= x[1]) g = x[2];
    if (r.bw >= 1e6) return (g || 'Wide signal') + ' (a wide block: a tower or TV)'; if (r.duty < 0.4 && r.bw <= 100e3) g = (g ? g + ', ' : '') + 'comes and goes (a device)'; return g || '-'; };
  const init0 = Ex.init;
  Ex.init = function () {
    init0.apply(this, arguments);
    const c = document.createElement('div'); c.className = 'card'; c.id = 'sv-card'; c.style.marginTop = '14px';
    c.innerHTML = '<div class="card-head"><div><h3>Find devices that transmit now and then</h3><div class="sub">Sweeps a wide range again and again and ranks what keeps showing up: remotes, sensors and meters that only send every so often. Pick one to watch it, or to try decoding it on the Sensors page.</div></div></div>' +
      '<div class="row" style="align-items:end"><label class="field">Where to look<select id="sv-r"><option value="24,1766">Everything (24 to 1766 MHz)</option><option value="24,500">Below 500 MHz</option><option value="300,350">300 to 350 MHz (remotes, US sensors)</option><option value="400,480">400 to 480 MHz (433 MHz sensors, UHF)</option><option value="860,930">860 to 930 MHz (868 and 915 MHz devices)</option></select></label>' +
      '<button class="btn primary" id="sv-go" data-act="sv-toggle" type="button">' + icon('search') + '<span>Start survey</span></button><span class="small muted" id="sv-st"></span></div>' +
      '<div class="progress hide" id="sv-prog" style="margin:10px 0"><i></i></div><div class="hide" id="sv-lock" style="margin-top:12px"></div>' +
      '<div class="scroll-x hide" id="sv-tw"><table class="tbl"><thead><tr><th>Frequency</th><th>Strength</th><th>How often</th><th>Width</th><th>Probably</th><th></th></tr></thead><tbody id="sv-rows"></tbody></table></div>';
    $('#p-explore').appendChild(c);
  };
  Ex.busy = () => SV.on || !!SV.lock;
  const leave0 = Ex.leave;
  Ex.leave = function () { if (leave0) leave0.apply(this, arguments); if (Ex.busy()) { SV.on = false; SV.lock = null; RS.send({ cmd: 'job', name: 'listen' }); } };
  function svDraw() {
    if (!$('#sv-rows')) return;
    const bt = $('#sv-go'); RS.setText(bt.querySelector(':scope > span:not([aria-hidden])'), SV.on ? 'Stop survey' : 'Start survey'); bt.classList.toggle('primary', !SV.on);
    $('#sv-tw').classList.toggle('hide', !SV.sig.length || !!SV.lock);
    $('#sv-rows').innerHTML = SV.sig.slice(0, 80).map((r, i) => '<tr><td class="num"><b>' + RS.fmt(r.f, 'nfm') + '</b></td><td class="small">+' + Math.round(r.db) + ' dB</td><td class="small">' + r.hits + ' of ' + r.passes + '</td><td class="small muted">' +
      (r.bw >= 1e6 ? num(r.bw / 1e6, 1) + ' MHz' : Math.round(r.bw / 1e3) + ' kHz') + '</td><td class="small">' + esc(guess(r)) + '</td><td><button class="btn small" type="button" data-act="sv-lock" data-i="' + i + '">Watch</button></td></tr>').join('');
    $('#sv-lock').classList.toggle('hide', !SV.lock);
  }
  function svLockUI() {
    const r = SV.lock; if (!r) return;
    $('#sv-lock').innerHTML = '<div class="card inset"><h3>Watching ' + RS.fmt(r.f, 'nfm') + '</h3><div class="sub">' + esc(guess(r)) + '</div>' +
      '<div class="glass" style="padding:8px;margin-top:8px"><canvas id="sv-cv" style="width:100%;height:150px" aria-label="Spectrum around this frequency"></canvas></div>' +
      '<div class="small muted" id="sv-lv" style="margin:6px 0">Measuring</div><div class="glass" style="padding:6px"><canvas id="sv-hist" style="width:100%;height:60px" aria-label="Signal strength over time"></canvas></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn primary" type="button" data-act="sv-decode">Try to decode it on Sensors</button><button class="btn" type="button" data-act="sv-listen">' + icon('sound') + 'Listen</button><button class="btn ghost" type="button" data-act="sv-back">Back to the list</button></div></div>';
  }
  RS.on('survey_progress', m => {
    if (RS.page !== 'explore' || !SV.on) return;
    $('#sv-prog').classList.remove('hide'); $('#sv-prog').firstElementChild.style.width = Math.round(100 * m.hop / Math.max(m.hops, 1)) + '%';
    RS.setText($('#sv-st'), 'Pass ' + (m.passes + 1) + ', now at ' + RS.fmt(m.f));
  });
  RS.on('survey', m => { SV.sig = m.signals || []; SV.passes = m.passes; if (RS.page === 'explore' && SV.on) { RS.setText($('#sv-st'), m.passes + ' pass' + (m.passes === 1 ? '' : 'es') + ', ' + SV.sig.length + ' found. Still looking'); svDraw(); } });
  RS.on('watch', m => {
    if (!SV.lock || RS.page !== 'explore') return;
    const u = Uint8Array.from(atob(m.db), c => c.charCodeAt(0)), cv = $('#sv-cv') && RS.fit($('#sv-cv')), col = RS.cssv('--pri') || '#6fd0dc';
    if (cv) { const g = cv.g, w = cv.w, h = cv.h; g.clearRect(0, 0, w, h); const v = Array.from(u, x => x / 2.2 - 110), lo = m.floor - 3;
      g.beginPath(); g.moveTo(0, h); v.forEach((d, i) => g.lineTo(i / (v.length - 1) * w, h - Math.min(Math.max((d - lo) / 45, 0), 1) * (h - 6))); g.lineTo(w, h); g.closePath(); g.fillStyle = col + '33'; g.fill(); g.strokeStyle = col; g.lineWidth = 1.3; g.stroke(); }
    const hc = $('#sv-hist') && RS.fit($('#sv-hist'));
    if (hc) { const g = hc.g, w = hc.w, h = hc.h; g.clearRect(0, 0, w, h); g.beginPath(); m.hist.forEach((d, i) => { const x = i / Math.max(m.hist.length - 1, 1) * w, y = h - Math.min(Math.max(d / 40, 0), 1) * (h - 4); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.strokeStyle = RS.cssv('--sig') || '#ffb52e'; g.lineWidth = 1.4; g.stroke(); }
    RS.setText($('#sv-lv'), (m.level > 6 ? 'Transmitting now' : 'Quiet right now') + ' (+' + Math.round(m.level) + ' dB above the noise). The line below is the last few minutes.');
  });
  RS.act['sv-toggle'] = () => {
    if (SV.on) { SV.on = false; SV.lock = null; $('#sv-prog').classList.add('hide'); RS.setText($('#sv-st'), ''); RS.send({ cmd: 'job', name: 'listen' }); svDraw(); return; }
    const [a, b] = $('#sv-r').value.split(',').map(Number);
    SV.on = true; SV.sig = []; SV.lock = null; SV.passes = 0; $('#sv-lock').innerHTML = '';
    RS.send({ cmd: 'sweep', start: a * 1e6, stop: b * 1e6, mode: 'nfm', thr: 8, purpose: 'survey' });
    RS.setText($('#sv-st'), 'Starting'); svDraw();
  };
  RS.act['sv-lock'] = b => { const r = SV.sig[+b.dataset.i]; if (!r) return; SV.lock = r; SV.on = false; $('#sv-prog').classList.add('hide'); RS.setText($('#sv-st'), '');
    RS.send({ cmd: 'sweep', start: r.f - 1, stop: r.f + 1, mode: 'nfm', purpose: 'watch' }); svDraw(); svLockUI(); };
  RS.act['sv-back'] = () => { SV.lock = null; $('#sv-lock').innerHTML = ''; RS.send({ cmd: 'job', name: 'listen' }); svDraw(); };
  RS.act['sv-decode'] = () => { const r = SV.lock; if (!r) return; SV.lock = null; $('#sv-lock').innerHTML = ''; svDraw();
    RS.sensorFreq = r.f; RS.sensorFreqs = null; RS.sensorTool = 'rtl_433'; RS.go('sensors'); start(); RS.toast('Listening for sensors on ' + RS.fmt(r.f) + '. Anything it can read appears in the list.'); };
  RS.act['sv-listen'] = () => { const r = SV.lock; if (!r) return; SV.lock = null; RS.send({ cmd: 'job', name: 'listen' }); RS.go('radio'); RS.tune(r.f, { mode: r.mode || RS.modeFor(r.f), recenter: true }); };
})();
