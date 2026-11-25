"""geo.py - find a place from whatever someone types: a town, a suburb, a postcode, "area, state, country", or a mix.

Free services are asked, and their answers merged:
  - Open-Meteo's geocoder: fast, gives elevation and time zone, but matches one place name (or one postcode) at a time.
  - OpenStreetMap's Nominatim: understands whole addresses, suburbs, postcodes and "Town, State, Country". It allows one
    request a second and turns busy addresses away (HTTP 429), so requests to it are spaced out and retried once.
  - Photon (by komoot, also built on OpenStreetMap data): asked only when Nominatim is busy or unreachable.
Answers are remembered for a day, so a repeated search asks nobody.
Only the words typed are sent. Results are cleaned, range-checked, de-duplicated and ranked so the place that matches every
word comes first. Network access is injectable (fetch_json) so the logic can be tested without the internet."""
import json
import os
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

import countries

UA = "Skywave (self-hosted radio receiver)"


# Common ways people write a country, so "Durham UK", "Leeds, England" and "Austin TX USA" all narrow the search.
COUNTRY_WORDS = {
    "australia": "AU", "aus": "AU", "au": "AU", "new zealand": "NZ", "nz": "NZ", "aotearoa": "NZ",
    "united states": "US", "united states of america": "US", "usa": "US", "us": "US", "america": "US",
    "canada": "CA", "united kingdom": "GB", "uk": "GB", "great britain": "GB", "britain": "GB", "england": "GB",
    "scotland": "GB", "wales": "GB", "northern ireland": "GB", "ireland": "IE", "germany": "DE", "deutschland": "DE",
    "france": "FR", "spain": "ES", "espana": "ES", "italy": "IT", "italia": "IT", "netherlands": "NL", "holland": "NL",
    "belgium": "BE", "switzerland": "CH", "austria": "AT", "sweden": "SE", "norway": "NO", "denmark": "DK",
    "finland": "FI", "poland": "PL", "portugal": "PT", "greece": "GR", "japan": "JP", "china": "CN", "india": "IN",
    "south africa": "ZA", "brazil": "BR", "mexico": "MX", "argentina": "AR", "singapore": "SG", "malaysia": "MY",
    "indonesia": "ID", "philippines": "PH", "thailand": "TH", "vietnam": "VN", "south korea": "KR", "korea": "KR",
    "hong kong": "HK", "taiwan": "TW", "nippon": "JP", "republic of korea": "KR", "uae": "AE",
}
POSTCODE = re.compile(r"^(?:\d{3,6}|[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}|[A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d|\d{5}-\d{4})$")


def _fold(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9 ]+", " ", s).strip()


def _clean(v, n=60):
    return re.sub(r"[^\w .,'()/-]", "", str(v or ""), flags=re.UNICODE)[:n].strip()


def fetch_json(url, timeout=8):
    if os.environ.get("NO_NET"):
        raise OSError("outside requests are turned off (NO_NET)")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read(400000).decode("utf-8", "replace"))


def _token_hits(tok, hay):
    """Does one typed word match a place's names? Full words, prefixes ("Vic" for Victoria) and short forms
    ("NC" for North Carolina, "TX" for Texas) all count."""
    if not tok:
        return True
    if tok in hay.split() or (len(tok) >= 3 and tok in hay):
        return True
    for part in [p for p in hay.split(",")] + [hay]:
        words = part.split()
        if not words:
            continue
        if len(tok) <= 4 and "".join(w[0] for w in words) == tok:            # initials: nc, ny, nsw
            return True
        if len(tok) <= 4 and len(words) == 1:                                # a short form inside one word: tx for Texas, qld for Queensland
            w, i = words[0], 0
            if w[0] == tok[0]:
                for ch in w:
                    if i < len(tok) and ch == tok[i]:
                        i += 1
                if i == len(tok):
                    return True
    return False


