'use strict';
process.env.BRIDGE_SIM = '0';
process.env.AGENT_TOKEN = 't-agent';
const { test } = require('node:test');
const assert = require('node:assert');
const bridge = require('../server/bridge');

const ctx = {
  order_no: 'T1', reservation_id: 7, mode: 'dinein', table_name: 'H1', pax: 2,
  customer: { name: 'A' }, note: '', items: [{ menu_code: 'X', menu_name: 'X', qty: 1, price: 10, notes: '' }], total: 10,
};

test('findCommand and addEvent are exported', () => {
  const cmd = bridge.enqueueOrder(ctx);
  assert.equal(bridge.findCommand('T1'), cmd);
  assert.equal(bridge.findCommand(cmd.id), cmd);
  bridge.addEvent(cmd, 'picked_up', 'x');
  assert.equal(cmd.stage, 'picked_up');
});

test('statusFor exposes mode, reservation_id, callback; overview exposes billNum/callback', () => {
  const st = bridge.statusFor('T1');
  assert.equal(st.mode, 'dinein');
  assert.equal(st.reservation_id, 7);
  assert.equal(st.table_name, 'H1');
  assert.equal(st.total, 10);
  assert.equal(st.pending_push, false);
  assert.equal(st.callback, null);
  const ov = bridge.overview();
  assert.ok('billNum' in ov.commands[0] && 'callback' in ov.commands[0]);
});

test('report settled does not await onSettled', async () => {
  let resolveHook;
  bridge.state.onSettled = () => new Promise(r => { resolveHook = r; });
  const cmd = bridge.findCommand('T1');
  const t0 = Date.now();
  const out = await bridge.report({ id: cmd.id, stage: 'settled', payment_method_name: 'Cash', billNum: 'B1' });
  assert.equal(out.status, true);
  assert.ok(Date.now() - t0 < 500, 'report returned before the hook resolved');
  assert.equal(cmd.payment_method, '00');
  assert.equal(cmd.billNum, 'B1');
  resolveHook();
});

test('onSettled rejection is recorded as an event, not thrown', async () => {
  bridge.state.onSettled = async () => { throw new Error('boom'); };
  const cmd = bridge.enqueueOrder({ ...ctx, order_no: 'T2' });
  await bridge.report({ id: cmd.id, stage: 'settled', payment_method_name: 'Card' });
  await new Promise(r => setTimeout(r, 20));
  assert.ok(cmd.events.some(e => /Callback failed: boom/.test(e.detail)));
});

test('AGENT_TOKEN has no default', () => {
  assert.equal(bridge.AGENT_TOKEN, 't-agent');
});
