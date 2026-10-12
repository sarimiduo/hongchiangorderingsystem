# Design — Hong Chiang ⇄ ESB POS bridge via local SQL agent (no ESB API)

Architecture decision: **SQL-to-SQL through the local agent**, reusing the
patterns from the production `esb-pos-replication` middleware (Posmid, agent
v1.70 / webapp v1.74). No ESB API, no API keys, no Data-TransID problem.

## The journey

```
Hong Chiang app ──► webapp (this repo) ──► local agent ──► ESB POS DB (live)
     ▲                   │  order queue        │ SQL writes:
     │                   │  (commands)         │  yellow: tr_saleshead + tr_tableusage
     │                   │                     │  red:    tr_salesmenu + head totals
     │                   │                     │
     │                   │                ESB POS cashier (human) settles the bill
     │                   │                     │
     │                   ◄── agent watcher: salesNum paid/void detected
     └── feedback: KDS reservations/update COMPLETED / walkIns/update paid
```

Key difference from the replication middleware: Posmid copies **finished paid
sales** (statusID 8) into a *shadow* destination. This bridge **creates
pre-payment state in a live POS** (statusID 1 head, statusID 13 menus) and
lets the human cashier finish it. Same toolbox, different direction of the
lifecycle.

## What carries over verbatim from the replication contract

- Whole sale or nothing, **one DB transaction**, rollback on any error.
- **Idempotency by salesNum** (re-delivery of a webapp command must not
  duplicate).
- MySQL **5.7-only SQL** (no CTEs/window functions); probe
  `information_schema` before touching non-core tables/columns (ESB builds
  differ — this build has `ms_transnumber`, the replication build used
  `ms_counter`: probe for whichever exists).
- Writes stamped with a **real cashier username** from `ms_posuser`
  (`createdBy`), never a "MIDDLEWARE" label.
- Agent ⇄ webapp loop: reuse the Posmid pattern — agent polls
  `GET /api/commands`, executes, acks with results; heartbeat; pause flag.
- Never touch the vendor PHP; never write what the POS regenerates.

## The two write transactions (from the dump diff)

### TXN A — "open table" (floor plan turns YELLOW)

Trigger: customer confirms table + pax in the Hong Chiang app.

1. Resolve `tableID` from `ms_table` by `tableName` (`flagActive=1`).
2. Guard: if the table already has an open head (`statusID` in open set,
   `salesDateOut IS NULL`) → do NOT create; attach later items to that
   `salesNum` (next batch) instead.
3. Generate `salesNum = 'S' + brandCode + unixEpoch + 2-digit seq` (dump
   format). Collision-check and retry — the POS mints numbers the same way.
4. `queueNum` from the build's counter table under a row lock
   (`ms_transnumber` here).
5. INSERT `tr_saleshead`: salesDate/salesDateIn now, `branchID`,
   `tableID`, `paxTotal`, `visitPurposeID` = DINE IN, `statusID=1`,
   all money columns 0, `billNum NULL`, `paymentTotal 0`,
   `createdBy = <real cashier>`. Leave `syncDate` exactly as the POS does for
   fresh sales (NULL) — this is the POS's own sale now; ITS sync owns it.
6. INSERT `tr_tableusage (referenceID=salesNum, expiredTime, username)`.

### TXN B — "save order" (floor plan turns RED)

Trigger: customer checkout in the Hong Chiang app.

1. Resolve each item `menuCode → menuID, price` from `ms_menu`
   (+ `ms_branchmenudetail` price/availability when present). Unmapped
   menuCode → reject the whole order back to the webapp (Posmid preflight
   rule: never copy/write a partial bill).
2. INSERT `tr_salesmenu` per line: `qty`, `price`, `total`, `notes`,
   `statusID=13` (Preparing), `flagPending=1`, `salesType='POS'`, `batchID` =
   submission number (1, 2, … per extra order round). Package children via
   `menuRefID`/`menuGroupID`, extras via `tr_salesmenuextra` — exact tax and
   money-column math comes from the `esb-pos-data-structure` reference
   (→ open question 1).
3. UPDATE `tr_saleshead` `subtotal`/`grandTotal` (+ tax columns per that
   reference), bump `editedDate`, refresh `tr_tableusage.expiredTime`.

Not written (POS regenerates or app-logic-only — mirrors the Posmid
skip-list): `billNum`, payments, `tr_kitchen_order`, all `tr_eso*` queues,
`tr_websocket`, stock movement. Kitchen display is Hong Chiang's job in this
architecture, so skipping ESB kitchen print is a feature, not a gap.

### Takeout variant

Same two transactions without `tableID`/`tr_tableusage`, `visitPurposeID` =
the takeaway visit purpose from `ms_visitpurpose`.

## The watcher — closing the loop back to Hong Chiang

Agent polls (cheap, indexed by salesNum, every ~5s) each tracked sale:

| Observation on `tr_saleshead` | Meaning | Feedback to Hong Chiang (via webapp → KDS API) |
|---|---|---|
| `paymentTotal >= grandTotal`, `billNum` set, `salesDateOut` set, statusID → paid/finished | **Cashier settled the bill** | dine-in: `reservations/update {status: COMPLETED, payment_method}` · takeout: `walkIns/update {status: paid, payment_method}` |
| statusID → 24/12 (Void/Cancelled) | Cashier voided | cancel/release feedback (free the table in HC) |
| `tr_salesmenu` rows added/edited by POS | Cashier modified order | sync view in HC app |

Payment method mapping: `tr_salespayment.paymentMethodID → ms_paymentmethod`
code → KDS enum (`00` Cash … `04` UnionPay) — one small mapping table in the
webapp, same style as Posmid's payment mapping.

## Why this is credible (and the two things to verify on a sandbox)

The dumps prove the yellow/red states are plain DB rows, and Posmid's
production "Create new bill" path proves the live destination POS accepts and
displays middleware-written sales. Verify early:

1. **Floor-plan refresh**: insert one TXN A row on a sandbox branch and watch
   the POS — does the table turn yellow without restarting the POS app? (The
   POS may use `tr_websocket` for push refresh; worst case the floor plan
   updates on its next poll/navigation.)
2. **Cashier flow on a bridge-created sale**: open it on the POS, add payment,
   settle — confirm billNum assignment, receipt print, and that ITS cloud sync
   uploads it cleanly (`syncDate` set afterwards).

## Open questions

1. **Share the `esb-pos-data-structure` skill** (referenced by the
   replication skill) — it holds the exact money/tax/status column math so
   TXN B writes totals the way the POS expects (inclusive VAT vs service
   charge ordering etc.).
2. Which ESB build runs at the Hong Chiang location — confirm counter table
   (`ms_transnumber` vs `ms_counter`) and schema version (agent probes anyway).
3. One real cashier username to stamp bridge writes with.

## Component plan

- **Webapp (this repo)**: add `/api/bridge/commands` (order queue for the
  agent, Posmid-style), `/api/bridge/report` (agent acks + watcher events),
  and the feedback caller into the KDS endpoints (already implemented in
  `server/index.js` as `/api/pay`).
- **Local agent** (Windows mini-PC at the branch, like Posmid's): poll
  commands → TXN A/B → watch → report. Python + PyMySQL, config in
  `agent.ini`, no credentials in the repo.
- **Status page in HC app**: "order finished" state driven by the webapp when
  the watcher reports settlement.
