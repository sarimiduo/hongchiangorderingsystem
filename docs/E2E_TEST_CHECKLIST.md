# End-to-end test checklist — apphong → midhong → local agent → ESB POS

Manual acceptance test of the whole chain, in the order data flows:

```
apphong.backdataon.online   (ordering web app, KDS feed)
  → midhong.backdataon.online (middleware: order queue, agent API, settlement callback)
      → mini-PC agent at the branch (hc_bridge_agent.py)
          → local ESB POS MySQL (tr_saleshead / tr_tableusage / tr_salesmenu)
              → cashier settles on ESB POS → agent reports → midhong → apphong → KDS paid
```

Tick each box, write what you actually saw in the **Record** column. Any
❌ in Part A blocks Part B; any ❌ in Part B blocks Part C.

> Hostnames: this checklist uses `apphong.backdataon.online` and
> `midhong.backdataon.online` as you asked. Whatever the final hostnames are,
> **all four of these must agree** or the chain silently breaks:
> `.env` `BRIDGE_URL` (apphong → midhong), `.env` `APP_URL` (midhong → apphong),
> the nginx `server_name` + certbot cert for each, and `agent.ini [webapp] url`.
> As of 2026-10-13 the VPS is configured for `*.berkatselalu.com`.

---

## 0. Before you start

| # | Item | Have it? |
|---|------|----------|
| 0.1 | `BRIDGE_TOKEN` and `AGENT_TOKEN` values from the VPS `.env` (never paste them in chat/commits) | ☐ |
| 0.2 | A real cashier username from `ms_posuser` (goes in `agent.ini [agent] cashier_username`) | ☐ |
| 0.3 | Mini-PC on the branch LAN with Python 3 + `pymysql`, `agent/hc_bridge_agent.py`, filled `agent.ini` (url = `https://midhong.backdataon.online`, token = AGENT_TOKEN) | ☐ |
| 0.4 | MySQL user for the agent that can SELECT + INSERT/UPDATE on the ESB db (`sushipos` or whatever the branch db is named); a read-only client (HeidiSQL / `mysql` CLI) to verify | ☐ |
| 0.5 | ESB POS app open on the cashier PC, floor plan visible | ☐ |
| 0.6 | Two table names that exist in `ms_table` (flagActive=1) and are BLUE/free, e.g. `T1`, `T2` — write them here: ______ / ______ | ☐ |
| 0.7 | One menu item whose `ms_menu.menuCode` is non-empty and one whose `menuCode` is empty (tests the name fallback) — write them: ______ / ______ | ☐ |
| 0.8 | **Production `.env` has `BRIDGE_SIM=0`.** With `BRIDGE_SIM=1` the simulator fakes settlements whenever the agent heartbeat is older than 30 s — on a real branch that would mark unpaid orders as PAID. (The VPS `.env` currently has `BRIDGE_SIM=1` — change it before Part C.) | ☐ |

---

## Part A — apphong (ordering system)

Run from any laptop/phone. `$APP = https://apphong.backdataon.online`.

| # | Step | Expected | ✅/❌ | Record |
|---|------|----------|------|--------|
| A1 | Open `$APP/` in a browser | Hong Chiang ordering UI loads (store banner, menu), no console errors | ☐ | |
| A2 | `curl -s $APP/api/config` | JSON with currency + mode info, HTTP 200 | ☐ | |
| A3 | `curl -s $APP/api/menu \| head -c 200` | HTTP 200; `"source":"local"` before the agent has ever synced, `"source":"esb"` after (see C4) | ☐ | source = |
| A4 | `curl -s $APP/api/bridge/overview` | **While midhong is up:** HTTP 200 `{"status":true, agent_live:…, commands:[…]}`. **While midhong is down:** HTTP 503 `"bridge unreachable"` with `commands: []` — the app must NOT crash | ☐ | |
| A5 | In the UI: choose **Dine-in**, table = your first free table (0.6), pax 2, add the menuCode item ×2 and the no-menuCode item ×1, add a line note (e.g. "no chili"), press **Save Order** | Status page shows the order number `ORD…` and the "show the cashier" card; no in-app payment button exists | ☐ | order_no = |
| A6 | `curl -s "$APP/api/bridge/status?order_no=<ORD from A5>"` | HTTP 200, `stage` is `queued` or later (`picked_up`, `table_opened`, …); `pending_push` is absent/false | ☐ | stage = |
| A7 | Repeat A5 as **Takeout** (walk-in, no table) | Order saved; status shows `mode: walkin` | ☐ | order_no = |
| A8 | **Outbox test:** stop midhong (`sudo systemctl stop hongchiang-mid` on the VPS), save another dine-in order, then `curl … /api/bridge/status?order_no=…` | Save Order still succeeds (`bridge_pushed:false`), status shows `pending_push:true`; start midhong again (`sudo systemctl start hongchiang-mid`) and within ~30 s the status becomes `queued` (outbox flushed) | ☐ | |
| A9 | VPS: `journalctl -u hongchiang -n 30 --no-pager` | Lines like `[bridge-client] push ORD… delivered`; for A8 `push ORD… failed … queued in outbox` then `delivered after N failed attempt(s)` | ☐ | |

