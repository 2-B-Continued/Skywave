# CLAUDE.md

Skywave is a self-hosted web app for an RTL-SDR dongle: FM/AM/air/marine radio with RDS and cover art, a scanner,
ADS-B planes, AIS ships, satellite passes and recording (Meteor LRPT, ISS SSTV), weather balloons, wireless sensors
(rtl_433), pagers and aircraft messages, captions, and a full receiver lab. One Python server drives the dongle and
serves a vanilla-JS single-page app. It runs in Docker, plain http on port 8073.

## Project rules (always follow)

- **Vanilla JS, no build step.** Plain `<script>` files in a fixed order in `static/index.html`, plain CSS. No
  bundler, framework, TypeScript or npm dependencies in the app.
- **Free only.** No paid services, API keys or accounts. Every online source must be free and keyless.
- **Clean, neutral code.** Comments explain the code and nothing else. No references to any person, their requests,
  notes, inspirations, other projects or locations in code, comments, tests or docs. No personal email anywhere.
- **Credit third-party code and data** in the README "Licence and credits" section when adding any.
- **Motion:** respect `prefers-reduced-motion` and the app's own Motion Off setting for every animation.
- **Styles keep their feel.** Each style is a different layout, not just colours (see Styles below).
- **Design work uses two skills.** For anything new or redesigned, use the Chrome Modern Web Guidance skill
  (`modern-web-guidance`: search and retrieve the guides for each UI pattern, follow them) and the MotionSites Web
  Builder skill (`motionsites-web-builder`: its craft rules and look-and-fix review, with screenshots of every style at
  desktop and phone width).
- **Every country is selectable** (250 codes) and the interface language list is all-inclusive (96 languages).
- **Plain http only.** There is no HTTPS server, no certificate and no browser geolocation. Nothing may depend on a
  secure context (no "Use my location", no phone compass). Capability checks such as the AudioWorklet fallback in
  `sound.js` are fine, because both paths work over http.
- **No inline script.** The CSP is `script-src 'self'`: no `<script>` blocks, `onclick=` attributes, `javascript:` URLs
  or `eval`. Use `data-act` and `RS.act`. Escape every server or radio value with `RS.esc` before it goes into HTML.
- **DAB+ was removed completely.** Do not reintroduce any reference to it.
- **Privacy:** pages send `Referrer-Policy: no-referrer`. The one exception is OpenStreetMap tiles
  (`strict-origin-when-cross-origin`, see `pages.js`), because their servers refuse tiles without a Referer. Anything
  new that leaves the machine must be listed in README ("What leaves your machine") and SECURITY.md.
- **Deliverables:** don't produce release zips unless asked. When asked, run `packaging/build.sh` (the app zip and the
  GitHub showcase zip are always separate).

## Running

```sh
docker compose up -d --build                          # Linux / Pi, USB dongle (privileged + /dev/bus/usb)
docker compose -f docker-compose.desktop.yml up -d    # macOS/Windows: rtl_tcp on the host, RTL_TCP=host.docker.internal:1234
SIM=1 PORT=8073 DATA_DIR=./data python3 server.py     # no dongle: simulated signals
```

Environment (see `config.py` `ENV_MAP`): `SIM`, `PORT`, `DATA_DIR`, `RTL_TCP` (`host:port` of a remote rtl_tcp,
used by everything including rtl_433 and rtlamr), `SAMPLE_RATE`, `LAT`/`LON`/`ALT`, `GAIN_DB`, `PPM`, `BIAS_T`,
`HF_MODE`, `DEEMPH_US`, `SETUP_DONE`, `AUTH_USER`/`AUTH_PASS`, `ALLOWED_HOSTS` (extra host names when sign-in is
off), `NO_NET` (no outside requests; used by tests),
`RTL433_BIN`, `RTLAMR_BIN`, `RTL_TCP_BIN`. Build arg `WITH_RTLAMR=1` adds the utility-meter decoder.

## Layout

Backend (Python 3, numpy/scipy, standard library HTTP server):

| File | Role |
|---|---|
| `server.py` | HTTP + WebSocket server, `/api/*` routes, auth, security headers, static files, start-up |
| `engine.py` | The radio thread: jobs (listen, scan, sweep, adsb, ism, record, health…), commands, audio out (frame types 2 mono, 3 stereo, 4 reduced, 5 new-station marker), retune |
| `sources.py` | rtl_tcp source (local process or remote `RTL_TCP`), file playback, error explanations, `remote_addr`/`remote_device` |
| `config.py` | Defaults, saved settings (`data/config.json`), env overrides, migrations of old defaults |
| `dsp.py`, `rds.py`, `audioq.py`, `captions.py`, `morse.py`, `afsk.py`, `datalink.py` | Demodulation and decoders |
| `adsb.py`, `ais.py`, `sim.py`, `fake_rtl_tcp.py` | ADS-B decode/encode (incl. TC29 autopilot targets, TC19 airspeed), AIS, simulator |
| `planeinfo.py` | Aircraft and route lookups: adsbdb, adsb.lol, adsb.im, hexdb.io, VRS standing data; route checked against the plane's (or receiver's) position; takeoff airport from the track; cache file versioned |
| `airports.py` | OurAirports list (downloaded monthly to `data/airports.json`), by code and nearest |
| `terminals.py` | Domestic/international, usual terminals and split airport names for major Australian airports |
| `airportmap.py` | Worldwide terminals from OpenStreetMap (Overpass) terminals/gates plus where the plane parked; remembers airline→terminal |
| `art.py` | Cover art: Apple → Apple US → Deezer → MusicBrainz/Cover Art Archive; studio over live; "Open in" links; covers also kept in `data/art` (newest 300) so song lists saved in browsers keep their pictures |
| `geo.py` | Place search (Open-Meteo, Nominatim, Photon), postcode → suburb, limited to the chosen country |
| `regions.py`, `countries.py`, `banks.py` | Band plans and channel lists per region; every country mapped to a region |
| `space.py`, `space_worker.py`, `satsync.py`, `sstv_*.py` | Satellite passes, orbit data, recording and decoding |
| `sensorstore.py`, `mqtt.py`, `rigctl.py`, `timers.py`, `weather.py`, `lab.py`, `prolab.py`, `gainmem.py` | Sensors history, Home Assistant MQTT, Gqrx-style control, timers, Lab |

