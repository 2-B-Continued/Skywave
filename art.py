"""Cover art for the song an FM station says it is playing.

FM radio does not carry pictures: the station only sends text (RadioText such as "Artist - Title"). So the picture is looked
up from that text, using Apple's public music search (no account or key needed). Only the song text is sent, nothing about
you. The picture is fetched by this server and served from here, so phones and lock screens load it from Skywave itself.
Results (including "nothing found") are remembered, so a song is looked up once.

"Open in": links() finds the song's page on Apple Music and Deezer (checked for your country) and offers a search for it
on the other big services that operate in your country. Only the song's name and your country code are sent.
"""
import difflib
import hashlib
import json
import re
import threading
import time
import urllib.parse
import urllib.request

_lock = threading.Lock()
_text = {}                       # cleaned text -> (time, result or None)
_img = {}                        # id -> (content type, bytes)
TTL = 6 * 3600
MAX_TEXT, MAX_IMG = 300, 60
_PREFIX = re.compile(r"^\s*(now playing|now on air|on air|now|playing|currently playing|you'?re listening to|listening to)\s*[:\-]\s*", re.I)
_SPLIT = re.compile(r"\s+[-–—]\s+|\s+by\s+", re.I)
# Lines that are clearly not a song: links, phone and text numbers, "with Host Name" shows, and bulletins. A bulletin is
# news, traffic, weather or sport at the start of the line followed by a colon, "update", "report", a time and so on, or
# a reading such as "28 degrees". The words alone are no sign: Weather With You, Stormy Weather,
# Good News, the band Traffic and Bad News are all songs.
_JUNK = re.compile(r"(https?://|www\.|\.com\b|\.au\b|call us|text \d|sms|\b1[38]00\b|\bwith [A-Z][a-z]+ [A-Z][a-z]+$"
                   r"|^(?:the )?(?:latest|breaking|local|world|national)\s+(?:news|traffic|weather|sport)"
                   r"|^(?:news|traffic|weather|sport)s?\s*(?::|(?:update|bulletin|headlines|at \d|on the hour|now)\b|\d)"
                   r"|^(?:news|traffic|weather|sport)s? report\s*:"
                   r"|\b(?:news|traffic|weather|sport) (?:update|bulletin|headlines|on the hour)\b|\d+\s*(?:°|degrees)\b)", re.I)


def parse(rt):
    """'Artist - Title' (or 'Title by Artist') out of a RadioText line. Returns (a, b, by_form) or None when it does not look like a song."""
    t = _PREFIX.sub("", re.sub(r"\s+", " ", str(rt or "")).strip())
    t = re.sub(r"\s*[\(\[]?(?:on|@)\s*[\d.]+\s*(?:fm|mhz)?[\)\]]?\s*$", "", t, flags=re.I).strip()
    if not (5 <= len(t) <= 120) or _JUNK.search(t):
        return None
    parts = _SPLIT.split(t, maxsplit=1)
    if len(parts) != 2 or not parts[0].strip() or not parts[1].strip():
        return None
    by = bool(re.search(r"\sby\s", t, re.I)) and not re.search(r"\s[-–—]\s", t)
    return parts[0].strip(), parts[1].strip(), by


def _norm(s):
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s.lower()).replace("&", " and ").replace("+", " and ")
    s = re.sub(r"\b(feat|ft|featuring|with)\b.*$", " ", s)
    return re.sub(r"[^a-z0-9 ]+", " ", s).split()


def _sim(a, b):
    a, b = " ".join(_norm(a)), " ".join(_norm(b))
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 0.95
    return difflib.SequenceMatcher(None, a, b).ratio()


_REPACK = re.compile(r"soundtrack|original (motion picture|score|cast|series)|music from|from the (motion picture|film|movie|series|netflix)|\bost\b|"
                     r"greatest hits|best of|\bhits\b|collection|anthology|essential|ultimate|\bgold\b|platinum|now that'?s|compilation|"
                     r"\blive\b|karaoke|tribute|workout|party|\bmix\b|in the style of", re.I)


def _repack(r):
    """1 when this release is a soundtrack, compilation, best-of, live album or similar repackaging, else 0."""
    va = (r.get("collectionArtistName") or "").strip()
    return int(bool(_REPACK.search(r.get("collectionName", "")) or r.get("primaryGenreName", "") == "Soundtrack"
                    or (va and va.lower() != (r.get("artistName") or "").strip().lower())))


_FILM = re.compile(r"soundtrack|original (motion picture|score|cast|series)|music from|from the (motion picture|film|movie|series|netflix)|\bost\b|"
                   r"motion picture|music (inspired by|from and inspired by)", re.I)


