#!/usr/bin/env python3
"""Draws the Skywave icon from code and renders every size (crisp at any resolution).
Run:  python3 tools/make_icons.py      (needs Python Playwright with Chromium, only to turn the SVG into PNGs)
Design: a tapering sine ribbon, a second fainter wave for depth, and a small sun-dot, on a deep night-sky gradient."""
import math, os, struct, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static")
IMG = os.path.join(ROOT, "img")


def ribbon(x0, x1, cy, amp, waves, phase, tmax, steps=200, envelope=True):
    """A filled wave whose thickness swells in the middle and fades to a point at both ends."""
    pts, top, bot = [], [], []
    for i in range(steps + 1):
        u = i / steps
        x = x0 + (x1 - x0) * u
        y = cy - amp * math.sin(2 * math.pi * (waves * u) + phase) * ((0.55 + 0.45 * math.sin(math.pi * u)) if envelope else 1.0)
        pts.append((x, y))
    for i, (x, y) in enumerate(pts):
        u = i / steps
        a = pts[max(i - 1, 0)]; b = pts[min(i + 1, steps)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy) or 1
        nx, ny = -dy / n, dx / n
        t = tmax * (math.sin(math.pi * u) ** 0.7 if envelope else 1.0) / 2
        top.append((x + nx * t, y + ny * t)); bot.append((x - nx * t, y - ny * t))
    poly = top + bot[::-1]
    return "M" + " L".join("%.1f %.1f" % p for p in poly) + "Z"


def svg(shape="round", bold=False):
    s = 1024
    rx = 232 if shape == "round" else 0
    if bold:        # small sizes: one thick wave, nothing fine
        main = ribbon(150, 874, 512, 175, 1.0, 0.0, 190, envelope=False)
        layers = f'<path d="{main}" fill="url(#ribb)"/>'
    else:
        w1 = ribbon(104, 920, 512, 132, 2.0, 0.0, 92, envelope=True)
        w2 = ribbon(104, 920, 512, 132, 2.0, 0.95, 92, envelope=True)
        w3 = ribbon(104, 920, 512, 132, 2.0, 1.9, 92, envelope=True)
        layers = (f'<path d="{w3}" fill="url(#ribb3)" opacity=".38"/><path d="{w2}" fill="url(#ribb2)" opacity=".62"/>'
                  f'<path d="{w1}" fill="#6fe8ff" opacity=".5" filter="url(#soft)"/><path d="{w1}" fill="url(#ribb)"/>')
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}" width="{s}" height="{s}">
<defs>
<linearGradient id="bg" x1="0.15" y1="0" x2="0.85" y2="1"><stop offset="0" stop-color="#0f1b45"/><stop offset=".55" stop-color="#0b2a55"/><stop offset="1" stop-color="#0b6a86"/></linearGradient>
<radialGradient id="glow" cx="0.25" cy="0.1" r="0.8"><stop offset="0" stop-color="#8cb8ff" stop-opacity=".32"/><stop offset="1" stop-color="#8cb8ff" stop-opacity="0"/></radialGradient>
<linearGradient id="ribb" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#a6f4ff"/><stop offset=".5" stop-color="#ffffff"/><stop offset="1" stop-color="#9fe6ff"/></linearGradient>
<linearGradient id="ribb2" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#52d3ff"/><stop offset="1" stop-color="#7aa8ff"/></linearGradient>
<linearGradient id="ribb3" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7a8cff"/><stop offset="1" stop-color="#b58cff"/></linearGradient>
<filter id="soft" x="-20%" y="-30%" width="140%" height="160%"><feGaussianBlur stdDeviation="20"/></filter>
<clipPath id="c"><rect width="{s}" height="{s}" rx="{rx}"/></clipPath>
</defs>
<g clip-path="url(#c)">
<rect width="{s}" height="{s}" fill="url(#bg)"/><rect width="{s}" height="{s}" fill="url(#glow)"/>
{layers}
<rect width="{s}" height="{s}" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="4" rx="{rx}"/>
</g></svg>'''


def write(name, text):
    with open(os.path.join(IMG, name), "w") as f:
        f.write(text)


def render(jobs):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        for src, out, size in jobs:
            pg = b.new_page(viewport={"width": size, "height": size})
            pg.set_content('<body style="margin:0;background:transparent">' + src.replace('width="1024" height="1024"', 'width="%d" height="%d"' % (size, size), 1) + "</body>")
            pg.screenshot(path=os.path.join(IMG, out), omit_background=True)
            pg.close()
        b.close()


def main():
    os.makedirs(IMG, exist_ok=True)
    rounded, full, bold = svg("round"), svg("full"), svg("round", bold=True)
    write("skywave.svg", rounded)
    write("skywave-full.svg", full)
    # Phones and lock screens draw their own corners, so every large picture is a full square with no transparent corners
    # (rounded ones show white corners). Only the tiny browser-tab icons and the in-page logo keep rounded corners.
    jobs = [(full, "skywave-1024.png", 1024), (full, "skywave-512.png", 512), (full, "skywave-192.png", 192),
            (full, "skywave-touch.png", 180), (full, "skywave-touch-1024.png", 1024), (full, "skywave-maskable-512.png", 512),
            (rounded, "skywave-logo-96.png", 96), (rounded, "skywave-logo-192.png", 192),
            (bold, "skywave-32.png", 32), (bold, "skywave-16.png", 16), (bold, "skywave-48.png", 48)]
    render(jobs)
    # favicon.ico with 16, 32 and 48 px PNG images inside
    imgs = [(n, open(os.path.join(IMG, "skywave-%d.png" % n), "rb").read()) for n in (16, 32, 48)]
    head = struct.pack("<HHH", 0, 1, len(imgs)); off = 6 + 16 * len(imgs); ent = b""; body = b""
    for n, d in imgs:
        ent += struct.pack("<BBBBHHII", n, n, 0, 0, 1, 32, len(d), off + len(body)); body += d
    open(os.path.join(ROOT, "favicon.ico"), "wb").write(head + ent + body)
    print("icons written to", IMG)


if __name__ == "__main__":
    sys.exit(main())
