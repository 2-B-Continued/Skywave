/* Skywave - antenna setup guide: best dipole (or wire) setup for each section, plus a calculator. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc;
  const VF = 71.2;   // metres x MHz: one rod of a dipole = a quarter wave, shortened ~5% for a real rod

  const len = mhz => VF / mhz;                                  // metres, one rod
  const fmtLen = m => m < 1 ? (m * 100).toFixed(m < 0.2 ? 1 : 0) + ' cm' : m.toFixed(2) + ' m';
  const ROD_MAX = 1.0;                                          // many telescopic kits stop around 1 m; check yours

  // shape: vert = vertical dipole, vee = flat V-dipole facing the sky, wire = long wire + 9:1 balun
  const SETUPS = {
    fm: { title: 'FM radio', mhz: 98, shape: 'vert', band: '87.5 to 108 MHz',
      why: 'FM stations are strong, so almost anything works. A properly sized pair of rods just makes it cleaner.',
      tips: ['Set both rods to the length shown and stand them straight up and down (vertical).', 'Near a window is plenty. If music sounds crackly or you hear several stations at once, lower the tuner gain in Settings.'] },
    am: { title: 'AM radio (531 to 1701 kHz)', mhz: 1, shape: 'wire', band: '0.5 to 1.7 MHz', wire: '5 to 20 m of wire',
      why: 'The radio waves are 200 to 600 metres long, so a rod antenna cannot be the right size. A wire does much better.',
      tips: ['Run 5 to 20 metres of thin wire around a room or along a balcony, connected through a 9:1 balun (a small box made for this).', 'Local AM stations are strong, so even a few metres works. Keep the wire away from power cables and chargers.', 'Needs a dongle that can tune this low. A V4 can. Older ones use "direct sampling", which Skywave switches on automatically.'] },
    sw: { title: 'Shortwave (3 to 30 MHz)', mhz: 7, shape: 'wire', band: '3 to 30 MHz', wire: '10 to 20 m of wire',
      why: 'Shortwave waves are 10 to 100 metres long. A full-size dipole would be huge, so use a long wire instead.',
      tips: ['10 to 20 metres of wire with a 9:1 balun works on every band at once. Longer is better.', 'The best listening is after dark, and the best antenna spot is as far from the computer, TVs and chargers as you can get; they all create noise at these frequencies.', 'For a rental: thin wire held with removable hooks along a balcony or inside along a wall is fine and leaves no marks.'] },
    uhfcb: { title: 'Walkie-talkies', mhz: 460, shape: 'vert', band: '446 MHz (PMR446), 462 to 467 MHz (FRS / GMRS), 476 to 477 MHz (UHF CB)',
      why: 'Walkie-talkies are vertically polarised, so a vertical antenna hears them best.',
      tips: ['The rods are short: set them to the length shown, standing straight up.', 'These bands are line-of-sight, so a few kilometres in a suburb, further from high ground. Height matters more than anything else.', 'The Scanner has the channel list for your region, with any emergency and calling channels named.'] },
    marine: { title: 'Marine radio', mhz: 159, shape: 'vert', band: '156 to 162.6 MHz',
      why: 'Marine radio is vertically polarised and line-of-sight over water.',
      tips: ['Vertical, as high as you can, in a window facing the water.', 'Channel 16 (156.800 MHz) is the distress and calling channel; the weather and boating chatter is on the channels around it.'] },
    air: { title: 'Aircraft voice (airband)', mhz: 126, shape: 'vert', band: '118 to 137 MHz',
      why: 'Aircraft voice radio is vertically polarised AM.',
      tips: ['Vertical, near a window with a view of the sky.', 'Aircraft at cruising height can be heard from hundreds of kilometres; ground and tower stations only from a few. Near an airport even short rods work.', '121.5 MHz is the international emergency frequency and 126.7 MHz is the usual local-airfield frequency in Australia.'] },
    gov: { title: 'Other two-way radio (400 to 520 MHz)', mhz: 460, shape: 'vert', band: '400 to 520 MHz',
      why: 'Business, council and some other two-way radio lives here, mostly vertically polarised.',
      tips: ['Vertical, with the shorter rods.', 'Many services in this range are digital or encrypted and will sound like a buzz; only analogue channels can be understood.'] },
    planes: { title: 'Planes (ADS-B at 1090 MHz)', mhz: 1090, shape: 'vert', band: '1090 MHz',
      why: 'This is the band where plane tracking needs the most help: the signals are weak and the cable loses a lot at this frequency.',
      tips: ['The rods are tiny. Use the shortest rods in your kit and set them to the length shown, standing straight up.', 'Put it as high as you can with a clear view of the sky, and keep the cable short. A rod behind a wall or a monitor sees almost nothing.', 'A dedicated 1090 MHz antenna (about A$30 to 60) hears much further than any telescopic kit. If you only see a few planes, this is the upgrade that matters most.'] },
    v137: { title: 'Weather satellites (Meteor, 137 MHz)', mhz: 137.5, shape: 'vee', band: '137.1 to 137.9 MHz',
      why: 'Satellites come from above, so the antenna should face the sky. A flat "V" with the two rods spread 120 degrees apart hears the whole sky well.',
      tips: ['Set both rods to the length shown, then lay them flat (horizontal) in a V about 120 degrees apart, like a wide letter V seen from above.', 'Mount it on a tripod or a balcony rail, facing straight up, with nothing metal within a metre. Rods often need trimming 1 or 2 cm for the best signal.', 'Choose passes that climb above 40 degrees, and record from just before it rises until it sets.', 'Indoors behind glass works a little; outdoors with a clear sky works far better.'] },
    iss: { title: 'International Space Station and 2 m satellites', mhz: 145.8, shape: 'vert', band: '145.8 MHz',
      why: 'The space station talks and sends packet data near 145.8 MHz, and it moves fast across the sky.',
      tips: ['Vertical dipole at the length shown, outdoors or at a window with a wide view of the sky.', 'Passes last 5 to 10 minutes. Pick ones above 30 degrees. Skywave follows the Doppler shift for you.', 'You can use the same flat V as for weather satellites; it hears the high, overhead part of a pass well.'] },
    uhfsat: { title: '70 cm satellites (SO-50, RS-44)', mhz: 435.5, shape: 'vert', band: '435 to 437 MHz',
      why: 'These satellites are heard on the 70 cm band, where rods are short.',
      tips: ['Vertical dipole at the length shown, with a clear view of the sky.', 'Passes are brief, so schedule them from the Space page rather than trying to catch them live.'] },
    ham2m: { title: 'Ham radio 2 m and APRS', mhz: 146, shape: 'vert', band: '144 to 148 MHz',
      why: 'Local ham and APRS signals are vertically polarised.',
      tips: ['Vertical dipole at the length shown. Height helps more than anything; try the highest window you have.', 'APRS reports come in bursts. Give it 10 to 30 minutes before deciding it does not work.'] },
    ham70: { title: 'Ham radio 70 cm', mhz: 435, shape: 'vert', band: '430 to 440 MHz',
      why: 'The 70 cm band is used for local repeaters and satellites.',
      tips: ['Vertical dipole with short rods at the length shown.', 'Repeaters are usually on hills, so a window facing the nearest high point helps.'] },
    hf: { title: 'Ham radio shortwave bands (160 m to 10 m)', mhz: 7.1, shape: 'wire', band: '1.8 to 29.7 MHz', wire: '10 to 20 m of wire',
      why: 'A full-size dipole for 40 m is about 20 metres tip to tip, which is impractical in a rental.',
      tips: ['A 10 to 20 m wire with a 9:1 balun works across the bands.', '40 m (7 MHz) is good at night, 20 m (14 MHz) is best in the daytime, and signals on both are often weak, so expect hissy, fading reception.', 'Needs a dongle that tunes this low (a V4, or direct sampling).'] },
    sens: { title: 'Wireless sensors (433 MHz)', mhz: 433.92, shape: 'vert', band: '433.92 MHz',
      why: 'Weather stations, thermometers and tyre sensors all transmit on 433.92 MHz with very little power.',
      tips: ['Vertical dipole with short rods at the length shown.', 'Put the antenna as close to the sensors as you can; they are weak and often inside or outside walls.', 'Most sensors report every 30 to 60 seconds.'] },
  };  // the walkie-talkie card is cut for the region's own band (UHF CB, PMR446, FRS / GMRS, CB 245...)
  function setup(id) {
    const s = SETUPS[id], w = RS.region && RS.region.walkie;
    if (id !== 'uhfcb' || !w) return s;
    return Object.assign({}, s, { title: w.name, mhz: Math.round((w.lo + w.hi) / 2e6), band: (w.lo / 1e6).toFixed(1) + ' to ' + (w.hi / 1e6).toFixed(1) + ' MHz' });
  }


  const GROUPS = {
    radio: ['fm', 'am', 'sw'],
    scanner: ['uhfcb', 'marine', 'air', 'gov'],
    planes: ['planes'],
    space: ['v137', 'iss', 'uhfsat'],
    ham: ['ham2m', 'ham70', 'hf'],
    sensors: ['sens'],
  };

  const GENERAL = [
    'Both rods must be the same length. Measure from the point where the rod leaves the base to its tip.',
    'Keep the antenna at least a metre from the computer, monitors and chargers. They make radio noise.',
    'Higher is better, and a short cable is better than a long one, especially above 400 MHz.',
    'A clear view of the sky beats a bigger antenna. A window facing the area you care about is a good start.',
    'Rental friendly: use the suction cup, the magnetic base on a metal tray or sheet, or a small tripod. Nothing needs drilling.',
    'After a change, run Settings > Check my radio, or watch how many planes or stations you find, and compare.',
  ];

  function diagram(shape, a) {
    const L = a.rod, col = 'var(--teal)', amb = 'var(--amber)';
    if (shape === 'vert') return '<svg viewBox="0 0 150 130" class="ant-svg" role="img" aria-label="Vertical dipole: two rods in a line, one above the other">' +
      '<rect x="68" y="55" width="14" height="20" rx="3" fill="var(--ink-2)"/><path d="M75 55V12M75 75v43" stroke="' + col + '" stroke-width="5" stroke-linecap="round"/>' +
      '<path d="M96 12v43M96 75v43" stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="3 3"/><text x="104" y="38" font-size="11" fill="var(--ink)">' + esc(L) + '</text><text x="104" y="102" font-size="11" fill="var(--ink)">' + esc(L) + '</text>' +
      '<path d="M75 75h-40" stroke="var(--ink-2)" stroke-width="2"/><text x="6" y="70" font-size="10" fill="var(--ink-2)">to radio</text></svg>';
    if (shape === 'vee') return '<svg viewBox="0 0 150 130" class="ant-svg" role="img" aria-label="V-dipole seen from above: two rods spread 120 degrees apart">' +
      '<rect x="68" y="92" width="14" height="14" rx="3" fill="var(--ink-2)"/><path d="M75 94L28 28M75 94L122 28" stroke="' + col + '" stroke-width="5" stroke-linecap="round"/>' +
      '<path d="M75 94V60" stroke="' + amb + '" stroke-width="1.5" stroke-dasharray="3 3"/><text x="78" y="72" font-size="10" fill="var(--ink-2)">120&deg;</text>' +
      '<text x="6" y="22" font-size="11" fill="var(--ink)">' + esc(L) + '</text><text x="108" y="22" font-size="11" fill="var(--ink)">' + esc(L) + '</text><text x="30" y="124" font-size="10" fill="var(--ink-2)">seen from above, lying flat</text></svg>';
    return '<svg viewBox="0 0 150 130" class="ant-svg" role="img" aria-label="Long wire with a balun box at the radio end">' +
      '<rect x="10" y="52" width="26" height="26" rx="4" fill="var(--ink-2)"/><text x="14" y="69" font-size="9" fill="#fff">9:1</text><path d="M36 65h100M136 65v-18" stroke="' + col + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<text x="40" y="52" font-size="11" fill="var(--ink)">' + esc(a.wire || 'long wire') + '</text><text x="10" y="100" font-size="10" fill="var(--ink-2)">balun at the radio end</text></svg>';
  }

  function entry(id) {
    const s = setup(id), rod = len(s.mhz), rodTxt = fmtLen(rod), tooLong = s.shape !== 'wire' && rod > ROD_MAX;
    const fits = s.shape === 'wire' ? '' : (tooLong ? '<div class="badge warn">Longer than most kit rods. Use a wire instead.</div>' : '');
    const head = s.shape === 'wire' ? '<b>' + esc(s.wire) + '</b> with a 9:1 balun' :
      '<b>Each rod ' + rodTxt + '</b> <span class="muted">(' + fmtLen(rod * 2) + ' tip to tip)</span>';
    const shapeName = { vert: 'Vertical dipole: rods straight up and down', vee: 'V-dipole: rods flat, 120 degrees apart, facing the sky', wire: 'Long wire' }[s.shape];
    return '<div class="ant-item">' + diagram(s.shape, { rod: rodTxt, wire: s.wire }) +
      '<div class="ant-body"><div class="ant-title"><b>' + esc(s.title) + '</b> <span class="muted small">' + esc(s.band) + '</span></div>' +
      '<div class="ant-len">' + head + '</div>' + fits + '<div class="small" style="margin:4px 0 6px"><b>' + shapeName + '</b></div>' +
      '<p class="small muted" style="margin:0 0 6px">' + esc(s.why) + '</p>' +
      '<ul class="small ant-tips">' + s.tips.map(t => '<li>' + esc(t) + '</li>').join('') + '</ul></div></div>';
  }

  RS.antennaCard = (key, open) => {
    const ids = GROUPS[key]; if (!ids) return '';
    return '<details class="card antenna more"' + (open ? ' open' : '') + '><summary>Best antenna setup for this page</summary>' +
      '<p class="small muted">Sizes are for a standard two-rod telescopic dipole kit. The rod length is measured from the base to the tip, for each rod.</p>' +
      ids.map(entry).join('') +
      '<details class="more"><summary>Rules that apply to every setup</summary><ul class="small ant-tips">' + GENERAL.map(t => '<li>' + esc(t) + '</li>').join('') + '</ul></details></details>';
  };

  // ---- calculator -------------------------------------------------------------------------------
  RS.antennaCalc = (mhz) => {
    if (!(mhz > 0.1 && mhz < 2000)) return 'Type a frequency in MHz, for example 145.8.';
    const rod = len(mhz), name = RS.bandName ? RS.bandName(mhz * 1e6) : '';
    let out = '<b>' + mhz + ' MHz</b>' + (name ? ' (' + esc(name) + ')' : '') + ': ';
    if (rod > ROD_MAX) out += 'each rod would need to be ' + fmtLen(rod) + ', too long for most telescopic kits. Use a long wire (about 10 to 20 m) with a 9:1 balun.';
    else out += 'set each rod to <b>' + fmtLen(rod) + '</b> (' + fmtLen(rod * 2) + ' tip to tip). Use a vertical dipole for ground-based signals and a flat V facing the sky for satellites.';
    return out;
  };

  function fullGuide() {
    const all = ['radio', 'scanner', 'planes', 'space', 'ham', 'sensors'];
    const names = { radio: 'Radio', scanner: 'Scanner', planes: 'Planes', space: 'Space', ham: 'Ham', sensors: 'Sensors' };
    return '<div class="card" id="st-antenna"><h3>Antenna guide</h3><div class="sub">The best way to set up an extendable dipole kit (or a wire) for every part of Skywave. One antenna cannot do everything well, so change the rod length when you change what you listen to.</div>' +
      '<div class="row" style="align-items:end;margin:10px 0 4px"><label class="field grow">How long should the rods be? Type a frequency (MHz)<input type="text" class="ant-in" inputmode="decimal" placeholder="e.g. 145.8"></label><button class="btn primary" data-act="ant-calc">Work it out</button><button class="btn" data-act="ant-test">Test my antenna live</button></div>' +
      '<div class="small ant-out" aria-live="polite"></div>' +
      '<div class="ant-table-wrap"><table class="ant-table"><thead><tr><th>Use</th><th>Frequency</th><th>Each rod</th><th>Shape</th></tr></thead><tbody>' +
      Object.keys(SETUPS).map(k => { const s = setup(k); return '<tr><td>' + esc(s.title) + '</td><td>' + esc(s.band) + '</td><td>' + (s.shape === 'wire' ? esc(s.wire) : fmtLen(len(s.mhz))) + '</td><td>' + ({ vert: 'Vertical', vee: 'Flat V', wire: 'Long wire' })[s.shape] + '</td></tr>'; }).join('') +
      '</tbody></table></div>' +
      all.map(k => '<details class="more"><summary>' + names[k] + '</summary>' + GROUPS[k].map(entry).join('') + '</details>').join('') +
      '<details class="more"><summary>Rules that apply to every setup</summary><ul class="small ant-tips">' + GENERAL.map(t => '<li>' + esc(t) + '</li>').join('') + '</ul></details>' +
      '<details class="more"><summary>One antenna for everything?</summary><div class="small">If you want a single antenna for as much as possible, a discone (about 25 MHz to 1.3 GHz) is the usual choice, but it is a compromise on every band and needs outdoor mounting. For a rental, a telescopic dipole kit whose rods you change per band, plus a long wire for shortwave, covers the most with the least fuss. An antenna switch lets you leave several connected.</div></details></div>';
  }
  RS.act['ant-calc'] = b => { const box = b.closest('.card'); box.querySelector('.ant-out').innerHTML = RS.antennaCalc(parseFloat(String(box.querySelector('.ant-in').value).replace(',', '.'))); };

  // ---- attach to each page after it has built itself --------------------------------------------
  Object.keys(GROUPS).forEach(k => {
    const P = RS.pages[k]; if (!P) return;
    const init = P.init;
    P.init = function () {
      if (init) init.apply(this, arguments);
      const page = document.getElementById('p-' + k);
      if (page) { const box = document.createElement('div'); box.style.marginTop = '14px'; box.innerHTML = RS.antennaCard(k); page.appendChild(box); }
    };
  });
  const E = RS.pages.explore;
  if (E) {
    const init = E.init;
    E.init = function () {
      if (init) init.apply(this, arguments);
      const page = document.getElementById('p-explore');
      if (page) { const box = document.createElement('div'); box.style.marginTop = '14px'; box.innerHTML = '<details class="card antenna more"><summary>What antenna length do I need?</summary><div class="row" style="align-items:end"><label class="field grow">Frequency (MHz)<input type="text" class="ant-in" inputmode="decimal" placeholder="e.g. 145.8"></label><button class="btn primary" data-act="ant-calc">Work it out</button></div><div class="small ant-out" style="margin-top:8px" aria-live="polite"></div></details>'; page.appendChild(box); }
    };
  }
  const S = RS.pages.settings;
  if (S) {
    const init = S.init;
    S.init = function () {
      if (init) init.apply(this, arguments);
      const stack = document.querySelector('#p-settings .stack');
      if (stack) { const box = document.createElement('div'); box.innerHTML = fullGuide(); const ref = stack.querySelector('.card:nth-of-type(3)'); stack.insertBefore(box.firstChild, ref ? ref.nextSibling : null); }
    };
  }
})();
