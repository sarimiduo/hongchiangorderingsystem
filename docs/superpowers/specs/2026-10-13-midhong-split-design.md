# midhong split — bridge middleware as its own service (stage 1: cashier-only)

Date: 2026-10-13 · Branch: `claude/bold-davinci-jpzlmi`

## Goal

Run the ESB bridge middleware as its own service at `midhong.berkatselalu.com`
(same VPS, same repo, second Node process) instead of inside the ordering app
process, and change the customer journey so that **saving the order** is the
only customer action and **the ESB cashier is the only one who finishes it**:

```
apphong  → Save Order → KDS order + push to midhong → agent → ESB table RED (same lines)
ESB POS  → cashier settles → agent watcher → midhong → callback → apphong: FINISHED / PAID
```

Decisions taken (and why):
- Same VPS, second nginx vhost, same repo — cheapest; one codebase, two roles.
- Settlement flows back by **push callback** (midhong → apphong), not polling.
- **Single code path**: apphong is always an HTTP client of midhong; no
  in-process fallback (a silent fallback would mask a misconfigured prod `.env`).
- **Stage 1 is cashier-only**: no online/QRIS payment, no self-service
  "I have paid" button. QRIS (and whether the bridge may write ESB settlement)
  is a later stage — golden rule 5 (bridge never writes payments/`billNum`)
  stands.

## 1. Architecture

```
apphong.berkatselalu.com → 127.0.0.1:3000  server/index.js  SPA + KDS proxy/mock + checkout
midhong.berkatselalu.com → 127.0.0.1:3100  server/mid.js    bridge queue + agent API + simulator + monitor
                                                            (mini-PC agent polls midhong over HTTPS)
```

`server/bridge.js` moves wholesale under midhong — queue, stages, simulator,
menu-sync store, payment-name mapping — unchanged in behavior. apphong stops
requiring it and talks HTTP through a new `server/bridge-client.js`.
Both Node processes bind `127.0.0.1`; nginx is the only public surface.

## 2. Interfaces

New shared secret `BRIDGE_TOKEN` (apphong ⇄ midhong, both directions).
`AGENT_TOKEN` (agent ⇄ midhong) is unchanged and only midhong reads it.

### midhong (`server/mid.js`)

| Method/route | Auth | Purpose |
|---|---|---|
| `POST /api/bridge/orders` | Bearer `BRIDGE_TOKEN` | apphong pushes an order. Body = today's `enqueueOrder` ctx: `{order_no, reservation_id, mode, table_name, pax, customer, note, items[{menu_code, menu_name, qty, price, notes}], total}`. Idempotent on `order_no`: re-push returns the existing command (`{status:true, data:{id, stage, existing:true}}`), never a duplicate. |
| `GET /api/bridge/status?order_no=` | none | one command's stage/events (as today) |
| `GET /api/bridge/overview` | none | all commands + agent liveness (as today) |
| `GET /api/bridge/menu` | none | ESB-synced catalog `{source:'esb', categories, meals}` or `{source:null}` |
| `GET /api/bridge/agent/commands` | Bearer `AGENT_TOKEN` | unchanged |
| `POST /api/bridge/agent/report` | Bearer `AGENT_TOKEN` | unchanged |
| `POST /api/bridge/agent/menu` | Bearer `AGENT_TOKEN` | unchanged |
| `POST /api/bridge/agent/heartbeat` | Bearer `AGENT_TOKEN` | unchanged |
| `GET /api/health` | none | `{ok:true, agent_live, queued, app_url}` |
| `GET /` | none | static monitor page `public-mid/index.html` |

On `settled` the command's `onSettled` hook sends the callback below.
`cmd.callback = {ok:boolean, attempts:number, last_error:string|null}` is
recorded and exposed in status/overview.

### apphong (`server/index.js`)

| Method/route | Auth | Purpose |
|---|---|---|
| `POST /api/bridge/callback` | Bearer `BRIDGE_TOKEN` | body `{order_no, reservation_id, mode, payment_method (KDS enum), salesNum, billNum}` → KDS `reservations/update {id, status:'COMPLETED', payment_method}` (dine-in) or `walkIns/update {order_no, status:'paid', payment_method}` (walk-in). Idempotent. |
| `GET /api/bridge/status`, `GET /api/bridge/overview` | none | proxied to midhong (frontend unchanged, no CORS) |
| `GET /api/menu` | none | ESB catalog from midhong `GET /api/bridge/menu`, cached 30 s; falls back to `server/data/menu.json` when midhong is unreachable or has no sync |
| `POST /api/checkout` | none | as today, then `pushOrder` to midhong (see §3) |
| `POST /api/pay` | — | **removed** (cashier-only) |

### Env (one `.env`, read by both systemd units)

```
PORT=3000                 # apphong
MID_PORT=3100             # midhong
BRIDGE_URL=http://127.0.0.1:3100   # apphong → midhong
APP_URL=http://127.0.0.1:3000      # midhong → apphong (callback)
BRIDGE_TOKEN=…            # shared apphong ⇄ midhong
AGENT_TOKEN=…             # shared midhong ⇄ mini-PC agent
BRIDGE_SIM=1  BRIDGE_SIM_SETTLE_SECONDS=25
KDS_MODE, KDS_BASE_URL, CURRENCY   # unchanged
```

