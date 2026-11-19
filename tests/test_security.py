import base64, http.client, os, socket, subprocess, sys, tempfile, time
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
def boot(port, **extra):
    d = tempfile.mkdtemp(prefix="sec-")
    env = dict(os.environ, SIM="1", PORT=str(port), DATA_DIR=d, NO_NET="1", SETUP_DONE="1", **extra)
    p = subprocess.Popen([sys.executable, "-W", "ignore", "server.py"], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(60):
        try: socket.create_connection(("127.0.0.1", port), 0.5).close(); break
        except OSError: time.sleep(0.3)
    return p
def req(port, method, path, headers=None, body=None, timeout=8):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    c.request(method, path, body=body, headers=headers or {}); r = c.getresponse(); data = r.read(); h = dict(r.getheaders()); c.close(); return r.status, h, data
ok = True
def chk(n, c, x=""):
    global ok; print("ok  " if c else "FAIL", n, x); ok &= bool(c)
p = boot(18110)
try:
    P = 18110
    s, h, _ = req(P, "GET", "/api/hello")
    chk("api works", s == 200); chk("security headers", h.get("X-Content-Type-Options") == "nosniff" and h.get("X-Frame-Options") == "DENY" and "frame-ancestors" in h.get("Content-Security-Policy", ""), h.get("X-Frame-Options"))
    s, _, _ = req(P, "POST", "/api/reset", {"Origin": "http://evil.example", "Content-Type": "text/plain"}, "{}"); chk("cross-site POST refused", s == 403, s)
    s, _, _ = req(P, "POST", "/api/ping", {"Origin": "http://127.0.0.1:%d" % P}, "{}"); chk("same-site POST allowed", s != 403, s)
    s, _, _ = req(P, "POST", "/api/ping", {}, "{}"); chk("no-Origin POST (curl) allowed", s != 403, s)
    s, _, _ = req(P, "GET", "/ws", {"Origin": "http://evil.example", "Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Key": "x" * 22 + "==", "Sec-WebSocket-Version": "13"}); chk("cross-site WebSocket refused", s == 403, s)
    s, _, _ = req(P, "GET", "/stream.mp3", {"Origin": "http://evil.example"}); chk("cross-site stream refused", s == 403, s)
    s, _, _ = req(P, "POST", "/api/ping", {"Content-Length": "-5"}); chk("negative length rejected quickly", s == 400, s)
    s, _, _ = req(P, "POST", "/api/ping", {"Content-Length": "99999999"}, ""); chk("huge length rejected", s in (400, 413), s)
    s, _, _ = req(P, "POST", "/api/ping", {}, "[1,2]"); chk("non-object body rejected", s == 400, s)
    for path in ("/rec/..%2f..%2f..%2fetc%2fpasswd", "/rec/../../../etc/passwd", "/txt/..%2f..%2fetc%2fpasswd", "/..%2f..%2fetc%2fpasswd", "/%2e%2e/%2e%2e/etc/passwd", "/dec/..%2f..%2fetc%2fpasswd"):
        s, _, d = req(P, "GET", path); chk("traversal blocked " + path, s in (404, 400) and b"root:" not in d, s)
    # slow client does not hold a thread forever (timeout 30 s is long; just check the server still answers while one sits idle)
    idle = socket.create_connection(("127.0.0.1", P)); s, _, _ = req(P, "GET", "/healthz"); chk("server responsive with idle client", s == 200); idle.close()
finally:
    p.terminate()
p = boot(18111, AUTH_USER="u", AUTH_PASS="p@ss")
try:
    P = 18111
    s, h, _ = req(P, "GET", "/api/hello"); chk("auth: no credentials -> 401", s == 401 and "WWW-Authenticate" in h, s)
    t = time.time(); s, _, _ = req(P, "GET", "/api/hello", {"Authorization": "Basic " + base64.b64encode(b"u:wrong").decode()}); chk("auth: wrong password -> 401 (delayed)", s == 401 and time.time() - t > 0.5, s)
    s, _, _ = req(P, "GET", "/api/hello", {"Authorization": "Basic " + base64.b64encode(b"u:p@ss").decode()}); chk("auth: right password -> 200", s == 200, s)
    s, _, _ = req(P, "GET", "/stream.mp3"); chk("auth: stream needs sign-in", s == 401, s)
    s, _, _ = req(P, "GET", "/healthz"); chk("healthz open", s == 200)
finally:
    p.terminate()
print("PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
