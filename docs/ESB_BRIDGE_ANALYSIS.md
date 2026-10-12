# Middleware Analysis — Hong Chiang ⇄ ESB POS Bridge

Analysis of the two ESB POS dumps (`sushipos` MySQL 5.7 schema, ~190 tables)
against the Hong-Chiang KDS API v2.0.1, for a local middleware that mirrors
Hong Chiang orders into the ESB POS as table states.

## 1. What changes in the ESB database between the two states

Diffing `opentablenoorder.sql` vs `tableoccupied.sql`, only **5 tables** differ,
and only 3 carry the state machine:

| Table | Open table, no order (YELLOW) | Occupied with order (RED) |
|---|---|---|
| `tr_saleshead` | 1 row: `salesNum`, `tableID`, `paxTotal`, `visitPurposeID=1` (DINE IN), `statusID=1` (New), **all money columns 0** | Same row updated: `subtotal`/`grandTotal` = order total, `editedDate` set |
| `tr_salesmenu` | **no rows** | 1 row per item: `menuID`, `qty`, `price`, `total`, `statusID=13` (Preparing), `flagPending=1`, `salesType='POS'`, `batchID=1` |
| `tr_tableusage` | 1 row: `(ID, referenceID=salesNum, expiredTime, username)` | `expiredTime` refreshed |
| `tr_branchevent` | audit log entries (JSON payloads: OPEN TABLE, pax, sign in/out) | more audit entries |
| `ms_branchmenu` | — | stock/sold-out bookkeeping |

So the POS floor-plan colors are driven by exactly this:

- **Blue** → no open `tr_saleshead` for that `tableID`
- **Yellow** → open `tr_saleshead` (statusID=1, totals 0) + `tr_tableusage`, **no `tr_salesmenu` rows**
- **Red** → same `salesNum` now has `tr_salesmenu` rows and non-zero `grandTotal`

Key formats observed:

- `salesNum = 'S' + brandCode + unixEpoch + 2 digits` (e.g. `SSUSHO1791844996 03` → brand "SUSHO", epoch 1791844996 = the salesDateIn timestamp). `queueNum` increments per day (`ms_transnumber` holds counters).
- `tableID` is the internal id in `ms_table`; the number shown on the floor plan is `ms_table.tableName` (e.g. tableID 42 = tableName "23"). The bridge must resolve name → id.
- `lk_status`: 1 New, 12 Cancelled, 13 Preparing, 14 Served, 10 Full Paid, 15 Billing…

## 2. Where the menu code lives in ESB

`ms_menu` has a dedicated **`menuCode`** column (separate from auto-increment
`menuID` and from `menuName`) — this is the field end users edit in ESB Core.
In this test database all `menuCode` values are still empty, so **step 0 of the
project is: fill in menuCode for every item in ESB Core.**

Bridge mapping rule: the middleware keys everything on `menuCode`, and resolves
`menuCode → menuID` by querying `ms_menu` at write time (never cache menuID
long-term — it is not the stable key; menuCode is).

## 3. Answer: is `meal_id` customizable on the Hong Chiang side?

**Per the KDS API documentation v2.0.1 — no.** The API has only 5 endpoints
(`tables/search`, `walkIns/get`, `orders/details`, `reservations/update`,
`walkIns/update`). There is **no menu endpoint at all**: no create, no update,
no list. `meal_id` only ever appears as a **read-only field inside
`orders/details` output**. So:

- The journey "menu creation comes from ESB and hits back into the Hong Chiang
  KDS device" is **not possible with the documented API**. Hong Chiang's
  `meal_id` is an internal id managed by their own admin/POS software; the API
  gives no way to set or even read the catalog. (If Hong Chiang has an
  undocumented admin API or import file, that would be a question for the
  vendor — the v2.0.1 spec does not expose it.)

