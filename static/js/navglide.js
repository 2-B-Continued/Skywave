/* navglide.js - the section bars move instead of jumping.
   - When the open section changes, the active tab's own shape (its background, corners, border and shadow, whatever
     the style draws) glides from the old tab to the new one. The leading edge travels a little ahead of the trailing
     edge, so it stretches slightly on the way and settles. Works for every style because it copies the computed look.
   - On a desktop, a faint highlight follows the pointer from tab to tab.
   - Button labels that change (Start / Stop and the like) swap with a short soft blur instead of a hard cut.
   Only left / top / width / height of one absolutely placed element (nothing else reflows), opacity and filter.
   Nothing moves when Motion is Off or the device asks for reduced motion. */
(function () {
  'use strict';
  const RS = window.RS, root = document.documentElement;
  const mq = q => { try { return matchMedia(q); } catch (e) { return { matches: false }; } };
  const reduce = mq('(prefers-reduced-motion: reduce)'), fine = mq('(hover: hover) and (pointer: fine)');
  const off = () => reduce.matches || root.dataset.motion === 'off';
  const EASE = 'cubic-bezier(0.65, 0, 0.35, 1)', DUR = 340;     // a move: ease in and out
  const LOOK = ['backgroundColor', 'backgroundImage', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
    'boxShadow', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopColor', 'borderRightColor', 'borderBottomColor',
    'borderLeftColor', 'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle', 'outlineColor', 'outlineStyle', 'outlineWidth', 'outlineOffset'];
  const SEL = '[aria-selected="true"]';

  const rectOf = el => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
  const shown = el => el && el.isConnected && el.offsetWidth > 0 && el.offsetHeight > 0;

  function bar(box) {
    if (!box || box._ng) return;
    const S = box._ng = { el: null, r: null, g: null, anim: null, hid: null };
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';

    const settle = () => { const a = box.querySelector(':scope > ' + SEL); S.el = shown(a) ? a : null; S.r = S.el ? rectOf(S.el) : null; };
    const finish = () => {
      if (S.anim) { S.anim.onfinish = null; S.anim.cancel(); S.anim = null; }
      if (S.g) { S.g.remove(); S.g = null; }
      if (S.hid) { S.hid.classList.remove('kx-ng-hide'); S.hid = null; }
      box.classList.remove('kx-ng-on');
    };

    function moved() {
      const cur = box.querySelector(':scope > ' + SEL);
      if (!shown(cur)) { finish(); settle(); return; }
      if (cur === S.el) { if (!S.g) S.r = rectOf(cur); return; }
      // where the shape is now: mid-flight if a slide is still running, otherwise the old tab as it last looked
      let from = S.g ? { x: parseFloat(getComputedStyle(S.g).left), y: parseFloat(getComputedStyle(S.g).top), w: S.g.offsetWidth, h: S.g.offsetHeight } : S.r;
      const prev = S.el;
      finish();
      if (off() || !from || !prev || !prev.isConnected) { settle(); return; }

      // the active look, read with transitions off so it's the final state rather than a mid-transition one
      const t = cur.style.transition; cur.style.transition = 'none';
      const cs = getComputedStyle(cur), look = {};
      LOOK.forEach(k => { look[k] = cs[k]; });
      cur.style.transition = t;
      const visible = (look.backgroundColor && !/rgba\([^)]*,\s*0\)|transparent/.test(look.backgroundColor)) || (look.backgroundImage && look.backgroundImage !== 'none') ||
        (look.boxShadow && look.boxShadow !== 'none') || parseFloat(look.borderBottomWidth) > 0;
      const to = rectOf(cur);
      if (!visible || (Math.abs(to.x - from.x) < 2 && Math.abs(to.y - from.y) < 2)) { settle(); return; }

      const g = document.createElement('span'); g.className = 'kx-ng'; g.setAttribute('aria-hidden', 'true');
      Object.assign(g.style, look);
      box.insertBefore(g, box.firstChild);
      box.classList.add('kx-ng-on'); cur.classList.add('kx-ng-hide');
      S.g = g; S.hid = cur; S.el = cur; S.r = to;

      // half way, the pill is 12% longer along its travel (a knob on the move stretches), then settles to its new size
      const horiz = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
      const mw = Math.max(from.w, to.w) * (horiz ? 1.12 : 1), mh = Math.max(from.h, to.h) * (horiz ? 1 : 1.12);
      const cx = (from.x + from.w / 2 + to.x + to.w / 2) / 2, cy = (from.y + from.h / 2 + to.y + to.h / 2) / 2;
      const box0 = { left: from.x + 'px', top: from.y + 'px', width: from.w + 'px', height: from.h + 'px' };
      const boxM = { left: (cx - mw / 2) + 'px', top: (cy - mh / 2) + 'px', width: mw + 'px', height: mh + 'px', offset: 0.5 };
      const box1 = { left: to.x + 'px', top: to.y + 'px', width: to.w + 'px', height: to.h + 'px' };
      Object.assign(g.style, box1);
      const far = Math.min(1, Math.hypot(to.x - from.x, to.y - from.y) / 400);
      S.anim = g.animate([box0, boxM, box1], { duration: DUR + far * 100, easing: EASE });
      S.anim.onfinish = () => { S.anim = null; finish(); settle(); };
    }

    new MutationObserver(recs => {
      if (recs.some(r => r.attributeName === 'aria-selected' || r.type === 'childList')) requestAnimationFrame(moved);
    }).observe(box, { attributes: true, attributeFilter: ['aria-selected'], subtree: true, childList: true });
    window.addEventListener('resize', RS.deb ? RS.deb(() => { finish(); settle(); hoverAway(); }, 120) : settle);
    settle();

    // ---- the pointer highlight (desktop)
    let h = null, hOn = false;
    function hoverAway() { if (h) { h.classList.remove('on'); hOn = false; } }
    box.addEventListener('pointerover', e => {
      if (!fine.matches || off()) return;
      const t = e.target.closest && e.target.closest('[role="tab"], button'); if (!t || t.parentNode !== box || !shown(t)) return;
      if (!h) { h = document.createElement('span'); h.className = 'kx-nh'; h.setAttribute('aria-hidden', 'true'); box.insertBefore(h, box.firstChild); }
      const r = rectOf(t), rad = getComputedStyle(t).borderTopLeftRadius;
      if (!hOn) { h.style.transition = 'none'; void h.offsetWidth; }       // first entry: appear in place, don't fly in
      Object.assign(h.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', borderRadius: rad && rad !== '0px' ? rad : '' });
      if (!hOn) { void h.offsetWidth; h.style.transition = ''; }
      h.classList.add('on'); hOn = true;
    });
    box.addEventListener('pointerleave', hoverAway);
    box.addEventListener('pointerdown', hoverAway);
  }

  // ---- labels: a soft swap when a control's text changes (RS.setText is the one place labels are rewritten)
  const SWAP = 'button, .btn, .chip, .badge, .tab';
  if (RS.setText) {
    const set = RS.setText;
    RS.setText = (el, txt) => {
      const had = el && el._raw !== undefined && el._raw !== txt;
      set(el, txt);
      if (!had || off() || !el.matches || !el.matches(SWAP) || !el.animate || !el.isConnected) return;
      el.animate([{ opacity: 0.35, filter: 'blur(2px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 180, easing: 'ease-out' });
    };
  }

  const go = () => { bar(document.getElementById('tabs')); bar(document.getElementById('mnav')); };
  RS.on && RS.on('hello', () => setTimeout(go, 50));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
  setTimeout(go, 600);
})();
