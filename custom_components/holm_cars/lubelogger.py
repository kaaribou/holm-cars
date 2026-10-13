"""Import des données LubeLogger : par son API, ou par ses fichiers CSV exportés."""
from __future__ import annotations

import csv
import io
import logging
import mimetypes
import os
import re
from datetime import date, datetime

import aiohttp

from .store import CarsStore, new_id

_LOGGER = logging.getLogger(__name__)
TIMEOUT = aiohttp.ClientTimeout(total=60)

# type LubeLogger → type HOLM Cars
API_KINDS = {
    "servicerecords": "entretien",
    "repairrecords": "reparation",
    "upgraderecords": "amelioration",
    "taxrecords": "frais",
    "gasrecords": "carburant",
    "odometerrecords": "km",
}


class LubeError(Exception):
    pass


# ------------------------------------------------------------------ outils
def parse_number(v) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = re.sub(r"[^\d,.\-]", "", str(v))
    if not s or s in ("-", ".", ","):
        return None
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".") if s.count(",") == 1 else s.replace(",", "")  # virgule décimale (format français)
    elif s.count(".") > 1:
        s = s.replace(".", "")
    try:
        return float(s)
    except ValueError:
        return None


def parse_bool(v) -> bool:
    return str(v).strip().lower() in ("true", "1", "yes", "oui", "vrai")


def detect_day_first(values: list[str], default: bool = True) -> bool:
    """Ordre jour/mois d'une colonne de dates « 12/03/2024 » : jour en premier si une valeur le prouve."""
    for v in values:
        m = re.match(r"\s*(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})", v or "")
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if a > 12:
                return True
            if b > 12:
                return False
    return default  # indécidable : format par défaut


def parse_date(v, day_first: bool = True) -> str | None:
    if not v:
        return None
    s = str(v).strip()
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.match(r"(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})", s)
    if m:
        a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100:
            y += 2000
        d, mo = (a, b) if day_first else (b, a)
        try:
            return date(y, mo, d).isoformat()
        except ValueError:
            try:
                return date(y, d, mo).isoformat()
            except ValueError:
                return None
    return None


def _g(row: dict, *keys):
    """Valeur d'un champ, quelle que soit la casse (camelCase de l'API, en-têtes CSV…)."""
    low = {str(k).lower().replace(" ", "").replace("_", ""): v for k, v in row.items()}
    for k in keys:
        v = low.get(k.lower())
        if v not in (None, ""):
            return v
    return None


def _tags(v) -> list[str]:
    if isinstance(v, list):
        return [str(t) for t in v if t]
    return [t for t in str(v or "").split() if t]


# ------------------------------------------------------------------ API
class LubeClient:
    def __init__(self, session: aiohttp.ClientSession, url: str, username: str = "", password: str = "", api_key: str = "") -> None:
        url = (url or "").strip().rstrip("/")
        if not re.match(r"https?://", url):
            url = "http://" + url
        self.url = url
        self.session = session
        self.headers = {"culture-invariant": "1", "Accept": "application/json"}
        if api_key:
            self.headers["x-api-key"] = api_key
        self.auth = aiohttp.BasicAuth(username, password) if username else None

    async def get(self, path: str, **params):
        try:
            async with self.session.get(self.url + path, params=params or None, headers=self.headers, auth=self.auth, timeout=TIMEOUT) as r:
                if r.status in (401, 403):
                    raise LubeError("Identifiants refusés par LubeLogger")
                if r.status == 404:
                    raise LubeError(f"Adresse introuvable : {path}")
                if r.status >= 400:
                    raise LubeError(f"LubeLogger a répondu {r.status}")
                ctype = r.headers.get("Content-Type", "")
                if "json" not in ctype:
                    raise LubeError("Réponse inattendue (page de connexion ?) : vérifiez l'adresse et les identifiants")
                return await r.json(content_type=None)
        except aiohttp.ClientError as e:
            raise LubeError(f"Connexion impossible : {e}") from e
        except TimeoutError as e:
            raise LubeError("LubeLogger ne répond pas") from e

    async def download(self, path: str) -> tuple[bytes, str] | None:
        if not path or path.startswith("/defaults/"):
            return None
        try:
            async with self.session.get(self.url + (path if path.startswith("/") else "/" + path), headers=self.headers,
                                        auth=self.auth, timeout=TIMEOUT) as r:
                if r.status != 200:
                    return None
                return await r.read(), r.headers.get("Content-Type", "")
        except (aiohttp.ClientError, TimeoutError):
            return None


