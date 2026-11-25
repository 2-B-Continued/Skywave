/* Skywave - Home, Scanner and Planes pages, plus the shared map. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc, icon = RS.icon;

  // OpenStreetMap's tile servers refuse a tile request that carries no Referer (an error tile saying "403r Access
  // blocked. Referer is required"). Every Skywave page is served with "Referrer-Policy: no-referrer", so the tiles say
  // which site asks for them themselves: only the address of this Skywave (scheme, host and port, never the page's
  // path), which is what OpenStreetMap's tile usage policy asks for.
  const TILE_REFERRER = 'strict-origin-when-cross-origin';
  // ================================================================ shared map (OpenStreetMap tiles optional)
  RS.Map = function (el, opt) {
    const m = this; opt = opt || {};
    m.el = el; m.lat = opt.lat || 20; m.lon = opt.lon || 0; m.z = opt.zoom || (opt.lat ? 8 : 2); m.items = []; m.hit = [];
    m.tiles = RS.store.get('tiles', true); m.failed = 0; m.draw = opt.draw || function () { }; m.onPick = opt.onPick || function () { };
    el.innerHTML = '<div class="tiles"></div><canvas class="over"></canvas><div class="zoom"><button class="btn" data-zoom="1" aria-label="Zoom in">' + icon('plus') + '</button><button class="btn" data-zoom="-1" aria-label="Zoom out">' + icon('minus') + '</button></div><div class="attrib hide">&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a></div>';
    m.tl = el.querySelector('.tiles'); m.cv = el.querySelector('canvas'); m.attr = el.querySelector('.attrib');
    m.pool = {};
    const W = () => 256 * Math.pow(2, m.z);
    m.wx = lon => (lon + 180) / 360 * W();
    m.wy = lat => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * W(); };
    m.lonOf = x => x / W() * 360 - 180;
    m.latOf = y => { const n = Math.PI - 2 * Math.PI * y / W(); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
    m.proj = (lat, lon) => ({ x: m.wx(lon) - m.wx(m.lon) + m.cv.clientWidth / 2, y: m.wy(lat) - m.wy(m.lat) + m.cv.clientHeight / 2 });
    m.unproj = (x, y) => ({ lat: m.latOf(m.wy(m.lat) + y - m.cv.clientHeight / 2), lon: m.lonOf(m.wx(m.lon) + x - m.cv.clientWidth / 2) });
    m.kmPx = () => 40075.016 * Math.cos(m.lat * Math.PI / 180) / W();
    m.setView = (lat, lon, z) => { if (!Number.isFinite(+lat) || !Number.isFinite(+lon)) return; m.lat = +lat; m.lon = +lon; if (z) m.z = Math.min(Math.max(z, 2), 16); m.dirty = true; };   // never a centre that isn't a place
    m.zoomBy = (d, px, py) => {
      const nz = Math.min(Math.max(m.z + d, 2), 16); if (nz === m.z) return;
      if (px == null) { px = m.cv.clientWidth / 2; py = m.cv.clientHeight / 2; }
      const at = m.unproj(px, py); m.z = nz;
      const cx = m.wx(at.lon) - (px - m.cv.clientWidth / 2), cy = m.wy(at.lat) - (py - m.cv.clientHeight / 2);
      m.lon = m.lonOf(cx); m.lat = m.latOf(cy); m.dirty = true;
    };
    let drag = null;
    m.cv.addEventListener('pointerdown', e => { m.cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, lat: m.lat, lon: m.lon, moved: false, cx: m.wx(m.lon), cy: m.wy(m.lat) }; });
    m.cv.addEventListener('pointermove', e => {
      if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) { m.lon = m.lonOf(drag.cx - dx); m.lat = m.latOf(drag.cy - dy); m.dirty = true; m.following = false; }
    });
    m.cv.addEventListener('pointerup', e => {
      if (drag && !drag.moved) {
        const r = m.cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        let best = null, bd = 22; m.hit.forEach(h => { const dd = Math.hypot(h.x - x, h.y - y); if (dd < bd) { bd = dd; best = h; } });
        m.onPick(best ? best.item : null);
      }
      drag = null;
    });
    m.cv.addEventListener('wheel', e => { e.preventDefault(); const r = m.cv.getBoundingClientRect(); m.zoomBy(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    el.querySelectorAll('[data-zoom]').forEach(b => b.onclick = () => m.zoomBy(parseInt(b.dataset.zoom)));
    m.setTiles = on => { m.tiles = on; RS.store.set('tiles', on); m.dirty = true; if (!on) m.tl.innerHTML = '', m.pool = {}; };
    m.render = () => {
      const c = RS.fit(m.cv); if (!c) return; const g = c.g, w = c.w, h = c.h;
      g.clearRect(0, 0, w, h);
      const showTiles = m.tiles && m.failed < 6;
      m.attr.classList.toggle('hide', !showTiles);
      if (showTiles) {
        const cx = m.wx(m.lon), cy = m.wy(m.lat), n = Math.pow(2, m.z);
        const x0 = Math.floor((cx - w / 2) / 256), x1 = Math.floor((cx + w / 2) / 256), y0 = Math.floor((cy - h / 2) / 256), y1 = Math.floor((cy + h / 2) / 256);
        const want = {};
        for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
          if (ty < 0 || ty >= n) continue;
          const key = m.z + '/' + (((tx % n) + n) % n) + '/' + ty; want[key + '@' + tx] = [tx, ty, key];
        }
        Object.keys(m.pool).forEach(k => { if (!want[k]) { m.pool[k].remove(); delete m.pool[k]; } });
        Object.keys(want).forEach(k => {
          const t = want[k]; let img = m.pool[k];
          if (!img) { img = document.createElement('img'); img.alt = ''; img.draggable = false; img.referrerPolicy = TILE_REFERRER; img.onerror = () => { m.failed++; img.remove(); m.dirty = true; }; img.onload = () => { m.failed = 0; }; img.src = 'https://tile.openstreetmap.org/' + t[2] + '.png'; m.tl.appendChild(img); m.pool[k] = img; }
          img.style.left = Math.round(t[0] * 256 - cx + w / 2) + 'px'; img.style.top = Math.round(t[1] * 256 - cy + h / 2) + 'px';
        });
      } else if (m.tl.firstChild) { m.tl.innerHTML = ''; m.pool = {}; }
      m.hit = []; m.showTiles = showTiles;
      m.draw(g, w, h, showTiles);
    };
    m.loop = () => { if (m.dirty) { m.dirty = false; m.render(); } };
    window.addEventListener('resize', () => { m.dirty = true; });
  };

  // HOME: see home.js

  // SCANNER: see scanner.js

  // PLANES: see planes.js
})();