def _film(r):
    """1 when this release is a film, TV or stage soundtrack."""
    return int(bool(_FILM.search(r.get("collectionName", "")) or r.get("primaryGenreName", "") == "Soundtrack"))


def _year(d):
    m = re.match(r"(\d{4})", str(d or ""))
    return int(m.group(1)) if m else None


def _good(results, artist, title):
    good = []
    for r in results:
        sa, st = _sim(artist, r.get("artistName", "")), _sim(title, r.get("trackName", ""))
        if sa >= 0.6 and st >= 0.6 and r.get("artworkUrl100"):
            good.append((sa + st, r))
    return good


def film_ids(results, artist, title):
    """Collection ids of the soundtracks among the matches: their album years are looked up before picking."""
    return sorted({r.get("collectionId") for _, r in _good(results, artist, title) if _film(r) and r.get("collectionId")})


def pick(results, artist, title, years=None):
    """The best release for a song. A hit appears on its original album and on many repackagings (film soundtracks,
    best-ofs, live albums), and the search returns them in no useful order: "Thunderstruck" came back as the Iron Man 2
    soundtrack instead of The Razors Edge. So the original wins: the earliest release that is not a repackaging.

    Film art only for songs made for the film. The song's own date travels with it onto later soundtracks (Holding Out
    For A Hero, 1984, came back dated 1984 on the 2001 Bandits soundtrack), so a track's date can't tell the two apart.
    `years` maps a soundtrack's collectionId to the year the soundtrack album itself came out (looked up separately);
    a soundtrack is only used when that album came out within a year of the song's first appearance anywhere. One whose
    album year is unknown, or later, is never used, even when nothing else matches."""
    years = years or {}
    good = _good(results, artist, title)
    if not good:
        return None
    first_year = min((_year(r.get("releaseDate")) for _, r in good if _year(r.get("releaseDate"))), default=None)

    def made_for_film(r):
        y = years.get(r.get("collectionId"))
        return bool(y and first_year and y <= first_year + 1)

    good = [(q, r) for q, r in good if not _film(r) or made_for_film(r)]
    if not good:
        return None
    top = max(q for q, _ in good)
    cands = [r for q, r in good if q >= top - 0.1]
    date = lambda r: str(r.get("releaseDate") or "9999")
    rank = lambda r: 0 if _film(r) else 1 + _repack(r)   # made for the film > the artist's own album > best-ofs and the like
    return min(cands, key=lambda r: (rank(r), date(r)))


def _fetch(url, limit, accept):
    req = urllib.request.Request(url, headers={"User-Agent": "skywave (radio receiver; cover art)", "Accept": accept})
    with urllib.request.urlopen(req, timeout=8) as r:
        return r.read(limit + 1), r.headers.get("Content-Type", "")


def lookup(rt, fetch=_fetch, country=""):
    """-> {"id","artist","title","album"} or None. `fetch` is replaceable for tests."""
    p = parse(rt)
    if not p:
        return None
    country = (country or "").upper() if re.fullmatch(r"[A-Za-z]{2}", country or "") else ""
    key = " | ".join(p[:2]).lower() + "|" + country
    now = time.time()
    with _lock:
        hit = _text.get(key)
        if hit and now - hit[0] < TTL:
            return hit[1]
    res = None
    try:
        for artist, title in ((p[1], p[0]),) if p[2] else ((p[0], p[1]), (p[1], p[0])):
            url = "https://itunes.apple.com/search?" + urllib.parse.urlencode(dict({"term": artist + " " + title, "media": "music", "entity": "song", "limit": 25}, **({"country": country} if country else {})))
            raw, _ = fetch(url, 900000, "application/json")
            results = json.loads(raw.decode("utf-8", "replace")).get("results", [])
            years = {}
            ids = film_ids(results, artist, title)[:10]
            if ids:                                   # when did each soundtrack album itself come out?
                try:
                    raw2, _ = fetch("https://itunes.apple.com/lookup?" + urllib.parse.urlencode(dict({"id": ",".join(str(i) for i in ids), "entity": "album"}, **({"country": country} if country else {}))), 400000, "application/json")
                    for c in json.loads(raw2.decode("utf-8", "replace")).get("results", []):
                        if c.get("wrapperType") == "collection" and _year(c.get("releaseDate")):
                            years[c.get("collectionId")] = _year(c.get("releaseDate"))
                except Exception:
                    years = {}                        # unknown: no soundtrack art this time
            best = pick(results, artist, title, years)
            if best:
                art = re.sub(r"/\d+x\d+bb\.", "/600x600bb.", best["artworkUrl100"])
                if not art.startswith("https://") or ".mzstatic.com/" not in art:
                    continue
                data, ctype = fetch(art, 600000, "image/*")
                if len(data) > 600000 or not ctype.startswith("image/") or len(data) < 500:
                    continue
                iid = hashlib.sha1(art.encode()).hexdigest()[:16]
                with _lock:
                    _img[iid] = (ctype.split(";")[0], data)
                    while len(_img) > MAX_IMG:
                        _img.pop(next(iter(_img)))
                res = {"id": iid, "artist": best.get("artistName", ""), "title": best.get("trackName", ""), "album": best.get("collectionName", ""),
                       "track": best.get("trackId")}
                break
    except Exception:
        return None                          # offline or blocked: do not remember a failure caused by the network
    with _lock:
        _text[key] = (now, res)
        while len(_text) > MAX_TEXT:
            _text.pop(next(iter(_text)))
    return res


