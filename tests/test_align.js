// Alignment maths against known values (a southern-hemisphere site -> geostationary satellites) and the live Space page card.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'al-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18102', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:18102/healthz'); break; } catch (e) { await new Promise(r => setTimeout(r, 250)); } }
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1100, height: 800 } })).newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:18102/#space'); await p.waitForTimeout(2500);
  let ok = true; const chk = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, x === undefined ? '' : JSON.stringify(x)); if (!c) ok = false; };
  const r = await p.evaluate(() => ({
    a: RS.align.geo(-33.92, 18.42, 28), b: RS.align.geo(0, 0, 0), c: RS.align.geo(51.5, 0, 0), d: RS.align.geo(40, -100, -100), e: RS.align.geo(0, 0, 180)
  }));
  chk('equator below satellite: el 90', Math.abs(r.b.el - 90) < 0.01, r.b);
  chk('London to 0E: az 180, el ~31', Math.abs(r.c.az - 180) < 0.01 && Math.abs(r.c.el - 31.4) < 0.5, r.c);
  chk('same longitude northern: az 180, skew 0', Math.abs(r.d.az - 180) < 0.01 && Math.abs(r.d.skew) < 0.01, r.d);
  chk('far side of earth: below horizon', r.e.up === false, r.e);
  chk('south of the equator to 28E: north-east-ish, high', r.a.az > 0 && r.a.az < 90 && r.a.el > 45, r.a);
  await p.evaluate(() => { const w = document.getElementById('sp-aim-wrap'); if (w) w.open = true; });   // the card lives in a closed section
  await p.waitForSelector('#aim-card', { state: 'visible', timeout: 5000 }); await p.waitForTimeout(2500);
  chk('card present', (await p.$$('#aim-sat option')).length > 0);
  await p.evaluate(() => { RS.align.sky = [{ id: 'iss', short: 'ISS', az: 123.4, el: 45.6, up: true, range_km: 500 }]; RS.align.sat = 'iss'; RS.align.mode = 'leo'; document.getElementById('aim-mode').value = 'leo'; document.getElementById('aim-mode').dispatchEvent(new Event('change')); });
  await p.waitForTimeout(300);
  chk('leo readout', /123\.4/.test(await p.innerText('#aim-out')), (await p.innerText('#aim-out')).slice(0, 80));
  chk('southern skew sane', await p.evaluate(() => Math.abs(RS.align.geo(-33.92, 18.42, 28).skew) < 90));
  await p.selectOption('#aim-mode', 'geo'); await p.fill('#aim-lon', '156'); await p.waitForTimeout(300);
  chk('geo readout shows', /Geostationary satellite at 156/.test(await p.innerText('#aim-out')), (await p.innerText('#aim-out')).slice(0, 120));
  chk('the bearing is explained as from true north', /true north/.test(await p.innerText('#aim-out')));
  chk('no phone compass button', !(await p.$('#aim-sens')));
  chk('no page errors', errs.length === 0, errs);
  await p.screenshot({ path: '/tmp/aim.png' }); await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
