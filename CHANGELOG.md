# Changelog

## 1.1.0
- **Recharges au tarif du moment** ([#1](https://github.com/kaaribou/holm-cars/issues/1)) : avec un prix du kWh venant d'une entité (HOLM HP/HC, Tempo…), chaque hausse du compteur d'énergie pendant la recharge est comptée au prix en vigueur à cet instant. Coût = somme des tranches, prix moyen affiché, détail dans la recharge (« 18,2 kWh à 0,1296 € · 4,1 kWh à 0,1609 € »). La recharge en cours survit à un redémarrage de Home Assistant (et une recharge terminée pendant l'arrêt est enregistrée au démarrage). Prix fixe : comportement inchangé.
- **Type de véhicule** ([#2](https://github.com/kaaribou/holm-cars/issues/2)) : voiture, moto, scooter, vélo électrique, trottinette électrique, utilitaire, camping-car ou autre, avec l'icône qui va avec. Vélo et trottinette : forcément électriques. Les véhicules existants restent des voitures.
- **Modèle CSV HOLM Cars** ([#3](https://github.com/kaaribou/holm-cars/issues/3)) : bouton « Télécharger le modèle » dans l'import CSV, pour importer depuis Excel ou n'importe quelle autre application. Colonnes en français (accents et majuscules ignorés), colonne `type` pour mélanger les opérations dans un seul fichier, `;` et virgule décimale acceptés. Le résultat de l'import détaille le nombre d'opérations par type.

## 1.0.1
- **Mobile** : la carte ne déborde plus de l'écran quand une opération a un titre long. Les montants, le lien « Historique » et les textes restent visibles sur téléphone.

## 1.0.0
Première version.

- **Garage** : toutes vos voitures, avec photo, immatriculation et alerte d'entretien.
- **Historique** : entretiens, réparations, équipements, pleins, recharges, frais et relevés kilométriques, avec factures et photos jointes.
- **Rappels** par date et/ou kilométrage (le premier atteint), périodiques ou non, avec notification sur vos téléphones et dans Home Assistant avant l'échéance.
- **Insights** : dépenses par mois et par poste, coût au km, kilomètres par mois, consommation, prix du litre ou du kWh, plus gros postes, dépenses à prévoir, comparaison des voitures.
- **Voiture connectée** : kilométrage repris d'une entité, recharges enregistrées automatiquement (énergie, coût, batterie).
- **Import LubeLogger** par l'API ou par les fichiers CSV, sans doublons.
- Entités par voiture : kilométrage, prochain entretien, dépenses de l'année, coût au km, consommation, « Entretien à prévoir ».
