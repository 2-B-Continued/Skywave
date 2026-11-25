/* setup.js - first-run setup (language, country, location, units) and the same form in Settings. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$ || (s => document.querySelector(s));
  const esc = RS.esc || (s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  // Every country, grouped by the region entry whose radio settings it shares. Per country: [code, English name,
  // units, FM de-emphasis in µs]. Names and group labels come out in the interface language where the browser can.
  const entries = () => (RS.region && RS.region.list) || [];
  const countryInfo = cc => {
    for (const e of entries()) for (const c of e.countries || []) if (c[0] === cc) return { region: e.id, units: c[2], deemph_us: c[3] };
    return { region: 'intl', units: 'metric', deemph_us: 50 };
  };
  // English names come from the server; the browser supplies the reader's language. A few places read better in their
  // short form (Hong Kong, not Hong Kong SAR China). A browser that has no name for a code hands the code back: use English.
  const english = {}, SHORT = new Set(['HK', 'MO', 'PS']);
  const nameOf = (code, lang) => {
    if (/^\d{3}$/.test(code) && english[code]) { const t = RS.t(english[code]); if (t !== english[code] || lang === 'en') return t; }   // areas: from the language file
    let n = '';
    try { n = new Intl.DisplayNames([lang, 'en'], { type: 'region', style: SHORT.has(code) ? 'short' : 'long' }).of(code) || ''; } catch (e) { }
    return n && n !== code ? n : english[code] || code;
  };
  const listOf = (items, lang) => { try { return new Intl.ListFormat([lang, 'en'], { type: 'conjunction' }).format(items); } catch (e) { return items.join(', '); } };
  // Every country, A to Z in the reader's language, for the searchable country list
  function countryList(lang) {
    const coll = new Intl.Collator([lang, 'en']), out = [];
    Object.assign(english, (RS.region && RS.region.areas) || {});
    for (const e of entries()) for (const c of e.countries || []) { english[c[0]] = c[1]; out.push({ cc: c[0], name: nameOf(c[0], lang), en: c[1] }); }
    return out.sort((a, b) => coll.compare(a.name, b.name));
  }
  // accents and case don't matter when searching ("reunion" finds Réunion, "cote" finds Côte d'Ivoire)
  const fold = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // A text box you can type a country into, with the full A to Z list under it. Typing narrows the list (by its name in
  // your language, its English name or its two-letter code); arrow keys, Enter and Escape work as in any list box.
  function countryPicker(id, lang, onPick) {
    const inp = $('#' + id + '-cq'), list = $('#' + id + '-cl'), val = $('#' + id + '-region');
    let all = countryList(lang), shown = [], act = -1;
    const none = { cc: '', name: RS.t('Not sure'), en: 'Not sure' };
    const nameFor = cc => (all.find(x => x.cc === cc) || none).name;
    const mark = i => {
      const rows = list.querySelectorAll('[role="option"]');
      act = Math.max(0, Math.min(rows.length - 1, i));
      rows.forEach((r, k) => r.setAttribute('aria-selected', String(k === act)));
      if (rows[act]) { inp.setAttribute('aria-activedescendant', rows[act].id); rows[act].scrollIntoView({ block: 'nearest' }); }
    };
    const draw = text => {
      const t = fold(text);
      if (!t) shown = [none].concat(all);
      else {
        // best first: the exact code or name, then names that start with what you typed, then a word in the name that
        // does, then names that contain it anywhere; A to Z within each
        const names = x => [fold(x.name), fold(x.en)];
        const rank = x => x.cc.toLowerCase() === t || names(x).includes(t) ? 0 : names(x).some(h => h.startsWith(t)) ? 1
          : names(x).some(h => h.split(' ').some(w => w.startsWith(t))) ? 2 : names(x).some(h => h.includes(t)) ? 3 : 9;
        shown = all.map(x => [rank(x), x]).filter(r => r[0] < 9).sort((a, b) => a[0] - b[0]).map(r => r[1]);
      }
      list.innerHTML = shown.length ? shown.map((x, i) => '<button type="button" class="locp-row" role="option" tabindex="-1" aria-selected="false" id="' + id + '-co' + i + '" data-i="' + i + '"><span class="locp-t"><b>' + esc(x.name) + '</b>' +
        (x.en && fold(x.en) !== fold(x.name) ? '<small>' + esc(x.en) + '</small>' : '') + '</span>' + (x.cc ? '<span class="locp-cc">' + x.cc + '</span>' : '') + '</button>').join('')
        : '<div class="locp-msg">No country matches "' + esc(text) + '"</div>';
      list.querySelectorAll('[role="option"]').forEach(b => { b.onmousedown = e => { e.preventDefault(); pick(+b.dataset.i); }; b.onmouseenter = () => mark(+b.dataset.i); });
      const cur = shown.findIndex(x => x.cc === val.value);
      act = -1; if (shown.length) mark(t ? 0 : Math.max(0, cur));
    };
    const open = () => { if (!list.hidden) return; list.hidden = false; inp.setAttribute('aria-expanded', 'true'); draw(inp.value === nameFor(val.value) ? '' : inp.value); };
    const close = () => { list.hidden = true; inp.setAttribute('aria-expanded', 'false'); inp.removeAttribute('aria-activedescendant'); inp.value = val.value ? nameFor(val.value) : ''; };
    const pick = i => { const x = shown[i]; if (!x) return; val.value = x.cc; close(); onPick(x.cc); };
    inp.onfocus = () => { inp.select(); open(); };
    inp.onclick = open;
    inp.oninput = () => { if (list.hidden) { list.hidden = false; inp.setAttribute('aria-expanded', 'true'); } draw(inp.value); };
    inp.onblur = () => setTimeout(() => { if (document.activeElement !== inp) close(); }, 120);
    inp.onkeydown = e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(); else mark(act + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (!list.hidden) mark(act - 1); }
      else if (RS.isEnter(e)) { if (!list.hidden && act >= 0) { e.preventDefault(); pick(act); } }
      else if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
    };
    $('#' + id + '-cbtn').onmousedown = e => { e.preventDefault(); if (list.hidden) { inp.focus(); } else close(); };
    return {
      set: cc => { val.value = cc || ''; inp.value = cc ? nameFor(cc) : ''; },
      relabel: l => { all = countryList(l); none.name = RS.t('Not sure'); inp.value = val.value ? nameFor(val.value) : ''; if (!list.hidden) draw(''); }
    };
  }
  // the country a browser's language tag names (en-AU -> AU), when it is one Skywave knows
  const browserCountry = () => { const m = /-([A-Z]{2})\b/.exec(navigator.language || ''); return m && countryInfo(m[1]).region !== 'intl' ? m[1] : ''; };

  const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } };

  function formHtml(id) {
    // each language in its own name, followed by its name in English so any of them can be found
    const enName = code => { try { const n = new Intl.DisplayNames(['en'], { type: 'language' }).of(code); return n && n !== code ? n : ''; } catch (e) { return ''; } };
    const langs = (RS.langs.length ? RS.langs : [{ code: 'en', name: 'English' }]).map(l => { const en = enName(l.code);
      return '<option value="' + esc(l.code) + '">' + esc(l.name) + (en && en.toLowerCase() !== l.name.toLowerCase() ? ' (' + esc(en) + ')' : '') + '</option>'; }).join('');
    return '<label class="field">Language<select id="' + id + '-lang">' + langs + '</select></label>' +
      '<div class="field cpick"><label for="' + id + '-cq">Country or region</label>' +
      '<div class="locp-in cpick-in">' + RS.icon('search') + '<input id="' + id + '-cq" type="text" placeholder="Type to search, or pick from the list" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="' + id + '-cl" aria-autocomplete="list">' +
      '<button type="button" class="cpick-btn" id="' + id + '-cbtn" tabindex="-1" aria-label="Show every country">' + RS.icon('down') + '</button></div>' +
      '<div id="' + id + '-cl" class="locp-res cpick-list" role="listbox" aria-label="Countries" hidden></div><input type="hidden" id="' + id + '-region">' +
      '<span class="hint">Every country, A to Z. This picks the right channel lists (walkie-talkies, CB), FM and AM tuning steps, and the APRS frequency for where you are.</span></div>' +
      '<div class="field locp"><label for="' + id + '-q">Where are you?</label>' +
      '<div class="locp-now" id="' + id + '-picked" aria-live="polite"></div>' +
      '<div class="locp-bar"><span class="locp-in">' + RS.icon('search') + '<input id="' + id + '-q" type="search" placeholder="Town, suburb or postcode" autocomplete="off" enterkeyhint="search" role="combobox" aria-expanded="false" aria-controls="' + id + '-res" aria-autocomplete="list"></span>' +
      '<button class="btn primary" type="button" id="' + id + '-find">Search</button></div>' +
      '<div id="' + id + '-res" class="locp-res" role="listbox" aria-label="Places found" hidden></div>' +
      '<span class="hint">For the plane map, satellite passes and distances. Try a town, a postcode, or a town with its state. Only places in your chosen country are shown, unless you type another country. Only the words you type are sent, to Open-Meteo and OpenStreetMap.</span></div>' +
      '<details class="more"><summary>Enter coordinates by hand</summary><div class="row tight" style="margin-top:8px"><label class="field" style="flex:1">Latitude<input id="' + id + '-lat" inputmode="decimal" placeholder="e.g. 51.5074"></label><label class="field" style="flex:1">Longitude<input id="' + id + '-lon" inputmode="decimal" placeholder="e.g. -0.1278"></label><label class="field" style="flex:1">Height above sea level (m)<input id="' + id + '-alt" inputmode="decimal" placeholder="0"></label></div></details>' +
      '<div class="field"><label>Units</label><div class="seg locp-units" role="group" aria-label="Units"><button type="button" data-u="metric" id="' + id + '-um">Metric: km, °C</button><button type="button" data-u="imperial" id="' + id + '-ui">Imperial: miles, °F</button></div></div>' +
      '<div class="small muted" id="' + id + '-tz"></div>';
  }

  function wire(id, init) {
    const st = { lat: init.lat, lon: init.lon, alt: init.alt, tz: init.tz || browserTz(), country: init.country || '', lang: init.lang, units: init.units, placed: !!init.placed, place: init.place || '' };
    const q = s => $('#' + id + '-' + s);
    q('lang').value = st.lang;
    const units = () => ['um', 'ui'].forEach(k => q(k).setAttribute('aria-pressed', String(q(k).dataset.u === st.units)));
    ['um', 'ui'].forEach(k => q(k).onclick = () => { st.units = q(k).dataset.u; init.unitsTouched = true; units(); });
    units();
    q('lat').value = st.placed ? st.lat : ''; q('lon').value = st.placed ? st.lon : ''; q('alt').value = st.placed ? st.alt : '';
    const showPicked = () => {
      const ll = (+st.lat).toFixed(3) + ', ' + (+st.lon).toFixed(3);
      q('picked').innerHTML = st.placed ? RS.icon('check') + '<span><b>' + esc(st.place || 'Your location') + '</b><small>' + ll + (st.tz ? ' \u00b7 ' + esc(st.tz.replace(/_/g, ' ')) : '') + '</small></span>'
        : '<span><b>No location yet</b><small>Planes and satellite passes need one</small></span>';
      q('picked').classList.toggle('set', !!st.placed);
      q('tz').textContent = 'Time zone: ' + (st.tz || 'this device\'s own');
    };
    showPicked();
    q('lang').onchange = async e => {
      st.lang = e.target.value; await RS.setLang(st.lang, true);
      cp.relabel(st.lang);
    };
    const chosen = cc => { st.country = cc; if (!init.unitsTouched) { st.units = countryInfo(cc).units; units(); } };
    const cp = countryPicker(id, st.lang || RS.lang || 'en', chosen);
    cp.set(st.country);
    const setCountry = cc => { cp.set(cc); chosen(cc); };
    ['lat', 'lon', 'alt'].forEach(k => q(k).oninput = () => { const la = parseFloat(q('lat').value), lo = parseFloat(q('lon').value); if (!isNaN(la) && !isNaN(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) { st.lat = la; st.lon = lo; st.alt = parseFloat(q('alt').value) || 0; st.placed = true; st.place = ''; showPicked(); } });
    let found = [], act = -1;
    const res = q('res'), inp = q('q');
    const close = () => { res.hidden = true; res.innerHTML = ''; inp.setAttribute('aria-expanded', 'false'); inp.removeAttribute('aria-activedescendant'); act = -1; };
    const mark = i => {
      const rows = res.querySelectorAll('.locp-row'); if (!rows.length) return;
      act = (i + rows.length) % rows.length;
      rows.forEach((r, k) => r.setAttribute('aria-selected', String(k === act)));
      inp.setAttribute('aria-activedescendant', rows[act].id); rows[act].scrollIntoView({ block: 'nearest' });
    };
    const pick = i => {
      const x = found[i]; if (!x) return;
      Object.assign(st, { lat: x.lat, lon: x.lon, alt: x.alt || 0, placed: true, cc: x.cc || '', place: [x.name, x.admin || x.country].filter(Boolean).join(', ') });
      if (x.tz) st.tz = x.tz;
      if (x.cc && countryInfo(x.cc).region !== 'intl') setCountry(x.cc);
      q('lat').value = st.lat; q('lon').value = st.lon; q('alt').value = st.alt; close(); inp.value = ''; showPicked();
    };
    // suggest: the lookup made while typing (lighter, and quiet when it finds nothing); otherwise the full search from
    // Enter or the Search button. Only the newest answer is shown, so a slow reply never replaces a newer one.
    let seq = 0;
    const search = async suggest => {
      const t = inp.value.trim(); if (t.length < (suggest ? 3 : 2)) return;
      const my = ++seq;
      res.hidden = false; res.setAttribute('aria-busy', 'true');
      if (!suggest || !found.length) res.innerHTML = '<div class="locp-msg">Searching</div>';
      let r; try { r = await RS.api('geocode?q=' + encodeURIComponent(t) + '&region=' + encodeURIComponent(st.country || '') + (suggest ? '&suggest=1' : '')); } catch (e) { r = { results: [], error: 'The computer running Skywave could not reach the place search. Check it is online, or enter coordinates by hand below.' }; }
      if (my !== seq || inp.value.trim() !== t) return;
      res.removeAttribute('aria-busy'); act = -1; inp.removeAttribute('aria-activedescendant');
      found = (r && r.results) || [];
      if (!found.length) {
        if (suggest && !(r && r.error)) { res.innerHTML = '<div class="locp-msg">No suggestions yet. Keep typing, or press Enter to search everywhere.</div>'; return; }
        res.innerHTML = '<div class="locp-msg">' + esc((r && r.error) || 'Nothing matched "' + t + '". Try just the town, or add the state or country.') + '</div>'; return;
      }
      res.innerHTML = found.map((x, i) => {
        const where = [x.area && x.area !== x.name ? x.area : '', x.admin, x.postcode, x.country].filter(Boolean).join(', ');
        return '<button type="button" class="locp-row" role="option" aria-selected="false" id="' + id + '-opt' + i + '" data-i="' + i + '"><span class="locp-t"><b>' + esc(x.name) + '</b><small>' + esc(where) + '</small></span>' + (x.cc ? '<span class="locp-cc">' + esc(x.cc) + '</span>' : '') + '</button>';
      }).join('');
      inp.setAttribute('aria-expanded', 'true');
      res.querySelectorAll('.locp-row').forEach(b => { b.onclick = () => pick(+b.dataset.i); b.onmouseenter = () => mark(+b.dataset.i); });
    };
    inp.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' && !res.hidden) { e.preventDefault(); mark(act + 1); }
      else if (e.key === 'ArrowUp' && !res.hidden) { e.preventDefault(); mark(act - 1); }
      else if (e.key === 'Escape' && !res.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
    });
    q('find').onclick = () => { clearTimeout(inp._sg); search(false); };
    inp.onkeydown = e => { if (RS.isEnter(e)) { e.preventDefault(); clearTimeout(inp._sg); if (act >= 0 && !res.hidden) pick(act); else search(false); } };
    // suggestions as you type, once you pause for a moment
    inp.addEventListener('input', () => {
      clearTimeout(inp._sg);
      if (inp.value.trim().length < 3) { seq++; found = []; close(); return; }
      inp._sg = setTimeout(() => search(true), 350);
    });
    return () => ({ lang: q('lang').value, country: st.country, region: st.country ? countryInfo(st.country).region : 'intl', lat: st.placed ? st.lat : 0, lon: st.placed ? st.lon : 0, alt: st.alt || 0, units: st.units, tz: st.tz, placed: st.placed, cc: st.cc || '' });
  }

  function save(v, extra) {
    const ch = Object.assign({ lang: v.lang, region: v.region, country: v.country, units: v.units, tz: v.tz || '', deemph_us: countryInfo(v.country).deemph_us || 50 }, extra || {});
    if (v.placed) { ch.lat = v.lat; ch.lon = v.lon; ch.alt = v.alt; }
    RS.store.set('lang', v.lang); RS.store.set('placed', v.placed || RS.store.get('placed', false));
    return RS.api('config', { changes: ch });
  }

  RS.setupWizard = () => {
    const country = (RS.cfg && RS.cfg.country) || browserCountry();
    const unitsDefault = country ? countryInfo(country).units : 'metric';
    const m = RS.modal('<h2>Welcome to Skywave</h2><p class="muted">Two minutes of setup so the right channels, distances and times show up for you. You can change all of this later in Settings.</p><div id="sw-look" class="look-box"></div>' + formHtml('sw') +
      '<div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" type="button" id="sw-skip">Skip for now</button><button class="btn primary" type="button" id="sw-ok">Save and start</button></div>');
    if (RS.mountLook) RS.mountLook($('#sw-look'));
    const get = wire('sw', { lat: 0, lon: 0, alt: 0, tz: browserTz(), country, lang: RS.store.get('lang', null) || RS.browserLang(), units: unitsDefault });
    const sel = $('#sw-lang'); if (![...sel.options].some(o => o.value === sel.value)) sel.value = 'en';
    $('#sw-ok').onclick = async () => { await save(get(), { setup_done: true }); RS.closeModal(); RS.toast('All set. You can change this any time in Settings.'); };
    $('#sw-skip').onclick = async () => { await RS.api('config', { changes: { setup_done: true, tz: browserTz() } }); RS.closeModal(); };
  };
  RS.on('hello', () => { if (RS.cfg && RS.cfg.setup_done === false && !RS._wizardShown) { RS._wizardShown = true; setTimeout(() => RS.setupWizard(), 300); } });

  // ---------------------------------------------------------------- the same form in Settings
  RS.mountLocationCard = el => {
    const c = RS.cfg || {};
    el.innerHTML = '<h3>Language, region and location</h3><div class="sub">Set during first-run setup. Change them here whenever you move or travel.</div>' + formHtml('sl') +
      '<div class="row" style="margin-top:10px"><button class="btn primary" type="button" id="sl-save">Save</button></div>';
    const placed = !!(c.lat || c.lon);
    const get = wire('sl', { lat: c.lat, lon: c.lon, alt: c.alt, tz: c.tz || browserTz(), country: c.country || ((entries().find(e => e.id === c.region) || {}).countries || []).map(x => x[0]).filter((x, i, a) => a.length === 1)[0] || '', lang: RS.store.get('lang', null) || c.lang || 'en', units: c.units || 'metric', placed, unitsTouched: true });
    $('#sl-save').onclick = async () => { await save(get()); RS.toast('Saved.'); RS.fire('home-refresh'); };
  };
})();
