// Интерфейс прототипа: доска на SVG + боковая панель. Вся логика — в engine.js.
(function () {
  'use strict';
  const E = window.NHEngine;
  const MAP = window.NHMap;

  const S = 32;             // размер клетки в единицах viewBox
  const OX = 26, OY = 22;   // поля под координаты
  const STEP_MS = 110;      // скорость анимации одного шага
  const SVGNS = 'http://www.w3.org/2000/svg';

  const ui = {
    selected: null,   // id выбранного юнита
    preview: null,    // ключ клетки, путь до которой показан
    hover: null,      // ключ клетки под курсором
    anim: null,       // { unitId, path, start }
    players: [1, 2, 3, 4],
    message: '',
  };
  let game = E.createGame(MAP, { players: ui.players });

  const $board = document.getElementById('board');
  const $panel = document.getElementById('panel');
  const $phase = document.getElementById('phase');

  // ---------- Геометрия ----------

  const cx = (c) => OX + c * S;
  const cy = (r) => OY + r * S;
  const mid = (c, r) => [cx(c) + S / 2, cy(r) + S / 2];

  function cellFromEvent(ev) {
    const pt = $board.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const p = pt.matrixTransform($board.getScreenCTM().inverse());
    const c = Math.floor((p.x - OX) / S), r = Math.floor((p.y - OY) / S);
    if (c < 0 || r < 0 || c >= game.map.cols || r >= game.map.rows) return null;
    return [c, r];
  }

  function el(tag, attrs, parent) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  // ---------- Статичный слой карты ----------

  function drawMap() {
    const m = game.map;
    $board.setAttribute('viewBox', `0 0 ${OX + m.cols * S + 6} ${OY + m.rows * S + 6}`);
    $board.innerHTML = '';
    const g = el('g', { class: 'map' }, $board);
    el('rect', { x: OX, y: OY, width: m.cols * S, height: m.rows * S, class: 'floor' }, g);

    // Зоны расстановки
    for (const z of [1, 2, 3, 4]) {
      const cells = m.zones[z];
      for (const [c, r] of cells) el('rect', { x: cx(c), y: cy(r), width: S, height: S, class: 'zone p' + z }, g);
      if (cells.length) {
        const xs = cells.map((p) => p[0]), ys = cells.map((p) => p[1]);
        const zc = (Math.min(...xs) + Math.max(...xs) + 1) / 2, zr = (Math.min(...ys) + Math.max(...ys) + 1) / 2;
        const t = el('text', { x: OX + zc * S, y: OY + zr * S, class: 'zone-num p' + z }, g);
        t.textContent = z;
      }
    }

    // Сетка
    let d = '';
    for (let c = 0; c <= m.cols; c++) d += `M${cx(c)} ${OY}V${OY + m.rows * S}`;
    for (let r = 0; r <= m.rows; r++) d += `M${OX} ${cy(r)}H${OX + m.cols * S}`;
    el('path', { d, class: 'grid' }, g);

    // Координаты
    for (let c = 0; c < m.cols; c++) {
      const t = el('text', { x: cx(c) + S / 2, y: OY - 8, class: 'coord' }, g);
      t.textContent = E.cellName(c, 0).replace(/\d+$/, '');
    }
    for (let r = 0; r < m.rows; r++) {
      const t = el('text', { x: OX - 8, y: cy(r) + S / 2 + 1, class: 'coord row' }, g);
      t.textContent = r + 1;
    }

    // Объекты и непроходимые клетки
    let xd = '';
    for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols; c++) {
      const k = m.cells[r][c].kind;
      if (k === 'object') {
        const x = cx(c), y = cy(r), i = 9;
        xd += `M${x + i} ${y + i}L${x + S - i} ${y + S - i}M${x + S - i} ${y + i}L${x + i} ${y + S - i}`;
      } else if (k === 'block') {
        el('rect', { x: cx(c), y: cy(r), width: S, height: S, class: 'block' }, g);
      }
    }
    el('path', { d: xd, class: 'object' }, g);

    // Стены и проёмы
    let wd = '', dd = '';
    const add = (kind, s) => { if (kind === 'wall') wd += s; else if (kind === 'door') dd += s; };
    for (let r = 0; r < m.rows; r++) for (let k = 0; k <= m.cols; k++) {
      add(m.vEdge[r][k], `M${cx(k)} ${cy(r)}V${cy(r) + S}`);
    }
    for (let k = 0; k <= m.rows; k++) for (let c = 0; c < m.cols; c++) {
      add(m.hEdge[k][c], `M${cx(c)} ${cy(k)}H${cx(c) + S}`);
    }
    el('path', { d: dd, class: 'door' }, g);
    el('path', { d: wd, class: 'wall' }, g);

    el('g', { id: 'overlay' }, $board);
    el('g', { id: 'units' }, $board);
  }

  // ---------- Динамический слой ----------

  function currentReach() {
    if (!ui.selected) return null;
    const u = E.unitById(game, ui.selected);
    if (!u || !u.pos || game.phase !== 'battle') return null;
    // Для чужого юнита показываем полную дальность — чтобы оценить угрозу.
    return E.computeReach(game, ui.selected, u.owner === game.current ? u.mpLeft : u.move);
  }

  function drawOverlay() {
    const ov = document.getElementById('overlay');
    ov.innerHTML = '';
    const sel = ui.selected && E.unitById(game, ui.selected);

    if (game.phase === 'setup' && sel) {
      for (const [c, r] of game.map.zones[sel.owner]) {
        if (E.canPlace(game, sel.id, c, r)) {
          el('rect', { x: cx(c) + 3, y: cy(r) + 3, width: S - 6, height: S - 6, rx: 4, class: 'place-target p' + sel.owner }, ov);
        }
      }
    }

    const reach = !ui.anim && currentReach();
    if (reach) {
      const own = sel.owner === game.current;
      for (const [k, v] of reach.cells) {
        const [c, r] = E.unkey(k);
        el('rect', { x: cx(c) + 1, y: cy(r) + 1, width: S - 2, height: S - 2, class: 'reach p' + sel.owner + (own ? '' : ' foreign') }, ov);
        const t = el('text', { x: cx(c) + S - 4, y: cy(r) + 10, class: 'reach-num' }, ov);
        t.textContent = v.steps;
      }
      const target = ui.preview && reach.cells.get(ui.preview);
      if (target) {
        const pts = target.path.map(([c, r]) => mid(c, r).join(',')).join(' ');
        el('polyline', { points: pts, class: 'path p' + sel.owner }, ov);
        target.path.slice(1, -1).forEach(([c, r]) => {
          const [x, y] = mid(c, r);
          el('circle', { cx: x, cy: y, r: 3, class: 'path-dot p' + sel.owner }, ov);
        });
        const [ec, er] = target.path[target.path.length - 1];
        const [x, y] = mid(ec, er);
        el('circle', { cx: x, cy: y, r: 11, class: 'path-end p' + sel.owner }, ov);
        const t = el('text', { x, y: y + 1, class: 'path-label' }, ov);
        t.textContent = target.steps;
      }
    }

    if (ui.hover && !ui.anim) {
      const [c, r] = E.unkey(ui.hover);
      el('rect', { x: cx(c) + 0.5, y: cy(r) + 0.5, width: S - 1, height: S - 1, class: 'hover' }, ov);
    }
  }

  function unitPos(u, now) {
    if (ui.anim && ui.anim.unitId === u.id) {
      const path = ui.anim.path;
      const t = Math.max(0, Math.min((now - ui.anim.start) / STEP_MS, path.length - 1));
      const i = Math.floor(t), f = t - i;
      const a = mid(...path[i]), b = mid(...path[Math.min(i + 1, path.length - 1)]);
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    return mid(...u.pos);
  }

  function drawUnits(now) {
    const layer = document.getElementById('units');
    layer.innerHTML = '';
    for (const u of game.units) {
      if (!u.pos) continue;
      const [x, y] = unitPos(u, now || performance.now());
      const spent = game.phase === 'battle' && u.owner === game.current && u.mpLeft === 0;
      const g = el('g', { transform: `translate(${x} ${y})`, class: 'unit p' + u.owner + (spent ? ' spent' : '') + (u.id === ui.selected ? ' selected' : '') }, layer);
      if (u.id === ui.selected) el('circle', { r: 15, class: 'sel-ring' }, g);
      el('circle', { r: 11.5, class: 'token' }, g);
      const t = el('text', { y: 1, class: 'token-label' }, g);
      t.textContent = u.short;
      if (game.phase === 'battle' && u.owner === game.current) {
        // Дуга оставшихся очков хода
        const frac = u.mpLeft / u.move;
        if (frac > 0 && frac < 1) {
          const a = frac * 2 * Math.PI - Math.PI / 2, R = 14;
          const large = frac > 0.5 ? 1 : 0;
          el('path', { d: `M0 ${-R}A${R} ${R} 0 ${large} 1 ${R * Math.cos(a)} ${R * Math.sin(a)}`, class: 'mp-arc' }, g);
        } else if (frac === 1) {
          el('circle', { r: 14, class: 'mp-arc' }, g);
        }
      }
    }
  }

  function render() {
    drawOverlay();
    drawUnits();
    renderPanel();
  }

  // ---------- Панель ----------

  const PLAYER_NAMES = { 1: 'Игрок 1', 2: 'Игрок 2', 3: 'Игрок 3', 4: 'Игрок 4' };

  function unitRow(u) {
    const inBattle = game.phase === 'battle';
    const mine = inBattle && u.owner === game.current;
    const status = !u.pos ? 'не на поле' : E.cellName(...u.pos);
    let extra = '';
    if (inBattle && mine) {
      extra = `<span class="mp" title="Осталось очков хода"><b style="width:${(100 * u.mpLeft) / u.move}%"></b></span><span class="mp-num">${u.mpLeft}/${u.move}</span>`;
    } else if (!inBattle && u.pos) {
      extra = `<button class="mini" data-action="unplace" data-id="${u.id}" aria-label="Убрать с поля">убрать</button>`;
    }
    return `<li class="unit-row ${u.id === ui.selected ? 'is-selected' : ''} ${u.pos ? '' : 'off'}">
      <button class="unit-pick" data-action="select" data-id="${u.id}">
        <span class="chip p${u.owner}">${u.short}</span>
        <span class="u-name">${u.name}</span>
        ${inBattle ? '' : `<span class="u-move">ход ${u.move}</span>`}
        <span class="u-cell">${status}</span>
      </button>${extra}
    </li>`;
  }

  function renderPanel() {
    const inBattle = game.phase === 'battle';
    $phase.textContent = inBattle ? `Раунд ${game.round} · ходит ${PLAYER_NAMES[game.current]}` : 'Расстановка';
    $phase.className = 'phase' + (inBattle ? ' p' + game.current : '');

    let html = '';
    if (!inBattle) {
      html += `<section>
        <h2>Игроки в партии</h2>
        <div class="toggles">${[1, 2, 3, 4].map((p) => `
          <label class="pill p${p}"><input type="checkbox" id="pl${p}" data-action="toggle-player" data-p="${p}" ${ui.players.includes(p) ? 'checked' : ''}> ${PLAYER_NAMES[p]}</label>`).join('')}
        </div>
      </section>
      <section>
        <h2>Расстановка</h2>
        <p class="hint">Выберите юнита в списке и кликните по клетке своей зоны. Клик по пустой зоне ставит следующего юнита этого игрока.</p>
        ${game.players.map((p) => `
          <div class="roster">
            <div class="roster-head"><span class="chip p${p}">${p}</span>${PLAYER_NAMES[p]}
              <button class="mini" data-action="auto" data-p="${p}">случайно</button></div>
            <ul>${game.units.filter((u) => u.owner === p).map(unitRow).join('')}</ul>
          </div>`).join('')}
        <div class="actions">
          <button class="btn" data-action="auto-all">Расставить всех</button>
          <button class="btn primary" data-action="start" ${E.setupComplete(game) ? '' : 'disabled'}>Начать бой</button>
        </div>
      </section>`;
    } else {
      const sel = ui.selected && E.unitById(game, ui.selected);
      html += `<section>
        <div class="turn p${game.current}"><span class="chip p${game.current}">${game.current}</span>
          <div><strong>${PLAYER_NAMES[game.current]}</strong><small>Раунд ${game.round}</small></div></div>
        <p class="hint">Кликните своего юнита: подсветится дальность. Наведите на клетку — увидите путь, кликните — юнит пойдёт. На телефоне: первое касание показывает путь, второе подтверждает. Очки хода можно тратить по частям.</p>
        <ul>${game.units.filter((u) => u.owner === game.current).map(unitRow).join('')}</ul>
        ${sel ? `<div class="sel-box">
          <span class="chip p${sel.owner}">${sel.short}</span>
          <div><strong>${sel.name}</strong> · ${PLAYER_NAMES[sel.owner]}<small>${sel.owner === game.current ? `осталось ${sel.mpLeft} из ${sel.move}` : 'чужой юнит: показана полная дальность'}</small></div>
          <label class="num">ход <input type="number" id="move-edit" min="1" max="20" value="${sel.move}" data-action="edit-move"></label>
        </div>` : ''}
        <div class="actions">
          <button class="btn" data-action="undo" ${game.history.length ? '' : 'disabled'}>Отменить ход</button>
          <button class="btn primary" data-action="end-turn">Конец хода</button>
        </div>
      </section>
      <section>
        <h2>Журнал</h2>
        <ol class="log">${game.log.slice(-12).reverse().map((l) => `<li${l.player ? ` class="p${l.player}"` : ''}><span>Р${l.round}</span>${l.text}</li>`).join('')}</ol>
      </section>`;
    }
    html += `<section>
      <h2>Правила прототипа</h2>
      <label class="check"><input type="checkbox" id="set-doors" data-action="setting" data-k="doorsPassable" ${game.settings.doorsPassable ? 'checked' : ''}> Синие проёмы проходимы</label>
      <label class="check"><input type="checkbox" id="set-objects" data-action="setting" data-k="objectsPassable" ${game.settings.objectsPassable ? 'checked' : ''}> Клетки с крестиком проходимы</label>
      <label class="check"><input type="checkbox" id="set-allies" data-action="setting" data-k="passThroughAllies" ${game.settings.passThroughAllies ? 'checked' : ''}> Можно проходить сквозь своих</label>
      ${inBattle ? '<button class="btn ghost" data-action="reset">Новая расстановка</button>' : ''}
    </section>`;
    if (ui.message) html += `<p class="toast" role="status">${ui.message}</p>`;
    $panel.innerHTML = html;
  }

  // ---------- Действия ----------

  function newGame() {
    const settings = game.settings;
    game = E.createGame(MAP, { players: ui.players, settings });
    ui.selected = null; ui.preview = null;
  }

  function flash(msg) {
    ui.message = msg;
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { ui.message = ''; renderPanel(); }, 2600);
  }

  function animateMove(unitId, path) {
    ui.anim = { unitId, path, start: performance.now() };
    const tick = (now) => {
      drawUnits(now);
      if (now - ui.anim.start < (path.length - 1) * STEP_MS) requestAnimationFrame(tick);
      else { ui.anim = null; render(); }
    };
    requestAnimationFrame(tick);
  }

  function onCellClick(c, r) {
    if (ui.anim) return;
    const k = E.key(c, r);
    const there = E.unitAt(game, c, r);

    if (game.phase === 'setup') {
      const sel = ui.selected && E.unitById(game, ui.selected);
      if (there) { ui.selected = there.id === ui.selected ? null : there.id; return render(); }
      const zone = game.map.cells[r][c].zone;
      if (sel && E.place(game, sel.id, c, r)) {
        const next = game.units.find((u) => u.owner === sel.owner && !u.pos);
        ui.selected = next ? next.id : null;
        return render();
      }
      if (zone && game.players.includes(zone)) {
        const next = game.units.find((u) => u.owner === zone && !u.pos);
        if (next && E.place(game, next.id, c, r)) {
          const after = game.units.find((u) => u.owner === zone && !u.pos);
          ui.selected = after ? after.id : null;
        }
        return render();
      }
      if (sel) flash('Ставить можно только в зону своего игрока.');
      return render();
    }

    // Бой
    if (there) {
      ui.selected = there.id === ui.selected ? null : there.id;
      ui.preview = null;
      return render();
    }
    const sel = ui.selected && E.unitById(game, ui.selected);
    if (!sel) return;
    const reach = E.computeReach(game, sel.id);
    if (sel.owner === game.current && reach.cells.has(k)) {
      if (ui.preview === k) {
        const res = E.moveUnit(game, sel.id, c, r);
        if (res.ok) {
          ui.preview = null; ui.hover = null;
          animateMove(sel.id, res.path);
          if (sel.mpLeft === 0) ui.selected = null;
          renderPanel();
        }
        else flash(res.error);
        return;
      }
      ui.preview = k;
      return render();
    }
    ui.selected = null; ui.preview = null;
    render();
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
    const sel = ui.selected && E.unitById(game, ui.selected);
    if (game.phase === 'battle' && sel) {
      const reach = currentReach();
      ui.preview = k && reach && reach.cells.has(k) ? k : null;
    }
    drawOverlay();
  });

  $board.addEventListener('pointerleave', () => { ui.hover = null; drawOverlay(); });

  $panel.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-action]');
    if (!b || b.tagName === 'INPUT') return;
    const a = b.dataset.action;
    if (a === 'select') {
      ui.selected = ui.selected === b.dataset.id ? null : b.dataset.id;
      ui.preview = null;
    } else if (a === 'unplace') {
      E.unplace(game, b.dataset.id);
      ui.selected = b.dataset.id;
    } else if (a === 'auto') {
      E.autoPlace(game, Number(b.dataset.p));
    } else if (a === 'auto-all') {
      for (const p of game.players) E.autoPlace(game, p);
      ui.selected = null;
    } else if (a === 'start') {
      E.startBattle(game);
      ui.selected = null;
    } else if (a === 'undo') {
      E.undo(game);
      ui.preview = null;
    } else if (a === 'end-turn') {
      E.endTurn(game);
      ui.selected = null; ui.preview = null;
    } else if (a === 'reset') {
      newGame();
    }
    render();
  });

  $panel.addEventListener('change', (ev) => {
    const i = ev.target;
    const a = i.dataset.action;
    if (a === 'toggle-player') {
      const p = Number(i.dataset.p);
      const next = i.checked ? [...ui.players, p] : ui.players.filter((x) => x !== p);
      if (next.length < 2) { i.checked = true; flash('Нужно минимум два игрока.'); return renderPanel(); }
      ui.players = next.sort();
      newGame();
    } else if (a === 'setting') {
      game.settings[i.dataset.k] = i.checked;
      ui.preview = null;
    } else if (a === 'edit-move') {
      const u = E.unitById(game, ui.selected);
      const v = Math.max(1, Math.min(20, Number(i.value) || 1));
      const spent = u.move - u.mpLeft;
      u.move = v;
      u.mpLeft = Math.max(0, v - spent);
    }
    render();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT') return;
    if (ev.key === 'Escape') { ui.selected = null; ui.preview = null; render(); }
    else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && game.phase === 'battle') { E.undo(game); ui.preview = null; render(); }
    else if (ev.key === 'Enter' && game.phase === 'battle') { E.endTurn(game); ui.selected = null; ui.preview = null; render(); }
  });

  drawMap();
  render();
})();
