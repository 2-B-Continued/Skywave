/* air.js - Planes page: listen to air traffic while tracking, show which plane is being talked to, alerts */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc, Pl = RS.pages.planes;
  const QUICK = [{ f: 121.5e6, n: 'Emergency guard channel' }, { f: 123.45e6, n: 'Air to air' }];
  const regionAir = () => ((RS.region && RS.region.air) || []).map(x => ({ f: x[0], n: x[1] }));
  const quick = () => regionAir().concat(QUICK.filter(q => !regionAir().some(r => r.f === q.f)));
  let sel = RS.store.get('air_freqs', [121.5e6]), built = false;
  const mhz = f => (f / 1e6).toFixed(3);
  const inAir = f => f >= 118e6 && f <= 137e6;

  function candidates() {
    const out = quick().map(q => ({ f: q.f, n: q.n })), seen = new Set(out.map(o => o.f));
    (RS.favs || []).forEach(x => { if (inAir(x.f) && !seen.has(x.f)) { seen.add(x.f); out.push({ f: x.f, n: x.name || 'Saved' }); } });
    (RS.scanLog || []).forEach(x => { const f = x.f || x.freq; if (f && inAir(f) && !seen.has(f)) { seen.add(f); out.push({ f: f, n: 'Heard recently' }); } });
    sel.forEach(f => { if (!seen.has(f)) { seen.add(f); out.push({ f: f, n: 'Added by you' }); } });
    return out.slice(0, 14);
  }
  function build() {
    const box = $('#pl-air'); if (!box || built) return; built = true;
    box.innerHTML = '<div class="card-head"><div><h3>Listen to air traffic ' + RS.hint('Pilots and controllers talk on separate radio channels, not on the same signal as the plane tracking. One radio can only do one thing at a time, so this switches back and forth: it tracks planes for a short while, then listens to your chosen channel for a short while, and keeps repeating. When someone is talking, a caption appears, and if they say the call sign of a plane on your map (for example "Qantas 431"), that plane lights up as talking. A transmission in progress is never cut off.', 'air-help') + '</h3><div class="sub">Hear the pilots and controllers while you watch the planes.</div></div><button class="btn primary" id="air-go" type="button">Start listening</button></div>' +
      '<div class="air-live" id="air-live"><span id="air-live-t">Not listening. Pick one or more channels and press Start.</span></div>' +
      '<div class="small muted" style="margin-top:8px">Channels to listen to (up to 4, taken in turn):</div><div class="chip-row" id="air-chips"></div>' +
      '<div class="row"><label class="field" style="max-width:220px">Add a channel (MHz)<input id="air-add" inputmode="decimal" placeholder="e.g. 120.5"></label><button class="btn" id="air-addgo" type="button" style="align-self:flex-end">Add</button><label class="check" style="align-self:flex-end"><input type="checkbox" id="air-save"><span>Also save captions as a text file</span></label></div>' +
      '<div class="row adv-only"><label class="field" style="max-width:200px">Track planes for (seconds)<input id="air-ta" type="number" min="10" max="120" value="30"></label><label class="field" style="max-width:200px">Listen for (seconds)<input id="air-tl" type="number" min="8" max="90" value="20"></label></div>' +
      '<div class="row"><label class="check"><input type="checkbox" id="air-near"><span>Tell me when a plane comes within</span></label><select id="air-nearkm"><option value="5">5 km</option><option value="10" selected>10 km</option><option value="20">20 km</option><option value="40">40 km</option></select></div>' +
      '<div class="small muted" style="margin-top:6px">Which local tower or approach channel to use depends on where you live. Use Scanner with the aviation sweep to find the busy ones, then add them here. The radio can tell you what is said, not which plane transmitted, so a plane is only highlighted when its call sign is spoken.</div>' +
      '<div class="air-chat" id="air-chat"></div>';
    $('#air-save').checked = !!RS.store.get('air_save', false);
    $('#air-near').checked = !!RS.store.get('air_near', false); $('#air-nearkm').value = String(RS.store.get('air_nearkm', 10));
    $('#air-near').onchange = e => RS.store.set('air_near', e.target.checked);
    $('#air-nearkm').onchange = e => RS.store.set('air_nearkm', +e.target.value);
    $('#air-save').onchange = e => RS.store.set('air_save', e.target.checked);
    $('#air-addgo').onclick = add; $('#air-add').onkeydown = e => { if (e.key === 'Enter') add(); };
    $('#air-go').onclick = () => {
      if (RS.st.air) { RS.send({ cmd: 'airwatch', on: false }); return; }
      if (!sel.length) { RS.toast('Pick at least one channel first.', 'bad'); return; }
      RS.send({ cmd: 'airwatch', on: true, freqs: sel.slice(0, 4), adsb_s: +$('#air-ta').value || 30, listen_s: +$('#air-tl').value || 20, save: $('#air-save').checked });
    };
    chips(); chat();
  }
  function add() {
    const f = RS.parseFreq($('#air-add').value, 'm');
    if (!f || !inAir(f)) { RS.toast('Aircraft voice is between 118 and 137 MHz, for example 120.5', 'bad'); return; }
    if (!sel.includes(f)) sel.push(f); sel = sel.slice(-4); RS.store.set('air_freqs', sel); $('#air-add').value = ''; chips();
  }
  function chips() {
    const el = $('#air-chips'); if (!el) return;
    // rebuilt only when the list itself changes; otherwise only the pressed state is updated, so the buttons never blink
    // and a tap can never land between two redraws
    const L = candidates(), key = L.map(c => c.f + c.n).join('|');
    if (el._key === key) { el.querySelectorAll('.chip').forEach(b => { const on = String(sel.includes(+b.dataset.f)); if (b.getAttribute('aria-pressed') !== on) b.setAttribute('aria-pressed', on); }); return; }
    el._key = key;
    el.innerHTML = L.map(c => '<button class="chip" type="button" aria-pressed="' + sel.includes(c.f) + '" data-f="' + c.f + '" title="' + esc(c.n) + '">' + mhz(c.f) + ' <span style="font-weight:400">' + esc(c.n) + '</span></button>').join('');
    el.querySelectorAll('.chip').forEach(b => b.onclick = () => {
      const f = +b.dataset.f; if (sel.includes(f)) sel = sel.filter(x => x !== f); else { sel.push(f); if (sel.length > 4) sel.shift(); }
      RS.store.set('air_freqs', sel); chips();
    });
  }
  function chat() {
    const el = $('#air-chat'); if (!el) return;
    const L = (RS.captionLog || []).filter(c => c.f >= 118e6 && c.f <= 137e6).slice(-8).reverse();
    el.innerHTML = L.length ? L.map(c => '<div><time>' + new Date(c.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '</time><span class="muted small">' + mhz(c.f) + '</span> ' + (c.planes || []).map(p => '<span class="who" data-act="pl-pick" data-id="' + p.icao + '">' + esc(p.callsign) + '</span>').join('') + esc(c.text) + '</div>').join('')
      : '<div class="muted small">Radio chatter will appear here as it is heard.</div>';
  }
  Pl.airUi = () => {
    if (!built) build();
    const a = RS.st.air, live = $('#air-live'), btn = $('#air-go'); if (!live) return;
    live.classList.toggle('on', !!a && a.phase === 'listen');
    RS.setText(btn, a ? 'Stop listening' : 'Start listening'); btn.classList.toggle('primary', !a);
    let t = 'Not listening. Pick one or more channels and press Start.';
    if (a) t = a.phase === 'listen' ? 'Listening to ' + mhz(a.freqs[(Math.max(0, (a.freqs.length - 1)))] ) + '' : 'Tracking planes';
    if (a && a.phase === 'listen') { const f = RS.st.vfo; t = 'Listening to ' + mhz(f) + ' MHz now (' + Math.ceil(a.left) + ' s)'; }
    else if (a) t = 'Tracking planes now. Next listening window in ' + Math.ceil(a.left) + ' s.';
    RS.setText($('#air-live-t'), t);
    chips(); chat();
  };
  RS.on('state', () => { if (RS.page === 'planes') Pl.airUi(); });
  RS.on('hello', () => { sel = RS.store.get('air_freqs', [(regionAir()[0] || QUICK[0]).f]); built = false; if (RS.page === 'planes') Pl.airUi(); });
  RS.on('caption', m => {
    (m.planes || []).forEach(p => { Pl.spoke[p.icao] = { t: Date.now(), text: m.text }; });
    if ((m.planes || []).length) { const first = m.planes[0]; RS.toast(first.callsign + ' is talking on the radio'); if (Pl.map) Pl.map.dirty = true; }
    if (RS.page === 'planes') { chat(); Pl.rows(); }
  });

  // alerts: emergencies and planes coming close
  const told = {};
  Pl.alerts = () => {
    const box = $('#pl-alert'); if (!box) return;
    const em = Pl.list.filter(Pl.isEmg);
    const name = { 0: '', 1: 'general emergency', 2: 'medical emergency', 3: 'minimum fuel', 4: 'radio failure', 5: 'unlawful interference', 6: 'downed aircraft' };
    box.innerHTML = em.map(a => '<div class="alert-emg" data-act="pl-pick" data-id="' + a.icao + '" role="alert">Emergency signal from ' + esc(a.callsign || a.icao) + ': ' + esc(name[a.emg] || (a.squawk === '7500' ? 'unlawful interference' : a.squawk === '7600' ? 'radio failure' : 'general emergency')) + (a.squawk ? ' (squawk ' + esc(a.squawk) + ')' : '') + '. Aircraft sometimes send this by mistake, so there is usually no need to worry.</div>').join('');
    em.forEach(a => { if (!told['e' + a.icao]) { told['e' + a.icao] = 1; RS.toast('Emergency code from ' + (a.callsign || a.icao), 'bad'); } });
    if (RS.store.get('air_near', false)) {
      const km = RS.store.get('air_nearkm', 10);
      Pl.list.forEach(a => { if (a.dist_km != null && a.dist_km <= km && (!told['n' + a.icao] || Date.now() - told['n' + a.icao] > 600000)) { told['n' + a.icao] = Date.now(); RS.toast((a.callsign || a.icao) + ' is ' + a.dist_km + ' km away' + (a.alt != null ? ' at ' + Math.round(a.alt).toLocaleString() + ' ft' : '')); } });
    }
  };
})();
