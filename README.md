# Skywave

A self-hosted web app for RTL-SDR USB radio dongles: FM and AM radio, aircraft (ADS-B), ships (AIS),
satellites, weather balloons, sensors, pagers and aircraft messages, scanners and a receiver lab, in one page that
works on desktop and phone, in 96 languages. Settings follow the country you choose.

## Quick start

You need Docker, an RTL-SDR dongle (an RTL-SDR Blog V4 is recommended) and an antenna.

**Linux and Raspberry Pi**
```bash
docker compose up -d --build
```
Open `http://localhost:8073`, or `http://<that computer's address>:8073` from another device.
If the dongle is reported busy, blacklist the TV driver and replug it:
```bash
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/blacklist-rtl.conf
```

**macOS and Windows (Docker Desktop):** containers there cannot see USB, so serve the dongle from the host and
connect over the network:
1. Install the RTL-SDR drivers (Windows: the RTL-SDR Blog V4 guide and Zadig; macOS: `brew install librtlsdr`).
2. Run `rtl_tcp -a 127.0.0.1` and leave it running.
3. `docker compose -f docker-compose.desktop.yml up -d --build`, then open `http://localhost:8073`.

**Without a dongle:** set `SIM: "1"` in the compose file to use the built-in simulator.

The first visit runs a short setup: language, country, location and units.

## Configuration

Set under `environment:` in the compose file.

| Variable | What it does |
|---|---|
| `AUTH_USER` / `AUTH_PASS` | Password-protect the page (set both). |
| `SIM` | `1` uses the simulator instead of a dongle. |
| `RTL_TCP` | `host:port` of an `rtl_tcp` server to use instead of USB. |
| `LAT`, `LON` | Force a location. |
| `TZ` | Container time zone. |
| `PORT` | Web port (default `8073`). |
| `HTTPS` / `HTTPS_PORT` | Self-signed HTTPS on the next port (default `8074`), needed for the phone compass; `HTTPS=0` turns it off. |

Data lives in `./data`. Optional utility-meter support: `docker compose build --build-arg WITH_RTLAMR=1`.

## Tests

No hardware needed; they use the simulator.
```bash
for t in tests/test_*.py; do python3 "$t" || break; done
NODE_PATH=$(npm root -g) node tests/pw_radio.js     # browser tests need Playwright
```

## Security and the law

On Linux the container runs privileged to reach USB, so run it on a network you trust and set a password if others
can reach it. Radio laws differ between countries; what you receive, record and transcribe is your responsibility.
Pager messages are shown on the page only and never written to disk.

## Licence and credits

MIT licence (see `LICENSE`). Skywave runs these open-source programs as separate processes, under their own licences:
the RTL-SDR drivers, rtl_433, multimon-ng, ffmpeg, meteor_demod and meteor_decode, rtlamr,
faster-whisper and the optional `sstv` package. Bundled in the page: GSAP 3.15.1 by GreenSock (GSAP Standard
"no charge" licence) and Lenis 1.3.27 by darkroom.engineering (MIT). Bundled fonts are under the SIL Open Font
License, with licence files alongside: Atkinson Hyperlegible, B612 Mono, Bricolage Grotesque, Geist Mono, Instrument
Sans, Instrument Serif, Inter, JetBrains Mono, Jura and Poiret One.
