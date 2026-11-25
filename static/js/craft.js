/* craft.js - small pieces of feedback shared by every style (see craft.css for the rules they follow).
   - the tuned frequency: a live signal dot beside it, a light behind the dial that follows the signal, and changed digits that roll
   - numbers on Home that change get a short pop so the change is noticed
   - toasts: a drawn tick for things that worked, and a short exit instead of vanishing
   - an indicator that glides to the active tab and to Easy / Advanced
   - nested corners: a control inside a rounded container gets the container's radius minus its padding
   Everything here is transform / opacity, and reduced motion gets a fade (craft.css). */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, root = document.documentElement;
  const reduce = () => root.dataset.motion === 'off';

  // ---------------------------------------------------------------- which page is open (CSS uses it, e.g. Home hides the practice banner)
  RS.on('page', n => { root.dataset.page = n; setTimeout(nestAll, 120); setTimeout(glideAll, 30); });

  // ---------------------------------------------------------------- signal level, 0..1
  let lvl = -1;
  function level() {
    const st = RS.st || {}, live = RS.live;
    const snr = (st.job === 'listen' && live && performance.now() - live.t < 1500) ? live.snr : (st.snr || 0);
    const v = Math.max(0, Math.min(1, (snr || 0) / 32));
    if (Math.abs(v - lvl) < 0.02) return;
    lvl = v;
    const d = $('#rd-stage'); if (d) d.style.setProperty('--lvl', v.toFixed(2));
    const h = $('#ham-dial') || $('#hm-dial'); if (h) h.style.setProperty('--lvl', v.toFixed(2));
  }
  RS.on('state', level); RS.on('spectrum', RS.throttle ? RS.throttle(level, 120) : level);

  // ---------------------------------------------------------------- the readout: signal dot + rolling digits
  const seen = new WeakMap();
  function readout(el) {
    if (!el || seen.has(el)) return;
    const st = { prev: '', t: 0 };
    seen.set(el, st);
    const mo = new MutationObserver(() => {
      if (el.classList.contains('editing')) return;
      if (!el.querySelector('.sig-dot')) { const s = el.querySelector('small'); const dot = document.createElement('i'); dot.className = 'sig-dot'; dot.setAttribute('aria-hidden', 'true'); s ? s.after(dot) : el.appendChild(dot); }
      const digits = el.textContent.replace(/[^0-9]/g, '');
      const now = performance.now(), quick = now - st.t < 140;     // dragging: no animation, it would only blur the numbers
      if (st.prev && digits !== st.prev && !quick && !reduce()) {
        const up = parseFloat(el.textContent) > st.prevVal;
        const ds = [...el.querySelectorAll('.dg')], a = digits, b = st.prev;
        for (let i = 1; i <= ds.length; i++) {
          if (a[a.length - i] !== b[b.length - i]) ds[ds.length - i].classList.add(up ? 'up' : 'down');
        }
      }
      st.t = now; st.prev = digits; st.prevVal = parseFloat(el.textContent);
    });
    mo.observe(el, { childList: true });
  }
  function bloom(card) {
    if (!card || card.querySelector(':scope > .sig-bloom')) return;
    const b = document.createElement('i'); b.className = 'sig-bloom'; b.setAttribute('aria-hidden', 'true'); card.prepend(b);
  }
  RS.on('page', n => {
    setTimeout(() => {
      readout($('#rd-freq')); readout($('#hm-freq')); bloom($('#rd-stage'));
      const hf = $('#hm-freq'); if (hf) bloom(hf.closest('.glass, .dial-card'));
      level();
    }, 60);
  });

  // ---------------------------------------------------------------- favourite: the star pops when it is set
  const fav = RS.act['rd-fav'];
  if (fav) RS.act['rd-fav'] = function (b, e) {
    const r = fav.apply(this, arguments);
    setTimeout(() => { const s = $('#rd-star'); if (s && s.classList.contains('on')) { s.classList.add('just'); setTimeout(() => s.classList.remove('just'), 600); } }, 80);
    return r;
  };

  // ---------------------------------------------------------------- phones: a tiny tick under the finger for each tuning step
  ['rd-nudge', 'rd-seek', 'rd-pick'].forEach(k => {
    const f = RS.act[k]; if (!f) return;
    RS.act[k] = function () { if (RS.isTouch && navigator.vibrate && !reduce()) { try { navigator.vibrate(k === 'rd-nudge' ? 6 : 12); } catch (e) { } } return f.apply(this, arguments); };
  });

  // ---------------------------------------------------------------- toasts
  const OK = /^(saved|added|copied|done|all set|removed|deleted|scheduled|recording saved|sent|connected|updated|ready|imported|exported|restored|renamed|cleared|started|stopped|found)/i;
  const tick = '<svg class="tk" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const toast = RS.toast;
  RS.toast = function (text, cls) {
    const r = toast.apply(this, arguments);
    const el = $('#toasts') && $('#toasts').lastElementChild;
    if (el) {
      if (cls === 'good' || (cls !== 'bad' && OK.test(String(text).trim()))) el.insertAdjacentHTML('afterbegin', tick);
      const rm = el.remove.bind(el);
      el.remove = () => { if (reduce() || !el.isConnected) return rm(); el.classList.add('out'); setTimeout(rm, 160); };
    }
    return r;
  };

  // ---------------------------------------------------------------- an indicator that glides to the active choice
  const GROUPS = [['#tabs', '[aria-selected="true"]']];   // Easy / Advanced gets kinetic.js's sliding pill instead
  function glide(box, sel) {
    if (!box) return;
    let g = box.querySelector(':scope > .glide');
    if (!g) { g = document.createElement('span'); g.className = 'glide'; g.setAttribute('aria-hidden', 'true'); box.appendChild(g); g.style.transition = 'none'; requestAnimationFrame(() => requestAnimationFrame(() => { g.style.transition = ''; })); }
    const a = box.querySelector(':scope > ' + sel);
    if (!a || !a.offsetWidth || getComputedStyle(a).display === 'none') { if (!g.classList.contains('hidden')) g.classList.add('hidden'); return; }
    if (g.classList.contains('hidden')) g.classList.remove('hidden');
    const inset = Math.min(14, a.offsetWidth * 0.22);
    g.style.width = Math.max(8, a.offsetWidth - inset * 2) + 'px';
    g.style.top = '0px'; g.style.bottom = 'auto';
    g.style.translate = (a.offsetLeft + inset) + 'px ' + (a.offsetTop + a.offsetHeight - 3) + 'px';
  }
  function glideAll() { GROUPS.forEach(([b, s]) => glide($(b), s)); }
  GROUPS.forEach(([b]) => {
    const box = $(b); if (!box) return;
    new MutationObserver(recs => { if (recs.some(r => !r.target.classList.contains('glide'))) requestAnimationFrame(glideAll); }).observe(box, { subtree: true, attributes: true, attributeFilter: ['aria-selected', 'aria-pressed', 'class'] });
  });
  window.addEventListener('resize', RS.deb ? RS.deb(glideAll, 120) : glideAll);

  // ---------------------------------------------------------------- nested corners: inner radius = outer radius - padding
  const NEST = '.mode-switch, .seg, .tabs, .soundbar';
  function nest(el) {
    const cs = getComputedStyle(el), r = parseFloat(cs.borderTopLeftRadius) || 0, p = parseFloat(cs.paddingTop) || 0;
    if (!r || cs.clipPath !== 'none' || p <= 0) { el.style.removeProperty('--r-nest'); return; }
    el.style.setProperty('--r-nest', Math.max(2, Math.round(r - p)) + 'px');
  }
  function nestAll() { document.querySelectorAll(NEST).forEach(nest); }
  new MutationObserver(() => { setTimeout(() => { nestAll(); glideAll(); }, 140); }).observe(root, { attributes: true, attributeFilter: ['data-style', 'data-theme'] });

  // ---------------------------------------------------------------- layout family per style (styles.css): the "rack" puts the station list beside the instrument
  const RACK = new Set(['terminal', 'ticket', 'brut', 'bento', 'walnut', 'relief']);
  const layout = () => { const st = root.dataset.style || 'skywave'; if (RACK.has(st)) root.dataset.layout = 'rack'; else delete root.dataset.layout; };
  new MutationObserver(layout).observe(root, { attributes: true, attributeFilter: ['data-style'] }); layout();

  // ---------------------------------------------------------------- the tuned frequency as a hue: low bands warm, high bands cool (log scale, 0.1 MHz to 1.7 GHz)
  let lastHue = -1;
  function hue() {
    const f = RS.vfo ? RS.vfo() : 0; if (!f) return;
    const k = Math.max(0, Math.min(1, (Math.log10(f) - 5) / (Math.log10(1.7e9) - 5)));
    const h = Math.round(20 + k * 260);
    if (h !== lastHue) { lastHue = h; root.style.setProperty('--fhue', h); }
  }
  RS.on('state', hue); RS.on('local', hue);

  // ---------------------------------------------------------------- a soft light that follows the pointer across the instrument glass (desktop, full motion)
  document.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || root.dataset.motion !== 'full') return;
    const c = e.target.closest && e.target.closest('.dial-card'); if (!c) return;
    const r = c.getBoundingClientRect();
    c.style.setProperty('--mx', (e.clientX - r.left) + 'px'); c.style.setProperty('--my', (e.clientY - r.top) + 'px');
    if (!c.classList.contains('lit')) { c.classList.add('lit'); c.addEventListener('pointerleave', () => c.classList.remove('lit'), { once: true }); }
  }, { passive: true });

  // first paint
  setTimeout(() => { if (RS.page) root.dataset.page = RS.page; nestAll(); glideAll(); readout($('#rd-freq')); bloom($('#rd-stage')); }, 400);
})();
