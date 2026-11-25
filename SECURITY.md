# Security policy

## Supported versions

Skywave is maintained as a single line of releases. Security fixes go into the latest release only, so please update
before reporting a problem.

| Version | Supported |
|---|---|
| Latest release | Yes |
| Anything older | No |

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue, pull request or discussion for a security problem.

A useful report includes:

- the Skywave version (shown in Settings) and how it is run (Docker on Linux, Docker Desktop, or directly
  with Python)
- what an attacker needs: network access only, a signed-in user, or access to the machine itself
- steps to reproduce, and what happens compared with what should happen
- any logs, requests or proof-of-concept code, with personal details such as locations and addresses removed

What to expect:

- an acknowledgement within 7 days
- an assessment within 14 days, saying whether the report is accepted and how serious it is
- a fix in a new release as soon as practical, usually within 90 days for accepted reports, with credit in the release
  notes unless you would rather not be named

Please give the fix time to ship before publishing details. If a report turns out to be outside this policy, it will
be explained why.

## Scope

In scope:

- the web server and its routes (`server.py`), including the sign-in check, the same-origin check on live connections
  and the security headers
- the web interface in `static/`, for example script injection through station names, song text, decoded messages or
  other data received over the air
- the decoders and file handling, for example crashes or file writes outside the data folder caused by crafted
  signals, uploads or imported files
- the optional integrations: MQTT and the rigctl remote-control port
- the Docker image and compose files as shipped

Out of scope:

- anything that needs the attacker to already control the host or the data folder
- a deployment exposed to the internet without `AUTH_USER` and `AUTH_PASS`, or without HTTPS from a reverse proxy
- the third-party services Skywave contacts (listed below); please report those to their owners
- denial of service from radio interference or a flood of over-the-air signals

## How Skywave is meant to be run

Skywave is a self-hosted app for a home network. Keep these points in mind when deploying it:

- **Set a password** with `AUTH_USER` and `AUTH_PASS` whenever anyone else can reach your network. Without them, anyone
  who can open the page can use the radio and see your location and recordings.
- **Do not expose it to the internet directly.** To reach it from outside your home, put it behind a reverse proxy
  with a real certificate, or use a VPN.
- **The container runs privileged on Linux** so it can reach the USB dongle. Run it on a machine and network you trust,
  or use `RTL_TCP` to read the dongle from another machine and drop `privileged` if you do.
- **The rigctl port** accepts commands only from the address ranges in its `allow` setting (local networks by
  default). Narrow the list if you enable it.
- **MQTT** sends readings to the broker you choose. Use a broker with a password, and TLS if it is not on your own
  network. The broker password is never sent to a browser, and only ever to the broker it was saved for: changing
  the broker address clears it.

## Built-in protections

- Optional sign-in (HTTP Basic), compared in constant time, with each failed attempt slowed down
- Live connections (`/ws`, `/stream.mp3`) and changes are refused when the request comes from another website
- With sign-in off, the server answers only to host names a home network uses (IP addresses, `localhost`, single-word
  names, `.local`, `.lan`, `.home.arpa`, `.internal`, plus `ALLOWED_HOSTS`), so a web page cannot reach it by pointing
  its own domain name at your machine (DNS rebinding)
- `Content-Security-Policy` with `script-src 'self'` (no inline scripts or event handlers, so text from the air or from
  outside services cannot run as script even if it reached the page unescaped) and `frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`
  and `Referrer-Policy: no-referrer` on every response. The one exception is OpenStreetMap map tiles: their servers
  refuse requests without a Referer, so those carry the Skywave address only (scheme, host and port, no path)
- Pager messages are shown on the page only and never written to disk
- Settings and recordings stay in the data folder; nothing is sent anywhere without a feature that needs it

## What leaves your machine

Only these requests go out, each when the feature that needs it is used:

- orbit data from CelesTrak and SatNOGS
- place search from Open-Meteo, OpenStreetMap Nominatim and Photon (only the words you type; suggestions while you type go to Open-Meteo and Photon only, after a short pause)
- aircraft details and routes from adsbdb, adsb.lol, adsb.im and hexdb.io (the aircraft's address, callsign and current position, or your
  receiver's position rounded to about 10 km before the plane has sent one; the position is used to pick the right
  route, because the same callsign can belong to different flights in different countries)
- the track flown so far by the plane you choose, from adsb.lol (aircraft address only); it also shows which airport
  the plane took off from when the route sources disagree or have nothing for today
- the list of airports from OurAirports, downloaded once a month (nothing is sent)
- maps of an airport's terminals and gates from OpenStreetMap's Overpass API (only the airport's position), once a
  month per airport, for working out which terminal a plane was parked at
- cover art from Apple, then Deezer, then MusicBrainz and the Cover Art Archive when the one before has nothing (only
  the song text and your country), and song links from Apple and Deezer
- map tiles from OpenStreetMap

## Third-party code

The vendored libraries in `static/vendor` and the Python packages in the Docker image are updated with each release.
If a vulnerability in one of them affects Skywave, report it as above.
