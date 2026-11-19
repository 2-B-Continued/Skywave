"""mqtt.py - sends sensor readings (and weather balloons) to an MQTT broker, so Home Assistant and similar tools can
use them. A small MQTT 3.1.1 publisher written here (QoS 0, keep-alive, last will), so nothing extra is installed.

Home Assistant discovery: every reading a sensor reports (temperature, humidity, wind...) appears in Home Assistant by
itself as a sensor under one device per transmitter. Balloons appear as device trackers.
"""
import json
import queue
import socket
import struct
import threading
import time

# rtl_433 field -> (name, unit, Home Assistant device class)
FIELDS = {
    "temperature_C": ("Temperature", "°C", "temperature"), "temperature_F": ("Temperature", "°F", "temperature"),
    "humidity": ("Humidity", "%", "humidity"), "pressure_hPa": ("Pressure", "hPa", "pressure"), "pressure_kPa": ("Pressure", "kPa", "pressure"),
    "wind_avg_km_h": ("Wind speed", "km/h", "wind_speed"), "wind_max_km_h": ("Wind gust", "km/h", "wind_speed"),
    "wind_avg_m_s": ("Wind speed", "m/s", "wind_speed"), "wind_max_m_s": ("Wind gust", "m/s", "wind_speed"),
    "wind_dir_deg": ("Wind direction", "°", None), "rain_mm": ("Rain", "mm", "precipitation"), "rain_rate_mm_h": ("Rain rate", "mm/h", "precipitation_intensity"),
    "moisture": ("Moisture", "%", "moisture"), "light_lux": ("Light", "lx", "illuminance"), "uv": ("UV index", None, None),
    "battery_ok": ("Battery OK", None, None), "battery_V": ("Battery", "V", "voltage"), "rssi": ("Signal", "dB", None), "snr": ("Signal to noise", "dB", None),
    "power_W": ("Power", "W", "power"), "energy_kWh": ("Energy", "kWh", "energy"), "co2_ppm": ("CO2", "ppm", "carbon_dioxide"),
    "pressure_PSI": ("Tyre pressure", "psi", "pressure"),
}


def _str(s):
    b = s.encode("utf-8")
    return struct.pack(">H", len(b)) + b


def _len(n):
    out = bytearray()
    while True:
        d, n = n % 128, n // 128
        out.append(d | (0x80 if n else 0))
        if not n:
            return bytes(out)


def packet_connect(client_id, user="", pw="", will_topic=None, will_msg=b"", keepalive=60):
    flags = 0x02
    payload = _str(client_id)
    if will_topic:
        flags |= 0x04 | 0x20                     # will, retained
        payload += _str(will_topic) + struct.pack(">H", len(will_msg)) + will_msg
    if user:
        flags |= 0x80
        payload += _str(user)
        if pw:
            flags |= 0x40
            payload += _str(pw)
    var = _str("MQTT") + bytes([4, flags]) + struct.pack(">H", keepalive)
    body = var + payload
    return bytes([0x10]) + _len(len(body)) + body


def packet_publish(topic, payload, retain=False):
    body = _str(topic) + payload
    return bytes([0x30 | (1 if retain else 0)]) + _len(len(body)) + body


def _uid(s):
    return "".join(ch if ch.isalnum() else "_" for ch in str(s)).strip("_").lower()[:60] or "x"