Frontend (`static/`): `index.html` loads `js/boot.js` in the head (saved style and theme, no flash), then `js/*.js` in
order (core first, then pages, then `themes.js`, `fx.js`,
vendored GSAP/Lenis, `motion.js`, `craft.js`, and `start.js` last). Everything hangs off the global `RS`:
`RS.api(path)`, `RS.send({cmd})` (WebSocket), `RS.on/RS.fire` events, `RS.act[name]` click handlers via
`data-act`, `RS.store` (localStorage), `RS.t()` translations, `RS.icon(name)` (SVG sprite ids in `index.html`),
`RS.pages.<page>` with `init/enter`.

- Audio: `audio-net.js` (network worker) → `audio-worklet.js` (`SkywaveCore` ring buffer with a learned cushion;
  runs as an AudioWorklet where allowed, otherwise driven by `sound.js` on the page) → speakers. Retune: `flush` on
  send, then the server's frame type 5 marks the new station; playback restarts on the base cushion.
- Dialogs: `RS.modal()` opens a native `<dialog>` with `showModal()` (inert page, focus kept inside and returned);
  `RS.releaseModal()` closes one that is about to animate away. Enter handlers use `RS.isEnter(e)` (IME-safe).
- Lab: one console page (`lab.js` + `labpro.js`, styles in `css/lab.css`). Panes return titled groups; `LAYOUT` in
  `lab.js` places each group (by its title slug) in the settings column, the instruments column or a tab of the dock
  under the waterfall. A group not listed lands in a "More" dock tab, so add new groups to `LAYOUT`. Live tools check
  `Lab.shown(id)` and start on the `labpane` event. `tests/pw_lab.js` covers it.
- Navigation: tabs always show icon and full name; `fitTabs()` in `core.js` adds `.wrap` to give the tabs their own
  wrapping row instead of shrinking them. Phones use the bottom `mobile-nav`.
- Setup/Settings form: `setup.js` (language, searchable A–Z country picker, typed place search, units).
- Translations: `static/lang/*.json` (95 files + `en-template.json.txt`); only keys passed through `RS.t()`.

## Styles and palettes

`<html data-style>` selects one of 10 styles: Skywave, Depth (spatial), Relief (neumorphism), Walnut
(skeuomorphism), Riot (maximalism), Bento, Folio, Terminal, Brut, Ticket. 28 palettes sit on top (`themes.js`,
including Clay and Carnival). A style can change layout entirely. Touch points when adding or changing a style:
`styles.css` (main section), `motion.css`, `kinetic.css`, `polish.css` (shared fixes), `themes.js` (STYLES,
palettes, DARK_ONLY), the style list in `static/js/boot.js`, `motion.js` presets, `fx.js` SPOT, `craft.js` RACK,
`dialstyles.js` dials, `radio.js` fonts map, and the style lists in `tools/screenshots.js` and `tests/pw_style*`.
Home uses `.ho-*` classes (`.hw` and `#hm-` are dead): a landing hero (`.ho-hero`, the style's `.glass` surface) with a live
waterfall canvas in the palette's `--sig` colour (pauses off screen, has a Pause button, still under reduced motion),
the headline in `--f-disp`, a stats strip, then `.ho-sheet` with the sections. `tests/pw_home.js` and `pw_home_hero.js`. Fixed elements inside `.topbar` need backdrop-filter off.

## Tests

```sh
for t in tests/test_*.py; do python3 -W ignore "$t"; done    # each prints ALL PASS / PASS
node tests/player_hiccups.js; node tests/player_retune.js    # audio player maths
NODE_PATH=$(npm root -g) node tests/pw_planes.js              # browser tests: Playwright + Chromium, one file at a time
```

- Browser tests start their own `SIM=1 NO_NET=1` server on a fixed port, and mock outside services with Playwright
  `route()`. The first run after a cold start is occasionally flaky; rerun once before investigating.
- `pw_sound.js`: `HOST=127.0.0.1` runs it as a secure page (AudioWorklet); default uses the network address (page player).
- `test_extras.py` needs `sgp4`, `test_sstv.py` needs `pysstv`, `test_lrpt_path.py` needs `meteor_demod`; they fail
  or skip without them.
- Outside services can't be reached from tests: new lookups get unit tests with fake fetch functions.
- Full-page screenshots misplace fixed elements; screenshot the element or the viewport.
- Regenerate README screenshots with `node tools/screenshots.js` (writes `docs/screenshots`).

## Packaging

`packaging/build.sh` writes `out/skywave.zip` (the app, with `packaging/README-app.md` as its README, plus this file
and `packaging/`, but no screenshots or screenshot tool) and `out/skywave-github.zip` (README.md, SECURITY.md, `docs/screenshots`, `tools/screenshots.js`).

## Open items worth checking on real hardware

- Sensors over a remote `RTL_TCP` (rtl_433 `-d rtl_tcp:host:port`, rtlamr `-server=`): only tested with stand-ins.
- Live responses of adsb.im, the VRS standing data, hexdb.io and Overpass: parsers were written from documented
  formats and tested with sample data.
- Retune speed with a real dongle (the simulator measures 60–200 ms to sound).
