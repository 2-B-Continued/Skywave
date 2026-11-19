// Style picker: Skywave is the default, Terminal has square corners, Classic has rounded ones, the choice survives a reload.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sty-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18121', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, x === undefined ? '' : JSON.stringify(x)); if (!c) ok = false; };
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:18121/#settings'); await p.waitForTimeout(2500);
  const st = () => p.evaluate(() => document.documentElement.dataset.style);
  chk('default style is skywave', await st() === 'skywave', await st());
  await p.evaluate(() => RS.setStyle('terminal')); await p.waitForTimeout(400);
  { const bad = await p.evaluate(() => [...document.querySelectorAll('.card,.btn,input,select')].filter(e => getComputedStyle(e).borderTopLeftRadius !== '0px').map(e => e.className + '|' + (e.id||'') + '|' + getComputedStyle(e).borderTopLeftRadius).slice(0, 6)); chk('radius 0 on cards', bad.length === 0, bad); }
  chk('all styles offered', (await p.$$('[data-act="sty-pick"]')).length === 10);
  await p.click('[data-act="sty-pick"][data-id="classic"]'); await p.waitForTimeout(500);
  chk('classic applies', await st() === 'classic');
  chk('classic has rounded corners', await p.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.card')).borderTopLeftRadius) > 4));
  await p.reload(); await p.waitForTimeout(2000);
  chk('choice survives reload', await st() === 'classic');
  await p.click('[data-act="sty-pick"][data-id="skywave"]'); await p.waitForTimeout(300);
  await p.click('[data-act="th-pick"][data-id="phosphor"]'); await p.waitForTimeout(300);
  chk('colour theme works with the style', await p.evaluate(() => document.documentElement.dataset.palette === 'phosphor' && document.documentElement.dataset.style === 'skywave'));
  chk('no page errors', errs.length === 0, errs);
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
