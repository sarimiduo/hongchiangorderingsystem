#!/usr/bin/env python3
"""Stateful stub of the Hong-Chiang KDS API for agent development.

Replays the behavior VERIFIED on the vendor's test device 2026-10-19
(docs/vendor-samples/): SEATED reservations, one order per visit created at
seating, one row per plate (qty 1), rounds appended, {code,msg} errors
without a status field, and reservations/update COMPLETED closing both the
reservation and the order (S00052 afterwards). walkIns/update paid removes
the order from walkIns/get.

Usage:
  python3 kds_stub.py [port]            # default 5500, serves /kds/*

Control endpoints (test driver):
  POST /ctl/add-round   {"order_no": "...", "meals": [[meal_id, name, price], ...]}
  POST /ctl/seat        {"table_id": 2, "guest_count": 6}
  POST /ctl/add-walkin  {"meals": [[meal_id, name, price], ...]}
  GET  /ctl/state
"""

import json
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer

NOW = lambda: datetime.now().strftime("%Y-%m-%d %H:%M:%S")

STATE = {
    "next_res": 27, "next_order": 20, "next_row": 1000, "next_walkin": 1,
    "tables": [
        {"id": 1, "name": "5", "seats": 2}, {"id": 2, "name": "6", "seats": 6},
        {"id": 3, "name": "7", "seats": 1}, {"id": 4, "name": "8", "seats": 1},
    ],
    "reservations": [],  # {id, table_id, status, guest_count, seated_time, completed_time}
    "orders": [],        # {id, order_no, table_id|None, status, meals: [rows], walkin: bool, paid: bool}
    "log": [],
}


def seat(table_id, guest_count):
    res = {"id": STATE["next_res"], "table_id": table_id, "status": "SEATED",
           "guest_count": guest_count, "seated_time": NOW(), "completed_time": None}
    STATE["next_res"] += 1
    STATE["reservations"].insert(0, res)
    order = {"id": STATE["next_order"],
             "order_no": "ORD%s%04d" % (datetime.now().strftime("%Y%m%d"), STATE["next_order"]),
             "table_id": table_id, "status": "in_progress", "meals": [],
             "walkin": False, "paid": False, "res_id": res["id"]}
    STATE["next_order"] += 1
    STATE["orders"].append(order)
    return res, order


def add_rows(order, meals):
    for meal_id, name, price in meals:
        order["meals"].append({
            "id": STATE["next_row"], "order_id": order["id"], "meal_id": meal_id,
            "meal_name": name, "quantity": 1, "price": "%.2f" % price,
            "subtotal": "%.2f" % price, "status": "PREPARING", "first": 0,
            "remarks": "", "createtime": NOW(), "updatetime": NOW(),
            "tablet_id": None, "image_path": "", "category_id": 0, "category_name": "",
        })
        STATE["next_row"] += 1


def open_order_for_table(table_id):
    for o in STATE["orders"]:
        if not o["walkin"] and o["table_id"] == table_id and o["status"] == "in_progress":
            return o
    return None


