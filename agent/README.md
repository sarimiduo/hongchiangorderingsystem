# Mini-PC Agent — Hong Chiang → ESB POS bridge

Runs on the Windows mini-PC (or any machine) that can reach the ESB POS MySQL
on the LAN. It polls the middleware webapp over HTTPS (outbound only — no
ports need to be opened at the branch), writes orders into the ESB POS
database, and reports settlement back.

## Files

- `hc_bridge_agent.py` — the agent
- `agent.ini` — your configuration (NOT committed to git; keep it on the mini-PC)
- `agent.ini.example` — template
- `run_agent.bat` — Windows launcher
- `kds_stub.py` — stateful test double of the KDS API (development only)

## Setup (Windows mini-PC)

1. Install Python 3.10+ from python.org (tick "Add python.exe to PATH").
2. `pip install pymysql`
3. Copy this `agent/` folder to the mini-PC, e.g. `C:\hcbridge\`.
4. Edit `agent.ini`:
   - `[webapp] url` — the bridge middleware (https://midhong.berkatselalu.com)
   - `[webapp] token` — must equal `AGENT_TOKEN` in the VPS `.env` (midhong reads it)
   - `[mysql]` — the local ESB POS database credentials
   - `[agent] cashier_username` — a REAL username from `ms_posuser`
5. Sanity checks, in order:
   ```
   python hc_bridge_agent.py --config agent.ini --probe      # schema + masters OK?
   python hc_bridge_agent.py --config agent.ini --sync-menu  # app now sells the ESB menu
   python hc_bridge_agent.py --config agent.ini --run        # main loop
   ```
6. Keep it running at boot: Task Scheduler → Create Task → trigger "At startup"
   → action: start `run_agent.bat` in `C:\hcbridge\` (same pattern as the
   Posmid agent), or use NSSM to install it as a service.

On the VPS, set the matching token in `/var/www/hongchiangorderingsystem/.env`
(read by the `hongchiang-mid` unit):

```
AGENT_TOKEN=<same value as agent.ini>
BRIDGE_SIM=0     # optional: disable the demo simulator once the real agent is live
```

then `sudo systemctl restart hongchiang-mid`.

## What it writes (and never writes)

Writes: `tr_saleshead` + `tr_tableusage` (open table, yellow), `tr_salesmenu`
+ head totals (order saved, red) — stamped with the configured cashier, whole
order in one transaction, idempotent per Hong Chiang order number.
Never writes: `billNum`, payments, kitchen/queue/websocket/stock tables —
those belong to the POS. Settlement is detected read-only and reported back.

Tax math mirrors the vendor `CalculateTotal.php`: per-line other tax (service)
and VAT driven by `map_branchvisitpurpose` (`taxValue`, `additionalTaxValue`,
`flagOtherTaxVat`) and the menu flags (`flagTax`, `flagOtherTax`,
`flagLuxuryItem`), DPP ratio and rounding from `ms_setting`, prices from the
visit purpose's menu template. Verified: untaxed menus produce the exact row
shape of real POS sales; with VAT 10% + service 5%, 2×29.000 → subtotal
58.000, service 2.900, VAT 6.090 (on subtotal+service), grand 66.990.
Discounts/promotions/vouchers are not written by the bridge (cashier applies
them on the POS at settle time).

## KDS poller mode (orders placed on Hong Chiang's own app)

With a `[kds] base_url` in `agent.ini` (e.g. `http://192.168.100.200:5500/kds`)
the agent ALSO polls the KDS directly, so orders guests place on Hong Chiang's
own ordering app land in ESB without going through the webapp:

- dine-in: `tables/search` → reservations with status `SEATED` (the verified
  live marker; `table.status` is useless) → `orders/details {table_id}` —
  `S00052` just means the table has no order; walk-ins: `walkIns/get` →
  `orders/details {order_id: order_no}`.
- New rows (the KDS appends one row per plate, qty 1) are aggregated per
  `meal_id` and written as the next ESB batch — same TXN A/B, same
  idempotency marker `HC:<order_no>`, restart-safe (`salesNum` is recovered
  from `additionalInfo`).
- Menu mapping: `[kds_menu_map] meal_id = menuCode`, falling back to exact
  `menuName`. Prices always come from ESB's menu template — the KDS currency
  is never trusted.
- When the cashier settles the sale on ESB, the agent closes the KDS order:
  `reservations/update {id, COMPLETED, payment_method}` for dine-in (verified:
  this also closes the order), `walkIns/update {order_no, paid, …}` for
  walk-ins. The ESB payment name is mapped to the KDS enum (cash/tunai→00 …).
- A build without a `map_branchvisitpurpose` row for the takeaway purpose
  degrades to the branch's first mapped purpose (warning logged) so lines are
  never written at price 0.

Test without a device: `python3 kds_stub.py` (port 5500) replays every
behavior verified on the vendor's test KDS, with `/ctl/*` endpoints to seat
tables and add plate rounds; then `--poll-once` runs one poll+watch cycle.

## Linux alternative

```
python3 hc_bridge_agent.py --config agent.ini --run
```

systemd unit: copy the pattern from `deploy/hongchiang.service`, point
`ExecStart` at the command above.
