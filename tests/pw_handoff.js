// Sound follows you: starting sound on the phone stops it on the desktop, unless "several devices" is allowed.
const { chromium, devices } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18147', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); let ok = true;
  const chk = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, x || ''); ok = ok && !!c; };
  const dp = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage(), mp = await (await b.newContext({ ...devices['iPhone 13'] })).newPage();
  for (const p of [dp, mp]) { await p.goto('http://127.0.0.1:18147/#radio'); await p.waitForTimeout(2200); }
  const on = p => p.evaluate(() => RS.audio.on);
  await dp.evaluate(() => RS.audio.start()); await dp.waitForTimeout(800); chk('desktop sound on', await on(dp));
  await mp.evaluate(() => RS.audio.start()); await mp.waitForTimeout(1500);
  chk('phone sound on', await on(mp)); chk('desktop sound stopped when the phone took over', !(await on(dp)));
  await dp.evaluate(() => RS.audio.start()); await dp.waitForTimeout(1500);
  chk('desktop takes it back', await on(dp)); chk('phone stopped', !(await on(mp)));
  await dp.evaluate(() => RS.setPref('sound_both', true)); await dp.waitForTimeout(800);
  await mp.evaluate(() => RS.audio.start()); await mp.waitForTimeout(1500);
  chk('both play when allowed', (await on(dp)) && (await on(mp)));
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