Startup guards: `index.js` exits with a clear message without `BRIDGE_URL`
and `BRIDGE_TOKEN`; `mid.js` without `APP_URL`, `BRIDGE_TOKEN`, `AGENT_TOKEN`.

### Agent

No code change. `agent.ini [webapp] url = https://midhong.berkatselalu.com`,
token = midhong's `AGENT_TOKEN`.

## 3. apphong changes

### Frontend (`public/js/app.js`, `public/css/app.css`)

- Cart page: single primary button **Save Order** (today's `saveOrder()`).
  "Pay Online First (optional)" and the `renderPayment` method chooser are
  removed; the `payment` route is dropped.
- Status page becomes the **cashier card**: table name rendered very large
  (fills the phone width), then order no, pax, total, "Please pay at the
  cashier — show this screen". Takeout shows the order number large instead
  of a table. Below it the existing bridge timeline (queued → picked_up →
  table_opened → order_saved → waiting_cashier → settled).
- No `/api/pay` calls anywhere. When the status poll sees `stage === 'settled'`
  the card flips to **FINISHED / PAID** with payment method and bill no.
  `voided` shows the existing warning.
- Takeout list page: "Mark as Paid (Cash)" button removed.
- `#bridge` monitor tab unchanged (served through the proxy).

### Server (`server/index.js`, new `server/bridge-client.js`)

`bridge-client.js` exports `pushOrder(ctx)`, `status(orderNo)`, `overview()`,
`menu()` — `fetch` against `BRIDGE_URL` with `Authorization: Bearer
BRIDGE_TOKEN`, 5 s timeout. It owns a small in-memory **outbox**: if
`pushOrder` fails (network / non-2xx), the ctx is queued and retried every
5 s until accepted; `status(orderNo)` for an order still in the outbox
returns `{stage:'queued', pending_push:true, events:[…]}` so the customer
page shows a sensible first step instead of "no bridge record".

Checkout: create the KDS order as today → `pushOrder`. Checkout succeeds
even if midhong is down (the KDS order exists; the outbox carries the push).

## 4. midhong (`server/mid.js`, `public-mid/index.html`)

Thin zero-dependency HTTP server in the style of `index.js`: the agent
routes move over verbatim, plus `POST /api/bridge/orders`, the read
endpoints, `/api/health`, and the static monitor page. The monitor page is
the overview table already rendered by the app's `#bridge` tab, reimplemented
as a standalone page polling `/api/bridge/overview` every 3 s and showing the
callback result per settled command.

`bridge.state.onSettled` = send callback to `${APP_URL}/api/bridge/callback`.
The built-in simulator stays, suppressed by a live agent heartbeat as today,
so the whole loop demos on the VPS with no agent connected.

## 5. Error handling

- midhong down at checkout → outbox retry (§3); customer sees "queued".
- apphong down at settle → callback retried 6× with backoff 2, 4, 8, 16, 32,
  60 s; result recorded in `cmd.callback`. Recovery: midhong re-sends every
  unacknowledged callback (`stage==='settled' && !callback.ok`) every 60 s
  until apphong answers 2xx — no apphong-side healing, no ack endpoint, works
  with no customer page open.
- Duplicate push / duplicate callback → no-ops (idempotent on `order_no`;
  the KDS update on a completed reservation is harmless).
- Bad token on either side → 401 with `{status:false, msg:'unauthorized'}`
  and a server log line.
- Missing env → process exits at startup with the list of missing names.

## 6. Deploy & docs

- `deploy/hongchiang-mid.service` (`ExecStart node server/mid.js`, same
  `WorkingDirectory` and `EnvironmentFile` as `hongchiang.service`).
- `deploy/nginx.midhong.conf` (proxy to `127.0.0.1:3100`, certbot as before).
- `server/dev.js` starts both processes locally (still no npm install).
- Updated: `.env.example`, `agent/agent.ini.example`, `agent/README.md`,
  `docs/DEPLOYMENT.md`, `README.md`, `CLAUDE.md` (journey, repo map, env,
  bridge contract, "stage 1: cashier-only" status, next steps incl. QRIS).
- Deploy = `git pull`, `systemctl restart hongchiang hongchiang-mid`.

## 7. Testing

- `test/journey.test.js` using `node:test` (Node ≥ 18, zero deps). Boots
  `index.js` and `mid.js` in-process on random ports with `KDS_MODE=mock`,
  `BRIDGE_SIM=0`, and asserts:
  1. checkout → command appears queued on midhong with the same lines/total;
  2. agent `report settled` (with a payment name) → callback → KDS mock order
     is `paid` / reservation `COMPLETED` with the mapped enum;
  3. re-pushing the same `order_no` does not create a second command;
  4. midhong unreachable at checkout → checkout still 200, status shows
     `pending_push`, and after midhong comes up the push lands;
  5. wrong `BRIDGE_TOKEN` → 401 on both sides.
  Tests are written before the implementation (TDD).
- `node --check` every touched JS file; `python3 -m py_compile` untouched agent
  still passes.
- Manual: two-process local loop (`node server/dev.js`), curl checkout,
  watch `/api/bridge/status`; Playwright screenshots of the cashier card
  (mobile viewport) and the midhong monitor page.

## Out of scope (later stages)

- QRIS / online payment (decision pending on whether the bridge may write
  ESB settlement — would need a settle dump diff).
- Takeout visit-purpose verification, production counter table, extras /
  packages, bridge-side promotions, multi-branch — unchanged from CLAUDE.md.
