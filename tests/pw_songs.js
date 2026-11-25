// Songs heard: a saved cover the server can no longer give never shows as a broken picture; songs without a cover get the
// placeholder, are looked up again once, and get their cover back when one is found.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'songs-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18133', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } });
  await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n, c ? '' : JSON.stringify(x)); ok = ok && !!c; };
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const asked = [];
  await p.route('**/api/art?**', r => {
    const q = new URL(r.request().url()).searchParams.get('q'); asked.push(q);
    const found = q === 'Band - Found Song';
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(found ? { art: '/img/skywave-192.png?v=5', artist: 'Band', title: 'Found Song', album: '', track: null } : { art: null, artist: '', title: '', album: '', track: null }) });
  });
  const now = Math.round(Date.now() / 1000);
  await p.addInitScript(t => localStorage.setItem('rs.rd_songs', JSON.stringify([
    { t: t, title: 'Gone Cover', artist: 'Band', url: '/api/artimg/00000000deadbeef', station: 'Test FM', f: 100e6 },
    { t: t - 60, title: 'Found Song', artist: 'Band', url: '', station: 'Test FM', f: 100e6 },
    { t: t - 120, title: 'Never Found', artist: 'Band', url: '', station: 'Test FM', f: 100e6 }])), now);
  await p.goto('http://127.0.0.1:18133/#radio'); await p.waitForTimeout(2500);
  await p.click('[data-rd-tab="songs"]'); await p.waitForTimeout(400);
  // the list is drawn once; covers found later go into their own rows without the list being redrawn
  await p.evaluate(() => { window.__redraws = 0; new MutationObserver(m => { window.__redraws += m.filter(x => x.type === 'childList').length; }).observe(document.getElementById('rd-list'), { childList: true }); });
  await p.waitForTimeout(6100);
  const st = await p.evaluate(() => {
    const rows = [...document.querySelectorAll('#rd-list .rdp-song')];
    return rows.map(r => { const im = r.querySelector('img'); return { t: r.querySelector('b').textContent, img: im ? (im.complete && im.naturalWidth > 0 ? 'ok' : 'broken') : null, ph: !!r.querySelector('.rdp-song-ph svg') }; });
  });
  chk('three songs listed', st.length === 3, st);
  chk('no broken pictures anywhere', !st.some(x => x.img === 'broken'), st);
  chk('a lost cover shows the placeholder', st.find(x => x.t === 'Gone Cover').ph, st);
  chk('a cover found again is put back', st.find(x => x.t === 'Found Song').img === 'ok', st);
  chk('a song with no cover keeps the placeholder', st.find(x => x.t === 'Never Found').ph, st);
  chk('each song looked up once', asked.length === 3 && new Set(asked).size === 3, asked);
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('rs.rd_songs')));
  chk('found cover saved for next time', saved.find(x => x.title === 'Found Song').url.startsWith('/img/'), saved);
  chk('lost cover address cleared', saved.find(x => x.title === 'Gone Cover').url === '', saved);
  chk('the list is not redrawn while covers are looked up', await p.evaluate(() => window.__redraws === 0), await p.evaluate(() => window.__redraws));
  chk('no page errors', !errs.length, errs);
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