---

## Part B — midhong (middleware)

`$MID = https://midhong.backdataon.online`. Tokens: `$BT` = BRIDGE_TOKEN, `$AT` = AGENT_TOKEN.

| # | Step | Expected | ✅/❌ | Record |
|---|------|----------|------|--------|
| B1 | `curl -s $MID/api/health` | `{"ok":true,"agent_live":false,"queued":N,"app_url":"https://apphong.backdataon.online"}` — check `app_url` is the real apphong host, otherwise callbacks go nowhere | ☐ | app_url = |
| B2 | Open `$MID/` in a browser | Monitor page; shows **⚪ offline** or **🟡 simulator** (no agent yet) and lists the orders from Part A with their stages | ☐ | |
| B3 | `curl -s $MID/api/bridge/overview` | HTTP 200, `commands[]` contains the A5/A7/A8 orders with `mode`, `table_name`, `items`, `stage` | ☐ | |
| B4 | `curl -s "$MID/api/bridge/status?order_no=<A5>"` | Same stage as A6 (apphong is just a proxy of this) | ☐ | |
| B5 | **Auth — bridge token:** `curl -s -o /dev/null -w '%{http_code}\n' -X POST $MID/api/bridge/orders -H 'Authorization: Bearer wrong' -H 'Content-Type: application/json' -d '{}'` | `401` | ☐ | |
| B6 | **Auth — agent token:** `curl -s -o /dev/null -w '%{http_code}\n' $MID/api/bridge/agent/commands -H 'Authorization: Bearer wrong'` | `401` | ☐ | |
| B7 | **Bad payload:** `curl -s -X POST $MID/api/bridge/orders -H "Authorization: Bearer $BT" -H 'Content-Type: application/json' -d '{"order_no":"X"}'` | HTTP 400 `bad payload` (needs order_no + mode + items) | ☐ | |
| B8 | **Idempotency:** push the SAME order twice: `curl -s -X POST $MID/api/bridge/orders -H "Authorization: Bearer $BT" -H 'Content-Type: application/json' -d '{"order_no":"TEST-IDEM-1","mode":"walkin","items":[{"menu_code":"","menu_name":"Test","qty":1,"price":1000}],"total":1000}'` — run it twice | 1st: `status:true`; 2nd: `data.existing:true`; `/api/bridge/overview` lists `TEST-IDEM-1` **once** | ☐ | |
| B9 | **Agent view of the queue:** `curl -s $MID/api/bridge/agent/commands -H "Authorization: Bearer $AT"` | HTTP 200 array of queued commands; each has `id, order_no, mode, table_name, pax, items[{menu_code, menu_name, qty, price, notes}], total` — confirm the A5 note text appears in `items[].notes` | ☐ | |
| B10 | **Callback path (no agent needed):** fake a settlement for the walk-in from A7: `curl -s -X POST $MID/api/bridge/agent/report -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d '{"id":<id of A7 from B9>,"stage":"settled","salesNum":"STEST1","billNum":"TEST001","payment_method_name":"Cash"}'` | HTTP 200 immediately; within a few seconds `$APP/api/bridge/status?order_no=<A7>` shows `stage:"settled"`, `callback.ok:true`, `payment_method:"00"`; the app's status page for A7 shows **FINISHED · PAID ✅** | ☐ | attempts = |
| B11 | VPS: `journalctl -u hongchiang-mid -n 30 --no-pager` and `journalctl -u hongchiang -n 10 --no-pager` | midhong: `queued ORD…`, callback sent; apphong: `settled ORD… in KDS (payment 00…)` | ☐ | |
| B12 | **Callback retry:** stop apphong (`sudo systemctl stop hongchiang`), report `settled` for `TEST-IDEM-1` as in B10, wait 10 s, start apphong again | Report returns 200 even with apphong down; `callback.attempts` > 1 and `callback.ok:true` after apphong is back (retries 2,4,8,16,32,60 s, then 60 s sweeper) | ☐ | attempts = |

