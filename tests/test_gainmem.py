"""Gain remembered per frequency: found once, applied on return without a message, checked quietly, forgotten on request
or when you set the gain yourself."""
import sys, time, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import *
import gainmem
ok = True
def check(n, c, extra=""):
    global ok; print(("PASS " if c else "FAIL ") + n, extra); ok = ok and bool(c)
# the store on its own
import tempfile
p = os.path.join(tempfile.mkdtemp(), "g.json"); m = gainmem.GainMemory(p)
m.put(100.0e6, 29.7, 30)
check("found within reach", m.find(100.05e6)["gain"] == 29.7 and m.find(100.2e6) is None)
check("saved and reloaded", gainmem.GainMemory(p).find(100.0e6)["gain"] == 29.7)
m.put(100.02e6, 19.7, 28); check("a new answer replaces the one right next to it", len(m.items) == 1 and m.find(100.0e6)["gain"] == 19.7)
check("forget", m.forget(100.0e6) and m.find(100.0e6) is None)
# in the engine
eng, cfg, d = make_engine(); col = Collector(eng)
cfg.update({"gain_auto": False, "gain_db": 40.2})
eng.command({"cmd": "tune", "freq": 100.0e6}); time.sleep(3)
eng.command({"cmd": "gain_tune"})
t0 = time.time()
while time.time() - t0 < 30 and (eng.gtune or not col.find("gain_tune")): time.sleep(0.5)
ev = (col.find("gain_tune") or [None])[-1]; chosen = ev and ev.get("chosen")
check("gain finder picks a gain", chosen is not None, ev)
check("remembered for this frequency", eng.gmem.find(100.0e6) and eng.gmem.find(100.0e6)["gain"] == chosen)
check("general gain in Settings left alone", cfg["gain_db"] == 40.2 and not cfg["gain_auto"], cfg["gain_db"])
check("saved to the data folder", json.load(open(os.path.join(d, "gain_memory.json")))["entries"][0]["gain"] == chosen)
n_notes = len([e for e in col.events if e.get("type") == "notice"])
eng.command({"cmd": "tune", "freq": 96.1e6}); time.sleep(2)
check("somewhere else: the general gain", eng.gm_entry is None and eng.src.gain == 40.2, getattr(eng.src, "gain", None))
eng.command({"cmd": "tune", "freq": 100.0e6}); time.sleep(2)
check("back again: the remembered gain is set at once", eng.gm_entry and eng.src.gain == chosen, getattr(eng.src, "gain", None))
st = col.last_state() or {}
time.sleep(1.5); st = col.last_state() or {}
check("state says a remembered gain is in use", st.get("gmem") and st["gmem"]["gain"] == chosen, st.get("gmem"))
time.sleep(6)
check("no message on return, and the quiet check stays quiet", len([e for e in col.events if e.get("type") == "notice"]) == n_notes)
# a check that finds the signal now overloading re-tunes quietly and updates the memory
e = eng.gmem.find(100.0e6); eng.gmem.put(100.0e6, 49.6, e["snr"]); eng._gm_last_q.clear(); time.sleep(1)
t0 = time.time(); saw_quiet = False
while time.time() - t0 < 25:
    st = col.last_state() or {}
    if st.get("gtune") and st["gtune"].get("quiet"): saw_quiet = True
    if saw_quiet and not eng.gtune: break
    time.sleep(0.05)
check("an overloading remembered gain is re-checked quietly", saw_quiet)
check("and replaced with a lower one", eng.gmem.find(100.0e6)["gain"] < 49.6, eng.gmem.find(100.0e6))
check("still no message", len([e for e in col.events if e.get("type") == "notice"]) == n_notes)
# you set the gain yourself: that wins here
eng.command({"cmd": "gain_forget"}); time.sleep(1)
check("forget on request", eng.gmem.find(100.0e6) is None and eng.gm_entry is None)
eng.gmem.put(100.0e6, 25.4, 20); time.sleep(1.5)
check("picked up again when stored", eng.gm_entry and eng.src.gain == 25.4)
cfg.update({"gain_db": 33.8}); eng._config_changed({"gain_db": 33.8}); time.sleep(1)
check("setting the gain yourself forgets the remembered one here", eng.gmem.find(100.0e6) is None)
eng.stop()
print("ALL PASS" if ok else "SOME FAILED"); sys.exit(0 if ok else 1)
