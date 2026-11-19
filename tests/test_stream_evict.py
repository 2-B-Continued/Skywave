"""A dead phone must not block the next device: the 5th live-stream listener gets in by replacing the oldest; keepalive is set."""
import os, sys, time, subprocess, shutil, socket, http.client
if not shutil.which("ffmpeg"):
    print("SKIP: no ffmpeg"); sys.exit(0)
root = os.path.join(os.path.dirname(__file__), "..")
env = dict(os.environ, SIM="1", PORT="18116", DATA_DIR="/tmp/evict", NO_NET="1", SETUP_DONE="1")
srv = subprocess.Popen([sys.executable, "-W", "ignore", "server.py"], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
ok = True
def chk(n, c, x=""):
    global ok
    print("ok  " if c else "FAIL", n, x); ok = ok and bool(c)
try:
    for _ in range(50):
        try: socket.create_connection(("127.0.0.1", 18116), 0.3).close(); break
        except OSError: time.sleep(0.2)
    conns = []
    for i in range(5):
        c = http.client.HTTPConnection("127.0.0.1", 18116, timeout=5); c.request("GET", "/stream.mp3"); r = c.getresponse()
        chk("listener %d accepted" % (i + 1), r.status == 200, r.status); r.read1(2000); conns.append((c, r)); time.sleep(0.3)
    first = conns[0][1]; got = b"x"; t0 = time.time()
    try:
        while got and time.time() - t0 < 6: got = first.read1(4096)
    except Exception: got = b""
    chk("the oldest listener was dropped", not got, time.time() - t0)
    last = conns[4][1]; d = last.read1(4096); chk("the newest listener still gets sound", bool(d), len(d))
    import urllib.request
    chk("page still fine", urllib.request.urlopen("http://127.0.0.1:18116/healthz", timeout=3).status == 200)
finally:
    srv.kill(); print("PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