def _hint(where):
    """The country to favour: the chosen country itself, or the one country a region entry stands for."""
    w = str(where or "")
    if len(w) == 2 and w.upper() in countries.REGION_OF and w.isupper():
        return w
    return countries.single_country(w)


def parse(query, region=""):
    """Split what was typed into: the place itself, the extra words that narrow it, a country and a postcode."""
    q = unicodedata.normalize("NFC", str(query or ""))
    q = re.sub(r"[^\w .,'/-]", " ", q, flags=re.UNICODE)
    q = re.sub(r"\s+", " ", q).strip(" ,")[:120]
    parts = [p.strip() for p in q.split(",") if p.strip()]
    country, postcode, rest = "", "", []
    for p in list(parts):
        f = _fold(p)
        if f in COUNTRY_WORDS:
            country = COUNTRY_WORDS[f]
            parts.remove(p)
    words = " ".join(parts).split()
    # a trailing country written without a comma: "Leeds UK", "Perth Western Australia"
    if not country:
        for n in (3, 2, 1):
            tail = _fold(" ".join(words[-n:])) if len(words) > n else ""
            if tail in COUNTRY_WORDS:
                country = COUNTRY_WORDS[tail]
                words = words[:-n]
                break
    for i, w in enumerate(words):                       # a postcode anywhere (UK ones are two words)
        two = " ".join(words[i:i + 2])
        if POSTCODE.match(two) and " " in two:
            postcode = two.upper(); words = words[:i] + words[i + 2:]; break
        if POSTCODE.match(w) and any(c.isdigit() for c in w):
            postcode = w.upper(); words = words[:i] + words[i + 1:]; break
    if parts and len(parts) > 1:
        head = parts[0]
        pc = _fold(postcode)
        rest = [" ".join(w for w in _fold(x).replace(pc, " ").split() if not POSTCODE.match(w)) if pc else _fold(x) for x in parts[1:]]
        if postcode and postcode.lower() in head.lower():
            head = head.replace(postcode, "").replace(postcode.lower(), "").strip()
    else:
        head = " ".join(words)
    hw = head.split()
    return {"text": q, "head": head.strip(), "rest": [r for r in rest if r and not POSTCODE.match(r)], "country": country,
            "postcode": postcode, "hint": _hint(region),
            # "Durham NC": the first word(s) may be the place and the rest may narrow it, or it may all be one name
            "short": " ".join(hw[:-1]) if len(parts) <= 1 and len(hw) > 1 else "", "soft": [_fold(w) for w in hw[1:]] if len(parts) <= 1 else []}


def _from_open_meteo(x):
    lat, lon = float(x["latitude"]), float(x["longitude"])
    cc = str(x.get("country_code", ""))[:2].upper()
    tz = str(x.get("timezone", ""))[:40]
    pcs = x.get("postcodes") or []
    return {"name": _clean(x.get("name")), "area": _clean(x.get("admin2") or x.get("admin3") or ""), "admin": _clean(x.get("admin1")),
            "country": _clean(x.get("country")), "cc": cc, "postcode": _clean(pcs[0], 12) if pcs else "",
            "lat": lat, "lon": lon, "alt": float(x.get("elevation") or 0), "tz": tz, "pop": int(x.get("population") or 0), "src": "om"}


def _from_photon(f):
    """One Photon result (a GeoJSON feature) in the same shape as the others."""
    a = f.get("properties") or {}
    lon, lat = f["geometry"]["coordinates"][:2]
    name = a.get("name") or a.get("district") or a.get("city") or a.get("postcode") or ""
    area = a.get("city") or a.get("county") or a.get("district") or ""
    if _fold(area) == _fold(name):
        area = a.get("county") or ""
    return {"name": _clean(name), "area": _clean(area), "admin": _clean(a.get("state") or ""), "country": _clean(a.get("country")),
            "cc": str(a.get("countrycode", ""))[:2].upper(), "postcode": _clean(a.get("postcode"), 12), "lat": float(lat),
            "lon": float(lon), "alt": 0.0, "tz": "", "pop": 0, "src": "photon", "rank": 0.3}


