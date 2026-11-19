// Ships page: tracks AIS on entry, lists and maps vessels, stops listening on leaving. Digital page is gone; coverage is in Settings.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18108', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1', LAT: '-33.92', LON: '18.42' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, x === undefined ? '' : JSON.stringify(x)); if (!c) ok = false; };
  const b = await chromium.launch();
  for (const mobile of [false, true]) {
    console.log(mobile ? '--- mobile' : '--- desktop');
    const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://127.0.0.1:18108/#ships'); await p.waitForTimeout(2500);
    chk('tap ais started on entering', await p.evaluate(() => RS.st.tap === 'ais'), await p.evaluate(() => RS.st.tap));
    await p.waitForTimeout(30000);
    const n = await p.evaluate(() => RS.pages.ships.list.length); chk('ships heard', n > 0, n);
    chk('rows listed', (await p.$$('#sh-rows tr')).length > 0);
    const row = await p.$('#sh-rows tr'); if (row) { await row.click(); await p.waitForTimeout(400); chk('selection card shown', await p.isVisible('#sh-sel')); }
    chk('map canvas', await p.isVisible('#sh-map canvas'));
    await p.click('#sh-fit'); await p.waitForTimeout(300);
    await p.evaluate(() => RS.go('radio')); await p.waitForTimeout(1500);
    chk('ais stopped on leaving', await p.evaluate(() => RS.st.tap == null), await p.evaluate(() => RS.st.tap));
    chk('no Digital page', await p.evaluate(() => !RS.pages.digital && !document.querySelector('[data-tab="digital"]')));
    await p.evaluate(() => RS.go('settings')); await p.waitForTimeout(500);
    const rows = await p.$$('#st-cover tbody tr'); chk('coverage table in Settings', rows.length >= 8, rows.length);
    chk('no "Not possible" or DVB-T', !(await p.evaluate(() => document.getElementById('st-cover').textContent)).match(/Not possible|DVB|TETRA|POCSAG/i));
    if (!mobile) await p.screenshot({ path: '/tmp/ships-d.png', fullPage: false });
    chk('no page errors', errs.length === 0, errs); await ctx.close();
  }
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
