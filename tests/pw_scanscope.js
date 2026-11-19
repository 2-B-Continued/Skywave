const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18107', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, x === undefined ? '' : JSON.stringify(x)); if (!c) ok = false; };
  const b = await chromium.launch();
  for (const mobile of [false, true]) {
    const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://127.0.0.1:18107/#scanner'); await p.waitForTimeout(2500);
    chk('scope visible', await p.isVisible('#sc-spec') && await p.isVisible('#sc-water'));
    await p.click('[data-act="sc-start"]'); await p.waitForTimeout(3500);
    const drawn = await p.evaluate(() => { const c = document.getElementById('sc-water'); const g = c.getContext('2d'); const a = g.getImageData(0, 0, 1024, 1).data; let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i + 2] > 35) n++; return n; });
    chk('waterfall has data while scanning', drawn > 0, drawn);
    const f0 = await p.evaluate(() => RS.vfo());
    await p.click('#sc-spec', { position: { x: 100, y: 60 } }); await p.waitForTimeout(1200);
    chk('click tunes and stops scan', await p.evaluate(() => !RS.st.scan), await p.evaluate(() => RS.vfo()));
    const f1 = await p.evaluate(() => RS.vfo()); await p.click('[data-act="sc-nudge"][data-n="1"]'); await p.waitForTimeout(800);
    chk('nudge changes frequency', await p.evaluate(() => RS.vfo()) > f1);
    chk('no page errors', errs.length === 0, errs); await ctx.close();
  }
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
