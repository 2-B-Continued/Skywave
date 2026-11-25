/* labpro.js - the deep end of the Lab: squelch modes and tone codes, the audio chain, a zoomed spectrum with a precision
   frequency counter, I/Q scopes, signal measurements, a long-term integrator (radio astronomy), a signal logger,
   network sound and remote control, performance figures and a raw settings editor. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc, Lab = RS.pages.lab;
  if (!Lab || !Lab.panes) return;
  const { row, tog, rng, sel, num, card, val } = Lab.ui;
  const P = Lab.panes;
  const kv = (k, v, id) => '<div class="lb-kv"' + (id ? ' id="' + id + '"' : '') + '><span>' + esc(k) + '</span><b>' + v + '</b></div>';
  const hz = f => (f / 1e6).toFixed(6) + ' MHz';
  const fmt = (v, d) => v == null || !isFinite(v) ? '-' : (+v).toFixed(d == null ? 1 : d);
  const ref = () => (RS.lab && RS.lab.ref_db) || 0;
  const unit = () => ref() ? 'dBm' : 'dBFS';
  const dbAt = (L, i) => L.bins[i] / 2.2 - 110;
  const save = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); };
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const CTCSS = [67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3, 179.9, 183.5, 186.2, 189.9, 192.8, 196.6, 199.5, 203.5, 206.5, 210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1];
  const DCS = '023 025 026 031 032 036 043 047 051 053 054 065 071 072 073 074 114 115 116 122 125 131 132 134 143 145 152 155 156 162 165 172 174 205 212 223 225 226 243 244 245 246 251 252 255 261 263 265 266 271 274 306 311 315 325 331 332 343 346 351 356 364 365 371 411 412 413 423 431 432 445 446 452 454 455 462 464 465 466 503 506 516 523 526 532 546 565 606 612 624 627 631 632 654 662 664 703 712 723 731 732 734 743 754'.split(' ');

  // ---------------------------------------------------------------- more on the existing tabs
  const front0 = P.front, demod0 = P.demod, display0 = P.display, measure0 = P.measure, system0 = P.system;
  P.front = () => front0() +
    card('Overload and gain', 'Clipping at the converter causes distortion and ghost signals anywhere in the band.',
      '<div class="lb-meas" id="lp-clip"></div><div class="row tight" style="margin-top:8px"><button class="btn small" data-act="sg-tune">Find the best gain</button><button class="btn small" data-act="sg-down">Lower gain 8 dB</button></div>' +
      sel('cfg', 'gain_db', 'Gain step (R820T / R828D table)', [0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9, 25.4, 28.0, 29.7, 32.8, 33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5, 48.0, 49.6].map(g => [g, g.toFixed(1) + ' dB']), 'The tuner only has these steps; the slider above snaps to the nearest one.')) +
    card('I/Q correction (manual)', 'Fixed corrections on top of the automatic one. Watch the mirror image of a strong signal on the other side of the centre and null it.',
      rng('lab', 'iq_gain_db', 'Q gain trim', -3, 3, 0.01, 'dB', '', 2) + rng('lab', 'iq_phase_deg', 'Q phase trim', -15, 15, 0.05, 'deg', '', 2)) +
    card('Up/down-converter', 'For an HF upconverter, a satellite LNB or any converter between the antenna and the dongle. Every frequency on screen stays the real one on the air.',
      row('Converter shift', '<input type="number" id="lp-cv-lo" step="1000" aria-label="Converter shift in Hz"> <span class="muted small">Hz</span>', '+125000000 for a 125 MHz HF upconverter; -9750000000 for a 9.75 GHz LNB.') +
      row('Use only below', '<input type="number" id="lp-cv-below" step="1000000" aria-label="Use the converter only below this frequency"> <span class="muted small">Hz</span>', '0 = always. 30000000 lets an upconverter with a bypass switch handle HF only.') +
      row('High-side (mirrors the spectrum)', '<label class="switch"><input type="checkbox" id="lp-cv-inv" aria-label="High-side converter"><i></i></label>', 'Local oscillator above the signal: the dongle sees LO minus frequency, upside down.') +
      '<div class="row tight"><button class="btn small primary" data-act="lp-cv-save">Apply converter</button><button class="btn small ghost" data-act="lp-cv-off">No converter</button></div>') +
    card('Channel I/Q recorder', 'Records only the tuned channel as 48 kHz I/Q (stereo WAV, I left and Q right): about 11 MB a minute instead of 290 MB for the whole band. Opens in SDR#, SDR++, GNU Radio, inspectrum or Audacity.',
      '<div class="row tight"><button class="btn" data-act="lp-chrec" id="lp-chrec">Start recording the channel</button><span class="small muted" id="lp-chrec-t"></span></div>');
  P.demod = () => demod0() +
    card('AGC time constants', 'Used when AGC mode is Custom. Attack: how fast it turns down for a loud signal. Decay: how fast it turns back up. Hang: how long it waits before turning up (keeps SSB and CW from pumping).',
      rng('lab', 'agc_attack_ms', 'Attack', 1, 500, 1, 'ms') + rng('lab', 'agc_decay_ms', 'Decay', 10, 5000, 10, 'ms') + rng('lab', 'agc_hang_ms', 'Hang', 0, 3000, 10, 'ms')) +
    card('AM detector', 'Synchronous AM locks to the carrier instead of following the envelope: much less distortion when the signal fades, and you can keep one sideband to dodge a neighbour.',
      sel('lab', 'am_det', 'Detector', [['env', 'Envelope (classic AM)'], ['sam', 'Synchronous, both sidebands'], ['sam_u', 'Synchronous, upper sideband only'], ['sam_l', 'Synchronous, lower sideband only']]) +
      rng('lab', 'pll_hz', 'Carrier loop bandwidth', 5, 300, 1, 'Hz', 'Narrow: steadier on weak signals. Wide: follows a drifting carrier.') + '<div class="lb-meas" id="lp-sam"></div>') +
    card('Automatic frequency control', 'Keeps a drifting FM transmitter (cheap handhelds, satellites, Doppler) centred in the filter.',
      tog('lab', 'afc', 'AFC on (NFM)') + rng('lab', 'afc_range', 'Pull range', 500, 20000, 100, 'Hz', 'How far it may move from where you tuned.') + '<div class="lb-meas" id="lp-afc"></div>') +
    card('Impulse blanker detail', '', rng('lab', 'nb_guard', 'Guard samples', 0, 16, 1, 'each side', 'Also blank this many samples around each spike (ringing after the impulse).'));
  P.display = () => display0() +
    card('More traces', 'Shared by every spectrum on the page.', tog('disp', 'minhold', 'Min hold', 'The quietest each point has been: shows the true noise floor under busy signals.') +
      tog('disp', 'avgtrace', 'Average trace', 'A slow running average drawn over the live trace.') + rng('disp', 'avgn', 'Average length', 2, 200, 1, 'frames') +
      rng('disp', 'gamma', 'Waterfall gamma', 0.3, 3, 0.05, '', 'Below 1 lifts weak signals out of the noise; above 1 keeps only strong ones.', 2) +
      '<div class="row" style="margin:6px 0"><button class="btn small" data-act="scope-reset-hold">Reset all hold and average traces</button></div>') +
    card('Level calibration', 'The dongle reads relative levels (dBFS). With a known reference (a signal generator or a calibrated beacon) enter the offset and every reading shows dBm.',
      num('lab', 'ref_db', 'Offset added to readings', -200, 200, 0.1, 'dB'));
  P.measure = () => measure0() +
    card('Signal analysis', 'The signal in the tuned channel, from the live spectrum.', '<div class="lb-meas" id="lp-bw"></div>') +
    card('Strongest signals in view', 'The ten highest peaks at least 5 kHz apart. Tap one to tune.', '<div id="lp-peaks"></div>');
  P.system = () => system0() +
    card('Performance', 'How hard the radio is working, and where any gaps in the sound come from. Signal processing must stay well under 100% of real time, or sound stutters.', '<div class="lb-meas" id="lp-perf"></div>') +
    card('Event log', 'What the radio has done and said, newest first.', '<div class="row tight"><input id="lp-logq" placeholder="Filter" style="flex:1"><button class="btn small" data-act="lp-log">Refresh</button><button class="btn small" data-act="lp-log-dl">Download</button></div><div id="lp-log" class="lp-log"></div>');

  // ---------------------------------------------------------------- new tabs
  P.squelch = () => card('Squelch mode', 'What opens the sound on narrow FM.',
    sel('lab', 'sq_mode', 'Opens on', [['level', 'Signal level (dB above the noise)'], ['noise', 'Noise quieting (classic FM squelch)'], ['ctcss', 'CTCSS tone (sub-audible tone squelch)'], ['dcs', 'DCS code (digital code squelch)']],
      'Level suits most uses. Noise quieting ignores interference that is loud but not a real FM signal. Tone and code squelch only open for one group of users on a shared channel.') +
    rng('lab', 'sq_quiet', 'Noise quieting needed', 0, 100, 1, '%', 'For noise squelch: how much the hiss must drop before the sound opens.') +
    sel('lab', 'sq_tone', 'CTCSS tone to open on', [[0, 'Any tone']].concat(CTCSS.map(t => [t, t.toFixed(1) + ' Hz']))) +
    sel('lab', 'sq_dcs', 'DCS code to open on', [['', 'Any code']].concat(DCS.map(c => ['D' + c + 'N', 'D' + c + 'N']))) +
    '<div class="lb-meas" id="lp-sq"></div>') +
    card('Tone and code detection', 'Reads the sub-audible tone or code on NFM and keypad tones on any mode.',
      tog('lab', 'tones', 'Detect CTCSS and DCS') + tog('lab', 'dtmf', 'Detect DTMF keypad tones') + '<div class="lb-meas" id="lp-tones"></div><div class="row tight" style="margin-top:6px"><button class="btn small ghost" data-act="lp-dtmf-clear">Clear keypad digits</button></div>') +
    card('CTCSS tones', 'The 50 standard tones; the one heard lights up.', '<div class="lp-grid" id="lp-ctgrid">' + CTCSS.map(t => '<span data-t="' + t + '">' + t.toFixed(1) + '</span>').join('') + '</div>') +
    card('DCS codes', 'The 104 standard codes. Some are equivalent once inverted, so a code may show as its twin.', '<div class="lp-grid dcs" id="lp-dcsgrid">' + DCS.map(c => '<span data-c="D' + c + '">' + c + '</span>').join('') + '</div>');
  P.audio = () => card('Audio analyser', 'What you are hearing, measured in this browser. Start the sound first.',
    '<canvas class="lp-cv" id="lp-afft" aria-label="Audio spectrum"></canvas><canvas class="lp-cv short" id="lp-ascope" aria-label="Audio waveform"></canvas>' +
    '<div class="row tight"><label class="check"><input type="checkbox" id="lp-alog" checked><span>Log frequency scale</span></label><label class="check"><input type="checkbox" id="lp-ahold"><span>Peak hold</span></label><select id="lp-afftn" aria-label="Analyser size"><option value="2048">2,048 points</option><option value="4096" selected>4,096 points</option><option value="8192">8,192 points</option><option value="16384">16,384 points</option></select></div><div class="small muted" id="lp-astat"></div>') +
    card('Equaliser', 'Five bands, after the tone controls.', tog('lab', 'eq_on', 'Equaliser on') + rng('lab', 'eq60', '60 Hz', -15, 15, 0.5, 'dB', '', 1) + rng('lab', 'eq250', '250 Hz', -15, 15, 0.5, 'dB', '', 1) + rng('lab', 'eq1k', '1 kHz', -15, 15, 0.5, 'dB', '', 1) + rng('lab', 'eq3k', '3 kHz', -15, 15, 0.5, 'dB', '', 1) + rng('lab', 'eq8k', '8 kHz', -15, 15, 0.5, 'dB', '', 1)) +
    card('Compressor', 'Evens out loud and quiet voices: everything above the threshold is reduced by the ratio.', tog('lab', 'comp_on', 'Compressor on') + rng('lab', 'comp_thr', 'Threshold', -60, 0, 1, 'dB') + rng('lab', 'comp_ratio', 'Ratio', 1, 20, 0.5, ': 1', '', 1) +
      rng('lab', 'comp_attack', 'Attack', 1, 200, 1, 'ms') + rng('lab', 'comp_release', 'Release', 20, 3000, 10, 'ms') + rng('lab', 'comp_makeup', 'Make-up gain', 0, 30, 0.5, 'dB', '', 1)) +
    card('Noise gate', 'Silences the output below a level: kills the hiss between words without a squelch.', tog('lab', 'gate_on', 'Gate on') + rng('lab', 'gate_db', 'Threshold', -90, -10, 1, 'dBFS')) +
    card('Output routing', 'Where the sound goes in your speakers or headphones.', sel('lab', 'route', 'Channels', [['normal', 'Normal (stereo when the station is)'], ['mono', 'Always mono'], ['left', 'Left ear only'], ['right', 'Right ear only'], ['swap', 'Swap left and right']]));
  P.zoom = () => card('Frequency counter', 'The strongest signal in the zoom window, measured to a fraction of a hertz.',
    '<div class="lp-counter" id="lp-count">waiting...</div><div class="lb-meas" id="lp-zm"></div>' +
    sel('lab', 'zoom_span', 'Zoom span', [[1500, '1.5 kHz (0.7 Hz detail)'], [3000, '3 kHz'], [6000, '6 kHz'], [12000, '12 kHz'], [24000, '24 kHz'], [46000, '46 kHz (whole channel)']])) +
    card('Zoom spectrum', 'A 16,384-point FFT of the tuned channel alone: about 3 Hz per point. Splits close carriers the main display shows as one.', '<canvas class="lp-cv" id="lp-zcv" aria-label="Zoom spectrum"></canvas>') +
    card('I/Q scope', 'The tuned channel itself, 768 samples at a time.',
      '<div class="seg" id="lp-smode">' + [['time', 'I and Q'], ['const', 'Constellation'], ['amp', 'Amplitude'], ['freq', 'Frequency'], ['phase', 'Phase'], ['eye', 'Eye']].map(m => '<button type="button" data-m="' + m[0] + '" aria-pressed="' + (Lab.smode === m[0]) + '">' + m[1] + '</button>').join('') + '</div>' +
      '<canvas class="lp-cv square" id="lp-scv" aria-label="I/Q scope"></canvas><div class="row tight"><label class="check"><input type="checkbox" id="lp-persist" checked><span>Persistence</span></label><label class="field">Eye symbol rate<input type="number" id="lp-eyesr" value="4800" step="100" style="width:110px"></label></div>') +
    card('Calibrate from a known carrier', 'Tune near a signal whose exact frequency you know (a beacon, a GPS-locked station, a VOR, a calibrated generator). Skywave works out the dongle\'s frequency error from the counter.',
      row('Its true frequency', '<input type="number" id="lp-known" step="1" placeholder="Hz, for example 113600000" aria-label="True frequency in Hz">') + '<div class="lb-meas" id="lp-cal"></div><div class="row tight"><button class="btn small primary" data-act="lp-cal">Apply this correction</button></div>');
  P.integ = () => card('Spectrum integrator', 'Averages the spectrum for minutes or hours, so signals far below the noise (the hydrogen line from the Milky Way, weak beacons, faint spurs) slowly appear. Capture a baseline with the antenna pointed away, then subtract it.',
    '<div class="row tight"><button class="btn primary" data-act="lp-in-go" id="lp-in-go">Start</button><button class="btn" data-act="lp-in-reset">Reset</button><button class="btn" data-act="lp-in-base">Use as baseline</button><button class="btn ghost" data-act="lp-in-nobase">Clear baseline</button><button class="btn" data-act="lp-in-csv">Download CSV</button></div>' +
    '<div class="lb-meas" id="lp-in-st"></div><canvas class="lp-cv tall" id="lp-incv" aria-label="Integrated spectrum"></canvas>' +
    '<div class="row tight"><label class="check"><input type="checkbox" id="lp-in-diff"><span>Show the difference from the baseline</span></label><label class="field">Smoothing<select id="lp-in-sm"><option value="1">None</option><option value="3">3 points</option><option value="7" selected>7 points</option><option value="15">15 points</option></select></label></div>') +
    card('Hydrogen line preset', 'Neutral hydrogen in our galaxy glows at 1420.4058 MHz. It needs a dish or horn, a hydrogen-line LNA and its filter (powered by the bias tee) and an hour or more of integration.',
      '<div class="row tight"><button class="btn" data-act="lp-h1">Tune for the hydrogen line</button></div>');
  P.logger = () => card('Signal logger', 'Records the signal at the tuned frequency over time: propagation, fading, antenna tests, interference that comes and goes.',
    '<div class="row tight"><button class="btn primary" data-act="lp-lg-go" id="lp-lg-go">Start logging</button><button class="btn" data-act="lp-lg-clear">Clear</button><button class="btn" data-act="lp-lg-csv">Download CSV</button><label class="field">Every<select id="lp-lg-iv"><option value="0.5">0.5 s</option><option value="1" selected>1 s</option><option value="5">5 s</option><option value="30">30 s</option><option value="60">1 min</option></select></label><label class="field">Show the last<select id="lp-lg-win"><option value="120">2 min</option><option value="600" selected>10 min</option><option value="3600">1 hour</option><option value="86400">everything</option></select></label></div>' +
    '<canvas class="lp-cv tall" id="lp-lgcv" aria-label="Signal log chart"></canvas><div class="lb-meas" id="lp-lg-st"></div>');
  P.net = () => card('Sound over the network', 'Sends the demodulated sound as raw 16-bit mono PCM over UDP, the same format other SDR programs use, for decoders running on another computer (WSJT-X, fldigi, multimon-ng, dsd...). From Docker, the host computer is usually 172.17.0.1.',
    tog('lab', 'udp_on', 'Send sound over UDP') + row('Destination', '<input data-src="lab" data-k="udp_host" value="' + esc(val('lab', 'udp_host') || '') + '" aria-label="Destination address" style="width:180px"> : <input type="number" data-src="lab" data-k="udp_port" value="' + (val('lab', 'udp_port') || 7355) + '" aria-label="Port" style="width:100px">') +
    sel('lab', 'udp_rate', 'Sample rate', [[48000, '48,000 Hz'], [24000, '24,000 Hz'], [16000, '16,000 Hz'], [8000, '8,000 Hz']]) + '<div class="lb-meas" id="lp-udp"></div>' +
    '<div class="small muted">Listen to it on a Linux computer: <code>nc -lu 7355 | aplay -r 48000 -f S16_LE -t raw -c 1</code></div>') +
    card('Remote control (Gqrx compatible)', 'Lets other programs tune Skywave over the network: Gpredict for satellite Doppler, rig-remote for scanning, loggers, your own scripts. Uses the Gqrx text commands (a subset of Hamlib rigctld).',
      row('Server on', '<label class="switch"><input type="checkbox" id="lp-rg-on" aria-label="Remote control on"><i></i></label>') + row('Port', '<input type="number" id="lp-rg-port" min="1024" max="65535" style="width:110px" aria-label="Port">', 'Also published by the Docker compose file. 7356 is the Gqrx default.') +
      row('Allowed computers', '<input id="lp-rg-allow" style="width:100%" aria-label="Allowed addresses">', 'Addresses or networks, separated by commas. Anyone allowed can retune the radio.') +
      '<div class="row tight"><button class="btn small primary" data-act="lp-rg-save">Apply</button></div><div class="lb-meas" id="lp-rg"></div>' +
      '<div class="small" style="margin-top:8px"><code>f</code> / <code>F 145800000</code> frequency &middot; <code>m</code> / <code>M FM 12500</code> mode and width &middot; <code>l STRENGTH</code> level &middot; <code>L SQL 8</code> squelch &middot; <code>U RECORD 1</code> &middot; <code>AOS</code> / <code>LOS</code> (Gpredict pass start and end)</div>') +
    card('Web interface for scripts', 'Everything the page does goes through these.', '<div class="small lp-api">' + [['GET', '/api/hello', 'full state snapshot'], ['GET', '/api/perf', 'processing load, memory, uptime'], ['GET', '/api/rigctl', 'remote control status'],
      ['GET', '/api/planes/history', 'the last hour of aircraft'], ['GET', '/api/export/aircraft.csv', 'aircraft list'], ['GET', '/api/export/aircraft-messages.csv', 'ACARS log'], ['GET', '/api/export/balloon-SERIAL.gpx', 'balloon track'],
      ['GET', '/api/mqtt', 'Home Assistant link status'], ['POST', '/api/lab', '{"set":{...}} any Lab setting'], ['POST', '/api/config', '{"changes":{...}} main settings'], ['WS', '/ws', '{"cmd":"tune","freq":...}, {"cmd":"tap","name":"acars"}, {"cmd":"lab_live","zoom":true}...'], ['GET', '/stream.mp3', 'the live sound as MP3']]
      .map(r => '<div><code>' + r[0] + ' ' + r[1] + '</code> <span class="muted">' + esc(r[2]) + '</span></div>').join('') + '</div>');
  P.raw = () => card('All Lab settings as JSON', 'Edit and apply in one go, or paste settings from another Skywave. Unknown keys and out-of-range values are ignored.',
    '<textarea id="lp-raw" class="lp-raw" spellcheck="false" aria-label="Lab settings JSON"></textarea><div class="row tight"><button class="btn primary" data-act="lp-raw-apply">Apply</button><button class="btn" data-act="lp-raw-load">Reload</button><button class="btn" data-act="lp-raw-dl">Download</button></div><div class="small" id="lp-raw-st"></div>') +
    card('Main settings (read only)', 'Change these in Settings, or with POST /api/config.', '<pre class="lp-raw ro" id="lp-cfg"></pre>') +
    card('Keyboard', 'On the Radio page.', '<div class="small">' + [['Left / Right', 'one step'], ['Shift + Left / Right', 'ten steps'], ['Mouse wheel on the dial', 'step'], ['Ctrl + wheel', 'zoom the dial'], ['Shift + click the spectrum', 'drop a marker'], ['Click the big frequency', 'type one (98.5, 7074 k, 1.09 g)']].map(r => '<div><span class="kbd">' + esc(r[0]) + '</span> ' + esc(r[1]) + '</div>').join('') + '</div>');

  // ---------------------------------------------------------------- live readouts
  const live0 = Lab.live;
  Lab.live = function () {
    live0.apply(this, arguments);
    const st = RS.st || {}, el = id => $('#' + id);
    if (el('lp-clip')) el('lp-clip').innerHTML = kv('Converter clipping', fmt(st.clip, 2) + ' %') + kv('Verdict', !st.clip ? 'clean' : st.clip < 0.5 ? 'fine' : st.clip < 5 ? 'overloading' : 'badly overloaded') + kv('Gain', RS.cfg.gain_auto ? 'automatic' : fmt(RS.cfg.gain_db) + ' dB') + (st.gtune ? kv('Gain finder', 'trying ' + st.gtune.i + ' of ' + st.gtune.n) : '');
    if (el('lp-sam')) el('lp-sam').innerHTML = st.sam ? kv('Carrier lock', Math.round(st.sam.lock * 100) + ' %') + kv('Carrier offset', fmt(st.sam.off) + ' Hz') : '<div class="muted small">Shows the carrier loop when tuned to AM with a synchronous detector.</div>';
    if (el('lp-afc')) el('lp-afc').innerHTML = st.afc != null ? kv('Pulled', st.afc + ' Hz from where you tuned') : '<div class="muted small">Not pulling (off, not NFM, or no signal).</div>';
    const tn = st.tones || {};
    if (el('lp-sq')) el('lp-sq').innerHTML = kv('Sound', st.gate ? 'open' : 'closed') + kv('Noise quieting', st.quiet != null ? '<span class="lp-bar"><i style="width:' + st.quiet + '%"></i></span> ' + st.quiet + ' %' : '-') + kv('Signal', fmt(st.snr) + ' dB above the noise');
    if (el('lp-tones')) el('lp-tones').innerHTML = kv('CTCSS', tn.ctcss ? tn.ctcss.toFixed(1) + ' Hz' : 'none') + kv('DCS', tn.dcs || 'none') + kv('Keypad (DTMF)', tn.dtmf ? '<span class="mono">' + esc(tn.dtmf) + '</span>' : 'none');
    RS.$$('#lp-ctgrid span').forEach(s => s.classList.toggle('on', tn.ctcss != null && +s.dataset.t === tn.ctcss));
    RS.$$('#lp-dcsgrid span').forEach(s => s.classList.toggle('on', !!tn.dcs && tn.dcs.slice(0, 4) === s.dataset.c));
    if (el('lp-chrec')) { RS.setText(el('lp-chrec'), st.chrec ? 'Stop and save' : 'Start recording the channel'); RS.setText(el('lp-chrec-t'), st.chrec ? 'Recording ' + st.chrec : ''); }
    if (el('lp-udp')) el('lp-udp').innerHTML = st.udp ? kv('Sent', (st.udp.sent / 1e6).toFixed(2) + ' MB') + (st.udp.err ? kv('Problem', esc(st.udp.err)) : '') : '<div class="muted small">Off.</div>';
    if (el('lp-bw')) bwMeasure();
    if (el('lp-peaks')) peaks();
  };
  RS.on('state', () => { if (RS.page === 'lab') Lab.live(); });

  // ---------------------------------------------------------------- measurements from the live spectrum
  function bwMeasure() {
    const L = RS.live, el = $('#lp-bw'); if (!L) { el.innerHTML = '<div class="muted">Waiting for the spectrum.</div>'; return; }
    const binHz = L.fs / 1024, lo = L.center - L.fs / 2, vfo = RS.vfo(), bw = RS.st.bw || 12000;
    const c = Math.round((vfo - lo) / binHz), half = Math.max(2, Math.round(bw / binHz));
    let pk = c, pv = -999; for (let i = Math.max(0, c - half); i < Math.min(1024, c + half); i++) { const v = dbAt(L, i); if (v > pv) { pv = v; pk = i; } }
    const width = dB => { let a = pk, b = pk; while (a > 0 && dbAt(L, a - 1) > pv - dB) a--; while (b < 1023 && dbAt(L, b + 1) > pv - dB) b++; return (b - a + 1) * binHz; };
    // power over bins a..b; null when most of that span lies outside the band on screen (an edge channel has no neighbour)
    const pw = (a, b) => { const i0 = Math.max(0, a), i1 = Math.min(1024, b); if (i1 - i0 < (b - a) / 2) return null; let s = 0; for (let i = i0; i < i1; i++) s += Math.pow(10, dbAt(L, i) / 10); return 10 * Math.log10(s + 1e-20); };
    const ch = Math.max(1, Math.round(bw / 2 / binHz)), main = pw(c - ch, c + ch), lowA = pw(c - 3 * ch, c - ch), upA = pw(c + ch, c + 3 * ch);
    const k = w => w >= 1000 ? (w / 1000).toFixed(1) + ' kHz' : Math.round(w) + ' Hz';
    el.innerHTML = kv('Peak level', fmt(pv + ref()) + ' ' + unit()) + kv('Channel power', fmt(main + ref()) + ' ' + unit()) + kv('Width at -3 dB', k(width(3))) + kv('Width at -6 dB', k(width(6))) + kv('Width at -20 dB', k(width(20))) + kv('Width at -26 dB', k(width(26))) +
      kv('Adjacent channel below', lowA == null ? '-' : fmt(lowA - main) + ' dBc') + kv('Adjacent channel above', upA == null ? '-' : fmt(upA - main) + ' dBc') + kv('Noise floor', fmt(L.floor + ref()) + ' ' + unit()) + kv('Display resolution', k(binHz));
  }
  // Peaks are held for 5 s after they were last seen, so a signal that pings less often than the spectrum refreshes
  // stays in the list instead of flashing in and out. Rows are ordered by a slowly falling peak level, so they don't
  // shuffle every frame, the table is drawn at most 4 times a second, and only when its text has changed.
  const HOLD_MS = 5000, held = [];
  let peaksAt = 0, peaksCenter = 0;
  function peaks() {
    const L = RS.live, el = $('#lp-peaks'); if (!L) return;
    const now = performance.now(), binHz = L.fs / 1024, lo = L.center - L.fs / 2, gap = Math.max(1, Math.round(5000 / binHz)), list = [];
    if (L.center !== peaksCenter || L.fs !== (peaks.fs || 0)) { held.length = 0; peaksCenter = L.center; peaks.fs = L.fs; }   // retuned: start afresh
    const idx = Array.from({ length: 1024 }, (_, i) => i).filter(i => i > 2 && i < 1021).sort((a, b) => dbAt(L, b) - dbAt(L, a));
    for (const i of idx) { if (list.length >= 10) break; if (dbAt(L, i) < L.floor + 6) break; if (list.every(j => Math.abs(j - i) > gap)) list.push(i); }
    for (const i of list) {
      const db = dbAt(L, i), f = lo + (i + 0.5) * binHz;
      let h = held.find(x => Math.abs(x.f - f) <= gap * binHz);
      if (!h) { h = { f, db, rank: db, seen: now }; held.push(h); }
      if (db >= h.db - 3 || now - h.seen > 300) h.f = f;          // follow the peak if it drifts
      h.db = db; h.seen = now; h.floor = L.floor; h.rank = Math.max(db, h.rank);
    }
    for (let k = held.length - 1; k >= 0; k--) {
      const h = held[k];
      h.rank -= 0.002 * Math.min(1000, now - (h.tick || now));  // falls 2 dB a second, so order changes calmly
      h.tick = now;
      if (now - h.seen > HOLD_MS) held.splice(k, 1);
    }
    if (now - peaksAt < 250) return; peaksAt = now;
    const show = held.slice().sort((a, b) => b.rank - a.rank).slice(0, 10);
    const html = show.length ? '<table class="tbl small"><thead><tr><th>Frequency</th><th>Level</th><th>Above noise</th></tr></thead><tbody>' + show.map(h => '<tr class="click" data-act="lp-tune" data-f="' + h.f + '"' + (now - h.seen > 600 ? ' style="opacity:.55" title="Not heard for ' + Math.round((now - h.seen) / 1000) + ' s"' : '') + '><td class="mono">' + hz(h.f) + '</td><td>' + fmt(h.db + ref()) + ' ' + unit() + '</td><td>' + fmt(h.db - h.floor) + ' dB</td></tr>').join('') + '</tbody></table>' : '<div class="muted">Nothing stands out above the noise.</div>';
    if (el._html !== html) { el._html = html; el.innerHTML = html; }
  }
  RS.act['lp-tune'] = b => RS.send({ cmd: 'tune', freq: +b.dataset.f });

  // ---------------------------------------------------------------- zoom, counter and scopes
  Lab.smode = RS.store.get('lp_smode', 'const');
  let zoom = null, snap = null, persist = null;
  function wantLive() {
    if (RS.page !== 'lab') return;
    RS.send({ cmd: 'lab_live', zoom: Lab.shown('lp-zcv') || Lab.shown('lp-count'), scope: Lab.shown('lp-scv') });
  }
  setInterval(wantLive, 4000);
  RS.on('labpane', p => { wantLive(); persist = null; if (p === 'net') rigFill(); if (p === 'raw') rawFill(); if (p === 'system') { perf(); logs(); } if (p === 'front') cvFill(); if (p === 'zoom') { RS.$$('#lp-smode button').forEach(b => b.onclick = () => { Lab.smode = b.dataset.m; RS.store.set('lp_smode', Lab.smode); persist = null; RS.$$('#lp-smode button').forEach(x => x.setAttribute('aria-pressed', x === b)); drawScope(); }); } });
  RS.on('page', p => { if (p !== 'lab') RS.send({ cmd: 'lab_live', zoom: false, scope: false }); });
  RS.on('zoom', m => { zoom = m; if (RS.page === 'lab') { drawZoom(); counter(); } });
  RS.on('iqsnap', m => { snap = m; if (Lab.shown('lp-scv')) drawScope(); });
  function grid(g, w, h) { g.strokeStyle = '#ffffff14'; g.lineWidth = 1; for (let i = 1; i < 8; i++) { g.beginPath(); g.moveTo(w * i / 8, 0); g.lineTo(w * i / 8, h); g.stroke(); } for (let i = 1; i < 5; i++) { g.beginPath(); g.moveTo(0, h * i / 5); g.lineTo(w, h * i / 5); g.stroke(); } }
  function drawZoom() {
    const cv = $('#lp-zcv'); if (!cv || !zoom) return; const c = RS.fit(cv); if (!c) return;
    const { g, w, h } = c, b = zoom.bins, n = b.length, lo = zoom.floor - 8, top = Math.max(zoom.peak_db + 4, lo + 30), Y = v => h - 16 - (v - lo) / (top - lo) * (h - 24);
    g.fillStyle = '#071318'; g.fillRect(0, 0, w, h); grid(g, w, h - 16);
    g.beginPath(); for (let i = 0; i < n; i++) { const x = i / (n - 1) * w; i ? g.lineTo(x, Y(b[i])) : g.moveTo(x, Y(b[i])); } g.strokeStyle = '#ffb52e'; g.lineWidth = 1.2; g.stroke();
    const px = ((zoom.peak_hz - zoom.f0) / zoom.span + 0.5) * w; g.strokeStyle = '#7ee0ff'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h - 16); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#9fb6bf'; g.font = '11px "Geist Mono", monospace'; g.textAlign = 'left'; g.fillText('-' + (zoom.span / 2000).toFixed(2) + ' kHz', 4, h - 3); g.textAlign = 'right'; g.fillText('+' + (zoom.span / 2000).toFixed(2) + ' kHz', w - 4, h - 3); g.textAlign = 'center'; g.fillText(hz(zoom.f0), w / 2, h - 3);
    g.textAlign = 'left'; g.fillText(fmt(top + ref(), 0) + ' ' + unit(), 4, 12);
  }
  function counter() {
    const z = zoom; if (!z) return;
    // grouped hertz, so every digit's weight is obvious: 113 600 000.42 Hz
    const s = z.peak_hz.toFixed(2), i = s.indexOf('.'), int = s.slice(0, i).replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');
    $('#lp-count').innerHTML = '<b>' + int + '</b><span>' + s.slice(i) + '</span> <small>Hz</small>';
    const off = z.peak_hz - z.f0;
    $('#lp-zm').innerHTML = kv('Level', fmt(z.peak_db + ref()) + ' ' + unit()) + kv('Above the noise', fmt(z.snr) + ' dB') + kv('Offset from tuned', (off >= 0 ? '+' : '') + off.toFixed(2) + ' Hz') + kv('Resolution', z.rbw.toFixed(2) + ' Hz per point') + kv('Span', (z.span / 1000).toFixed(1) + ' kHz');
    const kn = parseFloat(($('#lp-known') || {}).value);
    if ($('#lp-cal')) $('#lp-cal').innerHTML = kn > 0 ? (() => { const d = z.peak_hz - kn, ppm = d / kn * 1e6; return kv('Measured minus true', d.toFixed(1) + ' Hz') + kv('Dongle error', ppm.toFixed(2) + ' ppm') + kv('New correction', (RS.cfg.ppm - ppm).toFixed(1) + ' ppm (now ' + RS.cfg.ppm + ')'); })() : '<div class="muted small">Type the true frequency to see the correction.</div>';
  }
  RS.act['lp-cal'] = () => {
    const kn = parseFloat($('#lp-known').value); if (!zoom || !(kn > 0)) { RS.toast('Tune to the carrier and type its true frequency first.', 'bad'); return; }
    if (Math.abs(zoom.peak_hz - kn) > 50e3) { RS.toast('The strongest signal in the zoom is more than 50 kHz from that frequency. Tune closer.', 'bad'); return; }
    const ppm = Math.round(RS.cfg.ppm - (zoom.peak_hz - kn) / kn * 1e6);
    RS.api('config', { changes: { ppm } }).then(r => { if (r && r.config) RS.cfg = r.config; RS.toast('Frequency correction set to ' + ppm + ' ppm.'); });
  };
  function drawScope() {
    const cv = $('#lp-scv'); if (!cv || !snap) return; const c = RS.fit(cv); if (!c) return;
    const { g, w, h } = c, I = snap.i, Q = snap.q, n = I.length, mode = Lab.smode;
    const keep = $('#lp-persist') && $('#lp-persist').checked;
    if (!keep || !persist || persist.w !== w || persist.h !== h || persist.m !== mode) { g.fillStyle = '#071318'; g.fillRect(0, 0, w, h); persist = { w, h, m: mode }; } else { g.fillStyle = 'rgba(7,19,24,0.35)'; g.fillRect(0, 0, w, h); }
    grid(g, w, h);
    g.lineWidth = 1.1;
    const line = (arr, col, lo, hi) => { g.strokeStyle = col; g.beginPath(); for (let k = 0; k < arr.length; k++) { const x = k / (arr.length - 1) * w, y = h - (arr[k] - lo) / (hi - lo) * h; k ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); };
    if (mode === 'time') { line(I, '#ffb52e', -3, 3); line(Q, '#7ee0ff', -3, 3); }
    else if (mode === 'const') { const s = Math.min(w, h) / 6; g.fillStyle = '#ffb52ecc'; for (let k = 0; k < n; k++) g.fillRect(w / 2 + I[k] * s - 1, h / 2 - Q[k] * s - 1, 2, 2); }
    else if (mode === 'amp') { line(I.map((v, k) => Math.hypot(v, Q[k])), '#ffb52e', 0, 3); }
    else if (mode === 'phase') { line(I.map((v, k) => Math.atan2(Q[k], v)), '#ffb52e', -Math.PI, Math.PI); }
    else if (mode === 'freq' || mode === 'eye') {
      const f = []; for (let k = 1; k < n; k++) { const re = I[k] * I[k - 1] + Q[k] * Q[k - 1], im = Q[k] * I[k - 1] - I[k] * Q[k - 1]; f.push(Math.atan2(im, re) * snap.fs / (2 * Math.PI)); }
      if (mode === 'freq') { const m = Math.max(500, ...f.map(Math.abs)); line(f, '#ffb52e', -m, m); g.fillStyle = '#9fb6bf'; g.font = '11px sans-serif'; g.fillText('+-' + Math.round(m) + ' Hz', 4, 12); }
      else { const sr = Math.max(50, parseFloat(($('#lp-eyesr') || {}).value) || 4800), sps = snap.fs / sr, span = Math.round(2 * sps), m = Math.max(500, ...f.map(Math.abs)); g.strokeStyle = '#ffb52e88';
        for (let s0 = 0; s0 + span < f.length; s0 += Math.round(sps)) { g.beginPath(); for (let k = 0; k < span; k++) { const x = k / (span - 1) * w, y = h / 2 - f[s0 + k] / m * h / 2.2; k ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); } }
    }
    g.fillStyle = '#9fb6bf'; g.font = '11px sans-serif'; g.textAlign = 'right'; g.fillText('level ' + fmt(snap.rms_db + ref()) + ' ' + unit(), w - 4, 12); g.textAlign = 'left';
  }

  // ---------------------------------------------------------------- audio analyser (in this browser)
  let an = null, abuf = null, ahold = null, araf = 0;
  function analyser() {
    const A = RS.audio; if (!A || !A.ctx || !A.gain) return null;
    const n = +(($('#lp-afftn') || {}).value || 4096);
    if (!an || an.context !== A.ctx) { an = A.ctx.createAnalyser(); an.smoothingTimeConstant = 0.6; A.gain.connect(an); }
    if (an.fftSize !== n) { an.fftSize = n; ahold = null; }
    return an;
  }
  function audioLoop() {
    araf = 0;
    if (!Lab.shown('lp-afft')) return;
    araf = requestAnimationFrame(audioLoop);
    const a = analyser(), st = $('#lp-astat');
    if (!a) {
      if (st) st.textContent = '';
      // an empty screen says why it is empty, once (the loop keeps running until the sound starts)
      const cv = $('#lp-afft'), c = RS.fit(cv);
      if (c && cv._empty !== c.w) { cv._empty = c.w; c.g.fillStyle = '#071318'; c.g.fillRect(0, 0, c.w, c.h); c.g.fillStyle = '#9fb6bf'; c.g.font = '14px ' + (getComputedStyle(cv).fontFamily || 'sans-serif'); c.g.textAlign = 'center'; c.g.fillText('Press Start in the toolbar to hear the radio and see its audio here.', c.w / 2, c.h / 2); }
      return;
    }
    const cv0 = $('#lp-afft'); if (cv0) cv0._empty = 0;
    const cv = $('#lp-afft'), c = RS.fit(cv); if (!c) return;
    const { g, w, h } = c, n = a.frequencyBinCount, fs = a.context.sampleRate;
    if (!abuf || abuf.length !== n) abuf = new Float32Array(n);
    a.getFloatFrequencyData(abuf);
    const hold = $('#lp-ahold').checked; if (hold) { if (!ahold || ahold.length !== n) ahold = Float32Array.from(abuf); for (let i = 0; i < n; i++) ahold[i] = Math.max(ahold[i], abuf[i]); } else ahold = null;
    const logx = $('#lp-alog').checked, fmin = 20, fmax = Math.min(20000, fs / 2), X = f => logx ? Math.log(f / fmin) / Math.log(fmax / fmin) * w : (f - fmin) / (fmax - fmin) * w, Y = db => h - 14 - Math.min(1, Math.max(0, (db + 110) / 100)) * (h - 20);
    g.fillStyle = '#071318'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#ffffff14'; g.fillStyle = '#9fb6bf'; g.font = '10px sans-serif'; g.textAlign = 'center';
    [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach(f => { const x = X(f); if (x < 0 || x > w) return; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h - 14); g.stroke(); g.fillText(f >= 1000 ? f / 1000 + 'k' : f, x, h - 3); });
    const tr = (arr, col) => { g.strokeStyle = col; g.beginPath(); let first = true; for (let i = 1; i < n; i++) { const f = i * fs / a.fftSize; if (f < fmin || f > fmax) continue; const x = X(f), y = Y(arr[i]); first ? g.moveTo(x, y) : g.lineTo(x, y); first = false; } g.stroke(); };
    if (ahold) tr(ahold, '#ff6b6b99'); tr(abuf, '#ffb52e');
    let pi = 1; for (let i = 2; i < n; i++) if (abuf[i] > abuf[pi]) pi = i;
    if (st) st.textContent = 'Strongest tone ' + Math.round(pi * fs / a.fftSize) + ' Hz at ' + abuf[pi].toFixed(1) + ' dB  |  ' + (fs / a.fftSize).toFixed(1) + ' Hz per point  |  browser rate ' + fs + ' Hz';
    const sc = $('#lp-ascope'), c2 = RS.fit(sc); if (!c2) return;
    const td = new Float32Array(a.fftSize); a.getFloatTimeDomainData(td);
    let z0 = 0; for (let i = 1; i < td.length / 2; i++) if (td[i - 1] < 0 && td[i] >= 0) { z0 = i; break; }
    c2.g.fillStyle = '#071318'; c2.g.fillRect(0, 0, c2.w, c2.h); c2.g.strokeStyle = '#7ee0ff'; c2.g.beginPath();
    const m = Math.min(1024, td.length - z0); for (let i = 0; i < m; i++) { const x = i / (m - 1) * c2.w, y = c2.h / 2 - td[z0 + i] * c2.h / 2.1; i ? c2.g.lineTo(x, y) : c2.g.moveTo(x, y); } c2.g.stroke();
  }
  RS.on('labpane', p => { if (p === 'audio' && !araf) audioLoop(); });

  // ---------------------------------------------------------------- integrator
  const In = Lab.integ = { on: false, sum: null, n: 0, t0: 0, ms: 0, center: 0, fs: 0, base: null };
  RS.on('spec', L => {
    if (!In.on) return;
    if (In.center !== L.center || In.fs !== L.fs) { In.sum = null; In.n = 0; In.base = null; In.center = L.center; In.fs = L.fs; In.t0 = Date.now(); In.ms = 0; }
    if (!In.sum) In.sum = new Float64Array(1024);
    for (let i = 0; i < 1024; i++) In.sum[i] += Math.pow(10, dbAt(L, i) / 10);
    In.n++; In.ms = Date.now() - In.t0;
    if (In.n % 5 === 0 && Lab.shown('lp-incv')) drawInteg();
  });
  const inAvg = () => In.sum ? Array.from(In.sum, v => 10 * Math.log10(v / In.n + 1e-20)) : null;
  const smooth = (a, k) => { if (k <= 1) return a; const h = k >> 1; return a.map((_, i) => { let s = 0, c = 0; for (let j = i - h; j <= i + h; j++) if (j >= 0 && j < a.length) { s += a[j]; c++; } return s / c; }); };
  function drawInteg() {
    const st = $('#lp-in-st'); if (st) st.innerHTML = kv('Status', In.on ? 'integrating' : (In.n ? 'paused' : 'stopped')) + kv('Frames', In.n.toLocaleString()) + kv('Time', (In.ms / 60000).toFixed(1) + ' min') + kv('Noise reduction so far', In.n ? '~' + (5 * Math.log10(In.n)).toFixed(1) + ' dB' : '-') + kv('Centre', In.center ? hz(In.center) : '-') + kv('Baseline', In.base ? 'captured' : 'none');
    const go = $('#lp-in-go'); if (go) go.textContent = In.on ? 'Pause' : (In.n ? 'Continue' : 'Start');
    const cv = $('#lp-incv'); if (!cv) return; const c = RS.fit(cv); if (!c) return;
    const { g, w, h } = c; g.fillStyle = '#071318'; g.fillRect(0, 0, w, h); grid(g, w, h - 16);
    const avg = inAvg(); if (!avg) return;
    const k = +$('#lp-in-sm').value, diff = $('#lp-in-diff').checked && In.base;
    const show = smooth(diff ? avg.map((v, i) => v - In.base[i]) : avg, k), base = !diff && In.base ? smooth(In.base, k) : null;
    const all = show.slice(16, 1008).concat(base ? base.slice(16, 1008) : []), lo = Math.min(...all), hi = Math.max(...all), pad = Math.max(0.2, (hi - lo) * 0.1), Y = v => h - 16 - (v - lo + pad) / (hi - lo + 2 * pad) * (h - 22);
    const tr = (a, col) => { g.strokeStyle = col; g.beginPath(); a.forEach((v, i) => { const x = i / 1023 * w; i ? g.lineTo(x, Y(v)) : g.moveTo(x, Y(v)); }); g.stroke(); };
    if (base) tr(base, '#9fb6bf88'); tr(show, diff ? '#9be37d' : '#ffb52e');
    g.fillStyle = '#9fb6bf'; g.font = '11px "Geist Mono", monospace'; g.textAlign = 'left'; g.fillText((hi + pad).toFixed(2) + (diff ? ' dB' : ''), 4, 12); g.fillText((lo - pad).toFixed(2) + (diff ? ' dB' : ''), 4, h - 20);
    g.textAlign = 'center'; g.fillText(hz(In.center), w / 2, h - 3); g.textAlign = 'left'; g.fillText(hz(In.center - In.fs / 2), 4, h - 3); g.textAlign = 'right'; g.fillText(hz(In.center + In.fs / 2), w - 4, h - 3);
    const f1420 = 1420.4058e6; if (Math.abs(f1420 - In.center) < In.fs / 2) { const x = (f1420 - In.center) / In.fs * w + w / 2; g.strokeStyle = '#7ee0ff'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h - 16); g.stroke(); g.setLineDash([]); g.fillStyle = '#7ee0ff'; g.fillText('H I', x - 4, 24); }
  }
  RS.act['lp-in-go'] = () => { In.on = !In.on; if (In.on && !In.n) In.t0 = Date.now(); else if (In.on) In.t0 = Date.now() - In.ms; drawInteg(); };
  RS.act['lp-in-reset'] = () => { In.sum = null; In.n = 0; In.ms = 0; In.t0 = Date.now(); drawInteg(); };
  RS.act['lp-in-base'] = () => { const a = inAvg(); if (!a) { RS.toast('Integrate for a while first.', 'bad'); return; } In.base = a; In.sum = null; In.n = 0; In.ms = 0; In.t0 = Date.now(); RS.toast('Baseline captured. Point the antenna at the target and keep integrating.'); drawInteg(); };
  RS.act['lp-in-nobase'] = () => { In.base = null; drawInteg(); };
  RS.act['lp-in-csv'] = () => { const a = inAvg(); if (!a) return; save('integrated-' + stamp() + '.csv', 'frequency_hz,average_db,baseline_db,difference_db\n' + a.map((v, i) => { const f = In.center - In.fs / 2 + (i + 0.5) * In.fs / 1024; return f.toFixed(0) + ',' + v.toFixed(3) + ',' + (In.base ? In.base[i].toFixed(3) : '') + ',' + (In.base ? (v - In.base[i]).toFixed(3) : ''); }).join('\n'), 'text/csv'); };
  RS.act['lp-h1'] = () => {
    RS.send({ cmd: 'tune', freq: 1420.4058e6, mode: 'raw', recenter: true });
    RS.setDisp && RS.setDisp({ avgtrace: true });
    RS.toast('Tuned to 1420.4058 MHz. Turn on the bias tee in Front end if your LNA needs power, then start the integrator.');
  };
  RS.on('labpane', p => { if (p === 'integ') drawInteg(); if (p === 'logger') drawLog(); });

  // ---------------------------------------------------------------- logger
  const Lg = Lab.log = { on: false, pts: [], t: 0 };
  setInterval(() => {
    if (!Lg.on) return;
    const iv = +(($('#lp-lg-iv') || {}).value || Lg.iv || 1) * 1000, now = Date.now(); if (now - Lg.t < iv) return; Lg.t = now; Lg.iv = iv / 1000;
    const st = RS.st || {};
    Lg.pts.push([now, RS.vfo(), st.snr, (st.floor || 0) + (st.snr || 0), st.floor, st.clip || 0, st.quiet]); if (Lg.pts.length > 50000) Lg.pts.splice(0, 10000);
    if (Lab.shown('lp-lgcv')) drawLog();
  }, 250);
  function drawLog() {
    const go = $('#lp-lg-go'); if (go) go.textContent = Lg.on ? 'Pause' : 'Start logging';
    const cv = $('#lp-lgcv'); if (!cv) return; const c = RS.fit(cv); if (!c) return;
    const { g, w, h } = c, win = +$('#lp-lg-win').value * 1000, now = Date.now(), P2 = Lg.pts.filter(p => now - p[0] <= win);
    g.fillStyle = '#071318'; g.fillRect(0, 0, w, h); grid(g, w, h);
    if (P2.length < 2) { $('#lp-lg-st').innerHTML = '<div class="muted">' + (Lg.on ? 'Collecting...' : 'Press Start logging.') + '</div>'; return; }
    const t0 = P2[0][0], t1 = P2[P2.length - 1][0], lv = P2.map(p => p[3] + ref()), fl = P2.map(p => p[4] + ref()), lo = Math.min(...fl) - 3, hi = Math.max(...lv) + 3, X = t => (t - t0) / Math.max(1, t1 - t0) * w, Y = v => h - (v - lo) / (hi - lo) * h;
    const tr = (arr, col) => { g.strokeStyle = col; g.beginPath(); P2.forEach((p, i) => { i ? g.lineTo(X(p[0]), Y(arr[i])) : g.moveTo(X(p[0]), Y(arr[i])); }); g.stroke(); };
    tr(fl, '#9fb6bf88'); tr(lv, '#ffb52e');
    g.fillStyle = '#9fb6bf'; g.font = '11px "Geist Mono", monospace'; g.fillText(hi.toFixed(0) + ' ' + unit(), 4, 12); g.fillText(lo.toFixed(0), 4, h - 4);
    const sn = P2.map(p => p[2]), mean = sn.reduce((a, b) => a + b, 0) / sn.length, sd = Math.sqrt(sn.reduce((a, b) => a + (b - mean) * (b - mean), 0) / sn.length);
    $('#lp-lg-st').innerHTML = kv('Points', Lg.pts.length.toLocaleString()) + kv('Span shown', ((t1 - t0) / 60000).toFixed(1) + ' min') + kv('Signal to noise: average', mean.toFixed(1) + ' dB') + kv('Minimum / maximum', Math.min(...sn).toFixed(1) + ' / ' + Math.max(...sn).toFixed(1) + ' dB') + kv('Fading (standard deviation)', sd.toFixed(1) + ' dB') + kv('Frequency', hz(P2[P2.length - 1][1]));
  }
  RS.act['lp-lg-go'] = () => { Lg.on = !Lg.on; drawLog(); };
  RS.act['lp-lg-clear'] = () => { Lg.pts = []; drawLog(); };
  RS.act['lp-lg-csv'] = () => save('signal-log-' + stamp() + '.csv', 'time_utc,frequency_hz,snr_db,level_' + unit() + ',floor_' + unit() + ',clipping_pct,quieting_pct\n' + Lg.pts.map(p => new Date(p[0]).toISOString() + ',' + Math.round(p[1]) + ',' + fmt(p[2]) + ',' + fmt(p[3] + ref()) + ',' + fmt(p[4] + ref()) + ',' + fmt(p[5], 2) + ',' + (p[6] == null ? '' : p[6])).join('\n'), 'text/csv');

  // ---------------------------------------------------------------- converter, channel recorder, remote control
  function cvFill() { const c = RS.cfg.conv || {}; if (!$('#lp-cv-lo')) return; $('#lp-cv-lo').value = c.lo || 0; $('#lp-cv-below').value = c.below || 0; $('#lp-cv-inv').checked = !!c.invert; }
  RS.act['lp-cv-save'] = () => RS.api('config', { changes: { conv: { lo: +$('#lp-cv-lo').value || 0, below: +$('#lp-cv-below').value || 0, invert: $('#lp-cv-inv').checked } } }).then(r => { if (r && r.config) RS.cfg = r.config; RS.toast('Converter applied. The radio reconnects with the new tuning.'); });
  RS.act['lp-cv-off'] = () => RS.api('config', { changes: { conv: { lo: 0, below: 0, invert: false } } }).then(r => { if (r && r.config) RS.cfg = r.config; cvFill(); RS.toast('No converter.'); });
  RS.act['lp-chrec'] = () => RS.send({ cmd: 'chan_rec', on: !RS.st.chrec });
  RS.act['lp-dtmf-clear'] = () => RS.send({ cmd: 'dtmf_clear' });
  async function rigFill() {
    const r = RS.cfg.rigctl || {}; if (!$('#lp-rg-on')) return;
    $('#lp-rg-on').checked = !!r.on; $('#lp-rg-port').value = r.port || 7356; $('#lp-rg-allow').value = r.allow || '';
    const s = await fetch('/api/rigctl').then(x => x.json()).catch(() => null);
    if ($('#lp-rg')) $('#lp-rg').innerHTML = s ? kv('Server', s.on ? 'listening on ' + s.port : 'off') + kv('Connected programs', s.clients) + (s.error ? kv('Problem', esc(s.error)) : '') : '';
  }
  RS.act['lp-rg-save'] = () => RS.api('config', { changes: { rigctl: { on: $('#lp-rg-on').checked, port: +$('#lp-rg-port').value || 7356, allow: $('#lp-rg-allow').value } } }).then(r => { if (r && r.config) RS.cfg = r.config; setTimeout(rigFill, 500); });

  // ---------------------------------------------------------------- performance, log, raw
  async function perf() {
    const el = $('#lp-perf'); if (!el) return;
    const p = await fetch('/api/perf').then(x => x.json()).catch(() => null), st = RS.st || {}, A = RS.audio || {}, s = A.stats || {};
    if (!p) return;
    const up = p.uptime_s, ut = up > 86400 ? (up / 86400).toFixed(1) + ' days' : up > 3600 ? (up / 3600).toFixed(1) + ' h' : Math.round(up / 60) + ' min';
    el.innerHTML = kv('Signal processing load', fmt((st.perf || {}).load) + ' % of real time') + kv('Time per block', fmt((st.perf || {}).ms, 2) + ' ms') + kv('Server CPU time', p.cpu_s + ' s') + kv('Server memory (peak)', p.rss_mb + ' MB') +
      kv('Server threads', p.threads) + kv('Connected pages', p.clients) + kv('Running for', ut) +
      // where a gap starts: the server falling behind the radio, the network to this device, or this device's player
      kv('Skips to catch up with the radio', p.caught_up || 0) + kv('Sound trimmed on the way to slow devices', p.sound_trims || 0) +
      kv('Gaps in this page\'s player', s.under || 0) + kv('Player cushion', s.target ? Math.round(s.target * 1000) + ' ms' : '-') + kv('Player engine', A.engine === 'page' ? 'Page (plain http)' : A.engine === 'worklet' ? 'Audio thread' : '-');
  }
  setInterval(() => { if (Lab.shown('lp-perf')) perf(); }, 2000);
  let logLines = [];
  async function logs() {
    const r = await fetch('/api/log').then(x => x.json()).catch(() => null); logLines = (r && r.lines) || [];
    const q = (($('#lp-logq') || {}).value || '').toLowerCase(), el = $('#lp-log'); if (!el) return;
    el.innerHTML = logLines.filter(l => !q || l.text.toLowerCase().includes(q)).map(l => '<div class="lp-ll ' + esc(l.level) + '"><span class="mono">' + new Date(l.t * 1000).toLocaleTimeString() + '</span> ' + esc(l.text) + '</div>').join('') || '<div class="muted">Nothing logged.</div>';
  }
  RS.act['lp-log'] = logs;
  RS.act['lp-log-dl'] = () => save('skywave-log-' + stamp() + '.txt', logLines.map(l => new Date(l.t * 1000).toISOString() + ' [' + l.level + '] ' + l.text).join('\n'));
  document.addEventListener('input', e => { if (e.target.id === 'lp-logq') logs(); if (e.target.id === 'lp-known') counter(); });
  function rawFill() { const t = $('#lp-raw'); if (t) t.value = JSON.stringify(RS.lab, null, 2); const c = $('#lp-cfg'); if (c) { const v = Object.assign({}, RS.cfg); c.textContent = JSON.stringify(v, null, 2); } }
  RS.act['lp-raw-load'] = rawFill;
  RS.act['lp-raw-dl'] = () => save('skywave-lab-' + stamp() + '.json', JSON.stringify(RS.lab, null, 2), 'application/json');
  RS.act['lp-raw-apply'] = async () => {
    let v; try { v = JSON.parse($('#lp-raw').value); } catch (e) { $('#lp-raw-st').textContent = 'Not valid JSON: ' + e.message; return; }
    const r = await RS.api('lab', { set: v }); const n = Object.keys(v).filter(k => r && r.lab && JSON.stringify(r.lab[k]) === JSON.stringify(v[k])).length;
    $('#lp-raw-st').textContent = 'Applied ' + n + ' of ' + Object.keys(v).length + ' values' + (n < Object.keys(v).length ? ' (the rest were unknown or out of range and were left as they were).' : '.');
  };
})();
