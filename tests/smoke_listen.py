import sys, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import *
import numpy as np

eng, cfg, d = make_engine()
col = Collector(eng)
eng.command({"cmd": "tune", "freq": 100.0e6, "mode": "wfm"})
time.sleep(4.0)
st = col.last_state()
print("state:", {k: st[k] for k in ("job", "center", "vfo", "mode", "status", "snr", "gate", "error")})
print("spectra:", len(col.spectra), "audio bytes:", col.audio_bytes, "audio rms (median, non-silent frames):",
      np.median([r for r in col.audio_rms if r > 0] or [0]))
h, sp = col.spectra[-1]
print("spectrum header center MHz", h[1] / 1e6, "fs", h[2], "bins", len(sp), "peak bin", int(sp.argmax()),
      "-> MHz", (h[1] + (int(sp.argmax()) - 512) * h[2] / 1024) / 1e6)
# drive across the band: tune far away to trigger a recenter
eng.command({"cmd": "tune", "freq": 106.5e6, "mode": "wfm"})
time.sleep(2.5)
st = col.last_state(); print("after tune 106.5: center", st["center"] / 1e6, "vfo", st["vfo"] / 1e6, "snr", st["snr"])
eng.stop(); eng.join(5)
