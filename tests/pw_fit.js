// Nothing sticks out past the screen: on every page, in every style, on a phone and a computer, find visible elements whose
// box runs past the left or right edge of the window (sideways-scrolling rows such as the band buttons are allowed).
// NODE_PATH=$(npm root -g) node tests/pw_fit.js      STYLES=skywave,bento PAGES=radio,home to narrow it down
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const PORT = 18132;
const STYLES = (process.env.STYLES || 'skywave,depth,relief,walnut,riot,bento,folio,terminal,brut,ticket').split(',');
const PAGES = (process.env.PAGES || 'home,radio,scanner,planes,ships,sondes,messages,space,ham,sensors,explore,library,lab,settings').split(',');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: String(PORT), DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1', LAT: '-33.92', LON: '18.42' } });
  for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:' + PORT + '/healthz'); break; } catch (e) { await new Promise(r => setTimeout(r, 250)); } }   // wait until the server answers
  const b = await chromium.launch(); let bad = 0;
  for (const style of STYLES) for (const mobile of (process.env.MOB === '1' ? [true] : [true, false])) {
    const ctx = await b.newContext(mobile ? { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 860 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(s => { try { localStorage.setItem('rs.styleid', JSON.stringify(s)); localStorage.setItem('rs.motion', '"off"'); localStorage.setItem('rs.adv', 'true'); } catch (e) { } }, style);
    await p.goto('http://127.0.0.1:' + PORT + '/'); await p.waitForTimeout(2200);
    for (const pg of PAGES) {
      await p.evaluate(x => RS.go(x), pg); await p.waitForTimeout(900);
      const out = await p.evaluate(() => {
        const W = window.innerWidth, res = [], seen = new Set();
        const scroller = el => { for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) { const ox = getComputedStyle(n).overflowX; if ((ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') && n.scrollWidth > n.clientWidth + 1) return true; } return false; };
        const scope = [document.querySelector('.page.on'), document.querySelector('.topbar'), document.getElementById('soundbar'), document.getElementById('mnav'), document.getElementById('banners')].filter(Boolean);
        scope.forEach(root => root.querySelectorAll('*').forEach(el => {
          if (el.closest('svg') && el.tagName !== 'svg') return;
          const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed' && el.id === 'rs-live') return;
          const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
          if (r.right > W + 1.5 || r.left < -1.5) {
            if (scroller(el)) return;                                   // inside a row that scrolls sideways on purpose
            const key = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
            if (seen.has(key)) return; seen.add(key);
            res.push(key + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
          }
        }));
        return res.slice(0, 6);
      });
      if (out.length) { bad++; console.log('STICKS OUT', style, mobile ? 'phone' : 'desktop', pg, out.join('  ')); }
    }
    if (errs.length) { bad++; console.log('ERRORS', style, mobile ? 'phone' : 'desktop', errs.slice(0, 3)); }
    await ctx.close();
  }
  await b.close(); srv.kill(); console.log(bad ? 'ISSUES ' + bad : 'PASS'); process.exit(bad ? 1 : 0);
})();
