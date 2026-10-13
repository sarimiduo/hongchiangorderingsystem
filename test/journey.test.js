'use strict';
/**
 * End-to-end: boots apphong (server/index.js) and midhong (server/mid.js)
 * in-process on free ports with KDS_MODE=mock and the simulator off.
 * Tests run in file order and share state on purpose (it is one journey).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');

function freePort() {
  return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
async function j(url, opts) {
  const res = await fetch(url, opts);
  return { code: res.status, body: await res.json().catch(() => ({})) };
}
function post(url, body, token) {
  return j(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
}
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 50)); }
}

const T = { app: null, mid: null, APP: '', MID: '', servers: [] };
before(async () => {
  const appPort = await freePort(), midPort = await freePort();
  Object.assign(process.env, {
    KDS_MODE: 'mock', BRIDGE_SIM: '0', PORT: String(appPort), MID_PORT: String(midPort),
    BRIDGE_URL: `http://127.0.0.1:${midPort}`, APP_URL: `http://127.0.0.1:${appPort}`,
    BRIDGE_TOKEN: 't-bridge', AGENT_TOKEN: 't-agent',
  });
  T.APP = process.env.APP_URL; T.MID = process.env.BRIDGE_URL;
});
after(() => T.servers.forEach(s => s.close()));

// ---------------------------------------------------------------- midhong alone
test('midhong: starts, health, and rejects a bad bridge token', async () => {
  T.mid = require('../server/mid');
  T.servers.push(await T.mid.start());
  const h = await j(`${T.MID}/api/health`);
  assert.equal(h.code, 200); assert.equal(h.body.ok, true); assert.equal(h.body.queued, 0);
  const r = await post(`${T.MID}/api/bridge/orders`, { order_no: 'X' }, 'wrong');
  assert.equal(r.code, 401); assert.deepEqual(r.body, { status: false, msg: 'unauthorized' });
});

test('midhong: malformed push is a 400 and enqueues nothing', async () => {
  const r1 = await post(`${T.MID}/api/bridge/orders`, { items: [{ qty: 1 }] }, 't-bridge');
  assert.equal(r1.code, 400); assert.equal(r1.body.msg, 'bad payload');
  const r2 = await post(`${T.MID}/api/bridge/orders`, { order_no: 'E', mode: 'walkin', items: [] }, 't-bridge');
  assert.equal(r2.code, 400);
  const ov = await j(`${T.MID}/api/bridge/overview`);
  assert.equal(ov.body.commands.length, 0);
});

test('midhong: push is idempotent on order_no', async () => {
  const ctx = { order_no: 'IDEM1', reservation_id: null, mode: 'walkin', table_name: null, pax: 1, customer: {}, note: '',
    items: [{ menu_code: '', menu_name: 'Tea', qty: 2, price: 5000, notes: '' }], total: 10000 };
  const a = await post(`${T.MID}/api/bridge/orders`, ctx, 't-bridge');
  const b = await post(`${T.MID}/api/bridge/orders`, ctx, 't-bridge');
  assert.equal(a.code, 200); assert.equal(a.body.data.existing, false);
  assert.equal(b.code, 200); assert.equal(b.body.data.existing, true);
  assert.equal(b.body.data.id, a.body.data.id);
  const ov = await j(`${T.MID}/api/bridge/overview`);
  assert.equal(ov.body.commands.filter(c => c.order_no === 'IDEM1').length, 1);
  const st = await j(`${T.MID}/api/bridge/status?order_no=IDEM1`);
  assert.equal(st.body.stage, 'queued'); assert.equal(st.body.total, 10000);
});

test('midhong: agent endpoints need AGENT_TOKEN; commands lists the queued order', async () => {
  const bad = await j(`${T.MID}/api/bridge/agent/commands`, { headers: { Authorization: 'Bearer t-bridge' } });
  assert.equal(bad.code, 401);
  const ok = await j(`${T.MID}/api/bridge/agent/commands`, { headers: { Authorization: 'Bearer t-agent' } });
  assert.equal(ok.code, 200);
  assert.ok(ok.body.data.some(c => c.order_no === 'IDEM1'));
  const hb = await post(`${T.MID}/api/bridge/agent/heartbeat`, {}, 't-agent');
  assert.equal(hb.body.status, true);
});

test('midhong: menu sync is served on /api/bridge/menu; monitor page is served on /', async () => {
  const none = await j(`${T.MID}/api/bridge/menu`);
  assert.equal(none.body.source, null);
  const sync = await post(`${T.MID}/api/bridge/agent/menu`, { categories: [{ id: 1, name: 'Drinks' }], meals: [{ meal_id: 901, meal_name: 'Es Teh', menu_code: 'ET', price: 9000, category_id: 1 }] }, 't-agent');
  assert.equal(sync.body.status, true);
  const m = await j(`${T.MID}/api/bridge/menu`);
  assert.equal(m.body.source, 'esb'); assert.equal(m.body.meals[0].menu_code, 'ET');
  const page = await fetch(`${T.MID}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Bridge Monitor/);
});

test('midhong: callback to a dead apphong is non-blocking, counted, and marked not ok', async () => {
  const bridge = require('../server/bridge');
  const cmd = bridge.findCommand('IDEM1');
  const ok = await T.mid.sendCallback(cmd, [0, 0], 'http://127.0.0.1:1');   // 3 fast attempts to a closed port
  assert.equal(ok, false);
  assert.equal(cmd.callback.ok, false);
  assert.equal(cmd.callback.attempts, 3);
  assert.equal(cmd.callback.inflight, false);
  assert.match(cmd.callback.last_error, /ECONNREFUSED|fetch failed|unreachable/);
  assert.ok(cmd.events.some(e => /Callback to apphong failed/.test(e.detail)));
});

test('midhong: report settled returns immediately even when apphong is down', async () => {
  const ctx = { order_no: 'DEAD1', reservation_id: null, mode: 'walkin', table_name: null, pax: 1, customer: {}, note: '',
    items: [{ menu_code: '', menu_name: 'Tea', qty: 1, price: 5000, notes: '' }], total: 5000 };
  const a = await post(`${T.MID}/api/bridge/orders`, ctx, 't-bridge');
  const t0 = Date.now();
  const r = await post(`${T.MID}/api/bridge/agent/report`, { id: a.body.data.id, stage: 'settled', payment_method_name: 'Cash' }, 't-agent');
  assert.equal(r.body.status, true);
  assert.ok(Date.now() - t0 < 1000, 'agent report must not wait for the callback retries');
  const st = await j(`${T.MID}/api/bridge/status?order_no=DEAD1`);
  assert.equal(st.body.stage, 'settled');
  assert.equal(st.body.callback.ok, false);           // apphong is not running yet
  assert.ok(st.body.callback.attempts >= 1);
});
