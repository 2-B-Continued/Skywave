"""Receiver lab: settings validate, persist, and really change the signal path (simulator)."""
import sys, time, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import *
import numpy as np, lab
eng, cfg, d = make_engine(); col = Collector(eng)
ok = True
def check(n, c, extra=""):
    global ok; print(("PASS " if c else "FAIL ") + n, extra); ok = ok and bool(c)
eng.command({"cmd": "tune", "freq": 100.0e6}); time.sleep(2.5)
base = len(col.audio_rms)
check("audio flows", col.audio_bytes > 0)
# settings validation and persistence
eng.command({"cmd": "lab", "set": {"nfft": 16384, "window": "blackmanharris", "avg": 99, "bogus": 1, "fps": 20}}); time.sleep(1.5)
check("validated", eng.lab["nfft"] == 16384 and eng.lab["avg"] == 16 and "bogus" not in eng.lab, eng.lab["avg"])
check("saved to disk", json.load(open(os.path.join(d, "lab.json")))["nfft"] == 16384)
check("lab event emitted", col.find("lab"))
n0 = len(col.spectra); time.sleep(2); n1 = len(col.spectra)
check("spectrum frames still 1024 bins at 20 fps", all(len(s[1]) == 1024 for s in col.spectra[-10:]) and (n1 - n0) >= 25, n1 - n0)
check("separate display analyser in use", eng.sv is not None and eng.sv.nfft == 16384)
# front end commands reach the source
eng.command({"cmd": "lab", "set": {"offset_tuning": True, "tuner_agc": True, "direct_mode": "q"}}); time.sleep(1)
check("source told", getattr(eng.src, "offset_tuning", None) is True and eng.src.direct == 2, getattr(eng.src, "direct", None))
# demod chain
eng.command({"cmd": "lab", "set": {"nb_on": True, "notch_on": True, "nr_on": True, "hpf_hz": 100, "lpf_hz": 8000, "bass_db": 3, "agc_mode": "slow", "iq_balance": True, "iq_swap": True}}); time.sleep(3)
check("audio still flows with everything on", np.mean(col.audio_rms[-20:]) > 0.001, np.mean(col.audio_rms[-20:]))
check("no errors", not eng.error and not [e for e in col.events if e.get("type") == "notice" and e.get("level") == "error"], eng.error)
eng.command({"cmd": "mode", "mode": "usb"}); eng.command({"cmd": "lab", "set": {"cw_pitch": 500, "ssb_shift": 200}}); time.sleep(1.5)
check("ssb shift applied", eng.rx.ssb_shift == 200 and eng.rx.cw_pitch == 500)
eng.command({"cmd": "lab", "reset": True}); time.sleep(1)
check("reset", eng.lab == lab.DEFAULTS and eng.sv is None)
print("ALL PASS" if ok else "SOME FAILED"); sys.exit(0 if ok else 1)
