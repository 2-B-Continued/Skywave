"""Measures rendered text contrast from the screenshots pw_pixcontrast.js takes.
For each text box: the background is the most common lightness in the box, the text is the lightness furthest from it
(near the extreme, so anti-aliasing does not count). WCAG contrast of the two. Anti-aliasing makes thin text read a
little lower than its colours would, so the bar is 3:1 for all text: anything under it is hard to read for anyone."""
import json, sys, os, glob
from PIL import Image
out = sys.argv[1]; bar = float(sys.argv[2]) if len(sys.argv) > 2 else 3.0
def lin(c):
    c /= 255; return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
def L(p): return 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2])
cache, bad, total = {}, [], 0
for jf in sorted(glob.glob(os.path.join(out, '*.json'))):
    for it in json.load(open(jf)):
        if it.get('dis'): continue
        f = os.path.join(out, it['file'])
        if f not in cache: cache[f] = Image.open(f).convert('RGB')
        im = cache[f]; box = (int(it['x']), int(it['y']), int(it['x'] + it['w']), int(it['y'] + it['h']))
        px = list(im.crop(box).getdata())
        if len(px) < 30: continue
        lums = sorted(L(p) for p in px)
        # the background: the most common lightness band
        bands = {}
        for v in lums: k = round(v * 50); bands[k] = bands.get(k, 0) + 1
        bg = max(bands, key=bands.get) / 50
        far = [v for v in lums if abs(v - bg) > 0.0]
        lo, hi = lums[int(len(lums) * 0.03)], lums[int(len(lums) * 0.97) - 1]
        txt = hi if abs(hi - bg) > abs(lo - bg) else lo
        r = (max(bg, txt) + 0.05) / (min(bg, txt) + 0.05)
        total += 1
        if r < bar: bad.append((round(r, 2), it['page'], it['vw'], it['sel'], it['t'], it['file']))
bad.sort()
for b in bad[:120]: print(b)
print(f'{len(bad)} of {total} text boxes under {bar}:1')
sys.exit(1 if bad else 0)
