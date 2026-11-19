// Pixel contrast: screenshots each page in a style and palette, then (tests/pix_contrast.py) measures the rendered
// text against what is really behind it, images, gradients and blur included. Usage:
//   node tests/pw_pixcontrast.js <style> <palette|device-light|device-dark> <outdir>; python3 tests/pix_contrast.py <outdir>
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const mock = require('./space_mock.js');
const [style = 'folio', pal = 'device-light', out = '/tmp/pix'] = process.argv.slice(2);
const PAGES = (process.env.PAGES || 'home,radio,scanner,planes,ships,space,ham,sensors,explore,lab,library,settings').split(',');
const PORT = 18160 + Math.floor(Math.random() * 30);
const WIDTHS = (process.env.WIDTHS || '1440,390').split(',').map(Number);
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'px-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: String(PORT), DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1', LAT: '-33.92', LON: '18.42' } });

  await new Promise(r => setTimeout(r, 4000));

  const b = await chromium.launch(); const meta = [];
  for (const vw of WIDTHS) {
    const ctx = await b.newContext({ viewport: { width: vw, height: 900 }, colorScheme: pal === 'device-dark' ? 'dark' : 'light', hasTouch: vw < 500, deviceScaleFactor: 1 });
    const p = await ctx.newPage(); await mock(p);
    await p.addInitScript(([s, t, a]) => { localStorage.setItem('rs.styleid', JSON.stringify(s)); localStorage.setItem('rs.themeid', JSON.stringify(t.startsWith('device') ? '' : t)); localStorage.setItem('rs.motion', '"off"'); if (a) localStorage.setItem('rs.adv', 'true'); }, [style, pal, !!process.env.ADV]);
    await p.goto('http://127.0.0.1:' + PORT + '/#home'); await p.waitForTimeout(2500);
    for (const pg of PAGES) {
      await p.evaluate(pg => { RS.go(pg); scrollTo(0, 0); }, pg); await p.waitForTimeout(1500);
      const H = await p.evaluate(() => document.documentElement.scrollHeight), done = new Set();
      for (let y = 0, i = 0; y < H && i < 6; y += 700, i++) {
        await p.evaluate(y => scrollTo(0, y), y); await p.waitForTimeout(250);
        const file = `${style}-${pal}-${vw}-${pg}-${i}.png`; await p.screenshot({ path: path.join(out, file) });
        const items = await p.evaluate(() => {
          const res = [], vh = innerHeight, vw = innerWidth;
          const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const seen = new Set();
          while (tw.nextNode()) {
            const t = tw.currentNode; if (!t.textContent.trim()) continue;
            const el = t.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
            if (el.closest('#modal-root, .page:not(.active), [aria-hidden="true"], .hide, [hidden], svg, canvas')) continue;
            const s = getComputedStyle(el); if (s.visibility === 'hidden' || +s.opacity < 0.05) continue;
            const rg = document.createRange(); rg.selectNodeContents(t); const r = rg.getBoundingClientRect();
            if (r.width < 6 || r.height < 8 || r.top < 0 || r.bottom > vh || r.left < 0 || r.right > vw) continue;
            // what is drawn on top of this text (a fixed bar over the page): skip, it is measured where it is on top
            const top = document.elementFromPoint(Math.min(vw - 1, r.left + Math.min(r.width / 2, 20)), r.top + r.height / 2);
            if (top && !el.contains(top) && !top.contains(el)) continue;
            const dis = !!el.closest('[disabled], [aria-disabled="true"]');
            res.push({ t: t.textContent.trim().slice(0, 50), sel: el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : ''), x: r.left, y: r.top, w: r.width, h: r.height, fs: parseFloat(s.fontSize), fw: +s.fontWeight || 400, dis });
          }
          return res;
        });
        items.forEach(it => { const k = it.sel + '|' + it.t; if (done.has(k)) return; done.add(k); meta.push(Object.assign(it, { file, page: pg, vw })); });
      }
    }
    await ctx.close();
  }
  fs.writeFileSync(path.join(out, `${style}-${pal}.json`), JSON.stringify(meta));
  await b.close(); srv.kill();
})();
