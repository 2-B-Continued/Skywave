// Motion layer checks (simulator): levels per device, titles always revert to plain text, cards finish fully visible,
// smooth wheel scrolling glides and stops, the dial still owns its wheel, reduced motion turns everything off, the Settings card works.
// NODE_PATH=$(npm root -g) node tests/pw_motion.js   (SHOTS=/tmp/mo for mid-animation screenshots)
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const PORT = 18131, SHOTS = process.env.SHOTS || '';
const STYLES = (process.env.STYLES || 'skywave,depth,relief,walnut,riot,bento,folio,terminal,brut,ticket').split(',');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } };
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: String(PORT), DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1', LAT: '-33.92', LON: '18.42' } });
  await new Promise(r => setTimeout(r, 4000));
  const b = await chromium.launch();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const open = async (style, opts = {}) => {
    const ctx = await b.newContext(Object.assign(opts.mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 860 } }, opts.reduce ? { reducedMotion: 'reduce' } : {}));
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/WebSocket|favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });
    await p.addInitScript(([s, mo]) => { try { localStorage.setItem('rs.styleid', JSON.stringify(s)); if (mo) localStorage.setItem('rs.motion', JSON.stringify(mo)); } catch (e) { } }, [style, opts.motion || '']);
    await p.goto('http://127.0.0.1:' + PORT + '/#' + (opts.page || 'home'));
    return { ctx, p, errs };
  };
  for (const style of STYLES) {
    for (const mobile of [false, true]) {
      const { ctx, p, errs } = await open(style, { mobile });
      await p.waitForTimeout(350);
      if (SHOTS) await p.screenshot({ path: `${SHOTS}/${style}-${mobile ? 'm' : 'd'}-mid.png` });
      await p.waitForTimeout(2600);
      const lv = await p.evaluate(() => document.documentElement.dataset.motion);
      ok(lv === (mobile ? 'light' : 'full'), `${style} ${mobile ? 'phone' : 'desktop'} level is ${lv}`);
      for (const pg of ['home', 'radio', 'settings', 'space']) {
        await p.evaluate(x => RS.go(x), pg); await p.waitForTimeout(2600);
        const r = await p.evaluate(() => {
          const pg = document.querySelector('.page.on'), h = pg.querySelector('.page-head h2');
          const vis = [...pg.querySelectorAll('.card, .hw, .tile, .glass')].filter(e => { const r = e.getBoundingClientRect(); return e.offsetParent && r.top < innerHeight && r.bottom > 0; });
          const faded = vis.filter(e => { const cs = getComputedStyle(e); return parseFloat(cs.opacity) < 0.99 || (cs.clipPath && cs.clipPath !== 'none' && /inset/.test(cs.clipPath)); }).length;
          const running = document.getAnimations().filter(a => a.playState === 'running' && (!a.timeline || a.timeline instanceof DocumentTimeline) && a.effect && a.effect.getComputedTiming().iterations !== Infinity).length + (window.gsap ? gsap.globalTimeline.getChildren(true, true, false).filter(t => t.isActive() && t.repeat() !== -1).length : 0);
          const inlineEls = vis.filter(e => /opacity|transform|filter|clip-path/.test(e.getAttribute('style') || '')); const inline = inlineEls.length; const inlineWhat = inlineEls.slice(0, 2).map(e => e.className + ' => ' + e.getAttribute('style'));
          return { inline, inlineWhat, libs: !!(window.gsap && window.ScrollTrigger && window.SplitText && window.Lenis), split: h ? h.querySelectorAll('span, div').length : 0, aria: h ? h.getAttribute('aria-label') : null, text: h ? h.textContent : '', faded, running, ov: document.documentElement.scrollWidth - innerWidth };
        });
        ok(r.split === 0 && !r.aria, `${style} ${pg} title left split: ${JSON.stringify(r)}`);
        ok(r.faded === 0, `${style} ${pg} ${r.faded} cards left faded`);
        ok(r.running === 0, `${style} ${pg} ${r.running} finite animations still running after 2.6s`);
        ok(r.libs, `${style} ${pg} libraries loaded`);
        ok(r.inline === 0, `${style} ${pg} ${r.inline} cards keep inline animation styles ${JSON.stringify(r.inlineWhat)}`);
        ok(r.ov <= 1, `${style} ${pg} horizontal overflow ${r.ov}`);
      }
      // modal opens and ends fully visible
      if (!mobile) {
        await p.evaluate(() => RS.modal('<h2>Test</h2><p>hello</p><button class="btn" data-act="closeModal">Close</button>')); await p.waitForTimeout(1400);
        const mo = await p.evaluate(() => { const m = document.querySelector('.modal'); const cs = getComputedStyle(m); return { o: cs.opacity, c: cs.clipPath }; });
        ok(parseFloat(mo.o) > 0.99, `${style} modal opacity ${mo.o}`); await p.evaluate(() => RS.closeModal());
      }
      ok(!errs.length, `${style} ${mobile ? 'phone' : 'desktop'} errors: ${errs.join(' | ')}`);
      await ctx.close();
    }
  }
  // smooth scrolling (Lenis): glides over several frames, lands on target, and does not hijack the dial
  {
    const { ctx, p, errs } = await open('skywave', { page: 'settings' }); await p.waitForTimeout(2500);
    await p.mouse.move(12, 500);
    const t = await p.evaluate(async () => {
      window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 200));
      const L = RS.motion.lenis();
      document.elementFromPoint(12, 500).dispatchEvent(new WheelEvent('wheel', { deltaY: 600, bubbles: true, cancelable: true, clientX: 12, clientY: 500 }));
      const right = { y: scrollY, smooth: L && L.isScrolling, target: L && L.targetScroll };
      await new Promise(r => setTimeout(r, 1500));
      return { right, end: scrollY, lerp: L && L.options.lerp };
    });
    ok(t.right.smooth === 'smooth' && t.right.y < 5 && t.right.target === 600, 'wheel starts a Lenis glide rather than a jump: ' + JSON.stringify(t.right));
    ok(t.end > 590 && t.end < 610, 'smooth scroll lands on 600: ' + t.end);
    // real mouse wheel through Playwright
    await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(150);
    await p.mouse.wheel(0, 400); await p.waitForTimeout(1200);
    const y2 = await p.evaluate(() => scrollY); ok(y2 > 350, 'mouse wheel scrolls the page: ' + y2);
    // dial keeps its wheel
    await p.evaluate(() => RS.go('radio')); await p.waitForTimeout(1500);
    const dial = await p.evaluate(() => { const c = document.querySelector('#p-radio canvas'); c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await p.waitForTimeout(300);
    const y0 = await p.evaluate(() => scrollY); const f0 = await p.evaluate(() => RS.vfo());
    await p.mouse.move(dial.x, dial.y); await p.mouse.wheel(0, 120); await p.waitForTimeout(900);
    const y1 = await p.evaluate(() => scrollY); const f1 = await p.evaluate(() => RS.vfo());
    ok(Math.abs(y1 - y0) < 2, `wheel on the dial scrolled the page ${y0} -> ${y1}`);
    ok(f1 !== f0, 'wheel on the dial still tunes');
    // a page change mid-glide jumps to the top and stays there
    await p.evaluate(() => RS.go('settings')); await p.waitForTimeout(800); await p.mouse.move(640, 400);
    await p.mouse.wheel(0, 1500); await p.waitForTimeout(60); await p.evaluate(() => RS.go('space')); await p.waitForTimeout(900);
    const y3 = await p.evaluate(() => scrollY); ok(y3 < 3, 'page change stops the glide: ' + y3);
    // settings card switches levels
    await p.evaluate(() => RS.go('settings')); await p.waitForTimeout(800);
    await p.click('#st-motion [data-v="off"]'); let lv = await p.evaluate(() => document.documentElement.dataset.motion); ok(lv === 'off', 'Settings Off -> ' + lv);
    await p.click('#st-motion [data-v="light"]'); lv = await p.evaluate(() => document.documentElement.dataset.motion); ok(lv === 'light', 'Settings Light -> ' + lv);
    const sm = await p.evaluate(() => document.documentElement.classList.contains('sx-smooth') || document.documentElement.classList.contains('lenis')); ok(!sm, 'Light turns smooth scrolling off');
    await p.click('#st-motion [data-v=""]'); lv = await p.evaluate(() => document.documentElement.dataset.motion); ok(lv === 'full', 'Settings Automatic on desktop -> ' + lv);
    ok(!errs.length, 'scroll test errors: ' + errs.join(' | '));
    await ctx.close();
  }
  // reduced motion: off, nothing animates, no smooth scroll
  {
    const { ctx, p, errs } = await open('skywave', { reduce: true }); await p.waitForTimeout(400);
    const r = await p.evaluate(() => ({ lv: document.documentElement.dataset.motion, anims: document.getAnimations().length + gsap.globalTimeline.getChildren(true, true, false).filter(x => x.isActive()).length, sm: document.documentElement.classList.contains('lenis') }));
    ok(r.lv === 'off' && r.anims === 0 && !r.sm, 'reduced motion: ' + JSON.stringify(r));
    ok(!errs.length, 'reduced errors: ' + errs.join(' | '));
    await ctx.close();
  }
  await b.close(); srv.kill();
  console.log(fails ? 'FAILED ' + fails : 'PASS'); process.exit(fails ? 1 : 0);
})();
