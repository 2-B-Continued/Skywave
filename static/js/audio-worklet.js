/* audio-worklet.js - the live radio player, running on the browser's audio thread (AudioWorklet).

   Sound arrives from the network in uneven bursts (Wi-Fi, a busy computer, a busy page). Playing each burst the moment it
   lands is what causes clicks, gaps and slow drift. Instead every sample goes into a ring buffer, and this processor plays
   from it at a steady pace, a fixed cushion (the "target") behind the newest sound:

   - Start: stay silent until the cushion is full, then fade in over 6 ms.
   - Drift: the radio's clock and the sound card's clock never agree exactly, so the cushion slowly grows or shrinks. The
     playback speed is nudged by up to 0.8% (a pitch change far too small to hear) to hold the cushion at its target.
   - Drop-out: if the buffer runs dry, fade out over the last samples (no click), wait for the cushion to refill, fade back in,
     and make the cushion a little bigger so the same hiccup does not happen again. The extra is kept: only after two
     minutes in which the cushion was never nearly used up does it shrink, 5 ms at a time, so a hiccup that recurs every
     minute or so (a busy computer, Wi-Fi scanning for networks) is covered for good instead of breaking the sound each
     time it comes back.
   - Far behind (a long stall followed by a flood): skip ahead to the target with a short crossfade, so the sound is never late.
   - Retune: "flush" fades the old station out in 8 ms and starts clean, so tuning sounds instant.

   Input: 48 kHz 16-bit mono or interleaved stereo frames, arriving on a MessagePort straight from the network worker
   (audio-net.js), so a busy page never sits between the network and the speaker. Output: stereo at the sound card's rate
   (resampled here). Reports buffer, cushion, drop-outs and level about 30 times a second. */
class SkywaveCore {
  // rate: the output rate; post: where stats go (the worklet's port, or a callback on the page)
  constructor(o, rate, post) {
    o = o || {};
    this.outRate = rate; this.post = post; this.statEvery = o.statEvery || 12;
    this.inRate = 48000;
    this.cap = this.inRate * 8;                         // 8 s of room
    this.L = new Float32Array(this.cap);
    this.R = new Float32Array(this.cap);
    this.w = 0;                                         // write index
    this.ri = 0; this.rf = 0;                           // read position: integer index and fraction
    this.n = 0;                                         // samples waiting (input rate)
    this.base = o.target || 0.15;                       // the cushion asked for, in seconds
    this.target = this.base;
    this.maxT = 0.8;
    this.playing = false;
    this.g = 0;                                         // fade gain
    this.cut = false;                                   // a retune: fade out, then clear
    this.under = 0; this.skips = 0; this.calm = 0; this.frames = 0;
    this.level = 0; this.statN = 0; this.rate = 1;
  }

  msg(d) {
    if (!d) return;
    if (d.t === 'pcm') this.push(d.b, d.s);
    else if (d.t === 'flush') this.cut = true;
    else if (d.t === 'target') { this.base = Math.max(0.04, Math.min(1.2, +d.v || 0.15)); this.target = Math.max(this.base, Math.min(this.target, this.base * 2)); }
  }

  push(buf, stereo) {
    if (new Uint8Array(buf, 0, 1)[0] === 4) return this.push4(buf);
    const pcm = new Int16Array(buf.slice(1, 1 + ((buf.byteLength - 1) & ~1)));   // byte 0 is the frame type; 16-bit views need an even offset
    const fr = stereo ? pcm.length >> 1 : pcm.length;
    if (fr <= 0) return;
    this.frames++; this.inQ = 48;
    let w = this.w; const cap = this.cap, L = this.L, R = this.R, k = 1 / 32768;
    if (stereo) for (let i = 0; i < fr; i++) { L[w] = pcm[2 * i] * k; R[w] = pcm[2 * i + 1] * k; if (++w === cap) w = 0; }
    else for (let i = 0; i < fr; i++) { const v = pcm[i] * k; L[w] = v; R[w] = v; if (++w === cap) w = 0; }
    this.w = w;
    this.added(fr);
  }

