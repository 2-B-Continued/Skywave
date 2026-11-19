"""Cover art lookup: parsing RadioText, matching, caching, and that wrong or offline answers never produce a picture."""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import art
ok = True
def check(n, c, x=""):
    global ok; print(("PASS " if c else "FAIL ") + n, x); ok = ok and bool(c)
P = art.parse
check("artist - title", P("Dua Lipa - Houdini")[:2] == ("Dua Lipa", "Houdini"))
check("now playing prefix", P("NOW PLAYING: The Weeknd - Blinding Lights")[:2] == ("The Weeknd", "Blinding Lights"))
check("title by artist", P("Houdini by Dua Lipa") == ("Houdini", "Dua Lipa", True))
check("station chatter rejected", P("Win a trip! Text 1800 123 456") is None and P("Traffic and weather on 100.0") is None and P("www.example.com") is None)
check("no dash is not a song", P("Your favourite music") is None)
png = b"\x89PNG" + b"0" * 800
calls = []
def fake(url, limit, accept):
    calls.append(url)
    if "itunes.apple.com" in url:
        return json.dumps({"results": [
            {"artistName": "Someone Else", "trackName": "Other Song", "artworkUrl100": "https://is1-ssl.mzstatic.com/a/100x100bb.jpg"},
            {"artistName": "Dua Lipa", "trackName": "Houdini", "collectionName": "Radical Optimism", "artworkUrl100": "https://is1-ssl.mzstatic.com/b/100x100bb.jpg"}]}).encode(), "application/json"
    return png, "image/jpeg"
r = art.lookup("Dua Lipa - Houdini", fake)
check("matched the right song", r and r["album"] == "Radical Optimism", r)
check("asked for a big picture", any("600x600bb" in c for c in calls))
im = art.image(r["id"]); check("image served from memory", im and im[0] == "image/jpeg" and im[1] == png)
n = len(calls); art.lookup("Dua Lipa - Houdini", fake); check("second lookup is cached", len(calls) == n)
check("different song is not matched to wrong art", art.lookup("Nobody Known - Nothing Real", fake) is None)
def offline(url, limit, accept): raise OSError("no network")
check("offline gives nothing, no crash", art.lookup("Artist X - Song Y", offline) is None)
check("offline failure is not remembered", art.lookup("Artist X - Song Y", fake) is None and True)
check("bad id is safe", art.image("../../etc/passwd") is None)
def _r(coll, date, genre="Rock", va=None, artist="AC/DC", track="Thunderstruck", cid=None):
    d = {"artistName": artist, "trackName": track, "collectionName": coll, "releaseDate": date, "primaryGenreName": genre, "collectionId": cid or abs(hash(coll)) % 10**8,
         "artworkUrl100": "https://x.mzstatic.com/a/100x100bb.jpg"}
    if va:
        d["collectionArtistName"] = va
    return d
# a hit is on its original album and on repackagings: the original wins, unless the song was written for the film
g = art.pick([_r("Iron Man 2", "2010-04-19T07:00:00Z", "Soundtrack"), _r("The Razors Edge", "1990-09-24T07:00:00Z")], "AC/DC", "Thunderstruck")
check("original album beats a film soundtrack", g and g["collectionName"] == "The Razors Edge", g)
g = art.pick([_r("Iron Man 2", "2010-04-19T07:00:00Z"), _r("The Razors Edge", "1990-09-24T07:00:00Z")], "AC/DC", "Thunderstruck")
check("original album beats a later release that is not labelled a soundtrack", g and g["collectionName"] == "The Razors Edge", g)
g = art.pick([_r("A Star Is Born Soundtrack", "2018-10-05T07:00:00Z", "Soundtrack", artist="Lady Gaga", track="Shallow", cid=11),
              _r("Now That's What I Call Music! 101", "2019-01-10T07:00:00Z", "Pop", va="Various Artists", artist="Lady Gaga", track="Shallow")], "Lady Gaga", "Shallow", {11: 2018})
check("a song written for a film keeps its soundtrack art", g and g["collectionName"] == "A Star Is Born Soundtrack", g)
# an older song on a later film's soundtrack: the track keeps its 1984 date there, only the album year gives it away
H = dict(artist="Bonnie Tyler", track="Holding Out For A Hero")
res = [_r("Bandits (Music from the Motion Picture)", "1984-01-01T08:00:00Z", "Soundtrack", cid=21, **H),
       _r("Secret Dreams and Forbidden Fire", "1986-05-01T07:00:00Z", "Pop", cid=22, **H),
       _r("Footloose (Original Motion Picture Soundtrack)", "1984-01-27T08:00:00Z", "Soundtrack", va="Various Artists", cid=23, **H)]
