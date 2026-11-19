// The shared motion rules (static/js/feel.js): presses at 0.97, dialogs out of their button and back 20% quicker,
// a saved station flying on an arc, one highlight moving between passes, rubber band at the band's end, sections that
// settle as they open, colour masks, and nothing at all with Motion Off. Run: node tests/pw_feel.js
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const mock = require('./space_mock.js');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'feel-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18140', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1', LAT: '-33.92', LON: '18.42' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, x === undefined ? '' : JSON.stringify(x)); if (!c) ok = false; };
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(() => localStorage.setItem('rs.motion', '"full"'));
  await mock(p);
  await p.goto('http://127.0.0.1:18140/#radio'); await p.waitForTimeout(3000);
  // press
  await p.evaluate(() => document.getElementById('rd-sleep').scrollIntoView({ block: 'center' })); await p.waitForTimeout(200);
  const btn = await p.$('#rd-sleep'); const bb = await btn.boundingBox();
  await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await p.mouse.down(); await p.waitForTimeout(250);
  const sc = await p.waitForFunction(() => getComputedStyle(document.getElementById('rd-sleep')).scale === '0.97', null, { timeout: 800 }).then(() => '0.97').catch(() => p.$eval('#rd-sleep', e => getComputedStyle(e).scale));
  chk('a pressed button scales to 0.97', sc === '0.97', sc);
  await p.mouse.up(); await p.waitForTimeout(80);
  // dialog from its trigger
  const m = await p.evaluate(() => { const el = document.querySelector('#modal-root .modal'); return el && { o: el.style.transformOrigin, a: el.getAnimations().length }; });
  chk('the dialog grows out of the button that opened it', m && m.o && m.a > 0, m);
  // the close animation's own length (wall time on a software-rendered test browser adds slow frames)
  await p.keyboard.press('Escape'); await p.waitForTimeout(30);
  const dt = await p.evaluate(() => { const b = document.querySelector('body > .modal-back'), m = b && b.querySelector('.modal'); const as = m ? m.getAnimations() : [], a = as[as.length - 1]; return a ? a.effect.getTiming().duration : -1; });
  await p.waitForFunction(() => !document.querySelector('body > .modal-back'), null, { timeout: 2000 });
  chk('and closes back into it, quicker than it opened (about 200 ms)', dt > 0 && dt <= 220, dt);
  // save: the station flies on an arc to Your stations
  await p.evaluate(() => RS.tune(100.0e6, { mode: 'wfm' })); await p.waitForTimeout(1200);
  await p.click('#rd-star');
  const fly = await p.waitForSelector('.kx-fly', { timeout: 2500 }).then(() => true).catch(() => false);
  chk('a saved station flies to Your stations', fly);
  await p.waitForTimeout(1200);
  chk('and lands there', (await p.$$('#rd-favs .rdp-preset[data-k]')).length >= 1);
  // tuner: rubber band past the start of FM
  await p.evaluate(() => { RS.act['rd-band']({ dataset: { id: 'fm' } }); RS.tune(87.6e6, { mode: 'wfm' }); }); await p.waitForTimeout(1200);
  await p.evaluate(() => document.getElementById('rd-cv').scrollIntoView({ block: 'center' })); await p.waitForTimeout(200);
  const cb = await (await p.$('#rd-cv')).boundingBox(), y = cb.y + cb.height - 30;
  await p.mouse.move(cb.x + cb.width / 2, y); await p.mouse.down();
  for (let i = 1; i <= 12; i++) { await p.mouse.move(cb.x + cb.width / 2 + i * 40, y); await p.waitForTimeout(30); }
  const during = await p.evaluate(() => RS.pages.radio.dial.shown());
  const lo = await p.evaluate(() => RS.pages.radio.dial.band.lo);
  chk('dragging past the band start rubber-bands (a fifth of the pull)', during < lo && lo - during < 0.6e6, [during, lo]);
  await p.waitForTimeout(200); await p.mouse.up(); await p.waitForTimeout(600);
  chk('and springs back to the band', await p.evaluate(() => RS.pages.radio.dial.shown() >= RS.pages.radio.dial.band.lo));
  // list tab: old and new overlap, one highlight
  await p.click('[data-rd-tab="songs"]'); await p.waitForTimeout(60);
  chk('switching lists cross-fades (old on top while new arrives)', await p.evaluate(() => [...document.body.children].some(c => c.style && c.style.position === 'fixed' && c.classList.contains('rdp-list'))));
  // space: one ring moves between passes
  await p.evaluate(() => RS.go('space')); await p.waitForTimeout(2500);
  const k = await p.$$eval('#sp-tl .spx-pass', l => l[4].dataset.k);
  await p.click('#sp-tl .spx-pass[data-k="' + k + '"]'); await p.waitForTimeout(60);
  chk('the chosen-pass ring is one element that moves', await p.evaluate(() => { const m = document.querySelectorAll('#sp-tl > .kx-mark.ring'); return m.length === 1 && m[0].getAnimations().length > 0; }));
  // a section opening settles in
  await p.click('#sp-sats details summary');
  const st = await p.evaluate(() => new Promise(res => setTimeout(() => res([...document.querySelectorAll('#sp-sats details[open] .spx-sat-b > *')].map(e => { const a = e.getAnimations()[0]; return a ? a.effect.getTiming().delay : null; })), 20)));
  chk('an opened section staggers its contents, 30 ms apart', st.length > 1 && st[0] === 0 && st[1] === 30, st);
  // the pill in a segmented control stretches as it moves
  await p.click('[data-act="sp-hours"][data-h="48"]'); await p.waitForTimeout(60);
  chk('the segmented pill moves with a stretch', await p.evaluate(() => { const pl = document.querySelector('.spx-hours > .kx-pill'); const a = pl && pl.getAnimations()[0]; if (!a) return false; const k = a.effect.getKeyframes(); return k.length === 3 && parseFloat(k[1].width) > parseFloat(k[2].width) * 1.05; }));
  // Motion Off: nothing moves
  await p.evaluate(() => RS.act['mo-set']({ dataset: { v: 'off' } })); await p.waitForTimeout(900);     // as Settings does; earlier moves finish
  await p.click('[data-act="sp-hours"][data-h="24"]'); await p.waitForTimeout(60);
  await p.click('#sp-tl .spx-pass[data-k="' + k + '"]'); await p.waitForTimeout(60);
  const run = await p.evaluate(() => document.getAnimations().filter(a => a.playState === 'running' && !(a instanceof CSSAnimation) && !(a instanceof CSSTransition)).map(a => (a.effect && a.effect.target && (a.effect.target.id || a.effect.target.className)) || '?'));
  chk('with Motion Off the new rules move nothing', run.length === 0, run);
  chk('no page errors', errs.length === 0, errs);
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
