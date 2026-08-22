'use strict';
const LIFTS = require('./lifts');

const START = '07:00';
const END = '18:00';
const LIFT_IDS = LIFTS.map(l => l.id);
// "planned" (suplanuota) — numatytoji būsena. Kalendoriuje (klientinėje
// pusėje) tokia užduotis pati vizualiai laikoma "vykdoma", kai ateina jos
// pradžios laikas — tai skaičiuojama, ne saugoma atskira reikšme.
// "done" (baigta) — darbas užbaigtas; kortelė pilkėja, nebeilgėja.
const STATUSES = ['planned', 'done'];

// Grąžina masyvą klaidų pranešimų (lietuviškai); tuščias masyvas = viskas gerai.
function validateEvent(data) {
  const errors = [];

  if (!LIFT_IDS.includes(data.lift)) errors.push('Neteisingas keltuvas.');
  if (!data.dateFrom) errors.push('Trūksta datos „nuo".');
  if (data.status !== undefined && data.status !== null && !STATUSES.includes(data.status)) {
    errors.push('Neteisinga būsena.');
  }

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
