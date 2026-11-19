/* audio.js - library file player (global, survives page changes), single-source rule and lock-screen controls. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc, A = RS.audio;

  // ---------------------------------------------------------------- the file player
  const P = RS.player = { el: null, cur: null, ui: null };
  const mmss = t => { if (!isFinite(t) || t < 0) return '0:00'; t = Math.floor(t); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
  const niceName = n => n.replace(/_iq\.wav$|\.wav$|\.mp3$/, '').replace(/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)_/, '$1-$2-$3 $4:$5 - ').replace(/_/g, ' ');
  P.nice = niceName;
  P.playing = () => !!(P.el && P.cur && !P.el.paused && !P.el.ended);

  function build() {
    if (P.ui) return;
    const el = P.el = document.createElement('audio');
    el.id = 'rs-file'; el.preload = 'metadata'; el.setAttribute('playsinline', '');
    document.body.appendChild(el);
    const ui = P.ui = document.createElement('div');
    ui.id = 'fileplayer'; ui.className = 'fileplayer'; ui.hidden = true; ui.setAttribute('role', 'region'); ui.setAttribute('aria-label', 'Recording player');
    ui.innerHTML = '<button class="btn primary" id="fp-play" type="button" aria-label="Play or pause">' + RS.icon('play') + '</button>' +
      '<div class="now"><b id="fp-title"></b><span id="fp-time">0:00</span></div>' +
      '<input id="fp-seek" type="range" min="0" max="1000" value="0" aria-label="Position">' +
      '<button class="btn ghost" id="fp-close" type="button" aria-label="Close player" title="Close player">' + RS.icon('stop') + '</button>';
    const bar = $('#soundbar'); bar.parentNode.insertBefore(ui, bar);
    $('#fp-play').onclick = () => P.toggle();
    $('#fp-close').onclick = () => P.stop();
    let drag = false;
    const seek = $('#fp-seek');
    seek.addEventListener('input', () => { drag = true; if (el.duration) $('#fp-time').textContent = mmss(seek.value / 1000 * el.duration) + ' / ' + mmss(el.duration); });
    seek.addEventListener('change', () => { drag = false; if (el.duration) el.currentTime = seek.value / 1000 * el.duration; });
    el.addEventListener('timeupdate', () => {
      if (!drag && el.duration) { seek.value = Math.round(el.currentTime / el.duration * 1000); $('#fp-time').textContent = mmss(el.currentTime) + ' / ' + mmss(el.duration); }
      pos();
    });
    ['play', 'pause', 'ended'].forEach(ev => el.addEventListener(ev, () => { sync(); RS.fire('player'); }));
    el.addEventListener('error', () => { if (P.cur) { RS.toast('That recording could not be played.', 'bad'); P.stop(); } });
    el.volume = A.vol;
  }
  function sync() {
    if (!P.ui) return;
    const on = !!P.cur;
    P.ui.hidden = !on;
    document.body.classList.toggle('fp-on', on);
    if (!on) return;
    RS.ticker($('#fp-title'), P.cur.title || niceName(P.cur.name));
    $('#fp-play').innerHTML = RS.icon(P.playing() ? 'pause' : 'play');
    P.ui.classList.toggle('is-playing', P.playing());
    // sit just above the sound bar wherever this style puts it (full-width at the bottom, floating, or at the top)
    const sb = $('#soundbar'), r = sb.getBoundingClientRect();
    P.ui.style.bottom = (window.innerWidth > 760 ? (r.height && r.top > innerHeight / 2 ? Math.round(innerHeight - r.top + (r.bottom < innerHeight - 2 ? 10 : 0)) : 0) : 0) + 'px';
    meta();
  }
  P.play = f => {
    build();
    if (A.on) A.stop();                                        // a recording and the live radio never play together
    const url = '/rec/' + encodeURIComponent(f.name);
    if (!P.cur || P.cur.name !== f.name || P.el.ended) { P.el.pause(); P.el.src = url; }
    P.cur = { name: f.name, title: f.title };
    const pr = P.el.play(); if (pr && pr.catch) pr.catch(() => { });
    sync(); RS.fire('player');
  };
  P.toggle = () => { if (!P.cur) return; if (P.playing()) P.el.pause(); else { if (A.on) A.stop(); const pr = P.el.play(); if (pr && pr.catch) pr.catch(() => { }); } sync(); };
  P.stop = () => {
    if (!P.el || !P.cur) return;
    P.cur = null;
    try { P.el.pause(); P.el.removeAttribute('src'); P.el.load(); } catch (e) { }
    sync(); RS.fire('player');
  };
  P.isCur = name => !!(P.cur && P.cur.name === name);

  // ---------------------------------------------------------------- lock screen / headset controls
  const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
  // The picture on the phone's lock screen and in the notification shade. Without this the phone falls back to a tiny blurry icon.
  const ART = [{ src: '/img/skywave-1024.png', sizes: '1024x1024', type: 'image/png' }, { src: '/img/skywave-512.png', sizes: '512x512', type: 'image/png' }, { src: '/img/skywave-192.png', sizes: '192x192', type: 'image/png' }];
  // Setting the metadata again makes the phone reload the picture, which shows as flicker on the lock screen and in the
  // Dynamic Island. So it is only set when the text actually changes, and the playback state only when that changes.
  let lastMeta = '', lastState = '';
  function meta() {
    if (!ms || typeof MediaMetadata === 'undefined') return;
    try {
      let t = null;
      if (P.cur) t = [P.cur.title || niceName(P.cur.name), 'Skywave recording', 'Library'];
      else if (A.on) t = [($('#sb-title') || {})._tk || 'Radio', ($('#sb-sub') || {})._tk || '', 'Skywave'];
      const art = (RS.art && RS.art.cur && !P.cur) ? RS.art.cur : null;
      const sig = t ? t.join('\u0001') + (art ? '\u0001' + art.url : '') : '';
      if (t && sig !== lastMeta) { ms.metadata = new MediaMetadata({ title: t[0], artist: t[1], album: t[2], artwork: art ? [{ src: art.url, sizes: '600x600', type: 'image/jpeg' }].concat(ART) : ART }); }
      lastMeta = sig;
      const st = P.cur ? (P.playing() ? 'playing' : 'paused') : (A.on ? 'playing' : 'none');
      if (st !== lastState) { ms.playbackState = st; lastState = st; }
    } catch (e) { }
  }
  function pos() {
    if (!ms || !ms.setPositionState || !P.cur || !P.el || !isFinite(P.el.duration) || !P.el.duration) return;
    try { ms.setPositionState({ duration: P.el.duration, position: Math.min(P.el.currentTime, P.el.duration), playbackRate: 1 }); } catch (e) { }
  }
  if (ms) {
    const h = (n, f) => { try { ms.setActionHandler(n, f); } catch (e) { } };
    h('play', () => { if (P.cur) P.toggle(); else A.start(); });
    h('pause', () => { if (P.cur) P.el.pause(); else A.stop(); });
    h('stop', () => { if (P.cur) P.stop(); else A.stop(); });
    h('seekto', d => { if (P.cur && P.el && d && d.seekTime != null) P.el.currentTime = d.seekTime; });
    h('seekbackward', () => { if (P.cur) P.el.currentTime = Math.max(0, P.el.currentTime - 15); });
    h('seekforward', () => { if (P.cur) P.el.currentTime = Math.min(P.el.duration || 1e9, P.el.currentTime + 30); });
  }
  RS.on('audio', () => { if (P.cur && A.on) P.stop(); meta(); });
  RS.on('art', () => { if (A.on && !P.cur) meta(); });
  RS.on('state', () => { if (A.on && !P.cur) meta(); });
  const vol = A.setVol; A.setVol = v => { vol(v); if (P.el) P.el.volume = v; };
})();
