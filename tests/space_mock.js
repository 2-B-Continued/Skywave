// Plausible pass data for browser tests: the sandbox has no orbit library (sgp4), so the page is fed passes and paths.
module.exports = async function mockSpace(page, opt = {}) {
  const now = Date.now() / 1000;
  const mk = (sat, short, name, inMin, dur, el, a0, a1) => ({ sat, short, name, aos: now + inMin * 60, los: now + inMin * 60 + dur * 60, tca: now + inMin * 60 + dur * 30, max_el: el, az_aos: a0, az_tca: (a0 + a1) / 2, az_los: a1, duration: dur * 60 });
  const P = [
    mk('iss', 'ISS', 'International Space Station', opt.live ? -3 : 23, 10, 62, 225, 45),
    mk('meteor-m2-3', 'Meteor-M2-3', 'Meteor-M2-3 (weather satellite)', 95, 14, 48, 10, 170),
    mk('so-50', 'SO-50', 'SO-50 (amateur FM repeater)', 140, 11, 22, 300, 120),
    mk('iss', 'ISS', 'International Space Station', 118, 9, 18, 260, 120),
    mk('meteor-m2-4', 'Meteor-M2-4', 'Meteor-M2-4 (weather satellite)', 300, 13, 71, 190, 350),
    mk('rs-44', 'RS-44', 'RS-44 (amateur linear transponder)', 380, 16, 35, 80, 240),
    mk('funcube-1', 'FUNcube-1', 'FUNcube-1', 470, 12, 14, 20, 150),
    mk('meteor-m2-3', 'Meteor-M2-3', 'Meteor-M2-3 (weather satellite)', 700, 14, 33, 350, 190),
    mk('iss', 'ISS', 'International Space Station', 830, 10, 41, 240, 60),
    mk('so-50', 'SO-50', 'SO-50 (amateur FM repeater)', 1000, 12, 56, 140, 330),
    mk('meteor-m2-4', 'Meteor-M2-4', 'Meteor-M2-4 (weather satellite)', 1250, 13, 27, 170, 10),
  ].sort((a, b) => a.aos - b.aos);
  const sky = [{ id: 'iss', short: 'ISS', el: opt.live ? 30 : -20, az: 200, range_km: 900, up: !!opt.live }, { id: 'rs-44', short: 'RS-44', el: 24, az: 300, range_km: 2100, up: true }, { id: 'funcube-1', short: 'FUNcube-1', el: 9, az: 120, range_km: 2600, up: true }];
  await page.route('**/api/space/passes*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ passes: P, sky, now, available: true, tle_age_days: 1.4, status: 'Orbit data from CelesTrak', schedule: opt.schedule || [] }) }));
  await page.route('**/api/space/aim*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ sky, now, lat: -33.92, lon: 18.42 }) }));
  await page.route('**/api/space/track*', r => {
    const u = new URL(r.request().url()), t0 = +u.searchParams.get('t0'), p = P.find(x => Math.abs(x.aos - t0) < 1) || P[0], pts = [];
    for (let i = 0; i <= 40; i++) { const k = i / 40, az = p.az_aos + (((p.az_los - p.az_aos + 540) % 360) - 180) * k; pts.push([+((az + 360) % 360).toFixed(1), +(p.max_el * Math.sin(Math.PI * k)).toFixed(1)]); }
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ track: pts }) });
  });
  return P;
};