# Nominatim: at most one request a second from this server (its usage policy), one retry after "too many requests".
# NOMINATIM_EMAIL, if set, is sent as the policy asks of regular users, so the service can reach the operator.
_osm_lock = threading.Lock()
_osm_last = [0.0]


def _osm_fetch(url, fetch):
    email = os.environ.get("NOMINATIM_EMAIL", "").strip()
    if email:
        url += "&" + urllib.parse.urlencode({"email": email})
    for attempt in range(2):
        with _osm_lock:
            wait = _osm_last[0] + 1.1 - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            _osm_last[0] = time.monotonic()
        try:
            return fetch(url)
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt:
                raise
            time.sleep(2.0)
    return []


class Busy(Exception):
    """Every place search turned the request away or could not be reached."""


_cache = {}                                     # (query, region) -> (time, results)


def _from_nominatim(x):
    a = x.get("address") or {}
    lat, lon = float(x["lat"]), float(x["lon"])
    name = x.get("name") or a.get("suburb") or a.get("town") or a.get("city") or a.get("village") or a.get("hamlet") or a.get("postcode") or ""
    area = a.get("city") or a.get("town") or a.get("municipality") or a.get("county") or ""
    if _fold(area) == _fold(name):
        area = a.get("county") or a.get("state_district") or ""
    return {"name": _clean(name), "area": _clean(area), "admin": _clean(a.get("state") or a.get("region") or ""), "country": _clean(a.get("country")),
            "cc": str(a.get("country_code", ""))[:2].upper(), "postcode": _clean(a.get("postcode"), 12), "lat": lat, "lon": lon,
            "alt": 0.0, "tz": "", "pop": 0, "src": "osm", "rank": float(x.get("importance") or 0)}


def _score(r, p):
    hay = ", ".join(_fold(v) for v in (r["name"], r["area"], r["admin"], r["country"], r["cc"], r["postcode"]) if v)
    s = 0.0
    if p["head"] and _fold(r["name"]) == _fold(p["head"]):
        s += 4
    elif p["head"] and _fold(p["head"]) in _fold(r["name"]):
        s += 2
    for tok in p["rest"]:
        for t in tok.split():
            s += 2 if _token_hits(t, hay) else -3
    for t in p.get("soft", []):
        s += 1.5 if _token_hits(t, hay) else 0
    if p["country"]:
        s += 3 if r["cc"] == p["country"] else -6
    elif p["hint"] and r["cc"] == p["hint"]:
        s += 1.5
    if p["postcode"]:
        s += 3 if r["postcode"].replace(" ", "").upper() == p["postcode"].replace(" ", "").upper() else 0
    s += min(2.0, (r.get("pop") or 0) / 500000.0) + (r.get("rank") or 0)
    return s


def _enrich(r, fetch):
    """OpenStreetMap does not give a time zone or height: ask Open-Meteo for both at that point."""
    try:
        d = fetch("https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(
            {"latitude": round(r["lat"], 4), "longitude": round(r["lon"], 4), "timezone": "auto", "forecast_days": 1}), 5)
        tz = str(d.get("timezone", ""))[:40]
        if re.fullmatch(r"[A-Za-z0-9_+\-/]+", tz or "") and tz != "GMT":
            r["tz"] = tz
        if d.get("elevation") is not None:
            r["alt"] = float(d["elevation"])
    except Exception:
        pass


# the address parts that name a suburb or town, most specific first ("neighbourhood" is usually too small to be useful)
SUBURB_KEYS = ("suburb", "town", "village", "hamlet", "city_district", "quarter", "locality", "district", "city")


def _postcode_eq(a, b):
    return bool(a) and bool(b) and a.replace(" ", "").upper() == b.replace(" ", "").upper()


