// Интерфейс прототипа: поле (SVG), колесо инициативы, лоток кубиков, панель хода и ширма.
// Вся логика — в engine.js; здесь только показ и ввод.
(function () {
  'use strict';
  const E = window.NHEngine;
  const MAP = window.NHMap;
  const Dice = window.NHDice;
  const Wheel = window.NHWheel;
  const Screen = window.NHScreen;

  const S = 32;             // размер клетки в единицах viewBox
  const OX = 26, OY = 22;   // поля под координаты
  const STEP_MS = 110;      // скорость анимации одного шага
  const NS = 'http://www.w3.org/2000/svg';
  const F = E.FACTIONS;

  const ui = {
    lobby: { 1: true, 2: true, 3: true, 4: true }, // зоны с игроками
    busy: false,
    hover: null,      // ключ клетки под курсором
    preview: null,    // ключ клетки, путь до которой показан
    anim: null,       // { entity, path, start }
    hoverSlot: null,
    mode: 'attack',   // 'attack' | 'ability' — что делает клик по юниту
    screenSeat: null, // чья ширма открыта (null — того, кто сейчас действует)
    previewFaction: 4,
    message: '',
  };
  let game = null;
  const staticMap = E.parseMap(MAP);

  const $board = document.getElementById('board');
  const $info = document.getElementById('board-info');
  const $wheel = document.getElementById('wheel');
  const $tray = document.getElementById('tray');
  const $panel = document.getElementById('panel');
  const $phase = document.getElementById('phase');
  const $screen = document.getElementById('screen');
  const $tabs = document.getElementById('screen-tabs');

  // ---------- Утилиты ----------

  const cx = (c) => OX + c * S;
  const cy = (r) => OY + r * S;
  const mid = (c, r) => [cx(c) + S / 2, cy(r) + S / 2];
  const map = () => (game ? game.map : staticMap);
  const fname = (f) => F[f].name;
  const ename = (e) => E.entityName(game, e);
  const sname = (n) => E.seatName(game, n);
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const seatCls = (n) => { const s = game && E.seatOf(game, n); return s && s.faction ? 'f' + s.faction : 'f0'; };

  function el(tag, attrs, parent, text) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  function cellFromEvent(ev) {
    const pt = $board.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const p = pt.matrixTransform($board.getScreenCTM().inverse());
    const c = Math.floor((p.x - OX) / S), r = Math.floor((p.y - OY) / S);
    const m = map();
    if (c < 0 || r < 0 || c >= m.cols || r >= m.rows) return null;
    return [c, r];
  }

  function zoneClass(z) {
    if (game) {
      const s = game.seats.find((x) => x.zone === z);
      return s ? (s.faction ? 'f' + s.faction : 'taken') : 'empty';
    }
    return ui.lobby[z] ? 'taken' : 'empty';
  }

  // Кто сейчас действует (для подсветки и ширмы).
  function actor() {
    if (!game) return null;
    if (game.phase === 'factions') return { seat: E.picker(game) };
    if (game.pendingInit) return E.entity(game, game.pendingInit.entity);
    if (game.pending) return E.entity(game, game.pending.golem);
    if (game.phase === 'initiative') return E.initCurrent(game);
    if (game.phase === 'deploy') return E.deployCurrent(game);
    if (game.phase === 'battle') return E.current(game);
    return null;
  }

  // ---------- Поле: статичный слой ----------

  function drawMap() {
    const m = map();
    $board.setAttribute('viewBox', `0 0 ${OX + m.cols * S + 6} ${OY + m.rows * S + 6}`);
    $board.innerHTML = '';
    const g = el('g', { class: 'map' }, $board);
    el('rect', { x: OX, y: OY, width: m.cols * S, height: m.rows * S, class: 'floor' }, g);

    for (const z of [1, 2, 3, 4]) {
      const zc = zoneClass(z);
      const cells = m.zones[z];
      for (const [c, r] of cells) el('rect', { x: cx(c), y: cy(r), width: S, height: S, class: 'zone ' + zc }, g);
      const xs = cells.map((p) => p[0]), ys = cells.map((p) => p[1]);
      const mx = (Math.min(...xs) + Math.max(...xs) + 1) / 2, my = (Math.min(...ys) + Math.max(...ys) + 1) / 2;
      el('text', { x: OX + mx * S, y: OY + my * S, class: 'zone-num ' + zc }, g, z);
    }

    let d = '';
    for (let c = 0; c <= m.cols; c++) d += `M${cx(c)} ${OY}V${OY + m.rows * S}`;
    for (let r = 0; r <= m.rows; r++) d += `M${OX} ${cy(r)}H${OX + m.cols * S}`;
    el('path', { d, class: 'grid' }, g);

    for (let c = 0; c < m.cols; c++) el('text', { x: cx(c) + S / 2, y: OY - 8, class: 'coord' }, g, E.cellName(c, 0).replace(/\d+$/, ''));
    for (let r = 0; r < m.rows; r++) el('text', { x: OX - 8, y: cy(r) + S / 2 + 1, class: 'coord row' }, g, r + 1);

    for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols; c++) {
      if (m.cells[r][c].kind === 'block') el('rect', { x: cx(c), y: cy(r), width: S, height: S, class: 'block' }, g);
    }

    let wd = '', hd = '';
    const add = (kind, s) => { if (kind === 'wall') wd += s; else if (kind === 'half') hd += s; };
    for (let r = 0; r < m.rows; r++) for (let k = 0; k <= m.cols; k++) add(m.vEdge[r][k], `M${cx(k)} ${cy(r)}V${cy(r) + S}`);
    for (let k = 0; k <= m.rows; k++) for (let c = 0; c < m.cols; c++) add(m.hEdge[k][c], `M${cx(c)} ${cy(k)}H${cx(c) + S}`);
    el('path', { d: hd, class: 'half' }, g);
    el('path', { d: wd, class: 'wall' }, g);

    el('g', { id: 'tokens' }, $board);
    el('g', { id: 'overlay' }, $board);
    el('g', { id: 'units' }, $board);
  }

  // ---------- Поле: динамика ----------

  function drawTokens() {
    const layer = document.getElementById('tokens');
    layer.innerHTML = '';
    const spots = game ? Object.keys(game.tokens).map(E.unkey) : staticMap.tokenSpots;
    for (const [c, r] of spots) {
      const g = el('g', { class: 'map-token' }, layer);
      el('rect', { x: cx(c) + 6, y: cy(r) + 6, width: S - 12, height: S - 12, rx: 4 }, g);
      el('text', { x: cx(c) + S / 2, y: cy(r) + S / 2 + 1 }, g, '?');
    }
  }

  function marker(ov, cls, x, y) {
    const g = el('g', { class: cls, transform: `translate(${x} ${y})` }, ov);
    el('circle', { r: 15 }, g);
    el('path', { d: 'M0 -19V-12M0 12V19M-19 0H-12M12 0H19' }, g);
  }

  function drawOverlay() {
    const ov = document.getElementById('overlay');
    ov.innerHTML = '';
    if (!game || ui.busy) return drawHover(ov);

    if (game.phase === 'deploy') {
      const e = E.deployCurrent(game);
      for (const [c, r] of game.map.zones[E.seatOf(game, e.seat).zone]) {
        if (E.canDeploy(game, c, r)) el('rect', { x: cx(c) + 3, y: cy(r) + 3, width: S - 6, height: S - 6, rx: 4, class: 'place-target f' + e.faction }, ov);
      }
    }

    if (game.phase === 'battle' && game.pending && game.pending.type === 'return') {
      const g = E.entity(game, game.pending.golem);
      for (const [c, r] of game.pending.options) el('rect', { x: cx(c) + 3, y: cy(r) + 3, width: S - 6, height: S - 6, rx: 4, class: 'place-target f' + g.faction }, ov);
    }

    if (game.phase === 'battle' && game.turn) {
      const cur = E.current(game);
      const reach = E.turnReach(game);
      if (reach) {
        for (const [k, v] of reach.cells) {
          const [c, r] = E.unkey(k);
          el('rect', { x: cx(c) + 1, y: cy(r) + 1, width: S - 2, height: S - 2, class: 'reach f' + cur.faction }, ov);
          el('text', { x: cx(c) + S - 4, y: cy(r) + 10, class: 'reach-num' }, ov, v.steps);
        }
        const target = ui.preview && reach.cells.get(ui.preview);
        if (target) {
          el('polyline', { points: target.path.map(([c, r]) => mid(c, r).join(',')).join(' '), class: 'path f' + cur.faction }, ov);
          target.path.slice(1, -1).forEach(([c, r]) => {
            const [x, y] = mid(c, r);
            el('circle', { cx: x, cy: y, r: 3, class: 'path-dot f' + cur.faction }, ov);
          });
          const [x, y] = mid(...target.path[target.path.length - 1]);
          el('circle', { cx: x, cy: y, r: 11, class: 'path-end f' + cur.faction }, ov);
          el('text', { x, y: y + 1, class: 'path-label' }, ov, target.steps);
        }
      }
      if (ui.mode === 'ability') {
        for (const id of E.abilityTargets(game)) marker(ov, 'target ability', ...mid(...E.entity(game, id).pos));
      } else {
        for (const t of E.turnTargets(game)) marker(ov, 'target', ...mid(...E.entity(game, t.id).pos));
      }
    }
    drawHover(ov);
  }

  function drawHover(ov) {
    if (!ui.hover || ui.busy) return;
    const [c, r] = E.unkey(ui.hover);
    el('rect', { x: cx(c) + 0.5, y: cy(r) + 0.5, width: S - 1, height: S - 1, class: 'hover' }, ov);
  }

  function unitXY(e, now) {
    if (ui.anim && ui.anim.entity === e.id) {
      const path = ui.anim.path;
      const t = Math.max(0, Math.min((now - ui.anim.start) / STEP_MS, path.length - 1));
      const i = Math.floor(t), f = t - i;
      const a = mid(...path[i]), b = mid(...path[Math.min(i + 1, path.length - 1)]);
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    return mid(...e.pos);
  }

  function drawUnits(now) {
    const layer = document.getElementById('units');
    layer.innerHTML = '';
    if (!game) return;
    const cur = game.phase === 'battle' && E.current(game);
    for (const e of game.entities) {
      if (!e.alive || !e.pos) continue;
      const [x, y] = unitXY(e, now || performance.now());
      const active = cur && cur.id === e.id;
      const g = el('g', { transform: `translate(${x} ${y})`, class: 'unit f' + e.faction + (active ? ' active' : '') + (e.flying ? ' flying' : '') }, layer);
      if (active) el('circle', { r: 15.5, class: 'active-ring' }, g);
      el('circle', { r: 11.5, class: 'token' }, g);
      el('text', { y: 0.5, class: 'token-label' }, g, e.label);
      if (e.swallowing) el('circle', { r: 4, cx: 9, cy: -9, class: 'mark' }, g);
      const w = 20, frac = e.hp / e.maxHp;
      el('rect', { x: -w / 2, y: 13, width: w, height: 3, rx: 1.5, class: 'hp-bg' }, g);
      el('rect', { x: -w / 2, y: 13, width: w * frac, height: 3, rx: 1.5, class: 'hp' + (frac <= 0.3 ? ' low' : '') }, g);
    }
  }

  // ---------- Колесо ----------

  function renderWheel() {
    if (!game) return Wheel.draw($wheel, { wheel: new Array(31).fill(null) }, { title: 'Колесо', subtitle: 'инициативы' });
    let options = [], pointer = null, title = '', subtitle = '';
    if (game.pendingInit && !ui.busy) options = game.pendingInit.options;
    if (game.phase === 'initiative') {
      title = 'Инициатива';
      const e = E.initCurrent(game);
      subtitle = e ? ename(e) : '';
    } else if (game.phase === 'deploy') {
      title = 'Расстановка';
    } else if (game.phase === 'battle') {
      pointer = game.pointer;
      title = 'Круг ' + game.round;
      subtitle = 'место ' + game.pointer;
      if (!ui.busy && !game.pendingInit) options = E.shiftOptions(game);
    } else if (game.phase === 'over') {
      title = 'Конец';
    } else {
      title = 'Колесо';
      subtitle = 'инициативы';
    }
    Wheel.draw($wheel, game, { options, pointer, title, subtitle, hoverSlot: ui.hoverSlot });
  }

  // ---------- Панель ----------

  function chip(f, label) {
    return `<span class="chip f${f}">${esc(label)}</span>`;
  }

  function hpBar(e) {
    if (e.kind === 'hero') return '';
    return `<div class="hpbar" title="Здоровье"><b style="width:${(100 * e.hp) / e.maxHp}%"></b></div><span class="hp-num">${e.hp}/${e.maxHp}</span>`;
  }

  function card(title, body, cls) {
    return `<section class="card ${cls || ''}"><h2 class="ribbon-h">${title}</h2>${body}</section>`;
  }

  function renderLobby() {
    const n = Object.values(ui.lobby).filter(Boolean).length;
    return card('Новая партия', `
      <p class="hint">Отметьте стартовые зоны, где сидят игроки. Нужно минимум двое. Фракции выберете дальше.</p>
      <div class="seats">${[3, 4, 1, 2].map((z) => `
        <label class="seat ${ui.lobby[z] ? 'on' : ''}"><input type="checkbox" id="lobby-z${z}" data-action="lobby" data-z="${z}" ${ui.lobby[z] ? 'checked' : ''}>
          <span>Игрок ${z}</span><small>зона ${z}</small></label>`).join('')}
      </div>
      <div class="actions"><button class="btn primary" data-action="start" ${n >= 2 ? '' : 'disabled'}>Начать партию</button></div>`);
  }

  function renderSeats() {
    const list = game.order.length ? game.order : game.pickOrder.length ? game.pickOrder : game.seats.map((s) => s.seat);
    return card('Игроки', `<ul class="seat-list">${list.map((sn, i) => {
      const s = E.seatOf(game, sn);
      const alive = game.entities.filter((e) => e.seat === sn && e.kind === 'unit' && e.alive).length;
      return `<li class="${s.out ? 'out' : ''} ${seatCls(sn)}"><span class="ord">${i + 1}</span>${s.faction ? chip(s.faction, F[s.faction].name[0]) : '<span class="chip f0">?</span>'}
        <span class="s-name">Игрок ${sn}${s.faction ? ' · ' + esc(fname(s.faction)) : ''}</span>
        ${s.faction ? `<span class="s-stat" title="Живых юнитов">${alive}/5</span><span class="s-stat gold" title="Монеты">${s.coins}</span>` : ''}</li>`;
    }).join('')}</ul>`);
  }

  function renderTurn() {
    const ph = game.phase;
    if (ph === 'pick') {
      return card('Выбор фракций', `
        <p class="hint">Все бросают к6: у кого больше, тот выбирает фракцию первым, дальше по часовой стрелке (зоны 1 → 3 → 4 → 2). Или раздайте фракции случайно.</p>
        <div class="actions"><button class="btn primary" data-action="roll-pick">Бросить к6</button><button class="btn" data-action="random-factions">Случайно</button></div>`);
    }
    if (ph === 'factions') {
      const p = E.picker(game);
      const taken = E.takenFactions(game);
      return card(`Выбирает Игрок ${p}`, `
        <div class="faction-picks">${[1, 2, 3, 4].map((f) => `
          <button class="fpick f${f}" data-action="pick-faction" data-f="${f}" ${taken.includes(f) ? 'disabled' : ''}>
            <span class="emb">${Screen.EMBLEMS[F[f].key]}</span><b>${esc(F[f].name)}</b><small>${F[f].test ? 'тестовая' : 'карты готовы'}</small></button>`).join('')}
        </div>
        <p class="hint">Наведите на фракцию — ниже откроется её ширма.</p>
        <div class="actions"><button class="btn" data-action="random-factions">Остальным случайно</button></div>`);
    }
    if (ph === 'order') {
      return card('Порядок инициативы', `
        <p class="hint">Новый бросок к6: победитель первым бросает к30 за своего юнита 1, дальше по часовой. Затем юниты 2, 3, 4, 5 и герои.</p>
        <div class="actions"><button class="btn primary" data-action="roll-order">Бросить к6</button></div>`);
    }
    if (ph === 'initiative') {
      const e = E.initCurrent(game);
      const p = game.pendingInit;
      let body;
      if (!p) {
        body = `<p class="hint">Бросок к30 — исходное место. Затем можно сдвинуться на 1…${e.init} в любую сторону, только на свободное место и не через 30 | 1. Выпало 1 — любое свободное место. Выпало 30 или всё занято — последнее свободное место.</p>
          <div class="actions"><button class="btn primary" data-action="roll-init">Бросить к30</button>
          <button class="btn" data-action="auto-init">Всех автоматически</button></div>`;
      } else {
        body = `<p class="hint">Выпало <b>${p.value}</b>. ${p.mode === 'any' ? 'Можно встать на любое свободное место.' : 'Выберите место на колесе: подсвечены доступные.'}</p>
          <div class="slot-picks">${p.options.map((s) => `<button class="mini ${s === p.value ? 'strong' : ''}" data-action="pick-slot" data-slot="${s}">${s}</button>`).join('')}</div>
          <div class="actions"><button class="btn" data-action="auto-init">Всех автоматически</button></div>`;
      }
      return card(`Инициатива · ${game.initIndex + 1} из ${game.initQueue.length}`, `
        <div class="who">${chip(e.faction, e.label)}<div><strong>${esc(ename(e))}</strong><small>Игрок ${e.seat} · инициатива ${e.init}</small></div></div>${body}`);
    }
    if (ph === 'deploy') {
      const e = E.deployCurrent(game);
      return card(`Расстановка · ${game.deployIndex + 1} из ${game.deployQueue.length}`, `
        <div class="who">${chip(e.faction, e.label)}<div><strong>${esc(ename(e))}</strong><small>место ${e.slot} на колесе</small></div></div>
        <p class="hint">Юниты встают в порядке колеса. Кликните подсвеченную клетку зоны ${E.seatOf(game, e.seat).zone}.</p>
        <div class="actions"><button class="btn" data-action="auto-deploy">Остальных автоматически</button></div>`);
    }
    if (ph === 'battle') {
      if (game.pending && game.pending.type === 'return') {
        const g = E.entity(game, game.pending.golem), t = E.entity(game, game.pending.target);
        return card('Возврат проглоченного', `
          <div class="who">${chip(g.faction, g.label)}<div><strong>${esc(ename(g))}</strong><small>возвращает ${esc(ename(t))}</small></div></div>
          <p class="hint">Выберите одну из ближайших свободных клеток (подсвечены). Затем цель бросает к30 за инициативу.</p>`, 'turn-card f' + g.faction);
      }
      if (game.pendingInit) {
        const t = E.entity(game, game.pendingInit.entity), p = game.pendingInit;
        return card('Новая инициатива', `
          <div class="who">${chip(t.faction, t.label)}<div><strong>${esc(ename(t))}</strong><small>к30 = ${p.value}</small></div></div>
          <p class="hint">Выберите место на колесе.</p>
          <div class="slot-picks">${p.options.map((s) => `<button class="mini ${s === p.value ? 'strong' : ''}" data-action="pick-slot" data-slot="${s}">${s}</button>`).join('')}</div>`, 'turn-card f' + t.faction);
      }
      const e = E.current(game);
      const t = game.turn;
      let hint, state = '', abilityBtn = '';
      if (e.kind === 'hero') {
        hint = 'Ход героя: магазин или действие (способность героя, активный предмет). Магазин и предметы пока не сделаны. Можно сдвинуться по колесу (бездействие) или закончить ход.';
      } else {
        const parts = [];
        if (E.canMove(game)) parts.push(`движение: ${t.mpLeft} из ${e.speed}${e.flying ? ' (летает)' : ''}`);
        else parts.push(t.acted ? 'действие сделано' : 'движение потрачено');
        if (E.canAttack(game)) parts.push(E.turnTargets(game).length ? 'есть цели для атаки' : 'целей для атаки нет');
        parts.push(E.canShift(game) ? `сдвиг по колесу на 1…${e.init}` : 'сдвиг недоступен: юнит двигался');
        state = `<p class="state">${parts.join(' · ')}</p>`;
        hint = 'Наведите на клетку — путь, клик — пойти. Цели атаки в прицеле. Сдвиг — клик по месту на колесе.';
        if (e.ability && e.ability.kind === 'active') {
          const targets = E.abilityTargets(game);
          const st = { ready: 'заряжена', active: 'активна', spent: 'разряжена' }[e.abilityState];
          abilityBtn = `<button class="btn ${ui.mode === 'ability' ? 'on' : ''}" data-action="toggle-ability" ${targets.length ? '' : 'disabled'}>
            ${ui.mode === 'ability' ? 'Отмена: ' : ''}${esc(e.ability.name)} <small>(${st}${e.abilityState === 'ready' && !targets.length ? ', нет целей рядом' : ''})</small></button>`;
        }
      }
      return card(`Круг ${game.round} · место ${game.pointer}`, `
        <div class="who big">${chip(e.faction, e.label)}<div><strong>${esc(ename(e))}</strong><small>Игрок ${e.seat}</small></div>${hpBar(e)}</div>
        ${state}<p class="hint">${hint}</p>
        ${abilityBtn ? `<div class="actions">${abilityBtn}</div>` : ''}
        <div class="actions">
          ${e.kind === 'unit' ? `<button class="btn" data-action="undo-move" ${t.moved && !t.acted ? '' : 'disabled'}>Отменить движение</button>` : ''}
          <button class="btn primary" data-action="end-turn">Конец хода</button>
        </div>`, 'turn-card f' + e.faction);
    }
    if (ph === 'over') {
      return card('Партия окончена', `<p class="win-title">${game.winner ? 'Победа: ' + esc(sname(game.winner)) : 'Ничья'}</p>
        <div class="actions"><button class="btn primary" data-action="new">Новая партия</button></div>`, 'win ' + seatCls(game.winner));
    }
    return '';
  }

  function renderLog() {
    return card('Журнал', `<ol class="log">${game.log.slice(-40).reverse().map((l) =>
      `<li class="${l.seat ? seatCls(l.seat) : ''}"><span>К${l.round}</span>${esc(l.text)}</li>`).join('')}</ol>`);
  }

  function renderPanel() {
    const ph = game ? game.phase : 'lobby';
    const titles = { lobby: 'Подготовка', pick: 'Выбор фракций', factions: 'Выбор фракций', order: 'Порядок инициативы', initiative: 'Инициатива', deploy: 'Расстановка', battle: 'Бой', over: 'Конец партии' };
    const cur = ph === 'battle' && E.current(game);
    $phase.textContent = cur ? `Круг ${game.round} · ${ename(cur)}` : titles[ph];
    $phase.className = 'phase' + (cur ? ' f' + cur.faction : '');
    let html = game ? renderTurn() + renderSeats() + renderLog() : renderLobby();
    if (game && game.phase !== 'over') html += `<section class="card quiet"><button class="btn ghost" data-action="new">Сбросить партию</button></section>`;
    if (ui.message) html = `<p class="toast" role="status">${esc(ui.message)}</p>` + html;
    $panel.innerHTML = html;
    updateInfo();
  }

  // ---------- Ширма ----------

  function renderScreen() {
    const a = actor();
    let tabs = [], factionId, seatNum = null;
    const assigned = game && game.seats.filter((s) => s.faction);
    if (!game || !assigned.length || game.phase === 'factions' || game.phase === 'pick') {
      // До выбора — предпросмотр фракций
      tabs = [1, 2, 3, 4].map((f) => ({ key: 'f' + f, label: F[f].name, cls: 'f' + f, on: ui.previewFaction === f }));
      factionId = ui.previewFaction;
    } else {
      seatNum = ui.screenSeat || (a && a.seat) || assigned[0].seat;
      if (!E.seatOf(game, seatNum).faction) seatNum = assigned[0].seat;
      tabs = assigned.map((s) => ({ key: 's' + s.seat, label: `Игрок ${s.seat} · ${F[s.faction].name}`, cls: 'f' + s.faction, on: s.seat === seatNum, now: a && a.seat === s.seat }));
      factionId = E.seatOf(game, seatNum).faction;
    }
    $tabs.innerHTML = tabs.map((t) => `<button class="tab ${t.cls} ${t.on ? 'on' : ''}" data-tab="${t.key}">${esc(t.label)}${t.now ? ' <i>ходит</i>' : ''}</button>`).join('');
    $screen.innerHTML = Screen.render(E, factionId, game && seatNum ? game : null, seatNum, { activeId: a && a.id });
  }

  function updateInfo() {
    if (!game) { $info.textContent = 'Карта «Эскиз v1» 28×22. Сплошные линии — стены, синий пунктир — полустены, «?» — жетоны.'; return; }
    if (game.phase === 'deploy' && !ui.hover) {
      const d = E.deployCurrent(game);
      $info.innerHTML = `Ставит: <b class="chip-text f${d.faction}">${esc(ename(d))}</b> · место ${d.slot} на колесе`;
      return;
    }
    const u = ui.hover && E.unitAt(game, ...E.unkey(ui.hover));
    if (u) {
      const tgt = game.phase === 'battle' && !ui.busy && E.turnTargets(game).find((t) => t.id === u.id);
      const a = tgt && E.current(game);
      const stats = u.kind === 'unit' ? `здоровье ${u.hp}/${u.maxHp} · броня ${u.armor} · атака ${u.atk >= 0 ? '+' : ''}${u.atk} ${u.atkType === 'ranged' ? 'дальняя ' + u.range : 'ближняя'} · скорость ${u.speed}${u.flying ? ' (летает)' : ''} · инициатива ${u.init}` : '';
      $info.innerHTML = `<b class="chip-text f${u.faction}">${esc(ename(u))}</b> · ${stats}`
        + (tgt ? ` · <b>атака: к6 + ${a.atk}${tgt.penalty ? ' − ' + tgt.penalty : ''} − броня ${u.armor}</b>` : '');
      return;
    }
    if (ui.hover) {
      const [c, r] = E.unkey(ui.hover);
      const tok = game.tokens[ui.hover];
      $info.textContent = E.cellName(c, r) + (tok ? ' · жетон «?»: встать можно, пройти насквозь нельзя, ход заканчивается' : '');
      return;
    }
    $info.textContent = 'Наведите на юнита, чтобы увидеть его параметры.';
  }

  function render() {
    drawTokens();
    drawOverlay();
    drawUnits();
    renderWheel();
    renderPanel();
    renderScreen();
  }

  function flash(msg) {
    ui.message = msg;
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { ui.message = ''; renderPanel(); }, 2600);
    renderPanel();
  }

  // ---------- Проигрывание событий ----------

  function animatePath(entityId, path) {
    return new Promise((resolve) => {
      ui.anim = { entity: entityId, path, start: performance.now() };
      const tick = (now) => {
        drawUnits(now);
        if (now - ui.anim.start < (path.length - 1) * STEP_MS) requestAnimationFrame(tick);
        else { ui.anim = null; resolve(); }
      };
      requestAnimationFrame(tick);
    });
  }

  function tokenText(tok) {
    if (tok.kind === 'coins') return `<span class="coin-badge">${tok.value}</span> монет`;
    if (tok.kind === 'item') return '<span class="tok-badge item">предмет</span> (эффект добавим позже)';
    return '<span class="tok-badge trap">ловушка</span> (эффект добавим позже)';
  }

  async function playEvents(events) {
    const items = [];
    const lines = [];
    for (const ev of events) {
      const who = ev.entity && E.entity(game, ev.entity);
      if (ev.type === 'move') {
        await animatePath(ev.entity, ev.path);
      } else if (ev.type === 'roll' && (ev.purpose === 'order' || ev.purpose === 'pick')) {
        items.push({ sides: 6, value: ev.value, caption: 'Игрок ' + ev.seat + (ev.attempt > 1 ? ' · переброс' : ''), cls: seatCls(ev.seat), batch: ev.purpose + ev.attempt });
      } else if (ev.type === 'pickOrder') {
        lines.push('Порядок выбора фракций: ' + ev.order.map((sn) => '<b>Игрок ' + sn + '</b>').join(' → '));
      } else if (ev.type === 'faction') {
        lines.push(`Игрок ${ev.seat} играет за <b class="chip-text f${ev.faction}">${esc(fname(ev.faction))}</b>${ev.random ? ' (случайно)' : ''}`);
      } else if (ev.type === 'order') {
        lines.push('Первым бросает к30: ' + ev.order.map((sn) => `<b class="chip-text ${seatCls(sn)}">${esc(sname(sn))}</b>`).join(' → '));
      } else if (ev.type === 'roll' && ev.purpose === 'initiative') {
        items.push({ sides: 30, value: ev.value, caption: 'к30 · ' + esc(ename(who)), cls: 'f' + who.faction });
      } else if (ev.type === 'slot') {
        if (ev.forced) lines.push(`${esc(ename(who))} встаёт на место <b>${ev.slot}</b>`);
      } else if (ev.type === 'roll' && (ev.purpose === 'attack' || ev.purpose === 'counter')) {
        items.push({
          sides: 6, value: ev.value, cls: 'f' + who.faction,
          caption: (ev.purpose === 'attack' ? 'Атака · ' : 'Отпор · ') + esc(ename(who)),
          note: `${ev.value} + ${ev.mod}${ev.penalty ? ' − ' + ev.penalty : ''} = <b>${ev.total}</b>`,
        });
      } else if (ev.type === 'roll' && ev.purpose === 'counterCheck') {
        items.push({ sides: 6, value: ev.value, cls: 'f' + who.faction, caption: 'Отпор? нужно 4–6', note: ev.success ? '<b>да</b>' : 'нет', good: ev.success });
      } else if (ev.type === 'damage') {
        lines.push(`${esc(ename(who))}: ${ev.source ? esc(ev.source) + ', ' : ''}${ev.raw}${ev.pure ? ' <b class="pure">чистого</b>' : ' − броня ' + ev.armor} = <b>${ev.amount}</b> урона · ♥ ${ev.hpLeft}`);
      } else if (ev.type === 'immune') {
        lines.push(`${esc(ename(who))}: урона нет — ${esc(ev.reason)}`);
      } else if (ev.type === 'heal') {
        lines.push(`${esc(ename(who))}: <b class="heal">+${ev.amount}</b> здоровья (${esc(ev.source)}) · ♥ ${ev.hpLeft}`);
      } else if (ev.type === 'coins') {
        lines.push(`<span class="coin-badge">+${ev.amount}</span> монет: ${esc(ev.source)}`);
      } else if (ev.type === 'death') {
        lines.push(`<b>${esc(ename(who))} погибает</b>`);
      } else if (ev.type === 'out') {
        lines.push(`<b>${esc(sname(ev.seat))} выбывает</b>`);
      } else if (ev.type === 'token') {
        lines.push(`Жетон: ${tokenText(ev.token)}`);
      } else if (ev.type === 'ability') {
        lines.push(`<b>${esc(ev.name)}</b>: ${esc(ename(who))} → ${esc(ename(E.entity(game, ev.target)))}`);
      } else if (ev.type === 'swallowed') {
        lines.push(`${esc(ename(who))} проглочен: исчез с карты и колеса`);
      } else if (ev.type === 'released') {
        lines.push(`${esc(ename(who))} возвращается на ${E.cellName(...ev.cell)}`);
      } else if (ev.type === 'roundEnd') {
        lines.push(`Конец круга ${ev.round}`);
      } else if (ev.type === 'turnEnded') {
        lines.push(`Ход окончен (${ev.reason})`);
      } else if (ev.type === 'shift') {
        lines.push(`${esc(ename(who))}: инициатива ${ev.from} → ${ev.to}${ev.to > ev.from ? ' — ещё ход в этом круге' : ''}`);
      } else if (ev.type === 'text') {
        lines.push(esc(ev.text));
      }
    }
    if (items.length) await Dice.play($tray, items, lines.join('<br>'));
    else if (lines.length) Dice.note($tray, lines.join('<br>'));
  }

  async function act(fn) {
    if (ui.busy || !game) return;
    const res = fn();
    if (!res.ok) return flash(res.error);
    ui.busy = true;
    ui.preview = null;
    ui.mode = 'attack';
    drawOverlay();
    renderWheel();
    try {
      await playEvents(res.events);
    } finally {
      ui.busy = false;
      render();
    }
  }

  // ---------- Ввод ----------

  function onCellClick(c, r) {
    if (!game || ui.busy) return;
    const k = E.key(c, r);
    if (game.phase === 'deploy') return act(() => E.deploy(game, c, r));
    if (game.phase !== 'battle') return;
    if (game.pending && game.pending.type === 'return') return act(() => E.chooseReturnCell(game, c, r));
    const there = E.unitAt(game, c, r);
    if (there && ui.mode === 'ability' && E.abilityTargets(game).includes(there.id)) return act(() => E.useAbility(game, there.id));
    if (there && ui.mode === 'attack' && E.turnTargets(game).some((t) => t.id === there.id)) return act(() => E.attack(game, there.id));
    const reach = E.turnReach(game);
    if (reach && reach.cells.has(k)) {
      if (ui.preview === k) return act(() => E.move(game, c, r));
      ui.preview = k;
      return drawOverlay();
    }
  }

  $board.addEventListener('click', (ev) => {
    const cell = cellFromEvent(ev);
    if (cell) onCellClick(...cell);
  });

  $board.addEventListener('pointermove', (ev) => {
    if (ev.pointerType === 'touch') return;
    const cell = cellFromEvent(ev);
    const k = cell && E.key(...cell);
    if (k === ui.hover) return;
    ui.hover = k;
    if (game && game.phase === 'battle' && !ui.busy) {
      const reach = E.turnReach(game);
      ui.preview = k && reach && reach.cells.has(k) ? k : null;
    }
    drawOverlay();
    updateInfo();
  });
  $board.addEventListener('pointerleave', () => { ui.hover = null; drawOverlay(); updateInfo(); });

  $wheel.addEventListener('click', (ev) => {
    const g = ev.target.closest('[data-slot]');
    if (!g || !game || ui.busy) return;
    const slot = Number(g.dataset.slot);
    if (game.pendingInit) return act(() => E.chooseInitiative(game, slot));
    if (game.phase === 'battle' && E.shiftOptions(game).includes(slot)) return act(() => E.shift(game, slot));
  });
  $wheel.addEventListener('pointerover', (ev) => {
    const g = ev.target.closest('[data-slot]');
    const s = g ? Number(g.dataset.slot) : null;
    if (s !== ui.hoverSlot) { ui.hoverSlot = s; renderWheel(); }
  });

  $tabs.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-tab]');
    if (!b) return;
    const t = b.dataset.tab;
    if (t[0] === 'f') ui.previewFaction = Number(t.slice(1));
    else {
      const n = Number(t.slice(1));
      const a = actor();
      ui.screenSeat = a && a.seat === n ? null : n; // клик по ходящему — снова «следить за ходом»
    }
    renderScreen();
  });

  $panel.addEventListener('pointerover', (ev) => {
    const b = ev.target.closest('[data-action="pick-faction"]');
    if (b && Number(b.dataset.f) !== ui.previewFaction) { ui.previewFaction = Number(b.dataset.f); renderScreen(); }
  });

  $panel.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-action]');
    if (!b || ui.busy) return;
    const a = b.dataset.action;
    if (a === 'start') {
      const seats = [1, 2, 3, 4].filter((z) => ui.lobby[z]);
      game = E.createGame(MAP, { seats });
      ui.screenSeat = null;
      drawMap();
      Dice.note($tray, 'Бросьте к6: кто первым выбирает фракцию.');
      return render();
    }
    if (a === 'new') {
      game = null;
      drawMap();
      Dice.note($tray, 'Здесь будут броски кубиков.');
      return render();
    }
    const redraw = (res) => { drawMap(); return res; };
    if (a === 'roll-pick') return act(() => E.rollPickOrder(game));
    if (a === 'random-factions') return act(() => redraw(E.randomFactions(game)));
    if (a === 'pick-faction') return act(() => redraw(E.pickFaction(game, Number(b.dataset.f))));
    if (a === 'roll-order') return act(() => E.rollOrder(game));
    if (a === 'roll-init') return act(() => E.rollInitiative(game));
    if (a === 'auto-init') return act(() => {
      E.autoInitiative(game);
      return { ok: true, events: [{ type: 'text', text: 'Инициатива определена автоматически для всех оставшихся.' }] };
    });
    if (a === 'pick-slot') return act(() => E.chooseInitiative(game, Number(b.dataset.slot)));
    if (a === 'auto-deploy') return act(() => E.autoDeploy(game));
    if (a === 'undo-move') { E.undoMove(game); return render(); }
    if (a === 'end-turn') return act(() => E.endTurn(game));
    if (a === 'toggle-ability') { ui.mode = ui.mode === 'ability' ? 'attack' : 'ability'; return render(); }
  });

  $panel.addEventListener('change', (ev) => {
    const i = ev.target;
    if (i.dataset.action === 'lobby') {
      ui.lobby[Number(i.dataset.z)] = i.checked;
      drawMap();
      render();
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'SELECT' || ev.target.tagName === 'INPUT') return;
    if (ev.key === 'Enter' && game && game.phase === 'battle' && !ui.busy) act(() => E.endTurn(game));
    if (ev.key === 'Escape') { ui.preview = null; ui.mode = 'attack'; render(); }
  });

  // Доступ из консоли браузера для отладки: NHDebug.game()
  window.NHDebug = { game: () => game, render };

  drawMap();
  render();
  Dice.note($tray, 'Здесь будут броски кубиков.');
})();