**BUT — in this project the answer is effectively yes**, because the ordering
app we built owns its own menu layer (`server/data/menu.json`), and the KDS
only ever sees meals inside orders. So the clean architecture is:

> **ESB Core is the menu master.** The middleware reads `ms_menu` (+
> `ms_branchmenudetail` for branch price/availability) from the local POS DB
> and **generates the ordering app's menu**, embedding `menuCode` on every
> item. Orders then flow back carrying `menuCode` natively — no fuzzy mapping,
> no manual sync. Editing a menu in ESB Core propagates to the ordering app on
> the next middleware sync.

If orders instead originate on a **real Hong Chiang KDS device** (not our app),
the middleware only sees `meal_id`/`meal_name` from `orders/details`, and then
a manually maintained `meal_id ↔ menuCode` mapping table is unavoidable.

## 4. Proposed middleware flow

```
Hong Chiang app/KDS                 Middleware (local)                ESB POS DB (sushipos)
--------------------                ------------------                ---------------------
customer opens table     ──────▶    resolve tableName→tableID
(tables/search shows                generate salesNum/queueNum
 SEATED reservation)                INSERT tr_saleshead (statusID=1,
                                    totals 0) + tr_tableusage   ──▶   table turns YELLOW

customer saves order     ──────▶    orders/details → items
                                    menuCode → menuID via ms_menu
                                    INSERT tr_salesmenu (statusID=13,
                                    flagPending=1, batchID=n)
                                    UPDATE tr_saleshead totals   ──▶  table turns RED

payment (reservations/   ──────▶    (phase 2: tr_salespayment,
update / walkIns/update)            statusID→10, billNum …)
```

Detection on the Hong Chiang side is **polling-based** — the KDS API has no
webhooks. Poll `tables/search` (reservation appears = table opened) and
`orders/details` per occupied table (meals appear/change = order saved).
If orders originate in our own app, skip polling: the app's `/api/checkout`
can call the bridge synchronously with `menuCode` already attached.

## 5. Risks & cautions (important)

1. **Direct DB writes into a SaaS POS are unsupported by ESB.** The POS syncs
   to ESB cloud (`tr_sync`, `hub_*`, `syncDate` columns, `tr_branchevent`
   audit log). Rows the POS app didn't create may be rejected, overwritten, or
   flagged on sync. Test on a sandbox branch first and watch
   `tr_sync`/ERP behavior.
2. **A cleaner injection point may already exist:** the schema contains ESB
   Smart Order queue tables — `tr_temporder` (`orderID`, `orderData` JSON!),
   `tr_esoqueue`, `tr_esoprocessqueue`, `tr_esopickuporder`. This is how ESB's
   own self-order channel feeds the POS. Reverse-engineering one real ESO
   order into `tr_temporder.orderData` (or better: asking ESB for their
   official Smart Order / Open API) would ride ESB's own validated pipeline
   instead of hand-writing `tr_saleshead` math (taxes, rounding, promotions).
3. Money columns are interdependent (`subtotal`, `vatTotal`, `grandTotal`,
   `tr_salesheadvat`, `tr_salesmenuvat`). Phase 1 should write orders as
   tax-exclusive simple items and let the cashier settle payment in ESB,
   exactly like the dumps show (paymentTotal stays 0 until cashier acts).
4. `tr_branchevent` shows the POS logs every action with the cashier username —
   the bridge should write a recognizable `createdBy` (e.g. `HCBRIDGE`) for
   auditability.

## 6. UPDATE — the official door exists: ESO FS API (OpenAPI v1.0.0)

The ESO FS OpenAPI spec (`ESO-FS-OpenAPI-build.yaml`) confirms ESB's official
REST API for exactly this use case. **Use it instead of direct DB writes.**

- Base URLs: production `https://eso-api.esb.co.id`, staging
  `https://stg7.esb.co.id/api-ezo/web`
