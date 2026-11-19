/* lab.js - the Advanced "Lab": front end, demodulator, display, measurement, memory and system tools. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc, Lab = RS.pages.lab = {};
  RS.lab = RS.lab || {};
  const SRC = { lab: () => RS.lab || {}, cfg: () => RS.cfg || {}, disp: () => RS.disp || {} };
  const fmtN = (v, d) => (+v).toFixed(d == null ? 0 : d);

  // ---------------------------------------------------------------- control builders
  // every control carries data-src (lab|cfg|disp|rx) and data-k; one delegated listener applies changes
  const row = (label, ctl, help) => '<div class="lb-row"><div class="lb-l"><label>' + esc(label) + '</label>' + (help ? '<div class="small muted">' + esc(help) + '</div>' : '') + '</div><div class="lb-c">' + ctl + '</div></div>';
  const val = (src, k) => (SRC[src] ? SRC[src]() : {})[k];
  const tog = (src, k, label, help) => row(label, '<label class="switch"><input type="checkbox" data-src="' + src + '" data-k="' + k + '" ' + (val(src, k) ? 'checked' : '') + ' aria-label="' + esc(label) + '"><i></i></label>', help);
  const rng = (src, k, label, min, max, step, unit, help, dec) => { const v = val(src, k); return row(label, '<input type="range" data-src="' + src + '" data-k="' + k + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + (v == null ? min : v) + '" aria-label="' + esc(label) + '"><output data-o="' + k + '">' + fmtN(v == null ? min : v, dec || 0) + ' ' + esc(unit || '') + '</output>', help); };
  const sel = (src, k, label, opts, help) => { const v = val(src, k); return row(label, '<select data-src="' + src + '" data-k="' + k + '" aria-label="' + esc(label) + '">' + opts.map(o => '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(v) ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select>', help); };
  const num = (src, k, label, min, max, step, unit, help) => row(label, '<input type="number" data-src="' + src + '" data-k="' + k + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + (val(src, k) == null ? '' : val(src, k)) + '" aria-label="' + esc(label) + '"> <span class="muted small">' + esc(unit || '') + '</span>', help);
  const col = (src, k, label) => row(label, '<input type="color" data-src="' + src + '" data-k="' + k + '" value="' + (val(src, k) || '#ffb52e') + '" aria-label="' + esc(label) + '">');
  const card = (title, sub, body, id) => '<div class="card"' + (id ? ' id="' + id + '"' : '') + '><h3>' + esc(title) + '</h3>' + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + body + '</div>';

  const panes = {
    front: () => card('Source', 'Use the radio, or replay a baseband (IQ) recording as if it were live: spectrum, demodulation and scanning all work on it.',
      '<div id="lb-iq" class="lb-iq"></div>') + card('Tuner', 'How the radio chip amplifies and samples the signal.',
      tog('cfg', 'gain_auto', 'Automatic gain', 'Let the radio pick the gain. Turn off for manual control.') + rng('cfg', 'gain_db', 'Manual gain', 0, 49.6, 0.1, 'dB', 'Higher hears weak signals but overloads near strong ones.', 1) +
      tog('lab', 'tuner_agc', 'Tuner AGC loop', 'The chip\'s own gain control (RTL AGC). Usually off for best results.') + tog('lab', 'offset_tuning', 'Offset tuning', 'Moves the tuner away from the centre so the DC spike is not in your channel (R820T).') +
      sel('lab', 'direct_mode', 'Direct sampling', [['auto', 'Automatic (HF only)'], ['off', 'Always off'], ['i', 'I branch (forced)'], ['q', 'Q branch (forced)']], 'For HF below 24 MHz on dongles without an upconverter.') +
      sel('cfg', 'hf_mode', 'HF mode policy', [['auto', 'Automatic'], ['direct', 'Direct sampling below 24 MHz'], ['off', 'Never']]) +
      num('cfg', 'ppm', 'Frequency correction', -300, 300, 1, 'ppm', 'Crystal error. Use Calibrate in Settings to measure it from an FM station.') + tog('cfg', 'bias_t', 'Bias tee (4.5 V on antenna port)', 'Powers an LNA. Never enable it with a plain antenna that is DC-grounded.') +
      sel('cfg', 'sample_rate', 'Sample rate', [[2400000, '2.4 MS/s (widest)'], [1920000, '1.92 MS/s'], [1200000, '1.2 MS/s'], [960000, '0.96 MS/s (lightest)']], 'Wider shows more spectrum; slower is easier on a weak CPU.') +
      rng('cfg', 'settle_s', 'Retune settling', 0.05, 1, 0.05, 's', 'Samples discarded after a frequency change.', 2)) +
      card('Digital corrections', 'Applied to the raw I/Q before anything else.',
        tog('lab', 'dc_block', 'DC removal', 'Removes the spike at the exact centre.') + tog('lab', 'iq_balance', 'I/Q balance correction', 'Cancels the mirror image caused by unequal I and Q paths.') + tog('lab', 'iq_swap', 'Swap I and Q (flip the spectrum)', 'Mirrors the display and inverts sidebands. For upconverters with an inverted output.')),
    demod: () => card('Channel', 'Mode, width and the squelch gate.',
      '<div class="lb-row"><div class="lb-l"><label>Mode</label></div><div class="lb-c"><div class="seg" id="lb-modes">' + Object.keys(RS.MODES).map(k => '<button data-act="lb-mode" data-m="' + k + '" title="' + esc(RS.MODES[k].long) + '" aria-pressed="' + (RS.curMode() === k) + '">' + RS.TECH[k] + '</button>').join('') + '</div></div></div>' +
      row('Filter bandwidth', '<input type="range" id="lb-bw" min="500" max="250000" step="500" value="' + (RS.st.bw || 12000) + '" aria-label="Bandwidth"><output id="lb-bw-o">' + fmtN((RS.st.bw || 12000) / 1000, 1) + ' kHz</output>', 'Narrower rejects neighbours; wider keeps fidelity.') +
      row('Squelch threshold', '<input type="range" id="lb-sq" min="0" max="40" step="1" value="' + (RS.st.squelch || 0) + '" aria-label="Squelch"><output id="lb-sq-o">' + (RS.st.squelch ? RS.st.squelch + ' dB' : 'off') + '</output>', 'Opens when the signal is this far above the noise. 0 is off.') +
      sel('cfg', 'deemph_us', 'FM de-emphasis', [[50, '50 µs (Europe, Asia, Australia)'], [75, '75 µs (Americas, South Korea)'], [25, '25 µs (some NBFM)'], [0, 'Off']], 'Must match the broadcaster or the treble sounds wrong.') +
            row('Squelch hang time', '<input type="range" data-src="lab" data-k="squelch_hang" min="0" max="5" step="0.1" value="' + val('lab', 'squelch_hang') + '" aria-label="Squelch hang time"><output>' + fmtN(val('lab', 'squelch_hang'), 1) + ' s</output>', 'How long the gate stays open after the signal drops, so words are not clipped.')) +
      card('FM broadcast', 'Extras that only apply to FM radio stations (WFM).',
        tog('lab', 'fm_stereo', 'Stereo decoding', 'Recovers left and right from the 19 kHz pilot. Falls back to mono when the pilot is weak.') + tog('lab', 'fm_rds', 'RDS decoding', 'Reads the station name, song text and programme type that stations broadcast alongside the audio.') + '<div id="lb-rds" class="lb-meas"></div>') +
      card('Gain control (AGC)', 'Keeps loud and quiet signals at a steady volume.', sel('lab', 'agc_mode', 'AGC mode', [['default', 'Mode default'], ['off', 'Off (fixed gain)'], ['fast', 'Fast'], ['medium', 'Medium'], ['slow', 'Slow'], ['custom', 'Custom (set the times below)']]) + rng('lab', 'agc_target', 'Target level', 0.05, 0.6, 0.01, '', 'Higher is louder.', 2) + rng('lab', 'agc_max_db', 'Maximum gain', 0, 60, 1, 'dB', 'Caps how much a weak signal is boosted (only with a chosen AGC mode).')) +
      card('Noise and interference', 'Cleaning up the signal. Each stage can be switched on separately.',
        tog('lab', 'nb_on', 'Noise blanker', 'Removes short sharp spikes (car ignition, electric fences, switching supplies).') + rng('lab', 'nb_level', 'Blanker threshold', 2, 30, 0.5, '× normal', 'Lower blanks more.', 1) + '<div class="small muted" id="lb-nbc"></div>' +
        tog('lab', 'nr_on', 'Noise reduction', 'Spectral subtraction: learns the hiss in quiet moments and takes it away.') + rng('lab', 'nr_db', 'Noise reduction depth', 3, 30, 1, 'dB') +
        tog('lab', 'notch_on', 'Manual notch filter', 'Cuts one steady whistle.') + rng('lab', 'notch_hz', 'Notch frequency', 50, 9000, 10, 'Hz') + rng('lab', 'notch_q', 'Notch sharpness (Q)', 2, 80, 1, '') +
        tog('lab', 'auto_notch', 'Automatic notch', 'An adaptive filter that finds and removes steady tones by itself.')) +
      card('Audio shaping', 'Tone and filtering after demodulation.', rng('lab', 'hpf_hz', 'High-pass', 0, 2000, 10, 'Hz', '0 is off.') + rng('lab', 'lpf_hz', 'Low-pass', 0, 15000, 100, 'Hz', '0 is off.') + rng('lab', 'bass_db', 'Bass', -12, 12, 0.5, 'dB', '', 1) + rng('lab', 'treble_db', 'Treble', -12, 12, 0.5, 'dB', '', 1) + rng('lab', 'boost_db', 'Output gain', -12, 24, 0.5, 'dB', '', 1) + tog('lab', 'limiter', 'Soft limiter', 'Stops harsh clipping when boosted.')) +
      card('SSB and CW', 'Single-sideband and Morse tuning.', rng('lab', 'cw_pitch', 'CW pitch', 300, 1200, 10, 'Hz', 'The tone you hear for a Morse carrier.') + rng('lab', 'ssb_shift', 'Passband shift', -1000, 1000, 10, 'Hz', 'Slides the voice filter up or down to dodge interference.')),
    display: () => card('Spectrum analyser', 'How the FFT behind the display is computed.',
      sel('lab', 'nfft', 'FFT size', [[1024, '1,024'], [2048, '2,048'], [4096, '4,096 (default)'], [8192, '8,192'], [16384, '16,384']], 'More points show finer detail but react slower.') + '<div class="small muted" id="lb-rbw"></div>' +
      sel('lab', 'window', 'Window function', [['hann', 'Hann'], ['hamming', 'Hamming'], ['blackman', 'Blackman'], ['blackmanharris', 'Blackman-Harris (best dynamic range)'], ['flattop', 'Flat top (best amplitude accuracy)'], ['kaiser', 'Kaiser'], ['rect', 'Rectangular (none)']]) +
      rng('lab', 'avg', 'Averaging', 1, 16, 1, 'segments', 'More smooths the noise floor.') + sel('lab', 'fps', 'Frame rate', [[5, '5 per second'], [10, '10 per second'], [20, '20 per second']]) + sel('lab', 'decim', 'Bin reduction', [['peak', 'Peak (never hides a signal)'], ['mean', 'Average (smoother)']], 'The server sends 1,024 columns; this picks how finer data is squeezed in.')) +
      card('Trace and scale', 'Stored on this device.', tog('disp', 'auto', 'Automatic range', 'Follow the noise floor.') + rng('disp', 'min', 'Bottom of scale', -140, -20, 1, 'dB') + rng('disp', 'max', 'Top of scale', -80, 20, 1, 'dB') + rng('disp', 'smooth', 'Trace smoothing', 0, 0.95, 0.05, '', '', 2) +
        tog('disp', 'peak', 'Peak hold', 'A fading line that remembers recent peaks.') + tog('disp', 'maxhold', 'Max hold', 'Remembers the strongest value forever, until reset.') + '<div class="row" style="margin:6px 0"><button class="btn small" data-act="scope-reset-hold">Reset hold traces</button></div>' +
        tog('disp', 'fill', 'Fill under trace') + tog('disp', 'grid', 'Grid and dB labels') + tog('disp', 'markers', 'Show markers') + col('disp', 'trace', 'Trace colour')) +
      card('Waterfall', 'Colour map and speed.', '<div class="cm-grid">' + Object.keys(RS.COLORMAPS || {}).map(k => '<button type="button" class="cm" data-act="lb-cmap" data-k="' + k + '" aria-pressed="' + (RS.disp.cmap === k) + '"><span style="background:linear-gradient(90deg,' + RS.COLORMAPS[k].st.map(c => 'rgb(' + c.join(',') + ')').join(',') + ')"></span>' + esc(RS.COLORMAPS[k].name) + '</button>').join('') + '</div>' +
        rng('disp', 'wfms', 'Waterfall speed', 40, 600, 10, 'ms per line', 'Lower scrolls faster.')),
    measure: () => card('Live measurements', 'From the spectrum you are looking at (follow the tuned frequency on the Radio page).', '<div class="lb-meas" id="lb-meas"></div>', 'lb-m1') +
      card('Markers', 'Shift-click the spectrum on the Radio page to drop a marker, or use the buttons.', '<div class="row tight"><button class="btn small" data-act="lb-mk-vfo">Add at tuned frequency</button><button class="btn small" data-act="lb-mk-peak">Add at strongest signal</button><button class="btn small ghost" data-act="lb-mk-clear">Clear all</button></div><div id="lb-mk" style="margin-top:10px"></div>') +
      card('Export', 'Take your data with you.', '<div class="row tight"><button class="btn" data-act="lb-csv">Spectrum as CSV</button><button class="btn" data-act="lb-png">Waterfall as picture</button><button class="btn" data-act="lb-diag">Diagnostics (JSON)</button></div>'),
    memory: () => card('Frequency manager', 'Your favourites, with names. Edit, remove, import and export.', '<div id="lb-favs"></div><div class="row tight" style="margin-top:10px"><button class="btn small" data-act="lb-fav-add">Add tuned frequency</button><button class="btn small" data-act="lb-fav-export">Export CSV</button><button class="btn small" data-act="lb-fav-json">Export JSON</button><label class="btn small">Import<input type="file" id="lb-imp" accept=".csv,.json,.txt" hidden></label></div><div class="small muted" style="margin-top:6px">Import accepts this program\'s files and simple CSV lines like <span class="mono">name,frequency_MHz,mode</span>.</div>') +
      card('Receiver presets', 'Save the whole receiver set-up (all lab settings, mode, bandwidth, squelch) and bring it back in one tap.', '<div class="row tight"><input id="lb-pname" placeholder="Name this preset" style="flex:1"><button class="btn primary" data-act="lb-pre-save">Save preset</button></div><div id="lb-pres" style="margin-top:10px"></div>'),
    system: () => card('Maintenance', '', '<div class="row tight"><button class="btn" data-act="reset">Restart the radio</button><button class="btn" data-act="lb-reset">Reset lab to factory settings</button><button class="btn" data-act="lb-backup">Download settings backup</button><label class="btn">Restore backup<input type="file" id="lb-rest" accept=".json" hidden></label></div>') +
      card('Network interfaces', 'For scripts and other programs on your network.', '<div class="small"><div><code>GET /api/hello</code> full state snapshot</div><div><code>POST /api/lab</code> <span class="muted">{"set":{...}}</span> change any lab setting</div><div><code>POST /api/config</code> <span class="muted">{"changes":{...}}</span> change main settings</div><div><code>GET /api/recordings</code> list recordings</div><div><code>WS /ws</code> live spectrum (binary), audio and events. Commands: tune, mode, squelch, scan, job</div><div class="muted" style="margin-top:6px">There is no password by default. If you expose this beyond your home network, put it behind a reverse proxy with authentication.</div></div>'),
  };
  const TABS = [['front', 'Front end'], ['demod', 'Demodulator'], ['display', 'Display'], ['measure', 'Measure'], ['memory', 'Memory'], ['system', 'System']];
  Lab.panes = panes; Lab.TABS = TABS; Lab.ui = { row, tog, rng, sel, num, col, card, val };
  Lab.tab = RS.store.get('labtab', 'front');

  Lab.init = () => {
    $('#p-lab').innerHTML = '<div class="page-head"><h2>Lab</h2><p>Professional receiver controls. Everything here is optional; the defaults are tuned for most people.</p></div>' +
      '<div class="glass lb-scope"><canvas id="lb-spec" class="spec" aria-label="Spectrum"></canvas><canvas id="lb-water" class="water" aria-label="Waterfall"></canvas><div class="scope-info" id="lb-info"></div></div>' +
      '<div class="seg lb-tabs" role="tablist" id="lb-tabs">' + TABS.map(t => '<button role="tab" data-act="lb-tab" data-t="' + t[0] + '">' + t[1] + '</button>').join('') + '</div><div id="lb-body"></div>';
    Lab.scope = new RS.Scope($('#lb-spec'), $('#lb-water'), $('#lb-info'));
    RS.on('spec', L => { if (RS.page === 'lab') Lab.scope.frame(L); });
    RS.on('meas', () => { if (RS.page === 'lab') Lab.live(); });
    RS.on('lab', () => { if (RS.page === 'lab') Lab.sync(); });
    RS.on('hello', () => { if (RS.page === 'lab') Lab.draw(); });
    RS.on('adv', on => { if (!on && RS.page === 'lab') RS.go('home'); });
    const b = $('#lb-body');
    const apply = el => {
      const src = el.dataset.src, k = el.dataset.k; if (!src || !k) return;
      let v = el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? parseFloat(el.value) : el.value;
      if (el.tagName === 'SELECT' && /^-?\d+(\.\d+)?$/.test(v)) v = parseFloat(v);
      if (el.type === 'number' && !isFinite(v)) return;
      if (src === 'lab') { RS.lab[k] = v; Lab._p = Object.assign(Lab._p || {}, { [k]: v }); clearTimeout(Lab._t); Lab._t = setTimeout(() => { const patch = Lab._p; Lab._p = null; RS.api('lab', { set: patch }).catch(e => RS.toast(e.message, 'bad')); }, 120); }
      else if (src === 'cfg') { RS.cfg[k] = v; clearTimeout(Lab['_c' + k]); Lab['_c' + k] = setTimeout(() => RS.api('config', { changes: { [k]: v } }).catch(e => RS.toast(e.message, 'bad')), 200); }
      else if (src === 'disp') RS.setDisp({ [k]: v });
    };
    b.addEventListener('input', e => { const el = e.target; if (el.type === 'range') { const o = b.querySelector('output[data-o="' + el.dataset.k + '"]'); if (o) o.textContent = fmtN(el.value, (+el.step < 1 && +el.step > 0) ? (String(el.step).split('.')[1] || '').length : 0) + ' ' + (o.textContent.split(' ').slice(1).join(' ')); apply(el); } else if (el.type === 'color') apply(el); });
    b.addEventListener('change', e => { const el = e.target; if (el.type !== 'range' && el.dataset.src) apply(el); if (el.id === 'lb-imp') Lab.importFile(el.files[0]); if (el.id === 'lb-rest') Lab.restore(el.files[0]); });
    b.addEventListener('input', e => {
      if (e.target.id === 'lb-bw') { $('#lb-bw-o').textContent = fmtN(e.target.value / 1000, 1) + ' kHz'; clearTimeout(Lab._b); Lab._b = setTimeout(() => RS.setMode(RS.curMode(), +e.target.value), 150); }
      if (e.target.id === 'lb-sq') { const v = +e.target.value; $('#lb-sq-o').textContent = v ? v + ' dB' : 'off'; RS.send({ cmd: 'squelch', db: v }); RS.store.set('sq', v); }
    });
  };
  // refresh the controls in place (never rebuild them, so a click is never lost)
  Lab.sync = () => {
    RS.$$('#lb-body [data-src]').forEach(el => {
      if (el === document.activeElement || Lab._p) return;
      const v = val(el.dataset.src, el.dataset.k); if (v == null) return;
      if (el.type === 'checkbox') el.checked = !!v; else if (String(el.value) !== String(v)) { el.value = v; const o = $('#lb-body').querySelector('output[data-o="' + el.dataset.k + '"]'); if (o && el.type === 'range') o.textContent = fmtN(v, (+el.step < 1 && +el.step > 0) ? (String(el.step).split('.')[1] || '').length : 0) + ' ' + o.textContent.split(' ').slice(1).join(' '); }
    });
    Lab.live();
  };
  Lab.enter = () => { Lab.draw(); };
  Lab.draw = () => {
    RS.$$('#lb-tabs button').forEach(x => x.setAttribute('aria-pressed', x.dataset.t === Lab.tab));
    if (!panes[Lab.tab]) Lab.tab = 'front';
    $('#lb-body').innerHTML = panes[Lab.tab](); Lab.live(); Lab.lists(); RS.fire('labpane', Lab.tab);
  };
  RS.act['lb-tab'] = b => { Lab.tab = b.dataset.t; RS.store.set('labtab', Lab.tab); Lab.draw(); };
  RS.act['lb-mode'] = b => { RS.setMode(b.dataset.m); setTimeout(Lab.draw, 300); };
  RS.act['lb-cmap'] = b => { RS.setDisp({ cmap: b.dataset.k }); RS.$$('.cm').forEach(x => x.setAttribute('aria-pressed', x.dataset.k === b.dataset.k)); };
  RS.act['lb-reset'] = () => RS.confirm('Reset the lab?', 'All lab settings go back to their factory values.', 'Reset', () => { RS.api('lab', { reset: true }); RS.toast('Lab reset.'); });

  // ---------------------------------------------------------------- live read-outs
  const kv = (k, v) => '<div class="lb-kv"><span>' + esc(k) + '</span><b>' + v + '</b></div>';
  Lab.live = () => {
    const m = RS.meas || {}, st = RS.st || {};
    const el = $('#lb-meas'); if (el) el.innerHTML = m.peakF ? [
      kv('Frequency counter (strongest)', esc(RS.fmt(m.peakF)).replace(/ /, '&nbsp;')), kv('Level at peak', m.peakDb.toFixed(1) + ' dB'), kv('Noise floor', (m.floor || 0).toFixed(1) + ' dB'),
      kv('Signal-to-noise at peak', (m.peakDb - m.floor).toFixed(1) + ' dB'), kv('Channel power (tuned)', m.chanDb != null ? m.chanDb.toFixed(1) + ' dB' : '-'), kv('Occupied bandwidth (99%)', m.obw ? (m.obw / 1000).toFixed(1) + ' kHz' : '-'),
      kv('Bin width (display)', (m.binHz / 1000).toFixed(2) + ' kHz'), kv('FFT resolution', ((m.nfftRes || 0) / 1000).toFixed(2) + ' kHz')].join('') : '<div class="muted">Waiting for a signal... open the Radio page once so the spectrum starts.</div>';
    const r = $('#lb-rbw'); if (r) r.textContent = 'Resolution bandwidth: ' + ((RS.cfg.sample_rate || 2400000) / (RS.lab.nfft || 4096) / 1000).toFixed(2) + ' kHz per bin';
    const rd = $('#lb-rds'); if (rd) { const r = st.rds; rd.innerHTML = (st.stereo ? '<div><b>Stereo</b> locked</div>' : '<div class="muted">Mono (or not an FM station)</div>') + (r ? '<div>Station <b class="mono">' + esc(r.ps || '-') + '</b> &middot; PI <span class="mono">' + esc(r.pi_hex) + '</span> &middot; ' + esc(r.pty_name || '') + (r.tp ? ' &middot; traffic programme' : '') + '</div><div class="muted">' + esc(r.rt || '') + '</div><div class="small muted">' + r.groups + ' groups decoded</div>' : '<div class="muted">No RDS heard.</div>'); }
    const nb = $('#lb-nbc'); if (nb) nb.textContent = RS.lab.nb_on ? 'Samples blanked so far: ' + (st.nb_hits || 0).toLocaleString() : '';
    const mk = $('#lb-mk'); if (mk) { const L = RS.live; mk.innerHTML = RS.markers.length ? RS.markers.map((f, i) => { const lv = L ? (L.bins[Math.min(1023, Math.max(0, Math.round((f - (L.center - L.fs / 2)) / L.fs * 1023)))] / 2.2 - 110) : null; return '<div class="lb-kv"><span>M' + (i + 1) + ' ' + esc(RS.fmt(f)) + '</span><b>' + (lv != null ? lv.toFixed(1) + ' dB' : '') + (i ? ' <span class="muted">(Δ ' + esc(RS.fmt(Math.abs(f - RS.markers[0]))) + ' from M1)</span>' : '') + ' <button class="btn small ghost" data-act="lb-mk-del" data-i="' + i + '">Remove</button></b></div>'; }).join('') : '<div class="muted small">No markers yet.</div>'; }
    const sy = $('#lb-sys'); if (sy) {
      const d = st.device || {}, A = RS.audio || {};
      sy.innerHTML = [kv('Version', esc(RS.version)), kv('Connection', RS.connected ? 'live' : 'down'), kv('Radio', esc(d.name || (RS.sim ? 'simulator' : 'none')) + (d.tuner ? ' (' + esc(d.tuner) + ')' : '')), kv('Job', esc(st.job || '-')),
        kv('Sample rate', st.fs ? (st.fs / 1e6).toFixed(2) + ' MS/s' : '-'), kv('Centre', st.center ? esc(RS.fmt(st.center)) : '-'), kv('Audio frames', (A.frames || 0).toLocaleString()), kv('Sound gaps (this page)', (A.stats || {}).under || 0),
        kv('Noise-blanked samples', (st.nb_hits || 0).toLocaleString()), kv('Region', esc((RS.region && RS.region.name) || '-')), kv('Browser', esc(navigator.userAgent.slice(0, 60)))].join('');
    }
  };
  setInterval(() => { if (RS.page === 'lab' && Lab.tab === 'system') Lab.live(); }, 1500);

  // ---------------------------------------------------------------- markers, export
  RS.act['lb-mk-vfo'] = () => { RS.setMarkers(RS.markers.concat([RS.vfo()])); Lab.live(); };
  RS.act['lb-mk-peak'] = () => { if (RS.meas && RS.meas.peakF) RS.setMarkers(RS.markers.concat([RS.meas.peakF])); Lab.live(); };
  RS.act['lb-mk-clear'] = () => { RS.setMarkers([]); Lab.live(); };
  RS.act['lb-mk-del'] = b => { const m = RS.markers.slice(); m.splice(+b.dataset.i, 1); RS.setMarkers(m); Lab.live(); };
  const save = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); };
  RS.act['lb-csv'] = () => {
    const L = RS.live; if (!L) { RS.toast('No spectrum yet. Open the Radio page first.', 'bad'); return; }
    let t = 'frequency_hz,level_db\n'; for (let i = 0; i < 1024; i++) t += Math.round(L.center - L.fs / 2 + (i + .5) * L.fs / 1024) + ',' + (L.bins[i] / 2.2 - 110).toFixed(1) + '\n';
    save('spectrum-' + Math.round(L.center / 1e3) + 'kHz.csv', t, 'text/csv');
  };
  RS.act['lb-png'] = () => { const c = $('#lb-water'); c.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'waterfall.png'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 500); }); };
  RS.act['lb-diag'] = () => { const c = Object.assign({}, RS.cfg); delete c.rtl_tcp; save('skywave-diagnostics.json', JSON.stringify({ version: RS.version, time: new Date().toISOString(), state: RS.st, config: c, lab: RS.lab, display: RS.disp, markers: RS.markers, ua: navigator.userAgent }, null, 2), 'application/json'); };
  RS.act['lb-backup'] = async () => { const h = await RS.api('hello'); save('skywave-settings.json', JSON.stringify({ skywave_backup: 1, config: h.config, lab: RS.lab, prefs: RS.prefs, favourites: RS.favs, banks: RS.banks }, null, 2), 'application/json'); };
  Lab.restore = async f => {
    if (!f) return; let j; try { j = JSON.parse(await f.text()); } catch (e) { RS.toast('That is not a valid backup file.', 'bad'); return; }
    if (!j.skywave_backup && !j.aether_backup && !j.rtl_station_backup) { RS.toast('That file is not an Skywave backup.', 'bad'); return; }
    const keep = ['lat', 'lon', 'alt', 'gain_auto', 'gain_db', 'ppm', 'hf_mode', 'deemph_us', 'bias_t', 'settle_s', 'adsb_gain_db', 'sample_rate', 'audio_format', 'mp3_kbps', 'region', 'lang', 'units', 'tz'];
    const ch = {}; keep.forEach(k => { if (j.config && k in j.config) ch[k] = j.config[k]; });
    await RS.api('config', { changes: ch }); if (j.lab) await RS.api('lab', { set: j.lab }); if (j.prefs) await RS.api('prefs', { prefs: j.prefs }); if (j.favourites) await RS.api('favourites', { list: j.favourites });
    RS.toast('Backup restored.'); setTimeout(() => location.reload(), 800);
  };

  // ---------------------------------------------------------------- frequency manager and presets
  Lab.iq = async () => {
    const el = $('#lb-iq'); if (!el) return;
    let files = []; try { files = ((await RS.api('recordings')).files || []).filter(f => f.iq || /_iq\.wav$|\.cu8$/i.test(f.name)); } catch (e) { }
    const cur = RS.cfg.iq_file || '';
    el.innerHTML = '<div class="lb-row"><div class="lb-l"><label>Playing from</label><div class="small muted">Baseband files are made with the Space page\'s IQ recording option.</div></div><div class="lb-c"><select id="lb-iqf" aria-label="IQ file"><option value="">The radio (live)</option>' +
      files.map(f => '<option value="' + esc(f.name) + '"' + (f.name === cur ? ' selected' : '') + '>' + esc(f.name) + '</option>').join('') + '</select></div></div>' +
      '<div class="lb-row"><div class="lb-l"><label>Recorded at (MHz)</label><div class="small muted">The centre frequency the file was captured at. Read from the file name when possible.</div></div><div class="lb-c"><input id="lb-iqc" inputmode="decimal" value="' + ((RS.cfg.iq_center || 0) / 1e6 || '') + '" aria-label="Centre frequency in MHz"></div></div>' +
      '<div class="small muted">' + (cur ? 'Playing ' + esc(cur) + ' on a loop. Pick "The radio" to go live again.' : (files.length ? '' : 'No baseband recordings found yet.')) + '</div>';
    const apply = () => { const f = $('#lb-iqf').value, m = /_([0-9.]+)MHz_/.exec(f), c = $('#lb-iqc'); if (f && m && !parseFloat(c.value)) c.value = m[1]; RS.api('config', { changes: { iq_file: f, iq_center: (parseFloat(c.value) || 0) * 1e6 } }).then(() => { RS.toast(f ? 'Playing the recording.' : 'Back to the live radio.'); setTimeout(Lab.draw, 500); }); };
    $('#lb-iqf').onchange = apply; $('#lb-iqc').onchange = () => { if ($('#lb-iqf').value) apply(); };
  };
  Lab.lists = () => {
    Lab.iq();
    const f = $('#lb-favs'); if (f) f.innerHTML = RS.favs.length ? '<div class="lb-tbl">' + RS.favs.map((x, i) => '<div class="lb-tr"><input value="' + esc(x.name || '') + '" data-act-input="lb-fav-name" data-i="' + i + '" aria-label="Name"><span class="mono">' + esc(RS.fmt(x.f, x.mode)) + '</span><span class="pill">' + esc((RS.MODES[x.mode] || {}).name || x.mode || '') + '</span><button class="btn small" data-act="lb-fav-go" data-i="' + i + '">Tune</button><button class="btn small ghost danger" data-act="lb-fav-del" data-i="' + i + '">Remove</button></div>').join('') + '</div>' : '<div class="muted">No favourites yet. Press the star on the Radio page, or add one here.</div>';
    const p = $('#lb-pres'), P = (RS.prefs && RS.prefs.presets) || [];
    if (p) p.innerHTML = P.length ? P.map((x, i) => '<div class="lb-tr"><b>' + esc(x.name) + '</b><span class="muted small">' + esc((RS.MODES[x.mode] || {}).name || '') + ' ' + (x.bw ? (x.bw / 1000).toFixed(1) + ' kHz' : '') + '</span><button class="btn small primary" data-act="lb-pre-load" data-i="' + i + '">Load</button><button class="btn small ghost danger" data-act="lb-pre-del" data-i="' + i + '">Delete</button></div>').join('') : '<div class="muted">None saved yet.</div>';
  };
  const saveFavs = l => { l.sort((a, b) => a.f - b.f); RS.favs = l; RS.fire('favourites'); RS.api('favourites', { list: l }).catch(() => { }); Lab.lists(); };
  document.addEventListener('change', e => { const t = e.target; if (t.dataset && t.dataset.actInput === 'lb-fav-name') { const l = RS.favs.map(x => Object.assign({}, x)); l[+t.dataset.i].name = t.value.slice(0, 60); saveFavs(l); } });
  RS.act['lb-fav-add'] = () => { const f = Math.round(RS.vfo()); if (!RS.isFav(f)) RS.toggleFav(f, RS.curMode()); setTimeout(Lab.lists, 100); };
  RS.act['lb-fav-del'] = b => { const l = RS.favs.slice(); l.splice(+b.dataset.i, 1); saveFavs(l); };
  RS.act['lb-fav-go'] = b => { const x = RS.favs[+b.dataset.i]; RS.tune(x.f, { mode: x.mode, recenter: true }); RS.toast('Tuned to ' + RS.fmt(x.f, x.mode)); };
  RS.act['lb-fav-export'] = () => save('favourites.csv', 'name,frequency_mhz,mode\n' + RS.favs.map(x => '"' + String(x.name || '').replace(/"/g, '""') + '",' + (x.f / 1e6).toFixed(6) + ',' + (x.mode || '')).join('\n') + '\n', 'text/csv');
  RS.act['lb-fav-json'] = () => save('favourites.json', JSON.stringify(RS.favs, null, 1), 'application/json');
  Lab.importFile = async f => {
    if (!f) return; const txt = await f.text(); let add = [];
    try { const j = JSON.parse(txt); if (Array.isArray(j)) add = j.filter(x => x && isFinite(x.f)).map(x => ({ f: Math.round(x.f), mode: x.mode || RS.modeFor(x.f), name: String(x.name || '').slice(0, 60) })); } catch (e) {
      txt.split(/\r?\n/).forEach(line => { const c = line.match(/("([^"]*)"|[^,;\t]*)/g); const parts = line.split(/[,;\t]/).map(s => s.trim().replace(/^"|"$/g, '')); if (parts.length < 2) return; let fi = parts.findIndex(p => /^[\d.]+$/.test(p) && +p > 0); if (fi < 0) return; let hz = +parts[fi]; hz = hz < 2000 ? hz * 1e6 : hz < 2e6 ? hz * 1e3 : hz; if (hz < 1e5 || hz > 1.8e9) return; const name = parts.find((p, i) => i !== fi && p && !/^[\d.]+$/.test(p) && !RS.MODES[p.toLowerCase()]) || ''; const md = parts.find(p => RS.MODES[p.toLowerCase()]); add.push({ f: Math.round(hz), mode: md ? md.toLowerCase() : RS.modeFor(hz), name: name.slice(0, 60) }); });
    }
    if (!add.length) { RS.toast('No frequencies found in that file.', 'bad'); return; }
    const l = RS.favs.map(x => Object.assign({}, x)); add.forEach(a => { if (!l.some(x => Math.abs(x.f - a.f) < 5e3)) l.push(a); }); saveFavs(l); RS.toast('Imported ' + add.length + ' frequencies.');
  };
  RS.act['lb-pre-save'] = () => {
    const n = ($('#lb-pname').value || '').trim().slice(0, 40); if (!n) { RS.toast('Give the preset a name first.', 'bad'); return; }
    const P = ((RS.prefs && RS.prefs.presets) || []).filter(x => x.name !== n); P.push({ name: n, lab: Object.assign({}, RS.lab), mode: RS.curMode(), bw: RS.st.bw, squelch: RS.st.squelch || 0, gain_auto: RS.cfg.gain_auto, gain_db: RS.cfg.gain_db, deemph_us: RS.cfg.deemph_us });
    RS.setPref('presets', P.slice(-30)); setTimeout(Lab.lists, 50); RS.toast('Preset saved.');
  };
  RS.act['lb-pre-load'] = async b => { const x = ((RS.prefs && RS.prefs.presets) || [])[+b.dataset.i]; if (!x) return; await RS.api('lab', { set: x.lab || {} }); await RS.api('config', { changes: { gain_auto: x.gain_auto, gain_db: x.gain_db, deemph_us: x.deemph_us } }); RS.setMode(x.mode, x.bw); RS.send({ cmd: 'squelch', db: x.squelch || 0 }); RS.toast('Loaded "' + x.name + '".'); };
  RS.act['lb-pre-del'] = b => { const P = ((RS.prefs && RS.prefs.presets) || []).slice(); P.splice(+b.dataset.i, 1); RS.setPref('presets', P); setTimeout(Lab.lists, 50); };
})();
