"""RDS and stereo decoding against a synthetic FM broadcast signal."""
import os, sys
import numpy as np
from scipy import signal
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import rds

FS = 240000
ok = True
def check(name, cond, extra=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name, extra)
    ok &= bool(cond)

def groups(ps="RTLTEST1", rt="Hello from Skywave test", pi=0x4A21, pty=10):
    out = []
    ps = ps.ljust(8)[:8]
    rt = rt.ljust(64)[:64]
    for rep in range(40):
        for a in range(4):
            B = (0 << 12) | (0 << 11) | (1 << 10) | (pty << 5) | (1 << 3) | a
            out += [(pi, "A"), (B, "B"), (pi, "C'"), ((ord(ps[2*a]) << 8) | ord(ps[2*a+1]), "D")]
        for a in range(8):
            B = (2 << 12) | (1 << 10) | (pty << 5) | a
            c = rt[a*4:a*4+4]
            out += [(pi, "A"), (B, "B"), ((ord(c[0]) << 8) | ord(c[1]), "C"), ((ord(c[2]) << 8) | ord(c[3]), "D")]
    return out

def bits_of(gs):
    bits = []
    for data, name in gs:
        w = rds.block(data, name)
        bits += [(w >> i) & 1 for i in range(25, -1, -1)]
    return np.array(bits)

def make_mpx(seconds, with_rds=True, left=0.5, right=0.0, f=1000.0):
    n = int(FS * seconds); t = np.arange(n) / FS
    L = left * np.sin(2*np.pi*f*t); R = right * np.sin(2*np.pi*f*t)
    ph = 2*np.pi*19000*t
    mpx = 0.45 * (L + R) + 0.09 * np.sin(ph) + 0.45 * (L - R) * np.sin(2*ph)
    if with_rds:
        bits = bits_of(groups())
        d = np.zeros(len(bits), dtype=int); prev = 0
        for i, b in enumerate(bits):
            prev ^= b; d[i] = prev
        pos = t * rds.RDS_BAUD
        k = np.minimum(pos.astype(int), len(d) - 1)
        frac = pos - np.floor(pos)
        sym = (2 * d[k] - 1) * np.where(frac < 0.5, 1.0, -1.0)
        mpx = mpx + 0.04 * sym * np.sin(3 * ph)
    return mpx.astype(np.float32)

mpx = make_mpx(9.0)
p = rds.Pilot(); dec = rds.RdsDecoder()
for i in range(0, len(mpx) - 2400, 2400):
    dm, u = p.process(mpx[i:i+2400])
    dec.process(dm, u)
info = dec.public()
check("pilot locked", p.locked, "amp %.3f" % p.amp)
check("PI decoded", info["pi_hex"] == "4A21", info["pi_hex"])
check("PS decoded", info["ps"] == "RTLTEST1", repr(info["ps"]))
check("RadioText decoded", info["rt"].startswith("Hello from Skywave"), repr(info["rt"]))
check("PTY decoded", info["pty"] == 10 and info["pty_name"] == "Pop music", info["pty_name"])
check("few errors", dec.errors < max(5, dec.groups * 0.2), "groups %d errors %d" % (dec.groups, dec.errors))
# no RDS in the signal: nothing is invented
mpx0 = make_mpx(4.0, with_rds=False)
p = rds.Pilot(); dec = rds.RdsDecoder()
for i in range(0, len(mpx0) - 2400, 2400):
    dm, u = p.process(mpx0[i:i+2400]); dec.process(dm, u)
check("no false RDS", dec.public()["ps"] == "" and dec.groups < 3, "groups %d" % dec.groups)

# ---- whole receiver chain: FM-modulate at 240 kS/s, up to 2.4 MS/s, demodulate stereo + RDS
import dsp
mpx = make_mpx(7.0, left=0.5, right=0.0)
ph = np.cumsum(mpx.astype(np.float64)) * 2 * np.pi * 75000 / FS
iq240 = np.exp(1j * ph).astype(np.complex64)
iq = signal.resample_poly(iq240, 10, 1).astype(np.complex64)
rx = dsp.Receiver(2400000, 50.0); rx.configure("wfm"); rx.stereo_on = True; rx.rds_on = True
Ls, Rs, mono = [], [], []
CH = 48000
for i in range(0, len(iq) - CH, CH):
    a = rx.process(iq[i:i+CH], 0.0)
    mono.append(a)
    if rx.side is not None:
        Ls.append(a + rx.side); Rs.append(a - rx.side)
check("stereo detected", rx.stereo_active)
L = np.concatenate(Ls)[48000:]; R = np.concatenate(Rs)[48000:]
sep = 10 * np.log10((np.mean(L**2) + 1e-12) / (np.mean(R**2) + 1e-12))
check("channel separation > 20 dB", sep > 20, "%.1f dB" % sep)
pk = np.abs(np.fft.rfft(L * np.hanning(len(L)))); fpk = np.argmax(pk) * 48000 / len(L)
check("left tone is 1 kHz", abs(fpk - 1000) < 20, "%.0f Hz" % fpk)
info = rx.rds.public()
check("RDS through the receiver", info["ps"] == "RTLTEST1" and info["pi_hex"] == "4A21", repr(info["ps"]))
# the new modes run
for m in ("dsb", "raw", "am", "usb"):
    r2 = dsp.Receiver(2400000); r2.configure(m)
    t = np.arange(CH * 10) / 2.4e6
    tone = ((1 + 0.5 * np.sin(2*np.pi*1000*t)) * np.exp(2j*np.pi*5000*t)).astype(np.complex64)
    out = np.concatenate([r2.process(tone[i:i+CH], 5000.0) for i in range(0, len(tone), CH)])[2400:]
    check("mode %s produces audio" % m, np.std(out) > 0.01, "rms %.3f" % np.std(out))
print("ALL PASS" if ok else "SOME FAILED")
sys.exit(0 if ok else 1)
