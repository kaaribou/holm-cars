"""API WebSocket utilisée par la carte HOLM Cars."""
from __future__ import annotations

import logging
import os

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .const import DOMAIN, SIGNAL_UPDATED
from .lubelogger import LubeClient, LubeError, import_csv, preview, run_import
from .store import CarsStore

_LOGGER = logging.getLogger(__name__)


def _store(hass: HomeAssistant) -> CarsStore:
    return hass.data[DOMAIN]["store"]


def _err(connection, msg, e: Exception) -> None:
    connection.send_error(msg["id"], "holm_cars_error", str(e) or e.__class__.__name__)


async def _delete_files(hass, store: CarsStore, names: list[str]) -> None:
    def rm():
        for n in names:
            p = os.path.join(store.files_dir, os.path.basename(n))
            if os.path.isfile(p):
                os.remove(p)
    if names:
        await hass.async_add_executor_job(rm)


@callback
def async_register(hass: HomeAssistant) -> None:
    for fn in (ws_subscribe, ws_vehicle_save, ws_vehicle_delete, ws_record_save, ws_record_delete, ws_reminder_save,
               ws_reminder_delete, ws_reminder_done, ws_settings_save, ws_lube_preview, ws_lube_import, ws_csv_import):
        websocket_api.async_register_command(hass, fn)


@websocket_api.websocket_command({vol.Required("type"): "holm_cars/subscribe"})
@websocket_api.async_response
async def ws_subscribe(hass, connection, msg):
    store = _store(hass)

    @callback
    def changed(*_):
        connection.send_message(websocket_api.event_message(msg["id"], {"state": store.snapshot()}))

    connection.subscriptions[msg["id"]] = async_dispatcher_connect(hass, SIGNAL_UPDATED, changed)
    connection.send_result(msg["id"])
    changed()


# ------------------------------------------------------------------ véhicules
@websocket_api.websocket_command({vol.Required("type"): "holm_cars/vehicle/save", vol.Required("vehicle"): dict})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_vehicle_save(hass, connection, msg):
    store = _store(hass)
    try:
        old = store.data["vehicles"].get(msg["vehicle"].get("id") or "", {})
        v = store.save_vehicle(msg["vehicle"])
        if old.get("image") and old["image"] != v.get("image"):
            await _delete_files(hass, store, [old["image"]])
        connection.send_result(msg["id"], v)
    except (ValueError, KeyError) as e:
        _err(connection, msg, e)


@websocket_api.websocket_command({vol.Required("type"): "holm_cars/vehicle/delete", vol.Required("vehicle_id"): str})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_vehicle_delete(hass, connection, msg):
    store = _store(hass)
    img = (store.data["vehicles"].get(msg["vehicle_id"]) or {}).get("image")
    files = store.delete_vehicle(msg["vehicle_id"])
    await _delete_files(hass, store, files + ([img] if img else []))
    from homeassistant.helpers import device_registry as dr
    reg = dr.async_get(hass)
    dev = reg.async_get_device(identifiers={(DOMAIN, msg["vehicle_id"])})
    if dev:
        reg.async_remove_device(dev.id)
    connection.send_result(msg["id"])


# ------------------------------------------------------------------ opérations
@websocket_api.websocket_command({vol.Required("type"): "holm_cars/record/save", vol.Required("record"): dict})
@websocket_api.async_response
async def ws_record_save(hass, connection, msg):
    store = _store(hass)
    try:
        old = store.data["records"].get(msg["record"].get("id") or "", {})
        r = store.save_record(msg["record"])
        gone = [f["name"] for f in old.get("files") or [] if f["name"] not in {x["name"] for x in r.get("files") or []}]
        await _delete_files(hass, store, gone)
        hass.data[DOMAIN]["monitor"].check_reminders()
        connection.send_result(msg["id"], r)
    except (ValueError, KeyError) as e:
        _err(connection, msg, e)


@websocket_api.websocket_command({vol.Required("type"): "holm_cars/record/delete", vol.Required("record_id"): str})
@websocket_api.async_response
async def ws_record_delete(hass, connection, msg):
    store = _store(hass)
    await _delete_files(hass, store, store.delete_record(msg["record_id"]))
    connection.send_result(msg["id"])


