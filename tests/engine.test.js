// Запуск: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/engine.js');
const MAP = require('../src/map.js');

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

function newGame(seats, seed) {
  return E.createGame(MAP, { seats: seats || [{ seat: 1, faction: 1 }, { seat: 2, faction: 3 }], rng: seeded(seed || 1) });
}

// Партия сразу в бою: все юниты убраны с поля, колесо пустое.
function bareBattle() {
  const s = newGame();
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
  s.turn = null;
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

test('очерёдность: ничья по к6 перебрасывается, дальше по часовой', () => {
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
  s.tokens[E.key(13, 10)].content = 'gold';
  const res = E.move(s, 13, 10);
  assert.ok(res.ok);
  assert.ok(!s.tokens[E.key(13, 10)]);
  assert.equal(E.seatOf(s, 1).coins, E.TOKEN_GOLD);
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
