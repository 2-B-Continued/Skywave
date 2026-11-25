"""With the dongle on another computer (RTL_TCP), the sensor decoders read from that rtl_tcp server instead of USB."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import engine, sources
ok = True
def check(n, c, x=""):
    global ok; print(("PASS " if c else "FAIL ") + n, x if not c else ""); ok = ok and bool(c)

check("addresses", sources.remote_addr("pi.local:1234") == ("pi.local", 1234) and sources.remote_addr("10.0.0.5") == ("10.0.0.5", 1234)
      and sources.remote_addr("[fe80::1]:7373") == ("fe80::1", 7373) and sources.remote_addr("fe80::1") == ("fe80::1", 1234))
check("rtl_433's name for a remote server", sources.remote_device("pi.local:1234") == "rtl_tcp:pi.local:1234"
      and sources.remote_device("[fe80::1]:7373") == "rtl_tcp:[fe80::1]:7373")

seen = []
class Stop(Exception): pass
def popen(argv, **k):
    seen.append(argv); raise FileNotFoundError()
engine.subprocess.Popen = popen
class E:
    error = ""
    def __init__(self, remote):
        self.cfg = {"rtl_tcp": remote, "devices": {"radio": 0}, "gain_auto": False, "gain_db": 28.0}
        self.notes = []
    def _fallback_to_listen(self): pass
    def notice(self, m, k): self.notes.append(m)
for remote, want in (("pi.local:1234", "rtl_tcp:pi.local:1234"), ("", "0")):
    seen.clear(); e = E(remote)
    engine.Engine._ism_start(e, {"freq": 433.92e6})
    argv = seen[0]
    check("rtl_433 device %s" % (want,), argv[argv.index("-d") + 1] == want, argv)
check("the gain still applies over rtl_tcp", "-g" in argv)

import shutil
real = shutil.which
engine.shutil.which = lambda n: "/usr/bin/" + n if n == "rtlamr" else None      # rtlamr installed, no rtl_tcp program
e = E("pi.local:1234")
argv, aux, f = engine.Engine._amr_argv(e, 912.6e6)
check("rtlamr uses the remote server directly, no rtl_tcp started here", aux is None and "-server=pi.local:1234" in argv, argv)
e = E("")
argv, aux, f = engine.Engine._amr_argv(e, 912.6e6)
check("without RTL_TCP, rtlamr still needs a local rtl_tcp", argv is None and e.notes, e.notes)
engine.shutil.which = real

msg = sources.explain_failure(["rtl_tcp input: unable to connect to pi.local:1234"], "pi.local:1234")
check("a remote failure is explained as one, not as a USB problem", "pi.local:1234" in msg and "USB" not in msg and "privileged" not in msg, msg)
check("a USB failure is still explained as before", "privileged" in sources.explain_failure(["usb_open error -3"]))
print("ALL PASS" if ok else "SOME FAILED"); sys.exit(0 if ok else 1)
