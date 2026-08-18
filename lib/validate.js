'use strict';
const EMPLOYEES = require('./employees');

const START = '07:00';
const END = '18:00';
const EMP_IDS = EMPLOYEES.map(e => e.id);

// Grąžina masyvą klaidų pranešimų (lietuviškai); tuščias masyvas = viskas gerai.
function validateEvent(data) {
  const errors = [];

  if (!EMP_IDS.includes(data.emp)) errors.push('Neteisingas darbuotojas.');
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

module.exports = { validateEvent };