- Auth: `Authorization: Bearer <API key>` (issued via ESB Core / ESB PIC)
- Two context headers on most calls: `Data-Branch` (branch code) and
  **`Data-TransID` (encrypted POS transaction ID)**

### Endpoints

| Endpoint | Use |
|---|---|
| `GET /fsv1/setting/branch` | Branch config: features (callBill/callWaiter/atCashier), theme, payment mapping, `transactionMode: fullService` |
| `GET /fsv1/menu` | Full catalog: categories → menus with **`menuID` and `menuCode`**, prices, sold-out flags, `menuExtras`, `menuPackages` (option groups with `menuGroupID`, min/maxQty) |
| `POST /v1/user/auth` | Register customer identity (name, email, phone) → token |
| `POST /fsv1/order/calculate-total` | Price a cart server-side (items by `menuID` + extras + packages) |
| `POST /fsv2/order` | **Save Order** — body is an array of items: `{ID, menuID, qty, extras:[{menuExtraID,qty}], packages:[{menuID,qty,menuGroupID}], notes, promotionDetailID, promotionVoucherCode, rewardType}`. Async: returns `webSocketID` |
| `GET /fsv2/order/websocket-status` | Poll the async save result |
| `GET /fsv1/order` | View Order — returns the live transaction incl. `tableID`, `tableName`, `paxTotal`, `visitPurposeID`, items, totals |
| `POST /fsv1/payment` + `/fsv1/payment/validate` | Online payment (`paymentMethodID` e.g. `ovo`, amount from calculate-total, returnUrl) |
| `/fsv1/order/apply-promotion`, `validate-promotion`, `call-bill`, `call-waiter`, `/fsv1/bill` | Promotions, bill call, waiter call |

### The key constraint: `Data-TransID`

ESO FS **cannot open a table**. Every call is scoped to an *existing* POS
transaction via `Data-TransID` (encrypted salesNum). The yellow "open table"
state is created by the POS (cashier opens the table; `tr_saleshead` even has a
`printEsoFsQr` column — the POS prints/shows a QR per open table that embeds
this encrypted TransID). So the realistic bridge flow is:

```
1. Cashier opens table on POS  → tr_saleshead row (YELLOW) + ESO FS QR with Data-TransID
2. Customer orders in Hong Chiang app at that table
3. Middleware: POST /fsv2/order (Data-Branch, Data-TransID, items by menuID)
   → POS inserts tr_salesmenu itself (RED), with all tax/promo math done by ESB
4. Payment: at cashier (ESB side) or POST /fsv1/payment for online methods
```

The middleware needs a **table → Data-TransID registry**: capture the QR / its
encoded TransID when a table is opened (scan, or read `printEsoFsQr` flow), or
ask the ESB PIC how partners are expected to obtain TransIDs for integrations.
This is the one open question for ESB.

### Mapping with menuCode — confirmed end-to-end

`GET /fsv1/menu` returns both `menuID` and `menuCode`. So the sync is:

> Middleware pulls `/fsv1/menu` → generates the Hong Chiang app menu keyed by
> `menuCode` → at order time resolves `menuCode → menuID` from the same pull →
> `POST /fsv2/order` with `menuID`. ESB Core stays the single menu master; no
> DB access needed at all.

## 7. Recommended build order (revised)

1. ESB Core: fill `menuCode` for all menus; get ESO FS **API key** + branch
   code from ESB PIC (ask also: how to obtain `Data-TransID` programmatically).
2. Middleware "menu sync": `GET /fsv1/menu` → app menu (menuCode embedded).
3. Middleware "save order": app checkout → `POST /fsv2/order` → poll
   websocket-status → verify table turns RED and items match on the POS.
4. Payment phase: `calculate-total` → `payment` (online) or cashier settle.
5. Keep the direct-DB plan (section 4) only as a fallback/read-only monitor —
   reading `tr_saleshead`/`ms_table` locally is still handy to *detect* yellow
   tables and their salesNum without ESB's help.
