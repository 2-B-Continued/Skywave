// The live player learns from a hiccup that keeps coming back. Sound arrives in 50 ms frames with a little jitter and a
// 200 ms stall every 45 s, for 30 simulated minutes: after the first few stalls the cushion has grown enough to cover
// them, and it does not shrink back while they keep coming. Once they stop, it gives the extra back.
const fs = require('fs'), path = require('path');
const self = {}; new Function('self', fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'audio-worklet.js'), 'utf8'))(self);
const core = new self.SkywaveCore({ target: 0.1, statEvery: 1e9 }, 48000, () => {});
const frame = () => { const b = new ArrayBuffer(1 + 2400 * 2); new Uint8Array(b)[0] = 2; return b; };
let tIn = 0, tOut = 0, seed = 1, nextStall = 45, at20 = 0;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const oL = new Float32Array(128), oR = new Float32Array(128);
while (tOut < 1800) {
  while (tIn <= tOut) {
    core.push(frame(), false); tIn += 0.05 + (rand() - 0.5) * 0.004;
    if (tIn > nextStall) { tIn += 0.2; nextStall += 45; }
  }
  core.render(oL, oR); tOut += 128 / 48000;
  if (!at20 && tOut >= 1200) at20 = core.under;
}
const grown = core.target;
// the stalls stop: over the next 20 minutes the extra cushion is given back
nextStall = Infinity;
while (tOut < 3000) {
  while (tIn <= tOut) { core.push(frame(), false); tIn += 0.05 + (rand() - 0.5) * 0.004; }
  core.render(oL, oR); tOut += 128 / 48000;
}
const fails = []; const chk = (n, ok, info) => { console.log((ok ? 'ok   ' : 'FAIL ') + n + (ok ? '' : '  ' + JSON.stringify(info))); if (!ok) fails.push(n); };
chk('fewer than 20 drop-outs in 30 minutes of recurring stalls', core.under < 20, core.under);
chk('at most two in the last 10 minutes', core.under - at20 <= 2, core.under - at20);
chk('the cushion stays grown while the stalls continue', grown >= 0.2, grown);
chk('and shrinks back once they stop', core.target <= 0.12, core.target);
console.log(fails.length ? 'FAILED: ' + fails.join(', ') : 'ALL PASS'); process.exit(fails.length ? 1 : 0);
