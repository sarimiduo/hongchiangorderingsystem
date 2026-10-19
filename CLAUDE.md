# Hong Chiang Ordering System — Project Knowledge Base

You are working on a restaurant self-ordering web app plus a middleware bridge
that mirrors orders into a local **ESB POS** (Indonesian SaaS POS) database.
Everything below was established and verified in previous sessions — trust it,
and keep it updated when you change behavior.

**Brands, do not mix them up:** **Hong Chiang** is the SaaS vendor (its KDS /
kitchen-display API is what the app feeds and what the bridge reads); **ESB** is the
other SaaS (the POS/till). The restaurant whose name is on the customer-facing app is
**Edo Sushi**, a kaiten (conveyor-belt) sushi place with coloured plates at set prices
(red Rp15.000 … gold Rp40.000, sample tiers in `server/data/menu.json`). The value of
this repo is the middleware between the two SaaS systems.

## The journey (what this system does)

```
Customer (Edo Sushi web app on the Hong Chiang SaaS)
  └─ fills order → Save Order
       ├─ order goes to the Hong Chiang KDS (kitchen display)
       └─ apphong POSTs the order to the MIDHONG bridge service (server/mid.js, midhong.berkatselalu.com)
            └─ mini-PC AGENT (Python, at the branch) polls the queue over HTTPS
                 ├─ TXN A: opens the table in the ESB POS DB  → floor plan YELLOW
                 ├─ TXN B: writes the order lines + totals    → floor plan RED
                 └─ watches the sale until the human cashier settles it on ESB POS
                      └─ reports "settled" → midhong calls apphong back → apphong feeds the KDS
                           → app shows order FINISHED/PAID, table freed
```

Stage 1 is cashier-only: no in-app payment; only the ESB cashier finishes an order.

## Repo map

```
server/index.js        apphong: zero-dependency Node HTTP server, static SPA + /api; HTTP client of midhong
server/mid.js          midhong entrypoint: order intake, agent API, settlement callback + sweeper, monitor page
server/bridge.js       bridge core (loaded only by mid.js): command queue, stages, simulator, ESB menu store
server/bridge-client.js apphong → midhong client: pushOrder (outbox retry), status, overview, menu (30 s cache)
server/http-util.js    send/readBody/bearerOk/requireEnv shared by both entrypoints
server/dev.js          runs both processes locally
server/kds-mock.js     faithful mock of the Hong-Chiang KDS API + createOrder() sim hook
server/data/menu.json  local menu catalog (fallback; ESB-synced menu overrides it)
public/                SPA (index.html, css/app.css, js/app.js — hash router, no build step)
public/img/            found, credited pictures + the footer clip (credits.json = licences; see "UI design")
public-mid/            midhong's standalone monitor page (served on midhong "/")
test/                  node:test suites; test/journey.test.js boots both servers in-process
agent/hc_bridge_agent.py  the mini-PC agent (PyMySQL). agent.ini is GITIGNORED (secrets)
agent/README.md        agent setup (Windows Task Scheduler / Linux)
hermes/bot.js          Discord ⇄ agent bridge (this is how you are being driven)
deploy/                nginx + systemd units (hongchiang = apphong, hongchiang-mid = midhong)
docs/                  deep docs: DEPLOYMENT, VPS_GIT, HERMES_DISCORD,
                       ESB_BRIDGE_ANALYSIS, HC_ESB_SQL_BRIDGE_DESIGN,
                       E2E_TEST_CHECKLIST (manual acceptance test, app→mid→agent→ESB)
docs/superpowers/      design specs + implementation plans (midhong split)
VPS_SETUP.md           full VPS provisioning runbook
```

## Running locally

```bash
node server/dev.js            # both: app http://localhost:3000, bridge monitor http://localhost:3100
# or separately: node server/mid.js  +  node server/index.js
npm test                      # node --test test/ — boots both servers in-process, runs the journey
```