class Bridge(threading.Thread):
    def __init__(self, cfg):
        super().__init__(daemon=True, name="mqtt")
        self.cfg = cfg
        self.q = queue.Queue(maxsize=500)
        self.sock = None
        self.status = "off"
        self.announced = set()
        self.last_ping = 0.0
        self._kick = threading.Event()
        self.sent = 0

    # ---- what the rest of the app calls
    def hook(self, kind, d):
        m = self.cfg.get("mqtt") or {}
        if not m.get("on") or not m.get("host"):
            return
        try:
            self.q.put_nowait((kind, dict(d)))
        except queue.Full:
            pass

    def reconfigure(self):
        self._close("off")
        self.announced.clear()
        self._kick.set()

    # ---- the thread
    def run(self):
        backoff = 2.0
        while True:
            m = self.cfg.get("mqtt") or {}
            if not m.get("on") or not m.get("host"):
                self._close("off")
                self._kick.wait(5.0)
                self._kick.clear()
                continue
            if self.sock is None:
                if not self._connect(m):
                    self._kick.wait(backoff)
                    self._kick.clear()
                    backoff = min(backoff * 2, 60.0)
                    continue
                backoff = 2.0
            try:
                kind, d = self.q.get(timeout=5.0)
            except queue.Empty:
                kind = None
            try:
                if kind:
                    self._send(kind, d, m)
                if time.time() - self.last_ping > 30:
                    self.sock.sendall(b"\xc0\x00")         # PINGREQ
                    self.last_ping = time.time()
                    self._drain()
            except OSError as e:
                self._close("Lost the connection: %s" % e)

    def _connect(self, m):
        try:
            s = socket.create_connection((m["host"], int(m.get("port") or 1883)), timeout=6)
            s.settimeout(6)
            pre = m.get("prefix") or "skywave"
            s.sendall(packet_connect("skywave-" + _uid(socket.gethostname())[:16], m.get("user", ""), m.get("pass", ""),
                                     pre + "/status", b"offline"))
            ack = s.recv(4)
            if len(ack) < 4 or ack[0] != 0x20:
                s.close()
                self.status = "The broker did not answer like an MQTT server."
                return False
            if ack[3] != 0:
                s.close()
                self.status = {4: "The broker refused the user name or password.", 5: "The broker says this client is not allowed."}.get(ack[3], "The broker refused the connection (code %d)." % ack[3])
                return False
            s.settimeout(2)
            self.sock = s
            self.sock.sendall(packet_publish(pre + "/status", b"online", retain=True))
            self.status = "connected"
            self.last_ping = time.time()
            return True
        except OSError as e:
            self.status = "Can't reach %s:%s (%s)." % (m.get("host"), m.get("port"), getattr(e, "strerror", None) or e)
            return False

    def _drain(self):
        try:
            self.sock.setblocking(False)
            while self.sock.recv(256):
                pass
        except (BlockingIOError, OSError):
            pass
        finally:
            if self.sock:
                self.sock.settimeout(2)

    def _close(self, status):
        if self.sock:
            try:
                self.sock.sendall(b"\xe0\x00")              # DISCONNECT
                self.sock.close()
            except OSError:
                pass
        self.sock = None
        self.status = status

    def _pub(self, topic, obj, retain=False):
        data = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.sock.sendall(packet_publish(topic, data, retain))
        self.sent += 1

    def _send(self, kind, d, m):
        pre = m.get("prefix") or "skywave"
        disc = m.get("discovery", True)
        dev_extra = {"manufacturer": "Skywave", "via_device": "skywave"}
        if kind == "sensor":
            uid = _uid("%s_%s_%s" % (d.get("model"), d.get("id", ""), d.get("channel", "")))
            state = {k: v for k, v in d.items() if isinstance(v, (int, float, str, bool)) and k not in ("key",)}
            topic = "%s/sensor/%s/state" % (pre, uid)
            if disc:
                for f, (name, unit, dc) in FIELDS.items():
                    if f not in d or (uid, f) in self.announced:
                        continue
                    self.announced.add((uid, f))
                    conf = {"name": name, "unique_id": "skywave_%s_%s" % (uid, _uid(f)), "state_topic": topic,
                            "value_template": "{{ value_json.%s }}" % f, "availability_topic": pre + "/status",
                            "device": dict(dev_extra, identifiers=["skywave_" + uid], name="%s %s" % (d.get("model"), d.get("id", "")), model=str(d.get("model")))}
                    if unit:
                        conf["unit_of_measurement"] = unit
                    if dc:
                        conf["device_class"] = dc
                    if dc or unit:
                        conf["state_class"] = "total_increasing" if f in ("rain_mm", "energy_kWh") else "measurement"
                    self._pub("homeassistant/sensor/skywave_%s/%s/config" % (uid, _uid(f)), conf, retain=True)
            self._pub(topic, state)
        elif kind == "sonde" and d.get("lat") is not None:
            uid = _uid(d.get("serial"))
            topic = "%s/balloon/%s" % (pre, uid)
            if disc and (uid, "trk") not in self.announced:
                self.announced.add((uid, "trk"))
                self._pub("homeassistant/device_tracker/skywave_balloon_%s/config" % uid,
                          {"name": "Balloon %s" % d.get("serial"), "unique_id": "skywave_balloon_" + uid, "json_attributes_topic": topic,
                           "availability_topic": pre + "/status", "source_type": "gps",
                           "device": dict(dev_extra, identifiers=["skywave_balloon_" + uid], name="Weather balloon %s" % d.get("serial"))}, retain=True)
            self._pub(topic, {"latitude": d["lat"], "longitude": d["lon"], "gps_accuracy": 20, "altitude": d.get("alt"),
                              "climb": d.get("climb"), "speed": d.get("speed"), "burst": d.get("burst"), "frequency_mhz": round(d.get("freq", 0) / 1e6, 3)})


def test_connection(m, timeout=5):
    """Try the broker once with these settings; returns (ok, message)."""
    try:
        s = socket.create_connection((m["host"], int(m.get("port") or 1883)), timeout=timeout)
        s.settimeout(timeout)
        s.sendall(packet_connect("skywave-test", m.get("user", ""), m.get("pass", "")))
        ack = s.recv(4)
        s.sendall(b"\xe0\x00")
        s.close()
    except OSError as e:
        return False, "Can't reach %s:%s (%s)." % (m.get("host"), m.get("port"), getattr(e, "strerror", None) or e)
    if len(ack) < 4 or ack[0] != 0x20:
        return False, "Something answered, but it is not an MQTT broker."
    if ack[3]:
        return False, {4: "The broker refused the user name or password.", 5: "The broker says this client is not allowed."}.get(ack[3], "Refused (code %d)." % ack[3])
    return True, "Connected. Sensor readings will appear in Home Assistant as they arrive."
