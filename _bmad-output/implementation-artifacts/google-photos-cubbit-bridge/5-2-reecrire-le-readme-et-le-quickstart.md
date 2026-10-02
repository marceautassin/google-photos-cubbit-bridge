---
baseline_commit: 0be5bfc
---

# Story 5.2 : Réécrire le README et le QUICKSTART

Status: done

## Story

En tant que Marceau,
je veux une documentation qui décrit l'outil réel,
afin de ne plus être induit en erreur par des commandes qui n'existent plus.

**Exigences :** FR-20.

## Acceptance Criteria

1. `README.md` et `QUICKSTART.md` réécrits en français : plus aucune mention de `gpb auth`, `gpb list`, OAuth ni de
   la Google Photos Library API comme mode de fonctionnement.
2. **README** : ce que fait l'outil (archiver les exports Takeout vers le bucket dédié Cubbit, classés par date, sans
   jamais supprimer), garanties (point d'écriture unique, aucune suppression, attestation avant suppression), structure
   de l'archive (`photos/AAAA/AAAA-MM/`, `albums/<nom>/`, `quarantaine/`, `backups/`), installation (`npm link`),
   configuration (noms des variables `.env`, `config/config.json` si utilisé), **tableau des commandes réellement
   existantes** (une ligne chacune), commandes désactivées signalées comme telles, développement (`npm test`,
   `npm run lint`, `npx tsc --noEmit`), renvoi au runbook `docs/RUNBOOK.md` et à `docs/TAKEOUT_STRUCTURE.md`.
3. **Pourquoi pas l'API Google** : section datée — l'accès en lecture à toute la bibliothèque par la Google Photos
   Library API a été retiré par Google le 2025-03-31 (en vigueur au 2025-04-01) ; pivot vers Google Takeout.
4. **QUICKSTART** : le cycle en une page (commandes seules, dans l'ordre), renvoi au runbook pour le détail.
5. Exactitude : commandes vérifiées par `--help` dans une copie du projet sous un dossier temporaire (sans `.env` ni
   `data/`). Mettre à jour la note du `CLAUDE.md` projet qui dit que le README n'est pas à jour.
6. Signaler (sans le corriger) tout autre document du dépôt qui décrirait encore l'ancien fonctionnement.

## Dev Agent Record

### Agent Model Used

claude-sonnet-5-5 (Sonnet 5.5)

### Completion Notes List

- README, QUICKSTART réécrits d'après le code (`src/index.ts`, `src/commands/*.ts`), pas d'après l'ancien README. Plus aucune
  mention de `gpb auth`, `gpb list`, OAuth comme mode de fonctionnement ; la Library API n'apparaît que dans la section datée
  « Pourquoi pas l'API Google Photos ».
- Tableau des commandes vérifié par `--help` (copie temporaire sans `.env` ni `data/`, supprimée) ; commandes désactivées
  signalées : `sync`, `resume`, `archive`, `takeout import|list|validate`.
- `CLAUDE.md` : note du README mise à jour, et arborescence corrigée (`src/auth/` et `src/clients/google-photos.ts` n'existent
  plus depuis la story 1.2 ; `src/inventory/` ajouté).
- Documents encore obsolètes signalés, non corrigés : `_bmad-output/planning-artifacts/**/prd.md`, `addendum.md`, `.memlog.md`
  et `epics.md` (mentions OAuth / Library API, historiques).
- Aucun commit, aucun accès à `.env`, `data/` ni bucket.

- Corrections de revue : date de retrait de l'API (2025-03-31, en vigueur 2025-04-01), `<id>` dans le QUICKSTART, rappels 24 h, Google Photos et `analyser` sans verrou.

### File List

- README.md (réécrit)
- QUICKSTART.md (réécrit)
- CLAUDE.md (note historique et arborescence)

## Revue de clôture (orchestrateur)

- Revue `pr-reviewer` (Opus) commune avec la 5.1 (voir sa clôture) : APPROUVER. Plus aucune trace d'OAuth ni de Library API comme mode de fonctionnement ; tableau des commandes exact ; raison de l'abandon datée ; aucun secret.
- Note du `CLAUDE.md` projet et arborescence mises à jour (le README est désormais à jour ; `src/auth/` supprimé, `src/inventory/` ajouté).
- Documents historiques non modifiés, assumés : PRD, addendum, epics et stories 1.x-3.x citent encore OAuth / Library API comme contexte.
