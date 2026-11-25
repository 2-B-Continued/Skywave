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
# a postcode-only search for Bondi: Open-Meteo names the city whose postcodes include it, OpenStreetMap the postcode itself
OM["2026"] = [{"name": "Sydney", "latitude": -33.8678, "longitude": 151.2073, "country_code": "AU", "country": "Australia",
               "admin1": "New South Wales", "timezone": "Australia/Sydney", "population": 4600000, "postcodes": ["2000", "2026"]}]
OSM["2026"] = [{"lat": "-33.8915", "lon": "151.2767", "name": "2026", "importance": 0.3,
                "address": {"postcode": "2026", "city": "Sydney", "state": "New South Wales", "country": "Australia", "country_code": "au"}}]
REVERSE = {(-33.89, 151.28): {"address": {"suburb": "Bondi", "city": "Sydney", "state": "New South Wales", "postcode": "2026"}},
           (-33.87, 151.21): {"address": {"suburb": "Sydney", "city": "Sydney", "state": "New South Wales", "postcode": "2000"}},
           (35.99, -78.9): {"address": {"city": "Durham", "state": "North Carolina", "postcode": "27701"}}}
# a name used in several countries
OM["Richmond"] = [
    {"name": "Richmond", "latitude": 37.5538, "longitude": -77.4603, "country_code": "US", "country": "United States", "admin1": "Virginia", "timezone": "America/New_York", "population": 226000},
    {"name": "Richmond", "latitude": 51.4613, "longitude": -0.3037, "country_code": "GB", "country": "United Kingdom", "admin1": "England", "timezone": "Europe/London", "population": 20000},
    {"name": "Richmond", "latitude": -37.8183, "longitude": 145.0018, "country_code": "AU", "country": "Australia", "admin1": "Victoria", "timezone": "Australia/Melbourne", "population": 27000}]
CALLS = []


def fake(url, timeout=8):
    CALLS.append(url)
    u = urllib.parse.urlsplit(url); q = dict(urllib.parse.parse_qsl(u.query))
    if "geocoding-api.open-meteo.com" in url:
        res = [x for x in OM.get(q["name"], []) if not q.get("countryCode") or x["country_code"] == q["countryCode"]]
        return {"results": res} if res else {}
    if "nominatim" in url and "/reverse" in url:
        return REVERSE.get((round(float(q["lat"]), 2), round(float(q["lon"]), 2)), {})
    if "photon.komoot.io/reverse" in url:
        return {}
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
r = geo.geocode("2026", "au", fetch=fake)
check("a postcode shows the suburb it belongs to, with the city as its area", r and r[0]["name"] == "Bondi" and r[0]["area"] == "Sydney" and r[0]["postcode"] == "2026", r)
check("a centre in another postcode keeps its name", not any(x["name"] == "Sydney" and x["postcode"] == "2026" and x["area"] for x in r) and any(x["name"] == "Sydney" for x in r), r)
check("the label reads suburb, city, state, postcode", r and r[0]["label"] == "Bondi, Sydney, New South Wales, 2026", r and r[0]["label"])
r = first("Park Slope, NY 11215"); check("a typed suburb is left alone", r and r["name"] == "Park Slope", r)

CALLS.clear()
r = geo.geocode("Richmond", "AU", fetch=fake)
check("with a country chosen, only places in it", r and all(x["cc"] == "AU" for x in r), [x["cc"] for x in r or []])
check("the search services are asked for that country only", all("countryCode=AU" in u or "countrycodes=au" in u for u in CALLS if "search" in u), CALLS)
r = geo.geocode("Richmond", "", fetch=fake)
check("with no country chosen, the whole world", r and {x["cc"] for x in r} >= {"US", "GB", "AU"}, [x["cc"] for x in r or []])
r = geo.geocode("Richmond, UK", "AU", fetch=fake)
check("a country typed in the search wins over the chosen one", r and all(x["cc"] == "GB" for x in r), [x["cc"] for x in r or []])

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
# search as you type: never asks Nominatim (its policy forbids lookups on every keystroke), still finds places
seen = []
def watch(url, timeout=8):
    seen.append(url)
    return fake(url, timeout)
rs = geo.geocode("Durham NC", "", fetch=watch, suggest=True)
check("suggestions never ask Nominatim", not any("nominatim" in u for u in seen), seen)
check("suggestions still find the place", any(x["name"] == "Durham" for x in rs), rs)
seen.clear(); geo.geocode("2026", "au", fetch=watch, suggest=True)
check("a postcode typed as a suggestion never asks Nominatim either", not any("nominatim" in u for u in seen), seen)
print("FAILED %d" % fails if fails else "PASS")
sys.exit(1 if fails else 0)
