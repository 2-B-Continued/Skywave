/* scanner.js - the Scanner page.
   Layout: a list rail on the left (a "Change list" sheet on phones), and one column with the console, the channel strip,
   the spectrum and recent activity. The console is built once and only its words and buttons are updated, at a fixed
   height, so the page never jumps while the scan runs. Channel cells are all the same size: a name, the frequency, how
   often the scanner stopped there as a small bar, and a lit cell for the channel being heard. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc, icon = RS.icon;
  const Sc = RS.pages.scanner = {};
  Sc.bankId = RS.store.get('scanbank', 'cb_uhf');
  const bankById = id => RS.banks.find(b => b.id === id);
  const shortName = n => String(n || '').replace(/\s*\(\d+\s+channels?\)\s*$/i, '');
  const count = b => { const r = (b.ranges || [])[0]; return (b.channels || []).length + (r && r.step >= 100 ? Math.floor((r.stop - r.start) / r.step) + 1 : 0); };
  const emerg = c => /emergency|distress/i.test(c.label || '') || /^CH(5|35)\b/.test(c.label || '');
  const set = (el, t) => RS.setText(el, t);
  const show = (el, on) => { if (el && el.hidden === !!on) el.hidden = !on; };

  // ---------------------------------------------------------------- channels of a list, with a number and a name
  function split(c) {
    const L = c.label || '';
    let m = /^CH\s*(\d+)\s*(.*)$/i.exec(L) || /\bchannel\s+(\d+)\s*(.*)$/i.exec(L);
    if (m) return { num: +m[1], name: m[2].replace(/^[-,\s]+/, '') };
    return { num: null, name: L.replace(/\s+\d{2,3}\.\d+\s*$/, '') };
  }
  function expand(b) {
    const out = (b.channels || []).map(c => Object.assign({}, c, split(c)));
    (b.ranges || []).forEach(r => { if (!(r.step >= 100)) return; for (let f = r.start; f <= r.stop + 1 && out.length < 20000; f += r.step) out.push({ f: Math.round(f), label: '', name: '', num: null, mode: r.mode, bw: r.bw }); });
    if (out.length && out.every(c => c.num != null)) return out.sort((a, z) => a.num - z.num || a.f - z.f);
    return out.sort((a, z) => a.f - z.f);
  }
  const mhz = f => (f / 1e6).toFixed(f % 1e3 ? 4 : 3).replace(/0$/, '');

  // ---------------------------------------------------------------- the page
  Sc.init = () => {
    $('#p-scanner').innerHTML = `
    <div class="page-head scn-head"><h2>Scanner</h2><p>Checks a list of channels over and over, and stops on any channel where someone is talking.</p></div>
    <div class="scn">
      <aside class="scn-rail card kx-static" aria-label="Channel lists">
        <div class="scn-rail-h"><h3>Lists</h3><button class="btn small ghost" data-act="sc-new" type="button">New list</button></div>
        <div class="scn-lists" id="sc-lists" data-stagger role="listbox" aria-label="Choose a list"></div>
      </aside>
      <div class="scn-main">
        <section class="scn-console glass kx-static" id="sc-now" aria-live="polite">
          <div class="scn-top">
            <span class="scn-state" id="sc-state"><i class="scn-led"></i><span id="sc-state-t">Ready</span></span>
            <button class="btn small scn-change" data-act="sc-lists-sheet" type="button"><span>Change list</span>${icon('down')}</button>
          </div>
          <div class="scn-read">
            <div class="scn-title" id="sc-title">&nbsp;</div>
            <div class="scn-sub" id="sc-sub">&nbsp;</div>
          </div>
          <div class="scn-ctl">
            <button class="btn primary big" data-act="sc-start" id="sc-go" type="button">${icon('play')}<span>Start scanning</span></button>
            <button class="btn" data-act="sc-hold" id="sc-hold" type="button" hidden>${icon('pause')}<span>Hold</span></button>
            <button class="btn" data-act="sc-skip" id="sc-skip" type="button" hidden>${icon('skip')}<span>Skip</span></button>
            <button class="btn" data-act="sc-lockout" id="sc-ign" type="button" hidden title="Never stop on this channel again">${icon('ban')}<span class="scn-long">Ignore channel</span><span class="scn-short">Ignore</span></button>
            <button class="btn" data-act="sc-stop" id="sc-stop" type="button" hidden>${icon('stop')}<span>Stop</span></button>
          </div>
          <div class="scn-foot">
            <label class="check"><input type="checkbox" id="sc-rec"><span>Record what it finds</span></label>
            <button class="btn small ghost" data-act="sc-unlock" id="sc-unign" type="button" hidden><span>Un-ignore</span></button>
            <label class="scn-thr adv-only"><span>Sensitivity</span><input type="range" id="sc-thr" min="4" max="25" step="1" value="8" aria-label="Sensitivity: low numbers stop on fainter signals"><b id="sc-thr-v">8 dB</b></label>
          </div>
        </section>

        <section class="card kx-static scn-chans">
          <div class="scn-sec-h"><div><h3>Channels</h3><div class="sub" id="sc-ch-sub"></div></div></div>
          <div id="sc-chans" data-stagger></div>
        </section>

        <section class="card kx-static scn-scope">
          <div class="glass scope" id="sc-scope"><canvas class="spec" id="sc-spec"></canvas><canvas class="water" id="sc-water"></canvas></div>
          <div class="scn-scope-bar">
            <span class="scn-scope-info" id="sc-scope-info">Waiting for the radio</span>
            <span class="scn-scope-ctl">
              <button class="btn small" data-act="sc-nudge" data-n="-1" aria-label="Tune down one step" title="Tune down" type="button">&lsaquo;</button>
              <button class="btn small" data-act="sc-nudge" data-n="1" aria-label="Tune up one step" title="Tune up" type="button">&rsaquo;</button>
              <button class="btn small" data-act="sc-pause" type="button"><span>Pause</span></button>
            </span>
          </div>
          <p class="scn-note">Tap the picture to listen to that frequency (this stops the scan).</p>
        </section>

        <section class="card kx-static scn-log-card">
          <div class="scn-sec-h"><div><h3>Recent activity</h3><div class="sub">Where the scanner stopped, newest first</div></div><a class="btn small ghost" href="/api/export/scanlog.csv">Download (CSV)</a></div>
          <div class="scn-log" id="sc-log" data-stagger></div>
        </section>

        <details class="card kx-static scn-edit" id="sc-edit"><summary>Edit this list</summary><div id="sc-editor"></div></details>
      </div>
    </div>`;
    Sc.scope = new RS.Scope($('#sc-spec'), $('#sc-water'), $('#sc-scope-info'));
    RS.on('spec', L => { if (RS.page === 'scanner') Sc.scope.frame(L); });
    RS.on('banks', () => Sc.lists()); RS.on('scan_end', () => Sc.log()); RS.on('hello', () => { Sc.lists(); Sc.log(); });
    RS.on('scan_started', () => Sc.state());
    $('#sc-rec').onchange = e => { if (RS.st.scan) RS.send({ cmd: 'scan', action: 'record', on: e.target.checked }); };
    const thr = $('#sc-thr');
    thr.oninput = () => set($('#sc-thr-v'), thr.value + ' dB');
    thr.onchange = () => { RS.scanThr = parseFloat(thr.value); if (RS.st.scan) RS.send({ cmd: 'scan', action: 'thr', db: RS.scanThr }); };
  };
  Sc.enter = () => { const s = RS.st.scan; if (s) Sc.bankId = s.bank; Sc.lists(); Sc.state(); Sc.log(); Sc.editor(); };

  // ---------------------------------------------------------------- lists (rail, and the same rows in a sheet on phones)
  function rows() {
    return RS.banks.map(b => {
      const n = count(b), on = b.id === Sc.bankId, run = RS.st.scan && RS.st.scan.bank === b.id;
      return '<button class="scn-li" role="option" type="button" data-act="sc-pick" data-id="' + esc(b.id) + '" aria-selected="' + on + '" aria-pressed="' + on + '">' +
        '<span class="scn-li-n">' + esc(shortName(b.name)) + '</span>' +
        '<span class="scn-li-m">' + (run ? '<i class="scn-led on"></i>Scanning' : n ? n + ' channel' + (n > 1 ? 's' : '') : 'Empty') + (b.builtin ? '' : ' &middot; yours') + '</span></button>';
    }).join('');
  }
  Sc.lists = () => {
    if (!RS.banks.length) return;
    if (!bankById(Sc.bankId)) Sc.bankId = RS.banks[0].id;
    const el = $('#sc-lists'); if (!el) return;
    const h = rows(); if (el._h !== h) { el._h = h; el.innerHTML = h; }
    Sc.state(); Sc.editor();
  };
  RS.act['sc-lists-sheet'] = () => RS.modal('<h3>Choose a list</h3><div class="sub" style="margin-bottom:10px">Lists are groups of channels to check.</div><div class="scn-lists scn-lists-sheet">' + rows() + '</div>');

  // ---------------------------------------------------------------- the console (words and buttons only; the shape never changes)
  let chanKey = '';
  Sc.state = () => {
    if (RS.page !== 'scanner' || !$('#sc-now')) return;
    const sc = RS.st.scan, bank = bankById(Sc.bankId), running = !!sc, lock = running && sc.state === 'locked' && sc.cur;
    const con = $('#sc-now');
    con.dataset.mode = !running ? 'idle' : sc.hold ? 'hold' : lock ? 'live' : 'scan';
    set($('#sc-state-t'), !running ? 'Ready' : sc.hold ? 'Held' : lock ? 'Listening' : 'Scanning');
    if (!running) {
      set($('#sc-title'), bank ? shortName(bank.name) : 'Choose a list');
      set($('#sc-sub'), bank ? (bank.note || (count(bank) + ' channels')) : '');
    } else if (lock) {
      const c = split(sc.cur);
      set($('#sc-title'), c.num != null ? 'Channel ' + c.num + (c.name ? ' · ' + c.name : '') : (sc.cur.label || RS.fmt(sc.cur.f)));
      set($('#sc-sub'), RS.fmt(sc.cur.f, sc.cur.mode) + ' · ' + (RS.MODES[sc.cur.mode] ? RS.MODES[sc.cur.mode].name : '') + ' · ' + shortName(sc.name));
    } else {
      set($('#sc-title'), sc.hold ? 'Held' : 'Waiting for someone to talk');
      set($('#sc-sub'), 'Checking ' + sc.channels + ' channels in ' + shortName(sc.name) + (sc.windows > 1 ? ', part ' + sc.window + ' of ' + sc.windows : ''));
    }
    show($('#sc-go'), !running);
    ['#sc-hold', '#sc-skip', '#sc-ign', '#sc-stop'].forEach(s => show($(s), running));
    if (running) {
      const hb = $('#sc-hold'); hb.querySelector('use').setAttribute('href', '#i-' + (sc.hold ? 'play' : 'pause'));
      set(hb.querySelector(':scope > span:not([aria-hidden])'), sc.hold ? 'Resume' : 'Hold'); hb.classList.toggle('on', !!sc.hold);
      $('#sc-ign').disabled = !lock;
    }
    const rec = $('#sc-rec'); if (running && rec.checked !== !!sc.record) rec.checked = !!sc.record;
    const ui = $('#sc-unign'), nl = running ? sc.locked.length : 0;
    show(ui, nl > 0); if (nl) set(ui.querySelector('span'), 'Un-ignore ' + nl);
    const thr = $('#sc-thr'); if (document.activeElement !== thr) { const v = RS.scanThr || (bank && bank.thr) || 8; if (+thr.value !== v) thr.value = v; set($('#sc-thr-v'), v + ' dB'); }

    // the list rail shows which list is running
    const lists = $('#sc-lists'); if (lists) { const h = rows(); if (lists._h !== h) { lists._h = h; lists.innerHTML = h; } }

    // channel strip: redrawn only when something in it changed
    const mine = running && sc.bank === Sc.bankId;
    const key = [Sc.bankId, bank ? (bank.channels || []).length + ':' + JSON.stringify(bank.ranges || []) : '', mine ? JSON.stringify(sc.hits) : '', mine && sc.cur && lock ? sc.cur.f : 0, mine ? sc.locked.join(',') : '', con.dataset.mode].join('|');
    if (key !== chanKey) { chanKey = key; chans(bank, mine ? sc : null, lock); }
  };

  function cell(c, n, max, cur, ign) {
    const head = c.num != null ? String(c.num) : (c.name || mhz(c.f));
    const sub = c.num != null ? (c.name || '') : '';
    return '<button class="scn-ch' + (cur ? ' cur' : '') + (ign ? ' ign' : '') + (emerg(c) ? ' em' : '') + '" type="button" data-act="sc-chan" data-f="' + c.f + '" data-mode="' + esc(c.mode) + '" data-bw="' + (c.bw || '') + '"' +
      ' title="' + esc((c.label || '') + ' ' + RS.fmt(c.f, c.mode) + (n ? ', stopped here ' + n + ' time' + (n > 1 ? 's' : '') : '') + (ign ? ', ignored' : '') + (emerg(c) ? ', emergency channel' : '')) + '">' +
      '<span class="scn-ch-a"><b>' + esc(head) + '</b>' + (n ? '<em>' + n + '</em>' : '') + '</span>' +
      '<span class="scn-ch-f">' + mhz(c.f) + '</span>' +
      (sub ? '<span class="scn-ch-n">' + esc(sub) + '</span>' : '') +
      '<i class="scn-ch-bar" style="--v:' + (max ? Math.max(0.08, n / max) : 0).toFixed(3) + '"></i></button>';
  }
  function chans(bank, sc, lock) {
    const wrap = $('#sc-chans'); if (!wrap) return;
    const L = bank ? expand(bank) : [];
    const hits = sc ? sc.hits || {} : {}, cur = lock && sc && sc.cur ? sc.cur.f : 0, ign = new Set(sc ? sc.locked : []);
    const max = Math.max(0, ...Object.values(hits));
    const scanning = sc && !sc.hold && !lock;
    if (!L.length) {
      set($('#sc-ch-sub'), '');
      wrap.innerHTML = '<div class="scn-empty"><b>This list has no channels yet</b><span>Open "Edit this list" below and add a frequency.</span></div>';
      return;
    }
    if (L.length > 150) {
      set($('#sc-ch-sub'), L.length + ' channels from ' + RS.fmt(L[0].f) + ' to ' + RS.fmt(L[L.length - 1].f) + '. The busiest ones appear here as the scanner finds them.');
      const top = Object.entries(hits).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([f, n]) => ({ c: L.find(x => x.f === +f) || { f: +f, mode: L[0].mode, num: null, name: '' }, n }));
      wrap.innerHTML = top.length ? '<div class="scn-strip' + (scanning ? ' sweeping' : '') + '">' + top.map(x => cell(x.c, x.n, max, x.c.f === cur, ign.has(x.c.f))).join('') + '</div>'
        : '<div class="scn-empty"><b>Nothing found yet</b><span>Start scanning. Channels with activity show up here, busiest first.</span></div>';
      return;
    }
    set($('#sc-ch-sub'), L.length + ' in ' + shortName(bank.name) + '. Tap one to listen. Bars show how often the scanner stopped there.');
    wrap.innerHTML = '<div class="scn-strip' + (scanning ? ' sweeping' : '') + '">' + L.map(c => cell(c, hits[c.f] || 0, max, c.f === cur, ign.has(c.f))).join('') + '</div>';
  }

  // ---------------------------------------------------------------- recent activity
  Sc.log = () => {
    const el = $('#sc-log'); if (!el) return;
    const L = RS.scanLog.slice(0, 40);
    const h = L.length ? '<table class="scn-tbl"><thead><tr><th>Time</th><th>Channel</th><th>Frequency</th><th>Length</th></tr></thead><tbody>' +
      L.map(e => '<tr data-act="sc-chan" data-f="' + e.f + '" data-mode="' + esc(e.mode || '') + '" class="click"><td>' + RS.clock(e.t) + '</td><td>' + esc(e.label || '-') + '</td><td class="mono">' + RS.fmt(e.f) + '</td><td>' + RS.dur(e.dur) + '</td></tr>').join('') + '</tbody></table>'
      : '<div class="scn-empty"><b>Nothing yet</b><span>Each time the scanner stops on a channel, it is listed here.</span></div>';
    if (el._h !== h) { el._h = h; el.innerHTML = h; }
  };

  // ---------------------------------------------------------------- editing my own lists
  Sc.editor = () => {
    const el = $('#sc-editor'); if (!el) return;
    if (el.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
    const b = bankById(Sc.bankId);
    if (!b) { el.innerHTML = ''; return; }
    let h = '';
    if (b.builtin) h = '<p class="scn-edit-p">"' + esc(shortName(b.name)) + '" is built in, so it can\'t be changed. Make a copy to edit it.</p><div class="row tight"><button class="btn" data-act="sc-copy" type="button">Copy this list</button></div>';
    else {
      h = '<label class="field">List name<input type="text" id="ed-name" value="' + esc(b.name) + '" maxlength="60"></label>' +
        '<div class="scn-add"><label class="field">Frequency (MHz)<input type="text" id="ed-f" inputmode="decimal" placeholder="148.5"></label><label class="field">Name<input type="text" id="ed-l" placeholder="Optional" maxlength="40"></label><label class="field">Type<select id="ed-m"><option value="nfm">Two-way FM</option><option value="am">AM (aircraft)</option><option value="wfm">FM radio</option></select></label><button class="btn primary" data-act="sc-addch" type="button">Add</button></div>' +
        ((b.channels || []).length ? '<table class="scn-tbl"><tbody>' + b.channels.map((c, i) => '<tr><td class="mono">' + RS.fmt(c.f, c.mode) + '</td><td>' + esc(c.label || '') + '</td><td class="muted">' + ((RS.MODES[c.mode] || {}).name || '') + '</td><td class="end"><button class="btn small ghost danger" data-act="sc-delch" data-i="' + i + '" type="button">Remove</button></td></tr>').join('') + '</tbody></table>' : '') +
        '<div class="row tight" style="margin-top:12px"><button class="btn small danger ghost" data-act="sc-delbank" type="button">Delete this list</button></div>';
    }
    if (el._h !== h) { el._h = h; el.innerHTML = h; }
    set($('#sc-edit').querySelector('summary'), b.builtin ? 'Edit a copy of this list' : 'Edit this list');
    const nm = $('#ed-name'); if (nm) nm.onchange = () => saveBank(Object.assign({}, b, { name: nm.value || b.name }));
  };

  // ---------------------------------------------------------------- actions
  // the reply carries every list, so the page never looks for a list it has not heard about yet
  function saveBank(b) { return RS.api('banks', b).then(r => { if (r && Array.isArray(r.banks)) { RS.banks = r.banks; RS.fire('banks'); } return r; }).catch(e => RS.toast(e.message, 'bad')); }
  RS.act['sc-pick'] = b => {
    Sc.bankId = b.dataset.id; RS.store.set('scanbank', Sc.bankId);
    if (RS.st.scan && RS.st.scan.bank !== Sc.bankId) RS.send({ cmd: 'scan', action: 'stop' });
    if (b.closest('.scn-lists-sheet')) RS.closeModal();
    Sc.lists();
  };
  RS.act['sc-start'] = () => {
    const bank = bankById(Sc.bankId); if (!bank) return;
    if (!RS.audio.on) RS.audio.start();
    RS.send({ cmd: 'scan', action: 'start', bank: bank.id, thr: RS.scanThr || bank.thr || 8, record: !!$('#sc-rec').checked });
  };
  RS.act['sc-pause'] = b => { Sc.scope.paused = !Sc.scope.paused; set(b.querySelector('span') || b, Sc.scope.paused ? 'Resume' : 'Pause'); };
  RS.act['sc-nudge'] = b => { const f = RS.vfo(), m = RS.curMode(); RS.tune(f + (+b.dataset.n) * RS.stepFor(m, f), { mode: m }); };
  RS.act['sc-stop'] = () => RS.send({ cmd: 'scan', action: 'stop' });
  RS.act['sc-hold'] = () => RS.send({ cmd: 'scan', action: 'hold', on: !(RS.st.scan && RS.st.scan.hold) });
  RS.act['sc-skip'] = () => RS.send({ cmd: 'scan', action: 'skip' });
  RS.act['sc-lockout'] = () => RS.send({ cmd: 'scan', action: 'lockout' });
  RS.act['sc-unlock'] = () => RS.send({ cmd: 'scan', action: 'unlock_all' });
  RS.act['sc-chan'] = b => {
    const f = parseFloat(b.dataset.f); if (!f) return;
    if (!RS.audio.on) RS.audio.start();
    RS.tune(f, { mode: b.dataset.mode || undefined, bw: parseFloat(b.dataset.bw) || undefined, recenter: true });
    RS.toast('Listening to ' + RS.fmt(f) + '. Go to Radio to adjust.');
  };
  RS.act['sc-new'] = () => { const id = 'my_' + Date.now().toString(36); saveBank({ id: id, name: 'My list', note: '', thr: 8, hang: 3, channels: [], ranges: [] }).then(r => { if (r) { Sc.bankId = id; RS.store.set('scanbank', id); const d = $('#sc-edit'); if (d) d.open = true; Sc.lists(); } }); };
  RS.act['sc-copy'] = () => { const b = bankById(Sc.bankId), id = 'my_' + Date.now().toString(36); saveBank({ id: id, name: 'My copy of ' + shortName(b.name), note: b.note, thr: b.thr, hang: b.hang, channels: b.channels || [], ranges: b.ranges || [] }).then(r => { if (r) { Sc.bankId = id; RS.store.set('scanbank', id); Sc.lists(); } }); };
  RS.act['sc-delbank'] = () => { const b = bankById(Sc.bankId); RS.confirm('Delete "' + b.name + '"?', 'This removes the list. Built-in lists are not affected.', 'Delete', () => { RS.api('banks/delete', { id: b.id }); Sc.bankId = RS.banks[0].id; }); };
  RS.act['sc-addch'] = () => {
    const b = bankById(Sc.bankId), f = RS.parseFreq($('#ed-f').value, 'm');
    if (!f) { RS.toast('Type a frequency in MHz, for example 148.5', 'bad'); return; }
    const mode = $('#ed-m').value;
    saveBank(Object.assign({}, b, { channels: (b.channels || []).concat([{ f: Math.round(f), label: $('#ed-l').value, mode: mode, bw: mode === 'am' ? 12000 : 12500 }]) }));
  };
  RS.act['sc-delch'] = btn => { const b = bankById(Sc.bankId), ch = (b.channels || []).slice(); ch.splice(parseInt(btn.dataset.i), 1); saveBank(Object.assign({}, b, { channels: ch })); };
})();
