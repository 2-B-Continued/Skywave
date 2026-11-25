// Home hero: the live waterfall draws, its Pause button stops it, the live numbers show, and with reduced motion nothing
// animates (no entrance, no scrolling waterfall, no Pause button) while every word is still there.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18135', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n, c ? '' : JSON.stringify(x)); ok = ok && !!c; };
  const b = await chromium.launch();
  const snap = p => p.evaluate(() => { const c = document.getElementById('ho-wf'); return Array.from(c.getContext('2d').getImageData(0, 0, c.width, 30).data.filter((_, i) => i % 4 === 3)).join(','); });
  // full motion
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:18135/#home'); await p.waitForTimeout(3500);
  const a = await snap(p); await p.waitForTimeout(800); const b2 = await snap(p);
  chk('waterfall is drawing and moving', a !== b2 && /[1-9]/.test(b2));
  chk('headline names what is tuned', /MHz|[A-Za-z]/.test(await p.textContent('#ho-t1')));
  chk('four live numbers', (await p.$$('#ho-stats .ho-stat')).length === 4);
  chk('pause button offered', await p.isVisible('#ho-wf-pause'));
  await p.click('#ho-wf-pause'); await p.waitForTimeout(400);
  const c1 = await snap(p); await p.waitForTimeout(900); const c2 = await snap(p);
  chk('paused waterfall stands still', c1 === c2);
  chk('button now offers to play', /Play/.test(await p.textContent('#ho-wf-pause')));
  await p.click('#ho-wf-pause');
  chk('entrance pieces end fully visible', await p.evaluate(() => [...document.querySelectorAll('#ho-now .ho-ap')].every(e => getComputedStyle(e).opacity === '1')));
  // reduced motion
  const q = await (await b.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })).newPage(); q.on('pageerror', e => errs.push(e.message));
  await q.goto('http://127.0.0.1:18135/#home'); await q.waitForTimeout(3500);
  chk('reduced motion: no entrance animations', await q.evaluate(() => !document.getElementById('ho-now').getAnimations({ subtree: true }).some(x => x.playState === 'running')));
  chk('reduced motion: no pause button (nothing moves)', !(await q.isVisible('#ho-wf-pause')));
  const r1 = await snap(q); await q.waitForTimeout(1200); const r2 = await snap(q);
  chk('reduced motion: waterfall is a still picture', r1 === r2 && /[1-9]/.test(r1));
  chk('reduced motion: words all visible', await q.evaluate(() => [...document.querySelectorAll('#ho-now .ho-ap')].every(e => getComputedStyle(e).opacity === '1')));
  chk('phone: no sideways scrolling', !(await q.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)));
  chk('no page errors', !errs.length, errs);
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
