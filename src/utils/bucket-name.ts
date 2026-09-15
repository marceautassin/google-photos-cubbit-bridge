/** Nom de bucket S3 : 3 à 63 caractères, minuscules, chiffres, points et tirets, commençant et finissant par une lettre ou un chiffre. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** Raison de refuser un nom de bucket, `null` s'il est valide. Aucune normalisation : ` marceau` ou `MARCEAU` sont refusés. */
export function bucketNameProblem(name: string): string | null {
  return BUCKET_NAME.test(name)
    ? null
    : `nom de bucket « ${name} » invalide (3 à 63 caractères : minuscules, chiffres, « . » et « - », sans espace)`;
}
