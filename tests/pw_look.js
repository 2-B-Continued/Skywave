// First-run setup offers style + theme (applied live), the four new themes work in both styles, text stays readable.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'look-')), out = process.env.SHOTS || d;
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18124', DATA_DIR: d, NO_NET: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, x === undefined ? '' : JSON.stringify(x)); if (!c) ok = false; };
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:18124/#home'); await p.waitForTimeout(3000);
  chk('wizard has look picker', await p.isVisible('#sw-look'));
  chk('ten styles + new themes offered', (await p.$$('#sw-look [data-act=sty-pick]')).length === 10 && (await p.$$('#sw-look [data-id=obsidian],#sw-look [data-id=swiss],#sw-look [data-id=violet],#sw-look [data-id=mint]')).length === 4);
  await p.click('#sw-look [data-id=violet]'); await p.waitForTimeout(300);
  chk('theme applies live', await p.evaluate(() => document.documentElement.dataset.palette) === 'violet');
  chk('pressed state follows', await p.getAttribute('#sw-look [data-id=violet]', 'aria-pressed') === 'true');
  await p.screenshot({ path: path.join(out, 'wizard.png') });
  await p.click('#sw-ok'); await p.waitForTimeout(800);
  await p.reload(); await p.waitForTimeout(2500);
  chk('choice kept after setup + reload', await p.evaluate(() => document.documentElement.dataset.palette) === 'violet');
  chk('wizard not shown again', !(await p.isVisible('#sw-look')));
  for (const sty of ['skywave', 'relief']) for (const t of ['obsidian', 'swiss', 'violet', 'mint']) {
    await p.evaluate(([s, t]) => { RS.setStyle(s); RS.setTheme(t); }, [sty, t]); await p.waitForTimeout(300);
    const r = await p.evaluate(() => { const cs = getComputedStyle(document.documentElement); return { ink: cs.getPropertyValue('--ink').trim(), panel: cs.getPropertyValue('--panel').trim(), pal: document.documentElement.dataset.palette }; });
    chk(sty + '/' + t + ' readable', RSc(r.ink, r.panel) >= 7 && r.pal === t, r);
    await p.evaluate(() => RS.go('radio')); await p.waitForTimeout(500);
    await p.screenshot({ path: path.join(out, sty + '-' + t + '.png') });
  }
  chk('no page errors', errs.length === 0, errs);
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
  function RSc(a, c) { const h = x => { x = x.replace('#', ''); const n = parseInt(x, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); }; const L = x => { const [r, g, b] = h(x); return .2126 * r + .7152 * g + .0722 * b; }; const l1 = L(a), l2 = L(c); return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05); }
})();
