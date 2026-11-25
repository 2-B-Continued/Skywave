// Changing frequency: the new station is heard almost at once. The cushion has grown to 0.6 s after earlier drop-outs;
// on a retune the old sound is cut, any of it still arriving before the server's "new station" mark is dropped, and the
// new sound starts as soon as the asked-for cushion (90 ms) is there, not the grown one.
const fs = require('fs'), path = require('path');
const self = {}; new Function('self', fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'audio-worklet.js'), 'utf8'))(self);
const core = new self.SkywaveCore({ target: 0.09, statEvery: 1e9 }, 48000, () => {});
const frame = v => { const b = new ArrayBuffer(1 + 960 * 2), d = new DataView(b); d.setUint8(0, 2); for (let i = 0; i < 960; i++) d.setInt16(1 + 2 * i, v, true); return b; };   // 20 ms of one level
const oL = new Float32Array(128), oR = new Float32Array(128);
let t = 0, tIn = 0;
core.target = 0.6;                                           // grown after earlier drop-outs
const run = (until, v) => { while (t < until) { while (tIn <= t) { core.push(frame(v), false); tIn += 0.02; } core.render(oL, oR); t += 128 / 48000; } };
run(3, 1000);                                                // the old station, playing
const fails = []; const chk = (n, ok, info) => { console.log((ok ? 'ok   ' : 'FAIL ') + n + (ok ? '' : '  ' + JSON.stringify(info))); if (!ok) fails.push(n); };
chk('the old station is playing with the grown cushion', core.playing && core.n / 48000 > 0.4, core.n / 48000);
core.msg({ t: 'flush' });                                    // you tune
core.push(frame(1000), false); core.push(frame(1000), false); // old sound still on its way
core.msg({ t: 'new' });                                      // the server: the new station starts here
const t0 = t; let heard = null, oldHeard = false;
while (t < t0 + 1) {
  while (tIn <= t) { core.push(frame(-2000), false); tIn += 0.02; }
  core.render(oL, oR); t += 128 / 48000;
  for (let i = 0; i < 128; i++) { if (t - t0 > 0.01 && oL[i] > 0.01) oldHeard = true; if (heard === null && oL[i] < -0.01) heard = t - t0; }
}
chk('the new station is heard within 120 ms (' + (heard * 1000).toFixed(0) + ' ms)', heard !== null && heard < 0.12, heard);
chk('none of the old station plays after the retune', !oldHeard);
chk('the grown cushion is kept for later', core.target >= 0.5, core.target);
run(t + 30, -2000);
chk('no drop-out while the cushion builds back up', core.under === 0, core.under);
if (fails.length) { console.log('SOME FAILED'); process.exit(1); } console.log('ALL PASS');
