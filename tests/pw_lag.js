// A live <audio> stream must stay close to real time even after a stall (the 5-7 s lag report).
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lag-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18124', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, x === undefined ? '' : JSON.stringify(x)); if (!c) ok = false; };
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:18124/#radio'); await p.waitForTimeout(2500);
  chk('stream path in use', await p.evaluate(() => { RS.audio.useStream = () => true; RS.audio.start(); return RS.audio.mode === 'stream'; }));
  await p.waitForTimeout(6000);
  const lag = () => p.evaluate(() => ({ live: RS.audio.live, lag: RS.audio.lag, t: RS.audio.el && RS.audio.el.currentTime, rate: RS.audio.el && RS.audio.el.playbackRate }));
  const samples = []; for (let i = 0; i < 6; i++) { samples.push(Math.round((await lag()).lag * 10) / 10); await p.waitForTimeout(1000); }
  console.log('lag samples (s)', samples); chk('stays close to live from the start', Math.max(...samples.slice(2)) < 3 && samples[5] < 1, samples);
  // a stall: the element barely advances for 6 s while data keeps arriving, which is what a busy phone or a slow tab does
  await p.evaluate(() => { RS.audio.el.playbackRate = 0.0625; window.__hold = setInterval(() => { RS.audio.el.playbackRate = 0.0625; }, 50); });
  await p.waitForTimeout(6000);
  await p.evaluate(() => { clearInterval(window.__hold); RS.audio.el.playbackRate = 1; }); await p.waitForTimeout(300);
  const mid = await lag(); console.log('right after the stall', mid);
  await p.waitForTimeout(3000);
  const c = await lag(); console.log('3 s later', c); chk('caught up after the stall', c.live && c.lag < 3.5, c);
  chk('no page errors', errs.length === 0, errs);
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
