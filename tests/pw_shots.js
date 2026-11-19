// Screenshots of every page in the chosen style (STYLE=skywave|classic, THEME=id) for a visual check.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const STYLE = process.env.STYLE || 'skywave', THEME = process.env.THEME || '', OUT = process.env.OUT || '/tmp/shots';
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18120', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1', LAT: '-33.92', LON: '18.42' } });
  await new Promise(r => setTimeout(r, 4000));
  const b = await chromium.launch(); let bad = 0;
  for (const mobile of [false, true]) {
    const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 860 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(([s, t]) => { try { localStorage.setItem('rs.styleid', JSON.stringify(s)); localStorage.setItem('rs.themeid', JSON.stringify(t)); } catch (e) { } }, [STYLE, THEME]);
    await p.goto('http://127.0.0.1:18120/'); await p.waitForTimeout(2500);
    for (const pg of (process.env.PAGES || 'home,radio,scan,planes,ships,space,ham,sensors,explore,rec,lab,settings').split(',')) {
      await p.evaluate(x => { location.hash = x; if (window.RS && RS.go) RS.go(x); }, pg); await p.waitForTimeout(1300);
      const ov = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (ov > 1) { console.log('OVERFLOW', mobile ? 'mobile' : 'desktop', pg, ov); bad++; }
      await p.screenshot({ path: `${OUT}/${mobile ? 'm' : 'd'}-${pg}.png` });
    }
    if (errs.length) { console.log('ERRORS', errs); bad++; }
    await ctx.close();
  }
  await b.close(); srv.kill(); console.log(bad ? 'ISSUES ' + bad : 'PASS'); process.exit(0);
})();