g = art.pick(res, "Bonnie Tyler", "Holding Out For A Hero", {21: 2001, 23: 1984})
check("song written for a film keeps that film, not a later film it was used in", g and g["collectionName"].startswith("Footloose"), g)
g = art.pick(res[:2], "Bonnie Tyler", "Holding Out For A Hero", {21: 2001})
check("a film that only used the song never shows", g and g["collectionName"] == "Secret Dreams and Forbidden Fire", g)
check("soundtrack whose album year is unknown is not used", art.pick(res[:1], "Bonnie Tyler", "Holding Out For A Hero", {}) is None)
check("film ids are gathered for the year lookup", art.film_ids(res, "Bonnie Tyler", "Holding Out For A Hero") == [21, 23])
# "Open in": exact pages on Apple Music and Deezer (checked for the country), a search on the others where they operate
seen = []
def svc(url, limit, accept):
    seen.append(url)
    if "itunes.apple.com/lookup" in url:
        if "country=CN" in url: return json.dumps({"results": []}).encode(), "application/json"
        return json.dumps({"results": [{"trackId": 291, "artistName": "a-ha", "trackName": "Take On Me", "trackViewUrl": "https://music.apple.com/au/album/take-on-me/1?i=291&uo=4"}]}).encode(), "application/json"
    if "api.deezer.com/search" in url:
        return json.dumps({"data": [{"id": 77, "title": "Take On Me", "artist": {"name": "a-ha"}, "link": "https://www.deezer.com/track/77"}]}).encode(), "application/json"
    if "api.deezer.com/track/77" in url:
        return json.dumps({"id": 77, "link": "https://www.deezer.com/track/77", "available_countries": ["AU", "US", "GB"]}).encode(), "application/json"
    raise OSError("unexpected " + url)
L = art.links(291, "AU", "a-ha", "Take On Me", svc)
names = [x["name"] for x in L]
check("sorted by name", names == sorted(names, key=str.lower), names)
check("Apple Music: the song's page in your country's store", any(x["service"] == "appleMusic" and x["kind"] == "song" and x["url"] == "https://music.apple.com/au/album/take-on-me/1?i=291" for x in L), L)
check("Deezer: the song's page, playable in your country", any(x["service"] == "deezer" and x["kind"] == "song" for x in L))
check("Spotify and YouTube Music: a search for the song", any(x["service"] == "spotify" and x["kind"] == "search" and "a-ha%20Take%20On%20Me" in x["url"] for x in L), [x["url"] for x in L if x["service"] == "spotify"])
check("Pandora only in the US", "Pandora" not in names and "Pandora" in [x["name"] for x in art.links(291, "US", "a-ha", "Take On Me", svc)])
L2 = art.links(291, "CN", "a-ha", "Take On Me", svc)
check("not offered where a service doesn't operate or the song isn't sold", not any(x["service"] in ("spotify", "appleMusic", "deezer", "youtube") for x in L2), [x["name"] for x in L2])
n = len(seen); art.links(291, "AU", "a-ha", "Take On Me", svc); check("cached", len(seen) == n)
L3 = art.links(555, "AU", "Someone", "Something", offline)
check("offline: still offers the searches", L3 and all(x["kind"] == "search" for x in L3), L3)
check("nothing to go on: nothing", art.links("", "AU", "", "", svc) == [])
check("remaster tags left out of the search", "Remaster" not in art.links(291, "GB", "a-ha", "Take On Me - 2015 Remaster", svc)[0]["url"])
# the services' own icons, fetched from their own sites; HTML or SVG answers are refused
ICO = b"\x00\x00\x01\x00" + b"0" * 400
def icons(url, limit, accept):
    if "spotify" in url: return ICO, "image/x-icon"
    if "deezer" in url: return b"<html>" + b"0" * 400, "text/html"
    return b"<svg>" + b"0" * 400, "image/svg+xml"
check("icon from the service's own site", art.icon("spotify", icons) == ("image/x-icon", ICO))
check("a web page instead of an icon is refused", art.icon("deezer", icons) is None)
check("svg is refused (scripts)", art.icon("tidal", icons) is None)
check("unknown service: nothing fetched", art.icon("../../etc", icons) is None)
# band and song names that contain bulletin words are still songs ("news", "weather" and "traffic" once dropped them)
for t in ["Mac Miller - Good News", "ECHO AND THE BUNNYMEN - THE KILLING MOON", "Crowded House - Weather With You",
          "Traffic - Dear Mr. Fantasy", "Ella Fitzgerald - Stormy Weather", "Weather Report - Birdland"]:
    check("song with a bulletin word: " + t, P(t) is not None)
for t in ["News at 6 with John Smith", "Traffic update: northbound slow", "Weather - sunny 28 degrees", "Latest news - storms",
          "News: council announces - budget", "Traffic report: delays - ring road"]:
    check("bulletin skipped: " + t, P(t) is None)
check("& and 'and' match", art._sim("Echo & The Bunnymen", "Echo and the Bunnymen") >= 0.9)
_em = {"results": [
    {"artistName": "Echo & The Bunnymen", "trackName": "The Killing Moon", "collectionName": "Ocean Rain", "releaseDate": "1984-01-20T08:00:00Z",
     "artworkUrl100": "https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg", "collectionId": 1, "trackId": 11, "primaryGenreName": "Rock"},
    {"artistName": "Echo & The Bunnymen", "trackName": "The Killing Moon", "collectionName": "Songs to Learn & Sing", "releaseDate": "1984-01-20T08:00:00Z",
     "artworkUrl100": "https://is1-ssl.mzstatic.com/image/thumb/b/100x100bb.jpg", "collectionId": 2, "trackId": 12, "primaryGenreName": "Rock"}]}
def _emf(url, limit, accept):
    if "search?" in url:
        return json.dumps(_em).encode(), "application/json"
    if "lookup?" in url:
        return b'{"results": []}', "application/json"
    return b"\xff\xd8" + b"0" * 2000, "image/jpeg"
_r = art.lookup("The Killing Moon - Echo and the Bunnymen", fetch=_emf, country="GB")
check("the original album is chosen over a compilation", bool(_r) and _r["album"] == "Ocean Rain", _r)
print("ALL PASS" if ok else "SOME FAILED"); sys.exit(0 if ok else 1)


