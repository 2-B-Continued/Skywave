/* sheet.js - cards that slide up from the bottom and can be pulled back down.

   1. The player card. Press the mini player (the sound bar, or the recording player) and the page the sound comes from slides
      up as a card over the page you are on: the Radio page for the radio, Scanner while scanning, Library for a recording.
      It is the real page, live and fully usable. Pull it down by its handle, or from anywhere once it is scrolled to the top,
      press the chevron, press the dimmed page behind, press Escape or use the phone's back gesture to put it away. You land
      back where you were, scrolled where you were. Swiping up on the mini player opens it too.
   2. Every dialog (More, confirmations, pickers) on a phone is a bottom card: it can now be pulled down to close, and
      closing slides it away instead of vanishing.

   Pulling follows the finger 1:1, resists upward pulls (rubber band), and on release closes if pulled past about a quarter of
   its height or flicked down; otherwise it springs back. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, root = document.documentElement;
  const still = () => root.dataset.motion === 'off' || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const EASE = 'cubic-bezier(.32,.72,0,1)';           // the drawer curve

  // ---------------------------------------------------------------- pull-to-dismiss, for any bottom card
  RS.sheetDrag = (panel, o) => {
    let y0 = 0, x0 = 0, dy = 0, lastY = 0, lastT = 0, vel = 0, drag = false, decided = false, fromHandle = false, active = false;
    const scroller = () => (o.scroller ? o.scroller() : panel);
    const set = y => { panel.style.transform = y ? 'translate3d(0,' + y + 'px,0)' : ''; if (o.onMove) o.onMove(y, panel.offsetHeight); };
    const inHandle = (t, y) => !!(t && t.closest && t.closest(o.handle || '.sheet-grab')) || (o.handleZone && y - panel.getBoundingClientRect().top < o.handleZone);
    const blocked = t => !!(t && t.closest && t.closest('input[type=range], canvas, .map, textarea, select, [data-nodrag]'));
    function start(y, x, t) { active = true; y0 = lastY = y; x0 = x; lastT = performance.now(); dy = 0; vel = 0; drag = false; decided = false; fromHandle = inHandle(t, y); }
    function move(y, x, e) {
      if (!active) return;
      const d = y - y0;
      if (!decided) {
        if (Math.abs(d) < 6 && Math.abs(x - x0) < 6) return;
        decided = true;
        drag = Math.abs(d) > Math.abs(x - x0) && (d > 0 ? (fromHandle || (scroller().scrollTop <= 0 && !blocked(e.target))) : fromHandle);   // pulled up by the handle: it rubber-bands
        if (drag) panel.style.transition = 'none';
      }
      if (!drag) return;
      if (e.cancelable) e.preventDefault();
      dy = d > 0 ? d : d * 0.2;                                 // past the top: a fifth of the pull
      const now = performance.now(); vel = (y - lastY) / Math.max(1, now - lastT); lastY = y; lastT = now;
      set(dy);
    }
    function end() {
      if (!active) return; active = false;
      if (!drag) return; drag = false;
      const h = panel.offsetHeight;
      if (dy > h * 0.26 || (vel > 0.55 && dy > 24)) { o.onDismiss(vel); return; }
      panel.style.transition = 'transform .34s ' + EASE; set(0);
      setTimeout(() => { panel.style.transition = ''; }, 360);
    }
    panel.addEventListener('touchstart', e => { if (e.touches.length === 1) start(e.touches[0].clientY, e.touches[0].clientX, e.target); }, { passive: true });
    panel.addEventListener('touchmove', e => { if (e.touches.length === 1) move(e.touches[0].clientY, e.touches[0].clientX, e); }, { passive: false });
    panel.addEventListener('touchend', end); panel.addEventListener('touchcancel', end);
    panel.addEventListener('pointerdown', e => {               // a mouse can pull by the handle
      if (e.pointerType !== 'mouse' || !inHandle(e.target, e.clientY)) return;
      start(e.clientY, e.clientX, e.target);
      const mv = ev => move(ev.clientY, ev.clientX, ev), up = () => { end(); removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
  };
  // slide a card away (carrying the flick's speed), fade its backdrop, then finish
  RS.sheetAway = (panel, back, done, vel) => {
    if (still()) { done(); return; }
    const h = panel.offsetHeight, dur = Math.max(0.16, Math.min(0.42, 0.42 - (vel || 0) * 0.12));
    panel.style.transition = 'transform ' + dur + 's ' + EASE;
    panel.style.transform = 'translate3d(0,' + (h + 40) + 'px,0)';
    if (back) { back.style.transition = 'opacity ' + dur + 's ease'; back.style.opacity = '0'; }
    let fin = false; const f = () => { if (!fin) { fin = true; done(); } };
    panel.addEventListener('transitionend', f, { once: true }); setTimeout(f, dur * 1000 + 80);
  };

  // ---------------------------------------------------------------- dialogs: pull down to close, slide away on close
  const modal = RS.modal, close = RS.closeModal;
  RS.closeModal = instant => {
    const r = $('#modal-root'), back = r && r.firstChild;
    if (!back) return close();
    if (instant === true || still()) return close();
    // take it out of the dialog slot at once (so a new dialog can open), and let it slide away on its own
    const m = back.firstChild, onc = RS._onclose; RS._onclose = null;
    RS.releaseModal(back); back.style.pointerEvents = 'none'; document.body.appendChild(back);
    const away = () => back.remove();
    if (RS.isTouch && m) RS.sheetAway(m, back, away);
    else if (RS.feel) RS.feel.modalAway(back, m, away);          // back into the button that opened it, 20% quicker than it came
    else { back.style.transition = 'opacity .15s ease'; back.style.opacity = '0'; if (m) { m.style.transition = 'transform .15s ease, opacity .15s ease'; m.style.transform = 'scale(.98)'; m.style.opacity = '0'; } setTimeout(away, 170); }
    if (onc) onc();
  };
  RS.modal = function (html, opts) {
    const m = modal.apply(this, arguments);
    if (m && RS.isTouch) {
      m.classList.add('is-sheet');
      RS.sheetDrag(m, { handleZone: 40, onDismiss: v => { const r = $('#modal-root'), back = r && r.firstChild; const onc = RS._onclose; RS._onclose = null; if (back) { RS.releaseModal(back); document.body.appendChild(back); back.style.pointerEvents = 'none'; RS.sheetAway(m, back, () => back.remove(), v); } if (onc) onc(); },
        onMove: (y, h) => { const b = m.parentElement; if (b) b.style.opacity = String(Math.max(0.15, 1 - y / h)); } });
    }
    return m;
  };

  // ---------------------------------------------------------------- the player card
  const S = { open: false, src: '', under: '', ph: null, sy: 0, busy: false, pushed: false };
  const SOUND_PAGES = new Set(['radio', 'scanner', 'ham']);
  RS.on('page', n => { if (!S.busy && SOUND_PAGES.has(n) && RS.audio && RS.audio.on) RS.audio.srcPage = n; });
  RS.on('audio', () => { if (RS.audio.on && SOUND_PAGES.has(RS.page)) RS.audio.srcPage = RS.page; });
  function source() {
    if (RS.player && RS.player.cur) return 'library';
    const st = RS.st || {};
    if (st.scan) return 'scanner';
    return (RS.audio && RS.audio.srcPage) || 'radio';
  }
  const NAMES = { radio: 'Radio', scanner: 'Scanner', ham: 'Amateur radio', library: 'Library' };
  let el = null, panel = null, body = null, back = null;
  function build() {
    if (el) return;
    el = document.createElement('div'); el.className = 'psheet'; el.hidden = true;
    el.innerHTML = '<div class="psheet-back"></div><div class="psheet-panel" role="dialog" aria-modal="true" aria-labelledby="psheet-t">' +
      '<div class="psheet-grab sheet-grab"><i aria-hidden="true"></i><b id="psheet-t"></b><button class="btn small psheet-x" type="button" aria-label="Close">' + RS.icon('down') + '</button></div>' +
      '<div class="psheet-body" data-lenis-prevent></div></div>';
    document.body.appendChild(el);
    panel = el.querySelector('.psheet-panel'); body = el.querySelector('.psheet-body'); back = el.querySelector('.psheet-back');
    back.addEventListener('click', () => RS.closePlayerPage());
    el.querySelector('.psheet-x').addEventListener('click', () => RS.closePlayerPage());
    RS.sheetDrag(panel, { scroller: () => body, handle: '.psheet-grab', onDismiss: v => RS.closePlayerPage(v),
      onMove: (y, h) => { back.style.opacity = String(Math.max(0, 1 - y / h)); } });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.open && !$('#modal-root').firstChild) RS.closePlayerPage(); });
  }
  const resize = () => window.dispatchEvent(new Event('resize'));

  RS.openPlayerPage = () => {
    if (S.open) return;
    const src = source(), sec = $('#p-' + src);
    if (!sec || !RS.pages[src]) return;
    if (RS.page === src) {                              // already here: bring the player back into view instead
      if (RS.motion && RS.motion.scrollTo) RS.motion.scrollTo(0); else window.scrollTo({ top: 0, behavior: still() ? 'auto' : 'smooth' });
      return;
    }
    build();
    S.under = RS.page; S.sy = window.scrollY; S.src = src; S.busy = true;
    RS.go(src, true);
    S.ph = document.createComment('player card'); sec.before(S.ph); body.appendChild(sec);
    body.scrollTop = 0;
    const u = $('#p-' + S.under); if (u) u.classList.add('on', 'under-sheet');
    window.scrollTo(0, S.sy);
    const L = RS.motion && RS.motion.lenis && RS.motion.lenis(); if (L) L.stop();
    $('#psheet-t').textContent = NAMES[src] || '';
    root.classList.add('sheet-open');
    el.hidden = false; panel.style.transform = ''; back.style.opacity = '';
    if (still()) el.classList.add('on'); else requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
    S.open = true; S.busy = false;
    try { history.pushState({ psheet: 1 }, ''); S.pushed = true; } catch (e) { S.pushed = false; }
    setTimeout(resize, 40); setTimeout(resize, 560);
    setTimeout(() => { const f = panel.querySelector('.psheet-x'); if (f) f.focus({ preventScroll: true }); }, 60);
  };
  // put the page back where it lives; nav: true when something else already navigated away
  function teardown(nav) {
    const sec = $('#p-' + S.src);
    if (sec && S.ph && S.ph.parentNode) S.ph.replaceWith(sec);
    S.ph = null;
    const u = $('#p-' + S.under); if (u) u.classList.remove('under-sheet');
    el.classList.remove('on'); el.hidden = true; panel.style.transform = ''; panel.style.transition = ''; back.style.opacity = ''; back.style.transition = '';
    root.classList.remove('sheet-open');
    const L = RS.motion && RS.motion.lenis && RS.motion.lenis(); if (L) L.start();
    S.open = false;
    if (!nav) { S.busy = true; RS.go(S.under, true); if (location.hash !== '#' + S.under) history.replaceState(history.state, '', '#' + S.under); window.scrollTo(0, S.sy); S.busy = false; }
    resize();
  }
  RS.closePlayerPage = vel => {
    if (!S.open) return;
    if (S.pushed) { S.pushed = false; S.closing = true; try { history.back(); } catch (e) { } }
    RS.sheetAway(panel, back, () => teardown(false), typeof vel === 'number' ? vel : 0);
  };
  window.addEventListener('popstate', () => { if (S.closing) { S.closing = false; return; } if (S.open) { S.pushed = false; RS.sheetAway(panel, back, () => teardown(false)); } });
  // going somewhere else from inside the card (a tab, a link): the card gives way to that page
  RS.on('page', n => { if (S.open && !S.busy && n !== S.src) { S.busy = true; S.pushed = false; teardown(true); S.busy = false; } });   // the card's history entry stays: Back then returns to the page you were on
  RS.playerPageOpen = () => S.open;

  // ---------------------------------------------------------------- the mini player opens it: a press, or a swipe up
  // delegated, so it also works for the recording player, which is built later
  const AREA = '#soundbar .now, #sb-art, #fileplayer .now';
  document.addEventListener('click', e => {
    const t = e.target;
    if (!t.closest || t.closest('button, input, a, [data-act]') || !t.closest(AREA)) return;
    RS.openPlayerPage();
  });
  document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('#soundbar .now, #fileplayer .now')) { e.preventDefault(); RS.openPlayerPage(); } });
  let sy0 = null;
  document.addEventListener('touchstart', e => { const t = e.target; sy0 = t.closest && t.closest('#soundbar, #fileplayer') && !t.closest('button, input') ? e.touches[0].clientY : null; }, { passive: true });
  document.addEventListener('touchmove', e => { if (sy0 != null && sy0 - e.touches[0].clientY > 28) { sy0 = null; RS.openPlayerPage(); } }, { passive: true });
  function mark() {
    document.querySelectorAll('#soundbar .now, #fileplayer .now').forEach(n => { if (n.hasAttribute('role')) return; n.setAttribute('role', 'button'); n.setAttribute('tabindex', '0'); n.setAttribute('aria-label', 'Open the page this sound comes from'); });
  }
  mark(); RS.on('player', mark); RS.on('audio', mark);
})();
