#!/usr/bin/env python3
"""Hong Chiang -> ESB POS bridge agent.

Runs next to the ESB POS (same LAN / mini PC). Polls the webapp middleware for
orders placed in the Hong Chiang ordering app and writes them into the ESB POS
MySQL database as the POS's own pre-payment state:

  TXN A ("open table", floor plan YELLOW): tr_saleshead (statusID 1, totals 0)
        + tr_tableusage
  TXN B ("save order", floor plan RED):    tr_salesmenu rows (statusID 13,
        flagPending 1, batchID per round) + head totals update

Then it watches each written sale until the human cashier settles (or voids)
the bill on the ESB POS, and reports back so the webapp can feed the result
into the Hong Chiang KDS (reservations/update COMPLETED / walkIns/update paid).

Design: docs/HC_ESB_SQL_BRIDGE_DESIGN.md. Rules inherited from the production
ESB replication middleware:
  - MySQL 5.7-safe SQL only; probe information_schema before using anything
    that varies between ESB builds; degrade to sensible defaults.
  - Whole order or nothing, one DB transaction per TXN; rollback on any error.
  - Idempotent: a re-delivered command never duplicates (guarded by order_no
    stamped into tr_saleshead.additionalInfo and by the local state file).
  - Writes stamped with a REAL cashier username (config), never "MIDDLEWARE".
  - Tax math mirrors the vendor CalculateTotal.php: per-line other tax (service)
    and VAT from map_branchvisitpurpose + menu flags (flagTax/flagOtherTax/
    flagLuxuryItem), DPP ratio and rounding from ms_setting.

Usage:
  python3 hc_bridge_agent.py --config agent.ini --run          # main loop
  python3 hc_bridge_agent.py --config agent.ini --sync-menu    # push ESB menu to webapp
  python3 hc_bridge_agent.py --config agent.ini --probe        # schema sanity check

Dependencies: Python 3.8+, PyMySQL (pip install pymysql).
"""

import argparse
import configparser
import json
import random
import sys
import time
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

try:
    import pymysql
except ImportError:
    sys.exit("PyMySQL is required: pip install pymysql")

AGENT_VERSION = "0.1.0"

OPEN_STATUS_IDS = (1, 13, 15, 16, 33)       # head still open / in progress
PAID_STATUS_IDS = (8, 9, 10, 11, 31)        # finished / (half) paid / invoiced
VOID_STATUS_IDS = (12, 24)                  # cancelled / void


# --------------------------------------------------------------- webapp API
class Webapp:
    def __init__(self, base, token):
        self.base = base.rstrip("/")
        self.token = token

    def _call(self, method, path, payload=None):
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            method=method,
            headers={
                "Authorization": "Bearer " + self.token,
                "Content-Type": "application/json",
                "X-Agent-Info": "hc-bridge-agent/" + AGENT_VERSION,
            },
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())

    def commands(self):
        return self._call("GET", "/api/bridge/agent/commands").get("data", [])

    def report(self, cmd_id, stage, **kw):
        body = {"id": cmd_id, "stage": stage}
        body.update(kw)
        return self._call("POST", "/api/bridge/agent/report", body)

    def heartbeat(self):
        return self._call("POST", "/api/bridge/agent/heartbeat", {})

    def push_menu(self, payload):
        return self._call("POST", "/api/bridge/agent/menu", payload)

    def push_tables(self, payload):
        return self._call("POST", "/api/bridge/agent/tables", payload)