  // A reduced-quality frame (type 4: rate in kHz, channels, coding). Decoded, then brought up to 48 kHz with a cubic
  // (Catmull-Rom) interpolator whose last samples carry over, so there is no seam between frames.
  push4(buf) {
    const h = new Uint8Array(buf, 0, 4), rate = h[1] * 1000, ch = h[2] || 1, mu = h[3] === 1;
    if (!rate) return;
    let x;
    if (mu) {
      const u = new Uint8Array(buf, 4), lg = Math.log1p(255);
      if (!this.muT) { this.muT = new Float32Array(256); for (let i = 0; i < 256; i++) { const y = i / 127.5 - 1; this.muT[i] = Math.sign(y) * Math.expm1(Math.abs(y) * lg) / 255; } }
      x = new Float32Array(u.length); for (let i = 0; i < u.length; i++) x[i] = this.muT[u[i]];
    } else {
      const p = new Int16Array(buf.slice(4, 4 + ((buf.byteLength - 4) & ~1))); x = new Float32Array(p.length);
      for (let i = 0; i < p.length; i++) x[i] = p[i] / 32768;
    }
    const n = (x.length / ch) | 0; if (n <= 0) return;
    this.frames++; this.inQ = h[1];
    if (this.uRate !== rate || this.uCh !== ch) { this.uRate = rate; this.uCh = ch; this.uPos = 0; this.uHist = [new Float32Array(3), new Float32Array(3)]; }
    const step = rate / this.inRate, cap = this.cap, L = this.L, R = this.R;
    // input stream for each channel: the 3 carried samples, then this frame
    const get = (c, i) => i < 3 ? this.uHist[c][i] : x[(i - 3) * ch + (ch === 2 ? c : 0)];
    let pos = this.uPos, w = this.w, made = 0;
    const last = n + 3;
    while (pos + 2 < last - 1) {
      const i = pos | 0, f = pos - i;
      for (let c = 0; c < 2; c++) {
        const cc = ch === 2 ? c : 0;
        const p0 = get(cc, i), p1 = get(cc, i + 1), p2 = get(cc, i + 2), p3 = get(cc, i + 3);
        const v = p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
        (c ? R : L)[w] = v;
      }
      if (++w === cap) w = 0;
      made++; pos += step;
    }
    for (let c = 0; c < 2; c++) { const cc = ch === 2 ? c : 0; for (let j = 0; j < 3; j++) this.uHist[c][j] = get(cc, last - 3 + j); }
    this.uPos = pos - n;
    this.w = w;
    this.added(made);
  }

  added(fr) {
    const cap = this.cap;
    this.n += fr;
    if (this.n > cap - 128) { const drop = this.n - (cap - 128); this.ri = (this.ri + drop) % cap; this.n -= drop; }
    // far behind real time (a stall then a flood): jump to the target, keeping a little extra so it does not run dry at once
    const behind = this.n / this.inRate;
    if (this.playing && behind > this.target + 0.3) {
      const keep = Math.round((this.target + 0.05) * this.inRate), drop = this.n - keep;
      this.ri = (this.ri + drop) % cap; this.n = keep; this.skips++;
      this.g = Math.min(this.g, 0.3);                   // the jump lands softly
    }
  }

