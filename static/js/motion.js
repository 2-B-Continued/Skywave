/* motion.js - the motion layer: smooth inertial wheel scrolling (Lenis), staggered entrances when a page opens and as cards
   scroll into view (GSAP + ScrollTrigger), animated page titles (SplitText), magnetic controls, a cursor glow and a modal
   entrance. The libraries are vendored in static/vendor (no build step, no CDN). Each style gets its own motion character so it
   keeps its own shape language: Skywave and Aurora drift in from blur, Bento springs, Folio wipes like print, Terminal decrypts and steps.
   Three levels, chosen in Settings and stored per device: full (desktop default), light (phone default: short entrances only,
   no smooth scrolling and nothing that runs every frame) and off. The device's "reduce motion" setting always wins and means off.
   If the libraries fail to load, everything simply stays still. */
(function () {
  'use strict';
  const RS = window.RS, root = document.documentElement, G = window.gsap;
  const ST = window.ScrollTrigger, Split = window.SplitText, Lenis = window.Lenis;
  if (G && ST && Split) G.registerPlugin(ST, Split);
  const mm = q => { try { return matchMedia(q); } catch (e) { return { matches: false, addEventListener() { } }; } };
  const mqReduce = mm('(prefers-reduced-motion: reduce)'), mqFine = mm('(hover: hover) and (pointer: fine)');
  const M = RS.motion = {};

  // ---------------------------------------------------------------- level
  M.osReduce = () => mqReduce.matches;
  M.choice = () => { const v = RS.store.get('motion', null); return v === 'full' || v === 'light' || v === 'off' ? v : ''; };
  M.level = () => { if (mqReduce.matches || !G) return 'off'; return M.choice() || (RS.isTouch ? 'light' : 'full'); };
  const style = () => root.dataset.style || 'skywave';
  const full = () => M.level() === 'full';
  const on = () => M.level() !== 'off';

  // ---------------------------------------------------------------- per-style character
  // card: [from, to] for a card entering; title: how the page title arrives. Durations in seconds (GSAP).
  const PROFILE = {
    aurora: { title: 'blur-chars', dur: 1, ease: 'expo.out', stagger: 0.07, card: [{ opacity: 0, y: 34, filter: 'blur(10px)' }, { opacity: 1, y: 0, filter: 'blur(0px)' }] },
    classic: { title: 'rise-words', dur: 0.65, ease: 'power3.out', stagger: 0.045, card: [{ opacity: 0, y: 16 }, { opacity: 1, y: 0 }] },
    lumen: { title: 'shine-chars', dur: 0.8, ease: 'expo.out', stagger: 0.04, card: [{ opacity: 0, scale: 0.975, filter: 'blur(6px)' }, { opacity: 1, scale: 1, filter: 'blur(0px)' }] },
    bento: { title: 'pop-words', dur: 0.76, ease: 'expo.out', stagger: 0.055, card: [{ opacity: 0, y: 44, scale: 0.9 }, { opacity: 1, y: 0, scale: 1 }] },
    folio: { title: 'mask-words', dur: 0.95, ease: 'power4.inOut', stagger: 0.085, card: [{ clipPath: 'inset(0% 100% 0% 0%)', opacity: 0.2 }, { clipPath: 'inset(0% 0% 0% 0%)', opacity: 1 }] },
    brut: { title: 'slam-words', dur: 0.55, ease: 'power4.out', stagger: 0.05, card: [{ clipPath: 'inset(0% 100% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)' }] },
    ticket: { title: 'pop-words', dur: 0.8, ease: 'expo.out', stagger: 0.06, card: [{ opacity: 0, y: 36, rotation: -2.5 }, { opacity: 1, y: 0, rotation: 0 }] },
    skywave: { title: 'blur-chars', dur: 0.9, ease: 'expo.out', stagger: 0.05, card: [{ opacity: 0, y: 26, scale: 0.97, filter: 'blur(8px)' }, { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }] },
    console: { title: 'scramble', dur: 0.45, ease: 'steps(5)', stagger: 0.06, card: [{ opacity: 0 }, { opacity: 1 }] },
    terminal: { title: 'scramble', dur: 0.42, ease: 'steps(7)', stagger: 0.05, card: [{ clipPath: 'inset(0% 0% 100% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)' }] },
  };
  const prof = () => PROFILE[style()] || PROFILE.skywave;
  const CSS_SCROLL = !!(window.CSS && CSS.supports && CSS.supports('animation-timeline: view()'));
  // with CSS scroll motion, GSAP must not touch transform at all: reading it would fold the CSS translate / scale into an inline transform
  const CLEAR = CSS_SCROLL ? 'opacity,filter,clipPath' : 'transform,opacity,filter,clipPath';
  // phones and "light" get the same idea with less work: no blur, shorter, smaller moves
  const card = () => {
    const p = prof(); let [a, b] = p.card;
    // phones: the same character without blur (blur is the costly part), and a clear rise so it is actually seen
    if (!full()) { a = Object.assign({}, a); b = Object.assign({}, b); delete a.filter; delete b.filter; if (a.y || a.y === 0 || a.opacity === 0) { a.y = 26; b.y = 0; } }
    // where kinetic.css moves cards with the scroll (translate / scale on the compositor), GSAP only fades them, so the two never fight over the same box
    if (CSS_SCROLL) { const strip = o => { o = Object.assign({}, o); ['y', 'x', 'scale', 'rotation', 'yPercent'].forEach(k => delete o[k]); return o; }; a = strip(a); b = strip(b); if (!('opacity' in a) && !('clipPath' in a)) a.opacity = 0; if (!('opacity' in b) && !('clipPath' in b)) b.opacity = 1; }
    return { from: a, to: Object.assign({}, b, { duration: full() ? p.dur : Math.min(0.7, Math.max(0.55, p.dur)), ease: p.ease, clearProps: CLEAR }), stagger: full() ? p.stagger : Math.max(0.06, p.stagger) };
  };
  const capped = s => i => Math.min(i, 10) * s;          // long lists: the first ten stagger, the rest arrive together

  // ---------------------------------------------------------------- titles (SplitText; reverted when done, so the DOM stays plain)
  const GLYPHS = '<>/\\[]{}=+*^#%01_-';
  function scramble(el, dur) {
    if (!el || el.children.length || el.dataset.splitting) return;
    const text = el.textContent, n = text.length, t0 = performance.now(); el.dataset.splitting = '1'; el.setAttribute('aria-label', text.trim());
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / dur), done = Math.floor(k * n);
      el.textContent = text.slice(0, done) + [...text.slice(done)].map(c => c === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0]).join('');
      if (k < 1) setTimeout(step, 45); else { el.textContent = text; el.removeAttribute('aria-label'); delete el.dataset.splitting; }
    };
    step();
  }
  function shine(el) {        // one soft light sweep across the title (Lumen)
    el.classList.add('sx-shine');
    G.fromTo(el, { backgroundPosition: '120% 0%' }, { backgroundPosition: '-20% 0%', duration: 1, ease: 'power2.inOut', clearProps: 'backgroundPosition', onComplete: () => el.classList.remove('sx-shine') });
  }
  function title(el) {
    if (!el || !on() || el.children.length || el.dataset.splitting) return;
    const p = prof(), lt = !full();
    if (p.title === 'scramble') { scramble(el, lt ? 380 : 650); return; }
    if (!Split) return;
    const chars = p.title.endsWith('chars'), mask = p.title === 'mask-words';
    const sp = Split.create(el, { type: chars ? 'words,chars' : 'words', mask: mask ? 'words' : undefined, aria: 'auto' });
    const parts = chars ? sp.chars : sp.words;
    el.dataset.splitting = '1';
    let from;
    if (p.title === 'blur-chars') from = { opacity: 0, yPercent: 45, filter: 'blur(14px)' };
    else if (p.title === 'shine-chars') from = { opacity: 0, yPercent: 12, filter: 'blur(8px)' };
    else if (p.title === 'pop-words') from = { opacity: 0, yPercent: 60, scale: 0.6, rotation: -6 };
    else if (mask) from = { yPercent: 110 };
    else if (p.title === 'slam-words') from = { xPercent: -30, opacity: 0, skewX: -12 };
    else from = { opacity: 0, yPercent: 50 };
    if (lt) delete from.filter;
    let done = false;
    const end = () => { if (done) return; done = true; sp.revert(); delete el.dataset.splitting; if (p.title === 'shine-chars' && full()) shine(el); };
    G.from(parts, { ...from, duration: lt ? 0.7 : p.dur + 0.1, ease: p.ease, stagger: chars ? (lt ? 0.026 : 0.034) : (lt ? 0.05 : 0.08), onComplete: end, onInterrupt: end });
    setTimeout(end, 4000);                                       // belt and braces: never leave a title split
  }
  M.title = title; M.scramble = scramble;

  // ---------------------------------------------------------------- entrances and scroll reveals
  const SEL = '.page-head p, .card, .glass, .banner, .hw, .tile, .sat-card, .sensor, .cta, .th-card, .list-opt, details.more, .tbl';
  let ctx = null;
  function topLevel(page) {
    return [...page.querySelectorAll(SEL)].filter(el => { const up = el.parentElement && el.parentElement.closest(SEL); return !(up && page.contains(up)) && el.offsetParent !== null; });
  }
  let io = null;
  function enter(name) {
    if (io) { io.disconnect(); io = null; }
    if (ctx) { ctx.revert(); ctx = null; }
    if (!on() || !ST) return;
    const page = document.getElementById('p-' + name); if (!page) return;
    ctx = G.context(() => {
      title(page.querySelector('.page-head h2'));
      const vh = innerHeight, now = [], later = [];
      topLevel(page).forEach(el => { const r = el.getBoundingClientRect(); (r.top < vh * 1.02 ? now : later).push([el, r]); });
      const c = card();
      if (now.length) {
        const els = now.sort((a, b) => (a[1].top - b[1].top) || (a[1].left - b[1].left)).map(x => x[0]);
        G.fromTo(els, c.from, Object.assign({}, c.to, { delay: c.stagger, stagger: capped(c.stagger) }));
      }
      // below the fold: cards wait just out of sight and rise in as they come onto the screen. An IntersectionObserver
      // (not cached scroll positions) decides, so a card can never stay hidden after the page changes size under it.
      // where the browser can drive this from the scroll itself (kinetic.css: view timelines on the compositor), let it
      if (later.length && !CSS_SCROLL && 'IntersectionObserver' in window) {
        const els = later.map(x => x[0]);
        G.set(els, c.from);
        let q = [], qt = 0;
        const flush = () => { qt = 0; const b = q.filter(el => el.isConnected); q = []; if (b.length) G.to(b, Object.assign({}, c.to, { stagger: capped(c.stagger), overwrite: 'auto' })); };
        io = new IntersectionObserver(ents => ents.forEach(en => { if (!en.isIntersecting) return; io.unobserve(en.target); q.push(en.target); if (!qt) qt = requestAnimationFrame(flush); }),
          { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
        els.forEach(el => io.observe(el));
      }
      // the big page title drifts up and fades as you scroll down: tells you the page moved, costs nothing
      const h2 = page.querySelector('.page-head h2');
      if (h2) G.to(h2, { yPercent: -28, opacity: 0.25, ease: 'none', scrollTrigger: { trigger: h2, start: 'top top+=' + Math.round(innerHeight * 0.12), end: 'bottom top', scrub: 0.4 } });
    }, page);
  }
  M.enter = enter;
  // the shell (player and dock) eases in once, on first load
  function intro() {
    if (!on()) return;
    const lt = !full(), s = style();
    const sb = document.getElementById('soundbar'), tabs = document.getElementById('tabs'), mn = document.getElementById('mnav'), brand = document.querySelector('.brand');
    const off = s === 'aurora' ? { sb: -30, tabs: 40 } : s === 'bento' ? { sb: 60, tabs: -30 } : { sb: 24, tabs: 0 };
    const ease = s === 'terminal' ? 'steps(5)' : 'expo.out';
    const go = (el, y, d) => el && el.offsetParent !== null && G.from(el, { opacity: 0, y, duration: lt ? 0.5 : 1.1, delay: d, ease, clearProps: 'transform,opacity' });
    go(sb, off.sb, 0.12); go(tabs, off.tabs, 0.22); go(mn, 30, 0.2); go(brand, -12, 0.06);
  }

  // ---------------------------------------------------------------- smooth wheel scrolling (Lenis; computers only, phones already scroll with inertia)
  let lenis = null;
  const raf = t => { if (lenis) lenis.raf(t * 1000); };
  const smooth = {
    enable(v) {
      v = !!v && !!Lenis && !!ST;
      if (v && !lenis) {
        lenis = new Lenis({
          lerp: 0.1, smoothWheel: true, syncTouch: false, allowNestedScroll: true,
          // the dial (tunes) and the maps (zoom) take the wheel for themselves; so do sliders, lists and open dialogs
          virtualScroll: e => !(e.event && e.event.defaultPrevented),
          prevent: n => n.id === 'modal-root' || (n.matches && n.matches('input[type=range], select, textarea, [data-smooth-off]')),
        });
        lenis.on('scroll', ST.update);
        lenis.on('scroll', l => { if (l.velocity) ticker.push(l.velocity); });
        G.ticker.add(raf); G.ticker.lagSmoothing(0);
      } else if (!v && lenis) { lenis.destroy(); lenis = null; G.ticker.remove(raf); G.ticker.lagSmoothing(500, 33); }
      root.classList.toggle('sx-smooth', !!lenis);
    },
    top() { if (lenis) lenis.scrollTo(0, { immediate: true, force: true }); },
  };
  M.smooth = smooth;
  M.lenis = () => lenis;
  M.scrollTo = y => { if (lenis) lenis.scrollTo(y, { offset: typeof y === 'number' ? 0 : -90 }); else window.scrollTo(0, typeof y === 'number' ? y : y.getBoundingClientRect().top + scrollY - 90); };

  // ---------------------------------------------------------------- magnetic controls and cursor glow (fine pointers, full motion)
  const MAG = { aurora: ['.btn, .tab, .chip', 0.32, 10], lumen: ['.btn.primary, .soundbar .btn, .th-card', 0.22, 6], classic: ['.btn.primary, .btn.big, .tile', 0.16, 5], skywave: ['.btn.primary, .btn.big, .soundbar .btn', 0.18, 5] };
  const magnet = (() => {
    let cur = null;
    const reset = () => { if (cur) G.to(cur, { x: 0, y: 0, duration: 0.6, ease: 'expo.out', overwrite: 'auto', clearProps: 'transform' }); cur = null; };
    return {
      reset,
      move(e) {
        const m = MAG[style()]; if (!m) { reset(); return; }
        const t = e.target && e.target.closest ? e.target.closest(m[0]) : null;
        if (t !== cur) reset();
        if (!t || t.disabled || t.closest('.glass .band-chips, .hw-tools, .dial-card')) return;
        const r = t.getBoundingClientRect(); if (r.width > 420) return;
        const c = v => Math.max(-m[2], Math.min(m[2], v));
        // measure from the untransformed centre so the pull does not feed back on itself
        const gx = G.getProperty(t, 'x') || 0, gy = G.getProperty(t, 'y') || 0;
        cur = t;
        G.to(t, { x: c((e.clientX - (r.left - gx) - r.width / 2) * m[1]), y: c((e.clientY - (r.top - gy) - r.height / 2) * m[1]), duration: 0.4, ease: 'power3.out', overwrite: 'auto' });
      },
    };
  })();
  // Lumen and Skywave: a large soft light that trails the cursor across the page background
  const glow = (() => {
    let el = null, qx = null, qy = null, shown = false;
    const want = () => full() && mqFine.matches && (style() === 'lumen' || style() === 'aurora');
    return {
      move(e) {
        if (!want()) { this.hide(); return; }
        if (!el) { el = document.createElement('div'); el.className = 'sx-glow'; el.setAttribute('aria-hidden', 'true'); document.body.prepend(el); qx = G.quickTo(el, 'x', { duration: 0.9, ease: 'power3' }); qy = G.quickTo(el, 'y', { duration: 0.9, ease: 'power3' }); }
        if (!shown) { G.set(el, { x: e.clientX, y: e.clientY }); shown = true; el.classList.add('on'); }
        qx(e.clientX); qy(e.clientY);
      },
      hide() { if (el && shown) { el.classList.remove('on'); shown = false; } },
    };
  })();
  if (G) {
    let pq = 0, pe = null;
    document.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse' || !full()) return;
      pe = e; if (pq) return;
      pq = requestAnimationFrame(() => { pq = 0; magnet.move(pe); glow.move(pe); });
    }, { passive: true });
    document.addEventListener('pointerleave', () => { magnet.reset(); glow.hide(); });
    document.addEventListener('pointerdown', e => { magnet.reset(); spark(e); }, true);
  }

  // ---------------------------------------------------------------- Brut: a ticker band whose speed follows how fast you scroll
  const ticker = (() => {
    let el = null, track = null, tw = null, last = '';
    const text = () => { const t = document.getElementById('sb-title'), u = document.getElementById('sb-sub'); return ((t && t._tk) || 'Skywave') + '  \u2733  ' + ((u && u._tk) || '').replace(/\u00a0/g, '').trim(); };
    const fill = () => { const x = text(); if (!track || x === last) return; last = x; track.textContent = ''; for (let i = 0; i < 6; i++) { const sp = document.createElement('span'); sp.textContent = x + '  \u2733  '; if (i) sp.setAttribute('aria-hidden', 'true'); track.appendChild(sp); } };
    return {
      sync() {
        const want = style() === 'brut' && on();
        if (!want) { if (tw) { tw.kill(); tw = null; } if (el) { el.remove(); el = track = null; last = ''; } return; }
        if (!el) { const m = document.getElementById('main'); if (!m) return; el = document.createElement('div'); el.className = 'sx-marquee'; track = document.createElement('div'); track.className = 'sx-mq-track'; el.appendChild(track); m.prepend(el); }
        fill();
        if (full() && !tw) tw = G.to(track, { xPercent: -50, duration: 46, ease: 'none', repeat: -1 });
        if (!full() && tw) { tw.kill(); tw = null; G.set(track, { clearProps: 'transform' }); }
      },
      fill,
      push(v) { if (!tw) return; G.to(tw, { timeScale: (v < 0 ? -1 : 1) * (1 + Math.min(9, Math.abs(v) / 5)), duration: 0.25, overwrite: true }); G.to(tw, { timeScale: 1, duration: 1.2, delay: 0.3 }); },
    };
  })();
  // ---------------------------------------------------------------- Ticket: a little burst of punched-out confetti when a button is pressed
  function spark(e) {
    if (style() !== 'ticket' || !full() || !e.target.closest || !e.target.closest('.btn, .chip, .tab')) return;
    for (let i = 0; i < 8; i++) {
      const d = document.createElement('i'); d.className = 'sx-spark'; d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; document.body.appendChild(d);
      const a = (i / 8) * Math.PI * 2 + Math.random() * 0.5, r = 26 + Math.random() * 22;
      G.to(d, { x: Math.cos(a) * r, y: Math.sin(a) * r, rotation: Math.random() * 180, scale: 0, duration: 0.55, ease: 'power3.out', onComplete: () => d.remove() });
    }
  }

  // ---------------------------------------------------------------- modal entrance, per style
  function modalIn(m) {
    if (RS.feel) return;                                       // feel.js grows dialogs out of the button that opened them
    if (!on() || !m) return;
    const s = style(), lt = !full(), back = m.parentElement;
    let from = { opacity: 0, y: 18, scale: 0.98 }, to = { opacity: 1, y: 0, scale: 1 };
    if (s === 'bento') { from = { opacity: 0, y: 60, scale: 0.92 }; }
    else if (s === 'folio' || s === 'terminal') { from = { clipPath: 'inset(0% 0% 100% 0%)' }; to = { clipPath: 'inset(0% 0% 0% 0%)' }; }
    else if ((s === 'aurora' || s === 'skywave') && !lt) { from = { opacity: 0, y: 26, filter: 'blur(12px)' }; to = { opacity: 1, y: 0, filter: 'blur(0px)' }; }
    G.fromTo(m, from, Object.assign(to, { duration: lt ? 0.32 : s === 'terminal' ? 0.3 : 0.62, ease: s === 'terminal' ? 'steps(6)' : 'expo.out', clearProps: CLEAR }));
    if (back && back.classList.contains('modal-back')) G.from(back, { opacity: 0, duration: lt ? 0.2 : 0.36, ease: 'power1.out', clearProps: 'opacity' });
  }

  // ---------------------------------------------------------------- settings card
  RS.mountMotion = el => {
    if (!el) return;
    const c = M.choice(), lv = M.level(), os = M.osReduce();
    const b = (v, t) => '<button type="button" data-act="mo-set" data-v="' + v + '" aria-pressed="' + (c === v) + '">' + t + '</button>';
    el.innerHTML = '<h3>Motion</h3><div class="sub">Smooth scrolling, animated titles and cards that ease in as you scroll. Full is the default on computers; phones use Light, which skips anything that runs every frame so the radio sound has the phone to itself.</div>' +
      '<div class="seg" role="group" aria-label="Motion">' + b('', 'Automatic') + b('full', 'Full') + b('light', 'Light') + b('off', 'Off') + '</div>' +
      '<div class="small muted" style="margin-top:8px" role="status">' + (os ? 'Your device asks for reduced motion, so animation is off whatever you pick here.' : !G ? 'The animation files did not load, so animation is off.' : 'Now using: ' + (lv === 'full' ? 'Full' : lv === 'light' ? 'Light' : 'Off') + '.') + '</div>';
  };
  M.apply = () => { root.dataset.motion = M.level(); if (!G) return; smooth.enable(full() && mqFine.matches); if (!full()) { glow.hide(); magnet.reset(); } };
  M.set = v => { RS.store.set('motion', v || null); M.apply(); RS.fire('motion'); };
  RS.act['mo-set'] = b => { M.set(b.dataset.v); RS.mountMotion(document.getElementById('st-motion')); if (on()) title(document.querySelector('#p-settings .page-head h2')); };
  try { mqReduce.addEventListener('change', M.apply); mqFine.addEventListener('change', M.apply); } catch (e) { }

  // ---------------------------------------------------------------- wiring
  M.apply();
  if (!G) return;
  let first = true;
  RS.on('page', name => {
    smooth.top();                                               // a page change always starts at the top, even mid-glide
    requestAnimationFrame(() => { if (first) { first = false; intro(); } enter(name); if (lenis) lenis.resize(); });
  });
  // tuning: the big frequency gives a small nudge in the direction you tuned
  let lastF = 0;
  RS.on('local', () => {
    const el = document.querySelector('.page.on .freq'), f = RS.vfo ? RS.vfo() : 0;
    if (el && on() && lastF && f !== lastF && !el.classList.contains('editing')) G.fromTo(el, { x: f > lastF ? -10 : 10, opacity: 0.55 }, { x: 0, opacity: 1, duration: 0.32, ease: 'power3.out', overwrite: 'auto', clearProps: 'transform,opacity' });
    lastF = f;
  });
  RS.on('theme', () => { smooth.enable(full() && mqFine.matches); if (!full()) glow.hide(); ticker.sync(); });
  RS.on('motion', () => ticker.sync());
  let tq = 0; const tick = () => { if (!tq) tq = setTimeout(() => { tq = 0; ticker.fill(); }, 800); };
  RS.on('state', tick); RS.on('local', tick); RS.on('page', tick);
  ticker.sync();
  const mr = document.getElementById('modal-root');
  if (mr) new MutationObserver(ms => ms.forEach(x => x.addedNodes.forEach(n => { if (n.nodeType === 1) modalIn(n.matches('.modal') ? n : n.querySelector('.modal')); }))).observe(mr, { childList: true });
})();
