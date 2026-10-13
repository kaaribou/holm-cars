"""Capteurs par voiture : kilométrage, prochain entretien, dépenses, consommation."""
from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.const import UnitOfLength
from homeassistant.core import callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import async_track_time_change

from .const import DOMAIN, SIGNAL_UPDATED, SIGNAL_VEHICLES

KINDS = ("odometer", "next_reminder", "cost_year", "cost_per_km", "consumption")


def device_info(v: dict) -> DeviceInfo:
    return DeviceInfo(identifiers={(DOMAIN, v["id"])}, name=v.get("name") or "Voiture", manufacturer=v.get("make") or None,
                      model=" ".join(str(x) for x in (v.get("model"), v.get("year")) if x) or None, serial_number=v.get("plate") or None)


async def async_setup_entry(hass, entry, async_add_entities):
    store = hass.data[DOMAIN]["store"]
    known: set[str] = set()

    @callback
    def sync():
        new = []
        for vid in store.data["vehicles"]:
            if vid not in known:
                known.add(vid)
                new += [CarSensor(hass, entry, vid, k) for k in KINDS]
        if new:
            async_add_entities(new)
        gone = known - set(store.data["vehicles"])
        if gone:
            reg = er.async_get(hass)
            for vid in gone:
                known.discard(vid)
                for k in KINDS:
                    eid = reg.async_get_entity_id("sensor", DOMAIN, f"{vid}_{k}")
                    if eid:
                        reg.async_remove(eid)

    sync()
    entry.async_on_unload(async_dispatcher_connect(hass, SIGNAL_VEHICLES, sync))


NAMES = {"odometer": "Kilométrage", "next_reminder": "Prochain entretien", "cost_year": "Dépenses de l'année",
         "cost_per_km": "Coût au km", "consumption": "Consommation moyenne"}
ICONS = {"odometer": "mdi:counter", "next_reminder": "mdi:wrench-clock", "cost_year": "mdi:cash", "cost_per_km": "mdi:cash-marker",
         "consumption": "mdi:gas-station"}


class CarSensor(SensorEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, hass, entry, vid: str, kind: str) -> None:
        self.hass, self._vid, self._kind = hass, vid, kind
        self._attr_unique_id = f"{vid}_{kind}"
        self._attr_translation_key = None
        self._attr_name = NAMES[kind]
        self._attr_icon = ICONS[kind]
        store = hass.data[DOMAIN]["store"]
        v = store.data["vehicles"][vid]
        self._attr_device_info = device_info(v)
        cur = store.data["settings"].get("currency", "€")
        if kind == "odometer":
            self._attr_device_class = SensorDeviceClass.DISTANCE
            self._attr_native_unit_of_measurement = UnitOfLength.KILOMETERS
            self._attr_state_class = SensorStateClass.TOTAL_INCREASING
            self._attr_suggested_display_precision = 0
        elif kind == "cost_year":
            self._attr_device_class = SensorDeviceClass.MONETARY
            self._attr_native_unit_of_measurement = "EUR" if cur == "€" else cur
            self._attr_suggested_display_precision = 0
        elif kind == "cost_per_km":
            self._attr_native_unit_of_measurement = f"{cur}/km"
            self._attr_suggested_display_precision = 2
        elif kind == "next_reminder":
            self._attr_native_unit_of_measurement = "j"
        elif kind == "consumption":
            electric = v.get("energy") == "electrique"
            self._attr_native_unit_of_measurement = "kWh/100 km" if electric else "L/100 km"
            self._attr_icon = "mdi:ev-station" if electric else "mdi:gas-station"
            self._attr_suggested_display_precision = 1

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_dispatcher_connect(self.hass, SIGNAL_UPDATED, self._refresh))
        self.async_on_remove(async_track_time_change(self.hass, self._refresh, hour=0, minute=0, second=10))
        self._refresh()

    @callback
    def _refresh(self, *_) -> None:
        store = self.hass.data[DOMAIN]["store"]
        if self._vid not in store.data["vehicles"]:
            return
        s = store.vehicle_summary(self._vid)
        attrs = {}
        if self._kind == "odometer":
            val = s["odometer"]
        elif self._kind == "cost_year":
            val = s["cost_year"]
            attrs = {"total": s["cost_total"]}
        elif self._kind == "cost_per_km":
            val = s["cost_per_km"]
        elif self._kind == "consumption":
            c = s["consumption"] or {}
            val = c.get("avg")
            attrs = {"last": c.get("last")}
        else:
            n = s["next"]
            if n:
                val = n["days_left"] if n["days_left"] is not None else None
                attrs = {"title": n["title"], "due_date": n.get("due_date"), "due_km": n.get("due_km"), "km_left": n.get("km_left"),
                         "estimated_date": n.get("estimated_date"), "status": n["state"], "alerts": s["alerts"]}
            else:
                val, attrs = None, {"status": "none", "alerts": 0}
        self._attr_native_value = val
        self._attr_extra_state_attributes = attrs
        if self.entity_id:
            self.async_write_ha_state()
