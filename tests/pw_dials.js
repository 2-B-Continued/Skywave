// The radio dial, station strip and spectrum must be drawn differently in every style, with no page errors.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dial-')), out = process.env.SHOTS || d;
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18131', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  const b = await chromium.launch(), errs = [], hashes = {};
  const SET = [['terminal', 'neon'], ['depth', 'midnight'], ['relief', 'clay'], ['walnut', 'autumn'], ['riot', 'carnival'], ['bento', 'porcelain'], ['folio', 'swiss']];
  for (const [nm, vp] of [['d', { width: 1280, height: 860 }], ['m', { width: 390, height: 800 }]]) {
    const p = await (await b.newContext({ viewport: vp })).newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://127.0.0.1:18131/#radio'); await p.waitForTimeout(2500);
    for (const [sty, th] of SET) {
      await p.evaluate(([s, t]) => { RS.setStyle(s); RS.setTheme(t); }, [sty, th]); await p.waitForTimeout(1500);
      const h = await p.evaluate(() => ['#rd-cv', '#rd-ov'].map(q => { const c = document.querySelector(q); if (!c) return 'none'; const u = c.toDataURL(); let x = 0; for (let i = 0; i < u.length; i += 37) x = (x * 31 + u.charCodeAt(i)) | 0; return x; }).join('/'));
      hashes[nm + sty] = h;
      if (process.env.SHOTS) await (await p.$('#rd-dial, .dial-card')).screenshot({ path: path.join(out, 'dial-' + nm + '-' + sty + '.png') });
    }
  }
  const dd = SET.map(s => hashes['d' + s[0]]); const uniq = new Set(dd).size;
  console.log('dial hashes', dd.join(' | ')); console.log(uniq === SET.length ? 'ok every style draws a different dial' : 'FAIL dials identical'); console.log(errs.length ? 'FAIL errors ' + JSON.stringify(errs.slice(0, 3)) : 'ok no page errors');
  await b.close(); srv.kill(); process.exit(uniq === SET.length && !errs.length ? 0 : 1);
})();
