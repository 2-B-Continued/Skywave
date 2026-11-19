/* scale.js - turns a bare range slider into one with a visible scale: tick values, named zones and a live readout. */
(function () {
  'use strict';
  const RS = window.RS;
  // RS.scale(input, { unit:'dB', zones:[[from,'Name','what it means'],...], ticks:[...] })
  RS.scale = (inp, o) => {
    if (!inp || inp._scaled) return; inp._scaled = true;
    const min = +inp.min, max = +inp.max, span = max - min, Z = o.zones, unit = o.unit || '';
    const wrap = document.createElement('div'); wrap.className = 'scale';
    const pct = v => ((v - min) / span * 100);
    const bar = Z.map((z, i) => { const a = z[0], b = i + 1 < Z.length ? Z[i + 1][0] : max + 1e-9; return '<i class="z' + i + '" style="left:' + pct(a) + '%;width:' + (pct(Math.min(b, max)) - pct(a)) + '%" title="' + RS.esc(z[1]) + '"></i>'; }).join('');
    const ticks = (o.ticks || [min, Z.length > 2 ? Z[Math.floor(Z.length / 2)][0] : Math.round((min + max) / 2), max]).map(v => '<span style="left:' + pct(v) + '%">' + v + '</span>').join('');
    const names = Z.map((z, i) => { const a = z[0], b = i + 1 < Z.length ? Z[i + 1][0] : max; return '<span style="left:' + pct(a) + '%;width:' + (pct(b) - pct(a)) + '%">' + RS.esc(z[1]) + '</span>'; }).join('');
    wrap.innerHTML = '<div class="scale-bar">' + bar + '<b class="scale-pos"></b></div><div class="scale-ticks">' + ticks + '</div><div class="scale-names">' + names + '</div><div class="scale-read" aria-live="polite"></div>';
    inp.insertAdjacentElement('afterend', wrap);
    const read = wrap.querySelector('.scale-read'), pos = wrap.querySelector('.scale-pos');
    const upd = () => {
      const v = +inp.value; let z = Z[0]; Z.forEach(q => { if (v >= q[0]) z = q; });
      pos.style.left = pct(v) + '%'; read.innerHTML = '<b>' + v + (unit ? ' ' + unit : '') + '</b> &middot; ' + RS.esc(z[1]) + (z[2] ? ': <span class="muted">' + RS.esc(z[2]) + '</span>' : '');
      inp.setAttribute('aria-valuetext', v + ' ' + unit + ', ' + z[1]);
    };
    inp.addEventListener('input', upd); inp.addEventListener('change', upd); inp._scaleUpd = upd; upd();
  };
})();
