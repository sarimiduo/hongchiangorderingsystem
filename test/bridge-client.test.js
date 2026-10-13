'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');

function freePort() {
  return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}

let port, fake, received = [], client, mode = 'ok';
before(async () => {
  port = await freePort();
  process.env.BRIDGE_URL = `http://127.0.0.1:${port}/`;   // trailing slash must be tolerated
  process.env.BRIDGE_TOKEN = 't-bridge';
  client = require('../server/bridge-client');
});
after(() => fake && fake.close());

function startFake() {
  fake = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      res.setHeader('Content-Type', 'application/json');
      if (mode === '401') { res.writeHead(401); return res.end(JSON.stringify({ status: false, msg: 'unauthorized' })); }
      if (req.url.startsWith('/api/bridge/status')) { res.writeHead(404); return res.end(JSON.stringify({ status: false, msg: 'not_found' })); }
      if (req.url === '/api/bridge/menu') { res.writeHead(200); return res.end(JSON.stringify({ source: 'esb', categories: [], meals: [{ meal_id: 1 }] })); }
      res.writeHead(200); res.end(JSON.stringify({ status: true, msg: 'success', data: { id: 'cmd_1', stage: 'queued', existing: false } }));
    });
  });
  return new Promise(r => fake.listen(port, '127.0.0.1', r));
}

const ctx = { order_no: 'O1', reservation_id: null, mode: 'walkin', items: [{ menu_code: '', menu_name: 'X', qty: 1, price: 5, notes: '' }], total: 5 };

test('pushOrder while midhong is down → outbox, status() reports pending_push', async () => {
  const out = await client.pushOrder(ctx);
  assert.equal(out.pushed, false);
  assert.equal(client.outbox.length, 1);
  const st = await client.status('O1');
  assert.equal(st.stage, 'queued');
  assert.equal(st.pending_push, true);
  assert.equal(st.order_no, 'O1');
  assert.ok(Array.isArray(st.events) && st.events.length === 1);
});

test('overview() throws BridgeDown while midhong is down', async () => {
  await assert.rejects(client.overview(), e => e instanceof client.BridgeDown);
});

test('flushOutbox delivers with the bearer token once midhong is up', async () => {
  await startFake();
  const left = await client.flushOutbox();
  assert.equal(left, 0);
  assert.equal(received[0].url, '/api/bridge/orders');
  assert.equal(received[0].auth, 'Bearer t-bridge');
  assert.deepEqual(received[0].body, ctx);
});

test('status() returns null on 404 from midhong', async () => {
  assert.equal(await client.status('NOPE'), null);
});

test('menu() returns the ESB catalog and caches it', async () => {
  client.resetMenuCache();
  const n = received.length;
  const m1 = await client.menu();
  const m2 = await client.menu();
  assert.equal(m1.source, 'esb');
  assert.equal(m2, m1);
  assert.equal(received.length, n + 1, 'second call served from cache');
});

test('pushOrder with a 401 goes to the outbox (misconfigured token is retried, visible in logs)', async () => {
  mode = '401';
  const out = await client.pushOrder({ ...ctx, order_no: 'O2' });
  assert.equal(out.pushed, false);
  assert.match(out.error, /401/);
  mode = 'ok';
  assert.equal(await client.flushOutbox(), 0);
});
