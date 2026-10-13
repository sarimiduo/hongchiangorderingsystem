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

test('apphong: starts and rejects callbacks with a bad token', async () => {
  T.app = require('../server/index');
  T.servers.push(await T.app.start());
  const r = await post(`${T.APP}/api/bridge/callback`, { order_no: 'X' }, 'wrong');
  assert.equal(r.code, 401);
});

test('apphong: callback for an order the KDS does not know is acknowledged (no endless retry)', async () => {
  const r = await post(`${T.APP}/api/bridge/callback`, { order_no: 'GHOST', reservation_id: 999, mode: 'dinein', payment_method: '00' }, 't-bridge');
  assert.equal(r.code, 200);
  assert.equal(r.body.status, true);
  assert.equal(r.body.msg, 'kds_unknown_order');
});

test('apphong: /api/pay is gone', async () => {
  const r = await post(`${T.APP}/api/pay`, { mode: 'walkin', order_no: 'x' });
  assert.equal(r.code, 404);
});

test('apphong: /api/menu serves the ESB catalog synced on midhong', async () => {
  require('../server/bridge-client').resetMenuCache();
  const m = await j(`${T.APP}/api/menu`);
  assert.equal(m.body.source, 'esb');
  assert.ok(m.body.store && m.body.store.name, 'store info still comes from the local file');
  assert.equal(m.body.meals[0].menu_code, 'ET');
});

// ------------------------------------------------- apphong alone, midhong down
const { spawn } = require('child_process');
const pathMod = require('path');

async function spawnApp(env) {
  const child = spawn(process.execPath, [pathMod.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => { if (/listening on/.test(String(d))) resolve(); });
    child.stderr.on('data', d => { if (/missing required env/.test(String(d))) reject(new Error(String(d))); });
    child.on('exit', c => reject(new Error('exited ' + c)));
  });
  return child;
}

