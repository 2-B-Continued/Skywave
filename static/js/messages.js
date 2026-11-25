/* Skywave - the Messages page: text sent over the air. Aircraft messages (ACARS) and pagers (POCSAG), decoded live,
   with watch words that raise an alert. Nothing here is written to disk; the server keeps the last few hundred in memory. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc;
  const Ms = RS.pages.messages = {};
  Ms.kind = 'acars'; Ms.list = []; Ms.stopped = false; Ms.tap = {}; Ms.q = ''; Ms.hideNoise = true;
  const tracking = () => RS.st.tap === Ms.kind;
  const IATA = { QF: 'QFA', VA: 'VOZ', JQ: 'JST', ZL: 'RXA', TR: 'TGW', EK: 'UAE', SQ: 'SIA', NZ: 'ANZ', CX: 'CPA', EY: 'ETD', QR: 'QTR', MH: 'MAS',
    TG: 'THA', GA: 'GIA', BA: 'BAW', UA: 'UAL', DL: 'DAL', AA: 'AAL', CA: 'CCA', MU: 'CES', CZ: 'CSN', NH: 'ANA', JL: 'JAL', KE: 'KAL', AI: 'AIC', FJ: 'FJI', FX: 'FDX', '5X': 'UPS' };
  // ACARS gives the flight as the airline's two-letter code; planes broadcast the three-letter one. Turn one into the other.
  Ms.callsign = fl => { const m = /^([A-Z0-9]{2})0*(\d+[A-Z]?)$/.exec(String(fl || '').toUpperCase()); return m && IATA[m[1]] ? IATA[m[1]] + m[2] : ''; };
  const time = t => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const mhz = f => (f / 1e6).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + ' MHz';

  Ms.init = () => {
    $('#p-messages').innerHTML = `
    <div class="page-head"><h2>Messages</h2><p>Some radio traffic is text, not voice. Airliners swap short messages with their airline (ACARS): position reports, arrival times, gate numbers, weather. Pagers still carry messages for some services. Skywave turns both into text as they arrive.</p></div>
    <div class="seg" id="ms-kind" role="group" aria-label="Which messages" style="margin-bottom:14px"><button type="button" data-k="acars" aria-pressed="true">Aircraft</button><button type="button" data-k="pager" aria-pressed="false">Pagers</button></div>
    <div class="banner" id="ms-notice"><div class="txt" id="ms-notice-t"></div></div>
    <div class="card" style="margin-bottom:14px"><div class="row" id="ms-ctl"></div><div class="small muted" id="ms-chans" style="margin-top:8px"></div></div>
    <div class="card"><div class="card-head"><div><h3 id="ms-title">Messages</h3><div class="sub" id="ms-sub">Newest first</div></div>
      <div class="ms-tools"><input id="ms-q" class="ms-search" type="search" placeholder="Filter" aria-label="Filter messages"><label class="check" id="ms-noise-w"><input type="checkbox" id="ms-noise" checked><span>Hide link checks</span></label></div></div>
      <div id="ms-list" class="ms-list" aria-live="polite"></div>
      <div class="empty hide" id="ms-empty"><strong>Nothing yet</strong><span id="ms-empty-t"></span></div></div>
    <div class="two-col" style="margin-top:14px">
      <div class="card"><h3>Watch words ${RS.hint('When a message contains one of these words or numbers (a flight, a registration, a pager address, a word), it is highlighted and you get an alert.')}</h3>
        <div class="chip-row" id="ms-words" style="margin:8px 0"></div>
        <div class="row"><label class="field grow">Add a word or number<input id="ms-word" placeholder="for example BA1 or G-EUPT"></label><button class="btn" data-act="ms-add" type="button">Add</button></div>
        <div class="row" style="margin-top:8px"><button class="btn small ghost" data-act="ms-notify" type="button" id="ms-notify">Alert me on this device</button></div></div>
      <div class="card" id="ms-more"></div>
    </div>`;
    $('#ms-kind').onclick = e => { const b = e.target.closest('button'); if (!b) return; Ms.switch(b.dataset.k); };
    $('#ms-q').oninput = e => { Ms.q = e.target.value.trim().toLowerCase(); Ms.render(); };
    $('#ms-noise').onchange = e => { Ms.hideNoise = e.target.checked; Ms.render(); };
    $('#ms-word').onkeydown = e => { if (RS.isEnter(e)) RS.act['ms-add'](); };
    RS.on('dl_msg', m => { Ms.list.unshift(m); if (Ms.list.length > 400) Ms.list.pop(); if (m.hit && m.hit.length) Ms.alert(m); if (RS.page === 'messages') Ms.render(true); });
    RS.on('dl_history', m => { Ms.list = (m.list || []).slice().reverse(); if (m.tap && m.tap.name === Ms.kind) Ms.tap = m.tap; if (RS.page === 'messages') Ms.render(); });
    RS.on('tap_state', m => { RS.st.tap = m.name; if (m.name === 'acars' || m.name === 'pager') Ms.tap = m; if (RS.page === 'messages') Ms.update(); });
    RS.on('state', () => { if (RS.page === 'messages') { Ms.ctl(); Ms.autostart(); } });
    RS.on('hello', () => { Ms.words(); });
    RS.on('config', () => { Ms.words(); });
  };
  Ms.enter = () => { Ms.stopped = false; Ms.t0 = Date.now(); RS.send({ cmd: 'dl_history' }); Ms.autostart(); Ms.update(); };
  Ms.leave = () => { if (RS.st.tap === 'acars' || RS.st.tap === 'pager') RS.send({ cmd: 'tap' }); };
  Ms.freq = () => Ms.kind === 'pager' ? (RS.cfg.pager_freq || 0) : undefined;
  Ms.autostart = () => {
    const now = Date.now();
    if (RS.page !== 'messages' || !RS.connected || Ms.stopped || tracking() || RS.st.job !== 'listen' || now - (Ms.lastTry || 0) < 3000) return;
    if (Ms.kind === 'pager' && !Ms.freq()) return;              // a pager channel has to be chosen first
    Ms.lastTry = now; RS.send({ cmd: 'tap', name: Ms.kind, freq: Ms.freq() });
  };
  Ms.switch = k => {
    Ms.kind = k; RS.$$('#ms-kind button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.k === k)));
    Ms.stopped = false; Ms.tap = {};
    if (RS.st.tap && RS.st.tap !== k) RS.send({ cmd: 'tap' });
    setTimeout(Ms.autostart, 300); Ms.update();
  };
  Ms.ctl = () => {
    const on = tracking(), el = $('#ms-ctl'); if (!el) return;
    const ck = Ms.kind + on + (RS.cfg.pager_freq || ''); if (el._ck === ck) return; el._ck = ck;   // redraw only on change
    if (Ms.kind === 'acars') {
      el.innerHTML = '<button class="btn primary" data-act="ms-go" type="button">' + (on ? 'Stop' : 'Start listening') + '</button><a class="btn small" href="/api/export/aircraft-messages.csv">Download (CSV)</a>';
    } else {
      const f = RS.cfg.pager_freq ? (RS.cfg.pager_freq / 1e6).toFixed(4) : '';
      el.innerHTML = '<label class="field">Pager channel (MHz)<input id="ms-pf" inputmode="decimal" value="' + f + '" placeholder="for example 148.6375"></label><button class="btn" data-act="ms-pf-use" type="button">Use the Radio frequency</button><button class="btn primary" data-act="ms-go" type="button">' + (on ? 'Stop' : 'Start listening') + '</button>';
    }
  };
  Ms.update = () => {
    const ac = Ms.kind === 'acars';
    $('#ms-notice-t').innerHTML = ac ? '<strong>The radio is used for aircraft messages while you are here</strong>It listens on the usual message channels for your region at once. Planes and aircraft messages need the radio at different frequencies, so they cannot run together on one dongle.'
      : '<strong>Pager messages can be private</strong>They can include names, addresses and medical details. In many countries it is against the law to record pager messages or pass them on. Skywave only shows them here and does not save them.';
    $('#ms-title').textContent = ac ? 'Aircraft messages' : 'Pager messages';
    $('#ms-noise-w').classList.toggle('hide', !ac);
    const t = Ms.tap || {};
    $('#ms-chans').innerHTML = tracking() && t.chans ? 'Listening on ' + t.chans.map(c => mhz(c.f) + (c.hits ? ' <span class="muted">(' + c.hits + ')</span>' : '')).join(', ') + '.' : (Ms.kind === 'pager' && !RS.cfg.pager_freq ? 'Type the pager channel, or tune to it on the Radio page and press Use the Radio frequency.' : 'Not listening.');
    $('#ms-more').innerHTML = ac ? '<h3>Channels</h3><div class="sub">Leave blank for the usual ones in your region. Up to six, within about 2 MHz of each other.</div><div class="row" style="margin-top:10px"><label class="field grow">Frequencies in MHz, separated by commas<input id="ms-af" value="' + esc((RS.cfg.acars_freqs || []).map(f => (f / 1e6).toFixed(3)).join(', ')) + '"></label><button class="btn" data-act="ms-af-save" type="button">Save</button></div>'
      : '<h3>Finding the channel</h3><ul class="tips"><li>Pagers send short, rough-sounding bursts on a fixed channel, usually somewhere between 138 and 175 MHz or 400 and 470 MHz.</li><li>Use the Scanner or Explore to find a channel that bursts often, then come back here.</li><li>512, 1200 and 2400 bit/s pagers are all decoded at once.</li></ul>';
    Ms.ctl(); Ms.render();
  };
  Ms.noise = m => m.kind === 'acars' && (m.label === 'Q0' || m.label === '_d' || m.label === 'SQ') && !m.text;
  Ms.render = flash => {
    const L = Ms.list.filter(m => m.kind === Ms.kind && !(Ms.hideNoise && Ms.noise(m)) && (!Ms.q || JSON.stringify([m.text, m.flight, m.reg, m.addr, m.what]).toLowerCase().includes(Ms.q)));
    const live = (RS.pages.planes.live || RS.pages.planes.list || []);
    $('#ms-list').innerHTML = L.slice(0, 150).map((m, i) => {
      const hit = m.hit && m.hit.length ? ' hit' : '', cls = 'ms-item' + hit + (flash && i === 0 ? ' fresh' : '');
      if (m.kind === 'acars') {
        const cs = Ms.callsign(m.flight), plane = cs && live.find(a => (a.callsign || '').trim() === cs);
        const who = (m.flight ? '<b>' + esc(m.flight) + '</b>' : '') + (m.reg ? ' <span class="mono">' + esc(m.reg) + '</span>' : '') + (RS.airline && cs ? ' <span class="muted">' + esc(RS.airline(cs)) + '</span>' : '');
        return '<div class="' + cls + '"><div class="ms-head"><span class="ms-dir" title="' + (m.dir === 'down' ? 'From the aircraft' : 'To the aircraft') + '">' + (m.dir === 'down' ? '&#8595;' : '&#8593;') + '</span>' + who + '<span class="ms-what">' + esc(m.what || ('Label ' + m.label)) + '</span><span class="ms-time">' + time(m.t) + '</span></div>' +
          (m.text ? '<pre class="ms-text">' + esc(m.text) + '</pre>' : '') + '<div class="tiny muted">' + mhz(m.freq) + (m.checked ? '' : ' &middot; checksum not confirmed') + (plane ? ' &middot; <button class="linkish" data-act="ms-plane" data-id="' + plane.icao + '" type="button">on the plane map</button>' : '') + '</div></div>';
      }
      return '<div class="' + cls + '"><div class="ms-head"><b class="mono">' + esc(String(m.addr)) + '</b><span class="ms-what">' + (m.kind === 'tone' ? 'Alert tone only' : m.kind === 'numeric' ? 'Numbers' : 'Text') + ' &middot; ' + (m.proto || 'POCSAG') + ' ' + m.baud + ' bit/s</span><span class="ms-time">' + time(m.t) + '</span></div>' + (m.text ? '<pre class="ms-text">' + esc(m.text) + '</pre>' : '') + '</div>';
    }).join('');
    $('#ms-empty').classList.toggle('hide', L.length > 0);
    $('#ms-empty-t').textContent = !tracking() ? (Ms.kind === 'pager' && !RS.cfg.pager_freq ? 'Choose a pager channel to start.' : 'Listening is stopped.') :
      Ms.kind === 'acars' ? (Date.now() - (Ms.t0 || 0) > 120000 ? 'Quiet so far. Messages come in bursts as aircraft pass; an airband antenna and a high spot help a lot.' : 'Listening. Messages arrive in short bursts as aircraft pass.') : 'Listening for pages on ' + mhz(RS.cfg.pager_freq) + '.';
    $('#ms-sub').textContent = L.length ? L.length + ' message' + (L.length === 1 ? '' : 's') + ', newest first' : '';
  };
  Ms.words = () => {
    const w = RS.cfg.watch_words || [], el = $('#ms-words'); if (!el) return;
    el.innerHTML = w.length ? w.map(x => '<span class="chip">' + esc(x) + ' <button type="button" class="chip-x" data-act="ms-del" data-w="' + esc(x) + '" aria-label="Remove ' + esc(x) + '">&times;</button></span>').join('') : '<span class="muted small">No watch words yet.</span>';
    const nb = $('#ms-notify'); if (nb) nb.classList.toggle('hide', !('Notification' in window) || Notification.permission === 'granted');
  };
  const saveWords = w => RS.api('config', { changes: { watch_words: w } }).then(r => { if (r && r.config) { RS.cfg = r.config; Ms.words(); } });
  RS.act['ms-add'] = () => { const v = ($('#ms-word').value || '').trim(); if (!v) return; const w = (RS.cfg.watch_words || []).filter(x => x.toLowerCase() !== v.toLowerCase()).concat([v]); $('#ms-word').value = ''; saveWords(w); };
  RS.act['ms-del'] = b => saveWords((RS.cfg.watch_words || []).filter(x => x !== b.dataset.w));
  RS.act['ms-notify'] = () => { if ('Notification' in window) Notification.requestPermission().then(() => Ms.words()); };
  RS.act['ms-go'] = () => {
    if (tracking()) { Ms.stopped = true; RS.send({ cmd: 'tap' }); return; }
    Ms.stopped = false;
    if (Ms.kind === 'pager') {
      const f = parseFloat((($('#ms-pf') || {}).value || '').replace(',', '.')) * 1e6;
      if (!(f > 25e6 && f < 1.7e9)) { RS.toast('Type the pager channel in MHz first, for example 148.6375.', 'bad'); return; }
      RS.cfg.pager_freq = f; RS.send({ cmd: 'tap', name: 'pager', freq: f }); return;
    }
    RS.send({ cmd: 'tap', name: 'acars' });
  };
  RS.act['ms-pf-use'] = () => { const f = RS.st.vfo; if (f) { $('#ms-pf').value = (f / 1e6).toFixed(4); } };
  RS.act['ms-af-save'] = () => {
    const v = ($('#ms-af').value || '').split(/[ ,;]+/).map(x => parseFloat(x)).filter(x => x > 118 && x < 138).map(x => Math.round(x * 1e6));
    RS.api('config', { changes: { acars_freqs: v } }).then(r => { if (r && r.config) RS.cfg = r.config; RS.toast(v.length ? 'Saved. Restarting on the new channels.' : 'Back to the usual channels for your region.'); if (tracking()) RS.send({ cmd: 'tap', name: 'acars' }); Ms.update(); });
  };
  RS.act['ms-plane'] = b => { const pl = RS.pages.planes; pl.sel = b.dataset.id; RS.go('planes'); };
  // An alert for a watch word: a toast here, and a system notification when this device allows it.
  Ms.alert = m => {
    const what = m.kind === 'acars' ? (m.flight || m.reg || 'Aircraft') + ': ' + (m.text || m.what || '') : 'Pager ' + m.addr + ': ' + (m.text || '');
    RS.toast('Watch word "' + m.hit[0] + '" - ' + what.slice(0, 120), 'warn');
    RS.notify && RS.notify('Watch word: ' + m.hit[0], what.slice(0, 200));
  };
  RS.notify = (title, body) => {
    try { if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') new Notification(title, { body, icon: '/img/skywave-192.png', tag: 'skywave-' + title }); } catch (e) { /* some browsers only allow this from a service worker */ }
  };
})();
