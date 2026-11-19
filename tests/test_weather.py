"""Pipeline test for the weather decoder using stand-in decoder programs (no real satellite signal needed)."""
import os, sys, time, json, struct, tempfile, shutil
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
here = os.path.dirname(os.path.abspath(__file__))
os.environ["METEOR_DEMOD_BIN"] = os.path.join(here, "bin", "meteor_demod")
os.environ["METEOR_DECODE_BIN"] = os.path.join(here, "bin", "meteor_decode")
import config as C, weather, space as S, engine

tmp = tempfile.mkdtemp()
os.environ["DATA_DIR"] = tmp
cfg = C.Config()
sp = S.Space(cfg)
ev = []
d = weather.Decoder(cfg, lambda t, **k: ev.append((t, k)), sp)
name = "20261102-101500_137.1000MHz_meteor-m2-4_iq.wav"
p = cfg.path_for("recordings", name)
with open(p, "wb") as f:
    f.write(b"RIFF" + struct.pack("<I", 36 + 2048000) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 2, 1024000, 2048000, 2, 8) + b"data" + struct.pack("<I", 2048000) + b"\x80" * 2048000)
json.dump({"kind": "iq", "freq": 137.1e6, "sat": "meteor-m2-4", "sat_name": "Meteor-M2-4 (weather satellite)", "norad": 59051, "decode": "lrpt", "mod": "oqpsk",
           "t0": time.time() - 900, "t1": time.time() - 200, "max_el": 62.0, "lat": -33.92, "lon": 18.42, "fs": 1024000}, open(p + ".json", "w"))
did = d.submit(name)
for _ in range(200):
    time.sleep(0.2)
    if any(t == "decode_done" for t, _k in ev):
        break
res = [r for r in d.list() if r["id"] == did][0]
print("ok:", res["ok"], "images:", [i["file"] for i in res["images"]], "report:", res.get("report"), "method:", res.get("method"), "rs:", res.get("rs_errors"))
assert res["ok"] and res["report"] and len(res["images"]) == 4
pdf = d.file_path(did, "report.pdf")
print("pdf bytes", os.path.getsize(pdf))
assert open(pdf, "rb").read(5) == b"%PDF-"
shutil.copy(pdf, os.environ.get("KEEP_PDF", "/tmp/test_report.pdf"))
# a non-weather recording is refused politely
bad = "20261102-101500_145.8000MHz_voice_iq.wav"
open(cfg.path_for("recordings", bad), "wb").write(open(p, "rb").read())
try:
    d.submit(bad); time.sleep(1.5)
    r = [x for x in d.list() if x["id"] == bad[:-4]][0]
    print("non-weather:", r.get("ok"), r.get("error", "")[:70])
    assert not r.get("ok")
except ValueError as e:
    print("refused:", e)
print("PASS")
