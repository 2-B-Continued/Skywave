// Mini player: long text scrolls on ONE line (no stacked duplicates); stream reconnects when tuning changes.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18113', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, x === undefined ? '' : JSON.stringify(x)); if (!c) ok = false; };
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const mobile of [false, true]) {
    console.log(mobile ? '--- mobile' : '--- desktop');
    const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://127.0.0.1:18113/#radio'); await p.waitForTimeout(2500);
    const long = 'Now playing: A really quite long song title that goes on - and an even longer artist name feat. somebody else';
    let tt, r;
    for (let k = 0; k < 6; k++) {      // the server pushes fresh state about once a second and would overwrite the test text: retry until it sticks
      tt = await p.evaluate(t => { RS.st.job = 'listen'; RS.st.rds = { ps: 'WAVE FM', rt: t }; RS.updateSound(); return document.getElementById('sb-title')._tk; }, long); await p.waitForTimeout(120);
      r = await p.evaluate(() => ['sb-sub'].map(id => { const e = document.getElementById(id), t = e.querySelector('.tk-track'); const kids = [...t.children].map(c => c.getBoundingClientRect().top); return { run: e.classList.contains('tk-run'), h: Math.round(e.getBoundingClientRect().height), tops: [...new Set(kids.map(Math.round))].length, w: Math.round(e.getBoundingClientRect().width), tw: Math.round(t.getBoundingClientRect().width) }; }));
      if (r[0].run) break;
    }
    r.forEach((x, i) => { chk('sub scrolls', x.run, x); chk('sub is one line (all copies share a row, one line tall)', x.tops === 1 && x.h < 30, x); chk('sub track wider than box', x.tw > x.w); });
    chk('title keeps its plain text for the lock screen', tt === 'WAVE FM', tt);
    if (!mobile) {   // the MP3 stream path (browsers without AudioWorklet) reconnects on tune
      await p.evaluate(() => { RS.audio.useStream = () => true; RS.audio.start(); }); await p.waitForTimeout(1500);
      const s1 = await p.evaluate(() => document.getElementById('rs-live') && document.getElementById('rs-live').src);
      await p.evaluate(() => RS.send({ cmd: 'tune', freq: 99.5e6 })); await p.waitForTimeout(900);
      const s2 = await p.evaluate(() => document.getElementById('rs-live').src);
      chk('live stream reconnected after tuning (drops stale buffered audio)', s1 && s2 && s1 !== s2, [s1, s2]);
    }
    chk('no page errors', errs.length === 0, errs); await ctx.close();
  }
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
