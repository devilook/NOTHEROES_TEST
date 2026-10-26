// Ширма игрока: герой и 5 юнитов фракции, как на бумажной ширме.
// Показывает живые значения (здоровье, монеты, место на колесе, состояние способности).
(function (root) {
  'use strict';

  // ---------- Значки (SVG, цвет — currentColor) ----------
  const svg = (body, vb) => `<svg viewBox="${vb || '0 0 24 24'}" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    sword: svg('<path d="M14.5 2 13 3.5v10h-2v-10L9.5 2h5zM8 14.5h8v2H13v3.5l1 1.5h-4l1-1.5v-3.5H8z" fill="currentColor"/>'),
    bow: svg('<path d="M4 20 18 6M18 6h-5M18 6v5" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M4 20l3-1-2-2z" fill="currentColor"/>'),
    shield: svg('<path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5z" fill="currentColor"/>'),
    chevrons: svg('<path d="M4 11l8-6 8 6M4 16l8-6 8 6M4 21l8-6 8 6" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linejoin="round"/>'),
    wing: svg('<path d="M21 3C13 4 6 9 4 20c3-4 6-6 10-7-2 0-4 0-6 1 4-3 8-4 11-6-3 0-5 0-7 1 4-2 7-4 9-6z" fill="currentColor"/>'),
    hourglass: svg('<path d="M6 2h12v2h-1v3c0 2-2 4-3.5 5 1.5 1 3.5 3 3.5 5v3h1v2H6v-2h1v-3c0-2 2-4 3.5-5C9 11 7 9 7 7V4H6zm3 2v3c0 1 1.5 2.5 3 3.5 1.5-1 3-2.5 3-3.5V4z" fill="currentColor"/>'),
    heart: svg('<path d="M12 21C5 16 2 12.5 2 8.5 2 5.5 4.5 3 7.5 3c2 0 3.5 1 4.5 2.5C13 4 14.5 3 16.5 3 19.5 3 22 5.5 22 8.5c0 4-3 7.5-10 12.5z" fill="currentColor"/>'),
    coin: svg('<circle cx="12" cy="12" r="10" fill="currentColor"/><circle cx="12" cy="12" r="7" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="1.5"/>'),
  };

  // Эмблемы фракций
  const EMBLEMS = {
    undead: svg('<path d="M12 2C6.5 2 3 6 3 10.5c0 3 1.4 5 3.5 6V20h3v-2h1v2h3v-2h1v2h3v-3.5c2.1-1 3.5-3 3.5-6C21 6 17.5 2 12 2zM8.5 9a2.2 2.5 0 1 1 0 5 2.2 2.5 0 0 1 0-5zm7 0a2.2 2.5 0 1 1 0 5 2.2 2.5 0 0 1 0-5zM12 13.5l1.3 2.5h-2.6z" fill="currentColor"/>'),
    bastion: svg('<path d="M4 3h3v2h2V3h2v2h2V3h2v2h2V3h3v7l-2 1v10H6V11l-2-1zm6 12v6h4v-6a2 2 0 0 0-4 0z" fill="currentColor"/>'),
    sylvans: svg('<path d="M20 3C9 3 4 9 4 15c0 2 .6 3.6 1.4 5L4 22h2l1.2-1.7C8.6 21.4 10.3 22 12 22c6 0 9-6 8-19zM7 19c2-5 5-8 10-11-4 3-7 7-8.6 12z" fill="currentColor"/>'),
    demons: svg('<path d="M3 2c0 5 2 8 5 9-1 1-1.5 2.5-1.5 4 0 4 2.5 7 5.5 7s5.5-3 5.5-7c0-1.5-.5-3-1.5-4 3-1 5-4 5-9-2 3-4 4.5-6.5 5C14 6.3 13 6 12 6s-2 .3-2.5 1C7 6.5 5 5 3 2zm6 12 2 1-2 1zm6 0v2l-2-1z" fill="currentColor"/>'),
  };

  const COUNTER = {
    '+': { sym: '+', cls: 'c-plus', text: 'отпор: всегда' },
    '=': { sym: '=', cls: 'c-eq', text: 'отпор: 50/50 (к6 4–6)' },
    x: { sym: '×', cls: 'c-no', text: 'отпор: никогда' },
  };

  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  // Выделить ключевые слова в тексте способности, как на ширме.
  function abilityText(t) {
    return esc(t)
      .replace(/(\d+ )?чист(ый|ого) урон[а]?/gi, (m) => `<b class="pure">${m}</b>`)
      .replace(/\+(\d+) здоровья/g, (m, n) => `<b class="heal">+${n} здоровья</b>`)
      .replace(/(\d+) монет/g, (m, n) => `<b class="gold">${n} монет</b>`)
      .replace(/(?<![+\d])(\d+) здоровья/g, (m, n) => `<b class="heal">${n} здоровья</b>`)
      .replace(/максимальный урон/gi, (m) => `<b class="maxdmg">${m}</b>`);
  }

  function stateBadge(st) {
    return `<span class="ab-state s-${st}">${{ ready: 'заряжена', active: 'активна', spent: 'разряжена' }[st]}</span>`;
  }

  // Портрет с ширмы, если он есть; иначе крупная римская цифра.
  function portrait(opts, file, fallback) {
    const roman = `<span class="big-roman">${fallback}</span>`;
    if (!opts.portraits) return roman;
    return `<img class="art" src="assets/portraits/${opts.key}/${file}.jpg" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'big-roman',textContent:'${fallback}'}))">`;
  }

  function statCell(cls, icon, value, title, extra) {
    return `<div class="st ${cls}" title="${esc(title)}">${extra || ''}<span class="ico">${icon}</span><span class="val">${value}</span></div>`;
  }

  // u — юнит из данных фракции, live — сущность в партии (может не быть)
  function unitCard(E, u, live, opts) {
    const roman = E.ROMAN[u.num - 1];
    const hp = live ? live.hp : u.hp;
    const c = COUNTER[u.counter];
    let status = '';
    if (live) {
      if (!live.alive) status = '<span class="tag dead">погиб</span>';
      else if (live.swallowedBy) status = '<span class="tag">проглочен</span>';
      else {
        if (live.slot) status += `<span class="tag">место ${live.slot}</span>`;
        if (live.pos) status += `<span class="tag">${E.cellName(...live.pos)}</span>`;
        if (live.blinded) status += '<span class="tag warn">ослеплён</span>';
        if (live.rooted) status += '<span class="tag warn">опутан</span>';
        if (live.hunted) status += '<span class="tag warn">метка охоты</span>';
      }
    }
    const ab = u.ability;
    let abState = '';
    if (ab && ab.pending) abState = '<span class="ab-state s-pending">ждёт уточнения</span>';
    else if (ab && ab.kind === 'active') abState = stateBadge(live ? live.abilityState : 'ready');
    const isActive = opts.activeId && live && live.id === opts.activeId;
    return `<article class="ucard${live && !live.alive ? ' is-dead' : ''}${isActive ? ' is-active' : ''}">
      <header class="ribbon"><span class="emb">${opts.emblem}</span><h3>${roman}. ${esc(u.name)}</h3></header>
      <div class="ucard-body">
        <div class="portrait">${portrait(opts, u.num, roman)}<span class="token-mini">${u.num}</span><div class="tags">${status}</div></div>
        <div class="stats">
          <div class="hp-cell" title="Здоровье"><span class="hp-now">${hp}<small>/${u.hp}</small></span><span class="heart">${ICONS.heart}<b>${u.hp}</b></span></div>
          ${statCell('atk', u.atkType === 'ranged' ? ICONS.bow : ICONS.sword, (u.atk >= 0 ? '+' : '') + u.atk,
            u.atkType === 'ranged' ? 'Дальняя атака, дальность ' + u.range : 'Ближняя атака',
            u.atkType === 'ranged' ? `<span class="corner">${u.range}</span>` : '')}
          ${statCell('arm', `${ICONS.shield}<i class="csym ${c.cls}">${c.sym}</i>`, u.armor, 'Броня; ' + c.text)}
          ${statCell('spd', u.flying ? ICONS.wing : ICONS.chevrons, u.speed, u.flying ? 'Скорость, летает' : 'Скорость')}
          ${statCell('ini', ICONS.hourglass, u.init, 'Инициатива')}
        </div>
      </div>
      <div class="ability">${ab ? `<h4>${esc(ab.name)} ${abState}</h4><p>${abilityText(ab.text)}</p>${ab.radius ? `<span class="corner ab-range" title="Радиус способности: клетки на 8 линиях от юнита">${ab.radius}</span>` : ''}` : ''}</div>
    </article>`;
  }

  function heroCard(E, f, seat, live, opts) {
    const h = f.hero;
    const coins = seat ? seat.coins : h.coins;
    const ab = h.ability;
    const status = live && live.slot ? `<span class="tag">место ${live.slot}</span>` : '';
    const isActive = opts.activeId && live && live.id === opts.activeId;
    return `<article class="ucard hero${isActive ? ' is-active' : ''}">
      <header class="ribbon"><span class="emb">${opts.emblem}</span><h3><small>Герой:</small> ${esc(h.name)}</h3></header>
      <div class="ucard-body">
        <div class="portrait">${portrait(opts, 'hero', 'Г')}<div class="tags">${status}</div></div>
        <div class="stats">
          <div class="hp-cell coins-cell" title="Монеты сейчас"><span class="hp-now">${coins}</span><span class="coin">${ICONS.coin}</span></div>
          <div class="st gold" title="Стартовые монеты"><span class="ico coin-ico">${ICONS.coin}</span><span class="val">${h.coins}</span></div>
          ${statCell('ini', ICONS.hourglass, h.init, 'Инициатива')}
          ${seat ? `<div class="st loot" title="Найдено на карте: предметы и ловушки (эффекты позже)"><span class="val">${seat.items}<small> пр.</small> · ${seat.traps}<small> лов.</small></span></div>` : ''}
        </div>
      </div>
      <div class="ability">${ab ? `<h4>${esc(ab.name)} ${ab.kind === 'active' ? stateBadge(live ? live.abilityState : 'ready') : ''}</h4><p>${abilityText(ab.text)}</p>` : ''}</div>
    </article>`;
  }

  // game может быть null (предпросмотр фракции до начала партии).
  function render(E, factionId, game, seatNum, opts) {
    opts = opts || {};
    const f = E.FACTIONS[factionId];
    const emblem = EMBLEMS[f.key];
    const seat = game && seatNum ? E.seatOf(game, seatNum) : null;
    const live = (id) => (game && seatNum ? E.entity(game, id) : null);
    const o = { emblem, activeId: opts.activeId, portraits: !!f.portraits, key: f.key };
    return `<div class="screen f${f.id}">
      <div class="screen-top">
        <span class="emb big">${emblem}</span>
        <div class="screen-head">
          <h2 class="screen-title">Фракция: <em>${esc(f.name)}</em></h2>
          <p class="faction-ability">${f.ability ? abilityText(f.ability.text) : ''}</p>
        </div>
        <span class="emb big">${emblem}</span>
      </div>
      <div class="screen-grid">
        ${heroCard(E, f, seat, live('s' + seatNum + 'h'), o)}
        ${f.units.map((u, i) => unitCard(E, u, live('s' + seatNum + 'u' + (i + 1)), o)).join('')}
      </div>
    </div>`;
  }

  root.NHScreen = { render, ICONS, EMBLEMS };
})(typeof self !== 'undefined' ? self : this);
