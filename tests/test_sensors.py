"""Sensors: remembered between restarts, named, yours or hidden, a 24-hour history for real sensors, none for passing cars."""
import sys, os, time, json, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["RTL433_BIN"] = "python3 " + os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin", "fake_rtl433.py")
os.environ["FAKE433_FAST"] = "1"
from harness import *
import sensorstore
ok = True
def check(n, c, x=""):
    global ok; print(("PASS " if c else "FAIL ") + n, x); ok = ok and bool(c)
p = os.path.join(tempfile.mkdtemp(), "s.json"); st = sensorstore.SensorStore(p)
t = 1_800_000_000
for i in range(5): st.update({"model": "Nexus-TH", "id": 7, "channel": 1, "temperature_C": 20 + i, "humidity": 50}, t + i * 400)
k = "Nexus-TH|7|1"
h = st.history(k)
check("history in 5-minute steps, from the third message", len(h["temperature_C"]) == 3 and h["temperature_C"][-1][1] == 24, h)
for i in range(3): st.update({"model": "Toyota", "type": "TPMS", "id": "ab12", "pressure_PSI": 33}, t + i)
check("no history for tyre sensors", st.history("Toyota|ab12|") == {})
st.set(k, name="Garden", mine=True); st.save(force=True)
st2 = sensorstore.SensorStore(p)
check("named and yours, kept after a restart", st2.devs[k]["name"] == "Garden" and st2.devs[k]["mine"] and len(st2.history(k)["temperature_C"]) == 3)
st2.set(k, hidden=True); check("hiding one of yours makes it not yours", st2.devs[k]["hidden"] and not st2.devs[k]["mine"])
st2.update({"model": "Old", "id": 1}, t - 5 * 86400); st2.prune(t)
check("old unmarked sensors are forgotten, marked ones kept", "Old|1|" not in st2.devs and k in st2.devs)
check("forget", st2.forget(k) and k not in st2.devs)
# with the engine and a stand-in decoder
eng, cfg, d = make_engine(); col = Collector(eng)
eng.command({"cmd": "job", "name": "ism", "params": {"freq": 433.92e6}}); time.sleep(6)
keys = list(eng.sensors)
check("the decoder's sensors arrive", any("Fineoffset-WH24" in x for x in keys) and any("Toyota" in x for x in keys), keys)
st = col.last_state() or {}
check("state says what the decoder is doing", st.get("ism") and st["ism"]["freq"] == 433.92e6 and st["ism"]["n"] > 3, st.get("ism"))
eng.command({"cmd": "job", "name": "ism", "params": {"freq": 433.92e6, "freqs": [433.92e6, 868.3e6]}}); time.sleep(3)
st = col.last_state() or {}
check("hopping between two frequencies", st.get("ism") and st["ism"]["freqs"] == [433.92e6, 868.3e6], st.get("ism"))
eng.stop()
print("ALL PASS" if ok else "SOME FAILED"); sys.exit(0 if ok else 1)
