// Text contrast audit: every visible piece of text on every page, in the given styles and colour schemes, measured
// against what is actually behind it (backgrounds blended up the tree). Fails below 4.5:1 (3:1 for large text).
// Usage: node tests/pw_contrast.js [styles] [themes]   e.g. node tests/pw_contrast.js folio light,dark
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const mock = require('./space_mock.js');
const STYLES = (process.argv[2] || 'folio').split(','), MODES = (process.argv[3] || 'device-light,device-dark,swiss').split(',');   // a palette id, or device-light / device-dark for Match my device
const PAGES = (process.env.PAGES || 'home,radio,scanner,planes,ships,space,ham,sensors,explore,lab,library,settings').split(',');
const WIDTHS = (process.env.WIDTHS || '1440,390').split(',').map(Number);
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18150', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1', LAT: '-33.92', LON: '18.42' } });
  await new Promise(r => setTimeout(r, 4000));
  const b = await chromium.launch(); let bad = 0; const out = [];
  for (const style of STYLES) for (const mode of MODES) for (const vw of WIDTHS) {
    const ctx = await b.newContext({ viewport: { width: vw, height: 900 }, colorScheme: mode === 'device-dark' ? 'dark' : 'light', hasTouch: vw < 500 });
    const p = await ctx.newPage(); await mock(p);
    await p.addInitScript(([s, m]) => { localStorage.setItem('rs.styleid', JSON.stringify(s)); localStorage.setItem('rs.themeid', JSON.stringify(m.startsWith('device') ? '' : m)); localStorage.setItem('rs.motion', '"off"'); }, [style, mode]);
    await p.goto('http://127.0.0.1:18150/#home'); await p.waitForTimeout(2500);
    for (const pg of PAGES) {
      await p.evaluate(pg => RS.go(pg), pg); await p.waitForTimeout(1300);
      const r = await p.evaluate(() => {
        const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v[3] == null ? 1 : v[3]]; };
        const lum = c => { const f = x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
        const over = (top, under) => { const a = top[3]; return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]; };
        const page = parse(getComputedStyle(document.body).backgroundColor);
        const rootBg = parse(getComputedStyle(document.documentElement).backgroundColor);
        const base = (page && page[3] > 0.5 ? page : rootBg && rootBg[3] > 0.5 ? rootBg : [255, 255, 255, 1]);
        const bgOf = el => {           // blend the backgrounds from the page up to the element
          const L = []; for (let e = el; e && e !== document.documentElement; e = e.parentElement) L.push(e);
          let c = base.slice();
          for (const e of L.reverse()) { const s = getComputedStyle(e), k = parse(s.backgroundColor); if (k && k[3] > 0) c = over(k, c); }
          return c;
        };
        const res = [], seen = new Set();
        const w = document.createTreeWalker(document.querySelector('.page.active') || document.body, NodeFilter.SHOW_TEXT);
        const roots = [document.querySelector('.page.active'), document.querySelector('.topbar'), document.querySelector('.soundbar'), document.querySelector('.mobile-nav')].filter(Boolean);
        for (const rt of roots) {
          const tw = document.createTreeWalker(rt, NodeFilter.SHOW_TEXT);
          while (tw.nextNode()) {
            const t = tw.currentNode; if (!t.textContent.trim()) continue;
            const el = t.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            if (!r.width || !r.height || s.visibility === 'hidden' || +s.opacity === 0 || el.closest('[hidden], .hide, [aria-hidden="true"]')) continue;
            if (el.closest('.adv-only') && !document.body.classList.contains('advanced')) continue;
            let op = 1; for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity; if (op < 0.05) continue;
            const fg = parse(s.color); if (!fg) continue;
            const bg = bgOf(el), f = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
            const a = lum(f), z = lum(bg), ratio = (Math.max(a, z) + 0.05) / (Math.min(a, z) + 0.05);
            const size = parseFloat(s.fontSize), big = size >= 24 || (size >= 18.66 && +s.fontWeight >= 600);
            const need = el.disabled || el.closest('[disabled], [aria-disabled="true"]') ? 0 : big ? 3 : 4.5;
            if (ratio < need) res.push({ t: t.textContent.trim().slice(0, 40), sel: (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + [...el.classList].slice(0, 2).join('.')), ratio: +ratio.toFixed(2), fg: s.color, bg: 'rgb(' + bg.slice(0, 3).map(Math.round).join(',') + ')' });
          }
        }
        return res;
      });
      if (r.length) { bad += r.length; out.push(`${style}/${mode}/${vw} ${pg}: ${r.length}`); r.slice(0, 6).forEach(x => out.push('   ' + JSON.stringify(x))); }
    }
    await ctx.close();
  }
  console.log(out.join('\n')); console.log(bad ? 'FAIL ' + bad + ' low-contrast texts' : 'PASS');
  await b.close(); srv.kill(); process.exit(bad ? 1 : 0);
})();
