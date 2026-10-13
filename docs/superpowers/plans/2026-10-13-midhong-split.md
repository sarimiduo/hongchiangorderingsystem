# midhong split (stage 1: cashier-only) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the ESB bridge middleware as its own Node process (`midhong.berkatselalu.com`, `server/mid.js`) that apphong pushes orders to and that calls apphong back when the ESB cashier settles; make the customer journey Save Order → show-the-cashier card → FINISHED/PAID, with no in-app payment.

**Architecture:** Two zero-dependency Node HTTP servers from one repo on one VPS. `server/bridge.js` (queue, stages, simulator, menu-sync store) stays as-is but is only loaded by `server/mid.js`; `server/index.js` (apphong) becomes an HTTP client of midhong via `server/bridge-client.js`, proxies the read-only bridge endpoints for the unchanged frontend polling, and exposes `POST /api/bridge/callback` for the settlement feedback into the KDS. Shared HTTP helpers move to `server/http-util.js`.

**Tech Stack:** Node ≥ 18 (`node:http`, global `fetch`, `AbortSignal.timeout`, `node:test`), vanilla SPA (no build), systemd + nginx. No npm dependencies — do not add any.

**Spec:** `docs/superpowers/specs/2026-10-13-midhong-split-design.md`

## Global Constraints

- Zero npm dependencies; every server file must pass `node --check`.
- Node `>=18` (`package.json` engines); the VPS runs Node 20.
- Both Node processes bind `127.0.0.1` only (nginx is the public surface). `HOST` env may override (Docker only).
- Env names exactly: `PORT`, `MID_PORT`, `BRIDGE_URL`, `APP_URL`, `BRIDGE_TOKEN`, `AGENT_TOKEN`, `BRIDGE_SIM`, `BRIDGE_SIM_SETTLE_SECONDS`, `KDS_MODE`, `KDS_BASE_URL`, `CURRENCY`.
- `index.js` refuses to start without `BRIDGE_URL` + `BRIDGE_TOKEN`; `mid.js` without `APP_URL` + `BRIDGE_TOKEN` + `AGENT_TOKEN`.
- API response shape stays `{status, msg, data}` on bridge/agent endpoints; auth failures are `401 {status:false, msg:'unauthorized'}`.
- Stage 1 is cashier-only: no `/api/pay`, no online payment, no self-service "I have paid".
- The bridge never writes ESB payments/`billNum` (golden rule 5) — nothing in this plan touches the agent's SQL.
- Never commit `.env`, `agent/agent.ini`, `hermes/.env`. Always `git pull` before any push; never force-push.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **Callback for an order the KDS no longer knows** (apphong restarted; KDS mock state is in-memory): the KDS update returns `{status:false, msg:'S00001'}`. Expected: apphong answers `200 {status:true, msg:'kds_unknown_order'}` so midhong stops retrying — retrying can't heal a lost in-memory order. Test pinned in Task 6.
2. **Malformed push body** (`POST /api/bridge/orders` without `order_no` or with empty `items`): expected `400 {status:false, msg:'bad payload'}`, nothing enqueued. Test pinned in Task 4.
3. **midhong down while the customer page polls**: `GET /api/bridge/status` → `503 {status:false, msg:'bridge unreachable…'}`; `GET /api/bridge/overview` → 503 with `commands: []` so the monitor tab still renders. Test pinned in Task 7.
4. **Walk-in (takeout) settlement**: callback without `reservation_id` must go through `walkIns/update`, not `reservations/update`. Test pinned in Task 8.
5. **Callback to a dead apphong must not block the agent's report call**: `report()` returns immediately and `cmd.callback.ok` stays `false` with `attempts` counted; the 60 s sweeper re-sends later. Test pinned in Task 5.

Deviation from spec §5 (documented in Task 5): instead of apphong's status proxy "healing" a failed callback, midhong re-sends unacknowledged callbacks itself every 60 s. Same outcome (nothing lost), no extra endpoint, works even with no customer page open. Task 5 updates the spec paragraph.

---

## File structure

| File | Responsibility |
|---|---|
| `server/http-util.js` (new) | `send`, `readBody`, `bearerOk`, `requireEnv` shared by both servers |
| `server/bridge.js` (modify) | unchanged behavior; exports `findCommand`, `addEvent`; `statusFor`/`overview` expose `mode`, `reservation_id`, `callback`, `billNum`; `onSettled` fire-and-forget; no default `AGENT_TOKEN` |
| `server/mid.js` (new) | midhong entrypoint: orders intake, read endpoints, agent endpoints, callback sender + sweeper, monitor page, `start()` |
| `public-mid/index.html` (new) | standalone monitor page for `midhong.berkatselalu.com/` |
| `server/bridge-client.js` (new) | apphong → midhong client: `pushOrder` with outbox, `status`, `overview`, `menu` (30 s cache) |
| `server/index.js` (modify) | drop in-process bridge; callback route; proxies; async `activeMenu`; remove `/api/pay`; `start()`; bind 127.0.0.1 |
| `server/dev.js` (new) | runs both processes locally |
| `public/js/app.js`, `public/css/app.css` (modify) | cashier card status page; remove payment page, pay buttons |
| `test/*.test.js` (new) | `node:test` suites; `test/journey.test.js` boots both servers in-process |
| `deploy/hongchiang-mid.service`, `deploy/nginx.midhong.conf` (new), `docker-compose.yml`, `Dockerfile` (modify) | second service |
| `.env.example`, `package.json`, `README.md`, `docs/DEPLOYMENT.md`, `agent/agent.ini.example`, `agent/README.md`, `CLAUDE.md` (modify) | docs/config |

Task order matters: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11. Tasks 4–8 build up one test file (`test/journey.test.js`); each task appends tests and runs the whole file.

---

### Task 1: Shared HTTP helpers (`server/http-util.js`)

**Files:**
- Create: `server/http-util.js`
- Test: `test/http-util.test.js`

**Interfaces:**
- Produces: `send(res, code, data, type?)`, `readBody(req) → Promise<object>`, `bearerOk(req, token) → boolean`, `requireEnv(names: string[], who: string) → void` (prints missing names and `process.exit(1)`).

- [ ] **Step 1: Write the failing test**

```js
// test/http-util.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { send, readBody, bearerOk, requireEnv } = require('../server/http-util');

test('bearerOk compares the Authorization header exactly', () => {
  assert.equal(bearerOk({ headers: { authorization: 'Bearer abc' } }, 'abc'), true);
  assert.equal(bearerOk({ headers: { authorization: 'Bearer abd' } }, 'abc'), false);
  assert.equal(bearerOk({ headers: {} }, 'abc'), false);
  assert.equal(bearerOk({ headers: { authorization: 'Bearer ' } }, ''), false, 'empty token never matches');
});

test('send writes JSON with no-store; readBody parses JSON', async () => {
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    send(res, 201, { echo: body });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: JSON.stringify({ a: 1 }) });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { echo: { a: 1 } });
  srv.close();
});

test('requireEnv exits with the missing names', () => {
  const calls = [];
  const origExit = process.exit, origErr = console.error;
  process.exit = c => { calls.push(['exit', c]); };
  console.error = m => { calls.push(['err', m]); };
  try {
    requireEnv(['DEFINITELY_UNSET_X', 'DEFINITELY_UNSET_Y'], 'test');
  } finally { process.exit = origExit; console.error = origErr; }
  assert.deepEqual(calls[1], ['exit', 1]);
  assert.match(calls[0][1], /DEFINITELY_UNSET_X, DEFINITELY_UNSET_Y/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/http-util.test.js`
Expected: FAIL — `Cannot find module '../server/http-util'`

- [ ] **Step 3: Write the implementation**

```js
// server/http-util.js
'use strict';
/** HTTP helpers shared by server/index.js (apphong) and server/mid.js (midhong). */

function send(res, code, data, type) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/** True when the request carries exactly `Bearer <token>` and token is non-empty. */
function bearerOk(req, token) {
  if (!token) return false;
  return (req.headers.authorization || '') === 'Bearer ' + token;
}

/** Exit at startup with a clear message when required env vars are missing. */
function requireEnv(names, who) {
  const missing = names.filter(n => !process.env[n]);
  if (missing.length) {
    console.error(`[${who}] missing required env: ${missing.join(', ')} — see .env.example`);
    process.exit(1);
  }
}

module.exports = { send, readBody, bearerOk, requireEnv };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/http-util.test.js`
Expected: `# pass 3`

- [ ] **Step 5: Commit**

```bash
git add server/http-util.js test/http-util.test.js
git commit -m "Add shared HTTP helpers for the two server entrypoints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `bridge.js` adjustments for the split

**Files:**
- Modify: `server/bridge.js` (lines 6-10, 21, 42, 116-128, 187-210, 246-249)
- Test: `test/bridge.test.js`

**Interfaces:**
- Produces (new exports): `findCommand(idOrOrderNo) → cmd|undefined`, `addEvent(cmd, stage, detail)`.
- Changes: `state.onSettled(cmd)` is invoked **without await** (fire-and-forget; the hook owns its own events). `statusFor()` adds `mode, reservation_id, table_name, total, callback, pending_push:false`. `overview().commands[]` adds `billNum, callback`. `AGENT_TOKEN` has no default (`''` when unset).

- [ ] **Step 1: Write the failing test**

```js
// test/bridge.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bridge.test.js`
Expected: FAIL — `bridge.findCommand is not a function` (and others).

