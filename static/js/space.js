/* space.js - the Space page.
   One question first: what is the next satellite I can hear, where will it be, and how do I catch it? The page opens on
   that pass (or the one overhead now): its path across your sky, a live countdown, what it is likely to give you and one
   button to listen or record. Under it, the sky at a glance (every pass in the next hours, one row per satellite, as
   pioneered by Gpredict), the passes as a list, the satellites and their channels, recordings, antenna aiming (align.js)
   and orbit data. Positions are calculated from orbit data; they say where a satellite should be, not that it is heard. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc, icon = n => (RS.icon ? RS.icon(n) : '');
  const Sp = RS.pages.space = {};
  Sp.data = null; Sp.sel = null; Sp.hours = RS.store.get('sp_hours', 24); Sp.minEl = RS.store.get('sp_minel', 10); Sp.filter = 'all';
  const tracks = {};      // pass key -> [[az, el], ...]
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'off';
  const now = () => Date.now() / 1000;
  const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const dir = d => DIRS[Math.round(((d % 360) + 360) % 360 / 45) % 8];
  const key = p => p.sat + '-' + Math.floor(p.aos);
  const cat = id => (RS.catalog || []).find(c => c.id === id) || {};
  const day = t => { const d = new Date(t * 1000), n = new Date(); if (d.toDateString() === n.toDateString()) return 'Today'; if (new Date(n.getTime() + 864e5).toDateString() === d.toDateString()) return 'Tomorrow'; return d.toLocaleDateString([], { weekday: 'long' }); };
  const hm = t => new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const until = t => {
    const s = Math.round(t - now()); if (s <= 0) return 'now';
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
    return h ? h + ' h ' + m + ' min' : m + ' min ' + String(ss).padStart(2, '0') + ' s';
  };
  const mins = s => Math.max(1, Math.round(s / 60)) + ' min';

  // How the sun sits at a place and time (degrees above the horizon), to a degree: enough to say day or night pass.
  function sunEl(t, lat, lon) {
    const d = t / 86400 - 10957.5, g = (357.529 + 0.98560028 * d) * Math.PI / 180, q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * Math.PI / 180, e = (23.439 - 0.00000036 * d) * Math.PI / 180;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24, ha = (gmst * 15 + lon) * Math.PI / 180 - ra, la = lat * Math.PI / 180;
    return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha)) * 180 / Math.PI;
  }
  // What a pass is likely to give, in plain words. Pictures need height: a low weather pass breaks up wherever the signal does.
  const isWx = (p, c) => !!(c.decode || /meteor|weather/i.test((p.sat || '') + ' ' + (c.name || '')));
  function quality(p) {
    const c = cat(p.sat), el = p.max_el;
    if (isWx(p, c)) {
      const lit = RS.cfg && RS.cfg.lat != null ? sunEl((p.aos + p.los) / 2, RS.cfg.lat, RS.cfg.lon) > 5 : true;
      const light = lit ? 'A daylight pass, so the pictures come out in colour.' : 'A night pass: infrared only, so the pictures are grey.';
      if (el >= 50) return { n: 4, w: 'Excellent', tip: 'Very likely a complete picture. ' + light };
      if (el >= 30) return { n: 3, w: 'Good', tip: 'Usually a good picture; the start and end may break up. ' + light };
      if (el >= 20) return { n: 2, w: 'Fair', tip: 'Part of a picture at best, and only with a clear view down to the horizon.' };
      return { n: 1, w: 'Poor', tip: 'Too low for pictures with a simple antenna.' };
    }
    if (el >= 45) return { n: 4, w: 'Excellent', tip: 'High overhead for several minutes: the best chance to hear it.' };
    if (el >= 25) return { n: 3, w: 'Good', tip: 'Clear for a few minutes in the middle of the pass.' };
    if (el >= 15) return { n: 2, w: 'Fair', tip: 'Short and faint; a clear view that way helps.' };
    return { n: 1, w: 'Low', tip: 'Brief and faint; buildings and trees will block most of it.' };
  }
  // what to do with a pass: the channel to record and how
  function plan(p) {
    const c = cat(p.sat), fr = c.freqs || [], dig = fr.findIndex(f => f.kind === 'digital'), voice = fr.findIndex(f => f.kind !== 'digital');
    if (dig >= 0) return { c, fi: dig, kind: 'iq', label: c.decode ? 'Record and make pictures' : 'Record this pass' };
    if (voice >= 0) return { c, fi: voice, kind: 'audio', label: 'Record the sound' };
    return null;
  }
  const scheduled = (p, kind) => ((RS.space && RS.space.schedule) || []).find(s => s.id === key(p) + '-' + kind);
  const passes = () => ((Sp.data && Sp.data.passes) || []).filter(p => p.los > now());
  const live = p => p.aos <= now() && p.los > now();

  // ---------------------------------------------------------------- page
  Sp.init = () => {
    $('#p-space').innerHTML = `
    <div class="page-head"><h2>Space</h2></div>
    <div id="sp-warn"></div>
    <div id="sp-live"></div>
    <section class="glass spx-next" id="sp-next" aria-label="Next pass">
      <div class="spx-sky"><canvas id="sp-sky" class="spx-sky-cv" aria-label="Your sky, north at the top. The line is the satellite's path."></canvas>
        <div class="spx-sky-key"><span><i class="spx-k-path"></i>Its path</span><span><i class="spx-k-up"></i>Up now</span></div>
        <p class="spx-sky-note">Positions are calculated from orbit data: where a satellite should be, not proof it is heard.</p></div>
      <div class="spx-info" id="sp-info" aria-live="polite"></div>
    </section>

    <section class="card kx-static spx-glance">
      <div class="spx-head"><h3>The sky at a glance</h3>
        <div class="seg spx-hours" role="group" aria-label="How far ahead">${[12, 24, 48, 72].map(h => `<button type="button" data-act="sp-hours" data-h="${h}" aria-pressed="false">${h} h</button>`).join('')}</div></div>
      <p class="sub">Every pass over you, one row per satellite. Taller bars climb higher in the sky. Tap one to see it above.</p>
      <div class="spx-tl" id="sp-tl"></div>
    </section>

    <div class="spx-cols">
      <section class="card kx-static spx-list">
        <div class="spx-head"><h3>Coming up</h3>
          <div class="seg spx-filter" role="group" aria-label="Show">
            <button type="button" data-act="sp-filter" data-f="all" aria-pressed="true">All</button>
            <button type="button" data-act="sp-filter" data-f="good" aria-pressed="false">Worth it</button>
            <button type="button" data-act="sp-filter" data-f="rec" aria-pressed="false">Recording</button></div></div>
        <div id="sp-passes" class="spx-rows"></div>
        <label class="field adv-only spx-minel">Lowest peak to list <select id="sp-minel">${[0, 10, 20, 30, 45].map(v => `<option value="${v}">${v}&deg;</option>`).join('')}</select></label>
      </section>
      <section class="card kx-static spx-rec">
        <h3>Recordings</h3>
        <p class="sub">Scheduled passes record by themselves. Leave Skywave running.</p>
        <div id="sp-sched" class="spx-rows"></div>
        <details class="spx-more adv-only"><summary>Record any frequency now</summary>
          <div class="spx-form"><label class="field">Satellite <select id="sp-rsat"><option value="">None</option></select></label>
            <label class="field">Frequency (MHz)<input type="text" id="sp-rf" value="137.9" inputmode="decimal"></label>
            <label class="field">Minutes<input type="number" id="sp-rm" value="12" min="1" max="30"></label></div>
          <label class="field">Tuner gain for satellite recordings <span class="hint">Fixed, never automatic. About 40 dB suits most set-ups; the recording says if the radio was overloaded.</span><input type="range" id="sp-gain" min="0" max="49.6" step="0.1"></label>
          <p class="tiny muted">About 120 MB a minute. Weather satellites send on 137 MHz: a V-dipole lying flat and open to the sky works best.</p>
          <button class="btn primary" data-act="sp-rec">${icon('rec')}<span>Start recording</span></button></details>
      </section>
    </div>

    <section class="card kx-static spx-sats">
      <div class="spx-head"><h3>Satellites</h3><span class="sub" id="sp-sats-n"></span></div>
      <div id="sp-sats" class="spx-satlist"></div>
      <details class="spx-more"><summary>Add another satellite</summary>
        <p class="small muted">Any satellite can be tracked if you know its NORAD number and the frequency it sends on: both are listed on celestrak.org and amsat.org. Its orbit data downloads by itself (needs internet).</p>
        <div class="spx-form"><label class="field">Name<input type="text" id="sp-cn" placeholder="e.g. AO-91"></label>
          <label class="field">NORAD number<input type="text" id="sp-cid" inputmode="numeric" placeholder="e.g. 43017"></label>
          <label class="field">Frequency (MHz)<input type="text" id="sp-cf" inputmode="decimal" placeholder="e.g. 145.96"></label>
          <label class="field">Type<select id="sp-cm"><option value="nfm">FM voice</option><option value="usb">SSB (upper)</option><option value="lsb">SSB (lower)</option><option value="am">AM</option><option value="cw">Morse (CW)</option><option value="raw">Digital data (record only)</option></select></label></div>
        <button class="btn primary" data-act="sp-addsat">${icon('plus')}<span>Add satellite</span></button></details>
    </section>

    <details class="card kx-static spx-aim" id="sp-aim-wrap"><summary>Aim an antenna <span class="sub">Live compass bearing and height, with your phone's compass</span></summary><div id="sp-aim-slot"></div></details>

    <details class="card kx-static spx-orbit adv-only"><summary>Orbit data <span class="sub" id="sp-tle-sub"></span></summary>
      <p class="small" id="sp-tle-st"></p>
      <div class="row tight"><button class="btn" data-act="sp-refresh">Update orbit data now</button><button class="btn" data-act="sp-sync">Check satellite channels now</button></div>
      <p class="small muted" id="sp-sync-st"></p>
      <label class="field">Paste orbit data (TLE text) for use without internet<textarea id="sp-tle" placeholder="ISS (ZARYA)&#10;1 25544U 98067A ...&#10;2 25544 ..."></textarea></label>
      <button class="btn" data-act="sp-tle">Use pasted data</button></details>`;
    $('#sp-minel').value = String(Sp.minEl);
    $('#sp-minel').onchange = e => { Sp.minEl = +e.target.value; RS.store.set('sp_minel', Sp.minEl); Sp.load(); };
    $('#sp-rsat').onchange = e => { const c = cat(e.target.value); if (c.freqs) $('#sp-rf').value = String(+(c.freqs[0].f / 1e6).toFixed(4)); };
    const sg = $('#sp-gain');
    RS.scale(sg, { unit: 'dB', ticks: [0, 20, 40, 49.6], zones: [[0, 'Low', 'only for very strong signals'], [30, 'Medium', 'a good start with a strong antenna'], [38, 'Recommended', 'works for most satellite set-ups']] });
    sg.onchange = e => RS.api('config', { changes: { sat_gain_db: parseFloat(e.target.value) } });
    RS.on('hello', () => { if (RS.cfg) { sg.value = RS.cfg.sat_gain_db; sg._scaleUpd && sg._scaleUpd(); } if (RS.page === 'space') Sp.all(); });
    $('#sp-sats').addEventListener('change', e => {
      const s = e.target.closest('[data-auto]'); if (!s) return;
      RS.api('space/auto', { sat: s.dataset.auto, min_el: +s.value }).then(r => { RS.space.auto = r.auto; RS.toast(+s.value ? 'Done. ' + (r.added ? r.added + ' upcoming pass' + (r.added === 1 ? ' is' : 'es are') + ' scheduled.' : 'Passes will be scheduled as they come up.') : 'Automatic recording off.'); Sp.load(true); }).catch(er => RS.toast(er.message, 'bad'));
    });
    RS.on('schedule', () => { if (RS.page === 'space') { Sp.recs(); Sp.render(); } });
    RS.on('space_auto', m => { RS.space.auto = m.auto; });
    RS.on('catalog', () => { if (RS.page === 'space') { Sp.sats(); Sp.load(true); } });
    RS.on('space_status', () => { if (RS.page === 'space') { Sp.status(); Sp.load(true); } });
    RS.on('space_sync', m => { RS.space.sync = m.sync; if (m.catalog) { RS.catalog = m.catalog; RS.fire('catalog'); } Sp.status(); });
    RS.on('record_started', m => { RS.irec = { file: m.file, secs: m.seconds, t0: Date.now(), bytes: 0 }; Sp.live(); });
    RS.on('record_progress', m => { RS.irec = Object.assign(RS.irec || {}, m); Sp.live(); });
    RS.on('record_signal', m => { RS.irec = Object.assign(RS.irec || {}, { sig: m }); Sp.live(); });
    RS.on('record_done', m => { RS.irec = null; Sp.live(); RS.toast('Recording finished. It is in the Library' + (/meteor/i.test(m.file || '') ? ', and the weather pictures appear there shortly.' : '.')); });
    RS.on('state', () => { if (RS.page === 'space') Sp.live(); });
    window.addEventListener('resize', () => { if (RS.page === 'space') Sp.sky(); });
  };
  let tick = 0, poll = 0;
  Sp.enter = () => {
    Sp.all(); Sp.load();
    clearInterval(tick); tick = setInterval(() => { if (RS.page === 'space' && !document.hidden) { Sp.info(); Sp.sky(); Sp.nowLine(); } }, 1000);
    clearInterval(poll); poll = setInterval(() => { if (RS.page === 'space' && !document.hidden) Sp.load(true); }, 15000);
  };
  Sp.leave = () => { clearInterval(tick); clearInterval(poll); };
  Sp.all = () => { Sp.status(); Sp.sats(); Sp.recs(); Sp.live(); Sp.render(); RS.$$('[data-act="sp-hours"]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.h === Sp.hours))); };
  Sp.load = async quiet => {
    try {
      Sp.data = await RS.api('space/passes?hours=' + Sp.hours + '&min_el=' + Sp.minEl);
      if (Sp.data.schedule) RS.space.schedule = Sp.data.schedule;
      Sp.status(); Sp.render(); Sp.recs();
    } catch (e) { if (!quiet) RS.toast(e.message, 'bad'); }
  };
  Sp.render = () => { pick(); Sp.info(); Sp.sky(); Sp.timeline(); Sp.list(); Sp.sats(); };

  // the pass the top panel shows: your choice while it lasts, else the one overhead now, else the next one
  function pick() {
    const L = passes();
    if (Sp.sel && !L.some(p => key(p) === Sp.sel)) Sp.sel = null;
    if (!Sp.sel && L.length) Sp.sel = key(L.find(live) || L[0]);
  }
  const selected = () => passes().find(p => key(p) === Sp.sel) || null;
  async function trackFor(p) {
    const k = key(p); if (tracks[k]) return tracks[k];
    tracks[k] = 'loading';
    try { tracks[k] = (await RS.api('space/track?sat=' + encodeURIComponent(p.sat) + '&t0=' + p.aos + '&t1=' + p.los)).track || []; }
    catch (e) { tracks[k] = []; }
    Sp.sky(); return tracks[k];
  }

  // ---------------------------------------------------------------- status and the live strip
  Sp.status = () => {
    const sp = RS.space || {}, w = $('#sp-warn'); if (!w) return;
    let h = '';
    if ((Sp.data ? Sp.data.available : sp.available) === false) h = '<div class="banner bad"><div class="txt"><strong>Satellite tracking is not installed</strong>The orbit library (sgp4) is missing from this container. Rebuild it with the supplied Dockerfile.</div></div>';
    else if ((Sp.data ? Sp.data.tle_age_days : sp.tle_age_days) == null) h = '<div class="banner warn"><div class="txt"><strong>No orbit data yet</strong>Skywave downloads satellite orbits from CelesTrak. ' + esc(sp.status || '') + ' Without internet, paste orbit data under Orbit data (Advanced).</div><button class="btn" data-act="sp-refresh">Try again</button></div>';
    else if (sp.tle_age_days > 10) h = '<div class="banner warn"><div class="txt"><strong>Orbit data is ' + Math.round(sp.tle_age_days) + ' days old</strong>Predictions drift as it ages.</div><button class="btn" data-act="sp-refresh">Update</button></div>';
    if (w._h !== h) { w._h = h; w.innerHTML = h; }
    const sy = sp.sync || {};
    RS.setText($('#sp-sync-st'), sy.t ? 'Channels last checked ' + RS.ago(sy.t) + ' against the public SatNOGS database' + (sy.ok === false ? ' (failed)' : '') + '. ' + (sy.msg || '') : 'Channels have not been checked against the public SatNOGS database yet.');
    RS.setText($('#sp-tle-st'), (sp.tle_age_days != null ? 'Orbit data is ' + sp.tle_age_days.toFixed(1) + ' days old. ' : 'No orbit data. ') + (sp.status || ''));
    RS.setText($('#sp-tle-sub'), sp.tle_age_days != null ? sp.tle_age_days.toFixed(1) + ' days old' : 'none yet');
  };
  // following a satellite, or recording one: a strip above everything, with the live signal reading
  Sp.live = () => {
    const el = $('#sp-live'); if (!el) return;
    const d = RS.st && RS.st.doppler, r = RS.irec, rec = RS.st && RS.st.job === 'record';
    let h = '';
    if (rec || r) {
      const secs = r && r.secs || 0, done = r && r.secs_done != null ? r.secs_done : (r && r.t0 ? (Date.now() - r.t0) / 1000 : 0), m = r && r.sig;
      const word = m ? { none: 'not detected', weak: 'weak', good: 'good', strong: 'strong' }[m.level] || '' : '';
      let note = '';
      if (m && m.level === 'none' && done > 45) note = 'Nothing detected yet. The antenna wants a clear view of the sky, fully extended.';
      else if (m && m.level === 'weak') note = 'Weak. Pictures need about 5 dB or more; the higher part of the pass should help.';
      if (m && m.clip > 2) note = 'The radio is overloaded (' + m.clip + '% clipped). Lower the satellite gain under Recordings.';
      h = '<div class="spx-strip rec"><div class="spx-strip-t"><b>Recording' + (r && r.file ? ' ' + esc(r.file) : '') + '</b><span>' + (r && r.bytes ? RS.mb(r.bytes) + ' · ' : '') + (secs ? RS.dur(Math.max(secs - done, 0)) + ' left' : '') + (m ? ' · signal ' + word + ' (' + m.db.toFixed(1) + ' dB)' : '') + '</span>' + (note ? '<small>' + esc(note) + '</small>' : '') + '</div>' +
        '<div class="spx-bar"><i style="transform:scaleX(' + (secs ? Math.min(1, done / secs) : 0) + ')"></i></div><button class="btn small" data-act="sp-recstop">Stop</button></div>';
    } else if (d) {
      const c = cat(d.sat);
      h = '<div class="spx-strip"><div class="spx-strip-t"><b>Following ' + esc(c.short || d.sat) + '</b><span>On ' + esc(RS.fmt(RS.vfo())) + (d.shift != null ? ' · Doppler ' + (d.shift >= 0 ? '+' : '') + (d.shift / 1000).toFixed(1) + ' kHz' : '') + '. Only hiss? It may not be overhead yet.</span></div><button class="btn small" data-act="sp-unfollow">Stop following</button></div>';
    }
    if (el._h !== h) { el._h = h; el.innerHTML = h; }
  };

  // ---------------------------------------------------------------- the next pass
  Sp.info = () => {
    const el = $('#sp-info'); if (!el) return;
    const p = selected(), L = passes();
    if (!p) {
      const noloc = !RS.cfg || (!RS.cfg.lat && !RS.cfg.lon);
      const h = '<div class="spx-none"><b>' + (noloc ? 'Where are you?' : Sp.data ? 'No passes coming up' : 'Working out passes...') + '</b><span>' +
        (noloc ? 'Passes depend on where you are. Set your location in Settings.' : Sp.data && (Sp.data.available === false || Sp.data.tle_age_days == null) ? 'Orbit data is needed first.' : Sp.data ? 'Nothing climbs above ' + Sp.minEl + '° in the next ' + Sp.hours + ' hours. Look further ahead below.' : '') + '</span></div>';
      if (el._h !== h) { el._h = h; el.innerHTML = h; }
      return;
    }
    const q = quality(p), on = live(p), c = cat(p.sat), pl = plan(p), sch = pl && scheduled(p, pl.kind), i = L.indexOf(p);
    const prog = on ? (now() - p.aos) / (p.los - p.aos) : 0;
    const path = 'Rises in the ' + dir(p.az_aos) + ', climbs to ' + Math.round(p.max_el) + '° in the ' + dir(p.az_tca) + ', sets in the ' + dir(p.az_los) + '.';
    const voice = (c.freqs || []).map((f, fi) => [f, fi]).filter(x => x[0].kind !== 'digital');
    const struct = p.sat + '|' + p.aos + '|' + (sch ? 1 : 0) + '|' + on + '|' + i + '|' + L.length + '|' + voice.length + '|' + (pl ? pl.kind : '');   // redrawn once the satellite list arrives too
    if (el._s !== struct) {
      const was = el._s; el._s = struct;
      const swap = was && RS.feel && RS.feel.recent(800) && was.split('|')[1] !== String(p.aos);
      const set = h => { if (swap) RS.feel.swap(el, h); else el.innerHTML = h; };
      set('<div class="spx-when"><span id="sp-k">' + (on ? 'Overhead now' : esc(day(p.aos)) + ' at ' + esc(hm(p.aos))) + '</span><span class="spx-nav">' +
        '<button class="btn small" data-act="sp-step" data-d="-1" aria-label="Earlier pass"' + (i <= 0 ? ' disabled' : '') + '>' + icon('left') + '</button>' +
        '<button class="btn small" data-act="sp-step" data-d="1" aria-label="Later pass"' + (i >= L.length - 1 ? ' disabled' : '') + '>' + icon('right') + '</button></span></div>' +
        '<h3 class="spx-name">' + esc(p.short) + '</h3><div class="spx-what">' + esc(c.name && c.name !== p.short ? c.name.replace(/^[^(]*\(|\)$/g, '') : '') + '</div>' +
        '<div class="spx-count"><b id="sp-count"></b><span id="sp-count-l"></span></div>' +
        '<div class="spx-prog' + (on ? '' : ' hide') + '"><i id="sp-prog"></i></div>' +
        '<dl class="spx-facts"><div><dt>Highest</dt><dd>' + Math.round(p.max_el) + '°</dd></div><div><dt>Lasts</dt><dd>' + mins(p.los - p.aos) + '</dd></div><div><dt>Chances</dt><dd><span class="spx-q q' + q.n + '">' + esc(q.w) + '</span></dd></div></dl>' +
        '<p class="spx-path">' + esc(path) + ' ' + esc(q.tip) + '</p>' +
        '<div class="spx-acts">' +
        (voice.length ? '<button class="btn' + (on ? ' primary' : '') + '" data-act="sp-listen" data-sat="' + esc(p.sat) + '" data-i="' + voice[0][1] + '">' + icon('sound') + '<span>' + (on ? 'Listen now' : 'Listen') + '</span></button>' : '') +
        (pl ? (sch ? '<button class="btn on" data-act="sp-unsched" data-id="' + esc(sch.id) + '" title="Cancel this recording">' + icon('check') + '<span>Will record</span></button>'
          : '<button class="btn' + (on ? '' : ' primary') + '" data-act="sp-sched" data-k="' + esc(key(p)) + '">' + icon('rec') + '<span>' + esc(pl.label) + '</span></button>') : '') +
        '</div>');
    }
    RS.setText($('#sp-count'), on ? until(p.los) : until(p.aos));
    RS.setText($('#sp-count-l'), on ? 'until it sets' : 'until it rises');
    const pr = $('#sp-prog'); if (pr) pr.style.transform = 'scaleX(' + Math.min(1, Math.max(0, prog)).toFixed(4) + ')';
    if (on) RS.setText($('#sp-k'), 'Overhead now');
  };
  RS.act['sp-step'] = b => { const L = passes(), i = L.findIndex(p => key(p) === Sp.sel), j = Math.min(Math.max(i + +b.dataset.d, 0), L.length - 1); if (L[j]) { Sp.sel = key(L[j]); Sp.render(); } };
  RS.act['sp-pick'] = b => { Sp.sel = b.dataset.k; Sp.render(); const n = $('#sp-next'); if (n && n.getBoundingClientRect().top < 0) n.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'start' }); };

  // ---------------------------------------------------------------- your sky
  Sp.sky = () => {
    const cv = $('#sp-sky'); if (!cv) return; const c = RS.fit(cv); if (!c) return;
    const g = c.g, w = c.w, h = c.h, cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 20, s = getComputedStyle(cv);
    const ink = s.getPropertyValue('--inst-ink').trim() || s.color, sig = s.getPropertyValue('--sig').trim() || ink, body = s.getPropertyValue('--f-body').trim() || 'sans-serif';
    const pos = (az, el) => { const r = R * (90 - Math.max(0, el)) / 90, a = az * Math.PI / 180; return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; };
    g.clearRect(0, 0, w, h); g.save();
    g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = 1;
    g.globalAlpha = .06; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
    g.globalAlpha = .28; [1, 2 / 3, 1 / 3].forEach(k => { g.beginPath(); g.arc(cx, cy, R * k, 0, 7); g.stroke(); });
    g.globalAlpha = .14; g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
    g.globalAlpha = .75; g.font = '500 12px ' + body; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('N', cx, cy - R - 11); g.fillText('S', cx, cy + R + 11); g.fillText('E', cx + R + 11, cy); g.fillText('W', cx - R - 11, cy);
    g.globalAlpha = .45; g.font = '11px ' + body; g.textAlign = 'left'; g.fillText('30°', cx + 4, cy - R * 2 / 3 - 7); g.fillText('60°', cx + 4, cy - R / 3 - 7);
    g.globalAlpha = 1;
    // everything above the horizon now, quietly
    const p = selected(), up = ((Sp.data && Sp.data.sky) || []).filter(x => x.up);
    up.forEach(x => {
      if (p && x.id === p.sat) return;
      const [x0, y0] = pos(x.az, x.el); g.globalAlpha = .55; g.beginPath(); g.arc(x0, y0, 3.5, 0, 7); g.fill();
      g.globalAlpha = .7; g.font = '11px ' + body; g.textAlign = x0 > cx ? 'right' : 'left'; g.fillText(x.short, x0 + (x0 > cx ? -8 : 8), y0);
    });
    g.globalAlpha = 1;
    // the chosen pass: its path, where it rises and sets, and where it is now
    if (p) {
      const tr = tracks[key(p)];
      if (!tr) trackFor(p);
      else if (tr !== 'loading' && tr.length > 1) {
        // a new path reveals itself from where the satellite rises (a mask along the line, 450 ms, easing out)
        const k = key(p); if (Sp._rev !== k) { Sp._rev = k; Sp._rev0 = (RS.feel && !RS.feel.still()) ? performance.now() : 0; }
        const q = Sp._rev0 ? Math.min(1, (performance.now() - Sp._rev0) / 450) : 1, frac = 1 - Math.pow(1 - q, 3), n = Math.max(2, Math.ceil(frac * tr.length));
        if (q < 1) requestAnimationFrame(() => Sp.sky());
        g.strokeStyle = sig; g.lineWidth = 3; g.lineCap = 'round'; g.lineJoin = 'round';
        g.beginPath(); tr.slice(0, n).forEach(([az, el], i) => { const [x, y] = pos(az, el); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
        if (q < 1) { g.restore(); return; }
        const [ax, ay] = pos(tr[0][0], tr[0][1]); g.fillStyle = sig; g.beginPath(); g.arc(ax, ay, 4, 0, 7); g.fill();
        // arrowhead where it sets
        const a = tr[tr.length - 2], b = tr[tr.length - 1], [bx, by] = pos(b[0], b[1]), [px, py] = pos(a[0], a[1]), ang = Math.atan2(by - py, bx - px);
        g.beginPath(); g.moveTo(bx + 8 * Math.cos(ang), by + 8 * Math.sin(ang)); g.lineTo(bx + 7 * Math.cos(ang + 2.4), by + 7 * Math.sin(ang + 2.4)); g.lineTo(bx + 7 * Math.cos(ang - 2.4), by + 7 * Math.sin(ang - 2.4)); g.closePath(); g.fill();
        if (live(p)) {
          const k = (now() - p.aos) / (p.los - p.aos) * (tr.length - 1), i = Math.min(tr.length - 2, Math.floor(k)), f = k - i;
          const az = tr[i][0] + (((tr[i + 1][0] - tr[i][0] + 540) % 360) - 180) * f, el = tr[i][1] + (tr[i + 1][1] - tr[i][1]) * f, [x, y] = pos(az, el);
          g.globalAlpha = .22; g.beginPath(); g.arc(x, y, 13, 0, 7); g.fill(); g.globalAlpha = 1;
          g.beginPath(); g.arc(x, y, 6.5, 0, 7); g.fill();
          g.strokeStyle = ink; g.lineWidth = 2; g.stroke();
        }
      }
    }
    g.restore();
  };

  // ---------------------------------------------------------------- the sky at a glance
  Sp.timeline = () => {
    const el = $('#sp-tl'); if (!el) return;
    const L = passes(), t0 = now(), span = Sp.hours * 3600, x = t => ((t - t0) / span * 100);
    if (!L.length) { const h = '<div class="spx-empty">' + (Sp.data ? 'No passes in the next ' + Sp.hours + ' hours.' : 'Working out passes...') + '</div>'; if (el._h !== h) { el._h = h; el.innerHTML = h; } return; }
    const sats = []; L.forEach(p => { if (!sats.includes(p.sat)) sats.push(p.sat); });
    const step = (Sp.hours <= 12 ? 2 : Sp.hours <= 24 ? 3 : Sp.hours <= 48 ? 6 : 12) * (el.clientWidth && el.clientWidth < 520 ? 2 : 1), first = new Date(t0 * 1000); first.setMinutes(0, 0, 0);
    let ticks = '';
    for (let t = first.getTime() / 1000 + 3600; t < t0 + span; t += 3600) {
      const d = new Date(t * 1000); if (d.getHours() % step) continue;
      ticks += '<span class="spx-tick' + (d.getHours() === 0 ? ' day' : '') + '" style="left:' + x(t).toFixed(2) + '%">' + (d.getHours() === 0 ? esc(d.toLocaleDateString([], { weekday: 'short' })) : esc(d.toLocaleTimeString([], { hour: 'numeric' }))) + '</span>';
    }
    const h = '<div class="spx-tl-axis"><span class="spx-tl-lab"></span><div class="spx-tl-track">' + ticks + '</div></div>' + sats.map(s => {
      const P = L.filter(p => p.sat === s);
      return '<div class="spx-tl-row"><span class="spx-tl-lab">' + esc(P[0].short) + '</span><div class="spx-tl-track">' + P.map(p => {
        const a = Math.max(0, x(p.aos)), b = Math.min(100, x(p.los)), q = quality(p), ht = 6 + Math.min(90, p.max_el) / 90 * 20, pl = plan(p), rec = pl && scheduled(p, pl.kind);
        return '<button type="button" class="spx-pass q' + q.n + (key(p) === Sp.sel ? ' on' : '') + (rec ? ' rec' : '') + (live(p) ? ' live' : '') + '" data-act="sp-pick" data-k="' + esc(key(p)) + '" style="left:' + a.toFixed(3) + '%;width:calc(' + Math.max(0, b - a).toFixed(3) + '% + 3px);--h:' + ht.toFixed(1) + 'px" ' +
          'aria-label="' + esc(p.short + ', ' + day(p.aos) + ' at ' + hm(p.aos) + ', up to ' + Math.round(p.max_el) + ' degrees' + (rec ? ', will record' : '')) + '" title="' + esc(hm(p.aos) + ' – ' + hm(p.los) + ', up to ' + Math.round(p.max_el) + '°') + '"></button>';
      }).join('') + '</div></div>';
    }).join('') + '<div class="spx-tl-now" aria-hidden="true"></div>';
    if (el._h !== h) { el._h = h; el.innerHTML = h; if (Sp._stag) RS.feel && RS.feel.stagger(el.querySelectorAll('.spx-tl-row')); }
    if (RS.feel) RS.feel.mark(el, el.querySelector('.spx-pass.on'), 'ring');
  };
  Sp.nowLine = () => { const t = Sp._tlT || 0; if (Date.now() - t > 60000) { Sp._tlT = Date.now(); Sp.timeline(); } };   // the window starts now, so it moves on once a minute

  // ---------------------------------------------------------------- coming up
  Sp.list = () => {
    const el = $('#sp-passes'); if (!el) return;
    let L = passes();
    if (Sp.filter === 'good') L = L.filter(p => quality(p).n >= 3);
    if (Sp.filter === 'rec') L = L.filter(p => { const pl = plan(p); return pl && scheduled(p, pl.kind); });
    const h = L.length ? L.slice(0, 40).map(p => {
      const q = quality(p), pl = plan(p), rec = pl && scheduled(p, pl.kind), on = live(p);
      return '<div class="spx-row' + (key(p) === Sp.sel ? ' on' : '') + '"><button type="button" class="spx-row-main" data-act="sp-pick" data-k="' + esc(key(p)) + '">' +
        '<span class="spx-row-t"><b>' + (on ? 'Now' : esc(hm(p.aos))) + '</b><small>' + (on ? 'overhead' : esc(day(p.aos))) + '</small></span>' +
        '<span class="spx-row-n"><b>' + esc(p.short) + '</b><small>' + Math.round(p.max_el) + '° high · ' + mins(p.los - p.aos) + ' · ' + esc(dir(p.az_aos)) + ' to ' + esc(dir(p.az_los)) + '</small></span>' +
        '<span class="spx-q q' + q.n + '">' + esc(q.w) + '</span></button>' +
        (pl ? (rec ? '<button class="btn small on" data-act="sp-unsched" data-id="' + esc(rec.id) + '" aria-label="Cancel recording of ' + esc(p.short) + '" title="Cancel this recording">' + icon('check') + '<span>Will record</span></button>'
          : '<button class="btn small" data-act="sp-sched" data-k="' + esc(key(p)) + '" aria-label="Record ' + esc(p.short) + ' at ' + esc(hm(p.aos)) + '" title="' + esc(pl.label) + '">' + icon('rec') + '<span>Record</span></button>') : '') + '</div>';
    }).join('') : '<div class="spx-empty">' + (Sp.filter === 'rec' ? 'Nothing scheduled yet. Press the record button on a pass.' : Sp.filter === 'good' ? 'No high passes in this window.' : Sp.data ? 'No passes coming up.' : 'Working out passes...') + '</div>';
    if (el._h !== h) { el._h = h; el.innerHTML = h; if (Sp._stag && RS.feel) { RS.feel.stagger(el.querySelectorAll('.spx-row')); Sp._stag = false; } }
    if (RS.feel) RS.feel.mark(el, el.querySelector('.spx-row.on'));
    RS.$$('[data-act="sp-filter"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.f === Sp.filter)));
  };
  RS.act['sp-filter'] = b => { Sp.filter = b.dataset.f; Sp._stag = true; Sp.list(); };
  RS.act['sp-hours'] = b => { Sp.hours = +b.dataset.h; RS.store.set('sp_hours', Sp.hours); RS.$$('[data-act="sp-hours"]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); Sp._stag = true; Sp.load(); };

  // ---------------------------------------------------------------- recordings
  Sp.recs = () => {
    const el = $('#sp-sched'); if (!el) return;
    const L = ((RS.space && RS.space.schedule) || []).filter(s => s.end > now()).sort((a, b) => a.start - b.start);
    const h = L.length ? L.map(s => '<div class="spx-row" data-k="' + esc(s.id) + '"><span class="spx-row-t"><b>' + esc(hm(s.aos || s.start)) + '</b><small>' + esc(day(s.aos || s.start)) + '</small></span>' +
      '<span class="spx-row-n"><b>' + esc((s.label || s.sat).replace(/ (Today|Tomorrow|[A-Z][a-z]{2,8}) .*$/, '')) + '</b><small>' + esc(RS.fmt(s.freq)) + ' · ' + (s.kind === 'iq' ? 'radio data' : 'sound') + (s.max_el ? ' · ' + Math.round(s.max_el) + '°' : '') + '</small></span>' +
      '<button class="btn small ghost" data-act="sp-unsched" data-id="' + esc(s.id) + '">Cancel</button></div>').join('')
      : '<div class="spx-empty">Nothing scheduled. Record a pass from the list, or let a satellite record every good pass by itself (Satellites, below).</div>';
    if (el._h === h) return;
    const first = el._h == null; el._h = h;
    if (first || !RS.feel) el.innerHTML = h; else RS.feel.flip(el, c => c.dataset.k || (c.classList.contains('spx-empty') ? 'empty' : null), () => { el.innerHTML = h; });
    if (Sp._fly) {
      const f = Sp._fly; Sp._fly = null; const to = el.querySelector('[data-k="' + f.id + '"]'), vis = r => r.top >= 0 && r.bottom <= innerHeight;
      if (to && f.el && f.el.isConnected && vis(to.getBoundingClientRect()) && RS.feel) { to.style.visibility = 'hidden'; RS.feel.arc(f.el, to, { label: f.label, done: () => { to.style.visibility = ''; } }); }
      else if (RS.feel) { const b = document.querySelector('[data-act="sp-unsched"][data-id="' + f.id + '"]'); if (b) RS.feel.pulse(b); }
    }
  };

  // ---------------------------------------------------------------- satellites
  const open = {};
  Sp.sats = () => {
    const el = $('#sp-sats'); if (!el) return;
    const C = RS.catalog || [], auto = (RS.space && RS.space.auto) || {};
    RS.setText($('#sp-sats-n'), C.length ? C.length + ' tracked' : '');
    const chk = f => f.check === 'active' ? '<span class="spx-chip good" title="The public SatNOGS database lists this channel as in use">reported on</span>' : f.check === 'inactive' ? '<span class="spx-chip warn" title="The public SatNOGS database lists this channel as off">reported off</span>' : '';
    const next = id => passes().find(p => p.sat === id);
    const h = C.map(c => {
      const n = next(c.id), a = auto[c.id], aval = a ? (a.min_el != null ? a.min_el : a) : 0;
      return '<details class="spx-sat" data-sid="' + esc(c.id) + '"' + (open[c.id] ? ' open' : '') + '><summary><span class="spx-sat-n"><b>' + esc(c.short) + '</b><small>' + esc(c.name !== c.short ? c.name.replace(/^[^(]*\(|\)$/g, '') : '') + '</small></span>' +
        '<span class="spx-sat-s">' + (c.live && c.live.status && c.live.status !== 'alive' ? '<span class="spx-chip warn">' + esc(c.live.status) + '</span>' : '') + (+aval ? '<span class="spx-chip">records itself</span>' : '') +
        '<small>' + (n ? (live(n) ? 'overhead now' : 'next ' + esc(day(n.aos).toLowerCase()) + ' ' + esc(hm(n.aos))) : '') + '</small></span></summary>' +
        '<div class="spx-sat-b">' + (c.note || c.about ? '<p class="small">' + esc(c.note || c.about) + '</p>' : '') +
        (c.freqs || []).map((f, i) => '<div class="spx-ch"><span class="spx-ch-t"><b>' + esc(f.label) + '</b><small>' + esc(RS.fmt(f.f)) + ' · ' + esc((RS.MODES[f.mode] || {}).name || f.mode) + '</small>' + chk(f) + '</span><span class="spx-ch-a">' +
          (f.kind === 'digital' ? '<button class="btn small" data-act="sp-recsat" data-sat="' + esc(c.id) + '" data-i="' + i + '">' + icon('rec') + '<span>Record 12 min' + (c.decode ? ', make pictures' : '') + '</span></button>'
            : '<button class="btn small" data-act="sp-listen" data-sat="' + esc(c.id) + '" data-i="' + i + '">' + icon('sound') + '<span>Listen</span></button><button class="btn small" data-act="sp-listen" data-rec="1" data-sat="' + esc(c.id) + '" data-i="' + i + '">' + icon('rec') + '<span>Listen and record</span></button>') + '</span></div>').join('') +
        '<label class="field spx-auto">Record by itself <select data-auto="' + esc(c.id) + '">' + [[0, 'Never'], [20, 'Every pass above 20°'], [30, 'Every pass above 30°'], [45, 'Every pass above 45°'], [60, 'Every pass above 60°']].map(([v, t]) => '<option value="' + v + '"' + (+aval === v ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></label>' +
        (c.custom ? '<button class="btn small ghost danger" data-act="sp-delsat" data-id="' + esc(c.id) + '">Remove this satellite</button>' : '') + '</div></details>';
    }).join('') || '<div class="spx-empty">No satellites yet.</div>';
    if (el._h === h) return; el._h = h; el.innerHTML = h;
    el.querySelectorAll('details.spx-sat').forEach(d => d.addEventListener('toggle', () => { open[d.dataset.sid] = d.open; }));
    const sel = $('#sp-rsat'); if (sel) { const v = sel.value; sel.innerHTML = '<option value="">None</option>' + C.map(c => '<option value="' + esc(c.id) + '">' + esc(c.short) + '</option>').join(''); sel.value = C.some(c => c.id === v) ? v : ''; }
  };

  // ---------------------------------------------------------------- actions
  RS.act['sp-listen'] = b => {
    const c = cat(b.dataset.sat), f = (c.freqs || [])[+b.dataset.i]; if (!f) return;
    if (!RS.audio.on) RS.audio.start();
    RS.tune(f.f, { mode: f.mode, bw: f.bw, recenter: true, keep_doppler: true });
    RS.send({ cmd: 'doppler', on: true, sat: c.id, f0: f.f });
    if (b.dataset.rec) { setTimeout(() => RS.send({ cmd: 'rec_audio', on: true }), 400); RS.toast('Recording what you hear from ' + c.short + '. Press Record at the bottom to stop. Nothing is heard until it is above the horizon.'); }
    else if (f.aprs) { RS.send({ cmd: 'aprs', on: true }); RS.toast('Decoding packet radio from ' + c.short + '. Messages appear on the Ham page.'); }
    else RS.toast('Listening for ' + c.short + ' on ' + RS.fmt(f.f) + ', following its Doppler shift.');
  };
  RS.act['sp-unfollow'] = () => RS.send({ cmd: 'doppler', on: false });
  function startRec(f, m, label, sat, decode) { RS.send({ cmd: 'job', name: 'record', params: { freq: f, seconds: m * 60, label, sat: sat || '', decode: decode || '' } }); RS.toast('Recording started. The radio is busy until it finishes.'); }
  RS.act['sp-recsat'] = b => { const c = cat(b.dataset.sat), f = c.freqs[+b.dataset.i]; startRec(f.f, 12, c.id, c.id, c.decode); };
  RS.act['sp-rec'] = () => {
    const f = RS.parseFreq($('#sp-rf').value, 'm'), m = parseFloat($('#sp-rm').value), sat = $('#sp-rsat').value, c = cat(sat);
    if (!f) { RS.toast('Type the frequency in MHz, for example 137.9', 'bad'); return; }
    startRec(f, Math.min(Math.max(m || 12, 1), 30), sat || 'manual', sat, c.decode);
  };
  RS.act['sp-recstop'] = () => RS.send({ cmd: 'job', name: 'listen' });
  RS.act['sp-sched'] = b => {
    const p = passes().find(x => key(x) === b.dataset.k), pl = p && plan(p); if (!pl) return;
    const f = pl.c.freqs[pl.fi];
    RS.api('space/schedule', { sat: p.sat, aos: p.aos, los: p.los, freq: f.f, kind: pl.kind, mode: f.mode, bw: f.bw, max_el: p.max_el, label: p.short + ' ' + day(p.aos) + ' ' + hm(p.aos) })
      .then(() => { Sp._fly = { id: key(p) + '-' + pl.kind, el: b, label: p.short + ' ' + hm(p.aos) }; RS.toast('Scheduled: ' + p.short + ' ' + day(p.aos).toLowerCase() + ' at ' + hm(p.aos) + '. Leave Skywave running.'); Sp.load(true); }).catch(e => RS.toast(e.message, 'bad'));
  };
  RS.act['sp-unsched'] = b => RS.api('space/unschedule', { id: b.dataset.id }).then(() => { RS.toast('Recording cancelled.'); Sp.load(true); }).catch(e => RS.toast(e.message, 'bad'));
  RS.act['sp-addsat'] = () => {
    const f = RS.parseFreq($('#sp-cf').value, 'm');
    RS.api('space/custom', { name: $('#sp-cn').value, norad: parseInt($('#sp-cid').value), freq: f, mode: $('#sp-cm').value })
      .then(() => { RS.toast('Added. Downloading its orbit data...'); ['sp-cn', 'sp-cid', 'sp-cf'].forEach(i => { $('#' + i).value = ''; }); })
      .catch(e => RS.toast(e.message, 'bad'));
  };
  RS.act['sp-delsat'] = b => RS.confirm('Remove this satellite?', 'It disappears from the list. You can add it again later.', 'Remove', () => RS.api('space/custom/delete', { id: b.dataset.id }).then(() => Sp.load(true)));
  RS.act['sp-refresh'] = () => RS.api('space/refresh', {}).then(() => RS.toast('Downloading orbit data...')).catch(e => RS.toast(e.message, 'bad'));
  RS.act['sp-sync'] = () => RS.api('space/sync', {}).then(() => RS.toast('Checking the public satellite database. This takes about half a minute.')).catch(e => RS.toast(e.message, 'bad'));
  RS.act['sp-tle'] = () => RS.api('space/tle', { text: $('#sp-tle').value }).then(r => { RS.toast(r.added ? 'Orbit data added.' : 'No usable orbit data found in that text.', r.added ? '' : 'bad'); Sp.load(); }).catch(e => RS.toast(e.message, 'bad'));

  // for Home: the shared reading of a pass
  Sp.quality = quality; Sp.plan = plan; Sp.key = key; Sp.scheduled = scheduled; Sp.dir = dir;
})();
