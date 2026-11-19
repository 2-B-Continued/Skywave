// Sensors survey: start, list builds, lock on shows live spectrum, decode returns to sensors, leaving stops the sweep.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18109', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, x === undefined ? '' : JSON.stringify(x)); if (!c) ok = false; };
  const b = await chromium.launch();
  for (const mobile of [false, true]) {
    console.log(mobile ? '--- mobile' : '--- desktop');
    const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://127.0.0.1:18109/#explore'); await p.waitForTimeout(2500);
    chk('survey card', await p.isVisible('#sv-card'));
    await p.evaluate(() => { const s = document.getElementById('sv-r'); s.insertAdjacentHTML('beforeend', '<option value="86,92">test</option>'); s.value = '86,92'; });
    await p.click('#sv-go'); await p.waitForTimeout(1500);
    chk('job is sweep and stays', await p.evaluate(() => RS.st.job === 'sweep'), await p.evaluate(() => RS.st.job));
    await p.waitForFunction(() => RS.pages.explore.svy.sig.length > 0, null, { timeout: 60000 });
    chk('rows listed', (await p.$$('#sv-rows tr')).length > 0);
    await p.waitForTimeout(1500);
    chk('job still sweep after state updates', await p.evaluate(() => RS.st.job === 'sweep'));
    if (!mobile) await p.screenshot({ path: '/tmp/survey-d.png' });
    await p.click('#sv-rows tr button'); await p.waitForTimeout(3500);
    chk('lock panel', await p.isVisible('#sv-cv'));
    chk('level text', (await p.textContent('#sv-lv')).match(/dB/) != null, await p.textContent('#sv-lv'));
    if (!mobile) await p.screenshot({ path: '/tmp/survey-lock.png' });
    await p.click('[data-act="sv-decode"]'); await p.waitForTimeout(2500);
    chk('back to sensors job', await p.evaluate(() => RS.st.job === 'ism' || RS.st.job === 'listen'), await p.evaluate(() => RS.st.job));
    await p.evaluate(() => RS.go('explore')); await p.waitForTimeout(1500); await p.click('#sv-go'); await p.waitForTimeout(1500);   // decoding opened Sensors
    await p.evaluate(() => RS.go('radio')); await p.waitForTimeout(2000);
    chk('leaving stops survey', await p.evaluate(() => RS.st.job === 'listen'), await p.evaluate(() => RS.st.job));
    chk('no page errors', errs.length === 0, errs); await ctx.close();
  }
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
