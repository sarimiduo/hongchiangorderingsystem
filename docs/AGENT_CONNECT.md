# Connect the Local Agent to the Webapp — Step by Step

This runbook connects the three machines end to end:

```
VPS (cloud)                                  Branch (local, your LAN)
┌─────────────────────────────┐              ┌──────────────────────────────┐
│ apphong  (server/index.js)  │              │ mini-PC                      │
│   :3000  customer app       │              │   hc_bridge_agent.py         │
│      │  BRIDGE_TOKEN        │   HTTPS      │   agent.ini  ← AGENT_TOKEN   │
│      ▼                      │   (outbound  │      │                       │
│ midhong  (server/mid.js)    │◄──only)──────│──────┘  polls every 5 s      │
│   :3100  bridge middleware  │              │      │                       │
│          AGENT_TOKEN        │              │      ▼  SQL on the LAN       │
└─────────────────────────────┘              │ ESB POS MySQL (sushipos)     │
                                             └──────────────────────────────┘
```

**Two secrets, two different jobs — don't mix them up:**

| Token | Who shares it | Where it lives |
|---|---|---|
| `BRIDGE_TOKEN` | apphong ⇄ midhong (both on the VPS) | VPS `.env` only — the mini-PC never sees it |
| `AGENT_TOKEN` | midhong ⇄ mini-PC agent | VPS `.env` **and** mini-PC `agent.ini [webapp] token` — must be IDENTICAL |

The agent only makes **outbound** HTTPS calls to midhong. Nothing on the
branch network needs to be opened or port-forwarded, and the ESB MySQL is
never exposed beyond the LAN.

---

## PART A — VPS side (5 minutes)

### A1. Pull the latest code

```bash
cd /var/www/hongchiangorderingsystem
sudo -u www-data git pull
```

### A2. Generate the two tokens

```bash
openssl rand -hex 24    # run twice; first output = BRIDGE_TOKEN, second = AGENT_TOKEN
openssl rand -hex 24
```

Copy both outputs somewhere safe for the next steps.

### A3. Edit the environment file

```bash
sudo nano /var/www/hongchiangorderingsystem/.env
```

Make it contain (template is `.env.example`):

```ini
# ---- apphong ----
PORT=3000
KDS_MODE=mock                # switch to real + KDS_BASE_URL when the KDS device is wired
CURRENCY=Rp

# ---- midhong ----
MID_PORT=3100
BRIDGE_URL=http://127.0.0.1:3100     # apphong -> midhong (same VPS: loopback)
APP_URL=http://127.0.0.1:3000        # midhong -> apphong (settlement callback)
BRIDGE_TOKEN=<paste first openssl output>
AGENT_TOKEN=<paste second openssl output>

BRIDGE_SIM=1                 # keep 1 until the real agent is connected, then set 0
BRIDGE_SIM_SETTLE_SECONDS=25
```

> Both services REFUSE to start if their required variables are missing:
> apphong needs `BRIDGE_URL`+`BRIDGE_TOKEN`; midhong needs
> `APP_URL`+`BRIDGE_TOKEN`+`AGENT_TOKEN`. If a service won't start,
> `journalctl -u hongchiang -n 20` (or `-u hongchiang-mid`) names the
> missing variable.

### A4. Restart and verify both services

```bash
sudo systemctl restart hongchiang hongchiang-mid
systemctl is-active hongchiang hongchiang-mid     # both: active

curl -s localhost:3000/api/config | head -c 120   # apphong answers JSON
curl -s localhost:3100/api/health                 # {"ok":true,"agent_live":false,...}
```

### A5. Verify midhong is reachable from the internet

From ANY other machine (your laptop):

```bash
curl -s https://midhong.berkatselalu.com/api/health
# expected: {"ok":true,"agent_live":false,...}
```

If this fails but step A4 worked → DNS/nginx/SSL problem, not the app:
`dig +short midhong.berkatselalu.com` must return the VPS IP, nginx site
`deploy/nginx.midhong.conf` must be enabled, certbot run for the domain
(docs/DEPLOYMENT.md §3). **Do not continue to Part B until A5 passes** —
the mini-PC uses exactly this URL.

---

## PART B — Mini-PC side (Windows, 10 minutes)

### B1. Install Python + driver

1. Install **Python 3.10+** from https://python.org — during install tick
   **"Add python.exe to PATH"**.
2. Open Command Prompt and run:
   ```bat
   pip install pymysql
   ```

### B2. Copy the agent folder

Copy the repo's `agent/` folder to the mini-PC, e.g. `C:\hcbridge\`:

```
C:\hcbridge\hc_bridge_agent.py
C:\hcbridge\agent.ini.example
C:\hcbridge\run_agent.bat
```

(Any way works: `git clone` on the mini-PC, a USB stick, or SCP. Only these
three files are needed.)

### B3. Create the token/config file `agent.ini`

This is **the** file that connects the agent to the webapp. Copy the example
and fill it:

```bat
cd C:\hcbridge
copy agent.ini.example agent.ini
notepad agent.ini
```

```ini
[webapp]
; midhong — the bridge middleware on the VPS (NOT apphong)
url = https://midhong.berkatselalu.com
; PASTE the AGENT_TOKEN value from the VPS .env (step A3). Must match EXACTLY:
; no quotes, no spaces around it, same letters.
token = <paste AGENT_TOKEN here>

[mysql]
; the LOCAL ESB POS database on this mini-PC / LAN
host = 127.0.0.1
port = 3306
user = root
password = admin123
db = sushipos

[agent]
; a REAL cashier username from the ESB table ms_posuser —
; every row the bridge writes is stamped with it
cashier_username = <real ms_posuser username>
; brand code portion of salesNum (e.g. SUSHO). Empty = derived from an existing sale
brand_code =
poll_seconds = 5
default_pax = 2
state_file = agent_state.json

; optional: map Hong Chiang app table names -> ESB ms_table.tableName
; only needed if the names differ between the app and the ESB floor plan
; [tables]
; A1 = 6
```

