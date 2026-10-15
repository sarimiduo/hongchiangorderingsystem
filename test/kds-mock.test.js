'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const kds = require('../server/kds-mock');

test('setTables merges by name: id/status preserved, colliding new ids renumbered', () => {
  const t1 = kds.state.tables.find(t => t.name === '1');
  kds.createOrder({
    type: 'dinein', table_id: t1.id, guest_count: 2, customer: {},
    meals: [{ meal_id: 1, meal_name: 'x', quantity: 1, price: 1000 }],
  });
  assert.equal(t1.status, 'DINING');
  kds.setTables([
    { id: 99, name: '1', seats: 2 },      // existing: keeps its id and status
    { id: t1.id, name: '40', seats: 4 },  // new, id collides with a kept one
  ]);
  assert.deepEqual(kds.state.tables.map(t => t.name), ['1', '40']);
  const one = kds.state.tables.find(t => t.name === '1');
  assert.equal(one.id, t1.id);
  assert.equal(one.status, 'DINING');
  const forty = kds.state.tables.find(t => t.name === '40');
  assert.notEqual(forty.id, t1.id);
  assert.equal(forty.seats, 4);
});

test('setTables keeps a DINING table that ESB no longer lists, drops idle ones', () => {
  kds.setTables([{ id: 50, name: '41', seats: 2 }]);
  assert.deepEqual(kds.state.tables.map(t => t.name), ['1', '41']);
  assert.equal(kds.state.tables.find(t => t.name === '1').status, 'DINING');
});