def _suburb(r, postcode, fetch, use_osm):
    """For a place found by its postcode: look up which suburb or town sits at that spot and name the result after it,
    keeping the city as its area. A postcode often covers more than one suburb; this names the one at its centre."""
    lat, lon = r["lat"], r["lon"]
    got = None
    if use_osm:
        try:
            x = _osm_fetch("https://nominatim.openstreetmap.org/reverse?" + urllib.parse.urlencode(
                {"lat": lat, "lon": lon, "zoom": 14, "format": "jsonv2", "addressdetails": 1, "accept-language": "en"}), fetch) or {}
            a = x.get("address") or {}
            got = (next((a[k] for k in SUBURB_KEYS if a.get(k)), ""), a.get("city") or a.get("town") or a.get("municipality") or a.get("county") or "",
                   a.get("postcode") or "")
        except Exception:
            got = None
    if not got or not got[0]:
        try:
            d = fetch("https://photon.komoot.io/reverse?" + urllib.parse.urlencode({"lat": lat, "lon": lon, "lang": "en", "limit": 1})) or {}
            f = (d.get("features") or [{}])[0].get("properties") or {}
            name = f.get("name") if f.get("type") in ("district", "locality", "city", "town", "village", "suburb") else ""
            got = (name or f.get("district") or f.get("locality") or "", f.get("city") or f.get("county") or "", f.get("postcode") or "")
        except Exception:
            return
    sub, city, pc = (_clean(v) for v in got)
    if not sub or (pc and not _postcode_eq(pc, postcode)):
        return                                  # the centre falls in another postcode: keep the original name
    old = r["name"]
    if _fold(sub) != _fold(old):
        r["name"] = sub
        # the old name was the postcode itself or the wider city: the city becomes the area
        wider = city if POSTCODE.match(old) or _postcode_eq(old, postcode) else old
        r["area"] = wider if _fold(wider) != _fold(sub) else (r["area"] if _fold(r["area"]) != _fold(sub) else "")
    r["postcode"] = r["postcode"] or postcode


def geocode(query, region="", fetch=fetch_json, limit=8, suggest=False):
    """Places matching the text. suggest=True is the search-as-you-type mode: it leaves out Nominatim, whose usage policy
    does not allow lookups on every keystroke, and asks only Open-Meteo and Photon (built for exactly this)."""
    if fetch is not fetch_json:                # tests and other callers with their own fetch: no shared memory
        return _geocode(query, region, fetch, limit, suggest)
    key = (" ".join(str(query).lower().split()), region or "", bool(suggest))
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < 86400:
        return hit[1]
    res = _geocode(query, region, fetch, limit, suggest)
    if res:
        if len(_cache) > 200:
            _cache.clear()
        _cache[key] = (time.time(), res)
    return res


