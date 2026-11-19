// Lock-screen metadata must not be re-set on every state update (that makes the artwork flicker).
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18112', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const p = await (await b.newContext()).newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(() => { window.__m = 0; const d = Object.getOwnPropertyDescriptor(MediaSession.prototype, 'metadata'); if (d) Object.defineProperty(MediaSession.prototype, 'metadata', { get: d.get, set(v) { window.__m++; d.set.call(this, v); } }); });
  await p.goto('http://127.0.0.1:18112/#radio'); await p.waitForTimeout(2500);
  await p.evaluate(() => RS.audio ? RS.audio.start() : null).catch(() => { }); await p.click('text=Start sound').catch(() => { });
  await p.waitForTimeout(12000);
  const n = await p.evaluate(() => window.__m), on = await p.evaluate(() => !!(RS.audio && RS.audio.on));
  console.log('audio on', on, 'metadata sets in 12 s:', n); const ok = n <= 3 && !errs.length; console.log(ok ? 'PASS' : 'FAIL', errs);
  await b.close(); srv.kill(); process.exit(ok ? 0 : 1);
})();
