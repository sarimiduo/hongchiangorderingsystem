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

## Setup (Windows mini-PC)

1. Install Python 3.10+ from python.org (tick "Add python.exe to PATH").
2. `pip install pymysql`
3. Copy this `agent/` folder to the mini-PC, e.g. `C:\hcbridge\`.
4. Edit `agent.ini`:
   - `[webapp] url` — your deployed app (https://apphong.berkatselalu.com)
   - `[webapp] token` — must equal `AGENT_TOKEN` in the webapp `.env` on the VPS
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

On the VPS, set the matching token in `/var/www/hongchiangorderingsystem/.env`:

```
AGENT_TOKEN=<same value as agent.ini>
BRIDGE_SIM=0     # optional: disable the demo simulator once the real agent is live
```

then `sudo systemctl restart hongchiang`.

## What it writes (and never writes)

Writes: `tr_saleshead` + `tr_tableusage` (open table, yellow), `tr_salesmenu`
+ head totals (order saved, red) — stamped with the configured cashier, whole
order in one transaction, idempotent per Hong Chiang order number.
Never writes: `billNum`, payments, kitchen/queue/websocket/stock tables —
those belong to the POS. Settlement is detected read-only and reported back.

Note (demo-grade): totals are written tax-exclusive. Wire the
esb-pos-data-structure money rules before production use at a taxed branch.

## Linux alternative

```
python3 hc_bridge_agent.py --config agent.ini --run
```

systemd unit: copy the pattern from `deploy/hongchiang.service`, point
`ExecStart` at the command above.