# ----------------------------------------------------------------- DB layer
class Db:
    def __init__(self, cfg):
        self.conn = pymysql.connect(
            host=cfg.get("host", "127.0.0.1"), port=cfg.getint("port", 3306),
            user=cfg["user"], password=cfg["password"], database=cfg["db"],
            charset="utf8", autocommit=True, cursorclass=pymysql.cursors.DictCursor,
        )
        self._columns = {}

    def q(self, sql, args=None):
        with self.conn.cursor() as c:
            c.execute(sql, args or ())
            return c.fetchall()

    def one(self, sql, args=None):
        rows = self.q(sql, args)
        return rows[0] if rows else None

    def columns(self, table):
        """information_schema probe, cached. {} when the table doesn't exist."""
        if table not in self._columns:
            rows = self.q(
                "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA "
                "FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s", (table,))
            self._columns[table] = {r["COLUMN_NAME"]: r for r in rows}
        return self._columns[table]

    def insert(self, cur, table, values):
        """INSERT taking build differences into account: only columns that exist
        are written; NOT-NULL columns without a default get a type-appropriate
        filler so strict mode never rejects the row."""
        cols = self.columns(table)
        if not cols:
            raise RuntimeError("table %s does not exist on this build" % table)
        row = {}
        for name, meta in cols.items():
            if "auto_increment" in (meta["EXTRA"] or ""):
                continue
            if name in values:
                row[name] = values[name]
            elif meta["IS_NULLABLE"] == "YES" or meta["COLUMN_DEFAULT"] is not None:
                continue  # let the DB default / NULL apply
            else:  # NOT NULL, no default, we did not set it
                dt = meta["DATA_TYPE"]
                if dt in ("int", "bigint", "tinyint", "smallint", "decimal", "double", "float"):
                    row[name] = 0
                elif dt in ("datetime", "timestamp", "date"):
                    row[name] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                else:
                    row[name] = ""
        collist = ", ".join("`%s`" % c for c in row)
        marks = ", ".join(["%s"] * len(row))
        cur.execute("INSERT INTO `%s` (%s) VALUES (%s)" % (table, collist, marks),
                    list(row.values()))
        return cur.lastrowid


# ------------------------------------------------------------------ helpers
def now_s():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today_s():
    return datetime.now().strftime("%Y-%m-%d")