---

## Part C — local agent ↔ ESB POS

Run on the mini-PC, in the folder with `hc_bridge_agent.py` and `agent.ini`.
SQL checks run against the branch ESB database (read-only client).
Replace `<ORD>` with the order number you are checking.

### C-prep: schema + menu

| # | Step | Expected | ✅/❌ | Record |
|---|------|----------|------|--------|
| C1 | `python3 hc_bridge_agent.py --config agent.ini --probe` | Every core table prints `N columns`; `tr_saleshead/tr_salesmenu/tr_tableusage/ms_table/ms_menu` must NOT be `MISSING`. One of `ms_transnumber` / `ms_counter` may be MISSING (build-dependent). Last line prints `branchID`, `brand code`, dine-in purpose, takeaway purpose — all non-empty | ☐ | brand = / purposes = |
| C2 | If `brand code` was empty/wrong in C1, set `[agent] brand_code` in `agent.ini` and re-run `--probe` | Brand code matches the `S<BRAND>…` prefix of existing `tr_saleshead.salesNum` rows | ☐ | |
| C3 | `python3 hc_bridge_agent.py --config agent.ini --sync-menu` | Prints `menu sync: {status: true …}` with category + meal counts; no traceback | ☐ | meals = |
| C4 | `curl -s $APP/api/menu \| head -c 300` and reload `$APP/` | `"source":"esb"`; the app shows the ESB menu names/prices; prices match `ms_menu.price` (or the template price when `ms_menu.price` is 0) | ☐ | |

### C-run: live agent

| # | Step | Expected | ✅/❌ | Record |
|---|------|----------|------|--------|
| C5 | `python3 hc_bridge_agent.py --config agent.ini --run` (leave it running in its own window) | Polls every `poll_seconds`; no auth errors | ☐ | |
| C6 | Within 30 s: `curl -s $MID/api/health` and reload `$MID/` | `agent_live:true`; monitor shows **🟢 live agent connected**; simulator label gone | ☐ | |
| C7 | `curl -s $MID/api/bridge/overview \| grep -o '"simulator":[a-z]*'` | `"simulator":false` while the agent heartbeats (even if BRIDGE_SIM=1 — but still set it to 0 in prod, see 0.8) | ☐ | |

### C-dinein: the real journey (TXN A → TXN B → cashier → settled)

Place a fresh **dine-in** order in the app on your second free table (0.6): menuCode item ×2, no-menuCode item ×1, with a line note.

