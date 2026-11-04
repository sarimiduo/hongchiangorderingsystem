# quehong — Edo Sushi walk-in queue (ticketing) system

A LAN-first queue system for the branch: guests register on a tablet, get a
printed ticket with two QR codes, wait wherever they like (WhatsApp calls them
back), scan at the entrance, and the TVs show the queue and the exact table —
blinking on the floor plan — with a Bahasa (+ English) voice call. Seating
follows REAL table occupancy from the ESB POS via the bridge agent.

```
TABLET /register ──► que/server.js (mini-PC, :3200) ──► TM-T82X prints 2 QRs
                        │        ▲            │
         TV /display ◄──┤ SSE    │ scan       ├─ outbound HTTPS ─► que/pub.js (VPS)
         TV /display ◄──┤        │ (USB QR    │   queue snapshots    └ /q/<token> landing
         /admin kanban ◄┘        │  scanner)  │                        (dies at seat/finish)
                                 │            └─ localhost ◄─ que/wa/worker.js (Baileys)
      hc_bridge_agent.py ─ busy tables ─► /api/que/esb-occupancy
```

Everything except the landing pages + WhatsApp runs locally: internet down =
queue still works.

## Pieces

- `server.js` — the local server (mini-PC). Pages: `/register` (tablet),
  `/display?view=queue` (Showing Queue TV), `/display?view=seat` (Showing Seat
  TV: floor plan + blinking table + voice), `/display?view=auto` (single TV),
  `/scan` (USB scanner station), `/admin` (staff kanban, PIN).
- `store.js` — queue state machine (see "Rules" below), persisted to
  `data/que_state.json` (survives restarts/power cuts).
- `printer.js` — ESC/POS with native QR for the Epson TM-T82X.
- `wa/worker.js` — Baileys WhatsApp worker (unofficial; see its header).
- `pub.js` — the VPS public mirror; deploy per `DEPLOY_VPS.md`.
- `data/tables.json` — table inventory + floor-plan coordinates. **Edit the
  capacities to match reality** (counter 01–16 = 1 pax; the 2/4-pax split of
  tables 20–60 is a first guess). `id` must equal `ms_table.tableName` in ESB
  (or set `esb_name` per table) so the agent's occupancy feed matches.

## Rules implemented

- Mapping by pax: 1 → counter, 2 → 2-seater first (a 4-seater only while more
  than `upsizeReserve` of them stay free), 3 → 4-seater, > largest table →
  split across tables + the bilingual "your group may be seated apart" notice
  (tablet + printed ticket).
- A party that cannot be seated reserves its table class — smaller parties
  flow past it, same-class parties wait behind it (no starvation).
- Called + no scan in 5 min → **Pending** kanban (table released, WA notice).
  When they arrive and scan, they re-enter the main queue at position 2
  ("bypass the 2 numbers").
- Scan of a called ticket → Showing Seat takes the TV for 60 s (blink +
  voice), landing page revoked, next number called automatically.
- WhatsApp QR = `wa.me/<bot>?text=EDQ-xxxx`; the guest sends it, the sender's
  number is bound + verified (tablet typos auto-corrected). Nudges: "1 group
  ahead — come back now", "your turn", "we missed you".
- Voice: browser TTS on the display, `id-ID` first; set `QUE_VOICE=id+en` for
  an English repeat.

## Mini-PC setup (Windows, same box as the ESB bridge agent)

1. Install Node.js LTS (nodejs.org). Clone/copy this repo, e.g. `C:\hcbridge\repo`.
2. **Printer (TM-T82X, USB):** install the Epson Advanced Printer Driver,
   then Printer properties → Sharing → share as `TMT82X`. The server prints
   raw ESC/POS via `copy /b` to `\\localhost\TMT82X`. (Ethernet model instead:
   `QUE_PRINT=net:<printer-ip>:9100`, no driver needed.)
3. **Scanner:** any USB QR scanner in keyboard-wedge mode with Enter/CR
   suffix (factory default on most). Plug into the mini-PC; keep the `/scan`
   page focused on the station's screen.
4. Create `run_que.bat` next to the repo (values from `DEPLOY_VPS.md` §6):

   ```bat
   @echo off
   cd /d C:\hcbridge\repo
   set HOST=0.0.0.0
   set QUE_PORT=3200
   set QUE_PIN=<staff pin>
   set QUE_PRINT=share:\\localhost\TMT82X
   set QUE_PUB_URL=https://quehong.berkatselalu.com
   set QUE_TOKEN=<same as VPS .env>
   set QUE_WA_NUMBER=62xxxxxxxxxx
   set QUE_VOICE=id+en
   node que\server.js
   ```

   `HOST=0.0.0.0` is what lets the tablet/TVs on the LAN reach it.
5. **WhatsApp worker** (separate window/service):

   ```bat
   cd /d C:\hcbridge\repo\que\wa
   npm install
   node worker.js
   ```

   First run prints a QR in the terminal — scan it from the bot phone's
   WhatsApp → Linked devices. The session persists in `que\wa\auth\`
   (gitignored — treat it as a credential).
6. **Agent feed:** add to `agent.ini` on the same machine:

   ```ini
   [que]
   url = http://127.0.0.1:3200
   ```

   The agent then pushes the busy-table list every poll; `/admin` also has
   manual busy/free toggles as the fallback.
7. Autostart: Task Scheduler "At startup" for `run_que.bat` and a second task
   for the worker (same pattern as the bridge agent), or NSSM as services.
8. Point the devices at the mini-PC's LAN IP:
   tablet → `http://<ip>:3200/register`; queue TV → `/display?view=queue`;
   seat TV → `/display?view=seat` (one TV for both: `/display?view=auto`);
   scanner station → `/scan`; staff phone/PC → `/admin`.
   On each TV browser, click the page once so autoplay allows the voice.

## Dev / test without hardware

```bash
QUE_TOKEN=dev QUE_PUB_PORT=3300 node que/pub.js &
QUE_PORT=3200 QUE_TOKEN=dev QUE_PUB_URL=http://127.0.0.1:3300 node que/server.js
# printer jobs append to que/data/printer-out.bin (QUE_PRINT unset = file mode)
# scanner = paste the token into /scan; tests: node --test test/que.test.js
```
