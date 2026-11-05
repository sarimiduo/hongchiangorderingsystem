'use strict';
/* quehong queue core - table assignment rules, no-show kanban, re-insert,
 * scan flow, ESB occupancy handoff, WA binding, mirror revocation. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { QueStore, normalizeWa } = require('../que/store');

const INV = [
  { id: 'K1', capacity: 1, zone: 'counter' },
  { id: 'A', capacity: 2 }, { id: 'B', capacity: 2 },
  { id: 'C', capacity: 4 }, { id: 'D', capacity: 4 },
];

function mkStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'que-'));
  const clock = { t: Date.now() };
  const store = new QueStore({
    file: path.join(dir, 'state.json'), tables: INV,
    now: () => clock.t, ...opts,
  });
  return { store, clock };
}

test('assignment: 2 pax prefers the 2-seater, 3 pax takes a 4-seater', () => {
  const { store } = mkStore();
  const t2 = store.register({ name: 'Dua', pax: 2 });
  const t3 = store.register({ name: 'Tiga', pax: 3 });
  store.tick();
  assert.strictEqual(store.ticket(t2.token).state, 'called');
  assert.strictEqual(store.tableById(store.ticket(t2.token).table_ids[0]).capacity, 2);
  assert.strictEqual(store.tableById(store.ticket(t3.token).table_ids[0]).capacity, 4);
});

test('assignment: 2 pax upsizes to a 4-seater only above the reserve', () => {
  const { store } = mkStore({ upsizeReserve: 1 });
  // both 2-seaters manually busy, both 4-seaters free -> upsize allowed
  store.admin('table-busy', 'A'); store.admin('table-busy', 'B');
  const a = store.register({ pax: 2 });
  store.tick();
  assert.strictEqual(store.ticket(a.token).state, 'called');
  assert.strictEqual(store.tableById(store.ticket(a.token).table_ids[0]).capacity, 4);
  // only ONE 4-seater left (<= reserve) -> the next 2-pax party waits
  const b = store.register({ pax: 2 });
  store.tick();
  assert.strictEqual(store.ticket(b.token).state, 'waiting');
});

test('big party splits across tables and carries the notice flag', () => {
  const { store } = mkStore();
  const t = store.register({ pax: 7 });
  assert.strictEqual(t.split, true);
  store.tick();
  const got = store.ticket(t.token);
  assert.strictEqual(got.state, 'called');
  const cap = got.table_ids.reduce((s, id) => s + store.tableById(id).capacity, 0);
  assert.ok(cap >= 7, 'assigned capacity covers the party');
});

test('a blocked big party is not starved by smaller ones behind it', () => {
  const { store } = mkStore();
  // free: K1(1) + B(2) + D(4) = 7 seats -> an 8-pax split cannot fit yet
  store.admin('table-busy', 'C'); store.admin('table-busy', 'A');
  const big = store.register({ pax: 8 });   // blocked, reserves the 4-seater class
  const four = store.register({ pax: 4 });  // must NOT take the last 4-seater
  const two = store.register({ pax: 2 });   // may flow past on a 2-seater
  store.tick();
  assert.strictEqual(store.ticket(big.token).state, 'waiting');
  assert.strictEqual(store.ticket(four.token).state, 'waiting');
  assert.strictEqual(store.ticket(two.token).state, 'called');
});

test('no-show: called -> pending after 5 min, scan re-inserts at depth 2', () => {
  const { store, clock } = mkStore();
  const a = store.register({ pax: 2 });
  store.tick();
  assert.strictEqual(store.ticket(a.token).state, 'called');
  // fill the queue behind with 4-pax parties (only two 4-seaters exist)
  const rest = [1, 2, 3, 4].map(() => store.register({ pax: 4 }));
  clock.t += 5 * 60 * 1000 + 1;
  store.tick();
  const t = store.ticket(a.token);
  assert.strictEqual(t.state, 'pending');
  assert.strictEqual(t.table_ids.length, 0, 'holds released');
  // two 4-pax parties were seated meanwhile, two still wait
  // pending guest returns and scans -> back into main at position 2
  // (make every table busy so the scan cannot seat them instantly)
  for (const id of ['K1', 'A', 'B', 'C', 'D']) store.admin('table-busy', id);
  const r = store.scan(a.token);
  assert.strictEqual(r.result, 'requeued');
  assert.strictEqual(store.state.main.indexOf(a.token), 2);
  assert.ok(rest.length);
});

test('scan on a called ticket seats it, revokes the landing page, frees via ESB', () => {
  const { store } = mkStore();
  const a = store.register({ pax: 2, wa: '0812-3456-789' });
  store.tick();
  const seated = store.scan('https://quehong.example/q/' + a.token); // URL form
  assert.strictEqual(seated.result, 'seated');
  assert.deepStrictEqual(seated.tables, store.ticket(a.token).table_ids);
  const mt = store.mirror().tickets.find(x => x.token === a.token);
  assert.strictEqual(mt.revoked, true);
  // ESB opens a head on that table -> handoff finishes the ticket, table busy
  const tableId = seated.tables[0];
  store.esbOccupancy([tableId]);
  assert.strictEqual(store.ticket(a.token).state, 'finished');
  assert.strictEqual(store.tableState(store.tableById(tableId)), 'busy');
  // cashier settles in ESB -> busy list empties -> table free again
  store.esbOccupancy([]);
  assert.strictEqual(store.tableState(store.tableById(tableId)), 'free');
});

test('WhatsApp: inbound code binds the sender number, nudges hit the outbox', () => {
  const { store } = mkStore();
  const a = store.register({ pax: 2, wa: '0899' }); // typo'd at the tablet
  const r = store.waInbound({ code: a.code.toLowerCase(), jid: '628123@s.whatsapp.net', number: '628123' });
  assert.strictEqual(r.ok, true);
  const t = store.ticket(a.token);
  assert.strictEqual(t.wa_verified, true);
  assert.strictEqual(t.wa, '628123'); // sender wins over the typo
  // all tables busy so they stay waiting at position 0 -> "you are next" nudge
  for (const id of ['K1', 'A', 'B', 'C', 'D']) store.admin('table-busy', id);
  store.tick();
  const msgs = store.pullOutbox();
  assert.ok(msgs.some(m => m.token === a.token), 'nudge queued');
  store.ackOutbox(msgs.map(m => m.id));
  assert.strictEqual(store.pullOutbox().length, 0);
});

test('unknown scans and finished tickets are rejected', () => {
  const { store } = mkStore();
  assert.strictEqual(store.scan('garbage').result, 'unknown');
  const a = store.register({ pax: 1 });
  store.admin('finish', a.token);
  assert.strictEqual(store.scan(a.token).result, 'expired');
});

test('normalizeWa converts Indonesian local format', () => {
  assert.strictEqual(normalizeWa('0812-345-678'), '62812345678');
  assert.strictEqual(normalizeWa('+62 812 345 678'), '62812345678');
});