**Rules for this file:**
- `agent.ini` holds secrets → it is **gitignored**; never commit it, never
  paste its contents into chat. It lives ONLY on the mini-PC.
- `token` here = `AGENT_TOKEN` on the VPS. One character different = `401
  unauthorized` on every call.
- Find a cashier username with:
  `mysql -u root -p sushipos -e "SELECT username FROM ms_posuser LIMIT 10;"`

### B4. Sanity checks — run these IN ORDER

```bat
cd C:\hcbridge

:: 1) Can the agent reach the ESB database? (prints table/column probe)
python hc_bridge_agent.py --config agent.ini --probe

:: 2) Push the real ESB menu to the webapp (app starts selling the POS catalog)
python hc_bridge_agent.py --config agent.ini --sync-menu
::    expected: menu sync: {'status': True, ..., 'meals': <n>}

:: 3) Start the main loop
python hc_bridge_agent.py --config agent.ini --run
::    expected: "hc-bridge-agent ... polling https://midhong.berkatselalu.com every 5s"
```

What each proves: `--probe` = MySQL credentials + schema OK (nothing sent to
the webapp). `--sync-menu` = **token + URL are correct** (first authenticated
call). `--run` = the live connection.

### B5. Keep it running at boot (Task Scheduler)

1. Open **Task Scheduler** → **Create Task…** (not "Basic").
2. General tab: name `HC Bridge Agent`, tick **Run whether user is logged on
   or not**.
3. Triggers tab: **New…** → Begin the task: **At startup**.
4. Actions tab: **New…** → Program/script: `C:\hcbridge\run_agent.bat`,
   Start in: `C:\hcbridge`.
5. OK → enter the Windows password when asked.

`run_agent.bat` auto-restarts the agent if it ever crashes.

### Linux mini-PC instead?

```bash
pip3 install pymysql
cp agent.ini.example agent.ini && nano agent.ini    # same contents as B3
python3 hc_bridge_agent.py --config agent.ini --probe
python3 hc_bridge_agent.py --config agent.ini --sync-menu
python3 hc_bridge_agent.py --config agent.ini --run
# at boot: a systemd unit modeled on deploy/hongchiang.service pointing at the command above
```

---

## PART C — Verify the connection end to end

1. **Monitor shows the agent:** open https://midhong.berkatselalu.com/ —
   within ~30 s of `--run` starting it must show **"🟢 live agent
   connected"**. (`curl -s https://midhong.berkatselalu.com/api/health` →
   `"agent_live":true`.)
2. **Turn off the demo simulator** (so only the real agent moves orders): on
   the VPS set `BRIDGE_SIM=0` in `.env`, then
   `sudo systemctl restart hongchiang-mid`. Re-check step 1 afterwards.
3. **Place a real test order:** open https://apphong.berkatselalu.com on a
   phone → Dine In → pick a table → add items → **Save Order**.
   - App status page: stages advance `Pushed → Agent picked up → table
     opened (yellow) → order saved (red) → waiting cashier`, with the real
     ESB `salesNum` shown.
   - ESB POS floor plan: the table turns **yellow then red** with the same
     items.
4. **Settle as the cashier** on the ESB POS. Within ~5 s the app order flips
   to **FINISHED/PAID** and the table frees in the app.

When all four pass, the bridge is live.

---

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `--sync-menu` → HTTP 401 unauthorized | `agent.ini token` ≠ VPS `AGENT_TOKEN`. Re-paste both sides; restart `hongchiang-mid` after editing `.env`. |
| `--sync-menu` → connection refused / name not resolved | Part A5 not passing: DNS record, nginx site, or certbot missing for midhong. Test from the mini-PC: `curl https://midhong.berkatselalu.com/api/health`. |
| `--probe` → MySQL access denied | Wrong `[mysql]` credentials, or MySQL only listens on another host. Test: `mysql -h 127.0.0.1 -u root -p sushipos`. |
| Monitor stays "🟠 simulator" / `agent_live:false` | Agent loop not running, or it is polling the wrong URL (apphong instead of **midhong**), or token mismatch (check the agent's console for 401s). |
| Order stage = `error: menu not found` | The ordered item has no match in `ms_menu` (menuCode empty AND name differs). Run `--sync-menu` again so the app sells exactly the ESB catalog, or fill `menuCode` in ESB Core. |
| Order stuck at `queued` | Agent not polling (see agent console), or midhong restarted and lost the in-memory queue — apphong's outbox re-pushes automatically within ~1 min. |
| Table never turns yellow on the POS | Check the agent console error; commonest: app table name not in `ms_table` → add a `[tables]` mapping in `agent.ini`. |
| App never shows PAID after cashier settles | `journalctl -u hongchiang-mid -f` — look for callback retries; `APP_URL` in `.env` must point at apphong (loopback 3000 on the same VPS). |

## Security checklist

- `agent.ini` stays on the mini-PC only (it is gitignored for a reason).
- Rotate a token by changing BOTH sides (VPS `.env` + `agent.ini`) and
  restarting `hongchiang-mid` + the agent.
- Prefer a dedicated MySQL user over `root` long-term:
  ```sql
  CREATE USER 'hcbridge'@'localhost' IDENTIFIED BY '<strong-password>';
  GRANT SELECT, INSERT, UPDATE ON sushipos.* TO 'hcbridge'@'localhost';
  ```
  then update `[mysql]` in `agent.ini`.
