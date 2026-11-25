/* fx.js - the cursor spotlight: cards glow softly where the pointer is (Skywave and Depth always; Walnut with full motion).
   It only sets two CSS variables; each style sheet decides what the glow looks like. */
(function () {
  'use strict';
  let raf = 0, ev = null;
  const SPOT = { skywave: 1, depth: 1, walnut: 2 };
  document.addEventListener('pointermove', e => {
    const s = SPOT[document.documentElement.dataset.style];
    if (!s || e.pointerType === 'touch' || (s === 2 && document.documentElement.dataset.motion !== 'full')) return;
    ev = e; if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0; const t = ev.target && ev.target.closest && ev.target.closest('.card,.tile,.station,.hw,.cta,.banner,.list-opt,.th-card,.sat-card,.sensor'); if (!t) return;
      const r = t.getBoundingClientRect(); t.style.setProperty('--mx', (ev.clientX - r.left) + 'px'); t.style.setProperty('--my', (ev.clientY - r.top) + 'px');
    });
  }, { passive: true });
})();

/* every big frequency readout (Radio, Ham, Scanner) records how many digits it has, so the style sheet can shrink long ones to fit */
(function () {
  'use strict';
  let t = 0;
  const run = () => { t = 0; document.querySelectorAll('.freq').forEach(el => { if (el.classList.contains('editing')) return; const n = ((el.textContent || '').match(/[0-9]/g) || []).length; if (el.dataset.len !== String(n)) el.dataset.len = n; }); };
  const kick = () => { if (!t) t = setTimeout(run, 60); };
  const start = () => { new MutationObserver(kick).observe(document.body, { childList: true, subtree: true, characterData: true }); run(); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
