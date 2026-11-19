import os, sys, time, json, stat, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import make_engine, Collector
d0 = tempfile.mkdtemp(prefix="amr-")
tcp = os.path.join(d0, "fake_rtl_tcp_bin.py"); amr = os.path.join(d0, "fake_rtlamr.py")
open(tcp, "w").write('''import socket, sys, time
a = sys.argv; port = int(a[a.index("-p") + 1])
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", port)); s.listen(5)
while True:
    c, _ = s.accept(); c.close()
''')
open(amr, "w").write('''import json, sys, time
assert any(x.startswith("-server=127.0.0.1:") for x in sys.argv), sys.argv
for i in range(3):
    print(json.dumps({"Time": "2026-11-11T10:00:00Z", "Type": "SCM", "Message": {"ID": 12345678, "Type": 7, "Consumption": 1000 + i, "Tamper": 0}}), flush=True); time.sleep(0.3)
time.sleep(30)
''')
for f in (tcp, amr): os.chmod(f, 0o755)
os.environ["RTLAMR_BIN"] = "python3 " + amr; os.environ["RTL_TCP_BIN"] = "python3 " + tcp
import shutil; 
eng, cfg, d = make_engine(); col = Collector(eng)
eng.command({"cmd": "job", "name": "ism", "params": {"freq": 912.6e6, "tool": "rtlamr"}})
e = col.wait_for("sensor", 15, lambda e: True)
ok = bool(e) and e.get("model") == "rtlamr-SCM" and e.get("id") == 12345678 and e.get("consumption", 0) >= 1000
print("sensor event:", e)
eng.command({"cmd": "job", "name": "listen"}); time.sleep(1.5)
import subprocess
left = subprocess.run("pgrep -f '[f]ake_rtl_tcp_bin.py'", shell=True, capture_output=True).stdout.strip()
print("helper server stopped:", not left); ok &= not left
# not installed -> graceful
os.environ["RTLAMR_BIN"] = "definitely-not-installed"
eng.command({"cmd": "job", "name": "ism", "params": {"freq": 912.6e6, "tool": "rtlamr"}}); time.sleep(2)
print("job after missing tool:", eng.job); ok &= eng.job == "listen"
print("PASS" if ok else "FAIL"); eng.close() if hasattr(eng, "close") else None; os._exit(0 if ok else 1)
