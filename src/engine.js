// Игровая логика «НЕ ГЕРОИ». Чистые функции без DOM — этот же модуль
// потом будет работать на сервере. Правила: docs/rules.md.
//
// Партия — конечный автомат по фазам:
//   order      бросок к6 за очерёдность игроков
//   initiative по очереди: к30 и выбор места на колесе для каждого юнита, затем героев
//   deploy     расстановка юнитов в стартовые зоны в порядке колеса
//   battle     ходы по колесу 1→30, по кругу
//   over       победитель определён
//
// Каждое действие возвращает { ok, error?, events[] }. События (броски, урон, смерть,
// жетоны) интерфейс проигрывает как анимацию.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NHEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FACTIONS = {
    1: { id: 1, key: 'bastion', name: 'Бастион', colorName: 'жёлтые' },
    2: { id: 2, key: 'sylvans', name: 'Сильваны', colorName: 'зелёные' },
    3: { id: 3, key: 'demons', name: 'Демоны', colorName: 'красные' },
    4: { id: 4, key: 'undead', name: 'Нечисть', colorName: 'синие' },
  };

  // Тестовые параметры: одинаковые у всех, пока нет карт юнитов.
  const TEST_UNIT = {
    hp: 10, armor: 1, atk: 1, atkType: 'melee', range: 1,
    speed: 5, init: 3, counter: '=', flying: false,
  };
  const TEST_HERO = { init: 3 };

  const SLOTS = 30;
  // Стартовые зоны по часовой стрелке вокруг стола: 1 (низ-лево) → 3 → 4 → 2.
  const CLOCKWISE = [1, 3, 4, 2];
  const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

  // Содержимое жетонов «?» — заглушка, пока нет настоящих.
  const TOKEN_BAG = { gold: 12, item: 10, trap: 8 };
  const TOKEN_GOLD = 5;
  const TOKEN_TRAP_DAMAGE = 2;

  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const key = (c, r) => c + ',' + r;
  const unkey = (k) => k.split(',').map(Number);

  // ---------- Карта ----------

  function parseMap(def) {
    const lines = def.ascii;
    const rows = (lines.length - 1) / 2;
    const cols = (lines[0].length - 1) / 2;
    if (!Number.isInteger(rows) || !Number.isInteger(cols)) throw new Error('Неверный размер ASCII-карты');

    const cells = [];   // cells[r][c] = { kind: 'floor'|'token'|'block', zone: 0..4 }
    const vEdge = [];   // vEdge[r][k] — ребро слева от клетки k (k = 0..cols)
    const hEdge = [];   // hEdge[k][c] — ребро над клеткой в ряду k (k = 0..rows)
    const zones = { 1: [], 2: [], 3: [], 4: [] };
    const tokenSpots = [];
    const edgeOf = (ch, wallCh, halfCh) => (ch === wallCh ? 'wall' : ch === halfCh ? 'half' : null);

    for (let r = 0; r < rows; r++) {
      cells.push([]);
      vEdge.push([]);
      const line = lines[2 * r + 1];
      for (let k = 0; k <= cols; k++) {
        vEdge[r].push(k === 0 || k === cols ? 'wall' : edgeOf(line[2 * k], '|', ':'));
      }
      for (let c = 0; c < cols; c++) {
        const ch = line[2 * c + 1];
        const cell = { kind: 'floor', zone: 0 };
        if (ch === 'x') { cell.kind = 'token'; tokenSpots.push([c, r]); }
        else if (ch === '#') cell.kind = 'block';
        else if (ch >= '1' && ch <= '4') { cell.zone = Number(ch); zones[cell.zone].push([c, r]); }
        cells[r].push(cell);
      }
    }
    for (let k = 0; k <= rows; k++) {
      hEdge.push([]);
      const line = lines[2 * k];
      for (let c = 0; c < cols; c++) {
        hEdge[k].push(k === 0 || k === rows ? 'wall' : edgeOf(line[2 * c + 1], '-', '='));
      }
    }
    return { name: def.name, cols, rows, cells, vEdge, hEdge, zones, tokenSpots };
  }

  function edgeBetween(map, c, r, dc, dr) {
    if (dc === 1) return map.vEdge[r][c + 1];
    if (dc === -1) return map.vEdge[r][c];
    if (dr === 1) return map.hEdge[r + 1][c];
    return map.hEdge[r][c];
  }

  function inBounds(map, c, r) {
    return c >= 0 && r >= 0 && c < map.cols && r < map.rows;
  }

  // ---------- Создание партии ----------

  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // seats: [{ seat: 1..4 (= стартовая зона), faction: 1..4 }]
  function createGame(mapDef, opts) {
    opts = opts || {};
    const rng = opts.rng || Math.random;
    const map = parseMap(mapDef);
    const seatsIn = opts.seats || [{ seat: 1, faction: 1 }, { seat: 2, faction: 3 }];
    const unitStats = Object.assign({}, TEST_UNIT, opts.unitStats);
    const heroStats = Object.assign({}, TEST_HERO, opts.heroStats);

    const seats = seatsIn.map((s) => ({
      seat: s.seat, faction: s.faction, zone: s.seat, coins: 0, items: [], out: false,
    }));

    const entities = [];
    for (const s of seats) {
      for (let n = 1; n <= 5; n++) {
        entities.push(Object.assign({}, unitStats, {
          id: 's' + s.seat + 'u' + n, kind: 'unit', seat: s.seat, faction: s.faction,
          num: n, label: String(n), maxHp: unitStats.hp, alive: true, pos: null, slot: null,
        }));
      }
      entities.push(Object.assign({}, heroStats, {
        id: 's' + s.seat + 'h', kind: 'hero', seat: s.seat, faction: s.faction,
        num: 0, label: 'Г', alive: true, pos: null, slot: null,
      }));
    }

    const bag = [];
    for (const k in TOKEN_BAG) for (let i = 0; i < TOKEN_BAG[k]; i++) bag.push(k);
    shuffle(bag, rng);
    const tokens = {};
    map.tokenSpots.forEach(([c, r], i) => { tokens[key(c, r)] = { content: bag[i % bag.length] }; });

    return {
      map, rng, seats, entities, tokens,
      phase: 'order',
      order: [],              // места игроков в порядке хода
      wheel: new Array(SLOTS + 1).fill(null), // wheel[1..30] = id сущности
      initQueue: [], initIndex: 0, pendingInit: null,
      deployQueue: [], deployIndex: 0,
      pointer: 0, round: 1, turn: null,
      winner: null,
      log: [],
    };
  }

  const roll = (state, sides) => 1 + Math.floor(state.rng() * sides);

  function entity(state, id) {
    return state.entities.find((e) => e.id === id) || null;
  }

  function seatOf(state, seat) {
    return state.seats.find((s) => s.seat === seat);
  }

  function unitAt(state, c, r) {
    return state.entities.find((e) => e.alive && e.pos && e.pos[0] === c && e.pos[1] === r) || null;
  }

  function entityName(state, e) {
    const f = FACTIONS[e.faction].name;
    return e.kind === 'hero' ? f + ', герой' : f + ' ' + e.label;
  }

  function log(state, text, extra) {
    state.log.push(Object.assign({ round: state.round, text }, extra));
  }

  // ---------- Фаза order: к6 за очерёдность ----------

  function rollOrder(state) {
    if (state.phase !== 'order') return { ok: false, error: 'Очерёдность уже определена' };
    const events = [];
    let contenders = state.seats.map((s) => s.seat);
    let attempt = 1;
    while (contenders.length > 1) {
      const rolls = contenders.map((seat) => ({ seat, value: roll(state, 6) }));
      for (const x of rolls) events.push({ type: 'roll', die: 6, value: x.value, seat: x.seat, purpose: 'order', attempt });
      const max = Math.max(...rolls.map((x) => x.value));
      contenders = rolls.filter((x) => x.value === max).map((x) => x.seat);
      attempt++;
    }
    const first = contenders[0];
    const present = CLOCKWISE.filter((z) => state.seats.some((s) => s.seat === z));
    const i = present.indexOf(first);
    state.order = present.slice(i).concat(present.slice(0, i));
    log(state, 'Первым ходит ' + FACTIONS[seatOf(state, first).faction].name + '. Порядок: ' +
      state.order.map((s) => FACTIONS[seatOf(state, s).faction].name).join(' → '));

    // Очередь инициативы: юниты I всех игроков, юниты II, …, затем герои.
    state.initQueue = [];
    for (let n = 1; n <= 5; n++) for (const s of state.order) state.initQueue.push('s' + s + 'u' + n);
    for (const s of state.order) state.initQueue.push('s' + s + 'h');
    state.initIndex = 0;
    state.phase = 'initiative';
    events.push({ type: 'order', order: state.order.slice() });
    return { ok: true, events };
  }

  // ---------- Фаза initiative: к30 и место на колесе ----------

  const freeSlots = (state) => {
    const out = [];
    for (let s = 1; s <= SLOTS; s++) if (!state.wheel[s]) out.push(s);
    return out;
  };

  const highestFree = (state) => {
    for (let s = SLOTS; s >= 1; s--) if (!state.wheel[s]) return s;
    return null;
  };

  // Места на колесе в пределах сдвига от center (без перехода 30↔1), только свободные.
  function slotsWithin(state, center, range, includeCenter) {
    const out = [];
    for (let d = -range; d <= range; d++) {
      if (d === 0 && !includeCenter) continue;
      const s = center + d;
      if (s >= 1 && s <= SLOTS && !state.wheel[s]) out.push(s);
    }
    return out;
  }

  // Что можно сделать с выпавшим числом: { mode: 'any'|'choose'|'forced', options, slot }
  function initiativeOptions(state, e, value) {
    if (value === 1) return { mode: 'any', options: freeSlots(state) };
    if (value === SLOTS) return { mode: 'forced', slot: highestFree(state), reason: 'выпало 30' };
    const options = slotsWithin(state, value, e.init, true);
    if (!options.length) return { mode: 'forced', slot: highestFree(state), reason: 'все доступные места заняты' };
    return { mode: 'choose', options };
  }

  function initCurrent(state) {
    if (state.phase !== 'initiative') return null;
    return entity(state, state.initQueue[state.initIndex]);
  }

  function rollInitiative(state) {
    const e = initCurrent(state);
    if (!e) return { ok: false, error: 'Сейчас не определение инициативы' };
    if (state.pendingInit) return { ok: false, error: 'Сначала выберите место на колесе' };
    const value = roll(state, SLOTS);
    const opt = initiativeOptions(state, e, value);
    const events = [{ type: 'roll', die: SLOTS, value, entity: e.id, purpose: 'initiative' }];
    if (opt.mode === 'forced') {
      placeOnWheel(state, e, opt.slot);
      log(state, entityName(state, e) + ': к30 = ' + value + ', ' + opt.reason + ' → место ' + opt.slot, { seat: e.seat });
      events.push({ type: 'slot', entity: e.id, slot: opt.slot, forced: true });
      advanceInit(state);
    } else {
      state.pendingInit = { entity: e.id, value, mode: opt.mode, options: opt.options };
    }
    return { ok: true, events, forced: opt.mode === 'forced' };
  }

  function chooseInitiative(state, slot) {
    const p = state.pendingInit;
    if (!p) return { ok: false, error: 'Сначала бросьте к30' };
    if (!p.options.includes(slot)) return { ok: false, error: 'Сюда встать нельзя' };
    const e = entity(state, p.entity);
    placeOnWheel(state, e, slot);
    log(state, entityName(state, e) + ': к30 = ' + p.value + ' → место ' + slot, { seat: e.seat });
    state.pendingInit = null;
    advanceInit(state);
    return { ok: true, events: [{ type: 'slot', entity: e.id, slot }] };
  }

  function placeOnWheel(state, e, slot) {
    if (e.slot) state.wheel[e.slot] = null;
    state.wheel[slot] = e.id;
    e.slot = slot;
  }

  function advanceInit(state) {
    state.initIndex++;
    if (state.initIndex < state.initQueue.length) return;
    state.phase = 'deploy';
    state.deployQueue = state.entities
      .filter((e) => e.kind === 'unit')
      .sort((a, b) => a.slot - b.slot)
      .map((e) => e.id);
    state.deployIndex = 0;
    log(state, 'Инициатива определена. Расстановка в порядке колеса.');
  }

  // Бросить и выбрать за всех оставшихся: исходное место, а если занято — ближайшее доступное.
  function autoInitiative(state) {
    const events = [];
    while (state.phase === 'initiative') {
      if (!state.pendingInit) {
        const r = rollInitiative(state);
        events.push(...r.events);
        if (r.forced) continue;
      }
      const p = state.pendingInit;
      const best = p.options.slice().sort((a, b) => Math.abs(a - p.value) - Math.abs(b - p.value) || a - b)[0];
      events.push(...chooseInitiative(state, best).events);
    }
    return { ok: true, events };
  }

  // ---------- Фаза deploy ----------

  function deployCurrent(state) {
    if (state.phase !== 'deploy') return null;
    return entity(state, state.deployQueue[state.deployIndex]);
  }

  function canDeploy(state, c, r) {
    const e = deployCurrent(state);
    if (!e || !inBounds(state.map, c, r)) return false;
    const cell = state.map.cells[r][c];
    return cell.zone === seatOf(state, e.seat).zone && cell.kind === 'floor' && !unitAt(state, c, r);
  }

  function deploy(state, c, r) {
    if (!canDeploy(state, c, r)) return { ok: false, error: 'Ставить можно только на свободную клетку своей зоны' };
    const e = deployCurrent(state);
    e.pos = [c, r];
    state.deployIndex++;
    if (state.deployIndex >= state.deployQueue.length) startBattle(state);
    return { ok: true, events: [] };
  }

  function autoDeploy(state) {
    while (state.phase === 'deploy') {
      const e = deployCurrent(state);
      const free = state.map.zones[seatOf(state, e.seat).zone].filter(([c, r]) => canDeploy(state, c, r));
      const [c, r] = free[Math.floor(state.rng() * free.length)];
      deploy(state, c, r);
    }
    return { ok: true, events: [] };
  }

  // ---------- Фаза battle: колесо ----------

  function startBattle(state) {
    state.phase = 'battle';
    state.round = 1;
    state.pointer = 0;
    log(state, 'Бой начался. Круг 1.');
    advance(state);
  }

  function nextOccupied(state, from) {
    for (let s = from + 1; s <= SLOTS; s++) if (state.wheel[s]) return s;
    return null;
  }

  function advance(state) {
    if (state.phase !== 'battle') return;
    let s = nextOccupied(state, state.pointer);
    if (s === null) {
      log(state, 'Конец круга ' + state.round + '. Способности фракций — пока нет.');
      state.round++;
      s = nextOccupied(state, 0);
    }
    state.pointer = s;
    const e = entity(state, state.wheel[s]);
    state.turn = {
      entity: e.id, kind: e.kind,
      mpLeft: e.kind === 'unit' ? e.speed : 0,
      moved: false, acted: false,
      startPos: e.pos && e.pos.slice(),
    };
  }

  function current(state) {
    return state.turn ? entity(state, state.turn.entity) : null;
  }

  function endTurn(state) {
    if (state.phase !== 'battle') return { ok: false, error: 'Бой не идёт' };
    state.turn = null;
    advance(state);
    return { ok: true, events: [] };
  }

  // ---------- Движение ----------

  function cellBlocked(state, c, r) {
    return state.map.cells[r][c].kind === 'block';
  }

  // Клетки, куда юнит дойдёт за budget шагов. Дейкстра по (клетка, направление):
  // меньше шагов, при равенстве меньше поворотов. Правила:
  //  стена — никому; полустена — только летающим; юнит — насквозь только летающим,
  //  вставать на занятую нельзя; жетон — встать можно, пройти насквозь нельзя.
  function computeReach(state, id, budget) {
    const u = entity(state, id);
    const result = { origin: u && u.pos, cells: new Map() };
    if (!u || !u.pos || !u.alive) return result;
    if (budget == null) budget = u.speed;
    const best = new Map();
    const sk = (c, r, d) => c + ',' + r + ',' + d;
    const queue = [];
    const push = (it) => { queue.push(it); queue.sort((a, b) => a.steps - b.steps || a.turns - b.turns); };
    const [oc, or] = u.pos;
    best.set(sk(oc, or, -1), { steps: 0, turns: 0, prev: null });
    push({ c: oc, r: or, d: -1, steps: 0, turns: 0 });

    while (queue.length) {
      const cur = queue.shift();
      const rec = best.get(sk(cur.c, cur.r, cur.d));
      if (rec.steps !== cur.steps || rec.turns !== cur.turns) continue;
      if (cur.steps >= budget) continue;
      if (cur.steps > 0 && state.tokens[key(cur.c, cur.r)]) continue; // на жетоне путь кончается
      for (let d = 0; d < 4; d++) {
        const [dc, dr] = DIRS[d];
        const nc = cur.c + dc, nr = cur.r + dr;
        if (!inBounds(state.map, nc, nr) || cellBlocked(state, nc, nr)) continue;
        const edge = edgeBetween(state.map, cur.c, cur.r, dc, dr);
        if (edge === 'wall' || (edge === 'half' && !u.flying)) continue;
        const occ = unitAt(state, nc, nr);
        if (occ && !u.flying) continue;
        const steps = cur.steps + 1;
        const turns = cur.turns + (cur.d !== -1 && cur.d !== d ? 1 : 0);
        const k2 = sk(nc, nr, d);
        const prev = best.get(k2);
        if (prev && (prev.steps < steps || (prev.steps === steps && prev.turns <= turns))) continue;
        best.set(k2, { steps, turns, prev: sk(cur.c, cur.r, cur.d) });
        push({ c: nc, r: nr, d, steps, turns });
      }
    }

    const perCell = new Map();
    for (const [k, rec] of best) {
      const [c, r] = k.split(',').map(Number);
      if ((c === oc && r === or) || unitAt(state, c, r)) continue;
      const ck = key(c, r);
      const cur = perCell.get(ck);
      if (!cur || rec.steps < cur.rec.steps || (rec.steps === cur.rec.steps && rec.turns < cur.rec.turns)) perCell.set(ck, { k, rec });
    }
    for (const [ck, { k, rec }] of perCell) {
      const path = [];
      for (let at = k; at; at = best.get(at).prev) {
        const [c, r] = at.split(',').map(Number);
        path.unshift([c, r]);
      }
      result.cells.set(ck, { steps: rec.steps, path, token: !!state.tokens[ck] });
    }
    return result;
  }

  function canMove(state) {
    const t = state.turn;
    return !!(t && t.kind === 'unit' && !t.acted && t.mpLeft > 0);
  }

  function turnReach(state) {
    if (!canMove(state)) return null;
    return computeReach(state, state.turn.entity, state.turn.mpLeft);
  }

  function move(state, c, r) {
    if (!canMove(state)) return { ok: false, error: 'Сейчас двигаться нельзя' };
    const u = current(state);
    const target = turnReach(state).cells.get(key(c, r));
    if (!target) return { ok: false, error: 'Клетка недостижима' };
    u.pos = [c, r];
    state.turn.mpLeft -= target.steps;
    state.turn.moved = true;
    const events = [{ type: 'move', entity: u.id, path: target.path }];
    log(state, entityName(state, u) + ': ' + target.steps + ' кл. → ' + cellName(c, r), { seat: u.seat });
    if (target.token) {
      events.push(...openToken(state, u, c, r));
      checkVictory(state);
      if (state.phase === 'battle') {
        state.turn = null;
        advance(state);
      }
      events.push({ type: 'turnEnded', reason: 'жетон' });
    }
    return { ok: true, events, path: target.path };
  }

  function undoMove(state) {
    const t = state.turn;
    if (!t || t.kind !== 'unit' || t.acted || !t.moved) return { ok: false, error: 'Нечего отменять' };
    const u = current(state);
    u.pos = t.startPos.slice();
    t.mpLeft = u.speed;
    t.moved = false;
    log(state, entityName(state, u) + ': движение отменено', { seat: u.seat });
    return { ok: true, events: [] };
  }

  function openToken(state, u, c, r) {
    const k = key(c, r);
    const tok = state.tokens[k];
    delete state.tokens[k];
    const seat = seatOf(state, u.seat);
    const events = [{ type: 'token', entity: u.id, content: tok.content, cell: [c, r] }];
    if (tok.content === 'gold') {
      seat.coins += TOKEN_GOLD;
      log(state, entityName(state, u) + ' открыл жетон: золото +' + TOKEN_GOLD, { seat: u.seat });
    } else if (tok.content === 'item') {
      seat.items.push('Предмет (заглушка)');
      log(state, entityName(state, u) + ' открыл жетон: предмет', { seat: u.seat });
    } else {
      log(state, entityName(state, u) + ' открыл жетон: ловушка', { seat: u.seat });
      events.push(...applyDamage(state, u, TOKEN_TRAP_DAMAGE, { pure: true }));
    }
    return events;
  }

  // ---------- Бой ----------

  // Цели атаки для юнита a (с его текущей позиции): [{ id, penalty }]
  function attackTargets(state, a) {
    if (!a || !a.alive || !a.pos) return [];
    const out = [];
    const [ac, ar] = a.pos;
    for (const [dc, dr] of DIRS) {
      if (a.atkType === 'melee') {
        const nc = ac + dc, nr = ar + dr;
        if (!inBounds(state.map, nc, nr)) continue;
        if (edgeBetween(state.map, ac, ar, dc, dr)) continue; // стена и полустена мешают ближнему
        const t = unitAt(state, nc, nr);
        if (t && t.seat !== a.seat) out.push({ id: t.id, penalty: 0, dist: 1 });
        continue;
      }
      // Дальняя: по прямой до range клеток. Стена обрывает линию,
      // полустена и любой юнит на линии — штраф −1. Жетоны не мешают.
      let c = ac, r = ar, penalty = 0;
      for (let dist = 1; dist <= a.range; dist++) {
        const edge = edgeBetween(state.map, c, r, dc, dr);
        if (edge === 'wall') break;
        if (edge === 'half') penalty++;
        c += dc; r += dr;
        if (!inBounds(state.map, c, r)) break;
        const t = unitAt(state, c, r);
        if (t) {
          if (t.seat !== a.seat) out.push({ id: t.id, penalty, dist });
          penalty++;
        }
      }
    }
    return out;
  }

  function canAttack(state) {
    const t = state.turn;
    return !!(t && t.kind === 'unit' && !t.acted);
  }

  function turnTargets(state) {
    return canAttack(state) ? attackTargets(state, current(state)) : [];
  }

  // Бросок урона: к6 + атака − штраф; защитник вычитает броню. Минимум 0.
  function strike(state, atk, def, penalty, purpose) {
    const value = roll(state, 6);
    const raw = Math.max(0, value + atk.atk - penalty);
    const events = [{ type: 'roll', die: 6, value, entity: atk.id, target: def.id, purpose,
      mod: atk.atk, penalty, total: raw, armor: def.armor }];
    events.push(...applyDamage(state, def, raw, { by: atk.id, purpose }));
    return events;
  }

  function applyDamage(state, def, raw, opts) {
    opts = opts || {};
    const armor = opts.pure ? 0 : def.armor;
    const dmg = Math.max(0, raw - armor);
    def.hp = Math.max(0, def.hp - dmg);
    const events = [{ type: 'damage', entity: def.id, raw, armor, amount: dmg, hpLeft: def.hp, pure: !!opts.pure, purpose: opts.purpose }];
    log(state, entityName(state, def) + ': урон ' + raw + (armor ? ' − броня ' + armor : '') + ' = ' + dmg + ', здоровье ' + def.hp, { seat: def.seat });
    if (def.hp === 0) events.push(...kill(state, def));
    return events;
  }

  function kill(state, e) {
    e.alive = false;
    e.pos = null;
    if (e.slot) state.wheel[e.slot] = null;
    log(state, entityName(state, e) + ' погибает', { seat: e.seat });
    const events = [{ type: 'death', entity: e.id }];
    const seat = seatOf(state, e.seat);
    const unitsLeft = state.entities.some((x) => x.seat === e.seat && x.kind === 'unit' && x.alive);
    if (!unitsLeft && !seat.out) {
      seat.out = true;
      const hero = state.entities.find((x) => x.seat === e.seat && x.kind === 'hero');
      if (hero.slot) state.wheel[hero.slot] = null;
      hero.alive = false;
      log(state, FACTIONS[seat.faction].name + ' выбывают', { seat: e.seat });
      events.push({ type: 'out', seat: e.seat });
    }
    return events;
  }

  // Отпор: защитник с соседней клетки отвечает, если может достать атакующего.
  // «+» всегда, «Х» никогда, «=» к6: 4–6 — да.
  function counter(state, atk, def) {
    if (!def.alive || !atk.alive) return [];
    const adjacent = Math.abs(atk.pos[0] - def.pos[0]) + Math.abs(atk.pos[1] - def.pos[1]) === 1;
    if (!adjacent || def.counter === 'x') return [];
    const reach = attackTargets(state, def).find((t) => t.id === atk.id);
    if (!reach) return [{ type: 'text', text: 'Отпор невозможен: не достаёт' }];
    const events = [];
    if (def.counter === '=') {
      const value = roll(state, 6);
      const yes = value >= 4;
      events.push({ type: 'roll', die: 6, value, entity: def.id, purpose: 'counterCheck', success: yes });
      log(state, entityName(state, def) + ': проверка отпора к6 = ' + value + (yes ? ' — отпор!' : ' — нет отпора'), { seat: def.seat });
      if (!yes) return events;
    }
    events.push(...strike(state, def, atk, reach.penalty, 'counter'));
    return events;
  }

  function attack(state, targetId) {
    if (!canAttack(state)) return { ok: false, error: 'Сейчас атаковать нельзя' };
    const a = current(state);
    const tgt = turnTargets(state).find((t) => t.id === targetId);
    if (!tgt) return { ok: false, error: 'Цель недосягаема' };
    const d = entity(state, targetId);
    state.turn.acted = true;
    log(state, entityName(state, a) + ' атакует ' + entityName(state, d), { seat: a.seat });
    const events = [{ type: 'attack', entity: a.id, target: d.id }];
    events.push(...strike(state, a, d, tgt.penalty, 'attack'));
    events.push(...counter(state, a, d));
    checkVictory(state);
    // Атакующий погиб от отпора или больше нечего делать — ход заканчивается сам.
    if (state.phase === 'battle' && (!a.alive || state.turn.moved)) {
      state.turn = null;
      advance(state);
      events.push({ type: 'turnEnded', reason: a.alive ? 'действие после движения' : 'гибель' });
    }
    return { ok: true, events };
  }

  // ---------- Сдвиг по колесу ----------

  function canShift(state) {
    const t = state.turn;
    return !!(t && !t.moved);
  }

  function shiftOptions(state) {
    if (!canShift(state)) return [];
    const e = current(state);
    return slotsWithin(state, e.slot, e.init, false);
  }

  function shift(state, slot) {
    if (!shiftOptions(state).includes(slot)) return { ok: false, error: 'Сюда сдвинуться нельзя' };
    const e = current(state);
    const from = e.slot;
    placeOnWheel(state, e, slot);
    log(state, entityName(state, e) + ': инициатива ' + from + ' → ' + slot + (slot > from ? ' (ещё ход в этом круге)' : ''), { seat: e.seat });
    // Указатель остаётся на старом месте: если сдвиг вперёд, стрелка дойдёт до юнита снова.
    state.turn = null;
    advance(state);
    return { ok: true, events: [{ type: 'shift', entity: e.id, from, to: slot }] };
  }

  // ---------- Победа ----------

  function checkVictory(state) {
    const alive = state.seats.filter((s) => !s.out);
    if (alive.length <= 1 && state.phase === 'battle') {
      state.phase = 'over';
      state.turn = null;
      state.winner = alive.length ? alive[0].seat : null;
      log(state, alive.length ? 'Победа: ' + FACTIONS[alive[0].faction].name + '!' : 'Ничья');
    }
  }

  function cellName(c, r) {
    const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    return (c < 26 ? L[c] : L[Math.floor(c / 26) - 1] + L[c % 26]) + (r + 1);
  }

  return {
    FACTIONS, TEST_UNIT, TEST_HERO, SLOTS, CLOCKWISE, ROMAN, TOKEN_GOLD, TOKEN_TRAP_DAMAGE,
    key, unkey, parseMap, edgeBetween, createGame, entity, seatOf, unitAt, entityName,
    rollOrder, initCurrent, initiativeOptions, rollInitiative, chooseInitiative, autoInitiative,
    deployCurrent, canDeploy, deploy, autoDeploy,
    current, computeReach, turnReach, canMove, move, undoMove,
    attackTargets, turnTargets, canAttack, attack,
    canShift, shiftOptions, shift, endTurn, cellName,
  };
});