# ------------------------------------------------------------------ rappels
@websocket_api.websocket_command({vol.Required("type"): "holm_cars/reminder/save", vol.Required("reminder"): dict})
@websocket_api.async_response
async def ws_reminder_save(hass, connection, msg):
    try:
        r = _store(hass).save_reminder(msg["reminder"])
        hass.data[DOMAIN]["monitor"].check_reminders()
        connection.send_result(msg["id"], r)
    except (ValueError, KeyError) as e:
        _err(connection, msg, e)


@websocket_api.websocket_command({vol.Required("type"): "holm_cars/reminder/delete", vol.Required("reminder_id"): str})
@websocket_api.async_response
async def ws_reminder_delete(hass, connection, msg):
    _store(hass).delete_reminder(msg["reminder_id"])
    await hass.services.async_call("persistent_notification", "dismiss", {"notification_id": f"{DOMAIN}_{msg['reminder_id']}"})
    connection.send_result(msg["id"])


@websocket_api.websocket_command({
    vol.Required("type"): "holm_cars/reminder/done", vol.Required("reminder_id"): str, vol.Optional("date"): vol.Any(str, None),
    vol.Optional("odometer"): vol.Any(float, int, str, None), vol.Optional("cost"): vol.Any(float, int, str, None),
    vol.Optional("record_type"): vol.Any(str, None), vol.Optional("notes", default=""): str,
})
@websocket_api.async_response
async def ws_reminder_done(hass, connection, msg):
    try:
        rec = _store(hass).complete_reminder(msg["reminder_id"], msg.get("date"), msg.get("odometer"), msg.get("cost"),
                                             msg.get("record_type"), msg.get("notes", ""))
        await hass.services.async_call("persistent_notification", "dismiss", {"notification_id": f"{DOMAIN}_{msg['reminder_id']}"})
        connection.send_result(msg["id"], rec)
    except (ValueError, KeyError) as e:
        _err(connection, msg, e)


# ------------------------------------------------------------------ réglages
@websocket_api.websocket_command({vol.Required("type"): "holm_cars/settings/save", vol.Required("settings"): dict})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_settings_save(hass, connection, msg):
    store = _store(hass)
    s = store.data["settings"]
    for k, v in msg["settings"].items():
        if k in ("notify_days", "notify_km", "notify_hour"):
            try:
                s[k] = max(0, int(float(v)))
            except (TypeError, ValueError):
                continue
        elif k == "notify_targets":
            s[k] = [str(x) for x in v or []]
        elif k in ("persistent",):
            s[k] = bool(v)
        elif k == "currency":
            s[k] = str(v)[:4] or "€"
    store.changed()
    connection.send_result(msg["id"], s)


# ------------------------------------------------------------------ import LubeLogger
LUBE_SCHEMA = {vol.Required("url"): str, vol.Optional("username", default=""): str, vol.Optional("password", default=""): str,
               vol.Optional("api_key", default=""): str}


@websocket_api.websocket_command({vol.Required("type"): "holm_cars/lubelogger/preview", **LUBE_SCHEMA})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_lube_preview(hass, connection, msg):
    try:
        client = LubeClient(async_get_clientsession(hass), msg["url"], msg["username"], msg["password"], msg["api_key"])
        connection.send_result(msg["id"], {"vehicles": await preview(client)})
    except LubeError as e:
        _err(connection, msg, e)


@websocket_api.websocket_command({vol.Required("type"): "holm_cars/lubelogger/import", **LUBE_SCHEMA,
                                  vol.Optional("vehicle_ids"): [vol.Any(str, int)], vol.Optional("include_files", default=True): bool})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_lube_import(hass, connection, msg):
    store = _store(hass)
    try:
        client = LubeClient(async_get_clientsession(hass), msg["url"], msg["username"], msg["password"], msg["api_key"])
        stats = await run_import(hass, store, client, msg.get("vehicle_ids"), msg["include_files"])
        hass.data[DOMAIN]["monitor"].check_reminders()
        connection.send_result(msg["id"], stats)
    except LubeError as e:
        _err(connection, msg, e)


@websocket_api.websocket_command({vol.Required("type"): "holm_cars/csv/import", vol.Required("vehicle_id"): str,
                                  vol.Required("content"): str, vol.Optional("kind"): vol.Any(str, None)})
@websocket_api.async_response
async def ws_csv_import(hass, connection, msg):
    try:
        res = import_csv(_store(hass), msg["vehicle_id"], msg["content"], msg.get("kind") or None)
        connection.send_result(msg["id"], res)
    except LubeError as e:
        _err(connection, msg, e)
