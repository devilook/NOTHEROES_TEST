// Интерфейс прототипа: поле (SVG), колесо инициативы, лоток кубиков и панель хода.
// Вся логика — в engine.js; здесь только показ и ввод.
(function () {
  'use strict';
  const E = window.NHEngine;
  const MAP = window.NHMap;
  const Dice = window.NHDice;
  const Wheel = window.NHWheel;

  const S = 32;             // размер клетки в единицах viewBox
  const OX = 26, OY = 22;   // поля под координаты
  const STEP_MS = 110;      // скорость анимации одного шага
  const NS = 'http://www.w3.org/2000/svg';
  const F = E.FACTIONS;

  const ui = {
    lobby: { 1: 1, 2: 2, 3: 3, 4: 4 },   // зона → фракция (0 — пусто)
    busy: false,
    hover: null,      // ключ клетки под курсором
    preview: null,    // ключ клетки, путь до которой показан
    anim: null,       // { entity, path, start }
    hoverSlot: null,
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

  // ---------- Утилиты ----------

  const cx = (c) => OX + c * S;
  const cy = (r) => OY + r * S;
  const mid = (c, r) => [cx(c) + S / 2, cy(r) + S / 2];
  const map = () => (game ? game.map : staticMap);
  const fname = (f) => F[f].name;
  const ename = (e) => E.entityName(game, e);
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

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

  function zoneFaction(z) {
    if (game) {
      const s = game.seats.find((x) => x.zone === z);
      return s ? s.faction : 0;
    }
    return ui.lobby[z] || 0;
  }

  // ---------- Поле: статичный слой ----------

  function drawMap() {
    const m = map();
    $board.setAttribute('viewBox', `0 0 ${OX + m.cols * S + 6} ${OY + m.rows * S + 6}`);
    $board.innerHTML = '';
    const g = el('g', { class: 'map' }, $board);
    el('rect', { x: OX, y: OY, width: m.cols * S, height: m.rows * S, class: 'floor' }, g);

    for (const z of [1, 2, 3, 4]) {
      const f = zoneFaction(z);
      const cells = m.zones[z];
      for (const [c, r] of cells) el('rect', { x: cx(c), y: cy(r), width: S, height: S, class: 'zone ' + (f ? 'f' + f : 'empty') }, g);
      const xs = cells.map((p) => p[0]), ys = cells.map((p) => p[1]);
      const zc = (Math.min(...xs) + Math.max(...xs) + 1) / 2, zr = (Math.min(...ys) + Math.max(...ys) + 1) / 2;
      el('text', { x: OX + zc * S, y: OY + zr * S, class: 'zone-num ' + (f ? 'f' + f : 'empty') }, g, z);
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

  function drawOverlay() {
    const ov = document.getElementById('overlay');
    ov.innerHTML = '';
    if (!game || ui.busy) return drawHover(ov);

    if (game.phase === 'deploy') {
      const e = E.deployCurrent(game);
      for (const [c, r] of game.map.zones[e.seat]) {
        if (E.canDeploy(game, c, r)) el('rect', { x: cx(c) + 3, y: cy(r) + 3, width: S - 6, height: S - 6, rx: 4, class: 'place-target f' + e.faction }, ov);
      }
    }

    if (game.phase === 'battle') {
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
      for (const t of E.turnTargets(game)) {
        const [x, y] = mid(...E.entity(game, t.id).pos);
        const g = el('g', { class: 'target', transform: `translate(${x} ${y})` }, ov);
        el('circle', { r: 15 }, g);
        el('path', { d: 'M0 -19V-12M0 12V19M-19 0H-12M12 0H19' }, g);
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
    const deploying = game.phase === 'deploy' && E.deployCurrent(game);
    for (const e of game.entities) {
      if (!e.alive || !e.pos) continue;
      const [x, y] = unitXY(e, now || performance.now());
      const active = cur && cur.id === e.id;
      const g = el('g', { transform: `translate(${x} ${y})`, class: 'unit f' + e.faction + (active ? ' active' : '') }, layer);
      if (active) el('circle', { r: 15.5, class: 'active-ring' }, g);
      el('circle', { r: 11.5, class: 'token' }, g);
      el('text', { y: 0.5, class: 'token-label' }, g, e.label);
      // Полоска здоровья
      const w = 20, frac = e.hp / e.maxHp;
      el('rect', { x: -w / 2, y: 13, width: w, height: 3, rx: 1.5, class: 'hp-bg' }, g);
      el('rect', { x: -w / 2, y: 13, width: w * frac, height: 3, rx: 1.5, class: 'hp' + (frac <= 0.3 ? ' low' : '') }, g);
    }
    if (deploying) {
      // Подсказка: кого ставим сейчас
      $info.innerHTML = `Ставит: <b class="chip-text f${deploying.faction}">${esc(ename(deploying))}</b> · место ${deploying.slot} на колесе`;
    }
  }

  // ---------- Колесо ----------

  function renderWheel() {
    if (!game) {
      Wheel.draw($wheel, { wheel: new Array(31).fill(null) }, { title: 'Колесо', subtitle: 'инициативы' });
      return;
    }
    let options = [], pointer = null, title = '', subtitle = '';
    if (game.phase === 'initiative') {
      title = 'Инициатива';
      const e = E.initCurrent(game);
      subtitle = e ? ename(e) : '';
      if (game.pendingInit) options = game.pendingInit.options;
    } else if (game.phase === 'deploy') {
      title = 'Расстановка';
    } else if (game.phase === 'battle') {
      pointer = game.pointer;
      title = 'Круг ' + game.round;
      subtitle = 'место ' + game.pointer;
      if (!ui.busy) options = E.shiftOptions(game);
    } else if (game.phase === 'over') {
      title = 'Конец';
    }
    Wheel.draw($wheel, game, { options, pointer, title, subtitle, hoverSlot: ui.hoverSlot });
  }

  // ---------- Панель ----------

  function chip(f, label, extra) {
    return `<span class="chip f${f} ${extra || ''}">${esc(label)}</span>`;
  }

  function statLine(e) {
    if (e.kind === 'hero') return `инициатива ${e.init}`;
    const cnt = { '+': '+ всегда', '=': '= 50/50', x: 'Х никогда' }[e.counter];
    return `броня ${e.armor} · атака +${e.atk} ${e.atkType === 'melee' ? 'ближняя' : 'дальняя ' + e.range} · скорость ${e.speed}${e.flying ? ' (крыло)' : ''} · инициатива ${e.init} · отпор ${cnt}`;
  }

  function hpBar(e) {
    if (e.kind === 'hero') return '';
    return `<div class="hpbar" title="Здоровье"><b style="width:${(100 * e.hp) / e.maxHp}%"></b></div><span class="hp-num">${e.hp}/${e.maxHp}</span>`;
  }

  function renderLobby() {
    const used = Object.values(ui.lobby).filter(Boolean);
    const dup = used.length !== new Set(used).size;
    const ok = used.length >= 2 && !dup;
    return `<section class="card">
      <h2>Новая партия</h2>
      <p class="hint">Выберите фракцию для каждой стартовой зоны. Пустая зона — без игрока. Нужно минимум двое, фракции не повторяются.</p>
      <div class="seats">${[1, 3, 4, 2].map((z) => `
        <label class="seat ${ui.lobby[z] ? 'f' + ui.lobby[z] : ''}">
          <span class="zone-tag">Зона ${z}</span>
          <select id="lobby-z${z}" data-action="lobby" data-z="${z}">
            <option value="0">— пусто —</option>
            ${[1, 2, 3, 4].map((f) => `<option value="${f}" ${ui.lobby[z] === f ? 'selected' : ''}>${F[f].name} (${F[f].colorName})</option>`).join('')}
          </select>
        </label>`).join('')}
      </div>
      ${dup ? '<p class="warn">Одна фракция выбрана дважды.</p>' : ''}
      <p class="hint">Тестовые параметры у всех юнитов: здоровье 10, броня 1, атака +1 (ближняя), скорость 5, инициатива 3, отпор «=». У героя — инициатива 3.</p>
      <div class="actions"><button class="btn primary" data-action="start" ${ok ? '' : 'disabled'}>Начать партию</button></div>
    </section>`;
  }

  function renderSeats() {
    return `<section class="card">
      <h2>Игроки</h2>
      <ul class="seat-list">${(game.order.length ? game.order : game.seats.map((s) => s.seat)).map((sn, i) => {
        const s = E.seatOf(game, sn);
        const alive = game.entities.filter((e) => e.seat === sn && e.kind === 'unit' && e.alive).length;
        return `<li class="${s.out ? 'out' : ''}">${game.order.length ? `<span class="ord">${i + 1}</span>` : ''}${chip(s.faction, F[s.faction].name[0])}
          <span class="s-name">${fname(s.faction)}</span>
          <span class="s-stat" title="Живых юнитов">${alive}/5</span>
          <span class="s-stat" title="Монеты">${s.coins} мон.</span>
          <span class="s-stat" title="Предметы">${s.items.length} пр.</span></li>`;
      }).join('')}</ul>
    </section>`;
  }

  function renderTurn() {
    const ph = game.phase;
    if (ph === 'order') {
      return `<section class="card">
        <h2>Очерёдность</h2>
        <p class="hint">Каждый игрок бросает к6. Больше всех — ходит первым, дальше по часовой стрелке (зоны 1 → 3 → 4 → 2). Ничья у лидеров — переброс.</p>
        <div class="actions"><button class="btn primary" data-action="roll-order">Бросить к6</button></div>
      </section>`;
    }
    if (ph === 'initiative') {
      const e = E.initCurrent(game);
      const p = game.pendingInit;
      const done = game.initIndex, total = game.initQueue.length;
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
      return `<section class="card">
        <h2>Инициатива · ${done + 1} из ${total}</h2>
        <div class="who">${chip(e.faction, e.label)}<div><strong>${esc(ename(e))}</strong><small>${statLine(e)}</small></div></div>
        ${body}
      </section>`;
    }
    if (ph === 'deploy') {
      const e = E.deployCurrent(game);
      return `<section class="card">
        <h2>Расстановка · ${game.deployIndex + 1} из ${game.deployQueue.length}</h2>
        <div class="who">${chip(e.faction, e.label)}<div><strong>${esc(ename(e))}</strong><small>место ${e.slot} на колесе</small></div></div>
        <p class="hint">Юниты встают в порядке колеса. Кликните свободную клетку зоны ${E.seatOf(game, e.seat).zone}: она подсвечена.</p>
        <div class="actions"><button class="btn" data-action="auto-deploy">Остальных автоматически</button></div>
      </section>`;
    }
    if (ph === 'battle') {
      const e = E.current(game);
      const t = game.turn;
      let hint, state = '';
      if (e.kind === 'hero') {
        hint = 'Ход героя. Магазин и способности пока не сделаны. Можно сдвинуться по колесу (бездействие) или закончить ход.';
      } else {
        const parts = [];
        if (E.canMove(game)) parts.push(`движение: осталось ${t.mpLeft} из ${e.speed}`);
        else parts.push(t.acted ? 'действие сделано' : 'движение потрачено');
        if (E.canAttack(game)) parts.push(E.turnTargets(game).length ? 'есть цели для атаки' : 'целей рядом нет');
        if (E.canShift(game)) parts.push(`можно сдвинуться по колесу на 1…${e.init}`);
        else parts.push('сдвиг по колесу недоступен: юнит двигался');
        state = `<p class="state">${parts.join(' · ')}</p>`;
        hint = 'Подсвечено, куда можно дойти: наведите на клетку, чтобы увидеть путь, кликните, чтобы пойти. Цели атаки обведены прицелом. Сдвиг — клик по подсвеченному месту на колесе.';
      }
      return `<section class="card turn-card f${e.faction}">
        <h2>Круг ${game.round} · место ${game.pointer}</h2>
        <div class="who big">${chip(e.faction, e.label)}<div><strong>${esc(ename(e))}</strong><small>${statLine(e)}</small></div>${hpBar(e)}</div>
        ${state}
        <p class="hint">${hint}</p>
        <div class="actions">
          ${e.kind === 'unit' ? `<button class="btn" data-action="undo-move" ${t.moved && !t.acted ? '' : 'disabled'}>Отменить движение</button>` : ''}
          <button class="btn primary" data-action="end-turn">Конец хода</button>
        </div>
      </section>`;
    }
    if (ph === 'over') {
      const s = E.seatOf(game, game.winner);
      return `<section class="card win ${s ? 'f' + s.faction : ''}">
        <h2>Партия окончена</h2>
        <p class="win-title">${s ? 'Победа: ' + esc(fname(s.faction)) : 'Ничья'}</p>
        <div class="actions"><button class="btn primary" data-action="new">Новая партия</button></div>
      </section>`;
    }
    return '';
  }

  function renderLog() {
    if (!game) return '';
    return `<section class="card">
      <h2>Журнал</h2>
      <ol class="log">${game.log.slice(-40).reverse().map((l) => {
        const s = l.seat && E.seatOf(game, l.seat);
        return `<li class="${s ? 'f' + s.faction : ''}"><span>К${l.round}</span>${esc(l.text)}</li>`;
      }).join('')}</ol>
    </section>`;
  }

  function renderPanel() {
    const ph = game ? game.phase : 'lobby';
    const titles = { lobby: 'Подготовка', order: 'Очерёдность', initiative: 'Инициатива', deploy: 'Расстановка', battle: 'Бой', over: 'Конец партии' };
    $phase.textContent = ph === 'battle' ? `Круг ${game.round} · ${ename(E.current(game))}` : titles[ph];
    $phase.className = 'phase' + (ph === 'battle' ? ' f' + E.current(game).faction : '');
    let html = game ? renderTurn() + renderSeats() + renderLog() : renderLobby();
    if (game && game.phase !== 'over') html += `<section class="card quiet"><button class="btn ghost" data-action="new">Сбросить партию</button></section>`;
    if (ui.message) html = `<p class="toast" role="status">${esc(ui.message)}</p>` + html;
    $panel.innerHTML = html;
    if (!game || game.phase !== 'deploy') updateInfo();
  }

  function updateInfo() {
    if (!game) { $info.textContent = 'Карта «Эскиз v1» 28×22. Сплошные линии — стены, пунктир — полустены, «?» — жетоны.'; return; }
    const u = ui.hover && E.unitAt(game, ...E.unkey(ui.hover));
    if (u) {
      const tgt = game.phase === 'battle' && !ui.busy && E.turnTargets(game).find((t) => t.id === u.id);
      const a = tgt && E.current(game);
      $info.innerHTML = `<b class="chip-text f${u.faction}">${esc(ename(u))}</b> · здоровье ${u.hp}/${u.maxHp} · ${statLine(u)}`
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

  const TOKEN_TEXT = { gold: () => `золото +${E.TOKEN_GOLD} монет`, item: () => 'предмет (заглушка)', trap: () => `ловушка: ${E.TOKEN_TRAP_DAMAGE} чистого урона` };

  async function playEvents(events) {
    const items = [];
    const lines = [];
    for (const ev of events) {
      const who = ev.entity && E.entity(game, ev.entity);
      if (ev.type === 'move') {
        await animatePath(ev.entity, ev.path);
      } else if (ev.type === 'roll' && ev.purpose === 'order') {
        const s = E.seatOf(game, ev.seat);
        items.push({ sides: 6, value: ev.value, caption: fname(s.faction) + (ev.attempt > 1 ? ' · переброс' : ''), cls: 'f' + s.faction, batch: ev.attempt });
      } else if (ev.type === 'order') {
        lines.push('Порядок хода: ' + ev.order.map((sn) => `<b class="chip-text f${E.seatOf(game, sn).faction}">${fname(E.seatOf(game, sn).faction)}</b>`).join(' → '));
      } else if (ev.type === 'roll' && ev.purpose === 'initiative') {
        items.push({ sides: 30, value: ev.value, caption: 'к30 · ' + esc(ename(who)), cls: 'f' + who.faction });
      } else if (ev.type === 'slot') {
        if (ev.forced) lines.push(`${esc(ename(who))} автоматически встаёт на место <b>${ev.slot}</b>`);
      } else if (ev.type === 'roll' && (ev.purpose === 'attack' || ev.purpose === 'counter')) {
        items.push({
          sides: 6, value: ev.value, cls: 'f' + who.faction,
          caption: (ev.purpose === 'attack' ? 'Атака · ' : 'Отпор · ') + esc(ename(who)),
          note: `${ev.value} + ${ev.mod}${ev.penalty ? ' − ' + ev.penalty : ''} = <b>${ev.total}</b>`,
        });
      } else if (ev.type === 'roll' && ev.purpose === 'counterCheck') {
        items.push({ sides: 6, value: ev.value, cls: 'f' + who.faction, caption: 'Отпор? нужно 4–6', note: ev.success ? '<b>да</b>' : 'нет', good: ev.success });
      } else if (ev.type === 'damage') {
        lines.push(`${esc(ename(who))}: ${ev.raw}${ev.pure ? ' (чистый урон)' : ' − броня ' + ev.armor} = <b>${ev.amount}</b> урона · здоровье ${ev.hpLeft}`);
      } else if (ev.type === 'death') {
        lines.push(`<b>${esc(ename(who))} погибает</b>`);
      } else if (ev.type === 'out') {
        lines.push(`<b>${fname(E.seatOf(game, ev.seat).faction)} выбывают</b>`);
      } else if (ev.type === 'token') {
        lines.push(`Жетон открыт: ${TOKEN_TEXT[ev.content]()}`);
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
    if (game.phase === 'deploy') {
      const res = E.deploy(game, c, r);
      if (!res.ok) return flash(res.error);
      return render();
    }
    if (game.phase !== 'battle') return;
    const there = E.unitAt(game, c, r);
    if (there && E.turnTargets(game).some((t) => t.id === there.id)) return act(() => E.attack(game, there.id));
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
    if (!game || game.phase !== 'deploy') updateInfo();
  });
  $board.addEventListener('pointerleave', () => { ui.hover = null; drawOverlay(); updateInfo(); });

  $wheel.addEventListener('click', (ev) => {
    const g = ev.target.closest('[data-slot]');
    if (!g || !game || ui.busy) return;
    const slot = Number(g.dataset.slot);
    if (game.phase === 'initiative' && game.pendingInit) return act(() => E.chooseInitiative(game, slot));
    if (game.phase === 'battle' && E.shiftOptions(game).includes(slot)) return act(() => E.shift(game, slot));
  });
  $wheel.addEventListener('pointerover', (ev) => {
    const g = ev.target.closest('[data-slot]');
    const s = g ? Number(g.dataset.slot) : null;
    if (s !== ui.hoverSlot) { ui.hoverSlot = s; renderWheel(); }
  });

  $panel.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-action]');
    if (!b || ui.busy) return;
    const a = b.dataset.action;
    if (a === 'start') {
      const seats = [1, 2, 3, 4].filter((z) => ui.lobby[z]).map((z) => ({ seat: z, faction: ui.lobby[z] }));
      game = E.createGame(MAP, { seats });
      drawMap();
      Dice.note($tray, 'Бросьте к6 за очерёдность.');
      return render();
    }
    if (a === 'new') {
      game = null;
      drawMap();
      Dice.note($tray, 'Здесь будут броски кубиков.');
      return render();
    }
    if (a === 'roll-order') return act(() => E.rollOrder(game));
    if (a === 'roll-init') return act(() => E.rollInitiative(game));
    if (a === 'auto-init') return act(() => {
      const r = E.autoInitiative(game);
      return { ok: true, events: [{ type: 'text', text: 'Инициатива определена автоматически для всех оставшихся.' }], all: r };
    });
    if (a === 'pick-slot') return act(() => E.chooseInitiative(game, Number(b.dataset.slot)));
    if (a === 'auto-deploy') { E.autoDeploy(game); return render(); }
    if (a === 'undo-move') { E.undoMove(game); return render(); }
    if (a === 'end-turn') return act(() => E.endTurn(game));
  });

  $panel.addEventListener('change', (ev) => {
    const i = ev.target;
    if (i.dataset.action === 'lobby') {
      ui.lobby[Number(i.dataset.z)] = Number(i.value);
      drawMap();
      render();
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'SELECT' || ev.target.tagName === 'INPUT') return;
    if (ev.key === 'Enter' && game && game.phase === 'battle' && !ui.busy) act(() => E.endTurn(game));
    if (ev.key === 'Escape') { ui.preview = null; drawOverlay(); }
  });

  // Доступ из консоли браузера для отладки: NHDebug.game()
  window.NHDebug = { game: () => game, render };

  drawMap();
  render();
  Dice.note($tray, 'Здесь будут броски кубиков.');
})();
