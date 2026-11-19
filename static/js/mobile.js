/* mobile.js - small helpers for the phone layout: page title in the top bar, iOS status-bar colour, keyboard-safe docking. */
(function () {
  'use strict';
  const RS = window.RS;
  const names = { home: 'Home', radio: 'Radio', scanner: 'Scanner', planes: 'Planes', space: 'Space', ham: 'Ham radio', sensors: 'Sensors', explore: 'Explore', library: 'Library', lab: 'Lab', settings: 'Settings' };
  function title(p) { const el = document.getElementById('m-title'); if (el) { el.textContent = RS.t ? RS.t(names[p] || '') : (names[p] || ''); } }
  function chrome() {
    let m = document.querySelector('meta[name="theme-color"]'); if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); }
    m.content = RS.cssv('--chassis') || '#e3e8ea';
  }
  RS.on('page', title); RS.on('theme', chrome); window.addEventListener('load', () => { chrome(); title(RS.page); });
  setTimeout(() => { chrome(); title(RS.page); }, 600);
  // hide the fixed dock while a text field is focused, so the on-screen keyboard never leaves it floating over the field
  const dock = () => document.body.classList.toggle('kbd-open', /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName) && !/range|checkbox|radio|button/.test((document.activeElement || {}).type || ''));
  document.addEventListener('focusin', dock); document.addEventListener('focusout', () => setTimeout(dock, 50));
})();
