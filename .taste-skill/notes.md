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

# midhong monitor (public-mid/index.html), 2026-10-15

Direction: **The product performs** (seed 1420810439, sector dev-tool, `--keep palette,type` so the apphong
tokens and faces carry over). Hero blueprint "sentence split by a frame" set aside in favour of the direction's
own composition (headline upper-left, the working fragment fills the first screen): the 35%-wide 16:9 frame
cannot hold a readable ticket. Sections dealt: stats (bars standing on the edge) → list (day tabs, banded
agenda) → footer (a single quiet line). Signature motion: pinned story (the stage tabs stay put while the rows pass).
Idea: On this page, the kitchen pass rail (tickets clipped in the order they came, pulled when paid) becomes the
live queue: each order is a ticket moving along six stages until the cashier's stamp. Competitor test: Posmid's
monitor is a log table; the rail belongs to the restaurant.
Live thing: the ticket at the head of the rail advances as the bridge reports; the panel counts seconds since
the last answer; the stage tabs filter the rows; one button pauses the updates.
Baseline (old page): 8 FAIL (emoji, shadows, hairlines, 11.5px text, no pictures, no focal point, no motion).

ROUND 1: 4 FAIL (headline + rail heading at 3 lines, an eyebrow above the big count, side-scrolling tabs).
Fixed: "On the way to the till" with an authored break, "On the rail / every order so far", count and label on
one line, tabs wrap (2 columns on a phone, a sticky column on desktop), caption at body size.
Seen in the pictures: the ticket's six-column track overflowed a phone screen; the "today" figure said 0 while
four orders existed (they fell outside 10:00–21:00). Fixed: minmax(0,1fr) tracks, 3×2 on a phone, stacked
ticket header, and two extra bars "before 10" / "after 22" with the figure counting every order today.
ROUND 2: 0 FAIL, 1 WARN (10 moving elements; defended: a monitor that re-renders every 3 s should not dance).
Scores: design 7.5 · usability 8 · creativity 7.5 · content 7.5 → overall 7.6.
Still short: the stats field is a 90svh grey screen whenever the day is quiet; the staff link row carries three
plain links and no idea; the pictures repeat apphong's (no honest picture of a till exists in the collections).

# Edo Sushi rebrand (both apps), 2026-10-15

Correction from Dewa: Hong Chiang is the SaaS vendor (the KDS), not the restaurant. The restaurant is Edo Sushi,
kaiten (conveyor belt), coloured plates at set prices. Design system kept (split stage / the product performs,
tokens, faces with Noto JP for Japanese); the idea, copy, catalog and pictures redone.

Inventory: the name Edo (old Tokyo, where nigiri was born in the 1820s); the belt; plates by colour = price
(red 15k, blue 20k, green 25k, black 30k, gold 40k, sample tiers); the stack of empty plates counted by colour at
the end (the bill); the hot-tea tap at the seat; rupiah and the Indonesian pax question; pay at the counter.
Idea: On this app, the stack of coloured plates, the kaiten bill counted by colour at the end, becomes the
slip: every item is a plate of one colour, your stack grows as you tick, and the cashier screen shows the stack
beside the table number. Competitor test: an à-la-carte sushi bar has no plate colours; with the Edo prints
(Hiroshige's Nihonbashi and fish, the 1810 sushi-and-sake surimono) the page belongs to this name.
Live thing: the stack (drawn flat, one ellipse per plate in its real colour) and its count by colour, live as
you tick; the table-number check against the floor plan stays.
Copy: "Order here, pay by the plate" · "How the plates work": Pick your plates / The kitchen sends them / Pay by
the plate · menu heading "The belt" · slip "Your stack" · stamp "Paid 済" · midhong "the Edo Sushi till bridge".
Pictures: Hiroshige "View of Nihonbashi Tori-itchome" (1858), "Bonito and saxifrage", "Flying fish and ichimochi"
(AIC, CC0); "New Year's Sake and Sushi" (Met, CC0); "A stack of empty sushi plates…" (Commons, BY-SA 4.0);
"お皿が山積み" (Commons, BY 2.0); clip "Moving Sushi" (Commons, BY-SA 3.0). Two families on purpose: the prints
carry the name on the home, tables, menu and boards; the two plate photographs appear only on the status screen,
where the stack is literal. Credits in the home footer and midhong's caption.
Gate: home 0 FAIL, menu 0, status 0, midhong 0; npm test 33/33.
Sample content to confirm: the whole catalog (26 items, plate tiers, option groups) and the hours.

## Rounds (additional orders from the same seat), 2026-10-15
Every Save Order is a round kept in sessionStorage `hc_orders` (same mode + table = one visit). The belt's slip
says how many plates are already on the way; the status screen shows the table total and combined stack, then
each round as its own panel ("First order, 10:42", lines with the kitchen's word, the bridge stage for that
round), the till steps for the latest round, "Add another round" until every round is settled. The bridge
attaches later rounds to the same ESB head as a new batch (golden rule 4), so nothing changed server-side.
Verified with a scripted Chrome run (two rounds on table 5): screenshots in `.taste-skill/rounds/`.

## Queue Mode (counter pickup), 2026-10-27
Reading of a two-word brief: guests without a table get a queue number and a board at the counter calls it. The
number is issued by apphong at checkout (Q-001… per business day), the status screen shows it at display size
("Your number on the board"), the message flips to "Ready. Collect at the counter and pay there." when the kitchen
has every plate ready, and `#/queue` is the board: two fields, "Ready, collect at the counter" (ink field, numbers
in red) and "Being prepared" (surface), numbers in Besley at up to 8rem for a TV, refreshed every 5 s. The staff
takeout board lists the same rows with their lines. Nothing changes for the agent; the number also rides on the
bridge command so the monitor shows it.
