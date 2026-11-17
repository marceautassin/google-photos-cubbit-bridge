---
baseline_commit: 047d36d
---

# Story 6.1 : Retirer le code mort de l'ancienne synchronisation

Status: done

## Story

En tant que Marceau,
je veux que le dépôt ne contienne plus que l'outil réel,
afin qu'un lecteur de mon GitHub ne bute pas sur des commandes et des tables qui ne servent plus.

## Acceptance Criteria

1. **Commandes retirées.** `gpb --help` et `gpb takeout --help` ne listent plus `status`, `history`, `sync`, `resume`,
   `archive`, `takeout import`, `takeout list`, `takeout validate`. Les fichiers qui n'existaient que pour elles
   disparaissent (`src/commands/status.ts`, `src/commands/sync.ts`, `src/commands/disabled-command.ts`, et le
   `LEGACY_MESSAGE` de `src/commands/takeout.ts` s'il ne sert plus), ainsi que leurs tests (`tests/commands/sync.test.ts`).
   `gpb etat`, `gpb setup` et toutes les autres commandes restent inchangées.
2. **Modèle de données hérité retiré.** `SyncStatus`, `SyncRecord`, `SyncSession` (et types associés propres à
   l'ancienne synchronisation) disparaissent de `src/clients/types.ts` ; `SyncRecordModel` et `SyncSessionModel`
   disparaissent de `src/database/models.ts` (le fichier entier s'il ne contient plus rien d'utile).
   `src/database/connection.ts` ne crée plus `sync_records`, `sync_sessions`, leurs index ni leur trigger.
3. **Bases existantes intactes.** Aucun `DROP TABLE` : la base réelle de Marceau (`data/app.db`) contient ces tables et
   doit continuer de fonctionner telle quelle. Aucune migration, aucune écriture sur cette base pendant le dev.
4. **Configuration d'exemple neutre.** `config/config.json.backup` est supprimé. Dans `config/.env.example`, les valeurs de
   `CUBBIT_BUCKET`, `CUBBIT_DESTINATION_BUCKET` et `CUBBIT_REGION` deviennent des placeholders explicites
   (ex. `votre-bucket-source`, `votre-bucket-dedie`, `votre-region`), comme le sont déjà les clés.
5. **Documentation alignée.** `README.md`, `QUICKSTART.md`, `docs/RUNBOOK.md`, `CLAUDE.md` (section Architecture, liste
   des commandes) ne mentionnent plus les commandes retirées ; la phrase du README qui liste les commandes désactivées
   disparaît. Aucune autre réécriture de la doc.
6. **Qualité.** `npx tsc --noEmit` passe, `npm test` vert, `npx eslint src --ext .ts` sans erreur (les warnings
   existants peuvent rester, aucun nouveau).

## Hors périmètre

- Les noms de bucket et le prénom « Marceau » dans les tests, commentaires et docs : conservés (non sensibles, décision du
  2026-11-17).
- Les champs de configuration `sync.*` (`supportedFormats` est encore lu par `takeout`) : ne pas toucher au schéma de
  configuration.
- Les artefacts `_bmad-output/` historiques (stories, PRD) : ne pas les modifier.
- La réécriture des emails de commits : story 6.2.

## Dev Notes

- Relevé fait en cadrage (`git grep`) : `SyncRecordModel`/`SyncSessionModel` ne sont utilisés que par
  `src/commands/status.ts` ; `registerDisabledCommand` seulement par `sync.ts` et `takeout.ts` (l. 117-124).
  `tests/database/connection.test.ts` utilise un `SyncRecord` (l. 60) : adapter ce test pour qu'il reste utile sur une
  table encore vivante, ou retirer le cas s'il ne testait que l'ancienne table.
- Vérifier après coup : `git grep -nE "SyncStatus|SyncRecord|SyncSession|sync_records|sync_sessions|google_photo_id|googleUrl|registerDisabledCommand"`
  ne doit rien renvoyer dans `src/` et `tests/`.
- Ne jamais lire `.env` ni `data/`. Aucun accès réseau ni bucket.

## Dev Agent Record

### Completion Notes List

- Commandes `status`/`history`/`sync`/`resume`/`archive`/`takeout import|list|validate` retirées ; `disabled-command.ts`, `LEGACY_MESSAGE` et le test `sync.test.ts` supprimés. Le cas `it.each` « ancienne commande » de `tests/commands/takeout.test.ts` est retiré (testait uniquement les refus).
- `SyncStatus`/`SyncRecord`/`SyncSession` retirés de `src/clients/types.ts` ; `SyncRecordModel`/`SyncSessionModel` retirés de `src/database/models.ts` (le fichier garde `AppMetadataModel`, encore utilisé).
- `connection.ts` : plus de tables/index/trigger `sync_*`, sans DROP. Les numéros de migration sont conservés (une base existante a déjà 1 à 12 appliquées) ; la migration 2 (index) devient un no-op `SELECT 1;` commenté.
- `tests/database/connection.test.ts` : les cas `SyncRecord`/`SyncSession` retirés, le cas métadonnées conservé.
- `config/config.json.backup` supprimé ; `config/.env.example` : placeholders `votre-bucket-source`, `votre-bucket-dedie`, `votre-region`.
- Docs : README (ligne `status`/`history` et section « Commandes désactivées » retirées), CLAUDE.md (liste des commandes). QUICKSTART et RUNBOOK ne mentionnaient aucune commande retirée : inchangés.
- Vérifications : tsc OK ; 33 suites / 792 tests verts ; eslint 0 erreur, 4 warnings préexistants (execution-control.ts, logger.ts) ; `git grep` de la spec vide sur src/ et tests/. Aide CLI vérifiée via un script jetable enregistrant les commandes (lancer `gpb` réel charge config.json et ouvre `data/app.db`, donc non fait) : plus aucune commande retirée.

### File List

Supprimés : `src/commands/status.ts`, `src/commands/sync.ts`, `src/commands/disabled-command.ts`, `tests/commands/sync.test.ts`, `config/config.json.backup`.
Modifiés : `src/index.ts`, `src/commands/takeout.ts`, `src/clients/types.ts`, `src/database/models.ts`, `src/database/connection.ts`, `tests/commands/takeout.test.ts`, `tests/database/connection.test.ts`, `config/.env.example`, `README.md`, `CLAUDE.md`, ce fichier de story.