| # | Step | Expected | ✅/❌ | Record |
|---|------|----------|------|--------|
| C8 | Watch the agent window | Command picked up, then stages reported: `picked_up` → `table_opened` → `order_saved` → `waiting_cashier` | ☐ | |
| C9 | ESB POS floor plan (refresh) | Table went **YELLOW** (TXN A) then **RED** (TXN B) within ~10 s | ☐ | |
| C10 | SQL — head: `SELECT salesNum, queueNum, tableID, statusID, subtotal, otherTaxTotal, vatTotal, grandTotal, username, additionalInfo FROM tr_saleshead WHERE additionalInfo = 'HC:<ORD>';` | **Exactly 1 row**; `statusID` in the open set (1/13/15); `username` = your real cashier; `salesNum` = `S<brand><epoch><2 digits>`; `queueNum` = previous max + 1 for today | ☐ | salesNum = |
| C11 | SQL — table usage: `SELECT * FROM tr_tableusage WHERE referenceID = '<salesNum from C10>';` | 1 row, `tableID` = the table you chose (`SELECT tableID FROM ms_table WHERE tableName='…' AND flagActive=1`), `username` = cashier | ☐ | |
| C12 | SQL — lines: `SELECT menuID, qty, price, total, statusID, flagPending, salesType, batchID, notes FROM tr_salesmenu WHERE salesNum = '<salesNum>' ORDER BY batchID, menuID;` | 3 lines (2 distinct menu rows, qty 2 and 1); `statusID=13`, `flagPending=1`, `salesType='POS'`, same `batchID`; the line note text is present; the no-menuCode item resolved by exact `menuName` | ☐ | |
| C13 | SQL — tax math: compare C10 totals with: `subtotal = Σ(price×qty)`, `otherTaxTotal = subtotal × service%`, `vatTotal = dpp × VAT%` using `map_branchvisitpurpose` for this branch + dine-in purpose, `grandTotal` rounded per `ms_setting` POS rounding | Matches to the rupiah (reference: 2×29.000 with VAT 10 % + service 5 % → 58.000 / 2.900 / 6.090 / 66.990) | ☐ | |
| C14 | Open the table on ESB POS as the cashier | The order lines appear exactly as the app sent them (names, qty, note); the cashier can add/discount normally | ☐ | |
| C15 | **Settle it on ESB POS** (Cash) | ESB assigns `billNum`; table turns **BLUE** | ☐ | billNum = |
| C16 | Agent window, within one poll cycle | Reports `settled` with `salesNum`, `billNum`, `payment_method_name` | ☐ | |
| C17 | `curl -s "$MID/api/bridge/status?order_no=<ORD>"` | `stage:"settled"`, `billNum` = C15, `payment_method:"00"` (Cash), `callback.ok:true` | ☐ | |
| C18 | App status page for `<ORD>` + KDS | **FINISHED · PAID ✅**, payment Cash; KDS shows the order closed/paid (dine-in: `reservations/update COMPLETED`) | ☐ | |
| C19 | SQL — nothing the bridge must never touch was touched by it: `SELECT COUNT(*) FROM tr_salespayment WHERE salesNum='<salesNum>';` | Payment rows exist **only because the cashier settled** (created by ESB POS, not before C15). `billNum` on the head was empty until C15 | ☐ | |

### C-takeout

| # | Step | Expected | ✅/❌ | Record |
|---|------|----------|------|--------|
| C20 | Place a **Takeout** order in the app, 1 item | Agent opens a sale with the **takeaway** visit purpose (`--probe` printed it), no `tr_tableusage` row; ESB POS shows it in the takeaway/queue list | ☐ | salesNum = |
| C21 | Settle on ESB POS with a **card** | App → `payment_method:"01"`; KDS `walkIns/update status:paid`; app shows FINISHED · PAID | ☐ | |

### C-robustness

| # | Step | Expected | ✅/❌ | Record |
|---|------|----------|------|--------|
| C22 | **Attach to an occupied table:** with a dine-in order already RED on table X (not yet settled), place a second app order for table X | No second head: `SELECT COUNT(*) FROM tr_saleshead WHERE tableID=<X> AND statusID IN (1,13,15,16,33)` stays 1; the new lines appear on the same `salesNum` with a **new `batchID`**; head totals = both rounds together; both app orders settle when the cashier closes the table | ☐ | |
| C23 | **Re-delivery / restart:** while an order is `waiting_cashier`, Ctrl-C the agent, delete nothing, start `--run` again | No duplicate head/lines (`additionalInfo='HC:<ORD>'` still 1 row); `agent_state.json` keeps the mapping; stage continues to `settled` after the cashier settles | ☐ | |
| C24 | **Unknown table:** push an order via B8-style curl with `"mode":"dinein","table_name":"NOPE-99"` | Agent reports `stage:"error"` with a readable `error`; nothing written to the DB (no head with `HC:` for that order_no); monitor shows the error | ☐ | |
| C25 | **Agent offline:** stop the agent; place an order in the app; wait 60 s | Order stays `queued` on midhong, monitor drops to ⚪/🟡; **no simulator settlement** (BRIDGE_SIM=0); start the agent → it picks the order up and the normal journey continues | ☐ | |
| C26 | **Void:** cashier voids/cancels an open sale on ESB POS instead of paying | Agent reports `voided`; app shows the order as voided, table BLUE | ☐ | |
| C27 | **Day roll-over:** first order of a new business day | `queueNum` restarts at 1 for the new date (compare with ESB's own first sale) | ☐ | |

---

## Sign-off

| | |
|---|---|
| Date / branch / tester | |
| apphong commit (`git rev-parse --short HEAD` on the VPS) | |
| agent version (`head -5 hc_bridge_agent.py`) + ESB build (DB name, `ms_transnumber` or `ms_counter`) | |
| Blocking issues found | |
| Rows left in ESB for cleanup (salesNum list — never delete, let the cashier void) | |
