// Space page: satellite gain slider saves, and the recording banner shows the live "is it heard" reading with the honest wording.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18110', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, x === undefined ? '' : JSON.stringify(x)); if (!c) ok = false; };
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:18110/#space'); await p.waitForTimeout(2500);
  chk('sky card says positions are calculated', (await p.textContent('#p-space')).includes('calculated from orbit data'));
  chk('gain slider shows default', await p.evaluate(() => document.getElementById('sp-gain').value) == '40.2', await p.evaluate(() => document.getElementById('sp-gain').value));
  await p.evaluate(() => { const g = document.getElementById('sp-gain'); g.value = 36.4; g.dispatchEvent(new Event('change')); }); await p.waitForTimeout(800);
  chk('gain saved on the server', await p.evaluate(async () => (await RS.api('hello')).config.sat_gain_db) === 36.4);
  await p.evaluate(() => { RS.irec = { file: 'x_iq.wav', secs: 600, t0: Date.now() - 90000, bytes: 1e6 }; RS.fire('record_signal', { file: 'x', db: 0.3, level: 'none', best: 0.5, clip: 0 }); });
  await p.waitForTimeout(300);
  let t = await p.textContent('#sp-live'); chk('shows not detected + check the antenna', /not detected/.test(t) && /Nothing detected yet/.test(t) && /antenna/.test(t), t.slice(0, 200));
  await p.evaluate(() => { RS.fire('record_signal', { file: 'x', db: 7.1, level: 'good', best: 7.1, clip: 4.2 }); }); await p.waitForTimeout(300);
  t = await p.textContent('#sp-live'); chk('shows good + clipping warning', /signal good/.test(t) && /overloaded/.test(t), t.slice(0, 200));
  chk('no page errors', errs.length === 0, errs);
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
