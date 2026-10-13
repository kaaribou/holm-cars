"""Base de données HOLM Cars : véhicules, opérations (entretien, carburant, frais…), rappels."""
from __future__ import annotations

import calendar
import logging
import os
import time
import uuid
from datetime import date, datetime, timedelta

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store

from .const import COST_TYPES, DEFAULT_SETTINGS, ENERGIES, RECORD_TYPES, SIGNAL_UPDATED, SIGNAL_VEHICLES, STORAGE_KEY, STORAGE_VERSION

_LOGGER = logging.getLogger(__name__)


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def today() -> date:
    return datetime.now().date()


def parse_date(v) -> date | None:
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except (TypeError, ValueError):
        return None


def add_months(d: date, months: int) -> date:
    m = d.month - 1 + months
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def _num(v, cast=float):
    if v in (None, ""):
        return None
    try:
        return cast(v)
    except (TypeError, ValueError):
        try:
            return cast(float(str(v).replace(",", ".").replace(" ", "")))
        except (TypeError, ValueError):
            return None


class CarsStore:
    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.data: dict = {"vehicles": {}, "records": {}, "reminders": {}, "settings": dict(DEFAULT_SETTINGS)}
        self.files_dir = hass.config.path("holm_cars")
        self.live_odometer: dict[str, float] = {}   # relevé en direct (entité) par véhicule

    # ---------------------------------------------------------------- stockage
    async def async_load(self) -> None:
        d = await self._store.async_load()
        if isinstance(d, dict):
            for k in ("vehicles", "records", "reminders"):
                if isinstance(d.get(k), dict):
                    self.data[k] = d[k]
            self.data["settings"] = {**DEFAULT_SETTINGS, **(d.get("settings") or {})}
        await self.hass.async_add_executor_job(lambda: os.makedirs(self.files_dir, exist_ok=True))

    @callback
    def changed(self, vehicles: bool = False) -> None:
        self._store.async_delay_save(lambda: self.data, 1.0)
        async_dispatcher_send(self.hass, SIGNAL_UPDATED)
        if vehicles:
            async_dispatcher_send(self.hass, SIGNAL_VEHICLES)

    # ---------------------------------------------------------------- calculs
    def records_of(self, vid: str, types=None) -> list[dict]:
        out = [r for r in self.data["records"].values() if r["vehicle_id"] == vid and (types is None or r["type"] in types)]
        return sorted(out, key=lambda r: (r.get("date") or "", r.get("odometer") or 0))

    def odometer(self, vid: str) -> float | None:
        """Kilométrage actuel : le plus grand relevé connu (opérations, relevés, entité)."""
        v = self.data["vehicles"].get(vid) or {}
        vals = [r["odometer"] for r in self.data["records"].values() if r["vehicle_id"] == vid and isinstance(r.get("odometer"), (int, float))]
        if isinstance(v.get("initial_odometer"), (int, float)):
            vals.append(v["initial_odometer"])
        if vid in self.live_odometer:
            vals.append(self.live_odometer[vid])
        return max(vals) if vals else None

    def daily_km(self, vid: str) -> float | None:
        """Moyenne de km par jour sur les 12 derniers mois (sert à estimer la date d'un rappel en km)."""
        pts = [(parse_date(r["date"]), r["odometer"]) for r in self.data["records"].values()
               if r["vehicle_id"] == vid and isinstance(r.get("odometer"), (int, float)) and parse_date(r.get("date"))]
        if len(pts) < 2:
            return None
        pts.sort()
        end = pts[-1]
        start_limit = end[0] - timedelta(days=365)
        first = next((p for p in pts if p[0] >= start_limit), pts[0])
        if first[0] == end[0]:
            first = pts[0]
        days = (end[0] - first[0]).days
        if days < 20 or end[1] <= first[1]:
            return None
        return (end[1] - first[1]) / days

    def reminder_status(self, rem: dict) -> dict:
        s = self.data["settings"]
        vid = rem["vehicle_id"]
        odo = self.odometer(vid)
        due_date = parse_date(rem.get("due_date"))
        due_km = _num(rem.get("due_km"))
        days_left = (due_date - today()).days if due_date else None
        km_left = (due_km - odo) if (due_km is not None and odo is not None) else None
        lead_days = int(rem.get("notify_days") if rem.get("notify_days") not in (None, "") else s["notify_days"])
        lead_km = float(rem.get("notify_km") if rem.get("notify_km") not in (None, "") else s["notify_km"])
        overdue = (days_left is not None and days_left < 0) or (km_left is not None and km_left <= 0)
        soon = (days_left is not None and days_left <= lead_days) or (km_left is not None and km_left <= lead_km)
        est = None
        rate = self.daily_km(vid)
        if km_left is not None and rate:
            est = (today() + timedelta(days=max(0, round(km_left / rate)))).isoformat()
        return {"days_left": days_left, "km_left": km_left, "state": "overdue" if overdue else "soon" if soon else "ok",
                "estimated_date": est}

    def vehicle_summary(self, vid: str) -> dict:
        y = str(today().year)
        recs = self.records_of(vid)
        cost_year = sum(r.get("cost") or 0 for r in recs if r["type"] in COST_TYPES and (r.get("date") or "").startswith(y))
        cost_total = sum(r.get("cost") or 0 for r in recs if r["type"] in COST_TYPES)
        rems = [dict(r, **self.reminder_status(r)) for r in self.data["reminders"].values() if r["vehicle_id"] == vid]
        rank = {"overdue": 0, "soon": 1, "ok": 2}
        rems.sort(key=lambda r: (rank[r["state"]], r["days_left"] if r["days_left"] is not None else 99999,
                                 r["km_left"] if r["km_left"] is not None else 9e9))
        odo = self.odometer(vid)
        v = self.data["vehicles"][vid]
        first_odo = min([r["odometer"] for r in recs if isinstance(r.get("odometer"), (int, float))] + ([v["initial_odometer"]] if isinstance(v.get("initial_odometer"), (int, float)) else []), default=None)
        dist = (odo - first_odo) if (odo is not None and first_odo is not None) else None
        return {"odometer": odo, "cost_year": round(cost_year, 2), "cost_total": round(cost_total, 2),
                "cost_per_km": round(cost_total / dist, 3) if dist and dist > 100 else None,
                "next": rems[0] if rems else None, "alerts": sum(1 for r in rems if r["state"] != "ok"),
                "consumption": self.last_consumption(vid)}

    def consumption_series(self, vid: str, kind: str) -> list[dict]:
        """Consommation entre deux pleins complets (L/100 km ou kWh/100 km)."""
        recs = [r for r in self.records_of(vid, (kind,)) if isinstance(r.get("odometer"), (int, float)) and (r.get("fuel") or {}).get("qty")]
        out, acc, last_full = [], 0.0, None
        for r in recs:
            f = r["fuel"]
            if f.get("missed"):
                acc, last_full = 0.0, None
            acc += float(f["qty"])
            if f.get("full", True):
                if last_full is not None and r["odometer"] > last_full["odometer"]:
                    out.append({"date": r["date"], "value": round(acc / (r["odometer"] - last_full["odometer"]) * 100, 2)})
                last_full, acc = r, 0.0
        return out

    def last_consumption(self, vid: str) -> dict | None:
        v = self.data["vehicles"][vid]
        kind = "recharge" if v.get("energy") == "electrique" else "carburant"
        s = self.consumption_series(vid, kind)
        if not s:
            return None
        avg = sum(x["value"] for x in s[-10:]) / len(s[-10:])
        return {"last": s[-1]["value"], "avg": round(avg, 2), "unit": "kWh/100 km" if kind == "recharge" else "L/100 km"}

    def snapshot(self) -> dict:
        return {
            "vehicles": {k: {**v, "summary": self.vehicle_summary(k)} for k, v in self.data["vehicles"].items()},
            "records": self.data["records"],
            "reminders": {k: {**r, **self.reminder_status(r)} for k, r in self.data["reminders"].items()},
            "settings": self.data["settings"],
            "today": today().isoformat(),
        }

    # ---------------------------------------------------------------- véhicules
    def save_vehicle(self, d: dict) -> dict:
        vid = d.get("id") or new_id()
        old = self.data["vehicles"].get(vid, {"created": time.time()})
        v = {**old, **{k: d[k] for k in d if k != "summary"}, "id": vid}
        if v.get("energy") not in ENERGIES:
            v["energy"] = "essence"
        for k in ("year", "initial_odometer"):
            v[k] = _num(v.get(k), int) if k == "year" else _num(v.get(k))
        for k in ("purchase_price", "sold_price"):
            v[k] = _num(v.get(k))
        v.setdefault("name", " ".join(x for x in (v.get("make"), v.get("model")) if x) or "Ma voiture")
        self.data["vehicles"][vid] = v
        self.changed(vehicles=True)
        return v

    def delete_vehicle(self, vid: str) -> list[str]:
        files = []
        self.data["vehicles"].pop(vid, None)
        for k in [k for k, r in self.data["records"].items() if r["vehicle_id"] == vid]:
            files += [f["name"] for f in self.data["records"].pop(k).get("files") or []]
        for k in [k for k, r in self.data["reminders"].items() if r["vehicle_id"] == vid]:
            self.data["reminders"].pop(k)
        self.live_odometer.pop(vid, None)
        self.changed(vehicles=True)
        return files

    # ---------------------------------------------------------------- opérations
    def save_record(self, d: dict, notify: bool = True) -> dict:
        if d.get("vehicle_id") not in self.data["vehicles"]:
            raise ValueError("Véhicule inconnu")
        if d.get("type") not in RECORD_TYPES:
            raise ValueError("Type d'opération inconnu")
        rid = d.get("id") or new_id()
        old = self.data["records"].get(rid, {"created": time.time(), "source": "manual"})
        r = {**old, **d, "id": rid}
        r["date"] = (parse_date(r.get("date")) or today()).isoformat()
        r["odometer"] = _num(r.get("odometer"))
        r["cost"] = _num(r.get("cost")) or 0.0
        r["tags"] = [t for t in (r.get("tags") or []) if t]
        r["files"] = r.get("files") or []
        if r["type"] in ("carburant", "recharge"):
            f = dict(r.get("fuel") or {})
            f["qty"] = _num(f.get("qty"))
            f["unit"] = "kWh" if r["type"] == "recharge" else "L"
            f.setdefault("full", True)
            r["fuel"] = f
        else:
            r.pop("fuel", None)
        self.data["records"][rid] = r
        if notify:
            self.changed()
        return r

    def delete_record(self, rid: str) -> list[str]:
        r = self.data["records"].pop(rid, None)
        self.changed()
        return [f["name"] for f in (r or {}).get("files") or []]

    def set_reading(self, vid: str, km: float, when: date | None = None, source: str = "auto") -> None:
        """Relevé kilométrique : un seul relevé automatique par jour (mis à jour)."""
        when = when or today()
        day = when.isoformat()
        cur = next((r for r in self.data["records"].values() if r["vehicle_id"] == vid and r["type"] == "km"
                    and r.get("source") == source and r["date"] == day), None)
        if cur:
            if cur["odometer"] != km:
                cur["odometer"] = km
                self.changed()
            return
        self.save_record({"vehicle_id": vid, "type": "km", "date": day, "odometer": km, "title": "Relevé automatique" if source == "auto" else "Relevé", "source": source})

    # ---------------------------------------------------------------- rappels
    def save_reminder(self, d: dict) -> dict:
        if d.get("vehicle_id") not in self.data["vehicles"]:
            raise ValueError("Véhicule inconnu")
        rid = d.get("id") or new_id()
        old = self.data["reminders"].get(rid, {"created": time.time(), "notified": {}})
        r = {**old, **{k: v for k, v in d.items() if k not in ("days_left", "km_left", "state", "estimated_date")}, "id": rid}
        r["due_date"] = parse_date(r.get("due_date")).isoformat() if parse_date(r.get("due_date")) else None
        for k in ("due_km", "every_km", "notify_km"):
            r[k] = _num(r.get(k))
        for k in ("every_months", "notify_days"):
            r[k] = _num(r.get(k), int)
        if not r["due_date"] and r["due_km"] is None:
            raise ValueError("Indiquez une date ou un kilométrage")
        if (old.get("due_date"), old.get("due_km")) != (r["due_date"], r["due_km"]):
            r["notified"] = {}
        self.data["reminders"][rid] = r
        self.changed()
        return r

    def delete_reminder(self, rid: str) -> None:
        self.data["reminders"].pop(rid, None)
        self.changed()

    def complete_reminder(self, rid: str, when: str | None, odometer, cost, record_type: str | None, notes: str = "") -> dict | None:
        """Marque un rappel comme fait : crée l'opération et reprogramme le rappel s'il est périodique."""
        rem = self.data["reminders"].get(rid)
        if not rem:
            raise ValueError("Rappel introuvable")
        d = parse_date(when) or today()
        km = _num(odometer)
        if km is None:
            km = self.odometer(rem["vehicle_id"])
        rec = None
        if record_type:
            rec = self.save_record({"vehicle_id": rem["vehicle_id"], "type": record_type, "date": d.isoformat(), "odometer": km,
                                    "title": rem["title"], "category": rem.get("category") or "", "cost": cost, "notes": notes,
                                    "reminder_id": rid}, notify=False)
        rem.setdefault("history", []).append({"date": d.isoformat(), "odometer": km, "record_id": rec["id"] if rec else None})
        if rem.get("every_months") or rem.get("every_km"):
            rem["due_date"] = add_months(d, int(rem["every_months"])).isoformat() if rem.get("every_months") else None
            rem["due_km"] = (km + rem["every_km"]) if (rem.get("every_km") and km is not None) else None
            if not rem["due_date"] and rem["due_km"] is None:
                rem["due_date"] = add_months(d, 12).isoformat()
            rem["notified"] = {}
        else:
            self.data["reminders"].pop(rid)
        self.changed()
        return rec
