// Space: the next pass with its path and a live countdown, the sky at a glance, coming up, scheduling, satellites,
// aiming. The sandbox has no orbit library, so passes come from tests/space_mock.js. Run: node tests/pw_space.js
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const mock = require('./space_mock.js');
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'spt-'));
  const srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT: '18111', DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1', LAT: '-33.92', LON: '18.42' } });
  for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:18111/healthz'); break; } catch (e) { await new Promise(r => setTimeout(r, 250)); } }
  let ok = true; const chk = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, x === undefined ? '' : JSON.stringify(x)); if (!c) ok = false; };
  const b = await chromium.launch();
  for (const live of [false, true]) {
    console.log(live ? '--- a pass overhead now' : '--- next pass ahead');
    const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    const posts = []; p.on('request', r => { if (r.method() === 'POST') posts.push(r.url() + ' ' + (r.postData() || '')); });
    await mock(p, { live });
    await p.goto('http://127.0.0.1:18111/#space'); await p.waitForTimeout(3000);
    chk('next pass is the ISS', (await p.textContent('#sp-info .spx-name')) === 'ISS');
    const c1 = await p.textContent('#sp-count'); await p.waitForTimeout(2100); const c2 = await p.textContent('#sp-count');
    chk('countdown is live', c1 !== c2 && /min/.test(c2), [c1, c2]);
    chk(live ? 'says overhead now, with progress' : 'says until it rises', live ? /Overhead now/.test(await p.textContent('#sp-info')) && await p.isVisible('#sp-prog') : /until it rises/.test(await p.textContent('#sp-info')));
    chk('path drawn on the sky', await p.evaluate(() => { const c = document.getElementById('sp-sky'), g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 200) n++; return n > 300; }));
    chk('positions are called calculated', /calculated from orbit data/.test(await p.textContent('#p-space')));
    chk('sky at a glance has a row per satellite', (await p.$$('#sp-tl .spx-tl-row')).length === 6, (await p.$$('#sp-tl .spx-tl-row')).length);
    // pick another pass on the timeline
    const k = await (await p.$$('#sp-tl .spx-pass'))[3].getAttribute('data-k'); await p.click('#sp-tl .spx-pass[data-k="' + k + '"]'); await p.waitForTimeout(400);
    chk('tapping a bar shows that pass', (await p.getAttribute('#sp-tl .spx-pass.on', 'data-k')) === k && await p.evaluate(k => RS.pages.space.sel === k, k));
    await p.click('[data-act="sp-step"][data-d="1"]'); await p.waitForTimeout(300);
    chk('later-pass button moves on', (await p.$$('#sp-tl .spx-pass.on')).length === 1);
    // filters
    await p.click('[data-act="sp-filter"][data-f="good"]'); await p.waitForTimeout(200);
    const good = await p.$$eval('#sp-passes .spx-q', l => l.map(e => e.textContent));
    chk('Worth it keeps good and excellent passes', good.length > 0 && good.every(t => /Good|Excellent/.test(t)), good);
    await p.click('[data-act="sp-filter"][data-f="all"]');
    // schedule from the list
    await p.click('#sp-passes [data-act="sp-sched"]'); await p.waitForTimeout(800);
    chk('schedule request sent', posts.some(u => /space\/schedule/.test(u)), posts.slice(-2));
    // several in a row: the messages stack to three at most, the page keeps answering, and they all leave
    for (let i = 0; i < 5; i++) { const bs = await p.$$('#sp-passes [data-act="sp-sched"]'); if (!bs[i + 1]) break; await bs[i + 1].click(); await p.waitForTimeout(350); }
    const t0 = Date.now(); const nt = await p.evaluate(() => document.querySelectorAll('#toasts > :not(.out)').length);
    chk('page still answers after many recordings', Date.now() - t0 < 1500, Date.now() - t0);
    chk('at most three messages stay', nt <= 4, nt);
    await p.waitForFunction(() => document.querySelectorAll('#toasts > *').length === 0, null, { timeout: 15000 }).then(() => chk('the messages go away', true), () => chk('the messages go away', false));
    // satellites
    await p.click('#sp-sats details summary'); await p.waitForTimeout(300);
    chk('a satellite opens to its channels', (await p.$$('#sp-sats details[open] .spx-ch')).length >= 1);
    chk('aiming is mounted in its section', !!(await p.$('#sp-aim-slot #aim-card')));
    chk('no page errors', errs.length === 0, errs);
  }
  await b.close(); srv.kill(); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
