"""Location search: postcodes, "area, state, country", short state names, country words, merging and ranking.
The two web services are replaced by canned answers in their real formats, so this runs offline."""
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import geo  # noqa: E402

OM = {
    "Durham": [
        {"name": "Durham", "latitude": 54.7761, "longitude": -1.5733, "elevation": 60, "country_code": "GB", "country": "United Kingdom", "admin1": "England", "admin2": "County Durham", "timezone": "Europe/London", "population": 48000},
        {"name": "Durham", "latitude": 35.9940, "longitude": -78.8986, "elevation": 120, "country_code": "US", "country": "United States", "admin1": "North Carolina", "admin2": "Durham County", "timezone": "America/New_York", "population": 283000, "postcodes": ["27701"]},
    ],
    "Leeds": [
        {"name": "Leeds", "latitude": 53.7965, "longitude": -1.5478, "elevation": 63, "country_code": "GB", "country": "United Kingdom", "admin1": "England", "timezone": "Europe/London", "population": 455123},
        {"name": "Leeds", "latitude": 33.5482, "longitude": -86.5444, "elevation": 200, "country_code": "US", "country": "United States", "admin1": "Alabama", "timezone": "America/Chicago", "population": 11773},
    ],
    "27701": [
        {"name": "Durham", "latitude": 35.9940, "longitude": -78.8986, "elevation": 120, "country_code": "US", "country": "United States", "admin1": "North Carolina", "timezone": "America/New_York", "postcodes": ["27701"]},
    ],
}
OSM = {
    "Durham NC": [{"lat": "35.9960", "lon": "-78.9010", "name": "Durham", "importance": 0.5,
                   "address": {"city": "Durham", "county": "Durham County", "state": "North Carolina", "postcode": "27701", "country": "United States", "country_code": "us"}}],
    "Park Slope NY 11215": [{"lat": "40.6710", "lon": "-73.9814", "name": "Park Slope", "importance": 0.4,
                             "address": {"suburb": "Park Slope", "city": "New York", "state": "New York", "postcode": "11215", "country": "United States", "country_code": "us"}}],
    "SW1A 1AA": [{"lat": "51.5010", "lon": "-0.1416", "name": "", "importance": 0.3,
                  "address": {"postcode": "SW1A 1AA", "city": "London", "state": "England", "country": "United Kingdom", "country_code": "gb"}}],
}
CALLS = []


def fake(url, timeout=8):
    CALLS.append(url)
    u = urllib.parse.urlsplit(url); q = dict(urllib.parse.parse_qsl(u.query))
    if "geocoding-api.open-meteo.com" in url:
        res = [x for x in OM.get(q["name"], []) if not q.get("countryCode") or x["country_code"] == q["countryCode"]]
        return {"results": res} if res else {}
    if "nominatim" in url:
        key = q["q"].replace(",", "")
        key = " ".join(key.split())
        return OSM.get(key, [])
    if "api.open-meteo.com/v1/forecast" in url:
        return {"timezone": "Europe/London" if float(q["longitude"]) > -30 else "America/New_York", "elevation": 7.0}
    raise AssertionError(url)


def first(q, region=""):
    r = geo.geocode(q, region, fetch=fake)
    return r[0] if r else None


fails = 0
def check(name, cond, info=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + (("  " + str(info)) if not cond else ""))
    fails += 0 if cond else 1


r = first("Durham NC"); check("town plus short state name", r and r["name"] == "Durham" and r["admin"] == "North Carolina", r)
r = first("27701"); check("bare postcode", r and r["name"] == "Durham" and r["tz"] == "America/New_York", r)
r = first("27701", "us"); check("postcode with the region set", r and r["region"] == "us", r)
r = first("Durham, United Kingdom"); check("town, country", r and r["country"] == "United Kingdom", r)
r = first("Durham UK"); check("country without a comma", r and r["country"] == "United Kingdom", r)
r = first("Durham, NC"); check("state initials pick the right Durham", r and r["admin"] == "North Carolina", r)
r = first("Durham North Carolina"); check("full state name without commas", r and r["admin"] == "North Carolina", r)
r = first("Leeds UK"); check("UK country word", r and r["country"] == "United Kingdom", r)
r = first("Park Slope, NY 11215"); check("suburb, state and postcode via OpenStreetMap", r and r["name"] == "Park Slope" and r["postcode"] == "11215", r)
check("OpenStreetMap results get a time zone", r and r["tz"] == "America/New_York" and r["alt"] == 7.0, r)
r = first("SW1A 1AA"); check("UK postcode", r and abs(r["lat"] - 51.501) < 0.01 and r["tz"] == "Europe/London", r)
rs = geo.geocode("Durham NC", "", fetch=fake); check("the same place from both services is shown once", len([x for x in rs if x["name"] == "Durham" and x["country"] == "United States"]) == 1, rs)
check("labels read naturally", rs and rs[0]["label"].startswith("Durham, ") and "North Carolina" in rs[0]["label"], rs and rs[0]["label"])
check("nothing for one letter", geo.geocode("a", fetch=fake) == [])
p = geo.parse("Park Slope, NY 11215"); check("parse splits place, narrowing words and postcode", p["head"] == "Park Slope" and p["postcode"] == "11215" and p["rest"] == ["ny"], p)
check("short forms", geo._token_hits("tx", "texas") and geo._token_hits("nc", "north carolina") and geo._token_hits("ny", "new york") and not geo._token_hits("nc", "new york"))

# busy services: Nominatim says 429 -> one retry, then Photon; everything busy -> geo.Busy (a clear message, not an HTTP error)
import urllib.error
geo.time.sleep = lambda s: None                        # no real waiting in tests
PH = {"features": [{"geometry": {"coordinates": [-78.90, 35.99]}, "properties": {"name": "Durham", "county": "Durham County",
      "state": "North Carolina", "country": "United States", "countrycode": "US", "postcode": "27701"}}]}
seen = []
def busy(url, timeout=8):
    seen.append(url.split("/")[2])
    if "nominatim" in url:
        raise urllib.error.HTTPError(url, 429, "Too Many Requests", {}, None)
    if "photon" in url:
        return PH
    if "geocoding-api" in url:
        return {"results": []}
    return {}
r = geo.geocode("Somewhere Street Durham", "", fetch=busy)
check("OpenStreetMap busy: Photon answers", r and r[0]["name"] == "Durham" and r[0]["country"] == "United States", r)
check("OpenStreetMap is asked twice (one retry) before giving up", seen.count("nominatim.openstreetmap.org") == 2, seen)
tries = []
def once(url, timeout=8):
    if "nominatim" in url:
        tries.append(1)
        if len(tries) == 1:
            raise urllib.error.HTTPError(url, 429, "Too Many Requests", {}, None)
        return OSM["Durham NC"]
    return {"results": []} if "geocoding-api" in url else {}
r = geo.geocode("Durham NC", "", fetch=once)
check("a retry after 429 gets the answer", r and r[0]["name"] == "Durham" and len(tries) == 2, (r, tries))
def all_busy(url, timeout=8):
    if "geocoding-api" in url:
        return {"results": []}
    raise urllib.error.HTTPError(url, 429, "Too Many Requests", {}, None)
try:
    geo.geocode("Somewhere Street Durham", "", fetch=all_busy); check("everything busy is reported as busy", False)
except geo.Busy:
    check("everything busy is reported as busy", True)
print("FAILED %d" % fails if fails else "PASS")
sys.exit(1 if fails else 0)
