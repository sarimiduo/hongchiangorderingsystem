<!-- hello from Hongchi -->
# Hong Chiang Ordering System

An ESB-Order-style self-ordering web app ("app simulation") built on top of the
**Hong-Chiang KDS System API v2.0.1**.

Mobile-first UI replicating the ESB Order journey:

```
Home → Dine In (table + pax) / Takeout → Menu (category tabs, package
option-groups) → Cart → Payment → Live order status  +  Takeout board
```

## What the KDS API can (and cannot) support

The KDS API (`http://{host}:5500/kds/`) exposes **5 endpoints**, all `POST`:

| Endpoint | Purpose | Used in this app for |
|---|---|---|
| `walkIns/get` | List open takeout order numbers | **Takeout board** (live walk-in queue) |
| `tables/search` | Tables + status + reservations | **Table selection** (dine-in), live table status |
| `orders/details` | Order header + meals by `table_id` (dine-in) or `order_id` (walk-in) | **Order status page** — live kitchen status per meal (`PREPARING`/`READY`/`SERVED`), totals |
| `reservations/update` | Set reservation status + `payment_method` | **Dine-in payment / close bill** (status `COMPLETED`) |
| `walkIns/update` | Set walk-in order status + `payment_method` | **Takeout payment** (status `paid`) |

Payment method enum (per spec): `00` Cash · `01` Card · `02` Bonus · `03` Installment · `04` UnionPay.

**Important limitation:** the KDS API is *read + status-update only*. It has **no
menu/catalog endpoint and no create-order endpoint** (orders normally come from
the POS). So in this app:

- the **menu catalog** lives in `server/data/menu.json` (modeled on the KDS
  `order_meals` fields: `meal_id`, `meal_name`, `price`, `category_id`,
  `category_name`, …);
- **order creation** (`/api/checkout`) is a simulation hook that injects orders
  into the built-in KDS mock, the way the POS would;
- **everything else** (tables, order details, takeout queue, payment/status
  updates) speaks the real KDS protocol and works against a real device by
  flipping one env var.

## Quick start

```bash
# Node 18+ required, zero npm dependencies
cp .env.example .env
node server/index.js
# open http://localhost:3000
```

### Modes

- `KDS_MODE=mock` (default) — built-in simulator of all 5 KDS endpoints, with
  kitchen progression (`PREPARING → READY → SERVED`) and a seeded walk-in order.
- `KDS_MODE=real` + `KDS_BASE_URL=http://<kds-host>:5500/kds` — the five
  `/api/kds/*` calls are forwarded to the real KDS device. App-created orders
  stay in the local store (the real API cannot accept new orders).

## Project layout

```
server/index.js       zero-dependency HTTP server + app API (/api/*)
server/kds-mock.js    faithful mock of the 5 KDS endpoints + createOrder() sim hook
server/data/menu.json menu catalog (categories, meals, option groups)
public/               the SPA (index.html, css/app.css, js/app.js)
deploy/               nginx + systemd examples for apphong.berkatselalu.com
hermes/               Discord bridge bot for the Hermes agent on the VPS
docs/                 deployment, VPS git workflow, Hermes + Discord setup
```

## App API (what the frontend calls)

- `GET  /api/menu` — catalog
- `GET  /api/config` — currency, mode, payment methods
- `POST /api/kds/{walkIns/get | tables/search | orders/details | reservations/update | walkIns/update}` — KDS passthrough
- `POST /api/checkout` — create order (simulation of POS → KDS)
- `POST /api/pay` — settle: dine-in → `reservations/update {status: COMPLETED}`, takeout → `walkIns/update {status: paid}`

## ESB POS bridge (middleware + local SQL agent)

The simulation journey **Hong Chiang → middleware → ESB POS → cashier →
feedback** is built in:

1. Fill the order in the app → **Save Order** (cart) — the order goes to the
   kitchen (KDS) *and* is pushed to the middleware queue.
2. The **local agent** (`agent/hc_bridge_agent.py`, runs next to the ESB POS)
   polls the queue and writes the ESB database directly:
   TXN A `tr_saleshead` + `tr_tableusage` (table OPEN, yellow), then
   TXN B `tr_salesmenu` + head totals (table OCCUPIED, red) — same menu via
   `menuCode`/name resolution against `ms_menu`.
3. The agent **watches** the sale; when the human cashier settles the bill on
   the ESB POS, it reports back and the webapp feeds the result into the
   Hong Chiang KDS (`reservations/update COMPLETED` / `walkIns/update paid`).
4. Watch it live: the **order status page** shows the bridge timeline; the
   **Bridge Monitor** page (home → Bridge Monitor) shows every order's flow.

Extras: `--sync-menu` imports the real ESB catalog (`ms_menu` + template
prices) so the app sells exactly the POS's menu; with no live agent the
built-in **simulator** (`BRIDGE_SIM=1`, default) advances the stages so the
demo works standalone. Agent setup: `agent/agent.ini.example`; design:
[docs/HC_ESB_SQL_BRIDGE_DESIGN.md](docs/HC_ESB_SQL_BRIDGE_DESIGN.md).

Env: `AGENT_TOKEN` (shared secret for `/api/bridge/agent/*`), `BRIDGE_SIM`,
`BRIDGE_SIM_SETTLE_SECONDS`.

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for putting this on your VPS behind
`apphong.berkatselalu.com` (nginx + Let's Encrypt), and
[docs/VPS_GIT.md](docs/VPS_GIT.md) for the git push/pull workflow between your
workplaces and the VPS.

To let the **Hermes agent** modify this project from Discord chat, see
[docs/HERMES_DISCORD.md](docs/HERMES_DISCORD.md).