class Agent:
    def __init__(self, ini_path):
        cp = configparser.ConfigParser()
        if not cp.read(ini_path):
            sys.exit("config not found: %s" % ini_path)
        self.web = Webapp(cp["webapp"]["url"], cp["webapp"]["token"])
        self.db = Db(cp["mysql"])
        a = cp["agent"]
        self.cashier = a.get("cashier_username", "KASIR1")
        self.brand_code = a.get("brand_code", "")  # empty -> derived from an existing salesNum
        self.poll_seconds = a.getint("poll_seconds", 5)
        # 0 disables the periodic re-sync; the first sync runs right at startup
        self.menu_sync_minutes = a.getint("menu_sync_minutes", 10)
        self.pad_pax = a.getint("default_pax", 2)
        self.state_path = Path(a.get("state_file", "agent_state.json"))
        # Optional [tables] section: Hong Chiang table name -> ESB tableName
        self.table_map = dict(cp["tables"]) if cp.has_section("tables") else {}
        self.state = {"tracked": {}, "done_orders": []}
        if self.state_path.exists():
            try:
                self.state = json.loads(self.state_path.read_text())
            except Exception:
                pass

    def save_state(self):
        self.state_path.write_text(json.dumps(self.state, indent=1))

    # ----- master lookups (probed, cached per run) -----
    def branch_id(self):
        r = self.one("SELECT branchID FROM ms_branch ORDER BY branchID LIMIT 1")
        return r["branchID"] if r else 1

    def one(self, *a):
        return self.db.one(*a)

    def setting(self, key1, key2, which=1, default=None):
        if not self.db.columns("ms_setting"):
            return default
        r = self.one("SELECT value1, value2 FROM ms_setting WHERE key1 = %s AND key2 = %s",
                     (key1, key2))
        if not r:
            return default
        v = r["value1"] if which == 1 else r["value2"]
        return v if v is not None else default

    def tax_params(self, mode):
        """Per-visit-purpose tax config (map_branchvisitpurpose) + POS settings.
        Mirrors vendor CalculateTotal.php: taxValue (VAT %), additionalTaxValue
        (other tax / service %), flagOtherTaxVat (VAT applies on top of other
        tax), DPP ratio, rounding settings, and the price template."""
        p = {"taxValue": 0.0, "additionalTaxValue": 0.0, "flagOtherTaxVat": 0,
             "orderFee": 0.0, "menuTemplateID": None}
        if self.db.columns("map_branchvisitpurpose"):
            r = self.one(
                "SELECT additionalTaxValue, flagOtherTaxVat, taxValue, orderFee, menuTemplateID "
                "FROM map_branchvisitpurpose WHERE branchID = %s AND visitPurposeID = %s",
                (self.branch_id(), self.visit_purpose(mode)))
            if r:
                p.update(taxValue=float(r["taxValue"] or 0),
                         additionalTaxValue=float(r["additionalTaxValue"] or 0),
                         flagOtherTaxVat=int(r["flagOtherTaxVat"] or 0),
                         orderFee=float(r["orderFee"] or 0),
                         menuTemplateID=r["menuTemplateID"])
        p["dppRatio"] = (float(self.setting("VAT", "DPP Calculation Ratio", 1, 1) or 1)
                         / float(self.setting("VAT", "DPP Calculation Ratio", 2, 1) or 1))
        p["roundNearest"] = float(self.setting("POS", "Rounding Nearest Value", 1, 1) or 1)
        p["roundMode"] = (self.setting("POS", "Rounding Mode", 1, "UP") or "UP").upper()
        return p

    @staticmethod
    def apply_rounding(amount, nearest, mode):
        if not nearest or nearest <= 1:
            return amount
        import math
        q = amount / nearest
        if mode == "DOWN":
            q = math.floor(q)
        elif mode in ("NORMAL", "HALF"):
            q = math.floor(q + 0.5)
        else:  # UP
            q = math.ceil(q)
        return q * nearest

    def visit_purpose(self, mode):
        rows = self.db.q("SELECT visitPurposeID, visitPurposeName FROM ms_visitpurpose") \
            if self.db.columns("ms_visitpurpose") else []
        keys = ("take", "away", "bungkus", "bawa") if mode == "walkin" else ("dine",)
        for r in rows:
            name = (r.get("visitPurposeName") or "").lower()
            if any(k in name for k in keys):
                return r["visitPurposeID"]
        return rows[0]["visitPurposeID"] if rows else 1

    def table_by_name(self, name):
        esb_name = self.table_map.get(str(name), str(name))
        return self.one(
            "SELECT tableID, tableName FROM ms_table WHERE tableName = %s AND flagActive = 1",
            (esb_name,))

    MENU_COLS = "menuID, menuName, price, flagTax, flagOtherTax, flagLuxuryItem"

    def resolve_menu(self, item, template_id=None):
        """menuCode first (the stable, user-editable key), menuName as fallback.
        Price comes from the visit purpose's menu template when available."""
        code = (item.get("menu_code") or "").strip()
        r = None
        if code:
            r = self.one("SELECT %s FROM ms_menu WHERE menuCode = %%s AND flagActive = 1"
                         % self.MENU_COLS, (code,))
        if not r:
            name = (item.get("menu_name") or "").strip()
            r = self.one("SELECT %s FROM ms_menu WHERE LOWER(menuName) = LOWER(%%s) "
                         "AND flagActive = 1" % self.MENU_COLS, (name,))
        if r and template_id and self.db.columns("ms_menutemplatedetail"):
            tp = self.one("SELECT price FROM ms_menutemplatedetail "
                          "WHERE menuTemplateID = %s AND menuID = %s AND flagActive = 1",
                          (template_id, r["menuID"]))
            if tp and float(tp["price"] or 0) > 0:
                r = dict(r, price=tp["price"])
        return r

    def derive_brand_code(self):
        if self.brand_code:
            return self.brand_code
        r = self.one("SELECT salesNum FROM tr_saleshead ORDER BY salesDateIn DESC LIMIT 1")
        if r and r["salesNum"].startswith("S"):
            body = r["salesNum"][1:]
            code = body[:-12] if len(body) > 12 else body[:5]
            if code:
                self.brand_code = code
                return code
        self.brand_code = "BRIDGE"
        return self.brand_code

    def gen_sales_num(self, cur):
        for _ in range(10):
            num = "S%s%d%02d" % (self.derive_brand_code(), int(time.time()), random.randint(0, 99))
            cur.execute("SELECT 1 FROM tr_saleshead WHERE salesNum = %s", (num,))
            if not cur.fetchone():
                return num
            time.sleep(0.05)
        raise RuntimeError("could not generate a unique salesNum")

    def next_queue_num(self, cur):
        # Demo-grade: MAX+1 for today's business date inside the transaction.
        # (The production replication middleware uses the counter table under a
        # row lock; wire ms_transnumber / ms_counter the same way for production.)
        cur.execute("SELECT MAX(CAST(queueNum AS UNSIGNED)) AS q FROM tr_saleshead "
                    "WHERE salesDate = %s FOR UPDATE", (today_s(),))
        r = cur.fetchone()
        return str(int(r["q"] or 0) + 1)

    # ------------------------------------------------------------- TXN A + B
    def existing_open_head(self, table_id):
        return self.one(
            "SELECT salesNum FROM tr_saleshead WHERE tableID = %s AND salesDateOut IS NULL "
            "AND statusID IN (%s) ORDER BY salesDateIn DESC LIMIT 1"
            % ("%s", ",".join(str(s) for s in OPEN_STATUS_IDS)), (table_id,))

    def txn_a_open(self, cmd):
        """Open the table (or the takeaway head). Returns (salesNum, attached)."""
        table = None
        if cmd["mode"] == "dinein":
            table = self.table_by_name(cmd.get("table_name") or "")
            if not table:
                raise RuntimeError("table '%s' not found/active in ms_table" % cmd.get("table_name"))
            existing = self.existing_open_head(table["tableID"])
            if existing:
                return existing["salesNum"], True

        conn = self.db.conn
        conn.begin()
        try:
            with conn.cursor() as cur:
                sales_num = self.gen_sales_num(cur)
                queue_num = self.next_queue_num(cur)
                head = {
                    "salesNum": sales_num,
                    "queueNum": queue_num,
                    "salesDate": today_s(),
                    "salesDateIn": now_s(),
                    "branchID": self.branch_id(),
                    "tableID": table["tableID"] if table else 0,
                    "visitPurposeID": self.visit_purpose(cmd["mode"]),
                    "paxTotal": int(cmd.get("pax") or self.pad_pax),
                    "statusID": 1,
                    "subtotal": 0, "grandTotal": 0, "paymentTotal": 0,
                    "additionalInfo": "HC:" + cmd["order_no"],  # idempotency marker
                    "remarks": (cmd.get("note") or "")[:200],
                    "createdBy": self.cashier,
                }
                self.db.insert(cur, "tr_saleshead", head)
                if table and self.db.columns("tr_tableusage"):
                    self.db.insert(cur, "tr_tableusage", {
                        "referenceID": sales_num,
                        "expiredTime": (datetime.now() + timedelta(minutes=90)).strftime("%Y-%m-%d %H:%M:%S"),
                        "username": self.cashier,
                    })
            conn.commit()
            return sales_num, False
        except Exception:
            conn.rollback()
            raise

    def txn_b_save(self, cmd, sales_num):
        """Insert the order lines with ESB tax math and refresh the head totals.

        Tax model (vendor CalculateTotal.php + map_branchvisitpurpose):
          other tax (service) % applies per line when the menu has flagOtherTax;
          VAT % applies when the menu has flagTax; when flagOtherTaxVat the VAT
          base (DPP) includes the other tax; non-luxury DPP is scaled by the
          "VAT / DPP Calculation Ratio" setting; head rounding per POS settings.
        """
        tp = self.tax_params(cmd["mode"])
        # Resolve every item BEFORE writing anything (whole order or nothing).
        resolved = []
        for it in cmd["items"]:
            r = self.resolve_menu(it, tp["menuTemplateID"])
            if not r:
                raise RuntimeError("menu not found in ms_menu (code=%r name=%r) — fix menuCode mapping"
                                   % (it.get("menu_code"), it.get("menu_name")))
            price = float(it.get("price") or 0) or float(r["price"] or 0)
            resolved.append((r, it, price))

        conn = self.db.conn
        conn.begin()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT COALESCE(MAX(batchID),0)+1 AS b FROM tr_salesmenu "
                            "WHERE salesNum = %s FOR UPDATE", (sales_num,))
                batch = int(cur.fetchone()["b"])
                for i, (menu, it, price) in enumerate(resolved):
                    qty = max(1, int(it.get("qty") or 1))
                    line_total = price * qty
                    other_pct = tp["additionalTaxValue"] if int(menu.get("flagOtherTax") or 0) else 0.0
                    other_val = line_total * other_pct / 100.0
                    vat_pct = tp["taxValue"] if int(menu.get("flagTax") or 0) else 0.0
                    dpp = line_total + (other_val if tp["flagOtherTaxVat"] else 0.0)
                    if not int(menu.get("flagLuxuryItem") or 0):
                        dpp *= tp["dppRatio"]
                    vat_val = dpp * vat_pct / 100.0
                    self.db.insert(cur, "tr_salesmenu", {
                        "localID": i + 1,
                        "salesNum": sales_num,
                        "batchID": batch,
                        "menuRefID": 0, "menuGroupID": 0,
                        "menuID": menu["menuID"],
                        "qty": qty,
                        "originalPrice": price, "price": price,
                        "otherTax": other_pct, "otherTaxValue": other_val,
                        "vat": vat_pct, "vatValue": vat_val,
                        "otherTaxOnVat": tp["flagOtherTaxVat"],
                        "total": line_total,
                        "notes": (it.get("notes") or "")[:200],
                        "statusID": 13,          # Preparing
                        "flagPending": 1,
                        "salesType": "POS",
                        "createdBy": self.cashier, "createdDate": now_s(),
                    })
                # Refresh the head from the line aggregates (correct across batches).
                cur.execute(
                    "SELECT COALESCE(SUM(total),0) st, COALESCE(SUM(otherTaxValue),0) ot, "
                    "COALESCE(SUM(vatValue),0) vt FROM tr_salesmenu "
                    "WHERE salesNum = %s AND statusID NOT IN (12, 24)", (sales_num,))
                agg = cur.fetchone()
                subtotal = float(agg["st"])
                other_tax = float(agg["ot"])
                vat_total = float(agg["vt"])
                raw_grand = subtotal + other_tax + vat_total + tp["orderFee"]
                grand = self.apply_rounding(raw_grand, tp["roundNearest"], tp["roundMode"])
                rounding = grand - raw_grand
                cur.execute(
                    "UPDATE tr_saleshead SET subtotal = %s, otherTaxTotal = %s, vatTotal = %s, "
                    "orderFee = %s, roundingTotal = %s, grandTotal = %s, "
                    "editedBy = %s, editedDate = %s WHERE salesNum = %s",
                    (subtotal, other_tax, vat_total, tp["orderFee"], rounding, grand,
                     self.cashier, now_s(), sales_num))
            conn.commit()
            return batch
        except Exception:
            conn.rollback()
            raise

    # --------------------------------------------------------------- watcher
    def payment_name(self, sales_num):
        if not self.db.columns("tr_salespayment"):
            return None
        pm_cols = self.db.columns("ms_paymentmethod")
        name_col = next((c for c in pm_cols if "name" in c.lower()), None)
        if name_col:
            r = self.one(
                "SELECT pm.`%s` AS n FROM tr_salespayment sp "
                "JOIN ms_paymentmethod pm ON pm.paymentMethodID = sp.paymentMethodID "
                "WHERE sp.salesNum = %%s ORDER BY sp.ID DESC LIMIT 1" % name_col,
                (sales_num,))
            if r:
                return r["n"]
        return None

    def watch(self):
        for sales_num, t in list(self.state["tracked"].items()):
            head = self.one(
                "SELECT statusID, paymentTotal, grandTotal, billNum, salesDateOut "
                "FROM tr_saleshead WHERE salesNum = %s", (sales_num,))
            if not head:
                continue
            settled = (
                head["statusID"] in PAID_STATUS_IDS
                or (float(head["paymentTotal"] or 0) >= float(head["grandTotal"] or 0) > 0
                    and (head["billNum"] or head["salesDateOut"]))
            )
            if settled:
                self.web.report(t["cmd_id"], "settled",
                                billNum=head["billNum"],
                                payment_method_name=self.payment_name(sales_num),
                                detail="Cashier settled the bill on ESB POS (salesNum %s)" % sales_num)
                del self.state["tracked"][sales_num]
                self.save_state()
            elif head["statusID"] in VOID_STATUS_IDS:
                self.web.report(t["cmd_id"], "voided",
                                detail="Voided on ESB POS (statusID %s)" % head["statusID"])
                del self.state["tracked"][sales_num]
                self.save_state()

    # ------------------------------------------------------------- main loop
    def process(self, cmd):
        if cmd["order_no"] in self.state["done_orders"]:
            return  # idempotency across restarts
        self.web.report(cmd["id"], "picked_up", detail="Local agent picked up the order")
        try:
            sales_num, attached = self.txn_a_open(cmd)
            self.web.report(
                cmd["id"], "table_opened", salesNum=sales_num,
                detail=("Attached to open table session %s" % sales_num) if attached else
                       ("TXN A: tr_saleshead + tr_tableusage inserted — table %s OPEN (yellow), salesNum %s"
                        % (cmd.get("table_name") or "-", sales_num)))
            batch = self.txn_b_save(cmd, sales_num)
            self.web.report(
                cmd["id"], "order_saved", salesNum=sales_num,
                detail="TXN B: %d item(s) into tr_salesmenu (batch %d), head totals updated — OCCUPIED (red)"
                       % (len(cmd["items"]), batch))
            self.web.report(cmd["id"], "waiting_cashier",
                            detail="Watching tr_saleshead — waiting for the cashier on ESB POS")
            self.state["tracked"][sales_num] = {"cmd_id": cmd["id"], "order_no": cmd["order_no"]}
            self.state["done_orders"] = (self.state["done_orders"] + [cmd["order_no"]])[-500:]
            self.save_state()
        except Exception as e:
            self.web.report(cmd["id"], "error", error=str(e), detail="Agent failed: %s" % e)

    def run(self):
        print("hc-bridge-agent %s — polling %s every %ss, DB=%s"
              % (AGENT_VERSION, self.web.base, self.poll_seconds, self.db.conn.db.decode()
                 if isinstance(self.db.conn.db, bytes) else self.db.conn.db))
        last_menu_sync = 0.0
        while True:
            try:
                self.web.heartbeat()
                if self.menu_sync_minutes and \
                        time.time() - last_menu_sync >= self.menu_sync_minutes * 60:
                    # A sync failure (e.g. older midhong without the tables
                    # endpoint) must not block order processing below, and
                    # retries wait for the next interval, not the next poll.
                    last_menu_sync = time.time()
                    try:
                        self.sync_menu()
                    except Exception as e:
                        print("[menu-sync]", e, file=sys.stderr)
                    try:
                        self.sync_tables()
                    except Exception as e:
                        print("[table-sync]", e, file=sys.stderr)
                for cmd in self.web.commands():
                    self.process(cmd)
                self.watch()
            except Exception as e:
                print("[loop]", e, file=sys.stderr)
            time.sleep(self.poll_seconds)

    # ------------------------------------------------------------- menu sync
    def sync_menu(self):
        cats, cat_of = [], {}
        dcols = self.db.columns("ms_menucategorydetail")
        if dcols:
            # Column names drift between ESB builds — probe, don't assume.
            id_col = "menuCategoryDetailID" if "menuCategoryDetailID" in dcols else "ID"
            name_col = next((c for c in dcols if c.lower().endswith("detaildesc")), None) \
                or next((c for c in dcols if "desc" in c.lower()), None)
            flag = " WHERE flagActive = 1" if "flagActive" in dcols else ""
            for r in self.db.q("SELECT `%s` AS did, `%s` AS dname FROM ms_menucategorydetail%s"
                               % (id_col, name_col or id_col, flag)):
                cat_of[r["did"]] = r["did"]
                cats.append({"id": r["did"], "name": str(r["dname"])})
        # Price source differs per build: ms_menu.price, or (this build) the
        # active menu template details. Take ms_menu.price, fall back to template.
        tpl_price = {}
        if self.db.columns("ms_menutemplatedetail"):
            for r in self.db.q("SELECT menuID, MAX(price) AS p FROM ms_menutemplatedetail "
                               "WHERE flagActive = 1 GROUP BY menuID"):
                tpl_price[r["menuID"]] = float(r["p"] or 0)
        meals = []
        for r in self.db.q("SELECT menuID, menuName, menuShortName, menuCode, price, "
                           "menuCategoryDetailID FROM ms_menu WHERE flagActive = 1"):
            meals.append({
                "meal_id": r["menuID"],
                "meal_name": r["menuName"],
                "short_name": r["menuShortName"] or r["menuName"],
                "menu_code": r["menuCode"] or "",
                "price": float(r["price"] or 0) or tpl_price.get(r["menuID"], 0),
                "category_id": cat_of.get(r["menuCategoryDetailID"], cats[0]["id"] if cats else 1),
            })
        out = self.web.push_menu({"categories": cats or [{"id": 1, "name": "Menu"}], "meals": meals})
        print("menu sync:", out)

    # ------------------------------------------------------------ table sync
    def sync_tables(self):
        """Push the ESB floor plan (ms_table) so the app's table picker shows
        the real tables and seat counts instead of its seeded demo list."""
        tables = []
        for r in self.db.q("SELECT tableID, tableName, tableSeat FROM ms_table "
                           "WHERE flagActive = 1"):
            try:
                seats = int(str(r["tableSeat"] or "").strip() or 0)
            except ValueError:
                seats = 0
            tables.append({"table_id": r["tableID"], "table_name": r["tableName"],
                           "seats": seats or 2})
        out = self.web.push_tables({"tables": tables})
        print("table sync:", out)

    def probe(self):
        for t in ("tr_saleshead", "tr_salesmenu", "tr_tableusage", "ms_table", "ms_menu",
                  "ms_visitpurpose", "tr_salespayment", "ms_paymentmethod",
                  "ms_transnumber", "ms_counter"):
            cols = self.db.columns(t)
            print("%-18s %s" % (t, ("%d columns" % len(cols)) if cols else "MISSING"))
        print("branchID:", self.branch_id(), "| brand code:", self.derive_brand_code(),
              "| dine-in purpose:", self.visit_purpose("dinein"),
              "| takeaway purpose:", self.visit_purpose("walkin"))


def main():
    ap = argparse.ArgumentParser(description="Hong Chiang -> ESB POS bridge agent")
    ap.add_argument("--config", default="agent.ini")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--sync-menu", action="store_true")
    ap.add_argument("--sync-tables", action="store_true")
    ap.add_argument("--probe", action="store_true")
    args = ap.parse_args()
    agent = Agent(args.config)
    if args.probe:
        agent.probe()
    elif args.sync_menu:
        agent.sync_menu()
    elif args.sync_tables:
        agent.sync_tables()
    elif args.run:
        agent.run()
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
