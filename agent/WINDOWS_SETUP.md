# Windows Agent Setup Runbook — for Claude Code on the ESB POS PC

> **How to use:** on the Windows PC where ESB POS is installed, open a terminal,
> start Claude Code (`claude`), and say:
> *"Read agent/WINDOWS_SETUP.md and perform the setup step by step."*
> (If the repo isn't on the PC yet, see Part 0.)

---

## Instructions for the agent executing this runbook

You are setting up the **Hong Chiang → ESB POS bridge agent** on this Windows
machine. The ESB POS and its MySQL run locally here. Work through the parts in
order; after each part run its **Verify** block and do not continue until it
passes. Rules:

- You are on **Windows** — use PowerShell/cmd syntax, `py`/`python` launcher,
  backslash paths. No `sudo`, no bash-isms.
- `agent.ini` contains secrets: create it locally, NEVER commit it (it is
  gitignored), never print the full token into the chat (last 4 chars is fine
  for comparison).
- Values marked `<ASK USER>` must come from the user — ask and wait.
- If a command fails, diagnose and fix before moving on.

**Fixed facts:**

| Item | Value |
|---|---|
| Bridge middleware (webapp) | `https://midhong.berkatselalu.com` |
| Agent files | `agent/hc_bridge_agent.py`, `agent/agent.ini.example`, `agent/run_agent.bat` |
| Install folder | `C:\hcbridge` (create it) |
| ESB MySQL (local) | host `127.0.0.1`, port `3306`, db `sushipos`, user `root`, password `<ASK USER — do not assume>` |
| Agent token | `<ASK USER>` = the `AGENT_TOKEN` value from the VPS `.env` (`~/work/hongchiang-esb/.env` on the VPS) |

---

## Part 0 — Get the agent files onto this PC

If this runbook is being read from a local clone of the repo, copy the three
agent files to the install folder:

```powershell
mkdir C:\hcbridge -Force
copy agent\hc_bridge_agent.py C:\hcbridge\
copy agent\agent.ini.example C:\hcbridge\
copy agent\run_agent.bat C:\hcbridge\
```

If the repo is NOT on this PC: clone it first
(`git clone https://github.com/sarimiduo/hongchiangorderingsystem.git` — ask
the user to authenticate if the repo is private, or have them copy just the
three files into `C:\hcbridge` by hand), then do the copy above.

**Verify:** `dir C:\hcbridge` lists the three files.

## Part 1 — Python + driver

```powershell
python --version    # or: py --version  — need 3.10+
```

If Python is missing, download it from https://www.python.org/downloads/ and
install with **"Add python.exe to PATH" ticked** (ask the user to click
through the installer if you cannot), then reopen the terminal.

```powershell
pip install pymysql
```

**Verify:** `python -c "import pymysql; print(pymysql.__version__)"` prints a version.

## Part 2 — Confirm the local ESB MySQL

Ask the user for the MySQL root password (or a dedicated user if they made
one). Then test the connection WITHOUT the agent first:

```powershell
python -c "import pymysql; c=pymysql.connect(host='127.0.0.1',port=3306,user='root',password='<PW>',database='sushipos'); cur=c.cursor(); cur.execute('SELECT COUNT(*) FROM ms_menu'); print('menus:',cur.fetchone()[0]); cur.execute('SELECT username FROM ms_posuser LIMIT 5'); print('cashiers:',[r[0] for r in cur.fetchall()])"
```

Keep the printed **cashier usernames** — one of them goes into `agent.ini`
(ask the user which one to use).

**Verify:** the command prints a menu count > 0 and at least one username.
If connection is refused: the ESB MySQL may run on a different port or as a
named instance — check with `netstat -ano | findstr 3306` and ask the user
how ESB's MySQL was installed.

## Part 3 — Create `agent.ini` (the token file)

Ask the user for the **AGENT_TOKEN** (from the VPS: `grep AGENT_TOKEN ~/work/hongchiang-esb/.env`).
Then write `C:\hcbridge\agent.ini`:

```ini
[webapp]
url = https://midhong.berkatselalu.com
token = <AGENT_TOKEN from the user>

[mysql]
host = 127.0.0.1
port = 3306
user = root
password = <MySQL password from Part 2>
db = sushipos

[agent]
cashier_username = <username chosen in Part 2>
brand_code =
poll_seconds = 5
default_pax = 2
state_file = agent_state.json
```

**Verify:** the file parses —
`python -c "import configparser; cp=configparser.ConfigParser(); cp.read(r'C:\hcbridge\agent.ini'); print(cp.sections())"`
prints `['webapp', 'mysql', 'agent']`.

## Part 4 — Sanity checks, in order

```powershell
cd C:\hcbridge

# 1) DB + schema probe (local only, nothing sent to the webapp)
python hc_bridge_agent.py --config agent.ini --probe

# 2) First authenticated call: push the ESB menu to the webapp
python hc_bridge_agent.py --config agent.ini --sync-menu
```

**Verify:** `--probe` lists tr_saleshead/tr_salesmenu/ms_menu with column
counts and prints branchID + brand code. `--sync-menu` prints
`{'status': True, ... 'meals': <n>}`.

- `401 unauthorized` → the token in agent.ini ≠ the VPS `AGENT_TOKEN`
  (compare last 4 characters with the user; also make sure the VPS
  `hongchiang-mid` service was restarted after the token was set).
- Connection/name error → `curl https://midhong.berkatselalu.com/api/health`
  (or `Invoke-WebRequest`) from this PC must return `{"ok":true,...}` first;
  if not, the problem is VPS-side (DNS/nginx/service), stop and report it.

## Part 5 — Run and confirm the live connection

```powershell
python hc_bridge_agent.py --config agent.ini --run
```

Leave it running and check (new terminal or browser):

```powershell
curl https://midhong.berkatselalu.com/api/health
```

**Verify:** within ~30 s it reports `"agent_live":true`, and
https://midhong.berkatselalu.com/ shows **"🟢 live agent connected"**.

Then tell the user to flip the simulator off on the VPS so only this real
agent moves orders: set `BRIDGE_SIM=0` in the VPS `.env` and
`sudo systemctl restart hongchiang-mid`.

## Part 6 — Auto-start at boot

Preferred (GUI — walk the user through it): Task Scheduler → Create Task… →
name `HC Bridge Agent`, tick *Run whether user is logged on or not* →
Triggers: *At startup* → Actions: Program `C:\hcbridge\run_agent.bat`,
Start in `C:\hcbridge` → OK.

Or do it yourself from an **elevated** prompt:

```powershell
schtasks /Create /TN "HC Bridge Agent" /TR "C:\hcbridge\run_agent.bat" /SC ONSTART /RU SYSTEM /RL HIGHEST
schtasks /Run /TN "HC Bridge Agent"     # start it now without rebooting
```

**Verify:** `schtasks /Query /TN "HC Bridge Agent"` shows Ready/Running, and
`/api/health` still shows `"agent_live":true` after the console window from
Part 5 is closed.

## Part 7 — End-to-end acceptance test

1. On a phone, open https://apphong.berkatselalu.com → Dine In → pick a table
   → add items → **Save Order**.
2. Watch: app status page advances to *waiting cashier* with a real ESB
   `salesNum`; the ESB POS floor plan turns **yellow then red** on that table
   with the same items.
3. Settle the bill as the cashier on the ESB POS → within ~5 s the app order
   flips to **FINISHED/PAID** and the table frees.

Report each step's result to the user. Full troubleshooting table:
`docs/AGENT_CONNECT.md`.

## Final checklist (report this to the user)

- [ ] `C:\hcbridge` has the 3 files + `agent.ini` (secrets local only)
- [ ] `--probe` OK (DB reachable, schema probed, cashier set)
- [ ] `--sync-menu` OK (token accepted; app sells the ESB catalog)
- [ ] midhong `/api/health` → `"agent_live":true`; `BRIDGE_SIM=0` on the VPS
- [ ] Task Scheduler job survives a reboot
- [ ] One real order went app → yellow → red → cashier settle → PAID in app
