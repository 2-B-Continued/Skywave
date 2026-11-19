"""The MQTT bridge against a tiny fake broker: it connects with the right credentials, announces sensors to Home
Assistant once, sends readings, and reports a refused login clearly."""
import json, os, socket, struct, sys, threading, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import mqtt

ok = True
def check(name, cond, extra=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name, extra); ok = ok and bool(cond)

got = []
def broker(port_box, want_user="ha", want_pass="pw"):
    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(("127.0.0.1", 0)); srv.listen(4)
    port_box.append(srv.getsockname()[1])
    def rdlen(c):
        m, n, sh = 1, 0, 0
        while True:
            b = c.recv(1)[0]; n += (b & 127) * m; m *= 128
            if not b & 128: return n
    def recvn(c, n):
        d = b""
        while len(d) < n:
            x = c.recv(n - len(d))
            if not x: raise OSError
            d += x
        return d
    def serve(c):
        try:
            while True:
                h = c.recv(1)
                if not h: return
                body = recvn(c, rdlen(c))
                t = h[0] >> 4
                if t == 1:
                    flags = body[7]; p = body[10:]
                    def s(p): n = struct.unpack(">H", p[:2])[0]; return p[2:2 + n].decode(), p[2 + n:]
                    cid, p = s(p)
                    if flags & 4: _, p = s(p); n = struct.unpack(">H", p[:2])[0]; p = p[2 + n:]
                    user, p = s(p) if flags & 0x80 else ("", p)
                    pw, p = s(p) if flags & 0x40 else ("", p)
                    c.sendall(bytes([0x20, 2, 0, 0 if (user, pw) == (want_user, want_pass) else 4]))
                elif t == 3:
                    n = struct.unpack(">H", body[:2])[0]
                    got.append((body[2:2 + n].decode(), body[2 + n:], bool(h[0] & 1)))
                elif t == 12:
                    c.sendall(b"\xd0\x00")
        except OSError:
            pass
    def acc():
        while True:
            c, _ = srv.accept(); threading.Thread(target=serve, args=(c,), daemon=True).start()
    threading.Thread(target=acc, daemon=True).start()

box = []; broker(box)
class Cfg(dict):
    pass
cfg = Cfg(mqtt={"on": True, "host": "127.0.0.1", "port": box[0], "user": "ha", "pass": "pw", "prefix": "skywave", "discovery": True})
okc, msg = mqtt.test_connection(cfg["mqtt"]); check("test connection succeeds", okc, msg)
okc, msg = mqtt.test_connection(dict(cfg["mqtt"], **{"pass": "nope"})); check("wrong password is explained", not okc and "password" in msg, msg)
b = mqtt.Bridge(cfg); b.start()
s = {"key": "x", "model": "Acurite-Tower", "id": 1234, "channel": "A", "temperature_C": 21.5, "humidity": 55, "battery_ok": 1}
for _ in range(3):
    b.hook("sensor", s)
b.hook("sonde", {"serial": "S1", "lat": -33.95, "lon": 18.4, "alt": 1000, "freq": 401.5e6})
time.sleep(2.0)
topics = [g[0] for g in got]
check("bridge connected", b.status == "connected", b.status)
check("online status is retained", ("skywave/status", b"online", True) in got)
conf = [g for g in got if g[0].startswith("homeassistant/sensor/") and g[0].endswith("/config")]
check("discovery announced once per reading type", len(conf) == 3 and all(g[2] for g in conf), str([g[0] for g in conf]))
st = [g for g in got if g[0] == "skywave/sensor/acurite_tower_1234_a/state"]
check("readings sent", len(st) == 3 and json.loads(st[0][1])["temperature_C"] == 21.5)
check("balloon becomes a device tracker", any(t.startswith("homeassistant/device_tracker/") for t in topics) and "skywave/balloon/s1" in topics)
cfg["mqtt"] = dict(cfg["mqtt"], **{"on": False}); b.reconfigure(); time.sleep(1.0)
check("switching off disconnects", b.status == "off", b.status)
print("ALL PASS" if ok else "SOME FAILED"); sys.exit(0 if ok else 1)
