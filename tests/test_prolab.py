"""The deeper Lab: tone/code/keypad detection, synchronous AM, audio stages, converter maths, and end to end through the
engine and the simulator: zoom spectrum + frequency counter, I/Q scope, noise squelch, channel recording, network sound,
Gqrx-style remote control."""
import os
import socket
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import make_engine, Collector  # noqa: E402
import prolab as P  # noqa: E402
import lab  # noqa: E402
import rigctl  # noqa: E402
import sources  # noqa: E402

ok = True


def check(name, cond, extra=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name, extra)
    ok = ok and bool(cond)


rng = np.random.default_rng(5)
FS = 48000
t = np.arange(FS * 4) / FS
voice = (0.6 * np.sin(2 * np.pi * 700 * t) * np.sin(2 * np.pi * 3 * t)).astype(np.float32)


def feed(T, d, how):
    for i in range(0, len(d), 4800):
        getattr(T, how)(d[i:i + 4800])


for tone in (67.0, 71.9, 131.8, 254.1):
    T = P.Tones()
    feed(T, (0.2 * np.sin(2 * np.pi * tone * t) + voice + 0.05 * rng.standard_normal(len(t))).astype(np.float32), "feed_disc")
    check("CTCSS %.1f Hz found under speech" % tone, T.ctcss == tone, str(T.ctcss))
T = P.Tones()
feed(T, (voice + 0.3 * rng.standard_normal(len(t))).astype(np.float32), "feed_disc")
check("no tone, no false CTCSS/DCS", T.ctcss is None and T.dcs is None)
for code in (0o023, 0o411, 0o754):
    bits = P.dcs_bits(code, 8)
    sps = FS / 134.4
    idx = (np.arange(int(len(bits) * sps)) / sps).astype(int)
    a = np.convolve(np.where(np.array(bits)[idx] > 0, 0.25, -0.25), np.ones(60) / 60, "same").astype(np.float32)
    T = P.Tones()
    feed(T, a + (0.3 * np.sin(2 * np.pi * 900 * np.arange(len(a)) / FS)).astype(np.float32), "feed_disc")
    check("DCS %03o found" % code, T.dcs == "D%03oN" % code, str(T.dcs))
T = P.Tones()
feed(T, np.concatenate([np.zeros(4800), P.dtmf_audio("0412*9#D"), np.zeros(4800)]).astype(np.float32), "feed_audio")
check("DTMF keys", T.dtmf == "0412*9#D", T.dtmf)

m = np.sin(2 * np.pi * 1000 * t)
z = ((1 + 0.6 * m) * np.exp(1j * (2 * np.pi * 150 * t + 0.5))).astype(np.complex64)
for sb in ("both", "upper", "lower"):
    S = P.Sam(sb)
    o = np.concatenate([S.process(z[i:i + 4800]) for i in range(0, len(z), 4800)])[FS:]
    check("synchronous AM (%s) locks 150 Hz off and recovers the audio" % sb, np.corrcoef(o, m[FS:FS + len(o)])[0, 1] > 0.95 and abs(S.offset_hz - 150) < 2)

L = dict(lab.DEFAULTS)
L.update(eq_on=True, eq1k=9.0, comp_on=True, comp_thr=-30, comp_ratio=8, gate_on=True, gate_db=-40)
fx = lab.AudioFx(L)
loud = fx.process((0.5 * np.sin(2 * np.pi * 1000 * t[:FS])).astype(np.float32))
quiet = fx.process((0.003 * np.sin(2 * np.pi * 1000 * t[:FS])).astype(np.float32))
check("compressor + gate: loud stays bounded, near-silence is gated", np.abs(loud).max() <= 1.0 and np.sqrt(np.mean(quiet[-4800:] ** 2)) < 0.002)
check("validation keeps host names tidy", lab.validate({"udp_host": "10.0.0.5; rm -rf"})[0]["udp_host"] == "10.0.0.5rm-rf")


class Fake:
    def set_freq(self, h):
        self.h = h

    def read_samples(self, n):
        return bytes([0, 10] * n)


f = Fake()
c = sources.Converter(f, 125e6, False, 30e6)
c.set_freq(7.1e6)
a1 = f.h
c.set_freq(145e6)
check("upconverter: HF goes up 125 MHz, VHF passes straight through", a1 == 132.1e6 and f.h == 145e6)
c = sources.Converter(f, -9750e6)
c.set_freq(10489.5e6)
check("LNB: 10489.5 MHz reaches the dongle at 739.5 MHz", f.h == 739.5e6)
check("rigctl allow-list", rigctl.allowed("192.168.1.9", "127.0.0.1, 192.168.0.0/16") and not rigctl.allowed("8.8.8.8", "127.0.0.1, 192.168.0.0/16"))

