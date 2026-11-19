/* sound.js - live radio sound.

   How the sound gets to you
   - Live: a network worker (audio-net.js) receives the radio's sound on its own WebSocket and passes it straight to an
     AudioWorklet (audio-worklet.js) that plays it from a self-adjusting cushion. Low delay, instant retuning, no clicks, and
     immune to a busy page.
   - Screen off on a phone: phones stop Web Audio when the screen locks. So on a phone, Start sound also starts the server's MP3
     stream in an <audio> element, muted, inside the same tap (phones only allow sound to start from a tap). When the page is
     hidden, that element is unmuted and the live player faded out; when you come back, the live player takes over again at
     the live edge. The element is kept within about a second of live the whole time, so the handover is short.
   - Fallback: a browser without AudioWorklet plays the MP3 stream directly.

   States (A.state): off, starting, buffering, playing, waiting (connected, but no sound arriving), reconnecting, blocked
   (the browser wants a tap). A.note is the short sentence the sound bar shows for anything but playing.

   Public API: RS.audio.on, start(), stop(), setVol(v), vol, level, frames, ctx, gain (Lab's analyser), useStream(), live. Settings: 'bgaudio' (keep playing with the screen off), 'audio_buf' (low / balanced / smooth). */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$;
  const A = RS.audio;
  const V = '?v=4';
  Object.assign(A, { ctx: null, gain: null, on: false, state: 'off', note: '', level: 0, frames: 0, live: false, mode: '', stats: {}, net: { up: false } });
  A.vol = RS.store.get('vol', 0.8);
  RS.clientId = RS.clientId || Math.random().toString(36).slice(2, 12);

  const hasWorklet = () => !!((window.AudioContext || window.webkitAudioContext) && window.Worker);   // the live player runs with or without the audio thread
  A.bgOn = () => RS.store.get('bgaudio', RS.isTouch) && !!RS.canStream;
  // iPhone and iPad pause a muted stand-in the moment you leave the app, and then only a press of play can restart it,
  // so there the sound plays through the phone's media player from the start (about a second behind live) whenever it
  // should keep going in the background. Elsewhere the live player is used, with the stand-in taking over when hidden.
  const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  A.ios = IOS;
  A.useStream = () => !hasWorklet() || (IOS && A.bgOn());   // whole-session MP3 (no live player)
  // cushion in seconds [computer, phone]. Live is the default: you hear the radio as it happens, a hair ahead of the captions.
  const BUF = { live: [0.06, 0.09], balanced: [0.15, 0.2], smooth: [0.45, 0.55] };
  A.bufMode = () => { const m = RS.store.get('audio_buf', 'live'); return BUF[m] ? m : 'live'; };
  // streaming quality (audioq.py on the server): 1 data saver ... 5 lossless
  const QUAL = [null,
    ['Data saver', '12 kHz mono, about 96 kbit/s. Phone-call sound: fine for voices on a poor mobile connection.'],
    ['Low', '16 kHz mono, about 128 kbit/s. Clear speech: aircraft, marine, ham and scanners lose almost nothing.'],
    ['Medium', '24 kHz, stereo kept, about 192 kbit/s (384 in stereo). Music sounds good at a fraction of the data.'],
    ['High', '32 kHz, 16-bit, stereo kept, about 512 kbit/s (1 Mbit/s in stereo). Full FM broadcast quality.'],
    ['Lossless', '48 kHz, 16-bit, stereo kept, about 768 kbit/s (1.5 Mbit/s in stereo). Exactly what the radio makes.']];
  A.quality = () => Math.min(5, Math.max(1, +RS.store.get('audio_q', 5) || 5));
  A.setQuality = q => {
    q = Math.min(5, Math.max(1, Math.round(+q) || 5)); RS.store.set('audio_q', q);
    if (worker) worker.postMessage({ t: 'quality', q });
    if (A.on && el && el.src) elRetry(0);                        // the MP3 stream picks its bitrate when it connects
    RS.fire('audio-quality', q);
  };
  A.target = () => { const b = BUF[A.bufMode()]; return RS.isTouch ? b[1] : b[0]; };

  let ctx = null, node = null, gainN = null, worker = null, ready = null, el = null, elMuted = true;
  const wsUrl = () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?audio=1&q=' + A.quality();

  // The sound bar shows a note only once a state has lasted a moment (starting and blocked show at once), so a quick
  // buffering blip never makes its text jump or restart scrolling.
  let noteT = 0;
  function setState(s, note) {
    note = note || '';
    if (A.state === s && A._want === note) return;
    const changed = A.state !== s;
    A.state = s; A._want = note;
    clearTimeout(noteT);
    const show = () => { if (A.state === s && A.note !== note) { A.note = note; if (RS.updateSound) RS.updateSound(); } };
    if (!note || s === 'starting' || s === 'blocked' || s === 'off') show(); else noteT = setTimeout(show, 1200);
    if (changed) RS.fire('audio');
  }

  // ---------------------------------------------------------------- volume, with short ramps so nothing clicks
  function ramp(to, sec) {
    if (!gainN || !ctx) return;
    const t = ctx.currentTime, g = gainN.gain;
    try { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(to, t + (sec || 0.04)); } catch (e) { g.value = to; }
  }
  A.setVol = v => {
    A.vol = v; RS.store.set('vol', v);
    if (A.on && !(document.hidden && el && !elMuted)) ramp(v, 0.05);
    if (el) el.volume = v;
    if (RS.player && RS.player.el) RS.player.el.volume = v;
  };

  // ---------------------------------------------------------------- the live player graph
  function makeContext() {                                // must run inside the tap
    if (ctx) return true;
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return false;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { }   // iPhone: play even with the silent switch on
    try { ctx = new C({ latencyHint: 'interactive' }); } catch (e) { ctx = new C(); }       // the smallest output buffer the device allows
    A.ctx = ctx;
    gainN = ctx.createGain(); gainN.gain.value = 0; gainN.connect(ctx.destination); A.gain = gainN;
    ctx.onstatechange = () => { if (A.on && A.mode === 'live' && ctx.state !== 'running' && !document.hidden) wake(); stateFromStats(); };
    return true;
  }
  function unlock() {                                     // iOS: a silent sound inside the tap unlocks output for good
    try { const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); } catch (e) { }
    try { const p = ctx.resume(); if (p && p.catch) p.catch(() => { }); } catch (e) { }
  }
  // Two engines, same player core (audio-worklet.js):
  //  - 'worklet': on the browser's audio thread. Browsers only allow this on secure pages (https, or localhost).
  //  - 'page': the same core driven by a ScriptProcessor on the page, for plain http on a home network, where the audio
  //    thread is switched off. A slightly bigger cushion covers the page being busy now and then.
  function loadScript(src) { return new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); }); }
  function startWorker(onPcm) {
    worker = new Worker('/js/audio-net.js' + V);
    worker.onmessage = e => { const d = e.data; if (d && d.t === 'pcm') onPcm(d); else onNet(d); };
  }
  function graph() {
    if (ready) return ready;
    const canWorklet = !!(ctx.audioWorklet && window.AudioWorkletNode) && window.isSecureContext !== false;
    if (canWorklet) {
      ready = ctx.audioWorklet.addModule('/js/audio-worklet.js' + V).then(() => {
        node = new AudioWorkletNode(ctx, 'skywave-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { target: A.target() } });
        node.connect(gainN);
        node.port.onmessage = e => onStat(e.data);
        startWorker(() => { });
        const ch = new MessageChannel();
        node.port.postMessage({ t: 'port', port: ch.port1 }, [ch.port1]);
        worker.postMessage({ t: 'port', port: ch.port2 }, [ch.port2]);
        A.engine = 'worklet';
        return true;
      });
    } else {
      ready = (window.SkywaveCore ? Promise.resolve() : loadScript('/js/audio-worklet.js' + V)).then(() => {
        if (!ctx.createScriptProcessor) throw new Error('no ScriptProcessor');
        const core = new window.SkywaveCore({ target: pageTarget(), statEvery: 1 }, ctx.sampleRate, onStat);
        const sp = A.sp = ctx.createScriptProcessor(2048, 1, 2);
        sp.onaudioprocess = e => { const o = e.outputBuffer; core.render(o.getChannelData(0), o.numberOfChannels > 1 ? o.getChannelData(1) : o.getChannelData(0)); };
        sp.connect(gainN);
        node = { port: { postMessage: m => core.msg(m.t === 'target' ? { t: 'target', v: pageTarget() } : m) } };
        startWorker(d => core.push(d.b, d.s));
        A.engine = 'page';
        return true;
      });
    }
    ready = ready.catch(err => { console.warn('live player unavailable', err); ready = null; return false; });
    return ready;
  }
  const pageTarget = () => Math.max(A.target(), RS.isTouch ? 0.14 : 0.1);
  function wake() {
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    try { const p = ctx.resume(); if (p && p.catch) p.catch(() => { }); } catch (e) { }
  }

  // ---------------------------------------------------------------- what the player and the network report
  let lastStat = 0, lastFrameT = 0, lastFrames = 0;
  function onStat(d) {
    if (!d || d.t !== 'stat') return;
    A.stats = d; lastStat = performance.now();
    if (d.frames !== lastFrames) { lastFrames = d.frames; lastFrameT = lastStat; }
    A.frames = d.frames;
    if (A.mode === 'live' && !(document.hidden && el && !elMuted)) A.level = Math.max(A.level, Math.min(1, d.level * 1.6));
    stateFromStats();
  }
  function onNet(d) {
    if (!d) return;
    if (d.t === 'net') { A.net.up = d.up; stateFromStats(); }
    if (d.t === 'rate') { A.net.rate = d.bytes; A.net.up = d.up; stateFromStats(); }
  }
  function soundExpected() {                              // is the radio making sound right now? (not while tracking planes etc.)
    const st = RS.st || {};
    return !st.job || st.job === 'listen' || st.job === 'scan';
  }
  function stateFromStats() {
    if (!A.on) return;
    if (A.mode !== 'live') return;
    if (ctx && ctx.state !== 'running' && !document.hidden) return setState('blocked', 'Tap anywhere to let the sound play.');
    if (!A.net.up) return setState(A.state === 'starting' ? 'starting' : 'reconnecting', A.state === 'starting' ? 'Starting sound...' : 'Sound connection lost. Reconnecting...');
    const now = performance.now(), s = A.stats || {};
    if (now - lastFrameT > 2500) return setState('waiting', soundExpected() ? 'Waiting for sound from the radio...' : '');
    if (!s.playing) return setState('buffering', 'Buffering...');
    setState('playing', '');
  }
  setInterval(() => { if (A.on) stateFromStats(); }, 1000);

  // ---------------------------------------------------------------- the MP3 stream element (screen off, fallback)
  function elUrl() { return '/stream.mp3?q=' + A.quality() + '&t=' + Date.now(); }
  function startEl(muted) {                               // call inside the tap
    if (!el) {
      el = A.el = document.createElement('audio');
      el.id = 'rs-live'; el.preload = 'none'; el.setAttribute('playsinline', ''); el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
      el.addEventListener('error', () => elRetry(1500));
      el.addEventListener('ended', () => elRetry(500));
      // The lock screen and headset buttons arrive through the media session (audio.js), which stops the sound. A bare
      // pause while the page is out of sight is the phone's doing (switching apps, an interruption): carry on instead.
      el.addEventListener('pause', () => {
        if (!A.on || Date.now() <= (el._oursUntil || 0)) return;
        if (document.hidden && (A.mode === 'stream' || !elMuted)) { elRetry(400); return; }
        if (A.mode === 'stream') A.stop();
      });
      el.addEventListener('playing', () => {
        if (A.mode === 'stream') setState('playing', '');
        else if (document.hidden && !elMuted && A._handing) { A._handing = false; ramp(0, 0.06); }   // the stream is heard: now hand over
      });
      el.addEventListener('waiting', () => { if (A.mode === 'stream' && A.on) setState('buffering', 'Buffering...'); });
    }
    elMuted = !!muted; el.muted = elMuted; el.volume = A.vol;
    el._oursUntil = Date.now() + 1500;                 // a pause caused by changing the source is ours, not the user's
    el.src = elUrl();
    const p = el.play();
    if (p && p.catch) p.catch(e => { if (e && e.name === 'NotAllowedError' && A.mode === 'stream') setState('blocked', 'Tap the sound button to start.'); });
  }
  function stopEl() {
    if (!el) return;
    el._oursUntil = Date.now() + 1500;
    try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) { }
  }
  function elRetry(ms) {
    clearTimeout(A._elr);
    A._elr = setTimeout(() => { if (A.on && el && (A.mode === 'stream' || A.bgOn())) { el._oursUntil = Date.now() + 1500; el.src = elUrl(); const p = el.play(); if (p && p.catch) p.catch(() => { }); } }, ms);
  }
  // Keep the stream near the live edge, and restart it if it stops moving.
  // Safari (every iPhone and iPad) can't seek inside a live MP3 stream: it reports its buffer oddly (sometimes as an
  // estimate far ahead of the data) and a jump there stalls playback for good. So on Safari the position and speed are never touched; if it really is far behind, it reconnects to the
  // live edge only if it actually stops. Elsewhere a little extra speed, or a short jump. Readings that
  // can't be real (no end, or over 30 s behind) are ignored, and stall restarts back off (6, 12, 24 s).
  const SAFARI = A.ios || (/safari/i.test(navigator.userAgent) && !/chrome|chromium|crios|android|edg/i.test(navigator.userAgent));
  A.safari = SAFARI;
  let wdT = -1, wdAt = 0, wdBack = 6000;
  setInterval(() => {
    if (!A.on || !el || !el.src || el.paused) { wdT = -1; return; }
    let end = NaN; try { if (el.buffered.length) end = el.buffered.end(el.buffered.length - 1); } catch (e) { }
    const lag = end - el.currentTime, real = isFinite(lag) && lag >= 0 && lag < 30;
    A.lag = real ? lag : null;
    if (real) {
      if (SAFARI) {
        // nothing: Safari's buffer figure can't be trusted (acting on it causes jumps, or a reconnect gap every 30 s).
        // The server sends in real time, so the delay stays at Safari's own small start-up buffer.
      } else {
        try {
          if (lag > 2) el.currentTime = Math.max(el.currentTime, end - 0.7);
          else el.playbackRate = lag > 1.0 ? 1.06 : 1;
        } catch (e) { }
      }
    }
    if (el.currentTime !== wdT) { wdT = el.currentTime; wdAt = Date.now(); if (Date.now() - lastStall > 60000) wdBack = 6000; }
    else if (Date.now() - wdAt > wdBack) { wdAt = Date.now(); lastStall = Date.now(); wdBack = Math.min(wdBack * 2, 24000); elRetry(0); }
  }, 500);
  let lastStall = 0;

  // ---------------------------------------------------------------- start and stop
  A.start = () => {
    if (RS.player && RS.player.stop) RS.player.stop();   // one source at a time
    RS.send({ cmd: 'audio_claim', id: RS.clientId });
    A.on = true; A.level = 0;
    if (A.useStream()) {
      A.mode = 'stream'; A.live = true;
      if (!RS.canStream) { A.on = false; setState('off'); RS.toast('This browser cannot play the live sound. Try a current Chrome, Safari, Edge or Firefox.', 'bad'); return; }
      setState('starting', 'Starting sound...');
      startEl(false);
      return;
    }
    A.mode = 'live'; A.live = false;
    if (!makeContext()) { A.useStream = () => true; return A.start(); }
    unlock();
    if (A.bgOn()) startEl(true); else stopEl();         // the screen-off stand-in, started inside the tap
    lastFrameT = performance.now();
    setState('starting', 'Starting sound...');
    let g; try { g = graph(); } catch (e) { g = Promise.resolve(false); }
    g.then(ok => {
      if (!A.on || A.mode !== 'live') return;
      if (!ok) { A.stop(true); A.useStream = () => true; setState('blocked', 'Tap the sound button again to play the MP3 stream.'); return; }
      node.port.postMessage({ t: 'target', v: A.target() });
      node.port.postMessage({ t: 'flush' });
      worker.postMessage({ t: 'start', url: wsUrl(), q: A.quality() });
      if (!(document.hidden && el && !elMuted)) ramp(A.vol, 0.08);
      stateFromStats();
    });
  };
  A.stop = quiet => {
    A.on = false; clearTimeout(A._elr);
    if (worker) worker.postMessage({ t: 'stop' });
    if (node) node.port.postMessage({ t: 'flush' });
    ramp(0, 0.05);
    stopEl();
    setTimeout(() => { if (!A.on && ctx && ctx.state === 'running') { try { ctx.suspend(); } catch (e) { } } }, 250);
    A.live = false; A.level = 0;
    if (!quiet) setState('off');
  };
  // shorthand: play the whole-session stream rather than the live player
  A.startLive = () => { A.useStream = () => true; A.start(); return true; };

  // retuning: the live player drops the old station at once; a stream that is being heard reconnects (its buffer is old sound)
  const TUNE = { tune: 1, mode: 1, scan: 1, job: 1, tap: 1, preset: 1, sweep: 1 };
  A.onSend = cmd => {
    if (!A.on || !TUNE[cmd]) return;
    if (A.mode === 'live' && node) node.port.postMessage({ t: 'flush' });
    if (A.mode === 'stream' || (el && !elMuted)) { clearTimeout(A._fl); A._fl = setTimeout(() => { if (A.on) elRetry(0); }, 180); }
  };

  // ---------------------------------------------------------------- the page goes out of sight and comes back
  // Out of sight on a phone the live player is stopped by the phone, so the MP3 stream takes over. It is unmuted at once if it
  // is running; if it stalled or never started, it is restarted at the live edge. The live sound keeps playing until the
  // stream is actually heard ('playing'), so switching apps never leaves a gap, even if the stream is slow to start.
  function hidden() {
    if (!A.on || A.mode !== 'live' || !A.bgOn()) return;
    const healthy = el && el.src && !el.paused && el.readyState >= 3 && (A.lag == null || A.lag < 2.5);
    A._handing = true;
    if (!el || !el.src) { startEl(false); }
    else {
      elMuted = false; el.muted = false; el.volume = A.vol;
      if (!healthy) { el._oursUntil = Date.now() + 1500; el.src = elUrl(); const p = el.play(); if (p && p.catch) p.catch(() => { }); }
    }
    if (healthy) { A._handing = false; ramp(0, 0.06); }
    else setTimeout(() => { if (A._handing && document.hidden && el && !el.paused && el.readyState >= 3) { A._handing = false; ramp(0, 0.06); } }, 2500);
  }
  function shown() {
    if (!A.on) return;
    if (A.mode === 'live') {
      wake();
      if (worker) worker.postMessage({ t: 'kick' });          // the link may have died while asleep: check it now
      if (node) node.port.postMessage({ t: 'flush' });       // start again at the live edge
      A._handing = false;
      if (el && !elMuted) { elMuted = true; el.muted = true; }
      if (el && A.bgOn() && (el.paused || !el.src)) { el._oursUntil = Date.now() + 1500; el.src = elUrl(); el.muted = true; const p = el.play(); if (p && p.catch) p.catch(() => { }); }   // ready for next time
      ramp(A.vol, 0.12);
    } else if (el && el.paused) elRetry(0);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) hidden(); else shown(); });
  window.addEventListener('pageshow', e => { if (e.persisted) shown(); });
  window.addEventListener('pagehide', () => hidden());   // some phones send only this when you switch apps
  ['pointerdown', 'keydown', 'touchend'].forEach(ev => document.addEventListener(ev, () => { if (A.on && A.mode === 'live') wake(); }, { passive: true, capture: true }));

  // sound follows you: Start sound on another device stops it here (unless Settings allows both)
  RS.on('audio_owner', m => { if (m.id !== RS.clientId && A.on && !(RS.prefs && RS.prefs.sound_both)) { A.stop(); RS.toast('Sound moved to your other device. Press Start sound here to bring it back.'); } });
  // a job with no sound (planes, sensors): say so instead of "waiting"
  RS.on('state', () => { if (A.on) stateFromStats(); });

  // ---------------------------------------------------------------- Settings: sound
  function health() {
    if (!A.on) return 'Sound is off.';
    if (A.mode === 'stream') return 'Playing the MP3 stream' + (A.lag ? ', ' + A.lag.toFixed(1) + ' s behind live' : '') + '.';
    const s = A.stats || {};
    const parts = [A.state === 'playing' ? 'Playing live' + (A.engine === 'page' ? ' (page player)' : '') : (A.note || A.state).replace(/\.\.\.$/, '').replace(/\.$/, '')];
    if (s.buf != null && ctx) parts.push('about ' + Math.round((s.buf + 0.05 + (ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000) + ' ms behind the radio');
    if (s.target) parts.push('cushion ' + Math.round(s.target * 1000) + ' ms');
    parts.push((s.under || 0) + ' drop-out' + (s.under === 1 ? '' : 's'));
    if (s.skips) parts.push(s.skips + ' catch-up' + (s.skips === 1 ? '' : 's'));
    parts.push(QUAL[A.quality()][0].toLowerCase() + ' quality');
    if (A.net.rate) parts.push(Math.round(A.net.rate * 8 / 1000) + ' kbit/s');
    if (el && !elMuted) parts.push('screen-off stream');
    return parts.join(', ') + '.';
  }
  A.health = health;
  RS.mountSound = box => {
    if (!box) return;
    const cur = A.bufMode(), b = (k, t) => '<button type="button" data-k="' + k + '" aria-pressed="' + (cur === k) + '">' + t + '</button>';
    const qv = A.quality();
    box.innerHTML = '<h3>Sound</h3><div class="sub">How the live sound is played on this device.</div>' +
      '<div class="field q-field" style="margin-top:14px"><label for="st-aq">Streaming quality <b id="st-aq-n">' + QUAL[qv][0] + '</b></label>' +
      '<input type="range" id="st-aq" min="1" max="5" step="1" value="' + qv + '" list="st-aq-ticks" aria-describedby="st-aq-d">' +
      '<datalist id="st-aq-ticks"><option value="1"></option><option value="2"></option><option value="3"></option><option value="4"></option><option value="5"></option></datalist>' +
      '<div class="q-ticks" aria-hidden="true"><span>Data saver</span><span>Low</span><span>Medium</span><span>High</span><span>Lossless</span></div>' +
      '<span class="hint" id="st-aq-d">' + QUAL[qv][1] + ' The screen-off stream follows this too (48 to 192 kbit/s MP3).</span></div>' +
      '<div class="field" style="margin-top:14px"><label>Delay or smoothness</label><div class="seg" id="st-abuf" role="group" aria-label="Delay or smoothness">' + b('live', 'Live') + b('balanced', 'Balanced') + b('smooth', 'Smooth') + '</div>' +
      '<span class="hint">Live keeps the smallest cushion of sound (about a tenth of a second), so you hear signals as they arrive. After a drop-out the cushion grows a little by itself, then shrinks back. Balanced and Smooth start bigger, for weak Wi-Fi or a remote connection.</span></div>' +
      (RS.isTouch || RS.store.get('bgaudio', null) !== null ? '<label class="check"><input type="checkbox" id="st-bg"' + (RS.store.get('bgaudio', RS.isTouch) ? ' checked' : '') + '><span>Keep playing when you leave the app or lock the screen</span></label>' +
        '<div class="small muted">' + (IOS ? 'On iPhone and iPad this plays through the phone\'s own media player, about a second behind live, because that is the only way iOS keeps a web page\'s sound going in the background. Turn it off for the lowest delay; the sound then stops when you leave the app.'
          : 'Also starts the MP3 stream silently, ready to take over when the screen locks or you switch apps.') + '</div>' : '') +
      '<label class="check"><input type="checkbox" id="st-both"' + (RS.prefs && RS.prefs.sound_both ? ' checked' : '') + '><span>Let several devices play sound at the same time</span></label>' +
      '<div class="small muted">Otherwise pressing Start sound on one device (say your phone) stops the sound on your others, so you can hand the radio over with one tap.</div>' +
      '<div class="kv" style="margin-top:14px"><dt>Now</dt><dd id="st-ahealth" role="status">' + health() + '</dd></div>';
    const qs = $('#st-aq');
    qs.oninput = () => { const v = +qs.value; $('#st-aq-n').textContent = QUAL[v][0]; $('#st-aq-d').textContent = QUAL[v][1] + ' The screen-off stream follows this too (48 to 192 kbit/s MP3).'; };
    qs.onchange = () => A.setQuality(+qs.value);
    box.querySelectorAll('#st-abuf button').forEach(x => x.onclick = () => {
      RS.store.set('audio_buf', x.dataset.k);
      box.querySelectorAll('#st-abuf button').forEach(y => y.setAttribute('aria-pressed', String(y === x)));
      if (node) node.port.postMessage({ t: 'target', v: A.target() });
    });
    const bg = $('#st-bg'); if (bg) bg.onchange = e => { RS.store.set('bgaudio', e.target.checked); if (A.on) { A.stop(true); A.start(); } };
    $('#st-both').onchange = e => RS.setPref('sound_both', e.target.checked);
    clearInterval(A._hT); A._hT = setInterval(() => { const h = $('#st-ahealth'); if (!h || !h.isConnected) { clearInterval(A._hT); return; } h.textContent = health(); }, 1000);
  };
})();
