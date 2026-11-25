// OpenStreetMap's tile servers refuse tiles requested with no Referer. Map tiles carry this Skywave's address (and
// nothing more), while the rest of the app keeps sending no referrer at all.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18192', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  const fails = []; const chk = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(x))); if (!c) fails.push(n); };
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const refs = []; let pageRef = null;
  await p.route('https://tile.openstreetmap.org/**', r => { refs.push(r.request().headers()['referer'] || null); r.fulfill({ body: PNG, contentType: 'image/png' }); });
  const res = await p.goto('http://127.0.0.1:18192/#planes'); pageRef = res.headers()['referrer-policy'];
  await p.waitForTimeout(1500);
  await p.evaluate(() => { const m = RS.pages.planes.map; if (m && m.setTiles) m.setTiles(true); RS.store.set('map_tiles', true); });
  await p.evaluate(() => { const b = document.querySelector('[data-act="map-tiles"], [data-act="tiles"]'); if (b) b.click(); });
  await p.waitForTimeout(2500);
  chk('the page itself still sends no referrer', pageRef === 'no-referrer', pageRef);
  chk('map tiles were asked for', refs.length > 0, refs.length);
  chk('every tile carries a Referer', refs.length > 0 && refs.every(r => r), refs.slice(0, 3));
  chk('the Referer is only this Skywave\'s address, no page path', refs.every(r => r === 'http://127.0.0.1:18192/'), refs.slice(0, 3));
  await b.close(); srv.kill();
  console.log(fails.length ? 'SOME FAILED' : 'ALL PASS'); process.exit(fails.length ? 1 : 0);
})();
