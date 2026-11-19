#!/usr/bin/env python3
"""Stands in for rtl_433 in tests: prints JSON lines like the real decoder with -F json -M level.
A garden weather station, two thermometers (one with a flat battery), an energy monitor, a doorbell now and then,
and tyre sensors from passing cars (a new ID each time). FAKE433_FAST=1 sends everything quickly."""
import json, random, sys, time
fast = __import__("os").environ.get("FAKE433_FAST") == "1"
t0 = time.time(); n = 0
def out(d):
    d.update({"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "rssi": round(random.uniform(-18, -2), 1), "snr": round(random.uniform(8, 30), 1), "noise": -24.0})
    print(json.dumps(d), flush=True)
while True:
    n += 1; m = (time.time() - t0) / 60
    out({"model": "Fineoffset-WH24", "id": 141, "battery_ok": 1, "temperature_C": round(21.4 + 2 * __import__("math").sin(m), 1), "humidity": 58,
         "wind_dir_deg": 225, "wind_avg_m_s": 2.4, "wind_max_m_s": 4.1, "rain_mm": 12.6, "uv": 312, "uvi": 3, "light_lux": 41000, "mic": "CRC"})
    out({"model": "Nexus-TH", "id": 77, "channel": 1, "battery_ok": 1, "temperature_C": 19.8, "humidity": 46})
    if n % 2 == 0: out({"model": "Prologue-TH", "id": 203, "channel": 3, "battery_ok": 0, "temperature_C": 4.1, "humidity": 71})
    if n % 3 == 0: out({"model": "Efergy-e2CT", "id": 52219, "current_A": 3.6, "power_W": 864, "battery_ok": 1})
    if n % 5 == 0: out({"model": "Generic-Remote", "id": 4410, "cmd": 9, "tri_state": "F0F0F0F0F0F0"})
    if n % 2 == 1: out({"model": "Toyota", "type": "TPMS", "id": "%08x" % random.getrandbits(32), "status": 128, "pressure_PSI": round(random.uniform(30, 36), 1), "temperature_C": 24})
    time.sleep(0.4 if fast else 3)
