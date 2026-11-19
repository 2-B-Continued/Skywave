/* feel.js - how things move, in one place. Loaded after motion.js, sheet.js, kinetic.js and navglide.js.
   The rules, applied everywhere through the helpers below (RS.feel):
   - entrances ease out; moves ease in and out; nothing bounces in everyday use (rare celebrations may)
   - pop-ups start at 0.95, grow out of the button that opened them and shrink back into it; exits run 20% shorter
   - dropdowns and small pop-ups take 150-250 ms
   - presses scale to 0.97; a moving knob stretches 12% in the direction it travels
   - list rows stagger 30 ms apart as they arrive, and so do the contents of a section as it opens
   - things that fly somewhere follow an arc; a success pulses once where it landed
   - old and new states overlap (cross-fade) instead of one waiting for the other
   - colour changes and reveals use a mask that grows from where you pressed
   - icons cross-fade with a little blur; text swaps the same way (navglide.js)
   - nothing tweens while it is held: it follows the finger, then settles
   - dragging past an end rubber-bands (a fifth of the overshoot) and springs back
   - an element keeps its identity (its "layout id") across re-renders, so it moves to its new place instead of jumping
   Reduced motion or Motion Off: no movement at all; colour and opacity changes stay. */
(function () {
  'use strict';
  const RS = window.RS, root = document.documentElement;
  const still = () => root.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const E = { out: 'cubic-bezier(0.23, 1, 0.32, 1)', io: 'cubic-bezier(0.65, 0, 0.35, 1)', drawer: 'cubic-bezier(0.32, 0.72, 0, 1)' };
  const D = { press: 160, pop: 220, enter: 250, move: 320, emph: 450 };
  const exit = ms => Math.round(ms * 0.8);
  const F = RS.feel = { E, D, exit, still };
  const io = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  // ---------------------------------------------------------------- where the last press came from
  F.last = { el: null, x: 0, y: 0, t: 0 };
  const note = (el, x, y) => { F.last = { el, x, y, t: performance.now() }; };
  document.addEventListener('pointerdown', e => note(e.target.closest('button, [role=button], a, summary, .np-art, label') || e.target, e.clientX, e.clientY), true);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = document.activeElement; if (!el || el === document.body) return;
    const r = el.getBoundingClientRect(); note(el, r.left + r.width / 2, r.top + r.height / 2);
  }, true);
  F.recent = (ms = 700) => performance.now() - F.last.t < ms;
  // the point a pop-up grows from: the button pressed just now, if it is still on screen
  F.origin = () => {
    const el = F.last.el;
    if (F.recent(1200) && el && el.isConnected) { const r = el.getBoundingClientRect(); if (r.width) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
    return null;
  };

  // ---------------------------------------------------------------- pop-ups: from the trigger, back into it
  F.popIn = (el, o = {}) => {
    if (!el || still()) return;
    const at = o.from || F.origin(), r = el.getBoundingClientRect();
    if (at && r.width) el.style.transformOrigin = Math.round(at.x - r.left) + 'px ' + Math.round(at.y - r.top) + 'px';
    el.animate([{ opacity: 0, transform: 'scale(0.95)' }, { opacity: 1, transform: 'scale(1)' }], { duration: o.ms || D.pop, easing: E.out });
  };
  F.popOut = (el, done, o = {}) => {
    if (!el || still()) { done && done(); return; }
    const a = el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.95)' }], { duration: exit(o.ms || D.pop), easing: E.out, fill: 'forwards' });
    a.onfinish = () => done && done();
  };
  // dialogs on a computer grow out of what opened them; on a phone they are sheets and rise from the bottom edge
  const mr = document.getElementById('modal-root');
  let modalFrom = null;
  if (mr) new MutationObserver(ms => ms.forEach(x => x.addedNodes.forEach(n => {
    if (n.nodeType !== 1 || still()) return;
    const m = n.matches('.modal') ? n : n.querySelector('.modal'), back = n.classList.contains('modal-back') ? n : null; if (!m) return;
    modalFrom = F.origin();
    if (back) back.animate([{ opacity: 0 }, { opacity: 1 }], { duration: D.enter, easing: 'ease' });
    if (m.classList.contains('is-sheet')) m.animate([{ transform: 'translate3d(0, 100%, 0)' }, { transform: 'translate3d(0, 0, 0)' }], { duration: 420, easing: E.drawer });
    else { m.style.transformOrigin = ''; F.popIn(m, { from: modalFrom, ms: D.enter }); }
  }))).observe(mr, { childList: true });
  // closing (sheet.js moves the dialog out of the slot before calling this): back into the trigger, 20% faster than it came
  F.modalAway = (back, m, done) => {
    if (still() || !m) { done(); return; }
    back.animate([{ opacity: 1 }, { opacity: 0 }], { duration: exit(D.enter), easing: 'ease', fill: 'forwards' });
    F.popOut(m, done, { ms: D.enter });
  };

  // ---------------------------------------------------------------- a row of things arriving: 30 ms apart
  F.stagger = (nodes, o = {}) => {
    if (still()) return;
    const L = Array.from(nodes || []).filter(n => n.nodeType === 1 && n.offsetParent !== null);
    L.forEach((n, i) => n.animate([{ opacity: 0, transform: 'translateY(' + (o.y == null ? 6 : o.y) + 'px)' }, { opacity: 1, transform: 'none' }],
      { duration: o.ms || D.enter, delay: Math.min(i, 10) * 30, easing: E.out, fill: 'backwards' }));
  };
  // Any list marked data-stagger: when you change what it shows (a filter, a sort, a tab), the new rows arrive 30 ms apart.
  // Background refreshes (nothing pressed just before) change the rows quietly.
  F.watch = box => {
    if (!box || box._fw) return; box._fw = true;
    new MutationObserver(recs => {
      if (still() || !F.recent(700)) return;
      const added = [], gone = [];
      recs.forEach(r => { r.addedNodes.forEach(n => { if (n.nodeType === 1 && n.parentNode === box && !n.classList.contains('kx-mark')) added.push(n); }); r.removedNodes.forEach(n => { if (n.nodeType === 1 && !n.classList.contains('kx-mark')) gone.push(n); }); });
      // the same rows drawn again (only the selection moved): no entrance
      const sig = L => L.map(n => n.textContent.trim()).join('|');
      if (added.length > 1 && sig(added) !== sig(gone)) F.stagger(added);
    }).observe(box, { childList: true });
  };
  const scan = () => document.querySelectorAll('[data-stagger]').forEach(F.watch);
  RS.on('page', () => requestAnimationFrame(scan)); setTimeout(scan, 500);
  // a section opening: what it holds settles in, one after another
  document.addEventListener('toggle', e => {
    const d = e.target; if (!(d instanceof HTMLDetailsElement) || !d.open || still() || !F.recent(800)) return;
    let kids = Array.from(d.children).filter(c => c.tagName !== 'SUMMARY');
    if (kids.length === 1 && kids[0].children.length > 1) kids = Array.from(kids[0].children);
    F.stagger(kids.slice(0, 14));
  }, true);

  // ---------------------------------------------------------------- old and new at once
  // Swap what an element shows: the old picture fades out on top while the new one fades in beneath, both at once.
  F.swap = (el, html, o = {}) => {
    if (!el) return;
    if (still() || !el.isConnected || !el.offsetHeight) { el.innerHTML = html; return; }
    const r = el.getBoundingClientRect(), ghost = el.cloneNode(true);
    ghost.removeAttribute('id'); ghost.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
    Object.assign(ghost.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', margin: '0', pointerEvents: 'none', zIndex: 5, overflow: 'hidden' });
    ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
    document.body.appendChild(ghost);
    el.innerHTML = html;
    ghost.animate([{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(2px)' }], { duration: exit(D.enter), easing: E.out, fill: 'forwards' }).onfinish = () => ghost.remove();
    if (o.rows) F.stagger(el.querySelectorAll(o.rows));
    else el.animate([{ opacity: 0, filter: 'blur(2px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: D.enter, easing: E.out });
  };

  // ---------------------------------------------------------------- icons: cross-fade with a touch of blur
  F.icon = (slot, svgHtml) => {
    if (!slot) return;
    const old = slot.querySelector('svg');
    if (!old || still()) { slot.innerHTML = svgHtml; return; }
    const tmp = document.createElement('span'); tmp.innerHTML = svgHtml; const nu = tmp.firstElementChild; if (!nu) return;
    if (getComputedStyle(slot).position === 'static') slot.style.position = 'relative';
    Object.assign(old.style, { position: 'absolute', left: old.offsetLeft + 'px', top: old.offsetTop + 'px' });
    slot.appendChild(nu);
    old.animate([{ opacity: 1, transform: 'scale(1)', filter: 'blur(0)' }, { opacity: 0, transform: 'scale(0.6)', filter: 'blur(2px)' }], { duration: exit(D.pop), easing: E.out, fill: 'forwards' }).onfinish = () => old.remove();
    nu.animate([{ opacity: 0, transform: 'scale(0.6)', filter: 'blur(2px)' }, { opacity: 1, transform: 'scale(1)', filter: 'blur(0)' }], { duration: D.pop, easing: E.out });
  };

  // ---------------------------------------------------------------- success: one pulse where it landed
  F.pulse = el => {
    if (!el || !el.isConnected) return;
    const c = getComputedStyle(el).color;
    if (still()) { el.animate([{ outline: '2px solid ' + c, outlineOffset: '2px' }, { outline: '2px solid transparent', outlineOffset: '2px' }], { duration: 600 }); return; }
    el.animate([{ transform: 'scale(1)', boxShadow: '0 0 0 0 color-mix(in srgb, ' + c + ' 45%, transparent)' },
      { transform: 'scale(1.04)', boxShadow: '0 0 0 6px color-mix(in srgb, ' + c + ' 20%, transparent)', offset: 0.4 },
      { transform: 'scale(1)', boxShadow: '0 0 0 12px transparent' }], { duration: D.emph, easing: E.io });
  };

  // ---------------------------------------------------------------- flying somewhere: along an arc, then a pulse
  F.arc = (from, to, o = {}) => {
    const done = () => { if (o.done) o.done(); F.pulse(o.pulse || to); };
    if (!from || !to || still()) { done(); return; }
    const a = from.getBoundingClientRect ? from.getBoundingClientRect() : from, b = to.getBoundingClientRect();
    if (!b.width || !a.width) { done(); return; }
    const g = document.createElement('div'); g.className = 'kx-fly'; g.setAttribute('aria-hidden', 'true'); g.textContent = o.label || '';
    document.body.appendChild(g);
    const gw = g.offsetWidth, gh = g.offsetHeight;
    const x0 = a.left + a.width / 2 - gw / 2, y0 = a.top + a.height / 2 - gh / 2, x1 = b.left + b.width / 2 - gw / 2, y1 = b.top + b.height / 2 - gh / 2;
    const lift = Math.min(180, Math.max(60, Math.hypot(x1 - x0, y1 - y0) * 0.35));
    const cx = (x0 + x1) / 2, cy = Math.min(y0, y1) - lift;                 // the control point sits above the higher end: a thrown arc
    const frames = [];
    for (let i = 0; i <= 18; i++) {
      const t = io(i / 18), u = 1 - t, x = u * u * x0 + 2 * u * t * cx + t * t * x1, y = u * u * y0 + 2 * u * t * cy + t * t * y1;
      frames.push({ transform: 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) scale(' + (1 - 0.25 * t).toFixed(3) + ')', opacity: i === 18 ? 0 : 1, offset: i / 18 });
    }
    g.animate(frames, { duration: o.ms || 560, easing: 'linear' }).onfinish = () => { g.remove(); done(); };
  };

  // ---------------------------------------------------------------- the same element, in its new place (FLIP)
  // keyOf(node) gives each child a lasting identity; children that existed before move from where they were (ease-in-out),
  // new ones arrive with the 30 ms stagger, and ones that left fade out where they stood while the rest close up.
  F.flip = (box, keyOf, mutate) => {
    if (!box || still() || !box.offsetParent) { mutate(); return; }
    const before = new Map(), gone = [];
    Array.from(box.children).forEach(c => { const k = keyOf(c); if (k != null) before.set(k, { r: c.getBoundingClientRect(), el: c }); });
    mutate();
    const fresh = [], seen = new Set();
    Array.from(box.children).forEach(c => {
      const k = keyOf(c); if (k == null) return; seen.add(k);
      const b = before.get(k); if (!b) { fresh.push(c); return; }
      const r = c.getBoundingClientRect(), dx = b.r.left - r.left, dy = b.r.top - r.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) c.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }], { duration: D.move, easing: E.io });
    });
    before.forEach((b, k) => { if (!seen.has(k)) gone.push(b); });
    gone.forEach(b => {
      const g = b.el.cloneNode(true); g.setAttribute('aria-hidden', 'true'); g.inert = true;
      Object.assign(g.style, { position: 'fixed', left: b.r.left + 'px', top: b.r.top + 'px', width: b.r.width + 'px', height: b.r.height + 'px', margin: '0', pointerEvents: 'none', zIndex: 5 });
      document.body.appendChild(g);
      g.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.95)' }], { duration: exit(D.enter), easing: E.out, fill: 'forwards' }).onfinish = () => g.remove();
    });
    F.stagger(fresh);
  };

  // ---------------------------------------------------------------- one marker that moves to whatever is chosen
  // The highlight is a single element (its own layout id), so choosing something else moves it there instead of
  // switching one highlight off and another on.
  F.mark = (box, el, cls) => {
    if (!box) return;
    box._kxm = box._kxm || {};
    let m = box._kxm[cls || ''];
    if (m && !box.contains(m)) box.insertBefore(m, box.firstChild);        // the list was re-drawn: the same marker carries on
    if (!el || !el.offsetParent) { if (m) m.hidden = true; return; }
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    const b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
    const to = { x: r.left - b.left + box.scrollLeft, y: r.top - b.top + box.scrollTop, w: r.width, h: r.height };
    const fresh = !m || m.hidden;
    if (!m) { m = document.createElement('span'); m.className = 'kx-mark' + (cls ? ' ' + cls : ''); m.setAttribute('aria-hidden', 'true'); box.insertBefore(m, box.firstChild); box._kxm[cls || ''] = m; }
    m.hidden = false;
    const prev = m._to;
    Object.assign(m.style, { transform: 'translate(' + to.x + 'px,' + to.y + 'px)', width: to.w + 'px', height: to.h + 'px' });
    m._to = to;
    if (fresh || !prev || still()) { if (fresh && !still()) m.animate([{ opacity: 0 }, { opacity: 1 }], { duration: D.enter, easing: E.out }); return; }
    if (Math.abs(prev.x - to.x) < 0.5 && Math.abs(prev.y - to.y) < 0.5 && Math.abs(prev.w - to.w) < 0.5 && Math.abs(prev.h - to.h) < 0.5) return;
    // a knob on the move stretches 12% along its travel, then settles to its size
    const horiz = Math.abs(to.x - prev.x) >= Math.abs(to.y - prev.y), midW = Math.max(prev.w, to.w) * (horiz ? 1.12 : 1), midH = Math.max(prev.h, to.h) * (horiz ? 1 : 1.12);
    const mx = (prev.x + to.x) / 2 + (prev.w + to.w) / 4 - midW / 2, my = (prev.y + to.y) / 2 + (prev.h + to.h) / 4 - midH / 2;
    m.animate([
      { transform: 'translate(' + prev.x + 'px,' + prev.y + 'px)', width: prev.w + 'px', height: prev.h + 'px' },
      { transform: 'translate(' + mx + 'px,' + my + 'px)', width: midW + 'px', height: midH + 'px', offset: 0.5 },
      { transform: 'translate(' + to.x + 'px,' + to.y + 'px)', width: to.w + 'px', height: to.h + 'px' }], { duration: D.move, easing: E.io });
  };

  // ---------------------------------------------------------------- rubber band: past an end, a fifth of the pull
  F.rubber = (v, lo, hi, k = 0.2) => v < lo ? lo - (lo - v) * k : v > hi ? hi + (v - hi) * k : v;

  // ---------------------------------------------------------------- colour: the new colour grows from where you pressed
  // A button whose background changes because you pressed it (Save, Listen, a chip, a toggle) fills with its new colour
  // through a circular mask from the press point, instead of switching in one frame.
  const FILL_SEL = '.btn, .chip, .seg button, .rdp-preset-b, .ho-st, .spx-row .btn, [role=switch]';
  let pend = null;
  document.addEventListener('pointerdown', e => {
    const b = e.target.closest(FILL_SEL); if (!b) { pend = null; return; }
    pend = { b, bg: getComputedStyle(b).backgroundColor, x: e.clientX, y: e.clientY };
  }, true);
  document.addEventListener('click', () => {
    const p = pend; pend = null; if (!p || still()) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const b = p.b; if (!b.isConnected) return;
      const nu = getComputedStyle(b).backgroundColor; if (nu === p.bg) return;
      const r = b.getBoundingClientRect(), x = p.x - r.left, y = p.y - r.top, rad = Math.hypot(Math.max(x, r.width - x), Math.max(y, r.height - y)) + 2;
      // decorative layers are aria-hidden: code that looks for a button's label skips them (span:not([aria-hidden]))
      const lay = document.createElement('span'); lay.className = 'kx-fill'; lay.setAttribute('aria-hidden', 'true'); lay.style.background = nu;
      b.classList.add('kx-filling'); b.style.backgroundColor = p.bg; b.insertBefore(lay, b.firstChild);
      lay.animate([{ clipPath: 'circle(0px at ' + x + 'px ' + y + 'px)' }, { clipPath: 'circle(' + rad + 'px at ' + x + 'px ' + y + 'px)' }], { duration: 360, easing: E.out })
        .onfinish = () => { lay.remove(); b.style.backgroundColor = ''; b.classList.remove('kx-filling'); };
    }));
  }, true);

  // ---------------------------------------------------------------- nothing tweens while held
  // Whatever is under the finger (a slider, a tuner, a map, a sheet's handle) follows it directly; transitions come back on release.
  const HOLD = 'input[type=range], canvas, .map, .sheet-grab, [data-hold]';
  let held = null;
  document.addEventListener('pointerdown', e => { const h = e.target.closest(HOLD); if (h) { held = h; h.classList.add('kx-held'); root.classList.add('kx-holding'); } }, true);
  const release = () => { if (held) { held.classList.remove('kx-held'); held = null; root.classList.remove('kx-holding'); } };
  document.addEventListener('pointerup', release, true); document.addEventListener('pointercancel', release, true); window.addEventListener('blur', release);

  // ---------------------------------------------------------------- toasts: in from below, out 20% faster
  const tr = RS.toast;
  RS.toast = function () {
    const r = tr.apply(this, arguments), el = document.getElementById('toasts') && document.getElementById('toasts').lastElementChild;
    if (el && el.remove) {
      const rm = () => Element.prototype.remove.call(el);
      el.remove = () => {
        if (still() || !el.isConnected) return rm();
        el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px) scale(0.98)' }], { duration: exit(400), easing: E.out, fill: 'forwards' }).onfinish = () => rm();
      };
    }
    return r;
  };

  // ---------------------------------------------------------------- hints (the little "?" notes): out of their button and back
  const hint = RS.act.hint;
  RS.act.hint = b => {
    const host = b.closest('h3,h4,label,.hh') || b.parentElement, n = host.nextElementSibling;
    if (n && n.classList.contains('hinttext') && n.dataset.for === b.dataset.id && !still()) {
      b.setAttribute('aria-expanded', 'false'); n.classList.remove('hinttext'); n.classList.add('hinttext-out');
      F.popOut(n, () => n.remove()); return;
    }
    hint(b);
    const d = host.nextElementSibling; if (d && d.classList.contains('hinttext')) { const r = b.getBoundingClientRect(); F.popIn(d, { from: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, ms: 200 }); }
  };
})();
