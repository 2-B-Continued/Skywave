import json, os, subprocess, sys, tempfile, time, struct
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wsclient import *

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
d = tempfile.mkdtemp(prefix="rtlst-srv-")
env = dict(os.environ, SIM="1", PORT="18090", DATA_DIR=d, NO_NET="1")
p = subprocess.Popen([sys.executable, "-W", "ignore", "server.py"], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
try:
    time.sleep(2.0)
    base = "http://127.0.0.1:18090"
    print("healthz", get(base + "/healthz")[:2])
    code, body, h = get(base + "/api/hello"); hello = json.loads(body)
    print("api/hello keys", sorted(hello)[:8], "... banks", len(hello["banks"]), "version", hello["version"])
    ws = WS("127.0.0.1", 18090); print("ws handshake:", ws.status)
    op, data = ws.recv(); first = json.loads(data); print("first ws message type:", first["type"], "sim", first["sim"])
    ws.send_json({"cmd": "tune", "freq": 100.0e6, "mode": "wfm"})
    t0 = time.time(); n_a = n_s = 0; got_state = None
    while time.time() - t0 < 4:
        op, data = ws.recv()
        if op == 2:
            if data[0] == 2: n_a += len(data) - 1
            elif data[0] == 1: n_s += 1
        elif op == 1:
            m = json.loads(data)
            if m["type"] == "state": got_state = m
    print("audio bytes %d  spectrum frames %d  state vfo %.1f MHz" % (n_a, n_s, got_state["vfo"] / 1e6))
    # config change
    print("config post:", post(base + "/api/config", {"changes": {"lat": -33.95, "lon": 18.3}})[1]["changed"])
    # bad commands are ignored, not fatal
    ws.send_json({"cmd": "rm -rf"}); ws.send_json({"cmd": "tune", "freq": "bogus"})
    time.sleep(0.8)
    # favourites + banks + recordings + diag + log + passes
    print("favs:", post(base + "/api/favourites", {"list": [{"f": 100000000, "name": "Gold", "mode": "wfm"}]})[1])
    print("bank put:", post(base + "/api/banks", {"id": "mine", "name": "Mine", "channels": [{"f": 146500000, "label": "Calling", "mode": "nfm"}]})[1]["bank"]["name"])
    print("recordings:", json.loads(get(base + "/api/recordings")[1]))
    dg = json.loads(get(base + "/api/diag")[1]); print("diag:", {k: dg[k] for k in ("version", "sim", "job", "kernel_driver")})
    print("passes:", json.loads(get(base + "/api/space/passes")[1])["available"])
    # static
    for path in ("/", "/fonts/B612Mono-Regular.ttf", "/../server.py", "/nothing"):
        try:
            c, b, hh = get(base + path); print("GET", path, c, hh.get("Content-Type"), len(b))
        except Exception as e:
            print("GET", path, "->", getattr(e, "code", e))
    ws.close()
finally:
    p.terminate(); out = p.communicate(timeout=10)[0].decode()
    print("--- server output:\n" + out[-600:])

# auth test
env2 = dict(env, PORT="18091", AUTH_USER="radio", AUTH_PASS="s3cret")
p = subprocess.Popen([sys.executable, "-W", "ignore", "server.py"], cwd=root, env=env2, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
try:
    time.sleep(1.5)
    base = "http://127.0.0.1:18091"
    try: get(base + "/api/hello")
    except Exception as e: print("no auth ->", e.code)
    print("with auth ->", get(base + "/api/hello", auth="radio:s3cret")[0])
    try: get(base + "/api/hello", auth="radio:wrong")
    except Exception as e: print("wrong pw ->", e.code)
    w = WS("127.0.0.1", 18091); print("ws without creds:", w.status.split(" ", 1)[1])
    w2 = WS("127.0.0.1", 18091, auth="radio:s3cret"); print("ws with creds:", w2.status.split(" ", 1)[1])
    print("healthz open:", get(base + "/healthz")[0])
finally:
    p.terminate()
