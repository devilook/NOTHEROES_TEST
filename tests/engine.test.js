// Запуск: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/engine.js');
const MAP = require('../src/map.js');

// Тестовые фракции 8 и 9: одинаковые простые юниты (здоровье 10, броня 1, атака +1, скорость 5, отпор «=»),
// чтобы проверять базовые правила без способностей.
function testFaction(id) {
  const unit = (n) => ({ num: n, name: String(n), hp: 10, atk: 1, atkType: 'melee', range: 1, armor: 1, counter: '=', speed: 5, flying: false, init: 3, ability: null });
  return { id, key: 'test' + id, name: 'Тест' + id, ability: null, hero: { name: 'Герой', coins: 20, init: 3, ability: null }, units: [1, 2, 3, 4, 5].map(unit) };
}
E.FACTIONS[8] = testFaction(8);
E.FACTIONS[9] = testFaction(9);

// Детерминированный генератор: mulberry32.
function seeded(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Подложить заранее заданные броски: dice(state, [[6, 4], [6, 2]]) — к6 = 4, затем к6 = 2.
function dice(state, list) {
  const q = list.slice();
  state.rng = () => {
    const [sides, v] = q.shift();
    return (v - 0.5) / sides;
  };
}

// seats: [{ seat, faction }] — фракции назначаются сразу, партия начинается с фазы order.
function newGame(seats, seed) {
  seats = seats || [{ seat: 1, faction: 8 }, { seat: 2, faction: 9 }];
  return E.createGame(MAP, { seats: seats.map((x) => x.seat), factions: seats.map((x) => x.faction), rng: seeded(seed || 1) });
}

// Партия сразу в бою: все юниты убраны с поля, колесо пустое.
function bareBattle(seats) {
  const s = newGame(seats);
  E.rollOrder(s);
  E.autoInitiative(s);
  E.autoDeploy(s);
  s.wheel.fill(null);
  for (const e of s.entities) { e.slot = null; if (e.kind === 'unit') e.pos = null; }
  return s;
}

function put(s, id, c, r, slot) {
  const e = E.entity(s, id);
  e.pos = [c, r];
  e.slot = slot;
  s.wheel[slot] = id;
  return e;
}

function turnOf(s, id) {
  s.pointer = E.entity(s, id).slot - 1;
  s.turn = { entity: null };
  // advance — внутренняя функция, доходим до нужного слота через endTurn
  s.phase = 'battle';
  E.endTurn(s);
  assert.equal(s.turn.entity, id);
}

test('карта: 28×22, 4 зоны по 9 клеток, 30 мест жетонов', () => {
  const m = E.parseMap(MAP);
  assert.equal(m.cols, 28);
  assert.equal(m.rows, 22);
  for (const z of [1, 2, 3, 4]) assert.equal(m.zones[z].length, 9);
  assert.equal(m.tokenSpots.length, 30);
});

test('очерёдность бросков к30: ничья по к6 перебрасывается, дальше по часовой', () => {
  const s = newGame([{ seat: 1, faction: 1 }, { seat: 2, faction: 2 }, { seat: 3, faction: 3 }]);
  dice(s, [[6, 5], [6, 5], [6, 2], [6, 1], [6, 6]]); // места 1 и 2 по 5 → переброс: 1 против 6
  const r = E.rollOrder(s);
  assert.ok(r.ok);
  assert.deepEqual(s.order, [2, 1, 3]); // по часовой: 1 → 3 → 4 → 2; начинает 2
  assert.equal(r.events.filter((e) => e.type === 'roll').length, 5);
  assert.equal(s.initQueue[0], 's2u1');
  assert.equal(s.initQueue[1], 's1u1');
  assert.equal(s.initQueue.at(-1), 's3h');
});

test('инициатива: выбор в пределах сдвига, 1 — любое место, 30 — наибольшее свободное', () => {
  const s = newGame();
  E.rollOrder(s);
  const e = E.initCurrent(s);
  assert.deepEqual(E.initiativeOptions(s, e, 10).options, [7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(E.initiativeOptions(s, e, 2).options, [1, 2, 3, 4, 5]); // без перехода через 30↔1
  assert.equal(E.initiativeOptions(s, e, 1).mode, 'any');
  s.wheel[30] = 'x'; s.wheel[29] = 'x';
  const r30 = E.initiativeOptions(s, e, 30);
  assert.equal(r30.mode, 'forced');
  assert.equal(r30.slot, 28);
  for (let i = 3; i <= 9; i++) s.wheel[i] = 'x';
  const busy = E.initiativeOptions(s, e, 6);
  assert.equal(busy.mode, 'forced');
  assert.equal(busy.slot, 28);
});

test('полный цикл подготовки: все на колесе, все на поле, начинается бой', () => {
  const s = newGame([{ seat: 1, faction: 1 }, { seat: 2, faction: 2 }, { seat: 3, faction: 3 }, { seat: 4, faction: 4 }], 7);
  E.rollOrder(s);
  E.autoInitiative(s);
  assert.equal(s.phase, 'deploy');
  assert.equal(s.wheel.filter(Boolean).length, 24);
  // расстановка идёт в порядке колеса
  const slots = s.deployQueue.map((id) => E.entity(s, id).slot);
  assert.deepEqual(slots, slots.slice().sort((a, b) => a - b));
  E.autoDeploy(s);
  assert.equal(s.phase, 'battle');
  assert.ok(s.entities.filter((e) => e.kind === 'unit').every((e) => e.pos && s.map.cells[e.pos[1]][e.pos[0]].zone === e.seat));
  assert.equal(s.pointer, s.wheel.findIndex(Boolean));
});

test('движение: только ортогонально, не дальше скорости, сквозь юнитов нельзя', () => {
  const s = bareBattle();
  put(s, 's1u1', 3, 18, 5);
  turnOf(s, 's1u1');
  const reach = E.turnReach(s);
  assert.ok(reach.cells.size <= 60); // не больше ромба радиуса 5
  assert.equal(reach.cells.get(E.key(8, 18)).steps, 5);
  assert.equal(reach.cells.get(E.key(3, 13)).steps, 5);
  assert.ok(!reach.cells.has(E.key(4, 13)), 'дальше скорости нельзя');
  for (const [, v] of reach.cells) {
    assert.ok(v.steps <= 5);
    for (let i = 1; i < v.path.length; i++) {
      const [a, b] = [v.path[i - 1], v.path[i]];
      assert.equal(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]), 1);
    }
  }
  put(s, 's1u2', 3, 17, 6); // свой юнит сверху
  const r2 = E.turnReach(s);
  assert.ok(!r2.cells.has(E.key(3, 17)));
  assert.ok(r2.cells.get(E.key(3, 16)).steps > 2, 'обход, а не насквозь');
});

test('полустена: пеший не проходит, летающий проходит', () => {
  const s = bareBattle();
  // Полустена между (12,6) и (12,7)
  put(s, 's1u1', 12, 6, 5);
  turnOf(s, 's1u1');
  const walk = E.turnReach(s).cells.get(E.key(12, 7));
  assert.ok(!walk || walk.steps > 1);
  E.entity(s, 's1u1').flying = true;
  assert.equal(E.turnReach(s).cells.get(E.key(12, 7)).steps, 1);
});

test('жетон: встать можно, пройти насквозь нельзя; открытие заканчивает ход и убирает жетон', () => {
  const s = bareBattle();
  // Жетон на (6,12); юнит слева от него на (6,11)? Берём открытое место: жетон (13,10), юнит (13,9)
  assert.ok(s.tokens[E.key(13, 10)]);
  put(s, 's1u1', 13, 9, 5);
  put(s, 's2u1', 0, 0, 8);
  turnOf(s, 's1u1');
  const reach = E.turnReach(s);
  assert.ok(reach.cells.get(E.key(13, 10)).token);
  // Клетка сразу за жетоном не достигается через него
  const behind = reach.cells.get(E.key(13, 11));
  assert.ok(!behind || !behind.path.some(([c, r]) => c === 13 && r === 10));
  s.tokens[E.key(13, 10)] = { kind: 'coins', value: 70 };
  const coins = E.seatOf(s, 1).coins;
  const res = E.move(s, 13, 10);
  assert.ok(res.ok);
  assert.ok(!s.tokens[E.key(13, 10)]);
  assert.equal(E.seatOf(s, 1).coins, coins + 70);
  assert.equal(s.turn.entity, 's2u1', 'ход перешёл дальше');
});

test('атака: к6 + атака − броня; отпор «=» по к6 4–6', () => {
  const s = bareBattle();
  const a = put(s, 's1u1', 3, 18, 5);
  const d = put(s, 's2u1', 4, 18, 9);
  turnOf(s, 's1u1');
  assert.deepEqual(E.turnTargets(s).map((t) => t.id), ['s2u1']);
  dice(s, [[6, 4], [6, 5], [6, 3]]); // атака 4, проверка отпора 5 (да), отпор 3
  const r = E.attack(s, 's2u1');
  assert.ok(r.ok);
  assert.equal(d.hp, 10 - (4 + 1 - 1));   // 6
  assert.equal(a.hp, 10 - (3 + 1 - 1));   // 7
  assert.equal(s.turn.entity, 's1u1', 'не двигался — ход не закончен, можно сдвинуться');
  assert.ok(!E.canAttack(s));
  assert.ok(E.canShift(s));

  dice(s, [[6, 1]]);
  const s2 = bareBattle();
  put(s2, 's1u1', 3, 18, 5);
  const d2 = put(s2, 's2u1', 4, 18, 9);
  turnOf(s2, 's1u1');
  dice(s2, [[6, 1], [6, 3]]); // атака 1 → 1+1−1 = 1; проверка отпора 3 — нет
  E.attack(s2, 's2u1');
  assert.equal(d2.hp, 9);
  assert.equal(E.entity(s2, 's1u1').hp, 10);
});

test('ближняя атака не проходит через стену и полустену', () => {
  const s = bareBattle();
  put(s, 's1u1', 12, 6, 5);
  put(s, 's2u1', 12, 7, 9); // между ними полустена
  turnOf(s, 's1u1');
  assert.equal(E.turnTargets(s).length, 0);
});

test('гибель: юнит убирается с поля и колеса; все юниты мертвы — игрок выбывает, победа', () => {
  const s = bareBattle();
  put(s, 's1u1', 3, 18, 5);
  const d = put(s, 's2u1', 4, 18, 9);
  for (const e of s.entities) if (e.seat === 2 && e.id !== 's2u1') e.alive = false;
  d.hp = 2;
  turnOf(s, 's1u1');
  dice(s, [[6, 6]]);
  E.attack(s, 's2u1');
  assert.ok(!d.alive);
  assert.equal(s.wheel[9], null);
  assert.equal(s.phase, 'over');
  assert.equal(s.winner, 1);
});

test('сдвиг по колесу: нельзя после движения; вперёд — ещё ход в этом круге; без перехода 30↔1', () => {
  const s = bareBattle();
  put(s, 's1u1', 3, 18, 5);
  put(s, 's2u1', 20, 3, 12);
  turnOf(s, 's1u1');
  assert.deepEqual(E.shiftOptions(s), [2, 3, 4, 6, 7, 8]);
  E.shift(s, 8);
  assert.equal(s.turn.entity, 's1u1', 'стрелка дошла до места 8 — снова ход');
  E.move(s, 3, 17);
  assert.deepEqual(E.shiftOptions(s), [], 'после движения сдвиг запрещён');
  E.endTurn(s);
  assert.equal(s.turn.entity, 's2u1');
  E.endTurn(s);
  assert.equal(s.round, 2);
  assert.equal(s.turn.entity, 's1u1');

  const t = bareBattle();
  put(t, 's1u1', 3, 18, 29);
  put(t, 's2u1', 20, 3, 1);
  turnOf(t, 's1u1');
  assert.deepEqual(E.shiftOptions(t), [26, 27, 28, 30]);
});

// ---------- Присылка 5: выбор фракций, жетоны, Нечисть ----------

test('выбор фракций: к6 определяет, кто выбирает первым; дальше по часовой', () => {
  const s = E.createGame(MAP, { seats: [1, 3, 4], rng: seeded(3) });
  assert.equal(s.phase, 'pick');
  dice(s, [[6, 2], [6, 6], [6, 1]]); // зона 3 выигрывает
  E.rollPickOrder(s);
  assert.deepEqual(s.pickOrder, [3, 4, 1]);
  assert.equal(E.picker(s), 3);
  assert.ok(E.pickFaction(s, 4).ok);
  assert.ok(!E.pickFaction(s, 4).ok, 'занятую фракцию взять нельзя');
  E.pickFaction(s, 2);
  E.pickFaction(s, 1);
  assert.equal(s.phase, 'order');
  assert.equal(E.seatOf(s, 3).faction, 4);
  assert.equal(E.entity(s, 's3u1').name, 'Скелет');
  assert.equal(E.seatOf(s, 3).coins, 20, 'стартовые монеты героя');
});

test('случайные фракции: у всех разные, можно вместо броска', () => {
  const s = E.createGame(MAP, { seats: [1, 2, 3, 4], rng: seeded(9) });
  assert.ok(E.randomFactions(s).ok);
  assert.equal(s.phase, 'order');
  assert.deepEqual(s.seats.map((x) => x.faction).sort(), [1, 2, 3, 4]);
  assert.equal(s.entities.length, 24);
});

test('порядок к30: победитель к6 бросает первым за юнита 1, потом по часовой; герои последними', () => {
  const s = newGame([{ seat: 1, faction: 1 }, { seat: 3, faction: 2 }, { seat: 2, faction: 4 }]);
  dice(s, [[6, 1], [6, 3], [6, 5]]); // зона 2 выигрывает
  E.rollOrder(s);
  assert.deepEqual(s.order, [2, 1, 3]);
  assert.deepEqual(s.initQueue.slice(0, 4), ['s2u1', 's1u1', 's3u1', 's2u2']);
  assert.deepEqual(s.initQueue.slice(-3), ['s2h', 's1h', 's3h']);
});

test('жетоны: 15 монет нужных номиналов, 5 ловушек, 10 предметов', () => {
  const s = newGame();
  const all = Object.values(s.tokens);
  assert.equal(all.length, 30);
  assert.deepEqual(all.filter((t) => t.kind === 'coins').map((t) => t.value).sort((a, b) => a - b), E.TOKEN_COINS);
  assert.equal(all.filter((t) => t.kind === 'trap').length, 5);
  assert.equal(all.filter((t) => t.kind === 'item').length, 10);
});

const UNDEAD_VS_TEST = [{ seat: 1, faction: 4 }, { seat: 2, faction: 9 }];

test('Нечисть: параметры с ширмы', () => {
  const s = newGame(UNDEAD_VS_TEST);
  const [sk, va, gh, sc, go] = [1, 2, 3, 4, 5].map((n) => E.entity(s, 's1u' + n));
  assert.deepEqual([sk.hp, sk.atk, sk.armor, sk.counter, sk.speed, sk.init], [24, 0, 1, '=', 5, 4]);
  assert.deepEqual([va.hp, va.atk, va.armor, va.counter, va.speed, va.flying, va.init], [25, 2, 0, '+', 5, true, 1]);
  assert.deepEqual([gh.hp, gh.atk, gh.armor, gh.counter, gh.speed, gh.flying, gh.init], [20, 1, 0, 'x', 4, true, 2]);
  assert.deepEqual([sc.hp, sc.atk, sc.atkType, sc.range, sc.armor, sc.counter, sc.speed, sc.init], [25, 1, 'ranged', 4, 2, 'x', 4, 2]);
  assert.deepEqual([go.hp, go.atk, go.armor, go.counter, go.speed, go.init], [50, 2, 0, 'x', 3, 3]);
  assert.equal(E.entity(s, 's1h').init, 3);
});

test('Скарабей: дальняя атака на 4 клетки, Призрак не даёт штрафа; Острый панцирь бьёт ближника', () => {
  const s = bareBattle(UNDEAD_VS_TEST);
  const sc = put(s, 's1u4', 3, 18, 5);
  put(s, 's1u3', 4, 18, 6);   // Призрак на линии
  const enemy = put(s, 's2u1', 7, 18, 9);
  turnOf(s, 's1u4');
  const t = E.turnTargets(s).find((x) => x.id === 's2u1');
  assert.ok(t);
  assert.equal(t.penalty, 0, 'Призрак не преграда');
  dice(s, [[6, 4]]);
  E.attack(s, 's2u1');
  assert.equal(enemy.hp, 10 - (4 + 1 - 1));

  const s2 = bareBattle(UNDEAD_VS_TEST);
  const sc2 = put(s2, 's1u4', 3, 18, 9);
  const m = put(s2, 's2u1', 4, 18, 5);
  turnOf(s2, 's2u1');
  dice(s2, [[6, 6]]);
  E.attack(s2, 's1u4');
  assert.equal(sc2.hp, 25 - (6 + 1 - 2));
  assert.equal(m.hp, 10 - 2, 'атакующий получил 2 чистого урона');
});

test('Призрак: на 1, 3, 5 урона нет; Вампир лечится за атаку', () => {
  const s = bareBattle(UNDEAD_VS_TEST);
  const gh = put(s, 's1u3', 3, 18, 9);
  put(s, 's2u1', 4, 18, 5);
  turnOf(s, 's2u1');
  dice(s, [[6, 5]]);
  E.attack(s, 's1u3');
  assert.equal(gh.hp, 20);

  const s2 = bareBattle(UNDEAD_VS_TEST);
  const va = put(s2, 's1u2', 3, 18, 5);
  va.hp = 20;
  const d = put(s2, 's2u1', 4, 18, 9);
  turnOf(s2, 's1u2');
  dice(s2, [[6, 3], [6, 1]]); // атака 3; проверка отпора 1 — нет
  E.attack(s2, 's2u1');
  assert.equal(d.hp, 10 - (3 + 2 - 1));
  assert.equal(va.hp, 21);
});

test('Скелет не получает чистый урон; Собиратель останков: +50 за погибшего юнита', () => {
  const s = bareBattle(UNDEAD_VS_TEST);
  put(s, 's1u5', 3, 18, 5);
  const skel = put(s, 's1u1', 4, 18, 9);
  turnOf(s, 's1u5');
  E.useAbility(s, 's1u1');
  assert.equal(skel.hp, 24, 'чистый урон Проглатывания по Скелету не проходит');

  const s2 = bareBattle([{ seat: 1, faction: 9 }, { seat: 2, faction: 4 }]);
  put(s2, 's1u1', 3, 18, 5);
  const gh = put(s2, 's2u3', 4, 18, 9);
  put(s2, 's2u1', 20, 3, 12);
  gh.hp = 2;
  turnOf(s2, 's1u1');
  const coins = E.seatOf(s2, 2).coins;
  dice(s2, [[6, 6]]);
  E.attack(s2, 's2u3');
  assert.ok(!gh.alive);
  assert.equal(E.seatOf(s2, 2).coins, coins + 50);
});

test('Мясной голем: проглатывает, возвращает в конце следующего хода, цель бросает к30', () => {
  const s = bareBattle(UNDEAD_VS_TEST);
  const g = put(s, 's1u5', 3, 18, 5);
  const t = put(s, 's2u1', 4, 19, 9); // по диагонали
  put(s, 's2u2', 20, 3, 12);
  turnOf(s, 's1u5');
  assert.ok(E.abilityTargets(s).includes('s2u1'));
  const r = E.useAbility(s, 's2u1');
  assert.ok(r.ok);
  assert.equal(t.hp, 10 - 3);
  assert.equal(t.pos, null);
  assert.equal(s.wheel[9], null);
  assert.equal(g.abilityState, 'active');
  E.endTurn(s);                 // конец хода, где способность применена
  assert.equal(s.turn.entity, 's2u2');
  E.endTurn(s);                 // круг 2: снова голем
  assert.equal(s.turn.entity, 's1u5');
  E.move(s, 3, 17);
  dice(s, [[30, 15]]);
  const end = E.endTurn(s);     // конец следующего хода — возврат
  assert.ok(end.ok);
  if (s.pending) E.chooseReturnCell(s, ...s.pending.options[0]);
  assert.ok(t.pos, 'цель вернулась на поле');
  assert.equal(Math.abs(t.pos[0] - 3) + Math.abs(t.pos[1] - 17), 1, 'на ближайшую свободную клетку');
  if (s.pendingInit) E.chooseInitiative(s, 15);
  assert.equal(t.slot, 15);
  assert.equal(g.abilityState, 'spent');
  assert.ok(s.turn, 'бой продолжается');
});

test('Нечисть: в конце круга +2 здоровья, не выше максимума', () => {
  const s = bareBattle(UNDEAD_VS_TEST);
  const sk = put(s, 's1u1', 3, 18, 5);
  const va = put(s, 's1u2', 5, 18, 6);
  sk.hp = 10; va.hp = 24;
  put(s, 's2u1', 20, 3, 12);
  turnOf(s, 's2u1');
  E.endTurn(s);
  assert.equal(s.round, 2);
  assert.equal(sk.hp, 12);
  assert.equal(va.hp, 25);
});

// ---------- Присылка 6: радиус способностей, Сильваны, Демоны, Бастион ----------

test('радиус способности: только 8 линий, полная стена мешает, полустена нет', () => {
  const s = bareBattle();
  const cells = E.radiusCells(s, [3, 18], 2, false).map(([c, r]) => c + ',' + r);
  assert.ok(cells.includes('5,16') && cells.includes('3,16') && cells.includes('1,20'));
  assert.ok(!cells.includes('4,16'), 'клетка вне линий не входит');
  // Стена между I9 (8,8) и J9 (9,8)
  assert.ok(!E.radiusCells(s, [8, 8], 1, false).some(([c, r]) => c === 9 && r === 8));
  assert.ok(E.radiusCells(s, [8, 8], 1, true).some(([c, r]) => c === 9 && r === 8), 'игнорируя препятствия — можно');
  // Полустена между (12,6) и (12,7) не мешает
  assert.ok(E.radiusCells(s, [12, 6], 1, false).some(([c, r]) => c === 12 && r === 7));
});

test('Сильваны не получают отпор; Рейнджер без штрафов', () => {
  const s = bareBattle([{ seat: 1, faction: 2 }, { seat: 2, faction: 9 }]);
  const ent = put(s, 's1u5', 3, 18, 5);
  put(s, 's2u1', 4, 18, 9);
  turnOf(s, 's1u5');
  dice(s, [[6, 3]]); // только атака, проверки отпора нет
  const r = E.attack(s, 's2u1');
  assert.ok(r.ok);
  assert.equal(ent.hp, 33);

  const s2 = bareBattle([{ seat: 1, faction: 2 }, { seat: 2, faction: 9 }]);
  put(s2, 's1u1', 3, 18, 5);
  put(s2, 's2u2', 5, 18, 6);   // юнит на линии
  put(s2, 's2u1', 8, 18, 9);
  turnOf(s2, 's1u1');
  assert.equal(E.turnTargets(s2).find((t) => t.id === 's2u1').penalty, 0);
});

test('Фея ослепляет до конца хода цели; Энт опутывает', () => {
  const s = bareBattle([{ seat: 1, faction: 2 }, { seat: 2, faction: 9 }]);
  const fairy = put(s, 's1u2', 3, 18, 5);
  const t = put(s, 's2u1', 6, 15, 9);   // по диагонали на 3
  put(s, 's1u1', 20, 3, 12);
  turnOf(s, 's1u2');
  assert.ok(E.abilityTargets(s).includes('s2u1'));
  E.useAbility(s, 's2u1');
  assert.ok(t.blinded);
  E.endTurn(s);
  assert.equal(s.turn.entity, 's2u1');
  assert.ok(!E.canAttack(s) && !E.canShift(s));
  E.endTurn(s);
  assert.ok(!t.blinded, 'метка снята в конце хода цели');
  assert.equal(fairy.abilityState, 'spent');

  const s2 = bareBattle([{ seat: 1, faction: 2 }, { seat: 2, faction: 9 }]);
  put(s2, 's1u5', 3, 18, 5);
  const t2 = put(s2, 's2u1', 3, 15, 9);
  turnOf(s2, 's1u5');
  E.useAbility(s2, 's2u1');
  assert.equal(t2.hp, 8);
  assert.ok(t2.rooted);
  E.endTurn(s2);
  assert.ok(!E.canMove(s2), 'опутанный не двигается');
});

test('Одержимый: +1 чистого; Ифрит: 5 чистого всем вокруг', () => {
  const s = bareBattle([{ seat: 1, faction: 3 }, { seat: 2, faction: 9 }]);
  put(s, 's1u2', 3, 18, 5);
  const d = put(s, 's2u1', 4, 18, 9);
  turnOf(s, 's1u2');
  dice(s, [[6, 2], [6, 1]]);
  E.attack(s, 's2u1');
  assert.equal(d.hp, 10 - (2 + 2 - 1) - 1);

  const s2 = bareBattle([{ seat: 1, faction: 3 }, { seat: 2, faction: 9 }]);
  put(s2, 's1u3', 3, 18, 5);
  const ally = put(s2, 's1u2', 4, 17, 6);
  const foe = put(s2, 's2u1', 2, 18, 9);
  const far = put(s2, 's2u2', 6, 18, 10);
  turnOf(s2, 's1u3');
  E.useAbility(s2, 'self');
  assert.equal(ally.hp, 22 - 5);
  assert.equal(foe.hp, 10 - 5);
  assert.equal(far.hp, 10);
});

test('Адская охота: атака союзника по цели — максимальный урон, метка снимается', () => {
  const s = bareBattle([{ seat: 1, faction: 3 }, { seat: 2, faction: 9 }]);
  const hound = put(s, 's1u4', 3, 14, 5);
  put(s, 's1u2', 2, 18, 6);
  const t = put(s, 's2u1', 3, 18, 9);
  turnOf(s, 's1u4');
  E.useAbility(s, 's2u1');
  assert.ok(t.hunted);
  E.endTurn(s);
  assert.equal(s.turn.entity, 's1u2');
  dice(s, [[6, 1]]); // проверка отпора; атака без броска
  E.attack(s, 's2u1');
  assert.equal(t.hp, 10 - (6 + 2 - 1) - 1);
  assert.ok(!t.hunted);
  assert.equal(hound.abilityState, 'spent');
});

test('Адские врата и Перерождение ставят юнита на ближайшую свободную клетку', () => {
  const s = bareBattle([{ seat: 1, faction: 3 }, { seat: 2, faction: 9 }]);
  put(s, 's1u5', 10, 10, 5);
  const imp = put(s, 's1u1', 20, 3, 6);
  put(s, 's2u1', 0, 0, 9);
  turnOf(s, 's1u5');
  E.useAbility(s, 's1u1');
  if (s.pending) E.choosePlace(s, ...s.pending.options[0]);
  assert.equal(Math.abs(imp.pos[0] - 10) + Math.abs(imp.pos[1] - 10), 1);

  const s2 = bareBattle([{ seat: 1, faction: 1 }, { seat: 2, faction: 9 }]);
  put(s2, 's1u5', 10, 10, 5);
  const dead = E.entity(s2, 's1u1');
  dead.alive = false; dead.hp = 0;
  put(s2, 's2u1', 0, 0, 9);
  turnOf(s2, 's1u5');
  assert.deepEqual(E.abilityTargets(s2), ['s1u1']);
  E.useAbility(s2, 's1u1');
  if (s2.pending) E.choosePlace(s2, ...s2.pending.options[0]);
  if (s2.pendingInit) E.chooseInitiative(s2, s2.pendingInit.options[0]);
  assert.ok(dead.alive && dead.hp === 3 && dead.slot);
  assert.equal(s2.turn.entity, 's1u5', 'ход Паладина продолжается');
});

test('Бастион: +10 монет в конце круга; Рыцарь не получает урон от дальних атак; Лучник и Жрец', () => {
  const s = bareBattle([{ seat: 1, faction: 1 }, { seat: 2, faction: 4 }]);
  const knight = put(s, 's1u1', 3, 18, 5);
  put(s, 's2u4', 3, 15, 9);  // Скарабей стреляет
  turnOf(s, 's2u4');
  dice(s, [[6, 6]]);
  E.attack(s, 's1u1');
  assert.equal(knight.hp, 21);
  const coins = E.seatOf(s, 1).coins;
  E.endTurn(s);
  assert.equal(s.round, 2);
  assert.equal(E.seatOf(s, 1).coins, coins + 10);

  const s2 = bareBattle([{ seat: 1, faction: 1 }, { seat: 2, faction: 9 }]);
  put(s2, 's1u2', 3, 18, 5);
  const a = put(s2, 's2u1', 7, 14, 9);
  const b = put(s2, 's2u2', 8, 14, 10);
  const c = put(s2, 's2u3', 9, 14, 11);
  turnOf(s2, 's1u2');
  E.useAbility(s2, 's2u1');
  assert.deepEqual([a.hp, b.hp, c.hp], [7, 7, 10]);

  const s3 = bareBattle([{ seat: 1, faction: 1 }, { seat: 2, faction: 9 }]);
  put(s3, 's1u3', 3, 18, 5);
  const hurt = put(s3, 's1u4', 20, 3, 6);
  hurt.hp = 10;
  put(s3, 's2u1', 0, 0, 9);
  turnOf(s3, 's1u3');
  E.useAbility(s3, 's1u4');
  assert.equal(hurt.hp, 13);
});

test('Кавалерист: 5 клеток по прямой и атака — максимальный урон', () => {
  const s = bareBattle([{ seat: 1, faction: 1 }, { seat: 2, faction: 9 }]);
  put(s, 's1u4', 3, 18, 5);
  const t = put(s, 's2u1', 9, 18, 9);
  turnOf(s, 's1u4');
  E.move(s, 8, 18);
  dice(s, [[6, 1]]);  // только проверка отпора
  E.attack(s, 's2u1');
  assert.equal(t.hp, 10 - (6 + 3 - 1));
});

test('Демоны: обмен на колесе в конце круга; Бес — Душевные муки; Огненная ловушка', () => {
  const s = bareBattle([{ seat: 1, faction: 3 }, { seat: 2, faction: 9 }]);
  const imp = put(s, 's1u1', 3, 18, 5);
  const pos = put(s, 's1u2', 5, 18, 6);
  const foe = put(s, 's2u1', 20, 3, 12);
  turnOf(s, 's1u1');
  assert.ok(E.tormentTargets(s).includes('s2u1'));
  E.torment(s, 's2u1');
  assert.equal(foe.hp, 9);
  assert.equal(s.turn.entity, 's1u2', 'ход Беса закончился');
  E.endTurn(s); E.endTurn(s);  // Одержимый, враг → конец круга
  assert.equal(s.pending && s.pending.type, 'swap');
  E.swapOnWheel(s, 's1u1', 's1u2');
  assert.deepEqual([imp.slot, pos.slot], [6, 5]);
  assert.equal(s.turn.entity, 's1u2');

  const s2 = bareBattle([{ seat: 1, faction: 3 }, { seat: 2, faction: 9 }]);
  const djinn = E.entity(s2, 's1h');
  djinn.slot = 3; s2.wheel[3] = 's1h';
  const victim = put(s2, 's2u1', 3, 18, 9);
  put(s2, 's1u1', 20, 3, 12);
  turnOf(s2, 's1h');
  E.useAbility(s2, [5, 18]);
  assert.deepEqual(s2.fireTrap.cell, [5, 18]);
  E.endTurn(s2);
  assert.equal(s2.turn.entity, 's2u1');
  victim.hp = 15; victim.maxHp = 15;
  E.move(s2, 5, 18);
  assert.equal(victim.hp, 5);
  assert.equal(s2.fireTrap, null);
  assert.equal(djinn.abilityState, 'spent');
});
