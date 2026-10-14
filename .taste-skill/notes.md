# Hong Chiang ordering app — design notes (tasteskill run, 2026-10-14)

Direction dealt: **The split stage** (seed 1729440213), Besley / Libre Franklin, "Interior and table" set.
Reading of the brief: a self-ordering web app (phone first, also used on a desktop/tablet at the branch) for a
Taiwanese canteen in Indonesia. Stage 1: Save Order only, pay at the ESB cashier. Not a marketing page: every
screen must still do its job (tables, menu, options, slip, status, staff boards).

## Inventory (what belongs to this client and no competitor)
1. The name 鴻匠 Hong Chiang (the KDS/robot vendor's demo canteen; "Robot Delivery · Smart Kitchen").
2. Taiwanese canteen menu: 滷肉飯, 牛肉麵, 三杯雞飯, 雞肉菇菇咖哩飯, 珍珠奶茶, 冬瓜茶; sold in rupiah with
   Indonesian lines (Es Teh Manis Jumbo, Cah Kangkung); three languages on one sheet.
3. **The 點餐單** — the paper tick-sheet every Taiwanese 小吃店 hands you with a pencil: dish, price, a box for
   the quantity, your table number written at the top, totalled at the counter. The printed artefact of this world.
4. The table number stand on each table; the pax question ("makan bersama berapa orang?").
5. The delivery robot that brings the tray.
6. The kitchen display: PREPARING → READY → SERVED.
7. The cashier counter: the sale is settled there, the cashier stamps it paid; billNum.
8. Spice level 辣度 and rice choice 白飯 / 糙米飯 as the option groups.
9. Hours 10:00–22:00.
10. Signage of Taiwanese eateries: red brush characters on cream/white.

## The idea
> On this app, **the Taiwanese paper 點餐單 (the tick-sheet you fill with a pencil)** becomes **the whole
> interface: the menu is the sheet, your ticks are the order, and the "show the cashier" screen is the finished
> slip with the table number written large at the top.**

Competitor test: an Indonesian warung (point at the counter) or a Japanese ticket-machine shop: the sentence fails
for both. The tick-sheet is Taiwanese 小吃 and this is a Taiwanese canteen.

## The live thing
The slip fills as you tick: a sticky slip beside the menu (bottom bar on a phone) keeps the running rupiah total
with the 10% service line; on the home screen one field takes your table number and checks it live against the
kitchen's table list. After Save Order the slip keeps changing: kitchen status from the KDS, cashier status from
the ESB bridge, then the red PAID stamp.

## Palette: proportions dealt, colours from the subject
Dealt "warm black, gold" (dark ground). The subject's own colours are unmistakable (white paper, pencil ink,
vermillion red signage), so the proportions stay (one ground, one surface step, one ink, one muted, one accent on
the action and one other thing) and the values come from the subject. Reported as a palette redraw by subject.
--bg #ffffff · --surface #efede8 · --ink #16140f · --muted #5f5b55 · --accent #c8321e · --accent-ink #ffffff
Accent appears on: the primary button, and the table number on the slip (the red stamp of the sheet). Nowhere else.

## Type
Besley 800 (display, headings, prices on the slip) with Noto Serif TC 900 for CJK glyphs in those places;
Libre Franklin 400/600 (text) with Noto Sans TC 400/700 for CJK. Two Latin faces + their CJK companions.
Steps: small 14 · body 17–19 · lead 20–26 · head 32–56 · display (table number) clamp(6rem, 22vw, 15rem).

## Argument (claims → proof), per screen
Home      1. Order here, pay at the counter.                   → headline, one button, the hours bar
          2. It works like the paper sheet.                    → the slip in three states (how-it-works, pinned)
          3. Start from your table.                            → one field: table number, checked live
          4. This is Hong Chiang.                              → footer: name across the night-market clip, credits
Tables    Pick a free table.                                   → the live floor list from the KDS
Menu      The whole menu, as the sheet.                        → category heads, rows with price + qty, the slip
Slip      Your slip, totalled, one action.                     → lines, service, total, Save order
Status    Show the cashier.                                    → table number huge, order no, total, kitchen + cashier state
Boards    Staff: open takeouts; bridge monitor.                → plain lists

## Copy deck
Wordmark: Hong Chiang 鴻匠
Nav links: Menu · Takeout board · Bridge
Headline (home): Order here, pay at the counter        (30 chars)
Support: Tick the dishes you want. The kitchen starts at once and the cashier settles your bill when you are done.
Button: Order dine-in           Text link: Order for takeout
Hours bar: Open today 10:00–22:00 | Pay at the counter
How it works (three statements):
  Tick the sheet.      Every dish on the menu has a box. Tap it and the line is on your slip.
  The kitchen cooks.   Your slip goes straight to the kitchen display and the ESB till; the robot brings the tray.
  Pay at the counter.  Show the cashier your table number. When the bill is settled, the slip is stamped paid.
Table field: Which table are you at? / Type the number on your table stand
  after: We check it against the floor plan before you order.
Tables heading: Pick a free table
Menu heading: The sheet
Slip heading: Your slip
Status: Table 桌號 / Takeout 外帶 — Show this to the cashier — Finished, paid
Footer: Hong Chiang 鴻匠 (full width) · credits line

## Sample content to confirm before launch
Menu names/prices are the local demo catalog (server/data/menu.json); the live catalog comes from ESB sync.
No address exists in the brief; the hours bar carries "Pay at the counter" on the right instead.

## Critique

ROUND 1 (after the first inspect: 3/3/1/2 FAIL on home/menu/tables/status)
Seen in one second: the lit red-on-cream sign beside "Order here, pay at the counter".
Idea: the 點餐單 as the interface. Live thing: the slip fills as you tick; the table field checks the floor plan.
Layout words: home hero=split / how-it-works=pinned / table field=stack / footer=full-bleed; tables=split+index;
menu=split+list; slip=statement column; status=split+display figure.
Scores: design 6 · usability 6 · creativity 8 · content 7 → 6.5 (capped by FAILs).
Top three: 1. menu desktop: still panel collapsed to ~180px (1fr columns grew to the sheet's min-content);
2. status: "Sale SSUSHO…" sub-line broke out of the step row (text node + span became separate grid cells);
3. home how-it-works: statements too small for 80vh blocks, slip fragment too small for the panel.
Fixed all three, plus: neutral grey surface (cream check), truer signage red (#c62128), phone headline at 9vw,
footer wordmark 12vw with 鴻匠 on its own line, row secondary text at body size, muted darkened to 7:1.

ROUND 2 (0 FAIL on every screen; npm test 33/33)
Seen in one second: same; on the phone the still photo then the headline and the red button in one screen.
Layout words unchanged; boards=split+index.
Scores: design 7.5 · usability 7.5 · creativity 8 · content 7 → overall 7.5.
Caps: none.
Still short of 8: 1. desktop how-it-works runs three 80vh screens with one statement each; the fragment carries
them but the sheet side is sparse. 2. seven categories wrap to three lines on the desktop menu. 3. the footer
clip is 480p upscaled to a full screen (soft); the canteen's own footage should replace it. 4. the staff boards
share the customer screens' split; fine for consistency, a juror would call it sameness.
Defended WARNs: mixed-font-headline (鴻匠 needs a CJK face), font-count (Noto Sans TC for CJK glyphs only),
no-footage on inner app screens, first-action on screens whose action is per row / per tile.
