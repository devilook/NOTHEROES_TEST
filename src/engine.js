// Игровая логика «НЕ ГЕРОИ». Чистые функции без DOM — этот же модуль
// потом будет работать на сервере. Правила: docs/rules.md, фракции: src/factions.js.
//
// Партия — конечный автомат по фазам:
//   pick       к6: кто первым выбирает фракцию (или случайная раздача)
//   factions   игроки по очереди выбирают фракции
//   order      к6: кто первым бросает к30 за инициативу
//   initiative по очереди: к30 и выбор места на колесе для юнитов 1…5, затем героев
//   deploy     расстановка юнитов в стартовые зоны в порядке колеса
//   battle     ходы по колесу 1→30, по кругу
//   over       победитель определён
//
// Каждое действие возвращает { ok, error?, events[] }. События (броски, урон, смерть,
// жетоны) интерфейс проигрывает как анимацию.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./factions.js'));
  else root.NHEngine = factory(root.NHFactions);
})(typeof self !== 'undefined' ? self : this, function (FACTIONS) {
  'use strict';

  const SLOTS = 30;
  // Стартовые зоны по часовой стрелке вокруг стола: 1 (низ-лево) → 3 → 4 → 2.
  const CLOCKWISE = [1, 3, 4, 2];
  const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

  // Жетоны «?» (присылка 5): 15 монет, 5 ловушек, 10 предметов.
  const TOKEN_COINS = [20, 20, 30, 30, 40, 40, 50, 50, 60, 60, 70, 70, 80, 80, 100];
  const TOKEN_TRAPS = 5;
  const TOKEN_ITEMS = 10;

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

  // seats: номера стартовых зон игроков, например [1, 4]. Игрок = зона.
  function createGame(mapDef, opts) {
    opts = opts || {};
    const rng = opts.rng || Math.random;
    const map = parseMap(mapDef);
    const seatNums = (opts.seats || [1, 4]).map((s) => (typeof s === 'object' ? s.seat : s));
    const seats = seatNums.map((n) => ({ seat: n, faction: 0, zone: n, coins: 0, items: 0, traps: 0, out: false }));

    const bag = TOKEN_COINS.map((v) => ({ kind: 'coins', value: v }));
    for (let i = 0; i < TOKEN_TRAPS; i++) bag.push({ kind: 'trap' });
    for (let i = 0; i < TOKEN_ITEMS; i++) bag.push({ kind: 'item' });
    shuffle(bag, rng);
    const tokens = {};
    map.tokenSpots.forEach(([c, r], i) => { tokens[key(c, r)] = bag[i % bag.length]; });

    const state = {
      map, rng, seats, entities: [], tokens,
      phase: 'pick',
      pickOrder: [], pickIndex: 0,
      order: [],              // порядок игроков для бросков инициативы
      wheel: new Array(SLOTS + 1).fill(null), // wheel[1..30] = id сущности
      initQueue: [], initIndex: 0, pendingInit: null,
      deployQueue: [], deployIndex: 0,
      pointer: 0, round: 1, turn: null,
      pending: null,          // ожидание ввода посреди боя: клетка ('place') или обмен на колесе ('swap')
      fireTrap: null,         // { cell, seat, hero } — метка Огненной ловушки
      winner: null,
      log: [],
    };
    // Быстрый старт для тестов: фракции заданы сразу.
    if (opts.factions) {
      seats.forEach((s, i) => assignFaction(state, s, opts.factions[i]));
      state.phase = 'order';
    }
    return state;
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

  const has = (e, id) => !!(e && e.ability && e.ability.id === id);

  function seatHas(state, seatNum, id) {
    const s = seatOf(state, seatNum);
    const f = FACTIONS[s.faction];
    return !!f && ((f.ability && f.ability.id === id) || (f.hero.ability && f.hero.ability.id === id));
  }

  function entityName(state, e) {
    const f = FACTIONS[e.faction];
    if (e.kind === 'hero') return f.hero.name + ' (' + f.name + ')';
    return e.name + ' (' + f.name + ')';
  }

  function seatName(state, seatNum) {
    const s = seatOf(state, seatNum);
    return 'Игрок ' + seatNum + (s.faction ? ' · ' + FACTIONS[s.faction].name : '');
  }

  function log(state, text, extra) {
    state.log.push(Object.assign({ round: state.round, text }, extra));
  }

  // Бросок к6 всеми игроками: максимум побеждает, ничья у лидеров — переброс.
  // Порядок — по часовой стрелке от победителя.
  function rollClockwise(state, purpose) {
    const events = [];
    let contenders = state.seats.map((s) => s.seat);
    let attempt = 1;
    while (contenders.length > 1) {
      const rolls = contenders.map((seat) => ({ seat, value: roll(state, 6) }));
      for (const x of rolls) events.push({ type: 'roll', die: 6, value: x.value, seat: x.seat, purpose, attempt });
      const max = Math.max(...rolls.map((x) => x.value));
      contenders = rolls.filter((x) => x.value === max).map((x) => x.seat);
      attempt++;
    }
    const present = CLOCKWISE.filter((z) => state.seats.some((s) => s.seat === z));
    const i = present.indexOf(contenders[0]);
    return { events, order: present.slice(i).concat(present.slice(0, i)) };
  }

  // ---------- Фазы pick и factions ----------

  function rollPickOrder(state) {
    if (state.phase !== 'pick') return { ok: false, error: 'Порядок выбора уже определён' };
    const r = rollClockwise(state, 'pick');
    state.pickOrder = r.order;
    state.pickIndex = 0;
    state.phase = 'factions';
    log(state, 'Первым выбирает фракцию Игрок ' + r.order[0] + '. Порядок выбора: ' + r.order.map((s) => 'Игрок ' + s).join(' → '));
    r.events.push({ type: 'pickOrder', order: r.order.slice() });
    return { ok: true, events: r.events };
  }

  function picker(state) {
    return state.phase === 'factions' ? state.pickOrder[state.pickIndex] : null;
  }

  const takenFactions = (state) => state.seats.map((s) => s.faction).filter(Boolean);

  function assignFaction(state, seat, f) {
    seat.faction = f;
    const data = FACTIONS[f];
    seat.coins = data.hero.coins;
    data.units.forEach((u, i) => {
      state.entities.push(Object.assign({}, u, {
        id: 's' + seat.seat + 'u' + (i + 1), kind: 'unit', seat: seat.seat, faction: f,
        num: i + 1, label: String(i + 1), maxHp: u.hp, alive: true, pos: null, slot: null,
        abilityState: u.ability && u.ability.kind === 'active' ? 'ready' : null,
      }));
    });
    state.entities.push({
      id: 's' + seat.seat + 'h', kind: 'hero', seat: seat.seat, faction: f, num: 0, label: 'Г',
      name: data.hero.name, init: data.hero.init, ability: data.hero.ability,
      alive: true, pos: null, slot: null,
      abilityState: data.hero.ability && data.hero.ability.kind === 'active' ? 'ready' : null,
    });
  }

  function pickFaction(state, f) {
    if (state.phase !== 'factions') return { ok: false, error: 'Сейчас не выбор фракций' };
    if (!FACTIONS[f] || takenFactions(state).includes(f)) return { ok: false, error: 'Эта фракция уже занята' };
    const seat = seatOf(state, picker(state));
    assignFaction(state, seat, f);
    log(state, 'Игрок ' + seat.seat + ' играет за ' + FACTIONS[f].name, { seat: seat.seat });
    state.pickIndex++;
    if (state.pickIndex >= state.pickOrder.length) afterFactions(state);
    return { ok: true, events: [{ type: 'faction', seat: seat.seat, faction: f }] };
  }

  // Случайная раздача всем, у кого ещё нет фракции. Можно вместо броска к6.
  function randomFactions(state) {
    if (state.phase !== 'pick' && state.phase !== 'factions') return { ok: false, error: 'Фракции уже выбраны' };
    const free = shuffle([1, 2, 3, 4].filter((f) => !takenFactions(state).includes(f)), state.rng);
    const events = [];
    for (const s of state.seats) {
      if (s.faction) continue;
      assignFaction(state, s, free.shift());
      log(state, 'Игрок ' + s.seat + ' играет за ' + FACTIONS[s.faction].name + ' (случайно)', { seat: s.seat });
      events.push({ type: 'faction', seat: s.seat, faction: s.faction, random: true });
    }
    afterFactions(state);
    return { ok: true, events };
  }

  function afterFactions(state) {
    state.phase = 'order';
    // Сущности — в порядке зон, чтобы id и порядок не зависели от очереди выбора.
    state.entities.sort((a, b) => a.seat - b.seat || (a.kind === 'hero') - (b.kind === 'hero') || a.num - b.num);
  }

  // ---------- Фаза order: кто первым бросает к30 ----------

  function rollOrder(state) {
    if (state.phase !== 'order') return { ok: false, error: 'Сейчас не определение очерёдности' };
    const r = rollClockwise(state, 'order');
    state.order = r.order;
    log(state, 'Первым бросает инициативу Игрок ' + r.order[0] + '. Порядок: ' + r.order.map((s) => seatName(state, s)).join(' → '));
    state.initQueue = [];
    for (let n = 1; n <= 5; n++) for (const s of state.order) state.initQueue.push('s' + s + 'u' + n);
    for (const s of state.order) state.initQueue.push('s' + s + 'h');
    state.initIndex = 0;
    state.phase = 'initiative';
    r.events.push({ type: 'order', order: state.order.slice() });
    return { ok: true, events: r.events };
  }

  // ---------- Колесо: выбор места ----------

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

  function placeOnWheel(state, e, slot) {
    if (e.slot) state.wheel[e.slot] = null;
    state.wheel[slot] = e.id;
    e.slot = slot;
  }

  // Бросок к30 для e. Возвращает события; если нужен выбор — заводит pendingInit.
  // resume (в бою): 'advance' — после выбора передать ход дальше, 'turn' — вернуться в текущий ход.
  function determineInitiative(state, e, inBattle, resume) {
    const value = roll(state, SLOTS);
    const opt = initiativeOptions(state, e, value);
    const events = [{ type: 'roll', die: SLOTS, value, entity: e.id, purpose: 'initiative' }];
    if (opt.mode === 'forced') {
      placeOnWheel(state, e, opt.slot);
      log(state, entityName(state, e) + ': к30 = ' + value + ', ' + opt.reason + ' → место ' + opt.slot, { seat: e.seat });
      events.push({ type: 'slot', entity: e.id, slot: opt.slot, forced: true });
    } else {
      state.pendingInit = { entity: e.id, value, mode: opt.mode, options: opt.options, battle: !!inBattle, resume: resume || 'advance' };
    }
    return events;
  }

  function initCurrent(state) {
    if (state.pendingInit) return entity(state, state.pendingInit.entity);
    if (state.phase !== 'initiative') return null;
    return entity(state, state.initQueue[state.initIndex]);
  }

  function rollInitiative(state) {
    if (state.phase !== 'initiative') return { ok: false, error: 'Сейчас не определение инициативы' };
    if (state.pendingInit) return { ok: false, error: 'Сначала выберите место на колесе' };
    const e = initCurrent(state);
    const events = determineInitiative(state, e, false);
    const forced = !state.pendingInit;
    if (forced) advanceInit(state);
    return { ok: true, events, forced };
  }

  function chooseInitiative(state, slot) {
    const p = state.pendingInit;
    if (!p) return { ok: false, error: 'Сначала бросьте к30' };
    if (!p.options.includes(slot)) return { ok: false, error: 'Сюда встать нельзя' };
    const e = entity(state, p.entity);
    placeOnWheel(state, e, slot);
    log(state, entityName(state, e) + ': к30 = ' + p.value + ' → место ' + slot, { seat: e.seat });
    state.pendingInit = null;
    const events = [{ type: 'slot', entity: e.id, slot }];
    if (p.battle) events.push(...resumeAfter(state, p.resume));
    else advanceInit(state);
    return { ok: true, events };
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

  // Ближайшее к выпавшему доступное место (для автоматического выбора).
  const bestOption = (p) => p.options.slice().sort((a, b) => Math.abs(a - p.value) - Math.abs(b - p.value) || a - b)[0];

  // Бросить и выбрать за всех оставшихся: исходное место, а если занято — ближайшее доступное.
  function autoInitiative(state) {
    const events = [];
    while (state.phase === 'initiative') {
      if (!state.pendingInit) {
        const r = rollInitiative(state);
        events.push(...r.events);
        if (r.forced) continue;
      }
      events.push(...chooseInitiative(state, bestOption(state.pendingInit)).events);
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
    const events = [];
    if (state.deployIndex >= state.deployQueue.length) events.push(...startBattle(state));
    return { ok: true, events };
  }

  function autoDeploy(state) {
    const events = [];
    while (state.phase === 'deploy') {
      const e = deployCurrent(state);
      const free = state.map.zones[seatOf(state, e.seat).zone].filter(([c, r]) => canDeploy(state, c, r));
      const [c, r] = free[Math.floor(state.rng() * free.length)];
      events.push(...deploy(state, c, r).events);
    }
    return { ok: true, events };
  }

  // ---------- Фаза battle: колесо ----------

  function startBattle(state) {
    state.phase = 'battle';
    state.round = 1;
    state.pointer = 0;
    log(state, 'Бой начался. Круг 1.');
    return advance(state);
  }

  function nextOccupied(state, from) {
    for (let s = from + 1; s <= SLOTS; s++) if (state.wheel[s]) return s;
    return null;
  }

  function advance(state) {
    if (state.phase !== 'battle') return [];
    const events = [];
    let s = nextOccupied(state, state.pointer);
    if (s === null) {
      events.push(...endRound(state));
      if (state.phase !== 'battle' || blocked(state)) return events;
      s = nextOccupied(state, 0);
      if (s === null) return events;
    }
    state.pointer = s;
    const e = entity(state, state.wheel[s]);
    state.turn = {
      entity: e.id, kind: e.kind,
      mpLeft: e.kind === 'unit' ? e.speed : 0,
      moved: false, acted: false,
      startPos: e.pos && e.pos.slice(),
      run: { dir: -1, len: 0, best: 0 }, // самый длинный прямой отрезок за ход (Рыцарский разбег)
    };
    return events;
  }

  // Конец круга: срабатывают способности фракций. Общих событий нет.
  function endRound(state) {
    const events = [{ type: 'roundEnd', round: state.round }];
    log(state, 'Конец круга ' + state.round + '.');
    let swapSeat = null;
    for (const s of state.seats) {
      if (s.out) continue;
      if (seatHas(state, s.seat, 'regen2')) {
        for (const u of state.entities) {
          if (u.seat === s.seat && u.kind === 'unit' && u.alive && u.pos) events.push(...heal(state, u, 2, FACTIONS[s.faction].name));
        }
      }
      if (seatHas(state, s.seat, 'tithe10')) {
        s.coins += 10;
        log(state, FACTIONS[s.faction].hero.name + ': +10 монет (' + FACTIONS[s.faction].name + ')', { seat: s.seat });
        events.push({ type: 'coins', seat: s.seat, amount: 10, source: FACTIONS[s.faction].name });
      }
      if (seatHas(state, s.seat, 'wheelSwap') && swapCandidates(state, s.seat).length >= 2) swapSeat = s.seat;
    }
    state.round++;
    state.pointer = 0;
    if (swapSeat) {
      state.pending = { type: 'swap', seat: swapSeat };
      events.push({ type: 'pending', pending: 'swap' });
    }
    return events;
  }

  // ---------- Демоны: обмен местами на колесе в конце круга ----------

  function swapCandidates(state, seat) {
    return state.entities.filter((e) => e.seat === seat && e.kind === 'unit' && e.alive && e.slot).map((e) => e.id);
  }

  function swapOnWheel(state, idA, idB) {
    const p = state.pending;
    if (!p || p.type !== 'swap') return { ok: false, error: 'Сейчас не обмен на колесе' };
    const c = swapCandidates(state, p.seat);
    if (!c.includes(idA) || !c.includes(idB) || idA === idB) return { ok: false, error: 'Выберите двух своих юнитов на колесе' };
    const a = entity(state, idA), b = entity(state, idB);
    [a.slot, b.slot] = [b.slot, a.slot];
    state.wheel[a.slot] = a.id;
    state.wheel[b.slot] = b.id;
    state.pending = null;
    log(state, entityName(state, a) + ' и ' + entityName(state, b) + ' поменялись местами на колесе', { seat: p.seat });
    const events = [{ type: 'swap', a: a.id, b: b.id }];
    events.push(...advance(state));
    return { ok: true, events };
  }

  function skipSwap(state) {
    const p = state.pending;
    if (!p || p.type !== 'swap') return { ok: false, error: 'Сейчас не обмен на колесе' };
    state.pending = null;
    return { ok: true, events: advance(state) };
  }

  function current(state) {
    return state.turn ? entity(state, state.turn.entity) : null;
  }

  const blocked = (state) => !!(state.pending || state.pendingInit);

  // Конец хода текущего персонажа + отложенные эффекты (возврат проглоченного).
  function finishTurn(state) {
    const e = current(state);
    state.turn = null;
    const events = [];
    // «Способность заканчивается в конце хода цели»: Ослепляющая пыльца, Опутывание корнями
    if (e) for (const k of ['blinded', 'rooted']) if (e[k]) events.push(...endStatus(state, e, k));
    if (e && e.alive && e.swallowing) {
      if (e.swallowing.stage === 'used') {
        e.swallowing.stage = 'holding';
      } else {
        events.push(...beginReturn(state, e));
        if (blocked(state)) return events;
      }
    }
    events.push(...advance(state));
    return events;
  }

  function endTurn(state) {
    if (state.phase !== 'battle' || !state.turn) return { ok: false, error: 'Бой не идёт' };
    if (blocked(state)) return { ok: false, error: 'Сначала завершите выбор' };
    return { ok: true, events: finishTurn(state) };
  }

  // ---------- Движение ----------

  // Клетки, куда юнит дойдёт за budget шагов. Дейкстра по (клетка, направление):
  // меньше шагов, при равенстве меньше поворотов. Правила:
  //  стена — никому; полустена — только летающим; юнит — насквозь только летающим
  //  (Призрак преградой не считается); вставать на занятую нельзя;
  //  жетон — встать можно, пройти насквозь нельзя.
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
        if (!inBounds(state.map, nc, nr) || state.map.cells[nr][nc].kind === 'block') continue;
        const edge = edgeBetween(state.map, cur.c, cur.r, dc, dr);
        if (edge === 'wall' || (edge === 'half' && !u.flying)) continue;
        const occ = unitAt(state, nc, nr);
        if (occ && !u.flying && !has(occ, 'incorporeal')) continue;
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
    return !!(t && !blocked(state) && t.kind === 'unit' && !t.acted && t.mpLeft > 0 && !current(state).rooted);
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
    trackRun(state.turn.run, target.path);
    const events = [{ type: 'move', entity: u.id, path: target.path }];
    log(state, entityName(state, u) + ': ' + target.steps + ' кл. → ' + cellName(c, r), { seat: u.seat });
    if (state.fireTrap && state.fireTrap.cell[0] === c && state.fireTrap.cell[1] === r) {
      events.push(...triggerFireTrap(state, u));
      checkVictory(state);
      if (!u.alive) {
        events.push({ type: 'turnEnded', reason: 'гибель' });
        if (state.phase === 'battle') events.push(...finishTurn(state));
        return { ok: true, events, path: target.path };
      }
    }
    if (target.token) {
      events.push(...openToken(state, u, c, r));
      checkVictory(state);
      events.push({ type: 'turnEnded', reason: 'жетон' });
      if (state.phase === 'battle') events.push(...finishTurn(state));
    }
    return { ok: true, events, path: target.path };
  }

  // Длина прямого отрезка: шаги в одном направлении подряд, в том числе через несколько движений.
  function trackRun(run, path) {
    for (let i = 1; i < path.length; i++) {
      const d = DIRS.findIndex(([dc, dr]) => path[i][0] - path[i - 1][0] === dc && path[i][1] - path[i - 1][1] === dr);
      run.len = d === run.dir ? run.len + 1 : 1;
      run.dir = d;
      run.best = Math.max(run.best, run.len);
    }
  }

  function undoMove(state) {
    const t = state.turn;
    if (!t || t.kind !== 'unit' || t.acted || !t.moved) return { ok: false, error: 'Нечего отменять' };
    const u = current(state);
    u.pos = t.startPos.slice();
    t.mpLeft = u.speed;
    t.moved = false;
    t.run = { dir: -1, len: 0, best: 0 };
    log(state, entityName(state, u) + ': движение отменено', { seat: u.seat });
    return { ok: true, events: [] };
  }

  function openToken(state, u, c, r) {
    const k = key(c, r);
    const tok = state.tokens[k];
    delete state.tokens[k];
    const seat = seatOf(state, u.seat);
    const events = [{ type: 'token', entity: u.id, token: tok, cell: [c, r] }];
    if (tok.kind === 'coins') {
      seat.coins += tok.value;
      log(state, entityName(state, u) + ' открыл жетон: ' + tok.value + ' монет', { seat: u.seat });
    } else if (tok.kind === 'item') {
      seat.items++;
      log(state, entityName(state, u) + ' открыл жетон: предмет (эффект позже)', { seat: u.seat });
    } else {
      seat.traps++;
      log(state, entityName(state, u) + ' открыл жетон: ловушка (эффект позже)', { seat: u.seat });
    }
    return events;
  }

  // ---------- Урон и лечение ----------

  function heal(state, e, amount, source) {
    const before = e.hp;
    e.hp = Math.min(e.maxHp, e.hp + amount);
    if (e.hp === before) return [];
    log(state, entityName(state, e) + ': +' + (e.hp - before) + ' здоровья (' + source + '), здоровье ' + e.hp, { seat: e.seat });
    return [{ type: 'heal', entity: e.id, amount: e.hp - before, hpLeft: e.hp, source }];
  }

  // raw — урон до брони. opts: { pure, source }
  function applyDamage(state, def, raw, opts) {
    opts = opts || {};
    if (opts.pure && has(def, 'pureImmune')) {
      log(state, entityName(state, def) + ': чистый урон ' + raw + ' не действует (' + def.ability.name + ')', { seat: def.seat });
      return [{ type: 'immune', entity: def.id, raw, reason: def.ability.name, source: opts.source }];
    }
    const armor = opts.pure ? 0 : def.armor;
    const dmg = Math.max(0, raw - armor);
    def.hp = Math.max(0, def.hp - dmg);
    const events = [{ type: 'damage', entity: def.id, raw, armor, amount: dmg, hpLeft: def.hp, pure: !!opts.pure, source: opts.source }];
    log(state, entityName(state, def) + ': ' + (opts.source ? opts.source + ', ' : '') + 'урон ' + raw +
      (opts.pure ? ' (чистый)' : ' − броня ' + armor) + ' = ' + dmg + ', здоровье ' + def.hp, { seat: def.seat });
    if (def.hp === 0) events.push(...kill(state, def));
    return events;
  }

  function kill(state, e) {
    e.alive = false;
    const deathPos = e.pos;
    e.pos = null;
    if (e.slot) state.wheel[e.slot] = null;
    e.slot = null;
    log(state, entityName(state, e) + ' погибает', { seat: e.seat });
    const events = [{ type: 'death', entity: e.id }];
    const seat = seatOf(state, e.seat);
    for (const k of ['blinded', 'rooted', 'hunted']) if (e[k]) events.push(...endStatus(state, e, k));
    if (e.kind === 'unit' && seatHas(state, e.seat, 'soothe')) events.push(...soothe(state, e.seat));
    if (e.kind === 'unit' && seatHas(state, e.seat, 'collector50')) {
      seat.coins += 50;
      log(state, FACTIONS[seat.faction].hero.name + ': +50 монет (' + FACTIONS[seat.faction].hero.ability.name + ')', { seat: e.seat });
      events.push({ type: 'coins', seat: e.seat, amount: 50, source: FACTIONS[seat.faction].hero.ability.name });
    }
    // Голем погиб с проглоченной целью — цель выходит сразу (допущение, вопрос 27).
    if (e.swallowing) {
      const t = entity(state, e.swallowing.target);
      e.swallowing = null;
      e.abilityState = 'spent';
      const cell = nearestFreeCells(state, deathPos)[0];
      events.push(...releaseSwallowed(state, t, cell, true));
    }
    const unitsLeft = state.entities.some((x) => x.seat === e.seat && x.kind === 'unit' && x.alive);
    if (!unitsLeft && !seat.out) {
      seat.out = true;
      const hero = state.entities.find((x) => x.seat === e.seat && x.kind === 'hero');
      if (hero.slot) state.wheel[hero.slot] = null;
      hero.alive = false;
      log(state, seatName(state, e.seat) + ' выбывает', { seat: e.seat });
      events.push({ type: 'out', seat: e.seat });
    }
    return events;
  }

  // ---------- Бой ----------

  // Цели атаки для юнита a (с его текущей позиции): [{ id, penalty, dist }]
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
      // Дальняя: по прямой до range клеток. Стена обрывает линию, полустена и юнит
      // на линии — штраф −1 (Призрак не считается). Жетоны не мешают.
      let c = ac, r = ar, penalty = 0;
      for (let dist = 1; dist <= a.range; dist++) {
        const edge = edgeBetween(state.map, c, r, dc, dr);
        if (edge === 'wall') break;
        if (edge === 'half') penalty++;
        c += dc; r += dr;
        if (!inBounds(state.map, c, r)) break;
        const t = unitAt(state, c, r);
        if (t) {
          if (t.seat !== a.seat) out.push({ id: t.id, penalty: has(a, 'bullseye') ? 0 : penalty, dist });
          if (!has(t, 'incorporeal')) penalty++;
        }
      }
    }
    return out;
  }

  function canAttack(state) {
    const t = state.turn;
    return !!(t && !blocked(state) && t.kind === 'unit' && !t.acted && !current(state).blinded);
  }

  function turnTargets(state) {
    return canAttack(state) ? attackTargets(state, current(state)) : [];
  }

  // Один удар: к6 + атака − штраф; защитник вычитает броню. Минимум 0.
  // Плюс способности: максимальный урон (Адская охота, Рыцарский разбег), Бестелесность,
  // Поднять щиты!, Кровопийца, Дьявольские когти, Острый панцирь.
  function strike(state, atk, def, penalty, purpose) {
    let max = null;
    if (purpose === 'attack' && def.hunted && entity(state, def.hunted.by).seat === atk.seat) max = 'Адская охота';
    if (purpose === 'attack' && has(atk, 'charge') && state.turn && state.turn.entity === atk.id && state.turn.run.best >= 5) max = atk.ability.name;
    const value = max ? 6 : roll(state, 6);
    const raw = Math.max(0, value + atk.atk - penalty);
    const events = [{ type: 'roll', die: 6, value, entity: atk.id, target: def.id, purpose,
      mod: atk.atk, penalty, total: raw, armor: def.armor, max }];
    if (max) log(state, entityName(state, atk) + ': максимальный урон (' + max + ')', { seat: atk.seat });
    if (max === 'Адская охота') events.push(...endStatus(state, def, 'hunted'));
    let hit = true;
    if (has(def, 'incorporeal') && value % 2 === 1) {
      hit = false;
      log(state, entityName(state, def) + ': на кости ' + value + ' — промах (' + def.ability.name + ')', { seat: def.seat });
      events.push({ type: 'immune', entity: def.id, raw, reason: def.ability.name + ': выпало ' + value });
    } else if (has(def, 'shieldsUp') && atk.atkType === 'ranged') {
      log(state, entityName(state, def) + ': дальняя атака не наносит урона (' + def.ability.name + ')', { seat: def.seat });
      events.push({ type: 'immune', entity: def.id, raw, reason: def.ability.name });
    } else {
      events.push(...applyDamage(state, def, raw));
    }
    if (hit && atk.alive && has(atk, 'lifesteal1')) events.push(...heal(state, atk, 1, atk.ability.name));
    if (hit && atk.alive && def.alive && has(atk, 'claws')) events.push(...applyDamage(state, def, 1, { pure: true, source: atk.ability.name }));
    if (atk.alive && atk.atkType === 'melee' && has(def, 'spikes2')) {
      events.push(...applyDamage(state, atk, 2, { pure: true, source: def.ability.name }));
    }
    return events;
  }

  // Отпор: защитник с соседней клетки отвечает, если может достать атакующего.
  // «+» всегда, «Х» никогда, «=» к6: 4–6 — да.
  function counter(state, atk, def) {
    if (!def.alive || !atk.alive || !def.pos || !atk.pos) return [];
    if (seatHas(state, atk.seat, 'noCounter')) return [{ type: 'text', text: 'Отпора нет: ' + FACTIONS[atk.faction].name + ' не получают отпор' }];
    if (def.blinded) return [{ type: 'text', text: 'Отпора нет: ' + entityName(state, def) + ' ослеплён' }];
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

  // После действия: если юнит погиб или уже двигался — делать больше нечего, ход заканчивается.
  function afterAction(state, a, events) {
    checkVictory(state);
    if (state.phase !== 'battle' || !state.turn || state.turn.entity !== a.id) return;
    if (!a.alive || state.turn.moved) {
      if (blocked(state)) { state.turn.autoEnd = true; return; } // закончим после выбора клетки или места
      events.push({ type: 'turnEnded', reason: a.alive ? 'действие после движения' : 'гибель' });
      events.push(...finishTurn(state));
    }
  }

  // Продолжение после выбора посреди боя.
  function resumeAfter(state, resume) {
    if (blocked(state) || state.phase !== 'battle') return [];
    if (resume === 'advance') return advance(state);
    const t = state.turn;
    if (t && (t.autoEnd || !current(state).alive)) {
      return [{ type: 'turnEnded', reason: 'действие после движения' }].concat(finishTurn(state));
    }
    return [];
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
    afterAction(state, a, events);
    return { ok: true, events };
  }

  // ---------- Активные способности ----------

  // Шаг по линии способности. Полные стены мешают (если способность не игнорирует их),
  // полустены — нет. По диагонали путь закрыт, если оба обхода через угол упираются в стену.
  function stepClear(state, c, r, dc, dr) {
    const wall = (x, y, ddc, ddr) => edgeBetween(state.map, x, y, ddc, ddr) === 'wall';
    if (dc === 0 || dr === 0) return !wall(c, r, dc, dr);
    const viaH = !wall(c, r, dc, 0) && !wall(c + dc, r, 0, dr);
    const viaV = !wall(c, r, 0, dr) && !wall(c, r + dr, dc, 0);
    return viaH || viaV;
  }

  const LINES = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

  // Клетки в радиусе: только на 8 линиях (ортогонали и диагонали), не дальше radius.
  function radiusCells(state, from, radius, ignoreWalls) {
    const out = [];
    for (const [dc, dr] of LINES) {
      let c = from[0], r = from[1];
      for (let i = 1; i <= radius; i++) {
        if (!inBounds(state.map, c + dc, r + dr)) break;
        if (!ignoreWalls && !stepClear(state, c, r, dc, dr)) break;
        c += dc; r += dr;
        out.push([c, r]);
      }
    }
    return out;
  }

  function unitsInRadius(state, from, radius, ignoreWalls) {
    return radiusCells(state, from, radius, ignoreWalls).map(([c, r]) => unitAt(state, c, r)).filter(Boolean);
  }

  function abilityOwner(state) {
    const t = state.turn;
    if (!t || blocked(state) || t.acted) return null;
    const a = current(state);
    if (!a.ability || a.ability.kind !== 'active' || a.ability.pending) return null;
    if (a.ability.id === 'fireTrap') return a.abilityState === 'spent' ? null : a;
    return a.abilityState === 'ready' ? a : null;
  }

  // Цели активной способности текущего персонажа: id юнитов, 'self' или клетки [c, r].
  function abilityTargets(state) {
    const a = abilityOwner(state);
    if (!a) return [];
    const ab = a.ability;
    if (ab.target === 'self') return ['self'];
    if (ab.target === 'cell') {
      const out = [];
      for (let r = 0; r < state.map.rows; r++) for (let c = 0; c < state.map.cols; c++) {
        const busy = state.fireTrap && state.fireTrap.cell[0] === c && state.fireTrap.cell[1] === r;
        if (state.map.cells[r][c].kind === 'floor' && !unitAt(state, c, r) && !busy) out.push([c, r]);
      }
      return out;
    }
    if (ab.target === 'allyDead') {
      return state.entities.filter((e) => e.seat === a.seat && e.kind === 'unit' && !e.alive).map((e) => e.id);
    }
    const pool = ab.radius ? unitsInRadius(state, a.pos, ab.radius, ab.ignoreWalls)
      : state.entities.filter((e) => e.alive && e.pos);
    return pool.filter((e) => e.id !== a.id && e.kind === 'unit' &&
      (ab.target === 'any' || (ab.target === 'ally' ? e.seat === a.seat : e.seat !== a.seat))).map((e) => e.id);
  }

  // target: id юнита, 'self' или [c, r] для клетки.
  function useAbility(state, target) {
    const targets = abilityTargets(state);
    const ok = Array.isArray(target)
      ? targets.some((x) => Array.isArray(x) && x[0] === target[0] && x[1] === target[1])
      : targets.includes(target);
    if (!ok) return { ok: false, error: 'Способность сейчас недоступна для этой цели' };
    const a = current(state);
    const ab = a.ability;
    const t = typeof target === 'string' && target !== 'self' ? entity(state, target) : null;
    state.turn.acted = true;
    const events = [{ type: 'ability', entity: a.id, target: t ? t.id : null, name: ab.name }];
    log(state, entityName(state, a) + ': ' + ab.name + (t ? ' → ' + entityName(state, t) : ''), { seat: a.seat });
    const spend = () => { a.abilityState = 'spent'; };

    if (ab.id === 'swallow') {
      events.push(...applyDamage(state, t, 3, { pure: true, source: ab.name }));
      if (t.alive) {
        state.wheel[t.slot] = null;
        t.slot = null;
        t.pos = null;
        t.swallowedBy = a.id;
        a.swallowing = { target: t.id, stage: 'used' };
        a.abilityState = 'active';
        log(state, entityName(state, t) + ' проглочен: исчезает с карты и колеса', { seat: t.seat });
        events.push({ type: 'swallowed', entity: t.id, by: a.id });
      } else spend();
    } else if (ab.id === 'blindDust') {
      t.blinded = { by: a.id };
      a.abilityState = 'active';
      log(state, entityName(state, t) + ' ослеплён до конца своего хода', { seat: t.seat });
      events.push({ type: 'status', entity: t.id, status: 'blinded' });
    } else if (ab.id === 'roots') {
      events.push(...applyDamage(state, t, 2, { pure: true, source: ab.name }));
      if (t.alive) {
        t.rooted = { by: a.id };
        a.abilityState = 'active';
        log(state, entityName(state, t) + ' опутан до конца своего хода', { seat: t.seat });
        events.push({ type: 'status', entity: t.id, status: 'rooted' });
      } else spend();
    } else if (ab.id === 'hunt') {
      t.hunted = { by: a.id };
      a.abilityState = 'active';
      log(state, entityName(state, t) + ' помечен: следующая атака союзника — максимальный урон', { seat: t.seat });
      events.push({ type: 'status', entity: t.id, status: 'hunted' });
    } else if (ab.id === 'blast') {
      spend();
      for (const v of unitsInRadius(state, a.pos, 1, false)) events.push(...applyDamage(state, v, 5, { pure: true, source: ab.name }));
    } else if (ab.id === 'arrowRain') {
      spend();
      const hit = [t].concat(unitsInRadius(state, t.pos, 1, true));
      for (const v of hit) if (v.alive) events.push(...applyDamage(state, v, 3, { pure: true, source: ab.name }));
    } else if (ab.id === 'healWord') {
      spend();
      events.push(...heal(state, t, 3, ab.name));
    } else if (ab.id === 'hellGate') {
      spend();
      events.push(...askPlace(state, { reason: 'hellGate', target: t.id, source: a.id, near: a.pos, resume: 'turn' }));
    } else if (ab.id === 'rebirth') {
      spend();
      events.push(...askPlace(state, { reason: 'rebirth', target: t.id, source: a.id, near: a.pos, resume: 'turn' }));
    } else if (ab.id === 'fireTrap') {
      const moved = !!state.fireTrap;
      state.fireTrap = { cell: target.slice(), seat: a.seat, hero: a.id };
      a.abilityState = 'active';
      log(state, ab.name + (moved ? ': метка переставлена на ' : ': метка на ') + cellName(target[0], target[1]), { seat: a.seat });
      events.push({ type: 'trap', cell: target.slice(), moved });
    }
    afterAction(state, a, events);
    return { ok: true, events };
  }

  function endStatus(state, e, k) {
    const st = e[k];
    delete e[k];
    const src = st && entity(state, st.by);
    if (src && src.abilityState === 'active') src.abilityState = 'spent';
    const names = { blinded: 'ослепление', rooted: 'корни', hunted: 'метка охоты' };
    log(state, entityName(state, e) + ': ' + names[k] + ' спадает', { seat: e.seat });
    return [{ type: 'statusEnd', entity: e.id, status: k }];
  }

  function triggerFireTrap(state, u) {
    const ft = state.fireTrap;
    state.fireTrap = null;
    const hero = entity(state, ft.hero);
    if (hero) hero.abilityState = 'spent';
    const events = [{ type: 'trapFired', entity: u.id, cell: ft.cell }];
    events.push(...applyDamage(state, u, 10, { pure: true, source: 'Огненная ловушка' }));
    return events;
  }

  // Сильваны: погиб свой юнит — союзник перезаряжает способность и получает +5.
  // Союзника выбирает игрок (вопрос 31); пока автоматически: с разряженной способностью, иначе самый раненый.
  function soothe(state, seatNum) {
    const allies = state.entities.filter((e) => e.seat === seatNum && e.kind === 'unit' && e.alive && e.pos);
    if (!allies.length) return [];
    allies.sort((x, y) => (y.abilityState === 'spent') - (x.abilityState === 'spent') || x.hp / x.maxHp - y.hp / y.maxHp);
    const t = allies[0];
    const name = FACTIONS[seatOf(state, seatNum).faction].hero.ability.name;
    const events = [];
    if (t.abilityState === 'spent') {
      t.abilityState = 'ready';
      log(state, entityName(state, t) + ': способность перезаряжена (' + name + ')', { seat: seatNum });
      events.push({ type: 'recharge', entity: t.id, source: name });
    }
    events.push(...heal(state, t, 5, name));
    return events;
  }

  // Свободные клетки на минимальном расстоянии (по клеткам, без учёта стен) от from.
  function nearestFreeCells(state, from) {
    let best = Infinity, out = [];
    for (let r = 0; r < state.map.rows; r++) for (let c = 0; c < state.map.cols; c++) {
      if (state.map.cells[r][c].kind !== 'floor' || unitAt(state, c, r)) continue;
      const d = Math.abs(c - from[0]) + Math.abs(r - from[1]);
      if (d < best) { best = d; out = [[c, r]]; } else if (d === best) out.push([c, r]);
    }
    return out;
  }

  // Поставить юнита на ближайшую к near свободную клетку. Несколько вариантов — выбирает игрок.
  function askPlace(state, p) {
    const options = nearestFreeCells(state, p.near);
    if (options.length === 1) return applyPlace(state, p, options[0]);
    state.pending = Object.assign({ type: 'place', options }, p);
    return [{ type: 'pending', pending: 'place' }];
  }

  function applyPlace(state, p, cell) {
    const t = entity(state, p.target);
    const events = [];
    if (p.reason === 'swallowReturn') {
      const g = entity(state, p.source);
      g.swallowing = null;
      g.abilityState = 'spent';
      log(state, entityName(state, g) + ': способность закончилась', { seat: g.seat });
      events.push(...releaseSwallowed(state, t, cell, false));
    } else if (p.reason === 'hellGate') {
      const from = t.pos;
      t.pos = cell;
      log(state, entityName(state, t) + ' проходит через Адские врата на ' + cellName(cell[0], cell[1]), { seat: t.seat });
      events.push({ type: 'teleport', entity: t.id, from, cell });
    } else if (p.reason === 'rebirth') {
      t.alive = true;
      t.hp = 3;
      t.pos = cell;
      const seat = seatOf(state, t.seat);
      log(state, entityName(state, t) + ' воскрешён на ' + cellName(cell[0], cell[1]) + ' с 3 здоровья', { seat: t.seat });
      events.push({ type: 'revived', entity: t.id, cell });
      if (seat.out) seat.out = false;
      events.push(...determineInitiative(state, t, true, 'turn'));
    }
    return events;
  }

  function choosePlace(state, c, r) {
    const p = state.pending;
    if (!p || p.type !== 'place') return { ok: false, error: 'Сейчас не нужно выбирать клетку' };
    if (!p.options.some(([x, y]) => x === c && y === r)) return { ok: false, error: 'Выберите одну из подсвеченных клеток' };
    state.pending = null;
    const events = applyPlace(state, p, [c, r]);
    events.push(...resumeAfter(state, p.resume));
    return { ok: true, events };
  }

  // Конец следующего хода голема: цель возвращается.
  function beginReturn(state, golem) {
    return askPlace(state, { reason: 'swallowReturn', target: golem.swallowing.target, source: golem.id, near: golem.pos, resume: 'advance' });
  }

  // Цель выходит на клетку и заново определяет инициативу (к30).
  function releaseSwallowed(state, t, cell, auto) {
    t.pos = cell;
    delete t.swallowedBy;
    log(state, entityName(state, t) + ' возвращается на ' + cellName(cell[0], cell[1]), { seat: t.seat });
    const events = [{ type: 'released', entity: t.id, cell }];
    events.push(...determineInitiative(state, t, true, 'advance'));
    if (auto && state.pendingInit) {
      const p = state.pendingInit;
      const slot = bestOption(p);
      placeOnWheel(state, t, slot);
      state.pendingInit = null;
      log(state, entityName(state, t) + ': место ' + slot + ' (автоматически)', { seat: t.seat });
      events.push({ type: 'slot', entity: t.id, slot, forced: true });
    }
    return events;
  }

  // ---------- Бес: Душевные муки ----------

  // Бес не действовал и не менял инициативу — может ударить любого врага на 1 чистого.
  // Применение заканчивает ход (сдвигаться после уже нельзя).
  function tormentTargets(state) {
    const t = state.turn;
    if (!t || blocked(state) || t.acted) return [];
    const a = current(state);
    if (!has(a, 'torment')) return [];
    return state.entities.filter((e) => e.alive && e.pos && e.kind === 'unit' && e.seat !== a.seat).map((e) => e.id);
  }

  function torment(state, targetId) {
    if (!tormentTargets(state).includes(targetId)) return { ok: false, error: 'Душевные муки сейчас недоступны' };
    const a = current(state);
    const t = entity(state, targetId);
    log(state, entityName(state, a) + ': ' + a.ability.name + ' → ' + entityName(state, t), { seat: a.seat });
    const events = [{ type: 'ability', entity: a.id, target: t.id, name: a.ability.name }];
    events.push(...applyDamage(state, t, 1, { pure: true, source: a.ability.name }));
    checkVictory(state);
    if (state.phase === 'battle') {
      events.push({ type: 'turnEnded', reason: a.ability.name });
      events.push(...finishTurn(state));
    }
    return { ok: true, events };
  }

  // ---------- Сдвиг по колесу ----------

  function canShift(state) {
    const t = state.turn;
    const e = current(state);
    return !!(t && !blocked(state) && !t.moved && !(e && (e.blinded || e.rooted)));
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
    const events = [{ type: 'shift', entity: e.id, from, to: slot }];
    events.push(...finishTurn(state));
    return { ok: true, events };
  }

  // ---------- Победа ----------

  function checkVictory(state) {
    const alive = state.seats.filter((s) => !s.out);
    if (alive.length <= 1 && state.phase === 'battle') {
      state.phase = 'over';
      state.turn = null;
      state.pending = null;
      state.pendingInit = null;
      state.winner = alive.length ? alive[0].seat : null;
      log(state, alive.length ? 'Победа: ' + seatName(state, alive[0].seat) + '!' : 'Ничья');
    }
  }

  function cellName(c, r) {
    const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    return (c < 26 ? L[c] : L[Math.floor(c / 26) - 1] + L[c % 26]) + (r + 1);
  }

  return {
    FACTIONS, SLOTS, CLOCKWISE, ROMAN, TOKEN_COINS,
    key, unkey, parseMap, edgeBetween, createGame, entity, seatOf, unitAt, entityName, seatName, has,
    rollPickOrder, picker, pickFaction, randomFactions, takenFactions,
    rollOrder, initCurrent, initiativeOptions, rollInitiative, chooseInitiative, autoInitiative,
    deployCurrent, canDeploy, deploy, autoDeploy,
    current, computeReach, turnReach, canMove, move, undoMove,
    attackTargets, turnTargets, canAttack, attack,
    abilityTargets, useAbility, choosePlace, chooseReturnCell: choosePlace, nearestFreeCells, radiusCells,
    tormentTargets, torment, swapCandidates, swapOnWheel, skipSwap,
    canShift, shiftOptions, shift, endTurn, cellName,
  };
});
