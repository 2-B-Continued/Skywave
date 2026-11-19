// Radio page: presets, the three lists, station details, sleep timer, song history. Run: node tests/pw_radio.js
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rdt-')); let bad = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) bad++; };
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18210', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:18210/#radio'); await p.waitForTimeout(3000);
  for (const id of ['#rd-stage', '#rd-listen', '#rd-bands', '#rd-ov', '#rd-freq', '#rd-star', '#rd-np', '#rd-sleep', '#rd-favs', '#rd-list', '#rd-info', '#rd-scope-wrap']) ok(await p.$(id), 'has ' + id);
  await p.evaluate(() => RS.tune(100.0e6, { mode: 'wfm' })); await p.waitForTimeout(1500);
  await p.click('#rd-star'); await p.waitForTimeout(1500);
  ok(await p.$$eval('#rd-favs .rdp-preset-b', l => l.length) === 1, 'saved station appears as a preset');
  ok(await p.$eval('#rd-star', e => e.getAttribute('aria-pressed')) === 'true', 'save button shows saved');
  ok((await p.textContent('#rd-info')).includes('100.0'), 'station details show the frequency');
  // the simulator's own state messages replace RS.st about once a second, so set the RDS data and read the result in one go
  const r = await p.evaluate(() => { RS.st.rds = { ps: 'TESTFM', pty: 10, pty_name: 'Pop music', ms: 'music', tp: 1, ta: 0, af: [100.0e6, 104.1e6, 96.9e6], pi_hex: '9A01' }; RS.pages.radio.state();
    return { info: document.getElementById('rd-info').textContent, af: [...document.querySelectorAll('#rd-af .chip')].map(x => x.textContent).join(',') }; });
  ok(r.info.includes('Pop music') && r.info.includes('Carries traffic'), 'RDS programme and traffic shown');
  ok(r.af === '104.1,96.9', 'other frequencies offered, current one left out');
  await p.evaluate(() => { RS.store.set('rd_songs', [{ t: Math.floor(Date.now() / 1000), title: 'Song A', artist: 'Artist A', station: 'TESTFM' }]); });
  await p.click('[data-rd-tab="songs"]'); await p.waitForTimeout(300);
  ok(await p.$$eval('.rdp-song', l => l.length) === 1, 'songs heard lists the song');
  await p.click('[data-rd-tab="recent"]'); await p.waitForTimeout(300);
  ok((await p.textContent('#rd-list')).includes('Nothing yet'), 'recently played empty state');
  await p.click('[data-rd-tab="here"]'); await p.waitForTimeout(300);
  // the tuner: drag moves the frequency, a band button changes band, tapping a station on the scale tunes it
  await p.click('[data-rd-tab="here"]');
  await p.evaluate(() => { scrollTo(0, 0); document.getElementById('rd-cv').scrollIntoView({ block: 'center' }); }); await p.waitForTimeout(300);
  const f0 = await p.evaluate(() => RS.vfo()), box = await (await p.$('#rd-cv')).boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height - 30); await p.mouse.down();
  for (let i = 1; i <= 10; i++) { await p.mouse.move(box.x + box.width / 2 - i * 20, box.y + box.height - 30); await p.waitForTimeout(40); }
  await p.waitForTimeout(200); await p.mouse.up(); await p.waitForTimeout(1500);
  ok(await p.evaluate(() => RS.vfo()) > f0, 'dragging the scale left tunes up');
  await p.click('#rd-bands [data-id="am"]'); await p.waitForTimeout(1500);
  ok(await p.evaluate(() => RS.vfo() < 2e6 && RS.pages.radio.dial.band.id === 'am'), 'the AM band button tunes into AM');
  ok(await p.$eval('#rd-bands [data-id="am"]', e => e.getAttribute('aria-pressed')) === 'true', 'AM shows as chosen');
  await p.click('#rd-bands [data-id="fm"]'); await p.waitForTimeout(1500);
  await p.evaluate(() => RS.tune(99.0e6, { mode: 'wfm' })); await p.waitForTimeout(1500);
  const hit = await p.evaluate(() => { const t = RS.pages.radio.dial; t.dirty = true; t.render(performance.now()); return t.hits.find(h => Math.abs(h.f - 100.0e6) < 5e3); });
  ok(!!hit, 'saved station is written on the scale');
  if (hit) { const box = await (await p.$('#rd-cv')).boundingBox(); await p.mouse.click(box.x + (hit.x0 + hit.x1) / 2, box.y + (hit.y0 + hit.y1) / 2); await p.waitForTimeout(1500); ok(Math.abs(await p.evaluate(() => RS.vfo()) - 100.0e6) < 5e3, 'tapping it on the scale tunes to it'); }
  ok((await p.textContent('#rd-mono')).trim().length > 0, 'the cover shows the frequency until art arrives');
  await p.click('#rd-listen'); await p.waitForTimeout(800);
  ok(await p.evaluate(() => RS.audio.on) && /Stop/.test(await p.textContent('#rd-listen')), 'Listen starts the sound and becomes Stop');
  await p.click('#rd-listen'); await p.waitForTimeout(500);
  ok(await p.evaluate(() => !RS.audio.on), 'Stop stops it');
  await p.$eval('#rd-sleep', e => e.scrollIntoView({ block: 'center' })); await p.click('#rd-sleep');
  await p.waitForSelector('[data-act="rd-sleep-set"][data-m="30"]', { timeout: 3000 }).catch(() => {}); await p.click('[data-act="rd-sleep-set"][data-m="30"]'); await p.waitForTimeout(600);
  const slept = await p.waitForFunction(() => /Sleep 30 min/.test(document.querySelector('#rd-sleep').textContent), null, { timeout: 4000 }).then(() => true, () => false);
  ok(slept, 'sleep timer counts down on the button');
  const h0 = await p.evaluate(() => document.documentElement.scrollHeight); await p.waitForTimeout(4000);
  ok(Math.abs(await p.evaluate(() => document.documentElement.scrollHeight) - h0) < 40, 'page height steady');
  ok(!errs.length, 'no page errors ' + errs.slice(0, 2).join(' | '));
  await b.close(); srv.kill(); console.log(bad ? bad + ' failed' : 'all passed'); process.exit(bad ? 1 : 0);
})();
