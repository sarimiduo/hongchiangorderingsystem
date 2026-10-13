<!-- hello from Hongchi -->
# Hong Chiang Ordering System

An ESB-Order-style self-ordering web app ("app simulation") built on top of the
**Hong-Chiang KDS System API v2.0.1**, plus **midhong**, the bridge middleware
that mirrors every saved order into the ESB POS at the branch.

Mobile-first UI replicating the ESB Order journey:

```
Home → Dine In (table + pax) / Takeout → Menu (category tabs, package
option-groups) → Cart → Save Order → "show the cashier" status page  +  Takeout board
```

**Stage 1 — cashier-only:** the app has no payment step. The customer saves
the order and shows the status screen (big table number / order number) to the
cashier; only the ESB cashier finishes an order, and the app flips to
FINISHED · PAID when that happens.

## What the KDS API can (and cannot) support

The KDS API (`http://{host}:5500/kds/`) exposes **5 endpoints**, all `POST`:

| Endpoint | Purpose | Used in this app for |
|---|---|---|
| `walkIns/get` | List open takeout order numbers | **Takeout board** (live walk-in queue) |
| `tables/search` | Tables + status + reservations | **Table selection** (dine-in), live table status |
| `orders/details` | Order header + meals by `table_id` (dine-in) or `order_id` (walk-in) | **Order status page** — live kitchen status per meal (`PREPARING`/`READY`/`SERVED`), totals |
| `reservations/update` | Set reservation status + `payment_method` | **Close the dine-in bill** (status `COMPLETED`) when the ESB cashier settles |
| `walkIns/update` | Set walk-in order status + `payment_method` | **Close the takeout order** (status `paid`) when the ESB cashier settles |

Payment method enum (per spec): `00` Cash · `01` Card · `02` Bonus · `03` Installment · `04` UnionPay.

**Important limitation:** the KDS API is *read + status-update only*. It has **no
menu/catalog endpoint and no create-order endpoint** (orders normally come from
the POS). So in this app:

- the **menu catalog** lives in `server/data/menu.json` (modeled on the KDS
  `order_meals` fields: `meal_id`, `meal_name`, `price`, `category_id`,
  `category_name`, …) — overridden by the ESB catalog once the agent syncs it;
- **order creation** (`/api/checkout`) is a simulation hook that injects orders
  into the built-in KDS mock, the way the POS would;
- **everything else** (tables, order details, takeout queue, status updates)
  speaks the real KDS protocol and works against a real device by flipping one
  env var.

## Quick start

```bash
# Node 18+ required, zero npm dependencies
cp .env.example .env
node server/dev.js        # apphong on :3000 + midhong on :3100 (dev tokens filled in if .env has none)
# open http://localhost:3000 (app) and http://localhost:3100 (bridge monitor)
npm test                  # boots both servers in-process and runs the whole journey
```

### Modes

- `KDS_MODE=mock` (default) — built-in simulator of all 5 KDS endpoints, with
  kitchen progression (`PREPARING → READY → SERVED`) and a seeded walk-in order.
- `KDS_MODE=real` + `KDS_BASE_URL=http://<kds-host>:5500/kds` — the five
  `/api/kds/*` calls are forwarded to the real KDS device. App-created orders
  stay in the local store (the real API cannot accept new orders).

## Project layout

```
server/index.js        apphong: zero-dependency HTTP server, static SPA + app API (/api/*)
server/mid.js          midhong: the ESB bridge middleware as its own process (+ monitor page)
server/bridge.js       bridge core: command queue, stages, simulator, ESB menu store
server/bridge-client.js apphong → midhong client (push with outbox retry, status/overview/menu)
server/http-util.js    send/readBody/bearerOk/requireEnv shared by both servers
server/dev.js          runs apphong + midhong together locally
server/kds-mock.js     faithful mock of the 5 KDS endpoints + createOrder() sim hook
server/data/menu.json  menu catalog (categories, meals, option groups)
public/                the SPA (index.html, css/app.css, js/app.js)
public-mid/            midhong's standalone bridge monitor page
test/                  node:test suites (test/journey.test.js boots both servers)
agent/                 the mini-PC agent that writes the ESB POS database
deploy/                nginx + systemd units for apphong + midhong
hermes/                Discord bridge bot for the Hermes agent on the VPS
docs/                  deployment, VPS git workflow, Hermes + Discord setup, bridge design
```

## App API (what the frontend calls)

- `GET  /api/menu` — catalog (ESB-synced from midhong when available, else local)
- `GET  /api/config` — currency, mode, payment methods, bridge URL
- `POST /api/kds/{walkIns/get | tables/search | orders/details | reservations/update | walkIns/update}` — KDS passthrough
- `POST /api/checkout` — Save Order: create the KDS order and push it to midhong
- `GET  /api/bridge/status?order_no=…`, `GET /api/bridge/overview` — proxied to midhong (503 when it is down)
- `POST /api/bridge/callback` — from midhong (Bearer `BRIDGE_TOKEN`): the ESB cashier settled → close the order in the KDS

## ESB POS bridge (midhong + local SQL agent)

The journey **Hong Chiang → midhong → ESB POS → cashier → feedback** is built in:

1. Fill the order in the app → **Save Order** (cart) — the order goes to the
   kitchen (KDS) *and* apphong pushes it to **midhong** (`server/mid.js`, its
   own process; retried from an outbox if midhong is down).
2. The **local agent** (`agent/hc_bridge_agent.py`, runs next to the ESB POS)
   polls midhong and writes the ESB database directly:
   TXN A `tr_saleshead` + `tr_tableusage` (table OPEN, yellow), then
   TXN B `tr_salesmenu` + head totals (table OCCUPIED, red) — same menu via
   `menuCode`/name resolution against `ms_menu`.
3. The agent **watches** the sale; when the human cashier settles the bill on
   the ESB POS, it reports back to **midhong**, which calls **apphong** back,
   and apphong feeds the KDS (`reservations/update COMPLETED` /
   `walkIns/update paid`). Missed callbacks are re-sent every 60 s.
4. Watch it live: the **order status page** shows the cashier card and the
   bridge timeline; the **Bridge Monitor** (home → Bridge Monitor, or
   midhong's own page on `:3100`) shows every order's flow.

Extras: `--sync-menu` imports the real ESB catalog (`ms_menu` + template
prices) so the app sells exactly the POS's menu; with no live agent the
built-in **simulator** (`BRIDGE_SIM=1`, default) advances the stages so the
demo works standalone. Agent setup: `agent/agent.ini.example`; design:
[docs/HC_ESB_SQL_BRIDGE_DESIGN.md](docs/HC_ESB_SQL_BRIDGE_DESIGN.md).

Env: `MID_PORT`, `BRIDGE_URL` (apphong → midhong), `APP_URL` (midhong → apphong),
`BRIDGE_TOKEN` (shared by both servers), `AGENT_TOKEN` (midhong ⇄ agent),
`BRIDGE_SIM`, `BRIDGE_SIM_SETTLE_SECONDS`. Both servers refuse to start
without their required variables.

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for putting this on your VPS behind
`apphong.berkatselalu.com` + `midhong.berkatselalu.com` (nginx + Let's Encrypt), and
[docs/VPS_GIT.md](docs/VPS_GIT.md) for the git push/pull workflow between your
workplaces and the VPS.

To let the **Hermes agent** modify this project from Discord chat, see
[docs/HERMES_DISCORD.md](docs/HERMES_DISCORD.md).