async def preview(client: LubeClient) -> list[dict]:
    vehicles = await client.get("/api/vehicles")
    if not isinstance(vehicles, list):
        raise LubeError("Liste des véhicules illisible")
    out = []
    for v in vehicles:
        vid = _g(v, "id")
        counts = {}
        for kind in API_KINDS:
            try:
                rows = await client.get(f"/api/vehicle/{kind}", vehicleId=vid)
                counts[kind] = len(rows) if isinstance(rows, list) else 0
            except LubeError:
                counts[kind] = 0
        try:
            rem = await client.get("/api/vehicle/reminders", vehicleId=vid)
            counts["reminders"] = len(rem) if isinstance(rem, list) else 0
        except LubeError:
            counts["reminders"] = 0
        out.append({"id": vid, "name": " ".join(str(x) for x in (_g(v, "year"), _g(v, "make"), _g(v, "model")) if x),
                    "plate": _g(v, "licenseplate") or "", "electric": parse_bool(_g(v, "iselectric")), "counts": counts})
    return out


def _save_blob(store: CarsStore, data: bytes, ctype: str, name_hint: str) -> dict:
    ext = os.path.splitext(name_hint)[1].lower() or mimetypes.guess_extension((ctype or "").split(";")[0]) or ".bin"
    fid = new_id() + ext
    with open(os.path.join(store.files_dir, fid), "wb") as f:
        f.write(data)
    return {"name": fid, "label": os.path.basename(name_hint) or fid, "size": len(data), "mime": (ctype or "").split(";")[0]}


async def run_import(hass, store: CarsStore, client: LubeClient, vehicle_ids: list | None, include_files: bool, progress=None) -> dict:
    vehicles = await client.get("/api/vehicles")
    stats = {"vehicles": 0, "records": 0, "reminders": 0, "files": 0, "updated": 0}
    by_ext = {r.get("ext_id"): r for r in store.data["records"].values() if r.get("ext_id")}
    rem_ext = {r.get("ext_id"): r for r in store.data["reminders"].values() if r.get("ext_id")}
    veh_ext = {v.get("ext_id"): v for v in store.data["vehicles"].values() if v.get("ext_id")}

    async def files_of(row) -> list[dict]:
        out = []
        if not include_files:
            return out
        for f in _g(row, "files") or []:
            loc = _g(f, "location")
            got = await client.download(loc) if loc else None
            if got:
                out.append(await hass.async_add_executor_job(_save_blob, store, got[0], got[1], _g(f, "name") or loc))
                stats["files"] += 1
        return out

    for v in vehicles:
        lid = str(_g(v, "id"))
        if vehicle_ids and lid not in [str(x) for x in vehicle_ids]:
            continue
        electric = parse_bool(_g(v, "iselectric"))
        ext = f"lube:vehicle:{lid}"
        cur = veh_ext.get(ext)
        data = {
            "id": cur["id"] if cur else None, "ext_id": ext, "make": _g(v, "make") or "", "model": _g(v, "model") or "",
            "year": _g(v, "year"), "plate": _g(v, "licenseplate") or "",
            "energy": "electrique" if electric else "diesel" if parse_bool(_g(v, "isdiesel")) else (cur or {}).get("energy", "essence"),
            "purchase_date": parse_date(_g(v, "purchasedate"), False), "purchase_price": parse_number(_g(v, "purchaseprice")) or None,
            "sold_date": parse_date(_g(v, "solddate"), False), "sold_price": parse_number(_g(v, "soldprice")) or None,
            "archived": bool(_g(v, "solddate")),
        }
        data["name"] = (cur or {}).get("name") or " ".join(x for x in (data["make"], data["model"]) if x)
        if progress:
            progress(f"{data['name']}…")
        if not cur or not cur.get("image"):
            got = await client.download(_g(v, "imagelocation") or "")
            if got:
                data["image"] = (await hass.async_add_executor_job(_save_blob, store, got[0], got[1], _g(v, "imagelocation")))["name"]
        veh = store.save_vehicle({k: x for k, x in data.items() if x is not None or k == "id"} if cur else data)
        stats["vehicles"] += 1
        vid = veh["id"]

        for kind, rtype in API_KINDS.items():
            try:
                rows = await client.get(f"/api/vehicle/{kind}", vehicleId=lid)
            except LubeError as e:
                _LOGGER.debug("%s : %s", kind, e)
                continue
            day_first = detect_day_first([str(_g(r, "date") or "") for r in rows or []], False)
            for row in rows or []:
                ext = f"lube:{kind}:{_g(row, 'id')}"
                t = "recharge" if (rtype == "carburant" and electric) else rtype
                rec = {"vehicle_id": vid, "type": t, "ext_id": ext, "source": "lubelogger",
                       "date": parse_date(_g(row, "date"), day_first), "odometer": parse_number(_g(row, "odometer")),
                       "title": _g(row, "description") or {"carburant": "Plein", "recharge": "Recharge", "km": "Relevé"}.get(t, "Opération"),
                       "cost": parse_number(_g(row, "cost")) or 0.0, "notes": _g(row, "notes") or "", "tags": _tags(_g(row, "tags"))}
                if t in ("carburant", "recharge"):
                    rec["fuel"] = {"qty": parse_number(_g(row, "fuelconsumed")), "full": parse_bool(_g(row, "isfilltofull") if _g(row, "isfilltofull") is not None else True),
                                   "missed": parse_bool(_g(row, "missedfuelup")),
                                   "soc_start": parse_number(_g(row, "startingsoc")) if electric else None,
                                   "soc_end": parse_number(_g(row, "endingsoc")) if electric else None}
                if t == "km" and rec["odometer"] is None:
                    continue
                old = by_ext.get(ext)
                if old:
                    rec["id"] = old["id"]
                    rec["files"] = old.get("files") or []
                    stats["updated"] += 1
                else:
                    rec["files"] = await files_of(row)
                    stats["records"] += 1
                store.save_record(rec, notify=False)

        try:
            rems = await client.get("/api/vehicle/reminders", vehicleId=lid)
        except LubeError:
            rems = []
        rem_df = detect_day_first([str(_g(r, "duedate") or "") for r in rems or []], False)
        for row in rems or []:
            ext = f"lube:reminder:{_g(row, 'id')}"
            metric = str(_g(row, "metric") or "").lower()
            due_date = parse_date(_g(row, "duedate"), rem_df) if metric in ("date", "both", "") else None
            due_km = parse_number(_g(row, "dueodometer")) if metric in ("odometer", "both") else None
            if not due_date and not due_km:
                continue
            cur_rem = rem_ext.get(ext)
            store.save_reminder({"id": cur_rem["id"] if cur_rem else None, "ext_id": ext, "vehicle_id": vid,
                                 "title": _g(row, "description") or "Rappel", "notes": _g(row, "notes") or "",
                                 "due_date": due_date, "due_km": due_km, "category": "",
                                 **({k: cur_rem.get(k) for k in ("every_months", "every_km", "notify_days", "notify_km")} if cur_rem else {})})
            stats["reminders"] += 1
    store.changed(vehicles=True)
    return stats