def _geocode(query, region, fetch, limit, suggest=False):
    p = parse(query, region)
    if len(p["head"]) < 2 and not p["postcode"]:
        if not p["country"]:
            return []
    found, errors = [], []
    # Only places in one country: the one typed ("Perth, Scotland") or else the country chosen in settings.
    # With neither, the whole world is searched.
    only = p["country"] or p["hint"] or ""

    def om(name, cc):
        args = {"name": name, "count": 20, "language": "en", "format": "json"}
        if cc:
            args["countryCode"] = cc
        try:
            d = fetch("https://geocoding-api.open-meteo.com/v1/search?" + urllib.parse.urlencode(args))
            for x in d.get("results") or []:
                try:
                    found.append(_from_open_meteo(x))
                except (KeyError, TypeError, ValueError):
                    pass
        except Exception as e:
            errors.append(e)

    def photon():
        args = {"q": p["text"], "limit": 20 if only else 10, "lang": "en"}
        try:
            d = fetch("https://photon.komoot.io/api/?" + urllib.parse.urlencode(args)) or {}
            for x in d.get("features") or []:
                try:
                    found.append(_from_photon(x))
                except (KeyError, TypeError, ValueError, IndexError):
                    pass
        except Exception as e:
            errors.append(e)

    def osm():
        args = {"q": p["text"], "format": "jsonv2", "addressdetails": 1, "limit": 10, "accept-language": "en", "dedupe": 1}
        if only:
            args["countrycodes"] = only.lower()
        try:
            for x in _osm_fetch("https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(args), fetch) or []:
                try:
                    found.append(_from_nominatim(x))
                except (KeyError, TypeError, ValueError):
                    pass
        except Exception as e:
            errors.append(e)
            photon()                            # Nominatim is busy or down: ask Photon instead

    jobs = [threading.Thread(target=photon if suggest else osm)]
    cc = only
    if p["postcode"]:
        jobs.append(threading.Thread(target=om, args=(p["postcode"], cc)))
    if p["head"]:
        jobs.append(threading.Thread(target=om, args=(p["head"], cc)))
    if p.get("short") and len(p["short"]) >= 3:
        jobs.append(threading.Thread(target=om, args=(p["short"], cc)))
        if " " in p["short"]:
            jobs.append(threading.Thread(target=om, args=(p["short"].split()[0], cc)))
    elif p["country"] and not p["postcode"]:
        jobs.append(threading.Thread(target=om, args=(p["text"], "")))       # "Georgia": the country itself
    for j in jobs:
        j.start()
    for j in jobs:
        j.join(12)
    if not found and errors:
        if any(isinstance(e, urllib.error.HTTPError) and e.code == 429 for e in errors):
            raise Busy("busy")
        raise errors[0]

    out = []
    for r in found:
        if not (-90 <= r["lat"] <= 90 and -180 <= r["lon"] <= 180) or not r["name"]:
            continue
        if only and r["cc"] and r["cc"] != only and not (p["country"] and _fold(r["name"]) in COUNTRY_WORDS):
            continue
        r["score"] = _score(r, p)
        dup = next((o for o in out if abs(o["lat"] - r["lat"]) < 0.03 and abs(o["lon"] - r["lon"]) < 0.03), None)
        if dup:
            # keep the better-scored one, but take the other's time zone and height if it has them
            keep, other = (dup, r) if dup["score"] >= r["score"] else (r, dup)
            for k in ("tz", "postcode", "area"):
                keep[k] = keep[k] or other[k]
            if not keep["alt"]:
                keep["alt"] = other["alt"]
            if keep is r:
                out[out.index(dup)] = r
            continue
        out.append(r)
    out.sort(key=lambda r: -r["score"])
    out = out[:limit]
    # a postcode on its own: name each of the top results after the suburb at that spot, not just the city
    if p["postcode"] and not p["head"]:
        named = [r for r in out[:3] if not r["postcode"] or _postcode_eq(r["postcode"], p["postcode"])]
        ts = [threading.Thread(target=_suburb, args=(r, p["postcode"], fetch, i == 0 and not suggest)) for i, r in enumerate(named)]
        for t in ts:
            t.start()
        for t in ts:
            t.join(8)
    need = [r for r in out[:4] if not r["tz"]]
    ts = [threading.Thread(target=_enrich, args=(r, fetch)) for r in need]
    for t in ts:
        t.start()
    for t in ts:
        t.join(6)
    res = []
    for r in out:
        cc = r["cc"]
        label = ", ".join(x for x in (r["name"], r["area"] if _fold(r["area"]) != _fold(r["name"]) else "", r["admin"], r["postcode"]) if x)
        res.append({"name": r["name"], "admin": r["admin"], "area": r["area"], "country": r["country"], "postcode": r["postcode"],
                    "label": label, "lat": round(r["lat"], 4), "lon": round(r["lon"], 4), "alt": round(r["alt"], 1), "tz": r["tz"],
                    "cc": cc, "region": countries.region_of(cc) or "intl"})
    return res
