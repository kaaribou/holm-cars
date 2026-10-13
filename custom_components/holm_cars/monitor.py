"""Suivi automatique : kilométrage et recharges depuis des entités, notifications des rappels."""
from __future__ import annotations

import logging
from datetime import datetime

from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import async_track_state_change_event, async_track_time_change

from .const import DOMAIN, SIGNAL_VEHICLES
from .store import CarsStore, today

_LOGGER = logging.getLogger(__name__)
CHARGING_ON = {"on", "charging", "en charge", "true", "charge", "in_progress", "connected_charging"}


def _float(state) -> float | None:
    if state is None or state.state in (STATE_UNAVAILABLE, STATE_UNKNOWN, ""):
        return None
    try:
        return float(state.state)
    except ValueError:
        return None


def _km(state) -> float | None:
    """Valeur d'un compteur kilométrique, convertie en km si l'entité est en miles."""
    v = _float(state)
    if v is None:
        return None
    unit = (state.attributes.get("unit_of_measurement") or "").lower()
    return round(v * 1.609344, 1) if unit in ("mi", "miles") else v


class Monitor:
    def __init__(self, hass: HomeAssistant, store: CarsStore) -> None:
        self.hass, self.store = hass, store
        self._unsubs: list = []
        self._sessions: dict[str, dict] = {}   # recharges en cours par véhicule
        self._stop = []

    async def async_start(self) -> None:
        self._stop.append(async_dispatcher_connect(self.hass, SIGNAL_VEHICLES, self._rebuild))
        self._stop.append(async_track_time_change(self.hass, self._daily, minute=0, second=30))
        self._rebuild()

    def stop(self) -> None:
        for u in self._unsubs + self._stop:
            u()
        self._unsubs, self._stop = [], []

    # ------------------------------------------------------------ abonnements
    @callback
    def _rebuild(self) -> None:
        for u in self._unsubs:
            u()
        self._unsubs = []
        for vid, v in self.store.data["vehicles"].items():
            ent = v.get("odometer_entity")
            if ent:
                self._unsubs.append(async_track_state_change_event(self.hass, [ent], self._odo_cb(vid)))
                km = _km(self.hass.states.get(ent))
                if km is not None:
                    self._odometer(vid, km)
            ch = v.get("charge") or {}
            if ch.get("charging_entity") and ch.get("energy_entity"):
                self._unsubs.append(async_track_state_change_event(self.hass, [ch["charging_entity"]], self._charge_cb(vid)))
                st = self.hass.states.get(ch["charging_entity"])
                if st and str(st.state).lower() in CHARGING_ON and vid not in self._sessions:
                    self._start_session(vid)

    def _odo_cb(self, vid):
        @callback
        def cb(event: Event) -> None:
            km = _km(event.data.get("new_state"))
            if km is not None:
                self._odometer(vid, km)
        return cb

    @callback
    def _odometer(self, vid: str, km: float) -> None:
        prev = self.store.live_odometer.get(vid)
        if prev is not None and km < prev:
            return  # compteur qui recule : valeur douteuse
        self.store.live_odometer[vid] = km
        if prev is None or int(km) != int(prev):
            self.store.set_reading(vid, km)
            self.check_reminders()

    # ------------------------------------------------------------ recharges
    def _charge_cb(self, vid):
        @callback
        def cb(event: Event) -> None:
            old, new = event.data.get("old_state"), event.data.get("new_state")
            was = old is not None and str(old.state).lower() in CHARGING_ON
            now = new is not None and str(new.state).lower() in CHARGING_ON
            if now and not was:
                self._start_session(vid)
            elif was and not now and new is not None and new.state not in (STATE_UNAVAILABLE, STATE_UNKNOWN):
                self._end_session(vid)
        return cb

    def _charge_cfg(self, vid) -> dict:
        return (self.store.data["vehicles"].get(vid) or {}).get("charge") or {}

    @callback
    def _start_session(self, vid: str) -> None:
        ch = self._charge_cfg(vid)
        self._sessions[vid] = {
            "start": datetime.now().isoformat(timespec="minutes"),
            "energy": _float(self.hass.states.get(ch.get("energy_entity"))),
            "soc": _float(self.hass.states.get(ch["soc_entity"])) if ch.get("soc_entity") else None,
        }

    @callback
    def _end_session(self, vid: str) -> None:
        ch = self._charge_cfg(vid)
        sess = self._sessions.pop(vid, None)
        end = _float(self.hass.states.get(ch.get("energy_entity")))
        if end is None:
            return
        if ch.get("energy_mode", "total") == "session":
            kwh = end
        else:
            if not sess or sess.get("energy") is None:
                return
            kwh = end - sess["energy"]
        if kwh is None or kwh < float(ch.get("min_kwh") or 0.5):
            return
        price = None
        if ch.get("price_entity"):
            price = _float(self.hass.states.get(ch["price_entity"]))
        if price is None:
            try:
                price = float(ch.get("price") or 0)
            except (TypeError, ValueError):
                price = 0.0
        soc_end = _float(self.hass.states.get(ch["soc_entity"])) if ch.get("soc_entity") else None
        self.store.save_record({
            "vehicle_id": vid, "type": "recharge", "date": today().isoformat(), "odometer": self.store.odometer(vid),
            "title": ch.get("label") or "Recharge", "category": ch.get("place") or "Domicile", "cost": round(kwh * price, 2),
            "source": "auto", "notes": f"Recharge automatique · début {sess['start'][11:] if sess else '?'}",
            "fuel": {"qty": round(kwh, 2), "full": True, "price_unit": price,
                     "soc_start": sess.get("soc") if sess else None, "soc_end": soc_end},
        })

    # ------------------------------------------------------------ rappels
    @callback
    def _daily(self, now) -> None:
        if now.hour == int(self.store.data["settings"].get("notify_hour", 9)):
            self.check_reminders()

    @callback
    def check_reminders(self) -> None:
        s = self.store.data["settings"]
        for rem in list(self.store.data["reminders"].values()):
            st = self.store.reminder_status(rem)
            if st["state"] == "ok":
                continue
            stage = st["state"]
            notified = rem.setdefault("notified", {})
            if notified.get(stage):
                continue
            notified[stage] = today().isoformat()
            if stage == "overdue":
                notified["soon"] = notified.get("soon") or today().isoformat()
            self.store.changed()
            self.hass.async_create_task(self._send(rem, st, s))

    async def _send(self, rem: dict, st: dict, s: dict) -> None:
        v = self.store.data["vehicles"].get(rem["vehicle_id"]) or {}
        name = v.get("name") or "Voiture"
        parts = []
        if st["days_left"] is not None:
            d = st["days_left"]
            parts.append(f"dépassé de {-d} j" if d < 0 else "aujourd'hui" if d == 0 else f"dans {d} j")
        if st["km_left"] is not None:
            k = round(st["km_left"])
            parts.append(f"dépassé de {-k:,} km".replace(",", " ") if k <= 0 else f"dans {k:,} km".replace(",", " "))
        title = f"🚗 {name} : {rem['title']}"
        msg = (("En retard : " if st["state"] == "overdue" else "À prévoir : ") + " · ".join(parts)) if parts else rem["title"]
        self.hass.bus.async_fire(f"{DOMAIN}_reminder", {"vehicle_id": rem["vehicle_id"], "vehicle": name, "reminder_id": rem["id"],
                                                      "title": rem["title"], "state": st["state"], **st})
        if s.get("persistent", True):
            await self.hass.services.async_call("persistent_notification", "create",
                                                {"title": title, "message": msg, "notification_id": f"{DOMAIN}_{rem['id']}"})
        for target in s.get("notify_targets") or []:
            svc = target.split(".", 1)[-1]
            if not self.hass.services.has_service("notify", svc):
                continue
            try:
                await self.hass.services.async_call("notify", svc, {"title": title, "message": msg,
                                                                   "data": {"tag": f"{DOMAIN}_{rem['id']}", "ttl": 0, "priority": "high"}})
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("Notification %s impossible : %s", target, err)
