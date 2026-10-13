"""« Entretien à prévoir » : allumé quand un rappel de la voiture approche ou est dépassé."""
from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.core import callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import async_track_time_change

from .const import DOMAIN, SIGNAL_UPDATED, SIGNAL_VEHICLES
from .sensor import device_info


async def async_setup_entry(hass, entry, async_add_entities):
    store = hass.data[DOMAIN]["store"]
    known: set[str] = set()

    @callback
    def sync():
        new = [DueSensor(hass, vid) for vid in store.data["vehicles"] if vid not in known]
        known.update(store.data["vehicles"])
        if new:
            async_add_entities(new)
        for vid in known - set(store.data["vehicles"]):
            known.discard(vid)
            reg = er.async_get(hass)
            eid = reg.async_get_entity_id("binary_sensor", DOMAIN, f"{vid}_due")
            if eid:
                reg.async_remove(eid)

    sync()
    entry.async_on_unload(async_dispatcher_connect(hass, SIGNAL_VEHICLES, sync))


class DueSensor(BinarySensorEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_name = "Entretien à prévoir"
    _attr_device_class = BinarySensorDeviceClass.PROBLEM
    _attr_icon = "mdi:car-wrench"

    def __init__(self, hass, vid: str) -> None:
        self.hass, self._vid = hass, vid
        self._attr_unique_id = f"{vid}_due"
        self._attr_device_info = device_info(hass.data[DOMAIN]["store"].data["vehicles"][vid])

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_dispatcher_connect(self.hass, SIGNAL_UPDATED, self._refresh))
        self.async_on_remove(async_track_time_change(self.hass, self._refresh, hour=0, minute=0, second=15))
        self._refresh()

    @callback
    def _refresh(self, *_) -> None:
        store = self.hass.data[DOMAIN]["store"]
        if self._vid not in store.data["vehicles"]:
            return
        rems = [dict(r, **store.reminder_status(r)) for r in store.data["reminders"].values() if r["vehicle_id"] == self._vid]
        due = [r for r in rems if r["state"] != "ok"]
        self._attr_is_on = bool(due)
        self._attr_extra_state_attributes = {"reminders": [{"title": r["title"], "status": r["state"], "days_left": r["days_left"],
                                                            "km_left": r["km_left"]} for r in due]}
        if self.entity_id:
            self.async_write_ha_state()
