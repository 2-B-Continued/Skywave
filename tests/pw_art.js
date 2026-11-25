// Cover art shows on the Radio page and in the bottom bar when the station sends "Artist - Title", and the switch in Settings turns it off.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18122', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, x === undefined ? '' : JSON.stringify(x)); if (!c) ok = false; };
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'); const asked = [];
  await p.route('**/api/art?*', r => { const u = decodeURIComponent(r.request().url().split('q=')[1]); asked.push(u);
    if (/parse=1/.test(u) || /^UB40/.test(u)) return r.fulfill({ json: { art: null, artist: 'UB40', title: 'I Got You Babe', album: '', song: true } });   // no cover anywhere
    r.fulfill({ json: { art: '/api/artimg/test', artist: 'Dua Lipa', title: 'Houdini', album: 'Radical Optimism' } }); });
  await p.route('**/api/artimg/test', r => r.fulfill({ body: PNG, contentType: 'image/png' }));
  await p.goto('http://127.0.0.1:18122/#radio'); await p.waitForTimeout(2500);
  await p.evaluate(() => { RS.tune(100.0e6, { mode: 'wfm' }); });
  await p.waitForTimeout(1500);
  const say = rt => p.evaluate(t => { clearInterval(window.__iv); const f = () => { RS.st.rds = { ps: 'TESTFM', rt: t, pty: 10, pty_name: 'Pop' }; RS.fire('state'); }; f(); window.__iv = setInterval(f, 100); }, rt);   // the server's own state pushes would otherwise overwrite the pretend RadioText
  await say('Dua Lipa - Houdini'); await p.waitForTimeout(2200);
  chk('lookup asked with the song text', asked.some(a => a.split('&cc=')[0] === 'Dua Lipa - Houdini'), asked);
  chk('radio page shows the art', await p.isVisible('#rd-art'));
  chk('bottom bar shows the art', await p.isVisible('#sb-art'));
  await say('Win a trip! Text 1800 123 456'); await p.waitForTimeout(300);
  chk('art clears when the text changes', !(await p.isVisible('#rd-art')));
  await say('UB40 - I Got You Babe'); await p.waitForTimeout(2200);
  const songs = await p.evaluate(() => RS.store.get('rs_songs', null) || Object.keys(localStorage).filter(k => /song/i.test(k)).map(k => localStorage.getItem(k)));
  chk('a song with no cover anywhere still goes on the songs heard list', JSON.stringify(songs).includes('I Got You Babe'), songs);
  chk('and shows no picture', !(await p.isVisible('#rd-art')));
  await p.goto('http://127.0.0.1:18122/#settings'); await p.waitForTimeout(2000);
  chk('switch exists and is on', await p.isChecked('#st-art-on'));
  await p.uncheck('#st-art-on'); await p.waitForTimeout(300);
  asked.length = 0; await p.evaluate(() => { location.hash = 'radio'; RS.go('radio'); }); await p.waitForTimeout(500);
  await say('Dua Lipa - Houdini'); await p.waitForTimeout(2200);
  chk('switched off means no lookup, only reading the song out of the text', asked.length > 0 && asked.every(a => /parse=1/.test(a)), asked);
  chk('no page errors', errs.length === 0, errs);
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
