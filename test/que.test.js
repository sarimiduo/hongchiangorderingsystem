'use strict';
/* quehong queue core - owner seating rules (2026-11-05), no-show kanban,
 * re-insert, scan flow, ESB occupancy handoff, WA binding, mirror revoke. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { QueStore, normalizeWa } = require('../que/store');

// Miniature of the real floor: 3 counter stools (one column), two priority-1
// 4-seaters that stretch to 6 pax, one priority-2 table.
const INV = [
  { id: '01', capacity: 1, zone: 'counter', x: 900 },
  { id: '02', capacity: 1, zone: 'counter', x: 900 },
  { id: '03', capacity: 1, zone: 'counter', x: 900 },
  { id: '20', capacity: 4, max_pax: 6, priority: 1 },
  { id: '21', capacity: 4, max_pax: 6, priority: 1 },
  { id: '46', capacity: 4, max_pax: 6, priority: 2 },
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

test('couple gets two adjacent counter stools, single gets one', () => {
  const { store } = mkStore();
  const duo = store.register({ name: 'Couple', pax: 2 });
  const solo = store.register({ name: 'Solo', pax: 1 });
  store.tick();
  assert.deepStrictEqual(store.ticket(duo.token).table_ids, ['01', '02']);
  assert.deepStrictEqual(store.ticket(solo.token).table_ids, ['03']);
});

test('floor 4-seater holds up to 6 pax; priority-1 fills before priority-2', () => {
  const { store } = mkStore();
  const five = store.register({ pax: 5 });
  const four = store.register({ pax: 4 });
  const three = store.register({ pax: 3 });
  store.tick();
  assert.deepStrictEqual(store.ticket(five.token).table_ids, ['20']);
  assert.deepStrictEqual(store.ticket(four.token).table_ids, ['21']);
  // priority-1 zone full -> only now the priority-2 table opens
  assert.deepStrictEqual(store.ticket(three.token).table_ids, ['46']);
  assert.strictEqual(store.ticket(five.token).split, false);
});

test('couple overflows to a floor table only when no stool pair is free', () => {
  const { store } = mkStore();
  store.admin('table-busy', '02'); // 01 and 03 free but NOT adjacent pair? 01-02 broken, 02-03 broken
  const duo = store.register({ pax: 2 });
  store.tick();
  // no adjacent pair -> floor table, reserve respected (3 floor tables free > 1)
  assert.deepStrictEqual(store.ticket(duo.token).table_ids, ['20']);
  // with only one floor table left, the next couple (also without a pair) waits
  store.admin('table-busy', '21');
  const duo2 = store.register({ pax: 2 });
  store.tick();
  assert.strictEqual(store.ticket(duo2.token).state, 'waiting');
});

test('big party splits across floor tables, priority zone first', () => {
  const { store } = mkStore();
  const party = store.register({ pax: 7 });
  assert.strictEqual(party.split, true); // > floor max fit (6)
  store.tick();
  const got = store.ticket(party.token);
  assert.strictEqual(got.state, 'called');
  assert.deepStrictEqual(got.tables || got.table_ids, ['20', '21']); // 4+4 covers 7, zone 1 first
});

test('a blocked big party is not starved; couples flow past on the counter', () => {
  const { store } = mkStore();
  store.admin('table-busy', '20'); store.admin('table-busy', '21');
  const big = store.register({ pax: 8 });   // needs 8 floor seats, only '46' free -> blocked
  const four = store.register({ pax: 4 });  // must NOT take '46' past the blocked party
  const duo = store.register({ pax: 2 });   // counter is its own class -> passes
  store.tick();
  assert.strictEqual(store.ticket(big.token).state, 'waiting');
  assert.strictEqual(store.ticket(four.token).state, 'waiting');
  assert.deepStrictEqual(store.ticket(duo.token).table_ids, ['01', '02']);
});

test('no-show: called -> pending after 5 min, scan re-inserts at depth 2', () => {
  const { store, clock } = mkStore();
  const a = store.register({ pax: 4 });
  store.tick();
  assert.strictEqual(store.ticket(a.token).state, 'called');
  const rest = [1, 2, 3, 4, 5].map(() => store.register({ pax: 4 }));
  clock.t += 5 * 60 * 1000 + 1;
  store.tick(); // a -> pending; three of the rest get the three floor tables
  const t = store.ticket(a.token);
  assert.strictEqual(t.state, 'pending');
  assert.strictEqual(t.table_ids.length, 0, 'holds released');
  for (const tbl of INV) store.admin('table-busy', tbl.id); // nothing free at scan time
  const r = store.scan(a.token);
  assert.strictEqual(r.result, 'requeued');
  assert.strictEqual(store.state.main.indexOf(a.token), 2); // bypasses 2 numbers
  assert.ok(rest.length);
});

test('scan on a called ticket seats it, revokes the landing page, frees via ESB', () => {
  const { store } = mkStore();
  const a = store.register({ pax: 4, wa: '0812-3456-789' });
  store.tick();
  const seated = store.scan('https://quehong.example/q/' + a.token); // URL form
  assert.strictEqual(seated.result, 'seated');
  assert.deepStrictEqual(seated.tables, ['20']);
  const mt = store.mirror().tickets.find(x => x.token === a.token);
  assert.strictEqual(mt.revoked, true);
  store.esbOccupancy(['20']); // ESB opens the head -> handoff finishes the ticket
  assert.strictEqual(store.ticket(a.token).state, 'finished');
  assert.strictEqual(store.tableState(store.tableById('20')), 'busy');
  store.esbOccupancy([]); // cashier settled -> table free again
  assert.strictEqual(store.tableState(store.tableById('20')), 'free');
});

test('WhatsApp: inbound code binds the sender number, nudges hit the outbox', () => {
  const { store } = mkStore();
  const a = store.register({ pax: 4, wa: '0899' }); // typo'd at the tablet
  const r = store.waInbound({ code: a.code.toLowerCase(), jid: '628123@s.whatsapp.net', number: '628123' });
  assert.strictEqual(r.ok, true);
  const t = store.ticket(a.token);
  assert.strictEqual(t.wa_verified, true);
  assert.strictEqual(t.wa, '628123'); // sender wins over the typo
  for (const tbl of INV) store.admin('table-busy', tbl.id); // keep them waiting at the front
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
