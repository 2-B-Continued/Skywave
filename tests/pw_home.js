// Home: now panel, next up (passes can be recorded), around you (plane radar tracks and keeps tracking while on Home),
// tiles can be chosen and reordered, go to a frequency. Run: node tests/pw_home.js
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const mock = require('./space_mock.js');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18103', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1', LAT: '-33.92', LON: '18.42' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, x === undefined ? '' : JSON.stringify(x)); if (!c) ok = false; };
  const b = await chromium.launch();
  for (const mobile of [false, true]) {
    console.log(mobile ? '--- mobile' : '--- desktop');
    const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    const posts = []; p.on('request', r => { if (r.method() === 'POST') posts.push(r.url()); });
    await mock(p);
    await p.goto('http://127.0.0.1:18103/#home'); await p.waitForTimeout(2500);
    await p.evaluate(() => RS.setPref('home_tiles', ['planes', 'sky', 'sensors', 'scanner', 'ships', 'picture', 'recordings'])); await p.waitForTimeout(800);
    chk('now panel names what is tuned', /MHz|[A-Za-z]/.test(await p.textContent('#ho-title')), await p.textContent('#ho-title'));
    chk('tiles render', (await p.$$('#ho-tiles .ho-tile')).length === 7);
    chk('next up lists passes', (await p.$$('#ho-agenda .ho-ag')).length >= 3, (await p.$$('#ho-agenda .ho-ag')).length);
    const rec = await p.$$('[data-act="ho-pass-rec"]'); chk('record buttons on passes', rec.length >= 1, rec.length);
    if (rec.length) { await rec[0].click(); await p.waitForTimeout(800); chk('schedule request sent', posts.some(u => /space\/schedule/.test(u)), posts.slice(-3)); }
    // planes from Home
    await p.click('[data-act="ho-planes-start"]'); await p.waitForTimeout(9000);
    chk('job is adsb and stays adsb on Home', await p.evaluate(() => RS.st.job === 'adsb'), await p.evaluate(() => RS.st.job));
    chk('planes counted on the tile', /\d/.test(await p.textContent('.ho-tile[data-id="planes"] .ho-big')));
    chk('radar canvas drawn', await p.evaluate(() => { const c = document.querySelector('.ho-radar-cv'); return !!c && c.width > 50; }));
    chk('now panel says tracking aircraft', /aircraft/.test(await p.textContent('#ho-title')));
    await p.click('[data-act="ho-back"]'); await p.waitForTimeout(1500);
    chk('back to the radio', await p.evaluate(() => RS.st.job === 'listen'));
    // choose tiles
    await p.click('[data-act="ho-custom"]'); await p.waitForTimeout(400);
    await p.click('[data-act="ho-opt"][data-id="ships"]'); await p.waitForTimeout(300);
    await p.click('[data-act="ho-move"][data-id="sensors"][data-d="-1"]'); await p.waitForTimeout(300);
    await p.click('[data-act="ho-done"]'); await p.waitForTimeout(500);
    const ids = await p.$$eval('#ho-tiles .ho-tile', l => l.map(e => e.dataset.id));
    chk('ships hidden and sensors moved earlier', !ids.includes('ships') && ids.indexOf('sensors') < ids.indexOf('sky'), ids);
    // go to a frequency
    await p.fill('#ho-go-in', '98.5'); await p.press('#ho-go-in', 'Enter'); await p.waitForTimeout(800);
    chk('go to 98.5 opens the radio there', await p.evaluate(() => RS.page === 'radio' && Math.abs(RS.vfo() - 98.5e6) < 1e3), await p.evaluate(() => [RS.page, RS.vfo()]));
    await p.evaluate(() => RS.go('home')); await p.waitForTimeout(800);
    chk('no page errors', errs.length === 0, errs);
    await ctx.close();
  }
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
