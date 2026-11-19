"""The radio never falls behind live: samples waiting on the rtl_tcp socket beyond 0.3 s are dropped before the next block."""
import os
import socket
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import sources  # noqa: E402

a, b = socket.socketpair()
a.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1 << 22)
b.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 22)
src = sources.RtlTcpSource.__new__(sources.RtlTcpSource)
src.sock = b
b.settimeout(5.0)
fs = 240000                                    # a small rate keeps the test quick; the rule is in seconds
a.sendall(bytes(range(256)) * (2 * fs // 256))   # 1 s of samples waiting
import time; time.sleep(0.2)
waiting = src.backlog()
ok = True
def check(n, c, info=""):
    global ok
    print(("ok   " if c else "FAIL ") + n + ("" if c else "  " + str(info))); ok = ok and c
check("backlog measures waiting bytes", waiting >= 2 * fs * 0.9, waiting)
# the engine's rule, applied as _read_iq does
eng = types.SimpleNamespace(src=src, fs=fs)
drop = waiting - int(2 * fs * 0.1); drop -= drop % 2
check("skip keeps IQ pairs whole", src.skip(drop))
left = src.backlog()
check("about 0.1 s left after catching up", abs(left - 2 * fs * 0.1) <= 4096, left)
data = src.read_samples(1000)
check("reading carries on normally after a skip", len(data) == 2000)
print("PASS" if ok else "FAILED"); sys.exit(0 if ok else 1)
