// Запуск: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/engine.js');
const MAP = require('../src/map.js');

function battleWith(positions, settings) {
  const s = E.createGame(MAP, { players: [1, 2], settings });
  for (const u of s.units) u.pos = positions[u.id] || [27 - s.units.indexOf(u), 10];
  s.phase = 'battle';
  return s;
}

test('карта распознаётся: 28×22, по 9 клеток в каждой зоне', () => {
  const m = E.parseMap(MAP);
  assert.equal(m.cols, 28);
  assert.equal(m.rows, 22);
  for (const z of [1, 2, 3, 4]) assert.equal(m.zones[z].length, 9);
});

test('расставлять можно только в своей зоне и не друг на друга', () => {
  const s = E.createGame(MAP, { players: [1, 2] });
  assert.ok(E.place(s, 'p1u1', 0, 21));
  assert.ok(!E.place(s, 'p1u2', 0, 21), 'клетка занята');
  assert.ok(!E.place(s, 'p1u2', 27, 21), 'чужая зона');
  assert.ok(!E.place(s, 'p1u2', 5, 10), 'вне зоны');
  E.autoPlace(s, 1);
  E.autoPlace(s, 2);
  assert.ok(E.setupComplete(s));
  assert.ok(E.startBattle(s));
});

test('дальность ограничена очками хода, ходы только ортогональные', () => {
  const s = battleWith({ p1u5: [3, 18] }); // Тяжёлый, ход 3
  const reach = E.computeReach(s, 'p1u5');
  for (const [, v] of reach.cells) {
    assert.ok(v.steps <= 3);
    for (let i = 1; i < v.path.length; i++) {
      const [a, b] = [v.path[i - 1], v.path[i]];
      assert.equal(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]), 1);
    }
  }
  // Открытое поле: ромб радиуса 3 = 24 клетки (без стартовой).
  assert.equal(reach.cells.size, 24);
});

test('стена не пропускает, путь обходит её', () => {
  // Между I9 (8,8) и J9 (9,8) стена; обход длиннее, чем 4 очка хода Бойца.
  const s = battleWith({ p1u2: [8, 8] }); // Боец, ход 4
  const reach = E.computeReach(s, 'p1u2');
  assert.ok(!reach.cells.has(E.key(9, 8)), 'через стену нельзя, а обход длиннее 4');
  assert.equal(reach.cells.get(E.key(8, 9)).steps, 1, 'вдоль стены — можно');
});

test('синие проёмы закрываются настройкой', () => {
  // Проём между (12,6) и (12,7).
  const open = battleWith({ p1u1: [12, 6] });
  assert.equal(E.computeReach(open, 'p1u1').cells.get(E.key(12, 7)).steps, 1);
  const closed = battleWith({ p1u1: [12, 6] }, { doorsPassable: false });
  const t = E.computeReach(closed, 'p1u1').cells.get(E.key(12, 7));
  assert.ok(!t || t.steps > 1);
});

test('ход списывает очки, отмена возвращает', () => {
  const s = battleWith({ p1u1: [3, 18] });
  const r = E.moveUnit(s, 'p1u1', 3, 14);
  assert.ok(r.ok);
  assert.equal(E.unitById(s, 'p1u1').mpLeft, 2);
  assert.ok(!E.moveUnit(s, 'p1u1', 3, 10).ok, 'не хватает очков');
  E.undo(s);
  assert.deepEqual(E.unitById(s, 'p1u1').pos, [3, 18]);
  assert.equal(E.unitById(s, 'p1u1').mpLeft, 6);
});

test('чужими юнитами ходить нельзя, конец хода передаёт очередь', () => {
  const s = battleWith({});
  assert.ok(!E.moveUnit(s, 'p2u1', 0, 0).ok);
  E.endTurn(s);
  assert.equal(s.current, 2);
  E.endTurn(s);
  assert.equal(s.current, 1);
  assert.equal(s.round, 2);
});
