/* themes.js - colour themes and a fully custom editor.
   Every theme is a short list of base colours; the rest are derived and contrast-checked (WCAG) so text stays readable. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc;
  // base colours: bg (page), panel, ink (text), accent (buttons/links), signal (live readout), glass (dial window)
  const T = [
    { id: '', name: 'Match my device', note: 'Light or dark, whichever your device uses', sys: true },
    { id: 'light', name: 'Light', dark: false, sys: true, c: { bg: '#e3e8ea', panel: '#f6f8f8', ink: '#15252d', accent: '#0d6e7b', signal: '#ffb52e', glass: '#0c1a21' } },
    { id: 'dark', name: 'Dark', dark: true, sys: true, c: { bg: '#0e171c', panel: '#16232a', ink: '#e5edf0', accent: '#4cc0cf', signal: '#ffb52e', glass: '#091419' } },
    { id: 'porcelain', name: 'Porcelain', dark: false, c: { bg: '#f2f2f7', panel: '#ffffff', ink: '#1c1c1e', accent: '#0a66d9', signal: '#ff9f0a', glass: '#1c1c1e' }, note: 'Clean and light' },
    { id: 'graphite', name: 'Graphite', dark: true, c: { bg: '#1c1c1e', panel: '#2c2c2e', ink: '#f2f2f7', accent: '#64a8ff', signal: '#ffb340', glass: '#121214' }, note: 'Neutral and dark' },
    { id: 'midnight', name: 'Midnight', dark: true, c: { bg: '#0b1020', panel: '#141b30', ink: '#e6eaf5', accent: '#7aa2ff', signal: '#ffc857', glass: '#070a16' }, note: 'Deep navy' },
    { id: 'arctic', name: 'Arctic', dark: true, c: { bg: '#2e3440', panel: '#3b4252', ink: '#e5e9f0', accent: '#88c0d0', signal: '#ebcb8b', glass: '#242933' }, note: 'Arctic blue-grey' },
    { id: 'frost', name: 'Frost', dark: false, c: { bg: '#e5e9f0', panel: '#eceff4', ink: '#2e3440', accent: '#3b6f94', signal: '#c9962b', glass: '#2e3440' }, note: 'Arctic, light' },
    { id: 'dune-light', name: 'Dune Light', dark: false, c: { bg: '#eee8d5', panel: '#fdf6e3', ink: '#3d4f55', accent: '#1f6f99', signal: '#cb4b16', glass: '#073642' } },
    { id: 'dune-dark', name: 'Dune Dark', dark: true, c: { bg: '#00212b', panel: '#073642', ink: '#d5dcd9', accent: '#4fa6d6', signal: '#e0a21a', glass: '#001a22' } },
    { id: 'nightshade', name: 'Nightshade', dark: true, c: { bg: '#21222c', panel: '#282a36', ink: '#f8f8f2', accent: '#bd93f9', signal: '#f1fa8c', glass: '#191a21' } },
    { id: 'autumn', name: 'Autumn', dark: true, c: { bg: '#282828', panel: '#3c3836', ink: '#ebdbb2', accent: '#8ec07c', signal: '#fabd2f', glass: '#1d2021' }, note: 'Warm retro' },
    { id: 'mocha', name: 'Mocha', dark: true, c: { bg: '#181825', panel: '#1e1e2e', ink: '#cdd6f4', accent: '#89b4fa', signal: '#f9e2af', glass: '#11111b' } },
    { id: 'latte', name: 'Latte', dark: false, c: { bg: '#e6e9ef', panel: '#eff1f5', ink: '#4c4f69', accent: '#1e66f5', signal: '#df8e1d', glass: '#4c4f69' } },
    { id: 'dusk', name: 'Dusk', dark: true, c: { bg: '#16161e', panel: '#1a1b26', ink: '#c0caf5', accent: '#7aa2f7', signal: '#e0af68', glass: '#13131a' } },
    { id: 'slate', name: 'Slate', dark: true, c: { bg: '#21252b', panel: '#282c34', ink: '#abb2bf', accent: '#61afef', signal: '#e5c07b', glass: '#1b1e23' } },
    { id: 'rosewood', name: 'Rosewood', dark: true, c: { bg: '#191724', panel: '#1f1d2e', ink: '#e0def4', accent: '#9ccfd8', signal: '#f6c177', glass: '#14121f' } },
    { id: 'rosewood-light', name: 'Rosewood Light', dark: false, c: { bg: '#f2e9e1', panel: '#faf4ed', ink: '#575279', accent: '#286983', signal: '#b4637a', glass: '#575279' } },
    { id: 'forest', name: 'Forest', dark: true, c: { bg: '#0f1a14', panel: '#17261d', ink: '#e3efe6', accent: '#6fcf97', signal: '#f2c94c', glass: '#0a120d' } },
    { id: 'amber-crt', name: 'Amber Terminal', dark: true, c: { bg: '#120d05', panel: '#1b140a', ink: '#f3dfb5', accent: '#ffb000', signal: '#ff8c1a', glass: '#0b0803' }, note: 'Old-school radio shack' },
    { id: 'neon', name: 'Neon Grid', dark: true, c: { bg: '#070707', panel: '#111111', ink: '#ececec', accent: '#f5e90a', signal: '#ff3355', glass: '#030303', hot: '#19e3ff' }, note: 'Pure black with acid yellow, red and cyan. Made for the Skywave style' },
    { id: 'ember', name: 'Ember', dark: true, c: { bg: '#090707', panel: '#141010', ink: '#f3e9e4', accent: '#ff5a36', signal: '#ffd21f', glass: '#070405', hot: '#2ee6d6' }, note: 'Black with orange-red and teal' },
    { id: 'phosphor', name: 'Green Phosphor', dark: true, c: { bg: '#050805', panel: '#0b120c', ink: '#c8f2cf', accent: '#3dff7a', signal: '#f5d547', glass: '#030805', hot: '#ff4f8b' }, note: 'Green on black, like a monitor from 1985' },
    { id: 'chrome', name: 'Chrome', dark: false, c: { bg: '#d8d8d6', panel: '#ececea', ink: '#0b0b0b', accent: '#7a5d00', signal: '#b3003b', glass: '#0b0b0b', hot: '#d6004c' }, note: 'Cool light grey, for daytime' },
    { id: 'obsidian', name: 'Obsidian Gold', dark: true, c: { bg: '#0b0a09', panel: '#151311', ink: '#f1ebdf', accent: '#d6ad45', signal: '#f4d77a', glass: '#070605', hot: '#c9892b' }, note: 'Black stone with brushed gold. Quiet luxury' },
    { id: 'swiss', name: 'Swiss Red', dark: false, c: { bg: '#efefef', panel: '#ffffff', ink: '#101010', accent: '#d7261e', signal: '#ff4a3d', glass: '#141414', hot: '#d7261e' }, note: 'White paper, black type, one red. Graphic design studio' },
    { id: 'violet', name: 'Royal Violet', dark: true, c: { bg: '#0e0913', panel: '#1a1223', ink: '#f0e9f8', accent: '#b784ff', signal: '#ff7ad1', glass: '#080510', hot: '#6ff0cf' }, note: 'Aubergine with violet, magenta and mint' },
    { id: 'clay', name: 'Clay', dark: false, c: { bg: '#e3e8ef', panel: '#e3e8ef', ink: '#262f3d', accent: '#4459d6', signal: '#f07b2f', glass: '#1d2430', hot: '#f07b2f' }, note: 'One soft blue-grey for every surface. Made for the Relief style' },
    { id: 'carnival', name: 'Carnival', dark: false, c: { bg: '#fff0d4', panel: '#fffaf0', ink: '#1d0b33', accent: '#d4006f', signal: '#ffaa00', glass: '#1d0b33', hot: '#00a39b' }, note: 'Cream with magenta, saffron and teal. Made for the Riot style' },
    { id: 'mint', name: 'Mint Studio', dark: false, c: { bg: '#e3efe9', panel: '#f8fcfa', ink: '#0f2a20', accent: '#087f58', signal: '#e2492a', glass: '#0f2a20', hot: '#e2492a' }, note: 'Fresh pale green and deep emerald, for daytime' },
    { id: 'contrast', name: 'High contrast', dark: true, c: { bg: '#000000', panel: '#0d0d0d', ink: '#ffffff', accent: '#4dd2ff', signal: '#ffd400', glass: '#000000' }, note: 'Maximum legibility' },
  ];
  const byId = Object.fromEntries(T.map(t => [t.id, t]));
  // ---- style: the shape of everything (corners, frames, type). Colour themes sit on top of it.
  const STYLES = [
    { id: 'skywave', name: 'Skywave', theme: 'forest', note: 'Frosted glass: capsule controls and soft panes over a colour field whose hue follows the band you tune. Best with Forest.' },
    { id: 'depth', name: 'Depth', theme: 'midnight', note: 'Windows in a room: frosted panes float at different depths, lift toward you under the pointer, and the pages sit beside a floating column of tabs. Best with Midnight.' },
    { id: 'relief', name: 'Relief', theme: 'clay', note: 'Soft relief: everything is pressed out of one smooth surface, lit from the top left. Buttons rise, and sink in when chosen. Best with Clay.' },
    { id: 'walnut', name: 'Walnut', theme: 'autumn', note: 'The home receiver: walnut cheeks, brushed aluminium, a backlit glass dial, knurled knobs and keys that travel. Always dark: light palettes switch to Autumn.' },
    { id: 'riot', name: 'Riot', theme: 'carnival', note: 'More is more: clashing patterns, three colours at once, oversized mixed type, sticker labels and stacked shadows. Best with Carnival.' },
    { id: 'bento', name: 'Bento', theme: 'porcelain', note: 'The toy box: chunky pastel blocks, pill buttons that press down, giant rounded numbers. Best with Porcelain.' },
    { id: 'folio', name: 'Folio', theme: 'swiss', note: 'The broadsheet: a masthead and numbered index, enormous serif headlines, rules instead of boxes. Best with Swiss Red.' },
    { id: 'terminal', name: 'Terminal', theme: 'neon', note: 'The tty: monospace everything, framed panes with their names in the border, numbered windows. Always dark: light palettes switch to Neon Grid.' },
    { id: 'brut', name: 'Brut', theme: 'chrome', note: 'The poster: thick ink, blocks that share borders, giant capitals and hard shadows. Best with Chrome.' },
    { id: 'ticket', name: 'Ticket', theme: 'mint', note: 'The boarding pass: notched paper stubs, ink stamps and a barcode on the instrument. Best with Mint Studio.' },
  ];
  RS.styleId = () => { const l = RS.store.get('styleid', undefined); const p = (RS.prefs && RS.prefs.style); let v = l != null ? l : (p || 'skywave');
    return STYLES.some(x => x.id === v) ? v : 'skywave'; };
  const CUSTOM_FIELDS = [['bg', 'Page background'], ['panel', 'Cards and panels'], ['ink', 'Text'], ['accent', 'Buttons and links'], ['signal', 'Live frequency and needle'], ['glass', 'Dial and scope window'], ['good', 'Good (green)'], ['warn', 'Warning (amber)'], ['bad', 'Problem (red)']];
  const CUSTOM_DEFAULT = { bg: '#1c1c1e', panel: '#2c2c2e', ink: '#f2f2f7', accent: '#64a8ff', signal: '#ffb340', glass: '#121214', good: '', warn: '', bad: '', dark: true };

  // ---- colour maths
  const hex = h => { h = String(h).replace('#', ''); if (h.length === 3) h = h.replace(/./g, '$&$&'); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const toHex = a => '#' + a.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => { const x = hex(a), y = hex(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lum = h => { const [r, g, b] = hex(h).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return .2126 * r + .7152 * g + .0722 * b; };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + .05) / (lo + .05); };
  RS.contrast = ratio;
  // nudge fg toward white or black (whichever helps) until it reaches `min` against bg
  const ensure = (fg, bg, min) => { const toward = lum(bg) > .4 ? '#000000' : '#ffffff'; let c = fg, i = 0; while (ratio(c, bg) < min && i++ < 40) c = mix(c, toward, .08); return c; };
  const best = bg => ratio('#ffffff', bg) >= ratio('#000000', bg) ? '#ffffff' : '#000000';

  function derive(c, dark, sw) {
    const bg = c.bg, panel = c.panel;
    const line = mix(panel, c.ink, sw ? (dark ? .5 : .55) : (dark ? .16 : .17)), panel2 = mix(panel, bg, .5) === panel ? mix(panel, c.ink, .04) : mix(panel, c.ink, dark ? .05 : .04);
    const good = ensure(c.good || (dark ? '#52c28c' : '#1f7d52'), panel, 4.5), warn = ensure(c.warn || (dark ? '#e3a642' : '#a96a05'), panel, 4.5), bad = ensure(c.bad || (dark ? '#ee7469' : '#bb3429'), panel, 4.5);
    const teal = ensure(c.accent, panel, 4.5);
    const ink = ensure(c.ink, panel, 7), ink2 = ensure(ensure(mix(c.ink, panel, .26), panel, 6), bg, 6), ink3 = ensure(ensure(mix(c.ink, panel, .42), panel, 5.1), bg, 5.1);
    const glass = c.glass, gl = mix(glass, '#ffffff', .07);
    return {
      '--chassis': bg, '--panel': panel, '--panel-2': panel2, '--line': line, '--ink': ink, '--ink-2': ink2, '--ink-3': ink3,
      '--teal': teal, '--teal-hi': mix(teal, dark ? '#ffffff' : '#000000', .2), '--on-teal': best(teal),
      '--glass': glass, '--glass-2': gl, '--glass-line': mix(glass, '#ffffff', .16), '--glass-ink': ensure(mix('#ffffff', glass, .25), glass, 7),
      '--amber': c.signal, '--hot-c': c.hot || c.signal, '--amber-soft': c.signal + '33',
      '--good': good, '--warn': warn, '--bad': bad,
      '--good-bg': mix(panel, good, .16), '--warn-bg': mix(panel, warn, .16), '--bad-bg': mix(panel, bad, .16), '--info-bg': mix(panel, teal, .14),
    };
  }
  const ALL = Object.keys(derive(T[3].c, false));
  const root = document.documentElement;
  function clear() { ALL.forEach(k => root.style.removeProperty(k)); }

  RS.themeState = () => {
    const local = RS.store.get('themeid', undefined), p = (RS.prefs && RS.prefs.theme) || {};
    return { id: local !== undefined && local !== null ? local : (p.id || ''), custom: Object.assign({}, CUSTOM_DEFAULT, (RS.prefs && RS.prefs.custom_theme) || {}) };
  };
  // The top bar's two sides are made equally wide (the wider of the logo and the controls), so the tabs between them sit
  // in the true centre of the screen.
  RS.topSides = () => {
    const b = document.querySelector('.topbar > .brand'), t = document.querySelector('.topbar > .top-right'); if (!b || !t) return;
    root.style.removeProperty('--top-side');
    const w = Math.ceil(Math.max(b.scrollWidth, t.scrollWidth));
    if (w) root.style.setProperty('--top-side', w + 'px');
    if (RS.fitTabs) RS.fitTabs();
  };
  window.addEventListener('resize', () => requestAnimationFrame(RS.topSides));
  try { const ro = new ResizeObserver(() => { const t = document.querySelector('.topbar > .top-right'); if (t && Math.abs(t.scrollWidth - (RS._tsW || 0)) > 1) { RS._tsW = t.scrollWidth; requestAnimationFrame(RS.topSides); } });
    const watch = () => { const t = document.querySelector('.topbar > .top-right'); if (t) ro.observe(t); else setTimeout(watch, 200); }; watch(); } catch (e) { }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => RS.topSides && RS.topSides());
  RS.applyTheme = () => {
    const st = RS.themeState(); clear();
    const sty = RS.styleId(), sw = sty === 'terminal';
    root.dataset.style = sty; RS.store.set('style', sty);
    if (RS.fitTabs) setTimeout(RS.fitTabs, 60);
    // Terminal (a CRT) and Walnut (a backlit glass dial with lamp-lit readouts) are drawn dark. A light palette there would
    // wash the readouts out, so each uses its own dark palette instead whenever the chosen one is light.
    const DARK_ONLY = { terminal: 'neon', walnut: 'autumn' };
    const pick = byId[st.id] || byId[''], devDark = matchMedia('(prefers-color-scheme: dark)').matches;
    const light = st.id === 'custom' ? !st.custom.dark : pick.sys ? (pick.id === 'light' || (pick.id === '' && !devDark)) : !pick.dark;
    RS.darkOnly = DARK_ONLY[sty] ? byId[DARK_ONLY[sty]].name : null;
    if (DARK_ONLY[sty] && light) {
      const t = byId[DARK_ONLY[sty]];
      root.setAttribute('data-theme', 'dark'); const v = derive(t.c, true, sw); Object.keys(v).forEach(k => root.style.setProperty(k, v[k])); root.dataset.palette = t.id;
    } else if (st.id === 'custom') {
      const c = st.custom; root.setAttribute('data-theme', c.dark ? 'dark' : 'light'); const v = derive(c, !!c.dark, sw); Object.keys(v).forEach(k => root.style.setProperty(k, v[k])); root.dataset.palette = 'custom';
    } else {
      const t = byId[st.id] || byId[''];
      delete root.dataset.palette;
      if (t.sys) { if (t.id) root.setAttribute('data-theme', t.id); else root.removeAttribute('data-theme'); }
      else { root.setAttribute('data-theme', t.dark ? 'dark' : 'light'); const v = derive(t.c, t.dark, sw && !t.sys); Object.keys(v).forEach(k => root.style.setProperty(k, v[k])); root.dataset.palette = t.id; }
    }
    RS.store.set('theme', root.getAttribute('data-theme'));
    requestAnimationFrame(RS.topSides);
    try { const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = getComputedStyle(root).getPropertyValue('--chassis'); } catch (e) { }
    RS.fire('theme');
  };
  RS.setStyle = id => { RS.store.set('styleid', id); RS.setPref('style', id); RS.applyTheme(); };
  try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => RS.applyTheme()); } catch (e) { }
  RS.setTheme = t => { RS.store.set('themeid', t || ''); RS.setPref('theme', { id: t || '' }); RS.applyTheme(); };
  RS.applyTheme();
  RS.on('hello', RS.applyTheme); RS.on('prefs-applied', RS.applyTheme);

  // ---- settings card
  const swatch = t => {
    const c = t.c || (t.id === '' ? { bg: '#e3e8ea', panel: '#0e171c', ink: '#15252d', accent: '#0d6e7b', signal: '#ffb52e' } : null);
    return '<span class="th-sw" aria-hidden="true" style="background:' + c.bg + '"><i style="background:' + c.panel + '"></i><i style="background:' + c.accent + '"></i><i style="background:' + c.signal + '"></i></span>';
  };
  RS.mountThemes = el => {
    const st = RS.themeState();
    const card = t => '<button type="button" class="th-card" data-act="th-pick" data-id="' + t.id + '" aria-pressed="' + (st.id === t.id) + '">' + swatch(t) + '<b>' + esc(t.name) + '</b>' + (t.note ? '<span>' + esc(t.note) + '</span>' : '') + '</button>';
    const cc = st.custom;
    const sid = RS.styleId();
    const sty = STYLES.map(x => '<button type="button" class="th-card" data-act="sty-pick" data-id="' + x.id + '" aria-pressed="' + (sid === x.id) + '"><b>' + esc(x.name) + '</b><span>' + esc(x.note) + '</span></button>').join('');
    el.innerHTML = '<h3>Style</h3><div class="sub">The shape of everything: corners, frames and type. Colours are chosen separately below.</div><div class="th-grid" style="margin-bottom:20px">' + sty + '</div><h3>Colours</h3><div class="sub">Pick the colours. Text colours are checked automatically so everything stays easy to read.</div><div class="th-grid">' + T.map(card).join('') +
      '<button type="button" class="th-card" data-act="th-pick" data-id="custom" aria-pressed="' + (st.id === 'custom') + '"><span class="th-sw" aria-hidden="true" style="background:linear-gradient(90deg,#f66,#fc4,#6c6,#4bf,#a6f)"></span><b>Custom</b><span>Choose every colour yourself</span></button></div>' +
      '<div id="th-custom" class="' + (st.id === 'custom' ? '' : 'hide') + '"><h4 style="margin:16px 0 4px">Your colours</h4><div class="th-fields">' +
      CUSTOM_FIELDS.map(f => { const k = f[0], v = cc[k] || (k === 'good' ? '#52c28c' : k === 'warn' ? '#e3a642' : k === 'bad' ? '#ee7469' : '#888888'); return '<label class="th-f"><input type="color" data-k="' + k + '" value="' + v + '"><span>' + esc(f[1]) + '</span></label>'; }).join('') + '</div>' +
      '<div class="row tight" style="margin-top:10px"><label class="check"><input type="checkbox" id="th-dark" ' + (cc.dark ? 'checked' : '') + '><span>This is a dark theme</span></label><button class="btn small" type="button" data-act="th-copy">Start from the current theme</button><span class="small" id="th-warn" role="status"></span></div></div>';
    const upd = () => { const c = Object.assign({}, RS.themeState().custom); el.querySelectorAll('input[type=color]').forEach(i => c[i.dataset.k] = i.value); c.dark = $('#th-dark').checked; RS.setPref('custom_theme', c); RS.applyTheme(); warn(c); };
    const warn = c => { const r = ratio(c.ink, c.panel); $('#th-warn').textContent = r < 4.5 ? 'Text may be hard to read on these panels (contrast ' + r.toFixed(1) + ':1). It will be adjusted automatically.' : 'Text contrast ' + r.toFixed(1) + ':1: good.'; };
    el.querySelectorAll('input[type=color]').forEach(i => i.oninput = upd); $('#th-dark').onchange = upd; warn(cc);
  };
  // compact picker for first-run setup: style + colour theme, applied as you tap
  RS.mountLook = el => {
    const st = RS.themeState(), sid = RS.styleId();
    const eff = st.id === '' ? 'neon' : st.id;
    const card = t => '<button type="button" class="th-card" data-act="th-pick" data-id="' + t.id + '" aria-pressed="' + (eff === t.id) + '">' + swatch(t) + '<b>' + esc(t.name) + '</b></button>';
    el.innerHTML = '<h3 style="margin:0 0 4px">Look</h3><div class="small muted">Pick a style and a colour theme. They change right away, and you can change them later in Settings.</div>' +
      '<div class="th-grid">' + STYLES.map(x => '<button type="button" class="th-card" data-act="sty-pick" data-id="' + x.id + '" aria-pressed="' + (sid === x.id) + '"><b>' + esc(x.name) + '</b><span>' + esc(x.note) + '</span></button>').join('') + '</div>' +
      '<div class="th-grid look-themes">' + T.filter(t => t.c && !t.sys).map(card).join('') + '</div>';
  };
  const remount = () => { if ($('#st-themes')) RS.mountThemes($('#st-themes')); if ($('#sw-look')) RS.mountLook($('#sw-look')); };
  RS.act['sty-pick'] = b => { RS.setStyle(b.dataset.id); if ($('#sw-look')) { const x = STYLES.find(y => y.id === b.dataset.id); if (x && x.theme != null) RS.setTheme(x.theme); } remount(); };
  RS.act['th-pick'] = b => { RS.setTheme(b.dataset.id); remount(); };
  RS.act['th-copy'] = () => {
    const cs = getComputedStyle(root), g = n => { const v = cs.getPropertyValue(n).trim(); return /^#[0-9a-f]{6}$/i.test(v) ? v : toHex(hex(v.startsWith('#') ? v : '#888888')); };
    const c = { bg: g('--chassis'), panel: g('--panel'), ink: g('--ink'), accent: g('--teal'), signal: g('--amber'), glass: g('--glass'), good: g('--good'), warn: g('--warn'), bad: g('--bad'), dark: root.getAttribute('data-theme') === 'dark' };
    RS.setPref('custom_theme', c); RS.store.set('themeid', 'custom'); RS.setPref('theme', { id: 'custom' }); RS.applyTheme(); RS.mountThemes($('#st-themes'));
  };
})();
