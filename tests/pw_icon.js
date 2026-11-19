const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18117', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, x === undefined ? '' : JSON.stringify(x)); if (!c) ok = false; };
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:18117/#radio'); await p.waitForTimeout(2500);
  chk('header logo loads', await p.evaluate(() => { const i = document.querySelector('.brand img'); return i && i.complete && i.naturalWidth > 0; }));
  for (const u of ['/img/skywave.svg', '/img/skywave-1024.png', '/img/skywave-512.png', '/img/skywave-192.png', '/img/skywave-touch.png', '/img/skywave-touch-1024.png', '/img/skywave-maskable-512.png', '/favicon.ico', '/manifest.webmanifest']) {
    const r = await p.request.get('http://127.0.0.1:18117' + u); chk('serves ' + u, r.status() === 200 && (await r.body()).length > 100, [r.status(), r.headers()['content-type']]);
  }
  const dims = await p.evaluate(async () => { const o = {}; for (const u of ['/img/skywave-1024.png', '/img/skywave-512.png', '/img/skywave-touch.png']) { const i = new Image(); i.src = u; await i.decode(); o[u] = i.naturalWidth; } return o; });
  chk('icon sizes are real', dims['/img/skywave-1024.png'] === 1024 && dims['/img/skywave-512.png'] === 512 && dims['/img/skywave-touch.png'] === 180, dims);
  await p.evaluate(() => RS.audio.start()); await p.waitForTimeout(1200);
  const art = await p.evaluate(() => navigator.mediaSession && navigator.mediaSession.metadata && navigator.mediaSession.metadata.artwork.map(a => a.sizes));
  chk('lock-screen artwork supplied (1024, 512, 192)', art && art.join() === '1024x1024,512x512,192x192', art);
  chk('no page errors', errs.length === 0, errs);
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
