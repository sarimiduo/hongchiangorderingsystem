# Hong Chiang Ordering System — Project Knowledge Base

You are working on a restaurant self-ordering web app plus a middleware bridge
that mirrors orders into a local **ESB POS** (Indonesian SaaS POS) database.
Everything below was established and verified in previous sessions — trust it,
and keep it updated when you change behavior.

## The journey (what this system does)

```
Customer (Hong Chiang web app, ESB-Order-style UI)
  └─ fills order → Save Order
       ├─ order goes to the Hong Chiang KDS (kitchen display)
       └─ order is queued in the BRIDGE middleware (same webapp process)
            └─ mini-PC AGENT (Python, at the branch) polls the queue over HTTPS
                 ├─ TXN A: opens the table in the ESB POS DB  → floor plan YELLOW
                 ├─ TXN B: writes the order lines + totals    → floor plan RED
                 └─ watches the sale until the human cashier settles it on ESB POS
                      └─ reports "settled" → webapp feeds back into the KDS
                           → app shows order FINISHED/PAID, table freed
```

## Repo map

```
server/index.js        zero-dependency Node HTTP server: static SPA + /api
server/kds-mock.js     faithful mock of the Hong-Chiang KDS API + createOrder() sim hook
server/bridge.js       bridge middleware: command queue, agent API, simulator, KDS feedback
server/data/menu.json  local menu catalog (fallback; ESB-synced menu overrides it)
public/                SPA (index.html, css/app.css, js/app.js — hash router, no build step)
agent/hc_bridge_agent.py  the mini-PC agent (PyMySQL). agent.ini is GITIGNORED (secrets)
agent/README.md        agent setup (Windows Task Scheduler / Linux)
hermes/bot.js          Discord ⇄ agent bridge (this is how you are being driven)
deploy/                nginx + systemd units
docs/                  deep docs: DEPLOYMENT, VPS_GIT, HERMES_DISCORD,
                       ESB_BRIDGE_ANALYSIS, HC_ESB_SQL_BRIDGE_DESIGN
VPS_SETUP.md           full VPS provisioning runbook
```

## Running locally

```bash
node server/index.js          # http://localhost:3000 — no npm install, no build
```

Env (`.env.example`): `PORT`, `KDS_MODE=mock|real`, `KDS_BASE_URL`, `CURRENCY`,
`AGENT_TOKEN` (shared secret for `/api/bridge/agent/*`), `BRIDGE_SIM=1|0`,
`BRIDGE_SIM_SETTLE_SECONDS`. With `BRIDGE_SIM=1` (default) and no live agent,
a built-in simulator advances bridge stages so the whole journey demos
standalone. A live agent heartbeat (last 30s) suppresses the simulator.

Deployed at: `https://apphong.berkatselalu.com` (VPS path
`/var/www/hongchiangorderingsystem`, systemd unit `hongchiang`, nginx reverse
proxy, certbot SSL). Deploy = `git pull` + `systemctl restart hongchiang`.

## Fact sheet 1 — Hong-Chiang KDS API v2.0.1

Base `http://{host}:5500/kds/`, all POST, response `{status, msg, data}`
(failure: `{status:false, msg:"S00001", data:[]}`). **This API documents only
the KDS**, not Hong Chiang's ordering app: there is NO create-order, NO menu
endpoint, NO webhooks (poll only), NO auth.

| Endpoint | Purpose |
|---|---|
| `tables/search` `{}` | tables: id, name, status (IDLE/DINING), sort, seats, reservations[] |
| `walkIns/get` `{}` | `{order_nos: [...]}` open takeout orders |
| `orders/details` `{table_id}` (dine-in, int) or `{order_id}` (walk-in, the order_no string) | order header + order_meals[] (meal statuses PREPARING/READY/SERVED) |
| `reservations/update` `{id, status:"COMPLETED", payment_method}` | close dine-in reservation |
| `walkIns/update` `{order_no, status:"paid", payment_method}` | settle walk-in |

Payment enum: `00` Cash, `01` Card, `02` Bonus, `03` Installment, `04` UnionPay.
The webapp proxies these at `POST /api/kds/<path>`; `KDS_MODE=mock` uses
server/kds-mock.js, `real` forwards to the device. meal_id is read-only and NOT
customizable via this API — menu mapping to ESB uses `menu_code` instead.

## Fact sheet 2 — ESB POS database (MySQL 5.7, db name e.g. `sushipos`)

State machine (from dump diffs — only these matter for the floor plan):
- YELLOW (open, no order): row in `tr_saleshead` (statusID=1, money 0) + row in
  `tr_tableusage (referenceID=salesNum, expiredTime, username)`
- RED (occupied): same salesNum gains `tr_salesmenu` rows (statusID=13
  Preparing, flagPending=1, salesType='POS', batchID per round) and head totals
- BLUE (free): no open head for that tableID

Key formats and facts:
- `salesNum = 'S' + brandCode + unixEpoch + 2 digits` (e.g. SSUSHO17918…).
  `queueNum` increments per business day. `billNum` is assigned by the POS at
  settle, format `branchCode + YYYYMMDD + seq`.
- Floor plan shows `ms_table.tableName`; resolve name → `tableID` (flagActive=1).
- `ms_menu.menuCode` is the stable user-editable mapping key (menuID is just
  auto-increment). menuCodes may be empty — agent falls back to exact menuName.
- Prices: `ms_menu.price`, falling back to `ms_menutemplatedetail.price` for the
  visit purpose's `menuTemplateID` (from `map_branchvisitpurpose`).
- `lk_status`: 1 New, 8 Finished, 10 Full Paid, 12 Cancelled, 13 Preparing,
  14 Served, 15 Billing, 24 Void. Open set used: (1,13,15,16,33); paid set:
  (8,9,10,11,31); void set: (12,24).