# ---- engine + simulator
port = 17356
eng, cfg, d = make_engine(env={"LAT": "-33.92", "LON": "18.42"})
col = Collector(eng)
time.sleep(1.0)
eng.command({"cmd": "tune", "freq": 100.0e6, "mode": "wfm"})
time.sleep(2.0)
eng.command({"cmd": "lab", "set": {"zoom_span": 46000}})
eng.command({"cmd": "lab_live", "zoom": True, "scope": True})
z = col.wait_for("zoom", 10)
s = col.wait_for("iqsnap", 10)
check("zoom spectrum arrives with a fine resolution", z is not None and z["rbw"] < 3.0 and len(z["bins"]) > 100, str({k: z[k] for k in ("rbw", "span", "peak_hz")} if z else None))
check("I/Q snapshot for the scopes", s is not None and len(s["i"]) == 768)
eng.command({"cmd": "tune", "freq": 113.6e6, "mode": "am"})        # the simulator's VOR ident: a steady AM carrier
time.sleep(2.5)
col.events.clear()
eng.command({"cmd": "lab_live", "zoom": True})
z = col.wait_for("zoom", 10)
time.sleep(1.5)
zz = [e for e in col.events if e.get("type") == "zoom"]
z = zz[-1] if zz else z
check("frequency counter reads a carrier to within 5 Hz", z is not None and abs(z["peak_hz"] - 113.6e6) < 5, str(z["peak_hz"] if z else None))
eng.command({"cmd": "lab", "set": {"am_det": "sam"}})
time.sleep(2.0)
st = col.last_state()
check("synchronous AM runs in the receiver and reports lock", st.get("sam") is not None, str(st.get("sam")))
eng.command({"cmd": "lab", "set": {"am_det": "env"}})
# noise squelch: quiet carrier vs. nothing
eng.command({"cmd": "tune", "freq": 446.00625e6, "mode": "nfm"})
time.sleep(1.0)
qs = []
t0 = time.time()
while time.time() - t0 < 18:
    s_ = col.last_state()
    if s_ and s_.get("quiet") is not None:
        qs.append(s_["quiet"])
    time.sleep(0.25)
check("noise squelch reading moves between no signal and a signal", qs and max(qs) - min(qs) > 40, "min %s max %s" % (min(qs or [0]), max(qs or [0])))
# network sound
rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
rx.bind(("127.0.0.1", 0))
rx.settimeout(5)
eng.command({"cmd": "lab", "set": {"udp_on": True, "udp_host": "127.0.0.1", "udp_port": rx.getsockname()[1], "udp_rate": 16000}})
try:
    pkt = rx.recv(4096)
except socket.timeout:
    pkt = b""
check("sound goes out over UDP", len(pkt) > 100)
eng.command({"cmd": "lab", "set": {"udp_on": False}})
# channel recording
eng.command({"cmd": "chan_rec", "on": True})
time.sleep(2.0)
eng.command({"cmd": "chan_rec", "on": False})
e = col.wait_for("chan_rec", 5, lambda m: m.get("on") is False)
fn = os.path.join(d, "recordings", e["file"]) if e else ""
check("channel I/Q recording: 2-channel 48 kHz WAV", e and os.path.getsize(fn) > 48000 * 4, fn)
st = col.last_state()
check("performance figures in the state", st.get("perf") and st["perf"]["load"] > 0, str(st.get("perf")))
# remote control
cfg.update({"rigctl": {"on": True, "port": port, "allow": "127.0.0.1"}})
srv = rigctl.Server(eng, cfg)
srv.apply()
time.sleep(0.3)
r = rigctl.client(port, "F 118100000", "M AM 8000")
time.sleep(1.0)
r2 = rigctl.client(port, "f", "m", "l STRENGTH", "AOS", "u RECORD")
check("Gqrx-style remote control: set and read back", r == ["RPRT 0", "RPRT 0"] and r2[0] == "118100000" and r2[1].startswith("AM 8000") and r2[3] == "RPRT 0", str((r, r2)))
rigctl.client(port, "LOS")
srv.stop()
eng.stop()
eng.join(5)
print("ALL PASS" if ok else "SOME FAILED")
sys.exit(0 if ok else 1)
