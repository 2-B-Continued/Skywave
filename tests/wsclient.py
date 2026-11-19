"""Tiny WebSocket + HTTP client used by the server tests."""
import base64, json, os, socket, struct, urllib.request


class WS:
    def __init__(self, host, port, path="/ws", auth=None):
        self.s = socket.create_connection((host, port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        h = "GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n" % (path, host, port, key)
        if auth:
            h += "Authorization: Basic %s\r\n" % base64.b64encode(auth.encode()).decode()
        self.s.sendall((h + "\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            d = self.s.recv(1)
            if not d: raise EOFError
            buf += d
        self.status = buf.split(b"\r\n")[0].decode()

    def _rx(self, n):
        b = b""
        while len(b) < n:
            d = self.s.recv(n - len(b))
            if not d: raise EOFError
            b += d
        return b

    def recv(self):
        b1, b2 = self._rx(2)
        n = b2 & 0x7F
        if n == 126: n = struct.unpack(">H", self._rx(2))[0]
        elif n == 127: n = struct.unpack(">Q", self._rx(8))[0]
        return b1 & 0xF, self._rx(n)

    def send_json(self, obj):
        data = json.dumps(obj).encode()
        mask = os.urandom(4)
        n = len(data)
        hdr = bytes([0x81])
        if n < 126: hdr += bytes([0x80 | n])
        elif n < 65536: hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
        else: hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def close(self):
        try: self.s.close()
        except OSError: pass


def get(url, auth=None):
    req = urllib.request.Request(url)
    if auth: req.add_header("Authorization", "Basic " + base64.b64encode(auth.encode()).decode())
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, r.read(), r.headers


def post(url, obj):
    req = urllib.request.Request(url, data=json.dumps(obj).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, json.loads(r.read())
