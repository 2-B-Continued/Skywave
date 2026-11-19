// Four styles (Lumen, Bento, Folio, Aurora) with palettes: they apply, survive reload, keep text readable, and show on desktop and phone.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sty2-')), out = process.env.SHOTS || d;
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18125', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, x === undefined ? '' : JSON.stringify(x)); if (!c) ok = false; };
  const b = await chromium.launch(); const errs = [];
  const SET = [['lumen', 'violet'], ['bento', 'porcelain'], ['folio', 'swiss'], ['aurora', 'obsidian']];
  for (const [name, vp] of [['d', { width: 1280, height: 860 }], ['m', { width: 390, height: 800 }]]) {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 1 }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://127.0.0.1:18125/#radio'); await p.waitForTimeout(2500);
    for (const [sty, th] of SET) {
      await p.evaluate(([s, t]) => { RS.setStyle(s); RS.setTheme(t); }, [sty, th]); await p.waitForTimeout(400);
      chk(name + ' ' + sty + ' applied', await p.evaluate(() => document.documentElement.dataset.style) === sty);
      chk(name + ' ' + sty + ' no horizontal scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]));
      await p.screenshot({ path: path.join(out, name + '-' + sty + '-radio.png') });
      await p.evaluate(() => { const e = document.querySelector('#rd-dial'); if (e) { e.scrollIntoView({ block: 'center' }); } }); await p.waitForTimeout(250);
      await p.screenshot({ path: path.join(out, name + '-' + sty + '-dial.png') }); await p.evaluate(() => scrollTo(0, 0));
    }
    if (name === 'd') {
      await p.evaluate(() => RS.go('home')); await p.waitForTimeout(500);
      for (const [sty, th] of SET) { await p.evaluate(([s, t]) => { RS.setStyle(s); RS.setTheme(t); }, [sty, th]); await p.waitForTimeout(300); await p.screenshot({ path: path.join(out, 'd-' + sty + '-home.png') }); }
    }
    await ctx.close();
  }
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } }); const p = await ctx.newPage(); await p.goto('http://127.0.0.1:18125/#settings'); await p.waitForTimeout(2500);
  chk('settings offers ten styles', (await p.$$('[data-act="sty-pick"]')).length === 10);
  await p.click('[data-act="sty-pick"][data-id="bento"]'); await p.reload(); await p.waitForTimeout(2000);
  chk('bento survives reload', await p.evaluate(() => document.documentElement.dataset.style) === 'bento');
  chk('no page errors', errs.length === 0, errs);
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
