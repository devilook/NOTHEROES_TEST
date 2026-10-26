// Данные фракций. Источник — ширмы фракций (docs/factions/*.md).
// Нечисть — настоящие карты; остальные пока тестовые (присылка 4).
//
// Поля юнита: hp, atk, atkType 'melee'|'ranged', range, armor,
// counter '+'|'='|'x', speed, flying, init, ability { id, name, text, kind }.
// id способности связывает текст с кодом в engine.js.
(function (root) {
  'use strict';

  function testUnit(n) {
    return {
      num: n, name: String(n), hp: 10, atk: 1, atkType: 'melee', range: 1, armor: 1,
      counter: '=', speed: 5, flying: false, init: 3, ability: null,
    };
  }

  function testFaction(id, key, name, colorName) {
    return {
      id, key, name, colorName, test: true,
      ability: null,
      hero: { name: 'Герой', coins: 20, init: 3, ability: null },
      units: [1, 2, 3, 4, 5].map(testUnit),
    };
  }

  const FACTIONS = {
    1: testFaction(1, 'bastion', 'Бастион', 'жёлтые'),
    2: testFaction(2, 'sylvans', 'Сильваны', 'зелёные'),
    3: testFaction(3, 'demons', 'Демоны', 'красные'),
    4: {
      id: 4, key: 'undead', name: 'Нечисть', colorName: 'синие', test: false,
      ability: { id: 'regen2', name: 'Способность фракции', text: 'В конце круга инициативы каждый ваш юнит получает +2 здоровья.' },
      hero: {
        name: 'Нетре’зад', coins: 20, init: 3,
        ability: { id: 'collector50', kind: 'passive', name: 'Собиратель останков', text: 'Если ваш юнит умирает, ваш герой получает 50 монет.' },
      },
      units: [
        { num: 1, name: 'Скелет', hp: 24, atk: 0, atkType: 'melee', range: 1, armor: 1, counter: '=', speed: 5, flying: false, init: 4,
          ability: { id: 'pureImmune', kind: 'passive', name: 'Мёртвая оболочка', text: 'Скелет не получает чистый урон.' } },
        { num: 2, name: 'Вампир', hp: 25, atk: 2, atkType: 'melee', range: 1, armor: 0, counter: '+', speed: 5, flying: true, init: 1,
          ability: { id: 'lifesteal1', kind: 'passive', name: 'Кровопийца', text: 'Если Вампир атакует или даёт отпор, он получает +1 здоровья.' } },
        { num: 3, name: 'Призрак', hp: 20, atk: 1, atkType: 'melee', range: 1, armor: 0, counter: 'x', speed: 4, flying: true, init: 2,
          ability: { id: 'incorporeal', kind: 'passive', name: 'Бестелесность', text: 'Если Призрака атакуют или дают отпор и на кости атаки выпадает 1, 3 или 5, Призрак не получает урона. Призрак не считается преградой для дальних атак и передвижения юнитов.' } },
        { num: 4, name: 'Скарабей', hp: 25, atk: 1, atkType: 'ranged', range: 4, armor: 2, counter: 'x', speed: 4, flying: false, init: 2,
          ability: { id: 'spikes2', kind: 'passive', name: 'Острый панцирь', text: 'Если Скарабея атакуют или дают отпор ближней атакой, атакующий получает 2 чистого урона.' } },
        { num: 5, name: 'Мясной голем', hp: 50, atk: 2, atkType: 'melee', range: 1, armor: 0, counter: 'x', speed: 3, flying: false, init: 3,
          ability: { id: 'swallow', kind: 'active', range: 1, name: 'Проглатывание', text: 'Выберите любого юнита. Цель получает 3 чистого урона, исчезает с карты и круга инициативы. На голема ложится метка способности. В конце своего следующего хода голем возвращает цель на ближайшую выбранную свободную клетку, и она определяет инициативу. После этого способность заканчивается.' } },
      ],
    },
  };

  if (typeof module === 'object' && module.exports) module.exports = FACTIONS;
  else root.NHFactions = FACTIONS;
})(typeof self !== 'undefined' ? self : this);