- [ ] **Step 3: Edit `server/bridge.js`**

Lines 6-10, replace the flow comment with:
```js
 * Flow (docs/HC_ESB_SQL_BRIDGE_DESIGN.md, docs/superpowers/specs/2026-10-13-midhong-split-design.md):
 *   apphong checkout -> POST /api/bridge/orders (midhong) -> enqueue command
 *   -> agent polls /api/bridge/agent/commands
 *   -> agent runs TXN A (open table, yellow) + TXN B (save order, red)
 *   -> agent watches the sale -> reports "settled" when the cashier finishes
 *   -> midhong calls apphong back -> apphong feeds the KDS (reservations/walkIns update).
```

Line 21, replace:
```js
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'change-me-agent-token';
```
with:
```js
const AGENT_TOKEN = process.env.AGENT_TOKEN || ''; // mid.js refuses to start when empty
```

Line 42, replace the `onSettled` comment:
```js
  onSettled: null,     // set by server/index.js — feeds back into the KDS
```
with:
```js
  onSettled: null,     // set by server/mid.js — sends the settlement callback to apphong (not awaited)
```

Lines 116-128 (inside `report`), replace the `if (stage === 'settled') { ... }` block with:
```js
  if (stage === 'settled') {
    cmd.payment_method = body.payment_method_kds
      ? String(body.payment_method_kds)
      : mapPaymentMethod(body.payment_method_name);
    if (state.onSettled) {
      // Fire-and-forget: the hook may retry for minutes; the agent's HTTP
      // report call must return immediately. The hook records its own events.
      Promise.resolve()
        .then(() => state.onSettled(cmd))
        .catch(e => addEvent(cmd, 'settled', 'Callback failed: ' + e.message));
    }
  }
```

Lines 187-210, replace `statusFor` and `overview` with:
```js
/** Public status views (frontend via apphong proxy, and the midhong monitor). */
function statusFor(orderNo) {
  const c = findCommand(orderNo);
  if (!c) return null;
  return {
    id: c.id, order_no: c.order_no, stage: c.stage, simulated: c.simulated,
    mode: c.mode, reservation_id: c.reservation_id, table_name: c.table_name, total: c.total,
    salesNum: c.salesNum, billNum: c.billNum, payment_method: c.payment_method,
    callback: c.callback || null, pending_push: false,
    error: c.error, events: c.events, agent_live: isAgentLive(),
  };
}
function overview() {
  return {
    agent_live: isAgentLive(),
    agent_info: state.agentInfo,
    simulator: SIM_ENABLED && !isAgentLive(),
    esb_menu: state.esbMenu ? { synced_at: state.esbMenu.synced_at, meals: state.esbMenu.meals.length } : null,
    commands: [...state.commands].reverse().slice(0, 50).map(c => ({
      id: c.id, order_no: c.order_no, mode: c.mode, table_name: c.table_name,
      total: c.total, stage: c.stage, simulated: c.simulated,
      salesNum: c.salesNum, billNum: c.billNum, payment_method: c.payment_method,
      callback: c.callback || null,
      items: c.items.length, created: c.created, events: c.events,
    })),
  };
}
```

Lines 246-249, replace `module.exports` with:
```js
module.exports = {
  AGENT_TOKEN, enqueueOrder, findCommand, addEvent, listQueued, report, setEsbMenu,
  appMenuFromEsb, statusFor, overview, touchAgent, mapPaymentMethod, state,
};
```

- [ ] **Step 4: Run tests**

Run: `node --check server/bridge.js && node --test test/bridge.test.js test/http-util.test.js`
Expected: `# pass 8`

- [ ] **Step 5: Commit**

```bash
git add server/bridge.js test/bridge.test.js
git commit -m "bridge: export findCommand/addEvent, expose callback state, non-blocking onSettled

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `server/bridge-client.js` (apphong → midhong)

**Files:**
- Create: `server/bridge-client.js`
- Test: `test/bridge-client.test.js`

**Interfaces:**
- Consumes env `BRIDGE_URL`, `BRIDGE_TOKEN` (read at require time).
- Produces: `pushOrder(ctx) → Promise<{pushed:boolean, error?:string}>` (never throws; failures go to the outbox), `flushOutbox() → Promise<number>` (remaining count), `status(orderNo) → Promise<object|null>` (null = midhong says 404; throws `BridgeDown` on network error), `overview() → Promise<object>` (throws on network error), `menu() → Promise<object|null>` (ESB catalog or null; cached 30 s), `resetMenuCache()`, `outbox` (array, for tests), `BridgeDown` (Error subclass), `BRIDGE_URL`.

- [ ] **Step 1: Write the failing test**

```js
// test/bridge-client.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bridge-client.test.js`
Expected: FAIL — `Cannot find module '../server/bridge-client'`

- [ ] **Step 3: Write the implementation**

```js
// server/bridge-client.js
'use strict';
/**
 * apphong -> midhong client. apphong never loads server/bridge.js; everything
 * bridge-related goes over HTTP to BRIDGE_URL with the shared BRIDGE_TOKEN.
 *
 * pushOrder() never throws: if midhong is unreachable (or rejects), the order
 * waits in an in-memory outbox and is retried every 5 s until accepted, so a
 * checkout succeeds even when midhong is restarting.
 */

const BRIDGE_URL = (process.env.BRIDGE_URL || '').replace(/\/+$/, '');
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const TIMEOUT_MS = 5000;
const OUTBOX_RETRY_MS = 5000;
const MENU_CACHE_MS = 30000;

class BridgeDown extends Error {}

const outbox = []; // [{ctx, attempts, last_error, created}]
let menuCache = { at: 0, value: null };

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(BRIDGE_URL + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + BRIDGE_TOKEN },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new BridgeDown('midhong unreachable: ' + e.message);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`midhong ${res.status}: ${data.msg || ''}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function pushOrder(ctx) {
  try {
    await call('POST', '/api/bridge/orders', ctx);
    return { pushed: true };
  } catch (e) {
    console.error(`[bridge-client] push ${ctx.order_no} failed (${e.message}) — queued in outbox`);
    outbox.push({ ctx, attempts: 1, last_error: e.message, created: Date.now() });
    return { pushed: false, error: e.message };
  }
}

/** Retry everything in the outbox once. Returns how many are still pending. */
async function flushOutbox() {
  for (const item of [...outbox]) {
    try {
      await call('POST', '/api/bridge/orders', item.ctx);
      outbox.splice(outbox.indexOf(item), 1);
      console.log(`[bridge-client] push ${item.ctx.order_no} delivered after ${item.attempts} failed attempt(s)`);
    } catch (e) {
      item.attempts++;
      item.last_error = e.message;
    }
  }
  return outbox.length;
}
setInterval(() => { if (outbox.length) flushOutbox(); }, OUTBOX_RETRY_MS).unref();

function pendingStatus(item) {
  const t = new Date(item.created).toISOString().replace('T', ' ').slice(0, 19);
  return {
    id: null, order_no: item.ctx.order_no, stage: 'queued', simulated: false,
    mode: item.ctx.mode, reservation_id: item.ctx.reservation_id, table_name: item.ctx.table_name, total: item.ctx.total,
    salesNum: null, billNum: null, payment_method: null, callback: null, pending_push: true,
    error: item.last_error, agent_live: false,
    events: [{ t, stage: 'queued', detail: `Waiting for middleware — push retried ${item.attempts}×` }],
  };
}

