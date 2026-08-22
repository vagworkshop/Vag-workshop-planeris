'use strict';
// Visos prisijungimo paskyros — ir darbuotojai (mato tik savo keltuvą/us),
// ir "pilnos prieigos" paskyros (savininkas, priėmėjas — mato ir tvarko
// visus keltuvus). "lifts: null" reiškia "visi keltuvai".

const EMPLOYEES = require('./employees');
const LIFTS = require('./lifts');

const ACCOUNTS = [
  ...EMPLOYEES.map(emp => ({
    id: emp.id,
    label: emp.label,
    role: 'employee',
    lifts: LIFTS.filter(l => l.empId === emp.id).map(l => l.id),
  })),
  { id: 'simonas', label: 'Simonas', role: 'owner', lifts: null },
  { id: 'priemimas', label: 'Priėmimas', role: 'reception', lifts: null },
];

module.exports = ACCOUNTS;
