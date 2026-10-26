// Игровая логика «НЕ ГЕРОИ». Чистые функции без DOM — этот же модуль
// потом будет работать на сервере для проверки ходов.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NHEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Временный состав фракции: 5 юнитов с разной дальностью хода.
  const UNIT_TYPES = [
    { type: 'scout',   name: 'Разведчик', short: 'Р', move: 6 },
    { type: 'fighter', name: 'Боец',      short: 'Б', move: 4 },
    { type: 'shooter', name: 'Стрелок',   short: 'С', move: 4 },
    { type: 'medic',   name: 'Медик',     short: 'М', move: 5 },
    { type: 'heavy',   name: 'Тяжёлый',   short: 'Т', move: 3 },
  ];

  const PLAYER_IDS = [1, 2, 3, 4];

  // Порядок направлений: вверх, вправо, вниз, влево.
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  const key = (c, r) => c + ',' + r;
  const unkey = (k) => k.split(',').map(Number);

  // ---------- Карта ----------

  function parseMap(def) {
    const lines = def.ascii;
    const rows = (lines.length - 1) / 2;
    const cols = (lines[0].length - 1) / 2;
    if (!Number.isInteger(rows) || !Number.isInteger(cols)) throw new Error('Неверный размер ASCII-карты');

    const cells = [];   // cells[r][c] = { kind: 'floor'|'object'|'block', zone: 0..4 }
    const vEdge = [];   // vEdge[r][k] — ребро слева от клетки k (k = 0..cols)
    const hEdge = [];   // hEdge[k][c] — ребро над клеткой в ряду k (k = 0..rows)
    const zones = { 1: [], 2: [], 3: [], 4: [] };
    const objects = [];

    const edgeOf = (ch, wallCh, doorCh) => (ch === wallCh ? 'wall' : ch === doorCh ? 'door' : null);

    for (let r = 0; r < rows; r++) {
      cells.push([]);
      vEdge.push([]);
      const line = lines[2 * r + 1];
      for (let k = 0; k <= cols; k++) {
        // Внешняя рамка карты всегда стена.
        vEdge[r].push(k === 0 || k === cols ? 'wall' : edgeOf(line[2 * k], '|', ':'));
      }
      for (let c = 0; c < cols; c++) {
        const ch = line[2 * c + 1];
        const cell = { kind: 'floor', zone: 0 };
        if (ch === 'x') { cell.kind = 'object'; objects.push([c, r]); }
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
    return { name: def.name, cols, rows, cells, vEdge, hEdge, zones, objects };
  }

  // Ребро между соседними клетками (c,r) и (c+dc, r+dr).
  function edgeBetween(map, c, r, dc, dr) {
    if (dc === 1) return map.vEdge[r][c + 1];
    if (dc === -1) return map.vEdge[r][c];
    if (dr === 1) return map.hEdge[r + 1][c];
    return map.hEdge[r][c];
  }

  function inBounds(map, c, r) {
    return c >= 0 && r >= 0 && c < map.cols && r < map.rows;
  }

  // ---------- Состояние партии ----------

  function createGame(mapDef, opts) {
    opts = opts || {};
    const map = parseMap(mapDef);
    const activePlayers = opts.players || [1, 2];
    const units = [];
    for (const p of PLAYER_IDS) {
      if (!activePlayers.includes(p)) continue;
      UNIT_TYPES.forEach((t, i) => {
        units.push({
          id: 'p' + p + 'u' + (i + 1),
          owner: p,
          type: t.type,
          name: t.name,
          short: t.short,
          move: t.move,
          mpLeft: t.move,
          pos: null,
        });
      });
    }
    return {
      map,
      players: activePlayers.slice().sort((a, b) => a - b),
      units,
      phase: 'setup',            // 'setup' → 'battle'
      current: activePlayers.slice().sort((a, b) => a - b)[0],
      round: 1,
      settings: Object.assign({
        doorsPassable: true,     // синие проёмы проходимы
        objectsPassable: false,  // клетки с крестиком проходимы
        passThroughAllies: true, // можно проходить сквозь своих (но не вставать на них)
      }, opts.settings || {}),
      history: [],               // ходы текущего игрока — для отмены
      log: [],
    };
  }

  function unitById(state, id) {
    return state.units.find((u) => u.id === id) || null;
  }

  function unitAt(state, c, r) {
    return state.units.find((u) => u.pos && u.pos[0] === c && u.pos[1] === r) || null;
  }

  function cellWalkable(state, c, r) {
    const cell = state.map.cells[r][c];
    if (cell.kind === 'block') return false;
    if (cell.kind === 'object' && !state.settings.objectsPassable) return false;
    return true;
  }

  function stepAllowed(state, c, r, dc, dr) {
    const nc = c + dc, nr = r + dr;
    if (!inBounds(state.map, nc, nr)) return false;
    const edge = edgeBetween(state.map, c, r, dc, dr);
    if (edge === 'wall') return false;
    if (edge === 'door' && !state.settings.doorsPassable) return false;
    return cellWalkable(state, nc, nr);
  }

  // ---------- Расстановка ----------

  function canPlace(state, unitId, c, r) {
    if (state.phase !== 'setup') return false;
    const u = unitById(state, unitId);
    if (!u || !inBounds(state.map, c, r)) return false;
    if (state.map.cells[r][c].zone !== u.owner) return false;
    if (!cellWalkable(state, c, r)) return false;
    const other = unitAt(state, c, r);
    return !other || other.id === unitId;
  }

  function place(state, unitId, c, r) {
    if (!canPlace(state, unitId, c, r)) return false;
    unitById(state, unitId).pos = [c, r];
    return true;
  }

  function unplace(state, unitId) {
    if (state.phase !== 'setup') return false;
    const u = unitById(state, unitId);
    if (!u) return false;
    u.pos = null;
    return true;
  }

  function autoPlace(state, owner) {
    const free = state.map.zones[owner].filter(([c, r]) => !unitAt(state, c, r) && cellWalkable(state, c, r));
    for (const u of state.units) {
      if (u.owner !== owner || u.pos) continue;
      const i = Math.floor(Math.random() * free.length);
      const cell = free.splice(i, 1)[0];
      if (!cell) break;
      u.pos = cell;
    }
  }

  function setupComplete(state) {
    return state.units.every((u) => u.pos);
  }

  function startBattle(state) {
    if (state.phase !== 'setup' || !setupComplete(state)) return false;
    state.phase = 'battle';
    state.current = state.players[0];
    state.round = 1;
    state.history = [];
    for (const u of state.units) u.mpLeft = u.move;
    state.log.push({ round: 1, text: 'Расстановка завершена. Раунд 1.' });
    return true;
  }

  // ---------- Перемещение ----------

  // Все клетки, куда юнит может дойти в пределах оставшихся очков хода.
  // Дейкстра по (клетка, направление): сначала минимум шагов, затем
  // минимум поворотов — так путь получается прямым, а не «лесенкой».
  // budget — сколько шагов считать; по умолчанию оставшиеся очки хода.
  function computeReach(state, unitId, budget) {
    const u = unitById(state, unitId);
    const result = { origin: u && u.pos, cells: new Map() };
    if (!u || !u.pos) return result;
    if (budget == null) budget = state.phase === 'battle' ? u.mpLeft : u.move;

    const best = new Map(); // "c,r,d" → { steps, turns, prev }
    const sk = (c, r, d) => c + ',' + r + ',' + d;
    const queue = [];
    const push = (item) => {
      queue.push(item);
      queue.sort((a, b) => a.steps - b.steps || a.turns - b.turns);
    };
    const [oc, or] = u.pos;
    best.set(sk(oc, or, -1), { steps: 0, turns: 0, prev: null });
    push({ c: oc, r: or, d: -1, steps: 0, turns: 0 });

    while (queue.length) {
      const cur = queue.shift();
      const curRec = best.get(sk(cur.c, cur.r, cur.d));
      if (curRec.steps !== cur.steps || curRec.turns !== cur.turns) continue;
      if (cur.steps >= budget) continue;
      for (let d = 0; d < 4; d++) {
        const [dc, dr] = DIRS[d];
        if (!stepAllowed(state, cur.c, cur.r, dc, dr)) continue;
        const nc = cur.c + dc, nr = cur.r + dr;
        const occupant = unitAt(state, nc, nr);
        if (occupant && occupant.id !== u.id) {
          const ally = occupant.owner === u.owner;
          if (!ally || !state.settings.passThroughAllies) continue;
        }
        const steps = cur.steps + 1;
        const turns = cur.turns + (cur.d !== -1 && cur.d !== d ? 1 : 0);
        const k2 = sk(nc, nr, d);
        const prev = best.get(k2);
        if (prev && (prev.steps < steps || (prev.steps === steps && prev.turns <= turns))) continue;
        best.set(k2, { steps, turns, prev: sk(cur.c, cur.r, cur.d) });
        push({ c: nc, r: nr, d, steps, turns });
      }
    }

    // Лучшая запись для каждой клетки; занятые клетки — только транзит.
    const perCell = new Map();
    for (const [k, rec] of best) {
      const [c, r] = k.split(',').map(Number);
      if (c === oc && r === or) continue;
      if (unitAt(state, c, r)) continue;
      const ck = key(c, r);
      const cur = perCell.get(ck);
      if (!cur || rec.steps < cur.rec.steps || (rec.steps === cur.rec.steps && rec.turns < cur.rec.turns)) {
        perCell.set(ck, { k, rec });
      }
    }
    for (const [ck, { k, rec }] of perCell) {
      const path = [];
      let at = k;
      while (at) {
        const [c, r] = at.split(',').map(Number);
        path.unshift([c, r]);
        at = best.get(at).prev;
      }
      result.cells.set(ck, { steps: rec.steps, path });
    }
    return result;
  }

  function moveUnit(state, unitId, c, r) {
    if (state.phase !== 'battle') return { ok: false, error: 'Сначала завершите расстановку' };
    const u = unitById(state, unitId);
    if (!u) return { ok: false, error: 'Нет такого юнита' };
    if (u.owner !== state.current) return { ok: false, error: 'Сейчас ход другого игрока' };
    const reach = computeReach(state, unitId);
    const target = reach.cells.get(key(c, r));
    if (!target) return { ok: false, error: 'Клетка недостижима' };
    state.history.push({ unitId, from: u.pos, mpBefore: u.mpLeft });
    u.pos = [c, r];
    u.mpLeft -= target.steps;
    state.log.push({ round: state.round, player: u.owner, text: u.name + ': ' + target.steps + ' кл. → ' + cellName(c, r) });
    return { ok: true, path: target.path, steps: target.steps };
  }

  function undo(state) {
    const h = state.history.pop();
    if (!h) return false;
    const u = unitById(state, h.unitId);
    u.pos = h.from;
    u.mpLeft = h.mpBefore;
    state.log.push({ round: state.round, player: u.owner, text: u.name + ': ход отменён' });
    return true;
  }

  function endTurn(state) {
    if (state.phase !== 'battle') return false;
    const i = state.players.indexOf(state.current);
    const next = state.players[(i + 1) % state.players.length];
    if (i === state.players.length - 1) state.round++;
    state.current = next;
    state.history = [];
    for (const u of state.units) if (u.owner === next) u.mpLeft = u.move;
    state.log.push({ round: state.round, text: 'Ход игрока ' + next });
    return true;
  }

  // Координаты как на шахматной доске: столбцы A..Z, AA, AB; ряды 1..N сверху.
  function cellName(c, r) {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const col = c < 26 ? letters[c] : letters[Math.floor(c / 26) - 1] + letters[c % 26];
    return col + (r + 1);
  }

  return {
    UNIT_TYPES, PLAYER_IDS, key, unkey, parseMap, edgeBetween, createGame,
    unitById, unitAt, cellWalkable, canPlace, place, unplace, autoPlace,
    setupComplete, startBattle, computeReach, moveUnit, undo, endTurn, cellName,
  };
});
