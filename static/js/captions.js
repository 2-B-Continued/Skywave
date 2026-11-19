/* captions.js - live captions strip, timed-recording scheduler, transcripts in the Library */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$ || (s => document.querySelector(s));
  const esc = RS.esc || (s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  RS.captionLog = []; RS.timers = [];

  // ---------------------------------------------------------------- caption strip + CC button
  function build() {
    const bar = $('#soundbar'); if (!bar || $('#sb-cc')) return;
    const strip = document.createElement('div'); strip.id = 'capstrip'; strip.className = 'capstrip'; strip.hidden = true;
    strip.innerHTML = '<div class="cap-head"><b id="cap-title">Live captions</b><span id="cap-state" class="small"></span><label class="check small"><input type="checkbox" id="cap-save"><span>Also save as a text file</span></label><button class="btn small" id="cap-clear" type="button">Clear</button><button class="btn small" id="cap-off" type="button">Hide</button></div><div id="cap-lines" class="cap-lines" aria-live="polite"></div>';
    bar.appendChild(strip);
    const cc = document.createElement('button'); cc.className = 'btn'; cc.id = 'sb-cc'; cc.type = 'button';
    cc.title = 'Show live captions for spoken channels (not for radio stations)'; cc.innerHTML = '<b style="font-family:var(--mono,monospace)">CC</b><span class="cc-lbl">Captions</span>';
    bar.insertBefore(cc, $('#sb-rec'));
    cc.onclick = () => {
      const c = RS.st.captions || {};
      if (!c.on && c.allowed === false) { RS.toast('Captions are for spoken channels such as walkie-talkies, aircraft, marine and ham radio. They are not made for radio stations.', ''); return; }
      if (!c.on && !(RS.captionStatus || {}).available && !c.available) { RS.toast('Captions need the speech add-on, which is not installed. See Settings.', 'bad'); }
      RS.send({ cmd: 'captions', on: !c.on, save: c.on ? undefined : !!(RS.cfg && RS.cfg.caption_save) });
    };
    $('#cap-off').onclick = () => { RS.morseShow = 0; RS.send({ cmd: 'captions', on: false }); render(); };
    $('#cap-clear').onclick = () => { RS.captionLog = []; render(); };
    $('#cap-save').onchange = e => RS.send({ cmd: 'captions', on: true, save: e.target.checked });
  }
  const hhmm = t => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const lineHtml = x => '<div' + (x.kind === 'morse' ? ' class="morse"' : x.partial ? ' class="live"' : '') + '><time>' + hhmm(x.t) + '</time>' + (x.label ? '<i>' + esc(x.label) + '</i>' : '<i>' + esc(RS.fmt(x.f)) + '</i>') +
    (x.kind === 'morse' ? '<em class="mc">Morse code' + (x.wpm ? ' \u00b7 ' + x.wpm + ' wpm' : '') + '</em>' : '') + '<span>' + esc(x.text) + (x.partial ? '<b class="dots" aria-hidden="true">\u2026</b>' : '') + '</span></div>';
  function render() {
    const c = (RS.st && RS.st.captions) || {}, strip = $('#capstrip'), cc = $('#sb-cc'); if (!strip) return;
    const job = RS.st && RS.st.job;
    const canHear = job === 'listen' || job === 'ism' && false;
    cc.classList.toggle('rec-on', !!c.on);
    cc.classList.toggle('dim', c.allowed === false);
    cc.querySelector('.cc-lbl').textContent = c.on ? 'Captions on' : 'Captions';
    // Morse code opens the strip by itself, even with captions off, and keeps it for a few minutes after the last message
    const morse = !c.on && RS.morseShow && Date.now() - RS.morseShow < 180000;
    strip.hidden = !(c.on || morse);
    document.body.classList.toggle('has-caps', !!(c.on || morse));
    const last = RS.captionLog[RS.captionLog.length - 1];
    $('#cap-title').textContent = (morse || (last && last.kind === 'morse' && Date.now() / 1000 - last.t < 60)) ? 'Morse code' : 'Live captions';
    if (morse) {
      $('#cap-state').textContent = 'Decoded automatically from the tuned frequency.';
      const ls = RS.captionLog.filter(x => x.kind === 'morse').slice(-4);
      RS.setHTML($('#cap-lines'), ls.map(lineHtml).join(''));
      const l = $('#cap-lines'); l.scrollTop = l.scrollHeight;
      return;
    }
    if (!c.on) return;
    $('#cap-save').checked = !!c.save;
    let st = 'Listening for speech...';
    if (c.allowed === false) st = 'Paused: this is a radio station, and captions are only for spoken channels.';
    else if (c.loading) st = 'Loading the caption model (the first time it downloads, so give it a minute)...';
    else if (c.reason) st = c.reason;
    else if (job !== 'listen') st = 'Waiting: the radio is busy with something else.';
    else if (c.busy) st = 'Working out what was said...';
    $('#cap-state').textContent = st;
    const ls = RS.captionLog.slice(-4);
    const l = $('#cap-lines'), before = l._h;
    RS.setHTML(l, ls.length ? ls.map(lineHtml).join('') : '<div class="muted small">Nothing heard yet.</div>');
    if (l._h !== before) l.scrollTop = l.scrollHeight;
    void canHear;
  }
  RS.on('hello', () => { RS.captionLog = (RS._hello_caps || []).slice(); render(); });
  RS.on('state', render);
  // Live captions: the words so far arrive as a "partial" line, which is replaced in place by later guesses and finally by the finished line
  // (same id), so text appears while people are still talking and never lands as one big dump.
  const slot = id => { if (id == null) return -1; for (let i = RS.captionLog.length - 1; i >= 0 && i > RS.captionLog.length - 12; i--) if (RS.captionLog[i].id === id) return i; return -1; };
  RS.on('caption', m => {
    if (m.kind === 'morse') { RS.morseShow = Date.now(); setTimeout(render, 181000); }
    const i = slot(m.id);
    if (i >= 0) RS.captionLog[i] = m; else RS.captionLog.push(m);
    if (RS.captionLog.length > 80) RS.captionLog.shift();
    render();
    if (!m.partial) RS.fire('caption_added', m);
  });
  RS.on('caption_drop', m => { const i = slot(m.id); if (i >= 0 && RS.captionLog[i].partial) { RS.captionLog.splice(i, 1); render(); } });
  RS.on('captions', m => { RS.st.captions = m; render(); });

  // ---------------------------------------------------------------- timed recordings
  RS.on('timers', m => { RS.timers = m.list || []; if (RS.page === 'library' && RS.pages.library && RS.pages.library.timers) RS.pages.library.timers(); });
  const pad = n => String(n).padStart(2, '0');
  const localInput = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  RS.timerWhen = it => {
    const d = new Date(it.start * 1000), n = new Date();
    const day = d.toDateString() === n.toDateString() ? 'Today' : (new Date(n.getTime() + 864e5).toDateString() === d.toDateString() ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }));
    return day + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };
  RS.timerDur = s => s >= 3600 ? (s / 3600) + (s === 3600 ? ' hour' : ' hours') : Math.round(s / 60) + ' min';
  RS.openTimer = pre => {
    pre = pre || {};
    const f = pre.freq || (RS.vfo ? RS.vfo() : 146.5e6), mode = pre.mode || (RS.curMode ? RS.curMode() : 'nfm');
    const start = new Date(Date.now() + 5 * 60000); start.setSeconds(0, 0);
    const m = RS.modal('<h2 style="margin-top:0">Schedule a recording</h2><p class="small muted">The radio tunes to this channel by itself at the start time, even if nobody has the page open. It takes over the radio for the duration.</p>' +
      '<div class="grid2"><label class="field">Frequency (MHz)<input id="tm-f" inputmode="decimal" value="' + (f / 1e6).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + '"></label>' +
      '<label class="field">Mode<select id="tm-m"><option value="nfm">Two-way radio (NFM)</option><option value="am">Aircraft / AM</option><option value="wfm">FM station (WFM)</option><option value="usb">Upper sideband (USB)</option><option value="lsb">Lower sideband (LSB)</option><option value="cw">Morse (CW)</option></select></label>' +
      '<label class="field">Starts<input id="tm-s" type="datetime-local" value="' + localInput(start) + '"></label>' +
      '<label class="field">For how long<select id="tm-d"><option value="900">15 minutes</option><option value="1800">30 minutes</option><option value="3600" selected>1 hour</option><option value="7200">2 hours</option><option value="14400">4 hours</option><option value="28800">8 hours</option><option value="43200">12 hours</option></select></label>' +
      '<label class="field">Repeat<select id="tm-r"><option value="none">Just once</option><option value="daily">Every day</option><option value="weekdays">Weekdays (Mon to Fri)</option><option value="weekly">Every week</option></select></label>' +
      '<label class="field">Keep<select id="tm-w"><option value="sound">Sound (an audio file)</option><option value="text">Text only (a transcript, no audio)</option><option value="both">Both</option></select></label></div>' +
      '<label class="field">Name (optional)<input id="tm-l" placeholder="e.g. Morning truckie chatter" maxlength="60"></label>' +
      '<div class="small muted" id="tm-note" style="margin:8px 0"></div>' +
      '<div class="row"><button class="btn primary" id="tm-go">Schedule it</button><button class="btn" id="tm-now">Start in 1 minute</button><button class="btn" id="tm-x">Cancel</button></div>');
    $('#tm-m').value = ['nfm', 'am', 'wfm', 'usb', 'lsb', 'cw'].includes(mode) ? mode : 'nfm';
    const note = () => {
      const fr = RS.parseFreq($('#tm-f').value, 'm'), w = $('#tm-w').value;
      let t = 'Only the radio\'s own recording keeps running: sound is saved as ' + ((RS.cfg && RS.cfg.audio_format) === 'wav' ? 'WAV (big)' : 'MP3 (small)') + ' and only while someone is actually talking.';
      if (fr && w !== 'sound' && RS.bandName && /FM radio|AM radio|shortwave/i.test(RS.bandName(fr))) t = 'That is a radio station, and captions are only made for spoken channels, so no transcript would be written. Choose Sound, or a different channel.';
      else if (w !== 'sound') t = 'The transcript is plain text, saved in the Library.';
      $('#tm-note').textContent = t;
    };
    ['tm-f', 'tm-w'].forEach(i => $('#' + i).addEventListener('input', note)); note();
    const go = async startIn => {
      const fr = RS.parseFreq($('#tm-f').value, 'm'); if (!fr) { RS.toast('Type a frequency in MHz, e.g. 446.00625', 'bad'); return; }
      const body = { freq: fr, mode: $('#tm-m').value, duration: +$('#tm-d').value, repeat: $('#tm-r').value, what: $('#tm-w').value, label: $('#tm-l').value };
      if (startIn) body.start_in = 1; else { const t = new Date($('#tm-s').value).getTime() / 1000; if (!t) { RS.toast('Pick a start time', 'bad'); return; } body.start = t; }
      try { const r = await RS.api('timers/add', body); if (r && r.error) { RS.toast(r.error, 'bad'); return; } RS.timers = (r && r.list) || RS.timers; RS.closeModal(); RS.toast('Scheduled.'); if (RS.pages.library && RS.pages.library.timers) RS.pages.library.timers(); }
      catch (e) { RS.toast((e && e.message) || 'Could not schedule that', 'bad'); }
    };
    $('#tm-go').onclick = () => go(false); $('#tm-now').onclick = () => go(true); $('#tm-x').onclick = RS.closeModal;
    return m;
  };
  RS.act['timer-new'] = () => RS.openTimer();
  RS.act['timer-here'] = () => RS.openTimer({ freq: RS.vfo(), mode: RS.curMode() });
  RS.act['timer-del'] = async el => { const id = el.dataset.id; const r = await RS.api('timers/delete', { id }); RS.timers = (r && r.list) || []; if (RS.pages.library.timers) RS.pages.library.timers(); };

  // ---------------------------------------------------------------- transcripts (Library)
  RS.act['tx-view'] = async el => {
    const t = await (await fetch('/txt/' + encodeURIComponent(el.dataset.f))).text();
    RS.modal('<h2 style="margin-top:0">' + esc(el.dataset.f) + '</h2><pre class="txview">' + esc(t) + '</pre><div class="row"><a class="btn" href="/txt/' + encodeURIComponent(el.dataset.f) + '?download=1">Download</a><button class="btn primary" onclick="RS.closeModal()">Close</button></div>');
  };
  RS.act['tx-del'] = el => RS.confirm('Delete this transcript?', el.dataset.f, 'Delete', async () => { await RS.api('transcripts/delete', { file: el.dataset.f }); if (RS.pages.library.transcripts) RS.pages.library.transcripts(); });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
