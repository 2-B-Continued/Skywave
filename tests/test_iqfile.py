"""Play back a recorded IQ file through the whole engine and hear the station inside it."""
import sys, time, os, struct
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import *
import numpy as np

eng, cfg, d = make_engine()
col = Collector(eng)
fs, secs, centre = 2400000, 3, 101.0e6
t = np.arange(fs * secs) / fs
# an AM station 300 kHz above the centre, 1 kHz tone, 80 % depth
iq = (1 + 0.8 * np.sin(2 * np.pi * 1000 * t)) * np.exp(2j * np.pi * 300e3 * t) * 0.35
raw = np.empty(2 * len(iq), np.uint8)
raw[0::2] = np.clip(127.5 + 127 * iq.real, 0, 255); raw[1::2] = np.clip(127.5 + 127 * iq.imag, 0, 255)
path = cfg.path_for("recordings", "test_baseband.wav"); os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "wb") as f:
    f.write(b"RIFF" + struct.pack("<I", 36 + len(raw)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 2, fs, fs * 2, 2, 8) + b"data" + struct.pack("<I", len(raw)))
    f.write(raw.tobytes())
ch = cfg.update({"iq_file": "test_baseband.wav", "iq_center": centre}); eng.command({"cmd": "config", "changed": ch})
eng.command({"cmd": "tune", "freq": centre + 300e3, "mode": "am"})
time.sleep(5)
st = col.last_state()
rms = np.median([r for r in col.audio_rms if r > 0] or [0])
print("job", st["job"], "center", st["center"], "vfo", st["vfo"], "error", repr(st["error"]), "device", st["device"].get("name"), "rms", rms)
ok = st["center"] == centre and "test_baseband" in (st["device"].get("name") or "") and rms > 0.02 and not st["error"]
# tuning elsewhere in the file keeps the window fixed
eng.command({"cmd": "tune", "freq": centre + 300e3, "mode": "am", "recenter": True}); time.sleep(1)
ok &= col.last_state()["center"] == centre
eng.stop(); eng.join(5)
print("PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