  render(oL, oR) {
    const N = oL.length; const sampleRate = this.outRate;
    const cap = this.cap, L = this.L, R = this.R;
    const step0 = this.inRate / sampleRate;
    let peak = 0;

    if (this.cut) {                                    // retune: fade out within this block, then empty the buffer
      for (let i = 0; i < N; i++) {
        const g = this.g * (1 - i / N), j = this.ri;
        oL[i] = L[j] * g; oR[i] = R[j] * g;
        if (this.n > 1) { this.ri = (this.ri + 1) % cap; this.n--; }
      }
      this.cut = false; this.playing = false; this.g = 0; this.ri = this.w; this.n = 0; this.rf = 0;
      return this.stat(0, true);
    }

    const buffered = this.n / this.inRate;
    if (!this.playing) {
      if (buffered >= this.target) { this.playing = true; this.g = 0; }
      else { oL.fill(0); if (oR !== oL) oR.fill(0); return this.stat(0, true); }
    }

    // hold the cushion at the target by playing a hair faster or slower (at most 0.8%)
    const err = buffered - this.target;
    const want = 1 + Math.max(-0.01, Math.min(0.01, err * 0.08));     // 50 ms over target: 0.4% faster, inaudible
    this.rate += (want - this.rate) * 0.02;
    const step = step0 * this.rate;

    // enough left for this block? If not, play what there is with a fade to silence, then refill
    const need = Math.ceil(N * step) + 2;
    let avail = N, dry = false;
    if (this.n < need) { avail = Math.max(0, Math.floor((this.n - 2) / step)); dry = true; }
    const fadeIn = 1 / (0.006 * sampleRate);
    for (let i = 0; i < N; i++) {
      if (i >= avail) { oL[i] = 0; oR[i] = 0; continue; }
      let g = this.g;
      if (dry) g *= 1 - i / Math.max(1, avail);          // fade out on the way into a drop-out
      else if (g < 1) { g = Math.min(1, g + fadeIn); this.g = g; }
      const a = this.ri, b = a + 1 === cap ? 0 : a + 1, f = this.rf;
      const l = (L[a] + (L[b] - L[a]) * f) * g, r = (R[a] + (R[b] - R[a]) * f) * g;
      oL[i] = l; oR[i] = r;
      const al = l < 0 ? -l : l; if (al > peak) peak = al;
      this.rf += step;
      const adv = this.rf | 0;
      if (adv) { this.rf -= adv; this.ri = (this.ri + adv) % cap; this.n -= adv; }
    }
    if (dry) {
      this.playing = false; this.g = 0; this.under++;
      this.target = Math.min(this.maxT, this.target + 0.03);   // a slightly bigger cushion next time
      this.calm = 0;
    } else {
      // after two minutes without a drop-out or a near miss (the cushion all but used up), give back some of the extra
      // cushion: 5 ms every 15 s, down to what was asked for
      this.calm = this.n < this.target * this.inRate * 0.25 ? 0 : this.calm + N / sampleRate;
      if (this.calm > 120 && this.target > this.base) { this.target = Math.max(this.base, this.target - 0.005); this.calm = 105; }
    }
    return this.stat(peak, false);
  }

  stat(peak, idle) {
    this.level = Math.max(this.level * 0.92, peak);
    if (++this.statN >= (this.statEvery || 12)) {         // about every 32 ms on the audio thread
      this.statN = 0;
      this.post({ t: 'stat', q: this.inQ, level: this.level, buf: this.n / this.inRate, target: this.target, under: this.under,
        skips: this.skips, frames: this.frames, playing: this.playing, rate: this.rate, idle });
    }
    return true;
  }
}

// On the audio thread (secure pages): an AudioWorkletProcessor around the core.
if (typeof AudioWorkletProcessor !== 'undefined') {
  class SkywavePlayer extends AudioWorkletProcessor {
    constructor(opts) {
      super();
      this.core = new SkywaveCore((opts && opts.processorOptions) || {}, sampleRate, m => this.port.postMessage(m));
      const on = d => { if (d && d.t === 'port') d.port.onmessage = e => this.core.msg(e.data); else this.core.msg(d); };
      this.port.onmessage = e => on(e.data);
    }
    process(inputs, outputs) { const o = outputs[0]; return this.core.render(o[0], o[1] || o[0]); }
  }
  registerProcessor('skywave-player', SkywavePlayer);
} else if (typeof self !== 'undefined') {
  self.SkywaveCore = SkywaveCore;      // on the page (plain http, where browsers switch the audio thread off): sound.js drives it
}
