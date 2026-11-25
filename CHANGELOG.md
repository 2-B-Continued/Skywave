# Changelog

## 2026-11-25

Everything that changed since the first public version.

### Security

- **Deleting a decode could delete the whole data folder.** The id of a decoded picture was only reduced to a file
  name, so an id of `..` pointed at the data folder itself (settings, recordings and everything else) and an empty id
  at every decode. Ids are now checked to name exactly one folder inside `decoded/`, for deleting, reading and
  rebuilding reports.
- **Settings file could be read through the decoded-pictures address.** On case-insensitive disks (Docker Desktop on
  macOS and Windows) `/dec/../config.JSON` slipped past a check for `.json`, exposing the saved MQTT password. The
  same id check closes it, and `/dec/` now serves only pictures and PDF reports.
- **Protection from DNS rebinding.** With no password set, a web page elsewhere could point its own domain name at your
  Skywave and control it through your browser. Skywave now answers only to IP addresses, `localhost`, single-word names
  and `.local`, `.lan`, `.home.arpa` and `.internal` names, plus any listed in the new `ALLOWED_HOSTS` setting.
- **The MQTT broker password stays with its broker.** Testing or saving a different broker address, or restoring a
  settings file that named one, used to send the saved password to that address. The password is now only ever sent to
  the broker it was saved for; a new address starts without one, and the settings form says so.
- **Content Security Policy `script-src 'self'`.** Only Skywave's own script files can run, so text from the air or from
  outside services can never run as script even if it reached the page unescaped. The two inline scripts moved to
  `js/boot.js` and `js/start.js`.
- **Scanner lists are checked.** A range's mode is limited to real modes and escaped on the page (a crafted settings
  file could otherwise add script), and ranges must run upwards in steps of at least 100 Hz with at most 20,000
  channels.
- Cover art is limited to JPEG, PNG, WebP and GIF; an SVG, which can carry script, is never served from Skywave's own
  address.
- Unknown radio modes are refused, so they can never reach file names or the page.
- WebSocket messages are limited in total size, not only per piece.
- Orbit data downloads are limited in size.
- Server errors no longer echo internal details to the page; the details go to the log (Settings, Show technical
  details).
- `NO_NET` now also stops cover art, place search and satellite data lookups.
- The HTTPS server and its self-signed certificate were removed: Skywave serves plain http on your own network (use a
  reverse proxy with a real certificate to reach it from outside). Port 8074 is no longer published, and OpenSSL is no
  longer installed in the image.
- Map tiles send only this Skywave's address as their Referer (no page path), which the tile servers require; every
  other request sends none.
- A security policy was added: `SECURITY.md` (how to report a problem, what is in scope, what leaves your machine).

### Bug fixes

- Walnut's main buttons (Listen, Start and others) showed as empty dark pills on computers: a hover sheen replaced
  their fill. The sheen now sits on top of it.
- Walnut with a light palette washed out its backlit dial and readouts. Walnut, like Terminal, now always uses a dark
  palette (Autumn).
- Walnut's pressed buttons used amber text on grey (unreadable on light palettes); they now use a readable warm tone.
- Covers in Songs heard vanished after a restart, or on another device, and left a broken-image icon. Covers are now
  kept on disk (`data/art`, newest 300), a cover that still cannot load is looked up once more and put back, and a song
  without one shows a tidy placeholder.
- The Songs heard list no longer redraws itself while covers are being looked up.
- The same message no longer stacks twice in the toasts.
- Typing Chinese, Japanese or Korean no longer sends a search, adds an item or saves when Enter only confirms a
  character (place search, country list, frequency entry, scanner and message filters, sensor names).
- "Adjacent channel" readings no longer show nonsense (such as −186 dBc) at the edge of the band.
- The audio analyser explains what to do instead of showing an empty black box when the sound is off.
- Retuning is much faster: sound from the old station still on its way is dropped at once, the player starts the new
  station straight away, and the tuner settles in 0.05 s instead of 0.25 s.
- Map tiles failed with "Referer is required"; they now load.

### New

- **Home** is rebuilt as a landing page: a live waterfall of the band the radio is on fills the top, drawn in the
  palette's colours, with what you are hearing over it (cover, state, the station as a large headline with the song
  under it, signal, Listen, Open the radio, Go to a frequency) and a strip of live numbers (aircraft in range,
  satellites overhead, the next pass, the nearest sensor). The waterfall has a Pause button, stops drawing when out of
  sight, and is a still picture with reduced motion or Motion Off. Your stations, Next up, Around you and everything
  else follow on a sheet below.
- **Lab** is rebuilt as one console: a toolbar with a large frequency readout you can step digit by digit (mouse wheel
  or arrow keys) or type into, modes, bandwidth, squelch, volume, a signal meter and status lamps; every receiver
  setting in collapsible sections on the left; a large spectrum and a waterfall with twice the history in the middle,
  with a dock of tools under it (audio analyser, integrator, signal logger, tone tables, calibration and export, event
  log, raw settings, API); and live instruments on the right (signal analysis, frequency counter and zoom, I/Q scope,
  peaks and markers). Help text can be shown or hidden.
- **Planes:** each aircraft's route with the airport and terminal at each end (domestic or international, and where it
  was parked, from airport maps), the takeoff airport from its track when the route sources have nothing, the plane's
  type in plain words, how far along the flight is and when it should land, and what the autopilot is set to (selected
  altitude, heading and modes from ADS-B version 2) plus airspeed when no ground speed is sent. More aircraft and route
  sources: adsb.im, hexdb.io and a standing aircraft database. Routes are checked against where the plane actually is.
- **Place search** suggests places as you type, finds suburbs from postcodes and stays within your chosen country
  unless you name another.
- **Country picker** you can type into (any language, accents ignored) with the full A to Z list under it.
- **Sensors and utility meters over a remote `rtl_tcp`** (rtl_433 and rtlamr read the dongle on another computer), with
  plain-language explanations when the connection fails, including IPv6 addresses.
- **Cover art** prefers the studio recording over live and other versions, and the songs list keeps songs even when no
  cover is found or cover art is turned off.
- New radio dials for Depth, Relief, Walnut, Riot and Ticket, and new motion for each style (Depth's windows lean
  toward the pointer, Relief's controls lift, Walnut's lamp warms, Riot's stickers wobble).

### Changed

- Dialogs are native and accessible: the page behind can't be used while one is open, keyboard focus stays inside and
  returns to the button that opened it, and Esc or the back gesture closes it.
- The section tabs always show their icon and full name, moving onto a row of their own rather than shrinking.
- The Lab's text and numbers use each style's own fonts, on one consistent scale that follows the browser's text size.
- "Usually" is no longer shown after a terminal name in flight details.
- Relief's raised slab widens on the Lab so the console has room.
- The phone compass and "Use my location" were removed (both need a secure https page); the location is typed in.
- The README was rewritten with current screenshots, and `tools/screenshots.js` makes them.

### For developers

- New tests: `test_hardening.py`, `pw_lab.js`, `pw_songs.js`, `pw_home_hero.js`, `test_airportmap.py`,
  `test_airports.py`, `test_terminals.py`, `test_retune.py`, `test_remote_sensors.py`, `test_adsb_autopilot.py`,
  `pw_tiles_referer.js` and `player_retune.js`; more checks in the art, geo, location, planes and region tests. The
  HTTPS test was removed with the HTTPS server.
- `packaging/build.sh` builds the app and GitHub zips; `CLAUDE.md` describes the project rules and layout.
- `.gitignore` and `.dockerignore` were added (data, caches, zips, `.DS_Store`).
