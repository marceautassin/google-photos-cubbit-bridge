# Démarrage rapide

Le cycle complet d'un export Takeout, commandes seules et dans l'ordre. Détail de chaque étape, sorties attendues,
interruptions et suppressions : [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

À faire une fois (depuis le dossier du projet, avec un `.env` rempli d'après `config/.env.example`) :

```bash
npm ci
npm run build
npm link
```

Cycle, depuis le dossier du projet. `<export>` : horodatage de l'export (ex. `20260806T062636Z`). `<id>` : identifiant complet (ex. `20260806T062636Z-1`), nom du
dossier local `data/takeout/<id>/`. `<n>` : nombre de
parties annoncé par Google. `<dédié>` : bucket dédié (`CUBBIT_DESTINATION_BUCKET`). `<empreinte>` : affichée par
`planifier`.

```bash
# 1-2. Demander l'export à Google Takeout, puis déposer les zips dans <dédié>/backups/ (client S3 au choix)

# 3. Valider l'export (attendu : « exploitable », nombre de parties confirmé)
gpb takeout valider --export <export> --parties <n>

# 4. Inventorier le bucket dédié
gpb inventory scan --bucket <dédié>

# 5. Télécharger, vérifier et analyser
gpb takeout analyser --export <export> --parties <n>

# 6. Planifier, puis relire le plan (attendu : « Plan exécutable : oui »)
gpb takeout planifier --export <export> --sortie plan.csv

# 7. Simuler, puis archiver pour de vrai
gpb takeout archiver --export <export>
gpb takeout archiver --export <export> --confirmer <empreinte>

# 8. Réinventorier, puis attester (attendu : « Export attesté »)
gpb inventory scan --bucket <dédié>
gpb takeout attester --export <export> --parties <n> --export-liste data/medias-couverts-<export>.csv
```

**9. Suppressions** (à la main, jamais par l'outil) : seulement après `✅ Export attesté`, dans les 24 h. Zips de
`backups/` listés par l'attestation, puis Google Photos, puis `data/takeout/<id>/`. Voir le runbook.

Passe `archiver` interrompue : relancer la même commande, avec `--lever-verrou` après une coupure. `analyser` interrompu :
relancer la même commande (pas de verrou).

Au-delà de 24 h après l'attestation, refaire l'étape 8 avant de supprimer. Google Photos : suppression par période sûre
seulement si rien n'a été ajouté depuis l'export (sinon nouvel export, ou suppression d'après le CSV).
