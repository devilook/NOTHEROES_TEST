// Лоток кубиков: анимация бросков к6 и к30. Значения приходят из движка,
// здесь только показ.
(function (root) {
  'use strict';
  const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
  const reduced = () => root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));

  function setFace(el, sides, v) {
    if (sides === 6) {
      el.querySelector('.pips').innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9]
        .map((i) => `<i class="${PIPS[v].includes(i) ? 'on' : ''}"></i>`).join('');
    } else {
      el.querySelector('.num').textContent = v;
    }
  }

  function makeDie(item) {
    const wrap = document.createElement('figure');
    wrap.className = 'die-slot ' + (item.cls || '');
    wrap.innerHTML = `<div class="die d${item.sides}">${item.sides === 6 ? '<div class="pips"></div>' : '<span class="num"></span>'}</div>
      <figcaption><span class="cap">${item.caption || ''}</span><span class="note"></span></figcaption>`;
    setFace(wrap, item.sides, 1);
    return wrap;
  }

  async function rollOne(wrap, item) {
    const die = wrap.querySelector('.die');
    if (!reduced()) {
      die.classList.add('rolling');
      for (let i = 0; i < 10; i++) {
        setFace(wrap, item.sides, 1 + Math.floor(Math.random() * item.sides));
        await wait(50);
      }
      die.classList.remove('rolling');
    }
    setFace(wrap, item.sides, item.value);
    die.classList.add('landed');
    if (item.good === true) wrap.classList.add('good');
    if (item.good === false) wrap.classList.add('bad');
    wrap.querySelector('.note').innerHTML = item.note || '';
  }

  // items: [{ sides, value, caption, note, cls, batch, good }]
  // Кубики с одинаковым batch бросаются одновременно, группы — по очереди.
  async function play(tray, items, summary) {
    tray.querySelector('.dice-row').innerHTML = '';
    tray.querySelector('.dice-summary').innerHTML = '';
    const groups = [];
    for (const it of items) {
      const last = groups[groups.length - 1];
      if (last && it.batch != null && last[0].batch === it.batch) last.push(it);
      else groups.push([it]);
    }
    for (const g of groups) {
      const els = g.map((it) => {
        const el = makeDie(it);
        tray.querySelector('.dice-row').appendChild(el);
        return el;
      });
      await Promise.all(g.map((it, i) => rollOne(els[i], it)));
      await wait(reduced() ? 0 : 220);
    }
    tray.querySelector('.dice-summary').innerHTML = summary || '';
  }

  function note(tray, html) {
    tray.querySelector('.dice-row').innerHTML = '';
    tray.querySelector('.dice-summary').innerHTML = html;
  }

  root.NHDice = { play, note };
})(typeof self !== 'undefined' ? self : this);
