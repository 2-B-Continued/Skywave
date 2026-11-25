/* Skywave - core: connection, audio, shared helpers, page shell. */
(function () {
  'use strict';
  const RS = window.RS = {
    st: {}, cfg: {}, region: {}, langs: [], prefs: {}, banks: [], favs: [], catalog: [], bandplan: [], peaks: [], sweeps: [], space: {}, samples: [],
    aprs: [], sensors: {}, scanLog: [], connected: false, everConnected: false, sim: false, version: '',
    local: null, handlers: {}, pages: {}, act: {}, live: null, lastError: '', recording: null,
  };
  const $ = RS.$ = (s, r) => (r || document).querySelector(s);
  RS.$$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  RS.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const esc = RS.esc;
  // An Enter press that should act (search, add, save). An Enter that confirms an input-method candidate (Chinese,
  // Japanese, Korean typing) is not one: isComposing covers most browsers, keyCode 229 covers Safari's event order.
  RS.isEnter = e => e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;
  RS.store = {
    get(k, d) { try { const v = localStorage.getItem('rs.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('rs.' + k, JSON.stringify(v)); } catch (e) { } },
  };
  RS.on = (t, fn) => { (RS.handlers[t] = RS.handlers[t] || []).push(fn); };
  RS.fire = (t, d) => { (RS.handlers[t] || []).forEach(f => { try { f(d); } catch (e) { console.error(t, e); } }); };
  // Write HTML only when it differs from what is already there: replacing identical buttons several times a second wastes
  // work, loses hover states and can swallow a tap that lands mid-replace.
  RS.setHTML = (el, html) => { if (el && el._h !== html) { el._h = html; el.innerHTML = html; } return el; };
  RS.icon = (n, cls) => '<svg class="' + (cls || '') + '" aria-hidden="true"><use href="#i-' + n + '"/></svg>';
  RS.hint = (text, id) => '<button type="button" class="hintbtn" data-act="hint" data-id="' + (id || text.length) + '" data-hint="' + esc(text) + '" aria-expanded="false" aria-label="What does this mean?">?</button>';

  // ---------------------------------------------------------------- radio knowledge
  RS.MODES = {
    wfm: { name: 'FM Radio', long: 'FM (music stations)' }, nfm: { name: 'Two-way FM', long: 'Narrow FM (two-way radio)' },
    am: { name: 'AM', long: 'AM (AM radio, aircraft)' }, usb: { name: 'USB', long: 'USB (upper sideband)' },
    lsb: { name: 'LSB', long: 'LSB (lower sideband)' }, cw: { name: 'CW', long: 'CW (morse code)' },
    dsb: { name: 'DSB', long: 'DSB (double sideband, suppressed carrier)', adv: true }, raw: { name: 'RAW', long: 'RAW (unprocessed baseband, I channel)', adv: true },
  };
  RS.TECH = { wfm: 'WFM', nfm: 'NFM', am: 'AM', dsb: 'DSB', usb: 'USB', lsb: 'LSB', cw: 'CW', raw: 'RAW' };
  RS.modeFor = f => {
    for (const b of RS.bandplan) if (f >= b.a && f <= b.b) return b.mode;
    return 'nfm';
  };
  // Short-range channel names for the chosen region (UHF CB, PMR446, FRS/GMRS...). The server sends the list.
  RS.bandName = f => { for (const l of (RS.region.labels || [])) if (Math.abs(l.f - f) <= l.tol) return l.label; for (const b of RS.bandplan) if (f >= b.a && f <= b.b) return b.name; return ''; };
  RS.stepFor = (mode, f) => {
    if (mode === 'wfm') return 100e3;
    if (mode === 'am') return f < 2e6 ? ((RS.region && RS.region.am_step) || 9e3) : (f >= 108e6 ? 25e3 : 5e3);
    if (mode === 'usb' || mode === 'lsb') return 1e3;
    if (mode === 'cw') return 100;
    return 12.5e3;
  };
  RS.snap = (f, mode, step) => {
    step = step || RS.stepFor(mode, f);
    const am0 = (RS.region && RS.region.am && RS.region.am[0]) || 531e3;              // the region's AM raster starts here
    if (mode === 'am' && f < 2e6 && (step === 9e3 || step === 10e3)) return Math.round(am0 + Math.round((f - am0) / step) * step);
    return Math.round(Math.round(f / step) * step);
  };
  RS.freqParts = (f, mode) => {
    if (f >= 1e9) return { n: (f / 1e9).toFixed(4), u: 'GHz' };
    if (f >= 1e6) {
      const m = f / 1e6;
      if (mode === 'wfm') return { n: m.toFixed(1), u: 'MHz' };
      return { n: Math.abs(Math.round(f / 1e3) - f / 1e3) < 1e-6 && Math.round(f) % 1000 === 0 && Math.round(f / 1e3) % 25 !== 12 ? m.toFixed(3) : m.toFixed(4).replace(/0$/, ''), u: 'MHz' };
    }
    return { n: (f / 1e3).toFixed(f % 1e3 ? 1 : 0), u: 'kHz' };
  };
  RS.fmtHtml = (p) => esc(p.n).replace(/[0-9]/g, '<span class="dg">$&</span>').replace('.', '<span class="dp">.</span>') + '<small>' + p.u + '</small>';
  RS.fmt = (f, mode) => { const p = RS.freqParts(f, mode); return p.n + ' ' + p.u; };
  RS.bars = snr => { const t = [2, 6, 12, 20, 30]; let n = 0; for (const x of t) if (snr > x) n++; return n; };
  RS.nameFor = f => {
    for (const x of RS.favs) if (Math.abs(x.f - f) < 5e3 && x.name) return x.name;
    for (const b of RS.banks) for (const c of (b.channels || [])) if (Math.abs(c.f - f) < 5e3 && c.label) return c.label;
    return '';
  };
  RS.isFav = f => RS.favs.some(x => Math.abs(x.f - f) < 5e3);
  RS.toggleFav = (f, mode, name) => {
    const i = RS.favs.findIndex(x => Math.abs(x.f - f) < 5e3);
    let list = RS.favs.slice();
    if (i >= 0) list.splice(i, 1); else list.push({ f: Math.round(f), mode: mode || RS.modeFor(f), name: name || (RS.bandName(f) ? RS.bandName(f) + ' ' : '') + RS.fmt(f, mode) });
    list.sort((a, b) => a.f - b.f);
    RS.favs = list; RS.fire('favourites');
    RS.api('favourites', { list: list }).catch(() => { });
  };

  // ---------------------------------------------------------------- tuning (shared by every page)
  RS.vfo = () => (RS.local && performance.now() - RS.local.t < 1500) ? RS.local.f : (RS.st.vfo || 101.1e6);
  RS.curMode = () => (RS.local && performance.now() - RS.local.t < 1500 && RS.local.mode) ? RS.local.mode : (RS.st.mode || 'wfm');
  RS.autoMode = RS.store.get('automode', true);
  RS.tune = (f, o) => {
    o = o || {};
    f = Math.round(f);
    if (RS.st.scan) RS.send({ cmd: 'scan', action: 'stop' });
    const msg = { cmd: 'tune', freq: f };
    let mode = o.mode;
    if (!mode && RS.autoMode) { const m = RS.modeFor(f); if (m !== RS.curMode()) mode = m; }
    if (mode && mode !== RS.curMode()) msg.mode = mode;
    if (o.bw) msg.bw = o.bw;
    if (o.recenter) msg.recenter = true;
    if (o.keep_doppler) msg.keep_doppler = true;
    if (o.dir) msg.dir = o.dir;
    RS.local = { f: f, t: performance.now(), mode: msg.mode || RS.curMode() };
    RS.send(msg);
    RS.fire('local');
  };
  RS.setMode = (mode, bw) => {
    RS.local = { f: RS.vfo(), t: performance.now(), mode: mode };
    RS.send({ cmd: 'mode', mode: mode, bw: bw });
    RS.fire('local');
  };

  // ---------------------------------------------------------------- connection
  // One WebSocket carries everything but sound (sound has its own, in audio-net.js). It is never trusted to report its own
  // death: a phone that slept, changed network or restored the page from memory can hold a socket that looks open but is dead,
  // or one stuck "connecting" for minutes. So: Skywave must say hello within 5 s of a connection attempt, a ping goes out every
  // 4 s and the server answers it, anything silent for 10 s is replaced, and waking the page, coming back online or reopening it
  // checks the line at once. Retries start after 0.3 s and never wait more than 3 s.
  let ws = null, retryT = 0, backoff = 300, lastRx = 0, hello = false, tick = 0;
  RS.connAttempts = 0;
  RS.send = o => { if (o && RS.audio && RS.audio.onSend) RS.audio.onSend(o.cmd); if (ws && hello && ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch (e) { } return true; } return false; };
  RS.api = async (route, body) => {
    const r = await fetch('/api/' + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = {};
    try { j = await r.json(); } catch (e) { }
    if (!r.ok) throw new Error(j.error || j.message || ('Request failed (' + r.status + ')'));
    return j;
  };
  function lost() { hello = false; if (RS.connected) { RS.connected = false; RS.fire('conn'); } }
  function later(fast) {
    clearTimeout(retryT); RS.fire('conn');
    retryT = setTimeout(connect, fast ? 60 : backoff + Math.random() * 200);
    backoff = Math.min(3000, backoff * 1.6);
  }
  function drop(fast) {
    const s = ws; ws = null;
    if (s) { s.onopen = s.onmessage = s.onclose = s.onerror = null; try { s.close(); } catch (e) { } }
    lost(); later(fast);
  }
  function connect() {
    clearTimeout(retryT);
    if (ws) { const old = ws; ws = null; old.onopen = old.onmessage = old.onclose = old.onerror = null; try { old.close(); } catch (e) { } }
    RS.connAttempts++;
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    let s;
    try { s = new WebSocket(url); } catch (e) { later(); return; }
    ws = s; hello = false; s.binaryType = 'arraybuffer';
    const limit = setTimeout(() => { if (ws === s && !hello) drop(true); }, 5000);
    s.onopen = () => { lastRx = Date.now(); };
    s.onmessage = ev => {
      if (ws !== s) return;
      lastRx = Date.now();
      if (typeof ev.data === 'string') {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'hello') { hello = true; clearTimeout(limit); backoff = 300; RS.connAttempts = 0; }
        if (m.type === 'pong') return;
        onMsg(m);
      } else onBin(ev.data);
    };
    s.onclose = () => { clearTimeout(limit); if (ws === s) { ws = null; lost(); later(); } };
    s.onerror = () => { try { s.close(); } catch (e) { } };
  }
  setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    if (++tick % 4 === 0) { try { ws.send('{"cmd":"ping"}'); } catch (e) { } }
    if (hello && Date.now() - lastRx > 10000) drop(true);                 // went silent: the line is dead even if it looks open
  }, 1000);
  RS.reconnectSoon = () => { if (ws) drop(true); else { backoff = 300; connect(); } };
  // back in front, back online, restored from the back/forward cache: check the line now instead of trusting it
  function check() {
    if (!ws || !hello || Date.now() - lastRx > 4000) { backoff = 300; RS.reconnectSoon(); }
    else { try { ws.send('{"cmd":"ping"}'); } catch (e) { } }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
  window.addEventListener('online', () => { backoff = 300; RS.reconnectSoon(); });
  window.addEventListener('pageshow', e => { if (e.persisted) { backoff = 300; RS.reconnectSoon(); } });
  RS.act.reconnect = () => { backoff = 300; RS.reconnectSoon(); };
  function onBin(buf) {
    const dv = new DataView(buf);
    const t = dv.getUint8(0);
    if (t === 2 || t === 3) return;                       // sound travels on its own socket (sound.js)
    if (t === 1 && buf.byteLength >= 17 + 1024) {
      const fr = { center: dv.getFloat64(1), fs: dv.getUint32(9), floor: dv.getInt16(13) / 10, snr: dv.getInt16(15) / 10, bins: new Uint8Array(buf, 17, 1024), t: performance.now() };
      RS.live = fr;
      RS.fire('spec', fr);
    }
  }
  function onMsg(m) {
    switch (m.type) {
      case 'hello':
        RS.connected = true; RS.everConnected = true;
        RS.version = m.version; RS.cfg = m.config; RS.st = m.state; RS.banks = m.banks; RS.favs = m.favourites || [];
        RS.catalog = m.catalog || []; RS.bandplan = m.bandplan || []; RS.region = m.region || {}; RS.langs = m.langs || []; RS.prefs = m.prefs || {}; RS.lab = m.lab || {}; RS.space = m.space || {}; RS.aprs = m.aprs || [];
        RS.scanLog = m.scan_log || []; RS.decoder = m.decoder || {}; RS.sim = !!m.sim; RS.canStream = !!m.stream; RS.tools = m.tools || {}; RS.samples = m.samples || [];
        RS.timers = m.timers || []; RS._hello_caps = m.captions_log || []; RS.captionStatus = m.captions || {};
        RS.sensors = {}; (m.sensors || []).forEach(s => RS.sensors[s.key] = s);
        if (!RS.peaks.length && m.peaks && m.peaks.length) RS.peaks = m.peaks.map(p => Object.assign({}, p));
        RS.fire('conn'); RS.fire('hello'); RS.fire('state', RS.st); RS.ensureJob(); break;
      case 'state': RS.st = m; RS.fire('state', m); break;
      case 'config': RS.cfg = m.config; RS.fire('config'); break;
      case 'banks': RS.banks = m.banks; RS.fire('banks'); break;
      case 'catalog': RS.catalog = m.catalog || []; RS.fire('catalog'); break;
      case 'lab': RS.lab = m.lab; RS.fire('lab'); break;
      case 'favourites': RS.favs = m.list; RS.fire('favourites'); break;
      case 'aprs': RS.aprs.unshift(m); RS.aprs.length = Math.min(RS.aprs.length, 200); RS.fire('aprs', m); break;
      case 'sensor': RS.sensors[m.key] = m; RS.fire('sensor', m); break;
      case 'scan_end': RS.scanLog.unshift(m); RS.scanLog.length = Math.min(RS.scanLog.length, 100); RS.fire('scan_end', m); break;
      case 'schedule': RS.space.schedule = m.schedule; RS.fire('schedule'); break;
      case 'region': RS.region = m.region; RS.bandplan = m.bandplan || RS.bandplan; RS.fire('region', m); break;
      case 'prefs': RS.prefs = m.prefs || {}; RS.fire('prefs', m); break;
      case 'space_status': RS.space.status = m.status; RS.space.tle_age_days = m.tle_age_days; RS.fire('space_status', m); break;
      case 'notice':
        RS.toast(m.text, m.level === 'error' ? 'bad' : '');
        if (m.level === 'error') RS.lastError = m.text;
        RS.fire('notice', m); break;
      case 'recording': RS.recording = m.on ? m.file : null; RS.fire('recording', m); if (!m.on) RS.toast('Recording saved. Find it in the Library tab.'); break;
      default: RS.fire(m.type, m);
    }
  }

  // ---------------------------------------------------------------- sound: see sound.js (live player) and audio.js (files)
  const A = RS.audio = { on: false, vol: 0.8, level: 0, frames: 0, start() { }, stop() { }, setVol() { } };
  RS.isTouch = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  RS.clientId = Math.random().toString(36).slice(2, 12);

  // ---------------------------------------------------------------- small UI helpers
  // A message you cannot read in full is no use: long ones stay up longer and open in full when tapped
  RS.showFull = (title, text) => RS.modal('<h2>' + esc(title) + '</h2><div class="msg-full">' + esc(text) + '</div><div class="row tight"><button class="btn" data-act="copy-msg">Copy</button><button class="btn primary" data-act="closeModal">Close</button></div>');
  RS.act['copy-msg'] = b => { const t = b.closest('.modal').querySelector('.msg-full').textContent; try { navigator.clipboard.writeText(t); RS.toast('Copied.'); } catch (e) { } };
  RS.toast = (text, cls) => {
    const el = document.createElement('div'); el.className = 'toast ' + (cls || ''); el.textContent = text;
    const long = String(text).length > 90;
    if (long) { el.classList.add('long'); el.title = 'Tap to read the whole message'; el.setAttribute('role', 'button'); el.tabIndex = 0;
      el.addEventListener('click', () => { el.remove(); RS.showFull(cls === 'bad' ? 'Problem' : 'Message', text); }); }
    const box = $('#toasts');
    // the same message twice in a row says nothing new: the newer one replaces the older
    [...box.children].forEach(t => { if (!t._gone && t.textContent === el.textContent) { t._gone = true; t.remove(); } });
    box.appendChild(el);
    // keep three at most. A leaving toast may still be fading out (its remove() animates first), so count only
    // the ones staying, and ask each one to leave once
    const leave = t => { if (t._gone) return; t._gone = true; t.remove(); };
    const stay = [...box.children].filter(t => !t._gone);
    stay.slice(0, Math.max(0, stay.length - 3)).forEach(leave);
    const base = cls === 'bad' ? 9000 : 4500;
    setTimeout(() => leave(el), Math.min(20000, Math.max(base, String(text).length * (cls === 'bad' ? 90 : 60))));
  };
  // Dialogs are native modal <dialog>s: the browser makes the page behind inert, keeps focus inside, draws them above
  // everything and puts focus back on the button that opened them. The <dialog> fills the screen and is its own dimmed
  // backdrop, so the click-outside test is simply "the press landed on the <dialog> itself".
  let modalSeq = 0;
  RS.modal = (html, opts) => {
    RS.closeModal();
    const back = document.createElement('dialog'); back.className = 'modal-back';
    back.innerHTML = '<div class="modal">' + html + '</div>';
    const h = back.querySelector('h1, h2, h3');
    if (h) { if (!h.id) h.id = 'modal-title-' + (++modalSeq); back.setAttribute('aria-labelledby', h.id); }
    back.addEventListener('mousedown', e => { if (e.target === back) RS.closeModal(); });
    back.addEventListener('cancel', e => { e.preventDefault(); RS.closeModal(); });     // Esc / back gesture: close with the usual animation
    $('#modal-root').appendChild(back);
    try { back.showModal(); } catch (e) { back.setAttribute('open', ''); }
    const f = back.querySelector('[autofocus],input,button.primary,button'); if (f) f.focus();
    RS._onclose = opts && opts.onClose;
    return back.firstChild;
  };
  // Take a dialog out of the top layer but keep it drawn, so it can animate away after it has really closed.
  RS.releaseModal = back => { if (back && back.open) { back.classList.add('leaving'); try { back.close(); } catch (e) { back.removeAttribute('open'); } } };
  RS.closeModal = () => { const r = $('#modal-root'); if (r.firstChild) { RS.releaseModal(r.firstChild); r.replaceChildren(); if (RS._onclose) { const f = RS._onclose; RS._onclose = null; f(); } } };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') RS.closeModal(); });
  RS.confirm = (title, text, yes, fn) => {
    const m = RS.modal('<h2>' + esc(title) + '</h2><p>' + esc(text) + '</p><div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" id="cf-yes">' + esc(yes) + '</button></div>');
    m.querySelector('#cf-yes').onclick = () => { RS.closeModal(); fn(); };
  };
  RS.fit = c => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return null;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g: g, w: w, h: h };
  };
  RS.cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  RS.ago = t => { const s = Math.max(0, Date.now() / 1000 - t); if (s < 60) return Math.round(s) + ' s ago'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' d ago'; };
  RS.clock = t => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  RS.dur = s => { s = Math.round(s); return s >= 60 ? Math.floor(s / 60) + ' min ' + (s % 60 ? s % 60 + ' s' : '') : s + ' s'; };
  RS.mb = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' kB';
  RS.deb = (fn, ms) => { let t; return function () { const a = arguments; clearTimeout(t); t = setTimeout(() => fn.apply(null, a), ms); }; };
  RS.throttle = (fn, ms) => { let last = 0, t = null, args; return function () { args = arguments; const now = performance.now(); if (now - last >= ms) { last = now; fn.apply(null, args); } else { clearTimeout(t); t = setTimeout(() => { last = performance.now(); fn.apply(null, args); }, ms - (now - last)); } }; };

  // global click actions ( <button data-act="name"> )
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const fn = RS.act[b.dataset.act];
    if (!fn) return;
    e.preventDefault();
    const r = fn(b, e);
    // work that takes a moment shows a spinner on the button that started it (quick work never flashes one)
    if (r && typeof r.then === 'function' && b.tagName === 'BUTTON') {
      const t = setTimeout(() => { b.classList.add('busy'); b.setAttribute('aria-busy', 'true'); }, 300);
      const done = () => { clearTimeout(t); b.classList.remove('busy'); b.removeAttribute('aria-busy'); };
      r.then(done, done);
    }
  });
  RS.act.closeModal = () => RS.closeModal();
  RS.act.go = b => RS.go(b.dataset.page);
  RS.act.hint = b => {
    const host = b.closest('h3,h4,label,.hh') || b.parentElement;
    const n = host.nextElementSibling;
    if (n && n.classList.contains('hinttext') && n.dataset.for === b.dataset.id) { n.remove(); b.setAttribute('aria-expanded', 'false'); return; }
    if (n && n.classList.contains('hinttext')) n.remove();
    const d = document.createElement('div'); d.className = 'hinttext'; d.dataset.for = b.dataset.id; d.setAttribute('role', 'note'); d.textContent = b.dataset.hint;
    host.after(d); b.setAttribute('aria-expanded', 'true');
  };
  RS.act.reset = () => { RS.send({ cmd: 'reset' }); RS.toast('Restarting the radio...'); };

  // ---------------------------------------------------------------- pages and shell
  const TABS = [
    ['home', 'Home', 'home'], ['radio', 'Radio', 'radio'], ['scanner', 'Scanner', 'scan'], ['planes', 'Planes', 'plane'], ['ships', 'Ships', 'ship'],
    ['space', 'Space', 'space'], ['ham', 'Ham', 'ham'], ['sep'], ['sensors', 'Sensors', 'sensor'], ['sondes', 'Balloons', 'balloon'], ['messages', 'Messages', 'msg'], ['explore', 'Explore', 'explore'],
    ['library', 'Library', 'tape'], ['lab', 'Lab', 'lab'], ['settings', 'Settings', 'gear'],
  ];
  RS.TABS = TABS;
  const NEED = { planes: 'adsb', sensors: 'ism' };
  RS.page = null;
  RS.go = (name, noHash) => {
    if (!RS.pages[name]) name = 'home';
    const old = RS.page;
    if (old && old !== name && RS.pages[old].leave) RS.pages[old].leave();
    RS.page = name;
    RS.$$('.page').forEach(p => p.classList.toggle('on', p.id === 'p-' + name));
    RS.$$('[data-tab]').forEach(t => t.setAttribute('aria-selected', t.dataset.tab === name ? 'true' : 'false'));
    if (!noHash && location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    document.title = (name === 'home' ? '' : TABS.find(t => t[0] === name)[1] + ' - ') + 'Skywave';
    window.scrollTo(0, 0);
    RS.ensureJob();
    if (RS.pages[name].enter) RS.pages[name].enter();
    RS.fire('page', name);
    updateSound();
  };
  RS.ensureJob = () => {
    // pages that need the radio in a particular mode ask for it
    const job = NEED[RS.page] || 'listen';
    if (!RS.connected || !RS.page) return;
    const cur = RS.st.job;
    if (RS.st.air) { if (RS.page !== 'planes') RS.send({ cmd: 'airwatch', on: false }); return; }
    if (cur === 'record' || cur === 'health' || cur === 'calibrate') return;
    if (RS.page === 'home' && cur === 'adsb' && RS.pages.home.keepPlanes) return;      // the Home plane radar asked for this
    if (job === 'listen' && (cur === 'listen' || cur === 'sweep')) return;
    if (cur === job) return;
    if (job === 'ism') RS.send({ cmd: 'job', name: 'ism', params: { freq: RS.sensorFreq || 433.92e6, freqs: RS.sensorFreqs || undefined, tool: RS.sensorTool || 'rtl_433' } });
    else RS.send({ cmd: 'job', name: job });
  };
  function buildNav() {
    const tabs = $('#tabs'); let h = '';
    TABS.forEach(t => {
      if (t[0] === 'sep') { h += '<span class="tab-sep"></span>'; return; }
      h += '<button class="tab' + (['sensors', 'sondes', 'messages', 'explore', 'library', 'settings'].includes(t[0]) ? ' sec' : '') + (t[0] === 'lab' ? ' adv-only' : '') + '" role="tab" data-tab="' + t[0] + '" data-act="go" data-page="' + t[0] + '" title="' + t[1] + '">' + RS.icon(t[2]) + '<span class="t">' + t[1] + '</span></button>';
    });
    tabs.innerHTML = h;
    fitTabs();
    const m = $('#mnav'); h = '';
    [['home', 'Home', 'home'], ['radio', 'Radio', 'radio'], ['scanner', 'Scanner', 'scan'], ['planes', 'Planes', 'plane']].forEach(t => {
      h += '<button role="tab" data-tab="' + t[0] + '" data-act="go" data-page="' + t[0] + '">' + RS.icon(t[2]) + t[1] + '</button>';
    });
    h += '<button data-act="moreMenu">' + RS.icon('more') + 'More</button>';
    m.innerHTML = h;
  }
  // Every tab always shows its icon and its full name. When they don't fit on one line, the bar wraps onto a second
  // line rather than dropping or shrinking any of them. Measured, so the bar stays on one line whenever there is room.
  function fitTabs() {
    const t = $('#tabs'); if (!t || !t.offsetParent) return;
    t.classList.remove('wrap');
    const tabs = t.querySelectorAll('.tab'), first = tabs[0], last = tabs[tabs.length - 1];
    const over = () => t.scrollWidth > t.clientWidth + 1 || t.getBoundingClientRect().right > window.innerWidth + 1 ||
      (first && last && last.offsetTop > first.offsetTop + first.offsetHeight / 2);    // already running onto a second line
    if (over()) t.classList.add('wrap');
    document.documentElement.style.setProperty('--tabs-h', t.offsetHeight + 'px');   // styles that dock the tabs make room for them
  }
  RS.fitTabs = fitTabs;
  let fitT = 0;
  window.addEventListener('resize', () => { clearTimeout(fitT); fitT = setTimeout(fitTabs, 120); });
  setTimeout(() => { RS.on('page', () => requestAnimationFrame(fitTabs)); if (document.fonts) document.fonts.ready.then(fitTabs); }, 0);
  RS.act.moreMenu = () => {
    let h = '<h2>All sections</h2><div class="tile-grid" style="grid-template-columns:1fr 1fr">';
    TABS.forEach(t => { if (t[0] !== 'sep') h += '<button class="tile" style="min-height:90px;padding:12px" data-act="goClose" data-page="' + t[0] + '">' + RS.icon(t[2]) + '<b>' + t[1] + '</b></button>'; });
    RS.modal(h + '</div>');
  };
  RS.act.goClose = b => { RS.closeModal(); RS.go(b.dataset.page); };

  // ---- sound bar
  function updateSound() {
    const st = RS.st, job = st.job;
    const btn = $('#sb-play');
    btn.querySelector('use').setAttribute('href', A.on ? '#i-mute' : '#i-sound');
    // the label span by name: the press ripple adds its own layer as the button's last child, and the label must never
    // be written into that layer
    RS.setText(btn.querySelector(':scope > span:not([aria-hidden])'), A.on ? 'Sound on' : 'Start sound');
    btn.classList.toggle('primary', !A.on);
    const busy = job === 'adsb' || job === 'ism' || job === 'record' || job === 'health' || job === 'sweep';
    let title = 'Ready', sub = A.on ? 'Sound is on.' : 'Sound is off.';
    if (!RS.connected) { title = 'Not connected'; sub = 'Trying to reach Skywave...'; }
    else if (st.error) { title = 'No radio found'; sub = 'See the message at the top of the page.'; }
    else if (st.air) { title = st.air.phase === 'listen' ? 'Air watch: listening' : 'Air watch: tracking planes'; sub = st.air.phase === 'listen' ? RS.fmt(RS.vfo(), 'am') + ' - back to tracking soon' : 'The radio switches to listening in ' + Math.ceil(st.air.left) + ' s.'; }
    else if (job === 'adsb') { title = 'Tracking planes'; sub = 'The radio is busy listening for aircraft, so there is no sound. Go to Radio to listen.'; }
    else if (job === 'ism') { title = 'Reading sensors'; sub = 'The radio is busy listening for sensors, so there is no sound.'; }
    else if (job === 'record') { title = 'Recording a satellite'; sub = 'The radio is busy recording. Sound is off until it finishes.'; }
    else if (job === 'health') { title = 'Checking the radio'; sub = 'This takes about 20 seconds.'; }
    else if (job === 'sweep') { title = 'Looking for stations'; sub = 'Sound is paused while the radio searches.'; }
    else if (st.scan) {
      if (st.scan.state === 'locked' && st.scan.cur) { title = st.scan.cur.label || RS.fmt(st.scan.cur.f); sub = RS.fmt(st.scan.cur.f) + ' - ' + st.scan.name; }
      else { title = 'Scanning'; sub = st.scan.name + ' - waiting for activity'; }
    } else {
      const f = RS.vfo(), m = RS.curMode();
      title = RS.nameFor(f) || RS.fmt(f, m);
      const named = !!RS.nameFor(f);
      sub = (named ? RS.fmt(f, m) + ' - ' : '') + (RS.MODES[m] ? RS.MODES[m].long : m) + (RS.bandName(f) ? ' - ' + RS.bandName(f) : '');
      const rd = m === 'wfm' && st.rds && st.rds.ps ? st.rds : null;
      if (rd) { title = rd.ps.trim(); sub = rd.rt || (rd.pty_name && rd.pty ? rd.pty_name : RS.fmt(f, m)); }
      if (st.doppler) sub += ' - following satellite';
    }
    if (A.on && A.note && RS.connected && !busy) sub = A.note;
    RS.ticker($('#sb-title'), title); RS.ticker($('#sb-sub'), sub);
    const rec = $('#sb-rec'); rec.classList.toggle('rec-on', !!st.rec); rec.querySelector('.rec-lbl').textContent = st.rec ? 'Stop recording' : 'Record';
    rec.disabled = busy && job !== 'listen';
    $('#sb-vol').disabled = false;
  }
  RS.updateSound = updateSound;
  // The level bar: fast to rise, gentle to fall, timed in seconds rather than per screen frame (so a 120 Hz screen
  // does not drain it twice as fast and saw it up and down between level reports). Moved by sliding a full-width bar inside the
  // rounded track (transform only, no layout), and touched only when it moves by half a percent or more.
  let mShown = 0, mLast = 0;
  function meterLoop(t) {
    const dot = $('#sb-dot'), mt = $('#sb-meter');
    const open = RS.st.gate !== false && (RS.st.snr || 0) > 3 && RS.st.job === 'listen';
    if (dot._on !== !!open) { dot._on = !!open; dot.classList.toggle('on', !!open); }
    const dt = Math.min(0.1, Math.max(0, ((t || 0) - mLast) / 1000)); mLast = t || 0;
    A.level *= Math.pow(0.5, dt / 0.15);                                   // the held peak halves every 150 ms
    const want = A.on ? Math.min(1, A.level) : 0;
    mShown += (want - mShown) * (1 - Math.pow(0.5, dt / (want > mShown ? 0.025 : 0.18)));
    const v = Math.round(mShown * 200) / 2;
    if (mt._w !== v) {
      if (mt._w === undefined) { mt.style.width = '100%'; mt.style.willChange = 'transform'; }
      mt._w = v; mt.style.transform = 'translateX(' + (v - 100) + '%)';
    }
    requestAnimationFrame(meterLoop);
  }

  // ---- banners (errors and connection problems at the top of every page)
  function renderBanners() {
    const b = $('#banners'); let h = '';
    if (!RS.connected && (RS.everConnected || performance.now() > 1500)) {
      const n = RS.connAttempts || 0;
      h += '<div class="banner warn"><div class="txt"><strong>' + (RS.everConnected ? 'Lost contact with Skywave' : 'Connecting to Skywave...') + '</strong>' +
        (n >= 3 ? 'Still trying. Check the computer running Skywave is on, and that this device is on the same network (or your VPN is connected).' : 'Reconnecting automatically.') +
        '</div><div class="row tight"><button class="btn" data-act="reconnect">Try again now</button></div></div>';
        } else if (RS.st.error) {
      h += '<div class="banner bad"><div class="txt"><strong>The radio is not responding</strong>' + esc(RS.st.error) +
        '</div><div class="row tight"><button class="btn" data-act="reset">Try again</button><button class="btn" data-act="go" data-page="settings">Help me fix it</button></div></div>';
    } else if (RS.sim) {
      h += '<div class="banner sim slim"><div class="txt"><strong>Practice mode</strong>No radio is connected, so every signal here is simulated.</div></div>';
    }
    if (b.dataset.h !== h) { b.innerHTML = h; b.dataset.h = h; markClamped(); }
  }
  // a banner whose text is cut short (phones show two lines) can be tapped to show all of it
  function markClamped() {
    requestAnimationFrame(() => RS.$$('#banners .banner').forEach(bn => {
      const t = bn.querySelector('.txt'); if (!t || bn.classList.contains('open')) return;
      bn.classList.toggle('clamped', t.scrollHeight > t.clientHeight + 2);
    }));
  }
  $('#banners').addEventListener('click', e => {
    const bn = e.target.closest('.banner'); if (!bn || e.target.closest('button, a')) return;
    if (bn.classList.contains('open')) { bn.classList.remove('open'); markClamped(); return; }
    if (bn.classList.contains('clamped')) { bn.classList.remove('clamped'); bn.classList.add('open'); }
  });
  window.addEventListener('resize', () => { clearTimeout(markClamped._t); markClamped._t = setTimeout(markClamped, 200); });
  RS.on('state', () => { renderBanners(); updateSound(); const p = RS.pages[RS.page]; if (p && p.state) p.state(); });
  RS.on('conn', () => {
    renderBanners(); updateSound();
    const pill = $('#conn-pill'), d = pill.querySelector('.dot'), l = $('#conn-lbl');
    let cls = 'dot', t = 'Connecting';
    if (RS.connected) {
      const s = RS.st.status;
      if (RS.st.error) { cls += ' bad'; t = 'No radio'; }
      else if (RS.sim) { cls += ' warn'; t = 'Practice mode'; }
      else if (s === 'ok') { cls += ' good'; t = 'Radio ready'; }
      else { cls += ' good'; t = 'Ready'; }
    } else { cls += ' warn pulse'; t = RS.everConnected ? 'Reconnecting' : 'Connecting'; }
    d.className = cls; l.textContent = t;
  });
  let connKey = '';
  RS.on('state', () => { const k = [RS.connected, !!RS.st.error, RS.sim, RS.st.status].join(); if (k !== connKey) { connKey = k; RS.fire('conn'); } });
  RS.on('audio', updateSound);
  RS.on('local', updateSound);
  // Highlight whatever matches the tuned frequency, on every page (stations, favourites, quick channels, scanner channels).
  let markQ = 0;
  // Text that scrolls sideways, forever, when it is too long for its box (FM station info, mini player).
  RS.setText = (el, t) => { if (el && el._raw !== t) { el._raw = t; el.textContent = t; } };
  RS.ticker = (el, text) => {
    if (!el) return;
    text = text == null || text === '' ? '\u00a0' : String(text);
    if (el._tk === text) return;
    el._tk = text; el.classList.add('tk'); el.classList.remove('tk-run'); el.textContent = ''; el.removeAttribute('title');
    const track = document.createElement('span'); track.className = 'tk-track';
    const inner = document.createElement('span'); inner.className = 'tk-in'; inner.textContent = text; track.appendChild(inner); el.appendChild(track);
    requestAnimationFrame(() => {
      if (el._tk !== text || inner.scrollWidth <= el.clientWidth + 1) return;
      const part = () => { const g = document.createElement('span'); g.className = 'tk-gap'; g.textContent = '\u2022'; g.setAttribute('aria-hidden', 'true'); const t = inner.cloneNode(true); t.setAttribute('aria-hidden', 'true'); return [g, t]; };
      const a = part(), b = part();
      track.append(a[0], a[1]);                                  // [text][gap][text][gap]: sliding by half is seamless
      track.append(b[0].cloneNode(true));
      el.classList.add('tk-run'); el.title = text;
      track.style.setProperty('--tk-dur', Math.max(8, (inner.scrollWidth + a[0].scrollWidth) / 45).toFixed(1) + 's');
    });
  };
  RS.markCur = () => {
    markQ = 0;
    const f = RS.vfo();
    RS.$$('.station[data-f], .hw-chip[data-f], .chan[data-f]').forEach(el => {
      const on = Math.abs(parseFloat(el.dataset.f) - f) < (el.classList.contains('chan') ? 600 : 5e3);
      el.classList.toggle('cur', on);
      const tgt = el.parentElement && el.parentElement.classList.contains('station') ? el.parentElement : el;
      if (on) tgt.setAttribute('aria-current', 'true'); else tgt.removeAttribute('aria-current');
    });
  };
  const markSoon = () => { if (!markQ) markQ = requestAnimationFrame(RS.markCur); };
  RS.on('local', markSoon); RS.on('state', markSoon); RS.on('page', markSoon);

  RS.setAdvanced = on => {
    document.body.classList.toggle('advanced', !!on);
    $('#mode-easy').setAttribute('aria-pressed', on ? 'false' : 'true');
    $('#mode-adv').setAttribute('aria-pressed', on ? 'true' : 'false');
    RS.store.set('adv', !!on); RS.adv = !!on;
    RS.fire('adv', !!on);
  };
  RS.setTheme = t => {
    if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
    RS.store.set('theme', t || null);
    RS.fire('theme');
  };

  RS.start = () => {
    buildNav();
    $('#mode-easy').onclick = () => RS.setAdvanced(false);
    $('#mode-adv').onclick = () => RS.setAdvanced(true);
    RS.setAdvanced(RS.store.get('adv', false));
    $('#sb-play').onclick = () => { if (A.on) A.stop(); else A.start(); };
    $('#sb-vol').value = A.vol; $('#sb-vol').oninput = e => A.setVol(parseFloat(e.target.value));
    $('#sb-rec').onclick = () => {
      RS.send({ cmd: 'rec_audio', on: !RS.st.rec });
    };
    try { RS.peaks = RS.store.get('peaks', []); } catch (e) { }
    Object.keys(RS.pages).forEach(k => { try { RS.pages[k].init && RS.pages[k].init(); } catch (e) { console.error('init', k, e); } });
    const first = (location.hash || '#home').slice(1);
    RS.go(RS.pages[first] ? first : 'home', true);
    window.addEventListener('hashchange', () => { const n = location.hash.slice(1); if (RS.pages[n] && n !== RS.page) RS.go(n, true); });
    connect(); meterLoop(); RS.fire('conn'); setTimeout(() => RS.fire('conn'), 1600);
  };
})();