test('apphong refuses to start without BRIDGE_URL/BRIDGE_TOKEN', async () => {
  const env = { ...process.env }; delete env.BRIDGE_URL; delete env.BRIDGE_TOKEN;
  const child = spawn(process.execPath, [pathMod.join(__dirname, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', d => err += d);
  const code = await new Promise(r => child.on('exit', r));
  assert.equal(code, 1);
  assert.match(err, /BRIDGE_URL, BRIDGE_TOKEN/);
});

test('apphong with midhong down: checkout succeeds, status shows pending_push, proxies answer 503', async () => {
  const appPort = await freePort(), deadPort = await freePort();
  const child = await spawnApp({ PORT: String(appPort), BRIDGE_URL: `http://127.0.0.1:${deadPort}`, BRIDGE_TOKEN: 't-bridge' });
  try {
    const APP = `http://127.0.0.1:${appPort}`;
    const menu = (await j(`${APP}/api/menu`)).body;
    assert.equal(menu.source, 'local', 'falls back to the local catalog');
    const co = await post(`${APP}/api/checkout`, { type: 'walkin', guest_count: 1, meals: [{ meal_id: menu.meals[0].meal_id, quantity: 1 }] });
    assert.equal(co.code, 200); assert.equal(co.body.status, true); assert.equal(co.body.data.bridge_pushed, false);
    const st = await j(`${APP}/api/bridge/status?order_no=${co.body.data.order_no}`);
    assert.equal(st.code, 200); assert.equal(st.body.stage, 'queued'); assert.equal(st.body.pending_push, true);
    const ov = await j(`${APP}/api/bridge/overview`);
    assert.equal(ov.code, 503); assert.deepEqual(ov.body.commands, []);
    const unknown = await j(`${APP}/api/bridge/status?order_no=NOPE`);
    assert.equal(unknown.code, 503);
  } finally { child.kill(); }
});

// ------------------------------------------------------------ full journeys
async function checkout(type, extra) {
  const menu = (await j(`${T.APP}/api/menu`)).body;
  const co = await post(`${T.APP}/api/checkout`, {
    type, guest_count: 2, customer: { name: 'Test' }, note: 'no chili',
    meals: [{ meal_id: menu.meals[0].meal_id, quantity: 2, remarks: 'less ice' }], ...extra,
  });
  assert.equal(co.body.status, true, JSON.stringify(co.body));
  assert.equal(co.body.data.bridge_pushed, true);
  return co.body.data;
}
async function kdsOrder(orderNo) {
  return (await post(`${T.APP}/api/kds/orders/details`, { order_id: orderNo })).body.data.order;
}

test('journey dine-in: save order → midhong queue → agent settles → callback → KDS paid', async () => {
  const tables = (await post(`${T.APP}/api/kds/tables/search`, {})).body.data;
  const table = tables.find(t => t.status === 'IDLE');
  const o = await checkout('dinein', { table_id: table.id, table_name: table.name });
  assert.ok(o.reservation_id);

  // midhong has the same lines and total
  const st = (await j(`${T.APP}/api/bridge/status?order_no=${o.order_no}`)).body;
  assert.equal(st.stage, 'queued'); assert.equal(st.pending_push, false);
  assert.equal(st.table_name, table.name); assert.equal(Number(st.total), Number(o.total_price));
  const queued = (await j(`${T.MID}/api/bridge/agent/commands`, { headers: { Authorization: 'Bearer t-agent' } })).body.data;
  const cmd = queued.find(c => c.order_no === o.order_no);
  assert.equal(cmd.items.length, 1); assert.equal(cmd.items[0].qty, 2); assert.equal(cmd.items[0].notes, 'less ice');

  // agent walks the stages, then the cashier settles with Card
  for (const stage of ['picked_up', 'table_opened', 'order_saved', 'waiting_cashier']) {
    const r = await post(`${T.MID}/api/bridge/agent/report`, { id: cmd.id, stage, salesNum: 'SSUSHO1', detail: stage }, 't-agent');
    assert.equal(r.body.status, true);
  }
  const r = await post(`${T.MID}/api/bridge/agent/report`, { id: cmd.id, stage: 'settled', payment_method_name: 'Kartu Debit', billNum: 'JKT2026101301' }, 't-agent');
  assert.equal(r.body.status, true);

  const ord = await until(async () => { const x = await kdsOrder(o.order_no); return x.status === 'paid' ? x : null; });
  assert.equal(ord.payment_method, '01');                            // Card
  const done = (await j(`${T.APP}/api/bridge/status?order_no=${o.order_no}`)).body;
  assert.equal(done.stage, 'settled'); assert.equal(done.billNum, 'JKT2026101301');
  assert.equal(done.callback.ok, true); assert.equal(done.callback.attempts, 1);
  const t2 = (await post(`${T.APP}/api/kds/tables/search`, {})).body.data.find(t => t.id === table.id);
  assert.equal(t2.status, 'IDLE', 'table freed in the KDS');
});

test('journey takeout: walk-in settles through walkIns/update', async () => {
  const o = await checkout('walkin', {});
  assert.equal(o.reservation_id, null);
  const r = await post(`${T.MID}/api/bridge/agent/report`, { order_no: o.order_no, stage: 'settled', payment_method_name: 'Cash' }, 't-agent');
  assert.equal(r.body.status, true);
  const ord = await until(async () => { const x = await kdsOrder(o.order_no); return x.status === 'paid' ? x : null; });
  assert.equal(ord.payment_method, '00');
  const open = (await post(`${T.APP}/api/kds/walkIns/get`, {})).body.data.order_nos;
  assert.ok(!open.includes(o.order_no), 'no longer an open walk-in');
});

test('duplicate callback is harmless', async () => {
  const o = await checkout('walkin', {});
  const body = { order_no: o.order_no, reservation_id: null, mode: 'walkin', payment_method: '00' };
  const a = await post(`${T.APP}/api/bridge/callback`, body, 't-bridge');
  const b = await post(`${T.APP}/api/bridge/callback`, body, 't-bridge');
  assert.equal(a.body.msg, 'success'); assert.equal(b.body.msg, 'success');
  assert.equal((await kdsOrder(o.order_no)).status, 'paid');
});
