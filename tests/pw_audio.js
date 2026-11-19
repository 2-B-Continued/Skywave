// Browser test (Playwright): one audio source at a time, file player persists across pages, mobile bar swap.
const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-aud-'));
  fs.mkdirSync(path.join(d, 'recordings'), { recursive: true });
  for (const n of ['20260101-120000_a.wav', '20260101-130000_b.wav'])
    execSync(`ffmpeg -loglevel error -y -f lavfi -i sine=frequency=440:duration=30 -ar 22050 -ac 1 ${path.join(d, 'recordings', n)}`);
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18097', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c) => { console.log(c ? 'ok  ' : 'FAIL', n); if (!c) ok = false; };
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const mobile of [false, true]) {
    const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true } : { viewport: { width: 1200, height: 800 } });
    const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
    await pg.goto('http://127.0.0.1:18097/#library'); await pg.waitForTimeout(1500);
    console.log(mobile ? '--- mobile' : '--- desktop');
    await pg.evaluate(() => RS.audio.start()); await pg.waitForTimeout(800);
    chk('radio on', await pg.evaluate(() => RS.audio.on));
    if (mobile) chk('mobile: screen-off stream started muted alongside the live player', await pg.evaluate(() => { const e = document.getElementById('rs-live'); return RS.audio.mode === 'live' && !!e && !!e.src && e.muted; }));
    const rows = await pg.$$('#lb-list [data-act="lb-play"]'); chk('two files listed', rows.length === 2);
    await rows[0].click(); await pg.waitForTimeout(700);
    const src1 = await pg.evaluate(() => document.getElementById('rs-file').src);
    chk('radio stopped by file', !(await pg.evaluate(() => RS.audio.on)));
    chk('player visible', await pg.isVisible('#fileplayer'));
    const t1 = await pg.evaluate(() => document.getElementById('rs-file').currentTime); await pg.waitForTimeout(600);
    chk('file advancing', await pg.evaluate(t => document.getElementById('rs-file').currentTime > t, t1));
    if (mobile) chk('mobile: sound bar hidden while file plays', !(await pg.isVisible('#soundbar')));
    else {      // the bar sits at the bottom in most styles and at the top in Skywave: either way the two must not overlap
      const a = await pg.evaluate(() => { const p = document.getElementById('fileplayer').getBoundingClientRect(), s = document.getElementById('soundbar').getBoundingClientRect(); return p.bottom <= s.top + 1 || p.top >= s.bottom - 1 || p.right <= s.left + 1 || p.left >= s.right - 1; });
      if (!a) console.log('   rects', await pg.evaluate(() => JSON.stringify(['fileplayer', 'soundbar'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return [id, Math.round(r.top), Math.round(r.bottom), Math.round(r.left), Math.round(r.right), getComputedStyle(document.getElementById(id)).transform]; }))));
      chk('desktop: player and bar do not overlap', a);
    }
    await (await pg.$$('#lb-list [data-act="lb-play"]'))[1].click(); await pg.waitForTimeout(500);
    chk('second file replaced first (one element, one source)', await pg.evaluate(s => document.getElementById('rs-file').src !== s && !document.getElementById('rs-file').paused, src1));
    chk('selected row highlighted', (await pg.$$('#lb-list .rec-row.sel')).length === 1);
    await pg.evaluate(() => RS.go('radio')); await pg.waitForTimeout(500);
    chk('still playing after leaving Library', await pg.evaluate(() => !document.getElementById('rs-file').paused));
    chk('player still visible on Radio page', await pg.isVisible('#fileplayer'));
    await pg.evaluate(() => RS.audio.start()); await pg.waitForTimeout(600);
    chk('station start stops file', await pg.evaluate(() => document.getElementById('rs-file').paused && !RS.player.cur));
    chk('player hidden again', !(await pg.isVisible('#fileplayer')));
    if (mobile) chk('mobile: sound bar back', await pg.isVisible('#soundbar'));
    chk('radio playing', await pg.evaluate(() => RS.audio.on));
    chk('no page errors', errs.length === 0); if (errs.length) console.log(errs);
    await pg.screenshot({ path: `/tmp/audio-${mobile ? 'm' : 'd'}.png` });
    await ctx.close();
  }
  await b.close(); srv.kill();
  console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
