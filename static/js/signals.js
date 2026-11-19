/* Skywave - signal helpers on the Radio page and in Settings:
   - "What is this?": names the signal you are tuned to from where it sits and how it looks (width and shape measured
     by the radio), and offers the page that decodes it.
   - Overload warning: when the strongest signals hit the limits of the dongle's converter, sound distorts and ghost
     stations appear. A strip on the Radio page says so and offers to fix it.
   - Find the best gain: tries ten settings on the tuned signal and keeps the clearest one that does not overload. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc;
  const k = 1e3, M = 1e6;
  // Exact channels first (matched within 15 kHz), then ranges (narrowest wins).
  const CH = [
    [[131.550, 131.450, 131.725, 131.525, 131.825, 130.025, 129.125, 130.450, 136.900], 'Aircraft messages (ACARS)', 'Short text bursts between airliners and their airlines.', 'messages'],
    [[161.975, 162.025], 'Ship positions (AIS)', 'Ships broadcast who and where they are.', 'ships'],
    [[145.175, 144.390, 144.800, 144.575], 'APRS packet radio', 'Ham radio position and message packets.', 'ham'],
    [[121.500], 'Aviation emergency channel', 'The international distress and guard frequency for aircraft.'],
    [[156.800], 'Marine channel 16', 'Ship distress, safety and calling.'],
    [[137.100, 137.900], 'Meteor weather satellite', 'Digital cloud pictures when a Meteor satellite passes.', 'space'],
    [[145.800], 'Space station (ISS)', 'Voice and packet from the ISS when it passes.', 'space'],
    [[1090.000], 'Plane transponders (ADS-B)', 'Aircraft positions.', 'planes'],
  ];
  const RANGE = [
    [400.15, 406.0, 'Weather balloon band', 'Radiosondes send their position every second here.', 'sondes', s => !s || !s.bw || s.bw < 20 * k],
    [433.05, 434.79, 'Sensor band (433 MHz)', 'Weather stations, thermometers, doorbells and tyre sensors.', 'sensors'],
    [915.0, 928.0, 'Sensor band (915 MHz)', 'Meters, weather stations and other low-power devices.', 'sensors'],
    [476.4, 477.42, 'UHF CB radio', 'Two-way radio for everyone (Australia and New Zealand).'],
    [108.0, 117.975, 'Aircraft navigation beacon', 'VOR and ILS beacons; they identify themselves in Morse.'],
    [118.0, 137.0, 'Airband voice', 'Pilots and air traffic control, in AM.'],
    [87.5, 108.0, 'FM radio', 'Broadcast music and talk.'],
    [174.0, 230.0, 'Digital broadcasting and TV', 'Wide digital blocks; not decoded on this page.'],
    [0.531, 1.701, 'AM radio', 'Broadcast talk and sport.'],
    [26.965, 27.405, '27 MHz CB radio', 'Two-way radio, AM and SSB.'],
    [144.0, 148.0, '2 m ham band', 'Amateur radio: voice, repeaters and data.'],
    [420.0, 450.0, '70 cm ham band', 'Amateur radio: voice, repeaters and satellites.'],
    [156.0, 162.6, 'Marine VHF', 'Ship and harbour radio.'],
    [148.0, 174.0, 'Two-way radio and paging', 'Business, emergency services and pagers.'],
    [450.0, 520.0, 'Two-way radio', 'Business and government radio, much of it digital now.'],
    [1575.0, 1576.0, 'GPS', 'Satellite navigation; far below the noise without a special antenna.'],
  ];
  const PAGE = { messages: 'Messages', ships: 'Ships', ham: 'Ham', space: 'Space', planes: 'Planes', sondes: 'Balloons', sensors: 'Sensors' };

  function shapeWords(s) {
    if (!s || s.shape === 'none' || !s.bw) return '';
    const w = s.bw >= 1000 ? Math.round(s.bw / 100) / 10 + ' kHz' : s.bw + ' Hz';
    return { carrier: 'a steady carrier, ' + w + ' wide', am: 'AM-like, ' + w + ' wide', flat: 'flat-topped like a digital signal, ' + w + ' wide', fm: 'FM-like, ' + w + ' wide' }[s.shape] || w + ' wide';
  }
  RS.identify = (f, s) => {
    const mhz = f / M;
    for (const [list, name, detail, page] of CH) if (list.some(x => Math.abs(x - mhz) < 0.015)) return { name, detail, page };
    const hits = RANGE.filter(r => mhz >= r[0] && mhz <= r[1] && (!r[5] || r[5](s))).sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]));
    let r = hits[0] ? { name: hits[0][2], detail: hits[0][3], page: hits[0][4] } : null;
    if (r && s && s.shape === 'flat' && s.bw > 5 * k && s.bw < 14 * k && /Two-way|ham|CB|paging/i.test(r.name)) r = { name: 'Digital two-way radio', detail: 'Flat-topped signals like this are digital voice (DMR, P25 and similar), which Skywave cannot turn into sound.' };
    if (!r && s && s.shape !== 'none') r = { name: 'Unknown signal', detail: '' };
    return r;
  };

  // ---- Radio page: the "What is this?" line and the overload strip
  function mountRadio() {
    const q = $('#p-radio .rd-main') || $('#p-radio .readout'); if (!q || $('#rd-sig')) return;
    const d = document.createElement('div'); d.className = 'rd-sig'; d.id = 'rd-sig'; d.setAttribute('aria-live', 'polite'); q.appendChild(d);
    const o = document.createElement('div'); o.className = 'rd-over hide'; o.id = 'rd-over'; o.setAttribute('role', 'status');
    const dial = $('#rd-stage'); dial.parentNode.insertBefore(o, dial);
  }
  let lastSig = '', overSince = 0, overOn = false;
  function update() {
    if (RS.page !== 'radio') return;
    mountRadio();
    const st = RS.st || {}, el = $('#rd-sig'), ov = $('#rd-over'); if (!el) return;
    const id = st.vfo ? RS.identify(st.vfo, st.sig) : null, how = shapeWords(st.sig);
    const h = id ? '<span class="rd-sig-k">What is this?</span> <b>' + esc(id.name) + '</b>' + (how ? ' <span class="muted">(' + esc(how) + ')</span>' : '') +
      (id.page && RS.page !== id.page ? ' <button class="linkish" type="button" data-act="go" data-page="' + id.page + '">Open ' + PAGE[id.page] + '</button>' : '') +
      (id.detail ? '<div class="tiny muted">' + esc(id.detail) + '</div>' : '') : '';
    if (h !== lastSig) { el.innerHTML = h; lastSig = h; }
    // overload: only after it has lasted a couple of seconds, so a single strong burst does not nag
    // Measured over about 3 s by the server (clip_avg), ignoring the moment the radio opens or the gain changes. It comes on
    // above 1% and goes off below 0.4% (no flicker at the edge). Pressing "Keep this gain" remembers the gain: the warning then
    // only returns if the overload gets clearly worse (over 5%).
    const c = st.clip_avg != null ? st.clip_avg : (st.clip || 0), g0 = RS.cfg.gain_auto ? 'auto' : String(RS.cfg.gain_db);
    const kept = RS.store.get('clip_ok_gain', null) === g0;
    const lim = kept ? 5 : 1;
    if (st.job !== 'listen' || RS.cfg.gain_hint === false) overOn = false;
    else if (c > lim) overOn = true;
    else if (c < (kept ? 3 : 0.4)) overOn = false;
    const now = Date.now(); if (!overOn) overSince = 0; else if (!overSince) overSince = now;
    const show = overOn && (now - overSince > 2000 || c > 5) || !!(st.gtune && !st.gtune.quiet);   // the quiet re-check never shows
    // a gain remembered for this frequency: one quiet line, with a way to forget it
    let gm = $('#rd-gm');
    if (!gm) { gm = document.createElement('div'); gm.id = 'rd-gm'; gm.className = 'rd-gm tiny muted'; el.after(gm); }
    const gh = st.gmem && st.job === 'listen' ? 'Gain ' + st.gmem.gain + ' dB, remembered for this frequency' + (st.gtune && st.gtune.quiet ? ' (checking it)' : '') + '. <button class="linkish" type="button" data-act="sg-forget">Forget</button>' : '';
    if (gm._h !== gh) { gm._h = gh; gm.innerHTML = gh; gm.hidden = !gh; }
    ov.classList.toggle('hide', !show);
    if (show) {
      const g = st.gtune;
      ov.innerHTML = g ? '<div><b>Finding the best gain...</b> trying ' + g.i + ' of ' + g.n + (g.gain != null ? ' (' + g.gain + ' dB)' : '') + '</div><button class="btn small ghost" data-act="sg-stop" type="button">Stop</button>'
        : '<div><b>The signal is too strong for the dongle</b><span class="small"> ' + c.toFixed(1) + '% of samples are hitting the converter\'s limit (under 1% is fine), which causes distortion and ghost stations. Lowering the gain fixes it.</span></div><div class="row tight"><button class="btn small" data-act="sg-down" type="button">Lower the gain</button><button class="btn small" data-act="sg-tune" type="button">Find the best gain</button><button class="btn small ghost" data-act="sg-keep" type="button">Keep this gain</button></div>';
    }
  }
  RS.on('state', update);
  RS.on('page', p => { if (p === 'radio') { lastSig = ''; update(); } });
  RS.act['sg-down'] = () => RS.send({ cmd: 'gain_down' });
  RS.act['sg-keep'] = () => { RS.store.set('clip_ok_gain', RS.cfg.gain_auto ? 'auto' : String(RS.cfg.gain_db)); overOn = false; overSince = 0; update(); RS.toast('Kept. The warning only comes back if the overload gets much worse at this gain.'); };
  RS.act['sg-tune'] = () => { if (RS.st.job !== 'listen') { RS.toast('Open Radio and tune to a station first.', 'bad'); return; } RS.send({ cmd: 'gain_tune' }); RS.toast('Trying ten gain settings on this station. It takes about 15 seconds, and the answer is remembered for this frequency.'); };
  RS.act['sg-stop'] = () => RS.send({ cmd: 'gain_tune', stop: true });
  RS.act['sg-forget'] = () => RS.send({ cmd: 'gain_forget' });
  RS.on('gain_tune', m => {
    const box = $('#st-gt-res'); if (!box || !m.results) return;
    box.innerHTML = '<table class="tbl small"><thead><tr><th>Gain</th><th>Clarity</th><th>Overload</th></tr></thead><tbody>' + m.results.map(r => '<tr' + (r.gain === m.chosen ? ' class="plane-sel"' : '') + '><td>' + r.gain + ' dB' + (r.gain === m.chosen ? ' <b>chosen</b>' : '') + '</td><td>' + r.snr + ' dB</td><td>' + (r.clip ? r.clip + '%' : 'none') + '</td></tr>').join('') + '</tbody></table>';
  });

  // ---- Settings: the gain finder next to the gain slider
  const S = RS.pages.settings;
  if (S) {
    const init = S.init;
    S.init = function () {
      if (init) init.apply(this, arguments);
      const gain = $('#st-gain'); if (!gain) return;
      const field = gain.closest('.field');
      const d = document.createElement('div'); d.className = 'st-gt';
      d.innerHTML = '<div class="row tight" style="margin-top:8px"><button class="btn small" data-act="sg-tune" type="button">Find the best gain for the tuned station</button><label class="check"><input type="checkbox" id="st-ghint"><span>Warn me when the signal overloads</span></label></div><div id="st-gt-res" class="small" style="margin-top:6px"></div>';
      field.after(d);
      const cb = $('#st-ghint');
      RS.on('hello', () => { cb.checked = RS.cfg.gain_hint !== false; });
      cb.onchange = e => RS.api('config', { changes: { gain_hint: e.target.checked } }).then(r => { if (r && r.config) RS.cfg = r.config; });
    };
  }
})();
