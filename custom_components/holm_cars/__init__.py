"""HOLM Cars — entretien, dépenses, carburant et recharges de vos voitures."""
from __future__ import annotations

import hashlib
import logging
import os
import time

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import CARD_URL, DOMAIN, STATIC_PATH, VERSION
from .http import FileView, UploadView
from .monitor import Monitor
from .store import CarsStore
from .websocket import async_register

_LOGGER = logging.getLogger(__name__)
PLATFORMS = [Platform.SENSOR, Platform.BINARY_SENSOR]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    store = CarsStore(hass)
    await store.async_load()
    first = "registered" not in hass.data.get(f"{DOMAIN}_global", {})
    monitor = Monitor(hass, store)
    hass.data[DOMAIN] = {"store": store, "monitor": monitor}
    if first:
        hass.data[f"{DOMAIN}_global"] = {"registered": True}
        async_register(hass)
        hass.http.register_view(FileView())
        hass.http.register_view(UploadView())
        await hass.http.async_register_static_paths([
            StaticPathConfig(STATIC_PATH, os.path.join(os.path.dirname(__file__), "www"), False),
        ])
        card = os.path.join(os.path.dirname(__file__), "www", "holm-cars-card.js")
        digest = await hass.async_add_executor_job(_file_hash, card)
        url = f"{CARD_URL}?v={VERSION}-{digest}"
        if not await _register_resource(hass, url):
            add_extra_js_url(hass, url)
    await hass.async_add_executor_job(_cleanup_orphans, store)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    await monitor.async_start()
    monitor.check_reminders()
    return True


def _cleanup_orphans(store: CarsStore) -> None:
    """Fichiers envoyés mais jamais rattachés (fenêtre annulée) : supprimés après 24 h."""
    used = {v.get("image") for v in store.data["vehicles"].values()}
    for r in store.data["records"].values():
        used.update(f["name"] for f in r.get("files") or [])
    try:
        for name in os.listdir(store.files_dir):
            p = os.path.join(store.files_dir, name)
            if name not in used and os.path.isfile(p) and time.time() - os.path.getmtime(p) > 86400:
                os.remove(p)
    except OSError as err:
        _LOGGER.debug("Nettoyage des fichiers : %s", err)


async def _register_resource(hass: HomeAssistant, url: str) -> bool:
    """Déclare la carte comme ressource Lovelace (mode stockage) ; met à jour la version si besoin."""
    try:
        data = hass.data.get("lovelace")
        resources = getattr(data, "resources", None) or (data.get("resources") if isinstance(data, dict) else None)
        if resources is None or not hasattr(resources, "async_create_item"):
            return False
        if not getattr(resources, "loaded", True):
            await resources.async_load()
            resources.loaded = True
        mine = [r for r in resources.async_items() if str(r.get("url", "")).split("?")[0] == CARD_URL]
        if not mine:
            await resources.async_create_item({"res_type": "module", "url": url})
        else:
            if mine[0].get("url") != url:
                await resources.async_update_item(mine[0]["id"], {"res_type": "module", "url": url})
            for extra in mine[1:]:
                await resources.async_delete_item(extra["id"])
        return True
    except Exception as err:  # noqa: BLE001 — repli sur add_extra_js_url
        _LOGGER.debug("Ressource Lovelace non enregistrée (%s), chargement par extra_js_url", err)
        return False


def _file_hash(path: str) -> str:
    try:
        with open(path, "rb") as f:
            return hashlib.sha1(f.read()).hexdigest()[:8]
    except OSError:
        return "0"


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    data = hass.data.get(DOMAIN) or {}
    if data.get("monitor"):
        data["monitor"].stop()
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