async function status(orderNo) {
  const pending = outbox.find(i => i.ctx.order_no === orderNo);
  if (pending) return pendingStatus(pending);
  try {
    return await call('GET', '/api/bridge/status?order_no=' + encodeURIComponent(orderNo));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

function overview() { return call('GET', '/api/bridge/overview'); }

/** ESB-synced catalog from midhong, or null (no sync yet / midhong down). Cached 30 s. */
async function menu() {
  if (Date.now() - menuCache.at < MENU_CACHE_MS) return menuCache.value;
  let value = null;
  try {
    const m = await call('GET', '/api/bridge/menu');
    if (m && m.source === 'esb') value = m;
  } catch (e) {
    console.error('[bridge-client] menu fetch failed: ' + e.message);
  }
  menuCache = { at: Date.now(), value };
  return value;
}
function resetMenuCache() { menuCache = { at: 0, value: null }; }

module.exports = { pushOrder, flushOutbox, status, overview, menu, resetMenuCache, outbox, BridgeDown, BRIDGE_URL };
```

- [ ] **Step 4: Run tests**

Run: `node --check server/bridge-client.js && node --test test/bridge-client.test.js`
Expected: `# pass 6`

- [ ] **Step 5: Commit**

```bash
git add server/bridge-client.js test/bridge-client.test.js
git commit -m "Add apphong→midhong bridge client with outbox retry and menu cache

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `server/mid.js` — intake, read endpoints, agent endpoints, monitor page

**Files:**
- Create: `server/mid.js`, `public-mid/index.html`
- Test: `test/journey.test.js` (created here; later tasks append)

**Interfaces:**
- Consumes: `bridge.js` exports from Task 2; `http-util.js` from Task 1; env `MID_PORT`, `APP_URL`, `BRIDGE_TOKEN`, `AGENT_TOKEN`, `HOST` (optional bind address).
- Produces: `module.exports = { start(port?) → Promise<http.Server>, server }` (+ `sendCallback` in Task 5); auto-starts only when `require.main === module`. Routes per spec §2. In this task `bridge.state.onSettled` stays unset.

- [ ] **Step 1: Write the failing test (new file)**

```js
// test/journey.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/journey.test.js`
Expected: FAIL — `Cannot find module '../server/mid'`

- [ ] **Step 3: Write `server/mid.js`**

```js
// server/mid.js
'use strict';
/**
 * midhong — the ESB bridge middleware as its own service.
 *
 *   apphong  --POST /api/bridge/orders-->  midhong queue  <--polls--  mini-PC agent --> ESB POS
 *   apphong  <--POST /api/bridge/callback--  midhong  <--report settled--  agent watcher
 *
 * Zero dependencies. Serves a small monitor page on "/".
 * Env: MID_PORT, APP_URL, BRIDGE_TOKEN (apphong <-> midhong), AGENT_TOKEN (agent <-> midhong),
 *      BRIDGE_SIM, BRIDGE_SIM_SETTLE_SECONDS, HOST (bind address, default 127.0.0.1).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const bridge = require('./bridge');
const { send, readBody, bearerOk, requireEnv } = require('./http-util');

requireEnv(['APP_URL', 'BRIDGE_TOKEN', 'AGENT_TOKEN'], 'midhong');

const MID_PORT = Number(process.env.MID_PORT || 3100);
const HOST = process.env.HOST || '127.0.0.1';
const APP_URL = process.env.APP_URL.replace(/\/+$/, '');
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const MONITOR_HTML = path.join(__dirname, '..', 'public-mid', 'index.html');

/* ------------------------------------------------ settlement callback → apphong */
// Added in Task 5 (sendCallback + sweeper).

/* --------------------------------------------------------------------- routes */
function validOrder(b) {
  return b && typeof b.order_no === 'string' && b.order_no
    && (b.mode === 'dinein' || b.mode === 'walkin')
    && Array.isArray(b.items) && b.items.length > 0
    && b.items.every(i => i && Number(i.qty) > 0 && typeof i.menu_name === 'string');
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\//, '');

  if (req.method === 'GET' && route === 'health') {
    return send(res, 200, {
      ok: true, agent_live: bridge.overview().agent_live,
      queued: bridge.listQueued().length, app_url: APP_URL,
    });
  }

  // ---- public read endpoints (apphong proxies these for the SPA; monitor page) ----
  if (req.method === 'GET' && route.startsWith('bridge/status')) {
    const orderNo = url.searchParams.get('order_no');
    const st = orderNo ? bridge.statusFor(orderNo) : null;
    return send(res, st ? 200 : 404, st || { status: false, msg: 'not_found' });
  }
  if (req.method === 'GET' && route === 'bridge/overview') return send(res, 200, bridge.overview());
  if (req.method === 'GET' && route === 'bridge/menu') return send(res, 200, bridge.appMenuFromEsb() || { source: null });

  // ---- apphong → midhong: order intake (Bearer BRIDGE_TOKEN) ----
  if (req.method === 'POST' && route === 'bridge/orders') {
    if (!bearerOk(req, BRIDGE_TOKEN)) {
      console.error('[midhong] /api/bridge/orders: bad BRIDGE_TOKEN');
      return send(res, 401, { status: false, msg: 'unauthorized' });
    }
    const body = await readBody(req);
    if (!validOrder(body)) return send(res, 400, { status: false, msg: 'bad payload' });
    const existing = bridge.findCommand(body.order_no);
    if (existing) {
      return send(res, 200, { status: true, msg: 'exists', data: { id: existing.id, stage: existing.stage, existing: true } });
    }
    const cmd = bridge.enqueueOrder({
      order_no: body.order_no,
      reservation_id: body.reservation_id == null ? null : Number(body.reservation_id),
      mode: body.mode,
      table_name: body.table_name || null,
      pax: Number(body.pax) || 1,
      customer: body.customer || {},
      note: String(body.note || ''),
      items: body.items.map(i => ({
        menu_code: String(i.menu_code || ''), menu_name: String(i.menu_name),
        qty: Number(i.qty), price: Number(i.price) || 0, notes: String(i.notes || ''),
      })),
      total: Number(body.total) || 0,
    });
    console.log(`[midhong] queued ${cmd.order_no} (${cmd.mode}${cmd.table_name ? ' ' + cmd.table_name : ''}, ${cmd.items.length} item(s))`);
    return send(res, 200, { status: true, msg: 'success', data: { id: cmd.id, stage: cmd.stage, existing: false } });
  }

  // ---- agent endpoints (Bearer AGENT_TOKEN) — unchanged contract ----
  if (route.startsWith('bridge/agent/')) {
    if (!bearerOk(req, bridge.AGENT_TOKEN)) {
      console.error('[midhong] /api/bridge/agent/*: bad AGENT_TOKEN');
      return send(res, 401, { status: false, msg: 'unauthorized' });
    }
    bridge.touchAgent(req.headers['x-agent-info'] ? { info: String(req.headers['x-agent-info']).slice(0, 100) } : null);
    if (req.method === 'GET' && route === 'bridge/agent/commands') {
      return send(res, 200, { status: true, msg: 'success', data: bridge.listQueued() });
    }
    if (req.method === 'POST' && route === 'bridge/agent/report') {
      return send(res, 200, await bridge.report(await readBody(req)));
    }
    if (req.method === 'POST' && route === 'bridge/agent/menu') {
      return send(res, 200, bridge.setEsbMenu(await readBody(req)));
    }
    if (req.method === 'POST' && route === 'bridge/agent/heartbeat') {
      return send(res, 200, { status: true, msg: 'success' });
    }
    return send(res, 404, { status: false, msg: 'not_found' });
  }

  return send(res, 404, { status: false, msg: 'not_found', data: [] });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(MONITOR_HTML, 'utf8'), 'text/html; charset=utf-8');
    }
    return send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    return send(res, 500, { status: false, msg: e.message, data: [] });
  }
});

function start(port = MID_PORT) {
  return new Promise(resolve => {
    server.listen(port, HOST, () => {
      console.log(`midhong bridge listening on http://${HOST}:${server.address().port} (app=${APP_URL}, sim=${process.env.BRIDGE_SIM !== '0' ? 'on' : 'off'})`);
      resolve(server);
    });
  });
}

if (require.main === module) start();