def order_payload(o):
    total = sum(float(m["subtotal"]) for m in o["meals"])
    table = next((t for t in STATE["tables"] if t["id"] == o["table_id"]), None)
    return {"order": {
        "id": o["id"], "order_no": o["order_no"], "table_id": o["table_id"],
        "status": o["status"], "total_price": "%.2f" % total,
        "payment_method": None, "invoice_no": None, "paidtime": None,
        "createtime": NOW(), "updatetime": NOW(),
        "table_name": table["name"] if table else None,
    }, "order_meals": o["meals"]}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/ctl/state":
            return self._send(STATE)
        self._send({"code": "S00002", "msg": "Error:method_not_allowed"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n).decode() or "{}")
        except Exception:
            body = {}
        p = self.path.rstrip("/")
        STATE["log"].append([p, body])

        if p == "/kds/tables/search":
            data = []
            for t in STATE["tables"]:
                rs = [r for r in STATE["reservations"] if r["table_id"] == t["id"]]
                data.append({"id": t["id"], "name": t["name"], "status": "IDLE",
                             "sort": t["id"], "seats": t["seats"],
                             "reservations": [{
                                 "id": r["id"], "date": r["seated_time"][:10],
                                 "time": r["seated_time"][11:], "name": "直接來店",
                                 "phone": "0000000000", "status": r["status"],
                                 "guest_count": r["guest_count"], "dining_duration": 60,
                                 "seated_time": r["seated_time"],
                                 "completed_time": r["completed_time"], "note": "直接入座",
                             } for r in rs]})
            return self._send({"status": True, "msg": "success", "data": data})

        if p == "/kds/orders/details":
            if body.get("order_id") is not None:
                o = next((x for x in STATE["orders"]
                          if x["order_no"] == str(body["order_id"]) and x["status"] == "in_progress"), None)
            elif body.get("table_id") is not None:
                o = open_order_for_table(int(body["table_id"]))
            else:
                return self._send({"code": "S00051", "msg": "Error:missing_order_id"})
            if not o:
                return self._send({"code": "S00052", "msg": "Error:order_not_found"})
            return self._send({"status": True, "msg": "success", "data": order_payload(o)})

        if p == "/kds/walkIns/get":
            nos = [o["order_no"] for o in STATE["orders"] if o["walkin"] and not o["paid"]]
            return self._send({"status": True, "msg": "success", "data": {"order_nos": nos}})

        if p == "/kds/reservations/update":
            r = next((x for x in STATE["reservations"] if x["id"] == int(body.get("id") or 0)), None)
            if not r:
                return self._send({"code": "S00001", "msg": "Error:not_found"})
            r["status"] = str(body.get("status") or "COMPLETED")
            r["completed_time"] = NOW()
            closed = None
            for o in STATE["orders"]:
                if o.get("res_id") == r["id"] and o["status"] == "in_progress":
                    o["status"] = "closed"   # verified: settle closes the order too
                    closed = o
            data = {"id": r["id"], "table_id": r["table_id"], "status": r["status"],
                    "completed_time": r["completed_time"],
                    "order_id": closed["id"] if closed else None,
                    "order_number": closed["order_no"] if closed else None}
            return self._send({"status": True, "msg": "success", "data": data})

        if p == "/kds/walkIns/update":
            o = next((x for x in STATE["orders"] if x["walkin"] and x["order_no"] == str(body.get("order_no"))), None)
            if not o:
                return self._send({"code": "S00001", "msg": "Error:not_found"})
            if str(body.get("status")) == "paid":
                o["paid"] = True
                o["status"] = "paid"
            return self._send({"status": True, "msg": "success", "data": ""})

        # ---- control plane (test driver only) ----
        if p == "/ctl/seat":
            res, order = seat(int(body["table_id"]), int(body.get("guest_count") or 2))
            return self._send({"res_id": res["id"], "order_no": order["order_no"]})
        if p == "/ctl/add-round":
            o = next((x for x in STATE["orders"] if x["order_no"] == body["order_no"]), None)
            if not o:
                return self._send({"error": "unknown order"}, 404)
            add_rows(o, body["meals"])
            return self._send({"rows": len(o["meals"])})
        if p == "/ctl/add-walkin":
            order = {"id": STATE["next_order"],
                     "order_no": "ORDW%s%03d" % (datetime.now().strftime("%Y%m%d"), STATE["next_walkin"]),
                     "table_id": None, "status": "in_progress", "meals": [],
                     "walkin": True, "paid": False}
            STATE["next_order"] += 1
            STATE["next_walkin"] += 1
            add_rows(order, body["meals"])
            STATE["orders"].append(order)
            return self._send({"order_no": order["order_no"]})

        self._send({"code": "S00002", "msg": "Error:method_not_allowed"})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5500
    print("KDS stub on http://127.0.0.1:%d/kds" % port)
    HTTPServer(("127.0.0.1", port), H).serve_forever()
