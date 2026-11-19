"""Station name and radio text must appear whole and stay put: no building from the middle, no rebuilding on a bad frame."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import rds
ok = True
def chk(n, c, x=""):
    global ok
    print("ok  " if c else "FAIL", n, x); ok = ok and bool(c)
def g0(d, pi, addr, text):
    d._group({"A": pi, "B": (0 << 12) | addr, "D": (ord(text[0]) << 8) | ord(text[1])})
def g2(d, pi, ab, addr, text):
    t = text.ljust(4)
    d._group({"A": pi, "B": (2 << 12) | (ab << 4) | addr, "C": (ord(t[0]) << 8) | ord(t[1]), "D": (ord(t[2]) << 8) | ord(t[3])})
d = rds.RdsDecoder(); name = "WAVE  FM"; seen = []
# segments arrive out of order, middle first: nothing may show until a full, repeated copy is in
for rep in range(2):
    for addr in (2, 3, 0, 1):
        g0(d, 0x1234, addr, name[addr * 2:addr * 2 + 2]); seen.append(d.info["ps"])
chk("nothing partial was ever shown", all(x in ("", name) for x in seen), sorted(set(seen)))
chk("whole name shown", d.info["ps"] == name, d.info["ps"])
# a corrupted segment arrives once: the name must not change
g0(d, 0x1234, 1, "#X"); chk("one bad segment does not change the name", d.info["ps"] == name)
for addr in range(4): g0(d, 0x1234, addr, name[addr * 2:addr * 2 + 2])
chk("still the name", d.info["ps"] == name)
# the station really changes its name: it switches in one go
new = "NEWS 24H"; shown = set()
for rep in range(3):
    for addr in range(4):
        g0(d, 0x1234, addr, new[addr * 2:addr * 2 + 2]); shown.add(d.info["ps"])
chk("changes whole, never a mixture", shown <= {name, new} and d.info["ps"] == new, shown)
# a different station (PI changes): stale text is dropped
g0(d, 0x9999, 0, "AB"); chk("new station clears old name", d.info["ps"] == "")
# radio text: only whole text, and only once it has come round
rt = "Now playing: Test Song - Artist"; d = rds.RdsDecoder(); got = []
for rep in range(2):
    for addr in range(0, 8):
        g2(d, 0x1234, 0, addr, rt[addr * 4:addr * 4 + 4] if addr * 4 < len(rt) else "\r"); got.append(d.info["rt"])
chk("radio text never partial", all(x in ("", rt) for x in got), sorted(set(got)))
chk("radio text complete", d.info["rt"] == rt, d.info["rt"])
print("PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