def image(iid):
    with _lock:
        return _img.get(re.sub(r"[^0-9a-f]", "", str(iid))[:16])


# ---------------------------------------------------------------- "Open in": the song on the big streaming services
# song.link's public API was retired (31 July 2026), and Spotify, YouTube and Tidal need a developer account for theirs.
# So: Apple Music and Deezer give the exact song page, checked for your country (Apple's store for your country;
# Deezer lists the countries each track plays in). The others open the service's own search for "artist title", and are
# listed only where that service operates.
SERVICES = {"amazonMusic": "Amazon Music", "appleMusic": "Apple Music", "deezer": "Deezer", "pandora": "Pandora", "soundcloud": "SoundCloud",
            "spotify": "Spotify", "tidal": "Tidal", "youtube": "YouTube", "youtubeMusic": "YouTube Music"}
_EU = set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split())
# where each searched service operates (None = almost everywhere; then only the listed countries are left out)
WHERE = {
    "pandora": {"US"},
    "tidal": _EU | set("US CA GB AU NZ NO CH IS LI MX BR AR CL CO PE ZA NG UG KE IL AE SG MY TH HK JP JM DO PR".split()),
    "amazonMusic": _EU | set("US CA GB AU NZ JP IN BR MX CH NO".split()),
}
NOT_IN = {"spotify": {"CN", "RU", "BY", "IR", "KP", "SY", "CU"}, "youtube": {"CN", "KP", "IR"}, "youtubeMusic": {"CN", "KP", "IR", "RU", "BY"},
          "soundcloud": {"CN", "KP"}}
SEARCH = {
    "amazonMusic": "https://music.amazon.com/search/{q}", "pandora": "https://www.pandora.com/search/{q}/all",
    "soundcloud": "https://soundcloud.com/search?q={q}", "spotify": "https://open.spotify.com/search/{q}",
    "tidal": "https://tidal.com/search?q={q}", "youtube": "https://www.youtube.com/results?search_query={q}",
    "youtubeMusic": "https://music.youtube.com/search?q={q}",
}
_links = {}                      # (track id, country) -> (time, [links])
# the store country when no location is saved (the saved location's country is used first); shared entries take
# their largest country, and "eu" and "intl" have none
REGION_CC = {"au": "AU", "us": "US", "latam": "MX", "cn": "CN", "my": "MY", "jp": "JP", "kr": "KR", "tw": "TW", "th": "TH",
             "ph": "PH", "in": "IN", "vn": "VN"}


def _apple(tid, cc, fetch):
    raw, _ = fetch("https://itunes.apple.com/lookup?" + urllib.parse.urlencode({"id": tid, "country": cc or "US"}), 400000, "application/json")
    for r in json.loads(raw.decode("utf-8", "replace")).get("results", []):
        u = re.sub(r"[?&]uo=\d+$", "", r.get("trackViewUrl") or "")
        if r.get("trackId") == tid and u.startswith("https://"):
            return u, r.get("artistName", ""), r.get("trackName", "")
    return None, "", ""


def _deezer(artist, title, cc, fetch):
    q = 'artist:"%s" track:"%s"' % (artist.replace('"', ""), title.replace('"', ""))
    raw, _ = fetch("https://api.deezer.com/search?" + urllib.parse.urlencode({"q": q, "limit": 10}), 400000, "application/json")
    best = None
    for r in json.loads(raw.decode("utf-8", "replace")).get("data", []) or []:
        sa, st = _sim(artist, (r.get("artist") or {}).get("name", "")), _sim(title, r.get("title", ""))
        if sa >= 0.6 and st >= 0.6 and (best is None or sa + st > best[0]):
            best = (sa + st, r)
    if not best:
        return None
    tid = best[1].get("id")
    raw, _ = fetch("https://api.deezer.com/track/%d" % int(tid), 400000, "application/json")
    t = json.loads(raw.decode("utf-8", "replace"))
    avail = t.get("available_countries")
    if cc and isinstance(avail, list) and avail and cc not in avail:
        return None                               # not playable in your country
    link = t.get("link") or best[1].get("link") or ""
    return link if link.startswith("https://www.deezer.com/") else None