module.exports = { start, server };
```

- [ ] **Step 4: Write `public-mid/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>midhong — Bridge Monitor</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔁</text></svg>">
  <style>
    :root { --orange:#f05a24; --ink:#1f2024; --ink2:#5c5f66; --ink3:#9a9da3; --bg:#f4f4f5; --card:#fff; --line:#ececee; --green:#18a553; --red:#d7263d; }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:Inter, system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--ink); padding:16px; }
    .wrap { max-width:760px; margin:0 auto; display:grid; gap:12px; }
    h1 { font-size:18px; font-weight:800; display:flex; align-items:center; gap:8px; }
    .card { background:var(--card); border-radius:14px; padding:14px 16px; box-shadow:0 1px 4px rgba(20,20,30,.07); }
    .muted { color:var(--ink3); font-size:13px; }
    .row { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .badge { font-size:11.5px; font-weight:800; border-radius:999px; padding:4px 10px; letter-spacing:.3px; white-space:nowrap; }
    .PREPARING { background:#fdf1d7; color:#b07a0a; } .READY { background:#def3e5; color:#15823f; }
    .PAID { background:#def3e5; color:#15823f; } .SERVED { background:#e7e7ea; color:#5c5f66; } .ERR { background:#fde2e6; color:var(--red); }
    .ev { font-size:11.5px; color:var(--ink2); margin-top:6px; border-top:1px dashed var(--line); padding-top:6px; }
    code { font-family:ui-monospace, Menlo, monospace; font-size:12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>🔁 Bridge Monitor <span class="muted">midhong · apphong → ESB POS</span></h1>
    <div id="root" class="card muted">Loading…</div>
  </div>
  <script>
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    const fmt = n => 'Rp' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const LABEL = { queued:['QUEUED','PREPARING'], picked_up:['AGENT','PREPARING'], table_opened:['OPEN 🟡','PREPARING'],
      order_saved:['OCCUPIED 🔴','PREPARING'], waiting_cashier:['CASHIER…','READY'], settled:['FINISHED','PAID'],
      voided:['VOIDED','SERVED'], error:['ERROR','ERR'] };
    async function paint() {
      const root = document.getElementById('root');
      let ov;
      try { ov = await (await fetch('/api/bridge/overview')).json(); }
      catch (e) { root.innerHTML = '⚠️ midhong API unreachable'; return; }
      const cb = c => !c.callback ? '' : c.callback.ok
        ? `<br>↩︎ apphong told: ✅ (attempt ${c.callback.attempts})`
        : `<br>↩︎ apphong told: ❌ after ${c.callback.attempts} attempt(s) — ${esc(c.callback.last_error || '')} (re-sent every 60 s)`;
      root.className = 'wrap'; root.style.padding = '0';
      root.innerHTML = `
        <div class="card"><b>Agent:</b> ${ov.agent_live ? '🟢 live agent connected' : ov.simulator ? '🟠 simulator (no live agent)' : '⚪ offline'}
          ${ov.agent_info && ov.agent_info.info ? ` <span class="muted">${esc(ov.agent_info.info)}</span>` : ''}
          <div class="muted">${ov.esb_menu ? `Menu synced from ESB POS: ${ov.esb_menu.meals} items (${esc(ov.esb_menu.synced_at.slice(0,19).replace('T',' '))})` : 'No ESB menu sync yet'}</div>
        </div>
        ${ov.commands.length === 0 ? '<p class="muted">No orders yet.</p>' : ''}
        ${ov.commands.map(c => `
          <div class="card">
            <div class="row"><b>${esc(c.order_no)}</b>
              <span class="badge ${LABEL[c.stage] ? LABEL[c.stage][1] : 'SERVED'}">${LABEL[c.stage] ? LABEL[c.stage][0] : esc(c.stage)}</span></div>
            <div class="muted" style="margin-top:4px">
              ${c.mode === 'dinein' ? 'Dine In · Table ' + esc(c.table_name || '?') : 'Takeout'} · ${c.items} item(s) · ${fmt(c.total)}
              ${c.salesNum ? `<br>ESB salesNum <code>${esc(c.salesNum)}</code>` : ''}
              ${c.billNum ? ` · bill <code>${esc(c.billNum)}</code>` : ''}
              ${c.payment_method ? ` · paid (${esc(c.payment_method)})` : ''}${cb(c)}
            </div>
            <div class="ev">${c.events.slice(-3).map(e => `${esc(e.t.slice(11))} — ${esc(e.detail || e.stage)}`).join('<br>')}</div>
          </div>`).join('')}`;
    }
    paint(); setInterval(paint, 3000);
  </script>
</body>
</html>
```

- [ ] **Step 5: Run tests**

Run: `node --check server/mid.js && node --test test/journey.test.js`
Expected: `# pass 5`

- [ ] **Step 6: Commit**

```bash
git add server/mid.js public-mid/index.html test/journey.test.js
git commit -m "Add midhong service: order intake, read endpoints, agent API, monitor page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Settlement callback sender + 60 s sweeper (midhong)

**Files:**
- Modify: `server/mid.js` (the "settlement callback" section and the export line), `docs/superpowers/specs/2026-10-13-midhong-split-design.md` (§5 second bullet)
- Test: `test/journey.test.js` (append)

**Interfaces:**
- Produces: `sendCallback(cmd, delaysMs = [2000,4000,8000,16000,32000,60000], appUrl = APP_URL) → Promise<boolean>`; sets `cmd.callback = {ok, attempts, last_error, inflight}` and adds events; `bridge.state.onSettled = cmd => sendCallback(cmd)`. A sweeper every 60 s re-sends for `stage==='settled' && !callback.ok && !callback.inflight`.
- Callback body: `{order_no, reservation_id, mode, payment_method, salesNum, billNum}` to `POST ${appUrl}/api/bridge/callback` with `Authorization: Bearer BRIDGE_TOKEN`. Success = HTTP 2xx and `body.status !== false`.

- [ ] **Step 1: Append the failing tests**

```js
// test/journey.test.js — append
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/journey.test.js`
Expected: FAIL — `T.mid.sendCallback is not a function`

- [ ] **Step 3: Implement in `server/mid.js`** — replace the placeholder section with:

```js
/* ------------------------------------------------ settlement callback → apphong */
const CALLBACK_DELAYS_MS = [2000, 4000, 8000, 16000, 32000, 60000];
const SWEEP_MS = 60000;

/**
 * Tell apphong the cashier settled this order. Retries with the given delays
 * (attempts = delays.length + 1). Never throws; records cmd.callback.
 */
async function sendCallback(cmd, delaysMs = CALLBACK_DELAYS_MS, appUrl = APP_URL) {
  cmd.callback = cmd.callback || { ok: false, attempts: 0, last_error: null, inflight: false };
  if (cmd.callback.inflight) return false;
  cmd.callback.inflight = true;
  const body = {
    order_no: cmd.order_no, reservation_id: cmd.reservation_id, mode: cmd.mode,
    payment_method: cmd.payment_method || '00', salesNum: cmd.salesNum, billNum: cmd.billNum,
  };
  try {
    for (let i = 0; ; i++) {
      cmd.callback.attempts++;
      try {
        const res = await fetch(appUrl + '/api/bridge/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + BRIDGE_TOKEN },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.status === false) throw new Error(`apphong ${res.status}: ${data.msg || ''}`);
        cmd.callback.ok = true;
        cmd.callback.last_error = null;
        bridge.addEvent(cmd, 'settled', `Callback delivered to apphong (payment ${body.payment_method}${data.msg && data.msg !== 'success' ? ', ' + data.msg : ''})`);
        return true;
      } catch (e) {
        cmd.callback.last_error = e.message;
        if (i >= delaysMs.length) {
          bridge.addEvent(cmd, 'settled', `Callback to apphong failed after ${cmd.callback.attempts} attempt(s): ${e.message} — will retry every ${SWEEP_MS / 1000}s`);
          return false;
        }
        await new Promise(r => setTimeout(r, delaysMs[i]));
      }
    }
  } finally {
    cmd.callback.inflight = false;
  }
}
bridge.state.onSettled = cmd => sendCallback(cmd);

// Re-send callbacks apphong never acknowledged (it was down, or misconfigured).
setInterval(() => {
  for (const c of bridge.state.commands) {
    if (c.stage === 'settled' && c.callback && !c.callback.ok && !c.callback.inflight) sendCallback(c, []);
  }
}, SWEEP_MS).unref();
```

And change the export line to:
```js
module.exports = { start, server, sendCallback };
```

- [ ] **Step 4: Update spec §5** — in `docs/superpowers/specs/2026-10-13-midhong-split-design.md` replace the bullet starting "apphong down at settle →" with:

```
- apphong down at settle → callback retried 6× with backoff 2, 4, 8, 16, 32,
  60 s; result recorded in `cmd.callback`. Recovery: midhong re-sends every
  unacknowledged callback (`stage==='settled' && !callback.ok`) every 60 s
  until apphong answers 2xx — no apphong-side healing, no ack endpoint, works
  with no customer page open.
```

- [ ] **Step 5: Run tests**

Run: `node --check server/mid.js && node --test test/journey.test.js`
Expected: `# pass 7`

- [ ] **Step 6: Commit**

```bash
git add server/mid.js test/journey.test.js docs/superpowers/specs/2026-10-13-midhong-split-design.md
git commit -m "midhong: settlement callback to apphong with retries and 60s re-send sweeper

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: apphong server — bridge client, callback route, proxies, no `/api/pay`

**Files:**
- Modify: `server/index.js` (everything except `serveStatic` is rewritten; see Step 3)
- Test: `test/journey.test.js` (append)

**Interfaces:**
- Consumes: `bridge-client.js` (Task 3), `http-util.js` (Task 1).
- Produces: `module.exports = { start(port?) → Promise<http.Server>, server, settleInKds(payload) }`; auto-starts only when `require.main === module`. `settleInKds({order_no, reservation_id, mode, payment_method, billNum?}) → Promise<{status, msg}>`.

- [ ] **Step 1: Append the failing tests**

```js
// test/journey.test.js — append
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/journey.test.js`
Expected: FAIL — `T.app.start is not a function` (index.js currently listens at require time and does not export `start`).

- [ ] **Step 3: Rewrite `server/index.js`**

Replace everything from the top of the file through the end of `handleApi` with the block below. Keep `serveStatic` exactly as it is. Then replace the tail (`const server = http.createServer(...)` through `server.listen(...)`) with the second block.

```js
'use strict';
/**
 * Hong Chiang Ordering System — app server (apphong).
 *
 * Zero-dependency Node server that:
 *  - serves the ESB-style ordering SPA from /public
 *  - exposes the app API under /api/*
 *  - talks to the Hong-Chiang KDS API either via the built-in mock
 *    (KDS_MODE=mock, default) or a real KDS device (KDS_MODE=real,
 *    KDS_BASE_URL=http://{host}:5500/kds)
 *  - pushes every saved order to the midhong bridge (BRIDGE_URL) and receives
 *    the settlement callback when the ESB cashier finishes the bill.
 *
 * The real KDS API (spec v2.0.1) is read/status-update only — it has no
 * create-order or menu endpoint. The menu catalog and order creation live
 * in this app. Stage 1 is cashier-only: there is no in-app payment.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const kdsMock = require('./kds-mock');
const { send, readBody, bearerOk, requireEnv } = require('./http-util');

requireEnv(['BRIDGE_URL', 'BRIDGE_TOKEN'], 'apphong');
const bridgeClient = require('./bridge-client');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const KDS_MODE = (process.env.KDS_MODE || 'mock').toLowerCase();
const KDS_BASE_URL = (process.env.KDS_BASE_URL || 'http://127.0.0.1:5500/kds').replace(/\/+$/, '');
const CURRENCY = process.env.CURRENCY || 'Rp';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MENU = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'menu.json'), 'utf8'));
const KDS_PATHS = new Set(['walkIns/get', 'tables/search', 'orders/details', 'reservations/update', 'walkIns/update']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** The menu the app serves: ESB-synced catalog (from midhong) wins over the local file. */
async function activeMenu() {
  const esb = await bridgeClient.menu();
  if (esb) return { store: MENU.store, ...esb };
  return { source: 'local', ...MENU };
}

/** Call the KDS backend (mock or real). */
async function kds(relPath, body) {
  if (KDS_MODE === 'real') {
    const res = await fetch(`${KDS_BASE_URL}/${relPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return res.json();
  }
  return kdsMock.handle(relPath, body || {});
}

/**
 * The ESB cashier settled the bill (midhong callback) → close it in the KDS.
 * Returns {status:true, msg:'success'} on success, {status:true, msg:'kds_unknown_order'}
 * when the KDS does not know the order (nothing to heal by retrying), and
 * throws when the KDS itself is unreachable (midhong will retry).
 */
async function settleInKds(p) {
  const out = p.mode === 'dinein' && p.reservation_id
    ? await kds('reservations/update', { id: Number(p.reservation_id), status: 'COMPLETED', payment_method: p.payment_method || '00' })
    : await kds('walkIns/update', { order_no: String(p.order_no), status: 'paid', payment_method: p.payment_method || '00' });
  if (!out || out.status !== true) {
    console.error(`[apphong] settle ${p.order_no}: KDS answered ${JSON.stringify(out)} — acknowledged, not retried`);
    return { status: true, msg: 'kds_unknown_order' };
  }
  console.log(`[apphong] settled ${p.order_no} in KDS (payment ${p.payment_method || '00'}${p.billNum ? ', bill ' + p.billNum : ''})`);
  return { status: true, msg: 'success' };
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\//, '');

  if (req.method === 'GET' && route === 'menu') return send(res, 200, await activeMenu());

  // ---- bridge: read-only proxies to midhong (keeps the SPA on one origin) ----
  if (req.method === 'GET' && route.startsWith('bridge/status')) {
    const orderNo = url.searchParams.get('order_no');
    try {
      const st = orderNo ? await bridgeClient.status(orderNo) : null;
      return send(res, st ? 200 : 404, st || { status: false, msg: 'not_found' });
    } catch (e) {
      return send(res, 503, { status: false, msg: 'bridge unreachable: ' + e.message });
    }
  }
  if (req.method === 'GET' && route === 'bridge/overview') {
    try {
      return send(res, 200, await bridgeClient.overview());
    } catch (e) {
      return send(res, 503, { status: false, msg: 'bridge unreachable: ' + e.message, agent_live: false, simulator: false, esb_menu: null, commands: [] });
    }
  }

  // ---- bridge: settlement callback from midhong (Bearer BRIDGE_TOKEN) ----
  if (req.method === 'POST' && route === 'bridge/callback') {
    if (!bearerOk(req, BRIDGE_TOKEN)) {
      console.error('[apphong] /api/bridge/callback: bad BRIDGE_TOKEN');
      return send(res, 401, { status: false, msg: 'unauthorized' });
    }
    const body = await readBody(req);
    if (!body.order_no) return send(res, 400, { status: false, msg: 'bad payload' });
    try {
      return send(res, 200, await settleInKds(body));
    } catch (e) {
      return send(res, 502, { status: false, msg: 'KDS unreachable: ' + e.message });
    }
  }

  if (req.method === 'GET' && route === 'config') {
    return send(res, 200, {
      currency: CURRENCY,
      kds_mode: KDS_MODE,
      store: MENU.store,
      payment_methods: kdsMock.PAYMENT_METHODS,
      bridge_url: bridgeClient.BRIDGE_URL,
    });
  }

  // Generic KDS passthrough for the five documented endpoints.
  if (req.method === 'POST' && route.startsWith('kds/')) {
    const rel = route.slice(4);
    if (!KDS_PATHS.has(rel)) return send(res, 404, { status: false, msg: 'S00002', data: [] });
    const body = await readBody(req);

    // App-created orders live in the local store; in real mode fall through
    // to the device if the local store does not know the order.
    if (rel === 'orders/details' && KDS_MODE === 'real') {
      const local = kdsMock.handle(rel, body);
      if (local && local.status) return send(res, 200, local);
    }
    try {
      return send(res, 200, await kds(rel, body));
    } catch (e) {
      return send(res, 502, { status: false, msg: 'KDS unreachable: ' + e.message, data: [] });
    }
  }

  // Save Order — creates the KDS order, then pushes it to midhong -> agent -> ESB POS.
  if (req.method === 'POST' && route === 'checkout') {
    const body = await readBody(req);
    if (!Array.isArray(body.meals) || body.meals.length === 0) {
      return send(res, 400, { status: false, msg: 'empty_cart', data: [] });
    }
    const menu = await activeMenu();
    const catalog = new Map(menu.meals.map(m => [m.meal_id, m]));
    let meals;
    try {
      meals = body.meals.map(m => {
        const cat = catalog.get(Number(m.meal_id));
        if (!cat) throw new Error('unknown meal ' + m.meal_id);
        const extras = Number(m.options_price) || 0;
        const catName = (menu.categories.find(c => c.id === cat.category_id) || {}).name || null;
        return {
          meal_id: cat.meal_id, meal_name: cat.meal_name,
          menu_code: cat.menu_code || '',
          quantity: Math.max(1, Number(m.quantity) || 1),
          price: cat.price + extras,
          remarks: String(m.remarks || ''),
          category_id: cat.category_id, category_name: catName,
        };
      });
    } catch (e) {
      return send(res, 400, { status: false, msg: e.message, data: [] });
    }
    const { order, reservation } = kdsMock.createOrder({
      type: body.type === 'dinein' ? 'dinein' : 'walkin',
      table_id: body.table_id, guest_count: body.guest_count,
      customer: body.customer || {}, note: body.note || '', meals,
    });
    const push = await bridgeClient.pushOrder({
      order_no: order.order_no,
      reservation_id: reservation ? reservation.id : null,
      mode: order.type,
      table_name: body.table_name || null,
      pax: body.guest_count,
      customer: body.customer || {},
      note: body.note || '',
      items: meals.map(m => ({
        menu_code: m.menu_code, menu_name: m.meal_name,
        qty: m.quantity, price: m.price, notes: m.remarks,
      })),
      total: Number(order.total_price),
    });
    return send(res, 200, {
      status: true, msg: 'success',
      data: {
        order_no: order.order_no, order_id: order.id,
        reservation_id: reservation ? reservation.id : null,
        total_price: order.total_price,
        local_only: KDS_MODE === 'real',
        bridge_pushed: push.pushed,
      },
    });
  }

  return send(res, 404, { status: false, msg: 'not_found', data: [] });
}
```

Tail (after the unchanged `serveStatic`):

```js
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method === 'GET') return serveStatic(req, res, url);
    return send(res, 405, 'method not allowed', 'text/plain');
  } catch (e) {
    return send(res, 500, { status: false, msg: e.message, data: [] });
  }
});

function start(port = PORT) {
  return new Promise(resolve => {
    server.listen(port, HOST, () => {
      console.log(`Hong Chiang Ordering System listening on http://${HOST}:${server.address().port} (KDS_MODE=${KDS_MODE}${KDS_MODE === 'real' ? ', KDS=' + KDS_BASE_URL : ''}, bridge=${bridgeClient.BRIDGE_URL})`);
      resolve(server);
    });
  });
}

if (require.main === module) start();

module.exports = { start, server, settleInKds };
```

- [ ] **Step 4: Run tests**

Run: `node --check server/index.js && node --test test/journey.test.js`
Expected: `# pass 11`

- [ ] **Step 5: Commit**

```bash
git add server/index.js test/journey.test.js
git commit -m "apphong: talk to midhong over HTTP, add settlement callback route, drop /api/pay

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Journey tests — apphong when midhong is down, env guard

`index.js` reads `BRIDGE_URL` at require time, so these tests spawn apphong as a child process pointed at a dead port.

**Files:**
- Test: `test/journey.test.js` (append)

**Interfaces:**
- Consumes: `server/index.js` CLI start; outbox semantics from Task 3; 503 branches from Task 6.

- [ ] **Step 1: Append the tests**

```js
// test/journey.test.js — append
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
```

- [ ] **Step 2: Run tests**

Run: `node --test test/journey.test.js`
Expected: `# pass 13`. These pass against Task 3/6 code; if one fails, fix the implementation (check that `requireEnv` runs before `require('./bridge-client')` in `index.js`, and the 503 branches), not the test.

- [ ] **Step 3: Commit**

```bash
git add test/journey.test.js
git commit -m "test: apphong behavior when midhong is down (outbox, 503 proxies, env guard)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Full journey tests — dine-in and takeout settle through the callback

**Files:**
- Modify: `package.json` (scripts)
- Test: `test/journey.test.js` (append)

**Interfaces:**
- Consumes: everything above. KDS mock table ids come from `POST /api/kds/tables/search`.

- [ ] **Step 1: Append the tests**

```js
// test/journey.test.js — append
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
```

- [ ] **Step 2: Run tests**

Run: `node --test test/journey.test.js test/bridge.test.js test/bridge-client.test.js test/http-util.test.js`
Expected: `# fail 0`. If `ord.payment_method` is not `'01'`, check `mapPaymentMethod` — "Kartu Debit" must map to `'01'` (no cash/unionpay/install/bonus keyword).

- [ ] **Step 3: Add scripts to `package.json`** — replace the `scripts` block with:

```json
  "scripts": {
    "start": "node server/index.js",
    "start:mid": "node server/mid.js",
    "dev": "node server/dev.js",
    "test": "node --test test/"
  },
```

- [ ] **Step 4: Run `npm test`** (no install needed)

Run: `npm test`
Expected: `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add test/journey.test.js package.json
git commit -m "test: end-to-end dine-in and takeout settlement through midhong callback

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `server/dev.js` — run both processes locally

**Files:**
- Create: `server/dev.js`

**Interfaces:**
- Consumes: `server/index.js`, `server/mid.js` as child processes.
- Produces: `node server/dev.js` starts midhong on `MID_PORT` (3100) and apphong on `PORT` (3000) with dev-default tokens when the env has none; Ctrl-C stops both.

- [ ] **Step 1: Write `server/dev.js`**

```js
// server/dev.js
'use strict';
/**
 * Local two-process runner: midhong (bridge) + apphong (ordering app).
 *   node server/dev.js          # http://localhost:3000 (app), http://localhost:3100 (bridge monitor)
 * Reads .env if present (no dotenv dependency: simple KEY=VALUE lines), then
 * fills dev defaults for anything missing so it works with zero setup.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const env = { ...process.env };
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2];
  }
}
const PORT = env.PORT || '3000';
const MID_PORT = env.MID_PORT || '3100';
Object.assign(env, {
  PORT, MID_PORT,
  BRIDGE_URL: env.BRIDGE_URL || `http://127.0.0.1:${MID_PORT}`,
  APP_URL: env.APP_URL || `http://127.0.0.1:${PORT}`,
  BRIDGE_TOKEN: env.BRIDGE_TOKEN || 'dev-bridge-token',
  AGENT_TOKEN: env.AGENT_TOKEN || 'dev-agent-token',
});

function run(name, file) {
  const child = spawn(process.execPath, [path.join(__dirname, file)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = d => String(d).trimEnd().split('\n').map(l => `[${name}] ${l}`).join('\n') + '\n';
  child.stdout.on('data', d => process.stdout.write(tag(d)));
  child.stderr.on('data', d => process.stderr.write(tag(d)));
  child.on('exit', c => { console.log(`[${name}] exited (${c})`); process.exit(c || 0); });
  return child;
}
const kids = [run('midhong', 'mid.js'), run('apphong', 'index.js')];
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { kids.forEach(k => k.kill()); process.exit(0); });
console.log(`dev: app http://localhost:${PORT}  ·  bridge monitor http://localhost:${MID_PORT}  (AGENT_TOKEN=${env.AGENT_TOKEN})`);
```

- [ ] **Step 2: Verify manually**

Run: `node --check server/dev.js && (node server/dev.js & sleep 2; curl -s localhost:3000/api/config | head -c 200; echo; curl -s localhost:3100/api/health; echo; kill %1)`
Expected: `[midhong] midhong bridge listening…`, `[apphong] Hong Chiang Ordering System listening…`, a config JSON, and `{"ok":true,…}`.

- [ ] **Step 3: Commit**

```bash
git add server/dev.js
git commit -m "Add server/dev.js to run apphong and midhong together locally

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Frontend — Save Order only, cashier card, no pay buttons

**Files:**
- Modify: `public/js/app.js` (lines 3, 63-67, 388-389, 411, 414-439, 441-544, 546-628, 703-709), `public/css/app.css` (append)

**Interfaces:**
- Consumes: `GET /api/bridge/status` fields `stage, pending_push, salesNum, billNum, payment_method, agent_live, simulated, error, events`; `POST /api/kds/orders/details`.
- Produces: routes `home, tables, menu, cart, status, takeout, bridge` (no `payment`).

- [ ] **Step 1: Edit `public/js/app.js`**

Line 3, replace the journey comment with:
```js
 * Journey: home → (dine-in: table + pax | takeout) → menu → cart → Save Order → status (pay at cashier).
```

Lines 63-67, replace the routes with:
```js
const routes = {
  '': renderHome, home: renderHome, tables: renderTables, menu: renderMenu,
  cart: renderCart, status: renderStatus, takeout: renderTakeout,
  bridge: renderBridge,
};
```

Lines 380-389: the block currently reads
```js
      <div class="card pay-detail">
        …
      </div>
    </div>
      <button class="btn-ghost" id="to-pay">Pay Online First (optional)</button>
    </div>
    <div class="footbar">
```
(the stray extra `</div>` closes nothing). Replace lines 387-389 (`    </div>` + button line + `    </div>`) so the block reads:
```js
      <div class="card pay-detail">
        <h3>Payment Details</h3>
        <div class="pd-row"><span class="lbl">Subtotal <span class="muted">(${cartCount()} menu)</span></span><span>${fmt(cartSubtotal())}</span></div>
        <div class="pd-row"><span class="lbl">Rounding</span><span>${fmt(0)}</span></div>
        <div class="pd-row"><span class="lbl">Other fees (10%)</span><span>${fmt(serviceFee())}</span></div>
        <div class="pd-row total"><span>Total</span><span class="val">${fmt(cartTotal())}</span></div>
      </div>
      <p class="muted center" style="font-size:12.5px">Payment is at the cashier after you save the order.</p>
    </div>
    <div class="footbar">
```

Line 411: delete `document.getElementById('to-pay').onclick = () => go('payment');`

Lines 414-439 (`saveOrder`), replace with:
```js
/* Save Order — the only customer action: the order goes to the kitchen (KDS)
 * AND is pushed to midhong -> local agent -> ESB POS (table turns red).
 * Only the ESB cashier can finish it; the status page waits for that. */
async function saveOrder() {
  const btn = document.getElementById('save-order');
  btn.disabled = true; btn.textContent = 'Saving…';
  const out = await api('checkout', {
    type: S.session.mode,
    table_id: S.session.table ? S.session.table.id : null,
    table_name: S.session.table ? S.session.table.name : null,
    guest_count: S.session.pax ? parseInt(S.session.pax) || 2 : 2,
    customer: { name: S.session.custName || 'Guest', phone: S.session.custPhone || '' },
    note: S.session.note || '',
    meals: S.cart.map(i => ({
      meal_id: i.meal_id, quantity: i.qty, options_price: i.options_price,
      remarks: [Object.entries(i.options || {}).map(([g, a]) => a.join(', ')).filter(Boolean).join(' / '), i.remarks].filter(Boolean).join(' · '),
    })),
  });
  if (!out.status) { toast('Save failed: ' + out.msg); btn.disabled = false; btn.textContent = 'Save Order'; return; }
  S.lastOrder = {
    order_no: out.data.order_no, reservation_id: out.data.reservation_id,
    mode: S.session.mode, table: S.session.table, paid: false, total: cartTotal(),
  };
  S.cart = []; save();
  go('status');
}
```

Lines 441-544: delete the whole `/* ---- payment */` section (`function renderPayment() { … }` through its closing `}`).

Lines 546-628 (`renderStatus`), replace with:
```js
/* ------------------------------------------------------------------ status */
/* The "show the cashier" screen: table number (or takeout order no) rendered
 * huge, the bridge timeline underneath, kitchen status from the KDS. Flips to
 * FINISHED / PAID when midhong reports that the ESB cashier settled the bill. */
async function renderStatus() {
  const o = S.lastOrder;
  if (!o) { go('home'); return; }
  const dinein = o.mode === 'dinein' && o.table;
  $app.innerHTML = `
    <div class="topbar"><button class="back" onclick="location.hash='#/home'">←</button><h1 style="text-align:center">Order Status</h1><span style="width:36px"></span></div>
    <div class="wrap">
      <div class="cashier-card" id="cashier-card">
        <div class="cc-label">${dinein ? 'Table 桌號' : 'Takeout 外帶'}</div>
        <div class="cc-big">${esc(dinein ? o.table.name : o.order_no)}</div>
        ${dinein ? `<div class="cc-sub">Order ${esc(o.order_no)}</div>` : ''}
        <div class="cc-total">${fmt(o.total)}</div>
        <div class="cc-msg" id="cc-msg">Please pay at the cashier — show this screen 🙏</div>
      </div>
      <div class="card"><h3 style="font-size:15.5px;font-weight:800;margin-bottom:6px">ESB POS Bridge <span class="muted">(midhong → SQL agent)</span></h3>
        <div id="bridge-live"><div class="center mt8"><span class="spin"></span></div></div>
      </div>
      <div class="card"><h3 style="font-size:15.5px;font-weight:800;margin-bottom:6px">Kitchen Status <span class="muted">(live from KDS)</span></h3>
        <div id="meals-live"><div class="center mt8"><span class="spin"></span></div></div>
      </div>
      <button class="btn-ghost" onclick="location.hash='#/menu'">Order More</button>
      <button class="btn-ghost" onclick="sessionStorage.clear();location.hash='#/home'">New Session</button>
    </div>`;

  const BRIDGE_STAGES = [
    ['queued', '📨', 'Pushed to middleware'],
    ['picked_up', '🤖', 'Local agent picked up'],
    ['table_opened', '🟡', 'SQL: table opened on ESB POS'],
    ['order_saved', '🔴', 'SQL: order saved — table occupied'],
    ['waiting_cashier', '🧑‍💼', 'Waiting for cashier on ESB POS'],
    ['settled', '✅', 'Finished — bill settled on ESB POS'],
  ];
  function markPaid(st) {
    const card = document.getElementById('cashier-card'), msg = document.getElementById('cc-msg');
    if (!card || card.classList.contains('done')) return;
    card.classList.add('done');
    msg.textContent = `FINISHED · PAID ✅  payment ${st.payment_method || ''}${st.billNum ? ' · bill ' + st.billNum : ''}`;
    o.paid = true; save();
  }
  async function pollBridge() {
    const box = document.getElementById('bridge-live');
    if (!box) return;
    let st = null;
    try { st = await api('bridge/status?order_no=' + encodeURIComponent(o.order_no)); } catch (e) { /* keep spinner */ }
    if (!st || !st.stage) { box.innerHTML = `<p class="muted">${st && st.msg ? esc(st.msg) : 'No bridge record for this order.'}</p>`; return; }
    if (st.stage === 'settled') markPaid(st);
    const reached = i => BRIDGE_STAGES.findIndex(s => s[0] === st.stage) >= i || ['voided', 'error'].includes(st.stage);
    box.innerHTML = `
      ${BRIDGE_STAGES.map((s, i) => `
        <div class="bstep ${reached(i) ? 'on' : ''}">
          <span class="bic">${s[1]}</span>
          <span class="btxt">${s[2]}${s[0] === 'queued' && st.pending_push ? '<br><span class="muted">⏳ middleware not reachable yet — retrying</span>' : ''}${s[0] === 'table_opened' && st.salesNum && reached(i) ? `<br><span class="muted">salesNum ${esc(st.salesNum)}</span>` : ''}${s[0] === 'settled' && reached(5) && st.payment_method ? `<br><span class="muted">payment ${esc(st.payment_method)}${st.billNum ? ' · bill ' + esc(st.billNum) : ''}</span>` : ''}</span>
          <span class="bdot">${reached(i) ? '✔' : ''}</span>
        </div>`).join('')}
      ${st.stage === 'voided' ? '<p class="muted mt8">⚠️ Voided by the cashier on ESB POS.</p>' : ''}
      ${st.stage === 'error' ? `<p class="muted mt8">⚠️ Bridge error: ${esc(st.error || '')}</p>` : ''}
      <p class="muted mt8" style="font-size:11.5px">${st.agent_live ? '🟢 live agent connected' : (st.simulated ? '🟠 simulator mode (no live agent)' : '')}</p>`;
  }
  async function poll() {
    pollBridge();
    const out = await api('kds/orders/details', { order_id: o.order_no });
    const box = document.getElementById('meals-live');
    if (!box) return;
    if (!out.status) { box.innerHTML = `<p class="muted">No details (${esc(out.msg)})</p>`; return; }
    const ord = out.data.order;
    box.innerHTML = `
      ${out.data.order_meals.map(m => `
        <div class="meal-status">
          <span>${m.quantity}× ${esc(m.meal_name)}${m.remarks ? `<br><span class="muted">${esc(m.remarks)}</span>` : ''}</span>
          <span class="badge ${esc(m.status)}">${esc(m.status)}</span>
        </div>`).join('')}
      <div class="pd-row total" style="margin-top:8px"><span>Total</span><span class="val">${fmt(Number(ord.total_price))}</span></div>
      <div class="pd-row"><span class="lbl">Order status</span><span><span class="badge ${ord.status === 'paid' ? 'PAID' : 'PREPARING'}">${esc(ord.status)}</span></span></div>`;
  }
  poll();
  S.statusTimer = setInterval(poll, 5000);
}
```

Lines 703-709 (takeout board detail): replace
```js
        ${ord.status !== 'paid' ? `<button class="btn-primary mt8" id="tk-pay" style="margin-top:10px">Mark as Paid (Cash)</button>` : '<p class="center muted mt8">Paid ✓</p>'}
      </div>`;
    const payBtn = document.getElementById('tk-pay');
    if (payBtn) payBtn.onclick = async () => {
      const r = await api('pay', { mode: 'walkin', order_no: ord.order_no, payment_method: '00' });
      if (r.status) { toast('Marked as paid'); renderTakeout(); } else toast('Error: ' + r.msg);
    };
  };
```
with
```js
        <div class="pd-row"><span class="lbl">Status</span><span class="badge ${ord.status === 'paid' ? 'PAID' : 'PREPARING'}">${esc(ord.status)}</span></div>
        <p class="center muted mt8">Settled by the cashier on ESB POS</p>
      </div>`;
  };
```

- [ ] **Step 2: Append the cashier card styles to `public/css/app.css`**

```css
/* ---- "show the cashier" card (status page) ---- */
.cashier-card { background: var(--orange); color: #fff; border-radius: var(--radius); padding: 22px 16px 18px; text-align: center; box-shadow: var(--shadow); }
.cashier-card .cc-label { font-size: 13px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; opacity: .9; }
.cashier-card .cc-big { font-size: clamp(64px, 26vw, 128px); font-weight: 900; line-height: 1.05; letter-spacing: -1px; word-break: break-all; margin: 6px 0; }
.cashier-card .cc-sub { font-size: 14px; font-weight: 700; opacity: .95; }
.cashier-card .cc-total { font-size: 24px; font-weight: 800; margin-top: 10px; }
.cashier-card .cc-msg { font-size: 14px; font-weight: 600; margin-top: 10px; background: rgba(255,255,255,.18); border-radius: 10px; padding: 9px 10px; }
.cashier-card.done { background: var(--green); }
```

- [ ] **Step 3: Verify syntax and in the browser**

Run: `node --check public/js/app.js && grep -c "api('pay'" public/js/app.js`
Expected: `node --check` clean and `0` matches for `api('pay'`.

Then start `node server/dev.js`, open `http://localhost:3000`, Dine In → pick a table → add a meal → cart → **Save Order**. Expected: status page shows the big orange table name, the bridge timeline advancing (simulator), and after ~30 s the card turns green with "FINISHED · PAID". Takeout: big order number instead. Home → Takeout Board → tap an order: no "Mark as Paid" button. Home → Bridge Monitor renders. Open `http://localhost:3100/` → monitor shows the same command with "↩︎ apphong told: ✅".

Playwright (cloud sessions, chromium at `/opt/pw-browsers/chromium`): screenshot the status page at 390×844 before and after settlement; attach to the task report.

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js public/css/app.css
git commit -m "app: Save Order only, show-the-cashier card, remove in-app payment (stage 1)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Deploy assets, env, Docker, docs, CLAUDE.md

**Files:**
- Create: `deploy/hongchiang-mid.service`, `deploy/nginx.midhong.conf`
- Modify: `.env.example`, `docker-compose.yml`, `Dockerfile`, `docs/DEPLOYMENT.md`, `README.md`, `agent/agent.ini.example:1-5`, `agent/README.md:21-22,35`, `CLAUDE.md`

- [ ] **Step 1: `deploy/hongchiang-mid.service`**

```ini
# /etc/systemd/system/hongchiang-mid.service
[Unit]
Description=Hong Chiang ESB bridge middleware (midhong)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/hongchiangorderingsystem
EnvironmentFile=/var/www/hongchiangorderingsystem/.env
ExecStart=/usr/bin/node server/mid.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: `deploy/nginx.midhong.conf`**

```nginx
# /etc/nginx/sites-available/midhong.berkatselalu.com
# Reverse proxy for the ESB bridge middleware (Node on :3100)

server {
    listen 80;
    listen [::]:80;
    server_name midhong.berkatselalu.com;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# After `certbot --nginx -d midhong.berkatselalu.com` runs, certbot rewrites
# this file to add the :443 ssl server block automatically.
```

- [ ] **Step 3: `.env.example`** — replace the file with:

```
# ---- apphong (ordering app, server/index.js) ----
PORT=3000

# KDS_MODE=mock  -> built-in simulator of the Hong-Chiang KDS API (default, no hardware needed)
# KDS_MODE=real  -> forward KDS calls to a real KDS device/server
KDS_MODE=mock
# Base path of the real KDS API (only used when KDS_MODE=real). Per spec: http://{host}:5500/kds/
KDS_BASE_URL=http://192.168.1.50:5500/kds
# Currency prefix used by the frontend price formatter
CURRENCY=Rp

# ---- midhong (ESB bridge middleware, server/mid.js) ----
MID_PORT=3100

# apphong -> midhong (order push, status proxy). Same VPS: loopback.
BRIDGE_URL=http://127.0.0.1:3100
# midhong -> apphong (settlement callback)
APP_URL=http://127.0.0.1:3000
# Shared secret between apphong and midhong (both read it). Generate: openssl rand -hex 24
BRIDGE_TOKEN=change-me-bridge-token
# Shared secret between midhong and the mini-PC agent (agent.ini [webapp] token)
AGENT_TOKEN=change-me-agent-token

# 1 = midhong's built-in simulator advances bridge stages when no live agent is connected
BRIDGE_SIM=1
BRIDGE_SIM_SETTLE_SECONDS=25
```

- [ ] **Step 4: Docker** — replace `docker-compose.yml` with:

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - HOST=0.0.0.0
      - KDS_MODE=${KDS_MODE:-mock}
      - KDS_BASE_URL=${KDS_BASE_URL:-http://192.168.1.50:5500/kds}
      - CURRENCY=${CURRENCY:-Rp}
      - BRIDGE_URL=http://mid:3100
      - BRIDGE_TOKEN=${BRIDGE_TOKEN:-change-me-bridge-token}
  mid:
    build: .
    command: ["node", "server/mid.js"]
    restart: unless-stopped
    ports:
      - "3100:3100"
    environment:
      - MID_PORT=3100
      - HOST=0.0.0.0
      - APP_URL=http://app:3000
      - BRIDGE_TOKEN=${BRIDGE_TOKEN:-change-me-bridge-token}
      - AGENT_TOKEN=${AGENT_TOKEN:-change-me-agent-token}
      - BRIDGE_SIM=${BRIDGE_SIM:-1}
```

`Dockerfile`: add `COPY public-mid ./public-mid` after `COPY public ./public`, and change `EXPOSE 3000` to `EXPOSE 3000 3100`. (`HOST` is honored by both `start()` functions from Tasks 4 and 6; outside Docker it is unset and both bind `127.0.0.1`.)

- [ ] **Step 5: `docs/DEPLOYMENT.md`** — retitle to `# Deploying to your VPS (apphong + midhong)` and:
  - §1: after `sudo cp .env.example .env` change the comment to `# then edit: KDS_MODE, KDS_BASE_URL, BRIDGE_TOKEN, AGENT_TOKEN (openssl rand -hex 24 for each)`.
  - §2 becomes:
    ```bash
    sudo cp deploy/hongchiang.service deploy/hongchiang-mid.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now hongchiang hongchiang-mid
    systemctl status hongchiang hongchiang-mid   # both active (running)
    curl -s localhost:3000/api/config            # apphong
    curl -s localhost:3100/api/health            # midhong
    ```
  - §3: add a second A record `midhong` → same IP; nginx lines for `deploy/nginx.midhong.conf` → `sites-available/midhong.berkatselalu.com`; certbot `sudo certbot --nginx -d midhong.berkatselalu.com --redirect` as a second run.
  - §4: `sudo systemctl restart hongchiang hongchiang-mid`.
  - New §5 "Connect the mini-PC agent": `agent.ini [webapp] url = https://midhong.berkatselalu.com`, token = `AGENT_TOKEN` from `.env`; verify with `curl -s https://midhong.berkatselalu.com/api/health` and the monitor page at `https://midhong.berkatselalu.com/` showing "🟢 live agent connected".

- [ ] **Step 6: `README.md`** — Quick start becomes `node server/dev.js` (both processes) + `npm test`; project layout adds `server/mid.js`, `server/bridge-client.js`, `server/http-util.js`, `server/dev.js`, `public-mid/`, `test/`; App API: remove `POST /api/pay`, add `GET /api/bridge/status|overview` (proxied to midhong) and `POST /api/bridge/callback` (from midhong); in the "ESB POS bridge" section step 3 ends "…it reports back to **midhong**, which calls **apphong** back, and apphong feeds the KDS"; add a "Stage 1 — cashier-only" line: the app has no payment step; only the ESB cashier finishes an order. Env line lists `MID_PORT`, `BRIDGE_URL`, `APP_URL`, `BRIDGE_TOKEN`, `AGENT_TOKEN`, `BRIDGE_SIM`.

- [ ] **Step 7: Agent docs** — `agent/agent.ini.example` lines 1-5 become:
```ini
[webapp]
; the midhong bridge middleware (server/mid.js). Production: https://midhong.berkatselalu.com
url = http://127.0.0.1:3100
; must match AGENT_TOKEN in the VPS .env (read by midhong)
token = change-me-agent-token
```
`agent/README.md` line 21 → `` - `[webapp] url` — the bridge middleware (https://midhong.berkatselalu.com) ``; line 22 → `` - `[webapp] token` — must equal `AGENT_TOKEN` in the VPS `.env` (midhong reads it) ``; line 35 keeps the path, says "(read by the `hongchiang-mid` unit)".

- [ ] **Step 8: `CLAUDE.md`** — update:
  - Journey diagram: `order is queued in the BRIDGE middleware (same webapp process)` → `apphong POSTs the order to the MIDHONG bridge service (server/mid.js, midhong.berkatselalu.com)`; the settle line → `reports "settled" → midhong calls apphong back → apphong feeds the KDS`. Add: `Stage 1 is cashier-only: no in-app payment; only the ESB cashier finishes an order.`
  - Repo map: add `server/mid.js` (midhong entrypoint), `server/bridge-client.js`, `server/http-util.js`, `server/dev.js`, `public-mid/` (monitor page), `test/` (`node --test`), `docs/superpowers/` (specs + plans).
  - Running locally: `node server/dev.js` (both) or `node server/mid.js` + `node server/index.js`; `npm test`. Env list adds `MID_PORT`, `BRIDGE_URL`, `APP_URL`, `BRIDGE_TOKEN`; note both entrypoints refuse to start without their required vars.
  - Deployed at: add `https://midhong.berkatselalu.com` (unit `hongchiang-mid`, port 3100); deploy = `git pull` + `systemctl restart hongchiang hongchiang-mid`.
  - Fact sheet 4: agent API base is **midhong**; add the apphong⇄midhong contract (`POST /api/bridge/orders` idempotent on order_no, `POST /api/bridge/callback`, read proxies, `GET /api/bridge/menu`, callback retry 6× + 60 s sweeper, `cmd.callback {ok, attempts, last_error}`).
  - Testing conventions: `npm test` boots both servers in-process (`test/journey.test.js`); keep it green before any push.
  - Current status: "Done: midhong split (stage 1, cashier-only)"; Open: QRIS/online payment (needs a decision on bridge-side ESB settlement — golden rule 5), plus the existing items.

- [ ] **Step 9: Verify everything once more**

Run: `node --check server/index.js server/mid.js server/bridge.js server/bridge-client.js server/http-util.js server/dev.js public/js/app.js && python3 -m py_compile agent/hc_bridge_agent.py && npm test`
Expected: all checks pass, `# fail 0`. Then `git status` must not list `.env`, `agent/agent.ini`, or `hermes/.env`.

- [ ] **Step 10: Commit**

```bash
git add deploy/hongchiang-mid.service deploy/nginx.midhong.conf .env.example docker-compose.yml Dockerfile docs/DEPLOYMENT.md README.md agent/agent.ini.example agent/README.md CLAUDE.md
git commit -m "Deploy + docs for midhong: systemd/nginx units, env, Docker, agent URL, CLAUDE.md

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## After the last task

1. `git pull --rebase origin claude/bold-davinci-jpzlmi` (never force-push), rerun `npm test`, then push.
2. VPS rollout (operator, in order): add `BRIDGE_URL`, `APP_URL`, `BRIDGE_TOKEN`, `MID_PORT` to `/var/www/hongchiangorderingsystem/.env` (keep the existing `AGENT_TOKEN` so the handed-out `agent.ini` keeps working) → `git pull` → install `hongchiang-mid.service` + `nginx.midhong.conf` + certbot → `systemctl restart hongchiang hongchiang-mid` → check `https://midhong.berkatselalu.com/api/health` and place a test order on apphong.
3. The branch owner changes `agent.ini [webapp] url` to `https://midhong.berkatselalu.com` (the token does not change).
