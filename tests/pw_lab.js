// The Lab console: every settings group finds a place, the frequency readout steps and takes typed frequencies, mode and
// dock tabs work, the instruments update, no page errors, and it fits a phone without sideways scrolling.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18131', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const errs = [];
  const chk = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n, c ? '' : JSON.stringify(x)); ok = ok && !!c; };
  const b = await chromium.launch();
  const open = async vp => {
    const p = await (await b.newContext({ viewport: vp })).newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://127.0.0.1:18131/#home'); await p.waitForTimeout(2500);
    await p.click('#mode-adv'); await p.waitForTimeout(300); await p.evaluate(() => RS.go('lab')); await p.waitForTimeout(2500);
    return p;
  };
  const p = await open({ width: 1600, height: 1000 });
  const lay = await p.evaluate(() => ({ groups: document.querySelectorAll('#lx .lx-grp').length, more: !!document.getElementById('lx-d-more'),
    dup: (() => { const c = {}; document.querySelectorAll('#lx [id]').forEach(e => c[e.id] = (c[e.id] || 0) + 1); return Object.keys(c).filter(k => c[k] > 1); })() }));
  chk('every group placed (no leftover tab)', lay.groups > 40 && !lay.more, lay);
  chk('no duplicate ids', !lay.dup.length, lay.dup);
  const f0 = await p.evaluate(() => RS.vfo());
  await p.hover('#lx-freq span[data-p="3"]'); await p.mouse.wheel(0, -100); await p.waitForTimeout(400);
  chk('wheel on the kHz digit steps 1 kHz', await p.evaluate(() => RS.vfo()) - f0 === 1000);
  await p.focus('#lx-freq'); await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowDown'); await p.waitForTimeout(400);
  chk('arrow keys pick a digit and step it', await p.evaluate(() => RS.vfo()) - f0 === 1000 - 10000);
  await p.fill('#lx-fin', '145.5'); await p.press('#lx-fin', 'Enter'); await p.waitForTimeout(800);
  chk('typed frequency tunes', await p.evaluate(() => RS.vfo()) === 145500000);
  await p.click('#lb-modes [data-m="nfm"]'); await p.waitForTimeout(800);
  chk('mode button sets the mode', await p.evaluate(() => RS.curMode()) === 'nfm');
  for (const t of await p.$$eval('#lx .lx-tabs [role=tab]', x => x.map(e => e.dataset.d))) {
    await p.click('#lx-t-' + t); await p.waitForTimeout(150);
    chk('dock tab ' + t + ' shows its panel', await p.evaluate(id => !document.getElementById('lx-d-' + id).hidden && document.getElementById('lx-t-' + id).getAttribute('aria-selected') === 'true', t));
  }
  await p.waitForTimeout(1500);
  chk('signal analysis is live', await p.evaluate(() => /dBFS|dBm/.test(document.getElementById('lp-bw').textContent)));
  chk('status line filled', await p.evaluate(() => /MS\/s/.test(document.getElementById('lx-status').textContent)));
  await p.click('#lx-help'); chk('help text toggles', await p.evaluate(() => !document.getElementById('lx').classList.contains('help-off')));
  const m = await open({ width: 390, height: 844 });
  chk('phone: no sideways scrolling', !(await m.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)));
  chk('no page errors', !errs.length, errs.slice(0, 3));
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