# ------------------------------------------------------------------ CSV
CSV_KINDS = {
    "carburant": {"fuelconsumed", "fuelconsumption", "gallons", "liters", "litres"},
    "km": {"initialodometer"},
}


def csv_kind(headers: list[str]) -> str:
    hs = {h.lower().replace(" ", "").replace("_", "") for h in headers}
    for kind, keys in CSV_KINDS.items():
        if hs & keys:
            return kind
    if "odometer" in hs or "mileage" in hs:
        return "entretien" if "description" in hs else "km"
    return "frais"


def import_csv(store: CarsStore, vid: str, text: str, kind: str | None = None) -> dict:
    if vid not in store.data["vehicles"]:
        raise LubeError("Véhicule inconnu")
    text = text.lstrip("﻿")
    sample = text[:2000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.DictReader(io.StringIO(text), dialect=dialect))
    if not rows:
        raise LubeError("Fichier vide ou illisible")
    detected = csv_kind(list(rows[0].keys()))
    kind = kind or detected
    if kind == "carburant" and (store.data["vehicles"][vid].get("energy") == "electrique"):
        kind = "recharge"
    day_first = detect_day_first([_g(r, "date") or "" for r in rows])
    seen = {(r["type"], r["date"], r.get("odometer"), round(r.get("cost") or 0, 2)) for r in store.data["records"].values() if r["vehicle_id"] == vid}
    added = skipped = 0
    for row in rows:
        d = parse_date(_g(row, "date"), day_first)
        if not d:
            skipped += 1
            continue
        rec = {"vehicle_id": vid, "type": kind, "date": d, "source": "csv",
               "odometer": parse_number(_g(row, "odometer", "mileage")),
               "title": _g(row, "description") or {"carburant": "Plein", "recharge": "Recharge", "km": "Relevé"}.get(kind, "Opération"),
               "cost": parse_number(_g(row, "cost", "price", "prix")) or 0.0,
               "notes": _g(row, "notes") or "", "tags": _tags(_g(row, "tags"))}
        if kind in ("carburant", "recharge"):
            full = _g(row, "isfilltofull", "filltofull")
            rec["fuel"] = {"qty": parse_number(_g(row, "fuelconsumed", "fuelconsumption", "gallons", "liters", "litres")),
                           "full": parse_bool(full) if full is not None else True, "missed": parse_bool(_g(row, "missedfuelup") or "")}
        if kind == "km" and rec["odometer"] is None:
            skipped += 1
            continue
        key = (kind, d, rec["odometer"], round(rec["cost"], 2))
        if key in seen:
            skipped += 1
            continue
        seen.add(key)
        store.save_record(rec, notify=False)
        added += 1
    store.changed()
    return {"kind": kind, "detected": detected, "added": added, "skipped": skipped, "day_first": day_first}
