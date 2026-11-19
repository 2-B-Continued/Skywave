import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import numpy as np
from scipy import signal
import ais

bits_of = ais._bits
frame_bits = ais.frame_bits
sixbit = ais._six
def modulate(bits, noise=0.0, offset=0.15, seed=0):
    x = ais.modulate(bits, 0.6, offset)
    rng = np.random.default_rng(seed)
    return np.concatenate([np.zeros(300), x, np.zeros(300)]) + rng.normal(0, noise, len(x) + 600)

pos = bits_of(1, 6) + bits_of(0, 2) + bits_of(235123456, 30) + bits_of(0, 4) + bits_of(0, 8) + bits_of(123, 10) + [1] \
      + bits_of(int(round(18.4241 * 600000)) & (2**28 - 1), 28) + bits_of(int(round(-33.9249 * 600000)) & (2**27 - 1), 27) \
      + bits_of(900, 12) + bits_of(88, 9) + bits_of(20, 6) + bits_of(0, 2) + bits_of(0, 3) + [0] + bits_of(0, 19)
assert len(pos) == 168
stat = bits_of(5, 6) + bits_of(0, 2) + bits_of(235123456, 30) + bits_of(0, 2) + bits_of(9876543, 30) + sixbit("TEST01", 42) + sixbit("MV NORTH STAR", 120) \
       + bits_of(79, 8) + bits_of(0, 150 - 8 - 0)
stat = stat[:424] + [0] * (424 - len(stat[:424]))
ok = True
for label, noise in (("clean", 0.0), ("noisy", 0.12)):
    sig = np.concatenate([modulate(frame_bits(pos), noise, seed=1), modulate(frame_bits(stat), noise, seed=2), modulate(frame_bits(pos), noise, seed=3)])
    d = ais.AisDecoder(); got = []
    for i in range(0, len(sig), 480): got += d.process(sig[i:i + 480].astype(np.float32))
    print(label, "frames:", d.frames, "bad crc:", d.crc_bad, [(g["type"], g["mmsi"]) for g in got])
    p = [g for g in got if g["type"] == 1]
    ok &= len(p) >= 1 and abs(p[0]["lat"] + 33.9249) < 1e-3 and abs(p[0]["lon"] - 18.4241) < 1e-3 and p[0]["sog"] == 12.3 and p[0]["cog"] == 90.0
    s5 = [g for g in got if g["type"] == 5]
    if label == "clean":
        ok &= len(s5) == 1 and s5[0]["name"] == "MV NORTH STAR" and s5[0]["callsign"] == "TEST01"
        print(d.public()[0])
# garbage must not decode
d = ais.AisDecoder(); rng = np.random.default_rng(9); g = d.process(rng.normal(0, 0.5, 48000 * 5).astype(np.float32)); print("noise frames", d.frames); ok &= d.frames == 0
print("PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
