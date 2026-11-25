// The page follows the chosen country: Radio's FM and AM bands, the walkie-talkie button, Explore's band buttons, the
// Ham bands, AM steps and the sensor band all change with the region. The setup form lists every country.
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const PORT = 18183, base = 'http://127.0.0.1:' + PORT;
const fails = []; const chk = (n, ok, info) => { console.log((ok ? 'ok   ' : 'FAIL ') + n + (ok ? '' : '  ' + JSON.stringify(info))); if (!ok) fails.push(n); };

(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: String(PORT), DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  for (let i = 0; i < 80; i++) { try { await fetch(base + '/healthz'); break; } catch (e) { await new Promise(r => setTimeout(r, 250)); } }
  const setRegion = r => fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ changes: { region: r } }) });
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));

  await setRegion('jp');
  await p.goto(base + '/#radio'); await p.waitForTimeout(2500);
  const jp = await p.evaluate(() => ({ chips: [...document.querySelectorAll('#rd-bands button')].map(x => x.textContent), fm: RS.BANDS.find(x => x.id === 'fm'), step: RS.stepFor('am', 900e3) }));
  chk('Japan: FM band is 76 to 95 MHz', jp.fm.lo === 76e6 && jp.fm.hi === 95e6, jp.fm);
  chk('Japan: walkie-talkie button is the low-power radio', jp.chips.includes('Low-power radio'), jp.chips);
  chk('Japan: AM in 9 kHz steps', jp.step === 9e3, jp.step);
  await p.evaluate(() => RS.go('explore')); await p.waitForTimeout(1200);
  const ex = await p.evaluate(() => (RS.pages.explore.chipsData || []).map(c => c[0] + ' ' + c[1] / 1e6));
  chk('Japan: Explore offers its FM band and sensors at 315 MHz', ex.includes('FM radio 76') && ex.some(x => /^Sensors 315/.test(x)), ex);
  await p.evaluate(() => RS.go('sensors')); await p.waitForTimeout(1200);
  chk('Japan: sensors listen on 315 MHz first', await p.evaluate(() => RS.sensorFreq) === 315e6, await p.evaluate(() => RS.sensorFreq));

  await setRegion('th'); await p.waitForTimeout(1500);
  await p.evaluate(() => RS.go('radio')); await p.waitForTimeout(1500);
  const th = await p.evaluate(() => [...document.querySelectorAll('#rd-bands button')].map(x => x.textContent));
  chk('Thailand (changed while open): CB 245 button, FM back to 87.5 to 108', th.includes('CB 245') && await p.evaluate(() => RS.BANDS.find(x => x.id === 'fm').lo === 87.5e6), th);

  await setRegion('us'); await p.waitForTimeout(1500);
  await p.reload(); await p.waitForTimeout(2500);
  const us = await p.evaluate(() => ({ chips: [...document.querySelectorAll('#rd-bands button')].map(x => x.textContent), am: RS.BANDS.find(x => x.id === 'am'), step: RS.stepFor('am', 900e3), snap: RS.snap(1003e3, 'am') }));
  chk('US: FRS / GMRS button', us.chips.includes('FRS / GMRS'), us.chips);
  chk('US: AM runs to 1700 kHz in 10 kHz steps', us.am.lo === 530e3 && us.step === 10e3 && us.snap === 1000e3, us);
  await p.evaluate(() => RS.go('ham')); await p.waitForTimeout(1200);
  chk('US: 2 m runs to 148 MHz', await p.evaluate(() => RS.region.ham_2m[1]) === 148e6);

  // Australia and New Zealand share an entry; a New Zealand location brings its own APRS frequency
  await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ changes: { region: 'au', country: 'NZ' } }) });
  await p.waitForTimeout(1500); await p.reload(); await p.waitForTimeout(2500);
  const nz = await p.evaluate(() => ({ name: RS.region.name, aprs: RS.region.aprs, chips: [...document.querySelectorAll('#rd-bands button')].map(x => x.textContent) }));
  chk('New Zealand: shared entry, its own APRS frequency and UHF CB', nz.name === 'Oceania' && nz.aprs === 144.575e6 && nz.chips.includes('UHF CB'), nz);

  await setRegion('uk'); await p.waitForTimeout(1500); await p.reload(); await p.waitForTimeout(2500);
  const uk = await p.evaluate(() => [...document.querySelectorAll('#rd-bands button')].map(x => x.textContent));
  chk('UK (part of Europe): PMR446', uk.includes('PMR446'), uk);

  // the setup form lists every country A to Z, in the interface language, and you can type to find one
  const opts = () => [...document.querySelectorAll('#sw-cl [role="option"]')].map(o => ({ cc: (o.querySelector('.locp-cc') || {}).textContent || '', name: o.querySelector('b').textContent }));
  await p.evaluate(async () => { RS.setupWizard(); await new Promise(r => setTimeout(r, 400)); });
  await p.click('#sw-cq'); await p.waitForTimeout(150);
  const all = await p.evaluate(`(${opts})()`);
  const names = all.filter(o => o.cc).map(o => o.name);
  chk('setup lists all 250 countries and territories', names.length === 250, names.length);
  chk('in alphabetical order', names.every((n, i) => !i || new Intl.Collator('en').compare(names[i - 1], n) <= 0), names.slice(0, 5));
  chk('"Not sure" comes first', all[0].cc === '' && all[0].name === 'Not sure', all[0]);
  chk('South Africa is listed by name', names.includes('South Africa'));
  await p.fill('#sw-cq', 'zeal'); await p.waitForTimeout(150);
  const nzl = await p.evaluate(`(${opts})()`);
  chk('typing narrows the list ("zeal")', nzl.length === 1 && nzl[0].cc === 'NZ', nzl);
  await p.fill('#sw-cq', 'cote'); await p.waitForTimeout(150);
  chk('accents don\'t matter ("cote")', (await p.evaluate(`(${opts})()`)).some(o => o.cc === 'CI'));
  await p.fill('#sw-cq', 'ke'); await p.waitForTimeout(150);
  const ke = await p.evaluate(`(${opts})()`);
  chk('a two-letter code finds its country first ("ke")', ke[0] && ke[0].cc === 'KE', ke.slice(0, 3));
  await p.keyboard.press('Enter'); await p.waitForTimeout(150);
  const picked = await p.evaluate(() => ({ v: document.querySelector('#sw-region').value, shown: document.querySelector('#sw-cq').value, open: !document.querySelector('#sw-cl').hidden }));
  chk('Enter picks it, and the box shows its name', picked.v === 'KE' && picked.shown === 'Kenya' && !picked.open, picked);
  await p.click('#sw-cq'); await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter'); await p.waitForTimeout(150);
  chk('arrow keys move through the list', await p.evaluate(() => document.querySelector('#sw-region').value) === 'KI', await p.evaluate(() => document.querySelector('#sw-region').value));
  const de = await p.evaluate(async () => { const s = document.querySelector('#sw-lang'); s.value = 'de'; s.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 900));
    document.querySelector('#sw-cq').value = ''; return 1; });
  await p.click('#sw-cq'); await p.fill('#sw-cq', 'deutsch'); await p.waitForTimeout(150);
  const deo = await p.evaluate(`(${opts})()`);
  chk('country names follow the language', deo.some(o => o.cc === 'DE' && o.name === 'Deutschland'), deo.slice(0, 3));
  chk('no page errors', !errs.length, errs);
  await b.close(); srv.kill();
  console.log(fails.length ? 'FAILED: ' + fails.join(', ') : 'ALL PASS'); process.exit(fails.length ? 1 : 0);
})();