Env (`.env.example`): apphong — `PORT`, `KDS_MODE=mock|real`, `KDS_BASE_URL`,
`CURRENCY`, `BRIDGE_URL`, `BRIDGE_TOKEN`; midhong — `MID_PORT`, `APP_URL`,
`BRIDGE_TOKEN`, `AGENT_TOKEN` (shared secret for `/api/bridge/agent/*`),
`BRIDGE_SIM=1|0`, `BRIDGE_SIM_SETTLE_SECONDS`. Both entrypoints refuse to start
without their required vars (`index.js`: BRIDGE_URL+BRIDGE_TOKEN; `mid.js`:
APP_URL+BRIDGE_TOKEN+AGENT_TOKEN); `dev.js` fills dev defaults. With
`BRIDGE_SIM=1` (default) and no live agent, midhong's simulator advances bridge
stages so the whole journey demos standalone. A live agent heartbeat (last 30s)
suppresses the simulator. Both bind `127.0.0.1` (`HOST` overrides, Docker only).

Deployed at: `https://apphong.berkatselalu.com` (apphong, unit `hongchiang`,
port 3000) and `https://midhong.berkatselalu.com` (midhong, unit
`hongchiang-mid`, port 3100) — nginx reverse proxies, certbot SSL.
**Actual VPS checkout: `/home/dewa-dev/work/hongchiang-esb`, owned by user
`dewa-dev`** (the docs' `/var/www/...` is the generic example — adjust paths).
Deploy = plain `git pull` as dewa-dev (NO `sudo -u www-data`, it triggers
git's dubious-ownership refusal) + `sudo systemctl restart hongchiang
hongchiang-mid`. The systemd units' WorkingDirectory/User must match that
checkout and user.

## UI design (apphong SPA, redesigned 2026-10-14/15 with the `design-taste-frontend` skill)

Idea (Edo Sushi, 2026-10-15): the stack of coloured plates, the kaiten bill counted by
colour at the end, is the interface — every item is a plate of one colour (`meal.plate`,
else the price tier from `store.plates`), the slip is "your stack" (drawn flat in the
plates' real colours), the status screen is the stack beside the table number huge in red.
Direction "the split stage" (seed 1729440213): paper sheet column + sticky photo panel
(`.stage > .sheet + .still`), single column under 900px. Tokens in `public/css/app.css`
`:root` (ground white, surface #ebebea, ink, muted, accent red only on the primary button
and the table number; `--plate-*` for the plates). Type: Besley 800 (display) + Libre
Franklin (text), Noto Serif/Sans JP for Japanese glyphs. House rules: no emoji, gradients,
shadows at rest, hairlines, pill badges, eyebrow labels. Pictures in `public/img/` are
open-collection finds (Hiroshige's Edo prints from the Art Institute of Chicago and the
Met, CC0; a real plate stack from Commons, BY-SA; the "Moving Sushi" clip), credited in
the home footer and `credits.json`; they show the world around the restaurant, never its
own dishes. (The earlier Taiwanese 點餐單 idea and pictures, 2026-10-14, were a wrong reading
of the brand and were removed; `credits.json` still lists them as history.)
Deep links: `#/menu?mode=dinein&table=5` (QR on a table), `#/menu?mode=walkin`,
`#/status?order_no=ORD…`. Design notes + critique: `.taste-skill/notes.md`.
Rounds: every Save Order is one round of the visit (sessionStorage `hc_orders`, same mode +
table); the status screen lists them ("First order", "Second order"…) with the table total,
and "Add another round" sends the guest back to the belt. Each round is its own KDS order
and bridge command; the agent attaches it to the open ESB head as a new batch.
The midhong monitor (`public-mid/index.html`, single file, same tokens) follows the direction
"the product performs": the live ticket on the rail, an orders-by-hour chart, stage tabs +
banded rows; `mid.js` serves `/img/*` from `public/img` so it reuses the credited pictures.
`.taste-skill/direction.json` holds only the last draw (the monitor's); seeds are in the notes.
Gate (Node 20 on the VPS): `node --experimental-websocket <skill>/scripts/inspect.mjs
http://127.0.0.1:3005/ --out .taste-skill/inspect-home` with
`CHROME_PATH=~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome` and
`CHROME_ARGS="--no-sandbox --disable-gpu --disable-dev-shm-usage"`; run the dev copy on
spare ports first (`PORT=3005 MID_PORT=3105 BRIDGE_URL=http://127.0.0.1:3105
APP_URL=http://127.0.0.1:3005 node server/dev.js`) so nothing leaks into the live queue.

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
VERIFIED against the vendor's test device (192.168.100.200:5500, 2026-10-19,
sample in docs/vendor-samples/): response shapes match the spec exactly, no
auth, table names are mixed numeric/alphanumeric ("5", "A05"). One difference
from our mock: the real `tables/search` INCLUDES past COMPLETED reservations
in `reservations[]` — any consumer (esp. a future KDS poller) must filter by
reservation status itself, never assume the array holds only open ones.
The vendor's official integration flows (WhatsApp, 2026-10-19) confirm the
pull model: the POS polls tables/search + orders/details and settles via
reservations/update / walkIns/update — no push API or webhook exists.
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

## Fact sheet 4 — bridge contract (apphong ⇄ midhong ⇄ agent)

Stages: `queued → picked_up → table_opened → order_saved → waiting_cashier →
settled | voided | error`. Commands kept in-memory (last 200) in
server/bridge.js, which only midhong loads.

apphong ⇄ midhong (header `Authorization: Bearer <BRIDGE_TOKEN>` both ways):
- `POST {BRIDGE_URL}/api/bridge/orders` — apphong pushes
  `{order_no, reservation_id, mode, table_name, pax, customer, note, items, total}`;
  idempotent on `order_no` (`data.existing:true` on a re-push); `400 bad payload`
  without order_no/mode/items. apphong keeps an outbox and retries when midhong
  is down (`bridge_pushed:false`, status `pending_push:true`).
- `POST {APP_URL}/api/bridge/callback` — midhong tells apphong the cashier
  settled: `{order_no, reservation_id, mode, payment_method, salesNum, billNum}`;
  apphong closes the KDS order and answers `{status:true, msg:'success'}` — or
  `msg:'kds_unknown_order'` (also status:true, so midhong stops retrying).
  midhong retries 6× (2,4,8,16,32,60 s) and a 60 s sweeper re-sends anything
  still unacknowledged; result in `cmd.callback {ok, attempts, last_error}`.
- `GET /api/bridge/status?order_no=…`, `GET /api/bridge/overview`,
  `GET /api/bridge/menu`, `GET /api/bridge/tables` — public reads on midhong;
  apphong proxies the first two for the SPA (503 `bridge unreachable` with
  `commands: []` when down), uses the third as its catalog (30 s cache) and, in
  KDS mock mode only, feeds the fourth into kds-mock.setTables() before every
  `tables/search` (30 s cache; tables matched by NAME so open reservations
  survive; a real KDS device owns its own table list).

Agent API — base is **midhong** (header `Authorization: Bearer <AGENT_TOKEN>`):
- `GET  /api/bridge/agent/commands` → queued commands
  `{id, order_no, mode(dinein|walkin), table_name, pax, customer, note, items:[{menu_code, menu_name, qty, price, notes}], total}`
- `POST /api/bridge/agent/report` `{id, stage, salesNum?, billNum?, payment_method_name?, detail?, error?}`
  — on `settled` midhong maps the ESB payment name → KDS enum
  (cash/tunai→00, unionpay→04, install→03, bonus→02, else 01) and sends the
  callback to apphong, which calls the KDS update endpoint.
- `POST /api/bridge/agent/menu` — menu sync payload `{categories, meals}`;
  when present it REPLACES the app's catalog (`/api/menu` source:"esb").
- `POST /api/bridge/agent/tables` — table sync payload
  `{tables:[{table_id, table_name, seats}]}` from `ms_table` (flagActive=1);
  when present it replaces the app's floor plan (see `GET /api/bridge/tables`).
  The agent pushes menu + tables at startup and every `menu_sync_minutes`
  (agent.ini, default 10, 0 = manual `--sync-menu` / `--sync-tables` only).
- `POST /api/bridge/agent/heartbeat`

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
- `npm test` (`node --test test/`) boots apphong + midhong in-process
  (`test/journey.test.js`) and runs the whole journey; keep it green before
  any push. Manual loop: `node server/dev.js`, curl `/api/checkout`, watch
  `/api/bridge/status` (simulator) — or load an ESB dump into local MariaDB and
  run the real agent (`--probe`, `--sync-menu`, `--run`).
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
agent.ini (token matches the VPS `.env` AGENT_TOKEN). Done: midhong split
(stage 1, cashier-only) — bridge runs as its own service, apphong talks to it
over HTTP, settlement comes back through the callback; `npm test` covers it
(spec + plan in docs/superpowers/). VPS rollout of midhong (env vars, unit,
nginx, certbot, agent.ini url) is an operator step — see docs/DEPLOYMENT.md §5.

Open/likely asks:
- QRIS/online payment in the app (needs a decision on bridge-side ESB
  settlement — golden rule 5 says the bridge never writes payments).
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
