/* art.js - cover art for the song an FM station says is playing.
   FM only sends text, so the picture is looked up from the RadioText ("Artist - Title") by the Skywave server. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc;
  const A = RS.art = { cur: null, song: null, rt: '', f: 0, t: null };   // cur: the song with its cover; song: the song, cover or not
  const on = () => !(RS.prefs && RS.prefs.art_off);
  // the cover's own colour, so the player and the dial light up in it (only when the image server allows it to be read)
  function tint(url) {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 12; const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, 12, 12); const d = x.getImageData(0, 0, 12, 12).data;
        let best = null, bs = -1, r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const R = d[i], G = d[i + 1], B = d[i + 2], mx = Math.max(R, G, B), mn = Math.min(R, G, B), sat = mx ? (mx - mn) / mx : 0, v = mx / 255;
          r += R; g += G; b += B; n++;
          const score = sat * (0.35 + v) * (v > 0.18 && v < 0.97 ? 1 : 0.2);
          if (score > bs) { bs = score; best = [R, G, B]; }
        }
        const c1 = bs > 0.12 ? best : [r / n, g / n, b / n].map(Math.round);
        if (!A.cur || A.cur.url !== url) return;
        document.documentElement.style.setProperty('--art-c', 'rgb(' + c1.join(' ') + ')');
        document.documentElement.classList.add('art-tinted');
      } catch (e) { document.documentElement.classList.remove('art-tinted'); }
    };
    img.onerror = () => document.documentElement.classList.remove('art-tinted');
    img.src = url;
  }
  function paint() {
    const c = A.cur, root = document.documentElement;
    [['#rd-art', 'art-radio'], ['#sb-art', 'art-bar'], ['#ho-art', 'art-home']].forEach(([sel]) => {
      const el = $(sel); if (!el) return;
      if (c) {
        if (el.getAttribute('src') !== c.url) {
          // a new cover arrives: it resolves out of a blur instead of popping in
          el.classList.remove('art-in'); el.setAttribute('src', c.url);
          const go = () => { void el.offsetWidth; el.classList.add('art-in'); };
          if (el.complete) go(); else el.addEventListener('load', go, { once: true });
        }
        el.alt = 'Cover art: ' + c.title + ' by ' + c.artist;
        el.title = c.title + (c.artist ? ' - ' + c.artist : '') + (c.album ? ' (' + c.album + ')' : '');
        el.classList.remove('hide');
      } else { el.classList.add('hide'); el.classList.remove('art-in'); el.removeAttribute('src'); }
    });
    const set = (id, t) => { const e = $(id); if (e) e.textContent = t || ''; };
    set('#rd-np-t', c ? c.title : ''); set('#rd-np-a', c ? c.artist : ''); set('#rd-np-al', c ? c.album : '');
    ['#rd-np', '#ho-np'].forEach(id => { const e = $(id); if (e) e.classList.toggle('on', !!c); });
    const dl = $('#rd-stage'); if (dl) { if (c) dl.style.setProperty('--art-url', 'url("' + c.url.replace(/"/g, '%22') + '")'); else dl.style.removeProperty('--art-url'); dl.classList.toggle('has-art', !!c); }
    if (c) root.style.setProperty('--art-url', 'url("' + c.url.replace(/"/g, '%22') + '")'); else { root.style.removeProperty('--art-url'); root.style.removeProperty('--art-c'); root.classList.remove('art-tinted'); }
    document.body.classList.toggle('has-art', !!c); root.classList.toggle('has-art', !!c);
    if (c) tint(c.url);
    RS.fire('art');
  }
  A.paint = paint;
  function clear() { clearTimeout(A.t); A.song = null; if (A.cur) { A.cur = null; paint(); } }
  function check() {
    const st = RS.st || {}, rd = st.rds, m = RS.curMode && RS.curMode();
    // with cover art turned off, the song is still read from the text (here, on the Skywave computer) for the songs list
    const rt = (m === 'wfm' && st.job === 'listen' && rd && rd.rt) ? String(rd.rt).trim() : '';
    const f = Math.round((RS.vfo ? RS.vfo() : 0) / 1e4);
    if (!rt || f !== A.f) {
      // RadioText can drop out for a moment on a weak station; keep the picture through that, but not through a retune
      if (f !== A.f) { clearTimeout(A.gone); A.gone = null; A.rt = ''; A.f = f; clear(); return; }
      if (A.rt && !A.gone) A.gone = setTimeout(() => { A.gone = null; A.rt = ''; clear(); }, 4000);
      return;
    }
    clearTimeout(A.gone); A.gone = null;
    if (rt === A.rt) return;
    A.rt = rt; A.f = f; clear();
    A.t = setTimeout(async () => {                                 // RadioText is settled once it has stopped changing for a moment
      try {
        const r = await RS.api('art?q=' + encodeURIComponent(rt) + '&cc=' + ccHint() + (on() ? '' : '&parse=1'));
        if (A.rt !== rt) return;
        if (r.art && on()) { A.cur = A.song = { url: r.art, artist: r.artist, title: r.title, album: r.album, rt, track: r.track || null }; paint(); }
        else if (r.title && r.artist) { A.song = { url: '', artist: r.artist, title: r.title, album: '', rt, track: null }; RS.fire('art'); }
      } catch (e) { }
    }, 1200);
  }
  // ---------------------------------------------------------------- "Open in": press the cover to play the song elsewhere
  function ccHint() { const m = /[-_]([A-Za-z]{2})\b/.exec(navigator.language || ''); return m ? m[1].toUpperCase() : ''; }
  const regionName = cc => { try { return new Intl.DisplayNames([document.documentElement.lang || 'en'], { type: 'region' }).of(cc); } catch (e) { return cc; } };
  const canOpen = () => !!(A.cur && (A.cur.track || (A.cur.artist && A.cur.title)));
  // each row: the service's own icon (fetched by the Skywave server from the service's site), its initial if that fails
  function rowsHtml(L) {
    return L.map(x => '<a class="ol-row" href="' + RS.esc(x.url) + '" target="_blank" rel="noopener noreferrer"><span class="ol-ic" data-l="' + RS.esc(x.name.charAt(0)) + '">' +
      '<img src="/api/svcicon/' + encodeURIComponent(x.service) + '" alt="" width="28" height="28" loading="lazy" decoding="async"></span><span class="ol-n">' + RS.esc(x.name) + '</span>' + (x.kind === 'search' ? '<span class="ol-k">Search</span>' : '') + RS.icon('right') + '</a>').join('');
  }
  // any song can be opened: the one playing (default) or one from the Radio page's song history
  async function openIn(song) {
    const c = song && song.title ? song : A.cur;
    A._last = c;
    if (!c || !(c.track || (c.artist && c.title))) return;
    const dlg = RS.modal('<div class="ol"><div class="ol-head"><img class="ol-art" src="' + RS.esc(c.url) + '" alt="" width="64" height="64"><div class="ol-t"><b>' + RS.esc(c.title) + '</b><span>' + RS.esc(c.artist) + '</span>' + (c.album ? '<small>' + RS.esc(c.album) + '</small>' : '') + '</div></div>' +
      '<div class="ol-lbl">Open in</div><div class="ol-list" id="ol-list" aria-busy="true">' + '<i class="ol-sk"></i>'.repeat(4) + '</div><p class="ol-note" id="ol-note">&nbsp;</p></div>');
    if (dlg) { dlg.classList.add('ol-modal'); dlg.setAttribute('aria-label', 'Open ' + c.title + ' in'); }
    let r = null;
    try { r = await RS.api('artlinks?track=' + encodeURIComponent(c.track || '') + '&artist=' + encodeURIComponent(c.artist || '') + '&title=' + encodeURIComponent(c.title || '') + '&cc=' + ccHint()); } catch (e) { r = null; }
    const list = $('#ol-list'), note = $('#ol-note'); if (!list) return;
    list.removeAttribute('aria-busy');
    if (!r || !r.ok) { list.innerHTML = '<div class="ol-empty">Couldn\'t find links for this song just now. Check the internet connection of the computer running Skywave, then try again.</div><button class="btn small" type="button" data-act="art-open">Try again</button>'; note.textContent = ''; return; }
    const where = r.country ? regionName(r.country) : '';
    if (!r.links.length) { list.innerHTML = '<div class="ol-empty">This song isn\'t on the big streaming services' + (where ? ' in ' + RS.esc(where) : '') + '.</div>'; note.textContent = ''; return; }
    list.innerHTML = rowsHtml(r.links);
    list.querySelectorAll('.ol-ic img').forEach(im => { const gone = () => im.remove(); im.addEventListener('error', gone, { once: true }); if (im.complete && !im.naturalWidth) gone(); });
    const exact = r.links.filter(x => x.kind === 'song').map(x => x.name), srch = r.links.some(x => x.kind === 'search');
    note.textContent = (exact.length ? exact.join(' and ') + (exact.length > 1 ? ' open' : ' opens') + ' the song itself' + (where ? ', checked for ' + where : '') + '. ' : '') + (srch ? (exact.length ? 'The others search for it' : 'These search for the song') + (where ? ' on services available in ' + where : '') + '.' : '');
  }
  A.openIn = openIn;
  RS.act['art-open'] = () => openIn(A._last || null);
  document.addEventListener('click', e => { const t = e.target.closest && e.target.closest('#rd-np .np-art, #ho-np .np-art'); if (t && canOpen()) openIn(); });
  document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('#rd-np .np-art, #ho-np .np-art') && canOpen()) { e.preventDefault(); openIn(); } });
  RS.on('art', () => RS.$$('#rd-np .np-art, #ho-np .np-art').forEach(el => {
    if (canOpen()) { el.setAttribute('role', 'button'); el.tabIndex = 0; el.setAttribute('aria-label', 'Open ' + A.cur.title + ' in a music app'); el.classList.add('ol-can'); }
    else { el.removeAttribute('role'); el.removeAttribute('tabindex'); el.removeAttribute('aria-label'); el.classList.remove('ol-can'); }
  }));
  RS.on('state', check);
  RS.on('page', () => setTimeout(paint, 30));
  RS.on('prefs-applied', () => { if (!on()) clear(); else check(); });
  RS.mountArt = el => {
    if (!el) return;
    el.innerHTML = '<h3>Album art</h3><div class="sub">FM stations send only text, not pictures. When a station says what song is playing, Skywave looks up the cover art and shows it on the Radio page, in the bottom bar and on your lock screen.</div>' +
      '<label class="check"><input type="checkbox" id="st-art-on"' + (on() ? ' checked' : '') + '><span>Look up cover art for songs</span></label>' +
      '<div class="small muted" style="margin-top:6px">This sends only the song text (for example "Artist - Title") to Apple\'s public music search, from the computer running Skywave; when Apple has nothing, Deezer and then MusicBrainz with the Cover Art Archive are asked instead. Your country is sent as two letters (for example AU), so the songs and links match what is available where you are; nothing else about you is sent. Pressing a cover looks the song up on Apple Music and Deezer to link to it. Turn it off if you prefer nothing leaves your network.</div>';
    $('#st-art-on').onchange = e => { RS.setPref('art_off', !e.target.checked); if (!e.target.checked) clear(); else check(); };
  };
})();
