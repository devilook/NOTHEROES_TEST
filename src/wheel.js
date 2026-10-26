// Колесо инициативы: циферблат на 30 мест с одной стрелкой.
// Граница 30 | 1 — сверху; переходить её сдвигом нельзя.
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const SIZE = 320, C = SIZE / 2, R = 124, DOT = 12;

  function el(tag, attrs, parent, text) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  const angle = (slot) => ((slot - 0.5) * 12 - 90) * Math.PI / 180;
  const at = (slot, r) => [C + r * Math.cos(angle(slot)), C + r * Math.sin(angle(slot))];

  // opts: { options: [slot], pointer, title, subtitle, hoverSlot }
  function draw(svg, state, opts) {
    const E = root.NHEngine;
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    svg.innerHTML = '';
    el('circle', { cx: C, cy: C, r: R + 30, class: 'w-face' }, svg);
    el('circle', { cx: C, cy: C, r: R, class: 'w-track' }, svg);

    // Граница 30 | 1
    const [bx1, by1] = [C, C - R + 18], [bx2, by2] = [C, C - R - 30];
    el('line', { x1: bx1, y1: by1, x2: bx2, y2: by2, class: 'w-border' }, svg);

    // Стрелка
    if (opts.pointer) {
      // Стрелка начинается за подписью в центре, чтобы не перечёркивать её
      const [px, py] = at(opts.pointer, R - DOT - 6);
      const [sx, sy] = at(opts.pointer, 62);
      el('line', { x1: sx, y1: sy, x2: px, y2: py, class: 'w-hand' }, svg);
      el('circle', { cx: sx, cy: sy, r: 4, class: 'w-hub' }, svg);
    }

    const options = new Set(opts.options || []);
    for (let s = 1; s <= E.SLOTS; s++) {
      const [x, y] = at(s, R);
      const [lx, ly] = at(s, R + 21);
      el('text', { x: lx, y: ly, class: 'w-num' + (s === opts.pointer ? ' cur' : '') }, svg, s);
      const id = state.wheel[s];
      const g = el('g', { class: 'w-slot' + (options.has(s) ? ' option' : '') + (s === opts.hoverSlot ? ' hover' : ''), 'data-slot': s }, svg);
      if (id) {
        const e = E.entity(state, id);
        g.setAttribute('class', g.getAttribute('class') + ' f' + e.faction + (e.kind === 'hero' ? ' hero' : ''));
        if (s === opts.pointer) el('circle', { cx: x, cy: y, r: DOT + 5, class: 'w-current' }, g);
        el('circle', { cx: x, cy: y, r: DOT, class: 'w-token' }, g);
        el('text', { x, y: y + 0.5, class: 'w-label' }, g, e.label);
      } else {
        el('circle', { cx: x, cy: y, r: options.has(s) ? DOT : 4, class: 'w-empty' }, g);
        if (options.has(s)) el('text', { x, y: y + 0.5, class: 'w-opt-label' }, g, s);
      }
      // Широкая невидимая зона для клика
      el('circle', { cx: x, cy: y, r: DOT + 4, class: 'w-hit' }, g);
    }

    if (opts.title) el('text', { x: C, y: C - 2, class: 'w-title' }, svg, opts.title);
    if (opts.subtitle) el('text', { x: C, y: C + 20, class: 'w-sub' }, svg, opts.subtitle);
  }

  root.NHWheel = { draw };
})(typeof self !== 'undefined' ? self : this);
