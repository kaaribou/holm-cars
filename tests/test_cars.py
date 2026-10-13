"""HOLM Cars : véhicules, opérations, rappels, suivi automatique, imports."""
from datetime import date, timedelta
from unittest.mock import patch

import pytest
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_mock_service

from custom_components.holm_cars.const import DOMAIN
from custom_components.holm_cars.lubelogger import LubeClient, import_csv, parse_date, parse_number, run_import


async def setup(hass):
    entry = MockConfigEntry(domain=DOMAIN, title="HOLM Cars", data={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return hass.data[DOMAIN]["store"]


async def test_vehicule_entites_et_cout(hass: HomeAssistant):
    store = await setup(hass)
    v = store.save_vehicle({"make": "Dacia", "model": "Sandero", "year": "2021", "plate": "AA-123-AA", "energy": "essence"})
    await hass.async_block_till_done()
    y = date.today().year
    store.save_record({"vehicle_id": v["id"], "type": "carburant", "date": f"{y}-01-10", "odometer": 10000, "cost": 60, "fuel": {"qty": 40, "full": True}})
    store.save_record({"vehicle_id": v["id"], "type": "carburant", "date": f"{y}-02-10", "odometer": 10600, "cost": 54, "fuel": {"qty": 36, "full": True}})
    store.save_record({"vehicle_id": v["id"], "type": "entretien", "date": f"{y}-02-12", "odometer": 10650, "cost": "120,50", "title": "Vidange"})
    await hass.async_block_till_done()
    st = hass.states.get("sensor.dacia_sandero_kilometrage")
    assert st and float(st.state) == 10650
    assert float(hass.states.get("sensor.dacia_sandero_depenses_de_l_annee").state) == pytest.approx(234.5)
    assert float(hass.states.get("sensor.dacia_sandero_consommation_moyenne").state) == pytest.approx(6.0)
    snap = store.snapshot()
    assert snap["vehicles"][v["id"]]["summary"]["consumption"]["unit"] == "L/100 km"


async def test_rappel_km_date_notification_et_recurrence(hass: HomeAssistant):
    calls = async_mock_service(hass, "notify", "mobile_app_test")
    pn = async_mock_service(hass, "persistent_notification", "create")
    store = await setup(hass)
    store.data["settings"]["notify_targets"] = ["notify.mobile_app_test"]
    v = store.save_vehicle({"make": "Peugeot", "model": "5008"})
    store.save_record({"vehicle_id": v["id"], "type": "km", "date": date.today().isoformat(), "odometer": 99500})
    rem = store.save_reminder({"vehicle_id": v["id"], "title": "Vidange", "due_km": 100000, "every_km": 15000, "every_months": 12})
    hass.data[DOMAIN]["monitor"].check_reminders()
    await hass.async_block_till_done()
    assert len(calls) == 1 and "Vidange" in calls[0].data["title"] and "500 km" in calls[0].data["message"]
    assert len(pn) == 1
    hass.data[DOMAIN]["monitor"].check_reminders()  # pas de doublon
    await hass.async_block_till_done()
    assert len(calls) == 1
    assert hass.states.get("binary_sensor.peugeot_5008_entretien_a_prevoir").state == "on"
    rec = store.complete_reminder(rem["id"], date.today().isoformat(), 99800, 95, "entretien")
    r2 = store.data["reminders"][rem["id"]]
    assert rec["title"] == "Vidange" and r2["due_km"] == 114800 and r2["notified"] == {}
    assert r2["due_date"] == date.today().replace(year=date.today().year + 1).isoformat()
    await hass.async_block_till_done()
    assert hass.states.get("binary_sensor.peugeot_5008_entretien_a_prevoir").state == "off"


async def test_rappel_date_controle_technique(hass: HomeAssistant):
    store = await setup(hass)
    v = store.save_vehicle({"make": "Ford", "model": "Fusion"})
    rem = store.save_reminder({"vehicle_id": v["id"], "title": "Contrôle technique", "due_date": (date.today() + timedelta(days=10)).isoformat()})
    assert store.reminder_status(rem)["state"] == "soon"
    rem = store.save_reminder({**rem, "due_date": (date.today() + timedelta(days=40)).isoformat()})
    assert store.reminder_status(rem)["state"] == "ok"
    with pytest.raises(ValueError):
        store.save_reminder({"vehicle_id": v["id"], "title": "x"})


async def test_odometre_et_recharge_automatique(hass: HomeAssistant):
    store = await setup(hass)
    hass.states.async_set("sensor.car_odo", "12000", {"unit_of_measurement": "km"})
    hass.states.async_set("binary_sensor.car_charging", "off")
    hass.states.async_set("sensor.car_energy", "500.0", {"unit_of_measurement": "kWh"})
    v = store.save_vehicle({"make": "Leapmotor", "model": "T03", "energy": "electrique", "odometer_entity": "sensor.car_odo",
                            "charge": {"charging_entity": "binary_sensor.car_charging", "energy_entity": "sensor.car_energy",
                                       "energy_mode": "total", "price": 0.2}})
    await hass.async_block_till_done()
    assert store.odometer(v["id"]) == 12000
    hass.states.async_set("sensor.car_odo", "12045.6", {"unit_of_measurement": "km"})
    await hass.async_block_till_done()
    kms = store.records_of(v["id"], ("km",))
    assert len(kms) == 1 and kms[0]["odometer"] == 12045.6  # un seul relevé par jour
    hass.states.async_set("binary_sensor.car_charging", "on")
    await hass.async_block_till_done()
    hass.states.async_set("sensor.car_energy", "512.5", {"unit_of_measurement": "kWh"})
    hass.states.async_set("binary_sensor.car_charging", "off")
    await hass.async_block_till_done()
    ch = store.records_of(v["id"], ("recharge",))
    assert len(ch) == 1 and ch[0]["fuel"]["qty"] == 12.5 and ch[0]["cost"] == 2.5 and ch[0]["source"] == "auto"


def test_formats():
    assert parse_number("1 234,56 €") == 1234.56 and parse_number("1,234.5") == 1234.5 and parse_number("45,123") == 45.123
    assert parse_date("12/03/2024") == "2024-03-12" and parse_date("03/12/2024", day_first=False) == "2024-03-12"
    assert parse_date("2024-03-12T00:00:00") == "2024-03-12"


async def test_import_csv(hass: HomeAssistant):
    store = await setup(hass)
    v = store.save_vehicle({"make": "Ford", "model": "Fusion"})
    gas = "Date,Odometer,FuelConsumed,Cost,FuelEconomy,IsFillToFull,MissedFuelUp,Notes,Tags\n15/01/2024,100000,40,70,,True,False,,\n20/02/2024,100700,42,73.5,,True,False,plein,a b\n"
    res = import_csv(store, v["id"], gas)
    assert res["kind"] == "carburant" and res["added"] == 2
    assert import_csv(store, v["id"], gas)["added"] == 0  # pas de doublons
    svc = "Date;Odometer;Description;Cost;Notes;Tags\n01/03/2024;100800;Vidange;89,90;;\n"
    res = import_csv(store, v["id"], svc, "entretien")
    assert res["added"] == 1
    r = store.records_of(v["id"], ("entretien",))[0]
    assert r["cost"] == 89.9 and r["date"] == "2024-03-01"


class FakeResp:
    def __init__(self, data, status=200, ctype="application/json"):
        self.data, self.status, self.headers = data, status, {"Content-Type": ctype}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def json(self, content_type=None):
        return self.data

    async def read(self):
        return self.data


class FakeSession:
    def __init__(self):
        self.calls = []

    def get(self, url, params=None, headers=None, auth=None, timeout=None):
        self.calls.append((url, params, headers))
        path = url.split("8080", 1)[1]
        vid = (params or {}).get("vehicleId")
        data = {
            "/api/vehicles": [{"id": 1, "year": 2021, "make": "Dacia", "model": "Sandero", "licensePlate": "GA-278-WV", "isElectric": False,
                               "isDiesel": False, "imageLocation": "/images/car1.jpg", "purchaseDate": "", "soldDate": ""}],
            "/api/vehicle/servicerecords": [{"id": "5", "date": "03/15/2024", "odometer": "45000", "description": "Vidange", "cost": "120.5",
                                             "notes": "", "tags": "", "files": [{"name": "facture.pdf", "location": "/documents/f1.pdf"}]}],
            "/api/vehicle/gasrecords": [{"id": "7", "date": "04/02/2024", "odometer": "45500", "fuelConsumed": "38.2", "cost": "68.1",
                                         "isFillToFull": "True", "missedFuelUp": "False", "notes": "", "tags": ""}],
            "/api/vehicle/reminders": [{"id": "9", "description": "Contrôle technique", "metric": "Date", "dueDate": "06/30/2027",
                                        "dueOdometer": "0", "notes": ""}],
        }
        if path in ("/images/car1.jpg", "/documents/f1.pdf"):
            return FakeResp(b"binary", 200, "image/jpeg" if path.endswith("jpg") else "application/pdf")
        return FakeResp(data.get(path, []))


async def test_import_lubelogger_api(hass: HomeAssistant):
    store = await setup(hass)
    sess = FakeSession()
    client = LubeClient(sess, "http://nas:8080", "oliv", "x")
    stats = await run_import(hass, store, client, None, True)
    assert stats == {"vehicles": 1, "records": 2, "reminders": 1, "files": 1, "updated": 0}
    assert sess.calls[0][2]["culture-invariant"]
    v = next(iter(store.data["vehicles"].values()))
    assert v["plate"] == "GA-278-WV" and v["image"]
    svc = store.records_of(v["id"], ("entretien",))[0]
    assert svc["date"] == "2024-03-15" and svc["cost"] == 120.5 and svc["files"][0]["label"] == "facture.pdf"
    rem = next(iter(store.data["reminders"].values()))
    assert rem["due_date"] == "2027-06-30"
    stats = await run_import(hass, store, client, None, True)  # réimport : mise à jour, pas de doublon
    assert stats["records"] == 0 and stats["updated"] == 2 and len(store.data["vehicles"]) == 1 and len(store.data["reminders"]) == 1


async def test_websocket_et_fichiers(hass: HomeAssistant, hass_ws_client, hass_client):
    store = await setup(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "holm_cars/vehicle/save", "vehicle": {"make": "Dacia", "model": "Spring", "energy": "electrique"}})
    r = await ws.receive_json()
    assert r["success"], r
    vid = r["result"]["id"]
    client = await hass_client()
    import aiohttp
    form = aiohttp.FormData()
    form.add_field("file", b"%PDF-1.4 test", filename="facture.pdf", content_type="application/pdf")
    resp = await client.post("/api/holm_cars/upload", data=form)
    assert resp.status == 200
    up = await resp.json()
    assert up["label"] == "facture.pdf" and up["name"].endswith(".pdf")
    await ws.send_json({"id": 2, "type": "holm_cars/record/save", "record": {"vehicle_id": vid, "type": "recharge", "cost": "4,2", "odometer": 1200, "fuel": {"qty": 21}, "files": [up]}})
    r = await ws.receive_json()
    assert r["success"] and r["result"]["fuel"]["unit"] == "kWh"
    resp = await client.get(f"/api/holm_cars/file/{up['name']}")
    assert resp.status == 200 and await resp.read() == b"%PDF-1.4 test"
    bad = await client.get("/api/holm_cars/file/..%2F..%2Fsecrets.yaml")
    assert bad.status in (400, 404)
    await ws.send_json({"id": 3, "type": "holm_cars/subscribe"})
    r = await ws.receive_json()
    assert r["success"]
    ev = await ws.receive_json()
    assert vid in ev["event"]["state"]["vehicles"]
    await ws.send_json({"id": 4, "type": "holm_cars/record/delete", "record_id": next(iter(store.data["records"]))})
    while (m := await ws.receive_json()).get("id") != 4 or m.get("type") != "result":
        pass
    import os
    assert not os.path.exists(os.path.join(store.files_dir, up["name"]))
