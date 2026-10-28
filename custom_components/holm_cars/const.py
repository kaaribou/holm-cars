"""Constantes de HOLM Cars."""
DOMAIN = "holm_cars"
VERSION = "1.1.0"
STORAGE_KEY = "holm_cars"
STORAGE_VERSION = 1
CARD_URL = "/holm_cars_static/holm-cars-card.js"
STATIC_PATH = "/holm_cars_static"
FILES_URL = "/api/holm_cars/file"      # fichiers protégés (photos, factures) : accès par lien signé
UPLOAD_URL = "/api/holm_cars/upload"
SIGNAL_UPDATED = "holm_cars_updated"
SIGNAL_VEHICLES = "holm_cars_vehicles"
MAX_UPLOAD = 25 * 1024 * 1024

# types d'opérations
RECORD_TYPES = ("entretien", "reparation", "amelioration", "carburant", "recharge", "frais", "km")
COST_TYPES = ("entretien", "reparation", "amelioration", "carburant", "recharge", "frais")
ENERGIES = ("essence", "diesel", "electrique", "hybride", "hybride_rechargeable", "gpl", "e85")
# types de véhicules (#2) ; les engins légers sont forcément électriques
KINDS = ("voiture", "moto", "scooter", "velo_electrique", "trottinette", "utilitaire", "camping_car", "autre")
ELECTRIC_ONLY_KINDS = ("velo_electrique", "trottinette")

DEFAULT_SETTINGS = {
    "notify_targets": [],          # services notify.* (téléphones…)
    "persistent": True,            # notification dans Home Assistant
    "notify_days": 14,             # prévenir N jours avant
    "notify_km": 1000,             # ou N km avant
    "notify_hour": 9,
    "currency": "€",
}
