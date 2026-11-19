/* kinetic.js - the interactive half of kinetic.css: ripples where you press, a sliding pill in every segmented control,
   pages that slide in from the direction you are heading, the cover art tilting under the pointer, figures that pop when they
   change, and a scroll progress hairline. All transform / opacity; nothing runs when Motion is Off or the device asks for less. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, root = document.documentElement;
  const mq = q => { try { return matchMedia(q); } catch (e) { return { matches: false }; } };
  const reduce = mq('(prefers-reduced-motion: reduce)');
  const off = () => reduce.matches || root.dataset.motion === 'off';

  // ---------------------------------------------------------------- scroll progress hairline
  const bar = document.createElement('i'); bar.className = 'kx-progress'; bar.setAttribute('aria-hidden', 'true'); document.body.appendChild(bar);

  // ---------------------------------------------------------------- ripples
  const RIP = '.btn, .chip, .tile, .station, .list-opt, .mobile-nav button, .tab, .seg button, .hw-opt, .th-card';
  document.addEventListener('pointerdown', e => {
    if (off() || e.button > 0) return;
    const el = e.target.closest && e.target.closest(RIP); if (!el || el.disabled || el.closest('.kx-seg')) return;
    const r = el.getBoundingClientRect(); if (r.width < 24 || r.height < 18) return;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    let w = el.querySelector(':scope > .kx-rw');
    // the ripple layer goes in FIRST and is removed when the last ripple ends: code that finds a label as the button's
    // last child must never land in it, or a new label would be drawn on top of the old one
    if (!w) { w = document.createElement('span'); w.className = 'kx-rw'; w.setAttribute('aria-hidden', 'true'); el.insertBefore(w, el.firstChild); }
    const s = document.createElement('i'); s.className = 'kx-rip';
    s.style.left = (e.clientX - r.left) + 'px'; s.style.top = (e.clientY - r.top) + 'px';
    s.style.setProperty('--kx-s', Math.ceil(Math.hypot(r.width, r.height) / 5));
    const done = () => { s.remove(); if (w.isConnected && !w.childElementCount) w.remove(); };
    s.addEventListener('animationend', done, { once: true }); setTimeout(done, 900);   // also if the animation never runs
    w.appendChild(s);
  }, { passive: true });

  // ---------------------------------------------------------------- segmented controls: a pill slides to the chosen button
  function pill(seg) {
    const btns = [...seg.children].filter(b => b.tagName === 'BUTTON');
    if (btns.length < 2 || off()) { seg.classList.remove('kx-ready'); const p0 = seg.querySelector(':scope > .kx-pill'); if (p0) p0.remove(); return; }
    const a = btns.find(b => b.getAttribute('aria-pressed') === 'true');
    // only when the buttons sit on one line; a wrapped group keeps its normal look
    const one = btns.every(b => b.offsetTop === btns[0].offsetTop);
    let p = seg.querySelector(':scope > .kx-pill');
    if (!a || !one || !a.offsetWidth) { seg.classList.remove('kx-ready'); if (p) p.style.opacity = '0'; return; }
    if (!p) { p = document.createElement('span'); p.className = 'kx-pill'; p.setAttribute('aria-hidden', 'true'); seg.prepend(p); p.style.transition = 'none'; requestAnimationFrame(() => requestAnimationFrame(() => { p.style.transition = ''; })); }
    seg.classList.add('kx-seg', 'kx-ready');
    p.style.opacity = '1';
    const prev = p._at, to = { x: a.offsetLeft, y: a.offsetTop, w: a.offsetWidth, h: a.offsetHeight }; p._at = to;
    p.style.width = to.w + 'px'; p.style.height = to.h + 'px';
    p.style.translate = to.x + 'px ' + to.y + 'px';
    // moving to another choice: ease in and out, 12% longer half way along (a knob on the move stretches)
    if (prev && (prev.x !== to.x || prev.y !== to.y) && !off() && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const mw = Math.max(prev.w, to.w) * 1.12, cx = (prev.x + prev.w / 2 + to.x + to.w / 2) / 2;
      p.animate([{ translate: prev.x + 'px ' + prev.y + 'px', width: prev.w + 'px' }, { translate: (cx - mw / 2) + 'px ' + ((prev.y + to.y) / 2) + 'px', width: mw + 'px', offset: 0.5 },
        { translate: to.x + 'px ' + to.y + 'px', width: to.w + 'px' }], { duration: 320, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' });
    }
    p.style.borderRadius = getComputedStyle(a).borderTopLeftRadius;
  }
  const watched = new WeakSet();
  function pills(scope) {
    (scope || document).querySelectorAll('.seg, .mode-switch').forEach(seg => {
      if (seg.offsetParent === null) return;
      pill(seg);
      if (watched.has(seg)) return; watched.add(seg);
      new MutationObserver(ms => { if (ms.some(m => m.target !== seg.querySelector(':scope > .kx-pill'))) requestAnimationFrame(() => pill(seg)); })
        .observe(seg, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'], childList: true });
    });
  }
  window.addEventListener('resize', RS.deb ? RS.deb(() => pills(), 150) : () => pills());

  // ---------------------------------------------------------------- pages slide in from the direction you are heading
  let last = null;
  const order = n => { const i = (RS.TABS || []).filter(t => t[0] !== 'sep').findIndex(t => t[0] === n); return i < 0 ? 99 : i; };
  RS.on('page', n => {
    const pg = document.getElementById('p-' + n);
    if (pg && last && last !== n && !off()) {
      pg.classList.remove('kx-fwd', 'kx-back'); void pg.offsetWidth;
      pg.classList.add(order(n) >= order(last) ? 'kx-fwd' : 'kx-back');
      pg.addEventListener('animationend', function done(ev) { if (ev.target !== pg) return; pg.classList.remove('kx-fwd', 'kx-back'); pg.removeEventListener('animationend', done); });
    }
    last = n;
    setTimeout(() => { pills(pg); stats(pg); }, 60);
    setTimeout(() => pills(pg), 600);
  });

  // ---------------------------------------------------------------- the cover leans toward the pointer (desktop, full motion)
  // Follows the pointer frame by frame, but only while it is within 320 px of the cover; further away the cover eases back
  // to flat and the loop stops, so nothing runs while the pointer is elsewhere on the page.
  const R = 320;
  let art = null, tx = 0, ty = 0, cx = 0, cy = 0, loop = 0;
  function frame() {
    loop = 0;
    if (!art || !art.isConnected) { art = null; return; }
    cx += (tx - cx) * 0.22; cy += (ty - cy) * 0.22;
    art.style.transform = 'perspective(900px) rotateX(' + cy.toFixed(2) + 'deg) rotateY(' + cx.toFixed(2) + 'deg)';
    if (Math.abs(tx - cx) > 0.02 || Math.abs(ty - cy) > 0.02) loop = requestAnimationFrame(frame);
    else if (!tx && !ty) { art.style.transform = ''; art.style.transition = ''; art = null; }
  }
  document.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || root.dataset.motion !== 'full') return;
    const a = document.querySelector('.np.on .np-art'); if (!a) return;
    const r = a.getBoundingClientRect(); if (!r.width) return;
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), dist = Math.hypot(dx, dy);
    if (dist > R && !art) return;                                   // far away and already flat: do nothing at all
    art = a; a.style.transition = 'none';
    const k = dist > R ? 0 : 1;
    tx = k * Math.max(-1, Math.min(1, dx / R)) * 14; ty = k * Math.max(-1, Math.min(1, -dy / R)) * 12;
    if (!loop) loop = requestAnimationFrame(frame);
  }, { passive: true });
  document.addEventListener('pointerleave', () => { if (art) { tx = ty = 0; if (!loop) loop = requestAnimationFrame(frame); } }, true);

  // ---------------------------------------------------------------- sound on: some styles let the cover turn while it plays
  RS.on('state', () => { const on = !!(RS.audio && RS.audio.on); if (root.classList.contains('sound-on') !== on) root.classList.toggle('sound-on', on); });

  // ---------------------------------------------------------------- figures that change pop once
  const statSeen = new WeakSet();
  function stats(scope) {
    (scope || document).querySelectorAll('.stat-row').forEach(row => {
      if (statSeen.has(row)) return; statSeen.add(row);
      let prev = [...row.querySelectorAll('b')].map(b => b.textContent);
      new MutationObserver(() => {
        const bs = [...row.querySelectorAll('b')], now = bs.map(b => b.textContent);
        if (!off()) bs.forEach((b, i) => { if (prev[i] !== undefined && prev[i] !== now[i]) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); } });
        prev = now;
      }).observe(row, { childList: true, subtree: true, characterData: true });
    });
  }
  new MutationObserver(() => setTimeout(() => pills(), 160)).observe(root, { attributes: true, attributeFilter: ['data-style', 'data-motion'] });
  setTimeout(() => { pills(); stats(); }, 500);
})();
