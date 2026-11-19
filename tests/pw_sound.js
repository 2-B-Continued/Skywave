// Browser test (Playwright): the rebuilt live sound path (sound.js, audio-net.js, audio-worklet.js) and the connection manager.
// - desktop: Start sound reaches "playing" through the worklet, the cushion fills, frames keep arriving, few drop-outs
// - retune: the player is flushed and plays again within a second
// - the sound socket and the page socket are separate (the page socket carries no sound)
// - phone: the muted screen-off stream starts in the same tap; hiding the page unmutes it, showing the page mutes it again
// - connection: the page socket reconnects by itself within a few seconds after the server restarts; ping gets a pong
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const PORT = '18099';
// Run it as people actually open Skywave: by default over the computer's network address on plain http (an insecure page, where
// browsers switch the audio thread off and the page player takes over). HOST=127.0.0.1 runs it as a secure page (audio thread).
const ip = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
const HOST = process.env.HOST || (ip ? ip.address : '127.0.0.1');
let srv = null;
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-snd-'));
function start() { srv = spawn('python3', ['-W', 'ignore', 'server.py'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SIM: '1', PORT, DATA_DIR: d, NO_NET: '1', SETUP_DONE: '1' } }); }
(async () => {
  start(); await new Promise(r => setTimeout(r, 4000));
  let ok = true; const chk = (n, c, info) => { console.log(c ? 'ok  ' : 'FAIL', n, c ? '' : (info !== undefined ? JSON.stringify(info) : '')); if (!c) ok = false; };
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--no-proxy-server'], env: { ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '' } });
  console.log('host', HOST);
  for (const mobile of [false, true]) {
    console.log(mobile ? '--- phone' : '--- desktop');
    const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true } : { viewport: { width: 1200, height: 800 } });
    const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
    await pg.goto(`http://${HOST}:${PORT}/#radio`); await pg.waitForTimeout(2500);
    chk('connected', await pg.evaluate(() => RS.connected));
    const eng0 = await pg.evaluate(() => isSecureContext ? 'worklet' : 'page');
    await pg.click('#sb-play'); await pg.waitForTimeout(3500);
    const s1 = await pg.evaluate(() => ({ on: RS.audio.on, mode: RS.audio.mode, state: RS.audio.state, ...RS.audio.stats, net: RS.audio.net, ctx: RS.audio.ctx && RS.audio.ctx.state }));
    chk('sound on in live mode', s1.on && s1.mode === 'live', s1);
    chk('the right engine for this page (' + eng0 + ')', await pg.evaluate(() => RS.audio.engine) === eng0, await pg.evaluate(() => RS.audio.engine));
    chk('audio context running', s1.ctx === 'running', s1);
    chk('sound socket up', s1.net && s1.net.up, s1);
    chk('player is playing from its cushion', s1.state === 'playing' && s1.playing && s1.buf > 0.03, s1);
    await pg.waitForTimeout(4000);
    const s2 = await pg.evaluate(() => ({ ...RS.audio.stats }));
    chk('frames keep arriving', s2.frames > s1.frames + 10, [s1.frames, s2.frames]);
    chk('at most one drop-out in steady play', (s2.under || 0) - (s1.under || 0) <= 1, [s1.under, s2.under]);
    chk('cushion stays sensible (under 1 s)', s2.buf < 1.0, s2);
    // retune
    await pg.evaluate(() => { const f = RS.vfo(); RS.send({ cmd: 'tune', freq: f + 200000 }); });
    await pg.waitForTimeout(1500);
    const s3 = await pg.evaluate(() => ({ state: RS.audio.state, ...RS.audio.stats }));
    chk('plays again within 1.5 s of retuning', s3.state === 'playing' && s3.playing, s3);
    chk('sound level is measured', await pg.evaluate(() => RS.audio.level >= 0));
    chk('health line in Settings', await pg.evaluate(() => /Playing live|Buffering/.test(RS.audio.health())), await pg.evaluate(() => RS.audio.health()));
    if (mobile) {
      chk('screen-off stream started muted in the same tap', await pg.evaluate(() => { const e = document.getElementById('rs-live'); return !!e && !!e.src && e.muted; }));
      await pg.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
      await pg.waitForTimeout(400);
      chk('hidden: the stream takes over (unmuted)', await pg.evaluate(() => !document.getElementById('rs-live').muted));
      await pg.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
      await pg.waitForTimeout(1500);
      chk('shown: live player back, stream muted', await pg.evaluate(() => document.getElementById('rs-live').muted && RS.audio.mode === 'live'));
      chk('shown: playing again', await pg.evaluate(() => RS.audio.state === 'playing'), await pg.evaluate(() => [RS.audio.state, RS.audio.stats]));
    }
    await pg.click('#sb-play'); await pg.waitForTimeout(500);
    chk('stopped', await pg.evaluate(() => !RS.audio.on && RS.audio.state === 'off'));
    chk('no page errors', errs.length === 0, errs);
    if (!mobile) {
      // the page socket carries no sound: count binary sound frames on a second plain socket
      const n = await pg.evaluate(() => new Promise(res => { let c = 0, pong = false; const w = new WebSocket('ws://' + location.host + '/ws'); w.binaryType = 'arraybuffer';
        w.onopen = () => w.send('{"cmd":"ping"}');
        w.onmessage = e => { if (typeof e.data === 'string') { if (e.data.includes('"pong"')) pong = true; return; } const t = new Uint8Array(e.data)[0]; if (t === 2 || t === 3) c++; };
        RS.audio.start(); setTimeout(() => { w.close(); RS.audio.stop(); res({ c, pong }); }, 2500); }));
      chk('page socket carries no sound frames', n.c === 0, n);
      chk('ping is answered with pong', n.pong, n);
      // server restart: the page reconnects on its own, quickly
      srv.kill(); await new Promise(r => setTimeout(r, 1500));
      chk('notices the server is gone', !(await pg.evaluate(() => RS.connected)));
      start(); const t0 = Date.now(); let back = false;
      while (Date.now() - t0 < 15000) { await pg.waitForTimeout(250); if (await pg.evaluate(() => RS.connected)) { back = true; break; } }
      chk('reconnects by itself after a restart (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s incl. server start)', back);
    }
    await ctx.close();
  }
  await b.close(); srv.kill();
  console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
