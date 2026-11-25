// Screenshots for the README (docs/screenshots). Runs Skywave in simulator mode with the test stand-ins (no dongle, no
// network): planes from the simulator, sensors from tests/bin/fake_rtl433.py, satellite passes from tests/space_mock.js.
// Run: NODE_PATH=$(npm root -g) node tools/screenshots.js
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..'), OUT = process.env.OUT || path.join(ROOT, 'docs', 'screenshots'), PORT = '18140';
const mock = require(path.join(ROOT, 'tests', 'space_mock.js'));
const W = 1600, H = 1000;
const STYLES = ['skywave', 'depth', 'relief', 'walnut', 'riot', 'bento', 'folio', 'terminal', 'brut', 'ticket'];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: ROOT, env: { ...process.env, SIM: '1', PORT, DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1',
    LAT: '-33.92', LON: '18.42', RTL433_BIN: 'python3 ' + path.join(ROOT, 'tests', 'bin', 'fake_rtl433.py'), FAKE433_FAST: '1' } });
  await new Promise(r => setTimeout(r, 4500));
  const b = await chromium.launch();
  const url = 'http://127.0.0.1:' + PORT + '/';
  const page = async (vp, opt) => {
    const ctx = await b.newContext(Object.assign({ viewport: vp, deviceScaleFactor: 1 }, opt || {}));
    const p = await ctx.newPage(); await mock(p);
    await p.route('**/api/art?**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ art: null }) }));
    await p.addInitScript(() => { try { localStorage.setItem('rs.rd_songs', '[]'); } catch (e) { } });
    await p.goto(url + '#home'); await p.waitForTimeout(3000);
    return p;
  };
  const shot = async (p, name, go, wait) => {
    await p.evaluate(g => RS.go(g), go); await p.waitForTimeout(wait || 2500);
    await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('wrote', name);
  };
  // desktop pages in the default style
  const p = await page({ width: W, height: H });
  await p.evaluate(() => RS.setFavs ? 0 : RS.api('favourites', { list: [{ f: 100.0e6, name: 'Music FM', mode: 'wfm' }, { f: 104.5e6, name: 'News Talk', mode: 'wfm' }, { f: 145.5e6, name: '2 m calling', mode: 'nfm' }, { f: 121.5e6, name: 'Air guard', mode: 'am' }] }));
  await p.waitForTimeout(800);
  await shot(p, 'home', 'home', 4000);
  await shot(p, 'radio', 'radio');
  await p.evaluate(() => document.getElementById('mode-adv').click()); await p.waitForTimeout(400);
  await shot(p, 'lab', 'lab', 3500);
  await shot(p, 'scanner', 'scanner');
  await shot(p, 'space', 'space');
  await p.evaluate(() => RS.go('planes')); await p.waitForTimeout(14000);
  await shot(p, 'planes', 'planes', 1500);
  await p.evaluate(() => RS.go('sensors')); await p.waitForTimeout(9000);
  await shot(p, 'sensors', 'sensors', 1500);
  await p.evaluate(() => { RS.go('home'); document.getElementById('mode-adv') && RS.store.set('adv', false); });
  // every style: Home, as a 5 x 2 grid
  const tiles = [];
  for (const s of STYLES) {
    await p.evaluate(x => { RS.setStyle(x); RS.go('radio'); RS.go('home'); }, s); await p.waitForTimeout(2600);
    const f = path.join(d, 'style-' + s + '.png'); await p.screenshot({ path: f }); tiles.push([s, f]);
  }
  await p.evaluate(() => RS.setStyle('skywave'));
  const grid = await (await b.newContext({ viewport: { width: 1800, height: 1143 }, deviceScaleFactor: 1 })).newPage();
  await grid.setContent('<body style="margin:0;background:#0b0f12;display:grid;grid-template-columns:repeat(5,1fr);align-content:start;gap:6px;padding:6px;font:600 13px system-ui;color:#e8eef0">' +
    tiles.map(([s, f]) => '<figure style="margin:0"><img style="width:100%;display:block;border-radius:6px" src="data:image/png;base64,' + fs.readFileSync(f).toString('base64') + '"><figcaption style="padding:6px 2px 10px">' + s[0].toUpperCase() + s.slice(1) + '</figcaption></figure>').join('') + '</body>');
  await grid.waitForTimeout(500);
  const gh = await grid.evaluate(() => Math.ceil(Math.max(...[...document.querySelectorAll('figure')].map(f => f.getBoundingClientRect().bottom))) + 6);
  await grid.setViewportSize({ width: 1800, height: gh }); await grid.screenshot({ path: path.join(OUT, 'styles.png') }); console.log('wrote styles');
  // phone: Home, Radio and the Lab side by side
  const ph = await page({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const parts = [];
  for (const g of ['home', 'radio', 'planes']) { await ph.evaluate(x => RS.go(x), g); await ph.waitForTimeout(g === 'planes' ? 8000 : 2500); const f = path.join(d, 'phone-' + g + '.png'); await ph.screenshot({ path: f }); parts.push(f); }
  const pg = await (await b.newContext({ viewport: { width: 1680, height: 892 }, deviceScaleFactor: 1 })).newPage();
  await pg.setContent('<body style="margin:0;background:#0b0f12;display:flex;gap:40px;justify-content:center;align-items:center;height:892px">' +
    parts.map(f => '<img style="height:844px;border-radius:28px;box-shadow:0 20px 60px #0008" src="data:image/png;base64,' + fs.readFileSync(f).toString('base64') + '">').join('') + '</body>');
  await pg.waitForTimeout(500); await pg.screenshot({ path: path.join(OUT, 'phone.png') }); console.log('wrote phone');
  await b.close(); srv.kill(); fs.rmSync(d, { recursive: true, force: true });
})();
