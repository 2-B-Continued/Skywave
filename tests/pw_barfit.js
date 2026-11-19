// The sound bar keeps every control inside its own edges, in every style, from wide desktops down to 768 px.
// Run: node tests/pw_barfit.js
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  let bad = 0; const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bar-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18153', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000)); const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto('http://127.0.0.1:18153/#radio'); await p.waitForTimeout(2500);
  for (const st of (process.argv[2] || 'skywave,aurora,classic,lumen,bento,folio,terminal,brut,ticket,console').split(',')) {
    await p.evaluate(s => { RS.store.set('styleid', s); RS.applyTheme(); }, st);
    for (const w of [1920, 1440, 1280, 1100, 900, 800, 768]) {
      await p.setViewportSize({ width: w, height: 900 }); await p.waitForTimeout(250);
      const r = await p.evaluate(() => {
        const sb = document.getElementById('soundbar').getBoundingClientRect();
        const kids = [...document.querySelectorAll('#soundbar > *')].filter(e => e.offsetParent && getComputedStyle(e).display !== 'none').map(e => { const q = e.getBoundingClientRect(); return [e.id || e.className.split(' ')[0], Math.round(q.left), Math.round(q.right)]; });
        return { sb: [Math.round(sb.left), Math.round(sb.right)], over: kids.filter(x => x[2] > Math.round(sb.right) - 2 || x[1] < Math.round(sb.left) + 2) };
      });
      if (r.over.length) { bad++; console.log('FAIL', st, w, JSON.stringify(r)); }
    }
  }
  await b.close(); srv.kill(); console.log(bad ? 'FAIL' : 'PASS'); process.exit(bad ? 1 : 0);
})();
