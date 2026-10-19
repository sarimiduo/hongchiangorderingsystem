# Real orders/details capture — vendor test KDS, 2026-10-19

`POST /kds/orders/details {"table_id": 1}` returned order **id 18,
order_no ORD202608144SD6ID**, status `in_progress`, total_price `10549.92`,
**155 order_meals rows** accumulated 2026-08-14 → 2026-10-06. Full payload too
bulky/repetitive to store; the distinct catalog and the behavioral findings
are below.

## Behavioral findings (poller-critical)

1. **One row per plate, always `quantity: 1`.** Kaiten style: ordering the same
   meal N times = N rows with the same meal_id, never qty N. A poller must
   aggregate (or mirror row-per-row); never assume qty>1 rows exist.
2. **Rounds append to the SAME order** (id 18 spans weeks of createtime
   bursts). There is no batch/round field — group rows by `createtime` burst.
   New-row detection = new `id`s (row ids are monotonic).
3. **Table status and reservations DO NOT reliably signal an open order.**
   While order 18 is `in_progress` on table 1, `tables/search` shows the table
   `IDLE` with only a COMPLETED reservation (res 24 was completed earlier the
   same day WITHOUT closing the order). ⇒ The poller must probe
   `orders/details` per table (S00052 = no order) instead of trusting
   `tables/search`; and completing a reservation does not necessarily close
   the linked order.
4. **`payment_method` can be pre-filled ("00") while unpaid** (`paidtime` and
   `invoice_no` still null, status `in_progress`). Paid signal = status /
   paidtime, never payment_method.
5. Meal statuses observed: `PREPARING`, `READY`; rows turned READY carry
   `tablet_id` (e.g. 20) and a bumped updatetime. Legacy meals (ids 5-135)
   have `category_id: 0`, empty category_name and empty image_path — mapping
   must tolerate missing categories.
6. `image_path` is relative to the KDS host (`../uploads/meals/...`) — meal
   pictures could be served from `http://<kds-host>:5500/uploads/meals/…`
   (verify path root before using).

## Distinct meal catalog extracted from the rows (meal_id → name, price, category)

| meal_id | meal_name | price | cat | category_name |
|---|---|---|---|---|
| 5 | 炙燒合鴨 | 50.00 | 0 | (legacy) |
| 10 | 漢堡排美乃滋 | 49.98 | 0 | (legacy) |
| 12 | 蒜香合鴨 | 50.00 | 0 | (legacy) |
| 69 | 鮪魚花椰菜塔塔沙拉 | 50.00 | 0 | (legacy) |
| 134 | 鮪魚握壽司 | 80.00 | 0 | (legacy) |
| 135 | 鮪魚蔥酵蘿蔔包 | 70.00 | 0 | (legacy) |
| 339 | 小龍紅蝦 | 100.00 | 7 | 握壽司 |
| 340 | 奶油玉子 | 40.00 | 5 | 甜點 |
| 341 | 奶油炸蝦 | 50.00 | 7 | 握壽司 |
| 342 | 奶油蟹卷 | 50.00 | 7 | 握壽司 |
| 343 | 玉米沙拉 | 30.00 | 2 | 軍艦・卷壽司 |
| 345 | Kimchi Natto | 30.00 | 2 | 軍艦・卷壽司 |
| 346 | 厚切鮭魚 | 50.00 | 7 | 握壽司 |
| 347 | 厚切鰻魚 | 50.00 | 7 | 握壽司 |
| 349 | 炸彈燒肉 | 40.00 | 1 | 肉壽司 |
| 352 | 海帶手卷 | 50.00 | 2 | 軍艦・卷壽司 |
| 353 | 魚卵手卷 | 40.00 | 2 | 軍艦・卷壽司 |
| 354 | 極上鮭魚 | 50.00 | 7 | 握壽司 |
| 355 | 鮮味花枝 | 60.00 | 7 | 握壽司 |
| 357 | 蟹膏手卷 | 40.00 | 2 | 軍艦・卷壽司 |
| 358 | 鰻魚手卷 | 40.00 | 2 | 軍艦・卷壽司 |
| 361 | 红粉草莓寿司 | 60.00 | 2 | 軍艦・卷壽司 |
| 363 | 五花牛肉 | 150.00 | 1 | 肉壽司 |
| 365 | Sanshoku Dango | 150.00 | 5 | 甜點 |
| 367 | 日式布丁 | 150.00 | 5 | 甜點 |
| 371 | 漂浮咖啡 | 150.00 | 5 | 甜點 |
| 374 | Blackberry Sundae | 150.00 | 5 | 甜點 |
| 376 | 漂浮哈密 | 60.00 | 5 | 甜點 |
| 378 | Bear | 150.00 | 3 | 酒類 |
| 379 | 茶碗蒸 | 60.00 | 4 | 副餐 |
| 380 | 味噌湯 | 60.00 | 4 | 副餐 |

Prices sit on plate tiers (30/40/50/60/100/150) — kaiten coloured-plate
pricing, matching the Edo Sushi concept. Categories seen: 1 肉壽司,
2 軍艦・卷壽司, 3 酒類, 4 副餐, 5 甜點, 7 握壽司. This table doubles as the first
draft of the Hong-Chiang-meal_id → ESB-menuCode mapping: there is no menu
endpoint, so order history is the only menu discovery channel.