- Counter table differs per build: `ms_transnumber` OR `ms_counter` — always
  probe `information_schema` first; column names drift too (e.g.
  ms_menucategorydetail key is `ID` on this build).
- NEVER written by the bridge (POS/app-logic owns them): billNum, payments,
  `tr_kitchen_order`, all `tr_eso*` queues, `tr_websocket`, stock movement,
  counter audit tables.

## Fact sheet 3 — tax math (verified to the rupiah against the DB)

From vendor `CalculateTotal.php` + `map_branchvisitpurpose`
(branchID+visitPurposeID → `taxValue` VAT %, `additionalTaxValue` service %,
`flagOtherTaxVat`, `orderFee`, `menuTemplateID`) and `ms_setting`
(VAT/DPP Calculation Ratio value1/value2; POS/Rounding Nearest Value + Mode):

```
per line: lineTotal = price*qty
  otherVal = flagOtherTax(menu) ? lineTotal * additionalTax% : 0
  dpp      = lineTotal + (flagOtherTaxVat ? otherVal : 0)
  dpp     *= dppRatio          # unless menu.flagLuxuryItem
  vatVal   = flagTax(menu) ? dpp * taxValue% : 0
head (recomputed from line aggregates, so multi-batch stays correct):
  subtotal=Σtotal, otherTaxTotal=Σother, vatTotal=Σvat
  grandTotal = round(subtotal+otherTaxTotal+vatTotal+orderFee) per POS rounding
```

Verified: untaxed menu → exact dump row shape; VAT 10% + service 5% on
2×29.000 → 58.000 / 2.900 / 6.090 / 66.990. Discounts/promos/vouchers are NOT
written by the bridge — the cashier applies them at settle; the watcher reads
final amounts regardless. (For bridge-side promos you'd need vendor
SalesHead::calculateArrayHeadTotal — not available yet.)

## Fact sheet 4 — bridge contract (webapp ⇄ agent)

Stages: `queued → picked_up → table_opened → order_saved → waiting_cashier →
settled | voided | error`. Commands kept in-memory (last 200) in
server/bridge.js.

Agent API (header `Authorization: Bearer <AGENT_TOKEN>`):
- `GET  /api/bridge/agent/commands` → queued commands
  `{id, order_no, mode(dinein|walkin), table_name, pax, customer, note, items:[{menu_code, menu_name, qty, price, notes}], total}`
- `POST /api/bridge/agent/report` `{id, stage, salesNum?, billNum?, payment_method_name?, detail?, error?}`
  — on `settled` the webapp maps the ESB payment name → KDS enum
  (cash/tunai→00, unionpay→04, install→03, bonus→02, else 01) and calls the
  KDS update endpoint automatically.
- `POST /api/bridge/agent/menu` — menu sync payload `{categories, meals}`;
  when present it REPLACES the app's catalog (`/api/menu` source:"esb").
- `POST /api/bridge/agent/heartbeat`

Public (frontend): `GET /api/bridge/status?order_no=…`, `GET /api/bridge/overview`.

Agent golden rules (inherited from the production Posmid replication middleware):
1. MySQL **5.7-safe SQL only** (no CTEs/window functions). MariaDB test rigs
   accept more than real MySQL 5.7 — passing tests is not proof.
2. Probe `information_schema` before any non-core table/column; degrade
   gracefully (the generic `Db.insert()` fills NOT-NULL-no-default columns).
3. Whole order or nothing — one DB transaction per TXN, rollback on error.
4. Idempotent: `additionalInfo='HC:<order_no>'` marker + local state file;
   re-delivered commands never duplicate. If a table already has an open head,
   ATTACH (new batchID) instead of opening a second head.
5. Writes stamped with a REAL cashier username from `ms_posuser` — never a
   "MIDDLEWARE" label. Never modify vendor PHP. Origin data is never deleted.

## Testing conventions (do this before any push)

- `node --check` every touched JS file; `python3 -m py_compile` the agent.
- Full local test loop: start `node server/index.js`, curl `/api/checkout`,
  watch `/api/bridge/status` (simulator) — or load an ESB dump into local
  MariaDB and run the real agent (`--probe`, `--sync-menu`, `--run`).
- UI changes: drive with Playwright headless (chromium at
  `/opt/pw-browsers/chromium` in cloud sessions) and screenshot.
- SECRETS: `agent/agent.ini`, `.env`, `hermes/.env` are gitignored — never
  commit them, never print their contents into chat/commits.
- Git: ALWAYS `git pull` before pushing (a past race on this branch produced a
  remote commit that had lost its content — merge carefully, never force-push).
  Work happens on the branch the user names; don't create PRs unless asked.

## Current status & likely next steps

Done and verified end-to-end: app UI (ESB-Order-style journey), KDS mock+proxy,
bridge queue + simulator + monitor page, agent TXN A/B with real tax math,
settlement watcher, KDS feedback, menu sync from ESB, deployment assets, Hermes
Discord bridge. The mini-PC agent package was handed to the owner with a filled
agent.ini (token matches the VPS `.env` AGENT_TOKEN).

Open/likely asks:
- Takeout variant polish on ESB side (visit purpose per mode is implemented;
  verify against a real takeaway purpose row).
- Production counter: switch queueNum from MAX+1 to the build's counter table
  (`ms_transnumber` here / `ms_counter` elsewhere) under a row lock.
- Extras/packages: app option-groups currently flow as line notes; writing
  `tr_salesmenuextra` / package children (menuRefID/menuGroupID) is designed in
  docs/HC_ESB_SQL_BRIDGE_DESIGN.md but not implemented.
- Bridge-side promotions (needs vendor SalesHead.php).
- Multi-branch: one agent+token per branch; consider a real `midhong.` split
  only then.