def links(track_id, country, artist="", title="", fetch=_fetch):
    """-> [{"service", "name", "url", "kind"}] sorted by name. kind "song" is the exact song page, checked for `country`;
    kind "search" opens that service's search for the song (listed only where the service operates)."""
    try:
        tid = int(track_id)
    except (TypeError, ValueError):
        tid = None
    cc = (country or "").upper()
    if not re.fullmatch(r"[A-Z]{2}", cc):
        cc = ""
    artist, title = str(artist or "")[:120], str(title or "")[:160]
    key = (tid, cc, artist.lower(), title.lower())
    now = time.time()
    with _lock:
        hit = _links.get(key)
        if hit and now - hit[0] < 24 * 3600:
            return hit[1]
    out, failed = [], False
    if tid:
        try:
            u, a2, t2 = _apple(tid, cc, fetch)
            if u:
                out.append({"service": "appleMusic", "name": "Apple Music", "url": u, "kind": "song"})
                artist, title = artist or a2, title or t2
        except Exception:
            failed = True
    if artist and title:
        try:
            u = _deezer(artist, title, cc, fetch)
            if u:
                out.append({"service": "deezer", "name": "Deezer", "url": u, "kind": "song"})
        except Exception:
            failed = True
        q = urllib.parse.quote(_norm_q(artist) + " " + _norm_q(title), safe="")
        for k, tpl in SEARCH.items():
            if cc and k in WHERE and cc not in WHERE[k]:
                continue
            if not cc and k == "pandora":
                continue
            if cc in NOT_IN.get(k, ()):
                continue
            out.append({"service": k, "name": SERVICES[k], "url": tpl.format(q=q), "kind": "search"})
    out.sort(key=lambda x: x["name"].lower())
    if not failed:                                 # don't keep an answer that is missing a part because of the network
        with _lock:
            _links[key] = (now, out)
            while len(_links) > MAX_TEXT:
                _links.pop(next(iter(_links)))
    return out


def _norm_q(s):
    s = re.sub(r"\((feat|ft|with)[^)]*\)|\[(feat|ft|with)[^]]*\]", " ", s, flags=re.I)
    s = re.sub(r"\s+-\s+[^-]*\b(remaster(ed)?|radio edit|single version|mono|stereo|edit)\b.*$", "", s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip()


# Each service's own icon, fetched from its own website by this server and kept (so the page shows the real one and
# the browser never contacts those sites just to draw the list). Unreachable: the page shows the service's initial.
ICON_URLS = {
    "amazonMusic": "https://music.amazon.com/favicon.ico", "appleMusic": "https://music.apple.com/favicon.ico",
    "deezer": "https://www.deezer.com/favicon.ico", "pandora": "https://www.pandora.com/favicon.ico",
    "soundcloud": "https://soundcloud.com/favicon.ico", "spotify": "https://open.spotify.com/favicon.ico",
    "tidal": "https://tidal.com/favicon.ico", "youtube": "https://www.youtube.com/favicon.ico",
    "youtubeMusic": "https://music.youtube.com/favicon.ico",
}
_icons = {}                      # service -> (time, (content type, bytes) or None)


def icon(service, fetch=_fetch):
    """-> (content type, bytes) of the service's icon, or None. Kept for a week; a failure is retried after an hour."""
    url = ICON_URLS.get(service)
    if not url:
        return None
    now = time.time()
    with _lock:
        hit = _icons.get(service)
        if hit and now - hit[0] < (7 * 86400 if hit[1] else 3600):
            return hit[1]
    res = None
    try:
        data, ctype = fetch(url, 200000, "image/*")
        ctype = (ctype or "").split(";")[0].strip().lower()
        if ctype in ("image/vnd.microsoft.icon", "image/x-icon", "application/octet-stream") and data[:4] == b"\x00\x00\x01\x00":
            ctype = "image/x-icon"
        if 100 < len(data) <= 200000 and ctype.startswith("image/") and ctype != "image/svg+xml":
            res = (ctype, data)
    except Exception:
        res = None
    with _lock:
        _icons[service] = (now, res)
    return res
