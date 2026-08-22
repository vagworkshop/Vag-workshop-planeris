'use strict';
const LIFTS = require('./lifts');

// Kalendorius realiai prasideda nuo 07:00, bet tinklelis (ir leidžiamas
// laiko intervalas) prasideda nuo 05:00 — pirmos 2 valandos (05:00–07:00)
// naudojamos kaip "Laukiantys" darbų juosta (žr. index.html START_H).
// Ten sukurti darbai yra tokie patys įrašai, tik jiems automatiškai
// netaikomas vykdomo darbo statusas nei laiko juostelės ilgėjimas
// (klientinėje pusėje, žr. isWaitingTask()).
const START = '05:00';
const END = '18:00';
const LIFT_IDS = LIFTS.map(l => l.id);
// "planned" (suplanuota) — numatytoji būsena. Kalendoriuje (klientinėje
// pusėje) tokia užduotis pati vizualiai laikoma "vykdoma", kai ateina jos
// pradžios laikas — tai skaičiuojama, ne saugoma atskira reikšme.
// "done" (baigta) — darbas užbaigtas; kortelė pilkėja, nebeilgėja.
// "needs_entry" (baigta, reikia suvedimo) — darbas nebeilgėja, bet kortelė
// paraudonuoja (ne pilkėja), kol automobilis nuvežamas suvedimui.
// "needs_wash" (baigta, reikia variklio plovimo) — analogiškai paraudonuoja.
// Visos trys ne-"planned" būsenos vienodai stabdo automatinį vykdomo darbo
// statusą ir laiko juostelės ilgėjimą (žr. index.html isEffectivelyActive()).
const STATUSES = ['planned', 'done', 'needs_entry', 'needs_wash'];

// Grąžina masyvą klaidų pranešimų (lietuviškai); tuščias masyvas = viskas gerai.
function validateEvent(data) {
  const errors = [];

  if (data.status !== undefined && data.status !== null && !STATUSES.includes(data.status)) {
    errors.push('Neteisinga būsena.');
  }

  if (!LIFT_IDS.includes(data.lift)) errors.push('Neteisingas keltuvas.');
  if (!data.dateFrom) errors.push('Trūksta datos „nuo".');

  const dateTo = data.dateTo || data.dateFrom;
  if (data.dateFrom && dateTo < data.dateFrom) {
    errors.push('Data „iki" negali būti ankstesnė nei data „nuo".');
  }

  if (!data.start || !data.end) {
    errors.push('Trūksta laiko.');
  } else {
    if (data.end <= data.start) errors.push('Pabaiga turi būti vėlesnė už pradžią.');
    if (data.start < START) errors.push('Pradžia negali būti anksčiau nei ' + START + '.');
    if (data.end > END) errors.push('Pabaiga negali būti vėlesnė nei ' + END + '.');
  }

  return errors;
}

module.exports = { validateEvent, STATUSES };
