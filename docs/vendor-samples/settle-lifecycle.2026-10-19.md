# Verified dine-in lifecycle — vendor test KDS, 2026-10-19 (tables 6/id 2)

The full normal flow, captured end to end:

1. **Seat** → reservation 25 `SEATED` on table 6; an order is created AT
   seating (order 19 `createtime` == reservation `seated_time`, 16:24:25),
   `payment_method: null` on a fresh order (the pre-filled "00" seen on stale
   order 18 came from an earlier settle attempt, not creation).
2. **Order items** → rows appended (16:26:21): 5 plates, all qty 1, all
   `PREPARING`; header `total_price` 570.00 = exact sum of subtotals.
3. **Settle** → `reservations/update {id:25, status:"COMPLETED",
   payment_method:"00"}` → success; the response carries **`order_id: 19` and
   `order_number`** — the reservation↔order link, confirming WHICH order was
   closed.
4. **After settle** → `orders/details {table_id:2}` returns **S00052
   order_not_found**: completing the reservation CLOSES the order and removes
   it from the table lookup. `tables/search` shows reservation 25 COMPLETED
   (completed_time set), table still `IDLE` throughout.

⇒ `reservations/update COMPLETED` IS the complete dine-in settle: one call
closes reservation + order. The stale order 18 (order open after reservation
completed) was broken legacy data with a severed link, NOT normal behavior —
but a robust poller still tolerates that state (it polls orders/details and
treats S00052 as closed).

Poller lifecycle contract (all strings verified on-device):
  reservation SEATED (completed_time null)  = guest session open, id = settle key
  orders/details {table_id} → order + meals = mirror to ESB (aggregate qty-1 rows)
  ESB cashier settles → bridge calls reservations/update {id, COMPLETED, payment_method}
  → next orders/details returns S00052 = loop closed; verify via response order_number
