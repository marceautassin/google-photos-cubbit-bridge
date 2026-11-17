# google-photos-cubbit-bridge — règles projet

Outil CLI TypeScript personnel : archiver ses photos Google Photos (via archives
Google Takeout) vers un stockage S3 Cubbit, classées par date. Mono-utilisateur,
exécution locale uniquement.

## Git — règles strictes

- **Interdit de commit sans autorisation explicite de Marceau.** Proposer le commit,
  attendre le feu vert.
- **Interdit de push sans autorisation explicite de Marceau.** Même règle.
- **Ne jamais signer les commits au nom de Claude.** Pas de `Co-Authored-By: Claude`,
  pas de `Generated with Claude Code`, pas de mention d'IA dans le message. Les commits
  sont au nom de Marceau, point.

## Qualité de code

- **DRY** — pas de duplication. Un comportement, un seul endroit. Si le même bloc
  apparaît deux fois, il est extrait.
- **KISS** — la solution la plus simple qui marche. Pas d'abstraction anticipée, pas de
  généricité « au cas où ». Le code doit se lire sans effort dans six mois.
- **SOLID** — responsabilité unique par module, dépendances vers des interfaces
  (`src/clients/types.ts`), extension sans modification du code existant.

En cas de conflit entre les trois : **KISS gagne**. C'est un outil perso, pas une
plateforme. Une abstraction SOLID qui complique la lecture n'a pas sa place ici.

## Conventions du projet

- TypeScript strict. `npx tsc --noEmit` doit passer avant toute proposition de commit.
- Lint et format : `npm run lint`, `npm run format`.
- Tests : `npm test` (Jest).
- Langue : commentaires, logs utilisateur et documentation en **français**.

## Architecture

```
src/
├── index.ts        # Point d'entrée CLI
├── commands/       # Commandes CLI (takeout, inventory, plan, reparation, etat, setup)
├── takeout/        # Lecture, analyse, plan d'archivage et attestation des exports Google Takeout
├── inventory/      # Inventaire du bucket, datation, doublons, plan et rapport de réparation
├── clients/        # Client Cubbit (S3) + types partagés
├── database/       # SQLite : inventaire, analyses, plans, journal d'exécution
├── config/         # Chargement et typage de la configuration
└── utils/          # Logging, formats, fichiers
```

**Note historique :** le projet visait initialement la Google Photos Library API.
Google en a fermé l'accès en lecture à la bibliothèque complète — le projet a pivoté
vers l'ingestion d'archives **Google Takeout**. Le code de cette première approche
(`src/auth/`, `src/clients/google-photos.ts`) a été supprimé (story 1.2). Le `README.md`,
le `QUICKSTART.md` et `docs/RUNBOOK.md` décrivent l'outil réel (epic 5).

## Planification

Ce projet suit la méthode BMAD. Les artefacts vivent dans :

- `_bmad-output/planning-artifacts/` — PRD, epics et stories
- `_bmad-output/implementation-artifacts/` — sprint status, stories en cours

**Tout chantier doit avoir un `epics.md`** : l'outil de suivi Vigie s'appuie dessus.
Ne pas démarrer d'implémentation sans lui. Le nom de dossier du chantier doit être
identique côté planification et côté implémentation.
