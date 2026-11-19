// Every page in every style, desktop and phone: no horizontal scroll, no page errors.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sty3-')), out = process.env.SHOTS || d;
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18127', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const bad = []; const errs = [];
  const b = await chromium.launch();
  const SET = [['lumen', 'violet'], ['bento', 'porcelain'], ['folio', 'swiss'], ['aurora', 'obsidian']];
  const PAGES = ['home', 'radio', 'scanner', 'planes', 'ships', 'space', 'ham', 'sensors', 'explore', 'library', 'settings'];
  for (const [name, vp] of [['d', { width: 1280, height: 860 }], ['m', { width: 390, height: 800 }]]) {
    const p = await (await b.newContext({ viewport: vp })).newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://127.0.0.1:18127/#home'); await p.waitForTimeout(2500);
    for (const [sty, th] of SET) {
      await p.evaluate(([s, t]) => { RS.setStyle(s); RS.setTheme(t); }, [sty, th]);
      for (const pg of PAGES) {
        await p.evaluate(g => RS.go(g), pg); await p.waitForTimeout(350);
        const w = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
        if (w[0] > w[1] + 1) { bad.push(name + ' ' + sty + ' ' + pg + ' ' + w.join('/')); ok = false; }
        if (['settings', 'scanner', 'planes'].includes(pg) && process.env.SHOTS) await p.screenshot({ path: path.join(out, name + '-' + sty + '-' + pg + '.png') });
      }
    }
  }
  console.log(bad.length ? 'OVERFLOW ' + JSON.stringify(bad) : 'ok no overflow'); console.log(errs.length ? 'FAIL errors ' + JSON.stringify(errs.slice(0, 3)) : 'ok no page errors');
  await b.close(); srv.kill(); console.log(ok && !errs.length ? 'PASS' : 'FAIL'); process.exit(ok && !errs.length ? 0 : 1);
})();
