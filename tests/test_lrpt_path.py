"""Weather-satellite decode path against the REAL meteor_demod (skipped if it is not installed).
Uses a synthetic Meteor-style OQPSK signal in the exact 8-bit I/Q WAV format the record job writes."""
import os, sys, shutil, tempfile, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np, struct
import lrpt_synth, iq_tools

DEMOD = os.environ.get("METEOR_DEMOD_BIN") or shutil.which("meteor_demod") or "/tmp/ext/meteor_demod/build/meteor_demod"
if not os.path.exists(DEMOD) and not shutil.which(DEMOD):
    print("SKIP: meteor_demod not installed"); sys.exit(0)
os.environ["METEOR_DEMOD_BIN"] = DEMOD
os.environ.setdefault("METEOR_DECODE_BIN", "/bin/true")       # frames cannot come from random symbols; only the demod stage is under test
import weather
weather.DECODE = os.environ["METEOR_DECODE_BIN"]
ok = True
def chk(n, c, x=""):
    global ok
    print("ok  " if c else "FAIL", n, x); ok = ok and bool(c)

tmp = tempfile.mkdtemp()
# 1. signal levels line up with what the demodulator can lock on
for snr, want in ((12, "strong"), (6, "good"), (0, "weak")):
    p = os.path.join(tmp, "s%d.wav" % snr); lrpt_synth.make(p, secs=12, snr_db=snr)
    r = iq_tools.signal_report(p, segments=3, seg_s=3); chk("signal level at %d dB SNR" % snr, r["level"] == want, r)
rng = np.random.default_rng(5); n = 288000 * 12; x = rng.normal(size=n) + 1j * rng.normal(size=n)
raw = np.empty(2 * n, np.uint8); raw[0::2] = np.clip(x.real * 40 + 127.5, 0, 255); raw[1::2] = np.clip(x.imag * 40 + 127.5, 0, 255); b = raw.tobytes()
noise = os.path.join(tmp, "noise.wav")
open(noise, "wb").write(b"RIFF" + struct.pack("<I", 36 + len(b)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 2, 288000, 576000, 2, 8) + b"data" + struct.pack("<I", len(b)) + b)
r = iq_tools.signal_report(noise, segments=3, seg_s=3); chk("noise only reads as none", r["level"] == "none", r)

# 2. a recording with a 6 kHz frequency error (Doppler plus an uncalibrated dongle): the first attempt cannot lock, the wide search does
class Cfg:
    def __init__(self, root): self.root = root
    def path_for(self, kind, name=None):
        d = os.path.join(self.root, kind); os.makedirs(d, exist_ok=True); return os.path.join(d, name) if name else d
cfg = Cfg(tmp); events = []
dec = weather.Decoder(cfg, lambda *a, **k: events.append((a, k)), None)
name = "20261111-000000_137.9000MHz_Meteor_iq.wav"
lrpt_synth.make(cfg.path_for("recordings", name), secs=25, snr_db=8, cfo=6000)
import json; json.dump({"freq": 137.9e6, "fs": 288000, "decode": "lrpt", "mod": "oqpsk", "signal": {"level": "good", "db": 8.0}}, open(cfg.path_for("recordings", name) + ".json", "w"))
did = dec.submit(name)
for _ in range(120):
    time.sleep(1)
    if not dec.jobs: break
res = dec.list()[0]
d = res.get("diag") or []
chk("diagnostics recorded", len(d) >= 2, d)
if len(d) >= 2:
    chk("default search cannot find the carrier at +6 kHz (it sticks at its -3.5 kHz limit)", abs(d[0]["carrier_hz"] or 0) < 4000 and abs((d[0]["carrier_hz"] or 0) - 6000) > 2000, d[0])
    chk("wide carrier search finds it at +6 kHz", (d[1]["locked_pct"] or 0) > 50 and abs((d[1]["carrier_hz"] or 0) - 6000) < 300, d[1])
chk("failure message names the right step", "locked" in res.get("error", "") or res.get("ok"), res.get("error", "")[:90])

# 3. nothing in the recording: the message says the satellite could not be detected, and only two attempts are made
name2 = "20261111-000100_137.9000MHz_Meteor_iq.wav"; shutil.copy(noise, cfg.path_for("recordings", name2))
json.dump({"freq": 137.9e6, "fs": 288000, "decode": "lrpt", "mod": "oqpsk", "signal": iq_tools.signal_report(noise, segments=3, seg_s=3)}, open(cfg.path_for("recordings", name2) + ".json", "w"))
dec.submit(name2)
for _ in range(120):
    time.sleep(1)
    if not dec.jobs: break
r2 = [x for x in dec.list() if x["rec"] == name2][0]
chk("no-signal message", "could not be detected" in r2.get("error", ""), r2.get("error", "")[:80])
chk("only two attempts on noise", len(r2.get("diag", [])) <= 2, len(r2.get("diag", [])))
print("PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
