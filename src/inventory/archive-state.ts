import { BucketObject } from '../clients/types';
import { ObjectDating } from '../database/inventory-date-model';
import { InventoryRun } from '../database/inventory-model';
import { StoredPlan } from '../database/repair-plan-model';
import { formatNumber } from '../utils/format';
import { suspectReason } from './dating';
import { analyzeDuplicates, attachDatings } from './duplicates';
import {
  bucketMismatchHint,
  classifyScope,
  normalizePlanConfig,
  PlanInput,
  PlanRefusal,
  summarizePlan,
  UNRECOGNIZED_HINT,
  verifyStoredPlan,
} from './repair-plan';

/**
 * État de l'archive à la demande (story 2.5). Synthèse pure des calculs existants — périmètre du plan (`classifyScope`),
 * datations (`attachDatings`, `suspectReason`), doublons (`analyzeDuplicates`), plan courant (`summarizePlan`,
 * `verifyStoredPlan`) — depuis l'index local : aucun appel réseau, aucune écriture.
 */

export interface VolumeCount {
  count: number;
  size: number;
}

export interface YearRow extends VolumeCount {
  year: string; // AAAA
  suspectCount: number; // dates suspectes (2.2) comptées dans cette année
}

export interface YearBreakdown {
  years: YearRow[]; // par année croissante
  indeterminate: VolumeCount; // date indéterminée : jamais rangés dans une année
  undated: VolumeCount; // sans datation valide (non datés ou datation périmée)
}

export type PlanState = 'absent' | 'a_jour' | 'perime' | 'non_executable';

export interface PlanStatus {
  state: PlanState;
  id: string | null;
  generatedAt: Date | null;
  reasons: string[]; // périmé / non exécutable : raisons de `verifyStoredPlan` ; absent : dernier refus éventuel
  quarantine: VolumeCount | null; // d'après le plan enregistré ; null sans plan
}

/** Quarantaine restituée : celle du plan, sinon une borne haute, sinon rien d'estimable (médias non datés). */
export type QuarantineView =
  | { kind: 'plan'; volume: VolumeCount; planUpToDate: boolean }
  | { kind: 'au_plus'; volume: VolumeCount } // sans plan : indéterminés, albums et doublons compris
  | { kind: 'estimation_impossible'; undatedCount: number }; // sans plan, des médias ne sont pas datés

export interface ArchiveState {
  inventory: { bucket: string; completedAt: Date; objectCount: number; totalSize: number };
  scope: {
    prefixes: string[];
    objects: VolumeCount; // tous les objets sous les préfixes source
    media: VolumeCount;
    exclusions: VolumeCount;
    unrecognized: VolumeCount & { extensions: string[] };
  };
  years: YearBreakdown;
  quarantine: QuarantineView;
  duplicates: {
    groupCount: number;
    extraCopyCount: number;
    recoverableSize: number;
    unconfirmedGroupCount: number;
    unconfirmedSize: number; // au plus, hors volume récupérable
  };
  plan: PlanStatus;
  nextAction: string;
}

export interface ArchiveStateInput {
  inventoryRun: InventoryRun;
  planInput: PlanInput; // index local et configuration actuels, comme pour `gpb plan generer`
  storedPlan: StoredPlan | null;
  lastRefusal: PlanRefusal | null;
  now?: Date;
}

/** Nombre et volume d'une liste d'objets. */
export function volumeOf(items: { size: number }[]): VolumeCount {
  return { count: items.length, size: items.reduce((total, item) => total + item.size, 0) };
}

const add = (target: VolumeCount, size: number): void => {
  target.count++;
  target.size += size;
};

/**
 * Répartition des médias par année de leur date reconstruite. Date indéterminée et absence de datation valide forment
 * deux lignes à part ; les dates suspectes restent dans leur année et y sont comptées. Somme des lignes = médias.
 */
export function yearBreakdown(media: BucketObject[], datings: ObjectDating[], now: Date = new Date()): YearBreakdown {
  const years = new Map<string, YearRow>();
  const indeterminate: VolumeCount = { count: 0, size: 0 };
  const undated: VolumeCount = { count: 0, size: 0 };
  for (const { object, dating } of attachDatings(media, datings)) {
    if (dating === null) {
      add(undated, object.size);
    } else if (dating.takenAt === null) {
      add(indeterminate, object.size);
    } else {
      const year = dating.takenAt.slice(0, 4);
      const row = years.get(year) ?? { year, count: 0, size: 0, suspectCount: 0 };
      add(row, object.size);
      if (suspectReason(dating, now)) row.suspectCount++;
      years.set(year, row);
    }
  }
  return { years: [...years.values()].sort((a, b) => a.year.localeCompare(b.year)), indeterminate, undated };
}

