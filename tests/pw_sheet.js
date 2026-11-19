// Browser test (Playwright): the player card (press the mini player, use the page, pull it down) and pull-to-close dialogs.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-sh-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18098', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, info) => { console.log(c ? 'ok  ' : 'FAIL', n, c ? '' : (info !== undefined ? JSON.stringify(info) : '')); if (!c) ok = false; };
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  // pull a panel down with real-looking touch events
  const pull = (p, sel, dist, ms) => p.evaluate(([sel, dist, ms]) => new Promise(res => {
    const el = document.querySelector(sel), r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + 20;
    const T = (yy) => new Touch({ identifier: 1, target: el, clientX: x, clientY: yy, pageX: x, pageY: yy });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [T(y)], changedTouches: [T(y)], bubbles: true, cancelable: true }));
    let i = 0; const n = 12;
    const step = () => { i++; const yy = y + dist * i / n; el.dispatchEvent(new TouchEvent('touchmove', { touches: [T(yy)], changedTouches: [T(yy)], bubbles: true, cancelable: true }));
      if (i < n) setTimeout(step, ms / n); else { el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [T(yy)], bubbles: true, cancelable: true })); setTimeout(res, 700); } };
    setTimeout(step, ms / n);
  }), [sel, dist, ms]);
  for (const mobile of [true, false]) {
    console.log(mobile ? '--- phone' : '--- desktop');
    const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 860 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(() => localStorage.setItem('rs.motion', '"light"'));
    await p.goto('http://127.0.0.1:18098/#radio'); await p.waitForTimeout(2500);
    await p.click('#sb-play'); await p.waitForTimeout(800);
    await p.evaluate(() => RS.go('settings')); await p.waitForTimeout(600);
    await p.evaluate(() => window.scrollTo(0, 700)); await p.waitForTimeout(300);
    const sy = await p.evaluate(() => scrollY);
    await p.click('#soundbar .now'); await p.waitForTimeout(900);
    const o = await p.evaluate(() => ({ open: RS.playerPageOpen(), page: RS.page, inSheet: !!document.querySelector('.psheet-body #p-radio'), under: document.getElementById('p-settings').classList.contains('on'), y: scrollY }));
    chk('pressing the mini player opens the Radio card', o.open && o.page === 'radio' && o.inSheet, o);
    chk('the page underneath stays on screen, where it was', o.under && Math.abs(o.y - sy) < 2, [o, sy]);
    // the card is live: press a band chip inside it and the radio follows
    const before = await p.evaluate(() => RS.vfo());
    await p.click('.psheet-body #rd-bands button[data-act="rd-band"]:not([aria-pressed="true"])'); await p.waitForTimeout(900);
    const after = await p.evaluate(() => RS.vfo());
    chk('the card is usable: a band chip retunes the radio', before !== after, [before, after]);
    chk('the dial is drawn inside the card', await p.evaluate(() => { const c = document.querySelector('.psheet-body #rd-cv'); return !!c && c.width > 100 && c.getBoundingClientRect().width > 100; }));
    if (mobile) {
      await pull(p, '.psheet-grab', 60, 300); await p.waitForTimeout(200);
      chk('a short pull springs back', await p.evaluate(() => RS.playerPageOpen()));
      await pull(p, '.psheet-grab', 420, 260);
    } else {
      await p.click('.psheet-x'); await p.waitForTimeout(800);
    }
    const c = await p.evaluate(() => ({ open: RS.playerPageOpen(), page: RS.page, back: !!document.querySelector('main #p-radio'), y: scrollY, hash: location.hash }));
    chk('pulled down / closed: back on Settings where it was', !c.open && c.page === 'settings' && c.back && Math.abs(c.y - sy) < 2 && c.hash === '#settings', [c, sy]);
    chk('sound kept playing throughout', await p.evaluate(() => RS.audio.on));
    // back gesture closes the card
    await p.click('#soundbar .now'); await p.waitForTimeout(800);
    await p.goBack(); await p.waitForTimeout(900);
    chk('the back gesture closes the card', await p.evaluate(() => !RS.playerPageOpen() && RS.page === 'settings'));
    // navigating from inside the card goes there
    await p.click('#soundbar .now'); await p.waitForTimeout(800);
    await p.evaluate(() => RS.go('planes')); await p.waitForTimeout(800);
    const g = await p.evaluate(() => ({ open: RS.playerPageOpen(), page: RS.page, inMain: !!document.querySelector('main #p-radio'), under: !!document.querySelector('.under-sheet'), hash: location.hash }));
    chk('going to another page from the card lands there cleanly', !g.open && g.page === 'planes' && g.inMain && !g.under, g);
    if (mobile) {
      // More: a bottom card that can be pulled down
      await p.click('[data-act="moreMenu"]'); await p.waitForTimeout(700);
      chk('More opens as a card', await p.evaluate(() => !!document.querySelector('#modal-root .modal.is-sheet')));
      await pull(p, '#modal-root .modal', 420, 260);
      chk('More pulls down to close', await p.evaluate(() => !document.querySelector('#modal-root .modal') && !document.querySelector('.modal-back')));
      await p.click('[data-act="moreMenu"]'); await p.waitForTimeout(700);
      await p.evaluate(() => RS.closeModal()); await p.waitForTimeout(600);
      chk('closing More slides it away and leaves nothing behind', await p.evaluate(() => !document.querySelector('.modal-back')));
    }
    chk('no page errors', errs.length === 0, errs);
    await ctx.close();
  }
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