/** État du plan enregistré, vérifié contre l'index et la configuration actuels (`verifyStoredPlan`). */
export function planStatus(storedPlan: StoredPlan | null, current: PlanInput, lastRefusal: PlanRefusal | null): PlanStatus {
  if (!storedPlan) {
    return {
      state: 'absent',
      id: null,
      generatedAt: null,
      reasons: lastRefusal ? [`la dernière génération a été refusée : ${lastRefusal.reason}`] : [],
      quarantine: null,
    };
  }
  const { plan, generatedAt } = storedPlan;
  const reasons = verifyStoredPlan(plan, current, lastRefusal);
  const hint = bucketMismatchHint(plan, current.sourceBucket, current.destinationBucket);
  if (reasons.length > 0 && hint) reasons.push(hint);
  // Un plan intact dont seule la dernière génération a été refusée n'est pas périmé : il est non exécutable en l'état
  // (comme dans `plan afficher`). Second contrôle sans le refus, seulement dans ce cas.
  const stale = lastRefusal ? verifyStoredPlan(plan, current, null).length > 0 : reasons.length > 0;
  // Non exécutable avant périmé : « corrigez puis régénérez » couvre les deux cas.
  const state: PlanState = !plan.executable ? 'non_executable' : stale ? 'perime' : reasons.length > 0 ? 'non_executable' : 'a_jour';
  return { state, id: plan.id, generatedAt, reasons, quarantine: summarizePlan(plan).byAction.quarantaine };
}

/** Quarantaine à afficher : celle du plan s'il existe ; sans plan, borne haute seulement si tous les médias sont datés. */
export function quarantineView(years: YearBreakdown, plan: PlanStatus): QuarantineView {
  if (plan.quarantine) return { kind: 'plan', volume: plan.quarantine, planUpToDate: plan.state === 'a_jour' };
  if (years.undated.count > 0) return { kind: 'estimation_impossible', undatedCount: years.undated.count };
  return { kind: 'au_plus', volume: years.indeterminate };
}

export interface ActionFacts {
  sourcePrefixesMissing: boolean;
  undatedCount: number;
  unrecognizedCount: number;
  planState: PlanState;
}

/** Prochaine action recommandée, une seule, par priorité. `null` : aucun inventaire local. */
export function recommendAction(facts: ActionFacts | null): string {
  if (!facts) return 'inventoriez le bucket : gpb inventory scan';
  if (facts.sourcePrefixesMissing) return 'renseignez repair.sourcePrefixes dans config/config.json, puis : gpb plan generer';
  if (facts.undatedCount > 0) return `datez les ${formatNumber(facts.undatedCount)} média(s) non daté(s) : gpb inventory dates`;
  if (facts.unrecognizedCount > 0) {
    return `déclarez les objets non reconnus (${UNRECOGNIZED_HINT}), puis : gpb plan generer`;
  }
  switch (facts.planState) {
    case 'absent':
      return 'générez le plan de réparation : gpb plan generer';
    case 'perime':
      return 'régénérez le plan, il est périmé : gpb plan generer';
    case 'non_executable':
      return 'corrigez les points listés par « gpb plan afficher », puis régénérez le plan : gpb plan generer';
    case 'a_jour':
      return 'plan prêt à relire : gpb plan afficher --export plan.csv';
  }
}

/** Synthèse complète de l'état de l'archive. Pure : toutes les données viennent de l'entrée. */
export function buildArchiveState(input: ArchiveStateInput): ArchiveState {
  const { inventoryRun, planInput } = input;
  const config = normalizePlanConfig(planInput);
  const { media, exclusions, unrecognized } = classifyScope(planInput.objects, config);
  const years = yearBreakdown(media, planInput.datings, input.now);
  const report = analyzeDuplicates(media, planInput.datings);
  const plan = planStatus(input.storedPlan, planInput, input.lastRefusal);
  const extensions = [...new Set(unrecognized.map((u) => u.extension))].sort();

  return {
    inventory: {
      bucket: inventoryRun.bucket,
      completedAt: inventoryRun.completedAt,
      objectCount: inventoryRun.objectCount,
      totalSize: inventoryRun.totalSize,
    },
    scope: {
      prefixes: config.sourcePrefixes,
      objects: volumeOf([...media, ...exclusions, ...unrecognized]),
      media: volumeOf(media),
      exclusions: volumeOf(exclusions),
      unrecognized: { ...volumeOf(unrecognized), extensions },
    },
    years,
    quarantine: quarantineView(years, plan),
    duplicates: {
      groupCount: report.groups.length,
      extraCopyCount: report.extraCopyCount,
      recoverableSize: report.recoverableSize,
      unconfirmedGroupCount: report.unconfirmed.length,
      unconfirmedSize: report.unconfirmedSize,
    },
    plan,
    nextAction: recommendAction({
      sourcePrefixesMissing: config.sourcePrefixes.length === 0,
      undatedCount: years.undated.count,
      unrecognizedCount: unrecognized.length,
      planState: plan.state,
    }),
  };
}
